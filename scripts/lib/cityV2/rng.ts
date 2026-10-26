/**
 * Seeded randomness for the City V2 generators. Each stage draws from its own
 * stream (`stream(seed, 'ring')`, `stream(seed, 'blocks')`...), so changing how
 * one stage uses its numbers never reshuffles the others: the same seed always
 * gives the same city.
 */

export interface Rng {
  /** [0, 1). */
  next(): number;
  /** [a, b). */
  range(a: number, b: number): number;
  /** Integer in [a, b], both included. */
  int(a: number, b: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  /** Fisher-Yates, in place. */
  shuffle<T>(list: T[]): T[];
  /** Roughly normal (sum of three uniforms), mean m, standard deviation sd. */
  normal(m: number, sd: number): number;
}

/** mulberry32. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r: Rng = {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    shuffle: (list) => {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    },
    normal: (m, sd) => m + sd * (next() + next() + next() - 1.5) * 2,
  };
  return r;
}

/** Seed for a named stream (FNV-1a over the label, mixed with the city seed). */
export function streamSeed(seed: number, label: string): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619) >>> 0;
  return Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
}

export function stream(seed: number, label: string): Rng {
  return makeRng(streamSeed(seed, label));
}

/** Deterministic [0, 1) from a seed and a string key (per-face choices that must not depend on visiting order). */
export function hashUnit(seed: number, key: string): number {
  return streamSeed(seed, key) / 4294967296;
}
