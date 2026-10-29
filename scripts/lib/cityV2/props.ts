/**
 * City V2 street props (A4): where every lamp, tree, sign and bench goes.
 * A pure function of (layout, ground raster, buildings, seed): the same seed
 * always gives the same props.
 *
 * Everything is checked against the ground raster (ground.ts): a sidewalk prop
 * stands on sidewalk cells, a park prop on park cells, and so on, so nothing
 * ends up on the asphalt, in a kerb corner or on another block. Props keep
 * apart by their footprint radius (a spatial hash), yard plants keep off the
 * building footprints, and anything tall or bushy keeps clear of the junction
 * boxes (the view into a crossing stays open).
 *
 * Order (earlier props win a contested spot): traffic signals and signs at
 * junctions, bus stops, lamps, street trees, furniture, then the special
 * parcels (parking, park, industrial yards, the reserved parcels), medians,
 * front yards, and manholes / drains on the asphalt.
 *
 * District rules (DISTRICT_RULES): downtown is dense and ordered (tree pits,
 * benches, bins, bollards, planters, bike racks, bus stops), commercial a bit
 * sparser (planters, bus stops, parking), residential green (verges, trees,
 * yard bushes, few furniture), industrial sparse and functional (floodlights,
 * fences, containers, barriers, utility boxes; few trees).
 */
import { PROPS, PROP_CHUNK, PROP_INDEX, PROP_STRIDE, SIGNAL_HEADS, type CityV2PropsJson, type JunctionControl, type PropCategory, type PropJunction, type PropKitPiece, type PropParkingLot, type PropSignal } from '../../../src/world/cityv2/propKit';
import { ROAD_PROFILE, kerbOffset, laneOffsets, medianHalf, type RoadClass } from '../../../src/world/cityv2/roadProfiles';
import { valueNoise } from '../../../src/world/autobahn/noise';
import { CELL, LEVEL, RASTER, isJunction, junctionHalf, medianRects, type GroundRaster } from './ground';
import type { Kit } from './kit';
import { polygonArea, type CityLayout, type District, type LayoutBlock } from './layout';
import { hashUnit, stream, streamSeed } from './rng';
import { parcelCore } from './buildings';

export interface PropInstance {
  proto: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  variant: number;
  /** Who it belongs to, for the counts: a district, and the parcel use if any. */
  district: District;
  parcel?: string;
}

export interface PlacedProps {
  instances: PropInstance[];
  /** Parking spots: x, z, yaw, lot index (4 floats each). */
  spots: number[];
  lots: PropParkingLot[];
  junctions: PropJunction[];
  signals: PropSignal[];
  reserved: CityV2PropsJson['reserved'];
  /** Signals and signs that found no place (position, reason). */
  skipped: { id: string; x: number; z: number; why: string }[];
}

/** Per district: spacing (m) and chances that set its look. */
interface DistrictRule {
  /** Street trees: chance a sidewalk side gets them, spacing along it, sizes to pick from. */
  treeSide: number;
  treeSpacing: number;
  trees: string[];
  /** Tree pits under street trees (paved sidewalks). */
  pits: boolean;
  /** Grass verge along the kerb (residential streets). */
  verge: number;
  /** Chances per 9 m furniture slot. */
  bench: number;
  bin: number;
  planter: number;
  bikeRack: number;
  /** One hydrant / utility box per this many m of sidewalk. */
  hydrantEvery: number;
  utilityEvery: number;
  /** Bollard rows at the ends of main-street sides. */
  bollards: number;
  busStops: boolean;
  /** Front yard plants per 7 m lot sample (residential). */
  yard: number;
  lampScale: number;
}

const DISTRICT_RULES: Record<District, DistrictRule> = {
  downtown: { treeSide: 0.7, treeSpacing: 14, trees: ['tree_small', 'tree_medium'], pits: true, verge: 0, bench: 0.2, bin: 0.16, planter: 0.1, bikeRack: 0.07, hydrantEvery: 80, utilityEvery: 160, bollards: 0.65, busStops: true, yard: 0, lampScale: 0.8 },
  commercial: { treeSide: 0.42, treeSpacing: 20, trees: ['tree_small', 'tree_medium'], pits: true, verge: 0, bench: 0.06, bin: 0.07, planter: 0.06, bikeRack: 0.02, hydrantEvery: 110, utilityEvery: 140, bollards: 0.2, busStops: true, yard: 0, lampScale: 1.1 },
  residential: { treeSide: 0.85, treeSpacing: 13, trees: ['tree_small', 'tree_medium', 'tree_medium', 'tree_large'], pits: false, verge: 0.75, bench: 0.012, bin: 0.01, planter: 0, bikeRack: 0, hydrantEvery: 120, utilityEvery: 130, bollards: 0, busStops: false, yard: 0.45, lampScale: 1.2 },
  industrial: { treeSide: 0.06, treeSpacing: 24, trees: ['tree_small'], pits: false, verge: 0, bench: 0, bin: 0.004, planter: 0, bikeRack: 0, hydrantEvery: 140, utilityEvery: 90, bollards: 0, busStops: false, yard: 0, lampScale: 1.4 },
};

/** Lamp spacing along a sidewalk by road class (m; 0: none), and which lamp. Divided arterials are lit from the median. */
const LAMPS: Record<RoadClass, { spacing: number; proto: string; bothSides: boolean }> = {
  arterial3: { spacing: 0, proto: 'lamp_arterial', bothSides: false },
  boulevard: { spacing: 36, proto: 'lamp_arterial', bothSides: true },
  avenue: { spacing: 34, proto: 'lamp_street', bothSides: true },
  street: { spacing: 36, proto: 'lamp_street', bothSides: false },
  alley: { spacing: 0, proto: 'lamp_street', bothSides: false },
};
const MEDIAN_LAMP_SPACING = 38;
/** Clear of the junction box for anything tall or bushy, m beyond the widest kerb there. */
const JUNCTION_CLEAR = 9;
/** Sidewalk sides start and end this far from the kerb corners (rounded corner, zebra crossing), m beyond the sidewalk width. */
const CORNER_SKIP = 4;
const BUS_STOP_GAP = 260;
/** Props that hide the view into a junction (kept JUNCTION_CLEAR away from it). */
const TALL = new Set<PropCategory>(['tree', 'bush', 'planter', 'busstop', 'container', 'fence', 'utility']);

type P2 = [number, number];
const RAISED = LEVEL.raised;

interface Side {
  block: LayoutBlock;
  i: number;
  cls: RoadClass;
  k0: P2;
  t: P2;
  /** Outward (towards the street). */
  n: P2;
  len: number;
  w: number;
}

export function placeProps(l: CityLayout, raster: GroundRaster, buildings: { rect: [number, number, number, number] }[], seed: number): PlacedProps {
  const out: PlacedProps = { instances: [], spots: [], lots: [], junctions: [], signals: [], reserved: [], skipped: [] };
  const R = raster;
  const labelAt = (x: number, z: number): number => {
    const i = Math.floor((x - R.minX) / R.res);
    const j = Math.floor((z - R.minZ) / R.res);
    return i < 0 || j < 0 || i >= R.W || j >= R.H ? RASTER.NONE : R.lab[j * R.W + i];
  };
  /** All of a footprint (centre and a ring at `r`) on one of the labels. */
  const onLabels = (x: number, z: number, r: number, labels: readonly number[]): boolean => {
    if (!labels.includes(labelAt(x, z))) return false;
    if (r <= 0) return true;
    for (let a = 0; a < 8; a++) {
      const ang = (a / 8) * Math.PI * 2;
      if (!labels.includes(labelAt(x + Math.cos(ang) * r, z + Math.sin(ang) * r))) return false;
    }
    return true;
  };

  // --- spatial hashes: placed footprints, buildings, junctions ---------------------------------------
  const OCC = 8;
  const occ = new Map<string, number[]>();
  const occKey = (i: number, j: number) => `${i},${j}`;
  const free = (x: number, z: number, r: number): boolean => {
    if (r <= 0) return true;
    const i0 = Math.floor((x - r - 4) / OCC);
    const i1 = Math.floor((x + r + 4) / OCC);
    const j0 = Math.floor((z - r - 4) / OCC);
    const j1 = Math.floor((z + r + 4) / OCC);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = occ.get(occKey(i, j));
      if (!list) continue;
      for (let k = 0; k < list.length; k += 3) if (Math.hypot(list[k] - x, list[k + 1] - z) < r + list[k + 2]) return false;
    }
    return true;
  };
  const claim = (x: number, z: number, r: number) => {
    if (r <= 0) return;
    const key = occKey(Math.floor(x / OCC), Math.floor(z / OCC));
    let list = occ.get(key);
    if (!list) occ.set(key, (list = []));
    list.push(x, z, r);
  };
  const BB = 40;
  const bBins = new Map<string, number[]>();
  buildings.forEach((b, idx) => {
    const [x0, z0, x1, z1] = b.rect;
    for (let i = Math.floor(x0 / BB); i <= Math.floor(x1 / BB); i++) for (let j = Math.floor(z0 / BB); j <= Math.floor(z1 / BB); j++) {
      const key = `${i},${j}`;
      let list = bBins.get(key);
      if (!list) bBins.set(key, (list = []));
      list.push(idx);
    }
  });
  /** Distance from a point to the nearest building footprint (up to ~40 m; Infinity if none near). */
  const buildingGap = (x: number, z: number): number => {
    let best = Infinity;
    for (let i = Math.floor(x / BB) - 1; i <= Math.floor(x / BB) + 1; i++) for (let j = Math.floor(z / BB) - 1; j <= Math.floor(z / BB) + 1; j++) {
      for (const idx of bBins.get(`${i},${j}`) ?? []) {
        const [x0, z0, x1, z1] = buildings[idx].rect;
        best = Math.min(best, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)));
      }
    }
    return best;
  };
  const junctionNodes = l.nodes.filter((n) => isJunction(l, n.id));
  const JB = 60;
  const jBins = new Map<string, number[]>();
  const junctionReach = new Map<number, number>();
  for (const n of junctionNodes) {
    let w = 0;
    for (const e of n.out) if (e >= 0) w = Math.max(w, kerbOffset(l.edges[e].cls));
    junctionReach.set(n.id, w + JUNCTION_CLEAR);
    const key = `${Math.floor(n.x / JB)},${Math.floor(n.z / JB)}`;
    let list = jBins.get(key);
    if (!list) jBins.set(key, (list = []));
    list.push(n.id);
  }
  /** Outside every junction's clear zone (square around the box: the sight lines along both roads). */
  const clearOfJunctions = (x: number, z: number, r: number): boolean => {
    for (let i = Math.floor(x / JB) - 1; i <= Math.floor(x / JB) + 1; i++) for (let j = Math.floor(z / JB) - 1; j <= Math.floor(z / JB) + 1; j++) {
      for (const id of jBins.get(`${i},${j}`) ?? []) {
        const n = l.nodes[id];
        const reach = junctionReach.get(id)! + r;
        if (Math.abs(n.x - x) < reach && Math.abs(n.z - z) < reach) return false;
      }
    }
    return true;
  };

  // --- districts of nodes (blocks around them) ---------------------------------------------------------
  const nodeDistricts = new Map<string, District[]>();
  for (const b of l.blocks) for (const [x, z] of b.centre) {
    const key = `${x},${z}`;
    let list = nodeDistricts.get(key);
    if (!list) nodeDistricts.set(key, (list = []));
    list.push(b.district);
  }
  const districtOfNode = (x: number, z: number): District => {
    const list = nodeDistricts.get(`${x},${z}`) ?? ['residential'];
    const order: District[] = ['downtown', 'commercial', 'industrial', 'residential'];
    // The busiest district around it wins (a junction on the edge of downtown looks downtown).
    for (const d of order) if (list.includes(d)) return d;
    return 'residential';
  };

  // --- adding props -------------------------------------------------------------------------------------
  const add = (id: string, x: number, y: number, z: number, yaw: number, district: District, o: { s?: [number, number, number]; variant?: number; parcel?: string } = {}): PropInstance => {
    const proto = PROP_INDEX[id];
    if (proto === undefined) throw new Error(`Unknown prop ${id}`);
    const [sx, sy, sz] = o.s ?? [1, 1, 1];
    const inst: PropInstance = { proto, x, y, z, yaw, sx, sy, sz, variant: o.variant ?? 0, district, parcel: o.parcel };
    out.instances.push(inst);
    claim(x, z, PROPS[proto].radius * Math.max(sx, sz));
    return inst;
  };
  /** Adds a prop if its footprint is on the labels, free, and (tall ones) clear of junctions. */
  const tryAdd = (id: string, x: number, z: number, yaw: number, district: District, labels: readonly number[], o: { s?: [number, number, number]; variant?: number; parcel?: string; y?: number; pad?: number } = {}): PropInstance | null => {
    const def = PROPS[PROP_INDEX[id]];
    const r = def.radius * Math.max(o.s?.[0] ?? 1, o.s?.[2] ?? 1);
    // Poles need only their own few centimetres of sidewalk (a junction pole may stand close to a kerb corner).
    const foot = def.category === 'signal' || def.category === 'sign' || def.category === 'lamp' ? 0.25 : Math.min(r, 0.6) * 0.8;
    const why = !onLabels(x, z, foot, labels) ? `ground ${labelAt(x, z)}` : buildingGap(x, z) < foot ? 'building' : !free(x, z, r + (o.pad ?? 0)) ? 'taken' : TALL.has(def.category) && !clearOfJunctions(x, z, def.category === 'tree' ? 1 : 0) ? 'junction' : '';
    if (why) {
      // Junction furniture left out is reported (better missing than wrong).
      if (def.category === 'signal' || def.category === 'sign') out.skipped.push({ id, x, z, why });
      return null;
    }
    return add(id, x, o.y ?? RAISED, z, yaw, district, o);
  };
  const yawOf = (dx: number, dz: number) => Math.atan2(dx, dz);

  // --- sidewalk sides --------------------------------------------------------------------------------
  const sides: Side[] = [];
  for (const b of l.blocks) {
    const n = b.kerb.length;
    for (let i = 0; i < n; i++) {
      const cls = b.sides[i];
      if (!ROAD_PROFILE[cls].sidewalk) continue;
      const k0 = b.kerb[i];
      const k1 = b.kerb[(i + 1) % n];
      const len = Math.hypot(k1[0] - k0[0], k1[1] - k0[1]);
      if (len < 1) continue;
      const t: P2 = [(k1[0] - k0[0]) / len, (k1[1] - k0[1]) / len];
      const d: P2 = [k0[0] - b.lot[i][0], k0[1] - b.lot[i][1]];
      const along = d[0] * t[0] + d[1] * t[1];
      const nx = d[0] - along * t[0];
      const nz = d[1] - along * t[1];
      const w = Math.hypot(nx, nz);
      if (w < 1) continue;
      sides.push({ block: b, i, cls, k0, t, n: [nx / w, nz / w], len, w });
    }
  }
  const at = (s: Side, along: number, o: number): P2 => [s.k0[0] + s.t[0] * along - s.n[0] * o, s.k0[1] + s.t[1] * along - s.n[1] * o];
  const SW = [RASTER.SIDEWALK];
  /** Signal and sign poles: sidewalk, or the plaza's paving where it meets the junction. */
  const POLE = [RASTER.SIDEWALK, RASTER.PLAZA];
  /** Position along the street line in world terms (x for streets running along x): lines up spacing across blocks. */
  const lineCoord = (s: Side, along: number): number => {
    const p = at(s, along, 0);
    return Math.abs(s.t[0]) > 0.5 ? p[0] : p[1];
  };
  /** Along-side positions where the world coordinate hits phase + k·spacing. */
  const gridAlong = (s: Side, spacing: number, phase: number, from: number, to: number): number[] => {
    const c0 = lineCoord(s, 0);
    const dir = Math.abs(s.t[0]) > 0.5 ? s.t[0] : s.t[1];
    const res: number[] = [];
    const lo = Math.min(c0 + dir * from, c0 + dir * to);
    const hi = Math.max(c0 + dir * from, c0 + dir * to);
    for (let k = Math.ceil((lo - phase) / spacing); phase + k * spacing <= hi; k++) res.push((phase + k * spacing - c0) / dir);
    return res.sort((a, b) => a - b);
  };
  /** Street line key: the axis and the kerb line's coordinate across it (both sides of a street share the centre line). */
  const streetLine = (s: Side) => (Math.abs(s.t[0]) > 0.5 ? `z${Math.round(s.k0[1] + s.n[1] * kerbOffset(s.cls))}` : `x${Math.round(s.k0[0] + s.n[0] * kerbOffset(s.cls))}`);
  /** Which side of its street line a side is on (+1 / -1). */
  const sideSign = (s: Side) => Math.sign(Math.abs(s.t[0]) > 0.5 ? s.n[1] : s.n[0]);

  // --- junctions: signals, stop / yield, 30 zones, crossings ----------------------------------------------
  const rank: Record<RoadClass, number> = { arterial3: 4, boulevard: 3, avenue: 2, street: 1, alley: 0 };
  const edgeIndex = new Map<number, number>();
  l.edges.forEach((e, i) => edgeIndex.set(e.id, i));
  for (const n of junctionNodes) {
    const district = districtOfNode(n.x, n.z);
    const axisRank = [0, 0];
    const axisCls: (RoadClass | null)[] = [null, null];
    n.out.forEach((e, dir) => {
      if (e < 0) return;
      const r = rank[l.edges[e].cls];
      if (r >= axisRank[dir % 2]) {
        axisRank[dir % 2] = r;
        axisCls[dir % 2] = l.edges[e].cls;
      }
    });
    const hi = Math.max(...axisRank);
    const lo = Math.min(...axisRank);
    const signal = (lo >= 2 && hi >= 3) || (lo >= 2 && (district === 'downtown' || district === 'commercial'));
    const j: PropJunction = { id: n.id, x: n.x, z: n.z, kind: n.kind as 'cross' | 'tee', control: signal ? 'signal' : 'none', approaches: [] };
    n.out.forEach((eid, dir) => {
      if (eid < 0) return;
      const e = l.edges[eid];
      const other = l.nodes[e.a === n.id ? e.b : e.a];
      const len = Math.hypot(other.x - n.x, other.z - n.z);
      // Travel direction towards the junction, the driver's right.
      const t: P2 = [(n.x - other.x) / len, (n.z - other.z) / len];
      const r: P2 = [-t[1], t[0]];
      const jh = junctionHalf(l, n.id, e);
      const kerb = kerbOffset(e.cls);
      const mh = medianHalf(e.cls);
      const stopAt = jh + 4;
      const stop: P2 = [n.x - t[0] * stopAt + r[0] * (mh + kerb) / 2, n.z - t[1] * stopAt + r[1] * (mh + kerb) / 2];
      let control: JunctionControl = 'none';
      if (signal) control = 'signal';
      else if (rank[e.cls] < hi && rank[e.cls] <= 1) control = hi >= 3 ? 'stop' : 'yield';
      else if (rank[e.cls] === hi && hi > lo) control = 'priority';
      j.approaches.push({ edge: edgeIndex.get(eid)!, dir: t, control, stop, group: signal ? dir % 2 : -1 });
      const facing = yawOf(-t[0], -t[1]);
      const pole: P2 = [n.x - t[0] * (stopAt + 0.4) + r[0] * (kerb + 0.7), n.z - t[1] * (stopAt + 0.4) + r[1] * (kerb + 0.7)];
      if (control === 'signal') {
        // A mast arm over two or three lanes (the long one over the 3+3 arterials), a plain pole on narrower roads.
        const lanes = ROAD_PROFILE[e.cls].lanes;
        const id = lanes >= 3 ? 'signal_mast_long' : lanes >= 2 ? 'signal_mast' : 'signal_pole';
        if (tryAdd(id, pole[0], pole[1], facing, district, POLE)) {
          const c = Math.cos(facing);
          const sn = Math.sin(facing);
          const heads = SIGNAL_HEADS[id].map(([hx, hy, hz]): [number, number, number] => [pole[0] + c * hx + sn * hz, RAISED + hy, pole[1] - sn * hx + c * hz]);
          out.signals.push({ junction: n.id, edge: edgeIndex.get(eid)!, group: dir % 2, x: pole[0], z: pole[1], yaw: facing, heads });
        }
      } else if (control === 'stop' || control === 'yield') {
        tryAdd(control === 'stop' ? 'sign_stop' : 'sign_yield', pole[0], pole[1], facing, district, POLE);
      } else if (control === 'priority' && rank[e.cls] >= 2) {
        // Zebra crossing ahead on a main road through an unsignalled junction.
        const p: P2 = [n.x - t[0] * (stopAt + 8) + r[0] * (kerb + 0.6), n.z - t[1] * (stopAt + 8) + r[1] * (kerb + 0.6)];
        if (hashUnit(seed, `cross${n.id}:${dir}`) < 0.6) tryAdd('sign_crossing', p[0], p[1], facing, district, POLE);
      }
      // 30 zone: residential streets entered from a main road (sign facing the cars turning in).
      if (district === 'residential' && e.cls === 'street' && hi >= 2) {
        const leave: P2 = [-t[0], -t[1]];
        const rr: P2 = [-leave[1], leave[0]];
        const p: P2 = [n.x + leave[0] * (jh + 9) + rr[0] * (kerb + 0.6), n.z + leave[1] * (jh + 9) + rr[1] * (kerb + 0.6)];
        if (len > jh + 30) tryAdd('sign_speed30', p[0], p[1], yawOf(-leave[0], -leave[1]), district, SW);
      }
    });
    j.control = signal ? 'signal' : j.approaches.some((a) => a.control === 'stop') ? 'stop' : j.approaches.some((a) => a.control === 'yield') ? 'yield' : j.approaches.some((a) => a.control === 'priority') ? 'priority' : 'none';
    out.junctions.push(j);
  }

  // --- sidewalks: bus stops, lamps, trees, furniture ---------------------------------------------------
  const busStops: P2[] = [];
  const rng = stream(seed, 'props');
  for (const s of sides) {
    const d = s.block.district;
    const rule = DISTRICT_RULES[d];
    const from = s.w + CORNER_SKIP;
    const to = s.len - s.w - CORNER_SKIP;
    if (to - from < 4) continue;
    const special = s.block.kind === 'large';
    // Bus stop: middle of a long main-street side, far from other stops.
    if (rule.busStops && !special && rank[s.cls] >= 2 && to - from > 40 && s.w >= 3.5) {
      const mid = (from + to) / 2;
      const p = at(s, mid, 1.35);
      if (busStops.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > BUS_STOP_GAP) && hashUnit(seed, `bus${s.block.id}:${s.i}`) < 0.75) {
        if (tryAdd('bus_shelter', p[0], p[1], yawOf(s.n[0], s.n[1]), d, SW)) {
          busStops.push(p);
          const q = at(s, mid + 3.4, 0.6);
          tryAdd('bin', q[0], q[1], yawOf(s.n[0], s.n[1]), d, SW);
        }
      }
    }
    // Lamps on a grid along the street line (both sides staggered, or one side of a narrow street).
    // Downtown sidewalks along the divided arterials are lit too (besides the median lamps): the busiest streets.
    const lamp = s.cls === 'arterial3' && d === 'downtown' ? LAMPS.boulevard : LAMPS[s.cls];
    const line = streetLine(s);
    if (lamp.spacing > 0) {
      const spacing = lamp.spacing * (s.cls === 'street' || d === 'downtown' ? rule.lampScale : 1);
      const oneSide = hashUnit(seed, `lampside${line}`) < 0.5 ? 1 : -1;
      if (lamp.bothSides || sideSign(s) === oneSide) {
        const phase = hashUnit(seed, `lamp${line}`) * spacing + (sideSign(s) > 0 ? 0 : spacing / 2);
        const proto = d === 'industrial' ? 'lamp_flood' : d === 'residential' && s.cls === 'street' ? 'lamp_residential' : lamp.proto;
        for (const a of gridAlong(s, spacing, phase, from, to)) {
          const p = at(s, a, proto === 'lamp_flood' ? 0.6 : 0.5);
          tryAdd(proto, p[0], p[1], yawOf(s.n[0], s.n[1]), d, SW);
        }
      }
    }
    // Residential verge (grass strip along the kerb), under the street trees.
    if (rule.verge > 0 && s.cls === 'street' && !special && hashUnit(seed, `verge${s.block.id}:${s.i}`) < rule.verge) {
      // Pieces of ≤ 25 m: a chunk's extent (culling) stays its own.
      const vw = Math.min(1.2, s.w - 1.2);
      const len = to - from + 6;
      const pieces = Math.ceil(len / 25);
      for (let k = 0; k < pieces; k++) {
        const p = at(s, from - 3 + (len * (k + 0.5)) / pieces, vw / 2 + 0.05);
        add('verge', p[0], RAISED + 0.008, p[1], yawOf(s.t[0], s.t[1]), d, { s: [vw, 1, len / pieces + 0.01] });
      }
    }
    // Street trees between the lamps.
    if (!special && hashUnit(seed, `trees${s.block.id}:${s.i}`) < rule.treeSide && s.cls !== 'arterial3') {
      const spacing = rule.treeSpacing;
      const phase = hashUnit(seed, `tree${line}`) * spacing;
      for (const a of gridAlong(s, spacing, phase, from + 1, to - 1)) {
        const jitter = d === 'residential' ? rng.range(-2, 2) : 0;
        const p = at(s, a + jitter, Math.min(1.1, s.w * 0.4));
        const id = rule.trees[rng.int(0, rule.trees.length - 1)];
        // Sidewalk trees stay small enough not to hang far over the road.
        const scale = rng.range(0.85, 1.12);
        const inst = tryAdd(id, p[0], p[1], rng.range(0, Math.PI * 2), d, SW, { s: [scale, scale * rng.range(0.92, 1.1), scale], variant: rng.int(0, 3) });
        if (inst && rule.pits) add('tree_pit', p[0], RAISED + 0.006, p[1], yawOf(s.t[0], s.t[1]), d);
      }
    }
    // Furniture on 9 m slots, in the furniture zone next to the kerb; utility boxes against the lot line.
    for (let a = from + 2; a < to - 2; a += 9) {
      const roll = rng.next();
      const face = yawOf(-s.n[0], -s.n[1]);
      let acc = 0;
      const pick = (p: number) => roll >= acc && roll < (acc += p);
      if (pick(rule.bench)) {
        const p = at(s, a, 1.0);
        if (tryAdd('bench', p[0], p[1], face, d, SW)) {
          const q = at(s, a + 1.9, 0.55);
          if (rng.chance(0.6)) tryAdd('bin', q[0], q[1], face, d, SW);
        }
      } else if (pick(rule.bin)) {
        const p = at(s, a, 0.55);
        tryAdd('bin', p[0], p[1], face, d, SW);
      } else if (pick(s.w >= 3.5 ? rule.planter : 0)) {
        const p = at(s, a, 1.3);
        tryAdd(rng.chance(0.5) ? 'planter_long' : 'planter', p[0], p[1], yawOf(s.t[0], s.t[1]), d, SW, { s: s.w >= 4 ? [1, 1, 1] : [0.8, 1, 0.8] });
      } else if (pick(rule.bikeRack)) {
        const p = at(s, a, 1.0);
        tryAdd('bike_rack', p[0], p[1], yawOf(s.t[0], s.t[1]), d, SW);
      }
    }
    for (const a of gridAlong(s, rule.hydrantEvery, hashUnit(seed, `hyd${line}`) * rule.hydrantEvery, from, to)) {
      const p = at(s, a + 3, 0.45);
      tryAdd('hydrant', p[0], p[1], yawOf(s.n[0], s.n[1]), d, SW);
    }
    if (hashUnit(seed, `util${s.block.id}:${s.i}`) < (to - from) / rule.utilityEvery) {
      const p = at(s, from + (to - from) * hashUnit(seed, `utilpos${s.block.id}:${s.i}`), s.w - 0.45);
      tryAdd('utility_box', p[0], p[1], yawOf(s.n[0], s.n[1]), d, SW);
    }
    // Bollards: a short row at each end of main-street sides (downtown, commercial).
    if (rule.bollards > 0 && rank[s.cls] >= 2 && hashUnit(seed, `boll${s.block.id}:${s.i}`) < rule.bollards) {
      for (const base of [from - 1.5, to + 1.5]) for (let k = 0; k < 3; k++) {
        const p = at(s, base + (base < s.len / 2 ? -k : k) * 1.4, 0.4);
        tryAdd('bollard', p[0], p[1], 0, d, SW);
      }
    }
  }

  // --- the plaza (downtown) -----------------------------------------------------------------------------
  for (const b of l.blocks.filter((b) => b.kind === 'plaza')) {
    const PL = [RASTER.PLAZA];
    const [x0, z0, x1, z1] = bbox(b.lot);
    const r = stream(seed, `plaza${b.id}`);
    for (let x = x0 + 6; x <= x1 - 6; x += 9) for (let z = z0 + 6; z <= z1 - 6; z += 9) {
      const edge = x - x0 < 10 || x1 - x < 10 || z - z0 < 10 || z1 - z < 10;
      if (edge) {
        if (tryAdd('tree_medium', x, z, r.range(0, 6.28), 'downtown', PL, { variant: r.int(0, 3), s: [1, r.range(0.9, 1.1), 1] })) add('tree_pit', x, RAISED + 0.006, z, 0, 'downtown');
      } else if (r.chance(0.35)) tryAdd(r.chance(0.5) ? 'planter' : 'planter_long', x, z, r.chance(0.5) ? 0 : Math.PI / 2, 'downtown', PL);
      else if (r.chance(0.45)) {
        const yaw = r.int(0, 3) * (Math.PI / 2);
        if (tryAdd('bench', x, z, yaw, 'downtown', PL)) tryAdd('bin', x + Math.cos(yaw) * 1.8, z - Math.sin(yaw) * 1.8, yaw, 'downtown', PL);
      }
    }
    for (const [px, pz, yaw] of perimeter(b.lot, 2.2, 16)) tryAdd('lamp_park', px, pz, yaw, 'downtown', PL);
  }

  // --- special parcels ----------------------------------------------------------------------------------
  for (const b of l.blocks.filter((b) => b.kind === 'large')) {
    if (b.use === 'parking') parkingLot(b, b.district === 'industrial' ? 'fence' : 'trees', null);
    else if (b.use === 'park') park(b);
    else if (b.use === 'factory' || b.use === 'warehouse') yard(b);
    else reservedParcel(b);
  }
  for (const b of l.blocks.filter((b) => b.landmark && b.kind !== 'large')) reservedParcel(b);

  // --- medians ---------------------------------------------------------------------------------------------
  for (const m of medianRects(l)) {
    const e = l.edges[edgeIndex.get(m.edge)!];
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const dx = (B.x - A.x) / e.length;
    const dz = (B.z - A.z) / e.length;
    const [x0, z0, x1, z1] = bbox(m.poly);
    const s0 = Math.abs(dx) > 0.5 ? (dx > 0 ? x0 - A.x : A.x - x1) : dz > 0 ? z0 - A.z : A.z - z1;
    const s1 = s0 + (Math.abs(dx) > 0.5 ? x1 - x0 : z1 - z0);
    const district = districtOfNode(A.x, A.z);
    const MD = [RASTER.MEDIAN];
    if (e.cls === 'arterial3') {
      const phase = hashUnit(seed, `ml${m.edge}`) * MEDIAN_LAMP_SPACING;
      for (let s = s0 + 6 + phase % 10; s < s1 - 4; s += MEDIAN_LAMP_SPACING) tryAdd('lamp_median', A.x + dx * s, A.z + dz * s, yawOf(dx, dz), district, MD);
      for (let s = s0 + 10; s < s1 - 8; s += 7) if (hashUnit(seed, `mb${m.edge}:${Math.round(s)}`) < 0.5) tryAdd('bush', A.x + dx * s, A.z + dz * s, s, district, MD, { s: [0.9, 0.8, 0.9], variant: Math.round(s) % 4 });
    } else if (district !== 'industrial') {
      for (let s = s0 + 9; s < s1 - 6; s += 18) tryAdd('tree_small', A.x + dx * s, A.z + dz * s, s, district, MD, { s: [0.8, 0.9, 0.8], variant: Math.round(s) % 4 });
    }
  }

  // --- front yards (residential lots around the houses) -----------------------------------------------------
  for (const b of l.blocks.filter((b) => b.kind === 'buildings' && DISTRICT_RULES[b.district].yard > 0)) {
    const [x0, z0, x1, z1] = bbox(b.lot);
    const r = stream(seed, `yard${b.id}`);
    const LT = [RASTER.LOT, RASTER.GARDEN];
    for (let x = x0 + 2; x < x1 - 1; x += 7) for (let z = z0 + 2; z < z1 - 1; z += 7) {
      const px = x + r.range(-2, 2);
      const pz = z + r.range(-2, 2);
      const roll = r.next();
      const n = valueNoise(streamSeed(seed, 'yards'), px / 30, pz / 30);
      if (roll > DISTRICT_RULES[b.district].yard * (1 + n)) continue;
      if (!onLabels(px, pz, 1.4, LT) || buildingGap(px, pz) < 1.6) continue;
      const kind = r.next();
      if (kind < 0.55) tryAdd('bush', px, pz, r.range(0, 6.28), b.district, LT, { s: [r.range(0.8, 1.3), r.range(0.7, 1.2), r.range(0.8, 1.3)], variant: r.int(0, 3) });
      else if (kind < 0.8) tryAdd('grass_patch', px, pz, r.range(0, 6.28), b.district, LT, { y: RAISED + 0.007, s: [r.range(1.2, 2.2), 1, r.range(1.2, 2.2)] });
      else if (buildingGap(px, pz) > 3) tryAdd(r.chance(0.3) ? 'tree_conifer' : 'tree_small', px, pz, r.range(0, 6.28), b.district, LT, { s: [r.range(0.8, 1), r.range(0.85, 1.1), r.range(0.8, 1)], variant: r.int(0, 3) });
    }
  }

  // --- manholes and drains on the asphalt --------------------------------------------------------------------
  for (const e of l.edges) {
    if (e.cls === 'alley') continue;
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const dx = (B.x - A.x) / e.length;
    const dz = (B.z - A.z) / e.length;
    const s0 = (isJunction(l, e.a) ? junctionHalf(l, e.a, e) : 0) + 8;
    const s1 = e.length - (isJunction(l, e.b) ? junctionHalf(l, e.b, e) : 0) - 8;
    const lane = laneOffsets(e.cls)[0];
    const district = districtOfNode(A.x, A.z);
    for (let s = s0 + hashUnit(seed, `mh${e.id}`) * 30; s < s1; s += 80) {
      const o = (Math.round(s) % 2 ? 1 : -1) * lane;
      const x = A.x + dx * s + dz * o;
      const z = A.z + dz * s - dx * o;
      if (labelAt(x, z) === RASTER.ASPHALT) add('manhole', x, 0.004, z, yawOf(dx, dz), district);
    }
    if (e.cls === 'street' || e.cls === 'avenue') {
      const kerb = kerbOffset(e.cls) - 0.32;
      for (let s = s0 + 4; s < s1; s += 60) {
        const x = A.x + dx * s - dz * kerb;
        const z = A.z + dz * s + dx * kerb;
        if (labelAt(x, z) === RASTER.ASPHALT && labelAt(x - dz * 0.8, z + dx * 0.8) !== RASTER.ASPHALT) add('drain', x, 0.003, z, yawOf(dx, dz), district);
      }
    }
  }
  return out;

  // --- parcel helpers (hoisted) -------------------------------------------------------------------------------

  /** Main entrance side of a parcel: the side on the most important road short of the 3+3 arterials. */
  function entranceSide(b: LayoutBlock): number {
    let best = -1;
    let bestScore = -Infinity;
    const n = b.lot.length;
    for (let i = 0; i < n; i++) {
      const len = Math.hypot(b.lot[(i + 1) % n][0] - b.lot[i][0], b.lot[(i + 1) % n][1] - b.lot[i][1]);
      if (len < 24 || !ROAD_PROFILE[b.sides[i]].sidewalk) continue;
      const score = (b.sides[i] === 'arterial3' ? 0 : rank[b.sides[i]] * 10) + len / 100;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /** Entrance on side i of the lot: point on the lot edge, direction into the lot, and a P sign on the sidewalk. */
  function entrance(b: LayoutBlock, i: number, sign: boolean): [number, number, number] | null {
    if (i < 0) return null;
    const n = b.lot.length;
    const a = b.lot[i];
    const c = b.lot[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const t: P2 = [(c[0] - a[0]) / len, (c[1] - a[1]) / len];
    // Inward: towards the lot (the kerb lies outside).
    const k = b.kerb[i];
    const d: P2 = [a[0] - k[0], a[1] - k[1]];
    const al = d[0] * t[0] + d[1] * t[1];
    let inn: P2 = [d[0] - al * t[0], d[1] - al * t[1]];
    const il = Math.hypot(inn[0], inn[1]) || 1;
    inn = [inn[0] / il, inn[1] / il];
    const mid = 0.5 + (hashUnit(seed, `ent${b.id}`) - 0.5) * 0.3;
    const p: P2 = [a[0] + t[0] * len * mid, a[1] + t[1] * len * mid];
    if (sign) {
      const q: P2 = [p[0] + t[0] * 7 - inn[0] * (b.sidewalk - 0.6), p[1] + t[1] * 7 - inn[1] * (b.sidewalk - 0.6)];
      tryAdd('sign_parking', q[0], q[1], yawOf(-inn[0], -inn[1]), b.district, SW, { parcel: b.use });
    }
    return [p[0], p[1], yawOf(inn[0], inn[1])];
  }

  /**
   * Stall rows (5 stalls, 2.5 × 5 m) in double rows along the parcel's longer axis, 6.5 m aisles, a cross aisle every
   * 50 m with a lamp; all inside `area` (parking surface, or lot) and outside `keepOut` (a reserved rectangle).
   */
  function stalls(b: LayoutBlock, labels: readonly number[], margin: number, keepOut: [number, number, number, number] | null, lotIndex: number, maxRuns = Infinity): number {
    const [x0, z0, x1, z1] = bbox(b.lot);
    const alongX = x1 - x0 >= z1 - z0;
    // u along the rows, v across.
    const u0 = (alongX ? x0 : z0) + margin;
    const u1 = (alongX ? x1 : z1) - margin;
    const v0 = (alongX ? z0 : x0) + margin;
    const v1 = (alongX ? z1 : x1) - margin;
    const P = (u: number, v: number): P2 => (alongX ? [u, v] : [v, u]);
    const vDir: P2 = alongX ? [0, 1] : [1, 0];
    let runs = 0;
    const RUN = 12.5;
    // Inside this parcel (L-shaped ones too: the label alone is shared with the neighbouring lots), 1.5 m from its edge.
    const area = insetPolygon(b.lot, 1.5);
    const inside = (u: number, v: number) => {
      const [x, z] = P(u, v);
      if (keepOut && x > keepOut[0] - 2 && x < keepOut[2] + 2 && z > keepOut[1] - 2 && z < keepOut[3] + 2) return false;
      return labels.includes(labelAt(x, z)) && inPolygon(area, x, z);
    };
    // Module across: stall row (5 m, facing +v), aisle 6.5 m, stall row (facing −v), back to back with the next module.
    for (let v = v0; v + 16.5 <= v1; v += 16.5) {
      for (const [vRow, dirV] of [[v + 5, -1], [v + 11.5, 1]] as const) {
        for (let u = u0; u + RUN <= u1; u += RUN) {
          // A cross aisle every fifth run (one run wide): a lamp in it.
          const k = Math.round((u - u0) / RUN);
          if (k % 5 === 4) {
            if (dirV < 0) {
              const [lx, lz] = P(u + RUN / 2, v + 8.25);
              if (inside(u + RUN / 2, v + 8.25)) tryAdd('lamp_street', lx, lz, 0, b.district, labels, { parcel: b.use });
            }
            continue;
          }
          // The run's stall area: from the aisle edge vRow, 5 m deep (towards −v for the first row, +v for the second).
          const vFar = vRow + dirV * 5;
          const ok = [u + 0.2, u + RUN - 0.2].every((uu) => [vRow, vFar, (vRow + vFar) / 2].every((vv) => inside(uu, vv)));
          if (!ok || runs >= maxRuns) continue;
          const [ox, oz] = P(u + RUN / 2, vRow);
          // Instance origin at the aisle edge, +z into the stalls.
          const into: P2 = [vDir[0] * dirV, vDir[1] * dirV];
          add('stall_row', ox, RAISED + 0.01, oz, yawOf(into[0], into[1]), b.district, { parcel: b.use });
          runs++;
          for (let s = 0; s < 5; s++) {
            const su = u + 1.25 + s * 2.5;
            const [sx, sz] = P(su, vRow + dirV * 2.5);
            out.spots.push(sx, sz, yawOf(into[0], into[1]), lotIndex);
          }
        }
      }
    }
    return runs;
  }

  function parkingLot(b: LayoutBlock, edge: 'fence' | 'trees', keepOut: [number, number, number, number] | null): void {
    const labels = b.use === 'parking' ? [RASTER.PARKING] : [RASTER.LOT];
    const side = entranceSide(b);
    const ent = entrance(b, side, true);
    const lot: PropParkingLot = { block: b.id, use: b.use ?? 'parking', district: b.district, entrances: ent ? [ent] : [], spots: [out.spots.length / 4, 0] };
    const index = out.lots.length;
    out.lots.push(lot);
    const before = out.spots.length;
    stalls(b, labels, 3.5, keepOut, index);
    lot.spots[1] = (out.spots.length - before) / 4;
    // Edge: trees and bins (commercial) or a fence with a gate (industrial), kept clear of the entrance.
    const nearEntrance = (x: number, z: number) => ent !== null && Math.hypot(x - ent[0], z - ent[1]) < 9;
    if (edge === 'trees') {
      for (const [x, z] of perimeter(b.lot, 1.6, 18)) if (!nearEntrance(x, z)) tryAdd('tree_small', x, z, x, b.district, labels, { parcel: b.use, variant: Math.round(x) & 3 });
      if (ent) tryAdd('bin', ent[0] + Math.sin(ent[2]) * 2 + Math.cos(ent[2]) * 5, ent[1] + Math.cos(ent[2]) * 2 - Math.sin(ent[2]) * 5, ent[2], b.district, labels, { parcel: b.use });
    } else fence(b, labels, ent);
  }

  /** Fence panels (6 m) round the inside of the lot, a gate gap at the entrance with a barrier each side. */
  function fence(b: LayoutBlock, labels: readonly number[], ent: [number, number, number] | null): void {
    for (const [x, z, yaw] of perimeter(b.lot, 0.6, 6, true)) {
      if (ent && Math.hypot(x - ent[0], z - ent[1]) < 9) continue;
      if (onLabels(x, z, 0, labels) && clearOfJunctions(x, z, 0)) add('fence', x, RAISED, z, yaw, b.district, { parcel: b.use });
    }
    if (ent) {
      const [ex, ez, yaw] = ent;
      for (const side of [-1, 1]) {
        const x = ex + Math.cos(yaw) * side * 8.5 + Math.sin(yaw) * 1.5;
        const z = ez - Math.sin(yaw) * side * 8.5 + Math.cos(yaw) * 1.5;
        tryAdd('barrier', x, z, yaw, b.district, labels, { parcel: b.use });
      }
    }
  }

  function park(b: LayoutBlock): void {
    const PK = [RASTER.PARK];
    const r = stream(seed, `park${b.id}`);
    const [x0, z0, x1, z1] = bbox(b.lot);
    // Paths: a loop 6 m inside the edge, and two straight paths through the middle (2.6 m wide gravel).
    const paths: { a: P2; b: P2 }[] = [];
    const loop = insetPolygon(b.lot, 6);
    for (let i = 0; i < loop.length; i++) paths.push({ a: loop[i], b: loop[(i + 1) % loop.length] });
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    paths.push({ a: [x0, cz], b: [x1, cz] }, { a: [cx, z0], b: [cx, z1] });
    const pathCells: P2[] = [];
    for (const p of paths) {
      const len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
      const t: P2 = [(p.b[0] - p.a[0]) / len, (p.b[1] - p.a[1]) / len];
      // Pieces of ≤ 6 m where the path is on park ground (the straight ones are cut by the lot outline).
      for (let s = 0; s < len; s += 6) {
        const e = Math.min(len, s + 6);
        const mx = p.a[0] + t[0] * (s + e) / 2;
        const mz = p.a[1] + t[1] * (s + e) / 2;
        if (!onLabels(mx, mz, 2.2, PK)) continue;
        add('path', mx, RAISED + 0.012, mz, yawOf(t[0], t[1]), b.district, { s: [2.6, 1, e - s + 0.02], parcel: 'park' });
        pathCells.push([mx, mz]);
        // Lamps every other piece on one side, benches (with a bin now and then) on the other.
        const k = Math.round(s / 6);
        const nx = -t[1];
        const nz = t[0];
        if (k % 4 === 1) tryAdd('lamp_park', mx + nx * 2.1, mz + nz * 2.1, yawOf(-nx, -nz), b.district, PK, { parcel: 'park' });
        if (k % 5 === 3 && tryAdd('bench', mx - nx * 2.2, mz - nz * 2.2, yawOf(nx, nz), b.district, PK, { parcel: 'park' }) && r.chance(0.5)) {
          tryAdd('bin', mx - nx * 2 + t[0] * 1.8, mz - nz * 2 + t[1] * 1.8, yawOf(nx, nz), b.district, PK, { parcel: 'park' });
        }
      }
    }
    const offPath = (x: number, z: number, d: number) => pathCells.every(([px, pz]) => Math.hypot(px - x, pz - z) > d);
    // Trees: groves and open lawns (noise), several kinds and sizes; bushes along the edge.
    const ns = streamSeed(seed, `parknoise${b.id}`);
    for (let i = 0; i < 1400; i++) {
      const x = r.range(x0 + 3, x1 - 3);
      const z = r.range(z0 + 3, z1 - 3);
      const dens = valueNoise(ns, x / 26, z / 26);
      if (dens < -0.15 || !offPath(x, z, 4.5)) continue;
      const kind = r.next();
      const id = kind < 0.35 ? 'tree_large' : kind < 0.65 ? 'tree_medium' : kind < 0.85 ? 'tree_conifer' : 'tree_small';
      const s = r.range(0.85, 1.2);
      tryAdd(id, x, z, r.range(0, 6.28), b.district, PK, { s: [s, s * r.range(0.9, 1.15), s], variant: r.int(0, 3), parcel: 'park', pad: 0.8 });
    }
    for (const [x, z] of perimeter(b.lot, 1.8, 4.5)) if (r.chance(0.55) && offPath(x, z, 2.5)) tryAdd('bush', x, z, r.range(0, 6.28), b.district, PK, { s: [r.range(0.9, 1.4), r.range(0.8, 1.2), r.range(0.9, 1.4)], variant: r.int(0, 3), parcel: 'park' });
  }

  /** Factory / warehouse yard: fence and gate, container stacks, a loading zone with barriers, floodlights, staff parking. */
  function yard(b: LayoutBlock): void {
    const LT = [RASTER.LOT];
    const r = stream(seed, `yard-ind${b.id}`);
    const side = entranceSide(b);
    const ent = entrance(b, side, false);
    fence(b, LT, ent);
    const [x0, z0, x1, z1] = bbox(b.lot);
    // Floodlights inside the fence.
    for (const [x, z, yaw] of perimeter(b.lot, 2.2, 42)) tryAdd('lamp_flood', x, z, yaw, b.district, LT, { parcel: b.use });
    for (const [x, z, yaw] of perimeter(b.lot, 1.4, 61)) if (r.chance(0.5)) tryAdd('utility_box', x, z, yaw, b.district, LT, { parcel: b.use });
    // Loading zone: yellow hatching 9 m inside the gate, barriers along one side.
    if (ent) {
      const [ex, ez, yaw] = ent;
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const lx = ex + fx * 14;
      const lz = ez + fz * 14;
      if (onLabels(lx, lz, 6, LT) && inPolygon(insetPolygon(b.lot, 6), lx, lz) && buildingGap(lx, lz) > 9) {
        add('hatch', lx, RAISED + 0.01, lz, yaw, b.district, { s: [12, 1, 8], parcel: b.use });
        for (let k = -2; k <= 2; k++) tryAdd('barrier', lx + Math.cos(yaw) * 8 + fx * k * 2.1, lz - Math.sin(yaw) * 8 + fz * k * 2.1, yaw + Math.PI / 2, b.district, LT, { parcel: b.use });
      }
    }
    // Container stacks: rows of 3-6 side by side, 1-2 high, in 2-4 places away from the fence.
    const alongX = x1 - x0 >= z1 - z0;
    const inner = insetPolygon(b.lot, 12);
    const groups = r.int(2, 4);
    for (let g = 0, tries = 0; g < groups && tries < 40; tries++) {
      const cx = r.range(x0 + 14, x1 - 14);
      const cz = r.range(z0 + 14, z1 - 14);
      const nRow = r.int(3, 6);
      const rows = r.int(1, 2);
      const w = nRow * 2.6;
      const radius = Math.hypot(w, rows * 6.4) / 2 + 1;
      if (!onLabels(cx, cz, radius + 2, LT) || !inPolygon(inner, cx, cz) || !free(cx, cz, radius) || buildingGap(cx, cz) < radius + 4 || (ent && Math.hypot(cx - ent[0], cz - ent[1]) < 24)) continue;
      claim(cx, cz, radius);
      const yaw = alongX ? 0 : Math.PI / 2;
      for (let row = 0; row < rows; row++) for (let k = 0; k < nRow; k++) {
        // Containers' long side along local z; side by side along local x.
        const lxo = (k - (nRow - 1) / 2) * 2.6;
        const lzo = (row - (rows - 1) / 2) * 6.4;
        const x = cx + Math.cos(yaw) * lxo + Math.sin(yaw) * lzo;
        const z = cz - Math.sin(yaw) * lxo + Math.cos(yaw) * lzo;
        const variant = r.int(0, 5);
        add('container', x, RAISED, z, yaw, b.district, { variant, parcel: b.use });
        if (r.chance(0.35)) add('container', x, RAISED + 2.6, z, yaw, b.district, { variant: r.int(0, 5), parcel: b.use });
      }
      g++;
    }
    // Staff parking near the gate.
    const lot: PropParkingLot = { block: b.id, use: b.use ?? 'factory', district: b.district, entrances: ent ? [ent] : [], spots: [out.spots.length / 4, 0] };
    const index = out.lots.length;
    out.lots.push(lot);
    const before = out.spots.length;
    stalls(b, LT, 6, parcelCore(b), index, 6);
    lot.spots[1] = (out.spots.length - before) / 4;
  }

  /**
   * Mall / hospital / stadium / landmark: buildings in the middle (buildings.ts, parcelCore); around them parking
   * (with data), lamps and trees, an entrance with a sign.
   */
  function reservedParcel(b: LayoutBlock): void {
    const [x0, z0, x1, z1] = bbox(b.lot);
    const w = x1 - x0;
    const d = z1 - z0;
    const rect: [number, number, number, number] = parcelCore(b) ?? [x0 + w * 0.25, z0 + d * 0.25, x1 - w * 0.25, z1 - d * 0.25];
    out.reserved.push({ block: b.id, use: b.use ?? 'landmark', rect });
    const labels = [b.kind === 'plaza' ? RASTER.PLAZA : b.use === 'park' ? RASTER.PARK : b.use === 'parking' ? RASTER.PARKING : RASTER.LOT];
    if (b.use === 'mall' || b.use === 'stadium' || b.use === 'hospital') parkingLot(b, 'trees', rect);
    else for (const [x, z, yaw] of perimeter(b.lot, 2, 14)) tryAdd(hashUnit(seed, `lm${x},${z}`) < 0.5 ? 'planter' : 'lamp_park', x, z, yaw, b.district, labels, { parcel: b.use ?? 'landmark' });
  }
}

function bbox(poly: P2[]): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (const [x, z] of poly) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return [x0, z0, x1, z1];
}

/** Point in polygon (even-odd rule). */
function inPolygon(poly: P2[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
    const [xi, zi] = poly[i];
    const [xk, zk] = poly[k];
    if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
  }
  return inside;
}

/** A rectilinear polygon moved inwards by d on every side. */
function insetPolygon(poly: P2[], d: number): P2[] {
  const n = poly.length;
  const s = Math.sign(polygonArea(poly));
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const next = poly[(i + 1) % n];
    const inward = (a: P2, b: P2): P2 => [-Math.sign(b[1] - a[1]) * s, Math.sign(b[0] - a[0]) * s];
    const n0 = inward(prev, cur);
    const n1 = inward(cur, next);
    out.push([cur[0] + (n0[0] + n1[0]) * d, cur[1] + (n0[1] + n1[1]) * d]);
  }
  return out;
}

/**
 * Points every `step` m along the polygon, `inset` m inside it, with the yaw facing inwards (or, `along`, the yaw of
 * the side: fence panels), corners skipped by half a step.
 */
function perimeter(poly: P2[], inset: number, step: number, along = false): [number, number, number][] {
  const loop = insetPolygon(poly, inset);
  const s = Math.sign(polygonArea(poly));
  const res: [number, number, number][] = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < step) continue;
    const t: P2 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    const inward: P2 = [-t[1] * s, t[0] * s];
    const n = Math.floor(len / step);
    const pad = (len - n * step) / 2;
    for (let k = 0; k < n; k++) {
      const d = pad + (k + 0.5) * step;
      res.push([a[0] + t[0] * d, a[1] + t[1] * d, along ? Math.atan2(t[0], t[1]) + Math.PI / 2 : Math.atan2(inward[0], inward[1])]);
    }
  }
  return res;
}

// --- packing -------------------------------------------------------------------------------------------------

/** Kit props (geometry only) into the data file. */
export function packKitProps(kit: Kit, f32: number[], u32: number[]): PropKitPiece[] {
  const res: PropKitPiece[] = [];
  for (const def of PROPS) {
    if (!def.kit) continue;
    const piece = kit.pieces.get(def.kit);
    if (!piece) throw new Error(`Kit prop missing: ${def.kit}`);
    res.push({
      name: def.kit,
      prims: piece.prims.map((p) => {
        const pos: [number, number] = [f32.length, p.position.length / 3];
        for (const v of p.position) f32.push(v);
        const nor: [number, number] = [f32.length, p.position.length / 3];
        if (p.normal) for (const v of p.normal) f32.push(v);
        else for (let i = 0; i < p.position.length / 3; i++) f32.push(0, 1, 0);
        const idx: [number, number] = [u32.length, p.index.length];
        for (const v of p.index) u32.push(v);
        const mat = /Dirt/.test(p.material) ? 'soil' : /Ornaments/.test(p.material) ? 'iron' : def.id === 'bollard' ? 'metal' : 'concrete';
        return { mat, pos, nor, idx };
      }),
    });
  }
  return res;
}

/** Placed props into chunks (instances), cell collider boxes and the props section of the data file. */
export function packProps(placed: PlacedProps, f32: number[], kit: PropKitPiece[], cellKeys: Set<string>): { json: CityV2PropsJson; boxesByCell: Map<string, number[]> } {
  const chunks = new Map<string, PropInstance[]>();
  for (const p of placed.instances) {
    const key = `${Math.floor(p.x / PROP_CHUNK)},${Math.floor(p.z / PROP_CHUNK)}`;
    let list = chunks.get(key);
    if (!list) chunks.set(key, (list = []));
    list.push(p);
  }
  const json: CityV2PropsJson = { protos: PROPS.map((p) => p.id), stride: PROP_STRIDE, chunk: PROP_CHUNK, chunks: [], kit, spots: [0, 0], lots: placed.lots, junctions: placed.junctions, signals: placed.signals, counts: {}, total: placed.instances.length, colliders: 0, reserved: placed.reserved };
  const boxesByCell = new Map<string, number[]>();
  const keys = [...chunks.keys()].sort((a, b) => {
    const [ax, az] = a.split(',').map(Number);
    const [bx, bz] = b.split(',').map(Number);
    return az - bz || ax - bx;
  });
  for (const key of keys) {
    const list = chunks.get(key)!.sort((a, b) => a.proto - b.proto || a.x - b.x || a.z - b.z);
    const [cx, cz] = key.split(',').map(Number);
    const cell: [number, number] = [Math.floor((cx * PROP_CHUNK) / CELL), Math.floor((cz * PROP_CHUNK) / CELL)];
    const bounds: [number, number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    const items: [number, number, number][] = [];
    for (const p of list) {
      const def = PROPS[p.proto];
      let last = items[items.length - 1];
      if (!last || last[0] !== p.proto) items.push((last = [p.proto, f32.length, 0]));
      last[2]++;
      f32.push(p.x, p.y, p.z, p.yaw, p.sx, p.sy, p.sz, p.variant);
      // Footprint reach (flat strips: half their length), plus arms and masts over the road.
      const reach = (def.radius > 0 ? def.radius * Math.max(p.sx, p.sz) : Math.max(1, Math.max(p.sx, p.sz) / 2)) + (def.category === 'signal' ? 6 : 0) + (def.category === 'lamp' ? 3 : 0);
      bounds[0] = Math.min(bounds[0], p.x - reach);
      bounds[1] = Math.min(bounds[1], p.z - reach);
      bounds[2] = Math.max(bounds[2], p.x + reach);
      bounds[3] = Math.max(bounds[3], p.z + reach);
      bounds[4] = Math.max(bounds[4], p.y + PROP_HEIGHT[def.category] * p.sy);
      const counts = (json.counts[p.district] ??= {});
      counts[def.category] = (counts[def.category] ?? 0) + 1;
      if (p.parcel) {
        const pc = (json.counts[`parcel:${p.parcel}`] ??= {});
        pc[def.category] = (pc[def.category] ?? 0) + 1;
      }
      if (def.collider) {
        const ck = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`;
        if (!cellKeys.has(ck)) continue;
        let boxes = boxesByCell.get(ck);
        if (!boxes) boxesByCell.set(ck, (boxes = []));
        const [hx, hy, hz] = def.collider;
        const q = [0, Math.sin(p.yaw / 2), 0, Math.cos(p.yaw / 2)];
        boxes.push(p.x, p.y + hy * p.sy, p.z, hx * p.sx, hy * p.sy, hz * p.sz, q[0], q[1], q[2], q[3]);
        json.colliders++;
      }
    }
    json.chunks.push({ cx, cz, cell, bounds, items });
  }
  json.spots = [f32.length, placed.spots.length / 4];
  for (const v of placed.spots) f32.push(v);
  return { json, boxesByCell };
}

/** Rough height per category, m (chunk bounds for culling). */
const PROP_HEIGHT: Record<PropCategory, number> = { tree: 11, bush: 1.5, grass: 0.1, lamp: 11, signal: 6.5, sign: 2.6, bench: 1, bin: 1, bollard: 1, planter: 1.6, hydrant: 0.9, utility: 1.4, busstop: 2.6, bikerack: 1, barrier: 0.9, fence: 2, container: 2.7, marking: 0.1, path: 0.1, street: 0.1 };
