/**
 * Inter-pulse-interval plot.
 *
 * Two histograms — full-band onset intervals and fly-band envelope-peak
 * intervals — over the MEASURED tuning curve from calibration. Nothing here is
 * a drawn Gaussian: the curve is whatever the sweep actually found, which is
 * the only way the plot can ever disagree with the model.
 */

import type { TuningPoint } from '../brain/calibrate.ts';
import { axisText, clear, cssVar, fitCanvas, frame, GROUP_COLORS } from './theme.ts';

export interface IpiState {
  /** Fly-band envelope-peak intervals in seconds. */
  flyBand: Float32Array;
  /** Full-band onset intervals in seconds. */
  fullBand: Float32Array;
  /** Measured tuning curve, in the fly's own (k-scaled) time. */
  curve: TuningPoint[];
  targetIpi: number;
  k: number;
  calibrating: boolean;
}

const BINS = 40;

function histogram(values: ArrayLike<number>, min: number, max: number): Float32Array {
  const out = new Float32Array(BINS);
  const logMin = Math.log(min);
  const span = Math.log(max) - logMin;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v > min) || v > max) continue;
    const bin = Math.min(BINS - 1, Math.floor(((Math.log(v) - logMin) / span) * BINS));
    out[bin]++;
  }
  let peak = 0;
  for (const v of out) if (v > peak) peak = v;
  if (peak > 0) for (let i = 0; i < BINS; i++) out[i] /= peak;
  return out;
}

export class IpiPlot {
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  draw(state: IpiState): void {
    const s = fitCanvas(this.canvas);
    if (!s) return;
    clear(s);
    const { top } = frame(s);
    const ctx = s.ctx;
    const pad = { l: 28, r: 8, t: top, b: 22 };
    const w = s.width - pad.l - pad.r;
    const h = s.height - pad.t - pad.b;

    // Axis spans the sweep range in fly time, so it moves with Fly size.
    const min = 0.008 * state.k;
    const max = 0.5 * state.k;
    const xOf = (v: number) => pad.l + (Math.log(Math.max(min, v) / min) / Math.log(max / min)) * w;

    // Measured tuning curve, filled.
    if (state.curve.length > 1) {
      let peak = 1e-9;
      for (const p of state.curve) if (p.s > peak) peak = p.s;
      ctx.beginPath();
      ctx.moveTo(xOf(state.curve[0].ipi), pad.t + h);
      for (const p of state.curve) ctx.lineTo(xOf(p.ipi), pad.t + h - (p.s / peak) * h * 0.92);
      ctx.lineTo(xOf(state.curve[state.curve.length - 1].ipi), pad.t + h);
      ctx.closePath();
      ctx.fillStyle = 'rgba(224, 85, 143, 0.16)';
      ctx.fill();
      ctx.strokeStyle = GROUP_COLORS.song;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    const drawHist = (values: ArrayLike<number>, color: string, alpha: number) => {
      if (values.length === 0) return;
      const hist = histogram(values, min, max);
      const bw = w / BINS;
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      for (let i = 0; i < BINS; i++) {
        if (hist[i] <= 0) continue;
        const bh = hist[i] * h * 0.75;
        ctx.fillRect(pad.l + i * bw + 0.5, pad.t + h - bh, Math.max(1, bw - 1), bh);
      }
      ctx.globalAlpha = 1;
    };

    drawHist(state.fullBand, cssVar('--text', '#dfe3ee'), 0.3);
    drawHist(state.flyBand, GROUP_COLORS.sensor, 0.55);

    // Target IPI marker, in fly time.
    const tx = xOf(state.targetIpi * state.k);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, pad.t);
    ctx.lineTo(tx, pad.t + h);
    ctx.stroke();
    ctx.setLineDash([]);
    axisText(s, `target ${(state.targetIpi * state.k * 1000).toFixed(0)} ms`, tx, pad.t + 10, 'center');

    for (const ms of [10, 20, 50, 100, 200, 400]) {
      const v = ms / 1000;
      if (v < min || v > max) continue;
      const x = xOf(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + h);
      ctx.stroke();
      axisText(s, `${ms}`, x, s.height - 10, 'center');
    }
    axisText(s, 'interval (ms, fly time)', pad.l, s.height - 1);

    if (state.calibrating) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(pad.l, pad.t, w, h);
      ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('measuring tuning curve…', pad.l + w / 2, pad.t + h / 2);
      ctx.textAlign = 'left';
    }
  }
}
