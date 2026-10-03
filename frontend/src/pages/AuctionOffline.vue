<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuctionStore } from '@/stores/auctionStore'
import type {
  ArrivalIssue,
  AuctionCommand,
  AuctionLot,
  HammerResult,
  LotCategory,
  LotStatus
} from '@/types/auction'
import {
  ARRIVAL_ISSUE_LABELS,
  COMMAND_TYPE_LABELS,
  HAMMER_RESULT_LABELS,
  LOT_STATUS_LABELS,
  TERMINAL_STATUSES,
  createEmptyLot,
  nowMinute
} from '@/types/auction'
import { lotHeldAmount, summarizeBudget } from '@/utils/auctionEngine'
import { toNumber } from '@/utils/id'
import type { MergeReport } from '@/utils/auctionEngine'

const router = useRouter()
const auction = useAuctionStore()

onMounted(async () => {
  if (!auction.loaded) await auction.load()
  if (auction.venues.length && !venue.value) venue.value = auction.venues[0]
})

/* ------------------------------ 会场 ------------------------------ */

const venue = ref('')
const venueInput = ref('')

function enterVenue(): void {
  const v = venueInput.value.trim()
  if (!v) {
    ElMessage.warning('请填写会场名，如 上海诚轩')
    return
  }
  venue.value = v
}

/** 断网会场视图：跨会场共享征集清单，账本操作只回放本会场 pending */
const lane = computed(() => (venue.value ? auction.laneSnapshot(venue.value) : auction.snapshot()))
const laneSummary = computed(() => summarizeBudget(lane.value))
/** 本会场视角的可用额：总预算 − 本会场占用（其他会场各算一套，回馆合并时统一去重） */
const laneAvailable = computed(() => Math.max(0, lane.value.budget - laneSummary.value.held))

function laneHeld(lot: AuctionLot): number {
  return lotHeldAmount(lot, lane.value.bids)
}

const laneJournal = computed(() => (venue.value ? auction.journalOfVenue(venue.value) : []))

/* ------------------------------ 通用提交 ------------------------------ */

async function offlineSubmit(command: AuctionCommand): Promise<boolean> {
  const res = await auction.registerOffline(venue.value, command)
  if (res.ok) {
    ElMessage.success(res.message)
    return true
  }
  if (res.outcome?.code === 'budget_short' || res.outcome?.code === 'below_competitor') {
    ElMessage.warning(`${res.message} —— 已保留草稿，可在下方改价重试`)
  } else {
    ElMessage.error(res.message)
  }
  return false
}

/* ------------------------------ 征集 ------------------------------ */

const lotDialog = ref(false)
const lotForm = reactive(createEmptyLot())

function openCreateLot(): void {
  Object.assign(lotForm, createEmptyLot())
  lotForm.lotNo = auction.nextLotNo()
  lotForm.source = venue.value
  lotDialog.value = true
}

async function submitLot(): Promise<void> {
  if (!lotForm.lotNo.trim() || !lotForm.title.trim()) {
    ElMessage.warning('拍品号与名称必填')
    return
  }
  const ok = await offlineSubmit({
    type: 'upsertLot',
    lotNo: lotForm.lotNo.trim(),
    title: lotForm.title.trim(),
    category: lotForm.category as LotCategory,
    refId: lotForm.refId,
    source: lotForm.source.trim() || venue.value,
    ceiling: Math.round(toNumber(lotForm.ceiling)),
    note: lotForm.note
  })
  if (ok) lotDialog.value = false
}

/* ------------------------------ 报价 ------------------------------ */

const bidDialog = ref(false)
const bidForm = reactive({ lotNo: '', amount: 0, isOwn: true, bidAt: nowMinute() })

function openBid(lot: AuctionLot, isOwn: boolean): void {
  bidForm.lotNo = lot.lotNo
  bidForm.amount = (isOwn ? lot.ownHigh : lot.competitorHigh) + 100 || lot.ceiling
  bidForm.isOwn = isOwn
  bidForm.bidAt = nowMinute()
  bidDialog.value = true
}

async function submitBid(): Promise<void> {
  const amount = Math.round(toNumber(bidForm.amount))
  if (amount <= 0) {
    ElMessage.warning('报价必须大于 0')
    return
  }
  const ok = await offlineSubmit({
    type: 'registerBid',
    lotNo: bidForm.lotNo,
    amount,
    isOwn: bidForm.isOwn,
    venue: venue.value,
    bidAt: bidForm.bidAt
  })
  if (ok) bidDialog.value = false
}

/* ------------------------------ 取消竞价 ------------------------------ */

async function cancelBidding(lot: AuctionLot): Promise<void> {
  let reason = '现场撤拍'
  try {
    const r = await ElMessageBox.prompt('取消 / 撤拍原因', '竞价取消', {
      confirmButtonText: '确认取消',
      cancelButtonText: '再想想',
      inputValue: reason,
      inputValidator: (v: string) => !!v.trim() || '原因不能为空'
    })
    reason = r.value
  } catch {
    return
  }
  await offlineSubmit({
    type: 'cancelBidding',
    lotNo: lot.lotNo,
    venue: venue.value,
    bidKey: '',
    reason
  })
}

/* ------------------------------ 落槌 ------------------------------ */

const hammerDialog = ref(false)
const hammerForm = reactive<{ lotNo: string; result: HammerResult; price: number; winner: string; hammerAt: string }>(
  { lotNo: '', result: 'won', price: 0, winner: '', hammerAt: nowMinute() }
)

function openHammer(lot: AuctionLot): void {
  hammerForm.lotNo = lot.lotNo
  hammerForm.result = 'won'
  hammerForm.price = lot.ownHigh || lot.competitorHigh
  hammerForm.winner = ''
  hammerForm.hammerAt = nowMinute()
  hammerDialog.value = true
}

async function submitHammer(): Promise<void> {
  const ok = await offlineSubmit({
    type: 'hammer',
    lotNo: hammerForm.lotNo,
    result: hammerForm.result,
    price: Math.round(toNumber(hammerForm.price)),
    winner: hammerForm.winner.trim(),
    hammerAt: hammerForm.hammerAt
  })
  if (ok) hammerDialog.value = false
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
}>({ lotNo: '', normal: true, issue: '', receivedQty: 1, note: '', arrivedAt: nowMinute() })

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
  const ok = await offlineSubmit({
    type: 'arrive',
    lotNo: arriveForm.lotNo,
    normal: arriveForm.normal,
    issue: arriveForm.normal ? '' : arriveForm.issue,
    receivedQty: Math.max(0, Math.trunc(toNumber(arriveForm.receivedQty))),
    note: arriveForm.note,
    arrivedAt: arriveForm.arrivedAt
  })
  if (ok) arriveDialog.value = false
}

/* ------------------------------ 回馆合并 ------------------------------ */

const failWrite = ref(false)
const lastReport = ref<(MergeReport & { rolledBack?: boolean; rollbackError?: string }) | null>(null)

async function mergeAll(): Promise<void> {
  if (!auction.pendingCount) {
    ElMessage.info('各会场都没有待合并的断网记录')
    return
  }
  const report = await auction.mergeAll({ failWrite: failWrite.value })
  failWrite.value = false
  lastReport.value = report
  if (report.rolledBack) {
    ElMessage.error(`写库失败已整笔回滚，${auction.pendingCount} 条待合并记录原样保留，可重试`)
  } else {
    ElMessage.success(
      `合并完成：应用 ${report.applied} 条、草稿 ${report.drafts} 条、冲突 ${report.conflicts} 条`
    )
  }
}

const drafts = computed(() => auction.journal.filter((j) => j.status === 'draft'))
const conflicts = computed(() => auction.journal.filter((j) => j.status === 'conflict'))
const appliedLog = computed(() =>
  auction.journal
    .filter((j) => j.status === 'applied')
    .slice()
    .reverse()
    .slice(0, 20)
)

const draftAmounts = ref<Record<number, number>>({})

function draftAmount(id: number | undefined, fallback: number): number {
  if (id == null) return fallback
  return draftAmounts.value[id] ?? fallback
}

function setDraftAmount(id: number | undefined, v: number): void {
  if (id == null) return
  draftAmounts.value[id] = v
}

async function retryDraft(id: number | undefined): Promise<void> {
  if (id == null) return
  const entry = auction.journal.find((j) => j.id === id)
  if (!entry || entry.command.type !== 'registerBid') return
  const amount = Math.round(draftAmount(id, entry.command.amount))
  const res = await auction.retryDraft(id, { ...entry.command, amount })
  if (res.ok) ElMessage.success(res.message)
  else ElMessage.error(res.message)
}

async function discardDraft(id: number | undefined): Promise<void> {
  if (id == null) return
  await auction.discardDraft(id)
  ElMessage.info('草稿已放弃')
}

async function retryConflict(id: number | undefined): Promise<void> {
  if (id == null) return
  const res = await auction.retryOne(id)
  if (res.ok) ElMessage.success(res.message)
  else ElMessage.warning(res.message)
}

async function clearApplied(): Promise<void> {
  const ids = appliedLog.value.map((j) => j.id).filter((v): v is number => typeof v === 'number')
  if (!ids.length) return
  await auction.removeJournal(ids)
  ElMessage.success('已清理合并留档')
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

function isTerminal(lot: AuctionLot): boolean {
  return TERMINAL_STATUSES.includes(lot.status) || lot.status === 'won'
}

function categoryLabel(c: LotCategory): string {
  return c === 'cover' ? '实寄封' : '邮戳'
}

function commandSummary(cmd: AuctionCommand): string {
  switch (cmd.type) {
    case 'setBudget':
      return `总预算 → ${cmd.amount} 元`
    case 'upsertLot':
      return `${cmd.lotNo} ${cmd.title}（意向 ${cmd.ceiling}）`
    case 'registerBid':
      return `${cmd.lotNo} ${cmd.isOwn ? '己方' : '他人'}报价 ${cmd.amount} 元`
    case 'cancelBidding':
      return `${cmd.lotNo} 竞价取消（${cmd.reason}）`
    case 'hammer':
      return `${cmd.lotNo} 落槌：${HAMMER_RESULT_LABELS[cmd.result]} ${cmd.price} 元`
    case 'arrive':
      return `${cmd.lotNo} ${cmd.normal ? '正常到货' : `到货异常：${ARRIVAL_ISSUE_LABELS[cmd.issue as ArrivalIssue] ?? ''}`}`
  }
}

const reportStatusTag = {
  applied: 'success',
  draft: 'danger',
  conflict: 'info'
} as const
</script>

<template>
  <div class="gb-page offline-page">
    <header class="gb-page__head">
      <div>
        <h1 class="gb-page__title">断网会场登记</h1>
        <p class="gb-page__subtitle">
          平板现场断网也能为邮戳、实寄封登记意向价：所有操作先入本地操作账，回馆后合并到同一套账。
        </p>
      </div>
      <div class="offline-page__actions">
        <el-button @click="router.push('/auction')">返回回馆主账</el-button>
      </div>
    </header>

    <!-- 会场选择 -->
    <section class="gb-panel offline-venue">
      <el-tag type="warning" effect="dark" size="large">● 断网模式</el-tag>
      <template v-if="!venue">
        <el-input
          v-model="venueInput"
          placeholder="输入会场名，如 上海诚轩 / 北京嘉德"
          style="width: 280px"
          @keyup.enter="enterVenue"
        />
        <el-button type="primary" @click="enterVenue">进入会场</el-button>
        <el-select v-if="auction.venues.length" v-model="venue" placeholder="或选择已知会场" style="width: 240px">
          <el-option v-for="v in auction.venues" :key="v" :label="v" :value="v" />
        </el-select>
      </template>
      <template v-else>
        <span class="offline-venue__name">当前会场：<strong>{{ venue }}</strong></span>
        <el-select v-model="venue" placeholder="切换会场" style="width: 220px">
          <el-option v-for="v in auction.venues" :key="v" :label="v" :value="v" />
        </el-select>
        <el-button @click="venue = ''">更换 / 新增会场</el-button>
      </template>
    </section>

    <template v-if="venue">
      <!-- 会场预算 -->
      <section class="gb-panel offline-budget">
        <div>
          <span class="offline-budget__label">总预算</span>
          <strong>{{ laneSummary.budget.toLocaleString() }}</strong> 元
        </div>
        <div>
          <span class="offline-budget__label">本会场占用</span>
          <strong :class="{ 'is-over': laneSummary.overrun }">{{ laneSummary.held.toLocaleString() }}</strong> 元
        </div>
        <div>
          <span class="offline-budget__label">本会场可用</span>
          <strong>{{ laneAvailable.toLocaleString() }}</strong> 元
        </div>
        <div class="offline-budget__tip">
          多会场重复登记同一件，预算占用与最高报价各算一套；回馆合并时只保留最高一套占用。
        </div>
      </section>

      <!-- 会场拍品 -->
      <section class="gb-panel">
        <div class="offline-section__head">
          <h2 class="gb-panel__title">{{ venue }} · 征集与报价（含本会场待合并记录的预览）</h2>
          <el-button type="primary" size="small" @click="openCreateLot">现场登记征集</el-button>
        </div>
        <el-table :data="lane.lots" border stripe size="small">
          <el-table-column prop="lotNo" label="拍品号" width="90" />
          <el-table-column label="拍品" min-width="220">
            <template #default="{ row }">
              <div>
                <el-tag size="small" effect="plain" class="offline-cat">
                  {{ categoryLabel(row.category as LotCategory) }}
                </el-tag>
                <strong>{{ row.title }}</strong>
              </div>
              <div class="offline-muted">{{ row.source }}</div>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="STATUS_TAG_TYPE[row.status as LotStatus]" size="small">
                {{ LOT_STATUS_LABELS[row.status as LotStatus] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="ceiling" label="意向价" width="90" align="right" />
          <el-table-column prop="ownHigh" label="己方最高" width="90" align="right" />
          <el-table-column prop="competitorHigh" label="他人最高" width="90" align="right" />
          <el-table-column label="会场占用" width="100" align="right">
            <template #default="{ row }">
              <strong class="held-num">{{ laneHeld(row).toLocaleString() }}</strong>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="230">
            <template #default="{ row }">
              <template v-if="!isTerminal(row)">
                <el-button size="small" link type="primary" @click="openBid(row, true)">己方报价</el-button>
                <el-button size="small" link type="warning" @click="openBid(row, false)">他人先报</el-button>
                <el-button size="small" link type="info" @click="cancelBidding(row)">取消</el-button>
                <el-button size="small" link type="success" @click="openHammer(row)">落槌</el-button>
              </template>
              <el-button v-if="row.status === 'won'" size="small" link type="success" @click="openArrive(row)">
                到货
              </el-button>
              <el-tag v-if="isTerminal(row)" size="small" type="info" effect="plain">终局</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <!-- 本会场操作账 -->
      <section class="gb-panel">
        <h2 class="gb-panel__title">本会场操作账（断网待回馆合并，共 {{ laneJournal.length }} 条）</h2>
        <el-table :data="laneJournal" border stripe size="small">
          <el-table-column label="时间" width="180">
            <template #default="{ row }">{{ new Date(row.occurredAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column label="操作" width="110">
            <template #default="{ row }">{{ COMMAND_TYPE_LABELS[row.command.type as keyof typeof COMMAND_TYPE_LABELS] }}</template>
          </el-table-column>
          <el-table-column label="内容" min-width="260">
            <template #default="{ row }">{{ commandSummary(row.command) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'draft' ? 'danger' : 'warning'" size="small">
                {{ row.status === 'draft' ? '草稿' : '待合并' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column v-if="drafts.length" label="说明" min-width="200">
            <template #default="{ row }">
              <span v-if="row.resultNote" class="offline-reason">{{ row.resultNote }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </template>

    <!-- 回馆合并 -->
    <section class="gb-panel offline-merge">
      <div class="offline-section__head">
        <h2 class="gb-panel__title">
          回馆合并
          <el-tag v-if="auction.pendingCount" type="warning" effect="plain" class="offline-merge__tag">
            待合并 {{ auction.pendingCount }}
          </el-tag>
          <el-tag v-if="drafts.length" type="danger" effect="plain" class="offline-merge__tag">
            草稿 {{ drafts.length }}
          </el-tag>
          <el-tag v-if="conflicts.length" type="info" effect="plain" class="offline-merge__tag">
            冲突 {{ conflicts.length }}
          </el-tag>
        </h2>
        <div class="offline-merge__actions">
          <el-tooltip content="勾选后本次合并会在写库时抛错：整笔回滚到操作前，pending 原样保留可重试" placement="top">
            <el-switch v-model="failWrite" inline-prompt active-text="模拟写库失败" />
          </el-tooltip>
          <el-button type="success" :loading="auction.merging" :disabled="!auction.pendingCount" @click="mergeAll">
            合并全部断网记录并重算占用
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="lastReport?.rolledBack"
        type="error"
        :closable="false"
        show-icon
        class="offline-merge__alert"
        :title="`写库失败，已回到操作前：${lastReport.rollbackError || '模拟故障'}；${auction.pendingCount} 条待合并记录未丢失，请重试。`"
      />
      <el-alert
        v-if="lastReport && !lastReport.rolledBack && lastReport.warning"
        type="warning"
        :closable="false"
        show-icon
        class="offline-merge__alert"
        :title="lastReport.warning"
      />

      <el-table v-if="lastReport" :data="lastReport.results" border stripe size="small" class="offline-merge__table">
        <el-table-column label="结果" width="90">
          <template #default="{ row }">
            <el-tag :type="reportStatusTag[row.status as keyof typeof reportStatusTag]" size="small">
              {{ row.status === 'applied' ? '已应用' : row.status === 'draft' ? '草稿' : '冲突' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110">
          <template #default="{ row }">{{ COMMAND_TYPE_LABELS[row.command.type as keyof typeof COMMAND_TYPE_LABELS] }}</template>
        </el-table-column>
        <el-table-column label="说明（含差额）" min-width="300">
          <template #default="{ row }">
            <span :class="{ 'offline-reason': row.status !== 'applied' }">{{ row.message }}</span>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 草稿 -->
    <section v-if="drafts.length" class="gb-panel">
      <h2 class="gb-panel__title">保留的草稿（不占预算，改价后可重试）</h2>
      <el-table :data="drafts" border stripe size="small">
        <el-table-column label="会场" width="120" prop="venue" />
        <el-table-column label="内容" min-width="200">
          <template #default="{ row }">{{ commandSummary(row.command) }}</template>
        </el-table-column>
        <el-table-column label="差额 / 原因" min-width="260">
          <template #default="{ row }"><span class="offline-reason">{{ row.resultNote }}</span></template>
        </el-table-column>
        <el-table-column label="改价(元)" width="170">
          <template #default="{ row }">
            <el-input-number
              v-if="row.command.type === 'registerBid'"
              :model-value="draftAmount(row.id, row.command.amount)"
              :min="1"
              :precision="0"
              size="small"
              @update:model-value="(v: number) => setDraftAmount(row.id, v)"
            />
            <span v-else class="offline-muted">不可改价</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button
              size="small"
              type="primary"
              link
              :disabled="row.command.type !== 'registerBid'"
              @click="retryDraft(row.id)"
            >
              重试占用
            </el-button>
            <el-button size="small" type="danger" link @click="discardDraft(row.id)">放弃</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 冲突 -->
    <section v-if="conflicts.length" class="gb-panel">
      <h2 class="gb-panel__title">合并冲突（终局锁定 / 过期操作，不会盖掉落槌结果）</h2>
      <el-table :data="conflicts" border stripe size="small">
        <el-table-column label="会场" width="120" prop="venue" />
        <el-table-column label="内容" min-width="220">
          <template #default="{ row }">{{ commandSummary(row.command) }}</template>
        </el-table-column>
        <el-table-column label="说明" min-width="260">
          <template #default="{ row }"><span class="offline-reason">{{ row.resultNote }}</span></template>
        </el-table-column>
        <el-table-column label="操作" width="150">
          <template #default="{ row }">
            <el-button size="small" type="primary" link @click="retryConflict(row.id)">再试一次</el-button>
            <el-button size="small" type="info" link @click="auction.removeJournal([row.id])">清除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 已合并留档 -->
    <section v-if="appliedLog.length" class="gb-panel">
      <div class="offline-section__head">
        <h2 class="gb-panel__title">最近合并留档（{{ appliedLog.length }}）</h2>
        <el-button size="small" @click="clearApplied">清理留档</el-button>
      </div>
      <el-table :data="appliedLog" border stripe size="small">
        <el-table-column label="会场" width="120" prop="venue" />
        <el-table-column label="内容" min-width="220">
          <template #default="{ row }">{{ commandSummary(row.command) }}</template>
        </el-table-column>
        <el-table-column label="合并结果" min-width="240">
          <template #default="{ row }"><span class="offline-muted">{{ row.resultNote }}</span></template>
        </el-table-column>
        <el-table-column label="尝试次数" width="90" align="center" prop="attempts" />
      </el-table>
    </section>

    <!-- 现场征集 -->
    <el-dialog v-model="lotDialog" title="现场登记征集（断网）" width="600px">
      <el-form label-width="92px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="拍品号">
              <el-input v-model="lotForm.lotNo" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="类别">
              <el-radio-group v-model="lotForm.category">
                <el-radio-button value="cover">实寄封</el-radio-button>
                <el-radio-button value="postmark">邮戳</el-radio-button>
              </el-radio-group>
            </el-form-item>
          </el-col>
          <el-col :span="24">
            <el-form-item label="名称">
              <el-input v-model="lotForm.title" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="拍卖会">
              <el-input v-model="lotForm.source" />
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="意向价(元)">
              <el-input-number v-model="lotForm.ceiling" :min="0" :precision="0" style="width: 100%" />
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
        <el-button type="primary" @click="submitLot">记入操作账</el-button>
      </template>
    </el-dialog>

    <!-- 报价 -->
    <el-dialog v-model="bidDialog" :title="bidForm.isOwn ? '现场己方报价（回馆后占用）' : '记录他人先报'" width="460px">
      <el-form label-width="92px">
        <el-form-item label="拍品">
          <el-input :model-value="bidForm.lotNo" disabled />
        </el-form-item>
        <el-form-item label="报价(元)">
          <el-input-number v-model="bidForm.amount" :min="1" :precision="0" style="width: 100%" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="bidForm.bidAt" />
        </el-form-item>
        <p class="offline-hint">
          预算不足或出价低于他人最高时，这条记录会以草稿保留并写明差额，回馆合并与改价重试都在同一套账上。
        </p>
      </el-form>
      <template #footer>
        <el-button @click="bidDialog = false">取消</el-button>
        <el-button type="primary" @click="submitBid">记入操作账</el-button>
      </template>
    </el-dialog>

    <!-- 落槌 -->
    <el-dialog v-model="hammerDialog" title="现场落槌（回馆后入账，终局锁定）" width="460px">
      <el-form label-width="92px">
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
          <el-input v-model="hammerForm.winner" />
        </el-form-item>
        <el-form-item label="时间">
          <el-input v-model="hammerForm.hammerAt" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="hammerDialog = false">取消</el-button>
        <el-button type="success" @click="submitHammer">记入操作账</el-button>
      </template>
    </el-dialog>

    <!-- 到货 -->
    <el-dialog v-model="arriveDialog" title="到货登记（断网补录）" width="500px">
      <el-form label-width="92px">
        <el-form-item label="拍品">
          <el-input :model-value="arriveForm.lotNo" disabled />
        </el-form-item>
        <el-form-item label="验收结果">
          <el-radio-group v-model="arriveForm.normal">
            <el-radio :value="true">正常到货</el-radio>
            <el-radio :value="false">到货异常</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="!arriveForm.normal" label="异常类型">
          <el-select v-model="arriveForm.issue" style="width: 100%">
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
        <el-form-item label="时间">
          <el-input v-model="arriveForm.arrivedAt" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="arriveForm.note" type="textarea" :rows="2" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="arriveDialog = false">取消</el-button>
        <el-button type="primary" @click="submitArrive">记入操作账</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.offline-page__actions {
  display: flex;
  gap: 10px;
}
.offline-venue {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.offline-venue__name {
  font-size: 15px;
}
.offline-venue__name strong {
  color: var(--gb-brown);
}
.offline-budget {
  display: flex;
  align-items: center;
  gap: 26px;
  flex-wrap: wrap;
  font-size: 14px;
}
.offline-budget strong {
  font-size: 20px;
  color: var(--gb-brown);
}
.offline-budget strong.is-over {
  color: #c45656;
}
.offline-budget__label {
  display: block;
  font-size: 12px;
  color: var(--gb-muted);
}
.offline-budget__tip {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--gb-muted);
}
.offline-section__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.offline-section__head .gb-panel__title {
  margin-bottom: 0;
}
.offline-cat {
  margin-right: 6px;
}
.offline-muted {
  font-size: 12px;
  color: var(--gb-muted);
}
.offline-reason {
  color: #c45656;
  font-size: 12px;
}
.held-num {
  color: var(--gb-brown);
}
.offline-merge__actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.offline-merge__tag {
  margin-left: 8px;
}
.offline-merge__alert {
  margin: 10px 0;
}
.offline-merge__table {
  margin-top: 10px;
}
.offline-hint {
  margin: 0;
  font-size: 12px;
  color: var(--gb-muted);
}
</style>
