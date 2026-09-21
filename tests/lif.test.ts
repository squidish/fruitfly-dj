import { describe, expect, it } from 'vitest';
import { buildCsr, type EdgeArrays } from '../src/core/csr.ts';
import { DEFAULT_LIF, Network } from '../src/core/lif.ts';

function emptyEdges(): EdgeArrays {
  return { pre: new Uint32Array(0), post: new Uint32Array(0), syn: new Uint16Array(0), sign: new Int8Array(0) };
}

function net(n: number, edges: EdgeArrays, patch: Partial<typeof DEFAULT_LIF> = {}, groups?: Uint8Array): Network {
  const params = { ...DEFAULT_LIF, noiseSigma: 0, ...patch };
  return new Network({
    n,
    csr: buildCsr(n, edges, { wScale: 1, inhibScale: 1 }),
    groupOf: groups ?? new Uint8Array(n),
    nGroups: 2,
    params,
    seed: 1,
  });
}

function run(network: Network, drive: Float32Array, steps: number): number {
  for (let i = 0; i < steps; i++) network.step(drive);
  return network.totalSpikes;
}

describe('Network', () => {
  it('stays silent below threshold', () => {
    const nw = net(1, emptyEdges());
    const drive = Float32Array.from([0.9]);
    expect(run(nw, drive, 4000)).toBe(0);
  });

  it('fires above threshold', () => {
    const nw = net(1, emptyEdges());
    expect(run(nw, Float32Array.from([2]), 4000)).toBeGreaterThan(0);
  });

  it('fires at the rate the membrane equation predicts', () => {
    // Analytic ISI for a constant drive I: tau * ln(I / (I - 1)) + t_ref.
    const I = 2;
    const tauM = 0.01;
    const tRef = 0.002;
    const nw = net(1, emptyEdges(), { tauM, tRef });
    const seconds = 4;
    const steps = Math.round(seconds / DEFAULT_LIF.dt);
    const spikes = run(nw, Float32Array.from([I]), steps);
    const expectedIsi = tauM * Math.log(I / (I - 1)) + tRef;
    expect(spikes / seconds).toBeCloseTo(1 / expectedIsi, -0.5);
  });

  it('honours the refractory period', () => {
    const tRef = 0.01;
    const nw = net(1, emptyEdges(), { tRef, tauM: 0.002 });
    const seconds = 2;
    const spikes = run(nw, Float32Array.from([40]), Math.round(seconds / DEFAULT_LIF.dt));
    // With a huge drive the rate is capped by the refractory period alone.
    expect(spikes / seconds).toBeLessThanOrEqual(1 / tRef + 1);
    expect(spikes / seconds).toBeGreaterThan(1 / (tRef + DEFAULT_LIF.dt * 2) - 5);
  });

  it('delivers spikes after the synaptic delay, not before', () => {
    const edges: EdgeArrays = {
      pre: Uint32Array.from([0]),
      post: Uint32Array.from([1]),
      syn: Uint16Array.from([2]),
      sign: Int8Array.from([1]),
    };
    const delay = 0.005;
    const nw = net(2, edges, { delay, tauM: 0.005, tRef: 0.002 });
    const drive = Float32Array.from([2, 0]);
    let firstPre = -1;
    let firstPost = -1;
    for (let i = 0; i < 400; i++) {
      nw.step(drive);
      for (let s = 0; s < nw.spikeCount; s++) {
        if (nw.spikeIdx[s] === 0 && firstPre < 0) firstPre = i;
        if (nw.spikeIdx[s] === 1 && firstPost < 0) firstPost = i;
      }
    }
    expect(firstPre).toBeGreaterThanOrEqual(0);
    expect(firstPost).toBeGreaterThan(firstPre);
    expect((firstPost - firstPre) * DEFAULT_LIF.dt).toBeGreaterThanOrEqual(delay - DEFAULT_LIF.dt);
  });

  it('lets inhibition silence a driven neuron', () => {
    const edges: EdgeArrays = {
      pre: Uint32Array.from([0]),
      post: Uint32Array.from([1]),
      syn: Uint16Array.from([3]),
      sign: Int8Array.from([-1]),
    };
    const withInhib = net(2, edges, {});
    const without = net(2, emptyEdges(), {});
    const drive = Float32Array.from([2, 1.2]);
    const countTarget = (nw: Network) => {
      let c = 0;
      for (let i = 0; i < 4000; i++) {
        nw.step(drive);
        for (let s = 0; s < nw.spikeCount; s++) if (nw.spikeIdx[s] === 1) c++;
      }
      return c;
    };
    expect(countTarget(withInhib)).toBeLessThan(countTarget(without) / 2);
  });

  it('reports a low-passed rate that converges on the true rate', () => {
    const nw = net(1, emptyEdges(), { tauM: 0.01, tRef: 0.002, rateTau: 0.2 });
    const I = 2;
    run(nw, Float32Array.from([I]), 20000);
    const expected = 1 / (0.01 * Math.log(I / (I - 1)) + 0.002);
    expect(nw.rate[0]).toBeGreaterThan(expected * 0.7);
    expect(nw.rate[0]).toBeLessThan(expected * 1.3);
  });

  it('reports per-group mean rates', () => {
    const groups = Uint8Array.from([0, 1, 1]);
    const nw = net(3, emptyEdges(), { rateTau: 0.2 }, groups);
    run(nw, Float32Array.from([2, 2, 0]), 20000);
    expect(nw.groupRate[0]).toBeGreaterThan(10);
    // Group 1 has one firing neuron out of two, so its mean is about half.
    expect(nw.groupRate[1]).toBeGreaterThan(nw.groupRate[0] * 0.35);
    expect(nw.groupRate[1]).toBeLessThan(nw.groupRate[0] * 0.65);
  });

  it('is deterministic under noise for a given seed', () => {
    const make = () =>
      new Network({
        n: 8,
        csr: buildCsr(8, emptyEdges(), { wScale: 1, inhibScale: 1 }),
        groupOf: new Uint8Array(8),
        nGroups: 1,
        params: { ...DEFAULT_LIF, noiseSigma: 0.3 },
        seed: 99,
      });
    const drive = new Float32Array(8).fill(0.8);
    const a = make();
    const b = make();
    expect(run(a, drive, 5000)).toBe(run(b, drive, 5000));
    expect(a.totalSpikes).toBeGreaterThan(0);
  });

  it('gives different spikes for different seeds', () => {
    const make = (seed: number) =>
      new Network({
        n: 8,
        csr: buildCsr(8, emptyEdges(), { wScale: 1, inhibScale: 1 }),
        groupOf: new Uint8Array(8),
        nGroups: 1,
        params: { ...DEFAULT_LIF, noiseSigma: 0.3 },
        seed,
      });
    const drive = new Float32Array(8).fill(0.8);
    expect(run(make(1), drive, 5000)).not.toBe(run(make(2), drive, 5000));
  });

  it('resets cleanly', () => {
    const nw = net(1, emptyEdges());
    run(nw, Float32Array.from([2]), 1000);
    nw.reset();
    expect(nw.totalSpikes).toBe(0);
    expect(nw.t).toBe(0);
    expect(nw.rate[0]).toBe(0);
  });
});
