/**
 * 拍卖账引擎：纯函数、无 IndexedDB 依赖，可在 Node 下单测。
 *
 * 账本快照 LedgerSnapshot 是唯一事实来源；页面上的预算占用、最高报价全部由它派生。
 * - 线上操作：applyCommand 直接在快照上推演；
 * - 断网操作：命令以 pending / draft 落到操作账，回馆 mergePending 按序重放；
 * - 推演只在最后一步产出变更，任何拒绝（预算不足、被别人先报、终局冲突）都不改动快照，
 *   对应 store 层用 Dexie 单事务包裹，写库失败即整体回滚。
 */
import type {
  ArrivalIssue,
  AuctionBid,
  AuctionCommand,
  AuctionLot,
  HammerResult,
  JournalStatus,
  LotStatus
} from '@/types/auction'
import { HELD_STATUSES, TERMINAL_STATUSES } from '@/types/auction'
import { nowIso } from '@/utils/id'

/** 账本快照：总预算 + 拍品 / 报价 / 到货三张物料表 */
export interface LedgerSnapshot {
  budget: number
  lots: AuctionLot[]
  bids: AuctionBid[]
  arrivals: AuctionArrivalShape[]
  /** 已应用的幂等键集合，保证重试不重复入账 */
  appliedKeys: Set<string>
}

/** 到货记录的最小结构（与 types/auction 的 AuctionArrival 同形，引擎不依赖 id） */
export interface AuctionArrivalShape {
  lotNo: string
  normal: boolean
  issue: ArrivalIssue | ''
  receivedQty: number
  note: string
  arrivedAt: string
  createdAt: string
}

/** 竞价阶段已结束：不能再报价 / 撤价 / 重复落槌（won 仍可到货登记） */
const BIDDING_CLOSED: LotStatus[] = ['won', ...TERMINAL_STATUSES]

/** 拒绝原因码；页面文案统一从 REJECTION_MESSAGES 取 */
export type RejectCode =
  | 'amount_invalid'
  | 'lot_not_found'
  | 'lot_terminal'
  | 'below_competitor'
  | 'below_own_high'
  | 'budget_short'
  | 'cancel_not_found'
  | 'not_won'
  | 'hammer_result_invalid'
  | 'arrival_duplicate'
  | 'already_applied'

export const REJECTION_MESSAGES: Record<RejectCode, string> = {
  amount_invalid: '金额必须为不小于 0 的整数',
  lot_not_found: '拍品不存在，请先在征集清单登记',
  lot_terminal: '这件已经落槌 / 撤拍 / 到货，现场旧操作不能覆盖结果',
  below_competitor: '同一件已被别人先报：出价须高于他人最高报价',
  below_own_high: '出价不高于本会场已有己方报价，未重复占用',
  budget_short: '预算不足，已保留草稿',
  cancel_not_found: '该会场没有可取消的己方有效报价',
  not_won: '只有己方落槌的拍品才能登记到货',
  hammer_result_invalid: '落槌结果无效',
  arrival_duplicate: '这件已到货登记，异常情况请先撤销原登记',
  already_applied: '该操作已合并过，跳过重放'
}

/** 命令推演选项 */
export interface ApplyOptions {
  /**
   * 会场预算口径（断网现场 / 回馆合并重放时使用）：
   * 每个会场各算一套占用，单件报价只要不超过「总预算」即可记账，
   * 多会场合计压超总预算的情况留给 mergePending 的 overrun 提醒，不当场拒绝。
   * 默认 false：线上口径，按当前剩余可用额度做增量校验。
   */
  laneBudget?: boolean
}

/** 命令推演结果 */
export interface ApplyOutcome {
  ok: boolean
  code?: RejectCode
  message: string
  /** 推演成功后的新快照（失败时为原快照引用，调用方不得据其写库） */
  snapshot: LedgerSnapshot
  /** 成功时受影响的报价（草稿 / 替代等提示用） */
  bid?: AuctionBid
  /** 成功时被置为 superseded 的报价（多会场重复登记，只保留一套占用） */
  supersededBids: AuctionBid[]
  /** 预算被压满时的非阻断提醒（合并多会场占用可能超出总预算） */
  warning?: string
}

/** 预算占用汇总 */
export interface BudgetSummary {
  budget: number
  /** 在拍 + 被压过 + 已落槌三件状态占用之和（每件只算己方最高一套） */
  held: number
  available: number
  /** 已到货结清的落槌价累计 */
  settled: number
  overrun: boolean
}

/* ------------------------------ 快照工具 ------------------------------ */

export function emptySnapshot(budget = 0): LedgerSnapshot {
  return { budget, lots: [], bids: [], arrivals: [], appliedKeys: new Set<string>() }
}

export function cloneSnapshot(s: LedgerSnapshot): LedgerSnapshot {
  return {
    budget: s.budget,
    lots: s.lots.map((l) => ({ ...l })),
    bids: s.bids.map((b) => ({ ...b })),
    arrivals: s.arrivals.map((a) => ({ ...a })),
    appliedKeys: new Set(s.appliedKeys)
  }
}

function roundAmount(v: number): number {
  return Math.round(Number(v) || 0)
}

function reject(snapshot: LedgerSnapshot, code: RejectCode, detail?: string): ApplyOutcome {
  return {
    ok: false,
    code,
    message: detail ? `${REJECTION_MESSAGES[code]}（${detail}）` : REJECTION_MESSAGES[code],
    snapshot,
    supersededBids: []
  }
}

function lotOf(s: LedgerSnapshot, lotNo: string): AuctionLot | undefined {
  return s.lots.find((l) => l.lotNo === lotNo)
}

function ownActiveBids(s: LedgerSnapshot, lotNo: string): AuctionBid[] {
  return s.bids.filter((b) => b.lotNo === lotNo && b.isOwn && b.state === 'active')
}

/** 一件拍品当前占用的意向额：己方在拍的最高有效出价；已落槌按落槌价 */
export function lotHeldAmount(lot: AuctionLot, bids: AuctionBid[]): number {
  if (lot.status === 'won') return roundAmount(lot.hammerPrice)
  if (lot.status !== 'watching' && lot.status !== 'outbid') return 0
  const amounts = bids
    .filter((b) => b.lotNo === lot.lotNo && b.isOwn && b.state === 'active')
    .map((b) => b.amount)
  return amounts.length ? Math.max(...amounts.map(roundAmount)) : 0
}

export function summarizeBudget(s: LedgerSnapshot): BudgetSummary {
  let held = 0
  let settled = 0
  for (const lot of s.lots) {
    if (HELD_STATUSES.includes(lot.status)) held += lotHeldAmount(lot, s.bids)
    if (lot.status === 'arrived') settled += roundAmount(lot.hammerPrice)
  }
  const budget = roundAmount(s.budget)
  return {
    budget,
    held,
    available: budget - held,
    settled,
    overrun: held > budget
  }
}

/* --------------------------- 拍品聚合（重算） --------------------------- */

/**
 * 重算一件拍品的派生字段：己方/他人最高报价、被压过状态。
 * 竞价取消、落槌、到货异常之后统一调用，保证「占用」始终跟随最新事实。
 */
function recomputeLot(lot: AuctionLot, bids: AuctionBid[]): void {
  const ofLot = bids.filter((b) => b.lotNo === lot.lotNo)
  const ownActive = ofLot.filter((b) => b.isOwn && b.state === 'active')
  const competitorActive = ofLot.filter((b) => !b.isOwn && b.state === 'active')
  lot.ownHigh = ownActive.length ? Math.max(...ownActive.map((b) => b.amount)) : 0
  lot.competitorHigh = competitorActive.length
    ? Math.max(...competitorActive.map((b) => b.amount))
    : 0
  // 只有还在竞价阶段的拍品才随报价翻状态；终局由 hammer / arrive 命令决定
  if (lot.status === 'watching' || lot.status === 'outbid') {
    lot.status = lot.ownHigh > 0 && lot.competitorHigh > lot.ownHigh ? 'outbid' : 'watching'
  }
}

/* ------------------------------ 命令推演 ------------------------------ */

function applySetBudget(s: LedgerSnapshot, amount: number): ApplyOutcome {
  if (!Number.isFinite(amount) || amount < 0) return reject(s, 'amount_invalid')
  const next = cloneSnapshot(s)
  next.budget = roundAmount(amount)
  return { ok: true, message: `总预算已调整为 ${next.budget} 元`, snapshot: next, supersededBids: [] }
}

function applyUpsertLot(s: LedgerSnapshot, cmd: Extract<AuctionCommand, { type: 'upsertLot' }>): ApplyOutcome {
  if (cmd.ceiling < 0 || !Number.isFinite(cmd.ceiling)) return reject(s, 'amount_invalid')
  if (!cmd.lotNo.trim() || !cmd.title.trim()) return reject(s, 'amount_invalid', '拍品号与名称必填')
  const next = cloneSnapshot(s)
  const existing = lotOf(next, cmd.lotNo)
  const ts = nowIso()
  if (existing) {
    existing.title = cmd.title
    existing.category = cmd.category
    existing.refId = cmd.refId
    existing.source = cmd.source
    existing.ceiling = roundAmount(cmd.ceiling)
    existing.note = cmd.note
    existing.updatedAt = ts
    recomputeLot(existing, next.bids)
    return { ok: true, message: `已更新征集 ${cmd.lotNo}`, snapshot: next, supersededBids: [] }
  }
  const lot: AuctionLot = {
    lotNo: cmd.lotNo,
    title: cmd.title,
    category: cmd.category,
    refId: cmd.refId,
    source: cmd.source,
    ceiling: roundAmount(cmd.ceiling),
    competitorHigh: 0,
    ownHigh: 0,
    status: 'watching',
    hammerPrice: 0,
    winner: '',
    hammerAt: '',
    note: cmd.note,
    createdAt: ts,
    updatedAt: ts
  }
  next.lots.push(lot)
  return { ok: true, message: `已登记征集 ${cmd.lotNo}`, snapshot: next, supersededBids: [] }
}

function applyRegisterBid(
  s: LedgerSnapshot,
  cmd: Extract<AuctionCommand, { type: 'registerBid' }>,
  options: ApplyOptions = {}
): ApplyOutcome {
  const amount = roundAmount(cmd.amount)
  if (!Number.isFinite(amount) || amount <= 0) return reject(s, 'amount_invalid')
  const lot = lotOf(s, cmd.lotNo)
  if (!lot) return reject(s, 'lot_not_found')
  if (BIDDING_CLOSED.includes(lot.status)) return reject(s, 'lot_terminal')

  // 他人报价：只更新「别人先报」的情报线，不碰预算
  if (!cmd.isOwn) {
    if (amount <= lot.competitorHigh) {
      return reject(s, 'below_competitor', `他人最高已有 ${lot.competitorHigh} 元`)
    }
    const next = cloneSnapshot(s)
    const bid: AuctionBid = {
      lotNo: cmd.lotNo,
      amount,
      isOwn: false,
      venue: cmd.venue,
      bidAt: cmd.bidAt,
      state: 'active',
      reason: '',
      winning: false,
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    next.bids.push(bid)
    const target = lotOf(next, cmd.lotNo)!
    recomputeLot(target, next.bids)
    return {
      ok: true,
      message: `已记录他人报价 ${amount} 元`,
      snapshot: next,
      bid,
      supersededBids: []
    }
  }

  // 己方报价：须高过他人线、高过本会场已有己方报价
  if (amount <= lot.competitorHigh) {
    return reject(s, 'below_competitor', `差额 ${lot.competitorHigh + 1 - amount} 元`)
  }
  const sameVenueOwn = s.bids.find(
    (b) =>
      b.lotNo === cmd.lotNo &&
      b.isOwn &&
      b.venue === cmd.venue &&
      b.state === 'active' &&
      b.amount >= amount
  )
  if (sameVenueOwn) {
    return reject(s, 'below_own_high', `本会场最高已报 ${sameVenueOwn.amount} 元`)
  }

  // 每件只占用「一套」意向额：新增出价只占用（新高 − 旧高）的增量
  const summary = summarizeBudget(s)
  const increment = amount - Math.max(lot.ownHigh, 0)
  // 会场口径：单件报价不超过总预算即可（各会场各算一套，合计超限仅提醒）
  const laneCap = options.laneBudget
  const rejected = laneCap
    ? amount > s.budget
    : increment > 0 && increment > Math.max(0, summary.available)
  if (rejected) {
    const short = increment - Math.max(0, summary.available)
    return reject(
      s,
      'budget_short',
      laneCap
        ? `报价 ${amount} 元超过总预算 ${s.budget} 元，差额 ${amount - s.budget} 元`
        : `需再占用 ${increment} 元，可用预算仅 ${Math.max(0, summary.available)} 元，差额 ${short} 元`
    )
  }

  const next = cloneSnapshot(s)
  const bid: AuctionBid = {
    lotNo: cmd.lotNo,
    amount,
    isOwn: true,
    venue: cmd.venue,
    bidAt: cmd.bidAt,
    state: 'active',
    reason: '',
    winning: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  }
  next.bids.push(bid)

  // 多会场重复登记：同一件旧的己方有效报价被新高替代，释放其占用
  const superseded = ownActiveBids(next, cmd.lotNo).filter((b) => b.amount < amount)
  for (const b of superseded) {
    b.state = 'superseded'
    b.reason = `同一件在「${cmd.venue}」已有更高报价 ${amount} 元，本报价不再占用预算`
    b.updatedAt = nowIso()
  }
  const target = lotOf(next, cmd.lotNo)!
  recomputeLot(target, next.bids)
  return {
    ok: true,
    message: `已为 ${cmd.lotNo} 登记己方报价 ${amount} 元，占用意向额 ${Math.max(
      0,
      increment
    )} 元`,
    snapshot: next,
    bid,
    supersededBids: superseded
  }
}

function applyCancelBidding(
  s: LedgerSnapshot,
  cmd: Extract<AuctionCommand, { type: 'cancelBidding' }>
): ApplyOutcome {
  const lot = lotOf(s, cmd.lotNo)
  if (!lot) return reject(s, 'lot_not_found')
  if (BIDDING_CLOSED.includes(lot.status)) return reject(s, 'lot_terminal')
  const targets = ownActiveBids(s, cmd.lotNo).filter(
    (b) => cmd.venue === '' || b.venue === cmd.venue
  )
  if (!targets.length) return reject(s, 'cancel_not_found')
  // 快照经过克隆，不能用引用匹配，统一用报价业务键定位
  const targetKeys = new Set(targets.map(bidKey))
  const next = cloneSnapshot(s)
  const ts = nowIso()
  for (const b of next.bids) {
    if (b.isOwn && b.lotNo === cmd.lotNo && (targetKeys.has(bidKey(b)) || (cmd.bidKey && bidKey(b) === cmd.bidKey))) {
      b.state = 'cancelled'
      b.reason = cmd.reason || '竞价取消'
      b.updatedAt = ts
    }
  }
  const target = lotOf(next, cmd.lotNo)!
  recomputeLot(target, next.bids)
  return {
    ok: true,
    message: `已取消 ${cmd.lotNo} 在该会场的己方报价，释放意向额`,
    snapshot: next,
    supersededBids: []
  }
}

function applyHammer(s: LedgerSnapshot, cmd: Extract<AuctionCommand, { type: 'hammer' }>): ApplyOutcome {
  const lot = lotOf(s, cmd.lotNo)
  if (!lot) return reject(s, 'lot_not_found')
  // 落槌结果一旦入账即终局：断网记录里的旧落槌不能把结果盖掉
  if (TERMINAL_STATUSES.includes(lot.status) || lot.status === 'won') {
    return reject(s, 'lot_terminal', `当前状态：${lot.status}`)
  }
  const price = roundAmount(cmd.price)
  const results: HammerResult[] = ['won', 'lost', 'unsold']
  if (!results.includes(cmd.result) || (cmd.result === 'won' && price <= 0)) {
    return reject(s, 'hammer_result_invalid')
  }
  const next = cloneSnapshot(s)
  const target = lotOf(next, cmd.lotNo)!
  const ts = nowIso()
  target.hammerPrice = price
  target.winner = cmd.winner
  target.hammerAt = cmd.hammerAt
  target.updatedAt = ts
  const lotBids = next.bids.filter((b) => b.lotNo === cmd.lotNo && b.state !== 'cancelled')
  if (cmd.result === 'won') {
    target.status = 'won'
    target.winner = cmd.winner || '己方'
    for (const b of lotBids) {
      b.winning = b.isOwn && b.amount <= price && b.state === 'active'
      b.updatedAt = ts
    }
  } else {
    // lost / unsold：释放全部占用；未中标报价保留留档
    target.status = 'lost'
    target.winner = cmd.result === 'unsold' ? '流拍' : cmd.winner || '他人'
    for (const b of lotBids) {
      b.winning = false
      b.updatedAt = ts
    }
  }
  return {
    ok: true,
    message:
      cmd.result === 'won'
        ? `${cmd.lotNo} 己方以 ${price} 元落槌，意向额转为成交占用`
        : `${cmd.lotNo} ${cmd.result === 'unsold' ? '流拍' : '他人竞得'}，意向额已释放`,
    snapshot: next,
    supersededBids: []
  }
}

function applyArrive(s: LedgerSnapshot, cmd: Extract<AuctionCommand, { type: 'arrive' }>): ApplyOutcome {
  const lot = lotOf(s, cmd.lotNo)
  if (!lot) return reject(s, 'lot_not_found')
  if (lot.status !== 'won') return reject(s, 'not_won', `当前状态：${lot.status}`)
  const next = cloneSnapshot(s)
  const target = lotOf(next, cmd.lotNo)!
  const arrival: AuctionArrivalShape = {
    lotNo: cmd.lotNo,
    normal: cmd.normal,
    issue: cmd.issue,
    receivedQty: Math.max(0, Math.trunc(cmd.receivedQty || 0)),
    note: cmd.note,
    arrivedAt: cmd.arrivedAt,
    createdAt: nowIso()
  }
  next.arrivals.push(arrival)
  if (cmd.normal) {
    target.status = 'arrived'
  } else {
    // 到货异常：成交占用立即释放，回到在拍前的待处理态
    target.status = 'anomaly'
    target.hammerPrice = 0
    target.hammerAt = ''
  }
  target.updatedAt = nowIso()
  return {
    ok: true,
    message: cmd.normal
      ? `${cmd.lotNo} 正常到货，成交占用 ${lot.hammerPrice} 元已结清`
      : `${cmd.lotNo} 到货异常，成交占用 ${lot.hammerPrice} 元已释放，待处理`,
    snapshot: next,
    supersededBids: []
  }
}

/** 在快照上推演一条命令（不做幂等检查；幂等由 merge / store 层把关）。 */
export function applyCommand(
  s: LedgerSnapshot,
  cmd: AuctionCommand,
  options: ApplyOptions = {}
): ApplyOutcome {
  switch (cmd.type) {
    case 'setBudget':
      return applySetBudget(s, cmd.amount)
    case 'upsertLot':
      return applyUpsertLot(s, cmd)
    case 'registerBid':
      return applyRegisterBid(s, cmd, options)
    case 'cancelBidding':
      return applyCancelBidding(s, cmd)
    case 'hammer':
      return applyHammer(s, cmd)
    case 'arrive':
      return applyArrive(s, cmd)
    default:
      return reject(s, 'hammer_result_invalid')
  }
}

/* --------------------------- 报价键（取消 / 幂等） --------------------------- */

export function bidKey(b: AuctionBid): string {
  return `${b.lotNo}|${b.venue}|${b.amount}|${b.bidAt}`
}

/* ------------------------------ 断网合并 ------------------------------ */

export interface PendingEntry {
  idempotencyKey: string
  venue: string
  occurredAt: string
  command: AuctionCommand
}

export interface MergeItemResult {
  key: string
  status: JournalStatus
  message: string
  command: AuctionCommand
  /** registerBid 被拒绝且可留草稿时，草稿对应的报价（金额 / 差额回显用） */
  draftBid?: AuctionBid
}

export interface MergeReport {
  results: MergeItemResult[]
  applied: number
  conflicts: number
  drafts: number
  /** 合并后快照（写库失败时整体丢弃，调用方据此回滚） */
  snapshot: LedgerSnapshot
  warning?: string
}

/** 断网场景下，这些拒绝可以保留为草稿（不占预算、改价后可重试） */
const DRAFTABLE: RejectCode[] = ['budget_short', 'below_competitor']

/**
 * 回馆合并：把各会场 pending 操作按发生时间排序后逐条重放到同一套账。
 * 任一条都不阻断后续条目；终局冲突记 conflict，预算/被压过记 draft。
 * 注意：本函数只做内存推演，store 层拿到 snapshot 后必须与 journal 置位放在同一事务写库。
 */
export function mergePending(base: LedgerSnapshot, entries: PendingEntry[]): MergeReport {
  const sorted = [...entries].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  let current = base
  const results: MergeItemResult[] = []
  let applied = 0
  let conflicts = 0
  let drafts = 0

  for (const entry of sorted) {
    if (current.appliedKeys.has(entry.idempotencyKey)) {
      results.push({
        key: entry.idempotencyKey,
        status: 'conflict',
        message: REJECTION_MESSAGES.already_applied,
        command: entry.command
      })
      conflicts += 1
      continue
    }
    const outcome = applyCommand(current, entry.command, { laneBudget: true })
    if (outcome.ok) {
      current = outcome.snapshot
      current.appliedKeys.add(entry.idempotencyKey)
      applied += 1
      results.push({
        key: entry.idempotencyKey,
        status: 'applied',
        message: outcome.warning ? `${outcome.message}；${outcome.warning}` : outcome.message,
        command: entry.command
      })
      continue
    }
    // registerBid（己方）预算不足或被别人先报：保留草稿并说明差额
    if (entry.command.type === 'registerBid' && entry.command.isOwn && outcome.code && DRAFTABLE.includes(outcome.code)) {
      const draftBid: AuctionBid = {
        lotNo: entry.command.lotNo,
        amount: roundAmount(entry.command.amount),
        isOwn: true,
        venue: entry.venue || entry.command.venue,
        bidAt: entry.command.bidAt,
        state: 'draft',
        reason: outcome.message,
        winning: false,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
      drafts += 1
      results.push({
        key: entry.idempotencyKey,
        status: 'draft',
        message: outcome.message,
        command: entry.command,
        draftBid
      })
      continue
    }
    conflicts += 1
    results.push({
      key: entry.idempotencyKey,
      status: 'conflict',
      message: outcome.message,
      command: entry.command
    })
  }

  const summary = summarizeBudget(current)
  const warning = summary.overrun
    ? `多会场合并后占用 ${summary.held} 元，超出总预算 ${summary.budget} 元，差额 ${
        summary.held - summary.budget
      } 元，请调整预算或撤价`
    : undefined
  return { results, applied, conflicts, drafts, snapshot: current, warning }
}

/* --------------------------- 单会场视图（断网页面） --------------------------- */

/**
 * 从总账快照 + 各会场操作账构造会场视图：
 * - 征集（upsertLot）是跨会场共享的清单：所有会场的待合并征集都先建入视图，
 *   这样 B 会场也能给 A 会场刚登记、尚未回馆合并的同一件登记报价；
 * - 报价 / 取消 / 落槌 / 到货等账本操作只回放本会场的 pending（draft 不参与，草稿不占预算）；
 * - 不回放 setBudget，预算以总账为准。
 * 已合并（applied）的影响已在总账里，直接继承。
 */
export function buildLaneSnapshot(
  base: LedgerSnapshot,
  laneEntries: PendingEntry[],
  allPending: PendingEntry[] = []
): LedgerSnapshot {
  let view = cloneSnapshot(base)
  const ordered = [...allPending, ...laneEntries].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt)
  )
  const seen = new Set<string>()
  for (const entry of ordered) {
    if (entry.command.type === 'setBudget') continue
    // 征集清单跨会场共享：每个 upsertLot 只回放一次（本会场优先）
    if (entry.command.type === 'upsertLot') {
      if (seen.has(entry.command.lotNo)) continue
      seen.add(entry.command.lotNo)
    } else if (!laneEntries.includes(entry)) {
      continue
    }
    // 会场口径：本会场登记按总预算试算，不与其他会场的占用互相挤兑
    const outcome = applyCommand(view, entry.command, { laneBudget: true })
    if (outcome.ok) view = outcome.snapshot
  }
  return view
}

/** 现场登记前的试算：返回拒绝原因与差额说明；成功时给出占用增量。 */
export interface DryRunBid {
  ok: boolean
  code?: RejectCode
  message: string
  /** 登记后需新增占用的意向额（元） */
  increment: number
  available: number
}

export function dryRunRegisterBid(
  s: LedgerSnapshot,
  input: { lotNo: string; amount: number; isOwn: boolean; venue: string }
): DryRunBid {
  const probe = applyCommand(s, {
    type: 'registerBid',
    lotNo: input.lotNo,
    amount: roundAmount(input.amount),
    isOwn: input.isOwn,
    venue: input.venue,
    bidAt: ''
  })
  const lot = lotOf(s, input.lotNo)
  const before = lot ? lotHeldAmount(lot, s.bids) : 0
  const summary = summarizeBudget(s)
  return {
    ok: probe.ok,
    code: probe.code,
    message: probe.message,
    increment: probe.ok ? Math.max(0, roundAmount(input.amount) - before) : 0,
    available: summary.available
  }
}
