import { describe, expect, it } from 'vitest';
import { downsample, pushSample, toSegments, windowSlots, type SysSample } from './stats';

// 复刻 SysStatsChart 的完整数据管线（windowSlots 固定窗口 → downsample → toSegments），
// 锁定 X 轴行为：按真实时间戳固定最近 1 小时，缺失秒槽 null 断开
function chartPipeline(sampleCount: number, stepMs = 1000, plotPx = 1000) {
  const MAX_POINTS = 3600;
  const WINDOW_MS = 3_600_000;
  const t0 = 1_760_000_000_000;
  let arr: SysSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    arr = pushSample(arr, { ts: t0 + i * stepMs, cpu: 10, memBytes: 100e6, gpu: 5 }, MAX_POINTS);
  }
  const tMax = arr.at(-1)!.ts;
  const tMin = tMax - WINDOW_MS;
  const view = downsample(windowSlots(arr, tMin, tMax), plotPx);
  const segs = toSegments(view, {
    width: plotPx,
    height: 100,
    min: 0,
    max: 100,
    tMin,
    tMax,
    value: (s) => s.cpu,
  });
  return {
    xs: segs
      .join(' ')
      .split(' ')
      .map((p) => Number(p.split(',')[0])),
    segs,
  };
}

describe('chart pipeline true-time 1h window', () => {
  it('short data sits at true time positions in the right region, one contiguous segment', () => {
    // 5 分钟数据落在右端 ~8%（x≈917..1000），前导 null 区断开
    const { xs, segs } = chartPipeline(300);
    expect(segs).toHaveLength(1);
    expect(xs[0]).toBeGreaterThanOrEqual(900);
    expect(xs.at(-1)!).toBeGreaterThanOrEqual(995);
  });

  it('dropped seconds become null and break the line', () => {
    // 构造中段缺 30 秒的样本序列（缺口需超过抽稀桶宽 ~3.6s 才会在像素级断段）
    const MAX_POINTS = 3600,
      WINDOW_MS = 3_600_000,
      plotPx = 1000;
    const t0 = 1_760_000_000_000;
    let arr: SysSample[] = [];
    for (let i = 0; i < 10; i++) {
      const ts = i >= 5 ? t0 + (i + 30) * 1000 : t0 + i * 1000;
      arr = pushSample(arr, { ts, cpu: 10, memBytes: 100e6, gpu: 5 }, MAX_POINTS);
    }
    const tMax = arr.at(-1)!.ts;
    const tMin = tMax - WINDOW_MS;
    const view = downsample(windowSlots(arr, tMin, tMax), plotPx);
    const segs = toSegments(view, {
      width: plotPx,
      height: 100,
      min: 0,
      max: 100,
      tMin,
      tMax,
      value: (s) => s.cpu,
    });
    expect(segs.length).toBeGreaterThanOrEqual(2); // 缺口处断段
  });

  it('full hour of data covers the whole axis', () => {
    const { xs } = chartPipeline(3600);
    expect(xs[0]).toBeLessThanOrEqual(5);
    expect(xs.at(-1)!).toBeGreaterThanOrEqual(995);
    expect(new Set(xs).size).toBeGreaterThan(500);
  });
});
