# data2pixels

Tauri 2 + Vue 3 + TypeScript 的桌面波形示波器示例：Rust 后端模拟 3 通道信号采集并实时推送，前端环形缓冲 → min/max 抽稀 → Canvas2D / WebGL2 双模式渲染，附带近 1 小时的应用资源（内存 / CPU / GPU）监控图。

## 功能

- **3 通道信号采集模拟**：正弦+噪声、方波脉冲、腔体趋势，参数可由前端热更新（逐通道波形参数、采样率 1kHz–1GHz 对数可调、批次 10–100ms，`set_acq_config` 命令在 Rust 侧 clamp 后生效）
- **实时波形渲染**：Rust 每 20ms 攒批推送 `wave-data` 事件 → 前端环形缓冲（200k 深度，高速率下时基受深度限制）→ min/max 峰值检测 → 双渲染模式
  - Canvas2D：逐列竖线 + `destination-out` 余辉
  - WebGL2：`gl.LINES` + framebuffer ping-pong 余辉（不可用时自动回退 Canvas2D）
- **资源监控**：Rust sysinfo 常驻线程每 1s 采样自身进程 CPU/内存 → `sys-stats` 事件；GPU 为前端估算（WebGL 每帧渲染耗时 / 16.7ms 帧预算）
  - 按真实时间戳展示最近 1 小时固定窗口（每秒槽位，样本落在真实时间位置，缺失槽位 null 断开、不外推）按像素抽稀 → SVG 三曲线折线图（左右 Y 轴刻度、每 10 分钟 X 刻度、宽度随窗口缩放、可折叠）

## 技术栈

- **后端**：Rust + Tauri 2（`src-tauri/`），事件推送 + invoke 命令通信
- **前端**：Vue 3 `<script setup>` + TypeScript strict + Vite（固定端口 1420）
- **纯逻辑**：`src/lib/`（环形缓冲、min/max 抽稀、WebGL 缓冲、统计、时基），各模块配 vitest 单测，无 DOM 依赖
- **渲染组件**：`src/components/ChartCanvas.vue`（Canvas2D）、`ChartWebGL.vue`（WebGL2）、`ChartSVG.vue`（SVG 资源图）
- **包管理**：pnpm

## 快速开始

环境要求：Node.js 22+、pnpm、Rust 工具链（rustup）。

```bash
pnpm install
pnpm run tauri dev
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm run tauri dev` | 启动桌面应用（Vite 固定端口 1420，`strictPort`） |
| `pnpm run tauri build` | 打包（`beforeBuildCommand` 先跑前端类型检查 + vite build） |
| `pnpm test` | 前端单测（vitest run，覆盖 `src/lib/`） |
| `pnpm run build` | `vue-tsc --noEmit` 类型检查 + vite build（类型错误阻断构建） |
| `pnpm run lint` / `pnpm run lint:fix` | ESLint（仅前端，忽略 `src-tauri/**`） |
| `pnpm run format` / `format:check` | Prettier |
| `cd src-tauri && cargo test` | Rust 单测（信号生成 / clamp / 吞吐） |
| `cd src-tauri && cargo clippy` | Rust Lint（建议 `--all-targets -- -D warnings`） |
| `cd src-tauri && cargo fmt` | Rust 格式化 |

## 架构

```
Rust 采集引擎 (acq.rs)
  └─ 每 batch_ms 生成 3 通道样本 → wave-data 事件
Rust 统计线程 (stats.rs)
  └─ sysinfo 每 1s 采样 CPU/内存 → sys-stats 事件
        │
        ▼
前端环形缓冲 (src/lib/ring.ts, 200k 深度)
  → min/max 抽稀 (src/lib/minmax.ts)
  → ChartCanvas (Canvas2D) 或 ChartWebGL (WebGL2)
  → ChartSVG 资源图 (src/lib/stats.ts 窗口裁剪 + 抽稀)
```

### 跨端契约（改字段需两端同步）

- Rust ↔ 前端事件：`wave-data`（`AcqFrame`）、`sys-stats`（`StatsSample`）；命令：`start_acq` / `stop_acq` / `set_acq_config`
- serde 命名不统一：`GenParams` / `StatsSample` 为 camelCase，`AcqFrame` / `ChannelSamples` 保持 snake_case
- 前端采集参数必须在 Rust 侧经 `clamped()` 钳制后使用；每通道 100k 样本/s 吞吐上限

## 项目结构

```
├── src/                  # Vue 前端
│   ├── App.vue           # 主编排：采集参数控制、数据流接线、渲染模式切换
│   ├── components/       # ChartCanvas / ChartWebGL / ChartSVG
│   └── lib/              # ring / minmax / glbuf / stats / timebase（含 *.test.ts）
├── src-tauri/            # Rust 后端
│   ├── src/acq.rs        # 3 通道信号生成引擎（含单测）
│   ├── src/stats.rs      # 进程资源采样
│   ├── src/lib.rs        # Tauri 命令注册与状态管理
│   └── tauri.conf.json   # 窗口 1280×800（最小 800×600）、devUrl 1420、CSP null
└── AGENTS.md             # AI agent 协作说明（根 / src / src-tauri）
```

## 常见问题

- **pnpm 未安装**：仓库使用 corepack，可用 `corepack pnpm ...`，或全局安装 `npm install -g pnpm`
- **`sh: pnpm: command not found`**：Tauri 的 `beforeDevCommand` 走 `sh` 调 pnpm，需确保 pnpm 在 PATH 中
