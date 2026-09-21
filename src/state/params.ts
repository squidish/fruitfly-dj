/**
 * Every parameter, defined exactly once.
 *
 * The control panel, the URL hash, the worker message schema and the About
 * panel are all generated from this list. Adding a knob means adding one entry
 * here and nothing else.
 */

import { ABLATION_MODES, type AblationMode } from '../brain/ablation.ts';
import { PRESET_IDS, PRESETS, type GeneratorSettings } from '../audio/patterns.ts';
import { DEFAULT_SIM, type SimConfig } from '../core/sim.ts';
import tuned from './tuned.json';

export type Tier = 'basic' | 'advanced';
export type ParamValue = number | string | boolean;

export type ParamGroup =
  | 'source'
  | 'generator'
  | 'fly'
  | 'ear'
  | 'brain'
  | 'plasticity'
  | 'model';

export const GROUP_LABELS: Record<ParamGroup, string> = {
  source: 'Source',
  generator: 'Generator',
  fly: 'Fly',
  ear: 'Hearing',
  brain: 'Brain dynamics',
  plasticity: 'Short-term plasticity',
  model: 'Model',
};

interface BaseDef {
  key: string;
  label: string;
  group: ParamGroup;
  tier: Tier;
  /** One sentence of biology, shown as a tooltip. */
  tooltip: string;
  /** Changing this invalidates S_noise and S_ideal and triggers recalibration. */
  affectsCalibration?: boolean;
  /** Only meaningful when this predicate holds; the UI dims it otherwise. */
  enabledWhen?: (state: ParamState) => boolean;
}

export interface RangeDef extends BaseDef {
  type: 'range';
  min: number;
  max: number;
  step: number;
  default: number;
  unit?: string;
  /** Display multiplier, e.g. 1000 to show seconds as milliseconds. */
  scale?: number;
  precision?: number;
}

export interface SelectDef extends BaseDef {
  type: 'select';
  options: { value: string; label: string }[];
  default: string;
}

export interface ToggleDef extends BaseDef {
  type: 'toggle';
  default: boolean;
}

export type ParamDef = RangeDef | SelectDef | ToggleDef;

export type ParamState = Record<string, ParamValue>;

/** D. melanogaster ~35 ms, D. simulans ~50 ms. Both approximate. */
export const SPECIES: { value: string; label: string; ipi: number }[] = [
  { value: 'melanogaster', label: 'D. melanogaster (~35 ms)', ipi: 0.035 },
  { value: 'simulans', label: 'D. simulans (~50 ms)', ipi: 0.05 },
  { value: 'custom', label: 'Custom', ipi: 0.035 },
];

export const PARAMS: ParamDef[] = [
  // ---- Source -------------------------------------------------------------
  {
    key: 'source',
    label: 'Source',
    group: 'source',
    tier: 'basic',
    type: 'select',
    default: 'generator',
    options: [
      { value: 'generator', label: 'Generator' },
      { value: 'track', label: 'Track' },
      { value: 'file', label: 'Dropped file' },
      { value: 'mic', label: 'Microphone' },
    ],
    tooltip: 'Where the sound comes from. Files and microphone stay on your machine.',
  },
  {
    key: 'volume',
    label: 'Volume',
    group: 'source',
    tier: 'basic',
    type: 'range',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.5,
    tooltip: 'Speaker level only. The fly has its own gain control, so this does not change how much it likes anything.',
  },

  // ---- Generator ----------------------------------------------------------
  {
    key: 'preset',
    label: 'Preset',
    group: 'generator',
    tier: 'basic',
    type: 'select',
    default: 'fourOnTheFloor',
    options: PRESET_IDS.map((id) => ({ value: id, label: PRESETS[id].label })),
    tooltip: 'Three starting points: one the fly ignores, one it loves, and one that needs a bigger fly.',
  },
  {
    key: 'bpm',
    label: 'BPM',
    group: 'generator',
    tier: 'basic',
    type: 'range',
    min: 90,
    max: 180,
    step: 1,
    default: 128,
    unit: 'BPM',
    tooltip: 'Tempo. A 16th note at 128 BPM is 117 ms, about 3.3 courtship inter-pulse intervals.',
  },
  {
    key: 'kick',
    label: 'Kick',
    group: 'generator',
    tier: 'basic',
    type: 'select',
    default: 'four',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'four', label: 'Four on the floor' },
      { value: 'broken', label: 'Broken' },
    ],
    tooltip: 'A kick lives around 45-120 Hz, an octave or two below anything the fly can hear.',
  },
  {
    key: 'hats',
    label: 'Hats',
    group: 'generator',
    tier: 'basic',
    type: 'select',
    default: '16th',
    options: [
      { value: 'off', label: 'Off' },
      { value: '8th', label: '8th notes' },
      { value: '16th', label: '16th notes' },
    ],
    tooltip: 'Hi-hat energy sits above 6 kHz. The ear model puts it roughly 70 dB down.',
  },
  {
    key: 'snareRolls',
    label: 'Snare rolls',
    group: 'generator',
    tier: 'basic',
    type: 'toggle',
    default: true,
    tooltip: 'Snares are broadband, so a little of each one does reach the fly band.',
  },
  {
    key: 'bass',
    label: 'Bass',
    group: 'generator',
    tier: 'basic',
    type: 'select',
    default: '8th',
    options: [
      { value: 'off', label: 'Off' },
      { value: '8th', label: '8th notes' },
      { value: '16th', label: '16th notes' },
      { value: 'offbeat', label: 'Offbeat' },
    ],
    tooltip: 'A 16th-note bass line is the one pattern a resized fly can dance to.',
  },
  {
    key: 'bassHz',
    label: 'Bass note',
    group: 'generator',
    tier: 'advanced',
    type: 'range',
    min: 40,
    max: 160,
    step: 0.1,
    default: 55,
    unit: 'Hz',
    precision: 1,
    tooltip: 'Bass fundamental. Set the fly band on top of it and the fly starts hearing the bass line.',
  },
  {
    key: 'pad',
    label: 'Pad',
    group: 'generator',
    tier: 'basic',
    type: 'toggle',
    default: true,
    tooltip: 'A slow pad adds energy but no onsets, so it is close to silence as far as the fly is concerned.',
  },

  // ---- Fly ----------------------------------------------------------------
  {
    key: 'k',
    label: 'Fly size',
    group: 'fly',
    tier: 'basic',
    type: 'range',
    min: 1,
    max: 8,
    step: 0.05,
    default: 1,
    unit: 'x',
    precision: 2,
    affectsCalibration: true,
    tooltip: 'A bigger fly is a slower fly: every time constant scales up and the hearing band moves down.',
  },
  {
    key: 'autoFit',
    label: 'Auto-fit size',
    group: 'fly',
    tier: 'basic',
    type: 'toggle',
    default: false,
    tooltip: 'Sizes the fly so the music’s own beat lands on its preferred inter-pulse interval.',
  },
  {
    key: 'sex',
    label: 'Fly sex',
    group: 'fly',
    tier: 'basic',
    type: 'select',
    default: 'female',
    options: [
      { value: 'female', label: 'Female' },
      { value: 'male', label: 'Male' },
    ],
    tooltip: 'Females do not sing, so the dance vocabulary differs. Fixed by the data on a real connectome.',
  },
  {
    key: 'flySings',
    label: 'Let the fly sing',
    group: 'fly',
    tier: 'basic',
    type: 'toggle',
    default: false,
    enabledWhen: (s) => s.sex === 'male',
    tooltip: 'A male sings pulse song back at you. Mixed after the ear tap, so he cannot hear himself.',
  },

  // ---- Hearing ------------------------------------------------------------
  {
    key: 'fc',
    label: 'Hearing band centre',
    group: 'ear',
    tier: 'basic',
    type: 'range',
    min: 60,
    max: 600,
    step: 1,
    default: 250,
    unit: 'Hz',
    affectsCalibration: true,
    tooltip: 'Johnston’s organ is tuned near 250 Hz, the carrier of courtship song.',
  },
  {
    key: 'inputGain',
    label: 'Sensitivity',
    group: 'ear',
    tier: 'basic',
    type: 'range',
    min: 0.25,
    max: 4,
    step: 0.05,
    default: 1,
    unit: 'x',
    precision: 2,
    affectsCalibration: true,
    tooltip: 'How hard the ear drives the sensory neurons. This is the fly’s gain, not the volume knob.',
  },
  {
    key: 'q',
    label: 'Band sharpness (Q)',
    group: 'ear',
    tier: 'advanced',
    type: 'range',
    min: 0.5,
    max: 8,
    step: 0.1,
    default: 2,
    precision: 1,
    affectsCalibration: true,
    tooltip: 'Quality factor of each band-pass section. Two sections are cascaded per channel.',
  },
  {
    key: 'tauEnv',
    label: 'Envelope τ',
    group: 'ear',
    tier: 'advanced',
    type: 'range',
    min: 0.0005,
    max: 0.02,
    step: 0.0005,
    default: 0.003,
    unit: 'ms',
    scale: 1000,
    precision: 1,
    affectsCalibration: true,
    tooltip: 'How fast the envelope follows the carrier. Longer fuses adjacent pulses together.',
  },
  {
    key: 'deflGain',
    label: 'Deflection gain',
    group: 'ear',
    tier: 'advanced',
    type: 'range',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.6,
    precision: 2,
    affectsCalibration: true,
    tooltip: 'Drive from the sub-bass deflection channel. Mapping sub-bass here is artistic licence.',
  },
  {
    key: 'agc',
    label: 'Auditory gain control',
    group: 'ear',
    tier: 'advanced',
    type: 'toggle',
    default: true,
    affectsCalibration: true,
    tooltip: 'Peak-following adaptation to overall loudness. Turn it off and the volume knob buys affection again.',
  },

  // ---- Brain dynamics -----------------------------------------------------
  {
    key: 'wScale',
    label: 'Weight scale',
    group: 'brain',
    tier: 'advanced',
    type: 'range',
    min: 0.0005,
    max: 0.03,
    step: 0.0001,
    default: tuned.wScale,
    precision: 4,
    affectsCalibration: true,
    tooltip: 'Threshold fraction contributed by one synapse. Weight = synapse count x this.',
  },
  {
    key: 'inhibScale',
    label: 'Inhibition scale',
    group: 'brain',
    tier: 'advanced',
    type: 'range',
    min: 0,
    max: 3,
    step: 0.01,
    default: tuned.inhibScale,
    precision: 2,
    affectsCalibration: true,
    tooltip: 'Extra gain on GABA and Glu synapses. Local inhibition is what trims a burst to one spike per pulse.',
  },
  {
    key: 'tauM',
    label: 'Membrane τ',
    group: 'brain',
    tier: 'advanced',
    type: 'range',
    min: 0.002,
    max: 0.05,
    step: 0.0005,
    default: tuned.tauM,
    unit: 'ms',
    scale: 1000,
    precision: 1,
    affectsCalibration: true,
    tooltip: 'How long a neuron remembers its input. Longer means more summation across pulses.',
  },
  {
    key: 'vThresh',
    label: 'Threshold',
    group: 'brain',
    tier: 'advanced',
    type: 'range',
    min: 0.3,
    max: 2,
    step: 0.01,
    default: 1,
    precision: 2,
    affectsCalibration: true,
    tooltip: 'Spike threshold in normalised units, where rest is 0.',
  },
  {
    key: 'noiseSigma',
    label: 'Noise σ',
    group: 'brain',
    tier: 'advanced',
    type: 'range',
    min: 0,
    max: 0.3,
    step: 0.005,
    default: 0.04,
    precision: 3,
    affectsCalibration: true,
    tooltip: 'Membrane noise, drawn from the seeded generator so runs stay reproducible.',
  },
  {
    key: 'caffeine',
    label: 'Caffeine',
    group: 'brain',
    tier: 'advanced',
    type: 'toggle',
    default: false,
    affectsCalibration: true,
    tooltip: 'Macro: drops the threshold and raises the noise. The fly gets jumpy and less discerning.',
  },

  // ---- Short-term plasticity ---------------------------------------------
  {
    key: 'species',
    label: 'Species preset',
    group: 'plasticity',
    tier: 'advanced',
    type: 'select',
    default: 'melanogaster',
    options: SPECIES.map((s) => ({ value: s.value, label: s.label })),
    tooltip: 'Sets the target inter-pulse interval. Both values are approximate.',
  },
  {
    key: 'targetIpi',
    label: 'Target IPI',
    group: 'plasticity',
    tier: 'advanced',
    type: 'range',
    min: 0.01,
    max: 0.12,
    step: 0.001,
    default: 0.035,
    unit: 'ms',
    scale: 1000,
    precision: 0,
    affectsCalibration: true,
    tooltip: 'The interval the song group is tuned to. This is the only place it enters the model.',
  },
  {
    key: 'U',
    label: 'Release probability U',
    group: 'plasticity',
    tier: 'advanced',
    type: 'range',
    min: 0.01,
    max: 0.6,
    step: 0.005,
    default: tuned.U,
    precision: 3,
    affectsCalibration: true,
    tooltip: 'Baseline vesicle release. Low means strongly facilitating, which is what creates the band-pass.',
  },
  {
    key: 'tauFac',
    label: 'Facilitation τ',
    group: 'plasticity',
    tier: 'advanced',
    type: 'range',
    min: 0.005,
    max: 0.5,
    step: 0.001,
    default: tuned.tauFac,
    unit: 'ms',
    scale: 1000,
    precision: 0,
    affectsCalibration: true,
    tooltip: 'How long facilitation lasts. Sets where the tuning curve falls off at long intervals.',
  },
  {
    key: 'tauRec',
    label: 'Recovery τ',
    group: 'plasticity',
    tier: 'advanced',
    type: 'range',
    min: 0.02,
    max: 1.2,
    step: 0.005,
    default: tuned.tauRec,
    unit: 'ms',
    scale: 1000,
    precision: 0,
    affectsCalibration: true,
    tooltip: 'How long vesicles take to come back. Sets how hard short intervals are suppressed.',
  },

  // ---- Model --------------------------------------------------------------
  {
    key: 'ablation',
    label: 'Wiring',
    group: 'model',
    tier: 'advanced',
    type: 'select',
    default: 'connectome',
    options: ABLATION_MODES.map((m) => ({
      value: m,
      label: m === 'connectome' ? 'Connectome' : m === 'shuffled' ? 'Shuffled' : 'Ear only',
    })),
    affectsCalibration: true,
    tooltip: 'Swap the real wiring for a degree-preserving shuffle, or bypass it entirely.',
  },
  {
    key: 'seed',
    label: 'Seed',
    group: 'model',
    tier: 'advanced',
    type: 'range',
    min: 1,
    max: 9999,
    step: 1,
    default: 1,
    precision: 0,
    affectsCalibration: true,
    tooltip: 'Seeds every random draw. The same seed and the same input give identical spikes.',
  },
];

export const PARAM_BY_KEY: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.key, p]));

export const CALIBRATION_KEYS: string[] = PARAMS.filter((p) => p.affectsCalibration).map((p) => p.key);

export function defaultState(): ParamState {
  const out: ParamState = {};
  for (const p of PARAMS) out[p.key] = p.default;
  return out;
}

/** Coerce and clamp one value. Out-of-range values are clamped, not rejected. */
export function clampValue(def: ParamDef, raw: ParamValue): ParamValue {
  switch (def.type) {
    case 'range': {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) return def.default;
      const clamped = Math.min(def.max, Math.max(def.min, n));
      // Snap to the step grid so URL round-trips are exact.
      const steps = Math.round((clamped - def.min) / def.step);
      return Number((def.min + steps * def.step).toFixed(10));
    }
    case 'select': {
      const s = String(raw);
      return def.options.some((o) => o.value === s) ? s : def.default;
    }
    case 'toggle':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
  }
}

export function clampState(state: ParamState): ParamState {
  const out = defaultState();
  for (const [key, value] of Object.entries(state)) {
    const def = PARAM_BY_KEY[key];
    if (!def) continue;
    out[key] = clampValue(def, value);
  }
  return out;
}

/** The "Caffeine" macro, applied on top of the user's own settings. */
export function applyCaffeine(state: ParamState): { vThresh: number; noiseSigma: number } {
  const vThresh = Number(state.vThresh);
  const noiseSigma = Number(state.noiseSigma);
  if (!state.caffeine) return { vThresh, noiseSigma };
  return { vThresh: vThresh * 0.75, noiseSigma: noiseSigma + 0.06 };
}

export function isDefault(key: string, value: ParamValue): boolean {
  const def = PARAM_BY_KEY[key];
  return !!def && def.default === value;
}

/**
 * Map the UI state onto the simulation config. The simulation never sees a
 * ParamState, and the UI never sees a SimConfig; this is the only bridge.
 */
export function toSimConfig(state: ParamState, sampleRate: number): SimConfig {
  const { vThresh, noiseSigma } = applyCaffeine(state);
  return {
    ...DEFAULT_SIM,
    sampleRate,
    seed: Number(state.seed),
    k: Number(state.k),
    fc: Number(state.fc),
    q: Number(state.q),
    tauEnv: Number(state.tauEnv),
    agc: Boolean(state.agc),
    inputGain: Number(state.inputGain),
    deflGain: Number(state.deflGain),
    tauM: Number(state.tauM),
    vThresh,
    noiseSigma,
    wScale: Number(state.wScale),
    inhibScale: Number(state.inhibScale),
    U: Number(state.U),
    tauFac: Number(state.tauFac),
    tauRec: Number(state.tauRec),
    targetIpi: Number(state.targetIpi),
  };
}

export function ablationOf(state: ParamState): AblationMode {
  const v = String(state.ablation);
  return (ABLATION_MODES as readonly string[]).includes(v) ? (v as AblationMode) : 'connectome';
}

/** Map the UI state onto the generator, starting from the chosen preset. */
export function toGeneratorSettings(state: ParamState): GeneratorSettings {
  const presetId = String(state.preset);
  const preset = PRESETS[presetId as keyof typeof PRESETS] ?? PRESETS.fourOnTheFloor;
  const base = { ...preset.settings };
  return {
    ...base,
    bpm: Number(state.bpm),
    kick: state.kick as GeneratorSettings['kick'],
    hats: state.hats as GeneratorSettings['hats'],
    snareRolls: Boolean(state.snareRolls),
    bass: state.bass as GeneratorSettings['bass'],
    bassHz: Number(state.bassHz),
    pad: Boolean(state.pad),
  };
}

/** Settings a preset dictates, so selecting one updates the visible controls. */
export function presetOverrides(presetId: string): Partial<ParamState> {
  const preset = PRESETS[presetId as keyof typeof PRESETS];
  if (!preset) return {};
  const s = preset.settings;
  return {
    bpm: s.bpm,
    kick: s.kick,
    hats: s.hats,
    snareRolls: s.snareRolls,
    bass: s.bass,
    bassHz: s.bassHz,
    pad: s.pad,
  };
}
