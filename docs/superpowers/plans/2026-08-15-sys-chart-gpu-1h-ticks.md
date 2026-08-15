# 资源图表增强（GPU 估算 / 1 小时窗口 / Y 轴刻度 / 宽度对齐）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强应用资源 SVG 图表：新增 GPU 渲染负载估算曲线、X 轴近 1 小时窗口（每 10 分钟刻度、按真实时间定位）、左右 Y 轴刻度标签、图表宽度与波形区像素级对齐。

**Architecture:** `WaveGL.vue` 渲染循环测每帧耗时并每秒 emit `gpu-load`；`App.vue` 转发给 `SysStatsChart`（prop），与 Rust `sys-stats` 事件按秒合并进 `SysSample`（gpu 可为 null，曲线断开）。`lib/stats.ts` 扩展为 3600 点窗口 + 抽稀 + 刻度 + 按 ts 定位的多段 polyline 纯函数；`SysStatsChart` 改用 `clientWidth` 实测宽度渲染 SVG，左右各留 48px 刻度边距。

**Tech Stack:** Vue 3、SVG、vitest；Rust 侧零改动，前端零新依赖。

## Global Constraints

- GPU 口径：前端估算 `clamp(renderMs / 16.7ms × 100, 0, 100)`，每秒均值；Canvas2D 模式下 `gpu` 为 `null`，曲线断开，不得伪造 0。
- 滚动窗口 3600 点（1 小时 @ 1s），超出从头部丢弃。
- X 轴每 10 分钟一条刻度（-60m … 现在），按样本真实 `ts` 定位；窗口未填满时曲线从右侧逐步向左生长。
- Y 轴左轴内存（MB，0 到窗口最大值向上取整 32MB 倍数、下限 64），右轴 CPU/GPU 共用 0-100%，各 5 条网格线（含端点）+ 数值标签。
- 图表宽度：`clientWidth` + `resize` 监听实测（与 `WaveCanvas` 同模式），SVG 按实测像素渲染，禁止 `preserveAspectRatio="none"` 拉伸。
- 曲线颜色：内存 `#24c8db`、CPU `#f5a623`、GPU `#e74c3c`；图例 CPU/GPU 显示值 clamp 到 100。
- 前端与 Rust 均零新依赖；Rust 侧（stats.rs、Cargo.toml）不动。
- 测试命令：`npm test`；类型/构建检查：`npm run build`。

---

### Task 1: `lib/stats.ts` 扩展（3600 点、gpu 字段、downsample、axisTicks、toSegments）

**Files:**
- Modify: `src/lib/stats.ts`（全量重写）
- Test: `src/lib/stats.test.ts`（全量重写）

**Interfaces:**
- Consumes: Rust `sys-stats` payload `{ts, cpu, memBytes}`（不变）。
- Produces（Task 3 依赖，签名逐字锁定）:
  - `export interface SysSample { ts: number; cpu: number; memBytes: number; gpu: number | null }`
  - `export function pushSample(samples: SysSample[], s: SysSample, maxPoints = 3600): SysSample[]`
  - `export function downsample(samples: SysSample[], buckets: number): SysSample[]`
  - `export function axisTicks(min: number, max: number, count: number): number[]`
  - `export function toSegments(samples: SysSample[], opts: { width: number; height: number; min: number; max: number; tMin: number; tMax: number; value: (s: SysSample) => number | null }): string[]`
  - 旧 `toPolyline` 删除（唯一调用方 SysStatsChart 在 Task 3 改用 `toSegments`；本任务后、Task 3 前组件暂时编译不过，属预期，Task 1 只保证 `npm test` 通过）。

- [ ] **Step 1: 全量重写测试文件**

用以下内容替换 `src/lib/stats.test.ts` 全部内容：

```typescript
import { describe, expect, it } from "vitest";
import { axisTicks, downsample, pushSample, toSegments, type SysSample } from "./stats";

const mk = (ts: number, cpu = 1, memBytes = 1024, gpu: number | null = null): SysSample => ({
  ts, cpu, memBytes, gpu,
});

describe("pushSample", () => {
  it("appends and keeps order", () => {
    const out = pushSample([mk(0), mk(1)], mk(2));
    expect(out.map((s) => s.ts)).toEqual([0, 1, 2]);
  });

  it("drops oldest beyond maxPoints", () => {
    let arr: SysSample[] = [];
    for (let i = 0; i < 305; i++) arr = pushSample(arr, mk(i), 300);
    expect(arr).toHaveLength(300);
    expect(arr[0].ts).toBe(5);
    expect(arr.at(-1)!.ts).toBe(304);
  });

  it("default maxPoints is 3600", () => {
    let arr: SysSample[] = [];
    for (let i = 0; i < 3605; i++) arr = pushSample(arr, mk(i));
    expect(arr).toHaveLength(3600);
    expect(arr[0].ts).toBe(5);
  });

  it("does not mutate the input array", () => {
    const orig = [mk(0)];
    pushSample(orig, mk(1));
    expect(orig).toHaveLength(1);
  });
});

describe("downsample", () => {
  it("returns input when length <= buckets", () => {
    const in_ = [mk(0), mk(1), mk(2)];
    expect(downsample(in_, 10)).toBe(in_);
    expect(downsample([], 10)).toEqual([]);
  });

  it("averages each field per bucket", () => {
    const s = [mk(0, 0, 100), mk(1, 2, 300), mk(2, 4, 500), mk(3, 6, 700)];
    const out = downsample(s, 2);
    expect(out).toHaveLength(2);
    // 桶1: cpu (0+2)/2=1, mem (100+300)/2=200, ts 取组内最后 1
    expect(out[0]).toMatchObject({ ts: 1, cpu: 1, memBytes: 200, gpu: null });
    // 桶2: cpu (4+6)/2=5, mem (500+700)/2=600, ts 取组内最后 3
    expect(out[1]).toMatchObject({ ts: 3, cpu: 5, memBytes: 600, gpu: null });
  });

  it("gpu averages only non-null values; all-null bucket stays null", () => {
    const s = [mk(0, 1, 100, null), mk(1, 1, 100, 40), mk(2, 1, 100, 20), mk(3, 1, 100, null)];
    const out = downsample(s, 2);
    expect(out[0].gpu).toBe(40); // (40+20)/2
    expect(out[1].gpu).toBe(null);
  });
});

describe("axisTicks", () => {
  it("generates evenly spaced ticks with endpoints", () => {
    expect(axisTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(axisTicks(0, 64, 5)).toEqual([0, 16, 32, 48, 64]);
  });

  it("count <= 1 returns just min", () => {
    expect(axisTicks(5, 100, 1)).toEqual([5]);
    expect(axisTicks(5, 100, 0)).toEqual([5]);
  });
});

describe("toSegments", () => {
  const w = 100, h = 50;

  it("maps x by real timestamp over tMin..tMax", () => {
    const segs = toSegments(
      [mk(0, 0), mk(1800, 5), mk(3600, 10)],
      { width: w, height: h, min: 0, max: 100, tMin: 0, tMax: 3600, value: (s) => s.cpu },
    );
    expect(segs).toEqual(["0,50 50,25 100,0"]);
  });

  it("grows from the right when window is not full", () => {
    // 窗口 3600s，只有最近一段数据：x 应靠近右端
    const segs = toSegments(
      [mk(3400, 0), mk(3600, 0)],
      { width: w, height: h, min: 0, max: 100, tMin: 0, tMax: 3600, value: (s) => s.cpu },
    );
    expect(segs).toEqual(["94,50 100,50"]);
  });

  it("breaks the line at null values", () => {
    const segs = toSegments(
      [mk(0, 0), mk(1, null as unknown as number), mk(2, 0), mk(3, 0)],
      { width: w, height: h, min: 0, max: 100, tMin: 0, tMax: 3, value: (s) => s.cpu },
    );
    expect(segs).toEqual(["0,50", "67,50 100,50"]);
  });

  it("null via value callback breaks segments (gpu usage)", () => {
    const s = [mk(0, 1, 1024, 30), mk(1, 1, 1024, null), mk(2, 1, 1024, 60)];
    const segs = toSegments(s, {
      width: w, height: h, min: 0, max: 100, tMin: 0, tMax: 2,
      value: (x) => x.gpu,
    });
    expect(segs).toEqual(["0,35", "100,20"]);
  });

  it("clamps values outside min..max", () => {
    const segs = toSegments(
      [mk(0, -5), mk(1, 20)],
      { width: w, height: h, min: 0, max: 10, tMin: 0, tMax: 1, value: (s) => s.cpu },
    );
    expect(segs).toEqual(["0,50 100,0"]);
  });

  it("mid-height when min equals max; x=0 when tMin equals tMax", () => {
    const segs = toSegments(
      [mk(7, 7), mk(7, 7)],
      { width: w, height: h, min: 7, max: 7, tMin: 7, tMax: 7, value: (s) => s.cpu },
    );
    expect(segs).toEqual(["0,25 0,25"]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — `stats.ts` 无 `downsample` / `axisTicks` / `toSegments` 导出，`SysSample` 缺 `gpu` 字段（类型或断言错误）。

- [ ] **Step 3: 全量重写实现**

用以下内容替换 `src/lib/stats.ts` 全部内容：

```typescript
export interface SysSample {
  ts: number;
  cpu: number;
  memBytes: number;
  gpu: number | null;
}

export function pushSample(samples: SysSample[], s: SysSample, maxPoints = 3600): SysSample[] {
  const out = [...samples, s];
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out;
}

/// 样本数多于 buckets 时按顺序均分 buckets 组，cpu/memBytes/gpu 各取组内均值，
/// ts 取组内最后样本的 ts（保留真实时间用于 X 轴定位）。
export function downsample(samples: SysSample[], buckets: number): SysSample[] {
  if (buckets <= 0 || samples.length === 0) return [];
  if (samples.length <= buckets) return samples;
  const size = samples.length / buckets;
  const out: SysSample[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((b + 1) * size)));
    const group = samples.slice(start, end);
    const avg = (pick: (s: SysSample) => number | null): number | null => {
      const vals = group.map(pick).filter((v): v is number => v !== null);
      return vals.length === 0 ? null : vals.reduce((a, v) => a + v, 0) / vals.length;
    };
    out.push({
      ts: group[group.length - 1].ts,
      cpu: avg((s) => s.cpu) ?? 0,
      memBytes: avg((s) => s.memBytes) ?? 0,
      gpu: avg((s) => s.gpu),
    });
  }
  return out;
}

/// 生成 count 个等距刻度值（含 min/max 端点）。
export function axisTicks(min: number, max: number, count: number): number[] {
  if (count <= 1) return [min];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(min + ((max - min) * i) / (count - 1));
  return out;
}

/// 按 ts 映射 X、值映射 Y 生成 polyline 段；value 返回 null 处断段（GPU 无数据）。
export function toSegments(
  samples: SysSample[],
  opts: {
    width: number;
    height: number;
    min: number;
    max: number;
    tMin: number;
    tMax: number;
    value: (s: SysSample) => number | null;
  },
): string[] {
  const { width, height, min, max, tMin, tMax, value } = opts;
  const span = max - min;
  const tSpan = tMax - tMin;
  const segs: string[] = [];
  let cur: string[] = [];
  for (const s of samples) {
    const v = value(s);
    if (v === null) {
      if (cur.length) segs.push(cur.join(" "));
      cur = [];
      continue;
    }
    const x = Math.round(tSpan === 0 ? 0 : ((s.ts - tMin) / tSpan) * width);
    const clamped = Math.min(Math.max(v, min), max);
    const y = span === 0 ? height / 2 : height - ((clamped - min) / span) * height;
    cur.push(`${x},${Math.round(y)}`);
  }
  if (cur.length) segs.push(cur.join(" "));
  return segs;
}
```

注意：`npm run build` 在本任务后会因 `SysStatsChart.vue` 仍引用已删除的 `toPolyline` 而失败——这是预期的中间状态，Task 3 修复；本任务只要求 `npm test` 通过。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS — stats 15 个用例 + ring/minmax/glbuf 既有用例全部通过（ring/minmax/glbuf 不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: stats 纯函数扩展 gpu 字段/3600 点/抽稀/刻度/分段 polyline + 单测"
```

---

### Task 2: `WaveGL.vue` 每秒 GPU 负载估算事件

**Files:**
- Modify: `src/components/WaveGL.vue`（emits 声明、渲染耗时累计、每秒 emit）

**Interfaces:**
- Consumes: 无（独立于 Task 1）。
- Produces（Task 3 依赖）: WaveGL 新增 emit 事件 `"gpu-load"`，参数为 `number`（0-100 整数），与既有 `"fps"` 事件同一秒窗口发出。

- [ ] **Step 1: 扩展 emits 声明**

`src/components/WaveGL.vue` 第 13 行替换为：

```typescript
const emit = defineEmits<{ fps: [number]; "gpu-load": [number]; fallback: [] }>();
```

- [ ] **Step 2: 累计渲染耗时并每秒 emit**

模块级状态区（第 29-31 行 `fpsFrames`/`fpsLast` 附近）增加：

```typescript
let gpuMs = 0;
let gpuFrames = 0;
```

`render()` 函数体开头（第 188 行 `if (!gl) return;` 之后）加：

```typescript
  const t0 = performance.now();
```

`render()` 末尾 fps 统计块（第 245-251 行）替换为：

```typescript
  gpuMs += performance.now() - t0;
  gpuFrames++;
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    emit("fps", Math.round((fpsFrames * 1000) / (now - fpsLast)));
    // GPU 估算：每帧渲染耗时占 16.7ms 帧预算的比例，clamp 0-100
    const avgMs = gpuFrames > 0 ? gpuMs / gpuFrames : 0;
    emit("gpu-load", Math.min(100, Math.round((avgMs / 16.7) * 100)));
    fpsFrames = 0;
    gpuMs = 0;
    gpuFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(render);
```

- [ ] **Step 3: 类型检查**

Run: `npm run build`
Expected: vue-tsc 仅报 `SysStatsChart.vue` 引用已删除 `toPolyline` 的错误（Task 1 中间状态，Task 3 修复），除此之外无新错误。若不想跑完整 build，可用 `npx vue-tsc --noEmit` 并确认报错仅涉及 `toPolyline`。

- [ ] **Step 4: Commit**

```bash
git add src/components/WaveGL.vue
git commit -m "feat: WaveGL 每秒 emit 渲染负载估算 gpu-load 事件"
```

---

### Task 3: `SysStatsChart.vue` 重构 + `App.vue` 转发

**Files:**
- Modify: `src/components/SysStatsChart.vue`（全量重写）
- Modify: `src/App.vue`（gpuLoad 状态、事件转发、renderer 切换重置、watch 导入）

**Interfaces:**
- Consumes: Task 1 的 `SysSample`/`pushSample`/`downsample`/`axisTicks`/`toSegments`；Task 2 的 `gpu-load` 事件；Rust `sys-stats` 事件 payload `{ts, cpu, memBytes}`。
- Produces: `SysStatsChart` 组件 props `{ gpuLoad: number | null }`、无 emits。

- [ ] **Step 1: 全量重写 `SysStatsChart.vue`**

用以下内容替换 `src/components/SysStatsChart.vue` 全部内容：

```vue
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { axisTicks, downsample, pushSample, toSegments, type SysSample } from "../lib/stats";

const props = defineProps<{ gpuLoad: number | null }>();

const MARGIN_L = 48;
const MARGIN_R = 48;
const MARGIN_B = 20;
const H = 200;
const MAX_POINTS = 3600;
const WINDOW_MS = 3_600_000;
const X_TICK_COUNT = 7; // -60m 每 10 分钟一条 … 现在

const samples = ref<SysSample[]>([]);
const collapsed = ref(false);
const wrapRef = ref<HTMLDivElement | null>(null);
const plotW = ref(560);

const hasData = computed(() => samples.value.length > 0);

// 抽稀到绘图区像素宽度（每像素 1 点）
const view = computed(() =>
  downsample(samples.value, Math.max(10, plotW.value - MARGIN_L - MARGIN_R)),
);

const tMax = computed(() => view.value.at(-1)?.ts ?? Date.now());
const tMin = computed(() => tMax.value - WINDOW_MS);
const plotWarea = computed(() => Math.max(10, plotW.value - MARGIN_L - MARGIN_R));
const plotH = H - MARGIN_B;

// 内存轴：窗口内峰值向上取整到 32MB 倍数，下限 64
const memMaxMB = computed(() => {
  const peak = view.value.reduce((m, s) => Math.max(m, s.memBytes), 0) / 1024 / 1024;
  return Math.max(64, Math.ceil((peak + 16) / 32) * 32);
});

const segOpts = (min: number, max: number, value: (s: SysSample) => number | null) => ({
  width: plotWarea.value, height: plotH, min, max,
  tMin: tMin.value, tMax: tMax.value, value,
});
const memSegs = computed(() =>
  toSegments(view.value, segOpts(0, memMaxMB.value, (s) => s.memBytes / 1024 / 1024)),
);
const cpuSegs = computed(() => toSegments(view.value, segOpts(0, 100, (s) => s.cpu)));
const gpuSegs = computed(() => toSegments(view.value, segOpts(0, 100, (s) => s.gpu)));

const tickY = (v: number, max: number) => Math.round(plotH * (1 - v / max));
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
      label: mins === 0 ? "现在" : `-${mins}m`,
    });
  }
  return out;
});

const latest = computed(() => samples.value.at(-1));
const memMB = computed(() =>
  latest.value ? Math.round(latest.value.memBytes / 1024 / 1024) : 0,
);
const cpuPct = computed(() =>
  latest.value ? Math.min(100, Math.round(latest.value.cpu)) : 0,
);
const gpuPct = computed(() =>
  latest.value && latest.value.gpu !== null
    ? `${Math.min(100, Math.round(latest.value.gpu))}%`
    : "—",
);

// gpu-load 与 sys-stats 独立到达：暂存最近的估算值，下一个样本到达时并入
let pendingGpu: number | null = null;
watch(
  () => props.gpuLoad,
  (v) => { pendingGpu = v; },
);

let unlisten: UnlistenFn | null = null;

function sizeChart() {
  const el = wrapRef.value;
  if (el && el.clientWidth > 0) plotW.value = el.clientWidth;
}

onMounted(async () => {
  sizeChart();
  window.addEventListener("resize", sizeChart);
  unlisten = await listen<{ ts: number; cpu: number; memBytes: number }>("sys-stats", (e) => {
    samples.value = pushSample(samples.value, { ...e.payload, gpu: pendingGpu }, MAX_POINTS);
    pendingGpu = null;
  });
});

watch(collapsed, (v) => {
  if (!v) nextTick(sizeChart);
});

onBeforeUnmount(() => {
  unlisten?.();
  window.removeEventListener("resize", sizeChart);
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
        {{ collapsed ? "展开" : "收起" }}
      </button>
    </header>
    <div v-show="!collapsed" ref="wrapRef" class="stats-body">
      <div v-if="!hasData" class="empty">暂无数据</div>
      <svg v-else :width="plotW" :height="H" class="chart">
        <g :transform="`translate(${MARGIN_L}, 0)`">
          <line
            v-for="t in memTickPos" :key="`g${t.v}-${t.y}`"
            x1="0" :y1="t.y" :x2="plotWarea" :y2="t.y" class="grid"
          />
          <polyline v-for="(seg, i) in memSegs" :key="`m${i}`" :points="seg" class="line mem" />
          <polyline v-for="(seg, i) in cpuSegs" :key="`c${i}`" :points="seg" class="line cpu" />
          <polyline v-for="(seg, i) in gpuSegs" :key="`g${i}`" :points="seg" class="line gpu" />
          <text
            v-for="t in xTicks" :key="t.label"
            :x="t.x" :y="H - 6" class="tick"
            :text-anchor="t.label === '现在' ? 'end' : 'middle'"
          >{{ t.label }}</text>
        </g>
        <text
          v-for="t in memTickPos" :key="`ml${t.v}`"
          :x="MARGIN_L - 6" :y="t.y + 3" class="tick" text-anchor="end"
        >{{ t.v }}</text>
        <text
          v-for="t in pctTickPos" :key="`pr${t.v}`"
          :x="plotW - MARGIN_R + 6" :y="t.y + 3" class="tick" text-anchor="start"
        >{{ t.v }}%</text>
      </svg>
    </div>
  </section>
</template>

<style scoped>
.stats-panel {
  display: flex;
  flex-direction: column;
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
```

- [ ] **Step 2: `App.vue` 三处修改**

`<script setup>` 导入区第 2 行改为（增加 `watch`）：

```typescript
import { onMounted, onBeforeUnmount, ref, shallowRef, triggerRef, watch } from "vue";
```

状态区（第 24 行 `lastSeq` 之后）增加：

```typescript
const gpuLoad = ref<number | null>(null);
// 切到 Canvas2D（或 WebGL 回退）后 WaveGL 卸载，估算值失效，置空让 GPU 曲线断开
watch(renderer, () => {
  gpuLoad.value = null;
});
```

`onGlFallback`（第 61-64 行）改为：

```typescript
function onGlFallback() {
  renderer.value = "2d";
  glAvailable.value = false;
}
```

（函数体不变，`watch(renderer)` 已覆盖回退场景的重置。）

模板中波形 `<component>` 标签（第 170-177 行）增加事件监听：

```html
    <component
      :is="renderer === 'gl' ? WaveGL : WaveCanvas"
      :channels="channels"
      :timebase-ms="timebaseMs"
      :persistence="persistence"
      @fps="fps = $event"
      @gpu-load="gpuLoad = $event"
      @fallback="onGlFallback"
    />
```

`<SysStatsChart />`（波形组件之后）改为：

```html
    <SysStatsChart :gpu-load="gpuLoad" />
```

- [ ] **Step 3: 类型检查与单测**

Run: `npm run build`
Expected: vue-tsc 无错误，构建成功（Task 1 遗留的 `toPolyline` 报错就此消除）。

Run: `npm test`
Expected: PASS（全部用例）。

- [ ] **Step 4: 手动验证（如环境可用）**

Run: `npm run tauri dev`
Expected:
- 图表与波形区左右外沿对齐；左右两侧各有内存（MB）/百分比刻度，5 条水平网格线；X 轴 -60m…现在 7 个刻度。
- WebGL 模式下 GPU 曲线有读数；切到 Canvas2D 后 GPU 图例变"—"且曲线不再延伸；切回 WebGL 恢复。
- 拖拽窗口大小时图表宽度跟随重绘。
- 收起再展开后图表宽度正常。
若无法启动 GUI，跳过并在交付说明中注明。

- [ ] **Step 5: Commit**

```bash
git add src/components/SysStatsChart.vue src/App.vue
git commit -m "feat: 资源图表 1 小时窗口/Y 轴刻度/GPU 曲线/宽度对齐波形区"
```

---

### Task 4: README 更新

**Files:**
- Modify: `README.md`（资源监控说明两行）

**Interfaces:**
- Consumes: 无代码依赖，仅文档。
- Produces: 无。

- [ ] **Step 1: 更新说明**

将 `README.md` 中这两行：

```markdown
  - 资源监控：Rust sysinfo 常驻线程每 1s 采样自身进程 CPU/内存 → `sys-stats` 事件
    → 前端 300 点滚动窗口 → SVG 折线图（波形区下方，可折叠）
```

替换为：

```markdown
  - 资源监控：Rust sysinfo 常驻线程每 1s 采样自身进程 CPU/内存 → `sys-stats` 事件；
    GPU 为前端估算（WebGL 每帧渲染耗时 / 16.7ms 帧预算）
    → 前端 3600 点滚动窗口（近 1 小时）按像素抽稀 → SVG 三曲线折线图
    （左右 Y 轴刻度、10 分钟 X 刻度、宽度与波形区对齐、可折叠）
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 更新资源监控图表说明（GPU 估算/1 小时/刻度）"
```
