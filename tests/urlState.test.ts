import { describe, expect, it } from 'vitest';
import { PARAMS, PARAM_BY_KEY, clampState, clampValue, defaultState } from '../src/state/params.ts';
import { STATE_VERSION, decodeState, encodeState } from '../src/state/urlState.ts';

describe('encode/decode', () => {
  it('round-trips a modified state exactly', () => {
    const state = defaultState();
    state.k = 3.35;
    state.fc = 180;
    state.autoFit = true;
    state.preset = 'courtshipRiddim';
    state.ablation = 'shuffled';
    state.targetIpi = 0.05;

    const restored = decodeState(`#${encodeState(state)}`);
    expect(restored.k).toBeCloseTo(3.35, 6);
    expect(restored.fc).toBe(180);
    expect(restored.autoFit).toBe(true);
    expect(restored.preset).toBe('courtshipRiddim');
    expect(restored.ablation).toBe('shuffled');
    expect(restored.targetIpi).toBeCloseTo(0.05, 6);
  });

  it('round-trips every parameter at a non-default value', () => {
    const state = defaultState();
    for (const def of PARAMS) {
      if (def.type === 'range') {
        state[def.key] = clampValue(def, def.default === def.max ? def.min : def.max);
      } else if (def.type === 'toggle') {
        state[def.key] = !def.default;
      } else {
        const other = def.options.find((o) => o.value !== def.default);
        if (other) state[def.key] = other.value;
      }
    }
    const restored = decodeState(`#${encodeState(state)}`);
    for (const def of PARAMS) {
      if (def.type === 'range') expect(restored[def.key]).toBeCloseTo(Number(state[def.key]), 5);
      else expect(restored[def.key]).toEqual(state[def.key]);
    }
  });

  it('writes only what differs from the default, so links stay short', () => {
    const encoded = encodeState(defaultState());
    expect(encoded).toBe(`v=${STATE_VERSION}`);

    const state = defaultState();
    state.k = 4;
    expect(encodeState(state)).toBe(`v=${STATE_VERSION}&k=4`);
  });

  it('falls back to defaults for an empty hash', () => {
    expect(decodeState('')).toEqual(defaultState());
    expect(decodeState('#')).toEqual(defaultState());
  });

  it('clamps out-of-range values instead of rejecting them', () => {
    const restored = decodeState('#v=1&k=9999&fc=-40&inputGain=1e9');
    expect(restored.k).toBe(PARAM_BY_KEY.k.type === 'range' ? PARAM_BY_KEY.k.max : 8);
    expect(restored.fc).toBe(PARAM_BY_KEY.fc.type === 'range' ? PARAM_BY_KEY.fc.min : 60);
    expect(Number(restored.inputGain)).toBeLessThanOrEqual(4);
  });

  it('ignores unknown keys and junk', () => {
    const restored = decodeState('#v=1&notAParam=7&k=2&=&&');
    expect(restored.k).toBe(2);
    expect('notAParam' in restored).toBe(false);
  });

  it('survives a link from a hypothetical future version', () => {
    const restored = decodeState('#v=99&k=2&somethingNew=yes');
    expect(restored.k).toBe(2);
  });

  it('rejects a select value that is not an option', () => {
    expect(decodeState('#v=1&ablation=telepathy').ablation).toBe('connectome');
  });

  it('coerces toggles from both 1/0 and true/false', () => {
    expect(decodeState('#v=1&autoFit=1').autoFit).toBe(true);
    expect(decodeState('#v=1&autoFit=true').autoFit).toBe(true);
    expect(decodeState('#v=1&autoFit=0').autoFit).toBe(false);
  });
});

describe('clampState', () => {
  it('fills in missing keys from the defaults', () => {
    const partial = clampState({ k: 2 });
    expect(partial.k).toBe(2);
    expect(partial.fc).toBe(PARAM_BY_KEY.fc.default);
    expect(Object.keys(partial).sort()).toEqual(PARAMS.map((p) => p.key).sort());
  });

  it('snaps range values onto the step grid', () => {
    const snapped = clampState({ k: 3.3712 });
    expect(Number(snapped.k)).toBeCloseTo(3.35, 6);
  });
});

describe('the schema itself', () => {
  it('has unique keys', () => {
    const keys = PARAMS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every parameter a tooltip and a default inside its own range', () => {
    for (const def of PARAMS) {
      expect(def.tooltip.length, `${def.key} tooltip`).toBeGreaterThan(10);
      if (def.type === 'range') {
        expect(def.default, `${def.key} default`).toBeGreaterThanOrEqual(def.min);
        expect(def.default, `${def.key} default`).toBeLessThanOrEqual(def.max);
      }
      if (def.type === 'select') {
        expect(def.options.some((o) => o.value === def.default), `${def.key} default`).toBe(true);
      }
    }
  });
});
