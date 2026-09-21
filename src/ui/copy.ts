/**
 * All the witty copy in one place, so tone stays consistent and translating or
 * toning it down is a single-file job.
 */

import type { ApprovalBand } from '../core/approval.ts';

export const TITLE = 'Fly DJ';
export const TAGLINE = 'EDM, played to a fruit fly that cannot hear most of it.';

/** Status lines by approval band. */
export const STATUS: Record<ApprovalBand, string[]> = {
  deaf: [
    'Can’t hear your hi-hats',
    'Nothing in the band. Nothing in the fly.',
    'Structurally deaf to this drop',
  ],
  twitching: ['Antennae twitching', 'Something got through', 'Mild antennal interest'],
  considering: ['Considering it', 'Tentatively nodding', 'Could be persuaded'],
  courtship: ['Full courtship mode', 'Wings out, commitment made', 'This is the one'],
  overstimulated: [
    'Overstimulated: grooming',
    'Too much bass, now cleaning antennae',
    'Has retreated into personal grooming',
  ],
};

/** Deterministic pick, so the line only changes when the band does. */
export function statusLine(band: ApprovalBand, nonce: number): string {
  const lines = STATUS[band];
  return lines[Math.abs(nonce) % lines.length];
}

export const CIRCUIT_BADGE: Record<'real' | 'toy', { label: string; title: string }> = {
  real: {
    label: 'Connectome',
    title: 'Running on a circuit extracted from real connectome data.',
  },
  toy: {
    label: 'Toy circuit',
    title:
      'No real connectome data present, so the committed toy circuit is running. ' +
      'It is synthetic: layered groups with feed-forward inhibition, built so the ablation machinery has something to detect.',
  },
};

export const PANEL = {
  hear: {
    title: 'What you hear vs what the fly hears',
    blurb: 'Full spectrum on top, the fly’s band shaded, its envelope below. The gap is the joke.',
  },
  raster: { title: 'Spikes', blurb: 'Every dot is one action potential, sorted by group then cell type.' },
  graph: { title: 'Circuit', blurb: 'One node per cell type, sized by population. Inhibitory edges are dashed.' },
  ipi: {
    title: 'Inter-pulse intervals',
    blurb: 'What the music offers against what the fly is tuned for. The curve is measured, not drawn.',
  },
  compare: {
    title: 'Does the wiring matter?',
    blurb: 'The last few seconds re-run through three wirings, against one shared yardstick.',
  },
  brain3d: { title: 'Soma cloud', blurb: 'Cell bodies in place, glowing by firing rate.' },
};

export const START_GATE = {
  title: 'Wake the fly',
  body:
    'Browsers will not start audio without a click, and neither will the fly. ' +
    'Nothing is uploaded and nothing is downloaded: everything here runs on your machine.',
  button: 'Wake the fly',
  hint: 'Headphones recommended. On iPhone, check the silent switch.',
};

export const CALIBRATING = 'Recalibrating the fly’s yardstick…';
export const LAGGING = 'Brain lag: coarser timestep';

export const ABOUT_INTRO = [
  'Fly DJ plays music to a leaky integrate-and-fire network laid out on connectome topology, ' +
    'and shows you what gets through.',
  'Fly hearing is tuned to courtship song: roughly 250 Hz tone pulses about 35 ms apart, delivered in short trains. ' +
    'EDM is neither of those things. The fly cannot hear your hi-hats and is unmoved by four-on-the-floor. ' +
    'Make the fly bigger and it slows down until a 16th-note bass line starts to sound like courtship.',
  'This is not a validated model of anything. It is a simplified simulation in the spirit of Shiu et al. (Nature, 2024), ' +
    'built to be looked at rather than believed.',
];

export const DANCE_NOTE =
  'The dance is an artistic mapping of network activity onto a rig, not simulated motor behaviour. ' +
  'The female wing shimmer in particular is invented: females do not sing, and this is licence.';

export const SAFETY_NOTE =
  'Pulse song at ~28 Hz driven straight onto the visuals would be a seizure risk, so every large element ' +
  'goes through a flash limiter capped at 3 flashes per second. Per-spike flashes are allowed only on small ' +
  'elements such as raster dots. Turning on your system’s reduced-motion setting damps the animation further.';

export const PRIVACY_NOTE =
  'No backend, no accounts, no analytics. Dropped files and microphone audio are decoded locally and never leave your machine.';

export const TOOLTIP_ABLATION =
  'Shuffled keeps every neuron’s in- and out-degree and the whole weight distribution, and only changes which ' +
  'partner each synapse lands on. On real data, "the wiring barely matters" is a perfectly acceptable — and funny — result.';
