/**
 * Small deterministic noise kit shared by the road, biome and terrain code:
 * integer hash, smooth value noise, fractal sums. Everything is a pure function
 * of (seed, x, z), so a world rebuilt from the same seed is identical.
 *
 * The ridged sum (each octave weighted by the previous one, so ridges stay
 * sharp and valleys smooth) follows the approach of Procedural Terrains by
 * ZyFou (MIT, `ridgedFBM` in src/engine/terrain/terrainGLSL.js); written
 * here in plain TypeScript for the CPU.
 */

/** Integer hash → [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [-1, 1]. */
export function valueNoise(seed: number, x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(seed, xi, zi);
  const b = hash2(seed, xi + 1, zi);
  const c = hash2(seed, xi, zi + 1);
  const d = hash2(seed, xi + 1, zi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

/** Fractal sum of value noise, normalised to about [-1, 1]. Octaves are rotated so grid lines don't line up. */
export function fbm(seed: number, x: number, z: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(seed + i * 131, px, pz) * amp;
    norm += amp;
    amp *= 0.5;
    // Rotate ~37° and scale ×2.03 per octave.
    const nx = (px * 0.8 - pz * 0.6) * 2.03;
    pz = (px * 0.6 + pz * 0.8) * 2.03;
    px = nx;
  }
  return sum / norm;
}

/** Ridged fractal sum in [0, 1]: sharp crests, broad valleys. */
export function ridged(seed: number, x: number, z: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let carry = 1;
  let norm = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i < octaves; i++) {
    let n = 1 - Math.abs(valueNoise(seed + i * 977, px, pz));
    n *= n;
    n *= carry;
    carry = Math.min(1, Math.max(0, n * 1.4));
    sum += n * amp;
    norm += amp;
    amp *= 0.5;
    const nx = (px * 0.8 - pz * 0.6) * 2.05;
    pz = (px * 0.6 + pz * 0.8) * 2.05;
    px = nx;
  }
  return sum / norm;
}

export const smooth01 = (t: number): number => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};

/** 0 below a, 1 above b, smooth in between. */
export const ramp = (v: number, a: number, b: number): number => smooth01((v - a) / (b - a));
