# WebGL 渲染模式设计

日期：2026-08-15
状态：已确认

## 背景与目标

现有波形展示使用 `WaveCanvas.vue`（Canvas2D）绘制：环形缓冲 → `computeMinMax`
每像素列峰值降采样 → 逐列竖线 → Canvas2D 余辉（`destination-out` 衰减）。

目标：新增一种基于 WebGL 的展示方式，与 Canvas2D 模式可切换并存，便于对比
帧率与效果；余辉效果在 WebGL 模式下用 GPU（framebuffer 纹理）实现，视觉与
2D 版对齐。

## 技术选型

**原生 WebGL2，零新增依赖。** 波形本质是"每像素一根竖线"，`gl.LINES` +
uniform 颜色即可完整表达；无 3D 需求，引入 regl/three.js 收益为零。

## 组件结构

- 新建 `src/components/WaveGL.vue`，props/emits 与 `WaveCanvas.vue` 完全一致：
  `channels: ChannelView[]`、`timebaseMs: number`、`persistence: boolean`、
  `@fps`。
- `ChannelView` 接口从 `WaveCanvas.vue` 抽到 `src/lib/channels.ts`，
  `WaveCanvas.vue` 改为从该模块 re-export（保持既有导入不破坏）。
- `App.vue` 增加 `renderer: Ref<"2d" | "gl">`，控制面板（时基旁）新增一组
  切换按钮，用 `<component :is>` 在 `WaveCanvas` / `WaveGL` 间切换。
  图例、fps 上报、采集控制逻辑不变。

## WebGL 渲染管线（每帧 rAF）

1. **数据路径与 2D 版一致**：仍用 `computeMinMax` 得到每列 `(min, max)`；
   CPU 侧组装顶点（每列 2 个顶点，clip space 坐标），一次 `bufferData`
   上传动态 VBO，每个可见通道一个 draw call（`gl.LINES`，线宽 1px）。
2. **网格**：同一套 GL 线段着色器，另一组静态顶点 + 灰色 uniform。
3. **余辉（ping-pong framebuffer）**：两张纹理交替作为目标。每帧先把上一帧
   纹理以 `alpha × 0.97` 画进当前 framebuffer（对应 2D 版每帧 3% 衰减），
   再以低 alpha（约 0.35，对齐 2D 版）叠画当前波形；屏幕合成顺序为
   余辉纹理 → 网格 → 当前帧亮线。关闭余辉时跳过 framebuffer，直接画到
   屏幕（余辉纹理同时清空，避免重开后残留）。
4. **尺寸/DPR**：与 2D 版相同，`devicePixelRatio` 缩放 backing store，
   resize 时重建 framebuffer 纹理。

## 错误处理

`getContext("webgl2")` 返回 null 时，`WaveGL` emit `fallback` 事件，App.vue
收到后自动切回 Canvas2D 并禁用（置灰）WebGL 按钮。

## 测试策略

GL 调用本身不可单测；纯逻辑抽为 `src/lib/glbuf.ts` 纯函数并用 vitest 覆盖：

- `buildTraceVertices(mm, plotW, plotH)`：min/max 列 → clip space 顶点数组
  （长度、坐标范围、mn===mx 退化列行为）。
- `buildGridVertices(plotW, plotH)`：网格线顶点数量与位置。

组件层面：`npm run build` 通过 + 手动在两种模式间切换，对比波形一致性、
余辉效果与帧率。

## 不做的事（YAGNI）

- 不引入 WebGL 框架或依赖。
- 不做 WebGL1 降级（webview 均支持 WebGL2，失败即整体回退 2D）。
- 不改变数据采集、环形缓冲与 `computeMinMax` 管线。
