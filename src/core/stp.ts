/**
 * Tsodyks-Markram short-term plasticity.
 *
 * This is THE temporal assumption of the model (see ASSUMPTIONS.md). A
 * connectome gives wiring and synapse counts, not dynamics; nothing guarantees
 * inter-pulse-interval selectivity falls out of topology alone. So IPI tuning
 * is put here, explicitly, on the edges into the song group only, where the
 * ablation modes can test whether the wiring matters at all.
 *
 * Recursion (Tsodyks, Pawelzik & Markram 1998), for spike n+1 arriving an
 * interval d after spike n:
 *   u' = U + u (1 - U) exp(-d / tau_fac)
 *   x' = 1 + (x - u x - 1) exp(-d / tau_rec)
 *   release = u' x'
 *
 * Short intervals arrive before x has recovered, so they depress. Long ones
 * arrive after u has decayed back to U, so they lose facilitation. The result
 * is a band-pass in IPI, peaked by `npm run tune` at the target.
 */

export interface StpParams {
  /** Baseline release probability. */
  U: number;
  /** Facilitation time constant, seconds (already scaled by k). */
  tauFac: number;
  /** Vesicle recovery time constant, seconds (already scaled by k). */
  tauRec: number;
}

/**
 * A plain facilitating synapse. The fitted defaults the app actually runs with
 * live in src/state/tuned.json and reach the model through DEFAULT_SIM; these
 * are only the fallback for a StpPool constructed without parameters.
 */
export const DEFAULT_STP: StpParams = { U: 0.05, tauFac: 0.08, tauRec: 0.2 };

/**
 * One TM state pair per synapse. Event-driven: state only advances when the
 * presynaptic neuron fires, so cost scales with spikes, not with neurons.
 */
export class StpPool {
  readonly size: number;
  private u: Float32Array;
  private x: Float32Array;
  private last: Float64Array;
  params: StpParams;

  /** Running mean of the release gain, for the bench and the About panel. */
  private gainSum = 0;
  private gainCount = 0;

  constructor(size: number, params: StpParams = DEFAULT_STP) {
    this.size = size;
    this.params = { ...params };
    this.u = new Float32Array(size);
    this.x = new Float32Array(size);
    this.last = new Float64Array(size);
    this.reset();
  }

  reset(): void {
    this.u.fill(this.params.U);
    this.x.fill(1);
    this.last.fill(-1e9);
    this.gainSum = 0;
    this.gainCount = 0;
  }

  /** Mean release gain since the last reset. 1.0 means STP is doing nothing. */
  get meanGain(): number {
    return this.gainCount > 0 ? this.gainSum / this.gainCount : 1;
  }

  get releaseCount(): number {
    return this.gainCount;
  }

  setParams(p: Partial<StpParams>): void {
    Object.assign(this.params, p);
  }

  /**
   * Advance synapse `i` to time `t` and return its release gain, normalised so
   * an isolated spike after a long silence returns 1.0. That keeps w_scale
   * meaning the same thing with STP on or off.
   */
  release(i: number, t: number): number {
    const { U, tauFac, tauRec } = this.params;
    const d = t - this.last[i];
    this.last[i] = t;
    const ef = d >= 30 * tauFac ? 0 : Math.exp(-d / tauFac);
    const er = d >= 30 * tauRec ? 0 : Math.exp(-d / tauRec);
    const u0 = this.u[i];
    const x0 = this.x[i];
    const u = U + u0 * (1 - U) * ef;
    const x = 1 + (x0 - u0 * x0 - 1) * er;
    this.u[i] = u;
    this.x[i] = x;
    const gain = (u * x) / U;
    this.gainSum += gain;
    this.gainCount++;
    return gain;
  }

  /** Steady-state release gain for a periodic train at interval `d`. */
  steadyState(d: number): number {
    const { U, tauFac, tauRec } = this.params;
    const ef = Math.exp(-d / tauFac);
    const er = Math.exp(-d / tauRec);
    const u = U / (1 - (1 - U) * ef);
    const x = (1 - er) / (1 - (1 - u) * er);
    return (u * x) / U;
  }

  /** Read-only view, for tests. */
  state(i: number): { u: number; x: number } {
    return { u: this.u[i], x: this.x[i] };
  }
}
