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
    type: 'Yüksek hız / Açık yol',
    environment: 'Orman · açık arazi · tepeler',
    description: 'Uzun düzlükler, hızlı virajlar, tüneller ve yüksek hızlı sürüş için procedural Autobahn.',
    length: Infinity,
    elevation: 0,
    corners: 0,
    tags: ['Procedural', '3+3 şerit', 'Yüksek hız', 'Dinamik uzunluk'],
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
    name: 'Şehir',
    type: 'Açık dünya şehir',
    environment: `${km} × ${km} km · ${cityV2Info.blocks} blok · ${cityV2Info.roadKm} km yol`,
    description: 'Downtown, alışveriş caddeleri, yerleşim ve sanayi bölgeleri; trafik ışıkları, şehir trafiği ve park etmiş arabalarla.',
    length: Infinity,
    elevation: 0,
    corners: cityV2Info.junctions,
    tags: ['Açık dünya', 'Şehir', 'Trafik', 'CC0'],
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
