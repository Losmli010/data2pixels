/** 时基(ms) × 采样率(Hz) → 窗口样本数（向上取整，至少 1；非正输入返回 1） */
export function timebaseToSamples(timebaseMs: number, sampleRateHz: number): number {
  if (timebaseMs <= 0 || sampleRateHz <= 0) return 1;
  return Math.max(1, Math.ceil((timebaseMs * sampleRateHz) / 1000));
}
