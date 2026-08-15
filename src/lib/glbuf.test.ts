import { describe, expect, it } from 'vitest';
import { buildGridVertices, buildTraceVertices, hexToRgb } from './glbuf';

describe('buildTraceVertices', () => {
  it('空列返回空数组', () => {
    expect(buildTraceVertices([], 100, 100).length).toBe(0);
  });

  it('每列产生 2 个顶点共 4 个 float', () => {
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

  it('min/max 正确映射到 clip space（y 轴翻转）', () => {
    // plotH=100, Y_RANGE=[-1.5,1.5]：v=1 → yPix=50/3，v=-1 → yPix=250/3
    const v = buildTraceVertices([[-1, 1]], 100, 100);
    expect(v[0]).toBeCloseTo(-0.99); // x = (0.5/100)*2-1
    expect(v[1]).toBeCloseTo(1 - (2 * (50 / 3)) / 100); // 顶点：v=1
    expect(v[2]).toBeCloseTo(-0.99);
    expect(v[3]).toBeCloseTo(1 - (2 * (250 / 3)) / 100); // 底点：v=-1
    expect(v[3]).toBeLessThan(v[1]); // min 在下
  });

  it('mn===mx 退化为向下 1px 竖线', () => {
    const v = buildTraceVertices([[0, 0]], 100, 100);
    expect(v[1]).toBeCloseTo(v[3] + 2 / 100); // 第二顶点低 1px
  });
});

describe('buildGridVertices', () => {
  it('11 条竖线 + 3 条横线（v=-1,0,1）共 14 条线段', () => {
    expect(buildGridVertices(800, 360).length).toBe(14 * 4);
  });

  it('首条竖线位于左边缘，贯穿上下', () => {
    const v = buildGridVertices(800, 360);
    expect(v[0]).toBeCloseTo((0.5 / 800) * 2 - 1);
    expect(v[1]).toBe(1);
    expect(v[3]).toBe(-1);
  });
});

describe('hexToRgb', () => {
  it('解析 #rrggbb 为 0..1 归一化', () => {
    expect(hexToRgb('#24c8db')).toEqual([0x24 / 255, 0xc8 / 255, 0xdb / 255]);
  });

  it('非法输入返回白色', () => {
    expect(hexToRgb('red')).toEqual([1, 1, 1]);
  });
});
