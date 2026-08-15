# WebGL 渲染模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增与 Canvas2D 并存、可切换的 WebGL2 波形渲染模式，含 GPU 余辉。

**Architecture:** 复用现有 `computeMinMax` 降采样管线；新建 `WaveGL.vue` 组件（props/emits 与 `WaveCanvas.vue` 一致）用原生 WebGL2 绘制线段，余辉用双 framebuffer 纹理 ping-pong 衰减实现；`App.vue` 加渲染模式切换与 WebGL 不可用回退。

**Tech Stack:** Vue 3 `<script setup>` + TypeScript、原生 WebGL2（零新增依赖）、vitest。

**Spec:** `docs/superpowers/specs/2026-08-15-webgl-render-mode-design.md`

## Global Constraints

- 不新增任何 npm 依赖。
- 不修改 `src/lib/ring.ts` 与 `src/lib/minmax.ts` 的现有行为。
- `WaveGL.vue` 的 props（`channels: ChannelView[]` / `timebaseMs: number` / `persistence: boolean`）与 emits（`fps`）必须与 `WaveCanvas.vue` 完全一致。
- Y 轴范围固定 `[-1.5, 1.5]`；余辉每帧衰减系数 0.97（对应 2D 版 3% `destination-out`），余辉叠加 alpha 0.35。
- 波形线宽 1px，视觉与 Canvas2D 版对齐。
- 每个任务结束必须 `npm test`（全量）通过；涉及组件的任务还需 `npm run build`（含 vue-tsc 类型检查）通过。
- 工作目录：`/Users/losmli/Codes/codex-workspace/scope-wave-demo`（下文相对路径均基于此）。

---

### Task 1: 抽取 ChannelView 到共享模块

**Files:**
- Create: `src/lib/channels.ts`
- Modify: `src/components/WaveCanvas.vue:1-12`

**Interfaces:**
- Consumes: `SampleWindow`（`src/lib/ring.ts`，已有）。
- Produces: `src/lib/channels.ts` 导出 `interface ChannelView { id: string; label: string; color: string; samples: SampleWindow; visible: boolean }`。Task 3/4 依赖此类型；`WaveCanvas.vue` 继续 re-export，`App.vue` 现有导入不动。

- [ ] **Step 1: 创建 `src/lib/channels.ts`**

```ts
import type { SampleWindow } from "./ring";

export interface ChannelView {
  id: string;
  label: string;
  color: string;
  samples: SampleWindow;
  visible: boolean;
}
```

- [ ] **Step 2: 修改 `WaveCanvas.vue`**

把第 1-12 行的：

```ts
import { onMounted, onBeforeUnmount, ref } from "vue";
import { computeMinMax, type MinMax } from "../lib/minmax";
import type { SampleWindow } from "../lib/ring";

export interface ChannelView {
  id: string;
  label: string;
  color: string;
  samples: SampleWindow;
  visible: boolean;
}
```

改为：

```ts
import { onMounted, onBeforeUnmount, ref } from "vue";
import { computeMinMax, type MinMax } from "../lib/minmax";
import type { ChannelView } from "../lib/channels";

export type { ChannelView };
```

- [ ] **Step 3: 验证**

Run: `npm test && npm run build`
Expected: 全部单测 PASS，vue-tsc 与构建无错误。

- [ ] **Step 4: Commit**

```bash
git add src/lib/channels.ts src/components/WaveCanvas.vue
git commit -m "refactor: ChannelView 接口抽取到 lib/channels 共享"
```

---

### Task 2: glbuf 纯函数（顶点组装）

**Files:**
- Create: `src/lib/glbuf.ts`
- Test: `src/lib/glbuf.test.ts`

**Interfaces:**
- Consumes: `MinMax`（`src/lib/minmax.ts`，`export type MinMax = [number, number]`）。
- Produces（Task 3 依赖）:
  - `Y_RANGE: [number, number]`（值为 `[-1.5, 1.5]`）
  - `buildTraceVertices(mm: MinMax[], plotW: number, plotH: number): Float32Array` — 每列 4 个 float（两顶点 x,y 交错，clip space），`mn === mx` 时第二顶点向下 1px。
  - `buildGridVertices(plotW: number, plotH: number): Float32Array` — 11 条竖线 + 3 条横线（v = -1, 0, 1），线段端点 clip space 交错。
  - `hexToRgb(hex: string): [number, number, number]` — `#rrggbb` → 0..1 归一化，非法输入返回 `[1, 1, 1]`。

- [ ] **Step 1: 写失败测试 `src/lib/glbuf.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { buildGridVertices, buildTraceVertices, hexToRgb } from "./glbuf";

describe("buildTraceVertices", () => {
  it("空列返回空数组", () => {
    expect(buildTraceVertices([], 100, 100).length).toBe(0);
  });

  it("每列产生 2 个顶点共 4 个 float", () => {
    const v = buildTraceVertices(
      [
        [0, 1],
        [-1, 1],
      ],
      200,
      100,
    );
    expect(v.length).toBe(8);
  });

  it("min/max 正确映射到 clip space（y 轴翻转）", () => {
    // plotH=100, Y_RANGE=[-1.5,1.5]：v=1 → yPix=50/3，v=-1 → yPix=250/3
    const v = buildTraceVertices([[-1, 1]], 100, 100);
    expect(v[0]).toBeCloseTo(-0.99); // x = (0.5/100)*2-1
    expect(v[1]).toBeCloseTo(1 - 2 * (50 / 3) / 100); // 顶点：v=1
    expect(v[2]).toBe(-0.99);
    expect(v[3]).toBeCloseTo(1 - 2 * (250 / 3) / 100); // 底点：v=-1
    expect(v[3]).toBeLessThan(v[1]); // min 在下
  });

  it("mn===mx 退化为向下 1px 竖线", () => {
    const v = buildTraceVertices([[0, 0]], 100, 100);
    expect(v[1]).toBeCloseTo(v[3] + 2 / 100); // 第二顶点低 1px
  });
});

describe("buildGridVertices", () => {
  it("11 条竖线 + 3 条横线（v=-1,0,1）共 14 条线段", () => {
    expect(buildGridVertices(800, 360).length).toBe(14 * 4);
  });

  it("首条竖线位于左边缘，贯穿上下", () => {
    const v = buildGridVertices(800, 360);
    expect(v[0]).toBeCloseTo((0.5 / 800) * 2 - 1);
    expect(v[1]).toBe(1);
    expect(v[3]).toBe(-1);
  });
});

describe("hexToRgb", () => {
  it("解析 #rrggbb 为 0..1 归一化", () => {
    expect(hexToRgb("#24c8db")).toEqual([
      0x24 / 255,
      0xc8 / 255,
      0xdb / 255,
    ]);
  });

  it("非法输入返回白色", () => {
    expect(hexToRgb("red")).toEqual([1, 1, 1]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/glbuf.test.ts`
Expected: FAIL（模块 `./glbuf` 不存在）。

- [ ] **Step 3: 实现 `src/lib/glbuf.ts`**

```ts
import type { MinMax } from "./minmax";

export const Y_RANGE: [number, number] = [-1.5, 1.5];

function clipX(xPix: number, plotW: number): number {
  return (xPix / plotW) * 2 - 1;
}

function clipY(yPix: number, plotH: number): number {
  return 1 - (yPix / plotH) * 2;
}

function pixelY(v: number, plotH: number): number {
  const [lo, hi] = Y_RANGE;
  return plotH * (1 - (v - lo) / (hi - lo));
}

/** 每列 (min,max) → clip space 竖线段顶点对；mn===mx 时画 1px 竖线 */
export function buildTraceVertices(
  mm: MinMax[],
  plotW: number,
  plotH: number,
): Float32Array {
  const out = new Float32Array(mm.length * 4);
  for (let col = 0; col < mm.length; col++) {
    const [mn, mx] = mm[col];
    const x = clipX(col + 0.5, plotW);
    const yTop = pixelY(mx, plotH);
    const yBottom = mn === mx ? yTop + 1 : pixelY(mn, plotH);
    out[col * 4 + 0] = x;
    out[col * 4 + 1] = clipY(yTop, plotH);
    out[col * 4 + 2] = x;
    out[col * 4 + 3] = clipY(yBottom, plotH);
  }
  return out;
}

/** 与 2D 版网格一致：10 分度竖线 + v=-1..1 每格 1 条横线 */
export function buildGridVertices(plotW: number, plotH: number): Float32Array {
  const xs: number[] = [];
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    xs.push(clipX(x1, plotW), clipY(y1, plotH), clipX(x2, plotW), clipY(y2, plotH));
  };
  for (let i = 0; i <= 10; i++) {
    const x = (i / 10) * plotW + 0.5;
    push(x, 0, x, plotH);
  }
  const [lo, hi] = Y_RANGE;
  for (let v = Math.ceil(lo); v <= hi; v += 1) {
    const y = pixelY(v, plotH);
    push(0, y + 0.5, plotW, y + 0.5);
  }
  return new Float32Array(xs);
}

/** #rrggbb → [r,g,b] 归一化 0..1；非法输入返回白色 */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/glbuf.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/lib/glbuf.ts src/lib/glbuf.test.ts
git commit -m "feat: glbuf 顶点组装纯函数 + 单测"
```

---

### Task 3: WaveGL.vue 组件

**Files:**
- Create: `src/components/WaveGL.vue`

**Interfaces:**
- Consumes: `ChannelView`（Task 1）、`computeMinMax`（`src/lib/minmax.ts`）、`buildTraceVertices` / `buildGridVertices` / `hexToRgb`（Task 2）。
- Produces: 默认导出 Vue 组件，props `channels` / `timebaseMs` / `persistence`，emits `fps: [number]` 与 `fallback: []`（webgl2 不可用时触发一次）。Task 4 依赖。

GL 调用无法单测，本任务验证方式为 `npm run build`（vue-tsc 类型检查）+ 全量单测不回归。

- [ ] **Step 1: 创建 `src/components/WaveGL.vue`**

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { computeMinMax } from "../lib/minmax";
import { buildTraceVertices, buildGridVertices, hexToRgb } from "../lib/glbuf";
import type { ChannelView } from "../lib/channels";

const props = defineProps<{
  channels: ChannelView[];
  timebaseMs: number;
  persistence: boolean;
}>();

const emit = defineEmits<{ fps: [number]; fallback: [] }>();

const wrapRef = ref<HTMLDivElement | null>(null);
const mainCanvas = ref<HTMLCanvasElement | null>(null);

// 对齐 2D 版：每帧 3% destination-out ≈ 0.97 alpha；余辉叠加 alpha 0.35
const PERSIST_DECAY = 0.97;
const PERSIST_ALPHA = 0.35;

type Target = { tex: WebGLTexture; fb: WebGLFramebuffer };

let gl: WebGL2RenderingContext | null = null;
let dpr = 1;
let plotW = 0;
let plotH = 0;
let raf = 0;
let fpsFrames = 0;
let fpsLast = 0;
let persistDirty = false;

let progLines: WebGLProgram | null = null;
let progTex: WebGLProgram | null = null;
let vaoTrace: WebGLVertexArrayObject | null = null;
let vboTrace: WebGLBuffer | null = null;
let vaoGrid: WebGLVertexArrayObject | null = null;
let vboGrid: WebGLBuffer | null = null;
let gridVertCount = 0;
let vaoQuad: WebGLVertexArrayObject | null = null;
let vboQuad: WebGLBuffer | null = null;
let persFront: Target | null = null;
let persBack: Target | null = null;

const VS_LINES = `#version 300 es
layout(location = 0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS_LINES = `#version 300 es
precision mediump float;
uniform vec4 u_color;
out vec4 o_color;
void main() { o_color = u_color; }`;

const VS_TEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS_TEX = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_alpha;
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 c = texture(u_tex, v_uv);
  o_color = vec4(c.rgb, c.a * u_alpha);
}`;

function compile(vsSrc: string, fsSrc: string): WebGLProgram | null {
  if (!gl) return null;
  const mk = (type: number, src: string): WebGLShader | null => {
    const sh = gl!.createShader(type)!;
    gl!.shaderSource(sh, src);
    gl!.compileShader(sh);
    if (!gl!.getShaderParameter(sh, gl!.COMPILE_STATUS)) {
      console.error(gl!.getShaderInfoLog(sh));
      return null;
    }
    return sh;
  };
  const vs = mk(gl.VERTEX_SHADER, vsSrc);
  const fs = mk(gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

function makeTarget(w: number, h: number): Target | null {
  if (!gl) return null;
  const tex = gl.createTexture();
  if (!tex) return null;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  if (!fb) return null;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return { tex, fb };
}

function destroyTarget(t: Target | null) {
  if (!gl || !t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fb);
}

function sizePlot() {
  const el = wrapRef.value;
  const c = mainCanvas.value;
  if (!el || !c || !gl) return;
  dpr = window.devicePixelRatio || 1;
  plotW = Math.max(100, Math.floor(el.clientWidth));
  plotH = Math.max(100, Math.floor(el.clientHeight));
  c.width = plotW * dpr;
  c.height = plotH * dpr;
  c.style.width = `${plotW}px`;
  c.style.height = `${plotH}px`;

  destroyTarget(persFront);
  destroyTarget(persBack);
  persFront = makeTarget(plotW * dpr, plotH * dpr);
  persBack = makeTarget(plotW * dpr, plotH * dpr);
  persistDirty = false;

  if (vaoGrid && vboGrid) {
    gl.bindVertexArray(vaoGrid);
    gl.bindBuffer(gl.ARRAY_BUFFER, vboGrid);
    const grid = buildGridVertices(plotW, plotH);
    gl.bufferData(gl.ARRAY_BUFFER, grid, gl.STATIC_DRAW);
    gridVertCount = grid.length / 2;
  }
}

function drawTrace(verts: Float32Array, rgb: [number, number, number], alpha: number) {
  if (!gl || !progLines || !vaoTrace || !vboTrace) return;
  gl.useProgram(progLines);
  gl.bindVertexArray(vaoTrace);
  gl.bindBuffer(gl.ARRAY_BUFFER, vboTrace);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.uniform4f(gl.getUniformLocation(progLines, "u_color"), rgb[0], rgb[1], rgb[2], alpha);
  gl.drawArrays(gl.LINES, 0, verts.length / 2);
}

function drawGrid() {
  if (!gl || !progLines || !vaoGrid) return;
  gl.useProgram(progLines);
  gl.bindVertexArray(vaoGrid);
  gl.uniform4f(gl.getUniformLocation(progLines, "u_color"), 0.5, 0.5, 0.5, 0.25);
  gl.drawArrays(gl.LINES, 0, gridVertCount);
}

function drawTexture(t: Target, alpha: number) {
  if (!gl || !progTex || !vaoQuad) return;
  gl.useProgram(progTex);
  gl.bindVertexArray(vaoQuad);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.uniform1i(gl.getUniformLocation(progTex, "u_tex"), 0);
  gl.uniform1f(gl.getUniformLocation(progTex, "u_alpha"), alpha);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function clearScreen() {
  if (!gl) return;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, plotW * dpr, plotH * dpr);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function render() {
  if (!gl) return;

  const sampleNow = props.channels.reduce(
    (max, ch) => Math.max(max, ch.samples.count - 1),
    -1,
  );
  const winStart = Math.max(0, sampleNow - props.timebaseMs + 1);

  const traces: { verts: Float32Array; rgb: [number, number, number] }[] = [];
  if (sampleNow >= 0) {
    for (const ch of props.channels) {
      if (!ch.visible || ch.samples.count === 0) continue;
      const mm = computeMinMax(ch.samples.atGlobal.bind(ch.samples), winStart, sampleNow, plotW);
      traces.push({ verts: buildTraceVertices(mm, plotW, plotH), rgb: hexToRgb(ch.color) });
    }
  }

  if (props.persistence && persFront && persBack) {
    persistDirty = true;
    // 1. 衰减：上一帧余辉纹理以 0.97 alpha 画进当前目标
    gl.bindFramebuffer(gl.FRAMEBUFFER, persBack.fb);
    gl.viewport(0, 0, plotW * dpr, plotH * dpr);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawTexture(persFront, PERSIST_DECAY);
    // 2. 低亮叠加当前波形
    for (const t of traces) drawTrace(t.verts, t.rgb, PERSIST_ALPHA);
    // 3. 交换，刚写的内容成为下一帧的"上一帧"
    const tmp = persFront;
    persFront = persBack;
    persBack = tmp;
    // 4. 合成到屏幕：余辉 → 网格 → 当前帧亮线
    clearScreen();
    drawTexture(persFront, 1.0);
    drawGrid();
    for (const t of traces) drawTrace(t.verts, t.rgb, 1.0);
  } else {
    // 关闭余辉后清空纹理一次，避免重开时残留旧轨迹
    if (persistDirty && persFront && persBack) {
      for (const t of [persFront, persBack]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
        gl.viewport(0, 0, plotW * dpr, plotH * dpr);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      persistDirty = false;
    }
    clearScreen();
    drawGrid();
    for (const t of traces) drawTrace(t.verts, t.rgb, 1.0);
  }

  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    emit("fps", Math.round((fpsFrames * 1000) / (now - fpsLast)));
    fpsFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(render);
}

onMounted(() => {
  const c = mainCanvas.value;
  if (!c) return;
  gl = c.getContext("webgl2", { alpha: true, premultipliedAlpha: false });
  if (!gl) {
    emit("fallback");
    return;
  }
  progLines = compile(VS_LINES, FS_LINES);
  progTex = compile(VS_TEX, FS_TEX);
  if (!progLines || !progTex) {
    emit("fallback");
    return;
  }

  const setupVao = (vao: WebGLVertexArrayObject, vbo: WebGLBuffer) => {
    gl!.bindVertexArray(vao);
    gl!.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  };

  vaoTrace = gl.createVertexArray();
  vboTrace = gl.createBuffer();
  setupVao(vaoTrace!, vboTrace!);

  vaoGrid = gl.createVertexArray();
  vboGrid = gl.createBuffer();
  setupVao(vaoGrid!, vboGrid!);

  vaoQuad = gl.createVertexArray();
  vboQuad = gl.createBuffer();
  setupVao(vaoQuad!, vboQuad!);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW,
  );

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  sizePlot();
  fpsLast = performance.now();
  raf = requestAnimationFrame(render);
  window.addEventListener("resize", sizePlot);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener("resize", sizePlot);
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
});
</script>

<template>
  <div ref="wrapRef" class="wave-wrap">
    <canvas ref="mainCanvas" class="wave-canvas"></canvas>
    <div class="channel-legend">
      <span
        v-for="ch in channels.filter((c) => c.visible)"
        :key="ch.id"
        class="legend-item"
        :style="{ color: ch.color }"
      >
        ■ {{ ch.label }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.wave-wrap {
  position: relative;
  width: 100%;
  height: 360px;
  background: #0b0e14;
  border-radius: 8px;
  overflow: hidden;
}
.wave-canvas {
  position: absolute;
  inset: 0;
  display: block;
}
.channel-legend {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  gap: 12px;
  font-size: 12px;
  background: rgba(0, 0, 0, 0.5);
  padding: 4px 8px;
  border-radius: 4px;
}
</style>
```

- [ ] **Step 2: 验证**

Run: `npm test && npm run build`
Expected: 全部单测 PASS，vue-tsc 与构建无错误。

- [ ] **Step 3: Commit**

```bash
git add src/components/WaveGL.vue
git commit -m "feat: WaveGL WebGL2 波形渲染组件（ping-pong 余辉）"
```

---

### Task 4: App.vue 集成渲染模式切换 + WebGL 回退

**Files:**
- Modify: `src/App.vue`（script 第 2-32 行区域、template 第 119-132 行时基控制组之后、第 143-148 行 `<WaveCanvas>` 处、style）

**Interfaces:**
- Consumes: `WaveGL`（Task 3，emits `fallback`）、`WaveCanvas`（已有）。
- Produces: 无下游依赖，最终用户界面。

- [ ] **Step 1: 修改 script**

第 5 行 `import WaveCanvas, { type ChannelView } ...` 保持不变，其后新增导入与状态：

```ts
import WaveGL from "./components/WaveGL.vue";
```

在 `const timebaseMs = ref(5000);` 附近新增：

```ts
const renderer = ref<"2d" | "gl">("2d");
const glAvailable = ref(true);
```

在 `toggleRunning` 前新增：

```ts
function onGlFallback() {
  renderer.value = "2d";
  glAvailable.value = false;
}
```

- [ ] **Step 2: 修改 template**

在时基 `control-group`（`...时基按钮...</div>`）之后插入：

```html
<div class="control-group">
  <span class="label">渲染</span>
  <button
    class="btn small"
    :class="{ active: renderer === '2d' }"
    @click="renderer = '2d'"
  >
    Canvas2D
  </button>
  <button
    class="btn small"
    :class="{ active: renderer === 'gl' }"
    :disabled="!glAvailable"
    @click="renderer = 'gl'"
  >
    WebGL
  </button>
</div>
```

把 `<WaveCanvas ... />`（第 143-148 行）替换为：

```html
<component
  :is="renderer === 'gl' ? WaveGL : WaveCanvas"
  :channels="channels"
  :timebase-ms="timebaseMs"
  :persistence="persistence"
  @fps="fps = $event"
  @fallback="onGlFallback"
/>
```

- [ ] **Step 3: style 增加禁用态**

在 `.btn.on, .btn.active { ... }` 规则之后追加：

```css
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: #333;
  color: #888;
}
```

- [ ] **Step 4: 验证**

Run: `npm test && npm run build`
Expected: 全部单测 PASS，vue-tsc 与构建无错误。

- [ ] **Step 5: Commit**

```bash
git add src/App.vue
git commit -m "feat: App 集成 Canvas2D/WebGL 渲染模式切换与回退"
```

---

### Task 5: README 更新与全量验证

**Files:**
- Modify: `README.md:5-7`（架构描述）

**Interfaces:**
- Consumes: 全部前序任务成果。
- Produces: 无。

- [ ] **Step 1: 更新 README 架构行**

把：

```markdown
- 架构：Rust 1kHz 模拟 3 通道信号 → 20ms 攒批 `wave-data` 事件推送
  → 前端环形缓冲 → Canvas min/max 峰值检测绘制 → 余辉叠加
```

改为：

```markdown
- 架构：Rust 1kHz 模拟 3 通道信号 → 20ms 攒批 `wave-data` 事件推送
  → 前端环形缓冲 → min/max 峰值检测 → 渲染层双模式可切换：
  Canvas2D（逐列竖线 + destination-out 余辉）或
  WebGL2（`gl.LINES` + framebuffer ping-pong 余辉，不可用时自动回退）
```

- [ ] **Step 2: 全量验证**

Run: `npm test && npm run build`
Expected: 全部单测 PASS（ring / minmax / glbuf），构建无错误。

- [ ] **Step 3: 手动冒烟（可选，如环境支持 GUI）**

Run: `npm run tauri dev`
检查：渲染按钮切换 Canvas2D/WebGL 波形一致；WebGL 模式余辉开关生效且关闭后再开无残影；切换通道/时基正常；fps 显示正常。

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: README 补充 WebGL 渲染模式说明"
```
