<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, shallowRef, triggerRef, watch } from 'vue';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import ChartCanvas, { type ChannelView } from './components/ChartCanvas.vue';
import ChartWebGL from './components/ChartWebGL.vue';
import ChartSVG from './components/ChartSVG.vue';
import { SampleWindow } from './lib/ring.ts';
import { timebaseToSamples } from './lib/timebase.ts';

const CAPACITY = 200_000;

const channels = shallowRef<ChannelView[]>([
  {
    id: 'sine',
    label: '正弦+噪声',
    color: '#24c8db',
    samples: new SampleWindow(CAPACITY),
    visible: true,
  },
  {
    id: 'pulse',
    label: '方波脉冲',
    color: '#f5a623',
    samples: new SampleWindow(CAPACITY),
    visible: true,
  },
  {
    id: 'trend',
    label: '腔体趋势',
    color: '#9b59b6',
    samples: new SampleWindow(CAPACITY),
    visible: true,
  },
]);

const running = ref(false);
const paused = ref(false);
const persistence = ref(true);
const timebaseMs = ref(5000);
const sampleRateHz = ref(1000);
const batchMs = ref(20);
const acqError = ref('');
const sineP = ref({ freqHz: 5, amp: 1.0, noise: 0.15 });
const pulseP = ref({ freqHz: 1, duty: 0.5, amp: 1.0, jitter: 0.15 });
// 对数滑条绑定 log10 值（v-model 持续回写，拖动才跟手），松手再换算回 Hz
const sineFreqLog = ref(Math.log10(5));
const pulseFreqLog = ref(Math.log10(1));
const trendP = ref({ amp: 1.0, noise: 0.05 });
const renderer = ref<'2d' | 'gl'>('2d');
const glAvailable = ref(true);
const fps = ref(0);
const received = ref(0);
const dropped = ref(0);
const lastSeq = ref(-1);

const gpuLoad = ref<number | null>(null);
// gpu-load 的"到达"时间戳：值可能连续多秒不变（取整后恒值，如空闲时恒 0），
// 时效判断必须基于到达而非 prop 变化，故由模板在每次事件到达时刷新
const gpuLoadAt = ref(0);
// 切到 Canvas2D（或 WebGL 回退）后 WaveGL 卸载，估算值失效，置空让 GPU 曲线断开
watch(renderer, () => {
  gpuLoad.value = null;
});

const TIMEBASES = [
  { label: '100µs', value: 0.1 },
  { label: '1ms', value: 1 },
  { label: '10ms', value: 10 },
  { label: '100ms', value: 100 },
  { label: '1s', value: 1000 },
  { label: '2s', value: 2000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: '30s', value: 30000 },
];

let unlisten: UnlistenFn | null = null;

onMounted(async () => {
  unlisten = await listen('wave-data', (e) => {
    if (paused.value) return;
    const frame = e.payload as {
      seq: number;
      channels: { id: string; samples: number[] }[];
    };
    if (lastSeq.value >= 0 && frame.seq !== lastSeq.value + 1) {
      dropped.value++;
    }
    lastSeq.value = frame.seq;
    for (const ch of frame.channels) {
      const view = channels.value.find((c) => c.id === ch.id);
      if (view) view.samples.pushMany(ch.samples);
    }
    received.value += frame.channels.reduce((a, c) => a + c.samples.length, 0);
  });
  running.value = true;
});

onBeforeUnmount(() => {
  unlisten?.();
});

function onGlFallback() {
  renderer.value = '2d';
  glAvailable.value = false;
}

async function toggleRunning() {
  if (running.value) {
    await invoke('stop_acq');
    running.value = false;
  } else {
    await invoke('start_acq');
    running.value = true;
  }
}

function toggleChannel(id: string) {
  const ch = channels.value.find((c) => c.id === id);
  if (ch) ch.visible = !ch.visible;
  triggerRef(channels);
}

function clearBuffers() {
  for (const ch of channels.value) ch.samples.clear();
  received.value = 0;
  dropped.value = 0;
  lastSeq.value = -1;
}

const depthLimited = () => timebaseToSamples(timebaseMs.value, sampleRateHz.value) > CAPACITY;

async function pushAcqConfig() {
  acqError.value = '';
  try {
    await invoke('set_acq_config', {
      config: {
        sampleRateHz: sampleRateHz.value,
        batchMs: batchMs.value,
        sine: sineP.value,
        pulse: pulseP.value,
        trend: trendP.value,
      },
    });
  } catch (e) {
    acqError.value = String(e);
  }
}

function onSineFreqChange() {
  sineP.value.freqHz = hzFromLog(sineFreqLog.value);
  pushAcqConfig();
}
function onPulseFreqChange() {
  pulseP.value.freqHz = hzFromLog(pulseFreqLog.value);
  pushAcqConfig();
}
function hzFromLog(log: number): number {
  return Math.max(0.1, Math.round(10 ** log * 10) / 10);
}
function fmtHz(hz: number): string {
  if (hz >= 1e9) return `${hz / 1e9} GHz`;
  if (hz >= 1e6) return `${hz / 1e6} MHz`;
  if (hz >= 1e3) return `${hz / 1e3} kHz`;
  return `${hz} Hz`;
}

const bufferUsage = () =>
  channels.value.length === 0
    ? 0
    : Math.round(
        (channels.value.reduce((a, c) => a + c.samples.size, 0) /
          (channels.value.length * CAPACITY)) *
          100,
      );
</script>

<template>
  <main class="app">
    <header>
      <h1>data2pixels</h1>
    </header>

    <section class="panel">
      <div class="control-group">
        <button class="btn" :class="{ on: running }" @click="toggleRunning">
          {{ running ? '停止采集' : '开始采集' }}
        </button>
        <button class="btn" :class="{ on: paused }" @click="paused = !paused">
          {{ paused ? '已暂停' : '暂停' }}
        </button>
        <button class="btn" @click="clearBuffers">清空</button>
      </div>

      <div class="control-group">
        <span class="label">时基</span>
        <button
          v-for="tb in TIMEBASES"
          :key="tb.value"
          class="btn small"
          :class="{ active: timebaseMs === tb.value }"
          @click="timebaseMs = tb.value"
        >
          {{ tb.label }}
        </button>
      </div>

      <div class="control-group">
        <span class="label">渲染</span>
        <button class="btn small" :class="{ active: renderer === '2d' }" @click="renderer = '2d'">
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

      <div class="control-group">
        <label class="check"> <input v-model="persistence" type="checkbox" /> 余辉叠加 </label>
        <span v-for="ch in channels" :key="ch.id" class="check">
          <label :style="{ color: ch.color }">
            <input type="checkbox" :checked="ch.visible" @change="toggleChannel(ch.id)" />
            {{ ch.label }}
          </label>
        </span>
      </div>

      <div class="status">
        <span>帧率 {{ fps }} fps</span>
        <span>样本 {{ received.toLocaleString() }}</span>
        <span>丢包 {{ dropped }}</span>
        <span>缓冲 {{ bufferUsage() }}%</span>
        <span class="dot" :class="{ live: running }">{{ running ? '采集运行中' : '已停止' }}</span>
        <span v-if="depthLimited()" class="dot">时基受存储深度限制</span>
      </div>
    </section>

    <section class="panel">
      <div class="control-group">
        <span class="label">全局</span>
        <label class="slider"
          >采样率 <b>{{ fmtHz(sampleRateHz) }}</b>
          <input
            v-model.number="sampleRateHz"
            type="range"
            min="1000"
            max="1000000000"
            step="1000"
            @change="pushAcqConfig"
          />
        </label>
        <label class="slider"
          >批次 <b>{{ batchMs }}ms</b>
          <input
            v-model.number="batchMs"
            type="range"
            min="10"
            max="100"
            step="10"
            @change="pushAcqConfig"
          />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#24c8db' }">正弦</span>
        <label class="slider"
          >频率 <b>{{ fmtHz(hzFromLog(sineFreqLog)) }}</b>
          <input
            v-model.number="sineFreqLog"
            type="range"
            min="-1"
            max="6"
            step="0.05"
            @change="onSineFreqChange"
          />
        </label>
        <label class="slider"
          >幅度 <b>{{ sineP.amp.toFixed(2) }}</b>
          <input
            v-model.number="sineP.amp"
            type="range"
            min="0"
            max="2"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
        <label class="slider"
          >噪声 <b>{{ sineP.noise.toFixed(2) }}</b>
          <input
            v-model.number="sineP.noise"
            type="range"
            min="0"
            max="1"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#f5a623' }">方波</span>
        <label class="slider"
          >频率 <b>{{ fmtHz(hzFromLog(pulseFreqLog)) }}</b>
          <input
            v-model.number="pulseFreqLog"
            type="range"
            min="-1"
            max="5"
            step="0.05"
            @change="onPulseFreqChange"
          />
        </label>
        <label class="slider"
          >占空比 <b>{{ pulseP.duty.toFixed(2) }}</b>
          <input
            v-model.number="pulseP.duty"
            type="range"
            min="0.05"
            max="0.95"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
        <label class="slider"
          >幅度 <b>{{ pulseP.amp.toFixed(2) }}</b>
          <input
            v-model.number="pulseP.amp"
            type="range"
            min="0"
            max="2"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
        <label class="slider"
          >抖动 <b>{{ pulseP.jitter.toFixed(2) }}</b>
          <input
            v-model.number="pulseP.jitter"
            type="range"
            min="0"
            max="0.5"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
      </div>

      <div class="control-group">
        <span class="label" :style="{ color: '#9b59b6' }">趋势</span>
        <label class="slider"
          >幅度 <b>{{ trendP.amp.toFixed(2) }}</b>
          <input
            v-model.number="trendP.amp"
            type="range"
            min="0.1"
            max="2"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
        <label class="slider"
          >噪声 <b>{{ trendP.noise.toFixed(2) }}</b>
          <input
            v-model.number="trendP.noise"
            type="range"
            min="0"
            max="0.1"
            step="0.01"
            @change="pushAcqConfig"
          />
        </label>
        <label v-if="acqError" class="slider"
          ><span class="err">{{ acqError }}</span></label
        >
      </div>
    </section>

    <component
      :is="renderer === 'gl' ? ChartWebGL : ChartCanvas"
      :channels="channels"
      :timebase-ms="timebaseMs"
      :sample-rate-hz="sampleRateHz"
      :persistence="persistence"
      @fps="fps = $event"
      @gpu-load="
        gpuLoad = $event;
        gpuLoadAt = Date.now();
      "
      @fallback="onGlFallback"
    />

    <ChartSVG :gpu-load="gpuLoad" :gpu-load-at="gpuLoadAt" />
  </main>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  color: #e6e6e6;
  background: #11151c;
  min-height: 100vh;
}
header h1 {
  margin: 0;
  font-size: 1.3rem;
}

.panel {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  padding: 12px;
  background: #1a1f29;
  border-radius: 8px;
}
.control-group {
  display: flex;
  align-items: center;
  gap: 8px;
}
.label {
  color: #888;
  font-size: 0.85rem;
}
.btn {
  padding: 6px 12px;
  border: 1px solid #333;
  border-radius: 6px;
  background: #232936;
  color: #e6e6e6;
  cursor: pointer;
}
.btn.small {
  padding: 4px 8px;
}
.btn.on,
.btn.active {
  border-color: #24c8db;
  color: #24c8db;
}
.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: #333;
  color: #888;
}
.check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85rem;
  color: #aaa;
  margin-right: 8px;
}
.status {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 0.8rem;
  color: #999;
  margin-left: auto;
}
.dot.live {
  color: #24c8db;
}
.slider {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: #aaa;
}
.slider input[type='range'] {
  width: 120px;
}
.slider b {
  color: #e6e6e6;
  font-weight: normal;
  min-width: 56px;
}
.err {
  color: #e05656;
}
</style>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
}
body {
  margin: 0;
  background: #11151c;
}
</style>
