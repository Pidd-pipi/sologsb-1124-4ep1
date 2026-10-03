<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuctionStore } from '@/stores/auctionStore'
import { useCoverStore } from '@/stores/coverStore'
import { usePostmarkStore } from '@/stores/postmarkStore'
import type { AuctionLot, LotCategory, LotStatus } from '@/types/auction'
import {
  ARRIVAL_ISSUE_LABELS,
  HAMMER_RESULT_LABELS,
  LOT_STATUS_LABELS,
  TERMINAL_STATUSES,
  createEmptyLot,
  nowMinute,
  type ArrivalIssue,
  type HammerResult
} from '@/types/auction'
import type { AuctionCommand } from '@/types/auction'
import { toNumber } from '@/utils/id'
import { lotHeldAmount } from '@/utils/auctionEngine'

const router = useRouter()
const auction = useAuctionStore()
const coverStore = useCoverStore()
const postmarkStore = usePostmarkStore()

onMounted(async () => {
  if (!auction.loaded) await auction.load()
  if (!coverStore.loaded) await coverStore.load()
  if (!postmarkStore.loaded) await postmarkStore.load()
})

/* ------------------------------ 预算 ------------------------------ */

const budgetEditing = ref(false)
const budgetDraft = ref(0)

function editBudget(): void {
  budgetDraft.value = auction.budget
  budgetEditing.value = true
}

async function saveBudget(): Promise<void> {
  const res = await auction.applyOnline({ type: 'setBudget', amount: Math.round(budgetDraft.value) })
  if (res.ok) {
    ElMessage.success(res.message)
    budgetEditing.value = false
  } else {
    ElMessage.error(res.message)
  }
}

const budgetPct = computed(() => {
  const s = auction.summary
  if (!s.budget) return 0
  return Math.min(100, Math.round((s.held / s.budget) * 100))
})

/* ------------------------------ 征集表单 ------------------------------ */

const lotDialog = ref(false)
const lotForm = reactive<AuctionLot>(createEmptyLot())

const refOptions = computed(() => {
  const covers = coverStore.list.map((c) => ({
    label: `实寄封 ${c.coverNo} ${c.sentFrom}→${c.sentTo}`,
    value: `cover-${c.id}`
  }))
  const pms = postmarkStore.list.map((p) => ({
    label: `邮戳 ${p.pmNo} ${p.office}`,
    value: `postmark-${p.id}`
  }))
  return [...covers, ...pms]
})

function openCreateLot(): void {
  Object.assign(lotForm, createEmptyLot())
  lotForm.lotNo = auction.nextLotNo()
  lotDialog.value = true
}

function openEditLot(lot: AuctionLot): void {
  Object.assign(lotForm, JSON.parse(JSON.stringify(lot)) as AuctionLot)
  lotDialog.value = true
}

async function submitLot(): Promise<void> {
  if (!lotForm.lotNo.trim() || !lotForm.title.trim()) {
    ElMessage.warning('拍品号与名称必填')
    return
  }
  const refMatch = /^(cover|postmark)-(\d+)$/.exec(String(lotForm.refId ?? ''))
  const command: AuctionCommand = {
    type: 'upsertLot',
    lotNo: lotForm.lotNo.trim(),
    title: lotForm.title.trim(),
    category: lotForm.category,
    refId: refMatch ? Number(refMatch[2]) : null,
    source: lotForm.source.trim(),
    ceiling: Math.round(toNumber(lotForm.ceiling)),
    note: lotForm.note
  }
  const res = await auction.applyOnline(command)
  if (res.ok) {
    ElMessage.success(res.message)
    lotDialog.value = false
  } else {
    ElMessage.error(res.message)
  }
}

function onCategoryChange(): void {
  lotForm.refId = null
}

/* ------------------------------ 报价 ------------------------------ */

const bidDialog = ref(false)
const bidForm = reactive({
  lotNo: '',
  amount: 0,
  isOwn: true,
  venue: '',
  bidAt: nowMinute()
})

function openBid(lot: AuctionLot, isOwn: boolean): void {
  bidForm.lotNo = lot.lotNo
  bidForm.amount = (isOwn ? lot.ownHigh : lot.competitorHigh) + 100 || lot.ceiling
  bidForm.isOwn = isOwn
  bidForm.venue = lot.source
  bidForm.bidAt = nowMinute()
  bidDialog.value = true
}

async function submitBid(): Promise<void> {
  const amount = Math.round(toNumber(bidForm.amount))
  if (amount <= 0) {
    ElMessage.warning('报价必须大于 0')
    return
  }
  const res = await auction.applyOnline({
    type: 'registerBid',
    lotNo: bidForm.lotNo,
    amount,
    isOwn: bidForm.isOwn,
    venue: bidForm.venue.trim() || '回馆补录',
    bidAt: bidForm.bidAt
  })
  if (res.ok) {
    ElMessage.success(res.message)
    bidDialog.value = false
  } else {
    // 预算不足 / 被别人先报：线上模式直接说明差额，不落草稿（草稿只在断网现场保留）
    ElMessage.error(res.message)
  }
}

/* ------------------------------ 取消竞价 ------------------------------ */

async function cancelBidding(lot: AuctionLot): Promise<void> {
  const own = auction.bidsOf(lot.lotNo).filter((b) => b.isOwn && b.state === 'active')
  if (!own.length) {
    ElMessage.warning('这件没有可取消的己方有效报价')
    return
  }
  let reason = '竞价取消'
  try {
    const r = await ElMessageBox.prompt('请填写取消 / 撤拍原因', '竞价取消', {
      confirmButtonText: '确认取消并释放占用',
      cancelButtonText: '再想想',
      inputValue: '现场撤拍',
      inputValidator: (v: string) => !!v.trim() || '原因不能为空'
    })
    reason = r.value
  } catch {
    return
  }
  const venues = [...new Set(own.map((b) => b.venue))]
  const res = await auction.applyOnline({
    type: 'cancelBidding',
    lotNo: lot.lotNo,
    venue: venues.length === 1 ? venues[0] : '',
    bidKey: '',
    reason
  })
  if (res.ok) ElMessage.success(res.message)
  else ElMessage.error(res.message)
}

/* ------------------------------ 落槌 ------------------------------ */

const hammerDialog = ref(false)
const hammerForm = reactive<{
  lotNo: string
  result: HammerResult
  price: number
  winner: string
  hammerAt: string
}>({
  lotNo: '',
  result: 'won',
  price: 0,
  winner: '',
  hammerAt: nowMinute()
})

function openHammer(lot: AuctionLot): void {
  hammerForm.lotNo = lot.lotNo
  hammerForm.result = 'won'
  hammerForm.price = lot.ownHigh || lot.competitorHigh
  hammerForm.winner = ''
  hammerForm.hammerAt = nowMinute()
  hammerDialog.value = true
}

async function submitHammer(): Promise<void> {
  const res = await auction.applyOnline({
    type: 'hammer',
    lotNo: hammerForm.lotNo,
    result: hammerForm.result,
    price: Math.round(toNumber(hammerForm.price)),
    winner: hammerForm.winner.trim(),
    hammerAt: hammerForm.hammerAt
  })
  if (res.ok) ElMessage.success(res.message)
  else ElMessage.error(res.message)
}

/* ------------------------------ 到货 ------------------------------ */

const arriveDialog = ref(false)
const arriveForm = reactive<{
  lotNo: string
  normal: boolean
  issue: ArrivalIssue | ''
  receivedQty: number
  note: string
  arrivedAt: string
}>({
  lotNo: '',
  normal: true,
  issue: '',
  receivedQty: 1,
  note: '',
  arrivedAt: nowMinute()
})

function openArrive(lot: AuctionLot): void {
  arriveForm.lotNo = lot.lotNo
  arriveForm.normal = true
  arriveForm.issue = ''
  arriveForm.receivedQty = 1
  arriveForm.note = ''
  arriveForm.arrivedAt = nowMinute()
  arriveDialog.value = true
}

async function submitArrive(): Promise<void> {
  if (!arriveForm.normal && !arriveForm.issue) {
    ElMessage.warning('到货异常请选择异常类型')
    return
  }
  const res = await auction.applyOnline({
    type: 'arrive',
    lotNo: arriveForm.lotNo,
    normal: arriveForm.normal,
    issue: arriveForm.normal ? '' : arriveForm.issue,
    receivedQty: Math.max(0, Math.trunc(toNumber(arriveForm.receivedQty))),
    note: arriveForm.note,
    arrivedAt: arriveForm.arrivedAt
  })
  if (res.ok) ElMessage.success(res.message)
  else ElMessage.error(res.message)
}

/* ------------------------------ 展示辅助 ------------------------------ */

const STATUS_TAG_TYPE: Record<LotStatus, 'success' | 'warning' | 'danger' | 'info' | 'primary'> = {
  watching: 'primary',
  outbid: 'danger',
  won: 'success',
  lost: 'info',
  cancelled: 'info',
  arrived: 'success',
  anomaly: 'danger'
}

function heldOf(lot: AuctionLot): number {
  return lotHeldAmount(lot, auction.bids)
}

function isTerminal(lot: AuctionLot): boolean {
  return TERMINAL_STATUSES.includes(lot.status) || lot.status === 'won'
}

function refLabel(lot: AuctionLot): string {
  if (lot.refId == null) return '—'
  if (lot.category === 'cover') {
    const c = coverStore.byId(lot.refId)
    return c ? c.coverNo : `封 #${lot.refId}`
  }
  return `邮戳 #${lot.refId}`
}

function openRef(lot: AuctionLot): void {
  if (lot.refId == null) return
  if (lot.category === 'cover') void router.push(`/covers/${lot.refId}`)
}

function categoryLabel(c: LotCategory): string {
  return c === 'cover' ? '实寄封' : '邮戳'
}
</script>

<template>
  <div class="gb-page auction-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">拍卖征集账</h1>
        <p class="gb-page__subtitle">
          征集清单、报价与到货同一套账：每件只占用一套意向额；预算不足或被别人先报保留草稿并注明差额。
        </p>
      </div>
      <div class="auction-page__actions">
        <el-button @click="router.push('/auction/offline')">断网会场登记</el-button>
        <el-button type="primary" @click="openCreateLot">登记征集</el-button>
      </div>
    </header>

    <section class="gb-panel auction-budget">
      <div class="auction-budget__main">
        <span class="auction-budget__label">总预算</span>
        <strong class="auction-budget__num">{{ auction.budget.toLocaleString() }}</strong>
        <span class="auction-budget__unit">元</span>
        <el-button v-if="!budgetEditing" link type="primary" size="small" @click="editBudget">
          调整
        </el-button>
        <template v-else>
          <el-input-number v-model="budgetDraft" :min="0" :precision="0" size="small" />
          <el-button type="primary" size="small" @click="saveBudget">保存</el-button>
          <el-button size="small" @click="budgetEditing = false">取消</el-button>
        </template>
      </div>
      <el-progress
        :percentage="budgetPct"
        :status="auction.summary.overrun ? 'exception' : budgetPct >= 90 ? 'warning' : ''"
        style="max-width: 520px"
      />
      <div class="auction-budget__nums">
        <span>已占用 <strong :class="{ 'is-over': auction.summary.overrun }">{{
            auction.summary.held.toLocaleString()
          }}</strong> 元</span>
        <span>可用 <strong>{{ Math.max(0, auction.summary.available).toLocaleString() }}</strong> 元</span>
        <span>到货结清 <strong>{{ auction.summary.settled.toLocaleString() }}</strong> 元</span>
        <el-tag v-if="auction.pendingCount" type="warning" effect="plain" class="auction-budget__tag">
          断网待合并 {{ auction.pendingCount }} 条
        </el-tag>
        <el-tag v-if="auction.draftCount" type="danger" effect="plain" class="auction-budget__tag">
          草稿 {{ auction.draftCount }} 条
        </el-tag>
      </div>
    </section>

    <p v-if="!auction.lots.length" class="gb-empty">
      征集清单还是空的，先「登记征集」，或到「断网会场登记」体验现场记账。
    </p>

    <el-table v-else :data="auction.lots" border stripe row-key="lotNo">
      <el-table-column prop="lotNo" label="拍品号" width="92" fixed />
      <el-table-column label="拍品" min-width="240" fixed>
        <template #default="{ row }">
          <div class="lot-title">
            <el-tag size="small" effect="plain">{{ categoryLabel(row.category) }}</el-tag>
            <strong>{{ row.title }}</strong>
            <el-button v-if="row.refId != null" link type="primary" size="small" @click="openRef(row)">
              {{ refLabel(row) }}
            </el-button>
          </div>
          <div class="lot-source">{{ row.source || '来源待补' }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100" align="center">
        <template #default="{ row }">
          <el-tag :type="STATUS_TAG_TYPE[row.status as LotStatus]" size="small">
            {{ LOT_STATUS_LABELS[row.status as LotStatus] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="意向价" width="100" align="right">
        <template #default="{ row }">{{ row.ceiling.toLocaleString() }}</template>
      </el-table-column>
      <el-table-column label="己方最高" width="100" align="right">
        <template #default="{ row }">
          <span :class="{ 'is-high': row.ownHigh > 0 }">{{ row.ownHigh.toLocaleString() }}</span>
        </template>
      </el-table-column>
      <el-table-column label="他人最高" width="100" align="right">
        <template #default="{ row }">
          <span :class="{ 'is-out': row.competitorHigh >= row.ownHigh && row.competitorHigh > 0 }">
            {{ row.competitorHigh.toLocaleString() }}
          </span>
        </template>
      </el-table-column>
      <el-table-column label="当前占用" width="110" align="right">
        <template #default="{ row }">
          <strong class="held-num">{{ heldOf(row).toLocaleString() }}</strong>
        </template>
      </el-table-column>
      <el-table-column label="落槌 / 到货" min-width="150">
        <template #default="{ row }">
          <template v-if="row.hammerAt">
            <div>{{ row.hammerPrice.toLocaleString() }} 元 · {{ row.winner }}</div>
            <div class="lot-source">{{ row.hammerAt }}</div>
          </template>
          <span v-else class="lot-source">未落槌</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="250" fixed="right">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEditLot(row)">征集</el-button>
          <template v-if="!isTerminal(row)">
            <el-button size="small" link type="primary" @click="openBid(row, true)">己方报价</el-button>
            <el-button size="small" link type="warning" @click="openBid(row, false)">他人报价</el-button>
            <el-button size="small" link type="info" @click="cancelBidding(row)">取消竞价</el-button>
            <el-button size="small" link type="success" @click="openHammer(row)">落槌</el-button>
          </template>
          <el-button v-if="row.status === 'won'" size="small" link type="success" @click="openArrive(row)">
            到货登记
          </el-button>
          <el-tag v-if="isTerminal(row)" size="small" type="info" effect="plain">终局锁定</el-tag>
        </template>
      </el-table-column>
    </el-table>

    <!-- 征集表单 -->
    <el-dialog v-model="lotDialog" :title="lotForm.id ? '编辑征集' : '登记征集'" width="640px">
      <el-form label-width="96px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="拍品号">
              <el-input v-model="lotForm.lotNo" placeholder="如 AL-0004" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="类别">
              <el-radio-group v-model="lotForm.category" @change="onCategoryChange">
                <el-radio-button value="cover">实寄封</el-radio-button>
                <el-radio-button value="postmark">邮戳</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="名称">
              <el-input v-model="lotForm.title" placeholder="如 1910 年上海圆形日戳挂号实寄封" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="拍卖会">
              <el-input v-model="lotForm.source" placeholder="如 上海诚轩 2026 春拍" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="意向价(元)">
              <el-input-number v-model="lotForm.ceiling" :min="0" :precision="0" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="关联藏品">
              <el-select
                :model-value="lotForm.refId != null ? `${lotForm.category}-${lotForm.refId}` : ''"
                placeholder="可不关联（拍品尚未入藏）"
                clearable
                style="width: 100%"
                @update:model-value="(v: string) => (lotForm.refId = v ? Number(v.split('-')[1]) : null)"
              >
                <el-option
                  v-for="opt in refOptions.filter((o) => o.value.startsWith(lotForm.category))"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="备注">
              <el-input v-model="lotForm.note" type="textarea" :rows="2" />
            </el-form-item>
          </el-col>
        </el-row>
      </el-form>
      <template #footer>
        <el-button @click="lotDialog = false">取消</el-button>
        <el-button type="primary" @click="submitLot">保存到征集账</el-button>
      </template>
    </el-dialog>

    <!-- 报价表单 -->
    <el-dialog v-model="bidDialog" :title="bidForm.isOwn ? '登记己方报价（占用意向额）' : '登记他人报价（情报）'" width="480px">
      <el-form label-width="96px">
        <el-form-item label="拍品">
          <el-input :model-value="bidForm.lotNo" disabled />
        </el-form-item>
        <el-form-item label="会场">
          <el-input v-model="bidForm.venue" placeholder="如 上海诚轩" />
        </el-form-item>
        <el-form-item label="报价(元)">
          <el-input-number v-model="bidForm.amount" :min="1" :precision="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="bidForm.bidAt" placeholder="YYYY-MM-DD HH:mm" />
        </el-form-item>
        <p class="auction-hint">
          己方报价须高于他人最高报价；每件只占用最高一套意向额，新高自动替代旧报价的占用。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="bidDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBid">确认报价</el-button>
      </template>
    </el-dialog>

    <!-- 落槌表单 -->
    <el-dialog v-model="hammerDialog" title="落槌结果（终局锁定，断网旧记录不能覆盖）" width="480px">
      <el-form label-width="96px">
        <el-form-item label="拍品">
          <el-input :model-value="hammerForm.lotNo" disabled />
        </el-form-item>
        <el-form-item label="结果">
          <el-radio-group v-model="hammerForm.result">
            <el-radio v-for="(label, key) in HAMMER_RESULT_LABELS" :key="key" :value="key as HammerResult">
              {{ label }}
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="hammerForm.result === 'won'" label="落槌价(元)">
          <el-input-number v-model="hammerForm.price" :min="1" :precision="0" style="width: 100%" />
        </el-form-item>
        <el-form-item v-if="hammerForm.result === 'lost'" label="竞得方">
          <el-input v-model="hammerForm.winner" placeholder="如 电话委托 18 号" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="hammerForm.hammerAt" placeholder="YYYY-MM-DD HH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hammerDialog = false">取消</el-button>
        <el-button type="success" @click="submitHammer">确认落槌并重算占用</el-button>
      </template>
    </el-dialog>

    <!-- 到货表单 -->
    <el-dialog v-model="arriveDialog" title="到货登记" width="520px">
      <el-form label-width="96px">
        <el-form-item label="拍品">
          <el-input :model-value="arriveForm.lotNo" disabled />
        </el-form-item>
        <el-form-item label="验收结果">
          <el-radio-group v-model="arriveForm.normal">
            <el-radio :value="true">正常到货（结清占用）</el-radio>
            <el-radio :value="false">到货异常（释放占用）</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!arriveForm.normal" label="异常类型">
          <el-select v-model="arriveForm.issue" placeholder="请选择" style="width: 100%">
            <el-option
              v-for="(label, key) in ARRIVAL_ISSUE_LABELS"
              :key="key"
              :label="label"
              :value="key as ArrivalIssue"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="实收数量">
          <el-input-number v-model="arriveForm.receivedQty" :min="0" :precision="0" />
        </el-form-item>
        <el-form-item label="登记时间">
          <el-input v-model="arriveForm.arrivedAt" placeholder="YYYY-MM-DD HH:mm" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="arriveForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="arriveDialog = false">取消</el-button>
        <el-button type="primary" @click="submitArrive">登记并重算占用</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.auction-page__actions {
  display: flex;
  gap: 10px;
}
.auction-budget {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
}
.auction-budget__main {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.auction-budget__label {
  color: var(--gb-muted);
  font-size: 13px;
}
.auction-budget__num {
  font-size: 26px;
  color: var(--gb-brown);
  font-family: Georgia, 'Songti SC', serif;
}
.auction-budget__unit {
  color: var(--gb-muted);
  font-size: 12px;
}
.auction-budget__nums {
  display: flex;
  align-items: center;
  gap: 16px;
  font-size: 13px;
  color: var(--gb-muted);
}
.auction-budget__nums strong {
  color: var(--gb-ink);
}
.auction-budget__nums .is-over {
  color: #c45656;
}
.auction-budget__tag {
  margin-left: 4px;
}
.lot-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.lot-source {
  font-size: 12px;
  color: var(--gb-muted);
  margin-top: 2px;
}
.is-high {
  font-weight: 700;
  color: #3a7a4d;
}
.is-out {
  color: #c45656;
  font-weight: 700;
}
.held-num {
  color: var(--gb-brown);
}
.auction-hint {
  margin: 0;
  font-size: 12px;
  color: var(--gb-muted);
}
</style>
