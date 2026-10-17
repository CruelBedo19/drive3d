/**
 * Builds src/world/tracks/nordschleife.json: the Nordschleife centre line as
 * local metres (x = east, y = up, z = south), with corner names.
 *
 * Sources (cached under scripts/data/ so re-runs are offline and deterministic):
 *  - Geometry: OpenStreetMap route relation 38566 "Nürburgring Nordschleife",
 *    © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright).
 *  - Elevation: SRTM 30 m via the OpenTopoData public API (public domain data).
 *
 * `npm run build:track` (add `--refresh` to download the sources again).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'scripts/data');
const OSM_CACHE = join(DATA_DIR, 'nordschleife-osm.json');
const ELEVATION_CACHE = join(DATA_DIR, 'nordschleife-elevation.json');
const OUTPUT = join(ROOT, 'src/world/tracks/nordschleife.json');

const RELATION_ID = 38566;
/** The lap starts where the public Touristenfahrten lap does: the T13 straight. */
const START_WAY_NAME = 'T13';
const USER_AGENT = 'drive3d-track-builder/0.1';
const EARTH_RADIUS = 6371008.8;

/** Working resolution, plan-view smoothing (removes OSM polygon corners), output spacing. */
const FINE_STEP = 2;
const XZ_SMOOTH_SIGMA = 7;
const OUTPUT_STEP = 8;
/** Elevation: DEM sample spacing and smoothing (SRTM is noisy under trees). */
const ELEVATION_STEP = 30;
const ELEVATION_SMOOTH_SIGMA = 70;

interface LatLon {
  lat: number;
  lon: number;
}
interface OsmWay {
  type: 'way';
  id: number;
  tags?: Record<string, string>;
  geometry: LatLon[];
}
interface OsmRelation {
  type: 'relation';
  id: number;
  members: { type: string; ref: number; role: string }[];
}
type OsmElement = OsmWay | OsmRelation;

const refresh = process.argv.includes('--refresh');

async function main(): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });
  const osm = await loadOsm();

  // 1. Chain the relation's ways into one closed loop, remembering where each named way starts.
  const relation = osm.find((e): e is OsmRelation => e.type === 'relation' && e.id === RELATION_ID);
  if (!relation) throw new Error(`relation ${RELATION_ID} missing from OSM data`);
  const ways = new Map(osm.filter((e): e is OsmWay => e.type === 'way').map((w) => [w.id, w]));
  const loop: LatLon[] = [];
  const marks: { name: string; index: number }[] = [];
  for (const member of relation.members) {
    if (member.type !== 'way') continue;
    const way = ways.get(member.ref);
    if (!way) throw new Error(`way ${member.ref} missing from OSM data`);
    let geom = way.geometry;
    if (loop.length) {
      const end = loop[loop.length - 1];
      if (same(end, geom[geom.length - 1])) geom = [...geom].reverse();
      else if (!same(end, geom[0])) throw new Error(`gap before way ${way.id}`);
      geom = geom.slice(1);
    }
    const name = way.tags?.name;
    if (name && !marks.some((m) => m.name === name)) marks.push({ name, index: loop.length });
    loop.push(...geom);
  }
  if (!same(loop[0], loop[loop.length - 1])) throw new Error('relation does not form a closed loop');
  loop.pop();

  // 2. Start the lap at the start of the T13 way.
  const start = marks.find((m) => m.name === START_WAY_NAME);
  if (!start) throw new Error(`no way named ${START_WAY_NAME}`);
  const rotated = [...loop.slice(start.index), ...loop.slice(0, start.index)];
  const markIndex = (i: number) => (i - start.index + loop.length) % loop.length;

  // 3. Project to local metres around the start, resample finely, smooth the plan view.
  const origin = rotated[0];
  const cosLat = Math.cos(rad(origin.lat));
  const toLocal = (p: LatLon): [number, number] => [rad(p.lon - origin.lon) * cosLat * EARTH_RADIUS, -rad(p.lat - origin.lat) * EARTH_RADIUS];
  const toLatLon = (x: number, z: number): LatLon => ({ lat: origin.lat - deg(z / EARTH_RADIUS), lon: origin.lon + deg(x / (EARTH_RADIUS * cosLat)) });
  const raw = rotated.map(toLocal);
  const rawMarks = marks.map((m) => ({ name: m.name, at: raw[markIndex(m.index)] }));

  const fine = resampleClosed(raw, FINE_STEP);
  const smoothed = smoothClosed(fine, XZ_SMOOTH_SIGMA / FINE_STEP);
  const plan = resampleClosed(smoothed, OUTPUT_STEP);
  const length = closedLength(plan);

  // 4. Elevation along the smoothed line, interpolated and smoothed again, start = 0.
  const elevPoints = resampleClosed(smoothed, ELEVATION_STEP);
  const elevations = await loadElevations(elevPoints.map(([x, z]) => toLatLon(x, z)));
  const elevFine = interpolateClosed(elevations, plan.length);
  const elevSmooth = smoothScalarClosed(elevFine, ELEVATION_SMOOTH_SIGMA / OUTPUT_STEP);
  const y0 = elevSmooth[0];

  const points = plan.map(([x, z], i) => [round(x), round(elevSmooth[i] - y0), round(z)]);

  // 5. Corner names: nearest output point to where each named way starts.
  const cumulative = cumulativeDistances(plan);
  const corners = rawMarks
    .map((m) => {
      let best = 0;
      let bestD = Infinity;
      plan.forEach(([x, z], i) => {
        const d = (x - m.at[0]) ** 2 + (z - m.at[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      return { name: m.name, distance: Math.round(cumulative[best]) };
    })
    .sort((a, b) => a.distance - b.distance);

  const ys = points.map((p) => p[1]);
  const grades = points.map((p, i) => {
    const q = points[(i + 1) % points.length];
    return Math.abs(q[1] - p[1]) / Math.hypot(q[0] - p[0], q[2] - p[2]);
  });
  const out = {
    name: 'Nürburgring Nordschleife',
    closed: true,
    length: Math.round(length),
    spacing: OUTPUT_STEP,
    points,
    corners,
    source: {
      geometry: `OpenStreetMap relation ${RELATION_ID} (https://www.openstreetmap.org/relation/${RELATION_ID})`,
      geometryLicense: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
      elevation: 'SRTM 30 m via OpenTopoData (https://www.opentopodata.org), public domain',
      origin,
    },
  };
  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, JSON.stringify(out));
  console.log(
    `wrote ${OUTPUT}: ${points.length} points, ${(length / 1000).toFixed(2)} km, elevation ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)} m, max grade ${(Math.max(...grades) * 100).toFixed(1)} %, ${corners.length} corners`,
  );
}

async function loadOsm(): Promise<OsmElement[]> {
  if (!refresh && existsSync(OSM_CACHE)) return (JSON.parse(readFileSync(OSM_CACHE, 'utf8')) as { elements: OsmElement[] }).elements;
  const query = `[out:json][timeout:120];rel(${RELATION_ID});out body;way(r);out geom tags;`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    const text = await res.text();
    if (res.ok && text.startsWith('{')) {
      writeFileSync(OSM_CACHE, text);
      return (JSON.parse(text) as { elements: OsmElement[] }).elements;
    }
    console.log(`Overpass busy (${res.status}), retry ${attempt}`);
    await sleep(attempt * 10_000);
  }
  throw new Error('Overpass API unavailable');
}

async function loadElevations(points: LatLon[]): Promise<number[]> {
  if (!refresh && existsSync(ELEVATION_CACHE)) {
    const cached = JSON.parse(readFileSync(ELEVATION_CACHE, 'utf8')) as { points: number; elevations: number[] };
    if (cached.points === points.length) return cached.elevations;
  }
  const elevations: number[] = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const locations = batch.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
    const res = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${locations}`, { headers: { 'User-Agent': USER_AGENT } });
    const body = (await res.json()) as { status: string; results?: { elevation: number | null }[] };
    if (body.status !== 'OK' || !body.results) throw new Error(`OpenTopoData: ${body.status}`);
    for (const r of body.results) {
      if (r.elevation === null) throw new Error('OpenTopoData returned no elevation');
      elevations.push(r.elevation);
    }
    await sleep(1100); // public API: 1 request per second
  }
  writeFileSync(ELEVATION_CACHE, JSON.stringify({ points: points.length, elevations }));
  return elevations;
}

// --- Closed polyline helpers --------------------------------------------------

type P2 = [number, number];

function cumulativeDistances(pts: P2[]): number[] {
  const out = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return out;
}

function closedLength(pts: P2[]): number {
  const last = pts[pts.length - 1];
  return cumulativeDistances(pts)[pts.length - 1] + Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]);
}

/** Evenly spaced points along a closed polyline (the closing segment included). */
function resampleClosed(pts: P2[], step: number): P2[] {
  const ring = [...pts, pts[0]];
  const cum = cumulativeDistances(ring);
  const total = cum[cum.length - 1];
  const n = Math.round(total / step);
  const out: P2[] = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (cum[seg + 1] < d) seg++;
    const t = (d - cum[seg]) / Math.max(1e-9, cum[seg + 1] - cum[seg]);
    out.push([ring[seg][0] + (ring[seg + 1][0] - ring[seg][0]) * t, ring[seg][1] + (ring[seg + 1][1] - ring[seg][1]) * t]);
  }
  return out;
}

function gaussianKernel(sigma: number): number[] {
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const sum = k.reduce((a, b) => a + b, 0);
  return k.map((v) => v / sum);
}

function smoothClosed(pts: P2[], sigma: number): P2[] {
  const xs = smoothScalarClosed(pts.map((p) => p[0]), sigma);
  const zs = smoothScalarClosed(pts.map((p) => p[1]), sigma);
  return xs.map((x, i) => [x, zs[i]]);
}

function smoothScalarClosed(values: number[], sigma: number): number[] {
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const n = values.length;
  return values.map((_, i) => {
    let s = 0;
    for (let j = -r; j <= r; j++) s += values[(i + j + n) % n] * k[j + r];
    return s;
  });
}

/** Linear interpolation of an evenly spaced closed series onto `n` evenly spaced samples. */
function interpolateClosed(values: number[], n: number): number[] {
  const m = values.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const f = (i / n) * m;
    const a = Math.floor(f);
    const t = f - a;
    out.push(values[a % m] * (1 - t) + values[(a + 1) % m] * t);
  }
  return out;
}

const same = (a: LatLon, b: LatLon) => a.lat === b.lat && a.lon === b.lon;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;
const round = (v: number) => Math.round(v * 100) / 100;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
