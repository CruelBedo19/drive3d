import { BIOME_IDS, BIOMES, type BiomeId } from '../../config/biomes';
import { fbm, ramp } from './noise';

export const BIOME_COUNT = BIOME_IDS.length;
const SERVICE = BIOME_IDS.indexOf('service');

/** 1 at c, falling to 0 at c ± w. */
function bell(t: number, c: number, w: number): number {
  const d = (t - c) / w;
  return Math.max(0, 1 - d * d);
}

/**
 * Where the landscape is forest, farmland, hills… as weights at a world point.
 * Four slow climate fields (moisture, ruggedness, settlement, basin), each a
 * domain-warped fractal noise with a wavelength of several kilometres, are
 * turned into overlapping smooth weights and normalised. Neighbouring biomes
 * therefore fade into each other over hundreds of metres (forest → open forest
 * → fields → hills) instead of switching at a line. The rest-area surroundings
 * are added by the caller (they depend on the road, not on the climate).
 *
 * The climate-field idea (several low-frequency fields mapped to soft biome
 * weights) follows Procedural Terrains by ZyFou (MIT, `climateAt` /
 * `biomeWeightsAt` in src/engine/terrain/biomeGLSL.js); own implementation.
 */
export class BiomeMap {
  readonly seed: number;
  private readonly sm: number;
  private readonly sr: number;
  private readonly su: number;
  private readonly sv: number;
  private readonly sw: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.sm = (this.seed ^ 0x51ed27) >>> 0;
    this.sr = (this.seed ^ 0x2c1b3c6d) >>> 0;
    this.su = (this.seed ^ 0x297a2d39) >>> 0;
    this.sv = (this.seed ^ 0x1b56c4e9) >>> 0;
    this.sw = (this.seed ^ 0x7feb352d) >>> 0;
  }

  /**
   * Biome weights at (x, z), summing to 1, written into `out` (length BIOME_COUNT).
   * `service` 0..1: how much of this spot belongs to a rest area's surroundings.
   */
  weights(x: number, z: number, out: Float32Array, service = 0): Float32Array {
    // Domain warp: bends region borders into organic shapes.
    const wx = x + fbm(this.sw, x / 3000, z / 3000, 2) * 600;
    const wz = z + fbm(this.sw + 17, x / 3000, z / 3000, 2) * 600;
    const m = 0.5 + 0.5 * fbm(this.sm, wx / 5200, wz / 5200, 2);
    const r = 0.5 + 0.5 * fbm(this.sr, wx / 7400, wz / 7400, 2);
    const u = 0.5 + 0.5 * fbm(this.su, wx / 9000, wz / 9000, 2);
    const v = 0.5 + 0.5 * fbm(this.sv, wx / 6200, wz / 6200, 2);
    const flat = 1 - ramp(r, 0.55, 0.7);
    out[0] = ramp(m, 0.5, 0.74) * (1 - ramp(r, 0.62, 0.78)); // denseForest
    out[1] = bell(m, 0.47, 0.18) * (1 - ramp(r, 0.66, 0.8)); // openForest
    out[2] = (1 - ramp(m, 0.42, 0.54)) * flat * ramp(u, 0.36, 0.48); // farmland
    out[3] = (1 - ramp(m, 0.38, 0.5)) * flat * (1 - ramp(u, 0.34, 0.46)); // grassland
    out[4] = bell(r, 0.6, 0.1); // rollingHills
    out[5] = ramp(v, 0.6, 0.74) * (1 - ramp(r, 0.62, 0.76)); // valley
    out[6] = ramp(r, 0.66, 0.8); // rocky
    out[7] = ramp(u, 0.6, 0.7) * flat * 1.4; // industrial
    out[8] = 0;
    let sum = 0;
    for (let i = 0; i < SERVICE; i++) {
      // Sharpen a little so each region has a clear character, then normalise.
      out[i] = out[i] * out[i];
      sum += out[i];
    }
    // A little meadow everywhere: when every region is weak the mix still changes smoothly.
    out[3] += 0.06;
    sum += 0.06;
    const k = (1 - service) / sum;
    for (let i = 0; i < SERVICE; i++) out[i] *= k;
    out[SERVICE] = service;
    return out;
  }

  /** Strongest biome of a weight set. */
  static dominant(w: Float32Array): BiomeId {
    let best = 0;
    for (let i = 1; i < BIOME_COUNT; i++) if (w[i] > w[best]) best = i;
    return BIOME_IDS[best];
  }

  /** Weighted sum of one numeric profile field. */
  static mix(w: Float32Array, key: 'nearAmp' | 'detail' | 'ridge' | 'sink' | 'farBase' | 'farAmp' | 'trees' | 'conifer' | 'shrubs' | 'buildings'): number {
    let s = 0;
    for (let i = 0; i < BIOME_COUNT; i++) if (w[i] > 0) s += w[i] * BIOMES[BIOME_IDS[i]][key];
    return s;
  }
}
