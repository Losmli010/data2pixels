# 前端调控采集数据生成设计

日期：2026-08-15
状态：已确认

## 背景与目标

后端 `src-tauri/src/acq.rs` 以硬编码参数生成 3 通道信号（sine 5Hz/amp1/noise0.15、
pulse 1Hz/duty0.5/amp1/jitter0.15、trend amp1/noise0.05），采样率固定 1kHz、
20ms 攒批。目标：前端新增"采集参数"控制，热更新后端生成参数——逐通道波形
参数 + 全局采样率（1kHz–1GHz）与批次大小。

## 参数模型

### 全局

| 参数 | 范围 | 默认 | 刻度 |
|---|---|---|---|
| 采样率 sample_rate_hz | 1_000 – 1_000_000_000 (1kHz–1GHz) | 1000 | 对数 |
| 批次 batch_ms | 10 – 100 ms | 20 | 线性，步进 10 |

### 逐通道

| 通道 | 参数 | 范围 | 刻度 |
|---|---|---|---|
| sine | freq_hz | 0.1 – 1_000_000 (1MHz) | 对数 |
| | amp | 0 – 2 | 线性 0.01 |
| | noise | 0 – 1 | 线性 0.01 |
| pulse | freq_hz | 0.1 – 100_000 (100kHz) | 对数 |
| | duty | 0.05 – 0.95 | 线性 0.01 |
| | amp | 0 – 2 | 线性 0.01 |
| | jitter | 0 – 0.5 | 线性 0.01 |
| trend | amp | 0.1 – 2 | 线性 0.01 |
| | noise | 0 – 0.1 | 线性 0.01 |

频率上限放宽是为了让高采样率有意义；超过 Nyquist 时出现混叠是真实行为，
demo 中可观察，不做特殊处理。

## 高采样率物理模型（吞吐上限 + 存储深度）

真实按 1GHz 密集生成不可行（20ms 批 = 2000 万样本/通道）。采用真实示波器
的等价模型：

- **吞吐上限 CAP = 100_000 样本/s/通道**。每批实际样本数
  `n = min(rate × batch_ms / 1000, CAP × batch_ms / 1000)`，作为纯函数
  `samples_per_batch(rate, batch_ms)` 实现并单测。
- **信号时间按实际生成量推进**：样本时间 `t = 样本全局序号 / rate`（f64，
  1GHz 下间隔 1ns，精度足够）。超过 CAP 后等效"高速采集慢速回灌"，时间轴
  完全自洽不失真；墙钟节奏（每批 sleep batch_ms）不变。
- **存储深度 = 前端环形缓冲 200k**。1GHz 下满缓冲覆盖 200µs 信号时间——
  与真实示波器"最高采样率只在短时基下可用"一致。当
  `timebaseToSamples(时基, rate) > 200_000` 时窗口钳制到可用数据，状态栏
  显示"时基受存储深度限制"。

## Rust 侧设计

- `acq.rs` 新增 `GenParams`（serde `Deserialize`，`rename_all = "camelCase"`）：
  `sample_rate_hz: f64`、`batch_ms: u64`、`sine/pulse/trend` 三个子结构，
  字段如上表。新增 `clamped()` 方法把所有字段钳制到范围内（防前端非法值），
  `Default` 即当前硬编码值。
- `ChannelGen` 新增 `apply(params)`：把参数写入 `kind` 对应字段；trend 为
  有状态随机游走，参数热更新不影响内部 level/step_until。
- `gen(t0_index: u64, n: usize, rate_hz: f64)`：`t = (t0_index + i)/rate`；
  引擎线程维护 `t0_index += n`（不再按 batch_ms 递增）。`AcqFrame.t0_ms`
  改为信号时间（`t0_index / rate × 1000`，前端未使用该字段，语义对齐即可）。
- `lib.rs` 新增 command `set_acq_config(config: GenParams) -> Result<(), String>`：
  clamp 后写入 `Arc<Mutex<GenParams>>` managed state；引擎线程每批开头
  `clone` 一份读取并 `apply`，下一批生效（≤100ms），不中断采集、seq 连续。
- 引擎线程节拍 sleep 使用当前 `batch_ms`。

## 前端设计（App.vue + 两个渲染组件）

- 控制面板下方新增"采集参数"区块：顶部两个全局滑条（采样率对数滑条——
  滑条值为 log10(hz)，旁显格式化文本如 "1 MHz"；批次线性滑条），其下每
  通道一组滑条 + 当前值显示（对数滑条同理）。滑条 `@change`（松手）才
  `invoke("set_acq_config", ...)`。
- 本地 `ref` 镜像各参数（默认值与 Rust 一致），invoke 失败时状态栏显示
  错误信息一行（`acqError` ref）。
- 采样率破坏"1 样本 = 1ms"假设：`WaveCanvas` / `WaveGL` 各增加
  `sampleRateHz: number` prop，窗口换算
  `winStart = max(0, sampleNow - samplesInWindow + 1)`，其中
  `samplesInWindow = timebaseToSamples(timebaseMs, sampleRateHz)`。
- 新增 `src/lib/timebase.ts`：
  `timebaseToSamples(timebaseMs: number, sampleRateHz: number): number`
  （= `ceil(timebaseMs * rate / 1000)`）纯函数 + vitest 单测。
- 时基档位扩为九档：100µs / 1ms / 10ms / 100ms / 1s / 2s / 5s / 10s / 30s。
- 深度限制：`timebaseToSamples` 结果 > CAPACITY(200_000) 时钳制窗口并
  在状态栏提示。

## 错误处理

- Rust 侧 `clamped()` 保证任何输入安全；`set_acq_config` 返回
  `Result<(), String>`。
- 前端 invoke 的 Promise `.catch` 写入 `acqError` 显示，不静默。

## 测试

- Rust 单测：`clamped()` 越界值收敛；`samples_per_batch` 上限与下限路径；
  非 1kHz rate 下 `gen` 样本数正确且全部有限；sine freq 提高后过零率上升。
- 前端 vitest：`timebaseToSamples` 常规值、边界钳制语义、大数（1GHz × 30s）
  不溢出精度（< 2^53）。
- 手动冒烟：调参后波形随之变化；高采样率下时基档位与深度限制提示正确。

## 不做的事（YAGNI）

- 参数不持久化，重启回默认。
- 不做二进制 IPC 优化（当前 CAP 下 JSON 开销可接受）。
- 不做 CAP 运行时可调（定值 100k）。
- 不改 `computeMinMax` / 环形缓冲 / 渲染组件内部绘制逻辑（仅加 prop 与
  窗口换算）。
