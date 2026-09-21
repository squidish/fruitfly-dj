/**
 * Circuit data model and the binary format shared by the toy generator,
 * tools/extract_circuit.py and the loader.
 *
 * circuit.edges.bin, little-endian:
 *   uint32 n, Uint32 pre[n], Uint32 post[n], Uint16 syn[n], Int8 sign[n]
 */

import type { EdgeArrays } from './csr.ts';
import { Rng, deriveSeed } from './rng.ts';

export const GROUPS = ['sensor', 'relay1', 'relay2', 'song', 'groom', 'other'] as const;
export type GroupName = (typeof GROUPS)[number];

export const GROUP_INDEX: Record<GroupName, number> = GROUPS.reduce(
  (acc, g, i) => {
    acc[g] = i;
    return acc;
  },
  {} as Record<GroupName, number>,
);

export const G_SENSOR = GROUP_INDEX.sensor;
export const G_RELAY1 = GROUP_INDEX.relay1;
export const G_RELAY2 = GROUP_INDEX.relay2;
export const G_SONG = GROUP_INDEX.song;
export const G_GROOM = GROUP_INDEX.groom;
export const G_OTHER = GROUP_INDEX.other;

export type Sex = 'female' | 'male' | 'unknown';

export interface NeuronMeta {
  /** Index-local id. */
  id: number;
  /** FlyWire root id as a string, when the circuit came from real data. */
  root_id?: string;
  type: string;
  group: GroupName;
  /** Neurotransmitter label, e.g. "ACh", "GABA", "Glu". */
  nt: string;
  /** Soma position [x, y, z] in nm, when known. Drives the stretch 3D view. */
  pos?: [number, number, number];
}

export interface CircuitMeta {
  format: 1;
  name: string;
  sex: Sex;
  source: string;
  provenance: string;
  citations: string[];
  generated?: string;
  seed?: number;
  /** True for the toy circuit, whose sex is a knob rather than a fact. */
  sexSelectable?: boolean;
  neurons: NeuronMeta[];
  notes?: string[];
}

/** Sensor channel assignment. */
export const SENSOR_NONE = 0;
export const SENSOR_VIB = 1;
export const SENSOR_DEFL = 2;

export interface Circuit {
  meta: CircuitMeta;
  n: number;
  edges: EdgeArrays;
  groupOf: Uint8Array;
  /** Index into `typeNames` per neuron. */
  typeOf: Uint16Array;
  typeNames: string[];
  /** SENSOR_NONE / SENSOR_VIB / SENSOR_DEFL per neuron. */
  sensorKind: Int8Array;
  /**
   * Per-sensor fractional f_c offset in [-1, 1], scaled by EarConfig.jitter.
   * Seeded, so the same seed gives the same ear every time.
   */
  sensorJitter: Float32Array;
  /** Vibration channel index per sensor neuron, -1 otherwise. */
  sensorChannel: Int32Array;
  /** n x 3 soma positions, or null when the data has none. */
  pos: Float32Array | null;
}

export function parseEdgesBin(buf: ArrayBuffer): EdgeArrays {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const expected = 4 + n * (4 + 4 + 2 + 1);
  if (buf.byteLength < expected) {
    throw new Error(`circuit.edges.bin truncated: need ${expected} bytes, have ${buf.byteLength}`);
  }
  let off = 4;
  const pre = new Uint32Array(buf.slice(off, off + n * 4));
  off += n * 4;
  const post = new Uint32Array(buf.slice(off, off + n * 4));
  off += n * 4;
  const syn = new Uint16Array(buf.slice(off, off + n * 2));
  off += n * 2;
  const sign = new Int8Array(buf.slice(off, off + n));
  return { pre, post, syn, sign };
}

export function serialiseEdgesBin(e: EdgeArrays): ArrayBuffer {
  const n = e.pre.length;
  const buf = new ArrayBuffer(4 + n * 11);
  const dv = new DataView(buf);
  dv.setUint32(0, n, true);
  let off = 4;
  new Uint8Array(buf, off, n * 4).set(new Uint8Array(e.pre.buffer, e.pre.byteOffset, n * 4));
  off += n * 4;
  new Uint8Array(buf, off, n * 4).set(new Uint8Array(e.post.buffer, e.post.byteOffset, n * 4));
  off += n * 4;
  new Uint8Array(buf, off, n * 2).set(new Uint8Array(e.syn.buffer, e.syn.byteOffset, n * 2));
  off += n * 2;
  new Uint8Array(buf, off, n).set(new Uint8Array(e.sign.buffer, e.sign.byteOffset, n));
  return buf;
}

/** JO-A/JO-B carry vibration, JO-C/JO-E carry sustained deflection. */
export function sensorKindForType(type: string): number {
  const t = type.toUpperCase();
  if (t.includes('JO-A') || t.includes('JO-B')) return SENSOR_VIB;
  if (t.includes('JO-C') || t.includes('JO-E') || t.includes('JO-D')) return SENSOR_DEFL;
  return SENSOR_NONE;
}

export function buildCircuit(meta: CircuitMeta, edges: EdgeArrays, seed: number, channels: number): Circuit {
  const n = meta.neurons.length;
  const groupOf = new Uint8Array(n);
  const typeOf = new Uint16Array(n);
  const typeNames: string[] = [];
  const typeIndex = new Map<string, number>();
  const sensorKind = new Int8Array(n);
  const sensorJitter = new Float32Array(n);
  const sensorChannel = new Int32Array(n).fill(-1);
  let hasPos = false;

  for (const nrn of meta.neurons) {
    if (nrn.pos) hasPos = true;
  }
  const pos = hasPos ? new Float32Array(n * 3) : null;

  const rng = new Rng(deriveSeed(seed, 'sensor-jitter'));

  for (let i = 0; i < n; i++) {
    const nrn = meta.neurons[i];
    const g = GROUP_INDEX[nrn.group] ?? G_OTHER;
    groupOf[i] = g;

    let ti = typeIndex.get(nrn.type);
    if (ti === undefined) {
      ti = typeNames.length;
      typeIndex.set(nrn.type, ti);
      typeNames.push(nrn.type);
    }
    typeOf[i] = ti;

    if (g === G_SENSOR) {
      let kind = sensorKindForType(nrn.type);
      // A sensor whose type we do not recognise still has to hear something;
      // split it deterministically so the group is never silent.
      if (kind === SENSOR_NONE) kind = i % 4 === 3 ? SENSOR_DEFL : SENSOR_VIB;
      sensorKind[i] = kind;
      const j = rng.range(-1, 1);
      sensorJitter[i] = j;
      if (kind === SENSOR_VIB) {
        sensorChannel[i] = channels <= 1 ? 0 : Math.round(((j + 1) / 2) * (channels - 1));
      }
    }

    if (pos && nrn.pos) {
      pos[i * 3] = nrn.pos[0];
      pos[i * 3 + 1] = nrn.pos[1];
      pos[i * 3 + 2] = nrn.pos[2];
    }
  }

  return { meta, n, edges, groupOf, typeOf, typeNames, sensorKind, sensorJitter, sensorChannel, pos };
}

/** Re-bin vibration sensors after the channel count changes. */
export function assignSensorChannels(circuit: Circuit, channels: number): void {
  for (let i = 0; i < circuit.n; i++) {
    if (circuit.sensorKind[i] !== SENSOR_VIB) continue;
    const j = circuit.sensorJitter[i];
    circuit.sensorChannel[i] = channels <= 1 ? 0 : Math.round(((j + 1) / 2) * (channels - 1));
  }
}

/**
 * CSR slot -> STP state index, for edges landing on the song group only.
 * Everything else gets -1 and stays a static synapse.
 */
export function buildStpSlots(
  rowStart: Uint32Array,
  target: Uint32Array,
  nnz: number,
  groupOf: Uint8Array,
  songGroup = G_SONG,
): { slots: Int32Array; count: number } {
  void rowStart;
  const slots = new Int32Array(nnz).fill(-1);
  let count = 0;
  for (let e = 0; e < nnz; e++) {
    if (groupOf[target[e]] === songGroup) slots[e] = count++;
  }
  return { slots, count };
}

export function neuronsInGroup(circuit: Circuit, group: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < circuit.n; i++) if (circuit.groupOf[i] === group) out.push(i);
  return out;
}

/** Population count per cell type, for the type-level graph nodes. */
export function typeSummary(circuit: Circuit): { name: string; group: number; count: number; members: number[] }[] {
  const byType = new Map<number, { name: string; group: number; count: number; members: number[] }>();
  for (let i = 0; i < circuit.n; i++) {
    const t = circuit.typeOf[i];
    let rec = byType.get(t);
    if (!rec) {
      rec = { name: circuit.typeNames[t], group: circuit.groupOf[i], count: 0, members: [] };
      byType.set(t, rec);
    }
    rec.count++;
    rec.members.push(i);
  }
  return [...byType.values()].sort((a, b) => a.group - b.group || b.count - a.count);
}
