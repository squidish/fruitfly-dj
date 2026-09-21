import { describe, expect, it } from 'vitest';
import { Biquad, Ear, DEFAULT_EAR, channelFrequencies, envelopePeaks, median } from '../src/core/ear.ts';

const SR = 48000;

function tone(hz: number, seconds: number, amp = 1, sr = SR): Float32Array {
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sr);
  return out;
}

/** Mean fly-band envelope over the settled second half of a signal. */
function envMean(ear: Ear, signal: Float32Array): number {
  const block = 512;
  const frame = ear.allocFrame(block);
  let sum = 0;
  let count = 0;
  for (let off = 0; off < signal.length; off += block) {
    ear.process(signal.subarray(off, Math.min(signal.length, off + block)), frame);
    if (off < signal.length / 2) continue;
    for (let s = 0; s < frame.n; s++) {
      let m = 0;
      for (let c = 0; c < ear.channels; c++) m += frame.vib[c * frame.capacity + s];
      sum += m / ear.channels;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

describe('Biquad', () => {
  it('peaks at its centre frequency', () => {
    const b = new Biquad().setBandpass(SR, 250, 2);
    expect(b.magnitude(SR, 250)).toBeGreaterThan(0.99);
    expect(b.magnitude(SR, 250)).toBeLessThanOrEqual(1.001);
    expect(b.magnitude(SR, 2500)).toBeLessThan(0.1);
    expect(b.magnitude(SR, 25)).toBeLessThan(0.1);
  });

  it('is -3 dB at the Q-implied band edges', () => {
    const q = 2;
    const fc = 250;
    const b = new Biquad().setBandpass(SR, fc, q);
    // Band edges for a constant-0dB-gain BPF: f * sqrt(1 + 1/(4Q^2)) +/- f/(2Q)
    const bw = fc / q;
    const hi = Math.sqrt(fc * fc + bw * bw / 4) + bw / 2;
    expect(b.magnitude(SR, hi)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('low-passes', () => {
    const b = new Biquad().setLowpass(SR, 100);
    expect(b.magnitude(SR, 10)).toBeGreaterThan(0.99);
    expect(b.magnitude(SR, 1000)).toBeLessThan(0.02);
  });
});

describe('Ear', () => {
  it('spreads channels symmetrically around f_c', () => {
    const fcs = channelFrequencies({ fc: 250, channels: 8, jitter: 0.2 });
    expect(fcs.length).toBe(8);
    expect(fcs[0]).toBeCloseTo(200, 6);
    expect(fcs[7]).toBeCloseTo(300, 6);
    expect((fcs[0] + fcs[7]) / 2).toBeCloseTo(250, 6);
  });

  it('decimates to the ear rate regardless of block size', () => {
    for (const sr of [44100, 48000]) {
      const ear = new Ear({ sampleRate: sr, agc: false });
      const frame = ear.allocFrame(1024);
      let total = 0;
      const sig = tone(250, 1, 0.5, sr);
      for (let off = 0; off < sig.length; off += 333) {
        ear.process(sig.subarray(off, Math.min(sig.length, off + 333)), frame);
        total += frame.n;
      }
      // One second in, one second of ear samples out, give or take a block.
      expect(Math.abs(total - DEFAULT_EAR.earRate)).toBeLessThan(5);
    }
  });

  it('passes the fly band and rejects hi-hats — the whole joke', () => {
    const inBand = envMean(new Ear({ agc: false }), tone(250, 1, 0.5));
    const hat = envMean(new Ear({ agc: false }), tone(8000, 1, 0.5));
    const kick = envMean(new Ear({ agc: false }), tone(50, 1, 0.5));
    expect(inBand).toBeGreaterThan(0.2);
    // Two cascaded sections put a hi-hat about 70 dB down and a kick about 35.
    expect(hat).toBeLessThan(inBand / 1000);
    expect(kick).toBeLessThan(inBand / 40);
  });

  it('is sharper with two cascaded sections than with one', () => {
    const one = new Ear({ agc: false, stages: 1 });
    const two = new Ear({ agc: false, stages: 2 });
    const hat = tone(8000, 1, 0.5);
    const band = tone(250, 1, 0.5);
    const ratioOne = envMean(one, hat) / envMean(new Ear({ agc: false, stages: 1 }), band);
    const ratioTwo = envMean(two, hat) / envMean(new Ear({ agc: false, stages: 2 }), band);
    expect(ratioTwo).toBeLessThan(ratioOne / 10);
  });

  it('follows f_c when the fly is resized', () => {
    // At k = 3.3 the band moves to ~76 Hz, so a 76 Hz tone becomes audible.
    const big = new Ear({ fc: 250 / 3.3, agc: false });
    const small = new Ear({ fc: 250, agc: false });
    const bass = tone(76, 1, 0.5);
    expect(envMean(big, bass)).toBeGreaterThan(10 * envMean(small, bass));
    // ...and the full-sized fly hears it only through the filter skirt.
    expect(envMean(small, bass)).toBeLessThan(0.05);
  });

  it('holds output level steady across a 4x input level change when AGC is on', () => {
    const quiet = envMean(new Ear({ agc: true }), tone(250, 3, 0.15));
    const loud = envMean(new Ear({ agc: true }), tone(250, 3, 0.6));
    expect(loud / quiet).toBeLessThan(1.25);
    expect(loud / quiet).toBeGreaterThan(0.8);
  });

  it('does not amplify silence', () => {
    const ear = new Ear({ agc: true });
    expect(envMean(ear, new Float32Array(SR * 2))).toBeLessThan(1e-6);
  });

  it('detects onsets at a 5 ms resolution', () => {
    const ear = new Ear({ agc: false });
    const frame = ear.allocFrame(512);
    const sr = SR;
    const n = sr * 2;
    const sig = new Float32Array(n);
    const ipi = 0.035;
    const times: number[] = [];
    for (let t = 0.1; t < 1.9; t += ipi) {
      times.push(t);
      const at = Math.round(t * sr);
      for (let i = 0; i < 400; i++) {
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / 400);
        sig[at + i] += 0.6 * w * Math.sin((2 * Math.PI * 250 * i) / sr);
      }
    }
    const detected: number[] = [];
    let elapsed = 0;
    for (let off = 0; off < n; off += 512) {
      const chunk = sig.subarray(off, Math.min(n, off + 512));
      ear.process(chunk, frame);
      for (const o of frame.onsets) detected.push(elapsed + o);
      elapsed += chunk.length / sr;
    }
    // Every pulse found, within one hop, and nothing spurious.
    expect(detected.length).toBeGreaterThanOrEqual(times.length - 2);
    expect(detected.length).toBeLessThanOrEqual(times.length + 2);
    const intervals = detected.slice(1).map((t, i) => t - detected[i]);
    expect(median(intervals)).toBeCloseTo(ipi, 2);
  });
});

describe('envelopePeaks', () => {
  it('ignores ripple that is not prominent', () => {
    // 117 ms notes with a 14 ms ripple riding on them: exactly the Bass Rolls
    // case that made Auto-fit report a 7 ms "inter-pulse interval".
    const rate = 2000;
    const n = rate * 4;
    const env = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const phase = t % 0.117;
      const note = Math.exp(-phase / 0.022);
      env[i] = note * (1 + 0.25 * Math.sin(2 * Math.PI * 73 * t));
    }
    let mx = 0;
    let mn = Infinity;
    for (const v of env) {
      if (v > mx) mx = v;
      if (v < mn) mn = v;
    }
    const peaks = envelopePeaks(env, n, { minGapSamples: 10, prominence: (mx - mn) * 0.45, floor: mx * 0.2 });
    const intervals = peaks.slice(1).map((p, i) => (p - peaks[i]) / rate);
    expect(median(intervals)).toBeCloseTo(0.117, 2);
  });

  it('returns nothing for a flat signal', () => {
    const env = new Float32Array(1000).fill(0.5);
    expect(envelopePeaks(env, 1000, { minGapSamples: 2, prominence: 0.1 })).toEqual([]);
  });
});

describe('median', () => {
  it('handles both parities and the empty case', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});
