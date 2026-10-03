import 'fake-indexeddb/auto'
import { assert } from 'node:console'
import { db, initDatabase } from '../src/utils/db'
import {
  auctionService,
  setWriteFailSimulation,
  SimulatedWriteError
} from '../src/utils/auctionService'

// Node 测试环境没有 localStorage，补一个内存版（故障开关、网络模式都依赖它）
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const mem = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return mem.size
    },
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null
  } as Storage
}

let passed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (!cond) {
    console.error(`✗ ${name} ${extra}`)
    process.exitCode = 1
    throw new Error(name)
  }
  passed += 1
  console.log(`✓ ${name}`)
}

async function stats(venueId: number) {
  const d = await auctionService.loadAll()
  const venue = d.venues.find((v) => v.id === venueId)!
  return { stats: auctionService.venueStats(venue, d.bids, d.results, d.arrivals), d }
}

async function main() {
  await initDatabase()
  const d0 = await auctionService.loadAll()
  // 种子：上海春拍 20000、北京秋拍 30000；秋拍有 24000 预算不足草稿（差额4000）
  const autumn = d0.venues.find((v) => v.name.includes('北京'))!
  const spring = d0.venues.find((v) => v.name.includes('上海'))!
  const lot1 = d0.lots.find((l) => l.lotNo === 'L-2026-001')!
  const lot2 = d0.lots.find((l) => l.lotNo === 'L-2026-002')!
  const lot3 = d0.lots.find((l) => l.lotNo === 'L-2026-003')!
  check('种子写入两会场三标的', d0.venues.length === 2 && d0.lots.length === 3)

  // 1) 预算不足草稿：差额 4000（草稿不占预算；另一条种子断网在拍报价本机占用 1200）
  let s0 = (await stats(autumn.id!)).stats
  check('种子草稿不占用预算；断网在拍报价本机即时占用 1200', s0.held === 1200 && s0.committed === 1200)
  const draft = d0.bids.find((b) => b.lotId === lot2.id && b.status === 'draft')!
  check('预算草稿写明差额 4000', draft.shortfall === 4000 && draft.rejectReason === 'budget_short')

  // 2) 正常登记意向 → 占用
  const r1 = await auctionService.registerBid({
    venueId: spring.id!, lotId: lot1.id!, amount: 5000, note: '', offline: false
  })
  check('预算内登记成功并占用', r1.ok && r1.status === 'active')
  let s1 = (await stats(spring.id!)).stats
  check('占用 5000，剩余 15000', s1.held === 5000 && s1.available === 15000)

  // 3) 再登记 18000 → 预算不足（剩余 15000，差额 3000）
  const r2 = await auctionService.registerBid({
    venueId: spring.id!, lotId: lot2.id!, amount: 18000, note: '', offline: false
  })
  check('超额登记保留草稿', !r2.ok && r2.status === 'draft' && r2.reason === 'budget_short')
  check('预算差额为 3000', r2.shortfall === 3000, `got ${r2.shortfall}`)
  let s2 = (await stats(spring.id!)).stats
  check('草稿不占用，仍占用 5000', s2.held === 5000 && s2.available === 15000)

  // 4) 别人先报：258 号牌出 7000，本人再报 6000 → outbid 草稿，差额 1000
  await auctionService.registerBid({
    venueId: spring.id!, lotId: lot1.id!, amount: 7000, note: '', offline: false, bidder: '258 号牌'
  })
  let s3 = (await stats(spring.id!)).stats
  check('他人出价不占本人预算', s3.held === 5000)
  const r3 = await auctionService.registerBid({
    venueId: spring.id!, lotId: lot1.id!, amount: 6000, note: '', offline: false
  })
  check('别人先报 → outbid 草稿', r3.status === 'draft' && r3.reason === 'outbid')
  check('先报差额为 1000', r3.shortfall === 1000)

  // 5) 草稿改价超过最高价 → 同一会场同一件的本人意向就地更新为在拍 7500
  const draftBid = (await auctionService.loadAll()).bids
    .filter((b) => b.lotId === lot1.id && b.bidder === 'me')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  const r4 = await auctionService.registerBid({
    venueId: spring.id!, lotId: lot1.id!, amount: 7500, note: '', offline: false, bidUid: draftBid.uid
  })
  check('加价超过他人后转为在拍', r4.ok)
  let s4 = (await stats(spring.id!)).stats
  check('同一会场同一件意向就地改价，占用=7500', s4.held === 7500, `got ${s4.held}`)

  // 6) 取消 → 释放
  await auctionService.cancelBid({ bidId: draftBid.id!, note: '', offline: false })
  let s5 = (await stats(spring.id!)).stats
  check('取消后占用清零', s5.held === 0)

  // 7) 断网登记 + 回馆合并（新会场/新件，干净链路）
  const r7 = await auctionService.registerBid({
    venueId: autumn.id!, lotId: lot1.id!, amount: 6000, note: '现场', offline: true
  })
  check('断网登记本地即时生效并入队', r7.ok && r7.queued)
  const queuedBefore = (await auctionService.loadAll()).ops.filter((o) => o.opStatus === 'queued')
  check('outbox 至少有 2 条待合并（种子 1 + 新 1）', queuedBefore.length === 2)

  // 种子那条（lot3 出价 1200，服务端已被 258 号牌 1300 竞得）合并时应判冲突/丢弃
  const merge1 = await auctionService.mergeQueuedOps()
  check('合并：生效 1 条', merge1.applied === 1, JSON.stringify(merge1))
  check('合并：冲突 1 条（落槌真相保留）', merge1.conflicts.length === 1)
  check('合并无写库失败', merge1.failed === null)
  const d7 = await auctionService.loadAll()
  const seedOfflineBid = d7.bids.find((b) => b.uid === 'bid-seed-offline-canton')!
  check('断网出价未盖掉落槌结果：报价被丢弃', seedOfflineBid.status === 'rejected' && seedOfflineBid.rejectReason === 'closed_lot')
  const truth = d7.results.find((r) => r.lotId === lot3.id)!
  check('落槌真相仍是 258 号牌 1300', truth.winner === '258 号牌' && truth.hammerPrice === 1300 && truth.won === false)
  const conflictJournal = d7.journals.some((j) => j.opId === 'op-seed-offline-bid' && j.action === '出价丢弃')
  check('出价丢弃在操作流水留痕', conflictJournal)
  check('冲突队列项标记 conflict', d7.ops.find((o) => o.opId === 'op-seed-offline-bid')!.opStatus === 'conflict')

  // 8) 幂等：再合并一次不会重复改账
  const merge2 = await auctionService.mergeQueuedOps()
  check('无待合并项时合并 0 条', merge2.total === 0)

  // 9) 落槌：spring 的 lot1 本人竞得 8000 + 佣金 800 → 占用转应付
  await auctionService.recordResult({
    venueId: spring.id!, lotId: lot1.id!, winner: 'me', hammerPrice: 8000, buyerPremium: 800,
    won: true, offline: false
  })
  let s9 = (await stats(spring.id!)).stats
  check('春拍竞得后春拍在拍占用转应付（held=0, payable=8800）', s9.held === 0 && s9.payable === 8800, `held=${s9.held} payable=${s9.payable}`)
  check('春拍总占用=应付 8800，剩余 11200', s9.committed === 8800 && s9.available === 11200)
  const s9autumn = (await stats(autumn.id!)).stats
  check('秋拍对同一件的 6000 在拍意向不受春拍落槌影响（各算一套）', s9autumn.held === 6000)

  // 终局保护：落槌后再登记出价 → rejected
  const r9 = await auctionService.registerBid({
    venueId: spring.id!, lotId: lot1.id!, amount: 9999, note: '', offline: false
  })
  check('落槌后出价被丢弃', r9.status === 'rejected' && r9.reason === 'closed_lot')

  // 10) 到货正常 → 结清；到货异常 → 折让重算（用 lot3? lot3 非本人。再造一个竞得件）
  await auctionService.recordArrival({
    venueId: spring.id!, lotId: lot1.id!, arrivedAt: '2026-10-01', adjustment: 0,
    status: 'received', note: '', offline: false
  })
  let s10 = (await stats(spring.id!)).stats
  check('到货后应付清零、已结 8800', s10.payable === 0 && s10.settled === 8800)
  check('结清后剩余预算恢复 20000', s10.available === 20000)

  // 断网重复到货不覆盖：直接往 outbox 放一条"断网期间积压"的到货操作（平板本地当时尚无终局记录）
  const r10c = await (async () => {
    await db.auctionOps.add({
      opId: 'op-test-offline-arrival',
      type: 'arrival',
      venueId: spring.id!,
      lotId: lot1.id!,
      occurredAt: '2026-10-02T08:00:00.000Z',
      arrivalUid: 'arrival-test-offline',
      resultUid: (await auctionService.loadAll()).results.find(
        (r) => r.venueId === spring.id && r.lotId === lot1.id
      )!.uid,
      arrivedAt: '2026-10-02',
      adjustment: 9999,
      status: 'abnormal',
      note: '断网重报',
      opStatus: 'queued',
      message: '',
      attempts: 0,
      createdAt: '2026-10-02T08:00:00.000Z',
      updatedAt: '2026-10-02T08:00:00.000Z'
    })
    return auctionService.mergeQueuedOps()
  })()
  check('断网重报到货判冲突且不改实付', r10c.conflicts.length === 1)
  let s10b = (await stats(spring.id!)).stats
  check('实付仍为 8800', s10b.settled === 8800)

  // 11) 异常折让链路：新件在 autumn 竞得后异常到货
  await auctionService.recordResult({
    venueId: autumn.id!, lotId: lot2.id!, winner: 'me', hammerPrice: 20000, buyerPremium: 2000,
    won: true, offline: false
  })
  await auctionService.recordArrival({
    venueId: autumn.id!, lotId: lot2.id!, arrivedAt: '2026-10-02', adjustment: 3000,
    status: 'abnormal', note: '封背缺角折让', offline: false
  })
  const s11 = (await stats(autumn.id!)).stats
  check('异常到货实付=22000-3000=19000', s11.settled === 19000, `got ${s11.settled}`)
  const d11 = await auctionService.loadAll()
  check('到货记录保存折让与异常状态', d11.arrivals.some((a) => a.lotId === lot2.id && a.status === 'abnormal' && a.settledAmount === 19000))

  // 12) 写库故障：开启注入后，登记失败且台账回到操作前；op 标记 retry；关闭后重试成功
  const before = await auctionService.loadAll()
  const heldBefore = (await stats(spring.id!)).stats.held
  setWriteFailSimulation(true)
  let threw = false
  try {
    await auctionService.registerBid({
      venueId: spring.id!, lotId: lot2.id!, amount: 1000, note: '', offline: false
    })
  } catch (e) {
    threw = e instanceof SimulatedWriteError
  }
  setWriteFailSimulation(false)
  check('故障注入触发 SimulatedWriteError', threw)
  const s12 = (await stats(spring.id!)).stats
  check('失败后台账不变（占用回到操作前）', s12.held === heldBefore)
  const after = await auctionService.loadAll()
  check('失败未产生新报价/日志（事务回滚）', after.bids.length === before.bids.length)

  // 断网场景下故障：op 留在队列并可重试
  setWriteFailSimulation(true)
  let threw2 = false
  try {
    await auctionService.registerBid({
      venueId: spring.id!, lotId: lot2.id!, amount: 1000, note: '', offline: true
    })
  } catch {
    threw2 = true
  }
  check('断网写入遇故障同样整体回滚', threw2)
  const d12b = await auctionService.loadAll()
  check('回滚后 outbox 未多出操作', d12b.ops.length === after.ops.length)
  setWriteFailSimulation(false)

  // 13) 合并途中故障：把一条 queued 的 apply 人为打断 → merge 返回 failed，op 标 retry，之后重试成功
  await auctionService.registerBid({
    venueId: spring.id!, lotId: lot2.id!, amount: 1000, note: '', offline: true
  })
  setWriteFailSimulation(true)
  const mergeFail = await auctionService.mergeQueuedOps()
  setWriteFailSimulation(false)
  check('合并遇写库失败返回 failed', !!mergeFail.failed)
  const d13 = await auctionService.loadAll()
  const retryOpRow = d13.ops.find((o) => o.opId === mergeFail.failed!.opId)!
  check('失败操作标记 retry 并记录原因', retryOpRow.opStatus === 'retry' && retryOpRow.message.includes('写库失败'))
  const retrySummary = await auctionService.retryOp(mergeFail.failed!.opId)
  check('关闭故障后重试成功', retrySummary.applied === 1)
  const s13 = (await stats(spring.id!)).stats
  check('重试后意向生效，占用增加 1000', s13.held === heldBefore + 1000, `held=${s13.held}`)

  // 14) 多会场同一标的各算一套
  const sSpring = (await stats(spring.id!)).stats
  const sAutumn = (await stats(autumn.id!)).stats
  check('两会场预算独立', sSpring.budget === 20000 && sAutumn.budget === 30000)
  check('秋拍仍占用 lot1 的 6000，春拍占用 lot2 的 1000（同一件互不干扰）', sAutumn.held === 6000 && sSpring.held === 1000)

  await db.close()
  console.log(`\n全部 ${passed} 项断言通过`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
void assert
