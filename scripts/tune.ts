/**
 * Fit the model defaults so the ideal pulse-train sweep peaks at the target IPI.
 *
 *   npm run tune            fit and write src/state/tuned.json
 *   npm run tune -- --dry   fit and print, write nothing
 *
 * Coordinate descent over the handful of parameters that set IPI selectivity:
 * the three Tsodyks-Markram constants (the model's one temporal assumption)
 * plus the two weight scales that decide whether the song group sits near
 * threshold, which is the only regime where STP gain can modulate anything.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadCircuitFromDisk } from './loadToy.ts';
import { DEFAULT_SIM, type SimConfig } from '../src/core/sim.ts';
import { calibrate, type CalibrationResult } from '../src/brain/calibrate.ts';
import type { Circuit } from '../src/core/circuit.ts';

const SR = 48000;
const OUT = resolve(process.cwd(), 'src/state/tuned.json');

/** The parameters the tuner is allowed to move, with their search ladders. */
const KNOBS = {
  wScale: [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2],
  inhibScale: [0.3, 0.5, 0.7, 0.85, 1, 1.3],
  U: [0.5, 0.7, 0.85, 1, 1.2, 1.5],
  tauFac: [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2],
  tauRec: [0.5, 0.7, 0.85, 1, 1.2, 1.5, 2],
  tauM: [0.5, 0.7, 0.85, 1, 1.2, 1.5],
  tRef: [0.5, 0.7, 1, 1.5, 2, 3],
} as const;

type Knob = keyof typeof KNOBS;
const KNOB_ORDER: Knob[] = ['wScale', 'inhibScale', 'tauM', 'tRef', 'U', 'tauFac', 'tauRec'];

const LIMITS: Record<Knob, [number, number]> = {
  wScale: [0.0005, 0.06],
  inhibScale: [0.05, 4],
  U: [0.01, 0.6],
  tauFac: [0.005, 0.5],
  tauRec: [0.02, 1.2],
  tauM: [0.002, 0.06],
  tRef: [0.0005, 0.02],
};

interface Score {
  value: number;
  cal: CalibrationResult;
  contrast: number;
  peakErr: number;
  songRate: number;
  note: string;
}

function at(cal: CalibrationResult, ipi: number): number {
  return cal.curve.reduce((b, p) => (Math.abs(p.ipiBase - ipi) < Math.abs(b.ipiBase - ipi) ? p : b)).s;
}

function songRateAt(cal: CalibrationResult, ipi: number): number {
  return cal.curve.reduce((b, p) => (Math.abs(p.ipiBase - ipi) < Math.abs(b.ipiBase - ipi) ? p : b)).songRate;
}

/**
 * Robust peak location: a centroid in log-IPI over the top half of the curve.
 *
 * Plain argmax is a terrible search signal here. A good tuning curve is broad
 * and slightly noisy, so argmax hops between neighbouring points that differ by
 * a couple of percent, and the optimiser chases that hopping instead of the
 * shape. The centroid moves smoothly with the parameters, which is what
 * coordinate descent needs to follow.
 */
function centroidIpi(cal: CalibrationResult): number {
  const maxS = Math.max(...cal.curve.map((p) => p.s));
  if (!(maxS > 0)) return NaN;
  let wSum = 0;
  let acc = 0;
  for (const p of cal.curve) {
    const w = Math.max(0, p.s - 0.5 * maxS) ** 2;
    wSum += w;
    acc += w * Math.log(p.ipiBase);
  }
  return wSum > 0 ? Math.exp(acc / wSum) : NaN;
}

/**
 * Higher is better. Rewards a sharp peak at the target, punishes a peak in the
 * wrong place, and refuses to accept a circuit that is silent or saturated —
 * both of those can score well on shape while being useless to look at.
 */
function score(circuit: Circuit, cfg: SimConfig, opts: { seconds: number; points: number }): Score {
  const cal = calibrate(circuit, cfg, undefined, opts);
  const target = cfg.targetIpi;
  const sTarget = at(cal, target);
  const sLow = at(cal, 0.01);
  const sHigh = (at(cal, 0.096) + at(cal, 0.12)) / 2;
  const rate = songRateAt(cal, target);

  const dead = rate < 3;
  const saturated = rate > 80;
  const inverted = cal.sIdeal <= cal.sNoise;

  const contrast = sTarget / Math.max(1e-4, Math.max(sLow, sHigh));
  const centroid = centroidIpi(cal);
  const centroidErr = Number.isFinite(centroid) ? Math.abs(Math.log(centroid / target)) : 3;
  const argmaxErr = Math.abs(Math.log(Math.max(1e-6, cal.peakIpi) / target));
  const peakErr = centroidErr;
  const separation = (cal.sIdeal - cal.sNoise) / Math.max(1e-4, cal.sIdeal);

  // Centroid drives the search; argmax is what the acceptance criterion checks,
  // so it gets a smaller nudge of its own rather than being ignored.
  let value = Math.log(Math.max(1e-4, contrast)) - 4 * centroidErr - 1.5 * argmaxErr + 0.5 * separation;
  const notes: string[] = [];
  if (dead) {
    value -= 10;
    notes.push('dead');
  }
  if (saturated) {
    value -= 5;
    notes.push('saturated');
  }
  if (inverted) {
    value -= 5;
    notes.push('noise>ideal');
  }

  return { value, cal, contrast, peakErr, songRate: rate, note: notes.join(',') };
}

function clampKnob(k: Knob, v: number): number {
  const [lo, hi] = LIMITS[k];
  return Math.max(lo, Math.min(hi, v));
}

function main(): void {
  const dry = process.argv.includes('--dry');
  const circuit = loadCircuitFromDisk('toy_circuit', 1, DEFAULT_SIM.channels);
  const t0 = performance.now();

  let cfg: SimConfig = { ...DEFAULT_SIM, sampleRate: SR };
  const fast = { seconds: 2, points: 11 };
  const full = { seconds: 2.5, points: 12 };

  let best = score(circuit, cfg, fast);
  console.log(`Fly DJ tune — ${circuit.n} neurons, target IPI ${(cfg.targetIpi * 1000).toFixed(0)} ms`);
  console.log(
    `start  score=${best.value.toFixed(3)}  peak=${(best.cal.peakIpi * 1000).toFixed(0)} ms  ` +
      `contrast=${best.contrast.toFixed(2)}  song=${best.songRate.toFixed(1)} Hz ${best.note}`,
  );

  const rounds = 3;
  for (let round = 0; round < rounds; round++) {
    let improved = false;
    for (const knob of KNOB_ORDER) {
      const current = cfg[knob] as number;
      let localBest = best;
      let localValue = current;

      for (const mult of KNOBS[knob]) {
        const candidate = clampKnob(knob, current * mult);
        if (candidate === current) continue;
        const trial: SimConfig = { ...cfg, [knob]: candidate };
        const s = score(circuit, trial, fast);
        if (s.value > localBest.value + 1e-4) {
          localBest = s;
          localValue = candidate;
        }
      }

      if (localValue !== current) {
        cfg = { ...cfg, [knob]: localValue };
        best = localBest;
        improved = true;
        console.log(
          `  ${knob.padEnd(11)} -> ${localValue.toPrecision(3).padStart(9)}  score=${best.value.toFixed(3)}  ` +
            `peak=${(best.cal.peakIpi * 1000).toFixed(0)} ms  contrast=${best.contrast.toFixed(2)}  ` +
            `song=${best.songRate.toFixed(1)} Hz ${best.note}`,
        );
      }
    }
    if (!improved) {
      console.log(`  round ${round + 1}: no further improvement`);
      break;
    }
  }

  // Polish at full sweep resolution. The fast sweep is good enough to find the
  // right basin but not to choose between neighbours inside it.
  console.log('\nPolishing at full sweep resolution...');
  let bestFull = score(circuit, cfg, full);
  for (const knob of KNOB_ORDER) {
    const current = cfg[knob] as number;
    let localValue = current;
    for (const mult of [0.8, 0.9, 1.1, 1.25]) {
      const candidate = clampKnob(knob, current * mult);
      if (candidate === current) continue;
      const s = score(circuit, { ...cfg, [knob]: candidate }, full);
      if (s.value > bestFull.value + 1e-4) {
        bestFull = s;
        localValue = candidate;
      }
    }
    if (localValue !== current) {
      cfg = { ...cfg, [knob]: localValue };
      console.log(
        `  ${knob.padEnd(11)} -> ${localValue.toPrecision(3).padStart(9)}  score=${bestFull.value.toFixed(3)}  ` +
          `peak=${(bestFull.cal.peakIpi * 1000).toFixed(0)} ms  contrast=${bestFull.contrast.toFixed(2)}`,
      );
    }
  }

  console.log('\nFinal sweep:');
  const final = bestFull;
  const maxS = Math.max(...final.cal.curve.map((p) => p.s));
  for (const p of final.cal.curve) {
    const width = Math.round((p.s / Math.max(1e-9, maxS)) * 30);
    const mark = Math.abs(p.ipiBase - cfg.targetIpi) < 1e-9 ? ' <- target' : '';
    console.log(`  ${(p.ipiBase * 1000).toFixed(0).padStart(4)} ms  ${p.s.toFixed(3)}  ${'#'.repeat(width)}${mark}`);
  }

  const err = Math.abs(final.cal.peakIpi - cfg.targetIpi) / cfg.targetIpi;
  console.log(
    `\npeak ${(final.cal.peakIpi * 1000).toFixed(0)} ms vs target ${(cfg.targetIpi * 1000).toFixed(0)} ms ` +
      `(${(err * 100).toFixed(0)}% off, budget 20%) — ${err <= 0.2 ? 'PASS' : 'FAIL'}`,
  );
  console.log(`S_noise ${final.cal.sNoise.toFixed(3)}   S_ideal ${final.cal.sIdeal.toFixed(3)}   contrast ${final.contrast.toFixed(2)}`);

  const tuned = {
    $comment: 'Generated by `npm run tune`. Edit that script, not this file.',
    generated: new Date().toISOString().slice(0, 10),
    targetIpi: cfg.targetIpi,
    peakIpi: Number(final.cal.peakIpi.toFixed(4)),
    // Six significant figures, not four. The tuning curve has a broad plateau
    // around the target, so rounding the fitted values enough to shift them by
    // a fraction of a percent is enough to move the argmax to a neighbouring
    // sweep point -- and then the committed defaults no longer reproduce the
    // result this script just printed.
    wScale: Number((cfg.wScale as number).toPrecision(6)),
    inhibScale: Number((cfg.inhibScale as number).toPrecision(6)),
    tauM: Number((cfg.tauM as number).toPrecision(6)),
    tRef: Number((cfg.tRef as number).toPrecision(6)),
    U: Number((cfg.U as number).toPrecision(6)),
    tauFac: Number((cfg.tauFac as number).toPrecision(6)),
    tauRec: Number((cfg.tauRec as number).toPrecision(6)),
  };

  console.log(`\n${JSON.stringify(tuned, null, 2)}`);
  if (dry) {
    console.log('\n--dry: nothing written.');
  } else {
    writeFileSync(OUT, `${JSON.stringify(tuned, null, 2)}\n`);
    console.log(`\nwrote ${OUT}`);
  }
  console.log(`took ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

main();
