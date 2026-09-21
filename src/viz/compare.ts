/**
 * Ablation compare.
 *
 * The last few seconds of real drive, re-run through all three wirings offline
 * in the worker and shown as a bar chart. On real data this is an experiment,
 * not a pass/fail: "the wiring barely matters" is a legitimate — and funny —
 * outcome, and the panel says so rather than hiding it.
 */

import { ABLATION_BLURBS, ABLATION_LABELS, type AblationMode } from '../brain/ablation.ts';
import type { CompareResult } from '../audio/messages.ts';
import { clear, cssVar, fitCanvas, frame, GROUP_COLORS } from './theme.ts';

export class ComparePanel {
  private canvas: HTMLCanvasElement;
  private caption: HTMLElement | null;
  private results: CompareResult[] = [];
  private seconds = 0;
  private pending = false;

  constructor(canvas: HTMLCanvasElement, caption?: HTMLElement | null) {
    this.canvas = canvas;
    this.caption = caption ?? null;
  }

  setPending(): void {
    this.pending = true;
    this.draw();
  }

  setResults(results: CompareResult[], seconds: number): void {
    this.results = results;
    this.seconds = seconds;
    this.pending = false;
    this.draw();
    this.writeCaption();
  }

  /** Say out loud what the comparison found, including the unflattering answer. */
  private writeCaption(): void {
    if (!this.caption) return;
    if (this.results.length === 0) {
      this.caption.textContent = 'Not enough audio yet — let it play for a few seconds and try again.';
      return;
    }
    const by = (m: AblationMode) => this.results.find((r) => r.mode === m)?.approval ?? 0;
    const real = by('connectome');
    const shuffled = by('shuffled');
    const earOnly = by('earOnly');

    const parts: string[] = [];
    if (real > shuffled * 1.5) {
      parts.push('Shuffling the wiring costs the fly most of its response, so the topology is doing real work here.');
    } else if (shuffled > real * 1.2) {
      parts.push('The shuffled wiring did better. That happens, and it is worth sitting with.');
    } else {
      parts.push('Shuffled does about as well as the real wiring: on this input, the topology barely matters.');
    }
    if (earOnly > real * 0.9) {
      parts.push('Sensors wired straight to the song group do just as well, which says the ear is carrying the selectivity.');
    }
    parts.push(`Measured over the last ${this.seconds.toFixed(1)} s of what actually played.`);
    this.caption.textContent = parts.join(' ');
  }

  draw(): void {
    const s = fitCanvas(this.canvas);
    if (!s) return;
    clear(s);
    const { top } = frame(s);
    const ctx = s.ctx;
    const pad = { l: 78, r: 40, t: top + 4, b: 8 };
    const w = s.width - pad.l - pad.r;
    const h = s.height - pad.t - pad.b;

    if (this.pending) {
      ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('re-running the last few seconds…', pad.l, pad.t + h / 2);
      return;
    }
    if (this.results.length === 0) {
      ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('Press Compare once something has been playing.', pad.l - 60, pad.t + h / 2);
      return;
    }

    const max = Math.max(0.2, ...this.results.map((r) => r.approval));
    const rowH = h / this.results.length;
    this.results.forEach((r, i) => {
      const y = pad.t + i * rowH + rowH * 0.2;
      const barH = rowH * 0.55;
      const bw = (r.approval / max) * w;

      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(pad.l, y, w, barH);
      ctx.fillStyle = r.mode === 'connectome' ? GROUP_COLORS.song : GROUP_COLORS.relay2;
      ctx.globalAlpha = r.mode === 'connectome' ? 0.95 : 0.6;
      ctx.fillRect(pad.l, y, Math.max(1, bw), barH);
      ctx.globalAlpha = 1;

      ctx.fillStyle = cssVar('--text', '#dfe3ee');
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(ABLATION_LABELS[r.mode], pad.l - 8, y + barH / 2);
      ctx.textAlign = 'left';
      ctx.fillText(r.approval.toFixed(2), pad.l + Math.max(1, bw) + 6, y + barH / 2);
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = 'left';
    });
  }

  static blurb(mode: AblationMode): string {
    return ABLATION_BLURBS[mode];
  }
}
