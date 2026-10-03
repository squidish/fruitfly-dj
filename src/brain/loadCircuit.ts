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

/** Decode a base64 payload to bytes. `atob` exists on the main thread and in workers. */
function base64ToBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Pure decode step, shared by the browser loader and the Node harness.
 *
 * `edgesBuffer` may be null when the metadata carries the edges inline as
 * base64. Some static hosts refuse to serve an arbitrary binary file at all,
 * and a single self-contained JSON is the way to run there.
 */
export function decodeCircuit(
  metaJson: unknown,
  edgesBuffer: ArrayBuffer | null,
  seed: number,
  channels: number,
): Circuit {
  const meta = metaJson as CircuitMeta;
  if (!meta || !Array.isArray(meta.neurons) || meta.neurons.length === 0) {
    throw new Error('circuit meta has no neurons');
  }
  const buffer = meta.edgesBase64 ? base64ToBuffer(meta.edgesBase64) : edgesBuffer;
  if (!buffer) throw new Error('circuit has neither an edges file nor inline edges');
  const edges = parseEdgesBin(buffer);
  for (let i = 0; i < edges.pre.length; i++) {
    if (edges.pre[i] >= meta.neurons.length || edges.post[i] >= meta.neurons.length) {
      throw new Error(`edge ${i} references a neuron outside the circuit`);
    }
  }
  return buildCircuit(meta, edges, seed, channels);
}

async function fetchPair(base: string, prefix: string): Promise<[unknown, ArrayBuffer | null]> {
  const metaRes = await fetch(`${base}data/${prefix}.meta.json`);
  if (!metaRes.ok) throw new Error(`${prefix}.meta.json: HTTP ${metaRes.status}`);
  const meta = (await metaRes.json()) as CircuitMeta;

  // Inline edges mean there is no second file to go and get.
  if (meta.edgesBase64) return [meta, null];

  const edgeRes = await fetch(`${base}data/${prefix}.edges.bin`);
  if (!edgeRes.ok) throw new Error(`${prefix}.edges.bin: HTTP ${edgeRes.status}`);
  return [meta, await edgeRes.arrayBuffer()];
}

/**
 * Try the real circuit, fall back to the toy one. `base` must be an ABSOLUTE
 * URL: a worker resolves fetch against its own script URL, not the document,
 * so a relative base would look for the circuit inside assets/.
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
