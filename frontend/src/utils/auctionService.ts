/**
 * 拍卖台账领域服务：所有写操作都在 Dexie 事务内完成，写库失败整体回滚。
 *
 * 记账规则：
 *  1. 每件意向登记先按【会场】占用意向额；占用 = 在拍意向额 + 竞得待付。
 *     预算不足、或同一件在同会场已被别人以不低于的价格先报 → 保留草稿并写明差额。
 *  2. 取消竞价 / 落槌（竞得转应付、未得释放）/ 到货（正常或异常折让）都会重算占用。
 *  3. 终局结果受保护：断网记录回馆合并时，已落槌、已取消、已到货的记录不会被覆盖，
 *     只产生冲突说明。
 *  4. 断网操作先进 outbox 队列，回馆按发生时间逐条、幂等回放；任何一条写库失败
 *     都停在操作前，标记"待重试"，可在排除故障后原样重试。
 */
import { db } from './db'
import { nowIso, uid } from './id'
import type {
  ArrivalInput,
  ArrivalStatus,
  AuctionArrival,
  AuctionBid,
  AuctionJournal,
  AuctionLot,
  AuctionOp,
  AuctionOpPayload,
  AuctionResult,
  AuctionVenue,
  ArrivalOpPayload,
  BidRejectReason,
  BidStatus,
  ResultInput,
  ResultOpPayload
} from '@/types/auction'

const TX_TABLES = [
  db.auctionLots,
  db.auctionVenues,
  db.auctionBids,
  db.auctionResults,
  db.auctionArrivals,
  db.auctionOps,
  db.auctionJournal
] as const

/** 模拟写库故障的开关（演示"回到操作前 + 可重试"），持久化在 localStorage。 */
const FAIL_KEY = 'gbpostmark:auction:simulate-write-fail'

export class SimulatedWriteError extends Error {
  constructor() {
    super('模拟写库失败：存储不可写（可关闭故障注入后重试）')
    this.name = 'SimulatedWriteError'
  }
}

export function isWriteFailSimulation(): boolean {
  try {
    return globalThis.localStorage?.getItem(FAIL_KEY) === '1'
  } catch {
    return false
  }
}

export function setWriteFailSimulation(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(FAIL_KEY, '1')
    else globalThis.localStorage?.removeItem(FAIL_KEY)
  } catch {
    /* localStorage 不可用时忽略，开关退化为会话内无效 */
  }
}

/** 事务入口的故障注入点：在任何写入之前抛出，触发整笔回滚。 */
function assertWritable(): void {
  if (isWriteFailSimulation()) throw new SimulatedWriteError()
}

/* ------------------------------ 只读视图 ------------------------------ */

export interface LedgerData {
  lots: AuctionLot[]
  venues: AuctionVenue[]
  bids: AuctionBid[]
  results: AuctionResult[]
  arrivals: AuctionArrival[]
  ops: AuctionOp[]
  journals: AuctionJournal[]
}

async function loadAll(): Promise<LedgerData> {
  const [lots, venues, bids, results, arrivals, ops, journals] = await Promise.all([
    db.auctionLots.orderBy('lotNo').toArray(),
    db.auctionVenues.orderBy('sessionDate').toArray(),
    db.auctionBids.toCollection().sortBy('createdAt'),
    db.auctionResults.toCollection().sortBy('createdAt'),
    db.auctionArrivals.toCollection().sortBy('createdAt'),
    db.auctionOps.orderBy('occurredAt').toArray(),
    db.auctionJournal.orderBy('createdAt').reverse().toArray()
  ])
  return { lots, venues, bids, results, arrivals, ops, journals }
}

export interface VenueStats {
  /** 预算总额 */
  budget: number
  /** 在拍意向占用 */
  held: number
  /** 竞得待付（落槌价 + 佣金，尚未到货结清） */
  payable: number
  /** 到货已结（含异常折让后的实付） */
  settled: number
  /** 总占用 = 在拍 + 待付 */
  committed: number
  /** 剩余预算 */
  available: number
}

/**
 * 纯函数：按会场汇总预算占用。
 * 多个会场对同一件各算一套——这里只接收本会场的记录。
 */
export function venueStats(
  venue: AuctionVenue,
  bids: AuctionBid[],
  results: AuctionResult[],
  arrivals: AuctionArrival[]
): VenueStats {
  const held = bids
    .filter((b) => b.venueId === venue.id && b.status === 'active' && b.bidder === 'me')
    .reduce((s, b) => s + b.amount, 0)

  const settledResultIds = new Set(
    arrivals
      .filter((a) => a.venueId === venue.id && (a.status === 'received' || a.status === 'abnormal'))
      .map((a) => a.resultId)
  )

  let payable = 0
  let settled = 0
  for (const r of results.filter((x) => x.venueId === venue.id && x.won)) {
    if (settledResultIds.has(r.id as number)) {
      const a = arrivals.find((x) => x.resultId === r.id)
      settled += a?.settledAmount ?? 0
    } else {
      payable += r.hammerPrice + r.buyerPremium
    }
  }

  const committed = held + payable
  return {
    budget: venue.budget,
    held,
    payable,
    settled,
    committed,
    available: venue.budget - committed
  }
}

/** 某会场 + 某标的上，别人的最高在拍报价（本人出价不参与）。 */
export function competitorTop(
  venueId: number,
  lotId: number,
  bids: AuctionBid[]
): { bidder: string; amount: number } | null {
  const top = bids
    .filter((b) => b.venueId === venueId && b.lotId === lotId && b.status === 'active' && b.bidder !== 'me')
    .sort((a, b) => b.amount - a.amount)[0]
  return top ? { bidder: top.bidder, amount: top.amount } : null
}

/** 本人在某会场 + 某标的上最近一条可修改的报价（在拍或草稿，用于改价/重试）。 */
function myOpenBid(
  venueId: number,
  lotId: number,
  bids: AuctionBid[]
): AuctionBid | null {
  return (
    bids
      .filter(
        (b) =>
          b.venueId === venueId &&
          b.lotId === lotId &&
          b.bidder === 'me' &&
          (b.status === 'active' || b.status === 'draft')
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null
  )
}

function resultOf(
  venueId: number,
  lotId: number,
  results: AuctionResult[]
): AuctionResult | null {
  return results.find((r) => r.venueId === venueId && r.lotId === lotId) ?? null
}

/* ------------------------------ 日志 ------------------------------ */

async function addJournal(
  opId: string,
  type: AuctionJournal['type'],
  venueId: number,
  lotId: number,
  action: string,
  detail: string,
  offline: boolean,
  at: string
): Promise<void> {
  await db.auctionJournal.add({ opId, type, venueId, lotId, action, detail, offline, createdAt: at })
}

/* ------------------------------ 登记结果类型 ------------------------------ */

export interface RegisterBidOutcome {
  ok: boolean
  bidId?: number
  status: BidStatus
  reason: BidRejectReason
  /** 差额：预算缺口 或 与最高报价的差距（元） */
  shortfall: number
  message: string
  offline: boolean
  queued: boolean
}

interface RegisterBidInput {
  venueId: number
  lotId: number
  amount: number
  note: string
  offline: boolean
  /** 出价人，默认本人；UI 可模拟场内其它买家先报（不占用本人预算） */
  bidder?: string
  /** 由草稿改价重试 / 断网回放时复用既有报价 */
  bidUid?: string
  opId?: string
}

/* ------------------------------ 意向登记 ------------------------------ */

/**
 * 登记意向价：先做"别人先报"与预算两道校验，任一不过即保留草稿（附差额），
 * 不占用预算；通过则写入在拍并占用意向额。断网时本地同样生效，并入 outbox。
 *
 * 非本人出价（模拟场内其它号牌）不做预算/草稿处理：直接记一条在拍报价，
 * 用来触发后续本人出价时的"已被别人先报"判定。
 */
async function registerBid(input: RegisterBidInput): Promise<RegisterBidOutcome> {
  const { venueId, lotId, amount, note, offline } = input
  const bidder = input.bidder || 'me'
  const at = nowIso()
  const opId = input.opId ?? uid('op')
  const bidUid = input.bidUid ?? uid('bid')
  assertWritable()

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('意向价必须是大于 0 的数字')
  }

  // 他人出价在事务内直接带回结果，避免事务结束后回读的时序问题
  let competitorResult: RegisterBidOutcome | null = null
  // 改价/重试时沿用被更新报价的 uid，保证事务后回读得到同一条
  let effectiveBidUid = bidUid

  await db.transaction('rw', TX_TABLES, async () => {
    const venue = await db.auctionVenues.get(venueId)
    if (!venue) throw new Error('会场不存在')
    const lot = await db.auctionLots.get(lotId)
    if (!lot) throw new Error('标的不在征集清单中')

    const bids = await db.auctionBids.toArray()
    const results = await db.auctionResults.toArray()
    const arrivals = await db.auctionArrivals.toArray()

    if (bidder !== 'me') {
      // 其它买家出价：终局件不再接受，其余直接登记（不占用本人预算、不入 outbox）
      if (resultOf(venueId, lotId, results)) {
        throw new Error('该件已落槌，不能再登记出价')
      }
      const competitorId = await db.auctionBids.add({
        uid: bidUid,
        venueId,
        lotId,
        bidder,
        amount,
        status: 'active',
        rejectReason: '',
        shortfall: 0,
        note,
        offline: false,
        createdAt: at,
        updatedAt: at
      })
      await addJournal(
        opId,
        'bid',
        venueId,
        lotId,
        '他人出价',
        `${lot.lotNo} ${bidder} 出价 ${amount} 元（不占用本人预算）。`,
        false,
        at
      )
      competitorResult = {
        ok: true,
        bidId: competitorId,
        status: 'active',
        reason: '',
        shortfall: 0,
        message: `已登记 ${bidder} 出价 ${amount} 元（不占用本人预算）。`,
        offline: false,
        queued: false
      }
      return
    }

    // 终局保护：已有落槌结果的件不再接受新出价（回放断网记录时走到这里）
    const closed = resultOf(venueId, lotId, results)
    const existing = myOpenBid(venueId, lotId, bids)
    const target = input.bidUid
      ? (bids.find((b) => b.uid === input.bidUid) ?? existing)
      : existing

    let status: BidStatus = 'active'
    let reason: BidRejectReason = ''
    let shortfall = 0
    const extra: string[] = []

    if (closed) {
      status = 'rejected'
      reason = 'closed_lot'
      extra.push(`该件已落槌（${closed.won ? '本人竞得' : `${closed.winner} 竞得`}）`)
    } else {
      const top = competitorTop(venueId, lotId, bids)
      const stats = venueStats(venue, bids, results, arrivals)
      // 改价重试时，原在拍意向额先释放再重算
      const replacing = target?.status === 'active' ? target.amount : 0
      const available = stats.available + replacing

      if (top && top.amount >= amount) {
        status = 'draft'
        reason = 'outbid'
        shortfall = top.amount - amount
        extra.push(`${top.bidder} 已报 ${top.amount} 元`)
      } else if (amount > available) {
        status = 'draft'
        reason = 'budget_short'
        shortfall = Math.round((amount - available) * 100) / 100
        extra.push(`本场可用预算 ${available} 元`)
      }

      // 两个条件同时不满足时，把另一个差额也写进说明
      if (reason === 'outbid' && top && amount > available) {
        extra.push(`另外预算也不足，缺口 ${Math.round((amount - available) * 100) / 100} 元`)
      }
      if (reason === 'budget_short' && top && top.amount >= amount) {
        extra.push(`另外 ${top.bidder} 已报 ${top.amount} 元`)
      }
    }

    if (target && typeof target.id === 'number') {
      effectiveBidUid = target.uid
      await db.auctionBids.update(target.id, {
        amount,
        status,
        rejectReason: reason,
        shortfall,
        note: note || target.note,
        offline: target.offline || offline,
        updatedAt: at
      })
    } else {
      const row: AuctionBid = {
        uid: bidUid,
        venueId,
        lotId,
        bidder: 'me',
        amount,
        status,
        rejectReason: reason,
        shortfall,
        note,
        offline,
        createdAt: at,
        updatedAt: at
      }
      const id = await db.auctionBids.add(row)
      void id
    }

    const action =
      status === 'active' ? '占用意向额' : status === 'rejected' ? '合并丢弃' : '保留草稿'
    const detail =
      status === 'active'
        ? `${lot.lotNo} 意向 ${amount} 元，占用本场预算。`
        : status === 'rejected'
          ? `${lot.lotNo} 出价 ${amount} 元：${extra.join('；')}。`
          : `${lot.lotNo} 出价 ${amount} 元未成意向：${reason === 'outbid' ? '别人先报' : '预算不足'}，差额 ${shortfall} 元${extra.length ? `（${extra.join('；')}）` : ''}。`
    await addJournal(opId, 'bid', venueId, lotId, action, detail, offline, at)

    if (offline) {
      await enqueueOp(
        {
          opId,
          type: 'bid',
          venueId,
          lotId,
          occurredAt: at,
          bidUid: target?.uid ?? bidUid,
          amount,
          note
        },
        at
      )
    }
  })

  if (competitorResult) return competitorResult

  const saved = await db.auctionBids
    .where('uid')
    .equals(effectiveBidUid)
    .first()

  if (!saved) throw new Error('登记后读回报价失败')
  const stats = await venueStatsOf(venueId)
  const status = saved.status
  const ok = status === 'active'
  const message = ok
    ? `已登记意向 ${saved.amount} 元；本会场剩余预算 ${stats.available} 元${offline ? '（断网已记，回馆合并）' : ''}。`
    : status === 'rejected'
      ? `该件已终局，出价 ${saved.amount} 元已丢弃。`
      : saved.rejectReason === 'outbid'
        ? `同一件已被别人先报，出价 ${saved.amount} 元保留为草稿；需加价至少 ${saved.shortfall + 1} 元（现最高 ${saved.amount + saved.shortfall} 元）。`
        : `预算不足，出价 ${saved.amount} 元保留为草稿；差额 ${saved.shortfall} 元（本场剩余 ${stats.available} 元）。`

  return {
    ok,
    bidId: saved.id,
    status,
    reason: saved.rejectReason,
    shortfall: saved.shortfall,
    message,
    offline,
    queued: offline
  }
}

async function venueStatsOf(venueId: number): Promise<VenueStats> {
  const venue = await db.auctionVenues.get(venueId)
  if (!venue) throw new Error('会场不存在')
  const [bids, results, arrivals] = await Promise.all([
    db.auctionBids.toArray(),
    db.auctionResults.toArray(),
    db.auctionArrivals.toArray()
  ])
  return venueStats(venue, bids, results, arrivals)
}

/* ------------------------------ 取消竞价 ------------------------------ */

interface CancelInput {
  bidId: number
  note: string
  offline: boolean
  opId?: string
}

/** 取消竞价：在拍意向释放占用；已是终局（竞得/未得/丢弃）则拒绝并说明。 */
async function cancelBid(input: CancelInput): Promise<{ ok: boolean; message: string }> {
  const at = nowIso()
  const opId = input.opId ?? uid('op')
  assertWritable()
  await db.transaction('rw', TX_TABLES, async () => {
    const bid = await db.auctionBids.get(input.bidId)
    if (!bid) throw new Error('报价不存在')
    const lot = await db.auctionLots.get(bid.lotId)

    if (bid.status === 'active' || bid.status === 'draft') {
      await db.auctionBids.update(bid.id as number, {
        status: 'cancelled',
        rejectReason: '',
        shortfall: 0,
        updatedAt: at
      })
      await addJournal(
        opId,
        'cancel',
        bid.venueId,
        bid.lotId,
        '取消竞价',
        `${lot?.lotNo ?? ''} 原意向 ${bid.amount} 元取消，${bid.status === 'active' ? '释放占用。' : '草稿作废。'}`,
        input.offline,
        at
      )
    } else {
      // 终局取消：在合并层补冲突日志（事务即将回滚，事务内日志留不住）
      const conflict = new Error(`该报价已是终局（${bid.status}），不能取消`)
      ;(conflict as Error & { conflict?: boolean; conflictDetail?: string }).conflict = true
      ;(conflict as Error & { conflictDetail?: string }).conflictDetail =
        `${lot?.lotNo ?? ''} 报价已处于「${bid.status}」终局，取消不生效。`
      throw conflict
    }

    if (input.offline) {
      await enqueueOp(
        {
          opId,
          type: 'cancel',
          venueId: bid.venueId,
          lotId: bid.lotId,
          occurredAt: at,
          bidUid: bid.uid,
          note: input.note
        },
        at
      )
    }
  })
  return {
    ok: true,
    message: `已取消竞价并释放意向额。${input.offline ? '断网已记，回馆合并。' : ''}`
  }
}

/* ------------------------------ 落槌结果 ------------------------------ */

/**
 * 登记落槌结果：
 *  - 本人竞得：在拍意向额转应付（hammerPrice + buyerPremium），关联最高有效报价；
 *  - 未竞得：本人在拍报价全部置"未得"并释放占用；
 *  - 断网回放遇既有不同结果：不覆盖真相，只记冲突。
 */
async function recordResult(input: ResultInput): Promise<{ ok: boolean; message: string }> {
  const at = nowIso()
  const opId = input.opId ?? uid('op')
  const resultUid = input.resultUid ?? uid('result')
  assertWritable()
  if (!Number.isFinite(input.hammerPrice) || input.hammerPrice < 0) {
    throw new Error('落槌价必须是非负数字')
  }

  await db.transaction('rw', TX_TABLES, async () => {
    const lot = await db.auctionLots.get(input.lotId)
    if (!lot) throw new Error('标的不存在')
    const existing = resultOf(input.venueId, input.lotId, await db.auctionResults.toArray())

    if (existing) {
      const same =
        existing.winner === input.winner &&
        existing.hammerPrice === input.hammerPrice &&
        existing.won === input.won
      if (same) {
        // 幂等：断网回放同一条结果，直接补 outbox 状态，不重复改账
        await addJournal(
          opId,
          'result',
          input.venueId,
          input.lotId,
          '结果重复',
          `${lot.lotNo} 落槌结果与台账一致（${input.winner}，${input.hammerPrice} 元），跳过。`,
          input.offline,
          at
        )
      } else if (input.offline) {
        // 关键规则：后到的断网记录不能盖掉馆内/拍场已有的落槌真相。
        // 事务即将回滚，冲突留痕由合并层在事务外补写（recordConflict）。
        const err = new Error('CONFLICT')
        ;(err as Error & { conflict?: boolean; conflictKind?: string; conflictDetail?: string }).conflict = true
        ;(err as Error & { conflictKind?: string }).conflictKind = 'result'
        ;(err as Error & { conflictDetail?: string }).conflictDetail =
          `${lot.lotNo} 断网结果（${input.winner}，${input.hammerPrice} 元）与已有落槌（${existing.winner}，${existing.hammerPrice} 元）不同，保留原结果。`
        throw err
      } else {
        // 线上（回馆在拍场终端核对）允许更正，并留痕
        await applyResultUpsert(existing.id as number, resultUid, input, at)
        await addJournal(
          opId,
          'result',
          input.venueId,
          input.lotId,
          '结果更正',
          `${lot.lotNo} 落槌由「${existing.winner} ${existing.hammerPrice} 元」更正为「${input.winner} ${input.hammerPrice} 元」。`,
          false,
          at
        )
      }
    } else {
      const id = await applyResultUpsert(null, resultUid, input, at)
      const action = input.won ? '竞得转应付' : '未得释放'
      const detail = input.won
        ? `${lot.lotNo} 以 ${input.hammerPrice} 元（佣金 ${input.buyerPremium} 元）竞得，意向额转应付。`
        : `${lot.lotNo} 由 ${input.winner} 以 ${input.hammerPrice} 元竞得，本人意向释放。`
      await addJournal(opId, 'result', input.venueId, input.lotId, action, detail, input.offline, at)
      void id
    }

    if (input.offline) {
      const payload: ResultOpPayload = {
        opId,
        type: 'result',
        venueId: input.venueId,
        lotId: input.lotId,
        occurredAt: at,
        resultUid,
        winner: input.winner,
        hammerPrice: input.hammerPrice,
        buyerPremium: input.buyerPremium,
        won: input.won
      }
      await enqueueOp(payload, at)
    }
  })

  return {
    ok: true,
    message: input.won
      ? `已登记竞得：落槌 ${input.hammerPrice} 元 + 佣金 ${input.buyerPremium} 元，转为应付。`
      : `已登记未竞得（${input.winner} ${input.hammerPrice} 元），释放本人意向占用。`
  }
}

async function applyResultUpsert(
  existingId: number | null,
  resultUid: string,
  input: ResultInput,
  at: string
): Promise<number> {
  // 关联本人在该会场该标的上最高的在拍/草稿报价（竞得时）
  let bidId: number | null = null
  if (input.won) {
    const mine = (await db.auctionBids.where('[venueId+lotId]').equals([input.venueId, input.lotId]).toArray())
      .filter((b) => b.bidder === 'me' && (b.status === 'active' || b.status === 'won' || b.status === 'draft'))
      .sort((a, b) => b.amount - a.amount)[0]
    bidId = mine ? (mine.id as number) : null
  }

  const row: AuctionResult = {
    uid: resultUid,
    venueId: input.venueId,
    lotId: input.lotId,
    bidId,
    winner: input.winner,
    hammerPrice: input.hammerPrice,
    buyerPremium: input.buyerPremium,
    won: input.won,
    conflictNote: '',
    offline: input.offline,
    createdAt: at
  }

  let id: number
  if (existingId != null) {
    await db.auctionResults.update(existingId, { ...row })
    id = existingId
  } else {
    id = await db.auctionResults.add(row)
  }

  // 重算本人这批报价的状态（占用随之变化）
  const mine = await db.auctionBids
    .where('[venueId+lotId]')
    .equals([input.venueId, input.lotId])
    .toArray()
  for (const b of mine) {
    if (b.bidder !== 'me') continue
    if (b.status === 'cancelled' || b.status === 'rejected') continue
    if (input.won) {
      if (b.id === bidId || b.status === 'won') {
        await db.auctionBids.update(b.id as number, { status: 'won', updatedAt: at })
      } else {
        // 同一会场同一件只有一套竞得：其它报价归档为未得
        await db.auctionBids.update(b.id as number, { status: 'lost', updatedAt: at })
      }
    } else if (b.status === 'active' || b.status === 'draft') {
      await db.auctionBids.update(b.id as number, { status: 'lost', updatedAt: at })
    }
  }
  return id
}

/* ------------------------------ 到货登记 ------------------------------ */

/**
 * 到货登记：正常到货按 落槌价+佣金 结付；到货异常按折让重算实付。
 * 结清后该件不再占用"待付"。只接受本人竞得件，且不可重复登记。
 */
async function recordArrival(input: ArrivalInput): Promise<{ ok: boolean; message: string }> {
  const at = nowIso()
  const opId = input.opId ?? uid('op')
  const arrivalUid = input.arrivalUid ?? uid('arrival')
  assertWritable()

  await db.transaction('rw', TX_TABLES, async () => {
    const result = resultOf(input.venueId, input.lotId, await db.auctionResults.toArray())
    const lot = await db.auctionLots.get(input.lotId)
    if (!result) throw new Error('该件没有落槌结果，不能登记到货')
    if (!result.won) throw new Error('该件非本人竞得，无需到货登记')

    const existingArrival = await db.auctionArrivals
      .where('resultId')
      .equals(result.id as number)
      .first()

    const settled = Math.max(
      0,
      Math.round((result.hammerPrice + result.buyerPremium - input.adjustment) * 100) / 100
    )

    if (existingArrival) {
      if (input.offline) {
        // 终局保护：已到货不被断网重报覆盖（留痕由合并层事务外补写）
        const err = new Error('CONFLICT')
        ;(err as Error & { conflict?: boolean; conflictKind?: string; conflictDetail?: string }).conflict = true
        ;(err as Error & { conflictKind?: string }).conflictKind = 'arrival'
        ;(err as Error & { conflictDetail?: string }).conflictDetail =
          `${lot?.lotNo ?? ''} 已有到货登记（${existingArrival.status}），断网重报未覆盖。`
        throw err
      }
      await db.auctionArrivals.update(existingArrival.id as number, {
        status: input.status,
        arrivedAt: input.arrivedAt,
        adjustment: input.adjustment,
        settledAmount: settled,
        note: input.note,
        updatedAt: at
      })
      await addJournal(
        opId,
        'arrival',
        input.venueId,
        input.lotId,
        '到货更正',
        `${lot?.lotNo ?? ''} 到货登记更正为${input.status === 'abnormal' ? '异常' : '正常'}，实付重算为 ${settled} 元。`,
        false,
        at
      )
    } else {
      const row: AuctionArrival = {
        uid: arrivalUid,
        venueId: input.venueId,
        lotId: input.lotId,
        resultId: result.id as number,
        status: input.status,
        arrivedAt: input.arrivedAt,
        adjustment: input.adjustment,
        settledAmount: settled,
        note: input.note,
        offline: input.offline,
        createdAt: at,
        updatedAt: at
      }
      await db.auctionArrivals.add(row)
      await addJournal(
        opId,
        'arrival',
        input.venueId,
        input.lotId,
        input.status === 'abnormal' ? '到货异常' : '正常到货',
        `${lot?.lotNo ?? ''} ${input.status === 'abnormal' ? `到货异常折让 ${input.adjustment} 元，` : ''}实付 ${settled} 元，待付释放。`,
        input.offline,
        at
      )
    }

    if (input.offline) {
      const payload: ArrivalOpPayload = {
        opId,
        type: 'arrival',
        venueId: input.venueId,
        lotId: input.lotId,
        occurredAt: at,
        arrivalUid,
        resultUid: result.uid,
        arrivedAt: input.arrivedAt,
        adjustment: input.adjustment,
        status: input.status,
        note: input.note
      }
      await enqueueOp(payload, at)
    }
  })

  const stats = await venueStatsOf(input.venueId)
  return {
    ok: true,
    message: `已登记到货，实付结清；本会场剩余预算 ${stats.available} 元，已结 ${stats.settled} 元。`
  }
}

/* ------------------------------ outbox ------------------------------ */

async function enqueueOp(payload: AuctionOpPayload, at: string): Promise<void> {
  // 同 opId 已存在（线上/重放）时不重复入队
  const dup = await db.auctionOps.where('opId').equals(payload.opId).first()
  if (dup) return
  await db.auctionOps.add({
    ...payload,
    opStatus: 'queued',
    message: '',
    attempts: 0,
    createdAt: at,
    updatedAt: at
  } as AuctionOp)
}

/* ------------------------------ 回馆合并 ------------------------------ */

export interface MergeConflict {
  opId: string
  message: string
}

export interface MergeSummary {
  total: number
  applied: number
  conflicts: MergeConflict[]
  /** 因写库失败停下时，返回待重试的操作；它及之后的操作都未生效 */
  failed: { opId: string; message: string } | null
}

function isConflictError(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { conflict?: boolean }).conflict === true
}

function conflictDetail(e: unknown): { kind: string; detail: string } {
  const x = e as { conflictKind?: string; conflictDetail?: string }
  return {
    kind: x.conflictKind ?? 'cancel',
    detail: x.conflictDetail ?? '该操作与已有终局记录冲突，未生效。'
  }
}

/**
 * 冲突留痕：主事务因冲突回滚后，在独立事务里写审计流水。
 * 落槌冲突同时把断网结果摘要追加到结果备注，但不改任何终局字段。
 */
async function recordConflict(op: AuctionOp, detail: string, kind: string): Promise<void> {
  await db.transaction('rw', db.auctionResults, db.auctionJournal, async () => {
    if (kind === 'result' && op.type === 'result') {
      const existing = resultOf(op.venueId, op.lotId, await db.auctionResults.toArray())
      if (existing) {
        await db.auctionResults.update(existing.id as number, {
          conflictNote: `${existing.conflictNote ? `${existing.conflictNote}｜` : ''}断网记录另报「${op.winner} ${op.hammerPrice} 元」，未覆盖。`
        })
      }
    }
    const actionMap: Record<string, AuctionJournal['action']> = {
      result: '结果冲突',
      arrival: '到货冲突',
      cancel: '取消被拒绝',
      bid: '出价丢弃'
    }
    await db.auctionJournal.add({
      opId: op.opId,
      type: op.type,
      venueId: op.venueId,
      lotId: op.lotId,
      action: actionMap[kind] ?? '操作冲突',
      detail,
      offline: true,
      createdAt: nowIso()
    })
  })
}

/** 把一条 outbox 操作按当前台账真相回放；所有校验/终局保护逻辑与线上一致。 */
async function applyOp(op: AuctionOp): Promise<void> {
  switch (op.type) {
    case 'bid': {
      const out = await registerBid({
        venueId: op.venueId,
        lotId: op.lotId,
        amount: op.amount,
        note: op.note,
        offline: false, // 回放本身发生在回馆联网后
        bidUid: op.bidUid,
        opId: op.opId
      })
      if (out.status === 'rejected') {
        // 出价回放时该件已终局：报价已丢弃，队列层面记为冲突
        const err = new Error('CONFLICT')
        ;(err as Error & { conflict?: boolean; conflictKind?: string; conflictDetail?: string }).conflict = true
        ;(err as Error & { conflictKind?: string }).conflictKind = 'bid'
        ;(err as Error & { conflictDetail?: string }).conflictDetail = out.message
        throw err
      }
      return
    }
    case 'cancel': {
      await cancelBid({
        bidId: await requireBidIdByUid(op.bidUid),
        note: op.note,
        offline: false,
        opId: op.opId
      })
      return
    }
    case 'result': {
      await recordResult({
        venueId: op.venueId,
        lotId: op.lotId,
        winner: op.winner,
        hammerPrice: op.hammerPrice,
        buyerPremium: op.buyerPremium,
        won: op.won,
        offline: true, // 保留"断网来源"语义以触发终局保护
        opId: op.opId,
        resultUid: op.resultUid
      })
      return
    }
    case 'arrival': {
      await recordArrival({
        venueId: op.venueId,
        lotId: op.lotId,
        arrivedAt: op.arrivedAt,
        adjustment: op.adjustment,
        status: op.status,
        note: op.note,
        offline: true,
        opId: op.opId,
        arrivalUid: op.arrivalUid
      })
      return
    }
  }
}

async function requireBidIdByUid(bidUid: string): Promise<number> {
  const bid = await db.auctionBids.where('uid').equals(bidUid).first()
  if (!bid || typeof bid.id !== 'number') throw new Error('断网取消引用的报价已不存在')
  return bid.id
}

/**
 * 回馆合并：按 occurredAt 顺序回放 queued / retry 操作。
 * 冲突（终局保护）标记 conflict 后继续；写库失败整笔回滚、标记 retry 并停下，
 * 故障排除后可对同一条操作原样重试。
 */
async function mergeQueuedOps(): Promise<MergeSummary> {
  const pending = (
    await db.auctionOps.where('opStatus').anyOf('queued', 'retry').toArray()
  ).sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))

  const summary: MergeSummary = { total: pending.length, applied: 0, conflicts: [], failed: null }

  for (const op of pending) {
    try {
      await applyOp(op)
      await markOp(op.opId, 'applied', '已按回馆时台账合并', 0)
      summary.applied += 1
    } catch (e) {
      if (isConflictError(e)) {
        const { kind, detail } = conflictDetail(e)
        await recordConflict(op, detail, kind)
        await markOp(op.opId, 'conflict', '与已有终局结果冲突，已保留原记录', 0)
        summary.conflicts.push({ opId: op.opId, message: detail })
        continue
      }
      // 真正的写库失败：applyOp 事务已回滚，台账回到操作前
      const msg = e instanceof Error ? e.message : String(e)
      await markOp(op.opId, 'retry', `写库失败，已回到操作前：${msg}`, 1)
      summary.failed = { opId: op.opId, message: msg }
      break
    }
  }
  return summary
}

/** bookkeeping 事务不注入故障，保证"标记重试"本身总能落库。 */
async function markOp(
  opId: string,
  opStatus: AuctionOp['opStatus'],
  message: string,
  bumpAttempts: 0 | 1
): Promise<void> {
  await db.transaction('rw', db.auctionOps, async () => {
    const op = await db.auctionOps.where('opId').equals(opId).first()
    if (!op) return
    await db.auctionOps.update(op.id as number, {
      opStatus,
      message,
      attempts: op.attempts + bumpAttempts,
      updatedAt: nowIso()
    })
  })
}

async function retryOp(opId: string): Promise<MergeSummary> {
  const op = await db.auctionOps.where('opId').equals(opId).first()
  if (!op) throw new Error('队列里找不到这条操作')
  // 单条重试走与整批合并完全相同的回放逻辑
  const summary: MergeSummary = { total: 1, applied: 0, conflicts: [], failed: null }
  try {
    await applyOp(op)
    await markOp(opId, 'applied', '重试后已合并', 0)
    summary.applied = 1
  } catch (e) {
    if (isConflictError(e)) {
      const { kind, detail } = conflictDetail(e)
      await recordConflict(op, detail, kind)
      await markOp(opId, 'conflict', '与已有终局结果冲突，已保留原记录', 0)
      summary.conflicts.push({ opId, message: detail })
    } else {
      const msg = e instanceof Error ? e.message : String(e)
      await markOp(opId, 'retry', `写库失败，已回到操作前：${msg}`, 1)
      summary.failed = { opId, message: msg }
    }
  }
  return summary
}

async function discardOp(opId: string): Promise<void> {
  await markOp(opId, 'dead', '人工放弃该断网操作', 0)
}

/* ------------------------------ 清单 / 会场维护 ------------------------------ */

async function saveLot(lot: AuctionLot): Promise<number> {
  assertWritable()
  const at = nowIso()
  return db.transaction('rw', db.auctionLots, async () => {
    const row: AuctionLot = { ...lot, uid: lot.uid || uid('lot'), updatedAt: at }
    if (lot.id != null) {
      await db.auctionLots.update(lot.id, row)
      return lot.id
    }
    row.createdAt = at
    if (!row.lotNo) {
      const nos = (await db.auctionLots.toArray()).map((x) => x.lotNo)
      let n = 1
      const used = new Set(nos)
      while (used.has(`L-2026-${String(n).padStart(3, '0')}`)) n += 1
      row.lotNo = `L-2026-${String(n).padStart(3, '0')}`
    }
    return db.auctionLots.add(row)
  })
}

async function removeLot(lotId: number): Promise<void> {
  assertWritable()
  await db.transaction(
    'rw',
    db.auctionLots,
    db.auctionBids,
    db.auctionResults,
    db.auctionArrivals,
    async () => {
      const bids = await db.auctionBids.where('lotId').equals(lotId).toArray()
      if (bids.some((b) => b.status === 'active' || b.status === 'won')) {
        throw new Error('该件尚有在拍意向或竞得待付，不能删除')
      }
      await db.auctionLots.delete(lotId)
    }
  )
}

async function saveVenue(venue: AuctionVenue): Promise<number> {
  assertWritable()
  const at = nowIso()
  return db.transaction('rw', db.auctionVenues, async () => {
    const row: AuctionVenue = { ...venue, uid: venue.uid || uid('venue'), updatedAt: at }
    if (venue.id != null) {
      await db.auctionVenues.update(venue.id, row)
      return venue.id
    }
    row.createdAt = at
    return db.auctionVenues.add(row)
  })
}

export const auctionService = {
  loadAll,
  venueStats,
  competitorTop,
  registerBid,
  cancelBid,
  recordResult,
  recordArrival,
  mergeQueuedOps,
  retryOp,
  discardOp,
  saveLot,
  removeLot,
  saveVenue
}
