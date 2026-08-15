import type { MinMax } from './minmax';

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
export function buildTraceVertices(mm: MinMax[], plotW: number, plotH: number): Float32Array {
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
