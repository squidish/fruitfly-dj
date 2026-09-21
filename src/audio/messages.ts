/**
 * Message protocol between the EarWorklet, the BrainWorker and the main thread.
 *
 * Every timestamp in here is AudioContext time. That is the master clock: the
 * main thread draws only up to ctx.getOutputTimestamp().contextTime, so visuals
 * line up with what is actually heard, including 150-250 ms of Bluetooth
 * latency.
 */

import type { GroupName } from '../core/circuit.ts';
import type { TuningPoint } from '../brain/calibrate.ts';
import type { AblationMode } from '../brain/ablation.ts';

/** Worklet -> worker, straight down a MessagePort without touching the main thread. */
export interface EarMessage {
  type: 'ear';
  /** Context time of the first decimated sample in this frame. */
  t0: number;
  /** channels x capacity, row-major. */
  vib: Float32Array;
  defl: Float32Array;
  n: number;
  capacity: number;
  channels: number;
  /** Full-band onset times, in context time. */
  onsets: Float64Array;
  /** Broadband RMS over the frame. */
  rms: number;
  /** Gain the ear's AGC is currently applying. */
  gain: number;
}

export interface WorkletConfigMessage {
  type: 'config';
  patch: Record<string, number | boolean>;
}

export interface WorkletPortMessage {
  type: 'port';
}

export interface WorkletResetMessage {
  type: 'reset';
}

export type ToWorklet = WorkletConfigMessage | WorkletPortMessage | WorkletResetMessage;

/** One spike, ready to draw. */
export interface SpikeBatch {
  /** Neuron index per spike. */
  idx: Int32Array;
  /** Context time per spike. */
  t: Float64Array;
}

export interface BrainFrame {
  type: 'frame';
  /** Context time of the last simulated step. */
  t: number;
  approval: number;
  selectivity: number;
  /** Mean rate in Hz per group, indexed by GROUPS. */
  groupRates: Float32Array;
  /** Low-passed per-neuron rate, for brightness. */
  rates: Float32Array;
  spikes: SpikeBatch;
  /** Fly-band envelope samples since the last frame, at the ear rate. */
  env: Float32Array;
  /** Context time of env[0]. */
  envT0: number;
  envRate: number;
  /** Deflection-channel envelope, same timebase as env. */
  defl: Float32Array;
  /** Full-band onset times since the last frame. */
  onsets: Float64Array;
  /** Mean short-term-plasticity release gain; 1.0 means STP is doing nothing. */
  stpGain: number;
  /** Ear AGC gain. */
  earGain: number;
  /** True when the worker raised dt to keep up. */
  lagging: boolean;
  /** Simulated seconds per wall-clock second. */
  realtimeFactor: number;
}

export interface CalibrationMessage {
  type: 'calibration';
  sNoise: number;
  sIdeal: number;
  curve: TuningPoint[];
  peakIpi: number;
  targetIpi: number;
  ms: number;
}

export interface CalibratingMessage {
  type: 'calibrating';
}

export interface ReadyMessage {
  type: 'ready';
  n: number;
  edges: number;
  source: 'real' | 'toy';
  circuitName: string;
  sex: string;
  sexSelectable: boolean;
  provenance: string;
  citations: string[];
  warnings: string[];
  groups: GroupName[];
  groupOf: Uint8Array;
  typeOf: Uint16Array;
  typeNames: string[];
  /** n x 3 soma positions, or null. */
  pos: Float32Array | null;
  /** Top edges by weight, for the per-neuron graph. */
  graphEdges: { pre: Uint32Array; post: Uint32Array; weight: Float32Array };
}

export interface CompareResult {
  mode: AblationMode;
  approval: number;
  selectivity: number;
  songRate: number;
}

export interface CompareMessage {
  type: 'compare';
  results: CompareResult[];
  seconds: number;
}

export interface AutoFitMessage {
  type: 'autofit';
  k: number;
  /** Median fly-band inter-peak interval that produced it. */
  ipi: number;
}

export interface IpiStatsMessage {
  type: 'ipi';
  /** Fly-band envelope-peak intervals, seconds. */
  flyBand: Float32Array;
  /** Full-band onset intervals, seconds. */
  fullBand: Float32Array;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export type FromWorker =
  | ReadyMessage
  | BrainFrame
  | CalibrationMessage
  | CalibratingMessage
  | CompareMessage
  | AutoFitMessage
  | IpiStatsMessage
  | WorkerErrorMessage;

export interface WorkerInit {
  type: 'init';
  base: string;
  config: Record<string, number | string | boolean>;
}

export interface WorkerUpdate {
  type: 'update';
  config: Record<string, number | string | boolean>;
  /** Recalibrate 300 ms after the last change to a calibration-affecting knob. */
  recalibrate: boolean;
}

export interface WorkerCompareRequest {
  type: 'compare';
}

export interface WorkerAutoFitRequest {
  type: 'autofit';
}

export interface WorkerResetRequest {
  type: 'reset';
}

export type ToWorker =
  | WorkerInit
  | WorkerUpdate
  | WorkerCompareRequest
  | WorkerAutoFitRequest
  | WorkerResetRequest;
