/**
 * 拍卖台账首次运行的样例数据：
 * 两个会场（预算独立）、三件征集标的，并预置两类典型现场状态：
 *  - 一件预算不足保留的草稿（附差额）
 *  - 一件"别人先报"的冲突演示（outbox 里有断网出价，拍卖结果里已有落槌真相）
 */
import { db } from './db'
import { uid } from './id'
import type {
  AuctionBid,
  AuctionJournal,
  AuctionLot,
  AuctionOp,
  AuctionResult,
  AuctionVenue
} from '@/types/auction'

const SEED_TS = '2026-09-20T09:00:00.000Z'

export async function seedAuctionIfEmpty(): Promise<void> {
  if ((await db.auctionLots.count()) > 0) return

  const v1: AuctionVenue = {
    uid: 'venue-seed-spring',
    name: '上海春拍 · 邮品专场',
    budget: 20000,
    sessionDate: '2026-09-18',
    note: '本季邮品专场，意向预算 2 万元。',
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }
  const v2: AuctionVenue = {
    uid: 'venue-seed-autumn',
    name: '北京秋拍 · 邮政史场',
    budget: 30000,
    sessionDate: '2026-09-25',
    note: '邮政史与军邮专场。',
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }

  const lot1: AuctionLot = {
    uid: 'lot-seed-shanghai-circle',
    lotNo: 'L-2026-001',
    title: '上海圆形日戳封（PM-0001 同款，1910）',
    category: 'cover',
    estimateLow: 6000,
    estimateHigh: 9000,
    note: '中英文三格圆形日戳，封背中转完整。',
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }
  const lot2: AuctionLot = {
    uid: 'lot-seed-military',
    lotNo: 'L-2026-002',
    title: '军邮 231 局实寄封（孤品）',
    category: 'cover',
    estimateLow: 18000,
    estimateHigh: 26000,
    note: '抗战军邮，估价远超单场预算，用于演示预算占用与差额。',
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }
  const lot3: AuctionLot = {
    uid: 'lot-seed-canton-cancel',
    lotNo: 'L-2026-003',
    title: '广州机盖波纹戳剪片',
    category: 'postmark',
    estimateLow: 800,
    estimateHigh: 1500,
    note: '波纹六线清晰。',
    createdAt: SEED_TS,
    updatedAt: SEED_TS
  }

  // 预算不足草稿：意向 24000，本场预算 20000 → 差额 4000
  const draftBid: AuctionBid = {
    uid: uid('bid'),
    venueId: 0,
    lotId: 0,
    bidder: 'me',
    amount: 24000,
    status: 'draft',
    rejectReason: 'budget_short',
    shortfall: 4000,
    note: '现场预填，等追加预算后转在拍。',
    offline: true,
    createdAt: '2026-09-25T10:05:00.000Z',
    updatedAt: '2026-09-25T10:05:00.000Z'
  }

  // 断网期间在秋拍现场对 lot3 的出价（回馆后会发现该件已被别人竞得）
  const offlineBid: AuctionBid = {
    uid: 'bid-seed-offline-canton',
    venueId: 0,
    lotId: 0,
    bidder: 'me',
    amount: 1200,
    status: 'active',
    rejectReason: '',
    shortfall: 0,
    note: '现场断网登记，回馆待合并。',
    offline: true,
    createdAt: '2026-09-25T14:20:00.000Z',
    updatedAt: '2026-09-25T14:20:00.000Z'
  }

  // 服务端真相：lot3 已在秋拍落槌给别人（合并时不允许被断网记录盖掉）
  const officialResult: AuctionResult = {
    uid: 'result-seed-canton',
    venueId: 0,
    lotId: 0,
    bidId: null,
    winner: '258 号牌',
    hammerPrice: 1300,
    buyerPremium: 130,
    won: false,
    conflictNote: '拍场台账：258 号牌竞得。',
    offline: false,
    createdAt: '2026-09-25T16:00:00.000Z'
  }

  const queuedOp: AuctionOp = {
    opId: 'op-seed-offline-bid',
    type: 'bid',
    venueId: 0,
    lotId: 0,
    occurredAt: '2026-09-25T14:20:00.000Z',
    bidUid: 'bid-seed-offline-canton',
    amount: 1200,
    note: '现场断网登记，回馆待合并。',
    opStatus: 'queued',
    message: '',
    attempts: 0,
    createdAt: '2026-09-25T14:20:00.000Z',
    updatedAt: '2026-09-25T14:20:00.000Z'
  }

  const journals: AuctionJournal[] = [
    {
      opId: 'journal-seed-1',
      type: 'bid',
      venueId: 0,
      lotId: 0,
      action: '保留草稿',
      detail: '军邮封意向 24000 元，预算不足，差额 4000 元。',
      offline: true,
      createdAt: '2026-09-25T10:05:00.000Z'
    }
  ]

  const tables = [
    db.auctionVenues,
    db.auctionLots,
    db.auctionBids,
    db.auctionResults,
    db.auctionOps,
    db.auctionJournal
  ]
  await db.transaction('rw', tables, async () => {
      const v1Id = await db.auctionVenues.add(v1)
      const v2Id = await db.auctionVenues.add(v2)
      const lot1Id = await db.auctionLots.add(lot1)
      const lot2Id = await db.auctionLots.add(lot2)
      const lot3Id = await db.auctionLots.add(lot3)

      // 种子里写的是占位 id，入库后补成真实自增 id
      await db.auctionBids.bulkAdd([
        { ...draftBid, venueId: v2Id, lotId: lot2Id },
        { ...offlineBid, venueId: v2Id, lotId: lot3Id }
      ])
      await db.auctionResults.add({ ...officialResult, venueId: v2Id, lotId: lot3Id })
      await db.auctionOps.add({ ...queuedOp, venueId: v2Id, lotId: lot3Id })
      await db.auctionJournal.bulkAdd(
        journals.map((j) => ({ ...j, venueId: v2Id, lotId: lot2Id }))
      )
    }
  )
}
