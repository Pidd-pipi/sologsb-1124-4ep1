<script setup lang="ts">
/** 回馆同步面板：列出断网 outbox，支持一键合并、单条重试、放弃。 */
import { computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAuctionStore } from '@/stores/auctionStore'
import { OP_STATUS_LABEL, OP_TYPE_LABEL } from '@/types/auction'

const emit = defineEmits<{ (e: 'merged'): void }>()

const store = useAuctionStore()

const ordered = computed(() =>
  [...store.ops].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1))
)

const tagType: Record<string, 'info' | 'warning' | 'success' | 'danger' | 'primary'> = {
  queued: 'warning',
  applied: 'success',
  conflict: 'danger',
  retry: 'danger',
  dead: 'info'
}

function lotLabel(lotId: number): string {
  return store.lotById(lotId)?.lotNo ?? `#${lotId}`
}

function venueLabel(venueId: number): string {
  return store.venueById(venueId)?.name ?? `会场#${venueId}`
}

async function mergeAll(): Promise<void> {
  const summary = await store.merge()
  if (summary.failed) {
    ElMessage.error(
      `合并在「${summary.failed.opId}」处写库失败，台账已回到操作前；排除故障后可重试。`
    )
  } else if (summary.conflicts.length) {
    ElMessage.warning(
      `合并完成：生效 ${summary.applied} 条，${summary.conflicts.length} 条因终局冲突保留原记录。`
    )
  } else if (summary.total === 0) {
    ElMessage.info('没有待合并的断网记录。')
  } else {
    ElMessage.success(`已按现场操作顺序合并 ${summary.applied} 条断网记录。`)
  }
  emit('merged')
}

async function retryOne(opId: string): Promise<void> {
  await store.retryOp(opId)
  const op = store.ops.find((o) => o.opId === opId)
  if (op?.opStatus === 'applied') ElMessage.success('重试成功，该条已合并。')
  else if (op?.opStatus === 'conflict') ElMessage.warning('重试后判定为冲突，已保留原记录。')
  else ElMessage.error('重试仍写库失败，台账仍处于操作前状态。')
  emit('merged')
}

async function discardOne(opId: string): Promise<void> {
  await ElMessageBox.confirm('放弃后该条断网操作将不会并入台账，确定吗？', '放弃操作', {
    type: 'warning'
  })
  await store.discardOp(opId)
  ElMessage.info('该条已标记为人工放弃。')
}
</script>

<template>
  <section class="gb-panel sync-panel">
    <header class="sync-panel__head">
      <h3 class="gb-panel__title">
        断网记录（outbox）
        <el-tag size="small" type="warning" effect="plain" round>{{ store.pendingCount }} 待合并</el-tag>
        <el-tag v-if="store.retryCount" size="small" type="danger" effect="dark" round>
          {{ store.retryCount }} 待重试
        </el-tag>
      </h3>
      <el-button type="primary" :disabled="store.pendingCount + store.retryCount === 0" @click="mergeAll">
        回馆一键合并
      </el-button>
    </header>

    <el-table v-if="ordered.length" :data="ordered" size="small" stripe>
      <el-table-column label="时间" width="180">
        <template #default="{ row }">{{ new Date(row.occurredAt).toLocaleString('zh-CN') }}</template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">{{ OP_TYPE_LABEL[row.type as keyof typeof OP_TYPE_LABEL] }}</template>
      </el-table-column>
      <el-table-column label="会场 / 标的" min-width="220">
        <template #default="{ row }">
          <div>{{ venueLabel(row.venueId) }}</div>
          <small class="muted">{{ lotLabel(row.lotId) }}</small>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="tagType[row.opStatus as string]" size="small">
            {{ OP_STATUS_LABEL[row.opStatus as keyof typeof OP_STATUS_LABEL] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="说明" min-width="240" prop="message" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'muted': !row.message }">{{ row.message || '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150" align="right">
        <template #default="{ row }">
          <el-button
            v-if="row.opStatus === 'retry'"
            link
            type="primary"
            size="small"
            @click="retryOne(row.opId)"
          >
            重试
          </el-button>
          <el-button
            v-if="row.opStatus === 'queued' || row.opStatus === 'retry'"
            link
            type="danger"
            size="small"
            @click="discardOne(row.opId)"
          >
            放弃
          </el-button>
        </template>
      </el-table-column>
    </el-table>
    <div v-else class="gb-empty">暂无断网记录。现场把平板切成"断网"后登记的操作会排队到这里。</div>
  </section>
</template>

<style scoped>
.sync-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}
.sync-panel__head .gb-panel__title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.muted {
  color: var(--gb-muted);
}
</style>
