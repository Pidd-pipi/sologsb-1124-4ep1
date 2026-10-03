/**
 * auctionStore 集成测试：fake-indexeddb + 真实 Dexie，验证
 * 断网登记 → 回馆合并（含写库失败整体回滚）→ 重试 → 落槌/到货重算占用 的端到端行为。
 * 运行：node scripts/run-store-tests.mjs
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { createPinia, setActivePinia } from 'pinia'
import type { AuctionCommand, RegisterBidCommand } from '@/types/auction'
import { db } from '@/utils/db'
import { useAuctionStore } from '@/stores/auctionStore'

const tests: Array<[string, () => Promise<void>]> = []
function it(name: string, fn: () => Promise<void>): void {
  tests.push([name, fn])
}

setActivePinia(createPinia())
const auction = useAuctionStore()

it('初始化空账并设置预算', async () => {
  await auction.load()
  const r = await auction.applyOnline({ type: 'setBudget', amount: 10000 })
  assert.ok(r.ok, r.message)
  assert.equal(auction.budget, 10000)
})

it('现场 A 会场断网登记征集与报价，回馆前总账不占预算', async () => {
  const lot = await auction.registerOffline('上海诚轩', {
    type: 'upsertLot',
    lotNo: 'AL-1001',
    title: '清蟠龙挂号实寄封',
    category: 'cover',
    refId: null,
    source: '上海诚轩',
    ceiling: 8000,
    note: ''
  })
  assert.ok(lot.ok, lot.message)
  const bid = await auction.registerOffline('上海诚轩', {
    type: 'registerBid',
    lotNo: 'AL-1001',
    amount: 3000,
    isOwn: true,
    venue: '上海诚轩',
    bidAt: '2026-05-01 10:00'
  })
  assert.ok(bid.ok, bid.message)
  assert.equal(auction.pendingCount, 2)
  // 未合并：总账占用为 0
  assert.equal(auction.summary.held, 0)
  // 会场视图：已能预览到 1 条报价
  assert.equal(auction.laneSnapshot('上海诚轩').bids.length, 1)
})

it('现场 B 会场同一件重复登记，各算一套', async () => {
  const r = await auction.registerOffline('北京嘉德', {
    type: 'registerBid',
    lotNo: 'AL-1001',
    amount: 4500,
    isOwn: true,
    venue: '北京嘉德',
    bidAt: '2026-05-01 11:00'
  })
  assert.ok(r.ok, r.message)
  assert.equal(auction.pendingCount, 3)
})

it('预算不足的报价保留草稿并写明差额，且不产生 pending', async () => {
  const r = await auction.registerOffline('上海诚轩', {
    type: 'registerBid',
    lotNo: 'AL-1001',
    amount: 12000, // 超过总预算 10000（会场口径）
    isOwn: true,
    venue: '上海诚轩',
    bidAt: '2026-05-01 10:30'
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /差额 2000 元/)
  assert.equal(auction.draftCount, 1)
  assert.equal(auction.pendingCount, 3) // pending 未增加
})

it('写库失败时合并整体回滚：物料表不动、pending 全部保留', async () => {
  const beforeHeld = auction.summary.held
  const beforePending = auction.pendingCount
  const report = await auction.mergeAll({ failWrite: true })
  assert.equal(report.rolledBack, true)
  assert.equal(auction.pendingCount, beforePending, 'pending 必须原样保留')
  assert.equal(auction.summary.held, beforeHeld, '占用不得变化')
  assert.equal(auction.lots.length, 0, '征集不得落库')
})

it('正常合并：只保留最高一套占用，旧报价 superseded，草稿保留', async () => {
  const report = await auction.mergeAll()
  assert.equal(report.rolledBack, undefined)
  assert.equal(report.applied, 3)
  assert.equal(auction.pendingCount, 0)
  const lot = auction.lotByNo('AL-1001')!
  assert.ok(lot)
  assert.equal(lot.ownHigh, 4500)
  assert.equal(auction.summary.held, 4500, '只占最高一套')
  const shanghai = auction.bidsOf('AL-1001').find((b) => b.venue === '上海诚轩' && b.amount === 3000)!
  assert.equal(shanghai.state, 'superseded')
  assert.equal(auction.draftCount, 1)
})

it('草稿改价后重试：改为 5000（不超预算）成功占用', async () => {
  const draft = auction.journal.find((j) => j.status === 'draft')!
  assert.ok(draft)
  const command: RegisterBidCommand = { ...(draft.command as RegisterBidCommand), amount: 5000 }
  const r = await auction.retryDraft(draft.id!, command)
  assert.ok(r.ok, r.message)
  assert.equal(auction.summary.held, 5000)
  assert.equal(auction.draftCount, 0)
})

it('落槌后终局锁定；到货异常释放占用', async () => {
  const hammer = await auction.registerOffline('上海诚轩', {
    type: 'hammer',
    lotNo: 'AL-1001',
    result: 'won',
    price: 5000,
    winner: '',
    hammerAt: '2026-05-01 15:00'
  })
  assert.ok(hammer.ok)
  const late = await auction.registerOffline('上海诚轩', {
    type: 'registerBid',
    lotNo: 'AL-1001',
    amount: 9000,
    isOwn: true,
    venue: '上海诚轩',
    bidAt: '2026-05-01 16:00'
  })
  // 会场视图里落槌已回放（won），报价当场被终局拒绝 → 不留账
  assert.equal(late.ok, false)
  assert.match(late.message, /终局|不能覆盖/)
  await auction.mergeAll()
  assert.equal(auction.lotByNo('AL-1001')!.status, 'won')
  assert.equal(auction.summary.held, 5000)

  const anomaly = await auction.applyOnline({
    type: 'arrive',
    lotNo: 'AL-1001',
    normal: false,
    issue: 'damaged',
    receivedQty: 1,
    note: '封舌撕裂',
    arrivedAt: '2026-05-03 09:00'
  })
  assert.ok(anomaly.ok, anomaly.message)
  assert.equal(auction.summary.held, 0)
  assert.equal(auction.lotByNo('AL-1001')!.status, 'anomaly')
})

it('终局后线上再补一条旧落槌被拒绝，结果保持不变', async () => {
  const reHammer = await auction.applyOnline({
    type: 'hammer',
    lotNo: 'AL-1001',
    result: 'lost',
    price: 9000,
    winner: '他人',
    hammerAt: '2026-05-01 17:00'
  })
  assert.equal(reHammer.ok, false)
  assert.match(reHammer.message, /终局|不能覆盖/)
  assert.equal(auction.lotByNo('AL-1001')!.status, 'anomaly')
})

let passed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    process.exitCode = 1
    break
  }
}
db.close()
if (!process.exitCode) console.log(`\nauctionStore 集成：${passed} 项测试全部通过\n`)
