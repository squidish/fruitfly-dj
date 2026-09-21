/**
 * Seeded RNG. Hard rule 6: the same seed with the same input must produce
 * identical spikes, so nothing in core may touch Math.random().
 */

/** sfc32 — small, fast, and passes PractRand. 128 bits of state. */
export class Rng {
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  private spare: number | null = null;

  constructor(seed: number | string) {
    const s = typeof seed === 'string' ? hashString(seed) : (seed >>> 0);
    // Splitmix32 the scalar seed out into the four words so that adjacent
    // integer seeds (1, 2, 3) give well-separated streams.
    let x = s === 0 ? 0x9e3779b9 : s;
    const next = () => {
      x = (x + 0x9e3779b9) >>> 0;
      let z = x;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.next();
  }

  /** Raw uint32. */
  next(): number {
    const t = (this.a + this.b) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) >>> 0;
    this.d = (this.d + 1) >>> 0;
    const r = (t + this.d) >>> 0;
    return r;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.float();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.float() * n) % n;
  }

  /** Standard normal, Box–Muller with a cached spare. */
  normal(): number {
    if (this.spare !== null) {
      const v = this.spare;
      this.spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.float() * 2 - 1;
      v = this.float() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const f = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * f;
    return u * f;
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Fill a Float32Array with standard normals. */
  fillNormal(out: Float32Array): Float32Array {
    for (let i = 0; i < out.length; i++) out[i] = this.normal();
    return out;
  }
}

/** FNV-1a, so string seeds ("courtship") work as well as numbers. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Derive an independent sub-stream, so adding a consumer cannot shift others. */
export function deriveSeed(seed: number, label: string): number {
  return (hashString(label) ^ Math.imul(seed >>> 0, 0x85ebca6b)) >>> 0;
}
