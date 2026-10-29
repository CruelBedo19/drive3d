/**
 * City V2 districts: which part of town a point belongs to, and how streets and
 * blocks are made there.
 *
 *  downtown     around the main boulevard crossing nearest the centre: small
 *               blocks, many crossroads, mid-block alleys, the plaza.
 *  commercial   along the boulevards next to downtown: medium / large blocks,
 *               malls, car parks, a stadium.
 *  residential  the quieter rest: small streets, more T junctions and bends,
 *               rear lanes behind the houses, parks.
 *  industrial   towards one edge of town: big parcels, sparse streets.
 *
 * Districts are weighted Voronoi cells around seeded centres (distance divided
 * by a per-kind reach, wobbled by low-frequency noise so borders are not
 * straight). How many centres of each kind, where industry sits and how far
 * downtown reaches all come from the seed, so cities differ in character, not
 * only in street placement. Pure function of (seed, size, boulevard plan).
 */
import { valueNoise } from '../../../src/world/autobahn/noise';
import { stream, streamSeed } from './rng';

export type District = 'downtown' | 'commercial' | 'residential' | 'industrial';
export const DISTRICTS: readonly District[] = ['downtown', 'commercial', 'residential', 'industrial'];

/** What a protected large parcel is meant for (filled in by later stages). */
export type ParcelUse = 'mall' | 'hospital' | 'factory' | 'warehouse' | 'parking' | 'park' | 'stadium' | 'landmark';

export interface DistrictProfile {
  /** Blocks are split until their longer side is below a target in this range, m. */
  blockSpan: [number, number];
  /** Chance a split continues a street from across (crossroads) rather than a T. */
  continueChance: number;
  /** Chance of an L-shaped street (90° bend inside the block). */
  lChance: number;
  /** Relative weight for alleys (alley pass). */
  alley: number;
  /** Chance a big enough block is kept whole as a large parcel. */
  large: number;
  /** Uses for its large parcels, most likely first (a use listed twice comes up twice as often). */
  uses: ParcelUse[];
  /** Relative reach of a centre of this kind (bigger: larger cells). */
  reach: number;
  /** Smallest block depth between the backs of the sidewalks here, m (dense downtown lots are shallower). */
  minDepth: number;
  /** Smallest distance between junctions along a street here, m (downtown: one kit intersection apart). */
  minGap: number;
}

export const DISTRICT: Record<District, DistrictProfile> = {
  downtown: { blockSpan: [36, 66], continueChance: 0.7, lChance: 0.06, alley: 1, large: 0.12, uses: ['landmark', 'hospital'], reach: 1.05, minDepth: 24, minGap: 24 },
  commercial: { blockSpan: [90, 150], continueChance: 0.5, lChance: 0.1, alley: 0.3, large: 0.5, uses: ['mall', 'parking', 'stadium'], reach: 1, minDepth: 30, minGap: 30 },
  residential: { blockSpan: [66, 114], continueChance: 0.18, lChance: 0.32, alley: 0.65, large: 0.15, uses: ['park', 'hospital'], reach: 1.1, minDepth: 26, minGap: 30 },
  industrial: { blockSpan: [130, 230], continueChance: 0.3, lChance: 0.06, alley: 0.25, large: 0.7, uses: ['factory', 'warehouse', 'factory', 'warehouse', 'parking'], reach: 1.15, minDepth: 36, minGap: 30 },
};

export interface DistrictCentre {
  kind: District;
  x: number;
  z: number;
}

export interface DistrictMap {
  centres: DistrictCentre[];
  at(x: number, z: number): District;
}

/**
 * @param size town size, m
 * @param crossings boulevard crossings (m): downtown grows around the one nearest the centre
 * @param boulevards points along the boulevards (m): commercial centres sit on them
 */
export function planDistricts(seed: number, size: number, crossings: [number, number][], boulevards: [number, number][]): DistrictMap {
  const r = stream(seed, 'districts');
  const half = size / 2;
  const km2 = (size / 1000) ** 2;
  const scale = Math.sqrt(km2);
  const centres: DistrictCentre[] = [];
  // Downtown: the boulevard crossing nearest the centre (else near the centre), nudged.
  const core = [...crossings].sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0] ?? [r.range(-0.1, 0.1) * size, r.range(-0.1, 0.1) * size];
  centres.push({ kind: 'downtown', x: core[0] + r.range(-0.04, 0.04) * size, z: core[1] + r.range(-0.04, 0.04) * size });
  // Industry: towards one (random) edge, one centre per ~km of that edge.
  const side = r.int(0, 3);
  const nInd = Math.max(1, Math.round(scale * r.range(0.8, 1.4)));
  for (let i = 0; i < nInd; i++) {
    const t = (-0.5 + (i + 0.5) / nInd + r.range(-0.12, 0.12)) * size * 0.9;
    const d = half * r.range(0.62, 0.8);
    const [x, z] = side === 0 ? [t, -d] : side === 1 ? [d, t] : side === 2 ? [t, d] : [-d, t];
    centres.push({ kind: 'industrial', x, z });
  }
  // Commercial: on boulevards, ring around downtown, away from industry.
  const nCom = Math.max(1, Math.round(scale * r.range(1.2, 2.2)));
  const along = r.shuffle([...boulevards]).filter(([x, z]) => {
    const dDown = Math.hypot(x - centres[0].x, z - centres[0].z);
    return dDown > size * 0.16 && dDown < size * 0.42 && centres.every((c) => c.kind !== 'industrial' || Math.hypot(x - c.x, z - c.z) > size * 0.28);
  });
  for (const [x, z] of along) {
    if (centres.filter((c) => c.kind === 'commercial').length >= nCom) break;
    if (centres.some((c) => c.kind === 'commercial' && Math.hypot(x - c.x, z - c.z) < size * 0.3)) continue;
    centres.push({ kind: 'commercial', x, z });
  }
  // Residential: the rest, spread with a simple best-candidate pick (far from every other centre).
  const nRes = Math.max(2, Math.round(scale * r.range(2.2, 3.4)));
  for (let i = 0; i < nRes; i++) {
    let best: [number, number] = [0, 0];
    let bestD = -1;
    for (let k = 0; k < 24; k++) {
      const q: [number, number] = [r.range(-0.42, 0.42) * size, r.range(-0.42, 0.42) * size];
      const d = Math.min(...centres.map((c) => Math.hypot(q[0] - c.x, q[1] - c.z)));
      if (d > bestD) {
        bestD = d;
        best = q;
      }
    }
    centres.push({ kind: 'residential', x: best[0], z: best[1] });
  }
  const wobble = streamSeed(seed, 'district-noise');
  const at = (x: number, z: number): District => {
    let best: District = 'residential';
    let bestD = Infinity;
    for (const c of centres) {
      const n = 1 + 0.18 * valueNoise(wobble, x / 140, z / 140);
      const d = (Math.hypot(x - c.x, z - c.z) * n) / DISTRICT[c.kind].reach;
      if (d < bestD) {
        bestD = d;
        best = c.kind;
      }
    }
    return best;
  };
  return { centres, at };
}
