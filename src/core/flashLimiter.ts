/**
 * Photosensitivity guard.
 *
 * Pulse song at ~28 Hz driven straight onto the visuals is a seizure risk, and
 * the whole app is built around pulse song. So every large element's luminance
 * goes through here first: at most 3 flashes per second for anything covering
 * more than 2% of the viewport, where a "flash" is a pair of opposing
 * luminance changes, each at least `minDelta`.
 *
 * Small elements (raster dots) bypass the limiter — WCAG's general flash
 * threshold only applies above the area threshold.
 */

export interface FlashLimiterOptions {
  /** Flashes permitted inside the rolling window. */
  maxFlashes?: number;
  /** Window length in seconds. */
  windowSec?: number;
  /** Luminance change (0..1) that counts as a change. */
  minDelta?: number;
  /** Viewport fraction above which an element is "large". */
  largeAreaFraction?: number;
}

interface Track {
  held: number;
  dir: -1 | 0 | 1;
  times: number[];
}

export class FlashLimiter {
  readonly maxFlashes: number;
  readonly windowSec: number;
  readonly minDelta: number;
  readonly largeAreaFraction: number;
  private tracks = new Map<string, Track>();

  constructor(opts: FlashLimiterOptions = {}) {
    this.maxFlashes = opts.maxFlashes ?? 3;
    this.windowSec = opts.windowSec ?? 1;
    this.minDelta = opts.minDelta ?? 0.1;
    this.largeAreaFraction = opts.largeAreaFraction ?? 0.02;
  }

  reset(): void {
    this.tracks.clear();
  }

  /**
   * Clamp a requested luminance for element `id`.
   *
   * @param value requested relative luminance, 0..1
   * @param areaFraction fraction of the viewport the element covers
   * @param now seconds, monotonic
   * @returns the luminance the caller may actually use
   */
  limit(id: string, value: number, areaFraction: number, now: number): number {
    if (areaFraction <= this.largeAreaFraction) return value;

    let tr = this.tracks.get(id);
    if (!tr) {
      tr = { held: value, dir: 0, times: [] };
      this.tracks.set(id, tr);
      return value;
    }

    const d = value - tr.held;
    if (Math.abs(d) < this.minDelta) {
      // Inside the allowed excursion band, so this is not a change at all and
      // the anchor stays put. Wobble smaller than minDelta can therefore never
      // spend budget, and can never drift: it stays within one threshold of
      // the anchor until something big enough re-anchors it.
      return value;
    }

    const dir: -1 | 1 = d > 0 ? 1 : -1;
    // WCAG counts a flash as a PAIR of opposing changes, so a monotonic ramp
    // -- however large -- is one transition and is not limited. Only a
    // reversal spends budget. That is deliberately not the same as limiting
    // the rate of change.
    const completesPair = tr.dir !== 0 && dir !== tr.dir;

    if (completesPair) {
      this.prune(tr, now);
      if (tr.times.length >= this.maxFlashes) {
        // Budget spent: hold just inside the threshold rather than snapping.
        return tr.held + dir * this.minDelta * 0.999;
      }
      tr.times.push(now);
    }

    tr.held = value;
    tr.dir = dir;
    return value;
  }

  /** Flashes counted for `id` inside the current window. For tests and the About panel. */
  flashCount(id: string, now: number): number {
    const tr = this.tracks.get(id);
    if (!tr) return 0;
    this.prune(tr, now);
    return tr.times.length;
  }

  private prune(tr: Track, now: number): void {
    const cutoff = now - this.windowSec;
    while (tr.times.length > 0 && tr.times[0] <= cutoff) tr.times.shift();
  }
}
