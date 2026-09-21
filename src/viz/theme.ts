/**
 * One palette and one legend for every panel, plus the canvas plumbing they
 * all need. Group colour is the thing that ties the raster, the graph, the 3D
 * cloud and the legend together, so it is defined exactly once.
 */

import { GROUPS, type GroupName } from '../core/circuit.ts';

export const GROUP_COLORS: Record<GroupName, string> = {
  sensor: '#f0a53c',
  relay1: '#3fbfb0',
  relay2: '#4d90d9',
  song: '#e0558f',
  groom: '#7cc45c',
  other: '#8b8fa3',
};

export const GROUP_LABELS: Record<GroupName, string> = {
  sensor: 'Sensors (JO)',
  relay1: 'Relay 1 (AMMC)',
  relay2: 'Relay 2 (WED)',
  song: 'Song',
  groom: 'Grooming',
  other: 'Other',
};

export function groupColor(index: number): string {
  return GROUP_COLORS[GROUPS[index] ?? 'other'];
}

/** Excitatory / inhibitory edge colours, used by the graph and the legend. */
export const EDGE_EXC = 'rgba(120, 190, 255, 0.55)';
export const EDGE_INH = 'rgba(224, 85, 143, 0.6)';

export function cssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export interface Surface {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

/** Size a canvas to its box in device pixels and scale the context to CSS units. */
export function fitCanvas(canvas: HTMLCanvasElement): Surface | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, width, height, dpr };
}

export function clear(s: Surface): void {
  s.ctx.clearRect(0, 0, s.width, s.height);
}

/** Panel chrome shared by every plot: background, border, title. */
export function frame(s: Surface, title?: string): { top: number } {
  const bg = cssVar('--panel-plot', '#12141c');
  s.ctx.fillStyle = bg;
  s.ctx.fillRect(0, 0, s.width, s.height);
  if (!title) return { top: 6 };
  s.ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
  s.ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  s.ctx.textBaseline = 'top';
  s.ctx.fillText(title, 8, 6);
  return { top: 24 };
}

export function axisText(s: Surface, text: string, x: number, y: number, align: CanvasTextAlign = 'left'): void {
  s.ctx.fillStyle = cssVar('--text-dim', '#8b8fa3');
  s.ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
  s.ctx.textAlign = align;
  s.ctx.textBaseline = 'alphabetic';
  s.ctx.fillText(text, x, y);
  s.ctx.textAlign = 'left';
}

/** Build the one shared legend as DOM, so it is selectable and screen-readable. */
export function renderLegend(host: HTMLElement): void {
  host.innerHTML = '';
  for (const g of GROUPS) {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const dot = document.createElement('span');
    dot.className = 'legend-dot';
    dot.style.background = GROUP_COLORS[g];
    item.append(dot, document.createTextNode(GROUP_LABELS[g]));
    host.append(item);
  }
  const inh = document.createElement('span');
  inh.className = 'legend-item';
  const bar = document.createElement('span');
  bar.className = 'legend-dash';
  inh.append(bar, document.createTextNode('Inhibitory'));
  host.append(inh);
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
