/**
 * Node benchmark and model report. No browser, no audio hardware.
 *
 *   npm run bench
 *
 * Prints the measured tuning curve, the approval table across presets and
 * ablation modes, and the §3.4 performance budget check.
 */

import { performance } from 'node:perf_hooks';
import { loadCircuitFromDisk } from './loadToy.ts';
import { DEFAULT_SIM, Simulation, type SimConfig } from '../src/core/sim.ts';
import { calibrate, measureSelectivity } from '../src/brain/calibrate.ts';
import { ABLATION_LABELS, ABLATION_MODES, variantEdges, type AblationMode } from '../src/brain/ablation.ts';
import { approvalFrom } from '../src/core/approval.ts';
import { PRESET_IDS, PRESETS, renderPreset } from '../src/audio/patterns.ts';
import { Ear, median } from '../src/core/ear.ts';

const SR = 48000;

function bar(v: number, max: number, width = 28): string {
  const n = Math.max(0, Math.min(width, Math.round((v / Math.max(1e-9, max)) * width)));
  return '#'.repeat(n).padEnd(width, '.');
}

function fmt(v: number, digits = 3): string {
  return Number.isFinite(v) ? v.toFixed(digits) : 'n/a';
}

function heading(text: string): void {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`);
}

/** Median fly-band inter-peak interval, the quantity Auto-fit divides by. */
function flyBandIpi(signal: Float32Array, cfg: SimConfig, circuit: ReturnType<typeof loadCircuitFromDisk>): number {
  const sim = new Simulation(circuit, cfg);
  const ear = new Ear(sim.scaled.ear);
  sim.runAudio(signal, undefined, ear);
  return median(sim.recentEnvelopeIntervals(8));
}

function main(): void {
  const circuit = loadCircuitFromDisk('toy_circuit', 1, DEFAULT_SIM.channels);
  const base: SimConfig = { ...DEFAULT_SIM, sampleRate: SR };

  console.log(`Fly DJ bench — ${circuit.n} neurons, ${circuit.edges.pre.length} edges (${circuit.meta.name})`);
  console.log(`seed ${base.seed}, k = ${base.k}, f_c = ${base.fc} Hz, target IPI = ${(base.targetIpi * 1000).toFixed(0)} ms`);

  heading('Measured tuning curve (ideal pulse trains)');
  const cal = calibrate(circuit, base, undefined);
  const maxS = Math.max(...cal.curve.map((p) => p.s));
  for (const p of cal.curve) {
    const mark = Math.abs(p.ipiBase - base.targetIpi) < 1e-9 ? ' <- target' : '';
    console.log(`  ${(p.ipiBase * 1000).toFixed(0).padStart(4)} ms  S=${fmt(p.s)}  ${bar(p.s, maxS)}${mark}`);
  }
  const peakErr = Math.abs(cal.peakIpi - base.targetIpi) / base.targetIpi;
  console.log(
    `  peak at ${(cal.peakIpi * 1000).toFixed(0)} ms, target ${(base.targetIpi * 1000).toFixed(0)} ms ` +
      `(${(peakErr * 100).toFixed(0)}% off, budget 20%) — ${peakErr <= 0.2 ? 'PASS' : 'FAIL'}`,
  );
  console.log(`  S_noise = ${fmt(cal.sNoise)}   S_ideal = ${fmt(cal.sIdeal)}   sweep took ${cal.ms} ms`);

  heading('Approval by preset (k = 1)');
  const seconds = 6;
  const presetApproval: Record<string, number> = {};
  for (const id of PRESET_IDS) {
    const sig = renderPreset(id, SR, seconds);
    const r = measureSelectivity(circuit, base, undefined, sig);
    const a = approvalFrom(r.s, { sNoise: cal.sNoise, sIdeal: cal.sIdeal });
    presetApproval[id] = a;
    console.log(
      `  ${PRESETS[id].label.padEnd(22)} A=${fmt(a)}  S=${fmt(r.s)}  ` +
        `song=${fmt(r.songRate, 1)} Hz  sensor=${fmt(r.sensorRate, 1)} Hz`,
    );
  }
  const edm = presetApproval.fourOnTheFloor;
  const riddimA = presetApproval.courtshipRiddim;
  const jokeOk = riddimA >= 3 * edm && riddimA > 0.5;
  console.log(
    `  Courtship ${fmt(riddimA)} vs Four on the Floor ${fmt(edm)} ` +
      `(budget: 3x and above 0.5) — ${jokeOk ? 'PASS' : 'FAIL'}`,
  );

  heading('Fly size: Bass Rolls with Auto-fit');
  const rolls = renderPreset('bassRolls', SR, seconds);
  const ipi = flyBandIpi(rolls, base, circuit);
  const autoK = Math.max(1, Math.min(8, Math.round((ipi / base.targetIpi) / 0.05) * 0.05));
  console.log(`  median fly-band inter-peak interval: ${(ipi * 1000).toFixed(0)} ms -> Auto-fit k = ${autoK.toFixed(2)}`);
  const a1 = approvalFrom(measureSelectivity(circuit, base, undefined, rolls).s, cal);
  const fitCfg: SimConfig = { ...base, k: autoK };
  const calFit = calibrate(circuit, fitCfg, undefined);
  const aFit = approvalFrom(measureSelectivity(circuit, fitCfg, undefined, rolls).s, calFit);
  // A(k=1) is legitimately zero - a 73 Hz bass is simply outside a full-sized
  // fly's hearing - so "2x" also needs an absolute floor to mean anything.
  const fitOk = aFit >= 2 * a1 && aFit > 0.15;
  console.log(
    `  A(k=1) = ${fmt(a1)}   A(k=${autoK.toFixed(2)}) = ${fmt(aFit)}   ` +
      `(budget: 2x and above 0.15) — ${fitOk ? 'PASS' : 'FAIL'}`,
  );

  heading('Ablation compare (Courtship Riddim)');
  const riddim = renderPreset('courtshipRiddim', SR, seconds);
  // One shared calibration - the fly's own yardstick. Re-calibrating per mode
  // would normalise away exactly the difference the comparison is measuring.
  const abl: Record<AblationMode, number> = {} as Record<AblationMode, number>;
  for (const mode of ABLATION_MODES) {
    const edges = variantEdges(circuit, mode, base.seed);
    const r = measureSelectivity(circuit, base, edges, riddim);
    abl[mode] = approvalFrom(r.s, cal);
    console.log(`  ${ABLATION_LABELS[mode].padEnd(12)} A=${fmt(abl[mode])}  S=${fmt(r.s)}  ${bar(abl[mode], 1.5)}`);
  }
  console.log(
    `  Connectome vs Shuffled: ${fmt(abl.connectome / Math.max(1e-6, abl.shuffled), 2)}x — ` +
      `${abl.connectome > abl.shuffled ? 'wiring matters on the toy circuit' : 'wiring barely matters'}`,
  );

  heading('Volume invariance (Courtship Riddim, input level 0.5 - 2x)');
  const gains = [0.5, 1, 2];
  const vals = gains.map((g) => {
    const scaled = Float32Array.from(riddim, (v) => v * g);
    return approvalFrom(measureSelectivity(circuit, base, undefined, scaled).s, cal);
  });
  gains.forEach((g, i) => console.log(`  level ${g.toFixed(1)}x  A=${fmt(vals[i])}`));
  const spread = (Math.max(...vals) - Math.min(...vals)) / Math.max(1e-6, vals[1]);
  console.log(`  spread ${(spread * 100).toFixed(1)}% (budget 15%) — ${spread < 0.15 ? 'PASS' : 'FAIL'}`);

  heading('Performance budget (§3.4)');
  const perfSeconds = 10;
  const perfSignal = renderPreset('courtshipRiddim', SR, perfSeconds);
  // Best of three: a single sample on a shared machine measures scheduling
  // luck as much as it measures the simulation.
  const runs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const sim = new Simulation(circuit, base);
    const t0 = performance.now();
    sim.runAudio(perfSignal);
    runs.push((performance.now() - t0) / 1000);
  }
  const elapsed = Math.min(...runs);
  const scaled = elapsed * (3000 / circuit.n);
  console.log(
    `  ${perfSeconds} s of ${circuit.n} neurons at k=1: ${elapsed.toFixed(2)} s wall clock ` +
      `(best of ${runs.map((r) => r.toFixed(2)).join(', ')})`,
  );
  console.log(`  extrapolated to 3000 neurons: ${scaled.toFixed(2)} s (budget 4 s) — ${scaled <= 4 ? 'PASS' : 'FAIL'}`);
  console.log(`  realtime factor: ${(perfSeconds / elapsed).toFixed(1)}x`);

  heading('Determinism');
  const runOnce = () => {
    const s = new Simulation(circuit, base);
    s.runAudio(renderPreset('courtshipRiddim', SR, 3));
    return s.net.totalSpikes;
  };
  const a = runOnce();
  const b = runOnce();
  console.log(`  spike counts: ${a} and ${b} — ${a === b ? 'PASS' : 'FAIL'}`);
  console.log('');
}

main();
