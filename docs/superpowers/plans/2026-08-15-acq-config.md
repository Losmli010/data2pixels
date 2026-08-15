# 前端调控采集数据生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 前端"采集参数"面板热更新后端信号生成——逐通道波形参数 + 全局采样率（1kHz–1GHz，对数）与批次，含吞吐上限与存储深度模型。

**Architecture:** Rust 侧 `GenParams` 共享配置（`Arc<Mutex<>>`），新 command `set_acq_config` clamp 后写入，引擎线程每批 clone 读取并 `apply` 到生成器，下一批生效；信号时间按样本序号/rate 推进，每批样本数受吞吐上限钳制。前端新增参数面板（对数滑条）、`timebaseToSamples` 纯函数、两个渲染组件加 `sampleRateHz` prop。

**Tech Stack:** Rust（tauri v2 command、serde）、Vue 3 `<script setup>` + TS、vitest、cargo test。

**Spec:** `docs/superpowers/specs/2026-08-15-acq-config-design.md`

## Global Constraints

- 不新增任何 npm / cargo 依赖。
- 参数范围（Rust clamp 与前端滑条必须一致）：sample_rate_hz 1000–1_000_000_000（对数）；batch_ms 10–100（步进 10）；sine freq 0.1–1_000_000（对数）、amp 0–2、noise 0–1；pulse freq 0.1–100_000（对数）、duty 0.05–0.95、amp 0–2、jitter 0–0.5；trend amp 0.1–2、noise 0–0.1。
- 吞吐上限 `THROUGHPUT_CAP = 100_000.0` 样本/s/通道；每批样本数 = `min(rate×batch/1000, CAP×batch/1000)`。
- 信号时间 `t = 样本全局序号 / rate`（f64）；墙钟节奏每批 sleep `batch_ms` 不变。
- 前端 CAPACITY = 200_000 为存储深度；`timebaseToSamples > 200_000` 时窗口钳制并在状态栏提示"时基受存储深度限制"。
- 默认值（前后端一致）：rate 1000、batch 20、sine{5,1,0.15}、pulse{1,0.5,1,0.15}、trend{1,0.05}。
- 时基九档：100µs(0.1) / 1ms(1) / 10ms(10) / 100ms(100) / 1s(1000) / 2s(2000) / 5s(5000) / 10s(10000) / 30s(30000)，默认仍 5000。
- 参数不持久化；不改 `computeMinMax`、`SampleWindow`、渲染组件绘制内部逻辑。
- 每任务收尾 `cargo test`（src-tauri 目录）或 `npm test`（涉及前端时）+ `npm run build` 必须全绿。
- 工作目录：`/Users/losmli/Codes/codex-workspace/scope-wave-demo`（Rust 命令在其下 `src-tauri/` 执行）。
- 注意：git 仓库根在上级目录、工作树可能有他人无关改动，commit 时只 add 本任务明确列出的文件。

---

### Task 1: Rust 生成模型（GenParams + 采样率感知 gen）

**Files:**
- Modify: `src-tauri/src/acq.rs`

**Interfaces:**
- Consumes: 现有 `ChannelGen` / `WaveKind` / `XorShift`。
- Produces（Task 2 依赖）:
  - `GenParams`（含 `SineParams`/`PulseParams`/`TrendParams` 子结构，serde `Deserialize` + `rename_all = "camelCase"`，`Default` 为全局约束中的默认值）
  - `GenParams::clamped(&self) -> GenParams`
  - `samples_per_batch(rate_hz: f64, batch_ms: u64) -> usize`
  - `ChannelGen::apply(&mut self, p: &GenParams)`
  - `ChannelGen::gen(&mut self, t0_index: u64, n: usize, rate_hz: f64) -> Vec<f32>`（签名变更：原来是 `gen(t0_ms, n)`）

- [ ] **Step 1: 在 `#[cfg(test)] mod tests` 中追加失败测试（保留现有测试，但现有 4 处 `g.gen(0, 20)` / `g.gen(1000, 3)` / `g.gen(0, 25)` / `g.gen(0, 500)` / `g.gen(0, 2000)` / `g.gen(0, 100)` 需同步加第三参数 `1000.0`）**

```rust
    use super::{samples_per_batch, SineParams, TrendParams, PulseParams, GenParams, SAMPLE_RATE_MAX, BATCH_MS_MIN};

    #[test]
    fn clamped_pulls_out_of_range_values() {
        let p = GenParams {
            sample_rate_hz: 5e9,
            batch_ms: 5,
            sine: SineParams { freq_hz: 2e6, amp: 9.0, noise: -1.0 },
            pulse: PulseParams { freq_hz: -1.0, duty: 0.0, amp: -3.0, jitter: 9.0 },
            trend: TrendParams { amp: 0.0, noise: 5.0 },
        };
        let c = p.clamped();
        assert_eq!(c.sample_rate_hz, SAMPLE_RATE_MAX);
        assert_eq!(c.batch_ms, BATCH_MS_MIN);
        assert_eq!(c.sine.freq_hz, 1_000_000.0);
        assert_eq!(c.sine.amp, 2.0);
        assert_eq!(c.sine.noise, 0.0);
        assert_eq!(c.pulse.freq_hz, 0.1);
        assert_eq!(c.pulse.duty, 0.05);
        assert_eq!(c.pulse.amp, 0.0);
        assert_eq!(c.pulse.jitter, 0.5);
        assert_eq!(c.trend.amp, 0.1);
        assert_eq!(c.trend.noise, 0.1);
    }

    #[test]
    fn samples_per_batch_caps_at_throughput() {
        assert_eq!(samples_per_batch(1000.0, 20), 20);
        assert_eq!(samples_per_batch(5000.0, 20), 100);
        assert_eq!(samples_per_batch(1e9, 20), 2000); // CAP×20/1000
        assert_eq!(samples_per_batch(100_000.0, 100), 10_000);
    }

    #[test]
    fn gen_at_high_rate_yields_finite_samples() {
        let mut g = ChannelGen::sine();
        for v in g.gen(123_456, 1000, 1e9) {
            assert!(v.is_finite());
        }
    }

    #[test]
    fn higher_sine_freq_raises_zero_crossings() {
        let mut lo = ChannelGen::sine();
        lo.apply(&GenParams {
            sine: SineParams { freq_hz: 5.0, amp: 1.0, noise: 0.0 },
            ..GenParams::default()
        });
        let mut hi = ChannelGen::sine();
        hi.apply(&GenParams {
            sine: SineParams { freq_hz: 50.0, amp: 1.0, noise: 0.0 },
            ..GenParams::default()
        });
        let zc = |v: Vec<f32>| v.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        assert!(zc(hi.gen(0, 10_000, 1000.0)) > zc(lo.gen(0, 10_000, 1000.0)) * 3);
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test`
Expected: 编译失败（GenParams / samples_per_batch / apply 未定义、gen 参数数量不符）。

- [ ] **Step 3: 实现**

`acq.rs` 顶部 `use serde::Serialize;` 改为 `use serde::{Deserialize, Serialize};`，`ChannelSamples` 定义前插入：

```rust
pub const SAMPLE_RATE_MIN: f64 = 1_000.0;
pub const SAMPLE_RATE_MAX: f64 = 1_000_000_000.0;
pub const BATCH_MS_MIN: u64 = 10;
pub const BATCH_MS_MAX: u64 = 100;
/// 每通道吞吐上限（样本/s），超出后信号时间按实际生成量推进
pub const THROUGHPUT_CAP: f64 = 100_000.0;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SineParams { pub freq_hz: f32, pub amp: f32, pub noise: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PulseParams { pub freq_hz: f32, pub duty: f32, pub amp: f32, pub jitter: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrendParams { pub amp: f32, pub noise: f32 }

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenParams {
    pub sample_rate_hz: f64,
    pub batch_ms: u64,
    pub sine: SineParams,
    pub pulse: PulseParams,
    pub trend: TrendParams,
}

impl Default for GenParams {
    fn default() -> Self {
        Self {
            sample_rate_hz: 1000.0,
            batch_ms: 20,
            sine: SineParams { freq_hz: 5.0, amp: 1.0, noise: 0.15 },
            pulse: PulseParams { freq_hz: 1.0, duty: 0.5, amp: 1.0, jitter: 0.15 },
            trend: TrendParams { amp: 1.0, noise: 0.05 },
        }
    }
}

fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    v.clamp(lo, hi)
}

impl GenParams {
    /// 把所有字段钳制到安全范围（防前端传非法值）
    pub fn clamped(&self) -> Self {
        Self {
            sample_rate_hz: self.sample_rate_hz.clamp(SAMPLE_RATE_MIN, SAMPLE_RATE_MAX),
            batch_ms: self.batch_ms.clamp(BATCH_MS_MIN, BATCH_MS_MAX),
            sine: SineParams {
                freq_hz: clampf(self.sine.freq_hz, 0.1, 1_000_000.0),
                amp: clampf(self.sine.amp, 0.0, 2.0),
                noise: clampf(self.sine.noise, 0.0, 1.0),
            },
            pulse: PulseParams {
                freq_hz: clampf(self.pulse.freq_hz, 0.1, 100_000.0),
                duty: clampf(self.pulse.duty, 0.05, 0.95),
                amp: clampf(self.pulse.amp, 0.0, 2.0),
                jitter: clampf(self.pulse.jitter, 0.0, 0.5),
            },
            trend: TrendParams {
                amp: clampf(self.trend.amp, 0.1, 2.0),
                noise: clampf(self.trend.noise, 0.0, 0.1),
            },
        }
    }
}

/// 每批实际样本数 = min(rate × batch/1000, CAP × batch/1000)，至少 1
pub fn samples_per_batch(rate_hz: f64, batch_ms: u64) -> usize {
    let batch = batch_ms as f64;
    let want = rate_hz * batch / 1000.0;
    let cap = THROUGHPUT_CAP * batch / 1000.0;
    (want.min(cap).round() as usize).max(1)
}
```

`ChannelGen::gen` 替换为：

```rust
    /// 生成全局样本序号 [t0_index, t0_index+n) 的样本，t = 序号/rate_hz
    pub fn gen(&mut self, t0_index: u64, n: usize, rate_hz: f64) -> Vec<f32> {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let t = (t0_index + i) as f64 / rate_hz;
            out.push(self.sample(t));
        }
        out
    }
```

`ChannelGen::gen` 之后新增：

```rust
    /// 热更新波形参数；trend 的内部状态（level/step_until）不受影响
    pub fn apply(&mut self, p: &GenParams) {
        match &mut self.kind {
            WaveKind::Sine { freq_hz, amp, noise, .. } => {
                *freq_hz = p.sine.freq_hz;
                *amp = p.sine.amp;
                *noise = p.sine.noise;
            }
            WaveKind::Pulse { freq_hz, duty, amp, jitter } => {
                *freq_hz = p.pulse.freq_hz;
                *duty = p.pulse.duty;
                *amp = p.pulse.amp;
                *jitter = p.pulse.jitter;
            }
            WaveKind::Trend { amp, noise } => {
                *amp = p.trend.amp;
                *noise = p.trend.noise;
            }
        }
    }
```

（此任务不改 `AcqEngine`；引擎仍调 `g.gen(t0_ms, n)` 会编译失败——因此本任务把引擎循环内的调用同步改为 `g.gen(t0_ms, samples_per_channel, 1000.0)`，其中 `samples_per_channel` 临时仍为 `BATCH_MS as usize`。下一任务再接入共享配置。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test`
Expected: 全部测试 PASS（原 5 个 + 新 4 个）。

- [ ] **Step 5: Commit**

```bash
git add codex-workspace/scope-wave-demo/src-tauri/src/acq.rs
git commit -m "feat: GenParams 参数模型 + 采样率感知生成 + 单测"
```

---

### Task 2: 引擎接入共享配置 + set_acq_config command

**Files:**
- Modify: `src-tauri/src/acq.rs`（AcqEngine）
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 1 的 `GenParams`/`clamped`/`samples_per_batch`/`apply`/`gen`。
- Produces: `AcqEngine { running, params }`，`params: Arc<Mutex<GenParams>>`；command `set_acq_config(config: GenParams) -> Result<(), String>`（Task 5 前端 invoke 依赖，参数名为 `config`，键 camelCase）。

- [ ] **Step 1: 改写 `AcqEngine`**

```rust
pub struct AcqEngine {
    pub running: Arc<AtomicBool>,
    pub params: Arc<std::sync::Mutex<GenParams>>,
}

impl AcqEngine {
    pub fn spawn(app: tauri::AppHandle) -> Arc<Self> {
        let params = Arc::new(std::sync::Mutex::new(GenParams::default()));
        let engine = Arc::new(AcqEngine {
            running: Arc::new(AtomicBool::new(true)),
            params: params.clone(),
        });
        let engine2 = Arc::clone(&engine);
        std::thread::spawn(move || {
            let mut gens: Vec<ChannelGen> =
                vec![ChannelGen::sine(), ChannelGen::pulse(), ChannelGen::trend()];
            let mut t0_index: u64 = 0;
            let mut seq: u64 = 0;
            let mut last = Instant::now();
            loop {
                let p = params.lock().unwrap().clone();
                for g in gens.iter_mut() {
                    g.apply(&p);
                }
                let n = samples_per_batch(p.sample_rate_hz, p.batch_ms);
                let channels = gens
                    .iter_mut()
                    .map(|g| ChannelSamples {
                        id: g.id.to_string(),
                        samples: g.gen(t0_index, n, p.sample_rate_hz),
                    })
                    .collect();
                t0_index += n as u64;
                if engine2.running.load(Ordering::Relaxed) {
                    // t0_ms 为信号时间（前端未使用该字段，语义对齐即可）
                    let t0_ms = (t0_index as f64 / p.sample_rate_hz * 1000.0) as u64;
                    let _ = app.emit(
                        "wave-data",
                        AcqFrame { seq, t0_ms, channels },
                    );
                    seq = seq.wrapping_add(1);
                }
                let now = Instant::now();
                let elapsed = now.duration_since(last);
                if elapsed < Duration::from_millis(p.batch_ms) {
                    std::thread::sleep(Duration::from_millis(p.batch_ms) - elapsed);
                }
                last = now;
            }
        });
        engine
    }
}
```

（原实现中的 `const BATCH_MS`、`samples_per_channel`、`t0_ms: u64` 计数器全部移除，被 `p.batch_ms`/`n`/`t0_index` 取代。）

- [ ] **Step 2: `lib.rs` 增加 command 与 managed state**

在 `stop_acq` 之后新增（clamp 在此处执行，防前端非法值）：

```rust
#[tauri::command]
fn set_acq_config(
    config: acq::GenParams,
    params: tauri::State<'_, Arc<std::sync::Mutex<acq::GenParams>>>,
) -> Result<(), String> {
    *params.lock().map_err(|e| e.to_string())? = config.clamped();
    Ok(())
}
```

`generate_handler!` 改为 `generate_handler![start_acq, stop_acq, set_acq_config]`；`setup` 中 `app.manage(engine.running.clone());` 之后加一行 `app.manage(engine.params.clone());`。

- [ ] **Step 3: 验证**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全部测试 PASS，无警告级错误。

- [ ] **Step 4: Commit**

```bash
git add codex-workspace/scope-wave-demo/src-tauri/src/acq.rs codex-workspace/scope-wave-demo/src-tauri/src/lib.rs
git commit -m "feat: 采集引擎共享配置热更新 + set_acq_config 命令"
```

---

### Task 3: timebaseToSamples 纯函数（TDD）

**Files:**
- Create: `src/lib/timebase.ts`
- Test: `src/lib/timebase.test.ts`

**Interfaces:**
- Produces（Task 4/5 依赖）: `timebaseToSamples(timebaseMs: number, sampleRateHz: number): number` = `ceil(ms × Hz / 1000)`，非正输入或结果 < 1 时返回 1。

- [ ] **Step 1: 写失败测试 `src/lib/timebase.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { timebaseToSamples } from "./timebase";

describe("timebaseToSamples", () => {
  it("1kHz 下 1 样本/ms", () => {
    expect(timebaseToSamples(5000, 1000)).toBe(5000);
    expect(timebaseToSamples(100, 1000)).toBe(100);
  });

  it("非整除时向上取整", () => {
    expect(timebaseToSamples(1, 1500)).toBe(2);
    expect(timebaseToSamples(100, 30_000)).toBe(3000);
  });

  it("1GHz × 30s 仍在安全整数范围", () => {
    const n = timebaseToSamples(30_000, 1e9);
    expect(n).toBe(30_000_000_000);
    expect(Number.isSafeInteger(n)).toBe(true);
  });

  it("非正输入返回 1", () => {
    expect(timebaseToSamples(0, 1000)).toBe(1);
    expect(timebaseToSamples(100, 0)).toBe(1);
    expect(timebaseToSamples(-5, 1000)).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/timebase.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `src/lib/timebase.ts`**

```ts
/** 时基(ms) × 采样率(Hz) → 窗口样本数（向上取整，至少 1；非正输入返回 1） */
export function timebaseToSamples(timebaseMs: number, sampleRateHz: number): number {
  if (timebaseMs <= 0 || sampleRateHz <= 0) return 1;
  return Math.max(1, Math.ceil((timebaseMs * sampleRateHz) / 1000));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/timebase.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add codex-workspace/scope-wave-demo/src/lib/timebase.ts codex-workspace/scope-wave-demo/src/lib/timebase.test.ts
git commit -m "feat: timebaseToSamples 时基-样本换算纯函数 + 单测"
```

---

### Task 4: 渲染组件接入 sampleRateHz

**Files:**
- Modify: `src/components/WaveCanvas.vue`（props 约 :9-15、winStart 约 :103）
- Modify: `src/components/WaveGL.vue`（props 约 :8-14、winStart 约 :197）

**Interfaces:**
- Consumes: Task 3 的 `timebaseToSamples`。
- Produces: 两组件新增可选 prop `sampleRateHz?: number`（缺省按 1000，保证 Task 5 之前应用不回归）；窗口换算 `winStart = max(0, sampleNow - timebaseToSamples(timebaseMs, sampleRateHz ?? 1000) + 1)`。Task 5 传 `:sample-rate-hz="sampleRateHz"`。

- [ ] **Step 1: `WaveCanvas.vue`**

script 顶部 import 区加：

```ts
import { timebaseToSamples } from "../lib/timebase";
```

props 定义（`timebaseMs: number;` 之后）加一行：

```ts
  sampleRateHz?: number;
```

`render()` 中 `const winStart = Math.max(0, sampleNow - props.timebaseMs + 1);` 替换为：

```ts
  const winStart = Math.max(
    0,
    sampleNow - timebaseToSamples(props.timebaseMs, props.sampleRateHz ?? 1000) + 1,
  );
```

- [ ] **Step 2: `WaveGL.vue` 同样修改**

script 顶部 import 区加同样的 import；props 定义 `timebaseMs: number;` 后加 `sampleRateHz?: number;`；`render()` 中同一行 `const winStart = Math.max(0, sampleNow - props.timebaseMs + 1);` 替换为与 Step 1 完全相同的两行。

- [ ] **Step 3: 验证**

Run: `npm test && npm run build`
Expected: 全部单测 PASS，vue-tsc 与构建无错误。

- [ ] **Step 4: Commit**

```bash
git add codex-workspace/scope-wave-demo/src/components/WaveCanvas.vue codex-workspace/scope-wave-demo/src/components/WaveGL.vue
git commit -m "feat: 渲染组件支持 sampleRateHz 窗口换算"
```

---

### Task 5: App.vue 采集参数面板

**Files:**
- Modify: `src/App.vue`（script 状态区、TIMEBASES、模板 panel 区、动态组件绑定、style）

**Interfaces:**
- Consumes: Task 2 的 `set_acq_config`（invoke 参数键 `config`，camelCase 字段）；Task 3 的 `timebaseToSamples`；Task 4 的 `sampleRateHz` prop。
- Produces: 最终用户界面，无下游依赖。

- [ ] **Step 1: script 增加状态与处理函数**

import 区加：

```ts
import { timebaseToSamples } from "./lib/timebase";
```

`const timebaseMs = ref(5000);` 之后加：

```ts
const sampleRateHz = ref(1000);
const batchMs = ref(20);
const acqError = ref("");
const sineP = ref({ freqHz: 5, amp: 1.0, noise: 0.15 });
const pulseP = ref({ freqHz: 1, duty: 0.5, amp: 1.0, jitter: 0.15 });
const trendP = ref({ amp: 1.0, noise: 0.05 });
```

`TIMEBASES` 常量替换为九档：

```ts
const TIMEBASES = [
  { label: "100µs", value: 0.1 },
  { label: "1ms", value: 1 },
  { label: "10ms", value: 10 },
  { label: "100ms", value: 100 },
  { label: "1s", value: 1000 },
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
];
```

`clearBuffers` 之后加：

```ts
const depthLimited = () =>
  timebaseToSamples(timebaseMs.value, sampleRateHz.value) > CAPACITY;

async function pushAcqConfig() {
  acqError.value = "";
  try {
    await invoke("set_acq_config", {
      config: {
        sampleRateHz: sampleRateHz.value,
        batchMs: batchMs.value,
        sine: sineP.value,
        pulse: pulseP.value,
        trend: trendP.value,
      },
    });
  } catch (e) {
    acqError.value = String(e);
  }
}

function sliderVal(e: Event): number {
  return (e.target as HTMLInputElement).valueAsNumber;
}
function onRateChange(e: Event) {
  sampleRateHz.value = hzFromLog(sliderVal(e));
  pushAcqConfig();
}
function onSineFreqChange(e: Event) {
  sineP.value.freqHz = hzFromLog(sliderVal(e));
  pushAcqConfig();
}
function onPulseFreqChange(e: Event) {
  pulseP.value.freqHz = hzFromLog(sliderVal(e));
  pushAcqConfig();
}
function hzFromLog(log: number): number {
  return Math.round(10 ** log);
}
function fmtHz(hz: number): string {
  if (hz >= 1e9) return `${hz / 1e9} GHz`;
  if (hz >= 1e6) return `${hz / 1e6} MHz`;
  if (hz >= 1e3) return `${hz / 1e3} kHz`;
  return `${hz} Hz`;
}
```

- [ ] **Step 2: 模板——主 panel 的 `.status` 内加深度提示，其后插入"采集参数"面板**

`.status` div（含"帧率 …"）里最后加：

```html
        <span v-if="depthLimited()" class="dot">时基受存储深度限制</span>
```

主 `</section>`（panel 结束）与 `<component` 之间插入：

```html
    <section class="panel">
      <div class="control-group">
        <span class="label">全局</span>
        <label class="slider">采样率 <b>{{ fmtHz(sampleRateHz) }}</b>
          <input type="range" min="3" max="9" step="0.05" :value="Math.log10(sampleRateHz)"
            @change="onRateChange" />
        </label>
        <label class="slider">批次 <b>{{ batchMs }}ms</b>
          <input type="range" min="10" max="100" step="10" v-model.number="batchMs"
            @change="pushAcqConfig" />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#24c8db' }">正弦</span>
        <label class="slider">频率 <b>{{ fmtHz(sineP.freqHz) }}</b>
          <input type="range" min="-1" max="6" step="0.05" :value="Math.log10(sineP.freqHz)"
            @change="onSineFreqChange" />
        </label>
        <label class="slider">幅度 <b>{{ sineP.amp.toFixed(2) }}</b>
          <input type="range" min="0" max="2" step="0.01" v-model.number="sineP.amp"
            @change="pushAcqConfig" />
        </label>
        <label class="slider">噪声 <b>{{ sineP.noise.toFixed(2) }}</b>
          <input type="range" min="0" max="1" step="0.01" v-model.number="sineP.noise"
            @change="pushAcqConfig" />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#f5a623' }">方波</span>
        <label class="slider">频率 <b>{{ fmtHz(pulseP.freqHz) }}</b>
          <input type="range" min="-1" max="5" step="0.05" :value="Math.log10(pulseP.freqHz)"
            @change="onPulseFreqChange" />
        </label>
        <label class="slider">占空比 <b>{{ pulseP.duty.toFixed(2) }}</b>
          <input type="range" min="0.05" max="0.95" step="0.01" v-model.number="pulseP.duty"
            @change="pushAcqConfig" />
        </label>
        <label class="slider">幅度 <b>{{ pulseP.amp.toFixed(2) }}</b>
          <input type="range" min="0" max="2" step="0.01" v-model.number="pulseP.amp"
            @change="pushAcqConfig" />
        </label>
        <label class="slider">抖动 <b>{{ pulseP.jitter.toFixed(2) }}</b>
          <input type="range" min="0" max="0.5" step="0.01" v-model.number="pulseP.jitter"
            @change="pushAcqConfig" />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#9b59b6' }">趋势</span>
        <label class="slider">幅度 <b>{{ trendP.amp.toFixed(2) }}</b>
          <input type="range" min="0.1" max="2" step="0.01" v-model.number="trendP.amp"
            @change="pushAcqConfig" />
        </label>
        <label class="slider">噪声 <b>{{ trendP.noise.toFixed(2) }}</b>
          <input type="range" min="0" max="0.1" step="0.01" v-model.number="trendP.noise"
            @change="pushAcqConfig" />
        </label>
        <label class="slider" v-if="acqError"><span class="err">{{ acqError }}</span></label>
      </div>
    </section>
```

`<component :is=...>` 上加一个绑定（与 `:timebase-ms` 并列）：

```html
      :sample-rate-hz="sampleRateHz"
```

- [ ] **Step 3: style 追加**

`.dot.live` 规则之后追加：

```css
.slider {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #aaa;
}
.slider input[type="range"] {
  width: 120px;
}
.slider b {
  color: #e6e6e6;
  font-weight: normal;
  min-width: 56px;
}
.err {
  color: #e05656;
}
```

- [ ] **Step 4: 验证**

Run: `npm test && npm run build && cd src-tauri && cargo test`
Expected: 前端 4 个测试文件全 PASS（含 timebase 4 个新用例）、构建无错误、Rust 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add codex-workspace/scope-wave-demo/src/App.vue
git commit -m "feat: 采集参数面板（对数滑条热更新 + 深度限制提示）"
```

---

### Task 6: README 更新与全量验证

**Files:**
- Modify: `README.md:5-9`（架构描述）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无。

- [ ] **Step 1: 更新 README 架构行**

把"前端环形缓冲 → min/max 峰值检测"所在架构段替换为：

```markdown
- 架构：Rust 模拟 3 通道信号（参数可由前端热更新：逐通道波形参数、采样率
  1kHz–1GHz 对数可调、批次 10–100ms，`set_acq_config` 命令 clamp 后生效）
  → 20ms 攒批 `wave-data` 事件推送 → 前端环形缓冲（200k 深度，高速率下
  时基受深度限制）→ min/max 峰值检测 → 渲染层双模式可切换：
  Canvas2D（逐列竖线 + destination-out 余辉）或
  WebGL2（`gl.LINES` + framebuffer ping-pong 余辉，不可用时自动回退）
```

- [ ] **Step 2: 全量验证**

Run: `npm test && npm run build && cd src-tauri && cargo test`
Expected: 全部 PASS。

- [ ] **Step 3: 手动冒烟（可选，如环境支持 GUI）**

Run: `npm run tauri dev`
检查：调采样率/频率/幅度滑条松手后波形下一批变化；1GHz 下时基切 100µs/1ms 正常、切 30s 出现"时基受存储深度限制"；批次滑条改变事件节奏；trend 参数变化不断裂。

- [ ] **Step 4: Commit**

```bash
git add codex-workspace/scope-wave-demo/README.md
git commit -m "docs: README 补充采集参数热更新说明"
```
