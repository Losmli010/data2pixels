# AGENTS.md — data2pixels (src-tauri)

Tauri 2 桌面应用的 Rust 后端：模拟 3 通道信号采集引擎 + 进程资源采样，通过事件推送给前端（Vue 3）。
本文件位于 `src-tauri/`（Rust 工作区）；仓库根在上一级，前端说明见 `../src/AGENTS.md`，包管理器为 pnpm。

## 常用命令

在 `src-tauri/` 下执行：

- `cargo test` — Rust 单测（acq.rs 的信号生成/clamp/吞吐测试、stats.rs 的序列化测试）
- `cargo check` — 快速类型检查
- `cargo fmt` — 格式化（代码库已按 rustfmt 风格书写）

在仓库根执行（启动完整应用，Vite 固定端口 1420）：

- `pnpm run tauri dev` — 开发模式
- `pnpm run tauri build` — 打包（`beforeBuildCommand` 会先跑前端 `vue-tsc` + vite build）

## 目录结构

- `src/main.rs` — 入口，仅调用 `data2pixels_lib::run()`
- `src/lib.rs` — Tauri 装配：注册 3 个命令（`start_acq` / `stop_acq` / `set_acq_config`），setup 中 spawn 采集引擎和统计线程，并把 `running`（`Arc<AtomicBool>`）与 `params`（`Arc<Mutex<GenParams>>`）作为 managed state
- `src/acq.rs` — `AcqEngine`：常驻线程按 `batch_ms` 节拍生成 3 通道（sine / pulse / trend）样本并 emit `wave-data`；含 XorShift RNG、`GenParams::clamped()`、`samples_per_batch()`，所有单测在此
- `src/stats.rs` — sysinfo 每 1s 采样自身进程 CPU/内存，emit `sys-stats`
- `tauri.conf.json` — `frontendDist: ../dist`，devUrl 1420，CSP 为 null
- `capabilities/default.json` — 仅 `core:default` + `opener:default` 权限

## 架构要点

- 与前端的契约：事件 `wave-data`（`AcqFrame`：seq / t0_ms / channels）和 `sys-stats`（`StatsSample`：ts / cpu / memBytes），命令 `start_acq` / `stop_acq` / `set_acq_config`。改字段需与前端 `src/lib/channels.ts` 同步
- serde 命名规则不统一：`GenParams` 系列用 `rename_all = "camelCase"`（接收前端），`StatsSample` 也是 camelCase，但 `AcqFrame` / `ChannelSamples` 保持 Rust 默认 snake_case 序列化——修改或新增结构体时注意两端字段名对齐
- 采样率名义上 1kHz–1GHz 对数可调，但每通道有 `THROUGHPUT_CAP = 100_000` 样本/s 上限，超出后信号时间按实际生成量推进（`samples_per_batch`）
- 采集线程即使 `running=false` 也持续生成样本（保持相位连续），只是不 emit；start/stop 只切 AtomicBool
- `t0_ms` 是信号时间而非墙钟时间（前端目前未使用）
- trend 通道有内部状态（level / step_until），`apply()` 热更新参数不影响该状态

## 代码约定

- Rust 2021 edition，风格接近 rustfmt 默认；注释用中文说明约束
- 所有来自前端的参数必须经 `clamped()` 钳制后才进入引擎状态，新增参数要同步加 clamp 和对应单测
- 生成器用固定种子的 XorShift（每通道不同种子），保证可复现，单测依赖此确定性

## 注意事项

- `gen/` 目录是 Tauri 生成的 schema 等，勿手动编辑
- `Cargo.lock` 已提交，升级依赖时注意 lockfile 变更
