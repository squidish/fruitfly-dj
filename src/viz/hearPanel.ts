/**
 * "What you hear vs what the fly hears."
 *
 * Top: the full-band spectrum, with the fly's pass band shaded and the band's
 * actual filter response drawn over it. Bottom: the fly-band envelope on the
 * audio clock. The gap between the two is the entire point of the app.
 */

import { Ear } from '../core/ear.ts';
import { axisText, clear, cssVar, fitCanvas, frame, GROUP_COLORS } from './theme.ts';

export interface HearState {
  /** Spectrum in dBFS from the AnalyserNode. */
  spectrum: Float32Array;
  binHz: number;
  sampleRate: number;
  /** Effective band centre, already divided by k. */
  fc: number;
  q: number;
  stages: number;
  /** Fly-band envelope history, oldest first. */
  env: Float32Array;
  envCount: number;
  envRate: number;
  /** Onset times relative to the newest envelope sample, in seconds (negative). */
  onsets: number[];
  /** Ear AGC gain. */
  gain: number;
}

const MIN_DB = -100;
const MAX_DB = -10;

export class HearPanel {
  private canvas: HTMLCanvasElement;
  private responseEar: Ear | null = null;
  private responseKey = '';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  /** Filter magnitude at `hz`, cached until f_c / Q / stages change. */
  private response(state: HearState, hz: number): number {
    const key = `${state.fc}|${state.q}|${state.stages}|${state.sampleRate}`;
    if (key !== this.responseKey || !this.responseEar) {
      this.responseEar = new Ear({
        sampleRate: state.sampleRate,
        fc: state.fc,
        q: state.q,
        stages: state.stages,
        channels: 1,
        jitter: 0,
      });
      this.responseKey = key;
    }
    return this.responseEar.bandMagnitude(hz);
  }

  draw(state: HearState): void {
    const s = fitCanvas(this.canvas);
    if (!s) return;
    clear(s);
    const { top } = frame(s);

    const pad = { l: 34, r: 8, t: top, b: 16 };
    const splitY = pad.t + (s.height - pad.t - pad.b) * 0.58;
    const specH = splitY - pad.t;
    const envY = splitY + 10;
    const envH = s.height - pad.b - envY;
    const w = s.width - pad.l - pad.r;
    const ctx = s.ctx;

    // --- log-frequency spectrum -------------------------------------------
    const fMin = 20;
    const fMax = Math.min(20000, state.sampleRate / 2);
    const xOf = (hz: number) => pad.l + (Math.log(Math.max(fMin, hz) / fMin) / Math.log(fMax / fMin)) * w;

    // Shade the fly's band by its own filter response, so the picture is the
    // real transfer function rather than a rectangle.
    ctx.beginPath();
    ctx.moveTo(pad.l, splitY);
    for (let px = 0; px <= w; px += 2) {
      const hz = fMin * Math.pow(fMax / fMin, px / w);
      const mag = this.response(state, hz);
      ctx.lineTo(pad.l + px, splitY - mag * specH * 0.92);
    }
    ctx.lineTo(pad.l + w, splitY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(240, 165, 60, 0.13)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(240, 165, 60, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Spectrum trace.
    ctx.beginPath();
    let started = false;
    for (let px = 0; px <= w; px++) {
      const hz = fMin * Math.pow(fMax / fMin, px / w);
      const bin = Math.round(hz / Math.max(1e-6, state.binHz));
      if (bin >= state.spectrum.length) break;
      const db = state.spectrum[bin];
      const norm = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
      const y = splitY - norm * specH;
      if (!started) {
        ctx.moveTo(pad.l + px, y);
        started = true;
      } else {
        ctx.lineTo(pad.l + px, y);
      }
    }
    ctx.strokeStyle = cssVar('--text', '#dfe3ee');
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.globalAlpha = 1;

    for (const hz of [100, 1000, 10000]) {
      if (hz > fMax) continue;
      const x = xOf(hz);
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, splitY);
      ctx.stroke();
      axisText(s, hz >= 1000 ? `${hz / 1000}k` : `${hz}`, x, splitY + 10, 'center');
    }
    axisText(s, 'dB', 6, pad.t + 10);
    axisText(s, `f_c ${state.fc.toFixed(0)} Hz`, xOf(state.fc), pad.t + 10, 'center');

    // --- fly-band envelope -------------------------------------------------
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(pad.l, envY, w, envH);

    let peak = 1e-6;
    for (let i = 0; i < state.envCount; i++) if (state.env[i] > peak) peak = state.env[i];

    ctx.beginPath();
    for (let i = 0; i < state.envCount; i++) {
      const x = pad.l + (i / Math.max(1, state.envCount - 1)) * w;
      const y = envY + envH - (state.env[i] / peak) * envH * 0.95;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = GROUP_COLORS.sensor;
    ctx.lineWidth = 1.4;
    ctx.stroke();

    // Full-band onsets: the beat the fly is not responding to.
    const span = state.envCount / Math.max(1, state.envRate);
    for (const rel of state.onsets) {
      const frac = 1 + rel / Math.max(1e-6, span);
      if (frac < 0 || frac > 1) continue;
      const x = pad.l + frac * w;
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.beginPath();
      ctx.moveTo(x, envY);
      ctx.lineTo(x, envY + envH);
      ctx.stroke();
    }

    axisText(s, 'fly-band envelope', pad.l + 2, envY + 11);
    axisText(s, `ear gain ${state.gain.toFixed(2)}x`, s.width - pad.r - 2, envY + 11, 'right');
    axisText(s, `${span.toFixed(1)} s`, s.width - pad.r - 2, s.height - 4, 'right');
  }
}
