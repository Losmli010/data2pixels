<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { computeMinMax, type MinMax } from '../lib/minmax';
import type { ChannelView } from '../lib/channels';
import { timebaseToSamples } from '../lib/timebase';

export type { ChannelView };

const props = defineProps<{
  channels: ChannelView[];
  timebaseMs: number;
  sampleRateHz?: number;
  persistence: boolean;
}>();

const emit = defineEmits<{ fps: [number] }>();

const wrapRef = ref<HTMLDivElement | null>(null);
const mainCanvas = ref<HTMLCanvasElement | null>(null);

const Y_RANGE: [number, number] = [-1.5, 1.5];
let dpr = 1;
let plotW = 0;
let plotH = 0;
let raf = 0;
let persistCanvas: HTMLCanvasElement | null = null;
let persistCtx: CanvasRenderingContext2D | null = null;
let fpsFrames = 0;
let fpsLast = 0;

function sizePlot() {
  const el = wrapRef.value;
  if (!el) return;
  dpr = window.devicePixelRatio || 1;
  plotW = Math.max(100, Math.floor(el.clientWidth));
  plotH = Math.max(100, Math.floor(el.clientHeight));
  const c = mainCanvas.value!;
  c.width = plotW * dpr;
  c.height = plotH * dpr;
  c.style.width = `${plotW}px`;
  c.style.height = `${plotH}px`;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!persistCanvas) {
    persistCanvas = document.createElement('canvas');
    persistCtx = persistCanvas.getContext('2d');
  }
  persistCanvas.width = plotW * dpr;
  persistCanvas.height = plotH * dpr;
  persistCtx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function valueToY(v: number): number {
  const [lo, hi] = Y_RANGE;
  return plotH * (1 - (v - lo) / (hi - lo));
}

function drawGrid(ctx: CanvasRenderingContext2D) {
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const xSteps = 10;
  for (let i = 0; i <= xSteps; i++) {
    const x = (i / xSteps) * plotW;
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, plotH);
  }
  const [lo, hi] = Y_RANGE;
  for (let v = Math.ceil(lo); v <= hi; v += 1) {
    const y = valueToY(v);
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(plotW, y + 0.5);
  }
  ctx.stroke();
}

function drawTrace(ctx: CanvasRenderingContext2D, mm: MinMax[], color: string) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < mm.length; x++) {
    const [mn, mx] = mm[x];
    const y1 = valueToY(mx);
    const y2 = valueToY(mn);
    if (mn === mx) {
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y1 + 1);
    } else {
      ctx.moveTo(x + 0.5, y1);
      ctx.lineTo(x + 0.5, y2);
    }
  }
  ctx.stroke();
}

function render() {
  const c = mainCanvas.value;
  const ctx = c?.getContext('2d');
  if (!ctx) return;

  const sampleNow = props.channels.reduce((max, ch) => Math.max(max, ch.samples.count - 1), -1);
  const winStart = Math.max(
    0,
    sampleNow - timebaseToSamples(props.timebaseMs, props.sampleRateHz ?? 1000) + 1,
  );

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, plotW, plotH);

  if (props.persistence && persistCtx && persistCanvas) {
    const pc = persistCtx;
    pc.globalCompositeOperation = 'destination-out';
    pc.fillStyle = 'rgba(0,0,0,0.03)';
    pc.fillRect(0, 0, plotW, plotH);
    pc.globalCompositeOperation = 'source-over';
    for (const ch of props.channels) {
      if (!ch.visible || ch.samples.count === 0) continue;
      const mm = computeMinMax(ch.samples.atGlobal.bind(ch.samples), winStart, sampleNow, plotW);
      pc.globalAlpha = 0.35;
      drawTrace(pc, mm, ch.color);
    }
    ctx.drawImage(persistCanvas, 0, 0, plotW, plotH);
  } else {
    if (persistCtx && persistCanvas) {
      persistCtx.clearRect(0, 0, plotW, plotH);
    }
  }

  drawGrid(ctx);

  if (sampleNow >= 0) {
    for (const ch of props.channels) {
      if (!ch.visible || ch.samples.count === 0) continue;
      const mm = computeMinMax(ch.samples.atGlobal.bind(ch.samples), winStart, sampleNow, plotW);
      drawTrace(ctx, mm, ch.color);
    }
  }

  fpsFrames++;
  const now = performance.now();
  if (now - fpsLast >= 1000) {
    emit('fps', Math.round((fpsFrames * 1000) / (now - fpsLast)));
    fpsFrames = 0;
    fpsLast = now;
  }
  raf = requestAnimationFrame(render);
}

onMounted(() => {
  sizePlot();
  fpsLast = performance.now();
  raf = requestAnimationFrame(render);
  window.addEventListener('resize', sizePlot);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', sizePlot);
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
