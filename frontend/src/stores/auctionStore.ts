import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  auctionService,
  isWriteFailSimulation,
  setWriteFailSimulation,
  type LedgerData,
  type RegisterBidOutcome,
  type VenueStats
} from '@/utils/auctionService'
import type {
  ArrivalInput,
  AuctionArrival,
  AuctionBid,
  AuctionJournal,
  AuctionLot,
  AuctionOp,
  AuctionResult,
  AuctionVenue,
  ResultInput
} from '@/types/auction'

/** 现场网络状态：断网时所有登记照常落本地库并入 outbox，回馆后合并。 */
export type NetMode = 'online' | 'offline'

const NET_KEY = 'gbpostmark:auction:net-mode'

export const useAuctionStore = defineStore('auction', () => {
  const lots = ref<AuctionLot[]>([])
  const venues = ref<AuctionVenue[]>([])
  const bids = ref<AuctionBid[]>([])
  const results = ref<AuctionResult[]>([])
  const arrivals = ref<AuctionArrival[]>([])
  const ops = ref<AuctionOp[]>([])
  const journals = ref<AuctionJournal[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const netMode = ref<NetMode>('online')
  const writeFail = ref(false)

  async function load(): Promise<void> {
    loading.value = true
    try {
      const data: LedgerData = await auctionService.loadAll()
      lots.value = data.lots
      venues.value = data.venues
      bids.value = data.bids
      results.value = data.results
      arrivals.value = data.arrivals
      ops.value = data.ops
      journals.value = data.journals
      writeFail.value = isWriteFailSimulation()
      try {
        netMode.value = (globalThis.localStorage.getItem(NET_KEY) as NetMode) || 'online'
      } catch {
        netMode.value = 'online'
      }
      loaded.value = true
    } finally {
      loading.value = false
    }
  }

  const isOffline = computed(() => netMode.value === 'offline')
  const pendingCount = computed(() => ops.value.filter((o) => o.opStatus === 'queued').length)
  const retryCount = computed(() => ops.value.filter((o) => o.opStatus === 'retry').length)

  function setNetMode(mode: NetMode): void {
    netMode.value = mode
    try {
      globalThis.localStorage.setItem(NET_KEY, mode)
    } catch {
      /* ignore */
    }
  }

  function toggleWriteFail(on: boolean): void {
    setWriteFailSimulation(on)
    writeFail.value = on
  }

  /* ------------------------------ 关联查询 ------------------------------ */

  function lotById(id: number | null | undefined): AuctionLot | null {
    if (id == null) return null
    return lots.value.find((l) => l.id === id) ?? null
  }

  function venueById(id: number | null | undefined): AuctionVenue | null {
    if (id == null) return null
    return venues.value.find((v) => v.id === id) ?? null
  }

  function bidsOfLot(lotId: number): AuctionBid[] {
    return bids.value.filter((b) => b.lotId === lotId)
  }

  function resultOfLot(venueId: number, lotId: number): AuctionResult | null {
    return results.value.find((r) => r.venueId === venueId && r.lotId === lotId) ?? null
  }

  function arrivalOfLot(venueId: number, lotId: number): AuctionArrival | null {
    return arrivals.value.find((a) => a.venueId === venueId && a.lotId === lotId) ?? null
  }

  function statsOfVenue(venueId: number): VenueStats | null {
    const venue = venueById(venueId)
    if (!venue) return null
    return auctionService.venueStats(venue, bids.value, results.value, arrivals.value)
  }

  /** 某会场某件的最高报价（含别人，用于"最高报价各算一套"的展示）。 */
  function topBid(venueId: number, lotId: number): AuctionBid | null {
    const list = bids.value
      .filter((b) => b.venueId === venueId && b.lotId === lotId && b.status === 'active')
      .sort((a, b) => b.amount - a.amount)
    return list[0] ?? null
  }

  /* ------------------------------ 写操作 ------------------------------ */

  async function registerBid(input: {
    venueId: number
    lotId: number
    amount: number
    note: string
    bidUid?: string
    bidder?: string
  }): Promise<RegisterBidOutcome> {
    const outcome = await auctionService.registerBid({ ...input, offline: isOffline.value })
    await load()
    return outcome
  }

  async function cancelBid(bidId: number, note = ''): Promise<void> {
    await auctionService.cancelBid({ bidId, note, offline: isOffline.value })
    await load()
  }

  async function recordResult(input: Omit<ResultInput, 'offline'>): Promise<void> {
    await auctionService.recordResult({ ...input, offline: isOffline.value })
    await load()
  }

  async function recordArrival(input: Omit<ArrivalInput, 'offline'>): Promise<void> {
    await auctionService.recordArrival({ ...input, offline: isOffline.value })
    await load()
  }

  async function merge(): Promise<{
    total: number
    applied: number
    conflicts: { opId: string; message: string }[]
    failed: { opId: string; message: string } | null
  }> {
    const summary = await auctionService.mergeQueuedOps()
    await load()
    return summary
  }

  async function retryOp(opId: string): Promise<void> {
    await auctionService.retryOp(opId)
    await load()
  }

  async function discardOp(opId: string): Promise<void> {
    await auctionService.discardOp(opId)
    await load()
  }

  async function saveLot(lot: AuctionLot): Promise<number> {
    const id = await auctionService.saveLot(lot)
    await load()
    return id
  }

  async function removeLot(lotId: number): Promise<void> {
    await auctionService.removeLot(lotId)
    await load()
  }

  async function saveVenue(venue: AuctionVenue): Promise<number> {
    const id = await auctionService.saveVenue(venue)
    await load()
    return id
  }

  return {
    // state
    lots,
    venues,
    bids,
    results,
    arrivals,
    ops,
    journals,
    loading,
    loaded,
    netMode,
    writeFail,
    // getters
    isOffline,
    pendingCount,
    retryCount,
    // queries
    lotById,
    venueById,
    bidsOfLot,
    resultOfLot,
    arrivalOfLot,
    statsOfVenue,
    topBid,
    // actions
    load,
    setNetMode,
    toggleWriteFail,
    registerBid,
    cancelBid,
    recordResult,
    recordArrival,
    merge,
    retryOp,
    discardOp,
    saveLot,
    removeLot,
    saveVenue
  }
})
