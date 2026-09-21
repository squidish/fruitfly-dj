/**
 * The audio graph and the clock.
 *
 *   generator / track / file ──► musicBus ─┬─► earBus ──► EarWorklet ──► silent
 *                                          └─► speakerBus ──► volume ──► out
 *   microphone ───────────────────────────────► earBus only
 *   fly voice ────────────────────────────────► speakerBus only
 *
 * The microphone reaches the ear but never the speakers, which is the only way
 * to use a live mic without a feedback loop.
 *
 * The fly voice is mixed on the speaker side of the tap, so a singing male
 * cannot hear himself and the approval reading stays honest.
 *
 * AudioContext time is the master clock. getOutputTimestamp().contextTime tells
 * the renderer how far the speakers have actually got, which is what keeps the
 * raster lined up with what you hear across 150-250 ms of Bluetooth latency.
 */

import workletUrl from 'virtual:ear-worklet-url';
import { DEFAULT_EAR, type EarConfig } from '../core/ear.ts';
import { Generator } from './generator.ts';
import { FlyVoice } from './flyVoice.ts';
import type { ToWorklet } from './messages.ts';

export type SourceKind = 'generator' | 'track' | 'file' | 'mic';

export interface EngineOptions {
  /** Receives the MessagePort the worklet posts ear frames down. */
  onEarPort: (port: MessagePort) => void;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  generator: Generator | null = null;
  flyVoice: FlyVoice | null = null;

  private musicBus: GainNode | null = null;
  private earBus: GainNode | null = null;
  private speakerBus: GainNode | null = null;
  private volume: GainNode | null = null;
  private silent: GainNode | null = null;
  private earNode: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private spectrum = new Float32Array(0);

  private player: AudioBufferSourceNode | null = null;
  private playerBuffer: AudioBuffer | null = null;
  private micStream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;

  private source: SourceKind = 'generator';
  private playing = false;
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    this.opts = opts;
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /**
   * Create and resume the context. Must be called from a user gesture: the
   * autoplay policy is why there is a "Wake the fly" screen at all.
   */
  async start(earConfig: Partial<EarConfig>): Promise<void> {
    if (this.ctx) {
      await this.resume();
      return;
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.resume();

    await ctx.audioWorklet.addModule(workletUrl);

    this.musicBus = ctx.createGain();
    this.earBus = ctx.createGain();
    this.speakerBus = ctx.createGain();
    // Music is both heard and felt; the mic is only felt.
    this.musicBus.connect(this.earBus);
    this.musicBus.connect(this.speakerBus);
    this.volume = ctx.createGain();
    this.silent = ctx.createGain();
    this.silent.gain.value = 0;

    this.earNode = new AudioWorkletNode(ctx, 'ear-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ...DEFAULT_EAR, ...earConfig, sampleRate: ctx.sampleRate },
    });

    // The worklet has no audible output, but a node with nothing downstream is
    // not guaranteed to be pulled. A zero-gain path to the destination is.
    this.earBus.connect(this.earNode);
    this.earNode.connect(this.silent).connect(ctx.destination);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
    this.earBus.connect(this.analyser);

    this.speakerBus.connect(this.volume).connect(ctx.destination);

    // One MessageChannel: the worklet keeps one port, the worker gets the
    // other, and ear frames never touch the main thread.
    const channel = new MessageChannel();
    this.earNode.port.postMessage({ type: 'port' } satisfies ToWorklet, [channel.port1]);
    this.opts.onEarPort(channel.port2);

    this.flyVoice = new FlyVoice(ctx, this.speakerBus);
    this.generator = new Generator(ctx, this.musicBus);
    await this.generator.init();

    this.attachLifecycle();
  }

  /** iOS suspends the context on interruption; come back when the tab does. */
  private attachLifecycle(): void {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.resume();
    };
    document.addEventListener('visibilitychange', onVisible);
    this.ctx?.addEventListener('statechange', () => {
      const state = this.ctx?.state as string | undefined;
      if (state === 'interrupted') void this.resume();
    });
  }

  async resume(): Promise<void> {
    if (!this.ctx) return;
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* a resume outside a gesture can fail; the start gate handles it */
      }
    }
  }

  /** Context time the speakers have actually reached. */
  outputTime(): number {
    if (!this.ctx) return 0;
    const ts = this.ctx.getOutputTimestamp?.();
    const t = ts?.contextTime;
    return typeof t === 'number' && Number.isFinite(t) ? t : this.ctx.currentTime;
  }

  /** How far ahead of the speakers the context clock is, in seconds. */
  outputLatency(): number {
    if (!this.ctx) return 0;
    return Math.max(0, this.ctx.currentTime - this.outputTime());
  }

  setVolume(v: number): void {
    if (!this.volume || !this.ctx) return;
    this.volume.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.02);
  }

  configureEar(patch: Partial<EarConfig>): void {
    this.earNode?.port.postMessage({ type: 'config', patch } as ToWorklet);
  }

  resetEar(): void {
    this.earNode?.port.postMessage({ type: 'reset' } satisfies ToWorklet);
  }

  /** Latest full-band spectrum in dB, for the hear panel. */
  getSpectrum(): Float32Array {
    if (!this.analyser) return this.spectrum;
    this.analyser.getFloatFrequencyData(this.spectrum);
    return this.spectrum;
  }

  get binHz(): number {
    return this.sampleRate / (this.analyser?.fftSize ?? 2048);
  }

  async setSource(kind: SourceKind): Promise<void> {
    if (kind === this.source) return;
    this.stop();
    if (this.source === 'mic') this.stopMic();
    this.source = kind;
    if (kind === 'mic') await this.startMic();
  }

  get currentSource(): SourceKind {
    return this.source;
  }

  /**
   * Microphone, with every "helpful" browser process turned off: echo
   * cancellation, noise suppression and AGC all chew up exactly the onsets the
   * model is looking for.
   */
  private async startMic(): Promise<void> {
    if (!this.ctx || !this.earBus) return;
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
    this.micNode = this.ctx.createMediaStreamSource(this.micStream);
    // earBus only. Routing a live mic to the speakers is how you get feedback.
    this.micNode.connect(this.earBus);
  }

  private stopMic(): void {
    this.micNode?.disconnect();
    this.micNode = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
  }

  /** Decode a dropped file or a fetched track. Nothing leaves the machine. */
  async loadBuffer(data: ArrayBuffer): Promise<void> {
    if (!this.ctx) return;
    this.playerBuffer = await this.ctx.decodeAudioData(data);
  }

  get hasBuffer(): boolean {
    return this.playerBuffer !== null;
  }

  play(): void {
    if (!this.ctx || this.playing) return;
    void this.resume();
    this.playing = true;

    if (this.source === 'generator') {
      this.generator?.start();
    } else if (this.source === 'mic') {
      // Nothing to start: the stream is already flowing into the ear bus.
    } else if (this.playerBuffer && this.musicBus) {
      const node = this.ctx.createBufferSource();
      node.buffer = this.playerBuffer;
      node.loop = true;
      node.connect(this.musicBus);
      node.start();
      this.player = node;
    }
  }

  stop(): void {
    if (!this.playing) return;
    this.playing = false;
    this.generator?.stop();
    if (this.player) {
      try {
        this.player.stop();
      } catch {
        /* already stopped */
      }
      this.player.disconnect();
      this.player = null;
    }
  }

  toggle(): boolean {
    if (this.playing) this.stop();
    else this.play();
    return this.playing;
  }

  dispose(): void {
    this.stop();
    this.stopMic();
    this.generator?.dispose();
    this.flyVoice?.dispose();
    void this.ctx?.close();
    this.ctx = null;
  }
}
