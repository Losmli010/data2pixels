# scope-wave-demo 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立工程 `scope-wave-demo` 中实现「Rust 模拟采集 → Tauri 事件推送 → Canvas 实时波形绘制」完整管线，含峰值检测降采样、余辉叠加、3 通道交互控制。

**Architecture:** Rust 后台线程按 1kHz 生成 3 通道信号（正弦+噪声 / 方波脉冲 / 腔体趋势），每 20ms 攒批通过 `app.emit("wave-data")` 推送；前端 `listen` 收包写入每通道 `Float32Array` 环形缓冲，`requestAnimationFrame` 循环中按像素列做 min/max 峰值检测后绘制波形；余辉用离屏 Canvas `destination-out` 均匀淡出 + 低透明度叠加。

**Tech Stack:** Tauri v2、Vue 3、Vite、TypeScript、Rust、vitest、Canvas 2D

**工程路径：** `/Users/losmli/Codes/codex-workspace/scope-wave-demo`
**Rust 命令在 `src-tauri/` 下执行，前端命令在工程根目录执行。**

---

## 文件结构

```
scope-wave-demo/
├── src/
│   ├── App.vue                  # 控制面板 + listen 收包 + 状态管理
│   ├── main.ts                  # 脚手架自带
│   └── components/
│       └── WaveCanvas.vue       # 双 Canvas 波形绘制（网格/波形/余辉/帧率）
│   └── lib/
│       ├── ring.ts              # SampleWindow 环形缓冲
│       ├── ring.test.ts         # vitest
│       ├── minmax.ts            # computeMinMax 峰值检测纯函数
│       └── minmax.test.ts       # vitest
├── src-tauri/
│   └── src/
│       ├── main.rs              # 脚手架自带
│       ├── lib.rs               # 注册命令 + setup 启动采集线程
│       └── acq.rs               # ChannelGen + AcqEngine（含 Rust 单测）
```

---

### Task 1: 脚手架工程

**Files:**
- Create: `scope-wave-demo/`（create-tauri-app 生成）

- [ ] **Step 1: 生成工程**

```bash
cd /Users/losmli/Codes/codex-workspace
npx create-tauri-app@latest scope-wave-demo -m npm -t vue-ts --identifier com.scope.wavedemo --tauri-version 2 --force --yes
```

- [ ] **Step 2: 检查脚手架是否包含嵌套 git 仓库**

```bash
ls -d /Users/losmli/Codes/codex-workspace/scope-wave-demo/.git
```
Expected: 若存在该目录，删除它（父仓库 `/Users/losmli/Codes` 已托管此工程）：
```bash
rm -rf /Users/losmli/Codes/codex-workspace/scope-wave-demo/.git
```

- [ ] **Step 3: 确认目录结构**

```bash
ls /Users/losmli/Codes/codex-workspace/scope-wave-demo
ls /Users/losmli/Codes/codex-workspace/scope-wave-demo/src-tauri/src
```
Expected: 含 `src/`、`src-tauri/`、`index.html`、`package.json`；`src-tauri/src` 含 `lib.rs`、`main.rs`。

- [ ] **Step 4: 安装前端依赖**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm install
```
Expected: `node_modules/` 生成，无报错。

- [ ] **Step 5: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo
git commit -m "chore: scaffold scope-wave-demo (tauri v2 + vue-ts)"
```

---

### Task 2: Rust 信号生成 ChannelGen（TDD）

**Files:**
- Create: `src-tauri/src/acq.rs`
- Modify: `src-tauri/src/lib.rs`（加 `mod acq;`）

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/acq.rs` 先写入以下完整内容（含实现，因为模块需先编译才能跑 `cargo test`；本步仅验证「测试存在且实现正确」的最小闭环，实现写在 Step 3 的 `ChannelGen` 之前以模块形式给出，测试在 Step 1 即可编译运行）：

```rust
use serde::Serialize;

pub struct XorShift(u32);

impl XorShift {
    pub fn new(seed: u32) -> Self {
        Self(seed.max(1))
    }
    /// [0,1)
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (self.0 >> 8) as f32 / 16_777_216.0
    }
    /// [-1,1)
    pub fn next_signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
}

#[derive(Clone, Serialize)]
pub struct ChannelSamples {
    pub id: String,
    pub samples: Vec<f32>,
}

#[derive(Clone, Serialize)]
pub struct AcqFrame {
    pub seq: u64,
    pub t0_ms: u64,
    pub channels: Vec<ChannelSamples>,
}

pub struct ChannelGen {
    pub id: &'static str,
    kind: WaveKind,
    rng: XorShift,
    level: f32,
    step_until: f32,
}

enum WaveKind {
    Sine { freq_hz: f32, phase: f32, amp: f32, noise: f32 },
    Pulse { freq_hz: f32, duty: f32, amp: f32, jitter: f32 },
    Trend { amp: f32, noise: f32 },
}

impl ChannelGen {
    pub fn sine() -> Self {
        Self {
            id: "sine",
            kind: WaveKind::Sine { freq_hz: 5.0, phase: 0.0, amp: 1.0, noise: 0.15 },
            rng: XorShift::new(0x9E37_79B9),
            level: 0.0,
            step_until: 0.0,
        }
    }
    pub fn pulse() -> Self {
        Self {
            id: "pulse",
            kind: WaveKind::Pulse { freq_hz: 1.0, duty: 0.5, amp: 1.0, jitter: 0.15 },
            rng: XorShift::new(0x243F_6A88),
            level: 0.0,
            step_until: 0.0,
        }
    }
    pub fn trend() -> Self {
        Self {
            id: "trend",
            kind: WaveKind::Trend { amp: 1.0, noise: 0.05 },
            rng: XorShift::new(0x85A3_08D3),
            level: 0.0,
            step_until: 0.0,
        }
    }

    /// 采样率 1kHz：生成 [t0_ms, t0_ms+n) 共 n 个样本（1 样本/ms）
    pub fn gen(&mut self, t0_ms: u64, n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let t = (t0_ms as f64 + i as f64) / 1000.0;
            out.push(self.sample(t));
        }
        out
    }

    fn sample(&mut self, t: f64) -> f32 {
        match &mut self.kind {
            WaveKind::Sine { freq_hz, phase, amp, noise } => {
                let v = (2.0 * std::f32::consts::PI * freq_hz * t as f32 + *phase).sin() * *amp;
                v + self.rng.next_signed() * *noise
            }
            WaveKind::Pulse { freq_hz, duty, amp, jitter } => {
                let period = 1.0 / *freq_hz;
                let ph = (t as f32 % period) / period;
                let base = if ph < *duty { 1.0 } else { -1.0 };
                let to_edge = (ph - *duty).abs().min(ph).min((1.0 - ph));
                if to_edge < *jitter && self.rng.next_signed() > 0.0 {
                    1.0
                } else {
                    base
                } * *amp
            }
            WaveKind::Trend { amp, noise } => {
                if self.step_until > 0.0 {
                    self.step_until -= 1.0;
                } else if self.rng.next() < 0.002 {
                    self.level += self.rng.next_signed() * 0.8;
                    self.step_until = 200.0;
                }
                self.level += self.rng.next_signed() * 0.004;
                self.level = self.level.clamp(-*amp, *amp);
                self.level + self.rng.next_signed() * *noise
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn batch_size_matches_requested_count() {
        let mut g = ChannelGen::sine();
        assert_eq!(g.gen(0, 20).len(), 20);
        assert_eq!(g.gen(1000, 3).len(), 3);
    }

    #[test]
    fn sine_values_within_range_and_finite() {
        let mut g = ChannelGen::sine();
        for v in g.gen(0, 500) {
            assert!(v.is_finite());
            assert!((-1.2..1.2).contains(&v), "sine out of range: {v}");
        }
    }

    #[test]
    fn sine_phase_advances_continuously() {
        // 5Hz，t=0 起前 25ms（1/8 周期）内单调上升
        let mut g = ChannelGen::sine();
        let s = g.gen(0, 25);
        for w in s.windows(2) {
            assert!(w[1] >= w[0] - 0.4, "phase jump: {} -> {}", w[0], w[1]);
        }
    }

    #[test]
    fn trend_stays_within_amplitude() {
        let mut g = ChannelGen::trend();
        for v in g.gen(0, 2000) {
            assert!(v.is_finite());
            assert!((-1.5..1.5).contains(&v), "trend out of range: {v}");
        }
    }

    #[test]
    fn deterministic_seed_reproduces_sequence() {
        let mut a = ChannelGen::sine();
        let mut b = ChannelGen::sine();
        assert_eq!(a.gen(0, 100), b.gen(0, 100));
    }
}
```

- [ ] **Step 2: 在 lib.rs 注册模块**

修改 `src-tauri/src/lib.rs`，在文件顶部 `use` 前加：

```rust
mod acq;
pub use acq::{AcqFrame, ChannelGen};
```

- [ ] **Step 3: 运行测试验证通过**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo/src-tauri
cargo test
```
Expected: 5 个测试全部 PASS。

- [ ] **Step 4: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src-tauri/src
git commit -m "feat: ChannelGen 模拟 3 通道信号生成 (sine/pulse/trend)"
```

---

### Task 3: AcqEngine 采集线程 + 控制命令

**Files:**
- Modify: `src-tauri/src/acq.rs`（追加 AcqEngine）
- Modify: `src-tauri/src/lib.rs`（注册 `start_acq`/`stop_acq`，setup 启动线程）

- [ ] **Step 1: 追加 AcqEngine 实现**

在 `src-tauri/src/acq.rs` 的 `#[cfg(test)]` 之前追加：

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter as _;

pub struct AcqEngine {
    pub running: Arc<AtomicBool>,
}

impl AcqEngine {
    pub fn spawn(app: tauri::AppHandle) -> Arc<Self> {
        let engine = Arc::new(AcqEngine {
            running: Arc::new(AtomicBool::new(true)),
        });
        let engine2 = Arc::clone(&engine);
        std::thread::spawn(move || {
            let mut gens: Vec<ChannelGen> =
                vec![ChannelGen::sine(), ChannelGen::pulse(), ChannelGen::trend()];
            const BATCH_MS: u64 = 20;
            let samples_per_channel = BATCH_MS as usize; // 1kHz → 1 样本/ms
            let mut t0_ms: u64 = 0;
            let mut seq: u64 = 0;
            let mut last = Instant::now();
            loop {
                let channels = gens
                    .iter_mut()
                    .map(|g| ChannelSamples {
                        id: g.id.to_string(),
                        samples: g.gen(t0_ms, samples_per_channel),
                    })
                    .collect();
                t0_ms += BATCH_MS;
                if engine2.running.load(Ordering::Relaxed) {
                    let _ = app.emit(
                        "wave-data",
                        AcqFrame { seq, t0_ms, channels },
                    );
                    seq = seq.wrapping_add(1);
                }
                let now = Instant::now();
                let elapsed = now.duration_since(last);
                if elapsed < Duration::from_millis(BATCH_MS) {
                    std::thread::sleep(Duration::from_millis(BATCH_MS) - elapsed);
                }
                last = now;
            }
        });
        engine
    }
}
```

- [ ] **Step 2: 在 lib.rs 注册命令并启动线程**

修改 `src-tauri/src/lib.rs`：

```rust
use std::sync::atomic::Ordering;
use tauri::Manager as _;

mod acq;
pub use acq::{AcqEngine, ChannelGen};
```

将 `run()` 改为：

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start_acq, stop_acq])
        .setup(|app| {
            AcqEngine::spawn(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

并新增两个命令（放在 `run()` 之前）：

```rust
static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

#[tauri::command]
fn start_acq() {
    RUNNING.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn stop_acq() {
    RUNNING.store(false, Ordering::Relaxed);
}
```

> 说明：AcqEngine 线程内已用 `engine.running` 控制发包。这里用独立全局 `RUNNING` 是简化实现，为与引擎状态一致，改为共享同一 `AtomicBool`。若按此简化实现，Task 7 前端调 `start_acq`/`stop_acq` 需与引擎的 `running` 同步。**最终采用统一实现**：把 `RUNNING` 与引擎 `running` 合并——在 Task 3 Step 3 中改为引擎持有并暴露。

- [ ] **Step 3: 统一 running 状态（修正 Step 2 的简化）**

将 Step 2 的两处改为：引擎线程通过 setup 中创建的引擎实例控制。`lib.rs` 最终为：

```rust
use std::sync::Arc;
use tauri::Manager as _;

mod acq;
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: 编译检查**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo/src-tauri
cargo check
```
Expected: 无错误无警告（警告不影响通过，但应尽量为零）。

- [ ] **Step 5: 跑全部 Rust 测试**

```bash
cargo test
```
Expected: 5 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src-tauri
git commit -m "feat: AcqEngine 后台采集线程 + start/stop 命令"
```

---

### Task 4: 前端环形缓冲 ring.ts（TDD）

**Files:**
- Create: `src/lib/ring.ts`
- Create: `src/lib/ring.test.ts`
- Modify: `package.json`（加 vitest + test 脚本）

- [ ] **Step 1: 安装 vitest**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm install -D vitest
npm pkg set scripts.test="vitest run"
```

- [ ] **Step 2: 写失败测试 `src/lib/ring.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { SampleWindow } from "./ring";

describe("SampleWindow", () => {
  it("pushes and reads in order", () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3]);
    expect(w.size).toBe(3);
    expect(w.count).toBe(3);
    expect(w.firstGlobal).toBe(0);
    expect(w.atGlobal(0)).toBe(1);
    expect(w.atGlobal(2)).toBe(3);
  });

  it("wraps around when full", () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3, 4]);
    w.pushMany([5, 6]);
    expect(w.size).toBe(4);
    expect(w.count).toBe(6);
    expect(w.firstGlobal).toBe(2);
    expect(w.atGlobal(1)).toBeNaN();
    expect(w.atGlobal(2)).toBe(3);
    expect(w.atGlobal(3)).toBe(4);
    expect(w.atGlobal(4)).toBe(5);
    expect(w.atGlobal(5)).toBe(6);
  });

  it("clear resets state", () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3, 4]);
    w.clear();
    expect(w.size).toBe(0);
    expect(w.count).toBe(0);
    expect(w.atGlobal(0)).toBeNaN();
  });
});
```

- [ ] **Step 3: 运行验证失败**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm test
```
Expected: FAIL（`./ring` 模块不存在 / `SampleWindow` 未定义）。

- [ ] **Step 4: 实现 `src/lib/ring.ts`**

```ts
export class SampleWindow {
  private buf: Float32Array;
  private write = 0;
  private size = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  /** 已缓存样本数（≤ capacity） */
  get size(): number {
    return this.size;
  }

  /** 历史累计样本总数 */
  get count(): number {
    return this.count;
  }

  /** 缓存中最旧样本的全局序号 */
  get firstGlobal(): number {
    return this.count - this.size;
  }

  pushMany(values: ArrayLike<number>): void {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.write] = values[i];
      this.write = (this.write + 1) % this.capacity;
    }
    this.size = Math.min(this.size + n, this.capacity);
    this.count += n;
  }

  /** 按全局序号取样本；超出缓存窗口返回 NaN */
  atGlobal(g: number): number {
    if (g < this.firstGlobal || g >= this.count) return Number.NaN;
    const pos = (((this.write - this.count + g) % this.capacity) + this.capacity) % this.capacity;
    return this.buf[pos];
  }

  clear(): void {
    this.write = 0;
    this.size = 0;
    this.count = 0;
  }
}
```

> 注意：`get size()` 与私有字段 `this.size` 同名会冲突。**修正**：私有字段改名为 `private sz = 0;`，getter 返回 `this.sz`。最终实现见下：

```ts
export class SampleWindow {
  private buf: Float32Array;
  private write = 0;
  private sz = 0;
  private count = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get size(): number {
    return this.sz;
  }

  get count(): number {
    return this.count;
  }

  get firstGlobal(): number {
    return this.count - this.sz;
  }

  pushMany(values: ArrayLike<number>): void {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.write] = values[i];
      this.write = (this.write + 1) % this.capacity;
    }
    this.sz = Math.min(this.sz + n, this.capacity);
    this.count += n;
  }

  atGlobal(g: number): number {
    if (g < this.firstGlobal || g >= this.count) return Number.NaN;
    const pos = (((this.write - this.count + g) % this.capacity) + this.capacity) % this.capacity;
    return this.buf[pos];
  }

  clear(): void {
    this.write = 0;
    this.sz = 0;
    this.count = 0;
  }
}
```

- [ ] **Step 5: 运行验证通过**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm test
```
Expected: 3 个测试全部 PASS。

- [ ] **Step 6: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src/lib/ring.ts scope-wave-demo/src/lib/ring.test.ts scope-wave-demo/package.json scope-wave-demo/package-lock.json
git commit -m "feat: SampleWindow 环形缓冲 + 单测"
```

---

### Task 5: min/max 峰值检测 minmax.ts（TDD）

**Files:**
- Create: `src/lib/minmax.ts`
- Create: `src/lib/minmax.test.ts`

- [ ] **Step 1: 写失败测试 `src/lib/minmax.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { computeMinMax } from "./minmax";

// 简单数组包装：at(g) 直接按下标取值
const arrAt = (arr: number[]) => (g: number) => arr[g];

describe("computeMinMax", () => {
  it("returns empty for empty window", () => {
    expect(computeMinMax(arrAt([]), 0, 0, 100)).toEqual([]);
  });

  it("each column keeps min and max", () => {
    // 窗口 4 个样本、2 列 → 每列 2 样本
    const out = computeMinMax(arrAt([0, 10, 5, -5]), 0, 4, 2);
    expect(out).toEqual([
      [0, 10],
      [-5, 5],
    ]);
  });

  it("narrow window: one sample per column → min equals max", () => {
    const out = computeMinMax(arrAt([3, 7]), 0, 2, 4);
    expect(out).toEqual([
      [3, 3],
      [7, 7],
      [7, 7],
      [7, 7],
    ]);
  });

  it("respects global offsets", () => {
    // 只看 [2,5) 即 [5,1,-4]
    const out = computeMinMax(arrAt([9, 9, 5, 1, -4, 9]), 2, 5, 3);
    expect(out).toEqual([
      [5, 5],
      [1, 1],
      [-4, -4],
    ]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm test
```
Expected: FAIL（`./minmax` 模块不存在）。

- [ ] **Step 3: 实现 `src/lib/minmax.ts`**

```ts
export type MinMax = [number, number];

/**
 * min/max 峰值检测：把 [gStart, gEnd) 的样本均匀映射到 pxWidth 列，
 * 每列取该像素覆盖样本的 (min, max)。列宽>1 可保留毛刺，=1 退化为单点。
 */
export function computeMinMax(
  at: (g: number) => number,
  gStart: number,
  gEnd: number,
  pxWidth: number,
): MinMax[] {
  const out: MinMax[] = [];
  const n = gEnd - gStart;
  if (n <= 0 || pxWidth <= 0) return out;
  for (let col = 0; col < pxWidth; col++) {
    const s0 = Math.floor((col * n) / pxWidth);
    const s1 = Math.max(s0 + 1, Math.floor(((col + 1) * n) / pxWidth));
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = s0; i < s1; i++) {
      const v = at(gStart + i);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out.push([mn, mx]);
  }
  return out;
}
```

- [ ] **Step 4: 运行验证通过**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm test
```
Expected: 全部 PASS（ring + minmax 共 7 个）。

- [ ] **Step 5: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src/lib/minmax.ts scope-wave-demo/src/lib/minmax.test.ts
git commit -m "feat: computeMinMax 峰值检测降采样 + 单测"
```

---

### Task 6: WaveCanvas.vue 波形组件

**Files:**
- Create: `src/components/WaveCanvas.vue`

- [ ] **Step 1: 实现组件**

`src/components/WaveCanvas.vue`：

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { computeMinMax, type MinMax } from "../lib/minmax";
import type { SampleWindow } from "../lib/ring";

export interface ChannelView {
  id: string;
  label: string;
  color: string;
  samples: SampleWindow;
  visible: boolean;
}

const props = defineProps<{
  channels: ChannelView[];
  timebaseMs: number;
  persistence: boolean;
}>();

const emit = defineEmits<{ fps: [number] }>();

const wrapRef = ref<HTMLDivElement | null>(null);
const mainCanvas = ref<HTMLCanvasElement | null>(null);

const Y_RANGE: [number, number] = [-1.5, 1.5];
let dpr = 1;
let plotW = 0;
let plotH = 0;
let raf = 0;
let persistCanvas: HTMLCanvasElement | null = null;
let persistCtx: CanvasRenderingContext2D | null = null;
let fpsFrames = 0;
let fpsLast = 0;

function sizePlot() {
  const el = wrapRef.value;
  if (!el) return;
  dpr = window.devicePixelRatio || 1;
  plotW = Math.max(100, Math.floor(el.clientWidth));
  plotH = Math.max(100, Math.floor(el.clientHeight));
  const c = mainCanvas.value!;
  c.width = plotW * dpr;
  c.height = plotH * dpr;
  c.style.width = `${plotW}px`;
  c.style.height = `${plotH}px`;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!persistCanvas) {
    persistCanvas = document.createElement("canvas");
    persistCtx = persistCanvas.getContext("2d");
  }
  persistCanvas.width = plotW * dpr;
  persistCanvas.height = plotH * dpr;
  persistCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function valueToY(v: number): number {
  const [lo, hi] = Y_RANGE;
  return plotH * (1 - (v - lo) / (hi - lo));
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = "rgba(128,128,128,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const xSteps = 10;
  for (let i = 0; i <= xSteps; i++) {
    const x = (i / xSteps) * plotW;
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, plotH);
  }
  const [lo, hi] = Y_RANGE;
  for (let v = Math.ceil(lo); v <= hi; v += 1) {
    const y = valueToY(v);
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(plotW, y + 0.5);
  }
  ctx.stroke();
}

function drawTrace(ctx: CanvasRenderingContext2D, mm: MinMax[], color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < mm.length; x++) {
    const [mn, mx] = mm[x];
    const y1 = valueToY(mx);
    const y2 = valueToY(mn);
    if (mn === mx) {
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y1 + 1);
    } else {
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
  }
  ctx.stroke();
}

function render() {
  const c = mainCanvas.value;
  const ctx = c?.getContext("2d");
  if (!ctx) return;

  const sampleNow = props.channels.reduce(
    (max, ch) => Math.max(max, ch.samples.count - 1),
    -1,
  );
  const winStart = Math.max(0, sampleNow - props.timebaseMs + 1);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, plotW, plotH);

  if (props.persistence && persistCtx && persistCanvas) {
    const pc = persistCtx;
    pc.globalCompositeOperation = "destination-out";
    pc.fillStyle = "rgba(0,0,0,0.03)";
    pc.fillRect(0, 0, plotW, plotH);
    pc.globalCompositeOperation = "source-over";
    for (const ch of props.channels) {
      if (!ch.visible || ch.samples.count === 0) continue;
      const mm = computeMinMax(ch.samples.atGlobal.bind(ch.samples), winStart, sampleNow, plotW);
      pc.globalAlpha = 0.35;
      drawTrace(pc, mm, ch.color);
    }
    ctx.drawImage(persistCanvas, 0, 0, plotW, plotH);
  } else {
    if (persistCtx && persistCanvas) {
      persistCtx.clearRect(0, 0, plotW, plotH);
    }
  }

  drawGrid(ctx);

  if (sampleNow >= 0) {
    for (const ch of props.channels) {
      if (!ch.visible || ch.samples.count === 0) continue;
      const mm = computeMinMax(ch.samples.atGlobal.bind(ch.samples), winStart, sampleNow, plotW);
      drawTrace(ctx, mm, ch.color);
    }
  }

  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    emit("fps", Math.round(fpsFrames * 1000 / (now - fpsLast)));
    fpsFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(render);
}

onMounted(() => {
  sizePlot();
  fpsLast = performance.now();
  raf = requestAnimationFrame(render);
  window.addEventListener("resize", sizePlot);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener("resize", sizePlot);
});
</script>

<template>
  <div ref="wrapRef" class="wave-wrap">
    <canvas ref="mainCanvas" class="wave-canvas"></canvas>
    <div class="channel-legend">
      <span
        v-for="ch in channels.filter((c) => c.visible)"
        :key="ch.id"
        class="legend-item"
        :style="{ color: ch.color }"
      >
        ■ {{ ch.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.wave-wrap {
  position: relative;
  width: 100%;
  height: 360px;
  background: #0b0e14;
  border-radius: 8px;
  overflow: hidden;
}
.wave-canvas {
  position: absolute;
  inset: 0;
  display: block;
}
.channel-legend {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 12px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.5);
  padding: 4px 8px;
  border-radius: 4px;
}
</style>
```

- [ ] **Step 2: 类型检查**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npx vue-tsc --noEmit
```
Expected: 无类型错误（脚手架自带 vue-tsc）。

- [ ] **Step 3: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src/components/WaveCanvas.vue
git commit -m "feat: WaveCanvas 双 Canvas 波形绘制（网格/峰值/余辉/帧率）"
```

---

### Task 7: App.vue 集成（listen + 控制面板）

**Files:**
- Modify: `src/App.vue`（整体替换）

- [ ] **Step 1: 整体替换 App.vue**

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import WaveCanvas, { type ChannelView } from "./components/WaveCanvas.vue";
import { SampleWindow } from "./lib/ring";

const CAPACITY = 200_000;

const channels = shallowRef<ChannelView[]>([
  { id: "sine", label: "正弦+噪声", color: "#24c8db", samples: new SampleWindow(CAPACITY), visible: true },
  { id: "pulse", label: "方波脉冲", color: "#f5a623", samples: new SampleWindow(CAPACITY), visible: true },
  { id: "trend", label: "腔体趋势", color: "#9b59b6", samples: new SampleWindow(CAPACITY), visible: true },
]);

const running = ref(false);
const paused = ref(false);
const persistence = ref(true);
const timebaseMs = ref(5000);
const fps = ref(0);
const received = ref(0);
const dropped = ref(0);
const lastSeq = ref(-1);

const TIMEBASES = [
  { label: "2s", value: 2000 },
  { label: "5s", value: 5000 },
  { label: "10s", value: 10000 },
  { label: "30s", value: 30000 },
];

let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen("wave-data", (e) => {
    if (paused.value) return;
    const frame = e.payload as {
      seq: number;
      channels: { id: string; samples: number[] }[];
    };
    if (lastSeq.value >= 0 && frame.seq !== lastSeq.value + 1) {
      dropped.value++;
    }
    lastSeq.value = frame.seq;
    for (const ch of frame.channels) {
      const view = channels.value.find((c) => c.id === ch.id);
      if (view) view.samples.pushMany(ch.samples);
    }
    received.value += frame.channels.reduce((a, c) => a + c.samples.length, 0);
  });
  running.value = true;
});

onBeforeUnmount(() => {
  unlisten?.();
});

async function toggleRunning() {
  if (running.value) {
    await invoke("stop_acq");
    running.value = false;
  } else {
    await invoke("start_acq");
    running.value = true;
  }
}

function toggleChannel(id: string) {
  const ch = channels.value.find((c) => c.id === id);
  if (ch) ch.visible = !ch.visible;
}

function clearBuffers() {
  for (const ch of channels.value) ch.samples.clear();
  received.value = 0;
  dropped.value = 0;
  lastSeq.value = -1;
}

const bufferUsage = () =>
  channels.value.length === 0
    ? 0
    : Math.round(
        (channels.value.reduce((a, c) => a + c.samples.size, 0) /
          (channels.value.length * CAPACITY)) *
          100,
      );
</script>

<template>
  <main class="app">
    <header>
      <h1>scope-wave-demo</h1>
      <p class="sub">Rust 模拟采集 → Tauri 事件推送 → Canvas 波形显示</p>
    </header>

    <section class="panel">
      <div class="control-group">
        <button class="btn" :class="{ on: running }" @click="toggleRunning">
          {{ running ? "停止采集" : "开始采集" }}
        </button>
        <button class="btn" :class="{ on: paused }" @click="paused = !paused">
          {{ paused ? "已暂停" : "暂停" }}
        </button>
        <button class="btn" @click="clearBuffers">清空</button>
      </div>

      <div class="control-group">
        <span class="label">时基</span>
        <button
          v-for="tb in TIMEBASES"
          :key="tb.value"
          class="btn small"
          :class="{ active: timebaseMs === tb.value }"
          @click="timebaseMs = tb.value"
        >
          {{ tb.label }}
        </button>
      </div>

      <div class="control-group">
        <label class="check">
          <input type="checkbox" v-model="persistence" /> 余辉叠加
        </label>
        <span class="check" v-for="ch in channels" :key="ch.id">
          <label :style="{ color: ch.color }">
            <input type="checkbox" :checked="ch.visible" @change="toggleChannel(ch.id)" />
            {{ ch.label }}
          </label>
        </span>
      </div>

      <div class="status">
        <span>帧率 {{ fps }} fps</span>
        <span>样本 {{ received.toLocaleString() }}</span>
        <span>丢包 {{ dropped }}</span>
        <span>缓冲 {{ bufferUsage() }}%</span>
        <span class="dot" :class="{ live: running }">{{ running ? "采集运行中" : "已停止" }}</span>
      </div>
    </section>

    <WaveCanvas
      :channels="channels"
      :timebase-ms="timebaseMs"
      :persistence="persistence"
      @fps="fps = $event"
    />
  </main>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  color: #e6e6e6;
  background: #11151c;
  min-height: 100vh;
}
header h1 {
  margin: 0;
  font-size: 1.3rem;
}
.sub {
  margin: 0;
  color: #888;
  font-size: 0.85rem;
}
.panel {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  padding: 12px;
  background: #1a1f29;
  border-radius: 8px;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  color: #888;
  font-size: 0.85rem;
}
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
.btn.on,
.btn.active {
  border-color: #24c8db;
  color: #24c8db;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85rem;
  color: #aaa;
  margin-right: 8px;
}
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 0.8rem;
  color: #999;
  margin-left: auto;
}
.dot.live {
  color: #24c8db;
}
</style>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
}
body {
  margin: 0;
  background: #11151c;
}
</style>
```

- [ ] **Step 2: 类型检查**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npx vue-tsc --noEmit
```
Expected: 无类型错误。

- [ ] **Step 3: 前端测试仍通过**

```bash
npm test
```
Expected: 7 个测试全部 PASS。

- [ ] **Step 4: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo/src/App.vue
git commit -m "feat: App 集成 wave-data 监听 + 控制面板"
```

---

### Task 8: 全链路验证 + README

**Files:**
- Modify: `README.md`（可选，工程根）

- [ ] **Step 1: 前端单测**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm test
```
Expected: 全部 PASS。

- [ ] **Step 2: Rust 单测**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo/src-tauri
cargo test
```
Expected: 全部 PASS。

- [ ] **Step 3: 前端类型检查**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npx vue-tsc --noEmit && npm run build
```
Expected: 无错误，`dist/` 生成。

- [ ] **Step 4: 启动开发模式目视验证**

```bash
cd /Users/losmli/Codes/codex-workspace/scope-wave-demo
npm run tauri dev
```
Expected（人工确认）：
- 窗口打开即见 3 条波形（青=正弦、橙=脉冲、紫=趋势）持续滚动
- 状态栏显示帧率（~60）、样本持续增长、缓冲占用
- 按钮「停止采集」后波形冻结、状态变灰；再点恢复
- 「暂停」后波形停止滚动但缓冲保留；「清空」后画布清空重新累计
- 切换时基 2s/30s 波形时宽变化正确
- 通道显隐开关只影响对应通道；余辉开关生效（关闭后无拖影）
- 调整窗口大小波形自适应

- [ ] **Step 5: 更新 README**

在工程根 `README.md`（脚手架自带）顶部追加运行说明段落：

```markdown
## 采集模拟 → 波形显示示例

- `npm run tauri dev`：启动应用
- `npm test`：前端单测（ring / minmax）
- `cd src-tauri && cargo test`：Rust 信号生成单测
- 架构：Rust 1kHz 模拟 3 通道信号 → 20ms 攒批 `wave-data` 事件推送
  → 前端环形缓冲 → Canvas min/max 峰值检测绘制 → 余辉叠加
```

- [ ] **Step 6: Commit**

```bash
cd /Users/losmli/Codes/codex-workspace
git add scope-wave-demo
git commit -m "docs: README 说明采集模拟到显示管线"
```

---

## 自检清单（self-review）

**Spec 覆盖：**
- 能力 1（Rust 模拟采集 + 事件推送）→ Task 2/3 ✓
- 能力 2（Canvas 实时波形）→ Task 6 ✓
- 能力 3（min/max 峰值检测）→ Task 5 + Task 6 `computeMinMax` ✓
- 能力 4（余辉叠加）→ Task 6 `destination-out` 淡出 + 低透明度叠加 ✓
- 能力 5（3 通道 + 交互）→ Task 2 三种波形 + Task 7 控制面板 ✓
- 丢包检测 → Task 7 `seq` 校验 ✓
- 缓冲占用显示 → Task 7 `bufferUsage()` ✓

**占位符扫描：** 无 TBD/TODO；所有代码步骤含完整实现。

**类型一致性：**
- `SampleWindow`：`pushMany / atGlobal / clear / size / count / firstGlobal` 各任务引用一致 ✓
- `computeMinMax(at, gStart, gEnd, pxWidth)` 签名在测试与组件中一致 ✓
- `ChannelView` 接口在 WaveCanvas 导出、App 使用一致 ✓
- `start_acq`/`stop_acq` 命令名前后端一致 ✓
- 事件名 `wave-data` 前后端一致 ✓
