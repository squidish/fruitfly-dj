/**
 * Leaky integrate-and-fire network on connectome topology.
 *
 * Units are normalised: v_rest = 0, v_thresh = 1. A weight is therefore the
 * fraction of threshold one presynaptic spike contributes, which keeps
 * w_scale interpretable (synapse count x w_scale).
 */

import type { Csr } from './csr.ts';
import { Rng } from './rng.ts';
import type { StpPool } from './stp.ts';

export interface LifParams {
  /** Timestep in seconds. Already multiplied by fly size k. */
  dt: number;
  /** Membrane time constant, seconds (x k). */
  tauM: number;
  vRest: number;
  vThresh: number;
  vReset: number;
  /** Refractory period, seconds (x k). */
  tRef: number;
  /** Uniform synaptic delay, seconds (x k). */
  delay: number;
  /** Stationary std of the membrane noise, in threshold units. */
  noiseSigma: number;
  /** Time constant of the low-passed rate readout, seconds (x k). */
  rateTau: number;
}

export const DEFAULT_LIF: LifParams = {
  dt: 0.0005,
  tauM: 0.012,
  vRest: 0,
  vThresh: 1,
  vReset: 0,
  tRef: 0.002,
  delay: 0.0018,
  noiseSigma: 0.04,
  rateTau: 0.05,
};

export interface NetworkOptions {
  n: number;
  csr: Csr;
  /** Group id per neuron. */
  groupOf: Uint8Array;
  nGroups: number;
  params: LifParams;
  seed: number;
  /**
   * CSR slot -> index into `stp`, or -1 for a plain static synapse. Only edges
   * into the song group get an index; that restriction is the whole point.
   */
  stpSlots?: Int32Array | null;
  stp?: StpPool | null;
}

export class Network {
  readonly n: number;
  readonly csr: Csr;
  readonly groupOf: Uint8Array;
  readonly nGroups: number;
  readonly groupSize: Uint32Array;
  params: LifParams;

  readonly v: Float32Array;
  readonly refrac: Int32Array;
  /** Per-neuron low-passed rate in Hz. Brightness comes from this, never from raw spikes. */
  readonly rate: Float32Array;
  /** Per-group mean rate in Hz. */
  readonly groupRate: Float32Array;
  /** Indices of neurons that fired on the last step. */
  readonly spikeIdx: Int32Array;
  spikeCount = 0;
  /** Cumulative spike count, the determinism check in the acceptance criteria. */
  totalSpikes = 0;
  /** Simulation time in seconds. */
  t = 0;

  private ring: Float32Array;
  private ringLen: number;
  private ringPos = 0;
  private delaySteps: number;
  private refSteps: number;
  private rng: Rng;
  private stpSlots: Int32Array | null;
  private stp: StpPool | null;
  private groupSpikes: Uint32Array;

  constructor(opts: NetworkOptions) {
    this.n = opts.n;
    this.csr = opts.csr;
    this.groupOf = opts.groupOf;
    this.nGroups = opts.nGroups;
    this.params = { ...opts.params };
    this.rng = new Rng(opts.seed);
    this.stpSlots = opts.stpSlots ?? null;
    this.stp = opts.stp ?? null;

    this.v = new Float32Array(this.n);
    this.refrac = new Int32Array(this.n);
    this.rate = new Float32Array(this.n);
    this.groupRate = new Float32Array(this.nGroups);
    this.spikeIdx = new Int32Array(this.n);
    this.groupSpikes = new Uint32Array(this.nGroups);
    this.groupSize = new Uint32Array(this.nGroups);
    for (let i = 0; i < this.n; i++) this.groupSize[this.groupOf[i]]++;

    this.delaySteps = 0;
    this.refSteps = 0;
    this.ringLen = 1;
    this.ring = new Float32Array(this.n);
    this.retime();
    this.v.fill(this.params.vRest);
  }

  /** Recompute step-count derived state after dt / delay / t_ref change. */
  retime(): void {
    const p = this.params;
    this.delaySteps = Math.max(1, Math.round(p.delay / p.dt));
    this.refSteps = Math.max(0, Math.round(p.tRef / p.dt));
    const needed = this.delaySteps + 1;
    if (needed !== this.ringLen) {
      this.ringLen = needed;
      this.ring = new Float32Array(this.ringLen * this.n);
      this.ringPos = 0;
    }
  }

  setParams(patch: Partial<LifParams>): void {
    Object.assign(this.params, patch);
    this.retime();
  }

  reset(): void {
    this.v.fill(this.params.vRest);
    this.refrac.fill(0);
    this.rate.fill(0);
    this.groupRate.fill(0);
    this.ring.fill(0);
    this.ringPos = 0;
    this.spikeCount = 0;
    this.totalSpikes = 0;
    this.t = 0;
    this.stp?.reset();
  }

  /**
   * Advance one dt. `iext` is the external drive per neuron, in threshold
   * units (a sustained iext of 1 would park a leak-free neuron at threshold).
   */
  step(iext: Float32Array): number {
    const p = this.params;
    const { dt, tauM, vRest, vThresh, vReset } = p;
    const leak = dt / tauM;
    const noise = p.noiseSigma * Math.sqrt(2 * leak);
    const v = this.v;
    const refrac = this.refrac;
    const ring = this.ring;
    const base = this.ringPos * this.n;

    this.spikeCount = 0;
    this.groupSpikes.fill(0);

    for (let i = 0; i < this.n; i++) {
      const arriving = ring[base + i];
      ring[base + i] = 0;

      if (refrac[i] > 0) {
        refrac[i]--;
        v[i] = vReset;
        continue;
      }

      let vi = v[i];
      vi += leak * (vRest - vi + iext[i]);
      vi += arriving;
      if (noise > 0) vi += noise * this.rng.normal();

      if (vi >= vThresh) {
        v[i] = vReset;
        refrac[i] = this.refSteps;
        this.spikeIdx[this.spikeCount++] = i;
        this.groupSpikes[this.groupOf[i]]++;
      } else {
        v[i] = vi;
      }
    }

    // Deliver this step's spikes into the ring, delaySteps ahead.
    const writeRow = ((this.ringPos + this.delaySteps) % this.ringLen) * this.n;
    const { rowStart, target, weight } = this.csr;
    const stp = this.stp;
    const slots = this.stpSlots;
    const t = this.t;
    for (let s = 0; s < this.spikeCount; s++) {
      const i = this.spikeIdx[s];
      const end = rowStart[i + 1];
      for (let e = rowStart[i]; e < end; e++) {
        let w = weight[e];
        if (w === 0) continue;
        if (stp && slots) {
          const si = slots[e];
          if (si >= 0) w *= stp.release(si, t);
        }
        ring[writeRow + target[e]] += w;
      }
    }

    // Low-passed readouts. Brightness is driven from these, per the
    // photosensitivity rules, not from per-spike flashes.
    const alphaRate = Math.min(1, dt / p.rateTau);
    const invDt = 1 / dt;
    const decay = 1 - alphaRate;
    const rate = this.rate;
    for (let i = 0; i < this.n; i++) rate[i] *= decay;
    for (let s = 0; s < this.spikeCount; s++) {
      rate[this.spikeIdx[s]] += invDt * alphaRate;
    }
    for (let g = 0; g < this.nGroups; g++) {
      const size = this.groupSize[g];
      const inst = size > 0 ? (this.groupSpikes[g] * invDt) / size : 0;
      this.groupRate[g] += (inst - this.groupRate[g]) * alphaRate;
    }

    this.ringPos = (this.ringPos + 1) % this.ringLen;
    this.totalSpikes += this.spikeCount;
    this.t += dt;
    return this.spikeCount;
  }
}
