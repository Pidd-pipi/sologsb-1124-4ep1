<script setup lang="ts">
/** 单个会场的预算占用条：在拍占用 / 竞得待付 / 到货已结 / 剩余，各会场独立。 */
import { computed } from 'vue'
import type { VenueStats } from '@/utils/auctionService'

const props = defineProps<{ stats: VenueStats }>()

function pct(part: number): number {
  const total = props.stats.budget
  if (!total) return 0
  return Math.min(100, Math.round((part / total) * 1000) / 10)
}

const heldPct = computed(() => pct(props.stats.held))
const payablePct = computed(() => pct(props.stats.payable))
const overBudget = computed(() => props.stats.available < 0)
</script>

<template>
  <div class="budget-bar">
    <div class="budget-bar__track">
      <div class="seg seg--held" :style="{ width: heldPct + '%' }" title="在拍意向占用" />
      <div class="seg seg--payable" :style="{ width: payablePct + '%' }" title="竞得待付" />
    </div>
    <div class="budget-bar__legend">
      <span><i class="dot dot--held" />在拍占用 ¥{{ stats.held }}</span>
      <span><i class="dot dot--payable" />竞得待付 ¥{{ stats.payable }}</span>
      <span><i class="dot dot--free" />剩余 ¥{{ stats.available }}</span>
      <span class="muted">预算 ¥{{ stats.budget }} · 到货已结 ¥{{ stats.settled }}</span>
      <el-tag v-if="overBudget" type="danger" size="small" effect="dark">超预算</el-tag>
    </div>
  </div>
</template>

<style scoped>
.budget-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.budget-bar__track {
  display: flex;
  height: 10px;
  border-radius: 6px;
  overflow: hidden;
  background: #f0e7d8;
  border: 1px solid var(--gb-line);
}
.seg {
  height: 100%;
  transition: width 0.25s ease;
}
.seg--held {
  background: linear-gradient(90deg, #c98a3b, #d9a256);
}
.seg--payable {
  background: linear-gradient(90deg, #b0563f, #c9704f);
}
.budget-bar__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--gb-ink);
  align-items: center;
}
.budget-bar__legend .muted {
  color: var(--gb-muted);
}
.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 4px;
}
.dot--held {
  background: #c98a3b;
}
.dot--payable {
  background: #b0563f;
}
.dot--free {
  background: #9aa87a;
}
</style>
