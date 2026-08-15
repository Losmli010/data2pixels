# scope-wave-demo 设计文档

日期：2026-08-14
状态：已批准

## 目标

在独立工程 `scope-wave-demo`（Tauri v2 + Vue3 + Vite + TS）中演示「采集模拟 → 海量数据渲染」完整管线：
Rust 后台线程模拟多通道信号采集，通过 Tauri 事件批量推送，前端 Canvas 做实时波形绘制（含峰值检测降采样、余辉叠加、交互控制）。

## 能力清单

1. Rust 模拟采集 + 事件推送（演示 invoke 请求-响应 vs 事件订阅推送的架构选择）
2. Canvas 实时波形绘制（示波器/趋势图样式，网格 + 时基）
3. min/max 峰值检测降采样（存储深度 >> 屏幕宽度时的抽点算法，保留毛刺）
4. 余辉/荧光叠加显示（Persistence，模拟示波器荧光屏效果）
5. 多通道（3 通道各一种波形）+ 交互控制

## 总体数据流

```
Rust 模拟采集线程
   ↓ 固定采样率 1kHz 生成 3 通道样本
   ↓ 攒批（每 ~20ms 一批）
app.emit("wave-data", frame)   ← 事件批量推送
   ↓
前端 listen 收包 → 每通道 Float32Array 环形缓冲
   ↓ rAF 节流
Canvas：峰值检测 → 波形 →（可选）余辉叠加
   ↓
屏幕
```

## 工程结构

```
scope-wave-demo/
├── src/                     # Vue 前端（TS）
│   ├── App.vue              # 控制面板 + 布局
│   ├── main.ts
│   └── lib/
│       ├── ring.ts          # Float32Array 环形缓冲
│       └── minmax.ts        # 峰值检测纯函数
│   └── components/
│       └── WaveCanvas.vue   # 双 Canvas 波形绘制
├── src-tauri/               # Rust 后端
│   └── src/
│       ├── main.rs
│       ├── lib.rs           # 注册命令 + 事件
│       └── acq.rs           # 模拟采集引擎
└── docs/superpowers/specs/
```

## Rust 端设计（src-tauri/src/acq.rs）

### 通道定义

3 通道各一种波形，贴合半导体场景：

| id | 波形 | 特征 |
|---|---|---|
| `sine` | 正弦 + 白噪声 | 幅度/频率/相位可调，噪声 `+ 0.15 * (rand-0.5)` |
| `pulse` | 方波脉冲 | 边沿随机抖动，演示毛刺捕捉 |
| `trend` | 腔体趋势 | 分段缓变 + 噪声 + 偶发阶跃 |

### AcqEngine

- 持 `Instant` 主时钟 + 相位累加器，保证信号时间连续、相位无跳变
- `std::thread` 常驻循环：每 ~20ms 计算自上次以来应产生的样本数（1kHz → 每批约 20 样本/通道），生成并攒包
- 共享状态 `Arc<AtomicBool> running`：线程常驻，仅 running=true 时 `emit` 发包
- 暴露命令 `start_acq` / `stop_acq` 控制

### 帧包格式（typed + Serialize）

```json
{
  "seq": 42,
  "t0_ms": 123456,
  "channels": [
    { "id": "sine", "samples": [0.13, -0.5, ...] }
  ]
}
```

- `seq`：递增序号，前端可检测丢包
- `t0_ms`：本包第一样本的相对时间戳（毫秒）

### Rust 单元测试

- 信号取值范围正确
- 无 NaN
- 批次样本数正确（时间推进 × 采样率）
- 相位连续推进、无跳变

## 前端设计

### ring.ts — 环形缓冲

- 底层 `Float32Array`，固定容量（200_000 样本 ≈ 200s@1kHz）
- 支持批量 append（回绕覆盖最旧数据）
- 按时间窗口取区间
- 记录每样本对应时间（由包 t0_ms + 索引推导）

### minmax.ts — 峰值检测

- 纯函数 `computeMinMax(samples, winStart, winEnd, pxWidth) → Array<[min,max]>`
- 每像素列归集取极值
- 列宽 > 1：画 min→max 竖线（保留毛刺）
- 列宽 = 1：画单点
- 空输入 → 空数组

### WaveCanvas.vue — 波形组件

- **双 Canvas 叠层**：
  - 下层：余辉层（离屏持久化）
  - 上层：当前帧波形 + 网格 + 标签
- **余辉实现**：`destination-out` 均匀淡出（每帧 alpha≈0.03）+ 新波形低透明度叠加
- **网格**：时基刻度（X）+ 电压刻度（Y）+ 通道颜色/标签

### 渲染协调（rAF 单循环）

```
每帧：读 3 通道环形缓冲 → 按时基取可见窗口 → 每通道 computeMinMax
     → 画网格 → 画波形(或余辉叠加) → 画标签 → 统计帧率
```

- 时基缩放：改可见窗口秒数（2s / 5s / 10s / 30s），不重采样缓冲
- 滚动：默认跟随最新（窗口右端 = 当前时间）；暂停时冻结

### App.vue — 控制面板

- 启动/停止采集（invoke `start_acq` / `stop_acq`）
- 暂停（停收新帧但保留缓冲）、清空缓冲
- 时基下拉
- 每通道显隐开关
- 余辉开关
- 状态栏：帧率、收到样本数、缓冲占用率、running 状态

### 前端测试（vitest）

- `ring.ts`：append 越界回绕、窗口切片正确
- `minmax.ts`：列宽>1 极值、列宽=1 单点、空输入

## Tauri 接入

- `invoke_handler`：注册 `start_acq` / `stop_acq`
- `setup`：启动 AcqEngine 线程
- 事件：`wave-data`
- `capabilities`：确认 `event:default` 权限（Tauri v2 默认含）

## 错误处理

- 丢包检测：`seq` 不连续时前端标记一次（状态栏提示），不阻塞绘制
- Rust 线程启动失败：日志 + 前端状态栏显示采集未运行
- 缓冲写满：回绕覆盖（环形缓冲语义），状态栏显示占用率

## 非目标（YAGNI）

- 不做 WebGL/Worker 方案（作为后续演进项）
- 不做真机采集对接、不写文件持久化
- 不做多窗口
