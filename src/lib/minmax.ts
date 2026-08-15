export type MinMax = [number, number];

/**
 * min/max 峰值检测：把 [gStart, gEnd) 的样本均匀映射到 pxWidth 列，
 * 每列取该像素覆盖样本的 (min, max)。列宽>1 可保留毛刺，=1 退化为单点。
 */
export function computeMinMax(
  at: (g: number) => number,
  gStart: number,
  gEnd: number,
  pxWidth: number,
): MinMax[] {
  const out: MinMax[] = [];
  const n = gEnd - gStart;
  if (n <= 0 || pxWidth <= 0) return out;
  for (let col = 0; col < pxWidth; col++) {
    // Brief 原代码用 floor，上采样(n<pxWidth)时列起点滞后，与测试期望不符；
    // 改用 ceil 并夹取到 [0, n-1]：样本尽早推进且列间无缝、无遗漏。
    const s0 = Math.min(n - 1, Math.ceil((col * n) / pxWidth));
    const s1 = Math.max(s0 + 1, Math.ceil(((col + 1) * n) / pxWidth));
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = s0; i < s1; i++) {
      const v = at(gStart + i);
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out.push([mn, mx]);
  }
  return out;
}
