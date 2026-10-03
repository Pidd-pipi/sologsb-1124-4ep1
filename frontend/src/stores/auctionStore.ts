/**
 * 拍卖征集账 store：把引擎（纯函数）与 Dexie 写库接起来。
 *
 * 关键约定：
 * - 线上（回馆）操作 applyOnline：快照推演与四张表写库放在同一个 Dexie 事务里，
 *   推演被拒绝（预算不足 / 被别人先报 / 终局冲突）不写任何数据；事务抛错整体回滚。
 * - 断网（现场）操作 registerOffline：先在「当前总账 + 本会场 pending」视图上试算，
 *   通过则入操作账 pending；预算不足 / 被别人先报则入 draft 并写明差额，草稿不占预算。
 * - 回馆合并 mergePending：所有 pending 按发生时间重放到同一套账，
 *   快照落库与操作账置位同事务；注入的写库失败会整笔回滚，pending 原样保留可重试。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { db } from '@/utils/db'
import type {
  AuctionArrival,
  AuctionBid,
  AuctionCommand,
  AuctionJournal,
  AuctionLot
} from '@/types/auction'
import { COMMAND_TYPE_LABELS } from '@/types/auction'
import { nowIso, nextSerialNo, uid } from '@/utils/id'
import {
  type ApplyOutcome,
  type LedgerSnapshot,
  type MergeReport,
  type PendingEntry,
  applyCommand,
  bidKey,
  buildLaneSnapshot,
  emptySnapshot,
  mergePending,
  summarizeBudget
} from '@/utils/auctionEngine'

const META_BUDGET_KEY = 'budget'

/** 提交结果：ok=false 时 message 即差额 / 原因说明 */
export interface SubmitResult {
  ok: boolean
  message: string
  outcome?: ApplyOutcome
}

export const useAuctionStore = defineStore('auction', () => {
  const lots = ref<AuctionLot[]>([])
  const bids = ref<AuctionBid[]>([])
  const arrivals = ref<AuctionArrival[]>([])
  const journal = ref<AuctionJournal[]>([])
  const budget = ref(0)
  const loaded = ref(false)
  const merging = ref(false)

  /* ------------------------------ 读取 ------------------------------ */

  async function load(): Promise<void> {
    const [row, lotRows, bidRows, arrivalRows, journalRows] = await Promise.all([
      db.auctionMeta.get(META_BUDGET_KEY),
      db.auctionLots.toArray(),
      db.auctionBids.toArray(),
      db.auctionArrivals.toArray(),
      db.auctionJournal.orderBy('occurredAt').toArray()
    ])
    budget.value = row?.value ?? 0
    lots.value = lotRows.sort((a, b) => a.lotNo.localeCompare(b.lotNo))
    bids.value = bidRows
    arrivals.value = arrivalRows
    journal.value = journalRows
    loaded.value = true
  }

  /** 用四张表的当前内容构造引擎快照（appliedKeys 从操作账恢复）。 */
  function snapshot(): LedgerSnapshot {
    const s = emptySnapshot(budget.value)
    s.lots = lots.value.map((l) => ({ ...l }))
    s.bids = bids.value.map((b) => ({ ...b }))
    s.arrivals = arrivals.value.map((a) => ({
      lotNo: a.lotNo,
      normal: a.normal,
      issue: a.issue,
      receivedQty: a.receivedQty,
      note: a.note,
      arrivedAt: a.arrivedAt,
      createdAt: a.createdAt
    }))
    for (const j of journal.value) {
      if (j.status === 'applied') s.appliedKeys.add(j.idempotencyKey)
    }
    return s
  }

  const summary = computed(() => summarizeBudget(snapshot()))

  const pendingCount = computed(() => journal.value.filter((j) => j.status === 'pending').length)
  const draftCount = computed(() => journal.value.filter((j) => j.status === 'draft').length)
  const conflictCount = computed(() => journal.value.filter((j) => j.status === 'conflict').length)

  function nextLotNo(): string {
    return nextSerialNo(
      'AL-',
      lots.value.map((l) => l.lotNo)
    )
  }

  function lotByNo(lotNo: string): AuctionLot | undefined {
    return lots.value.find((l) => l.lotNo === lotNo)
  }

  function bidsOf(lotNo: string): AuctionBid[] {
    return bids.value
      .filter((b) => b.lotNo === lotNo)
      .sort((a, b) => b.bidAt.localeCompare(a.bidAt))
  }

  function arrivalsOf(lotNo: string): AuctionArrival[] {
    return arrivals.value.filter((a) => a.lotNo === lotNo)
  }

  /** 某会场的操作账（pending + draft + 该会场冲突记录） */
  function journalOfVenue(venue: string): AuctionJournal[] {
    return journal.value
      .filter((j) => j.venue === venue)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
  }

  const venues = computed(() => {
    const set = new Set<string>()
    for (const l of lots.value) if (l.source) set.add(l.source)
    for (const j of journal.value) if (j.venue) set.add(j.venue)
    return [...set]
  })

  /** 断网页面使用的会场视图：跨会场共享征集清单，账本操作只回放本会场 pending。 */
  function laneSnapshot(venue: string): LedgerSnapshot {
    const toEntry = (j: {
      idempotencyKey: string
      venue: string
      occurredAt: string
      command: AuctionCommand
    }): PendingEntry => ({
      idempotencyKey: j.idempotencyKey,
      venue: j.venue,
      occurredAt: j.occurredAt,
      command: j.command
    })
    const allPending = journal.value.filter((j) => j.status === 'pending')
    const entries = allPending.filter((j) => j.venue === venue).map(toEntry)
    return buildLaneSnapshot(snapshot(), entries, allPending.map(toEntry))
  }

  /* --------------------------- 快照落库（事务内） --------------------------- */

  async function persistSnapshot(tx: {
    auctionLots: typeof db.auctionLots
    auctionBids: typeof db.auctionBids
    auctionArrivals: typeof db.auctionArrivals
    auctionMeta: typeof db.auctionMeta
  }, s: LedgerSnapshot): Promise<void> {
    await tx.auctionMeta.put({ key: META_BUDGET_KEY, value: s.budget })
    await tx.auctionLots.clear()
    await tx.auctionBids.clear()
    await tx.auctionArrivals.clear()
    await tx.auctionLots.bulkAdd(s.lots)
    await tx.auctionBids.bulkAdd(s.bids)
    await tx.auctionArrivals.bulkAdd(
      s.arrivals.map((a, i) => ({ ...a, id: i + 1 }))
    )
  }

  /* ------------------------------ 线上操作 ------------------------------ */

  /**
   * 回馆联网时直接操作：推演 + 落库同一事务。
   * 推演失败直接返回原因，不写库；事务抛错由 Dexie 回滚。
   */
  async function applyOnline(command: AuctionCommand): Promise<SubmitResult> {
    const outcome = applyCommand(snapshot(), command)
    if (!outcome.ok) return { ok: false, message: outcome.message, outcome }
    try {
      await db.transaction(
        'rw',
        db.auctionLots,
        db.auctionBids,
        db.auctionArrivals,
        db.auctionMeta,
        async () => {
          await persistSnapshot(
            {
              auctionLots: db.auctionLots,
              auctionBids: db.auctionBids,
              auctionArrivals: db.auctionArrivals,
              auctionMeta: db.auctionMeta
            },
            outcome.snapshot
          )
        }
      )
    } catch (err) {
      return { ok: false, message: `写库失败，已回到操作前：${(err as Error).message}` }
    }
    await load()
    return { ok: true, message: outcome.message, outcome }
  }

  /* ------------------------------ 断网操作 ------------------------------ */

  /** 现场登记前的会场试算（页面即时显示占用增量 / 差额）。 */
  function dryRunOffline(
    venue: string,
    command: AuctionCommand
  ): ApplyOutcome {
    return applyCommand(laneSnapshot(venue), command)
  }

  /**
   * 断网登记：命令先写操作账。
   * - 试算通过 → pending，回馆合并时才真正占账（页面按会场视图预览占用）；
   * - registerBid 己方出价被拒（预算不足 / 被别人先报）→ draft，附差额说明；
   * - 其他拒绝（拍品不存在、金额非法等）直接返回，不留账。
   */
  async function registerOffline(venue: string, command: AuctionCommand): Promise<SubmitResult> {
    if (!venue.trim()) return { ok: false, message: '请先填写会场名' }
    const outcome = applyCommand(laneSnapshot(venue), command)
    const ts = nowIso()
    const entry: AuctionJournal = {
      idempotencyKey: uid('op'),
      venue: venue.trim(),
      occurredAt: ts,
      status: 'pending',
      resultNote: '',
      attempts: 0,
      command,
      createdAt: ts,
      updatedAt: ts
    }
    if (!outcome.ok) {
      const draftable =
        command.type === 'registerBid' &&
        command.isOwn &&
        (outcome.code === 'budget_short' || outcome.code === 'below_competitor')
      if (!draftable) return { ok: false, message: outcome.message, outcome }
      entry.status = 'draft'
      entry.resultNote = outcome.message
    }
    try {
      await db.auctionJournal.add(entry)
    } catch (err) {
      return { ok: false, message: `操作账写入失败，未保留任何记录：${(err as Error).message}` }
    }
    await load()
    return {
      ok: outcome.ok,
      message: outcome.ok
        ? `断网已记账（${COMMAND_TYPE_LABELS[command.type]}），回馆后合并`
        : outcome.message,
      outcome
    }
  }

  /* --------------------------- 回馆合并（核心） --------------------------- */

  /**
   * 回馆合并全部 pending：内存重放得到 MergeReport 后，
   * 物料表与操作账在同一事务落库。任何写库异常（含演示用故障注入）
   * 都会抛错并整体回滚——操作账仍是合并前的 pending，可再次重试。
   */
  async function mergeAll(options?: { failWrite?: boolean }): Promise<MergeReport & { rolledBack?: boolean }> {
    merging.value = true
    try {
      const base = snapshot()
      const pending = journal.value.filter((j) => j.status === 'pending')
      const entries: PendingEntry[] = pending.map((j) => ({
        idempotencyKey: j.idempotencyKey,
        venue: j.venue,
        occurredAt: j.occurredAt,
        command: j.command
      }))
      const report = mergePending(base, entries)

      const statusByKey = new Map(report.results.map((r) => [r.key, r]))
      try {
        await db.transaction(
          'rw',
          db.auctionLots,
          db.auctionBids,
          db.auctionArrivals,
          db.auctionMeta,
          db.auctionJournal,
          async () => {
            await persistSnapshot(
              {
                auctionLots: db.auctionLots,
                auctionBids: db.auctionBids,
                auctionArrivals: db.auctionArrivals,
                auctionMeta: db.auctionMeta
              },
              report.snapshot
            )
            // 草稿对应的报价行落库（state=draft，不占预算，可改价重试）
            const draftBids = report.results
              .filter((r) => r.status === 'draft' && r.draftBid)
              .map((r) => r.draftBid!)
            if (draftBids.length) await db.auctionBids.bulkAdd(draftBids)

            for (const j of pending) {
              if (typeof j.id !== 'number') continue
              const r = statusByKey.get(j.idempotencyKey)
              if (!r) continue
              await db.auctionJournal.update(j.id, {
                status: r.status,
                resultNote: r.message,
                attempts: j.attempts + 1,
                updatedAt: nowIso()
              })
            }
            if (options?.failWrite) {
              throw new Error('模拟写库失败（演示回滚）')
            }
          }
        )
      } catch (err) {
        // 整笔回滚：物料表与操作账都回到合并前，pending 原样保留
        await load()
        return { ...report, rolledBack: true, snapshot: base, warning: (err as Error).message }
      }

      await load()
      return report
    } finally {
      merging.value = false
    }
  }

  /** 重试单条 pending（等价于只合并这一条；终局冲突仍会被拒绝并保留 pending）。 */
  async function retryOne(journalId: number): Promise<SubmitResult> {
    const entry = journal.value.find((j) => j.id === journalId)
    if (!entry) return { ok: false, message: '操作账记录不存在' }
    if (entry.status !== 'pending' && entry.status !== 'conflict') {
      return { ok: false, message: '只有待合并 / 冲突的记录可以重试' }
    }
    const base = snapshot()
    const report = mergePending(base, [
      {
        idempotencyKey: entry.idempotencyKey,
        venue: entry.venue,
        occurredAt: entry.occurredAt,
        command: entry.command
      }
    ])
    const r = report.results[0]
    if (r.status !== 'applied') {
      try {
        await db.auctionJournal.update(journalId, {
          status: r.status,
          resultNote: r.message,
          attempts: entry.attempts + 1,
          updatedAt: nowIso()
        })
      } catch {
        /* 仅置位失败不影响内存结果 */
      }
      await load()
      return { ok: false, message: r.message }
    }
    try {
      await db.transaction(
        'rw',
        db.auctionLots,
        db.auctionBids,
        db.auctionArrivals,
        db.auctionMeta,
        db.auctionJournal,
        async () => {
          await persistSnapshot(
            {
              auctionLots: db.auctionLots,
              auctionBids: db.auctionBids,
              auctionArrivals: db.auctionArrivals,
              auctionMeta: db.auctionMeta
            },
            report.snapshot
          )
          if (r.draftBid) await db.auctionBids.add(r.draftBid)
          await db.auctionJournal.update(journalId, {
            status: 'applied',
            resultNote: r.message,
            attempts: entry.attempts + 1,
            updatedAt: nowIso()
          })
        }
      )
    } catch (err) {
      return { ok: false, message: `写库失败，已回到操作前：${(err as Error).message}` }
    }
    await load()
    return { ok: true, message: r.message }
  }

  /** 修改草稿命令（改金额 / 会场等），随后仍走 retryDraft 试合并。 */
  async function updateDraft(journalId: number, patch: Partial<AuctionJournal>): Promise<void> {
    await db.auctionJournal.update(journalId, { ...patch, updatedAt: nowIso() })
    await load()
  }

  /**
   * 草稿重试：用改后的命令在当前总账上重放。
   * 成功 → applied 并删除对应的 draft 报价行（若有）；仍不足 → 继续保留 draft。
   */
  async function retryDraft(journalId: number, command: AuctionCommand): Promise<SubmitResult> {
    const entry = journal.value.find((j) => j.id === journalId)
    if (!entry || entry.status !== 'draft') return { ok: false, message: '草稿不存在' }
    const base = snapshot()
    const report = mergePending(base, [
      {
        idempotencyKey: entry.idempotencyKey,
        venue: entry.venue,
        occurredAt: entry.occurredAt,
        command
      }
    ])
    const r = report.results[0]
    if (r.status !== 'applied') {
      await db.auctionJournal.update(journalId, {
        command,
        resultNote: r.message,
        attempts: entry.attempts + 1,
        updatedAt: nowIso()
      })
      await load()
      return { ok: false, message: r.message }
    }
    try {
      await db.transaction(
        'rw',
        db.auctionLots,
        db.auctionBids,
        db.auctionArrivals,
        db.auctionMeta,
        db.auctionJournal,
        async () => {
          await persistSnapshot(
            {
              auctionLots: db.auctionLots,
              auctionBids: db.auctionBids,
              auctionArrivals: db.auctionArrivals,
              auctionMeta: db.auctionMeta
            },
            report.snapshot
          )
          // 清掉同拍品同会场的旧 draft 报价行，避免和新报价并存
          const stale = await db.auctionBids
            .where('state')
            .equals('draft')
            .toArray()
          await db.auctionBids.bulkDelete(
            stale
              .filter(
                (b) =>
                  command.type === 'registerBid' &&
                  b.lotNo === command.lotNo &&
                  b.venue === entry.venue
              )
              .map((b) => b.id)
              .filter((v): v is number => typeof v === 'number')
          )
          await db.auctionJournal.update(journalId, {
            command,
            status: 'applied',
            resultNote: r.message,
            attempts: entry.attempts + 1,
            updatedAt: nowIso()
          })
        }
      )
    } catch (err) {
      return { ok: false, message: `写库失败，已回到操作前：${(err as Error).message}` }
    }
    await load()
    return { ok: true, message: r.message }
  }

  /** 放弃草稿（从操作账删除，并清掉对应 draft 报价行）。 */
  async function discardDraft(journalId: number): Promise<void> {
    const entry = journal.value.find((j) => j.id === journalId)
    await db.auctionJournal.delete(journalId)
    if (entry && entry.command.type === 'registerBid') {
      const command = entry.command
      const venue = entry.venue
      const stale = await db.auctionBids
        .where('state')
        .equals('draft')
        .toArray()
      await db.auctionBids.bulkDelete(
        stale
          .filter((b) => b.lotNo === command.lotNo && b.venue === venue)
          .map((b) => b.id)
          .filter((v): v is number => typeof v === 'number')
      )
    }
    await load()
  }

  /** 删除已合并 / 冲突的操作账记录（留档清理，不影响总账）。 */
  async function removeJournal(ids: number[]): Promise<void> {
    await db.auctionJournal.bulkDelete(ids)
    await load()
  }

  return {
    lots,
    bids,
    arrivals,
    journal,
    budget,
    loaded,
    merging,
    summary,
    pendingCount,
    draftCount,
    conflictCount,
    venues,
    load,
    snapshot,
    laneSnapshot,
    nextLotNo,
    lotByNo,
    bidsOf,
    arrivalsOf,
    journalOfVenue,
    applyOnline,
    dryRunOffline,
    registerOffline,
    mergeAll,
    retryOne,
    updateDraft,
    retryDraft,
    discardDraft,
    removeJournal,
    bidKey
  }
})
