import type { TrackId } from '../config/tracks';
import { decimatePath } from '../ui/map/MapData';
import { STRAIGHT_LENGTH, TRACK_WIDTH, TURN_RADIUS, stadiumLine } from './TestTrack';
import nordschleifeData from './tracks/nordschleife.json';

/** What the map selection screen shows for a track, without building it. */
export interface TrackInfo {
  id: TrackId;
  name: string;
  type: string;
  environment: string;
  description: string;
  /** Lap length, m. */
  length: number;
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
    type: 'Gerçek pist',
    environment: 'Orman · Eifel dağları',
    description: 'Yeşil Cehennem: dar, inişli çıkışlı, kör virajlarla dolu efsanevi tur.',
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
  type: 'Geliştirme / Test',
  environment: 'Düz test alanı',
  description: 'Handling ve araç test alanı: oval pist, skidpad, slalom, rampa ve çarpma duvarı.',
  length: Math.round(2 * STRAIGHT_LENGTH + 2 * Math.PI * TURN_RADIUS),
  elevation: 0,
  corners: 0,
  outline: stadiumLine(TURN_RADIUS),
  closed: true,
  width: TRACK_WIDTH,
};

/** Selectable tracks in menu order. Stats are read from the track data, not typed in. */
export const TRACK_CATALOG: readonly TrackInfo[] = [TEST_INFO, nordschleifeInfo()];

export function trackInfo(id: string): TrackInfo | undefined {
  return TRACK_CATALOG.find((t) => t.id === id);
}
