<script setup lang="ts">
/**
 * 拍卖台账页：征集清单 → 意向报价（预算占用/草稿差额）→ 落槌 → 到货 的同一套账。
 * 顶部可切换"现场断网"：断网登记照常落本地库并进 outbox，回馆一键合并。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import { useAuctionStore } from '@/stores/auctionStore'
import LotCard from '@/components/auction/LotCard.vue'
import SyncPanel from '@/components/auction/SyncPanel.vue'
import VenueBudgetBar from '@/components/auction/VenueBudgetBar.vue'
import {
  ARRIVAL_STATUS_LABEL,
  BID_REJECT_REASON_LABEL,
  LOT_CATEGORY_LABEL,
  OP_TYPE_LABEL,
  createEmptyLot,
  createEmptyVenue,
  type AuctionBid,
  type AuctionLot,
  type ArrivalStatus,
  type LotCategory
} from '@/types/auction'
import { nowIso, toNumber } from '@/utils/id'

const store = useAuctionStore()

onMounted(async () => {
  if (!store.loaded) await store.load()
})

/** 模板兜底：会场统计尚未算出时使用的空值 */
const ZERO_STATS = { budget: 0, held: 0, payable: 0, settled: 0, committed: 0, available: 0 }

/* ------------------------------ 筛选 ------------------------------ */

const keyword = ref('')
const categoryFilter = ref<LotCategory | ''>('')

const categoryOptions = Object.entries(LOT_CATEGORY_LABEL).map(([value, label]) => ({
  value: value as LotCategory,
  label
}))

const filteredLots = computed(() =>
  store.lots.filter((lot) => {
    if (categoryFilter.value && lot.category !== categoryFilter.value) return false
    if (keyword.value.trim()) {
      const k = keyword.value.trim()
      return lot.lotNo.includes(k) || lot.title.includes(k)
    }
    return true
  })
)

/* ------------------------------ 会场与预算 ------------------------------ */

async function saveVenueFromDialog(): Promise<void> {
  try {
    await store.saveVenue({
      ...venueForm,
      budget: toNumber(venueForm.budget),
      createdAt: venueForm.createdAt || nowIso(),
      updatedAt: nowIso()
    })
    ElMessage.success(venueDialog.editing ? '会场已保存，预算独立核算。' : '会场已新建。')
    venueDialog.visible = false
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

const venueDialog = reactive({ visible: false, editing: false })
const venueForm = reactive(createEmptyVenue(nowIso()))

function openVenueCreate(): void {
  Object.assign(venueForm, createEmptyVenue(nowIso()))
  venueDialog.editing = false
  venueDialog.visible = true
}

function openVenueEdit(venueId: number): void {
  const venue = store.venueById(venueId)
  if (!venue) return
  Object.assign(venueForm, venue)
  venueDialog.editing = true
  venueDialog.visible = true
}

/* ------------------------------ 征集清单 ------------------------------ */

const lotDialog = reactive({ visible: false })
const lotForm = reactive(createEmptyLot(nowIso()))

function openLotCreate(): void {
  Object.assign(lotForm, createEmptyLot(nowIso()))
  lotDialog.visible = true
}

async function saveLotFromDialog(): Promise<void> {
  try {
    await store.saveLot({
      ...lotForm,
      estimateLow: toNumber(lotForm.estimateLow),
      estimateHigh: toNumber(lotForm.estimateHigh),
      createdAt: lotForm.createdAt || nowIso(),
      updatedAt: nowIso()
    })
    ElMessage.success('已加入征集清单，各会场可独立登记意向。')
    lotDialog.visible = false
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

async function removeLot(lot: AuctionLot): Promise<void> {
  await ElMessageBox.confirm(`确定从征集清单删除「${lot.lotNo} ${lot.title}」？`, '删除标的', {
    type: 'warning'
  })
  try {
    await store.removeLot(lot.id as number)
    ElMessage.success('已删除。')
  } catch (e) {
    ElMessage.error((e as Error).message)
  }
}

/* ------------------------------ 意向登记弹窗 ------------------------------ */

const bidDialog = reactive({
  visible: false,
  competitorMode: false,
  lotId: 0,
  venueId: 0,
  bidUid: '' as string | undefined,
  lotTitle: '',
  amount: 0,
  bidder: '',
  note: ''
})

function openBid(payload: { lot: AuctionLot; venueId: number; bid?: AuctionBid }): void {
  bidDialog.competitorMode = false
  bidDialog.lotId = payload.lot.id as number
  bidDialog.venueId = payload.venueId
  bidDialog.lotTitle = `${payload.lot.lotNo} ${payload.lot.title}`
  bidDialog.bidUid = payload.bid?.uid
  bidDialog.amount = payload.bid?.amount ?? payload.lot.estimateLow
  bidDialog.bidder = ''
  bidDialog.note = payload.bid?.note ?? ''
  bidDialog.visible = true
}

function openCompetitor(payload: { lot: AuctionLot; venueId: number }): void {
  bidDialog.competitorMode = true
  bidDialog.lotId = payload.lot.id as number
  bidDialog.venueId = payload.venueId
  bidDialog.lotTitle = `${payload.lot.lotNo} ${payload.lot.title}`
  bidDialog.bidUid = undefined
  bidDialog.amount = payload.lot.estimateHigh
  bidDialog.bidder = `${Math.floor(100 + Math.random() * 800)} 号牌`
  bidDialog.note = ''
  bidDialog.visible = true
}

/** 弹窗里实时演示"两件会不会过线"：别人最高报价、可用预算、差额。 */
const bidPreview = computed(() => {
  const amount = toNumber(bidDialog.amount)
  if (bidDialog.competitorMode) return { outbid: false, budgetShort: 0, top: 0, available: 0 }
  const all = store.bids.filter((b) => b.venueId === bidDialog.venueId && b.lotId === bidDialog.lotId)
  const replacing = bidDialog.bidUid
    ? (all.find((b) => b.uid === bidDialog.bidUid && b.status === 'active')?.amount ?? 0)
    : 0
  const top =
    all
      .filter((b) => b.status === 'active' && b.bidder !== 'me')
      .sort((a, b) => b.amount - a.amount)[0]?.amount ?? 0
  const stats = store.statsOfVenue(bidDialog.venueId)
  const available = stats ? stats.available + replacing : 0
  return {
    outbid: top >= amount,
    budgetShort: Math.max(0, Math.round((amount - available) * 100) / 100),
    top,
    available: Math.round(available * 100) / 100,
    replacing
  }
})

async function submitBid(): Promise<void> {
  const amount = toNumber(bidDialog.amount)
  if (amount <= 0) {
    ElMessage.warning('请填写大于 0 的意向价。')
    return
  }
  try {
    const out = await store.registerBid({
      venueId: bidDialog.venueId,
      lotId: bidDialog.lotId,
      amount,
      note: bidDialog.note,
      bidUid: bidDialog.bidUid,
      bidder: bidDialog.competitorMode ? bidDialog.bidder || '其它号牌' : 'me'
    })
    if (bidDialog.competitorMode) {
      ElMessage.success(`已登记 ${bidDialog.bidder} 出价 ¥${amount}（不占用本人预算）。`)
    } else if (out.ok) {
      ElMessage.success(out.message)
    } else {
      // 预算不足 / 别人先报 / 终局丢弃：草稿已经入库
      ElMessage[out.status === 'rejected' ? 'error' : 'warning'](out.message)
    }
    bidDialog.visible = false
  } catch (e) {
    // 写库失败：事务整体回滚，台账保持操作前，弹窗保留供重试
    ElMessage.error(`${(e as Error).message || '写库失败'}（台账未改动，可改后重试）`)
  }
}

async function cancelFromCard(bid: AuctionBid): Promise<void> {
  await ElMessageBox.confirm(`取消「¥${bid.amount}」这笔意向？占用将释放。`, '取消竞价', {
    type: 'warning'
  })
  try {
    await store.cancelBid(bid.id as number, '现场取消')
    ElMessage.success('已取消并释放占用。')
  } catch (e) {
    ElMessage.error(`${(e as Error).message}（台账未改动）`)
  }
}

/* ------------------------------ 落槌弹窗 ------------------------------ */

const resultDialog = reactive({
  visible: false,
  lotId: 0,
  venueId: 0,
  lotTitle: '',
  won: true,
  winner: 'me',
  hammerPrice: 0,
  buyerPremium: 0
})

function openResult(payload: { lot: AuctionLot; venueId: number }): void {
  const existing = store.resultOfLot(payload.venueId, payload.lot.id as number)
  resultDialog.lotId = payload.lot.id as number
  resultDialog.venueId = payload.venueId
  resultDialog.lotTitle = `${payload.lot.lotNo} ${payload.lot.title}`
  resultDialog.won = existing ? existing.won : true
  resultDialog.winner = existing ? existing.winner : 'me'
  resultDialog.hammerPrice = existing ? existing.hammerPrice : payload.lot.estimateLow
  resultDialog.buyerPremium = existing ? existing.buyerPremium : Math.round(payload.lot.estimateLow * 0.1)
  resultDialog.visible = true
}

async function submitResult(): Promise<void> {
  try {
    await store.recordResult({
      venueId: resultDialog.venueId,
      lotId: resultDialog.lotId,
      winner: resultDialog.won ? 'me' : resultDialog.winner || '其它号牌',
      hammerPrice: toNumber(resultDialog.hammerPrice),
      buyerPremium: toNumber(resultDialog.buyerPremium),
      won: resultDialog.won
    })
    ElMessage.success(
      resultDialog.won
        ? '已登记竞得：意向额转应付，占用已重算。'
        : '已登记未竞得：本人意向释放，占用已重算。'
    )
    resultDialog.visible = false
  } catch (e) {
    ElMessage.error(`${(e as Error).message || '写库失败'}（台账未改动，可重试）`)
  }
}

/* ------------------------------ 到货弹窗 ------------------------------ */

const arrivalDialog = reactive({
  visible: false,
  lotId: 0,
  venueId: 0,
  lotTitle: '',
  status: 'received' as ArrivalStatus,
  arrivedAt: new Date().toISOString().slice(0, 10),
  adjustment: 0,
  note: ''
})

const arrivalContext = computed(() =>
  store.resultOfLot(arrivalDialog.venueId, arrivalDialog.lotId)
)
const settledPreview = computed(() => {
  const r = arrivalContext.value
  if (!r) return 0
  return Math.max(0, Math.round((r.hammerPrice + r.buyerPremium - toNumber(arrivalDialog.adjustment)) * 100) / 100)
})

function openArrival(payload: { lot: AuctionLot; venueId: number }): void {
  const existing = store.arrivalOfLot(payload.venueId, payload.lot.id as number)
  arrivalDialog.lotId = payload.lot.id as number
  arrivalDialog.venueId = payload.venueId
  arrivalDialog.lotTitle = `${payload.lot.lotNo} ${payload.lot.title}`
  arrivalDialog.status = existing?.status ?? 'received'
  arrivalDialog.arrivedAt = existing?.arrivedAt ?? new Date().toISOString().slice(0, 10)
  arrivalDialog.adjustment = existing?.adjustment ?? 0
  arrivalDialog.note = existing?.note ?? ''
  arrivalDialog.visible = true
}

async function submitArrival(): Promise<void> {
  try {
    await store.recordArrival({
      venueId: arrivalDialog.venueId,
      lotId: arrivalDialog.lotId,
      arrivedAt: arrivalDialog.arrivedAt,
      adjustment: toNumber(arrivalDialog.adjustment),
      status: arrivalDialog.status,
      note: arrivalDialog.note
    })
    ElMessage.success(
      arrivalDialog.status === 'abnormal'
        ? `到货异常已登记，实付按折让重算为 ¥${settledPreview.value}。`
        : `正常到货，实付 ¥${settledPreview.value} 已结清。`
    )
    arrivalDialog.visible = false
  } catch (e) {
    ElMessage.error(`${(e as Error).message || '写库失败'}（台账未改动，可重试）`)
  }
}

/* ------------------------------ 草稿清单（快速定位） ------------------------------ */

const draftBids = computed(() =>
  store.bids.filter((b) => b.status === 'draft' && typeof b.id === 'number')
)

function resumeDraft(bid: AuctionBid): void {
  const lot = store.lotById(bid.lotId)
  if (!lot) return
  openBid({ lot, venueId: bid.venueId, bid })
}
</script>

<template>
  <div class="gb-page auction-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">拍卖台账 · 征集 / 报价 / 落槌 / 到货同一套账</h1>
        <p class="gb-page__subtitle">
          每件先按会场占用意向额；预算不足或被别人先报则保留草稿并写明差额。
          现场断网照常登记，回馆合并时终局结果不被覆盖，写库失败整笔回滚、可重试。
        </p>
      </div>
      <div class="auction-page__tools">
        <el-radio-group
          :model-value="store.netMode"
          size="small"
          @update:model-value="store.setNetMode($event as 'online' | 'offline')"
        >
          <el-radio-button value="online">联网（馆内）</el-radio-button>
          <el-radio-button value="offline">现场断网</el-radio-button>
        </el-radio-group>
        <el-tooltip content="开启后任意写操作都会在落库前失败，演示事务回滚与重试；不影响断网排队本身。" placement="bottom">
          <el-switch
            :model-value="store.writeFail"
            active-text="模拟写库故障"
            inline-prompt
            @update:model-value="store.toggleWriteFail($event as boolean)"
          />
        </el-tooltip>
      </div>
    </header>

    <el-alert
      v-if="store.isOffline"
      title="现场断网模式：报价、取消、落槌、到货都会先写入本机并排入 outbox；预算占用在本机即时生效，回馆后一键合并。"
      type="warning"
      :closable="false"
      show-icon
      class="auction-page__alert"
    />
    <el-alert
      v-if="store.writeFail"
      title="写库故障注入已开启：下一笔写操作将失败并回滚（台账不变），关闭开关后可对同一条操作重试。"
      type="error"
      :closable="false"
      show-icon
      class="auction-page__alert"
    />

    <!-- 会场与预算 -->
    <section class="gb-panel">
      <header class="auction-page__panel-head">
        <h3 class="gb-panel__title">会场预算（多会场重复登记同一件时，占用与最高报价各算一套）</h3>
        <el-button size="small" :icon="Plus" @click="openVenueCreate">新建会场</el-button>
      </header>
      <div v-if="store.venues.length" class="venue-list">
        <div v-for="venue in store.venues" :key="venue.id" class="venue-card">
          <div class="venue-card__head">
            <div>
              <strong>{{ venue.name }}</strong>
              <small>{{ venue.sessionDate }} · {{ venue.note || '无备注' }}</small>
            </div>
            <el-button link size="small" @click="openVenueEdit(venue.id as number)">编辑预算</el-button>
          </div>
          <VenueBudgetBar :stats="store.statsOfVenue(venue.id as number) ?? ZERO_STATS" />
        </div>
      </div>
      <div v-else class="gb-empty">还没有会场，先建一个并设定意向预算。</div>
    </section>

    <!-- 断网 outbox -->
    <SyncPanel />

    <!-- 草稿与异常报价 -->
    <section v-if="draftBids.length" class="gb-panel">
      <h3 class="gb-panel__title">保留中的草稿（预算不足 / 被别人先报，附差额）</h3>
      <div class="draft-list">
        <el-alert
          v-for="bid in draftBids"
          :key="bid.id"
          :closable="false"
          type="warning"
          show-icon
          class="draft-item"
        >
          <template #title>
            <strong>{{ store.lotById(bid.lotId)?.lotNo }}</strong>
            @ {{ store.venueById(bid.venueId)?.name }}：意向 ¥{{ bid.amount }}
            <el-tag size="small" type="warning">
              {{ bid.rejectReason ? BID_REJECT_REASON_LABEL[bid.rejectReason] : '草稿' }}
            </el-tag>
            差额 <strong>¥{{ bid.shortfall }}</strong>
            <el-button link type="primary" size="small" @click="resumeDraft(bid)">改价重试</el-button>
          </template>
        </el-alert>
      </div>
    </section>

    <!-- 征集清单 -->
    <section>
      <header class="auction-page__panel-head">
        <h3 class="gb-panel__title" style="margin: 0">征集清单</h3>
        <div class="auction-page__filters">
          <el-select v-model="categoryFilter" placeholder="全部品类" clearable size="small" style="width: 130px">
            <el-option v-for="opt in categoryOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
          <el-input v-model="keyword" placeholder="拍品号 / 名称" size="small" clearable style="width: 200px" />
          <el-button size="small" type="primary" :icon="Plus" @click="openLotCreate">新增标的</el-button>
        </div>
      </header>

      <div v-if="filteredLots.length" class="gb-grid gb-grid--wide lot-grid">
        <div v-for="lot in filteredLots" :key="lot.id" class="lot-wrap">
          <LotCard
            :lot="lot"
            :venues="store.venues"
            @bid="openBid"
            @cancel="cancelFromCard"
            @competitor="openCompetitor"
            @result="openResult"
            @arrival="openArrival"
          />
          <div class="lot-wrap__foot">
            <el-button link type="info" size="small" @click="removeLot(lot)">从清单删除</el-button>
          </div>
        </div>
      </div>
      <div v-else class="gb-empty">清单为空，先新增标的。</div>
    </section>

    <!-- 操作流水 -->
    <section class="gb-panel">
      <h3 class="gb-panel__title">操作流水（所有写操作的审计轨迹）</h3>
      <el-timeline v-if="store.journals.length">
        <el-timeline-item
          v-for="(j, idx) in store.journals.slice(0, 30)"
          :key="j.id ?? idx"
          :timestamp="new Date(j.createdAt).toLocaleString('zh-CN')"
          placement="top"
          :type="j.offline ? 'warning' : 'primary'"
        >
          <el-tag size="small" :type="j.offline ? 'warning' : 'info'" effect="plain">
            {{ j.offline ? '断网' : '联网' }} · {{ OP_TYPE_LABEL[j.type] }}
          </el-tag>
          <strong style="margin-left: 6px">{{ j.action }}</strong>
          <div class="muted" style="font-size: 12px">{{ j.detail }}</div>
        </el-timeline-item>
      </el-timeline>
      <div v-else class="gb-empty">还没有操作记录。</div>
    </section>

    <!-- 会场弹窗 -->
    <el-dialog v-model="venueDialog.visible" :title="venueDialog.editing ? '编辑会场' : '新建会场'" width="460px">
      <el-form label-width="92px">
        <el-form-item label="会场名称">
          <el-input v-model="venueForm.name" placeholder="如：上海春拍 · 邮品专场" />
        </el-form-item>
        <el-form-item label="拍卖日期">
          <el-date-picker v-model="venueForm.sessionDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item label="意向预算（元）">
          <el-input-number v-model="venueForm.budget" :min="0" :step="1000" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="venueForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="venueDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveVenueFromDialog">保存</el-button>
      </template>
    </el-dialog>

    <!-- 标的弹窗 -->
    <el-dialog v-model="lotDialog.visible" title="新增征集标的" width="520px">
      <el-form label-width="92px">
        <el-form-item label="拍品号">
          <el-input v-model="lotForm.lotNo" placeholder="留空自动编号 L-2026-xxx" />
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="lotForm.title" placeholder="如：某某戳实寄封" />
        </el-form-item>
        <el-form-item label="品类">
          <el-radio-group v-model="lotForm.category">
            <el-radio v-for="opt in categoryOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="估价区间">
          <el-input-number v-model="lotForm.estimateLow" :min="0" :step="100" />
          <span style="margin: 0 8px">–</span>
          <el-input-number v-model="lotForm.estimateHigh" :min="0" :step="100" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="lotForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="lotDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="saveLotFromDialog">加入清单</el-button>
      </template>
    </el-dialog>

    <!-- 意向登记 / 他人先报 弹窗 -->
    <el-dialog
      v-model="bidDialog.visible"
      :title="bidDialog.competitorMode ? '模拟场内他人出价' : `登记意向价 · ${bidDialog.lotTitle}`"
      width="480px"
    >
      <template v-if="bidDialog.competitorMode">
        <el-form label-width="80px">
          <el-form-item label="号牌">
            <el-input v-model="bidDialog.bidder" placeholder="如：258 号牌" />
          </el-form-item>
          <el-form-item label="出价（元）">
            <el-input-number v-model="bidDialog.amount" :min="1" :step="100" style="width: 100%" />
          </el-form-item>
        </el-form>
        <el-alert
          title="他人出价只用于判断“同一件被别人先报”，不会占用本人预算；该操作不进入断网队列。"
          type="info"
          :closable="false"
          show-icon
        />
      </template>
      <template v-else>
        <el-form label-width="100px">
          <el-form-item label="意向价（元）">
            <el-input-number v-model="bidDialog.amount" :min="1" :step="100" style="width: 100%" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="bidDialog.note" type="textarea" :rows="2" placeholder="佣金口径、品相要求等" />
          </el-form-item>
        </el-form>
        <div class="bid-hints">
          <el-alert
            :title="`本会场当前可用预算 ¥${bidPreview.available}`"
            :type="bidPreview.budgetShort > 0 ? 'error' : 'success'"
            :closable="false"
            show-icon
          />
          <el-alert
            v-if="bidPreview.top > 0"
            :title="`他人最高报价 ¥${bidPreview.top}`"
            :type="bidPreview.outbid ? 'warning' : 'success'"
            :closable="false"
            show-icon
          />
          <el-alert
            v-if="bidPreview.budgetShort > 0"
            :title="`预算不足：将保留草稿，差额 ¥${bidPreview.budgetShort}`"
            type="error"
            :closable="false"
            show-icon
          />
          <el-alert
            v-if="bidPreview.outbid"
            :title="`别人先报：将保留草稿，需加价至少 ¥${bidPreview.top - toNumber(bidDialog.amount) + 1}`"
            type="warning"
            :closable="false"
            show-icon
          />
        </div>
      </template>
      <template #footer>
        <el-button @click="bidDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitBid">
          {{ bidDialog.competitorMode ? '登记他人出价' : store.isOffline ? '断网登记并排队' : '登记并占用' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 落槌弹窗 -->
    <el-dialog v-model="resultDialog.visible" :title="`登记落槌结果 · ${resultDialog.lotTitle}`" width="480px">
      <el-form label-width="92px">
        <el-form-item label="结果">
          <el-radio-group v-model="resultDialog.won">
            <el-radio :value="true">本人竞得</el-radio>
            <el-radio :value="false">他人竞得</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!resultDialog.won" label="竞得号牌">
          <el-input v-model="resultDialog.winner" placeholder="如：258 号牌" />
        </el-form-item>
        <el-form-item label="落槌价（元）">
          <el-input-number v-model="resultDialog.hammerPrice" :min="0" :step="100" style="width: 100%" />
        </el-form-item>
        <el-form-item label="买家佣金（元）">
          <el-input-number v-model="resultDialog.buyerPremium" :min="0" :step="10" style="width: 100%" />
        </el-form-item>
      </el-form>
      <el-alert
        v-if="resultDialog.won"
        :title="`竞得后 ¥${toNumber(resultDialog.hammerPrice) + toNumber(resultDialog.buyerPremium)} 转为应付，在拍意向额释放重算。`"
        type="success"
        :closable="false"
        show-icon
      />
      <template #footer>
        <el-button @click="resultDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitResult">登记落槌</el-button>
      </template>
    </el-dialog>

    <!-- 到货弹窗 -->
    <el-dialog v-model="arrivalDialog.visible" :title="`到货登记 · ${arrivalDialog.lotTitle}`" width="480px">
      <el-form label-width="92px">
        <el-form-item label="到货情况">
          <el-radio-group v-model="arrivalDialog.status">
            <el-radio value="received">{{ ARRIVAL_STATUS_LABEL.received }}</el-radio>
            <el-radio value="abnormal">{{ ARRIVAL_STATUS_LABEL.abnormal }}</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="到货日期">
          <el-date-picker v-model="arrivalDialog.arrivedAt" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="arrivalDialog.status === 'abnormal'" label="异常折让（元）">
          <el-input-number v-model="arrivalDialog.adjustment" :min="0" :step="50" style="width: 100%" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="arrivalDialog.note" type="textarea" :rows="2" placeholder="缺损描述、折让依据等" />
        </el-form-item>
      </el-form>
      <el-alert
        :title="`实付 = 落槌价 + 佣金 − 折让 = ¥${settledPreview}；登记后待付释放。`"
        :type="arrivalDialog.status === 'abnormal' ? 'warning' : 'success'"
        :closable="false"
        show-icon
      />
      <template #footer>
        <el-button @click="arrivalDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitArrival">登记到货</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.auction-page__tools {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.auction-page__alert {
  margin-bottom: 14px;
}
.auction-page__panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.auction-page__filters {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.venue-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
  gap: 12px;
}
.venue-card {
  border: 1px solid var(--gb-line);
  border-radius: 10px;
  padding: 10px 12px;
  background: #fff;
}
.venue-card__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
  gap: 8px;
}
.venue-card__head small {
  display: block;
  color: var(--gb-muted);
  font-size: 12px;
  margin-top: 2px;
}
.lot-grid {
  margin-top: 4px;
}
.lot-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.lot-wrap__foot {
  display: flex;
  justify-content: space-between;
  padding: 0 4px;
}
.draft-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.draft-item :deep(.el-alert__title) {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.bid-hints {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.muted {
  color: var(--gb-muted);
}
</style>
