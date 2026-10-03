/**
 * 拍卖账引擎单测：无浏览器依赖，`node scripts/run-engine-tests.mjs` 运行
 * （esbuild 即时把 TS 打到临时文件后用 node 执行）。
 */
import assert from 'node:assert/strict'
import type { AuctionCommand } from '@/types/auction'
import {
  type LedgerSnapshot,
  type PendingEntry,
  applyCommand,
  buildLaneSnapshot,
  emptySnapshot,
  lotHeldAmount,
  mergePending,
  summarizeBudget
} from '@/utils/auctionEngine'

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

const ts = (min: string) => `2026-04-12 ${min}`

function withLot(s: LedgerSnapshot, ceiling = 10000): LedgerSnapshot {
  const out = applyCommand(s, {
    type: 'upsertLot',
    lotNo: 'AL-0001',
    title: '测试封',
    category: 'cover',
    refId: null,
    source: '上海诚轩',
    ceiling,
    note: ''
  })
  assert.ok(out.ok, out.message)
  return out.snapshot
}

function bid(
  amount: number,
  isOwn: boolean,
  venue: string,
  min = '10:00'
): Extract<AuctionCommand, { type: 'registerBid' }> {
  return { type: 'registerBid', lotNo: 'AL-0001', amount, isOwn, venue, bidAt: ts(min) }
}

test('设置总预算', () => {
  const r = applyCommand(emptySnapshot(), { type: 'setBudget', amount: 50000 })
  assert.ok(r.ok)
  assert.equal(r.snapshot.budget, 50000)
  const bad = applyCommand(emptySnapshot(), { type: 'setBudget', amount: -1 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'amount_invalid')
})

test('登记征集并按己方最高出价占用一套意向额', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  const r = applyCommand(s, bid(3000, true, '上海诚轩'))
  assert.ok(r.ok, r.message)
  const sum = summarizeBudget(r.snapshot)
  assert.equal(sum.held, 3000)
  assert.equal(sum.available, 7000)
})

test('同一会场重复登记只补增量占用，不超过己方最高的出价被拒', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  const dup = applyCommand(s, bid(2000, true, '上海诚轩', '10:05'))
  assert.equal(dup.ok, false)
  assert.equal(dup.code, 'below_own_high')
  const higher = applyCommand(s, bid(4000, true, '上海诚轩', '10:10'))
  assert.ok(higher.ok)
  assert.equal(summarizeBudget(higher.snapshot).held, 4000)
})

test('出价被别人压过须高于他人最高，并给出差额', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 20000 }).snapshot
  s = applyCommand(s, bid(4200, false, '上海诚轩', '09:50')).snapshot
  const low = applyCommand(s, bid(4200, true, '上海诚轩'))
  assert.equal(low.ok, false)
  assert.equal(low.code, 'below_competitor')
  assert.match(low.message, /差额 1 元/)
  const ok = applyCommand(s, bid(4300, true, '上海诚轩', '10:02'))
  assert.ok(ok.ok)
  const lot = ok.snapshot.lots[0]
  assert.equal(lot.ownHigh, 4300)
  assert.equal(lot.status, 'watching')
})

test('己方有报价后他人出更高，拍品转被压过状态', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 20000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  s = applyCommand(s, bid(4000, false, '上海诚轩', '10:30')).snapshot
  assert.equal(s.lots[0].status, 'outbid')
  // 仍按己方出价占用
  assert.equal(summarizeBudget(s).held, 3000)
})

test('预算不足时拒绝并说明差额', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 2500 }).snapshot
  const r = applyCommand(s, bid(3000, true, '上海诚轩'))
  assert.equal(r.ok, false)
  assert.equal(r.code, 'budget_short')
  assert.match(r.message, /差额 500 元/)
  // 拒绝后快照不变，占用仍为 0
  assert.equal(summarizeBudget(s).held, 0)
})

test('竞价取消释放占用', () => {
  let s = withLot(emptySnapshot())
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  const cancel = applyCommand(s, {
    type: 'cancelBidding',
    lotNo: 'AL-0001',
    venue: '上海诚轩',
    bidKey: '',
    reason: '撤拍'
  })
  assert.ok(cancel.ok, cancel.message)
  assert.equal(summarizeBudget(cancel.snapshot).held, 0)
  assert.equal(cancel.snapshot.bids[0].state, 'cancelled')
})

test('落槌：己方拍得按落槌价占用；他人竞得 / 流拍释放', () => {
  let won = withLot(emptySnapshot())
  won = applyCommand(won, { type: 'setBudget', amount: 10000 }).snapshot
  won = applyCommand(won, bid(3000, true, '上海诚轩')).snapshot
  won = applyCommand(won, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'won',
    price: 3600,
    winner: '',
    hammerAt: ts('11:00')
  }).snapshot
  assert.equal(won.lots[0].status, 'won')
  assert.equal(lotHeldAmount(won.lots[0], won.bids), 3600)

  let lost = withLot(emptySnapshot(10000))
  lost = applyCommand(lost, { type: 'setBudget', amount: 10000 }).snapshot
  lost = applyCommand(lost, bid(3000, true, '上海诚轩')).snapshot
  lost = applyCommand(lost, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'lost',
    price: 3800,
    winner: '委托 18 号',
    hammerAt: ts('11:00')
  }).snapshot
  assert.equal(lost.lots[0].status, 'lost')
  assert.equal(summarizeBudget(lost).held, 0)
})

test('终局后旧报价 / 旧落槌不能覆盖结果', () => {
  let s = withLot(emptySnapshot(10000))
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  s = applyCommand(s, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'won',
    price: 3600,
    winner: '',
    hammerAt: ts('11:00')
  }).snapshot
  const lateBid = applyCommand(s, bid(9000, true, '北京嘉德', '12:00'))
  assert.equal(lateBid.ok, false)
  assert.equal(lateBid.code, 'lot_terminal')
  const reHammer = applyCommand(s, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'lost',
    price: 9000,
    winner: '别人',
    hammerAt: ts('13:00')
  })
  assert.equal(reHammer.ok, false)
  assert.equal(s.lots[0].status, 'won')
  assert.equal(s.lots[0].hammerPrice, 3600)
})

test('到货正常结清占用；到货异常释放成交占用', () => {
  let s = withLot(emptySnapshot(10000))
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  s = applyCommand(s, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'won',
    price: 3600,
    winner: '',
    hammerAt: ts('11:00')
  }).snapshot
  const arrived = applyCommand(s, {
    type: 'arrive',
    lotNo: 'AL-0001',
    normal: true,
    issue: '',
    receivedQty: 1,
    note: '',
    arrivedAt: ts('14:00')
  })
  assert.ok(arrived.ok)
  assert.equal(arrived.snapshot.lots[0].status, 'arrived')
  assert.equal(summarizeBudget(arrived.snapshot).held, 0)
  assert.equal(summarizeBudget(arrived.snapshot).settled, 3600)

  const anomaly = applyCommand(s, {
    type: 'arrive',
    lotNo: 'AL-0001',
    normal: false,
    issue: 'damaged',
    receivedQty: 1,
    note: '封舌撕裂',
    arrivedAt: ts('14:00')
  })
  assert.ok(anomaly.ok)
  assert.equal(anomaly.snapshot.lots[0].status, 'anomaly')
  assert.equal(summarizeBudget(anomaly.snapshot).held, 0)
})

test('多会场重复登记同一件：合并后只保留最高一套占用，旧报价置 superseded', () => {
  const base = emptySnapshot(10000)
  const report = mergePending(base, [
    {
      idempotencyKey: 'k1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T09:00:00.000Z',
      command: {
        type: 'upsertLot',
        lotNo: 'AL-0001',
        title: '测试封',
        category: 'cover',
        refId: null,
        source: '上海诚轩',
        ceiling: 10000,
        note: ''
      }
    },
    {
      idempotencyKey: 'k2',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(3000, true, '上海诚轩')
    },
    {
      idempotencyKey: 'k3',
      venue: '北京嘉德',
      occurredAt: '2026-04-12T10:30:00.000Z',
      command: bid(4500, true, '北京嘉德', '10:30')
    }
  ])
  assert.equal(report.applied, 3)
  assert.equal(summarizeBudget(report.snapshot).held, 4500)
  const states = report.snapshot.bids.map((b) => `${b.venue}:${b.state}`).sort()
  assert.deepEqual(states, ['上海诚轩:superseded', '北京嘉德:active'])
  assert.match(report.snapshot.bids.find((b) => b.state === 'superseded')!.reason, /更高报价/)
})

test('合并时预算不足 / 被别人先报保留草稿并说明差额，草稿不占预算', () => {
  // 总账已有他人 5000 报价 + 紧张预算
  let base = withLot(emptySnapshot(5000))
  base = applyCommand(base, { type: 'setBudget', amount: 5000 }).snapshot
  base = applyCommand(base, bid(5000, false, '上海诚轩', '09:00')).snapshot
  const report = mergePending(base, [
    {
      idempotencyKey: 'd1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(4500, true, '上海诚轩', '10:00') // 低于他人 → 草稿
    }
  ])
  assert.equal(report.drafts, 1)
  assert.equal(report.results[0].status, 'draft')
  assert.match(report.results[0].message, /差额 501 元/)
  assert.equal(report.results[0].draftBid?.state, 'draft')
  assert.equal(summarizeBudget(report.snapshot).held, 0)
})

test('合并遇到已终局拍品记冲突，落槌结果不被盖掉，后续条目继续处理', () => {
  let s = withLot(emptySnapshot(10000))
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  s = applyCommand(s, bid(3000, true, '上海诚轩')).snapshot
  s = applyCommand(s, {
    type: 'hammer',
    lotNo: 'AL-0001',
    result: 'won',
    price: 3600,
    winner: '',
    hammerAt: ts('11:00')
  }).snapshot
  const report = mergePending(s, [
    {
      idempotencyKey: 'c1',
      venue: '北京嘉德',
      occurredAt: '2026-04-12T12:00:00.000Z',
      command: bid(9000, true, '北京嘉德', '12:00')
    },
    {
      idempotencyKey: 'c2',
      venue: '北京嘉德',
      occurredAt: '2026-04-12T12:05:00.000Z',
      command: { type: 'setBudget', amount: 12000 }
    }
  ])
  assert.equal(report.conflicts, 1)
  assert.equal(report.applied, 1)
  assert.equal(report.snapshot.budget, 12000)
  assert.equal(report.snapshot.lots[0].status, 'won')
  assert.equal(report.snapshot.lots[0].hammerPrice, 3600)
})

test('单件合并报价超出预算保留草稿；多件合计压超总预算给出 overrun 提醒', () => {
  // 场景一：单件报价自身就超过可用预算 → 草稿，不占预算
  const single = mergePending(emptySnapshot(3000), [
    {
      idempotencyKey: 'k1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T09:00:00.000Z',
      command: {
        type: 'upsertLot',
        lotNo: 'AL-0001',
        title: '测试封',
        category: 'cover',
        refId: null,
        source: '上海诚轩',
        ceiling: 10000,
        note: ''
      }
    },
    {
      idempotencyKey: 'k2',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(5000, true, '上海诚轩')
    }
  ])
  assert.equal(single.drafts, 1)
  assert.equal(summarizeBudget(single.snapshot).held, 0)

  // 场景二：两件报价各自都在预算内，合计压超 → 全部应用并给 overrun 提醒
  const base = emptySnapshot(5000)
  const mkLot = (lotNo: string, title: string): AuctionCommand => ({
    type: 'upsertLot',
    lotNo,
    title,
    category: 'cover',
    refId: null,
    source: '上海诚轩',
    ceiling: 10000,
    note: ''
  })
  const report = mergePending(base, [
    { idempotencyKey: 'l1', venue: '上海诚轩', occurredAt: '2026-04-12T09:00:00.000Z', command: mkLot('AL-0001', '封一') },
    { idempotencyKey: 'l2', venue: '上海诚轩', occurredAt: '2026-04-12T09:01:00.000Z', command: mkLot('AL-0002', '封二') },
    {
      idempotencyKey: 'b1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: { type: 'registerBid', lotNo: 'AL-0001', amount: 3000, isOwn: true, venue: '上海诚轩', bidAt: ts('10:00') }
    },
    {
      idempotencyKey: 'b2',
      venue: '北京嘉德',
      occurredAt: '2026-04-12T10:30:00.000Z',
      command: { type: 'registerBid', lotNo: 'AL-0002', amount: 3000, isOwn: true, venue: '北京嘉德', bidAt: ts('10:30') }
    }
  ])
  assert.equal(report.applied, 4)
  assert.equal(summarizeBudget(report.snapshot).overrun, true)
  assert.match(report.warning ?? '', /超出总预算 5000 元，差额 1000 元/)
})

test('幂等：同一条 pending 重放（重试）不重复入账', () => {
  let s = withLot(emptySnapshot(10000))
  s = applyCommand(s, { type: 'setBudget', amount: 10000 }).snapshot
  const first = mergePending(s, [
    {
      idempotencyKey: 'same',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(3000, true, '上海诚轩')
    }
  ])
  assert.equal(first.applied, 1)
  const again = mergePending(first.snapshot, [
    {
      idempotencyKey: 'same',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(3000, true, '上海诚轩')
    }
  ])
  assert.equal(again.applied, 0)
  assert.equal(again.conflicts, 1)
  assert.equal(again.snapshot.bids.filter((b) => b.isOwn && b.state === 'active').length, 1)
})

test('断网会场视图只回放本会场 pending，各会场占用各算一套', () => {
  // 总账：预算 10000，征集已在另一个会场建立，无报价
  let base = withLot(emptySnapshot(10000))
  base = applyCommand(base, { type: 'setBudget', amount: 10000 }).snapshot
  const laneA = buildLaneSnapshot(base, [
    {
      idempotencyKey: 'a',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(3000, true, '上海诚轩')
    }
  ])
  const laneB = buildLaneSnapshot(base, [
    {
      idempotencyKey: 'b',
      venue: '北京嘉德',
      occurredAt: '2026-04-12T10:30:00.000Z',
      command: bid(4000, true, '北京嘉德', '10:30')
    }
  ])
  assert.equal(summarizeBudget(laneA).held, 3000)
  assert.equal(summarizeBudget(laneB).held, 4000)
  // 总账本身没有报价，未合并前不占预算
  assert.equal(summarizeBudget(base).held, 0)
})

test('征集清单跨会场共享：A 会场未合并的新征集，B 会场也能登记报价', () => {
  const base = emptySnapshot(10000)
  const upsert: PendingEntry = {
    idempotencyKey: 'lot',
    venue: '上海诚轩',
    occurredAt: '2026-04-12T09:00:00.000Z',
    command: {
      type: 'upsertLot',
      lotNo: 'AL-0009',
      title: '跨会场封',
      category: 'cover',
      refId: null,
      source: '上海诚轩',
      ceiling: 8000,
      note: ''
    }
  }
  const bidB: PendingEntry = {
    idempotencyKey: 'bidb',
    venue: '北京嘉德',
    occurredAt: '2026-04-12T10:30:00.000Z',
    command: {
      type: 'registerBid',
      lotNo: 'AL-0009',
      amount: 4000,
      isOwn: true,
      venue: '北京嘉德',
      bidAt: ts('10:30')
    }
  }
  const laneB = buildLaneSnapshot(base, [bidB], [upsert, bidB])
  assert.equal(laneB.lots.length, 1)
  assert.equal(summarizeBudget(laneB).held, 4000)
  // A 会场视图看不到 B 的报价占用
  const laneA = buildLaneSnapshot(base, [], [upsert, bidB])
  assert.equal(summarizeBudget(laneA).held, 0)
})

test('草稿改价重试后转为已应用并占用预算', () => {
  let base = withLot(emptySnapshot(4000))
  base = applyCommand(base, { type: 'setBudget', amount: 4000 }).snapshot
  const failed = mergePending(base, [
    {
      idempotencyKey: 'd1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(5000, true, '上海诚轩')
    }
  ])
  assert.equal(failed.drafts, 1)
  // 预算调到 6000 后，用同一幂等键、改价 4000 重试
  const raised = applyCommand(failed.snapshot, { type: 'setBudget', amount: 6000 }).snapshot
  const retry = mergePending(raised, [
    {
      idempotencyKey: 'd1',
      venue: '上海诚轩',
      occurredAt: '2026-04-12T10:00:00.000Z',
      command: bid(4000, true, '上海诚轩')
    }
  ])
  assert.equal(retry.applied, 1)
  assert.equal(summarizeBudget(retry.snapshot).held, 4000)
})

console.log(`\n拍卖账引擎：${passed} 项测试全部通过\n`)
