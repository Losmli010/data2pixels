import { describe, expect, it } from 'vitest';
import { timebaseToSamples } from './timebase';

describe('timebaseToSamples', () => {
  it('1kHz 下 1 样本/ms', () => {
    expect(timebaseToSamples(5000, 1000)).toBe(5000);
    expect(timebaseToSamples(100, 1000)).toBe(100);
  });

  it('非整除时向上取整', () => {
    expect(timebaseToSamples(1, 1500)).toBe(2);
    expect(timebaseToSamples(100, 30_000)).toBe(3000);
  });

  it('1GHz × 30s 仍在安全整数范围', () => {
    const n = timebaseToSamples(30_000, 1e9);
    expect(n).toBe(30_000_000_000);
    expect(Number.isSafeInteger(n)).toBe(true);
  });

  it('非正输入返回 1', () => {
    expect(timebaseToSamples(0, 1000)).toBe(1);
    expect(timebaseToSamples(100, 0)).toBe(1);
    expect(timebaseToSamples(-5, 1000)).toBe(1);
  });
});
