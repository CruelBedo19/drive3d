import { BIOME_IDS, BIOMES, FIELD_COLOURS } from '../../config/biomes';
import { AUTOBAHN as A } from '../../config/tracks';
import { BIOME_COUNT } from './BiomeMap';
import { hash2, ramp, valueNoise } from './noise';
import { SECTION, type Frame, type RoadGenerator } from './RoadGenerator';

const FARMLAND = BIOME_IDS.indexOf('farmland');
const INDUSTRIAL = BIOME_IDS.indexOf('industrial');
const ROCKY = BIOME_IDS.indexOf('rocky');
const PROFILES = BIOME_IDS.map((id) => BIOMES[id]);
const ROCK = [0.44, 0.42, 0.38] as const;
const CONCRETE = [0.55, 0.55, 0.52] as const;

/**
 * The landscape as a function of a world point: finds the point's road
 * coordinate (s, lateral offset) by Newton steps along the centre line, then
 * reads the generator's height (road corridor terrain near the road, free
 * landscape further out) and paints a colour from the biome weights. Used by
 * the chunk ribbons, the landscape tiles and the vegetation, so all of them
 * agree exactly where they meet.
 */
export class TerrainField {
  readonly gen: RoadGenerator;
  /** Road coordinate of the last projected point. */
  s = 0;
  off = 0;
  /** False when the point lies before the road's start (no corridor there). */
  onRoad = false;
  private readonly f: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
  private readonly rot: number;

  constructor(gen: RoadGenerator) {
    this.gen = gen;
    this.rot = hash2(gen.seed, 5, 5) * Math.PI;
  }

  /** Road coordinate of (x, z), starting the search at `guess` (a nearby point's s). */
  project(x: number, z: number, guess: number): void {
    const gen = this.gen;
    // Stay inside the generated road (never extend it from here: far points would grow it endlessly).
    const sMax = Math.max(0, gen.length - 601);
    let s = Math.min(sMax, Math.max(0, guess));
    const f = this.f;
    for (let i = 0; i < 6; i++) {
      gen.frame(s, f);
      const d = (x - f.x) * Math.sin(f.heading) + (z - f.z) * Math.cos(f.heading);
      const next = Math.min(sMax, Math.max(0, s + d));
      const moved = Math.abs(next - s);
      s = next;
      if (moved < 0.05) break;
    }
    gen.frame(s, f);
    this.s = s;
    this.off = (x - f.x) * Math.cos(f.heading) - (z - f.z) * Math.sin(f.heading);
    // Clamped at the start: the point is behind the road, not beside it.
    const along = (x - f.x) * Math.sin(f.heading) + (z - f.z) * Math.cos(f.heading);
    this.onRoad = !((s <= 0 && along < -1) || (s >= sMax && along > 1));
  }

  /** Landscape height at (x, z) (projects first; s / off / weights stay readable). */
  height(x: number, z: number, guess: number): number {
    this.project(x, z, guess);
    if (!this.onRoad) return this.gen.farHeight(x, z, this.gen.biome.weights(x, z, this.gen.weights));
    return this.gen.worldHeight(this.s, this.off, x, z);
  }

  /**
   * Ground colour at (x, z) for biome weights `w`: biome ground (a forest's
   * canopy colour when `canopy` → 1, for distant tiles that carry no trees),
   * crop-field patchwork in farmland, concrete yards in industrial areas, rock
   * on steep slopes. `slopeY` = normal.y (1 = flat). Writes rgb at out[i..i+2].
   */
  colour(x: number, z: number, w: Float32Array, slopeY: number, canopy: number, off: number, out: number[] | Float32Array, i: number): void {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < BIOME_COUNT; k++) {
      const wk = w[k];
      if (wk <= 0.001) continue;
      const p = PROFILES[k];
      const c = Math.min(1, canopy * p.trees * 1.3);
      let cr = p.ground[0] + (p.canopy[0] - p.ground[0]) * c;
      let cg = p.ground[1] + (p.canopy[1] - p.ground[1]) * c;
      let cb = p.ground[2] + (p.canopy[2] - p.ground[2]) * c;
      if ((k === FARMLAND || k === INDUSTRIAL) && Math.abs(off) > SECTION.edge + 12) {
        // Patchwork on a rotated grid: long fields / yards with their own colour.
        const cos = Math.cos(this.rot);
        const sin = Math.sin(this.rot);
        const u = x * cos - z * sin;
        const v = x * sin + z * cos;
        if (k === FARMLAND) {
          const field = FIELD_COLOURS[Math.floor(hash2(this.gen.seed + 41, Math.floor(u / 170), Math.floor(v / 70)) * FIELD_COLOURS.length)];
          cr = cr * 0.2 + field[0] * 0.8;
          cg = cg * 0.2 + field[1] * 0.8;
          cb = cb * 0.2 + field[2] * 0.8;
        } else if (hash2(this.gen.seed + 43, Math.floor(u / 90), Math.floor(v / 90)) < 0.35) {
          cr = CONCRETE[0];
          cg = CONCRETE[1];
          cb = CONCRETE[2];
        }
      }
      r += cr * wk;
      g += cg * wk;
      b += cb * wk;
    }
    const steep = ramp(1 - slopeY, 0.16, 0.42) * (0.55 + w[ROCKY]);
    if (steep > 0) {
      const t = Math.min(1, steep);
      r += (ROCK[0] - r) * t;
      g += (ROCK[1] - g) * t;
      b += (ROCK[2] - b) * t;
    }
    const shade = 0.88 + 0.12 * valueNoise(this.gen.seed + 47, x / 23, z / 23);
    out[i] = r * shade;
    out[i + 1] = g * shade;
    out[i + 2] = b * shade;
  }

  /** Sink applied to landscape tiles inside the road corridor (they lie under the chunk ribbons). */
  static corridorSink(off: number): number {
    const a = Math.abs(off);
    const c = A.world.corridor;
    if (a >= c + 8) return 0;
    if (a <= c) return 1.5 + 6.5 * (1 - ramp(a, SECTION.edge + 5, SECTION.edge + 30));
    return 1.5 * (1 - (a - c) / 8);
  }
}
