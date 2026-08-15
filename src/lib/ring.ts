export class SampleWindow {
  private buf: Float32Array;
  private write = 0;
  private sz = 0;
  private cnt = 0;

  constructor(public readonly capacity: number) {
    this.buf = new Float32Array(capacity);
  }

  get size(): number {
    return this.sz;
  }

  get count(): number {
    return this.cnt;
  }

  get firstGlobal(): number {
    return this.cnt - this.sz;
  }

  pushMany(values: ArrayLike<number>): void {
    const n = values.length;
    for (let i = 0; i < n; i++) {
      this.buf[this.write] = values[i];
      this.write = (this.write + 1) % this.capacity;
    }
    this.sz = Math.min(this.sz + n, this.capacity);
    this.cnt += n;
  }

  atGlobal(g: number): number {
    if (g < this.firstGlobal || g >= this.count) return Number.NaN;
    const pos = (((this.write - this.count + g) % this.capacity) + this.capacity) % this.capacity;
    return this.buf[pos];
  }

  clear(): void {
    this.write = 0;
    this.sz = 0;
    this.cnt = 0;
  }
}
