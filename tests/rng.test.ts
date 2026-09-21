import { describe, expect, it } from 'vitest';
import { Rng, deriveSeed, hashString } from '../src/core/rng.ts';

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(1);
    const b = new Rng(1);
    const xs = Array.from({ length: 64 }, () => a.float());
    const ys = Array.from({ length: 64 }, () => b.float());
    expect(xs).toEqual(ys);
  });

  it('separates adjacent integer seeds', () => {
    const a = Array.from({ length: 32 }, (_, i) => new Rng(i + 1).float());
    expect(new Set(a).size).toBe(a.length);
  });

  it('stays inside [0, 1)', () => {
    const r = new Rng('courtship');
    for (let i = 0; i < 10000; i++) {
      const v = r.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('produces roughly standard normals', () => {
    const r = new Rng(7);
    const n = 40000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = r.normal();
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
  });

  it('shuffles as a permutation', () => {
    const src = Array.from({ length: 100 }, (_, i) => i);
    const out = new Rng(3).shuffle(src.slice());
    expect(out.slice().sort((a, b) => a - b)).toEqual(src);
    expect(out).not.toEqual(src);
  });

  it('derives independent sub-streams', () => {
    expect(deriveSeed(1, 'a')).not.toBe(deriveSeed(1, 'b'));
    expect(deriveSeed(1, 'a')).toBe(deriveSeed(1, 'a'));
    expect(hashString('')).toBeTypeOf('number');
  });
});
