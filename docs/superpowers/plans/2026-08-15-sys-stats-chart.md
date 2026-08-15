# 应用资源监控图表（DOM/SVG）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 scope-wave-demo 中新增纯 SVG 折线图面板，实时展示应用自身进程的内存（MB）和 CPU（%）随时间的变化。

**Architecture:** Rust 侧新增常驻采样线程（`stats.rs`），每 1s 用 sysinfo 读取自身进程 CPU/内存并以 `sys-stats` 事件推送；前端 `SysStatsChart.vue` 监听事件，`lib/stats.ts` 纯函数维护 300 点滚动窗口并生成 SVG polyline 坐标；图表挂在 `App.vue` 波形区下方，可折叠。

**Tech Stack:** Tauri 2（Emitter 事件推送）、sysinfo 0.33、Vue 3 `<script setup>`、SVG、Vitest、cargo test。

## Global Constraints

- 事件名固定为 `sys-stats`，payload 字段名为 `ts`（毫秒 epoch，number）、`cpu`（0-100 百分比，number）、`memBytes`（字节数，number）。
- 采样间隔 1s，前端保留最近 300 点（5 分钟），超出从头部丢弃。
- 采样线程常驻，不受"开始/停止采集"按钮影响。
- 前端零新依赖；Rust 仅新增 `sysinfo = "0.33"`。
- 图表必须为 SVG（DOM 文档流内），不得用 canvas/WebGL。
- 前端测试命令：`npm test`（vitest run）；Rust 测试命令：`cd src-tauri && cargo test`。

---

### Task 1: Rust 采样模块 `stats.rs`

**Files:**
- Modify: `src-tauri/Cargo.toml`（dependencies 增加 sysinfo）
- Create: `src-tauri/src/stats.rs`
- Modify: `src-tauri/src/lib.rs`（注册模块并在 setup 中启动线程）

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `stats::StatsSample`（`#[derive(Clone, Serialize)]`，`#[serde(rename_all = "camelCase")]`，字段 `ts: u64, cpu: f32, mem_bytes: u64`，序列化后为 `{ts, cpu, memBytes}`）；`stats::spawn_stats_thread(app: tauri::AppHandle)`；事件名 `"sys-stats"`。Task 3 的前端监听依赖这三个名字。

- [ ] **Step 1: 添加依赖并写失败的序列化测试**

`src-tauri/Cargo.toml` 的 `[dependencies]` 末尾加：

```toml
sysinfo = "0.33"
```

创建 `src-tauri/src/stats.rs`，先只写结构体与测试：

```rust
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSample {
    pub ts: u64,
    pub cpu: f32,
    pub mem_bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sample_serializes_to_camel_case_json() {
        let s = StatsSample { ts: 1_700_000_000_000, cpu: 12.5, mem_bytes: 48 * 1024 * 1024 };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"ts\":1700000000000"), "{json}");
        assert!(json.contains("\"cpu\":12.5"), "{json}");
        assert!(json.contains("\"memBytes\":50331648"), "{json}");
    }
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `cd src-tauri && cargo test stats`
Expected: PASS（1 个测试）。此步是序列化格式验证，测试与实现同文件同步给出，故直接通过。

- [ ] **Step 3: 实现采样线程**

在 `stats.rs` 顶部补充（放在 `use serde::Serialize;` 之后）：

```rust
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessesToUpdate, System};
use tauri::Emitter as _;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

pub fn spawn_stats_thread(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let pid = sysinfo::Pid::from_u32(std::process::id());
        loop {
            sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
            if let Some(proc) = sys.process(pid) {
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let sample = StatsSample {
                    ts,
                    cpu: proc.cpu_usage(),
                    mem_bytes: proc.memory(),
                };
                let _ = app.emit("sys-stats", sample);
            } else {
                eprintln!("sys-stats: process {} not found, skipping sample", pid);
            }
            std::thread::sleep(SAMPLE_INTERVAL);
        }
    });
}
```

注：CPU 使用率需要两次 refresh 之间的间隔才有意义，先 sleep 再进入下一轮 refresh，首样本可能是 0，属预期。

- [ ] **Step 4: 在 lib.rs 中接线**

`src-tauri/src/lib.rs` 修改为：

```rust
use std::sync::Arc;
use tauri::Manager as _;

mod acq;
mod stats;
pub use acq::AcqEngine;

#[tauri::command]
fn start_acq(running: tauri::State<'_, Arc<std::sync::atomic::AtomicBool>>) {
    running.store(true, std::sync::atomic::Ordering::Relaxed);
}

#[tauri::command]
fn stop_acq(running: tauri::State<'_, Arc<std::sync::atomic::AtomicBool>>) {
    running.store(false, std::sync::atomic::Ordering::Relaxed);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_acq, stop_acq])
        .setup(|app| {
            let engine = AcqEngine::spawn(app.handle().clone());
            app.manage(engine.running.clone());
            stats::spawn_stats_thread(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: 运行全部 Rust 测试与编译检查**

Run: `cd src-tauri && cargo test`
Expected: PASS（原有 acq 测试 + 新增 stats 测试全部通过）。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/stats.rs src-tauri/src/lib.rs
git commit -m "feat: sysinfo 采样线程每秒推送进程 CPU/内存 sys-stats 事件"
```

---

### Task 2: 前端纯函数 `lib/stats.ts`

**Files:**
- Create: `src/lib/stats.ts`
- Test: `src/lib/stats.test.ts`

**Interfaces:**
- Consumes: Task 1 的事件 payload 形状 `{ ts: number; cpu: number; memBytes: number }`。
- Produces（Task 3 依赖，签名必须一字不差）:
  - `export interface SysSample { ts: number; cpu: number; memBytes: number }`
  - `export function pushSample(samples: SysSample[], s: SysSample, maxPoints = 300): SysSample[]`（返回新数组，超过 maxPoints 时丢弃头部）
  - `export function toPolyline(samples: SysSample[], opts: { width: number; height: number; min: number; max: number; value: (s: SysSample) => number }): string`（返回 SVG `points` 属性字符串，x 均分 width，y 按 [min,max] 线性映射到 [height,0]，min==max 时 y 取 height/2）

- [ ] **Step 1: 写失败的测试**

创建 `src/lib/stats.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { pushSample, toPolyline, type SysSample } from "./stats";

const mk = (ts: number, cpu = 1, memBytes = 1024): SysSample => ({ ts, cpu, memBytes });

describe("pushSample", () => {
  it("appends and keeps order", () => {
    const out = pushSample([mk(0), mk(1)], mk(2));
    expect(out.map((s) => s.ts)).toEqual([0, 1, 2]);
  });

  it("drops oldest beyond maxPoints", () => {
    let arr: SysSample[] = [];
    for (let i = 0; i < 305; i++) arr = pushSample(arr, mk(i));
    expect(arr).toHaveLength(300);
    expect(arr[0].ts).toBe(5);
    expect(arr.at(-1)!.ts).toBe(304);
  });

  it("does not mutate the input array", () => {
    const orig = [mk(0)];
    pushSample(orig, mk(1));
    expect(orig).toHaveLength(1);
  });
});

describe("toPolyline", () => {
  const w = 100, h = 50;

  it("maps values linearly to svg coordinates", () => {
    // 值 [0, 5, 10] 映射 min=0 max=10：y = 50, 25, 0；x 均分 0, 50, 100
    const pts = toPolyline([mk(0, 0), mk(1, 5), mk(2, 10)], {
      width: w, height: h, min: 0, max: 10, value: (s) => s.cpu,
    });
    expect(pts).toBe("0,50 50,25 100,0");
  });

  it("clamps values outside [min,max]", () => {
    const pts = toPolyline([mk(0, -5), mk(1, 20)], {
      width: w, height: h, min: 0, max: 10, value: (s) => s.cpu,
    });
    expect(pts).toBe("0,50 100,0");
  });

  it("returns mid-height when min equals max", () => {
    const pts = toPolyline([mk(0, 7), mk(1, 7)], {
      width: w, height: h, min: 7, max: 7, value: (s) => s.cpu,
    });
    expect(pts).toBe("0,25 100,25");
  });

  it("rounds coordinates to integers", () => {
    const pts = toPolyline([mk(0, 1), mk(1, 2), mk(2, 3)], {
      width: 100, height: 50, min: 0, max: 9, value: (s) => s.cpu,
    });
    for (const pair of pts.split(" ")) {
      expect(pair).toMatch(/^\d+,\d+$/);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL — 找不到模块 `./stats`。

- [ ] **Step 3: 最小实现**

创建 `src/lib/stats.ts`：

```typescript
export interface SysSample {
  ts: number;
  cpu: number;
  memBytes: number;
}

export function pushSample(samples: SysSample[], s: SysSample, maxPoints = 300): SysSample[] {
  const out = [...samples, s];
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out;
}

export function toPolyline(
  samples: SysSample[],
  opts: { width: number; height: number; min: number; max: number; value: (s: SysSample) => number },
): string {
  const { width, height, min, max, value } = opts;
  const span = max - min;
  return samples
    .map((s, i) => {
      const x = samples.length === 1 ? 0 : Math.round((i / (samples.length - 1)) * width);
      let y: number;
      if (span === 0) {
        y = height / 2;
      } else {
        const clamped = Math.min(Math.max(value(s), min), max);
        y = height - ((clamped - min) / span) * height;
      }
      return `${x},${Math.round(y)}`;
    })
    .join(" ");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（新增 6 个用例 + 既有 ring/minmax/glbuf 用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/stats.ts src/lib/stats.test.ts
git commit -m "feat: sys-stats 滚动窗口与 polyline 映射纯函数 + 单测"
```

---

### Task 3: `SysStatsChart.vue` 组件与集成

**Files:**
- Create: `src/components/SysStatsChart.vue`
- Modify: `src/App.vue`（波形组件后挂载、导入）

**Interfaces:**
- Consumes: Task 1 的事件 `sys-stats`（payload `{ts, cpu, memBytes}`）；Task 2 的 `SysSample` / `pushSample` / `toPolyline`。
- Produces: 无后续任务依赖。组件无 props、无 emits。

- [ ] **Step 1: 创建组件**

创建 `src/components/SysStatsChart.vue`（样式沿用 App.vue 的深色面板风格，色值与现有通道色一致：内存 `#24c8db`、CPU `#f5a623`）：

```vue
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { pushSample, toPolyline, type SysSample } from "../lib/stats";

const W = 560;
const H = 120;
const MAX_POINTS = 300;

const samples = ref<SysSample[]>([]);
const collapsed = ref(false);
const hasData = computed(() => samples.value.length > 0);

const latest = computed(() => samples.value.at(-1));
const memMB = computed(() =>
  latest.value ? Math.round(latest.value.memBytes / 1024 / 1024) : 0,
);
const cpuPct = computed(() =>
  latest.value ? Math.round(latest.value.cpu) : 0,
);

// 内存轴：以 16MB 向上取整留出余量，避免曲线贴顶
const memMaxMB = computed(() =>
  Math.max(64, Math.ceil(((latest.value?.memBytes ?? 0) / 1024 / 1024 + 16) / 32) * 32),
);

const memPoints = computed(() =>
  toPolyline(samples.value, {
    width: W, height: H, min: 0, max: memMaxMB.value, value: (s) => s.memBytes / 1024 / 1024,
  }),
);
const cpuPoints = computed(() =>
  toPolyline(samples.value, {
    width: W, height: H, min: 0, max: 100, value: (s) => s.cpu,
  }),
);

let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen<SysSample>("sys-stats", (e) => {
    samples.value = pushSample(samples.value, e.payload, MAX_POINTS);
  });
});

onBeforeUnmount(() => {
  unlisten?.();
});
</script>

<template>
  <section class="panel stats-panel">
    <header class="stats-head">
      <h2>应用资源</h2>
      <span class="legend mem">内存 {{ memMB }} MB（左轴）</span>
      <span class="legend cpu">CPU {{ cpuPct }}%（右轴）</span>
      <button class="btn small" @click="collapsed = !collapsed">
        {{ collapsed ? "展开" : "收起" }}
      </button>
    </header>
    <div v-if="!collapsed" class="stats-body">
      <div v-if="!hasData" class="empty">暂无数据</div>
      <svg v-else :viewBox="`0 0 ${W} ${H}`" class="chart" preserveAspectRatio="none">
        <line x1="0" :y1="H / 2" :x2="W" :y2="H / 2" class="grid" />
        <polyline :points="memPoints" class="line mem" />
        <polyline :points="cpuPoints" class="line cpu" />
      </svg>
      <div class="axis">
        <span>0</span>
        <span>{{ memMaxMB }} MB / 100%</span>
        <span>-5min → 现在</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.stats-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
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
.stats-head .btn {
  margin-left: auto;
}
.chart {
  width: 100%;
  height: 120px;
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
.grid {
  stroke: #232936;
  stroke-width: 0.5;
}
.empty {
  height: 120px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #666;
  background: #141922;
  border: 1px solid #232936;
  border-radius: 6px;
}
.axis {
  display: flex;
  justify-content: space-between;
  font-size: 0.7rem;
  color: #777;
}
</style>
```

- [ ] **Step 2: 在 App.vue 挂载**

`src/App.vue` 两处修改。`<script setup>` 导入区（第 6 行 `import WaveGL...` 之后）加：

```typescript
import SysStatsChart from "./components/SysStatsChart.vue";
```

模板中波形 `<component ... />`（第 170-177 行）之后加：

```html
    <SysStatsChart />
```

- [ ] **Step 3: 类型检查与单测**

Run: `npm run build`
Expected: vue-tsc 无错误，构建成功。

Run: `npm test`
Expected: PASS（全部用例）。

- [ ] **Step 4: 手动验证（如环境可用）**

Run: `npm run tauri dev`
Expected: 波形区下方出现"应用资源"面板；约 1-2s 后开始出现折线（首点 CPU 可能为 0）；点击"开始/停止采集"时 CPU 曲线有可见变化且停止后曲线仍持续更新；"收起/展开"按钮正常。若无法启动 GUI，跳过此步并在交付说明中注明。

- [ ] **Step 5: Commit**

```bash
git add src/components/SysStatsChart.vue src/App.vue
git commit -m "feat: App 集成应用资源 SVG 折线图面板（内存/CPU）"
```

---

### Task 4: README 更新

**Files:**
- Modify: `README.md`（架构描述段落后追加一行）

**Interfaces:**
- Consumes: 无代码依赖，仅文档。
- Produces: 无。

- [ ] **Step 1: 更新架构说明**

在 `README.md` 第 6-9 行的架构描述末尾追加一行：

```markdown
  - 资源监控：Rust sysinfo 常驻线程每 1s 采样自身进程 CPU/内存 → `sys-stats` 事件
    → 前端 300 点滚动窗口 → SVG 折线图（波形区下方，可折叠）
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 补充应用资源监控图表说明"
```
