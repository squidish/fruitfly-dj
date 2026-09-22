/**
 * Generator patterns, and an offline renderer for them.
 *
 * The pattern description is pure data with no Tone.js in sight, so the Node
 * bench and the tests can render the exact same presets the browser plays.
 * That is what makes "the fly ignores four-on-the-floor" an assertion rather
 * than a vibe.
 */

import { Rng, deriveSeed } from '../core/rng.ts';
import { pulseTrain } from '../brain/calibrate.ts';

export type PresetId = 'fourOnTheFloor' | 'courtshipRiddim' | 'bassRolls' | 'rollers174';
export const PRESET_IDS: PresetId[] = ['fourOnTheFloor', 'courtshipRiddim', 'bassRolls', 'rollers174'];

export type HatSubdivision = 'off' | '8th' | '16th';
export type KickPattern = 'off' | 'four' | 'broken' | 'twoStep';
export type BassPattern = 'off' | '8th' | '16th' | 'offbeat';

/**
 * Timbre of a pulse train.
 *
 * 'pip'  - a clean windowed sine burst: synthetic courtship song.
 * 'rim'  - a rimshot: the same carrier as the body tone, plus a noise
 *          transient and a much faster decay. Musically it is a drum; to the
 *          ear model it is the same thing as a pip, because what reaches the
 *          fly is the 250 Hz body and nothing else.
 */
export type PulseTimbre = 'pip' | 'rim';

/** Trains of short pulses at a fixed carrier and interval, separated by gaps. */
export interface PulseTrainSettings {
  /** Carrier in Hz. Sits in the fly's band by design. */
  fc: number;
  /** Interval between pulses, seconds. */
  ipi: number;
  trainMin: number;
  trainMax: number;
  /** Silence between trains, seconds. */
  gap: number;
  timbre: PulseTimbre;
  /**
   * Amplitude of the pulses relative to the drums. This is a mixing decision
   * with real consequences: the fly's gain control follows BROADBAND peak
   * level, so a fat sub turns the fly's gain down and the in-band rolls go
   * with it. A rollers tune that the fly can hear is one where the break sits
   * on top of the bass, which is how the genre is mixed anyway.
   */
  level: number;
}

export interface GeneratorSettings {
  bpm: number;
  kick: KickPattern;
  hats: HatSubdivision;
  snareRolls: boolean;
  bass: BassPattern;
  /** Bass fundamental in Hz. */
  bassHz: number;
  /**
   * Bass note decay in seconds. Short is what makes Bass Rolls work: the fly
   * needs each note to be a discrete event with silence after it, the way a
   * courtship pulse is. A sustained note smears into a tone, the sensors go
   * tonic, and the synapses into the song group see a burst instead of an
   * interval.
   */
  bassDecay: number;
  pad: boolean;
  /**
   * When set, the generator lays trains of short in-band pulses over whatever
   * the drum machine is doing. This is the only element any preset has that
   * the fly can actually hear well.
   */
  pulses?: PulseTrainSettings;
  /** Peak amplitude before the master gain. */
  level: number;
}

export interface PresetDef {
  id: PresetId;
  label: string;
  blurb: string;
  settings: GeneratorSettings;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  fourOnTheFloor: {
    id: 'fourOnTheFloor',
    label: 'Four on the Floor 128',
    blurb: 'A plain EDM loop. The baseline the fly ignores.',
    settings: {
      bpm: 128,
      kick: 'four',
      hats: '16th',
      snareRolls: true,
      bass: '8th',
      bassHz: 55,
      bassDecay: 0.09,
      pad: true,
      level: 0.5,
    },
  },
  courtshipRiddim: {
    id: 'courtshipRiddim',
    label: 'Courtship Riddim',
    blurb: '250 Hz pips about 35 ms apart, in trains of 5-15. The fly loves it.',
    settings: {
      bpm: 128,
      kick: 'off',
      hats: 'off',
      snareRolls: false,
      bass: 'off',
      bassHz: 55,
      bassDecay: 0.05,
      pad: false,
      level: 0.5,
      pulses: { fc: 250, ipi: 0.035, trainMin: 5, trainMax: 15, gap: 0.25, timbre: 'pip', level: 1 },
    },
  },
  rollers174: {
    id: 'rollers174',
    label: 'Rollers 174',
    blurb:
      'Drum and bass. The 32nd-note snare roll lands 43 ms apart, against a 35 ms target — ' +
      'the one real genre the fly actually gets.',
    settings: {
      // 174 BPM is the drum and bass centre of gravity, and the arithmetic is
      // a genuine coincidence rather than a fudge: a 32nd note at 174 BPM is
      // 43.1 ms, and the fly is tuned to 35 ms. That is comfortably inside its
      // passband. Auto-fit will ask for k = 1.23 to land on the peak exactly.
      bpm: 174,
      kick: 'twoStep',
      hats: '16th',
      snareRolls: true,
      bass: 'offbeat',
      // A low E sub, well below anything the fly can hear.
      bassHz: 41.2,
      bassDecay: 0.06,
      pad: false,
      level: 0.55,
      pulses: {
        // Snare body. Real snares ring around 180-250 Hz, and this one is
        // placed so both its modes (220 and 275 Hz) sit inside the fly's
        // 200-300 Hz passband at default size.
        fc: 220,
        // 1/32 at 174 BPM. Left as an expression so the number is visible.
        ipi: 60 / 174 / 8,
        // Rolls come in bursts, not continuously, which is both how drum and
        // bass is edited and what the fly's synapses want.
        trainMin: 6,
        trainMax: 16,
        gap: 0.34,
        timbre: 'rim',
        level: 2.8,
      },
    },
  },
  bassRolls: {
    id: 'bassRolls',
    label: 'Bass Rolls',
    blurb: '16th-note bass at 128 BPM: 117 ms apart, which is what Fly size is for.',
    settings: {
      bpm: 128,
      kick: 'off',
      hats: 'off',
      snareRolls: false,
      bass: '16th',
      // D2. At k = 3.3 the fly's band sits at 250 / 3.3 = 76 Hz, right here.
      bassHz: 73.4,
      bassDecay: 0.022,
      pad: false,
      level: 0.6,
    },
  },
};

export const DEFAULT_GENERATOR: GeneratorSettings = { ...PRESETS.fourOnTheFloor.settings };

/** Beat, eighth and sixteenth durations in seconds. */
export function grid(bpm: number): { beat: number; eighth: number; sixteenth: number; bar: number } {
  const beat = 60 / Math.max(1, bpm);
  return { beat, eighth: beat / 2, sixteenth: beat / 4, bar: beat * 4 };
}

function addKick(out: Float32Array, at: number, sr: number): void {
  const len = Math.round(0.22 * sr);
  for (let i = 0; i < len; i++) {
    const idx = at + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    // Pitch sweep 120 -> 45 Hz. Every bit of this is below the fly's band.
    const f = 45 + 75 * Math.exp(-t / 0.035);
    const env = Math.exp(-t / 0.09);
    out[idx] += 0.9 * env * Math.sin(2 * Math.PI * f * t);
  }
}

function addHat(out: Float32Array, at: number, sr: number, rng: Rng, open = false): void {
  const len = Math.round((open ? 0.14 : 0.035) * sr);
  let hp = 0;
  let prev = 0;
  for (let i = 0; i < len; i++) {
    const idx = at + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    const white = rng.float() * 2 - 1;
    // One-pole high-pass, ~6 kHz. Pure hi-hat: the fly cannot hear a hertz of it.
    const a = 1 - Math.exp((-2 * Math.PI * 6000) / sr);
    hp = white - prev + (1 - a) * hp;
    prev = white;
    out[idx] += 0.22 * Math.exp(-t / (open ? 0.06 : 0.012)) * hp;
  }
}

function addSnare(out: Float32Array, at: number, sr: number, rng: Rng, gain = 1): void {
  const len = Math.round(0.16 * sr);
  for (let i = 0; i < len; i++) {
    const idx = at + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    const env = Math.exp(-t / 0.05);
    const noise = rng.float() * 2 - 1;
    const body = Math.sin(2 * Math.PI * 185 * t) + 0.6 * Math.sin(2 * Math.PI * 330 * t);
    out[idx] += gain * env * (0.35 * noise + 0.18 * body);
  }
}

/**
 * A rimshot: sharp noise transient over a short body tone at `fc`.
 *
 * To a listener it is a drum. To the ear model it is a pulse at the carrier,
 * because the noise is brief and broadband and almost none of it survives the
 * band-pass -- which is exactly the property that makes a drum and bass roll
 * legible to a fly.
 */
/** Second body mode as a ratio of the first. Inharmonic, like a real shell. */
export const RIM_MODE_RATIO = 1.25;

function addRim(out: Float32Array, at: number, sr: number, fc: number, rng: Rng, amp = 1): void {
  const len = Math.round(0.016 * sr);
  let hp = 0;
  let prev = 0;
  const a = 1 - Math.exp((-2 * Math.PI * 2500) / sr);
  for (let i = 0; i < len; i++) {
    const idx = at + i;
    if (idx < 0 || idx >= out.length) break;
    const t = i / sr;
    const white = rng.float() * 2 - 1;
    hp = white - prev + (1 - a) * hp;
    prev = white;
    // Two body modes, not one. Real drum shells ring at several inharmonic
    // frequencies, and here that physical fact does useful work: a single
    // 250 Hz sine is audible to a default-sized fly and silent to a 1.25x one,
    // because fly size moves the hearing band as well as the preferred
    // interval. A body spanning 200-250 Hz is heard at both.
    // The upper mode is damped much faster than the lower one, which is true
    // of a real shell and matters here: two modes ringing together for the
    // same length of time beat at their difference frequency, and a 55 Hz
    // beat puts a 18 ms ripple inside every 43 ms hit -- enough to fool the
    // envelope peak detector into reporting an interval that is not there.
    const decay = Math.exp(-t / 0.007);
    const body =
      decay * Math.sin(2 * Math.PI * fc * t) +
      0.85 * decay * Math.sin(2 * Math.PI * fc * RIM_MODE_RATIO * t);
    const stick = Math.exp(-t / 0.0015) * hp;
    out[idx] += amp * (0.55 * body + 0.3 * stick);
  }
}

function addBass(out: Float32Array, at: number, sr: number, hz: number, dur: number, decay: number): void {
  const len = Math.round(Math.min(dur, decay * 6) * sr);
  const tau = Math.max(0.002, decay);
  for (let i = 0; i < len; i++) {
    const idx = at + i;
    if (idx < 0 || idx >= out.length) continue;
    const t = i / sr;
    // Percussive envelope: this is what gives Bass Rolls its clean peaks.
    const env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
    const phase = 2 * Math.PI * hz * t;
    // Mostly fundamental. A harmonic-rich bass gives the fly a second thing to
    // lock onto an octave up, and then Auto-fit's answer is no longer the size
    // that sounds best.
    const tone = Math.sin(phase) + 0.18 * Math.sin(2 * phase) + 0.06 * Math.sin(3 * phase);
    out[idx] += 0.7 * env * tone;
  }
}

function addPad(out: Float32Array, sr: number, hz: number, seconds: number): void {
  const n = Math.min(out.length, Math.round(seconds * sr));
  const partials = [1, 1.5, 2, 2.51];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Slow swell, so the pad never contributes onsets.
    const env = 0.12 * (0.6 + 0.4 * Math.sin((2 * Math.PI * t) / 6));
    let v = 0;
    for (let p = 0; p < partials.length; p++) {
      v += Math.sin(2 * Math.PI * hz * partials[p] * t + p) / (p + 1);
    }
    out[i] += env * v * 0.35;
  }
}

/**
 * Render a preset offline. Same pattern data the live Tone.js generator plays,
 * so bench numbers and browser behaviour describe the same music.
 */
export function renderOffline(
  settings: GeneratorSettings,
  sampleRate: number,
  seconds: number,
  seed = 1,
): Float32Array {
  const n = Math.max(1, Math.round(sampleRate * seconds));
  const out = new Float32Array(n);
  const rng = new Rng(deriveSeed(seed, 'generator'));

  if (settings.pulses) {
    const p = settings.pulses;
    if (p.timbre === 'pip') {
      const pips = pulseTrain({
        sampleRate,
        seconds,
        fc: p.fc,
        ipi: p.ipi,
        trainMin: p.trainMin,
        trainMax: p.trainMax,
        gap: p.gap,
        amplitude: 1,
        seed: deriveSeed(seed, 'pulses'),
      });
      for (let i = 0; i < n; i++) out[i] += pips[i] * p.level;
    } else {
      // Same train structure, struck rather than sung.
      const trainRng = new Rng(deriveSeed(seed, 'pulses'));
      let at = 0;
      while (at < n) {
        const count = p.trainMin + trainRng.int(Math.max(1, p.trainMax - p.trainMin + 1));
        for (let i = 0; i < count && at < n; i++) {
          // Accent the first of each group of four, the way a drummer would.
          addRim(out, at, sampleRate, p.fc, trainRng, p.level);
          at += Math.round(p.ipi * sampleRate);
        }
        at += Math.round(p.gap * sampleRate);
      }
    }
  }

  const g = grid(settings.bpm);
  const beats = Math.ceil(seconds / g.beat);

  if (settings.kick === 'twoStep') {
    // The drum and bass skeleton: kick on 1 and the "and" of 3, snare on 3.
    const bars = Math.ceil(seconds / g.bar);
    for (let bar = 0; bar < bars; bar++) {
      const barAt = bar * g.bar;
      addKick(out, Math.round(barAt * sampleRate), sampleRate);
      addKick(out, Math.round((barAt + g.beat * 2.5) * sampleRate), sampleRate);
      if (settings.snareRolls) {
        addSnare(out, Math.round((barAt + g.beat * 2) * sampleRate), sampleRate, rng, 0.9);
      }
    }
  } else if (settings.kick !== 'off') {
    for (let b = 0; b < beats; b++) {
      const at = Math.round(b * g.beat * sampleRate);
      if (settings.kick === 'four') addKick(out, at, sampleRate);
      else if (b % 4 !== 2) addKick(out, at, sampleRate);
      if (settings.kick === 'broken' && b % 4 === 2) {
        addKick(out, Math.round((b * g.beat + g.eighth) * sampleRate), sampleRate);
      }
    }
  }

  if (settings.hats !== 'off') {
    const step = settings.hats === '8th' ? g.eighth : g.sixteenth;
    const steps = Math.ceil(seconds / step);
    for (let s = 0; s < steps; s++) {
      addHat(out, Math.round(s * step * sampleRate), sampleRate, rng, s % 4 === 2);
    }
  }

  if (settings.snareRolls && settings.kick !== 'twoStep') {
    for (let b = 0; b < beats; b++) {
      if (b % 4 === 1 || b % 4 === 3) addSnare(out, Math.round(b * g.beat * sampleRate), sampleRate, rng);
      // A 16th roll into the top of every fourth bar.
      if (b % 16 === 15) {
        for (let r = 0; r < 4; r++) {
          addSnare(out, Math.round((b * g.beat + r * g.sixteenth) * sampleRate), sampleRate, rng, 0.5 + r * 0.12);
        }
      }
    }
  }

  if (settings.bass !== 'off') {
    const step = settings.bass === '16th' ? g.sixteenth : g.eighth;
    const steps = Math.ceil(seconds / step);
    // A slow two-bar root movement, so it is a bass line and not a test tone.
    const degrees = [1, 1, 1, 1, 6 / 5, 6 / 5, 4 / 5, 4 / 5];
    for (let s = 0; s < steps; s++) {
      if (settings.bass === 'offbeat' && s % 2 === 0) continue;
      const bar = Math.floor((s * step) / g.bar);
      const hz = settings.bassHz * degrees[bar % degrees.length];
      addBass(out, Math.round(s * step * sampleRate), sampleRate, hz, step * 0.95, settings.bassDecay);
    }
  }

  if (settings.pad) addPad(out, sampleRate, settings.bassHz * 2, seconds);

  // Normalise to the requested level, so presets are loudness-comparable and
  // the volume-invariance criterion is testing the model, not the mix.
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0) {
    const gain = settings.level / peak;
    for (let i = 0; i < n; i++) out[i] *= gain;
  }
  return out;
}

export function renderPreset(id: PresetId, sampleRate: number, seconds: number, seed = 1): Float32Array {
  return renderOffline(PRESETS[id].settings, sampleRate, seconds, seed);
}
