/**
 * Ablation modes. The point of these is to make "does the wiring actually
 * matter?" a question the app can answer out loud rather than assume.
 *
 * On real data this is an experiment, not a pass/fail. "The wiring barely
 * matters" is an acceptable — and funny — result.
 */

import { degreePreservingShuffle, type EdgeArrays } from '../core/csr.ts';
import { G_SENSOR, G_SONG, type Circuit } from '../core/circuit.ts';
import { deriveSeed } from '../core/rng.ts';

export const ABLATION_MODES = ['connectome', 'shuffled', 'earOnly'] as const;
export type AblationMode = (typeof ABLATION_MODES)[number];

export const ABLATION_LABELS: Record<AblationMode, string> = {
  connectome: 'Connectome',
  shuffled: 'Shuffled',
  earOnly: 'Ear only',
};

export const ABLATION_BLURBS: Record<AblationMode, string> = {
  connectome: 'The wiring as loaded, real or toy.',
  shuffled: 'Degree-preserving edge swap: same degrees, same weight distribution, different partners.',
  earOnly: 'Sensors wired straight to the song group with uniform weights. STP still applies.',
};

/**
 * Sensors straight onto the song group, uniform weights, everything in between
 * discarded. Total excitatory synapse mass landing on the song group is matched
 * to the original so the comparison is about routing, not about gain.
 */
export function earOnlyEdges(circuit: Circuit): EdgeArrays {
  const sensors: number[] = [];
  const song: number[] = [];
  for (let i = 0; i < circuit.n; i++) {
    if (circuit.groupOf[i] === G_SENSOR) sensors.push(i);
    else if (circuit.groupOf[i] === G_SONG) song.push(i);
  }

  let excMass = 0;
  const e = circuit.edges;
  for (let i = 0; i < e.pre.length; i++) {
    if (circuit.groupOf[e.post[i]] === G_SONG && e.sign[i] > 0) excMass += e.syn[i];
  }

  const m = sensors.length * song.length;
  if (m === 0) return { pre: new Uint32Array(0), post: new Uint32Array(0), syn: new Uint16Array(0), sign: new Int8Array(0) };

  const per = Math.max(1, Math.min(65535, Math.round(excMass / m)));
  const pre = new Uint32Array(m);
  const post = new Uint32Array(m);
  const syn = new Uint16Array(m);
  const sign = new Int8Array(m);
  let w = 0;
  for (const s of sensors) {
    for (const t of song) {
      pre[w] = s;
      post[w] = t;
      syn[w] = per;
      sign[w] = 1;
      w++;
    }
  }
  return { pre, post, syn, sign };
}

export function variantEdges(circuit: Circuit, mode: AblationMode, seed: number): EdgeArrays {
  switch (mode) {
    case 'shuffled':
      return degreePreservingShuffle(circuit.edges, deriveSeed(seed, 'shuffle'));
    case 'earOnly':
      return earOnlyEdges(circuit);
    case 'connectome':
    default:
      return circuit.edges;
  }
}
