/**
 * Fly DJ — wiring.
 *
 * The clock discipline lives here: every incoming worker frame is stamped in
 * AudioContext time and parked in a queue, and the render loop only ever draws
 * what getOutputTimestamp().contextTime says has actually reached the speakers.
 * That is what keeps the raster, the envelope and the fly's bob lined up with
 * what you hear, across 150-250 ms of Bluetooth latency.
 */

import './styles.css';

import { AudioEngine } from './audio/engine.ts';
import type { BrainFrame, CompareResult, FromWorker, ToWorker } from './audio/messages.ts';
import { approvalBand } from './core/approval.ts';
import { EnvelopePeakDetector } from './core/ear.ts';
import { FlashLimiter } from './core/flashLimiter.ts';
import { G_GROOM, G_RELAY1, G_RELAY2, G_SENSOR } from './core/circuit.ts';
import { DEFAULT_SIM } from './core/sim.ts';
import type { TuningPoint } from './brain/calibrate.ts';
import { FlyBehaviour } from './fly/behaviours.ts';
import { FlyRig } from './fly/rig.ts';
import {
  CALIBRATION_KEYS,
  SPECIES,
  defaultState,
  presetOverrides,
  toGeneratorSettings,
  type ParamState,
  type ParamValue,
} from './state/params.ts';
import { readHash, shareUrl, writeHash } from './state/urlState.ts';
import { renderAbout } from './ui/about.ts';
import { Controls } from './ui/controls.ts';
import { CIRCUIT_BADGE, PANEL, statusLine } from './ui/copy.ts';
import { showFatal, showStartGate } from './ui/startGate.ts';
import { ComparePanel } from './viz/compare.ts';
import { Brain3D } from './viz/brain3d.ts';
import { CircuitGraph } from './viz/graph.ts';
import { HearPanel } from './viz/hearPanel.ts';
import { IpiPlot } from './viz/ipiPlot.ts';
import { Raster } from './viz/raster.ts';
import { prefersReducedMotion, renderLegend } from './viz/theme.ts';

/**
 * The app's asset base, resolved to an absolute URL.
 *
 * Vite's BASE_URL can be relative (`./`) when the build does not know its
 * final path. A relative base is fine on the main thread, where it resolves
 * against the document, but a Web Worker resolves `fetch` against its OWN
 * script URL -- which lives in assets/ -- so `./data/...` becomes
 * `assets/data/...` and the circuit silently 404s. Resolving once here keeps
 * the app working under an absolute base, a subpath, or a relative base.
 */
const ASSET_BASE = new URL(import.meta.env.BASE_URL, window.location.href).href;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

interface TrackEntry {
  file: string;
  title: string;
  artist: string;
  licence: string;
  source: string;
}

/** Envelope samples kept for the hear panel: ~3 s at the ear rate. */
const ENV_HISTORY = DEFAULT_SIM.earRate * 3;

class App {
  private state: ParamState = defaultState();
  private engine: AudioEngine;
  private worker: Worker | null = null;
  private workerRestarts = 0;

  private rig: FlyRig;
  private behaviour = new FlyBehaviour();
  private limiter = new FlashLimiter();

  private hearPanel = new HearPanel($<HTMLCanvasElement>('hear-canvas'));
  private raster = new Raster($<HTMLCanvasElement>('raster-canvas'));
  private graph = new CircuitGraph($<HTMLCanvasElement>('graph-canvas'));
  private ipiPlot = new IpiPlot($<HTMLCanvasElement>('ipi-canvas'));
  private compare = new ComparePanel($<HTMLCanvasElement>('compare-canvas'), $('compare-note'));
  private cloud = new Brain3D($<HTMLCanvasElement>('cloud-canvas'));
  private controls: Controls;

  // Latest model state, all delayed to output time before it is drawn.
  private frameQueue: BrainFrame[] = [];
  // Annotated rather than inferred: TS 5.7 infers Float32Array<ArrayBuffer>
  // from the initialiser, and these are reassigned from worker messages, whose
  // arrays are Float32Array<ArrayBufferLike>.
  private rates: Float32Array = new Float32Array(0);
  private groupRates: Float32Array = new Float32Array(6);
  private approval = 0;
  private stpGain = 1;
  private earGain = 1;

  private envRing = new Float32Array(ENV_HISTORY);
  private envTimes = new Float64Array(ENV_HISTORY);
  private envWrite = 0;
  private envCount = 0;
  private envRate = DEFAULT_SIM.earRate;
  private envScratch = new Float32Array(ENV_HISTORY);
  private peakDetector = new EnvelopePeakDetector();
  private peakPending = false;
  private onsetTimes: number[] = [];

  private curve: TuningPoint[] = [];
  private calibrating = true;
  private ready = false;
  private lastRaf = 0;
  private lastAutoFit = 0;
  private statusNonce = 0;
  private currentBand = '';
  private tracks: TrackEntry[] = [];
  private aboutInfo: Parameters<typeof renderAbout>[1] | null = null;
  private reduced = prefersReducedMotion();

  constructor() {
    this.state = readHash();
    this.engine = new AudioEngine({ onEarPort: (port) => this.attachEarPort(port) });
    this.rig = new FlyRig($('fly-stage'));
    this.controls = new Controls($('controls'), this.state, {
      onChange: (key, value) => this.onControlChange(key, value),
      onReset: () => this.resetAll(),
      onShare: () => this.share(),
      onCompare: () => this.requestCompare(),
    });

    renderLegend($('legend'));
    this.bindChrome();
    this.paintNotes();
    void this.loadTracks();

    showStartGate($('start-gate'), () => this.boot());
    requestAnimationFrame((t) => this.tick(t));
  }

  // ---- boot --------------------------------------------------------------

  private async boot(): Promise<void> {
    await this.engine.start({
      fc: Number(this.state.fc) / Number(this.state.k),
      q: Number(this.state.q),
      tauEnv: Number(this.state.tauEnv) * Number(this.state.k),
      agc: Boolean(this.state.agc),
    });
    this.startWorker();
    this.applyToEngine();
    this.engine.play();
    this.setPlayButton(true);
  }

  private startWorker(): void {
    this.worker?.terminate();
    const worker = new Worker(new URL('./brain/worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorkerMessage(ev.data);
    worker.onerror = (ev) => this.onWorkerCrash(ev.message || 'worker error');
    this.send({ type: 'init', base: ASSET_BASE, config: this.state as Record<string, ParamValue> });
    // The worklet already holds the other end; hand this one to the worker.
    if (this.pendingPort) {
      worker.postMessage({ type: 'port' }, [this.pendingPort]);
      this.pendingPort = null;
    }
  }

  private pendingPort: MessagePort | null = null;

  private attachEarPort(port: MessagePort): void {
    if (this.worker) this.worker.postMessage({ type: 'port' }, [port]);
    else this.pendingPort = port;
  }

  private send(msg: ToWorker): void {
    this.worker?.postMessage(msg);
  }

  private onWorkerCrash(message: string): void {
    if (this.workerRestarts === 0) {
      this.workerRestarts++;
      this.toast('The brain crashed. Restarting it once…');
      // A fresh MessageChannel is needed: the old port died with the worker.
      this.engine.resetEar();
      this.startWorker();
      return;
    }
    showFatal($('start-gate'), `${message}. Reloading is the quickest way out of this.`);
  }

  // ---- worker messages ---------------------------------------------------

  private onWorkerMessage(msg: FromWorker): void {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        this.rates = new Float32Array(msg.n);
        this.raster.setLayout(msg.groupOf, msg.typeOf);
        this.graph.setData({
          n: msg.n,
          groupOf: msg.groupOf,
          typeOf: msg.typeOf,
          typeNames: msg.typeNames,
          edges: msg.graphEdges,
        });
        const hasCloud = this.cloud.setData(msg.pos, msg.groupOf);
        $('layout').dataset.cloud = String(hasCloud);
        const cloudTab = document.querySelector<HTMLButtonElement>('.tab[data-tab="cloud"]');
        const cloudPanel = document.querySelector<HTMLElement>('[data-panel="cloud"]');
        if (cloudTab) cloudTab.hidden = !hasCloud;
        if (cloudPanel) cloudPanel.hidden = !hasCloud;

        const badge = $('circuit-badge');
        const copy = CIRCUIT_BADGE[msg.source];
        badge.textContent = `${copy.label} · ${msg.n} neurons`;
        badge.title = copy.title;
        badge.classList.toggle('badge-real', msg.source === 'real');
        badge.classList.toggle('badge-toy', msg.source === 'toy');

        // Sex is a knob on the toy circuit and a fact on real data.
        const sexRow = document.querySelector<HTMLElement>('.control-row[data-key="sex"]');
        if (sexRow && !msg.sexSelectable) {
          sexRow.classList.add('disabled');
          const input = sexRow.querySelector('select');
          if (input) {
            input.disabled = true;
            input.value = msg.sex === 'male' ? 'male' : 'female';
          }
          this.state.sex = msg.sex === 'male' ? 'male' : 'female';
          this.controls.sync(this.state);
        }

        this.aboutInfo = {
          source: msg.source,
          circuitName: msg.circuitName,
          n: msg.n,
          edges: msg.edges,
          sex: msg.sexSelectable ? `${msg.sex} (selectable on the toy circuit)` : msg.sex,
          provenance: msg.provenance,
          citations: msg.citations,
          warnings: msg.warnings,
          tracks: this.tracks,
        };
        break;
      }

      case 'calibrating':
        this.calibrating = true;
        $('calib-badge').hidden = false;
        break;

      case 'calibration':
        this.calibrating = false;
        $('calib-badge').hidden = true;
        this.curve = msg.curve;
        $('ipi-note').textContent =
          `Measured peak ${(msg.peakIpi * 1000).toFixed(0)} ms against a ` +
          `${(msg.targetIpi * 1000).toFixed(0)} ms target. ${PANEL.ipi.blurb}`;
        break;

      case 'frame':
        this.frameQueue.push(msg);
        // Hard cap, in case the tab was backgrounded and rAF stopped.
        if (this.frameQueue.length > 240) this.frameQueue.splice(0, this.frameQueue.length - 240);
        break;

      case 'ipi':
        this.ipiFly = msg.flyBand;
        this.ipiFull = msg.fullBand;
        break;

      case 'compare':
        this.compare.setResults(msg.results as CompareResult[], msg.seconds);
        break;

      case 'autofit':
        if (this.state.autoFit && Number.isFinite(msg.ipi)) {
          if (msg.alreadyFits) {
            this.toast(`Auto-fit: ${(msg.ipi * 1000).toFixed(0)} ms beat is already in the fly’s range.`);
          } else {
            this.setParam('k', msg.k);
            this.toast(`Auto-fit: ${(msg.ipi * 1000).toFixed(0)} ms beat → fly size ${msg.k.toFixed(2)}x`);
          }
        }
        break;

      case 'error':
        this.toast(msg.message);
        break;
    }
  }

  private ipiFly: Float32Array = new Float32Array(0);
  private ipiFull: Float32Array = new Float32Array(0);

  /** Drain queued frames up to the time the speakers have actually reached. */
  private drainFrames(now: number): void {
    while (this.frameQueue.length > 0) {
      const frame = this.frameQueue[0];
      // A frame is due once its last envelope sample has been heard.
      const frameEnd = frame.envT0 + frame.env.length / Math.max(1, frame.envRate);
      if (frameEnd > now && this.frameQueue.length < 200) break;
      this.frameQueue.shift();
      this.consumeFrame(frame);
    }
  }

  private consumeFrame(frame: BrainFrame): void {
    this.rates = frame.rates;
    this.groupRates = frame.groupRates;
    this.approval = frame.approval;
    this.stpGain = frame.stpGain;
    this.earGain = frame.earGain;
    this.envRate = frame.envRate;

    this.raster.addSpikes(frame.spikes.idx, frame.spikes.t);
    this.raster.addRates(frame.groupRates);

    for (let i = 0; i < frame.env.length; i++) {
      const t = frame.envT0 + i / frame.envRate;
      this.envRing[this.envWrite] = frame.env[i];
      this.envTimes[this.envWrite] = t;
      this.envWrite = (this.envWrite + 1) % ENV_HISTORY;
      this.envCount = Math.min(ENV_HISTORY, this.envCount + 1);
      if (this.peakDetector.push(frame.env[i], t)) this.peakPending = true;
    }

    for (let i = 0; i < frame.onsets.length; i++) this.onsetTimes.push(frame.onsets[i]);
    if (this.onsetTimes.length > 400) this.onsetTimes.splice(0, this.onsetTimes.length - 400);

    $('lag-badge').hidden = !frame.lagging;
  }

  // ---- render loop -------------------------------------------------------

  private tick(msNow: number): void {
    requestAnimationFrame((t) => this.tick(t));
    const dt = this.lastRaf === 0 ? 0.016 : Math.min(0.1, (msNow - this.lastRaf) / 1000);
    this.lastRaf = msNow;

    const now = this.engine.outputTime();
    this.drainFrames(now);

    this.updateFly(dt);
    this.updateGauge(msNow / 1000);
    this.drawPanels(now);
    this.maybeAutoFit(msNow);
  }

  private updateFly(dt: number): void {
    const k = Number(this.state.k);
    const pose = this.behaviour.update(dt, {
      approval: this.approval,
      joRate: this.groupRates[G_SENSOR] ?? 0,
      relayRate: ((this.groupRates[G_RELAY1] ?? 0) + (this.groupRates[G_RELAY2] ?? 0)) / 2,
      groomRate: this.groupRates[G_GROOM] ?? 0,
      groomThreshold: DEFAULT_SIM.groomThreshold,
      envPeak: this.peakPending,
      sex: this.state.sex === 'male' ? 'male' : 'female',
      k,
      reducedMotion: this.reduced,
    });
    this.peakPending = false;
    this.rig.apply(pose);

    const line = $('behaviour-line');
    line.textContent =
      `${this.behaviour.state} · STP gain ${this.stpGain.toFixed(2)}x · ` +
      `ear gain ${this.earGain.toFixed(2)}x · audio latency ${(this.engine.outputLatency() * 1000).toFixed(0)} ms`;

    // Male sing-back follows the courtship state, when the user allowed it.
    const voice = this.engine.flyVoice;
    if (voice) {
      const wants = Boolean(this.state.flySings) && this.state.sex === 'male' && this.behaviour.state === 'courting';
      voice.configure({ fc: Number(this.state.fc) / k, ipi: Number(this.state.targetIpi) * k });
      if (wants && !voice.isSinging) voice.start();
      else if (!wants && voice.isSinging) voice.stop();
    }
  }

  private updateGauge(nowSec: number): void {
    const a = this.approval;
    const fill = $('gauge-fill');
    const pct = Math.max(0, Math.min(1, a / 2));
    fill.style.right = `${(1 - pct) * 100}%`;
    $('gauge-value').textContent = a.toFixed(2);
    $('approval-gauge').setAttribute('aria-valuenow', a.toFixed(2));

    const band = approvalBand(a, this.groupRates[G_GROOM] ?? 0, DEFAULT_SIM.groomThreshold);
    if (band !== this.currentBand) {
      this.currentBand = band;
      this.statusNonce++;
      $('status-line').textContent = statusLine(band, this.statusNonce);
    }

    // The dance floor and the gauge are both large elements, so their
    // brightness goes through the flash limiter before it is applied.
    const wantLum = 0.25 + Math.min(1, a) * 0.6;
    const floorLum = this.limiter.limit('dance-floor', wantLum, 0.3, nowSec);
    $('dance-floor').style.filter = `brightness(${(0.55 + floorLum * 0.9).toFixed(3)})`;
    const gaugeLum = this.limiter.limit('gauge', wantLum, 0.04, nowSec);
    fill.style.filter = `brightness(${(0.8 + gaugeLum * 0.5).toFixed(3)})`;
  }

  private drawPanels(now: number): void {
    const k = Number(this.state.k);

    // Hear panel: oldest-first envelope window ending at output time.
    const count = this.envCount;
    const start = (this.envWrite - count + ENV_HISTORY * 2) % ENV_HISTORY;
    for (let i = 0; i < count; i++) this.envScratch[i] = this.envRing[(start + i) % ENV_HISTORY];
    const newest = count > 0 ? this.envTimes[(this.envWrite - 1 + ENV_HISTORY) % ENV_HISTORY] : now;

    this.hearPanel.draw({
      spectrum: this.engine.getSpectrum(),
      binHz: this.engine.binHz,
      sampleRate: this.engine.sampleRate,
      fc: Number(this.state.fc) / k,
      q: Number(this.state.q),
      stages: DEFAULT_SIM.stages,
      env: this.envScratch,
      envCount: count,
      envRate: this.envRate,
      onsets: this.onsetTimes.filter((t) => t <= newest).map((t) => t - newest),
      gain: this.earGain,
    });

    const window = 2 * k;
    this.raster.prune(now, window * 1.4);
    this.raster.draw(now, window);
    this.graph.draw(this.rates);
    this.ipiPlot.draw({
      flyBand: this.ipiFly,
      fullBand: this.ipiFull,
      curve: this.curve,
      targetIpi: Number(this.state.targetIpi),
      k,
      calibrating: this.calibrating,
    });
    this.cloud.draw(this.rates, !this.reduced);
  }

  private maybeAutoFit(msNow: number): void {
    if (!this.state.autoFit || !this.ready) return;
    if (msNow - this.lastAutoFit < 2500) return;
    this.lastAutoFit = msNow;
    this.send({ type: 'autofit' });
  }

  // ---- control plumbing --------------------------------------------------

  private onControlChange(key: string, value: ParamValue): void {
    this.state[key] = value;

    // A preset carries its own generator settings; a species carries its IPI.
    if (key === 'preset') {
      Object.assign(this.state, presetOverrides(String(value)));
      this.state.source = 'generator';
    }
    if (key === 'species') {
      const species = SPECIES.find((s) => s.value === value);
      if (species && value !== 'custom') this.state.targetIpi = species.ipi;
    }
    if (key === 'targetIpi') this.state.species = 'custom';
    // Nudging Fly size by hand means you have taken over from Auto-fit.
    if (key === 'k' && this.state.autoFit && !this.autoFitWriting) this.state.autoFit = false;

    this.controls.sync(this.state);
    writeHash(this.state);
    this.applyToEngine();

    const recalibrate = CALIBRATION_KEYS.includes(key) || key === 'caffeine';
    this.send({ type: 'update', config: this.state as Record<string, ParamValue>, recalibrate });

    if (key === 'source') void this.applySource(String(value));
  }

  private autoFitWriting = false;

  private setParam(key: string, value: ParamValue): void {
    this.autoFitWriting = key === 'k';
    this.onControlChange(key, value);
    this.autoFitWriting = false;
  }

  /** Push whatever the audio side needs: ear config, generator, volume. */
  private applyToEngine(): void {
    const k = Number(this.state.k);
    this.engine.setVolume(Number(this.state.volume));
    this.engine.configureEar({
      fc: Number(this.state.fc) / k,
      q: Number(this.state.q),
      tauEnv: Number(this.state.tauEnv) * k,
      agc: Boolean(this.state.agc),
      agcTau: DEFAULT_SIM.agcTau * k,
    });
    const generator = this.engine.generator;
    if (generator) {
      generator.setSettings(toGeneratorSettings(this.state));
      generator.setPulses(Number(this.state.fc) / k, Number(this.state.targetIpi) * k);
    }
  }

  private async applySource(kind: string): Promise<void> {
    try {
      await this.engine.setSource(kind as 'generator' | 'track' | 'file' | 'mic');
      if (kind === 'mic') this.toast('Microphone live. It reaches the fly, never the speakers.');
      this.engine.play();
      this.setPlayButton(true);
    } catch (err) {
      this.toast(`Could not switch source: ${(err as Error).message}`);
      this.state.source = 'generator';
      this.controls.sync(this.state);
    }
  }

  private resetAll(): void {
    this.state = defaultState();
    this.controls.sync(this.state);
    writeHash(this.state);
    this.applyToEngine();
    this.send({ type: 'update', config: this.state as Record<string, ParamValue>, recalibrate: true });
    this.toast('Everything back to defaults.');
  }

  private async share(): Promise<void> {
    const url = shareUrl(this.state);
    try {
      await navigator.clipboard.writeText(url);
      this.toast('Link copied. It carries every setting.');
    } catch {
      this.toast(url);
    }
  }

  private requestCompare(): void {
    this.compare.setPending();
    this.send({ type: 'compare' });
    this.setTab('compare');
  }

  // ---- chrome ------------------------------------------------------------

  private bindChrome(): void {
    $('play-btn').addEventListener('click', () => {
      const playing = this.engine.toggle();
      this.setPlayButton(playing);
    });

    $('about-btn').addEventListener('click', () => {
      const modal = $('about-modal');
      modal.hidden = false;
      $('about-btn').setAttribute('aria-expanded', 'true');
      if (this.aboutInfo) renderAbout($('about-body'), { ...this.aboutInfo, tracks: this.tracks });
    });
    $('about-close').addEventListener('click', () => {
      $('about-modal').hidden = true;
      $('about-btn').setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('about-modal').hidden = true;
    });

    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      tab.addEventListener('click', () => this.setTab(tab.dataset.tab ?? 'stage'));
    }
    // On desktop the fly stage and graph are always visible, so the tabs only
    // choose which panel shares the second row.
    this.setSecondary('raster');

    $('raster-mode').addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      this.raster.mode = this.raster.mode === 'raster' ? 'rates' : 'raster';
      const isRates = this.raster.mode === 'rates';
      btn.textContent = isRates ? 'Spikes' : 'Rates';
      btn.setAttribute('aria-pressed', String(isRates));
    });

    $('graph-mode').addEventListener('click', (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      const next = this.graph.mode === 'type' ? 'neuron' : 'type';
      this.graph.setMode(next);
      btn.textContent = next === 'neuron' ? 'By type' : 'Per-neuron';
      btn.setAttribute('aria-pressed', String(next === 'neuron'));
    });

    $('compare-btn').addEventListener('click', () => this.requestCompare());

    const drawer = $('drawer');
    const toggle = $('drawer-toggle');
    drawer.dataset.open = 'true';
    toggle.addEventListener('click', () => {
      const open = drawer.dataset.open !== 'true';
      drawer.dataset.open = String(open);
      toggle.setAttribute('aria-expanded', String(open));
    });

    this.bindFileDrop();
    matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', (e) => {
      this.reduced = e.matches;
    });
  }

  private setPlayButton(playing: boolean): void {
    const btn = $('play-btn');
    btn.textContent = playing ? 'Pause' : 'Play';
    btn.setAttribute('aria-pressed', String(playing));
  }

  private setTab(tab: string): void {
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      const active = b.dataset.tab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    $('layout').dataset.tab = tab;
    if (tab !== 'stage' && tab !== 'graph') this.setSecondary(tab);
  }

  private setSecondary(panel: string): void {
    $('layout').dataset.secondary = panel;
  }

  private bindFileDrop(): void {
    const drop = $('file-drop');
    const input = $<HTMLInputElement>('file-input');

    const handle = async (file: File) => {
      try {
        const data = await file.arrayBuffer();
        await this.engine.loadBuffer(data);
        this.setParam('source', 'file');
        this.toast(`Loaded ${file.name}. It never left your machine.`);
      } catch (err) {
        this.toast(`Could not decode that file: ${(err as Error).message}`);
      }
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void handle(file);
    });

    for (const type of ['dragenter', 'dragover']) {
      document.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      });
    }
    for (const type of ['dragleave', 'drop']) {
      document.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.remove('over');
      });
    }
    document.addEventListener('drop', (e) => {
      const file = (e as DragEvent).dataTransfer?.files?.[0];
      if (file) void handle(file);
    });
  }

  /** The track list is hidden when the manifest is empty. */
  private async loadTracks(): Promise<void> {
    try {
      const res = await fetch(`${ASSET_BASE}audio/tracks.json`);
      if (!res.ok) return;
      const manifest = (await res.json()) as { tracks?: TrackEntry[] };
      this.tracks = manifest.tracks ?? [];
    } catch {
      this.tracks = [];
    }
    if (this.tracks.length === 0) return;

    const host = $('track-list');
    host.hidden = false;
    const heading = document.createElement('h3');
    heading.textContent = 'Tracks';
    host.append(heading);
    for (const track of this.tracks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'action-btn';
      btn.textContent = `${track.title} — ${track.artist}`;
      btn.title = track.licence;
      btn.addEventListener('click', async () => {
        const res = await fetch(`${ASSET_BASE}audio/${track.file}`);
        await this.engine.loadBuffer(await res.arrayBuffer());
        this.setParam('source', 'track');
      });
      host.append(btn);
    }
  }

  private paintNotes(): void {
    $('hear-note').textContent = PANEL.hear.blurb;
    $('raster-note').textContent = PANEL.raster.blurb;
    $('graph-note').textContent = PANEL.graph.blurb;
    $('ipi-note').textContent = PANEL.ipi.blurb;
    $('compare-note').textContent = PANEL.compare.blurb;
  }

  private toastTimer: number | null = null;
  private toast(message: string): void {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 3600);
  }
}
new App();
