/**
 * Offline calibration, run in the worker.
 *
 * Approval is a selectivity index, so it needs two anchors measured on THIS
 * circuit with THESE parameters:
 *   S_noise  - response to an energy-matched noise envelope
 *   S_ideal  - response to ideal pulse song at the target IPI and f_c
 *
 * The same sweep that finds S_ideal also produces the MEASURED tuning curve the
 * IPI plot draws. Nothing there is a hand-drawn Gaussian.
 */

import { Ear } from '../core/ear.ts';
import { Rng, deriveSeed } from '../core/rng.ts';
import { Simulation, type SimConfig } from '../core/sim.ts';
import type { Circuit } from '../core/circuit.ts';
import type { EdgeArrays } from '../core/csr.ts';

export interface PulseTrainOptions {
  sampleRate: number;
  seconds: number;
  /** Carrier frequency, already divided by k. */
  fc: number;
  /** Inter-pulse interval in seconds, already multiplied by k. */
  ipi: number;
  /**
   * Carrier cycles per pulse. Real melanogaster pulses run 2-4, which at 250 Hz
   * is 8-16 ms. Two keeps the pulse short enough that a 10 ms IPI is still a
   * train of separate pulses rather than a tone, so the low end of the sweep
   * measures something.
   */
  cycles?: number;
  amplitude?: number;
  /** Pulses per train. Real song comes in short trains, not a metronome. */
  trainMin?: number;
  trainMax?: number;
  /** Silence between trains, in seconds (scaled by the caller). */
  gap?: number;
  seed?: number;
}

/**
 * Ideal courtship pulse song: short trains of Hann-windowed carrier pulses at
 * a fixed IPI, separated by gaps.
 */
export function pulseTrain(opts: PulseTrainOptions): Float32Array {
  const {
    sampleRate,
    seconds,
    fc,
    ipi,
    cycles = 2,
    amplitude = 0.5,
    trainMin = 5,
    trainMax = 15,
    gap = 0.25,
    seed = 1,
  } = opts;

  const n = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(n);
  const pulseLen = Math.max(4, Math.round((cycles / Math.max(1, fc)) * sampleRate));
  const step = Math.max(pulseLen, Math.round(ipi * sampleRate));
  const gapSamples = Math.max(0, Math.round(gap * sampleRate));
  const rng = new Rng(seed);

  let at = 0;
  while (at < n) {
    const pulses = trainMin + rng.int(Math.max(1, trainMax - trainMin + 1));
    for (let p = 0; p < pulses && at < n; p++) {
      // Randomise each pulse's carrier phase. Without this, IPIs that happen to
      // be a whole number of carrier cycles (20 ms is exactly five at 250 Hz)
      // build a phase-coherent comb and punch a spurious notch in the measured
      // tuning curve. Real courtship song is not phase-locked either.
      const phase = rng.float() * 2 * Math.PI;
      for (let i = 0; i < pulseLen; i++) {
        const idx = at + i;
        if (idx >= n) break;
        const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / pulseLen);
        out[idx] += amplitude * w * Math.sin((2 * Math.PI * fc * i) / sampleRate + phase);
      }
      at += step;
    }
    at += gapSamples;
  }
  return out;
}

/** White noise. */
export function whiteNoise(sampleRate: number, seconds: number, seed: number, amplitude = 0.5): Float32Array {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(n);
  const rng = new Rng(seed);
  for (let i = 0; i < n; i++) out[i] = amplitude * (rng.float() * 2 - 1);
  return out;
}

/**
 * The S_noise control: the same carrier as ideal song, amplitude-modulated by
 * a NOISE ENVELOPE of comparable bandwidth instead of a periodic pulse train.
 *
 * Matching spectrum as well as energy matters. Broadband white noise scaled to
 * match fly-band energy ends up enormously loud out of band, so it drives the
 * deflection channel instead and measures the wrong thing entirely. This
 * control differs from ideal song in temporal structure and nothing else.
 */
export function noiseEnvelopeCarrier(opts: {
  sampleRate: number;
  seconds: number;
  fc: number;
  /** Envelope bandwidth in Hz; pass 1 / targetIpi to match the pulse train's. */
  envCutoff: number;
  seed: number;
  amplitude?: number;
}): Float32Array {
  const { sampleRate, seconds, fc, envCutoff, seed, amplitude = 0.5 } = opts;
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(n);
  const rng = new Rng(seed);

  // Two cascaded one-poles, so the envelope has a rolloff rather than a cliff.
  const a = 1 - Math.exp((-2 * Math.PI * Math.max(1, envCutoff)) / sampleRate);
  let e1 = 0;
  let e2 = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const w = rng.float() * 2 - 1;
    e1 += a * (w - e1);
    e2 += a * (e1 - e2);
    const env = Math.abs(e2);
    out[i] = env;
    sum += env;
  }

  const mean = sum / n;
  const norm = mean > 1e-12 ? amplitude / mean : 0;
  for (let i = 0; i < n; i++) {
    out[i] = out[i] * norm * Math.sin((2 * Math.PI * fc * i) / sampleRate);
  }
  return out;
}

/** Mean fly-band envelope a signal produces, measured through the real ear. */
export function earEnvelopeMean(signal: Float32Array, earCfg: ConstructorParameters<typeof Ear>[0]): number {
  const ear = new Ear(earCfg);
  const block = 512;
  const frame = ear.allocFrame(block);
  let sum = 0;
  let count = 0;
  const nch = ear.channels;
  for (let off = 0; off < signal.length; off += block) {
    ear.process(signal.subarray(off, Math.min(signal.length, off + block)), frame);
    for (let s = 0; s < frame.n; s++) {
      let m = 0;
      for (let c = 0; c < nch; c++) m += frame.vib[c * frame.capacity + s];
      sum += m / nch;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/** Scale `signal` so its fly-band envelope mean matches `target`. */
export function matchEnvelope(
  signal: Float32Array,
  target: number,
  earCfg: ConstructorParameters<typeof Ear>[0],
): Float32Array {
  const mean = earEnvelopeMean(signal, earCfg);
  if (!(mean > 1e-12) || !(target > 1e-12)) return signal;
  const g = target / mean;
  const out = new Float32Array(signal.length);
  for (let i = 0; i < signal.length; i++) out[i] = signal[i] * g;
  return out;
}

/**
 * Run one stimulus through a fresh simulation and return the mean smoothed
 * selectivity over the settled tail of the run.
 */
export function measureSelectivity(
  circuit: Circuit,
  cfg: SimConfig,
  edges: EdgeArrays | undefined,
  signal: Float32Array,
  settleFraction = 0.4,
): { s: number; songRate: number; sensorRate: number; spikes: number } {
  const sim = new Simulation(circuit, cfg, edges);
  const ear = new Ear(sim.scaled.ear);
  const block = 256;
  const frame = ear.allocFrame(block);
  const settleAt = signal.length * settleFraction;

  let sSum = 0;
  let songSum = 0;
  let sensorSum = 0;
  let samples = 0;
  let settled = false;

  for (let off = 0; off < signal.length; off += block) {
    settled = off >= settleAt;
    ear.process(signal.subarray(off, Math.min(signal.length, off + block)), frame);
    sim.pushEar(frame.vib, frame.defl, frame.n, frame.capacity, () => {
      if (!settled) return;
      sSum += sim.approval.selectivity;
      songSum += sim.songRate;
      sensorSum += sim.sensorRate;
      samples++;
    });
  }

  const inv = samples > 0 ? 1 / samples : 0;
  return { s: sSum * inv, songRate: songSum * inv, sensorRate: sensorSum * inv, spikes: sim.net.totalSpikes };
}

export interface TuningPoint {
  /** IPI in seconds, in the fly's own (k-scaled) time. */
  ipi: number;
  /** IPI in seconds at k = 1, so the curve is comparable across fly sizes. */
  ipiBase: number;
  s: number;
  songRate: number;
}

export interface CalibrationResult {
  sNoise: number;
  sIdeal: number;
  /** Measured tuning curve, drawn under the IPI histograms. */
  curve: TuningPoint[];
  /** IPI (base seconds) at which the curve peaks. */
  peakIpi: number;
  targetIpi: number;
  /** Wall-clock milliseconds the sweep took. */
  ms: number;
}

export interface CalibrationOptions {
  /** Seconds of stimulus per sweep point, in fly time. */
  seconds?: number;
  /** Sweep range at k = 1, in seconds. */
  ipiMin?: number;
  ipiMax?: number;
  points?: number;
}

/**
 * Sweep IPI 10-120 ms, plus an energy-matched noise control. Returns both
 * approval anchors and the measured tuning curve.
 */
export function calibrate(
  circuit: Circuit,
  cfg: SimConfig,
  edges: EdgeArrays | undefined,
  opts: CalibrationOptions = {},
): CalibrationResult {
  const started = Date.now();
  const k = Math.max(1, cfg.k);
  const seconds = (opts.seconds ?? 2.5) * k;
  const ipiMin = opts.ipiMin ?? 0.01;
  const ipiMax = opts.ipiMax ?? 0.12;
  const points = opts.points ?? 12;

  const sim0 = new Simulation(circuit, cfg, edges);
  const earCfg = sim0.scaled.ear;
  const fcEff = earCfg.fc;

  const ipis: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = points === 1 ? 0 : i / (points - 1);
    // Geometric spacing: IPI tuning is a ratio phenomenon.
    ipis.push(ipiMin * Math.pow(ipiMax / ipiMin, t));
  }
  if (!ipis.some((v) => Math.abs(v - cfg.targetIpi) < 1e-6)) ipis.push(cfg.targetIpi);
  ipis.sort((a, b) => a - b);

  const seed = deriveSeed(cfg.seed, 'calibration');
  const curve: TuningPoint[] = [];
  let idealEnv = 0;

  for (const ipiBase of ipis) {
    const signal = pulseTrain({
      sampleRate: cfg.sampleRate,
      seconds,
      fc: fcEff,
      ipi: ipiBase * k,
      gap: 0.25 * k,
      seed,
    });
    const r = measureSelectivity(circuit, cfg, edges, signal);
    curve.push({ ipi: ipiBase * k, ipiBase, s: r.s, songRate: r.songRate });
    if (Math.abs(ipiBase - cfg.targetIpi) < 1e-9) idealEnv = earEnvelopeMean(signal, earCfg);
  }

  const targetPoint = curve.reduce((best, p) =>
    Math.abs(p.ipiBase - cfg.targetIpi) < Math.abs(best.ipiBase - cfg.targetIpi) ? p : best,
  );
  const peak = curve.reduce((best, p) => (p.s > best.s ? p : best), curve[0]);

  if (idealEnv <= 0) {
    idealEnv = earEnvelopeMean(
      pulseTrain({ sampleRate: cfg.sampleRate, seconds, fc: fcEff, ipi: cfg.targetIpi * k, gap: 0.25 * k, seed }),
      earCfg,
    );
  }

  const noise = matchEnvelope(
    noiseEnvelopeCarrier({
      sampleRate: cfg.sampleRate,
      seconds,
      fc: fcEff,
      envCutoff: 1 / Math.max(1e-3, cfg.targetIpi * k),
      seed: deriveSeed(cfg.seed, 'calibration-noise'),
    }),
    idealEnv,
    earCfg,
  );
  const noiseResult = measureSelectivity(circuit, cfg, edges, noise);

  return {
    sNoise: noiseResult.s,
    sIdeal: targetPoint.s,
    curve,
    peakIpi: peak.ipiBase,
    targetIpi: cfg.targetIpi,
    ms: Date.now() - started,
  };
}
