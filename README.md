# data2pixels

采集模拟 → 波形/资源显示示例

- `pnpm run tauri dev`：启动应用
- `pnpm test`：前端单测（ring / minmax / glbuf）
- `cd src-tauri && cargo test`：Rust 信号生成单测
- 架构：Rust 模拟 3 通道信号（参数可由前端热更新：逐通道波形参数、采样率
  1kHz–1GHz 对数可调、批次 10–100ms，`set_acq_config` 命令 clamp 后生效）
  → 20ms 攒批 `wave-data` 事件推送 → 前端环形缓冲（200k 深度，高速率下
  时基受深度限制）→ min/max 峰值检测 → 渲染层双模式可切换：
  Canvas2D（逐列竖线 + destination-out 余辉）或
  WebGL2（`gl.LINES` + framebuffer ping-pong 余辉，不可用时自动回退）
  - 资源监控：Rust sysinfo 常驻线程每 1s 采样自身进程 CPU/内存 → `sys-stats` 事件；
    GPU 为前端估算（WebGL 每帧渲染耗时 / 16.7ms 帧预算）
    → 前端按时间戳展示最近 1 小时固定窗口（每秒槽位，样本落在真实时间位置，
    缺失槽位 null 断开、不外推）按像素抽稀 → SVG 三曲线折线图
    （左右 Y 轴刻度、每 10 分钟 X 刻度、宽度与波形区对齐、可折叠）

# Tauri + Vue + TypeScript

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
