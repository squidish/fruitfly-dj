/**
 * Spike raster over the last 2 s x k, sorted by group then cell type.
 *
 * Spikes carry AudioContext timestamps, and the panel is drawn only up to
 * getOutputTimestamp().contextTime, so a dot appears exactly when the sound
 * that caused it leaves the speakers.
 *
 * Raster dots are the one place per-spike flashing is allowed: they are far
 * below the 2% viewport area threshold the flash limiter guards.
 */

import { GROUPS } from '../core/circuit.ts';
import { axisText, clear, cssVar, fitCanvas, frame, groupColor } from './theme.ts';

export interface RasterSpike {
  idx: number;
  t: number;
}

export class Raster {
  private canvas: HTMLCanvasElement;
  /** Neuron index -> row. */
  private row = new Int32Array(0);
  private rowGroup = new Uint8Array(0);
  private n = 0;
  private spikes: RasterSpike[] = [];
  /** Firing-rate trace mode. */
  mode: 'raster' | 'rates' = 'raster';
  private rateHistory: Float32Array[] = [];
  private historyLimit = 240;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** Order rows by group, then cell type, then index. */
  setLayout(groupOf: Uint8Array, typeOf: Uint16Array): void {
    this.n = groupOf.length;
    const order = Array.from({ length: this.n }, (_, i) => i);
    order.sort((a, b) => groupOf[a] - groupOf[b] || typeOf[a] - typeOf[b] || a - b);
    this.row = new Int32Array(this.n);
    this.rowGroup = new Uint8Array(this.n);
    for (let r = 0; r < order.length; r++) {
      this.row[order[r]] = r;
      this.rowGroup[r] = groupOf[order[r]];
    }
    this.spikes = [];
    this.rateHistory = [];
  }

  addSpikes(idx: Int32Array, t: Float64Array): void {
    for (let i = 0; i < idx.length; i++) this.spikes.push({ idx: idx[i], t: t[i] });
    // Bounded memory: a very loud passage can push a lot of spikes per frame.
    if (this.spikes.length > 120000) this.spikes.splice(0, this.spikes.length - 120000);
  }

  addRates(groupRates: Float32Array): void {
    this.rateHistory.push(groupRates.slice());
    if (this.rateHistory.length > this.historyLimit) this.rateHistory.shift();
  }

  /** Drop anything older than the visible window. */
  prune(now: number, window: number): void {
    const cutoff = now - window;
    let drop = 0;
    while (drop < this.spikes.length && this.spikes[drop].t < cutoff) drop++;
    if (drop > 0) this.spikes.splice(0, drop);
  }

  draw(now: number, window: number): void {
    const s = fitCanvas(this.canvas);
    if (!s) return;
    clear(s);
    const { top } = frame(s);
    const pad = { l: 6, r: 6, t: top, b: 14 };
    const h = s.height - pad.t - pad.b;
    const w = s.width - pad.l - pad.r;
    const ctx = s.ctx;

    if (this.mode === 'rates') {
      this.drawRates(s.ctx, pad.l, pad.t, w, h);
      axisText({ ...s }, 'group firing rate', pad.l + 2, s.height - 4);
      return;
    }

    if (this.n === 0) return;
    const rowH = h / this.n;
    const dot = Math.max(1, Math.min(3, rowH));

    // Group bands behind the dots, so the sort order is readable at a glance.
    let runStart = 0;
    for (let r = 1; r <= this.n; r++) {
      if (r === this.n || this.rowGroup[r] !== this.rowGroup[runStart]) {
        ctx.fillStyle = groupColor(this.rowGroup[runStart]);
        ctx.globalAlpha = 0.06;
        ctx.fillRect(pad.l, pad.t + runStart * rowH, w, (r - runStart) * rowH);
        ctx.globalAlpha = 1;
        runStart = r;
      }
    }

    const t0 = now - window;
    for (const sp of this.spikes) {
      if (sp.t < t0 || sp.t > now) continue;
      const x = pad.l + ((sp.t - t0) / window) * w;
      const r = this.row[sp.idx];
      ctx.fillStyle = groupColor(this.rowGroup[r]);
      ctx.fillRect(x, pad.t + r * rowH, dot, dot);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.beginPath();
    ctx.moveTo(pad.l + w, pad.t);
    ctx.lineTo(pad.l + w, pad.t + h);
    ctx.stroke();

    axisText(s, `${window.toFixed(1)} s`, pad.l + 2, s.height - 4);
    axisText(s, 'now', s.width - pad.r - 2, s.height - 4, 'right');
  }

  private drawRates(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
    if (this.rateHistory.length < 2) return;
    let peak = 1;
    for (const frameRates of this.rateHistory) {
      for (const v of frameRates) if (v > peak) peak = v;
    }
    for (let g = 0; g < GROUPS.length; g++) {
      ctx.beginPath();
      for (let i = 0; i < this.rateHistory.length; i++) {
        const px = x + (i / Math.max(1, this.rateHistory.length - 1)) * w;
        const py = y + h - (this.rateHistory[i][g] / peak) * h * 0.95;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = groupColor(g);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(`peak ${peak.toFixed(0)} Hz`, x + 2, y + 10);
  }
}
