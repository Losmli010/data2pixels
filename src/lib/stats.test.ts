import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  downsample,
  pushSample,
  toSegments,
  windowSlots,
  type SysSample,
} from './stats';

const mk = (ts: number, cpu = 1, memBytes = 1024, gpu: number | null = null): SysSample => ({
  ts,
  cpu,
  memBytes,
  gpu,
});

describe('pushSample', () => {
  it('appends and keeps order', () => {
    const out = pushSample([mk(0), mk(1)], mk(2));
    expect(out.map((s) => s.ts)).toEqual([0, 1, 2]);
  });

  it('drops oldest beyond maxPoints', () => {
    let arr: SysSample[] = [];
    for (let i = 0; i < 305; i++) arr = pushSample(arr, mk(i), 300);
    expect(arr).toHaveLength(300);
    expect(arr[0].ts).toBe(5);
    expect(arr.at(-1)!.ts).toBe(304);
  });

  it('default maxPoints is 3600', () => {
    let arr: SysSample[] = [];
    for (let i = 0; i < 3605; i++) arr = pushSample(arr, mk(i));
    expect(arr).toHaveLength(3600);
    expect(arr[0].ts).toBe(5);
  });

  it('does not mutate the input array', () => {
    const orig = [mk(0)];
    pushSample(orig, mk(1));
    expect(orig).toHaveLength(1);
  });
});

describe('downsample', () => {
  it('returns input when length <= buckets', () => {
    const in_ = [mk(0), mk(1), mk(2)];
    expect(downsample(in_, 10)).toBe(in_);
    expect(downsample([], 10)).toEqual([]);
  });

  it('averages each field per bucket', () => {
    const s = [mk(0, 0, 100), mk(1, 2, 300), mk(2, 4, 500), mk(3, 6, 700)];
    const out = downsample(s, 2);
    expect(out).toHaveLength(2);
    // 桶1: cpu (0+2)/2=1, mem (100+300)/2=200, ts 取组内最后 1
    expect(out[0]).toMatchObject({ ts: 1, cpu: 1, memBytes: 200, gpu: null });
    // 桶2: cpu (4+6)/2=5, mem (500+700)/2=600, ts 取组内最后 3
    expect(out[1]).toMatchObject({ ts: 3, cpu: 5, memBytes: 600, gpu: null });
  });

  it('gpu averages only non-null values; all-null bucket stays null', () => {
    const s = [mk(0, 1, 100, 30), mk(1, 1, 100, 50), mk(2, 1, 100, null), mk(3, 1, 100, null)];
    const out = downsample(s, 2);
    expect(out[0]!.gpu).toBe(40); // (30+50)/2
    expect(out[1]!.gpu).toBe(null);
  });
});

describe('axisTicks', () => {
  it('generates evenly spaced ticks with endpoints', () => {
    expect(axisTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
    expect(axisTicks(0, 64, 5)).toEqual([0, 16, 32, 48, 64]);
  });

  it('count <= 1 returns just min', () => {
    expect(axisTicks(5, 100, 1)).toEqual([5]);
    expect(axisTicks(5, 100, 0)).toEqual([5]);
  });
});

describe('windowSlots', () => {
  const S = 1000;

  it('slots samples at their true second, null elsewhere', () => {
    const out = windowSlots([mk(1 * S), mk(3 * S, 7, 300)], 0, 3 * S);
    expect(out).toEqual([null, mk(1 * S), null, mk(3 * S, 7, 300)]);
  });

  it('leading region before the first sample is null', () => {
    const out = windowSlots([mk(2 * S)], 0, 2 * S);
    expect(out).toEqual([null, null, mk(2 * S)]);
  });

  it('internal gaps are null (no forward fill)', () => {
    const out = windowSlots([mk(0, 5, 100), mk(2 * S, 7, 300)], 0, 2 * S);
    expect(out[1]).toBeNull();
  });

  it('returns all null when no samples', () => {
    const out = windowSlots([], 0, 3 * S);
    expect(out).toEqual([null, null, null, null]);
  });

  it('ignores samples outside the window', () => {
    const out = windowSlots([mk(0), mk(5 * S)], 1 * S, 3 * S);
    expect(out).toEqual([null, null, null]);
  });
});

describe('downsample with null entries', () => {
  it('all-null bucket downsamples to null, mixed bucket averages non-null', () => {
    const out = downsample([null, null, mk(2 * 1000, 4, 500), mk(3 * 1000, 6, 700)], 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toMatchObject({ ts: 3 * 1000, cpu: 5, memBytes: 600 });
  });
});

describe('toSegments', () => {
  const w = 100,
    h = 50;

  it('maps x by real timestamp over tMin..tMax', () => {
    const segs = toSegments([mk(0, 0), mk(1800, 5), mk(3600, 10)], {
      width: w,
      height: h,
      min: 0,
      max: 10,
      tMin: 0,
      tMax: 3600,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['0,50 50,25 100,0']);
  });

  it('grows from the right when window is not full', () => {
    // 窗口 3600s，只有最近一段数据：x 应靠近右端
    const segs = toSegments([mk(3400, 0), mk(3600, 0)], {
      width: w,
      height: h,
      min: 0,
      max: 100,
      tMin: 0,
      tMax: 3600,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['94,50 100,50']);
  });

  it('breaks the line at null values', () => {
    const segs = toSegments([mk(0, 0), mk(1, null as unknown as number), mk(2, 0), mk(3, 0)], {
      width: w,
      height: h,
      min: 0,
      max: 100,
      tMin: 0,
      tMax: 3,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['0,50', '67,50 100,50']);
  });

  it('null via value callback breaks segments (gpu usage)', () => {
    const s = [mk(0, 1, 1024, 30), mk(1, 1, 1024, null), mk(2, 1, 1024, 60)];
    const segs = toSegments(s, {
      width: w,
      height: h,
      min: 0,
      max: 100,
      tMin: 0,
      tMax: 2,
      value: (x) => x.gpu,
    });
    expect(segs).toEqual(['0,35', '100,20']);
  });

  it('clamps values outside min..max', () => {
    const segs = toSegments([mk(0, -5), mk(1, 20)], {
      width: w,
      height: h,
      min: 0,
      max: 10,
      tMin: 0,
      tMax: 1,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['0,50 100,0']);
  });

  it('clamps x to 0 when sample ts is earlier than tMin', () => {
    // Rust 采样周期略大于 1s，1 小时后最旧样本 ts < tMin，x 不应为负
    const segs = toSegments([mk(-130, 5), mk(0, 5), mk(1800, 5)], {
      width: w,
      height: h,
      min: 0,
      max: 10,
      tMin: 0,
      tMax: 3600,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['0,25 0,25 50,25']);
  });

  it('mid-height when min equals max; x=0 when tMin equals tMax', () => {
    const segs = toSegments([mk(7, 7), mk(7, 7)], {
      width: w,
      height: h,
      min: 7,
      max: 7,
      tMin: 7,
      tMax: 7,
      value: (s) => s.cpu,
    });
    expect(segs).toEqual(['0,25 0,25']);
  });
});
