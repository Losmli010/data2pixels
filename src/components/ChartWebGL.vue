<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { computeMinMax } from '../lib/minmax';
import { buildTraceVertices, buildGridVertices, hexToRgb } from '../lib/glbuf';
import type { ChannelView } from '../lib/channels';
import { timebaseToSamples } from '../lib/timebase';

const props = defineProps<{
  channels: ChannelView[];
  timebaseMs: number;
  sampleRateHz?: number;
  persistence: boolean;
}>();

const emit = defineEmits<{ fps: [number]; 'gpu-load': [number]; fallback: [] }>();

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
let gpuMs = 0;
let gpuFrames = 0;
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
precision highp float;
uniform vec4 u_color;
out vec4 o_color;
void main() { o_color = vec4(u_color.rgb * u_color.a, u_color.a); }`;

const VS_TEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() { v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS_TEX = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform float u_premultiply; // 1.0 = 衰减 pass：rgb/a 同乘 u_alpha；0.0 = 合成 pass：原样透传
in vec2 v_uv;
out vec4 o_color;
void main() {
  vec4 c = texture(u_tex, v_uv);
  vec4 decayed = vec4(c.rgb * u_alpha, c.a * u_alpha);
  o_color = mix(vec4(c.rgb, c.a), decayed, u_premultiply);
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
  gl.uniform4f(gl.getUniformLocation(progLines, 'u_color'), rgb[0], rgb[1], rgb[2], alpha);
  gl.drawArrays(gl.LINES, 0, verts.length / 2);
}

function drawGrid() {
  if (!gl || !progLines || !vaoGrid) return;
  gl.useProgram(progLines);
  gl.bindVertexArray(vaoGrid);
  gl.uniform4f(gl.getUniformLocation(progLines, 'u_color'), 0.5, 0.5, 0.5, 0.25);
  gl.drawArrays(gl.LINES, 0, gridVertCount);
}

function drawTexture(t: Target, alpha: number, premultiply: boolean) {
  if (!gl || !progTex || !vaoQuad) return;
  gl.useProgram(progTex);
  gl.bindVertexArray(vaoQuad);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, t.tex);
  gl.uniform1i(gl.getUniformLocation(progTex, 'u_tex'), 0);
  gl.uniform1f(gl.getUniformLocation(progTex, 'u_alpha'), alpha);
  gl.uniform1f(gl.getUniformLocation(progTex, 'u_premultiply'), premultiply ? 1.0 : 0.0);
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
  const t0 = performance.now();

  const sampleNow = props.channels.reduce((max, ch) => Math.max(max, ch.samples.count - 1), -1);
  const winStart = Math.max(
    0,
    sampleNow - timebaseToSamples(props.timebaseMs, props.sampleRateHz ?? 1000) + 1,
  );

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
    // 衰减 pass：加法混合，配 FS_TEX 预乘输出得 dst = prev * 0.97（rgb 与 a 同乘），
    // 精确等价 2D 版 destination-out
    gl.blendFunc(gl.ONE, gl.ONE);
    drawTexture(persFront, PERSIST_DECAY, true);
    // 后续绘制恢复预乘 over
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // 2. 低亮叠加当前波形
    for (const t of traces) drawTrace(t.verts, t.rgb, PERSIST_ALPHA);
    // 3. 交换，刚写的内容成为下一帧的"上一帧"
    const tmp = persFront;
    persFront = persBack;
    persBack = tmp;
    // 4. 合成到屏幕：余辉 → 网格 → 当前帧亮线
    clearScreen();
    drawTexture(persFront, 1.0, false);
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

  gpuMs += performance.now() - t0;
  gpuFrames++;
  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    emit('fps', Math.round((fpsFrames * 1000) / (now - fpsLast)));
    // GPU 估算：每帧渲染耗时占 16.7ms 帧预算的比例，clamp 0-100
    const avgMs = gpuFrames > 0 ? gpuMs / gpuFrames : 0;
    emit('gpu-load', Math.min(100, Math.round((avgMs / 16.7) * 100)));
    fpsFrames = 0;
    gpuMs = 0;
    gpuFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(render);
}

onMounted(() => {
  const c = mainCanvas.value;
  if (!c) return;
  gl = c.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
  if (!gl) {
    emit('fallback');
    return;
  }
  progLines = compile(VS_LINES, FS_LINES);
  progTex = compile(VS_TEX, FS_TEX);
  if (!progLines || !progTex) {
    emit('fallback');
    return;
  }

  const setupVao = (vao: WebGLVertexArrayObject, vbo: WebGLBuffer) => {
    gl!.bindVertexArray(vao);
    gl!.bindBuffer(gl!.ARRAY_BUFFER, vbo);
    gl!.enableVertexAttribArray(0);
    gl!.vertexAttribPointer(0, 2, gl!.FLOAT, false, 0, 0);
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
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  sizePlot();
  fpsLast = performance.now();
  raf = requestAnimationFrame(render);
  window.addEventListener('resize', sizePlot);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', sizePlot);
  gl?.getExtension('WEBGL_lose_context')?.loseContext();
});
</script>

<template>
  <div ref="wrapRef" class="wave-wrap">
    <canvas ref="mainCanvas" class="wave-canvas"></canvas>
    <div class="channel-legend">
      <span v-if="persistence" class="legend-item persist">▒ 余辉叠加</span>
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
