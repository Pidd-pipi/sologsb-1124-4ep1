<script setup lang="ts">
/** 征集清单中的一件标的：按会场展示本人意向、别人最高报价、落槌/到货状态。 */
import { computed } from 'vue'
import {
  ArrowDown,
  Coin,
  Document,
  Promotion,
  Warning
} from '@element-plus/icons-vue'
import { useAuctionStore } from '@/stores/auctionStore'
import {
  ARRIVAL_STATUS_LABEL,
  BID_STATUS_LABEL,
  LOT_CATEGORY_LABEL,
  type AuctionBid,
  type AuctionLot,
  type AuctionVenue
} from '@/types/auction'

const props = defineProps<{ lot: AuctionLot; venues: AuctionVenue[] }>()

const emit = defineEmits<{
  (e: 'bid', payload: { lot: AuctionLot; venueId: number; bid?: AuctionBid }): void
  (e: 'cancel', bid: AuctionBid): void
  (e: 'competitor', payload: { lot: AuctionLot; venueId: number }): void
  (e: 'result', payload: { lot: AuctionLot; venueId: number }): void
  (e: 'arrival', payload: { lot: AuctionLot; venueId: number }): void
}>()

const store = useAuctionStore()

const categoryType: Record<string, 'primary' | 'success' | 'info'> = {
  postmark: 'primary',
  cover: 'success',
  other: 'info'
}

interface VenueRow {
  venue: AuctionVenue
  myBid: AuctionBid | null
  competitor: { bidder: string; amount: number } | null
  topAmount: number | null
  topIsMe: boolean
  result: ReturnType<typeof store.resultOfLot>
  arrival: ReturnType<typeof store.arrivalOfLot>
}

const rows = computed< VenueRow[]>(() =>
  props.venues.map((venue) => {
    const list = store.bidsOfLot(props.lot.id as number).filter((b) => b.venueId === venue.id)
    const myBids = list
      .filter((b) => b.bidder === 'me')
      .sort((a, b) => {
        // 可操作的在拍/草稿优先展示；同状态下取最新一条
        const rank = (s: AuctionBid['status']) =>
          s === 'active' ? 0 : s === 'draft' ? 1 : s === 'won' ? 2 : 3
        if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status)
        return a.createdAt < b.createdAt ? 1 : -1
      })
    const competitors = list
      .filter((b) => b.bidder !== 'me' && b.status === 'active')
      .sort((a, b) => b.amount - a.amount)
    const active = list.filter((b) => b.status === 'active').sort((a, b) => b.amount - a.amount)
    return {
      venue,
      myBid: myBids[0] ?? null,
      competitor: competitors[0] ? { bidder: competitors[0].bidder, amount: competitors[0].amount } : null,
      topAmount: active[0]?.amount ?? null,
      topIsMe: !!active[0] && active[0].bidder === 'me',
      result: store.resultOfLot(venue.id as number, props.lot.id as number),
      arrival: store.arrivalOfLot(venue.id as number, props.lot.id as number)
    }
  })
)

const bidTagType: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  draft: 'warning',
  active: 'primary',
  cancelled: 'info',
  won: 'success',
  lost: 'info',
  rejected: 'danger'
}
</script>

<template>
  <el-card class="lot-card" shadow="never">
    <header class="lot-card__head">
      <div>
        <div class="lot-card__no">
          <el-tag size="small" :type="categoryType[lot.category]">
            {{ LOT_CATEGORY_LABEL[lot.category] }}
          </el-tag>
          <strong>{{ lot.lotNo }}</strong>
        </div>
        <h4 class="lot-card__title">{{ lot.title }}</h4>
        <p class="lot-card__est">
          估价 <el-icon><Coin /></el-icon>
          ¥{{ lot.estimateLow }} – ¥{{ lot.estimateHigh }}
        </p>
      </div>
    </header>

    <p v-if="lot.note" class="lot-card__note">{{ lot.note }}</p>

    <el-divider class="lot-card__divider">各会场登记情况</el-divider>

    <div v-for="row in rows" :key="row.venue.id" class="venue-row">
      <div class="venue-row__title">
        <el-icon><Promotion /></el-icon>
        <span>{{ row.venue.name }}</span>
        <el-tag v-if="row.result" :type="row.result.won ? 'success' : 'info'" size="small">
          {{ row.result.won ? `竞得 ¥${row.result.hammerPrice}` : `${row.result.winner} ¥${row.result.hammerPrice}` }}
        </el-tag>
        <el-tag v-if="row.arrival" :type="row.arrival.status === 'abnormal' ? 'danger' : 'success'" size="small">
          {{ ARRIVAL_STATUS_LABEL[row.arrival.status] }}
          <template v-if="row.arrival.adjustment">（折让 ¥{{ row.arrival.adjustment }}）</template>
        </el-tag>
      </div>

      <div v-if="row.myBid" class="venue-row__bid">
        <el-tag :type="bidTagType[row.myBid.status]" size="small">
          {{ BID_STATUS_LABEL[row.myBid.status] }}
        </el-tag>
        <span class="amount">¥{{ row.myBid.amount }}</span>
        <el-icon v-if="row.myBid.offline" title="现场断网登记"><Document /></el-icon>
        <template v-if="row.myBid.status === 'draft'">
          <el-text type="warning" size="small">
            <el-icon><Warning /></el-icon>
            {{ row.myBid.rejectReason === 'outbid'
              ? `别人先报，差额 ¥${row.myBid.shortfall}`
              : `预算不足，差额 ¥${row.myBid.shortfall}` }}
          </el-text>
        </template>
        <el-text v-else-if="row.topAmount != null" size="small" :type="row.topIsMe ? 'success' : 'info'">
          {{ row.topIsMe ? '本人为最高报价' : `最高 ¥${row.topAmount}（${row.competitor?.bidder}）` }}
        </el-text>
        <el-button
          v-if="row.myBid && (row.myBid.status === 'active' || row.myBid.status === 'draft')"
          link
          type="danger"
          size="small"
          @click="emit('cancel', row.myBid)"
        >
          取消竞价
        </el-button>
      </div>
      <div v-else class="venue-row__bid muted">
        <el-text size="small" type="info">尚未在本会场登记意向</el-text>
      </div>

      <div class="venue-row__actions">
        <el-button
          size="small"
          type="primary"
          plain
          :disabled="!!row.result"
          @click="emit('bid', { lot, venueId: row.venue.id as number, bid: row.myBid ?? undefined })"
        >
          {{ row.myBid && (row.myBid.status === 'draft' || row.myBid.status === 'active') ? '改价/重试' : '登记意向' }}
        </el-button>
        <el-button
          size="small"
          plain
          :disabled="!!row.result || store.isOffline"
          @click="emit('competitor', { lot, venueId: row.venue.id as number })"
        >
          模拟他人先报
        </el-button>
        <el-button
          size="small"
          plain
          @click="emit('result', { lot, venueId: row.venue.id as number })"
        >
          落槌
        </el-button>
        <el-button
          size="small"
          :type="row.arrival?.status === 'abnormal' ? 'danger' : 'default'"
          plain
          :disabled="!row.result?.won"
          @click="emit('arrival', { lot, venueId: row.venue.id as number })"
        >
          <el-icon v-if="row.result?.won && !row.arrival"><ArrowDown /></el-icon>
          到货
        </el-button>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.lot-card {
  border-color: var(--gb-line);
  background: #fffdf8;
}
.lot-card__no {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--gb-muted);
  font-size: 12px;
}
.lot-card__title {
  margin: 6px 0 4px;
  font-size: 15px;
  color: var(--gb-brown);
}
.lot-card__est {
  margin: 0;
  font-size: 13px;
  color: var(--gb-ink);
}
.lot-card__est .el-icon {
  vertical-align: -2px;
}
.lot-card__note {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--gb-muted);
}
.lot-card__divider {
  margin: 10px 0;
}
.venue-row {
  border: 1px dashed var(--gb-line);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 8px;
}
.venue-row:last-child {
  margin-bottom: 0;
}
.venue-row__title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--gb-ink);
}
.venue-row__bid {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 0;
  font-size: 13px;
  flex-wrap: wrap;
}
.venue-row__bid .amount {
  font-weight: 700;
  color: #8c5a2e;
}
.venue-row__bid.muted {
  font-weight: 400;
}
.venue-row__actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
