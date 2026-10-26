/** Selectable driving worlds (`?track=`). */
export type TrackId = 'test' | 'nordschleife' | 'autobahn' | 'city';

export const TRACK_IDS: readonly TrackId[] = ['test', 'nordschleife', 'autobahn', 'city'];
export const DEFAULT_TRACK: TrackId = 'test';

/** Ids of removed or renamed worlds (old links, saved profiles) → the world that replaced them. */
const TRACK_ALIASES: Record<string, TrackId> = { city_v2: 'city' };

export function canonicalTrackId(v: string | null): string | null {
  return v !== null ? (TRACK_ALIASES[v] ?? v) : null;
}

export function isTrackId(v: string | null): v is TrackId {
  return v !== null && (TRACK_IDS as readonly string[]).includes(v);
}

/**
 * Nordschleife cross-section and build settings, metres. The centre line comes
 * from OpenStreetMap (src/world/tracks/nordschleife.json); everything else is ours.
 *
 *   tree line | verge | barrier | grass shoulder | kerb | asphalt | centre | ...
 */
export const NORDSCHLEIFE = {
  /** Asphalt width (the real track is ~8-12 m). */
  width: 10,
  /** Painted edge line: distance in from the asphalt edge, width. */
  edgeLine: { inset: 0.3, width: 0.15 },
  centreDash: { width: 0.12, dash: 3, gap: 6 },
  /** Kerbs on the inside of corners tighter than `insideRadius`, outside below `outsideRadius`. */
  kerb: { width: 1.1, insideRadius: 180, outsideRadius: 70, stripe: 1.5, height: 0.03 },
  /** Grass between the asphalt and the guard rail. */
  shoulder: 4,
  /** Guard rail: height, thickness. */
  barrier: { height: 0.75, thickness: 0.2 },
  /** Ground outside the rail (drivable, so a car that jumps the rail doesn't fall out of the world). */
  verge: 18,
  trees: { spacing: 9, depth: 22, minHeight: 9, maxHeight: 19, seed: 1927 },
  /** Sample spacing along the track: visuals, colliders. */
  visualStep: 2,
  colliderStep: 4,
  /** Visual meshes are split into chunks this long so frustum culling works. */
  chunkLength: 400,
  /** Spawn this far after the start line (on the T13 straight). */
  spawnDistance: 70,
  fog: { near: 220, far: 1100 },
} as const;

/**
 * Autobahn: procedural, streamed, deterministic per seed. All dimensions in
 * metres. Offsets across the road are measured from the median centre,
 * positive = left of the driving direction (direction A drives on the right).
 */
export const AUTOBAHN = {
  seed: 2026,
  /** Cross-section (German RQ 36-style). */
  lane: 3.75,
  lanes: 3,
  /** Paved strip between the median barrier and the fast lane. */
  innerStrip: 0.75,
  /** Emergency shoulder (Standstreifen). */
  shoulder: 3,
  /** Median: half width from the centre to the inner strip. */
  medianHalf: 1.6,
  /** Gravel / grass beyond the shoulder before the guard rail. */
  verge: 1.2,
  /** Lateral fall for drainage (rise per metre away from the median). */
  crossfall: 0.015,
  /** Superelevation: slope per unit curvature, and its limit (~2°). */
  bankPerCurvature: 110,
  maxBank: 0.035,
  markings: { width: 0.15, edgeWidth: 0.3, dash: 6, gap: 12, lift: 0.012 },
  guardrail: { height: 0.75, thickness: 0.2, post: 4 },
  medianBarrier: { height: 0.9, width: 0.6 },
  /** Road plan (sizes chosen for 300+ km/h: long straights, wide sweepers). */
  plan: {
    straight: [900, 3200] as const,
    radius: [1500, 4500] as const,
    curveLength: [500, 1800] as const,
    transition: 260,
    maxGrade: 0.04,
    gradeLength: [700, 2200] as const,
    gradeTransition: 350,
    startStraight: 1400,
    /** Curves always turn back towards the start direction once the heading has drifted this far (rad)… */
    headingDrift: 0.45,
    /** …and one curve turns at most this much: the heading stays within ±78°, so the road never loops. */
    maxTurn: 0.9,
  },
  features: {
    tunnel: { every: [6000, 10000] as const, length: [300, 900] as const, height: 7.2, hill: 26 },
    bridge: { every: [4500, 8000] as const, length: [220, 480] as const, depth: 22 },
    overpass: { every: [1800, 3200] as const, height: 6.8, width: 11 },
    exit: { every: [4500, 7000] as const, length: 520, spread: 38, drop: 4 },
    restArea: { every: [11000, 15000] as const, first: 3800, length: 950, offset: 78 },
    environment: { length: [3000, 6000] as const, blend: 400 },
  },
  /** Streaming: chunk length and how many are kept around the player. */
  chunk: { length: 200, ahead: 10, behind: 3, cache: 6 },
  /**
   * Road-aligned terrain ribbon of each chunk (detailed, with colliders): lateral columns beyond
   * the road edge, along-road step. It reaches a little past `world.corridor`, where the free
   * landscape tiles take over.
   */
  terrain: { offsets: [0, 3, 8, 16, 28, 46, 72, 98, 122, 136], step: 10, colliderBand: 70 },
  /** Roadside trees of each chunk, up to the corridor edge (the landscape tiles plant the rest). */
  trees: { spacing: 14, maxOffset: 140, seed: 77 },
  /** Bushes near the road (instanced, culled at half the vegetation distance). */
  shrubs: { spacing: 9, from: 4, to: 48 },
  /**
   * Endless landscape around the road. Corridor: half width (from the centre line) owned by the
   * chunk ribbons; the landscape tiles sink under it. Heights blend from the road terrain to the
   * free landscape between blendNear and blendFar (m from the centre line).
   */
  world: {
    corridor: 140,
    blendNear: 500,
    blendFar: 1400,
    mountains: 340,
    /** Landscape tile LOD: tile size of level 0 (×2 per level), levels, grid segments per level. */
    tile: 256,
    levels: 4,
    segments: [32, 32, 16, 16] as const,
    /** Skirt depth per level (hides cracks between levels), m. */
    skirt: [10, 20, 40, 80] as const,
    /** Tile trees: jittered grid cell per level (only levels 0-1 carry trees). */
    treeCell: [18, 30] as const,
    /** Tiles kept parked after leaving the view (rebuilt from the cache when coming back). */
    cache: 24,
    /** Build time per frame, ms: road chunks and landscape tiles share the frame. */
    roadBudget: 4,
    worldBudget: 2.5,
    /** Low-cost road strip drawn beyond the loaded chunks (no collision), m ahead / behind. */
    farRoad: { ahead: 4200, behind: 2400, step: 25 },
  },
  /** Lateral distance at which the car is brought back to the road. */
  boundary: 260,
  spawn: { s: 600, lane: 1 },
  fog: { near: 380, far: 2600 },
} as const;
