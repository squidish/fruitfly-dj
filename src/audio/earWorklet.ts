/**
 * The ear, running on the audio thread.
 *
 * Band-pass -> rectify -> envelope -> decimate to 2 kHz, plus a full-band onset
 * detector on a 5 ms hop. Analyser frames were ~16 ms, about half the 35 ms
 * courtship inter-pulse interval, which is why this had to move off the main
 * thread.
 *
 * Output goes straight to the BrainWorker down a MessagePort. The main thread
 * is not in the path at all, so a busy render frame cannot stall the brain.
 *
 * The tap sits BEFORE the fly's own voice is mixed in, so a singing male cannot
 * hear himself and there is no feedback loop.
 */

import { Ear, type EarConfig, type EarFrame } from '../core/ear.ts';
import type { EarMessage, ToWorklet } from './messages.ts';

/** Decimated samples to gather before posting. ~16 ms at 2 kHz. */
const FRAME_SAMPLES = 32;

class EarProcessor extends AudioWorkletProcessor {
  private ear: Ear;
  private frame: EarFrame;
  private out: Float32Array;
  private deflOut: Float32Array;
  private onsets: number[] = [];
  private filled = 0;
  private t0 = 0;
  private haveT0 = false;
  private target: MessagePort | null = null;
  private mono = new Float32Array(128);
  private rmsSum = 0;
  private rmsCount = 0;

  constructor(options?: { processorOptions?: unknown }) {
    super(options);
    const cfg = (options?.processorOptions ?? {}) as Partial<EarConfig>;
    this.ear = new Ear({ ...cfg, sampleRate });
    this.frame = this.ear.allocFrame(512);
    this.out = new Float32Array(this.ear.channels * FRAME_SAMPLES);
    this.deflOut = new Float32Array(FRAME_SAMPLES);

    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => {
      const msg = ev.data;
      if (msg.type === 'config') {
        this.ear.configure(msg.patch as Partial<EarConfig>);
        if (this.ear.channels * FRAME_SAMPLES !== this.out.length) {
          this.out = new Float32Array(this.ear.channels * FRAME_SAMPLES);
          this.filled = 0;
          this.haveT0 = false;
        }
        this.frame = this.ear.allocFrame(512);
      } else if (msg.type === 'reset') {
        this.ear.reset();
        this.filled = 0;
        this.haveT0 = false;
        this.onsets.length = 0;
      } else if (msg.type === 'port') {
        this.target = (ev.ports && ev.ports[0]) || null;
      }
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const len = input[0].length;
    if (this.mono.length !== len) this.mono = new Float32Array(len);
    const mono = this.mono;

    // Downmix. A stereo track's two channels reach one pair of antennae.
    if (input.length === 1) {
      mono.set(input[0]);
    } else {
      const inv = 1 / input.length;
      mono.fill(0);
      for (const ch of input) for (let i = 0; i < len; i++) mono[i] += ch[i] * inv;
    }

    const blockStart = currentTime;
    this.ear.process(mono, this.frame);
    this.rmsSum += this.frame.rms * this.frame.rms * len;
    this.rmsCount += len;

    for (const offset of this.frame.onsets) this.onsets.push(blockStart + offset);

    const nch = this.ear.channels;
    const cap = this.frame.capacity;
    for (let s = 0; s < this.frame.n; s++) {
      if (!this.haveT0) {
        // Context time of this decimated sample: the block start plus its
        // offset at the ear rate.
        this.t0 = blockStart + s / this.ear.cfg.earRate;
        this.haveT0 = true;
      }
      for (let c = 0; c < nch; c++) this.out[c * FRAME_SAMPLES + this.filled] = this.frame.vib[c * cap + s];
      this.deflOut[this.filled] = this.frame.defl[s];
      this.filled++;
      if (this.filled >= FRAME_SAMPLES) this.flush();
    }

    return true;
  }

  private flush(): void {
    const target = this.target;
    if (!target) {
      this.filled = 0;
      this.haveT0 = false;
      this.onsets.length = 0;
      this.rmsSum = 0;
      this.rmsCount = 0;
      return;
    }

    const vib = this.out.slice(0, this.ear.channels * FRAME_SAMPLES);
    const defl = this.deflOut.slice(0, FRAME_SAMPLES);
    const onsets = Float64Array.from(this.onsets);
    const msg: EarMessage = {
      type: 'ear',
      t0: this.t0,
      vib,
      defl,
      n: this.filled,
      capacity: FRAME_SAMPLES,
      channels: this.ear.channels,
      onsets,
      rms: this.rmsCount > 0 ? Math.sqrt(this.rmsSum / this.rmsCount) : 0,
      gain: this.ear.gain,
    };
    target.postMessage(msg, [vib.buffer, defl.buffer, onsets.buffer]);

    this.filled = 0;
    this.haveT0 = false;
    this.onsets.length = 0;
    this.rmsSum = 0;
    this.rmsCount = 0;
  }
}

registerProcessor('ear-processor', EarProcessor);
