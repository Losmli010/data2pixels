# 应用资源监控图表（DOM/SVG）设计

日期：2026-08-15
状态：已获用户批准

## 目标

在 scope-wave-demo 中新增一个纯 DOM（SVG）图表，实时展示应用自身（Tauri 进程）的
内存和 CPU 使用情况随时间的变化。

## 已确认的决策

| 决策点 | 选择 |
| --- | --- |
| 数据来源 | Rust 后端采样（sysinfo crate），事件推送到前端 |
| 图表形式 | SVG 折线图（DOM 文档流内，非 canvas/WebGL） |
| 采样频率 | 1s 一次 |
| 保留窗口 | 最近 5 分钟（300 点），超出从头部丢弃 |
| 摆放位置 | 波形区域下方独立面板，可折叠收起 |
| 采集开关关系 | 采样线程常驻，不受"开始/停止采集"影响 |

## 架构与数据流

```
stats.rs 常驻线程 (1s)
  └─ sysinfo 刷新 + 读取当前进程 cpu_usage()/memory()
      └─ app.emit("sys-stats", { ts, cpu, memBytes })
          └─ SysStatsChart.vue 监听
              └─ lib/stats.ts 滚动窗口（300 点）
                  └─ SVG polyline 渲染（内存 MB 左轴 / CPU % 右轴）
```

1. `src-tauri/src/stats.rs`：`spawn_stats_thread(app_handle)` 在 `lib.rs` 的
   `setup` 中启动。线程内先 refresh 一次（sysinfo 的 CPU 使用率需要两次
   refresh 之间有间隔才有意义），再进入 1s 循环：refresh_processes → 读取
   当前进程 → emit 事件 → sleep 1s。
2. 事件 payload：`{ ts: number（毫秒 epoch）, cpu: number（百分比 0-100）,
   memBytes: number }`。
3. 前端 `SysStatsChart.vue` 监听 `sys-stats`，调用 `lib/stats.ts` 的纯函数
   维护滚动窗口，并生成两条 polyline 的 points 字符串。

## 组件与接口

### `src-tauri/src/stats.rs`
- `pub fn spawn_stats_thread(app: tauri::AppHandle)`：spawn 常驻采样线程。
- 无需暴露 tauri command（纯事件推送，前端不主动查询）。

### `src/lib/stats.ts`
- `StatsWindow` 风格的纯函数（与 `lib/ring.ts` 一致的测试友好设计）：
  - `pushSample(window, sample, maxPoints = 300)`：追加并裁剪。
  - `toPolyline(samples, { width, height, min, max })`：把值域映射为
    SVG points 字符串。
- 单测覆盖 `npm test`。

### `src/components/SysStatsChart.vue`
- 无 props（自订阅事件），内部 `points: {ts, cpu, memBytes}[]`。
- 布局：面板标题 + 折叠按钮；图表区两条折线——内存（MB，左 Y 轴）、
  CPU（%，右 Y 轴），不同颜色 + 图例；X 轴标注相对时间（-5min → now）。
- 每秒收到新点后整体重算 polyline（300 点开销可忽略）。

### `src/App.vue`
- 在波形组件下方挂载 `<SysStatsChart />`。

## 错误处理

- sysinfo 查不到当前进程（理论不发生）时跳过该次采样并 `log::warn`。
- 前端事件监听失败或无数据时，图表区域显示"暂无数据"占位。

## 测试

- Rust：`stats.rs` 序列化格式的单测（`cargo test`）。
- 前端：`lib/stats.ts` 滚动窗口裁剪与 polyline 映射的单测（`npm test`）。
- 手动：`npm run tauri dev`，启停采集观察内存/CPU 曲线随之变化，
  停止采集后曲线仍持续更新。

## 依赖变更

- `src-tauri/Cargo.toml`：新增 `sysinfo = "0.33"`。
- 前端零新依赖。

## 非目标

- 不做历史数据持久化（刷新即丢）。
- 不做 sysinfo-plugin 形式的通用系统监控（只看自身进程）。
- 不做图形缩放/游标等交互（仅滚动展示）。
