import { describe, expect, it } from 'vitest';
import { FlashLimiter } from '../src/core/flashLimiter.ts';

const LARGE = 0.3;
const SMALL = 0.005;

/** Count opposing luminance transitions in an output series. */
function countFlashes(values: number[], minDelta: number): number {
  let flashes = 0;
  let anchor = values[0];
  let dir = 0;
  for (const v of values) {
    const d = v - anchor;
    if (Math.abs(d) < minDelta) continue;
    const next = d > 0 ? 1 : -1;
    if (dir !== 0 && next !== dir) flashes++;
    anchor = v;
    dir = next;
  }
  return flashes;
}

describe('FlashLimiter', () => {
  it('lets small elements through untouched — raster dots are exempt', () => {
    const fl = new FlashLimiter();
    for (let i = 0; i < 200; i++) {
      const want = i % 2 === 0 ? 0 : 1;
      expect(fl.limit('dot', want, SMALL, i * 0.01)).toBe(want);
    }
  });

  it('caps a large element at 3 flashes per second', () => {
    const fl = new FlashLimiter();
    const out: number[] = [];
    // 28 Hz square wave: exactly the pulse-song rate this exists to stop.
    for (let i = 0; i < 600; i++) {
      const t = i / 60;
      const want = Math.floor(t * 56) % 2 === 0 ? 0.05 : 0.95;
      out.push(fl.limit('floor', want, LARGE, t));
    }
    for (let second = 0; second < 9; second++) {
      const slice = out.slice(second * 60, (second + 1) * 60);
      expect(countFlashes(slice, 0.1)).toBeLessThanOrEqual(3);
    }
  });

  it('counts at most 3 flashes in any one-second window', () => {
    const fl = new FlashLimiter();
    for (let i = 0; i < 100; i++) {
      const t = i * 0.01;
      fl.limit('floor', i % 2 === 0 ? 0 : 1, LARGE, t);
    }
    expect(fl.flashCount('floor', 1)).toBeLessThanOrEqual(3);
  });

  it('holds output inside the threshold band once the budget is spent', () => {
    const fl = new FlashLimiter({ minDelta: 0.1 });
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) seen.push(fl.limit('floor', i % 2 === 0 ? 0 : 1, LARGE, i * 0.005));
    // Over 200 ms the budget runs out; the rest must be clamped, not snapped.
    const tail = seen.slice(20);
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThanOrEqual(0.25);
  });

  it('allows flashes again once the window has passed', () => {
    const fl = new FlashLimiter();
    for (let i = 0; i < 20; i++) fl.limit('floor', i % 2 === 0 ? 0 : 1, LARGE, i * 0.01);
    expect(fl.flashCount('floor', 0.2)).toBe(3);
    expect(fl.flashCount('floor', 5)).toBe(0);
    expect(fl.limit('floor', 0.02, LARGE, 5)).toBeCloseTo(0.02, 5);
  });

  it('keeps sub-threshold wobble bounded and free', () => {
    const fl = new FlashLimiter({ minDelta: 0.1 });
    const seen: number[] = [];
    // Fast oscillation, but smaller than the flash threshold.
    for (let i = 0; i < 200; i++) {
      seen.push(fl.limit('floor', 0.5 + (i % 2 === 0 ? -0.04 : 0.04), LARGE, i * 0.005));
    }
    expect(fl.flashCount('floor', 1)).toBe(0);
    expect(Math.max(...seen) - Math.min(...seen)).toBeLessThan(0.1);
  });

  it('treats a monotonic ramp as one transition, not a flash', () => {
    // WCAG's general flash threshold counts a PAIR of opposing changes. A slow
    // fade up is one transition however far it goes, so it is not limited --
    // and the reversal at the end is what costs a flash.
    const fl = new FlashLimiter({ minDelta: 0.1 });
    let out = 0;
    for (let i = 0; i < 100; i++) out = fl.limit('floor', i * 0.01, LARGE, i * 0.001);
    expect(out).toBeCloseTo(0.99, 2);
    expect(fl.flashCount('floor', 0.1)).toBe(0);

    fl.limit('floor', 0, LARGE, 0.11);
    expect(fl.flashCount('floor', 0.12)).toBe(1);
  });

  it('keeps separate budgets per element', () => {
    const fl = new FlashLimiter();
    for (let i = 0; i < 20; i++) {
      fl.limit('a', i % 2 === 0 ? 0 : 1, LARGE, i * 0.01);
    }
    expect(fl.flashCount('a', 0.2)).toBe(3);
    expect(fl.flashCount('b', 0.2)).toBe(0);
  });

  it('resets', () => {
    const fl = new FlashLimiter();
    for (let i = 0; i < 20; i++) fl.limit('floor', i % 2 === 0 ? 0 : 1, LARGE, i * 0.01);
    fl.reset();
    expect(fl.flashCount('floor', 0.2)).toBe(0);
  });
});
