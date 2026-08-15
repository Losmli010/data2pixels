# AGENTS.md — data2pixels

Tauri 2 桌面应用：Rust 模拟 3 通道信号采集，前端（Vue 3 + TS + Vite）做波形/资源可视化。
本文件位于 `src/`（前端工作区）；仓库根在上一级 `/Users/losmli/Codes/data2pixels`，包管理器为 pnpm。

## 常用命令（在仓库根执行）

- `pnpm run tauri dev` — 启动桌面应用（Vite 固定端口 1420，`strictPort`）
- `pnpm test` — 前端单测（vitest run，覆盖 `src/lib/` 下 ring / minmax / glbuf / stats / timebase）
- `pnpm run build` — `vue-tsc --noEmit` 类型检查 + vite build（类型错误会阻断构建）
- `pnpm run lint` / `pnpm run lint:fix` — ESLint（仅前端；`src-tauri/**` 已 ignore）
- `pnpm run format` / `format:check` — Prettier
- `cd src-tauri && cargo test` — Rust 信号生成单测

## 目录结构

- `src/` — Vue 前端
  - `lib/` — 纯逻辑模块（环形缓冲、min/max 抽稀、WebGL 缓冲、统计、时基），每个模块配 `*.test.ts`，用 vitest 直接测试，无 DOM 依赖
  - `components/` — 三个渲染组件：`ChartCanvas.vue`（Canvas2D）、`ChartWebGL.vue`（WebGL2，不可用自动回退）、`ChartSVG.vue`（资源监控折线图）
  - `App.vue` — 主编排（~500 行）：采集参数控制、数据流接线、渲染模式切换
- `src-tauri/src/` — Rust 后端
  - `acq.rs` — `AcqEngine`：3 通道信号生成，20ms 攒批 emit `wave-data` 事件；参数经 `set_acq_config` clamp 后热更新（采样率 1kHz–1GHz 对数可调）
  - `stats.rs` — sysinfo 常驻线程每 1s 采样自身进程 CPU/内存，emit `sys-stats` 事件
  - `lib.rs` — Tauri 命令注册：`start_acq` / `stop_acq` / `set_acq_config`；运行标志为 `Arc<AtomicBool>`，参数为 `Arc<Mutex<GenParams>>`

## 架构要点

- 数据流：Rust 生成 → `wave-data` 事件 → 前端环形缓冲（200k 深度，高速率下时基受深度限制）→ min/max 峰值检测 → 双模式渲染（Canvas2D 逐列竖线 + destination-out 余辉，或 WebGL2 `gl.LINES` + framebuffer ping-pong 余辉）
- GPU 使用率是前端估算值（每帧 WebGL 渲染耗时 / 16.7ms 帧预算），不是系统真值
- 资源监控图为固定 1 小时窗口、每秒槽位；缺失槽位为 null 断开，不做外推

## 代码约定

- Vue 3 `<script setup>` SFC + TypeScript strict 模式（`noUnusedLocals` / `noUnusedParameters` 开启）
- Prettier：printWidth 100、单引号、分号、trailingComma all
- ESLint：prettier 负责格式，风格规则已关闭；`no-explicit-any` 为 warn；`vue/multi-word-component-names` 已关闭
- `src/vite-env.d.ts` 中的 `{}` / `any` 是 Vue 官方垫片写法，勿"修复"
- 新的前端纯逻辑应放 `src/lib/` 并配 vitest 测试文件，与现有模块保持一致

## 注意事项

- vite.config.ts 专为 Tauri 定制：端口 1420 固定、忽略 `src-tauri/**` 的 watch，改动前了解这些约束
- Rust 与前端通过 `wave-data` / `sys-stats` 事件和三个 invoke 命令通信；改字段需两端同步（acq.rs 的 serde 结构 vs `src/lib/channels.ts`）
- `docs/` 目录为空文档占位，无必读文档
