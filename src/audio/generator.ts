/**
 * The licence-free generator.
 *
 * Tone.js drives everything on the musical grid. Courtship pips are scheduled
 * directly against the AudioContext clock instead, because a 35 ms inter-pulse
 * interval inside trains of 5-15 pulses is not a musical subdivision of
 * anything and pretending otherwise would just quantise the joke away.
 *
 * The pattern data lives in patterns.ts and is shared with the offline
 * renderer, so what the bench measures is what the browser plays.
 */

import * as Tone from 'tone';
import { DEFAULT_GENERATOR, grid, type GeneratorSettings } from './patterns.ts';
import { Rng, deriveSeed } from '../core/rng.ts';

export class Generator {
  private ctx: AudioContext;
  private destination: AudioNode;
  private settings: GeneratorSettings = { ...DEFAULT_GENERATOR };
  private out: Tone.Gain | null = null;
  private kick: Tone.MembraneSynth | null = null;
  private hat: Tone.NoiseSynth | null = null;
  private snare: Tone.NoiseSynth | null = null;
  private bass: Tone.Synth | null = null;
  private pad: Tone.PolySynth | null = null;
  private parts: Tone.Loop[] = [];
  private started = false;
  private ready = false;

  // Courtship pip scheduler, on the raw context clock.
  private pipTimer: number | null = null;
  private pipAt = 0;
  private pipsLeft = 0;
  private pipGain: GainNode | null = null;
  private rng = new Rng(deriveSeed(1, 'courtship-live'));

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.destination = destination;
  }

  /** Must be called after a user gesture, once the context is running. */
  async init(): Promise<void> {
    if (this.ready) return;
    Tone.setContext(this.ctx);

    this.out = new Tone.Gain(1);
    Tone.connect(this.out, this.destination);

    this.kick = new Tone.MembraneSynth({
      pitchDecay: 0.035,
      octaves: 4,
      envelope: { attack: 0.001, decay: 0.24, sustain: 0, release: 0.02 },
    }).connect(this.out);

    const hatFilter = new Tone.Filter(6000, 'highpass').connect(this.out);
    this.hat = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: { attack: 0.001, decay: 0.03, sustain: 0 },
      volume: -18,
    }).connect(hatFilter);

    this.snare = new Tone.NoiseSynth({
      noise: { type: 'pink' },
      envelope: { attack: 0.001, decay: 0.13, sustain: 0 },
      volume: -14,
    }).connect(this.out);

    this.bass = new Tone.Synth({
      oscillator: { type: 'sine' },
      envelope: { attack: 0.004, decay: 0.1, sustain: 0, release: 0.02 },
      volume: -6,
    }).connect(this.out);

    this.pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'sawtooth' },
      envelope: { attack: 1.4, decay: 0.4, sustain: 0.7, release: 2.2 },
      volume: -26,
    }).connect(this.out);

    this.pipGain = this.ctx.createGain();
    this.pipGain.gain.value = 0.55;
    this.pipGain.connect(this.destination);

    this.buildParts();
    this.ready = true;
    this.applySettings();
  }

  private buildParts(): void {
    const transport = Tone.getTransport();

    this.parts.push(
      new Tone.Loop((time) => {
        if (this.settings.kick === 'off') return;
        const beat = Math.round(transport.ticks / transport.PPQ) % 4;
        if (this.settings.kick === 'broken' && beat === 2) {
          this.kick?.triggerAttackRelease('C1', '8n', time + Tone.Time('8n').toSeconds());
          return;
        }
        this.kick?.triggerAttackRelease('C1', '8n', time);
      }, '4n').start(0),
    );

    this.parts.push(
      new Tone.Loop((time) => {
        if (this.settings.hats === 'off') return;
        this.hat?.triggerAttackRelease('32n', time);
      }, '16n').start(0),
    );

    this.parts.push(
      new Tone.Loop((time) => {
        if (!this.settings.snareRolls) return;
        this.snare?.triggerAttackRelease('16n', time);
      }, '2n').start('4n'),
    );

    this.parts.push(
      new Tone.Loop((time) => {
        if (this.settings.bass === 'off') return;
        const step = Math.round(transport.ticks / (transport.PPQ / 4));
        if (this.settings.bass === '8th' && step % 2 !== 0) return;
        if (this.settings.bass === 'offbeat' && step % 2 === 0) return;
        // A slow two-bar root movement, matching the offline renderer.
        const degrees = [1, 1, 1, 1, 6 / 5, 6 / 5, 4 / 5, 4 / 5];
        const bar = Math.floor(step / 16);
        const hz = this.settings.bassHz * degrees[bar % degrees.length];
        this.bass?.triggerAttackRelease(hz, Math.max(0.02, this.settings.bassDecay * 2), time);
      }, '16n').start(0),
    );

    this.parts.push(
      new Tone.Loop((time) => {
        if (!this.settings.pad) return;
        const root = this.settings.bassHz * 2;
        this.pad?.triggerAttackRelease([root, root * 1.5, root * 2.51], '2m', time);
      }, '2m').start(0),
    );
  }

  setSettings(next: GeneratorSettings): void {
    this.settings = { ...next };
    if (!this.ready) return;
    this.applySettings();
    // The courtship scheduler is not on the transport, so switching presets
    // mid-playback has to start and stop it explicitly.
    if (this.started) {
      if (this.settings.courtship) this.startPips();
      else this.stopPips();
    }
  }

  private applySettings(): void {
    const transport = Tone.getTransport();
    transport.bpm.value = this.settings.bpm;
    if (this.bass) {
      this.bass.envelope.decay = Math.max(0.01, this.settings.bassDecay);
    }
  }

  /** Retune the live courtship pips when f_c, target IPI or fly size change. */
  setCourtship(fc: number, ipi: number): void {
    if (!this.settings.courtship) return;
    this.settings = { ...this.settings, courtship: { ...this.settings.courtship, fc, ipi } };
  }

  start(): void {
    if (!this.ready || this.started) return;
    this.started = true;
    Tone.getTransport().start();
    if (this.settings.courtship) this.startPips();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    Tone.getTransport().stop();
    this.stopPips();
  }

  get isPlaying(): boolean {
    return this.started;
  }

  private startPips(): void {
    if (this.pipTimer !== null) return;
    this.pipAt = this.ctx.currentTime + 0.1;
    this.pipsLeft = 0;
    this.pipTimer = self.setInterval(() => this.schedulePips(), 60);
  }

  private stopPips(): void {
    if (this.pipTimer === null) return;
    clearInterval(this.pipTimer);
    this.pipTimer = null;
  }

  private schedulePips(): void {
    const c = this.settings.courtship;
    if (!c || !this.pipGain) return;
    const horizon = this.ctx.currentTime + 0.25;
    let guard = 0;
    while (this.pipAt < horizon && guard++ < 128) {
      if (this.pipsLeft <= 0) {
        // Short trains separated by gaps, the way real song is delivered.
        this.pipsLeft = c.trainMin + this.rng.int(Math.max(1, c.trainMax - c.trainMin + 1));
        this.pipAt += c.gap;
        continue;
      }
      this.pip(this.pipAt, c.fc);
      this.pipsLeft--;
      this.pipAt += c.ipi;
    }
    if (this.pipAt < this.ctx.currentTime) this.pipAt = this.ctx.currentTime + 0.05;
  }

  private pip(at: number, fc: number): void {
    if (!this.pipGain) return;
    const cycles = 2;
    const dur = Math.max(0.004, cycles / Math.max(20, fc));
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = fc;
    // Hann-ish window, matching the offline pulse shape.
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + dur * 0.5);
    env.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(env).connect(this.pipGain);
    osc.start(at);
    osc.stop(at + dur + 0.01);
  }

  dispose(): void {
    this.stop();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    this.kick?.dispose();
    this.hat?.dispose();
    this.snare?.dispose();
    this.bass?.dispose();
    this.pad?.dispose();
    this.out?.dispose();
    this.pipGain?.disconnect();
    this.ready = false;
  }

  /** Grid helper, exposed so the UI can show what a 16th note costs in ms. */
  static grid = grid;
}
