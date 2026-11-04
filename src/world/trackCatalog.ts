import type { TrackId } from '../config/tracks';
import { decimatePath } from '../ui/map/MapData';
import { STRAIGHT_LENGTH, TRACK_WIDTH, TURN_RADIUS, stadiumLine } from './TestTrack';
import nordschleifeData from './tracks/nordschleife.json';
import { AUTOBAHN } from '../config/tracks';
import { RoadGenerator } from './autobahn/RoadGenerator';
import cityV2Info from './tracks/city-v2-info.json';

/** What the map selection screen shows for a track, without building it. */
export interface TrackInfo {
  id: TrackId;
  name: string;
  type: string;
  environment: string;
  description: string;
  /** Lap length, m (Infinity: endless / generated). */
  length: number;
  /** Short badges for the card (Procedural, 3+3 şerit…). */
  tags?: readonly string[];
  /** Highest minus lowest point, m (0 when flat). */
  elevation: number;
  /** Named corners in the source data (0 when none). */
  corners: number;
  /** Plan-view outline (x, z pairs) for the card thumbnail. */
  outline: Float32Array;
  closed: boolean;
  width: number;
}

function nordschleifeInfo(): TrackInfo {
  const pts = nordschleifeData.points;
  let lo = Infinity;
  let hi = -Infinity;
  const xz = new Float32Array(pts.length * 2);
  pts.forEach((p, i) => {
    lo = Math.min(lo, p[1]);
    hi = Math.max(hi, p[1]);
    xz[i * 2] = p[0];
    xz[i * 2 + 1] = p[2];
  });
  return {
    id: 'nordschleife',
    name: nordschleifeData.name,
    type: 'Real circuit',
    environment: 'Forest · Eifel mountains',
    description: 'The Green Hell: a legendary lap of narrow, undulating roads packed with blind corners.',
    length: nordschleifeData.length,
    elevation: Math.round(hi - lo),
    corners: nordschleifeData.corners.length,
    outline: decimatePath(xz, 40),
    closed: true,
    width: 10,
  };
}

const TEST_INFO: TrackInfo = {
  id: 'test',
  name: 'Test Track',
  type: 'Development / Test',
  environment: 'Flat test area',
  description: 'Handling and vehicle test area: oval circuit, skidpad, slalom, ramp and crash barrier.',
  length: Math.round(2 * STRAIGHT_LENGTH + 2 * Math.PI * TURN_RADIUS),
  elevation: 0,
  corners: 0,
  outline: stadiumLine(TURN_RADIUS),
  closed: true,
  width: TRACK_WIDTH,
};

/** The Autobahn is endless; the card shows the first 15 km of the default seed. */
function autobahnInfo(): TrackInfo {
  const gen = new RoadGenerator(AUTOBAHN.seed);
  const pts: number[] = [];
  const f = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
  for (let s = 0; s <= 15000; s += 100) {
    gen.frame(s, f);
    pts.push(f.x, f.z);
  }
  return {
    id: 'autobahn',
    name: 'Autobahn',
    type: 'High speed / Open road',
    environment: 'Forest · open terrain · hills',
    description: 'Procedural Autobahn with long straights, fast sweepers, tunnels and bridges for high-speed driving.',
    length: Infinity,
    elevation: 0,
    corners: 0,
    tags: ['Procedural', '3+3 lanes', 'High speed', 'Dynamic length'],
    outline: new Float32Array(pts),
    closed: false,
    width: 34,
  };
}

/** The city: summary written by scripts/prepare-city-v2.ts (the outline is the ring road). */
function cityTrackInfo(): TrackInfo {
  const km = (cityV2Info.size / 1000).toFixed(cityV2Info.size % 1000 ? 1 : 0);
  return {
    id: 'city',
    name: 'City',
    type: 'Open-world city',
    environment: `${km} × ${km} km · ${cityV2Info.blocks} blocks · ${cityV2Info.roadKm} km of roads`,
    description: 'Downtown, shopping streets, residential and industrial districts; with traffic lights, city traffic and parked cars.',
    length: Infinity,
    elevation: 0,
    corners: cityV2Info.junctions,
    tags: ['Open world', 'City', 'Traffic', 'CC0'],
    outline: new Float32Array(cityV2Info.outline),
    closed: true,
    width: 18,
  };
}

/** Selectable tracks in menu order. Stats are read from the track data, not typed in. */
export const TRACK_CATALOG: readonly TrackInfo[] = [TEST_INFO, nordschleifeInfo(), autobahnInfo(), cityTrackInfo()];

export function trackInfo(id: string): TrackInfo | undefined {
  return TRACK_CATALOG.find((t) => t.id === id);
}
