/**
 * City V2 road cross-sections, shared by the layout and ground generators
 * (scripts/lib/cityV2) and the game (lanes, on-road tests). The hierarchy:
 *
 *   arterial3  3+3 lanes and a 4 m median: the one or two main axes of town   25 m kerb to kerb
 *   boulevard  2+2 lanes and a 3 m median: other main boulevards, the ring    17 m
 *   avenue     2+2 lanes, no median: the main streets of a district           13 m
 *   street     1+1 lanes: ordinary streets                                     7 m
 *   alley      a narrow lane, no sidewalks                                     5 m
 *
 * Sidewalks are the blocks' own (their district sets the width), so a street
 * between two districts may have two different sidewalks. Every width is a
 * multiple of 0.5 m: the ground raster resolution.
 */

export type RoadClass = 'arterial3' | 'boulevard' | 'avenue' | 'street' | 'alley';
export const ROAD_CLASSES: readonly RoadClass[] = ['arterial3', 'boulevard', 'avenue', 'street', 'alley'];

export interface RoadProfile {
  /** Lanes each way. */
  lanes: number;
  /** Lane width, m. */
  lane: number;
  /** Raised median between the two directions, m (0: none). */
  median: number;
  /** Whether blocks along it have a sidewalk on this side. */
  sidewalk: boolean;
}

export const ROAD_PROFILE: Record<RoadClass, RoadProfile> = {
  arterial3: { lanes: 3, lane: 3.5, median: 4, sidewalk: true },
  boulevard: { lanes: 2, lane: 3.5, median: 3, sidewalk: true },
  avenue: { lanes: 2, lane: 3.25, median: 0, sidewalk: true },
  street: { lanes: 1, lane: 3.5, median: 0, sidewalk: true },
  alley: { lanes: 1, lane: 2.5, median: 0, sidewalk: false },
};

/** Centre line to the kerb (asphalt edge), m: lanes plus half the median. */
export function kerbOffset(c: RoadClass): number {
  const p = ROAD_PROFILE[c];
  return p.median / 2 + p.lanes * p.lane;
}

/** Centre line to the median's kerb, m (0 without a median). */
export function medianHalf(c: RoadClass): number {
  return ROAD_PROFILE[c].median / 2;
}

/** Lane centres right of the centre line, m (right-hand traffic, innermost first). */
export function laneOffsets(c: RoadClass): number[] {
  const p = ROAD_PROFILE[c];
  return Array.from({ length: p.lanes }, (_, k) => p.median / 2 + p.lane * (k + 0.5));
}

/** Sidewalk width per district, m. */
export const SIDEWALK: Record<'downtown' | 'commercial' | 'residential' | 'industrial', number> = {
  downtown: 4,
  commercial: 3.5,
  residential: 2.5,
  industrial: 2.5,
};

/** The widest sidewalk: the layout keeps blocks deep enough for it whatever district they end up in. */
export const SIDEWALK_MAX = 4;
