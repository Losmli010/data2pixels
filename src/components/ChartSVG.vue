<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  axisTicks,
  downsample,
  pushSample,
  toSegments,
  windowSlots,
  type SysSample,
} from '../lib/stats';

const props = defineProps<{ gpuLoad: number | null; gpuLoadAt: number }>();

const MARGIN_L = 48;
const MARGIN_R = 48;
const MARGIN_T = 8;
const MARGIN_B = 20;
const PAD_Y = 8; // 曲线纵向内缩：峰值/谷值不贴上下边缘，避免刻度与小标签被遮挡
const H = 200;
const MAX_POINTS = 3600;
const WINDOW_MS = 3_600_000;
const X_TICK_COUNT = 7; // 固定近 1 小时轴，每 10 分钟一条刻度

const samples = ref<SysSample[]>([]);
const collapsed = ref(false);
const wrapRef = ref<HTMLDivElement | null>(null);
const plotW = ref(560);
let resizeObserver: ResizeObserver | null = null;

const hasData = computed(() => samples.value.length > 0);
const plotWarea = computed(() => Math.max(10, plotW.value - MARGIN_L - MARGIN_R));

const tMax = computed(() => samples.value.at(-1)?.ts ?? Date.now());
// X 轴按真实时间戳固定为最近 1 小时（右端=最新样本时间）：样本落在其真实
// 时间对应的像素位置，缺失的秒槽（数据未开始的区段与采样空洞）以 null
// 补齐、曲线断开，不外推不伪造
const tMin = computed(() => tMax.value - WINDOW_MS);

const view = computed(() =>
  downsample(windowSlots(samples.value, tMin.value, tMax.value), plotWarea.value),
);
const plotH = H - MARGIN_B - MARGIN_T;

// 内存轴：窗口内峰值向上取整到 32MB 倍数，下限 64
const memMaxMB = computed(() => {
  const peak = view.value.reduce((m, s) => Math.max(m, s?.memBytes ?? 0), 0) / 1024 / 1024;
  return Math.max(64, Math.ceil((peak + 16) / 32) * 32);
});

const segOpts = (min: number, max: number, value: (s: SysSample) => number | null) => ({
  width: plotWarea.value,
  height: plotH,
  min,
  max,
  tMin: tMin.value,
  tMax: tMax.value,
  padY: PAD_Y,
  value,
});
const memSegs = computed(() =>
  toSegments(
    view.value,
    segOpts(0, memMaxMB.value, (s) => s.memBytes / 1024 / 1024),
  ),
);
const cpuSegs = computed(() =>
  toSegments(
    view.value,
    segOpts(0, 100, (s) => s.cpu),
  ),
);
const gpuSegs = computed(() =>
  toSegments(
    view.value,
    segOpts(0, 100, (s) => s.gpu),
  ),
);

const tickY = (v: number, max: number) => Math.round(PAD_Y + (plotH - 2 * PAD_Y) * (1 - v / max));
const memTickPos = computed(() =>
  axisTicks(0, memMaxMB.value, 5).map((v) => ({ v: Math.round(v), y: tickY(v, memMaxMB.value) })),
);
const pctTickPos = computed(() =>
  axisTicks(0, 100, 5).map((v) => ({ v: Math.round(v), y: tickY(v, 100) })),
);

const xTicks = computed(() => {
  const out: { x: number; label: string }[] = [];
  for (let i = 0; i < X_TICK_COUNT; i++) {
    const mins = 60 - (60 / (X_TICK_COUNT - 1)) * i;
    out.push({
      x: Math.round((i / (X_TICK_COUNT - 1)) * plotWarea.value),
      label: mins === 0 ? '现在' : `-${mins}m`,
    });
  }
  return out;
});

const latest = computed(() => samples.value.at(-1));
const memMB = computed(() => (latest.value ? Math.round(latest.value.memBytes / 1024 / 1024) : 0));
const cpuPct = computed(() => (latest.value ? Math.min(100, Math.round(latest.value.cpu)) : 0));
const gpuPct = computed(() =>
  latest.value && latest.value.gpu !== null
    ? `${Math.min(100, Math.round(latest.value.gpu))}%`
    : '—',
);

// gpu-load 与 sys-stats 独立到达：沿用最近一次到达的估算值（App 传入到达时间戳
// gpuLoadAt，恒值也每次刷新，避免按"值变化"判定），超过 2s 未到达（窗口最小化/
// 隐藏时 rAF 停转、gpu-load 停发）或 renderer 切换（App 侧置 null）则按 null 断段
function effectiveGpu(): number | null {
  return props.gpuLoad !== null && Date.now() - props.gpuLoadAt <= 2000 ? props.gpuLoad : null;
}

let unlisten: UnlistenFn | null = null;

function sizeChart() {
  const el = wrapRef.value;
  if (el && el.clientWidth > 0) plotW.value = el.clientWidth;
}

onMounted(async () => {
  sizeChart();
  resizeObserver = new ResizeObserver(sizeChart);
  resizeObserver.observe(wrapRef.value!);
  unlisten = await listen<{ ts: number; cpu: number; memBytes: number }>('sys-stats', (e) => {
    samples.value = pushSample(samples.value, { ...e.payload, gpu: effectiveGpu() }, MAX_POINTS);
  });
});

watch(collapsed, (v) => {
  if (!v) nextTick(sizeChart);
});

// 首个样本到达时正文区才渲染 SVG，重新测量一次宽度，
// 避免挂载瞬间空占位符的窄宽度被当作图表宽度
watch(hasData, (v) => {
  if (v) nextTick(sizeChart);
});

onBeforeUnmount(() => {
  unlisten?.();
  resizeObserver?.disconnect();
  resizeObserver = null;
});
</script>

<template>
  <section class="panel stats-panel">
    <header class="stats-head">
      <h2>应用资源（近 1 小时）</h2>
      <span class="legend mem">内存 {{ memMB }} MB（左轴）</span>
      <span class="legend cpu">CPU {{ cpuPct }}%（右轴）</span>
      <span class="legend gpu">GPU {{ gpuPct }}（估算，仅 WebGL）</span>
      <button class="btn small" @click="collapsed = !collapsed">
        {{ collapsed ? '展开' : '收起' }}
      </button>
    </header>
    <div v-show="!collapsed" ref="wrapRef" class="stats-body">
      <div v-if="!hasData" class="empty">暂无数据</div>
      <svg v-else :width="plotW" :height="H" class="chart">
        <g :transform="`translate(${MARGIN_L}, ${MARGIN_T})`">
          <line
            v-for="t in memTickPos"
            :key="`g${t.v}-${t.y}`"
            x1="0"
            :y1="t.y"
            :x2="plotWarea"
            :y2="t.y"
            class="grid"
          />
          <polyline v-for="(seg, i) in memSegs" :key="`m${i}`" :points="seg" class="line mem" />
          <polyline v-for="(seg, i) in cpuSegs" :key="`c${i}`" :points="seg" class="line cpu" />
          <polyline v-for="(seg, i) in gpuSegs" :key="`g${i}`" :points="seg" class="line gpu" />
          <text
            v-for="t in xTicks"
            :key="t.label"
            :x="t.x"
            :y="plotH + 14"
            class="tick"
            :text-anchor="t.label === '现在' ? 'end' : 'middle'"
          >
            {{ t.label }}
          </text>
        </g>
        <text
          v-for="t in memTickPos"
          :key="`ml${t.v}`"
          :x="MARGIN_L - 6"
          :y="MARGIN_T + t.y + 3"
          class="tick"
          text-anchor="end"
        >
          {{ t.v }}
        </text>
        <text
          v-for="t in pctTickPos"
          :key="`pr${t.v}`"
          :x="plotW - MARGIN_R + 6"
          :y="MARGIN_T + t.y + 3"
          class="tick"
          text-anchor="start"
        >
          {{ t.v }}%
        </text>
      </svg>
    </div>
  </section>
</template>

<style scoped>
section.panel.stats-panel {
  display: flex;
  flex-direction: column;
  /* 覆盖 .panel 的 align-items:center：列方向下它会让子元素收缩到内容宽，
     挂载时正文区只有"暂无数据"占位（~66px），实测宽度被永久污染 */
  align-items: stretch;
  gap: 8px;
  /* 左右贴边与波形区外沿对齐，仅保留上下内边距 */
  padding-left: 0;
  padding-right: 0;
}
.stats-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.stats-head h2 {
  margin: 0;
  font-size: 1rem;
}
.legend {
  font-size: 0.8rem;
}
.legend.mem {
  color: #24c8db;
}
.legend.cpu {
  color: #f5a623;
}
.legend.gpu {
  color: #e74c3c;
}
.stats-head .btn {
  margin-left: auto;
}
/* App.vue 的 .btn 为 scoped，无法命中本组件内部按钮，这里补一份对齐的样式 */
.btn {
  padding: 6px 12px;
  border: 1px solid #333;
  border-radius: 6px;
  background: #232936;
  color: #e6e6e6;
  cursor: pointer;
}
.btn.small {
  padding: 4px 8px;
}
.chart {
  display: block;
  box-sizing: border-box;
  background: #141922;
  border: 1px solid #232936;
  border-radius: 6px;
}
.line {
  fill: none;
  stroke-width: 1.5;
}
.line.mem {
  stroke: #24c8db;
}
.line.cpu {
  stroke: #f5a623;
}
.line.gpu {
  stroke: #e74c3c;
}
.grid {
  stroke: #232936;
  stroke-width: 0.5;
}
.tick {
  fill: #777;
  font-size: 10px;
}
.empty {
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  background: #141922;
  border: 1px solid #232936;
  border-radius: 6px;
}
</style>
