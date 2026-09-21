/**
 * Circuit loading. Fallback chain: real circuit -> toy circuit. A header badge
 * shows which one is active, so a silent fallback is still visible.
 *
 * Only the app's own assets are ever fetched (hard rule 1).
 */

import { buildCircuit, parseEdgesBin, type Circuit, type CircuitMeta } from '../core/circuit.ts';

export type CircuitSource = 'real' | 'toy';

export interface LoadedCircuit {
  circuit: Circuit;
  source: CircuitSource;
  /** Non-fatal problems worth showing in About, e.g. why the real circuit was skipped. */
  warnings: string[];
}

/** Pure decode step, shared by the browser loader and the Node harness. */
export function decodeCircuit(
  metaJson: unknown,
  edgesBuffer: ArrayBuffer,
  seed: number,
  channels: number,
): Circuit {
  const meta = metaJson as CircuitMeta;
  if (!meta || !Array.isArray(meta.neurons) || meta.neurons.length === 0) {
    throw new Error('circuit meta has no neurons');
  }
  const edges = parseEdgesBin(edgesBuffer);
  for (let i = 0; i < edges.pre.length; i++) {
    if (edges.pre[i] >= meta.neurons.length || edges.post[i] >= meta.neurons.length) {
      throw new Error(`edge ${i} references a neuron outside the circuit`);
    }
  }
  return buildCircuit(meta, edges, seed, channels);
}

async function fetchPair(base: string, prefix: string): Promise<[unknown, ArrayBuffer]> {
  const [metaRes, edgeRes] = await Promise.all([
    fetch(`${base}data/${prefix}.meta.json`),
    fetch(`${base}data/${prefix}.edges.bin`),
  ]);
  if (!metaRes.ok) throw new Error(`${prefix}.meta.json: HTTP ${metaRes.status}`);
  if (!edgeRes.ok) throw new Error(`${prefix}.edges.bin: HTTP ${edgeRes.status}`);
  return [await metaRes.json(), await edgeRes.arrayBuffer()];
}

/**
 * Try the real circuit, fall back to the toy one. `base` is Vite's BASE_URL so
 * this works under a GitHub Pages subpath.
 */
export async function loadCircuit(base: string, seed: number, channels: number): Promise<LoadedCircuit> {
  const warnings: string[] = [];

  try {
    const [meta, edges] = await fetchPair(base, 'circuit');
    return { circuit: decodeCircuit(meta, edges, seed, channels), source: 'real', warnings };
  } catch (err) {
    warnings.push(`No real circuit loaded (${(err as Error).message}); using the toy circuit.`);
  }

  const [meta, edges] = await fetchPair(base, 'toy_circuit');
  return { circuit: decodeCircuit(meta, edges, seed, channels), source: 'toy', warnings };
}
