# AGENTS.md — data2pixels（仓库根）

Tauri 2 桌面应用：Rust 后端模拟 3 通道信号采集（20ms 攒批推 `wave-data` 事件），Vue 3 + TS + Vite 前端做波形 / 资源可视化（环形缓冲 → min/max 抽稀 → Canvas2D 或 WebGL2 渲染）。包管理器为 **pnpm**。

更细粒度的说明在两个子目录的 AGENTS.md 中，改对应代码前先读：

- `src/AGENTS.md` — 前端结构、命令、约定
- `src-tauri/AGENTS.md` — Rust 后端结构、命令、约定

## 常用命令（仓库根执行）

- `pnpm run tauri dev` — 启动桌面应用（Vite 固定端口 1420，`strictPort`）
- `pnpm test` — 前端单测（vitest，覆盖 `src/lib/` 纯逻辑模块）
- `pnpm run build` — `vue-tsc --noEmit` 类型检查 + vite build（类型错误阻断构建）
- `pnpm run lint` / `pnpm run lint:fix` — ESLint（仅前端，忽略 `src-tauri/**`）
- `pnpm run format` / `format:check` — Prettier
- `cd src-tauri && cargo test` — Rust 单测；`cargo check` 快速类型检查

## 跨端契约（最易踩坑）

- Rust ↔ 前端通过事件 `wave-data`（`AcqFrame`）和 `sys-stats`（`StatsSample`），以及命令 `start_acq` / `stop_acq` / `set_acq_config` 通信。**改字段需两端同步**：`src-tauri/src/acq.rs` / `stats.rs` 的 serde 结构 vs `src/lib/channels.ts`
- serde 命名不统一：`GenParams` / `StatsSample` 是 camelCase，`AcqFrame` / `ChannelSamples` 保持 snake_case
- 前端传来的采集参数必须在 Rust 侧经 `clamped()` 钳制后使用；采样率名义上 1kHz–1GHz 对数可调，但每通道有 100k 样本/s 吞吐上限

## 约定与注意事项

- 前端纯逻辑放 `src/lib/` 并配 `*.test.ts`（vitest，无 DOM 依赖）；组件在 `src/components/`
- TypeScript strict 模式（`noUnusedLocals` / `noUnusedParameters`）；Prettier printWidth 100、单引号、分号、trailingComma all
- Rust 2021 edition，rustfmt 风格；`src-tauri/gen/` 为生成目录勿手动编辑；`Cargo.lock` 已提交
- `src/vite-env.d.ts` 中的 `{}` / `any` 是 Vue 官方垫片写法，勿"修复"
- `docs/` 目录无必读文档
