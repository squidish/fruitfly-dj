import { describe, expect, it } from 'vitest';
import { ApprovalMeter, approvalBand, approvalFrom } from '../src/core/approval.ts';

describe('approvalFrom', () => {
  it('maps the noise anchor to 0 and the ideal anchor to 1', () => {
    const c = { sNoise: 0.3, sIdeal: 1.2 };
    expect(approvalFrom(0.3, c)).toBeCloseTo(0);
    expect(approvalFrom(1.2, c)).toBeCloseTo(1);
    expect(approvalFrom(0.75, c)).toBeCloseTo(0.5);
  });

  it('clamps below zero but allows the breakout range above one', () => {
    const c = { sNoise: 0.3, sIdeal: 1.2 };
    expect(approvalFrom(0, c)).toBe(0);
    expect(approvalFrom(1.5, c)).toBeGreaterThan(1);
    expect(approvalFrom(99, c)).toBe(3);
  });

  it('refuses to divide by a degenerate calibration', () => {
    expect(approvalFrom(5, { sNoise: 1, sIdeal: 1 })).toBe(0);
    expect(approvalFrom(5, { sNoise: 2, sIdeal: 1 })).toBe(0);
  });
});

describe('ApprovalMeter', () => {
  it('is a ratio, so scaling both rates changes nothing', () => {
    // This is the whole point of a selectivity index: turning the volume up
    // raises numerator and denominator together.
    const a = ApprovalMeter.rawSelectivity(20, 10, 2);
    const b = ApprovalMeter.rawSelectivity(40, 20, 2);
    expect(a).toBeCloseTo(b);
  });

  it('uses the sensor floor so silence cannot divide by ~0', () => {
    expect(ApprovalMeter.rawSelectivity(4, 0, 2)).toBe(2);
    expect(ApprovalMeter.rawSelectivity(4, 0.001, 2)).toBe(2);
    expect(Number.isFinite(ApprovalMeter.rawSelectivity(0, 0, 2))).toBe(true);
  });

  it('converges on the raw value when smoothed', () => {
    const m = new ApprovalMeter({ rFloor: 2, smoothing: 0.5 });
    for (let i = 0; i < 20000; i++) m.update(20, 10, 0.0005);
    expect(m.selectivity).toBeCloseTo(2, 3);
  });

  it('smooths over roughly its time constant', () => {
    const m = new ApprovalMeter({ rFloor: 2, smoothing: 0.5 });
    const dt = 0.0005;
    for (let i = 0; i < Math.round(0.5 / dt); i++) m.update(20, 10, dt);
    // One time constant in, an exponential is about 63% of the way there.
    expect(m.selectivity).toBeGreaterThan(2 * 0.55);
    expect(m.selectivity).toBeLessThan(2 * 0.72);
  });

  it('applies its calibration to produce approval', () => {
    const m = new ApprovalMeter({ rFloor: 2, smoothing: 0.01 });
    m.setCalibration({ sNoise: 0.5, sIdeal: 2 });
    for (let i = 0; i < 5000; i++) m.update(20, 10, 0.0005);
    expect(m.approval).toBeCloseTo(1, 2);
  });

  it('resets', () => {
    const m = new ApprovalMeter();
    for (let i = 0; i < 1000; i++) m.update(20, 10, 0.0005);
    m.reset();
    expect(m.selectivity).toBe(0);
  });
});

describe('approvalBand', () => {
  it('escalates with approval', () => {
    expect(approvalBand(0.0, 0, 12)).toBe('deaf');
    expect(approvalBand(0.2, 0, 12)).toBe('twitching');
    expect(approvalBand(0.45, 0, 12)).toBe('considering');
    expect(approvalBand(0.9, 0, 12)).toBe('courtship');
  });

  it('lets grooming override everything', () => {
    expect(approvalBand(1.5, 20, 12)).toBe('overstimulated');
    expect(approvalBand(0, 20, 12)).toBe('overstimulated');
  });
});
