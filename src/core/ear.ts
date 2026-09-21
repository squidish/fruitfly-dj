/**
 * Johnston's-organ model. Phenomenological, NOT derived from the connectome —
 * see ASSUMPTIONS.md. Pure DSP over Float32Array so the AudioWorklet, the
 * BrainWorker and the Node harness all run the identical code path.
 *
 * Per vibration channel (JO-A/B):
 *   band-pass(f_c, Q) -> full-wave rectify -> one-pole envelope(tau_env)
 * Deflection channel (JO-C/E):
 *   low-pass(f_c / deflectionDivisor) -> rectify -> envelope
 * Both are box-decimated to `earRate` (2 kHz) before leaving the worklet.
 *
 * A full-band onset detector runs alongside on a 5 ms hop.
 */

export interface EarConfig {
  /** Hardware rate; 44100 and 48000 both occur in the wild. */
  sampleRate: number;
  /** Band centre in Hz. Callers pass f_c / k — the ear knows nothing of k. */
  fc: number;
  /** Band-pass quality factor. */
  q: number;
  /**
   * Cascaded band-pass sections per channel. One 2nd-order section rolls off at
   * only 6 dB/octave, which leaves a hi-hat just 36 dB down — audible once the
   * sensors' threshold nonlinearity gets hold of it. Two sections give
   * 12 dB/octave and put the hats where they belong.
   */
  stages: number;
  /** Envelope time constant in seconds. Callers pass tau_env * k. */
  tauEnv: number;
  /** Number of vibration channels spanning the jittered f_c spread. */
  channels: number;
  /** Fractional f_c jitter, +/- this much (0.2 = +/-20%). */
  jitter: number;
  /** Deflection channel takes energy below fc / this. */
  deflectionDivisor: number;
  /** Decimated output rate fed to the brain. */
  earRate: number;
  /** Onset detector hop in seconds. */
  onsetHop: number;
  /**
   * Adaptive gain control. A real auditory periphery adapts to overall sound
   * level, and without it the volume knob buys affection through the back door:
   * the cascade is threshold-nonlinear, so halving the level silences the song
   * group outright. Listed in ASSUMPTIONS.md.
   *
   * Two properties matter, and both were learned the hard way:
   *
   * 1. It follows BROADBAND input, never fly-band energy. Driving it from the
   *    band would make the ear crank its gain up on a track with nothing in the
   *    band, and the fly would start hearing hi-hats.
   * 2. It follows PEAK level, not RMS. An RMS follower also tracks duty cycle,
   *    so a sparse pulse train reads as quiet and gets boosted — which lifts the
   *    long-IPI end of the tuning curve and flattens the very selectivity the
   *    model exists to show. Peak level is the same for every IPI.
   */
  agc: boolean;
  /** Input peak level the AGC aims to hold. */
  agcRef: number;
  /** AGC release time constant in seconds (x k). */
  agcTau: number;
  /** AGC attack time constant in seconds (x k). */
  agcAttack: number;
  /** Gain clamp, so silence is never amplified into hiss. */
  agcMin: number;
  agcMax: number;
  /** Peak level below which the AGC stops chasing. */
  agcFloor: number;
}

export const DEFAULT_EAR: EarConfig = {
  sampleRate: 48000,
  fc: 250,
  q: 2,
  stages: 2,
  tauEnv: 0.003,
  channels: 8,
  jitter: 0.2,
  deflectionDivisor: 6,
  earRate: 2000,
  onsetHop: 0.005,
  agc: true,
  agcRef: 0.4,
  agcTau: 1,
  agcAttack: 0.005,
  agcMin: 0.25,
  agcMax: 4,
  agcFloor: 0.02,
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Transposed direct form II biquad. */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private z1 = 0;
  private z2 = 0;

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  /** RBJ band-pass, constant 0 dB peak gain. */
  setBandpass(sampleRate: number, freq: number, q: number): this {
    const f = clamp(freq, 1, sampleRate * 0.45);
    const w = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  /** RBJ low-pass. */
  setLowpass(sampleRate: number, freq: number, q = Math.SQRT1_2): this {
    const f = clamp(freq, 1, sampleRate * 0.45);
    const w = (2 * Math.PI * f) / sampleRate;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.max(q, 0.05));
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  /** Magnitude response at `freq`, for drawing the fly band in the hear panel. */
  magnitude(sampleRate: number, freq: number): number {
    const w = (2 * Math.PI * freq) / sampleRate;
    const cw = Math.cos(w);
    const c2w = Math.cos(2 * w);
    const sw = Math.sin(w);
    const s2w = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * cw + this.b2 * c2w;
    const ni = -(this.b1 * sw + this.b2 * s2w);
    const dr = 1 + this.a1 * cw + this.a2 * c2w;
    const di = -(this.a1 * sw + this.a2 * s2w);
    return Math.sqrt((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di));
  }
}

/**
 * Per-channel centre frequencies: `channels` points spread evenly across
 * +/-jitter around f_c. Sensor neurons are assigned to channels by a seeded
 * draw in the brain, which is where the "+/-20% per neuron" jitter lands.
 */
export function channelFrequencies(cfg: Pick<EarConfig, 'fc' | 'channels' | 'jitter'>): Float32Array {
  const n = Math.max(1, cfg.channels | 0);
  const out = new Float32Array(n);
  if (n === 1) {
    out[0] = cfg.fc;
    return out;
  }
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * 2 - 1; // -1 .. 1
    out[i] = cfg.fc * (1 + cfg.jitter * t);
  }
  return out;
}

/** One decimated ear frame. */
export interface EarFrame {
  /** channels x capacity, row-major. Only the first `n` of each row are valid. */
  vib: Float32Array;
  /** capacity samples; only the first `n` are valid. */
  defl: Float32Array;
  /** Samples written per channel this frame. */
  n: number;
  /** Samples per channel the buffers can hold. */
  capacity: number;
  /** Channel count the `vib` rows are laid out for. */
  channels: number;
  /** Onset times in seconds, relative to the first input sample of the block. */
  onsets: number[];
  /** Broadband RMS of the block, for the "what you hear" panel. */
  rms: number;
}

/** Allocate a frame sized for input blocks of at most `maxBlock` samples. */
export function makeFrame(channels: number, capacity: number): EarFrame {
  return {
    vib: new Float32Array(channels * capacity),
    defl: new Float32Array(capacity),
    n: 0,
    capacity,
    channels,
    onsets: [],
    rms: 0,
  };
}

export class Ear {
  readonly cfg: EarConfig;
  private fcsArr: Float32Array;
  /** channels x stages, row-major by channel. */
  private bp: Biquad[] = [];
  private stages = 2;
  private defLp: [Biquad, Biquad] = [new Biquad(), new Biquad()];
  private envState = new Float32Array(0);
  private acc = new Float32Array(0);
  private deflEnv = 0;
  private deflAcc = 0;
  private accCount = 0;
  private envA = 0;
  private samplesPerOut = 24;
  private agcPeak = 0;
  private agcRelease = 0;
  private agcAttackA = 0;
  private agcGain = 1;
  readonly onset: OnsetDetector;

  constructor(cfg: Partial<EarConfig> = {}) {
    this.cfg = { ...DEFAULT_EAR, ...cfg };
    this.fcsArr = channelFrequencies(this.cfg);
    this.onset = new OnsetDetector(this.cfg.sampleRate, this.cfg.onsetHop);
    this.rebuild();
  }

  /** Centre frequencies actually in use, one per channel. */
  get fcs(): Float32Array {
    return this.fcsArr;
  }

  get channels(): number {
    return this.fcsArr.length;
  }

  /** Apply a config patch and recompute coefficients. Keeps filter state. */
  configure(patch: Partial<EarConfig>): void {
    Object.assign(this.cfg, patch);
    this.rebuild();
  }

  private rebuild(): void {
    const c = this.cfg;
    this.fcsArr = channelFrequencies(c);
    const n = this.fcsArr.length;
    this.stages = Math.max(1, Math.round(c.stages));
    if (this.bp.length !== n * this.stages) {
      this.bp = Array.from({ length: n * this.stages }, () => new Biquad());
      this.envState = new Float32Array(n);
      this.acc = new Float32Array(n);
    }
    for (let i = 0; i < n; i++) {
      for (let st = 0; st < this.stages; st++) {
        this.bp[i * this.stages + st].setBandpass(c.sampleRate, this.fcsArr[i], c.q);
      }
    }
    const deflCut = Math.max(2, c.fc / c.deflectionDivisor);
    this.defLp[0].setLowpass(c.sampleRate, deflCut);
    this.defLp[1].setLowpass(c.sampleRate, deflCut);
    this.envA = 1 - Math.exp(-1 / (Math.max(1e-5, c.tauEnv) * c.sampleRate));
    this.agcRelease = Math.exp(-1 / (Math.max(1e-3, c.agcTau) * c.sampleRate));
    this.agcAttackA = 1 - Math.exp(-1 / (Math.max(1e-5, c.agcAttack) * c.sampleRate));
    this.samplesPerOut = c.sampleRate / c.earRate;
    this.onset.configure(c.sampleRate, c.onsetHop);
  }

  /** Gain the AGC is currently applying. Shown in the hear panel. */
  get gain(): number {
    return this.agcGain;
  }

  /** Broadband peak level the AGC is tracking. */
  get trackedPeak(): number {
    return this.agcPeak;
  }

  reset(): void {
    for (const b of this.bp) b.reset();
    this.defLp[0].reset();
    this.defLp[1].reset();
    this.envState.fill(0);
    this.acc.fill(0);
    this.deflEnv = 0;
    this.deflAcc = 0;
    this.accCount = 0;
    this.agcPeak = 0;
    this.agcGain = 1;
    this.onset.reset();
  }

  /** Upper bound on decimated samples produced by `n` input samples. */
  maxOut(n: number): number {
    return Math.ceil(n / this.samplesPerOut) + 2;
  }

  /** A frame sized for this ear and the given maximum input block. */
  allocFrame(maxBlock: number): EarFrame {
    return makeFrame(this.channels, this.maxOut(maxBlock));
  }

  /** Band-pass magnitude of the centre channel, for drawing the shaded band. */
  bandMagnitude(freq: number): number {
    const mid = (this.fcsArr.length >> 1) * this.stages;
    const section = this.bp[mid];
    if (!section) return 0;
    return Math.pow(section.magnitude(this.cfg.sampleRate, freq), this.stages);
  }

  /**
   * Run one block of input. Decimation and filter state carry across calls, so
   * blocks may be any length up to the frame's capacity.
   */
  process(input: Float32Array, frame: EarFrame): void {
    const nch = this.fcsArr.length;
    const cap = frame.capacity;
    const a = this.envA;
    const bp = this.bp;
    const stages = this.stages;
    const env = this.envState;
    const acc = this.acc;
    let out = 0;
    let sumSq = 0;
    frame.onsets.length = 0;

    for (let s = 0; s < input.length; s++) {
      const x = input[s];
      sumSq += x * x;

      if (this.cfg.agc) {
        // Fast attack, slow release: the classic peak follower.
        const mag = x < 0 ? -x : x;
        this.agcPeak =
          mag > this.agcPeak
            ? this.agcPeak + this.agcAttackA * (mag - this.agcPeak)
            : this.agcPeak * this.agcRelease;
        const g = this.cfg.agcRef / Math.max(this.cfg.agcFloor, this.agcPeak);
        this.agcGain = g < this.cfg.agcMin ? this.cfg.agcMin : g > this.cfg.agcMax ? this.cfg.agcMax : g;
      } else {
        this.agcGain = 1;
      }

      for (let c = 0; c < nch; c++) {
        let band = x;
        const base = c * stages;
        for (let st = 0; st < stages; st++) band = bp[base + st].process(band);
        const e = env[c] + a * ((band < 0 ? -band : band) - env[c]);
        env[c] = e;
        acc[c] += e;
      }

      const low = this.defLp[1].process(this.defLp[0].process(x));
      this.deflEnv += a * ((low < 0 ? -low : low) - this.deflEnv);
      this.deflAcc += this.deflEnv;
      this.accCount++;

      if (this.onset.push(x)) frame.onsets.push(this.onset.onsetTimeFor(s));

      if (this.accCount >= this.samplesPerOut && out < cap) {
        // The filters are linear, so scaling the envelope here is the same as
        // scaling the input, without disturbing any filter state.
        const inv = this.agcGain / this.accCount;
        for (let c = 0; c < nch; c++) {
          frame.vib[c * cap + out] = acc[c] * inv;
          acc[c] = 0;
        }
        frame.defl[out] = this.deflAcc * inv;
        this.deflAcc = 0;
        this.accCount -= this.samplesPerOut;
        if (this.accCount < 0) this.accCount = 0;
        out++;
      }
    }

    frame.n = out;
    frame.rms = input.length > 0 ? Math.sqrt(sumSq / input.length) : 0;
  }
}

/**
 * Full-band onset detector on a 5 ms hop. Analyser frames gave ~16 ms
 * resolution, about half the 35 ms courtship IPI, which is why this lives
 * in the worklet instead.
 */
export class OnsetDetector {
  private hopSamples = 240;
  private sampleRate = 48000;
  private acc = 0;
  private count = 0;
  private prevEnergy = 0;
  private prevFlux = 0;
  private slowFlux = 0;
  private hopIndex = 0;
  private lastOnsetHop = -1e9;

  /** Onsets closer than this fuse. Two hops = 10 ms, the IPI sweep floor. */
  minGapHops = 2;
  /** Flux must beat the running mean by this factor. */
  threshFactor = 1.6;
  /** Absolute energy floor, so silence does not ring. */
  floor = 1e-6;

  constructor(sampleRate: number, hop: number) {
    this.configure(sampleRate, hop);
  }

  configure(sampleRate: number, hop: number): void {
    this.sampleRate = sampleRate;
    this.hopSamples = Math.max(1, Math.round(sampleRate * hop));
  }

  reset(): void {
    this.acc = 0;
    this.count = 0;
    this.prevEnergy = 0;
    this.prevFlux = 0;
    this.slowFlux = 0;
    this.hopIndex = 0;
    this.lastOnsetHop = -1e9;
  }

  /** Feed one sample. True on the sample that closes a hop containing an onset. */
  push(x: number): boolean {
    this.acc += x * x;
    this.count++;
    if (this.count < this.hopSamples) return false;

    const energy = this.acc / this.count;
    this.acc = 0;
    this.count = 0;
    const h = this.hopIndex++;

    // Half-wave-rectified log-energy rise: spectral flux applied broadband,
    // which is all a click train needs.
    const flux = Math.max(0, Math.log(energy + this.floor) - Math.log(this.prevEnergy + this.floor));
    this.prevEnergy = energy;

    const strong = flux > this.threshFactor * (this.slowFlux + 0.02);
    const peak = flux >= this.prevFlux;
    const clear = h - this.lastOnsetHop >= this.minGapHops;
    const audible = energy > this.floor * 10;
    this.slowFlux = this.slowFlux * 0.95 + flux * 0.05;
    this.prevFlux = flux;

    if (strong && peak && clear && audible) {
      this.lastOnsetHop = h;
      return true;
    }
    return false;
  }

  /** Onset time in seconds from the block start, for the sample that closed the hop. */
  onsetTimeFor(sampleIndex: number): number {
    return Math.max(0, (sampleIndex - this.hopSamples + 1) / this.sampleRate);
  }
}

/**
 * Peak picking on the decimated fly-band envelope. Drives the body bob, the
 * fly-band IPI histogram and Auto-fit.
 *
 * Prominence, not local maxima. A one-pole envelope follower with a 3 ms time
 * constant still leaves roughly 10% ripple at the carrier, and on a decaying
 * note that ripple is a chain of perfectly good local maxima about 5 ms apart.
 * Picking those gave Auto-fit a 7 ms "inter-pulse interval" that was really
 * just the carrier. So a peak only counts once the signal has fallen away from
 * it by `prominence`.
 */
export function envelopePeaks(
  env: Float32Array,
  n: number,
  opts: { minGapSamples: number; prominence: number; floor?: number },
): number[] {
  const peaks: number[] = [];
  const { minGapSamples, prominence } = opts;
  const floor = opts.floor ?? 0;
  if (n < 3 || !(prominence > 0)) return peaks;

  let rising = true;
  let candIdx = 0;
  let candVal = env[0];
  let troughVal = env[0];
  let last = -1e9;

  for (let i = 1; i < n; i++) {
    const v = env[i];
    if (rising) {
      if (v > candVal) {
        candVal = v;
        candIdx = i;
      } else if (candVal - v >= prominence) {
        // Confirmed: we came down far enough to call candIdx a real peak.
        if (candVal > floor && candIdx - last >= minGapSamples) {
          peaks.push(candIdx);
          last = candIdx;
        }
        rising = false;
        troughVal = v;
      }
    } else {
      if (v < troughVal) {
        troughVal = v;
      } else if (v - troughVal >= prominence) {
        rising = true;
        candVal = v;
        candIdx = i;
      }
    }
  }
  return peaks;
}

/** Median of a numeric array. Returns NaN when empty. */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Streaming version of `envelopePeaks`, for the live path.
 *
 * The renderer only ever sees the slice of envelope that has actually reached
 * the speakers, so peak picking has to carry state across chunk boundaries
 * rather than re-running over a window each frame.
 */
export class EnvelopePeakDetector {
  /** Fraction of the running range a peak must stand out by. */
  prominenceFraction = 0.45;
  /** Seconds a peak must be clear of the previous one. */
  minGap = 0.005;

  private rising = true;
  private candVal = 0;
  private candT = -1e9;
  private troughVal = 0;
  private lastPeakT = -1e9;
  private runMax = 0;
  private runMin = 0;
  private started = false;

  reset(): void {
    this.rising = true;
    this.candVal = 0;
    this.candT = -1e9;
    this.troughVal = 0;
    this.lastPeakT = -1e9;
    this.runMax = 0;
    this.runMin = 0;
    this.started = false;
  }

  /** Feed one envelope sample. Returns true when a peak is confirmed. */
  push(value: number, t: number): boolean {
    if (!this.started) {
      this.started = true;
      this.candVal = value;
      this.troughVal = value;
      this.runMax = value;
      this.runMin = value;
      this.candT = t;
      return false;
    }

    // Slowly forget the old range, so a quiet passage does not freeze the
    // threshold at a level nothing will ever reach again.
    this.runMax = Math.max(value, this.runMax * 0.9995);
    this.runMin = Math.min(value, this.runMin + (this.runMax - this.runMin) * 0.0005);
    const prominence = Math.max(1e-7, (this.runMax - this.runMin) * this.prominenceFraction);

    let fired = false;
    if (this.rising) {
      if (value > this.candVal) {
        this.candVal = value;
        this.candT = t;
      } else if (this.candVal - value >= prominence) {
        if (this.candT - this.lastPeakT >= this.minGap && this.candVal > this.runMax * 0.2) {
          this.lastPeakT = this.candT;
          fired = true;
        }
        this.rising = false;
        this.troughVal = value;
      }
    } else {
      if (value < this.troughVal) {
        this.troughVal = value;
      } else if (value - this.troughVal >= prominence) {
        this.rising = true;
        this.candVal = value;
        this.candT = t;
      }
    }
    return fired;
  }
}
