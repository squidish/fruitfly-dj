/**
 * Approval is a SELECTIVITY index, not a firing rate.
 *
 *   S = r_song / max(r_sensor, r_floor)          (smoothed over 500 ms x k)
 *   A = (S - S_noise) / (S_ideal - S_noise)
 *
 * S_noise is the response to an energy-matched noise envelope and S_ideal the
 * response to ideal pulse song at the target IPI. Dividing by sensor rate is
 * what stops the volume knob buying affection: louder raises numerator and
 * denominator together.
 */

export interface ApprovalCalibration {
  /** S for an energy-matched noise envelope. */
  sNoise: number;
  /** S for ideal pulse song at the target IPI and f_c. */
  sIdeal: number;
}

export const NEUTRAL_CALIBRATION: ApprovalCalibration = { sNoise: 0, sIdeal: 1 };

export class ApprovalMeter {
  /** Sensor-rate floor in Hz, so silence cannot divide by ~0. */
  rFloor: number;
  /** Smoothing time constant in seconds (500 ms x k). */
  smoothing: number;
  calibration: ApprovalCalibration = { ...NEUTRAL_CALIBRATION };

  private s = 0;

  constructor(opts: { rFloor?: number; smoothing?: number } = {}) {
    this.rFloor = opts.rFloor ?? 2;
    this.smoothing = opts.smoothing ?? 0.5;
  }

  reset(): void {
    this.s = 0;
  }

  setCalibration(c: ApprovalCalibration): void {
    this.calibration = { ...c };
  }

  /** Raw, unsmoothed selectivity for one instant. */
  static rawSelectivity(rSong: number, rSensor: number, rFloor: number): number {
    return rSong / Math.max(rSensor, rFloor);
  }

  update(rSong: number, rSensor: number, dt: number): void {
    const raw = ApprovalMeter.rawSelectivity(rSong, rSensor, this.rFloor);
    const a = Math.min(1, dt / Math.max(1e-4, this.smoothing));
    this.s += (raw - this.s) * a;
  }

  /** Smoothed selectivity index. */
  get selectivity(): number {
    return this.s;
  }

  /** Normalised approval. 0 = indifferent noise, 1 = ideal courtship song. */
  get approval(): number {
    return approvalFrom(this.s, this.calibration);
  }
}

/** The A = (S - S_noise) / (S_ideal - S_noise) mapping, clamped to a sane range. */
export function approvalFrom(s: number, c: ApprovalCalibration): number {
  const span = c.sIdeal - c.sNoise;
  if (!(span > 1e-9)) return 0;
  const a = (s - c.sNoise) / span;
  return a < 0 ? 0 : a > 3 ? 3 : a;
}

/** Status-line bands. Kept here so copy.ts and the fly agree on the thresholds. */
export type ApprovalBand = 'deaf' | 'twitching' | 'considering' | 'courtship' | 'overstimulated';

export function approvalBand(a: number, groomingRate: number, groomThreshold: number): ApprovalBand {
  if (groomingRate > groomThreshold) return 'overstimulated';
  if (a < 0.1) return 'deaf';
  if (a < 0.35) return 'twitching';
  if (a < 0.6) return 'considering';
  return 'courtship';
}
