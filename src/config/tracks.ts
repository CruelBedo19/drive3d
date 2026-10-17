/** Selectable driving worlds (`?track=`). */
export type TrackId = 'test' | 'nordschleife';

export const TRACK_IDS: readonly TrackId[] = ['test', 'nordschleife'];
export const DEFAULT_TRACK: TrackId = 'test';

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
