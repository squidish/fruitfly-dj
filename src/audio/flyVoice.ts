/**
 * The male fly's sing-back.
 *
 * FAFB is a female brain and females do not sing, so this is male-only and off
 * by default. He synthesises pulse song at the carrier and target IPI the model
 * is currently running, both scaled by fly size k.
 *
 * Mixed AFTER the EarWorklet tap, so he cannot hear himself: no feedback loop,
 * and the approval reading stays honest. Level is hard-capped.
 */

/** Hard ceiling on the fly voice, whatever else happens. */
export const FLY_VOICE_CEILING = 0.08;

export interface FlyVoiceOptions {
  /** Carrier in Hz, already divided by k. */
  fc: number;
  /** Inter-pulse interval in seconds, already multiplied by k. */
  ipi: number;
  /** Carrier cycles per pulse. */
  cycles?: number;
}

export class FlyVoice {
  private ctx: AudioContext;
  private gain: GainNode;
  private timer: number | null = null;
  private opts: FlyVoiceOptions = { fc: 250, ipi: 0.035 };
  private nextAt = 0;
  private singing = false;

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(destination);
  }

  configure(opts: Partial<FlyVoiceOptions>): void {
    Object.assign(this.opts, opts);
  }

  get isSinging(): boolean {
    return this.singing;
  }

  /** Start a train. Trains are short, like the real thing. */
  start(): void {
    if (this.singing) return;
    this.singing = true;
    this.gain.gain.setTargetAtTime(FLY_VOICE_CEILING, this.ctx.currentTime, 0.05);
    this.nextAt = this.ctx.currentTime + 0.05;
    this.timer = self.setInterval(() => this.schedule(), 50);
  }

  stop(): void {
    if (!this.singing) return;
    this.singing = false;
    this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  dispose(): void {
    this.stop();
    this.gain.disconnect();
  }

  /** Schedule pulses a little ahead of the clock, the usual Web Audio pattern. */
  private schedule(): void {
    const horizon = this.ctx.currentTime + 0.2;
    let guard = 0;
    while (this.nextAt < horizon && guard++ < 64) {
      this.pulse(this.nextAt);
      this.nextAt += this.opts.ipi;
    }
    if (this.nextAt < this.ctx.currentTime) this.nextAt = this.ctx.currentTime + 0.02;
  }

  private pulse(at: number): void {
    const { fc, cycles = 2 } = this.opts;
    const dur = Math.max(0.004, cycles / Math.max(20, fc));
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = fc;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(1, at + dur * 0.3);
    env.gain.linearRampToValueAtTime(0, at + dur);
    osc.connect(env).connect(this.gain);
    osc.start(at);
    osc.stop(at + dur + 0.01);
  }
}
