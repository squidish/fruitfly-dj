/**
 * The assembled ear -> brain simulation. Pure TypeScript, no DOM and no Web
 * Audio, so the BrainWorker, the Node bench/tune harness and the tests all
 * drive the identical object.
 *
 * Fly size k is applied here, in one place: it multiplies every time constant
 * and divides f_c. Nothing downstream needs to know about it.
 */

import { DEFAULT_EAR, Ear, type EarConfig, envelopePeaks } from './ear.ts';
import { ApprovalMeter, type ApprovalCalibration } from './approval.ts';
import { buildCsr, rescale, type Csr, type EdgeArrays, type WeightScaling } from './csr.ts';
import { DEFAULT_LIF, Network, type LifParams } from './lif.ts';
import { StpPool, type StpParams } from './stp.ts';
import {
  buildStpSlots,
  G_GROOM,
  G_RELAY1,
  G_RELAY2,
  G_SENSOR,
  G_SONG,
  GROUPS,
  SENSOR_DEFL,
  SENSOR_VIB,
  type Circuit,
} from './circuit.ts';
import { deriveSeed } from './rng.ts';
import tuned from '../state/tuned.json';

/** Every knob the simulation reads, at k = 1. Mirrors src/state/params.ts. */
export interface SimConfig {
  seed: number;
  /** Fly size, 1-8x. Makes the fly k times slower. */
  k: number;

  // Ear
  sampleRate: number;
  fc: number;
  q: number;
  stages: number;
  tauEnv: number;
  channels: number;
  jitter: number;
  deflectionDivisor: number;
  earRate: number;
  onsetHop: number;
  agc: boolean;
  agcRef: number;
  agcTau: number;

  // Drive
  /**
   * Fixed conversion from ear envelope to threshold units. The envelope of a
   * full-scale in-band tone is about 0.3, so this is what puts a listening
   * sensor a comfortable margin over threshold. Not a user control.
   */
  sensorGain: number;
  /** "Sensitivity": the user's multiplier on top of sensorGain. */
  inputGain: number;
  deflGain: number;

  // Brain
  dt: number;
  tauM: number;
  vThresh: number;
  tRef: number;
  delay: number;
  noiseSigma: number;
  rateTau: number;
  wScale: number;
  inhibScale: number;

  // Short-term plasticity (the one temporal assumption)
  U: number;
  tauFac: number;
  tauRec: number;

  // Approval
  targetIpi: number;
  approvalSmoothing: number;
  rFloor: number;
  groomThreshold: number;
}

export const DEFAULT_SIM: SimConfig = {
  seed: 1,
  k: 1,
  sampleRate: 48000,
  fc: 250,
  q: 2,
  stages: 2,
  tauEnv: 0.003,
  channels: 8,
  jitter: 0.2,
  deflectionDivisor: 6,
  earRate: 2000,
  onsetHop: 0.005,
  agc: true,
  agcRef: 0.4,
  agcTau: 1,
  sensorGain: 25,
  inputGain: 1,
  deflGain: 0.6,
  dt: 0.0005,
  // Everything below comes from src/state/tuned.json, written by `npm run tune`.
  tauM: tuned.tauM,
  vThresh: 1,
  tRef: tuned.tRef,
  delay: DEFAULT_LIF.delay,
  noiseSigma: DEFAULT_LIF.noiseSigma,
  rateTau: DEFAULT_LIF.rateTau,
  wScale: tuned.wScale,
  inhibScale: tuned.inhibScale,
  U: tuned.U,
  tauFac: tuned.tauFac,
  tauRec: tuned.tauRec,
  targetIpi: 0.035,
  approvalSmoothing: 0.5,
  rFloor: 2,
  groomThreshold: 12,
};

/** Parameters after fly size has been applied. */
export interface ScaledConfig {
  ear: EarConfig;
  lif: LifParams;
  stp: StpParams;
  weights: WeightScaling;
  targetIpi: number;
  approvalSmoothing: number;
}

/**
 * Fly size k makes the fly k times slower: every time constant x k, f_c / k.
 * This replaces v1's input time-compression, which was acausal.
 */
export function scaleByFlySize(c: SimConfig): ScaledConfig {
  const k = Math.max(1, c.k);
  return {
    ear: {
      sampleRate: c.sampleRate,
      fc: c.fc / k,
      q: c.q,
      stages: c.stages,
      tauEnv: c.tauEnv * k,
      channels: c.channels,
      jitter: c.jitter,
      deflectionDivisor: c.deflectionDivisor,
      earRate: c.earRate,
      onsetHop: c.onsetHop,
      agc: c.agc,
      agcRef: c.agcRef,
      agcTau: c.agcTau * k,
      agcAttack: DEFAULT_EAR.agcAttack * k,
      agcMin: DEFAULT_EAR.agcMin,
      agcMax: DEFAULT_EAR.agcMax,
      agcFloor: DEFAULT_EAR.agcFloor,
    },
    lif: {
      dt: c.dt * k,
      tauM: c.tauM * k,
      vRest: 0,
      vThresh: c.vThresh,
      vReset: 0,
      tRef: c.tRef * k,
      delay: c.delay * k,
      noiseSigma: c.noiseSigma,
      rateTau: c.rateTau * k,
    },
    stp: { U: c.U, tauFac: c.tauFac * k, tauRec: c.tauRec * k },
    weights: { wScale: c.wScale, inhibScale: c.inhibScale },
    targetIpi: c.targetIpi * k,
    approvalSmoothing: c.approvalSmoothing * k,
  };
}

/** One simulated step's worth of output, reused between calls. */
export interface StepEvents {
  spikeIdx: Int32Array;
  spikeCount: number;
  /** Mean fly-band envelope this step. */
  flyEnv: number;
  /** Deflection channel envelope this step. */
  deflEnv: number;
  t: number;
  /** Index of the ear sample this step consumed up to, within the current push. */
  sampleIndex: number;
}

export class Simulation {
  readonly circuit: Circuit;
  readonly cfg: SimConfig;
  scaled: ScaledConfig;
  csr: Csr;
  net: Network;
  stp: StpPool;
  approval: ApprovalMeter;

  /** Indices of vibration sensors and the channel each listens to. */
  private vibSensors: Int32Array;
  private vibChannels: Int32Array;
  private deflSensors: Int32Array;
  private iext: Float32Array;

  /** Box-decimation state for turning 2 kHz ear samples into dt-sized steps. */
  private chanAcc: Float32Array;
  private deflAcc = 0;
  private accN = 0;
  private frac = 0;
  private samplesPerStep = 1;

  /** Rolling fly-band envelope at the ear rate, for peak picking and plots. */
  readonly envHistory: Float32Array;
  envWrite = 0;
  envTotal = 0;

  constructor(circuit: Circuit, cfg: Partial<SimConfig>, edges?: EdgeArrays) {
    this.circuit = circuit;
    this.cfg = { ...DEFAULT_SIM, ...cfg };
    this.scaled = scaleByFlySize(this.cfg);

    const e = edges ?? circuit.edges;
    this.csr = buildCsr(circuit.n, e, this.scaled.weights);
    const { slots, count } = buildStpSlots(this.csr.rowStart, this.csr.target, this.csr.nnz, circuit.groupOf);
    this.stp = new StpPool(count, this.scaled.stp);
    this.net = new Network({
      n: circuit.n,
      csr: this.csr,
      groupOf: circuit.groupOf,
      nGroups: GROUPS.length,
      params: this.scaled.lif,
      seed: deriveSeed(this.cfg.seed, 'lif-noise'),
      stpSlots: slots,
      stp: this.stp,
    });

    this.approval = new ApprovalMeter({
      rFloor: this.cfg.rFloor,
      smoothing: this.scaled.approvalSmoothing,
    });

    const vib: number[] = [];
    const vibCh: number[] = [];
    const defl: number[] = [];
    for (let i = 0; i < circuit.n; i++) {
      if (circuit.sensorKind[i] === SENSOR_VIB) {
        vib.push(i);
        vibCh.push(Math.max(0, Math.min(this.cfg.channels - 1, circuit.sensorChannel[i])));
      } else if (circuit.sensorKind[i] === SENSOR_DEFL) {
        defl.push(i);
      }
    }
    this.vibSensors = Int32Array.from(vib);
    this.vibChannels = Int32Array.from(vibCh);
    this.deflSensors = Int32Array.from(defl);

    this.iext = new Float32Array(circuit.n);
    this.chanAcc = new Float32Array(this.cfg.channels);
    this.envHistory = new Float32Array(this.cfg.earRate * 12); // 12 s at the ear rate
    this.retime();
  }

  private retime(): void {
    this.samplesPerStep = Math.max(0.01, this.scaled.lif.dt * this.cfg.earRate);
  }

  /** Apply a config patch. Rebuilds only what actually changed. */
  update(patch: Partial<SimConfig>): void {
    const before = { ...this.cfg };
    Object.assign(this.cfg, patch);
    this.scaled = scaleByFlySize(this.cfg);

    if (before.wScale !== this.cfg.wScale || before.inhibScale !== this.cfg.inhibScale) {
      rescale(this.csr, this.scaled.weights);
    }
    this.net.setParams(this.scaled.lif);
    this.stp.setParams(this.scaled.stp);
    this.approval.smoothing = this.scaled.approvalSmoothing;
    this.approval.rFloor = this.cfg.rFloor;
    this.retime();
  }

  setCalibration(c: ApprovalCalibration): void {
    this.approval.setCalibration(c);
  }

  reset(): void {
    this.net.reset();
    this.stp.reset();
    this.approval.reset();
    this.chanAcc.fill(0);
    this.deflAcc = 0;
    this.accN = 0;
    this.frac = 0;
    this.envHistory.fill(0);
    this.envWrite = 0;
    this.envTotal = 0;
  }

  get time(): number {
    return this.net.t;
  }

  /** Mean rate of a group, in Hz. */
  groupRate(g: number): number {
    return this.net.groupRate[g];
  }

  get songRate(): number {
    return this.net.groupRate[G_SONG];
  }

  get sensorRate(): number {
    return this.net.groupRate[G_SENSOR];
  }

  get relayRate(): number {
    return (this.net.groupRate[G_RELAY1] + this.net.groupRate[G_RELAY2]) / 2;
  }

  get groomRate(): number {
    return this.net.groupRate[G_GROOM];
  }

  /**
   * Feed decimated ear samples. `vib` is channels x capacity row-major; only
   * the first `n` samples of each row are read. Calls `onStep` once per
   * simulated dt.
   */
  pushEar(
    vib: Float32Array,
    defl: Float32Array,
    n: number,
    capacity: number,
    onStep?: (ev: StepEvents) => void,
  ): void {
    const nch = this.cfg.channels;
    const events: StepEvents = {
      spikeIdx: this.net.spikeIdx,
      spikeCount: 0,
      flyEnv: 0,
      deflEnv: 0,
      t: 0,
      sampleIndex: 0,
    };

    for (let s = 0; s < n; s++) {
      let mean = 0;
      for (let c = 0; c < nch; c++) {
        const v = vib[c * capacity + s];
        this.chanAcc[c] += v;
        mean += v;
      }
      mean /= nch;
      this.deflAcc += defl[s];
      this.accN++;

      // Keep the fly-band envelope at the ear rate for peak picking and plots.
      this.envHistory[this.envWrite] = mean;
      this.envWrite = (this.envWrite + 1) % this.envHistory.length;
      this.envTotal++;

      this.frac += 1;
      if (this.frac >= this.samplesPerStep) {
        this.frac -= this.samplesPerStep;
        events.sampleIndex = s;
        this.runStep(events, onStep);
      }
    }
  }

  private runStep(events: StepEvents, onStep?: (ev: StepEvents) => void): void {
    const inv = this.accN > 0 ? 1 / this.accN : 0;
    const gain = this.cfg.inputGain * this.cfg.sensorGain;
    const iext = this.iext;

    let flyEnv = 0;
    for (let c = 0; c < this.cfg.channels; c++) {
      this.chanAcc[c] *= inv;
      flyEnv += this.chanAcc[c];
    }
    flyEnv /= Math.max(1, this.cfg.channels);
    const deflEnv = this.deflAcc * inv;

    for (let s = 0; s < this.vibSensors.length; s++) {
      iext[this.vibSensors[s]] = gain * this.chanAcc[this.vibChannels[s]];
    }
    const deflDrive = gain * this.cfg.deflGain * deflEnv;
    for (let s = 0; s < this.deflSensors.length; s++) {
      iext[this.deflSensors[s]] = deflDrive;
    }

    this.chanAcc.fill(0);
    this.deflAcc = 0;
    this.accN = 0;

    const count = this.net.step(iext);
    this.approval.update(this.songRate, this.sensorRate, this.scaled.lif.dt);

    events.spikeCount = count;
    events.flyEnv = flyEnv;
    events.deflEnv = deflEnv;
    events.t = this.net.t;
    onStep?.(events);
  }

  /**
   * Offline convenience: run a raw audio buffer through a private Ear and then
   * the brain. This is the path calibration, bench and tune take.
   */
  runAudio(signal: Float32Array, onStep?: (ev: StepEvents) => void, ear?: Ear): Ear {
    const e = ear ?? new Ear(this.scaled.ear);
    const block = 256;
    const frame = e.allocFrame(block);
    for (let off = 0; off < signal.length; off += block) {
      const chunk = signal.subarray(off, Math.min(signal.length, off + block));
      e.process(chunk, frame);
      this.pushEar(frame.vib, frame.defl, frame.n, frame.capacity, onStep);
    }
    return e;
  }

  /** Fly-band envelope peaks over the last `seconds`, as intervals in seconds. */
  recentEnvelopeIntervals(seconds: number): number[] {
    const rate = this.cfg.earRate;
    const want = Math.min(this.envHistory.length, Math.round(seconds * rate), this.envTotal);
    if (want < 8) return [];
    const buf = new Float32Array(want);
    const start = (this.envWrite - want + this.envHistory.length * 2) % this.envHistory.length;
    for (let i = 0; i < want; i++) buf[i] = this.envHistory[(start + i) % this.envHistory.length];

    let peakMax = 0;
    let peakMin = Infinity;
    for (let i = 0; i < want; i++) {
      if (buf[i] > peakMax) peakMax = buf[i];
      if (buf[i] < peakMin) peakMin = buf[i];
    }
    if (peakMax <= 1e-6) return [];

    // 5 ms x k floor between peaks, matching the onset detector's resolution.
    const minGap = Math.max(2, Math.round(0.005 * this.cfg.k * rate));
    const peaks = envelopePeaks(buf, want, {
      minGapSamples: minGap,
      // 0.45 of the window's range. Lower thresholds latch onto ripple: a
      // Q = 2 band-pass at 250 Hz still passes a bass note's 2nd and 3rd
      // harmonics, and those beat at the fundamental, putting a 14 ms ripple
      // inside every 117 ms note.
      prominence: (peakMax - peakMin) * 0.45,
      floor: peakMax * 0.2,
    });
    const out: number[] = [];
    for (let i = 1; i < peaks.length; i++) out.push((peaks[i] - peaks[i - 1]) / rate);
    return out;
  }
}
