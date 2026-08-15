import { describe, expect, it } from 'vitest';
import { SampleWindow } from './ring';

describe('SampleWindow', () => {
  it('pushes and reads in order', () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3]);
    expect(w.size).toBe(3);
    expect(w.count).toBe(3);
    expect(w.firstGlobal).toBe(0);
    expect(w.atGlobal(0)).toBe(1);
    expect(w.atGlobal(2)).toBe(3);
  });

  it('wraps around when full', () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3, 4]);
    w.pushMany([5, 6]);
    expect(w.size).toBe(4);
    expect(w.count).toBe(6);
    expect(w.firstGlobal).toBe(2);
    expect(w.atGlobal(1)).toBeNaN();
    expect(w.atGlobal(2)).toBe(3);
    expect(w.atGlobal(3)).toBe(4);
    expect(w.atGlobal(4)).toBe(5);
    expect(w.atGlobal(5)).toBe(6);
  });

  it('clear resets state', () => {
    const w = new SampleWindow(4);
    w.pushMany([1, 2, 3, 4]);
    w.clear();
    expect(w.size).toBe(0);
    expect(w.count).toBe(0);
    expect(w.atGlobal(0)).toBeNaN();
  });
});
