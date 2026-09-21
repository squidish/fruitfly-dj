/**
 * Node-side circuit loading for the bench, the tuner and the tests. Reads the
 * committed toy circuit straight off disk — no server, no network.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decodeCircuit } from '../src/brain/loadCircuit.ts';
import type { Circuit } from '../src/core/circuit.ts';

export function loadCircuitFromDisk(prefix = 'toy_circuit', seed = 1, channels = 8, dir = 'public/data'): Circuit {
  const root = resolve(process.cwd());
  const meta = JSON.parse(readFileSync(resolve(root, dir, `${prefix}.meta.json`), 'utf8'));
  const bin = readFileSync(resolve(root, dir, `${prefix}.edges.bin`));
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer;
  return decodeCircuit(meta, ab, seed, channels);
}
