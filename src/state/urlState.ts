/**
 * Versioned URL-hash serialisation, so a preset is shareable without a backend.
 *
 * Only values that differ from the default are written, which keeps links short
 * and means a future default change is picked up rather than frozen into every
 * old link. Unknown keys are dropped and out-of-range values are clamped.
 */

import { PARAMS, PARAM_BY_KEY, clampValue, defaultState, type ParamState, type ParamValue } from './params.ts';

export const STATE_VERSION = 1;

function encodeValue(value: ParamValue): string {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return String(Number(value.toPrecision(6)));
  return String(value);
}

export function encodeState(state: ParamState): string {
  const parts: string[] = [`v=${STATE_VERSION}`];
  for (const def of PARAMS) {
    const value = state[def.key];
    if (value === undefined || value === def.default) continue;
    parts.push(`${encodeURIComponent(def.key)}=${encodeURIComponent(encodeValue(value))}`);
  }
  return parts.join('&');
}

export function decodeState(hash: string): ParamState {
  const state = defaultState();
  const raw = hash.replace(/^#/, '');
  if (!raw) return state;

  const params = new URLSearchParams(raw);
  const version = Number(params.get('v'));
  // Version 1 is the only shape there has ever been. A newer link still loads:
  // unknown keys are ignored and the rest is clamped, which beats a blank page.
  if (Number.isFinite(version) && version > STATE_VERSION) {
    console.warn(`Fly DJ: link is from a newer version (v${version}); loading what is recognisable.`);
  }

  for (const [key, value] of params) {
    if (key === 'v') continue;
    const def = PARAM_BY_KEY[key];
    if (!def) continue;
    state[key] = clampValue(def, def.type === 'range' ? Number(value) : value);
  }
  return state;
}

/** Replace the hash without adding a history entry per slider tick. */
export function writeHash(state: ParamState): void {
  const next = `#${encodeState(state)}`;
  if (window.location.hash === next) return;
  window.history.replaceState(null, '', next);
}

export function readHash(): ParamState {
  return decodeState(window.location.hash);
}

/** Full shareable URL for the current state. */
export function shareUrl(state: ParamState): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#${encodeState(state)}`;
}
