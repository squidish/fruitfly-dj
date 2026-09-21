import { describe, expect, it } from 'vitest';
import { buildCsr, degreePreservingShuffle, inDegree, rescale, weightOf, type EdgeArrays } from '../src/core/csr.ts';

function edges(list: [number, number, number, number][]): EdgeArrays {
  return {
    pre: Uint32Array.from(list.map((e) => e[0])),
    post: Uint32Array.from(list.map((e) => e[1])),
    syn: Uint16Array.from(list.map((e) => e[2])),
    sign: Int8Array.from(list.map((e) => e[3])),
  };
}

describe('weightOf', () => {
  it('scales by synapse count and sign', () => {
    expect(weightOf(20, 1, { wScale: 0.01, inhibScale: 1 })).toBeCloseTo(0.2);
    expect(weightOf(20, -1, { wScale: 0.01, inhibScale: 1 })).toBeCloseTo(-0.2);
  });

  it('applies inhib_scale only to negative weights', () => {
    expect(weightOf(20, -1, { wScale: 0.01, inhibScale: 2 })).toBeCloseTo(-0.4);
    expect(weightOf(20, 1, { wScale: 0.01, inhibScale: 2 })).toBeCloseTo(0.2);
  });

  it('zeroes unknown transmitters rather than guessing', () => {
    expect(weightOf(99, 0, { wScale: 0.01, inhibScale: 1 })).toBe(0);
  });
});

describe('buildCsr', () => {
  const e = edges([
    [0, 1, 10, 1],
    [0, 2, 20, -1],
    [2, 1, 30, 1],
    [1, 0, 5, 1],
  ]);

  it('groups edges by presynaptic neuron', () => {
    const csr = buildCsr(3, e, { wScale: 0.01, inhibScale: 1 });
    expect(csr.nnz).toBe(4);
    expect(csr.rowStart[0]).toBe(0);
    expect(csr.rowStart[1]).toBe(2);
    expect(csr.rowStart[3]).toBe(4);
    const targetsOf0 = Array.from(csr.target.slice(csr.rowStart[0], csr.rowStart[1])).sort();
    expect(targetsOf0).toEqual([1, 2]);
  });

  it('preserves total signed weight', () => {
    const csr = buildCsr(3, e, { wScale: 0.01, inhibScale: 1 });
    const total = csr.weight.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo((10 - 20 + 30 + 5) * 0.01, 6);
  });

  it('rescales in place without rebuilding', () => {
    const csr = buildCsr(3, e, { wScale: 0.01, inhibScale: 1 });
    const before = csr.weight.slice();
    rescale(csr, { wScale: 0.02, inhibScale: 1 });
    for (let i = 0; i < csr.nnz; i++) expect(csr.weight[i]).toBeCloseTo(before[i] * 2, 6);
  });

  it('counts in-degree', () => {
    expect(Array.from(inDegree(3, e))).toEqual([1, 2, 1]);
  });
});

describe('degreePreservingShuffle', () => {
  const list: [number, number, number, number][] = [];
  for (let pre = 0; pre < 20; pre++) {
    for (let j = 0; j < 4; j++) {
      list.push([pre, (pre * 7 + j * 3 + 1) % 20, 10 + j, j % 2 === 0 ? 1 : -1]);
    }
  }
  const original = edges(list);

  it('preserves every out-degree and in-degree', () => {
    const shuffled = degreePreservingShuffle(original, 42);
    const outBefore = new Uint32Array(20);
    const outAfter = new Uint32Array(20);
    for (let i = 0; i < original.pre.length; i++) {
      outBefore[original.pre[i]]++;
      outAfter[shuffled.pre[i]]++;
    }
    expect(Array.from(outAfter)).toEqual(Array.from(outBefore));
    expect(Array.from(inDegree(20, shuffled))).toEqual(Array.from(inDegree(20, original)));
  });

  it('preserves the weight distribution', () => {
    const shuffled = degreePreservingShuffle(original, 42);
    const sort = (a: ArrayLike<number>) => Array.from(a).sort((x, y) => x - y);
    expect(sort(shuffled.syn)).toEqual(sort(original.syn));
    expect(sort(shuffled.sign)).toEqual(sort(original.sign));
  });

  it('actually rewires, and does so deterministically', () => {
    const a = degreePreservingShuffle(original, 42);
    const b = degreePreservingShuffle(original, 42);
    expect(Array.from(a.post)).toEqual(Array.from(b.post));
    let moved = 0;
    for (let i = 0; i < original.post.length; i++) if (a.post[i] !== original.post[i]) moved++;
    expect(moved).toBeGreaterThan(original.post.length * 0.5);
  });

  it('creates no self-loops', () => {
    const shuffled = degreePreservingShuffle(original, 7);
    for (let i = 0; i < shuffled.pre.length; i++) expect(shuffled.pre[i]).not.toBe(shuffled.post[i]);
  });
});
