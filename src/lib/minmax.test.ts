import { describe, expect, it } from 'vitest';
import { computeMinMax } from './minmax';

// 简单数组包装：at(g) 直接按下标取值
const arrAt = (arr: number[]) => (g: number) => arr[g];

describe('computeMinMax', () => {
  it('returns empty for empty window', () => {
    expect(computeMinMax(arrAt([]), 0, 0, 100)).toEqual([]);
  });

  it('each column keeps min and max', () => {
    // 窗口 4 个样本、2 列 → 每列 2 样本
    const out = computeMinMax(arrAt([0, 10, 5, -5]), 0, 4, 2);
    expect(out).toEqual([
      [0, 10],
      [-5, 5],
    ]);
  });

  it('narrow window: one sample per column → min equals max', () => {
    const out = computeMinMax(arrAt([3, 7]), 0, 2, 4);
    expect(out).toEqual([
      [3, 3],
      [7, 7],
      [7, 7],
      [7, 7],
    ]);
  });

  it('respects global offsets', () => {
    // 只看 [2,5) 即 [5,1,-4]
    const out = computeMinMax(arrAt([9, 9, 5, 1, -4, 9]), 2, 5, 3);
    expect(out).toEqual([
      [5, 5],
      [1, 1],
      [-4, -4],
    ]);
  });
});
