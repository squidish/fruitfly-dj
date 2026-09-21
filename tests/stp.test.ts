import { describe, expect, it } from 'vitest';
import { StpPool } from '../src/core/stp.ts';
import tuned from '../src/state/tuned.json';

const P = { U: tuned.U, tauFac: tuned.tauFac, tauRec: tuned.tauRec };

describe('StpPool', () => {
  it('returns 1.0 for an isolated spike after a long silence', () => {
    const p = new StpPool(1, P);
    expect(p.release(0, 100)).toBeCloseTo(1, 6);
  });

  it('keeps synapses independent', () => {
    const p = new StpPool(2, P);
    p.release(0, 0);
    p.release(0, 0.01);
    const fresh = p.release(1, 0.01);
    expect(fresh).toBeCloseTo(1, 6);
  });

  it('matches the closed-form steady state after a long train', () => {
    for (const ipi of [0.02, 0.035, 0.08]) {
      const p = new StpPool(1, P);
      let last = 0;
      for (let i = 0; i < 400; i++) last = p.release(0, i * ipi);
      expect(last).toBeCloseTo(p.steadyState(ipi), 3);
    }
  });

  it('is band-pass in inter-pulse interval, peaked near the target', () => {
    const p = new StpPool(1, P);
    const ipis = [0.008, 0.012, 0.018, 0.025, 0.035, 0.05, 0.075, 0.11, 0.2, 0.4];
    const gains = ipis.map((d) => p.steadyState(d));
    const peakIpi = ipis[gains.indexOf(Math.max(...gains))];

    // Falls off at both ends: that is what makes it a band-pass rather than
    // plain depression or plain facilitation.
    expect(gains[0]).toBeLessThan(Math.max(...gains));
    expect(gains[gains.length - 1]).toBeLessThan(Math.max(...gains));
    expect(peakIpi).toBeGreaterThan(0.015);
    expect(peakIpi).toBeLessThan(0.08);
    expect(Math.abs(peakIpi - tuned.targetIpi) / tuned.targetIpi).toBeLessThan(0.6);
  });

  it('depresses short intervals relative to the target', () => {
    const p = new StpPool(1, P);
    expect(p.steadyState(0.008)).toBeLessThan(p.steadyState(tuned.targetIpi));
  });

  it('loses facilitation at long intervals', () => {
    const p = new StpPool(1, P);
    expect(p.steadyState(0.5)).toBeLessThan(p.steadyState(tuned.targetIpi));
    // A single spike after silence is the normalised 1.0 baseline.
    expect(p.steadyState(30)).toBeCloseTo(1, 2);
  });

  it('tracks mean release gain for the readout', () => {
    const p = new StpPool(1, P);
    expect(p.meanGain).toBe(1);
    for (let i = 0; i < 20; i++) p.release(0, i * tuned.targetIpi);
    expect(p.releaseCount).toBe(20);
    expect(p.meanGain).toBeGreaterThan(1);
  });

  it('resets to a pristine state', () => {
    const p = new StpPool(1, P);
    for (let i = 0; i < 20; i++) p.release(0, i * 0.01);
    p.reset();
    expect(p.release(0, 1000)).toBeCloseTo(1, 6);
  });
});
