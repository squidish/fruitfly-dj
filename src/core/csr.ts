/**
 * Edge storage. Edges arrive as flat typed arrays (that is exactly the layout
 * of circuit.edges.bin) and are compressed to CSR, keyed by presynaptic
 * neuron, so a spike walks one contiguous run of targets.
 */

import { Rng } from './rng.ts';

/** Flat edge list, the on-disk layout of circuit.edges.bin. */
export interface EdgeArrays {
  pre: Uint32Array;
  post: Uint32Array;
  /** Synapse count from the connectome. */
  syn: Uint16Array;
  /** +1 excitatory (ACh), -1 inhibitory (GABA/Glu), 0 unknown. */
  sign: Int8Array;
}

export interface WeightScaling {
  wScale: number;
  inhibScale: number;
}

/** Compressed sparse row, presynaptic-major. */
export interface Csr {
  n: number;
  /** Length n + 1. Edges of neuron i are [rowStart[i], rowStart[i + 1]). */
  rowStart: Uint32Array;
  /** Postsynaptic neuron per slot. */
  target: Uint32Array;
  /** Signed, scaled weight per slot. */
  weight: Float32Array;
  /** Raw synapse count per slot, kept so weights can be rescaled in place. */
  syn: Uint16Array;
  /** Sign per slot. */
  sign: Int8Array;
  /** Edge count. */
  nnz: number;
}

export function edgeCount(e: EdgeArrays): number {
  return e.pre.length;
}

/** Weight = synapse count x sign x w_scale, x inhib_scale when negative. */
export function weightOf(syn: number, sign: number, s: WeightScaling): number {
  if (sign === 0) return 0;
  const w = syn * sign * s.wScale;
  return sign < 0 ? w * s.inhibScale : w;
}

export function buildCsr(n: number, edges: EdgeArrays, scaling: WeightScaling): Csr {
  const nnz = edgeCount(edges);
  const rowStart = new Uint32Array(n + 1);
  for (let i = 0; i < nnz; i++) {
    const p = edges.pre[i];
    if (p < n) rowStart[p + 1]++;
  }
  for (let i = 0; i < n; i++) rowStart[i + 1] += rowStart[i];

  const cursor = rowStart.slice(0, n);
  const target = new Uint32Array(nnz);
  const weight = new Float32Array(nnz);
  const syn = new Uint16Array(nnz);
  const sign = new Int8Array(nnz);

  for (let i = 0; i < nnz; i++) {
    const p = edges.pre[i];
    if (p >= n) continue;
    const slot = cursor[p]++;
    target[slot] = edges.post[i];
    syn[slot] = edges.syn[i];
    sign[slot] = edges.sign[i];
    weight[slot] = weightOf(edges.syn[i], edges.sign[i], scaling);
  }

  return { n, rowStart, target, weight, syn, sign, nnz };
}

/** Recompute weights in place after w_scale / inhib_scale change. */
export function rescale(csr: Csr, scaling: WeightScaling): void {
  for (let i = 0; i < csr.nnz; i++) {
    csr.weight[i] = weightOf(csr.syn[i], csr.sign[i], scaling);
  }
}

/** In-degree per neuron, for pruning and graph layout. */
export function inDegree(n: number, edges: EdgeArrays): Uint32Array {
  const d = new Uint32Array(n);
  for (let i = 0; i < edgeCount(edges); i++) d[edges.post[i]]++;
  return d;
}

export function copyEdges(e: EdgeArrays): EdgeArrays {
  return {
    pre: e.pre.slice(),
    post: e.post.slice(),
    syn: e.syn.slice(),
    sign: e.sign.slice(),
  };
}

/**
 * Degree-preserving double-edge swap. (a->b, c->d) becomes (a->d, c->b), so
 * every neuron keeps its in- and out-degree and the weight distribution is
 * untouched — only *which* partner a synapse lands on changes. That is the
 * control the Shuffled ablation needs.
 */
export function degreePreservingShuffle(edges: EdgeArrays, seed: number, passes = 10): EdgeArrays {
  const out = copyEdges(edges);
  const m = edgeCount(out);
  if (m < 2) return out;
  const rng = new Rng(seed);

  // Reject duplicates so the shuffled graph stays simple, like the original.
  const seen = new Set<number>();
  const key = (a: number, b: number) => a * 4294967296 + b;
  for (let i = 0; i < m; i++) seen.add(key(out.pre[i], out.post[i]));

  const attempts = m * passes;
  for (let t = 0; t < attempts; t++) {
    const i = rng.int(m);
    const j = rng.int(m);
    if (i === j) continue;
    const a = out.pre[i];
    const b = out.post[i];
    const c = out.pre[j];
    const d = out.post[j];
    if (a === d || c === b) continue; // would create a self-loop
    const k1 = key(a, d);
    const k2 = key(c, b);
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.delete(key(a, b));
    seen.delete(key(c, d));
    seen.add(k1);
    seen.add(k2);
    out.post[i] = d;
    out.post[j] = b;
  }
  return out;
}
