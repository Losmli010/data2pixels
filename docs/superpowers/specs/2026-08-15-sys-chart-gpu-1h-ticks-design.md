# 资源图表增强：GPU 估算、1 小时窗口、Y 轴刻度、宽度对齐设计

日期：2026-08-15
状态：已获用户批准
前置：`2026-08-15-sys-stats-chart-design.md`（本文件在其基础上增强）

## 目标

增强既有应用资源 SVG 折线图：
1. 补充 GPU 使用情况（前端估算口径）；
2. X 轴展示近 1 小时数据；
3. Y 轴显示刻度；
4. 图表 DOM 宽度与波形显示区一致。

## 已确认的决策

| 决策点 | 选择 |
| --- | --- |
| GPU 口径 | 前端估算：WebGL 渲染帧耗时 / 16.7ms 帧预算，clamp 0-100 |
| GPU 采集方 | `WaveGL.vue` 渲染循环内测量，前端内部传递（不经 Rust） |
| X 轴窗口 | 近 1 小时，采样仍 1s，前端滚动窗口 3600 点 |
| 渲染抽稀 | 按绘图区像素宽度 bucket 均值抽稀（每像素 1 点） |
| Y 轴刻度 | 左轴内存（MB）0-窗口最大值；右轴 CPU/GPU 共用 0-100%；各 5 条网格线 + 数值标签 |
| 宽度 | 与 `WaveCanvas` 同模式：`clientWidth` + `resize` 监听，SVG 实测像素宽，不拉伸 |

## 架构与数据流

```
WaveGL.vue 渲染循环（每帧测 performance.now 差值）
  └─ 每秒汇总均值 → emit("gpu-load", pct)
      └─ App.vue 转发 → SysStatsChart（prop）
          └─ 与最近一次 sys-stats 样本合并为 SysSample{ts, cpu, memBytes, gpu}

stats.rs（不变，1s）→ emit("sys-stats", {ts, cpu, memBytes})
  └─ SysStatsChart 监听 → lib/stats.ts 滚动窗口（3600 点）
      └─ downsample(按像素 bucket 均值) → SVG 三条 polyline
```

### GPU 估算语义
- `gpu% = clamp(renderMs / 16.7ms × 100, 0, 100)`，`renderMs` 为单帧渲染函数
  执行耗时；每秒取该秒内所有帧的平均值作为一个估算点。
- Canvas2D 模式下无 `gpu-load` 事件，该秒 `gpu` 为 `null`，GPU 曲线断开；
  图例标注"GPU（仅 WebGL 渲染负载估算）"。
- `SysSample.gpu: number | null`；Rust payload 不变，GPU 由前端合并进样本。

### 合并对齐
- `SysStatsChart` 收到 `sys-stats` 时创建/更新当前秒的样本；收到 `gpu-load`
  时把值填入最近样本（同一秒窗口内），下一秒重新开始累计。两者独立到达，
  任一先到都不丢数据。

## 组件与接口

### `src/lib/stats.ts`（扩展）
- `SysSample` 增加 `gpu: number | null`。
- `pushSample` 的 `maxPoints` 默认改为 3600。
- `downsample(samples, buckets, value): SysSample[]`——把 N 个样本按顺序均分为
  `buckets` 组，每组取 `value` 均值，返回代表每组的新样本数组（ts 取组内最后
  样本 ts，用于 X 轴真实时间定位）。
- `axisTicks(min, max, count): number[]`——生成 `count` 个等距刻度值（含端点）。
- 既有 `toPolyline` 增加按 `ts` 映射 X 坐标的重载参数（X 由真实时间而非索引
  均分决定），签名变更在实现计划中锁定。

### `src/components/WaveGL.vue`（小改）
- 渲染循环测量每帧渲染函数耗时，每秒均值 `emit("gpu-load", pct)`。
- 事件仅在有 WebGL 渲染帧的秒内发出。

### `src/components/SysStatsChart.vue`（重构布局）
- 宽度：挂载后读 `clientWidth` 并监听 `resize`（与 WaveCanvas 相同模式），
  SVG 以 `width=实测px / height=固定px` 渲染，移除 `preserveAspectRatio="none"`。
- 布局：绘图区左右各留 48px 边距；左轴内存标签（MB）、右轴 CPU/GPU 标签（%），
  刻度文本在 SVG 内绘制（不缩放）。
- X 轴：每 10 分钟网格线 + 标签（-60m … 现在），按样本 `ts` 定位；窗口未填满
  时曲线从右侧逐步向左生长。
- 内存轴定标：窗口内最大 memBytes 向上取整到 32MB 的倍数（修掉按最新值定标
  截平历史峰值的遗留问题）。
- 图例：内存 / CPU / GPU 三项；CPU 与 GPU 显示值 clamp 到 100。
- 三条曲线：内存 `#24c8db`、CPU `#f5a623`、GPU 新色 `#e74c3c`。

### `src/App.vue`（小改）
- 转发 `WaveGL` 的 `gpu-load` 事件给 `SysStatsChart`（prop 传入）。

## 错误处理

- `gpu-load` 与 `sys-stats` 任一缺失时对应字段为 `null`，曲线断开而非伪造 0。
- 容器宽度为 0（折叠后展开瞬间）时保持上次宽度，`resize` 触发后重算。

## 测试

- `lib/stats.ts`：`downsample`（分组数、均值、组内 ts）、`axisTicks`、
  `gpu` 字段与 3600 点窗口、`toPolyline` 的 ts 映射——vitest。
- `WaveGL` 帧测量与 `SysStatsChart` 布局为 DOM/渲染逻辑，`npm run build`
  类型检查 + 手动 `npm run tauri dev` 验证（三条曲线、刻度、宽度对齐、
  2D 模式 GPU 断开）。

## 依赖变更

- 无（前端与 Rust 均零新依赖）。

## 非目标

- 不做真实 GPU 硬件占用采集（macOS 无公开 API）。
- 不做图表游标/缩放交互。
- 不持久化历史（刷新即丢）。
