export interface SysSample {
  ts: number;
  cpu: number;
  memBytes: number;
  gpu: number | null;
}

export function pushSample(samples: SysSample[], s: SysSample, maxPoints = 3600): SysSample[] {
  const out = [...samples, s];
  return out.length > maxPoints ? out.slice(out.length - maxPoints) : out;
}

/// 以真实时间戳为锚的固定窗口：[tMin, tMax] 每 stepMs 一个槽位，
/// 该秒有样本则取样本，否则为 null（含数据未开始的区段与采样空洞，不外推）。
export function windowSlots(
  samples: SysSample[],
  tMin: number,
  tMax: number,
  stepMs = 1000,
): (SysSample | null)[] {
  const out: (SysSample | null)[] = [];
  if (tMax <= tMin) return samples.length ? [samples[samples.length - 1]] : out;
  const bySlot = new Map<number, SysSample>();
  for (const s of samples) {
    if (s.ts < tMin || s.ts > tMax) continue;
    bySlot.set(Math.round(s.ts / stepMs), s);
  }
  for (let t = Math.ceil(tMin / stepMs) * stepMs; t <= tMax; t += stepMs) {
    out.push(bySlot.get(Math.round(t / stepMs)) ?? null);
  }
  return out;
}

/// 样本数多于 buckets 时按顺序均分 buckets 组，cpu/memBytes/gpu 各取组内均值，
/// ts 取组内最后样本的 ts（保留真实时间用于 X 轴定位）；全空组输出 null。
export function downsample(samples: (SysSample | null)[], buckets: number): (SysSample | null)[] {
  if (buckets <= 0 || samples.length === 0) return [];
  if (samples.length <= buckets) return samples;
  const size = samples.length / buckets;
  const out: (SysSample | null)[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((b + 1) * size)));
    const group = samples.slice(start, end).filter((s): s is SysSample => s !== null);
    if (group.length === 0) {
      out.push(null);
      continue;
    }
    const avg = (pick: (s: SysSample) => number | null): number | null => {
      const vals = group.map(pick).filter((v): v is number => v !== null);
      return vals.length === 0 ? null : vals.reduce((a, v) => a + v, 0) / vals.length;
    };
    out.push({
      ts: group[group.length - 1].ts,
      cpu: avg((s) => s.cpu) ?? 0,
      memBytes: avg((s) => s.memBytes) ?? 0,
      gpu: avg((s) => s.gpu),
    });
  }
  return out;
}

/// 生成 count 个等距刻度值（含 min/max 端点）。
export function axisTicks(min: number, max: number, count: number): number[] {
  if (count <= 1) return [min];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(min + ((max - min) * i) / (count - 1));
  return out;
}

/// 按 ts 映射 X、值映射 Y 生成 polyline 段；value 返回 null 或槽位本身为 null
/// （前向填充前的无数据区）处断段。padY 留出上下内缩（防止曲线贴边被遮挡）。
export function toSegments(
  samples: (SysSample | null)[],
  opts: {
    width: number;
    height: number;
    min: number;
    max: number;
    tMin: number;
    tMax: number;
    value: (s: SysSample) => number | null;
    padY?: number;
  },
): string[] {
  const { width, height, min, max, tMin, tMax, value, padY = 0 } = opts;
  const span = max - min;
  const tSpan = tMax - tMin;
  const innerH = height - 2 * padY;
  const segs: string[] = [];
  let cur: string[] = [];
  for (const s of samples) {
    if (s === null) {
      if (cur.length) segs.push(cur.join(' '));
      cur = [];
      continue;
    }
    const v = value(s);
    if (v === null) {
      if (cur.length) segs.push(cur.join(' '));
      cur = [];
      continue;
    }
    // ts 早于 tMin（Rust 采样周期略大于 1s，1 小时后最旧样本越界）时 clamp 到 0
    const x = Math.round(
      tSpan === 0 ? 0 : Math.min(Math.max(((s.ts - tMin) / tSpan) * width, 0), width),
    );
    const clamped = Math.min(Math.max(v, min), max);
    const frac = span === 0 ? 0.5 : 1 - (clamped - min) / span;
    const y = Math.round(padY + innerH * frac);
    cur.push(`${x},${y}`);
  }
  if (cur.length) segs.push(cur.join(' '));
  return segs;
}
