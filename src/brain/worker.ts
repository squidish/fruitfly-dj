/**
 * The BrainWorker.
 *
 * Ear frames arrive straight from the AudioWorklet on a MessagePort, so the
 * main thread is not in the audio -> brain path and a slow render frame cannot
 * stall the simulation. Spikes go out stamped in AudioContext time; the main
 * thread draws only the ones that have actually reached the speakers.
 */

import { Simulation, type StepEvents } from '../core/sim.ts';
import { GROUPS, type Circuit } from '../core/circuit.ts';
import { median } from '../core/ear.ts';
import { loadCircuit } from './loadCircuit.ts';
import { calibrate } from './calibrate.ts';
import { ABLATION_MODES, variantEdges, type AblationMode } from './ablation.ts';
import { approvalFrom } from '../core/approval.ts';
import { clampState, toSimConfig, ablationOf, type ParamState } from '../state/params.ts';
import type { BrainFrame, EarMessage, FromWorker, ToWorker } from '../audio/messages.ts';

/** Ear samples of drive kept for Compare, at the ear rate. */
const COMPARE_SECONDS = 10;
/** Debounce before recalibrating, per §3.5. */
const RECALIBRATE_DELAY_MS = 300;
/** Load above which the worker degrades dt and raises the "brain lag" badge. */
const LAG_THRESHOLD = 0.85;
const RECOVER_THRESHOLD = 0.45;

let circuit: Circuit | null = null;
let sim: Simulation | null = null;
let state: ParamState | null = null;
let mode: AblationMode = 'connectome';
let earRate = 2000;

let recalTimer: ReturnType<typeof setTimeout> | null = null;
let calibration = { sNoise: 0, sIdeal: 1 };

/** Ring of recent drive, so Compare can re-run the last 10 s offline. */
let driveVib: Float32Array | null = null;
let driveDefl: Float32Array | null = null;
let driveWrite = 0;
let driveTotal = 0;
let driveChannels = 8;

// Per-frame accumulators, flushed to the main thread once per ear message.
const spikeIdx: number[] = [];
const spikeT: number[] = [];
let envAcc: number[] = [];
let deflAcc: number[] = [];
let envT0 = 0;
let onsetAcc: number[] = [];

// Interval histories for the IPI plot.
let lastOnset = NaN;
const fullBandIntervals: number[] = [];

let loadEma = 0;
let lagging = false;
let baseDt = 0;

function post(msg: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(msg, transfer);
}

function fail(err: unknown): void {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
}

/** Top edges by absolute weight, for the per-neuron WebGL graph. */
function graphEdges(c: Circuit, limit = 6000) {
  const n = c.edges.pre.length;
  const order = Array.from({ length: n }, (_, i) => i);
  order.sort((a, b) => c.edges.syn[b] - c.edges.syn[a]);
  const take = Math.min(limit, n);
  const pre = new Uint32Array(take);
  const post_ = new Uint32Array(take);
  const weight = new Float32Array(take);
  for (let i = 0; i < take; i++) {
    const e = order[i];
    pre[i] = c.edges.pre[e];
    post_[i] = c.edges.post[e];
    weight[i] = c.edges.syn[e] * c.edges.sign[e];
  }
  return { pre, post: post_, weight };
}

async function init(base: string, config: Record<string, number | string | boolean>): Promise<void> {
  state = clampState(config as ParamState);
  const cfg = toSimConfig(state, 48000);
  earRate = cfg.earRate;
  baseDt = cfg.dt;

  const loaded = await loadCircuit(base, cfg.seed, cfg.channels);
  circuit = loaded.circuit;
  mode = ablationOf(state);
  sim = new Simulation(circuit, cfg, variantEdges(circuit, mode, cfg.seed));

  driveChannels = cfg.channels;
  driveVib = new Float32Array(driveChannels * earRate * COMPARE_SECONDS);
  driveDefl = new Float32Array(earRate * COMPARE_SECONDS);

  const meta = circuit.meta;
  post(
    {
      type: 'ready',
      n: circuit.n,
      edges: circuit.edges.pre.length,
      source: loaded.source,
      circuitName: meta.name,
      sex: meta.sex,
      sexSelectable: Boolean(meta.sexSelectable),
      provenance: meta.provenance,
      citations: meta.citations ?? [],
      warnings: loaded.warnings,
      groups: [...GROUPS],
      groupOf: circuit.groupOf,
      typeOf: circuit.typeOf,
      typeNames: circuit.typeNames,
      pos: circuit.pos,
      graphEdges: graphEdges(circuit),
    },
    [],
  );

  runCalibration();
}

function runCalibration(): void {
  if (!circuit || !sim || !state) return;
  post({ type: 'calibrating' });
  const cfg = toSimConfig(state, sim.cfg.sampleRate);
  try {
    const result = calibrate(circuit, cfg, variantEdges(circuit, mode, cfg.seed));
    calibration = { sNoise: result.sNoise, sIdeal: result.sIdeal };
    sim.setCalibration(calibration);
    post({
      type: 'calibration',
      sNoise: result.sNoise,
      sIdeal: result.sIdeal,
      curve: result.curve,
      peakIpi: result.peakIpi,
      targetIpi: result.targetIpi,
      ms: result.ms,
    });
  } catch (err) {
    fail(err);
  }
}

function scheduleRecalibration(): void {
  if (recalTimer !== null) clearTimeout(recalTimer);
  recalTimer = setTimeout(() => {
    recalTimer = null;
    runCalibration();
  }, RECALIBRATE_DELAY_MS);
}

function update(config: Record<string, number | string | boolean>, recalibrate: boolean): void {
  if (!sim || !circuit) return;
  state = clampState(config as ParamState);
  const cfg = toSimConfig(state, sim.cfg.sampleRate);
  baseDt = cfg.dt;
  const nextMode = ablationOf(state);

  if (nextMode !== mode) {
    mode = nextMode;
    sim = new Simulation(circuit, cfg, variantEdges(circuit, mode, cfg.seed));
    sim.setCalibration(calibration);
  } else {
    sim.update({ ...cfg, dt: lagging ? 0.001 : cfg.dt });
  }

  if (recalibrate) scheduleRecalibration();
}

function recordDrive(msg: EarMessage): void {
  if (!driveVib || !driveDefl) return;
  const perChannel = driveDefl.length;
  for (let s = 0; s < msg.n; s++) {
    for (let c = 0; c < driveChannels; c++) {
      driveVib[c * perChannel + driveWrite] = msg.vib[c * msg.capacity + s];
    }
    driveDefl[driveWrite] = msg.defl[s];
    driveWrite = (driveWrite + 1) % perChannel;
    driveTotal++;
  }
}

function onStep(ev: StepEvents, t0: number): void {
  const t = t0 + ev.sampleIndex / earRate;
  for (let i = 0; i < ev.spikeCount; i++) {
    spikeIdx.push(ev.spikeIdx[i]);
    spikeT.push(t);
  }
}

function handleEar(msg: EarMessage): void {
  if (!sim) return;
  const started = performance.now();

  if (envAcc.length === 0) envT0 = msg.t0;
  for (let s = 0; s < msg.n; s++) {
    let m = 0;
    for (let c = 0; c < msg.channels; c++) m += msg.vib[c * msg.capacity + s];
    envAcc.push(m / msg.channels);
    deflAcc.push(msg.defl[s]);
  }

  for (let i = 0; i < msg.onsets.length; i++) {
    const t = msg.onsets[i];
    onsetAcc.push(t);
    if (Number.isFinite(lastOnset)) {
      const d = t - lastOnset;
      if (d > 0 && d < 2) {
        fullBandIntervals.push(d);
        if (fullBandIntervals.length > 400) fullBandIntervals.shift();
      }
    }
    lastOnset = t;
  }

  recordDrive(msg);
  sim.pushEar(msg.vib, msg.defl, msg.n, msg.capacity, (ev) => onStep(ev, msg.t0));

  // Load tracking. Audio must never stall, so when the brain falls behind it
  // coarsens its own timestep rather than letting a backlog build.
  const elapsed = performance.now() - started;
  const audioMs = (msg.n / earRate) * 1000;
  loadEma = loadEma * 0.9 + (elapsed / Math.max(1e-3, audioMs)) * 0.1;
  if (!lagging && loadEma > LAG_THRESHOLD) {
    lagging = true;
    sim.update({ dt: 0.001 });
  } else if (lagging && loadEma < RECOVER_THRESHOLD) {
    lagging = false;
    sim.update({ dt: baseDt });
  }

  flush(msg.gain);
}

function flush(earGain: number): void {
  if (!sim) return;

  const idx = Int32Array.from(spikeIdx);
  const times = Float64Array.from(spikeT);
  const env = Float32Array.from(envAcc);
  const defl = Float32Array.from(deflAcc);
  const onsets = Float64Array.from(onsetAcc);
  const rates = sim.net.rate.slice();
  const groupRates = sim.net.groupRate.slice();

  const frame: BrainFrame = {
    type: 'frame',
    t: sim.time,
    approval: sim.approval.approval,
    selectivity: sim.approval.selectivity,
    groupRates,
    rates,
    spikes: { idx, t: times },
    env,
    envT0,
    envRate: earRate,
    defl,
    onsets,
    stpGain: sim.stp.meanGain,
    earGain,
    lagging,
    realtimeFactor: loadEma > 0 ? 1 / loadEma : 0,
  };

  post(frame, [
    idx.buffer,
    times.buffer,
    env.buffer,
    defl.buffer,
    onsets.buffer,
    rates.buffer,
    groupRates.buffer,
  ]);

  spikeIdx.length = 0;
  spikeT.length = 0;
  envAcc = [];
  deflAcc = [];
  onsetAcc = [];
}

/** The last COMPARE_SECONDS of real drive, oldest first. */
function replayBuffer(): { vib: Float32Array; defl: Float32Array; n: number; capacity: number } | null {
  if (!driveVib || !driveDefl) return null;
  const capacity = driveDefl.length;
  const n = Math.min(capacity, driveTotal);
  if (n < earRate) return null;
  const vib = new Float32Array(driveChannels * n);
  const defl = new Float32Array(n);
  const start = (driveWrite - n + capacity * 2) % capacity;
  for (let i = 0; i < n; i++) {
    const src = (start + i) % capacity;
    for (let c = 0; c < driveChannels; c++) vib[c * n + i] = driveVib[c * capacity + src];
    defl[i] = driveDefl[src];
  }
  return { vib, defl, n, capacity: n };
}

/**
 * Re-run the last 10 s of real drive through all three wirings, faster than
 * real time, against ONE shared calibration. Re-calibrating each mode would
 * normalise away exactly the difference being measured.
 */
function runCompare(): void {
  if (!circuit || !sim || !state) return;
  const replay = replayBuffer();
  if (!replay) {
    post({ type: 'compare', results: [], seconds: 0 });
    return;
  }
  const cfg = toSimConfig(state, sim.cfg.sampleRate);
  const results = ABLATION_MODES.map((m) => {
    const trial = new Simulation(circuit!, cfg, variantEdges(circuit!, m, cfg.seed));
    trial.setCalibration(calibration);
    let sSum = 0;
    let songSum = 0;
    let count = 0;
    const settle = replay.n * 0.3;
    let i = 0;
    trial.pushEar(replay.vib, replay.defl, replay.n, replay.capacity, () => {
      if (i++ < settle) return;
      sSum += trial.approval.selectivity;
      songSum += trial.songRate;
      count++;
    });
    const inv = count > 0 ? 1 / count : 0;
    const s = sSum * inv;
    return { mode: m, approval: approvalFrom(s, calibration), selectivity: s, songRate: songSum * inv };
  });
  post({ type: 'compare', results, seconds: replay.n / earRate });
}

/**
 * Fly size is already close enough when the music's beat is within this factor
 * of the target interval, in either direction.
 *
 * Resizing is not free. Fly size moves the hearing band as well as the
 * preferred interval, so buying a better interval match always costs a worse
 * frequency match -- and Auto-fit cannot see that half of the trade, because
 * it only measures intervals. When the interval is already inside the tuning
 * curve's passband, the frequency cost dominates and resizing makes things
 * worse. Drum and bass is the case that exposed this: a 32nd-note roll at
 * 174 BPM is 43 ms against a 35 ms target, and "fixing" that 1.23x discrepancy
 * drags the hearing band off the snare body and silences the fly completely.
 */
const AUTOFIT_DEADBAND = 1.4;

function runAutoFit(): void {
  if (!sim || !state) return;
  const intervals = sim.recentEnvelopeIntervals(8);
  const m = median(intervals);
  if (!Number.isFinite(m) || m <= 0) {
    post({ type: 'autofit', k: Number(state.k), ipi: NaN });
    return;
  }
  const raw = m / Number(state.targetIpi);
  if (raw > 1 / AUTOFIT_DEADBAND && raw < AUTOFIT_DEADBAND) {
    post({ type: 'autofit', k: Number(state.k), ipi: m, alreadyFits: true });
    return;
  }
  const k = Math.min(8, Math.max(1, Math.round(raw / 0.05) * 0.05));
  post({ type: 'autofit', k: Number(k.toFixed(2)), ipi: m });
}

function postIpiStats(): void {
  if (!sim) return;
  post({
    type: 'ipi',
    flyBand: Float32Array.from(sim.recentEnvelopeIntervals(8)),
    fullBand: Float32Array.from(fullBandIntervals),
  });
}

setInterval(postIpiStats, 500);

self.onmessage = (ev: MessageEvent<ToWorker | { type: 'port' }>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        void init((msg as { base: string }).base, (msg as { config: ParamState }).config).catch(fail);
        break;
      case 'port': {
        const port = ev.ports[0];
        if (port) port.onmessage = (e: MessageEvent<EarMessage>) => handleEar(e.data);
        break;
      }
      case 'update':
        update((msg as { config: ParamState }).config, (msg as { recalibrate: boolean }).recalibrate);
        break;
      case 'compare':
        runCompare();
        break;
      case 'autofit':
        runAutoFit();
        break;
      case 'reset':
        sim?.reset();
        fullBandIntervals.length = 0;
        lastOnset = NaN;
        driveWrite = 0;
        driveTotal = 0;
        break;
    }
  } catch (err) {
    fail(err);
  }
};
