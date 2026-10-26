/**
 * City V2 street layout: a seeded, repeatable, orthogonal street network.
 *
 * Everything lives on a 6 m grid (the kit's street segment length) in integer
 * grid units, so nodes match exactly and no floating-point slivers appear.
 * World metres = grid × UNIT, the city centred on the origin, +x east, +z south.
 *
 *  1. Main arterials: a few boulevards across the town (1 km: 3, 2 km: 5), split
 *     over the two axes by the seed. Each jogs sideways only as often as needed
 *     to keep its straight pieces ≤ `maxBoulevardStraight` (300-500 m runs).
 *  2. Ring: a boulevard around the town, stepping in or out (two 90° bends) only
 *     where needed for the same limit and never where an arterial meets it.
 *     One arterial stops at a crossing boulevard: a T with a landmark at the end
 *     of the view ("vista").
 *  3. Districts (districts.ts): downtown around the main crossing, commercial
 *     along the boulevards, industry towards one edge, residential the rest.
 *  4. Blocks: every face larger than its district's target span is split by a
 *     street across it (wall to wall: no dead ends). A split either continues a
 *     street from the other side (a crossroads) or lands somewhere new (a T,
 *     staggered); sometimes it cuts a corner off with an L (a 90° bend), or jogs
 *     when a face is too wide for one straight street. District rules set block
 *     sizes, crossroads vs T and how often streets bend. Some big blocks are kept
 *     whole as large parcels (mall, stadium, factory, park...), on purpose.
 *  5. Alleys: narrow lanes through some blocks, weighted by district (rear lanes
 *     in residential blocks, mid-block passages downtown), up to `alleyPerKm2`.
 *
 * Splits keep blocks at least `minDepth` deep, junctions `minGap` apart and
 * street runs ≤ `maxStraight`. The result is a pure function of (seed, params).
 */
import { DISTRICT, DISTRICTS, planDistricts, type District, type DistrictCentre, type DistrictMap, type DistrictProfile, type ParcelUse } from './districts';
import { ROAD_CLASSES, ROAD_PROFILE, SIDEWALK, SIDEWALK_MAX, kerbOffset, type RoadClass } from '../../../src/world/cityv2/roadProfiles';
import { hashUnit, stream, type Rng } from './rng';

export type { District, ParcelUse } from './districts';

/** Grid unit, m (the kit's street segment length). */
export const UNIT = 6;

export type { RoadClass } from '../../../src/world/cityv2/roadProfiles';
/** Place in the hierarchy: the ring road, a main arterial, or a local street / alley. */
export type RoadRank = 'ring' | 'arterial' | 'local';

/**
 * Centre line to the back of the widest possible sidewalk, m: what the layout
 * keeps clear when it spaces roads (the block's district, which sets its real
 * sidewalk, is only known once the blocks exist).
 */
export function halfWidth(c: RoadClass): number {
  return kerbOffset(c) + (ROAD_PROFILE[c].sidewalk ? SIDEWALK_MAX : 0);
}

/** Main arterials widened to 3+3 lanes: one per axis through the middle of town from this size on (else one in all). */
const WIDE_BOTH_AXES_FROM = 1500;
/** Sidewalk on the outer side of the ring road, m. */
const RING_OUTER_SIDEWALK = 3;
/** Streets splitting a block larger than this (m²) in a downtown or commercial district are avenues (2+2). */
const AVENUE_FACE_AREA = 45000;

export interface LayoutParams {
  seed: number;
  /** Side of the square the town fits in, m. */
  size: number;
  /** Longest straight run of a street or alley, m. */
  maxStraight: number;
  /** Longest straight piece of a boulevard (ring, arterials), m. */
  maxBoulevardStraight: number;
  /** Smallest block depth between the backs of the sidewalks, m. */
  minDepth: number;
  /** The same next to an alley (lots behind an alley can be shallower), m. */
  alleyDepth: number;
  /** Smallest distance between two junctions / bends along a road, m. */
  minGap: number;
  /** Alley length per km² of town (the target is picked in this range), m. */
  alleyPerKm2: [number, number];
}

export const LAYOUT_DEFAULTS: Omit<LayoutParams, 'seed'> = {
  size: 1000,
  maxStraight: 350,
  maxBoulevardStraight: 520,
  minDepth: 30,
  alleyDepth: 20,
  minGap: 30,
  alleyPerKm2: [1800, 2600],
};

export type NodeKind = 'cross' | 'tee' | 'bend' | 'pass';
/** Plain building block, the downtown plaza, or a large parcel kept whole (see `use`). */
export type BlockKind = 'buildings' | 'plaza' | 'large';

export interface LayoutNode {
  id: number;
  /** World position, m. */
  x: number;
  z: number;
  kind: NodeKind;
  /** Edge ids by direction: +x, +z, -x, -z (-1 = none). */
  out: [number, number, number, number];
}

export interface LayoutEdge {
  id: number;
  a: number;
  b: number;
  cls: RoadClass;
  rank: RoadRank;
  length: number;
}

export interface LayoutBlock {
  id: number;
  kind: BlockKind;
  district: District;
  /** What a large parcel is for. */
  use?: ParcelUse;
  /** Centre-line polygon (m), one road class per side (side i runs from point i to point i + 1). */
  centre: [number, number][];
  sides: RoadClass[];
  /** Sidewalk width along this block (its district's), m; none along alleys. */
  sidewalk: number;
  /** Kerb line (edge of the asphalt) and lot line (back of the sidewalk), m. */
  kerb: [number, number][];
  lot: [number, number][];
  /** Lot polygon area, m². */
  area: number;
  /** Graph edges around the block. */
  edges: number[];
  /** A boulevard ends in a T in front of this block: landmark spot. */
  landmark: boolean;
}

export interface CityLayout {
  params: LayoutParams;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  blocks: LayoutBlock[];
  /** Ring road centre line, its outer kerb and the outer back of its sidewalk (m). */
  outline: { centre: [number, number][]; kerb: [number, number][]; edge: [number, number][] };
  /** T junctions where a boulevard ends (node ids): the street looks at a landmark. */
  vistas: number[];
  /** District centres (the district of a block is in the block). */
  districts: DistrictCentre[];
  /** Main arterials placed. */
  arterials: number;
  /** World bounds of everything built (outer sidewalk edge), m. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

// --- graph (grid units) ------------------------------------------------------------------------

const DX = [1, 0, -1, 0];
const DZ = [0, 1, 0, -1];
type P = [number, number];

interface GNode {
  x: number;
  z: number;
  out: [number, number, number, number];
}

interface GEdge {
  a: number;
  b: number;
  cls: RoadClass;
  rank: RoadRank;
  dead: boolean;
}

function dirOf(ax: number, az: number, bx: number, bz: number): number {
  if (az === bz) return bx > ax ? 0 : 2;
  if (ax === bx) return bz > az ? 1 : 3;
  throw new Error(`Not axis-aligned: (${ax},${az}) → (${bx},${bz})`);
}

class Graph {
  nodes: GNode[] = [];
  edges: GEdge[] = [];
  /** Nodes no new street may join (the landmark T). */
  locked = new Set<number>();
  private at = new Map<string, number>();

  clone(): Graph {
    const g = new Graph();
    g.nodes = this.nodes.map((n) => ({ x: n.x, z: n.z, out: [...n.out] as GNode['out'] }));
    g.edges = this.edges.map((e) => ({ ...e }));
    g.locked = new Set(this.locked);
    g.at = new Map(this.at);
    return g;
  }

  /** Back to a snapshot taken with clone(). */
  restore(snap: Graph): void {
    this.nodes = snap.nodes;
    this.edges = snap.edges;
    this.locked = snap.locked;
    this.at = snap.at;
  }

  nodeAt(x: number, z: number): number | undefined {
    return this.at.get(`${x},${z}`);
  }

  node(x: number, z: number): number {
    const k = `${x},${z}`;
    let id = this.at.get(k);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push({ x, z, out: [-1, -1, -1, -1] });
      this.at.set(k, id);
    }
    return id;
  }

  degree(n: number): number {
    return this.nodes[n].out.filter((e) => e >= 0).length;
  }

  link(a: number, b: number, cls: RoadClass, rank: RoadRank): number {
    const A = this.nodes[a];
    const B = this.nodes[b];
    const d = dirOf(A.x, A.z, B.x, B.z);
    if (A.out[d] >= 0 || B.out[(d + 2) % 4] >= 0) throw new Error(`Edge slot taken at (${A.x},${A.z}) dir ${d}`);
    const id = this.edges.length;
    this.edges.push({ a, b, cls, rank, dead: false });
    A.out[d] = id;
    B.out[(d + 2) % 4] = id;
    return id;
  }

  unlink(e: number): void {
    const E = this.edges[e];
    E.dead = true;
    for (const n of [E.a, E.b]) {
      const o = this.nodes[n].out;
      for (let d = 0; d < 4; d++) if (o[d] === e) o[d] = -1;
    }
  }

  other(e: number, n: number): number {
    const E = this.edges[e];
    return E.a === n ? E.b : E.a;
  }

  live(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.edges.length; i++) if (!this.edges[i].dead) out.push(i);
    return out;
  }

  len(e: number): number {
    const A = this.nodes[this.edges[e].a];
    const B = this.nodes[this.edges[e].b];
    return Math.abs(A.x - B.x) + Math.abs(A.z - B.z);
  }

  /** Live edge whose open interior contains (x, z), or -1. */
  edgeThrough(x: number, z: number): number {
    for (const e of this.live()) {
      const A = this.nodes[this.edges[e].a];
      const B = this.nodes[this.edges[e].b];
      if (A.z === B.z && z === A.z && x > Math.min(A.x, B.x) && x < Math.max(A.x, B.x)) return e;
      if (A.x === B.x && x === A.x && z > Math.min(A.z, B.z) && z < Math.max(A.z, B.z)) return e;
    }
    return -1;
  }

  /** Node at (x, z): existing, splitting the edge through it, or new. */
  ensure(x: number, z: number): number {
    const n = this.nodeAt(x, z);
    if (n !== undefined && this.degree(n) > 0) return n;
    const e = this.edgeThrough(x, z);
    const id = this.node(x, z);
    if (e >= 0) {
      const { a, b, cls, rank } = this.edges[e];
      this.unlink(e);
      this.link(a, id, cls, rank);
      this.link(id, b, cls, rank);
    }
    return id;
  }

  /** Would this axis-aligned segment overlap an existing edge lengthwise? */
  overlaps(ax: number, az: number, bx: number, bz: number): boolean {
    for (const e of this.live()) {
      const A = this.nodes[this.edges[e].a];
      const B = this.nodes[this.edges[e].b];
      if (az === bz && A.z === B.z && A.z === az) {
        if (Math.min(Math.max(ax, bx), Math.max(A.x, B.x)) - Math.max(Math.min(ax, bx), Math.min(A.x, B.x)) > 0) return true;
      } else if (ax === bx && A.x === B.x && A.x === ax) {
        if (Math.min(Math.max(az, bz), Math.max(A.z, B.z)) - Math.max(Math.min(az, bz), Math.min(A.z, B.z)) > 0) return true;
      }
    }
    return false;
  }

  /**
   * Adds an axis-aligned polyline, splitting the edges it crosses or touches.
   * Returns false (and changes nothing) if a piece would overlap an edge.
   */
  insertPath(pts: P[], cls: RoadClass, rank: RoadRank = 'local'): boolean {
    for (let i = 0; i + 1 < pts.length; i++) if (this.overlaps(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1])) return false;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      const horizontal = az === bz;
      const lo = horizontal ? Math.min(ax, bx) : Math.min(az, bz);
      const hi = horizontal ? Math.max(ax, bx) : Math.max(az, bz);
      // Stops along the segment: its ends, crossings with perpendicular edges, nodes lying on it.
      const stops = new Set<number>([horizontal ? ax : az, horizontal ? bx : bz]);
      for (const e of this.live()) {
        const A = this.nodes[this.edges[e].a];
        const B = this.nodes[this.edges[e].b];
        if (horizontal && A.x === B.x && A.x >= lo && A.x <= hi && az >= Math.min(A.z, B.z) && az <= Math.max(A.z, B.z)) stops.add(A.x);
        if (!horizontal && A.z === B.z && A.z >= lo && A.z <= hi && ax >= Math.min(A.x, B.x) && ax <= Math.max(A.x, B.x)) stops.add(A.z);
      }
      for (let n = 0; n < this.nodes.length; n++) {
        const N = this.nodes[n];
        if (this.degree(n) === 0) continue;
        if (horizontal && N.z === az && N.x >= lo && N.x <= hi) stops.add(N.x);
        if (!horizontal && N.x === ax && N.z >= lo && N.z <= hi) stops.add(N.z);
      }
      const sorted = [...stops].sort((p, q) => p - q);
      let prev = -1;
      for (const s of sorted) {
        const id = horizontal ? this.ensure(s, az) : this.ensure(ax, s);
        if (prev >= 0 && prev !== id) {
          const d = dirOf(this.nodes[prev].x, this.nodes[prev].z, this.nodes[id].x, this.nodes[id].z);
          if (this.nodes[prev].out[d] < 0) this.link(prev, id, cls, rank);
        }
        prev = id;
      }
    }
    return true;
  }

  /** Straight length (grid units) from node n going in direction d through every node that continues it. */
  run(n: number, d: number): number {
    let len = 0;
    let cur = n;
    for (let guard = 0; guard < 10000; guard++) {
      const e = this.nodes[cur].out[d];
      if (e < 0) break;
      len += this.len(e);
      cur = this.other(e, cur);
    }
    return len;
  }

  /** Removes degree-0 nodes from lookups and merges straight degree-2 nodes of one class and rank. */
  tidy(): void {
    for (let n = 0; n < this.nodes.length; n++) {
      const o = this.nodes[n].out;
      for (const [d1, d2] of [[0, 2], [1, 3]] as const) {
        if (this.degree(n) !== 2 || o[d1] < 0 || o[d2] < 0) continue;
        const e1 = o[d1];
        const e2 = o[d2];
        if (this.edges[e1].cls !== this.edges[e2].cls || this.edges[e1].rank !== this.edges[e2].rank) continue;
        const a = this.other(e1, n);
        const b = this.other(e2, n);
        const { cls, rank } = this.edges[e1];
        this.unlink(e1);
        this.unlink(e2);
        this.link(a, b, cls, rank);
      }
    }
    for (let n = 0; n < this.nodes.length; n++) if (this.degree(n) === 0) this.at.delete(`${this.nodes[n].x},${this.nodes[n].z}`);
  }
}

// --- faces ------------------------------------------------------------------------------------

interface Face {
  /** Half-edges in order: edge id and the node it starts from. */
  half: { e: number; from: number }[];
  /** Simplified polygon (grid), corners only, and the class of each side. */
  poly: P[];
  sides: RoadClass[];
  /** Graph nodes on each side, in order (corners included), for spacing checks. */
  sideNodes: number[][];
  area: number;
  key: string;
}

/** Interior faces of the planar graph (the outer face is dropped). */
function faces(g: Graph): Face[] {
  const seen = new Set<number>();
  const all: Face[] = [];
  for (const e0 of g.live()) {
    for (const flip of [0, 1]) {
      if (seen.has(e0 * 2 + flip)) continue;
      const half: Face['half'] = [];
      let e = e0;
      let from = flip ? g.edges[e0].b : g.edges[e0].a;
      for (let guard = 0; guard < 100000; guard++) {
        const id = e * 2 + (g.edges[e].a === from ? 0 : 1);
        if (seen.has(id)) break;
        seen.add(id);
        half.push({ e, from });
        const to = g.other(e, from);
        const N = g.nodes[to];
        const d = dirOf(g.nodes[from].x, g.nodes[from].z, N.x, N.z);
        const back = (d + 2) % 4;
        // Next edge: the first one turning from the way back in one rotational sense.
        let next = -1;
        for (let k = 1; k <= 4; k++) {
          const nd = (back + k) % 4;
          if (N.out[nd] >= 0) {
            next = N.out[nd];
            break;
          }
        }
        from = to;
        e = next;
      }
      all.push(buildFace(g, half));
    }
  }
  if (all.length === 0) return [];
  // Interior faces share one orientation; the outer face (largest |area|) has the other.
  let outer = 0;
  for (let i = 1; i < all.length; i++) if (Math.abs(all[i].area) > Math.abs(all[outer].area)) outer = i;
  const sign = Math.sign(all[outer].area);
  return all.filter((f) => Math.sign(f.area) === -sign && f.poly.length >= 4);
}

function buildFace(g: Graph, half: Face['half']): Face {
  const pts: P[] = half.map((h) => [g.nodes[h.from].x, g.nodes[h.from].z]);
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, z1] = pts[i];
    const [x2, z2] = pts[(i + 1) % pts.length];
    area += x1 * z2 - x2 * z1;
  }
  area /= 2;
  // Corners: where the direction changes.
  const dirs = half.map((h) => {
    const a = g.nodes[h.from];
    const b = g.nodes[g.other(h.e, h.from)];
    return dirOf(a.x, a.z, b.x, b.z);
  });
  const start = dirs.findIndex((d, i) => d !== dirs[(i - 1 + dirs.length) % dirs.length]);
  const poly: P[] = [];
  const sides: RoadClass[] = [];
  const sideNodes: number[][] = [];
  if (start >= 0) {
    for (let k = 0; k < half.length; k++) {
      const i = (start + k) % half.length;
      const prevDir = dirs[(i - 1 + half.length) % half.length];
      if (k === 0 || dirs[i] !== prevDir) {
        poly.push(pts[i]);
        sides.push(g.edges[half[i].e].cls);
        sideNodes.push([half[i].from]);
      } else if (halfWidth(g.edges[half[i].e].cls) > halfWidth(sides[sides.length - 1])) sides[sides.length - 1] = g.edges[half[i].e].cls;
      sideNodes[sideNodes.length - 1].push(g.other(half[i].e, half[i].from));
    }
  }
  const key = [...half.map((h) => h.from)].sort((a, b) => a - b).join(',');
  return { half, poly, sides, sideNodes, area, key };
}

// --- polygon helpers (grid or metres) ----------------------------------------------------------

function bbox(poly: P[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return { minX, minZ, maxX, maxZ };
}

export function polygonArea(poly: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

/**
 * Moves every side of a rectilinear polygon inwards by its own distance
 * (negative: outwards). Adjacent sides are perpendicular, so each new corner
 * is simply the crossing of the two moved lines.
 */
export function offsetRectilinear(poly: [number, number][], dist: number[]): [number, number][] {
  const n = poly.length;
  const s = Math.sign(polygonArea(poly));
  // Inward normal of side i (from i to i + 1): the left normal for positive area in x/z.
  const normal = (i: number): [number, number] => {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % n];
    const dx = Math.sign(x2 - x1);
    const dz = Math.sign(z2 - z1);
    return [-dz * s, dx * s];
  };
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const [nx0, nz0] = normal(prev);
    const [nx1, nz1] = normal(i);
    const [x, z] = poly[i];
    // The previous side is vertical or horizontal; take x from the vertical one and z from the horizontal one.
    const px = x + nx0 * dist[prev] + nx1 * dist[i];
    const pz = z + nz0 * dist[prev] + nz1 * dist[i];
    out.push([px, pz]);
  }
  return out;
}

// --- generation ---------------------------------------------------------------------------------

/** A protected large parcel, by a point inside it (grid units). */
interface LargeMark {
  x: number;
  z: number;
}

export function generateLayout(input: Partial<LayoutParams> & { seed: number }): CityLayout {
  const p: LayoutParams = { ...LAYOUT_DEFAULTS, ...input };
  const minGap = Math.ceil(p.minGap / UNIT);
  const R = Math.floor((p.size / 2 - halfWidth('boulevard')) / UNIT);
  const maxRun = Math.floor(p.maxStraight / UNIT);
  const maxBoulevardRun = Math.floor(p.maxBoulevardStraight / UNIT);
  const km2 = (p.size / 1000) ** 2;
  let g = new Graph();

  // 1. Boulevard plan: a few main arterials, each jogging as rarely as the straight limit allows.
  const art = stream(p.seed, 'arterials');
  let plans = planArterials(R, p.size, maxBoulevardRun, art);

  // 2. Ring, stepping only where no arterial meets it.
  const ring = ringPolygon(R, maxBoulevardRun, plans, stream(p.seed, 'ring'));
  g.insertPath([...ring, ring[0]], 'boulevard', 'ring');

  // 3. Arterials, re-planned (other position / jogs) until they fit.
  const placed: { axis: 0 | 1; path: P[]; wide: boolean }[] = [];
  for (let i = 0; i < plans.length; i++) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const plan = attempt === 0 ? plans[i] : replanArterial(plans, i, R, maxBoulevardRun, art);
      const path = arterialPath(ring, plan);
      if (!path) continue;
      const snap = g.clone();
      const cls: RoadClass = plan.wide ? 'arterial3' : 'boulevard';
      if (clearOfParallels(g, path, cls, p) && g.insertPath(path, cls, 'arterial') && spacingOk(g, minGap) && blocksOk(g, path, p)) {
        plans = plans.map((q, k) => (k === i ? plan : q));
        placed.push({ axis: plan.axis, path, wide: plan.wide });
        break;
      }
      g = snap;
    }
  }

  // The vista: one arterial stops at a crossing boulevard.
  const vistas: number[] = [];
  {
    const r = stream(p.seed, 'vista');
    // Never one of the 3+3 axes: they cross the whole town.
    for (const { path } of r.shuffle(placed.filter((q) => !q.wide))) {
      const snap = g.clone();
      const node = cutArterial(g, path, r);
      if (node >= 0 && spacingOk(g, minGap)) {
        vistas.push(node);
        // Keep it a T: no street may continue the boulevard into the landmark block.
        g.locked.add(node);
        break;
      }
      g = snap;
    }
  }

  // 4. Districts, around the boulevard crossings and along the boulevards.
  const crossings: [number, number][] = [];
  const along: [number, number][] = [];
  for (let n = 0; n < g.nodes.length; n++) {
    const o = g.nodes[n].out;
    if (g.degree(n) >= 3 && o.every((e) => e < 0 || g.edges[e].rank !== 'local') && o.filter((e) => e >= 0 && g.edges[e].rank === 'arterial').length >= 2) crossings.push([g.nodes[n].x * UNIT, g.nodes[n].z * UNIT]);
  }
  for (const { path } of placed) {
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const L = Math.abs(bx - ax) + Math.abs(bz - az);
      for (let s = 0; s <= L; s += 10) along.push([(ax + ((bx - ax) * s) / L) * UNIT, (az + ((bz - az) * s) / L) * UNIT]);
    }
  }
  const districts = planDistricts(p.seed, p.size, crossings, along);
  const districtOf = (f: Face) => {
    const [cx, cz] = centroid(f.poly);
    return districts.at(cx * UNIT, cz * UNIT);
  };

  // 5. Blocks: split by district rules; some big blocks are kept whole as large parcels.
  const rb = stream(p.seed, 'blocks');
  const large: LargeMark[] = [];
  const isLarge = (f: Face) => large.some((m) => pointInPoly([m.x, m.z], f.poly));
  const largeQuota = Math.max(2, Math.round(km2 * stream(p.seed, 'large').range(2.5, 4)));
  const final = new Set<string>();
  for (let iter = 0; iter < 40000; iter++) {
    const fs = faces(g).filter((f) => !final.has(f.key) && !isLarge(f) && spanOf(f) * UNIT > target(f, p, districts));
    if (fs.length === 0) break;
    fs.sort((a, b) => Math.abs(b.area) - Math.abs(a.area) || (a.key < b.key ? -1 : 1));
    const f = fs[0];
    const d = districtOf(f);
    if (large.length < largeQuota && largeCandidate(g, f) && hashUnit(p.seed, `large:${centroid(f.poly).join(',')}`) < DISTRICT[d].large) {
      large.push(interiorPoint(f.poly));
      continue;
    }
    const prof = DISTRICT[d];
    // The first streets through the big downtown / commercial blocks are the district's avenues (2+2).
    const cls: RoadClass = (d === 'downtown' || d === 'commercial') && Math.abs(f.area) * UNIT * UNIT > AVENUE_FACE_AREA ? 'avenue' : 'street';
    if (splitFace(g, f, rb, { ...p, minDepth: prof.minDepth }, prof, Math.ceil(prof.minGap / UNIT), maxRun, cls)) continue;
    // Far too big but hemmed in by short, stepped sides (ring steps, boulevard jogs): try again with
    // junctions 24 m, then 18 m apart, a slightly longer straight, then L-shaped streets first.
    const tooBig = Math.abs(f.area) * UNIT * UNIT > 60000;
    const relaxed = { ...p, minDepth: Math.min(prof.minDepth, 26) };
    if (tooBig && splitFace(g, f, rb, relaxed, prof, 4, Math.floor(maxRun * 1.15), cls)) continue;
    if (tooBig && splitFace(g, f, rb, relaxed, { ...prof, lChance: 1 }, 3, Math.floor(maxRun * 1.15), cls)) continue;
    final.add(f.key);
  }
  // A compact block that stayed too big to split is a large parcel on purpose; ragged ones stay plain blocks.
  for (const f of faces(g)) if (!isLarge(f) && Math.abs(f.area) * UNIT * UNIT > 20000 && Math.abs(f.area) * UNIT * UNIT <= 60000 && f.poly.length <= 8) large.push(interiorPoint(f.poly));

  // 6. Alleys: narrow lanes through some blocks (rear lanes, mid-block passages), weighted by district.
  const ra = stream(p.seed, 'alleys');
  const alleyTarget = km2 * ra.range(p.alleyPerKm2[0], p.alleyPerKm2[1]);
  const alleyRules: LayoutParams = { ...p, minDepth: p.alleyDepth };
  const tried = new Set<string>();
  let alleyLength = 0;
  for (let iter = 0; iter < 5000 && alleyLength < alleyTarget; iter++) {
    let best: Face | null = null;
    let bestScore = -1;
    for (const f of faces(g)) {
      if (tried.has(f.key) || isLarge(f) || spanOf(f) * UNIT < 66 || Math.abs(f.area) * UNIT * UNIT < 3200) continue;
      if (f.half.some((h) => g.locked.has(h.from))) continue;
      const score = DISTRICT[districtOf(f)].alley * hashUnit(p.seed, `alley:${f.key}`);
      if (score > bestScore) {
        bestScore = score;
        best = f;
      }
    }
    if (!best) break;
    const added = splitWithAlley(g, best, ra, alleyRules, districtOf(best), minGap, maxRun);
    if (added > 0) alleyLength += added * UNIT;
    else tried.add(best.key);
  }
  g.tidy();
  return finish(g, p, ring, vistas, districts, large, placed.length);
}

function spanOf(f: Face): number {
  const b = bbox(f.poly);
  return Math.max(b.maxX - b.minX, b.maxZ - b.minZ);
}

/**
 * Target span of a face: the smallest of the districts it overlaps (sampled at
 * its centre and four inner points), so a big face reaching into downtown keeps
 * being split there instead of stopping at a neighbour's larger block size.
 */
function target(f: Face, p: LayoutParams, districts: DistrictMap): number {
  const b = bbox(f.poly);
  const u = hashUnit(p.seed, `span:${f.key}`);
  let min = Infinity;
  for (const [fx, fz] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
    const x = b.minX + (b.maxX - b.minX) * fx;
    const z = b.minZ + (b.maxZ - b.minZ) * fz;
    if (!pointInPoly([x, z], f.poly)) continue;
    const [lo, hi] = DISTRICT[districts.at(x * UNIT, z * UNIT)].blockSpan;
    min = Math.min(min, lo + (hi - lo) * u);
  }
  return Number.isFinite(min) ? min : DISTRICT.residential.blockSpan[1];
}

/** Big, compact and plain enough to keep whole (mall, stadium, factory, park...). */
function largeCandidate(g: Graph, f: Face): boolean {
  const b = bbox(f.poly);
  const area = Math.abs(f.area) * UNIT * UNIT;
  return area >= 9000 && area <= 45000 && Math.min(b.maxX - b.minX, b.maxZ - b.minZ) * UNIT >= 84 && f.poly.length <= 6 && !f.half.some((h) => g.locked.has(h.from));
}

/** A point well inside a rectilinear polygon (grid units): the centre of its widest horizontal slice. */
function interiorPoint(poly: P[]): LargeMark {
  const b = bbox(poly);
  const mid = (b.minZ + b.maxZ) / 2;
  let best: LargeMark | null = null;
  let bestScore = -Infinity;
  for (let z = b.minZ + 0.5; z < b.maxZ; z += 1) {
    const hits = lineHits(poly, 1, z);
    if (!hits) continue;
    for (let i = 0; i + 1 < hits.length; i += 2) {
      // Wide slices near the middle; half-unit z keeps the point off every side.
      const score = hits[i + 1] - hits[i] - Math.abs(z - mid) * 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = { x: (hits[i] + hits[i + 1]) / 2, z };
      }
    }
  }
  if (!best || !pointInPoly([best.x, best.z], poly)) throw new Error('No interior point for a large parcel');
  return best;
}

interface ArterialPlan {
  axis: 0 | 1;
  /** Lateral position (x for axis 0, z for axis 1) at the start, grid units. */
  base: number;
  /** One of the 3+3 main axes. */
  wide: boolean;
  /** Jogs along the way: at `at` the boulevard moves sideways to `to`. */
  jogs: { at: number; to: number }[];
}

/**
 * Main arterials: about 2.5 per km of town (1 km: 3, 2 km: 5), split over the two
 * axes by the seed. Axis 0 is planned first; axis 1 then keeps its jogs away
 * from every position the axis-0 boulevards take (they jog too), and its own
 * sideways moves off the lines where axis-0 boulevards jog.
 */
function planArterials(R: number, size: number, maxRun: number, r: Rng): ArterialPlan[] {
  const total = Math.max(2, Math.round((size / 1000) * 2.5));
  const n0 = r.chance(0.5) ? Math.ceil(total / 2) : Math.floor(total / 2);
  const counts = [n0, total - n0];
  const bases = counts.map((n) => Array.from({ length: n }, (_, i) => Math.round(-R + ((i + 1) * 2 * R) / (n + 1) + r.int(-8, 8))));
  const plans: ArterialPlan[] = [];
  for (const axis of [0, 1] as const) for (const base of bases[axis]) plans.push({ axis, base, jogs: [], wide: false });
  // The 3+3 axes: the arterial through the middle of town on each axis (in a small town only the most central
  // one). Downtown grows around the boulevard crossing nearest the centre: their crossing.
  const central = [...plans].sort((a, b) => Math.abs(a.base) - Math.abs(b.base));
  for (const axis of [0, 1] as const) {
    if (size < WIDE_BOTH_AXES_FROM && axis !== central[0].axis) continue;
    const q = central.find((c) => c.axis === axis);
    if (q) q.wide = true;
  }
  for (const plan of plans) {
    const { lanes, jogLines } = avoidFor(plans, plan.axis, plans.indexOf(plan));
    plan.jogs = planJogs(plan.base, plan.axis === 0 ? bases[1] : lanes, jogLines, R, maxRun, r);
  }
  return plans;
}

/**
 * For an arterial on `axis`: every lateral position the other axis' arterials
 * take (their base and each jog target), and the lines where they jog.
 */
function avoidFor(plans: ArterialPlan[], axis: 0 | 1, self: number): { lanes: number[]; jogLines: number[] } {
  const others = plans.filter((q, k) => q.axis !== axis && k !== self);
  return { lanes: others.flatMap((q) => [q.base, ...q.jogs.map((j) => j.to)]), jogLines: others.flatMap((q) => q.jogs.map((j) => j.at)) };
}

/** Jogs at positions away from `avoid`; each sideways move lands ≥ 9 units off the other axis' jog lines. */
function planJogs(base: number, avoid: number[], jogLines: number[], R: number, maxRun: number, r: Rng): ArterialPlan['jogs'] {
  const at = jogPositions(R, avoid, maxRun, r) ?? [];
  const jogs: ArterialPlan['jogs'] = [];
  let c = base;
  for (const a of at) {
    const options = r.shuffle([-10, -9, -8, -7, 7, 8, 9, 10].map((d) => c + d));
    const to = options.find((t) => jogLines.every((l) => Math.abs(l - t) >= 9)) ?? options[0];
    jogs.push({ at: a, to });
    c = to;
  }
  return jogs;
}

/** Another position and other jogs for arterial i (after a failed fit). */
function replanArterial(plans: ArterialPlan[], i: number, R: number, maxRun: number, r: Rng): ArterialPlan {
  const plan = plans[i];
  const { lanes, jogLines } = avoidFor(plans, plan.axis, i);
  const base = plan.base + r.int(-12, 12);
  return { axis: plan.axis, base, jogs: planJogs(base, lanes, jogLines, R, maxRun, r), wide: plan.wide };
}

/**
 * As few break points along [-R, R] as keep every straight piece ≤ maxRun (and ≥ 20
 * units), each nudged ≥ 12 units away from the positions in `avoid`.
 */
function jogPositions(R: number, avoid: number[], maxRun: number, r: Rng): number[] | null {
  const clear = (t: number) => avoid.every((a) => Math.abs(a - t) >= 12);
  for (let k = 0; k <= 8; k++) {
    const pos: number[] = [];
    let ok = true;
    for (let j = 1; j <= k && ok; j++) {
      const t0 = Math.round(-R + (j * 2 * R) / (k + 1) + r.int(-3, 3));
      let t = t0;
      for (let step = 1; step < 40 && !clear(t); step++) t = t0 + (step % 2 ? 1 : -1) * Math.ceil(step / 2);
      if (!clear(t)) ok = false;
      pos.push(t);
    }
    if (!ok) continue;
    const cuts = [-R, ...pos.sort((a, b) => a - b), R];
    if (cuts.every((c, i) => i === 0 || (c - cuts[i - 1] <= maxRun * 0.97 && c - cuts[i - 1] >= 20))) return pos;
  }
  return null;
}

/** Ring polygon (grid): a square of half-size R whose sides step in and out where no arterial meets them. */
function ringPolygon(R: number, maxRun: number, plans: ArterialPlan[], r: Rng): P[] {
  // side j: point(s, level) for s ∈ [-R, R] along the side, level = inset from the square.
  const point = (j: number, s: number, l: number): P => {
    switch (j) {
      case 0:
        return [s, -R + l];
      case 1:
        return [R - l, s];
      case 2:
        return [-s, R - l];
      default:
        return [-R + l, -s];
    }
  };
  // Where arterials reach each side, in that side's coordinate.
  const end = (q: ArterialPlan) => (q.jogs.length ? q.jogs[q.jogs.length - 1].to : q.base);
  const meets: number[][] = [[], [], [], []];
  for (const q of plans) {
    if (q.axis === 0) {
      meets[0].push(q.base);
      meets[2].push(-end(q));
    } else {
      meets[3].push(-q.base);
      meets[1].push(end(q));
    }
  }
  const sides = [0, 1, 2, 3].map((j) => {
    const breaks = (jogPositions(R, meets[j], maxRun, r) ?? []).sort((a, b) => a - b);
    const levels: number[] = [r.chance(0.5) ? 0 : r.int(5, 9)];
    for (let i = 0; i < breaks.length; i++) levels.push(levels[i] === 0 ? r.int(5, 9) : 0);
    return { levels, breaks };
  });
  const poly: P[] = [];
  for (let j = 0; j < 4; j++) {
    const prev = sides[(j + 3) % 4];
    const cur = sides[j];
    poly.push(point(j, -R + prev.levels[prev.levels.length - 1], cur.levels[0]));
    cur.breaks.forEach((t, i) => {
      poly.push(point(j, t, cur.levels[i]));
      poly.push(point(j, t, cur.levels[i + 1]));
    });
  }
  return poly;
}

/** Where a line x = c (axis 0) or z = c (axis 1) crosses the polygon, sorted. Null if it runs along a side or through a corner. */
function lineHits(poly: P[], axis: 0 | 1, c: number): number[] | null {
  const hits: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (a[axis] === c) return null;
    const along = 1 - axis;
    // Sides perpendicular to the line: constant `along` coordinate, spanning c in `axis`.
    if (a[along] === b[along] && Math.min(a[axis], b[axis]) < c && c < Math.max(a[axis], b[axis])) hits.push(a[along]);
  }
  return hits.sort((p, q) => p - q);
}

/** The planned arterial as a path from ring to ring, or null if a jog would leave the town. */
function arterialPath(ring: P[], plan: ArterialPlan): P[] | null {
  const { axis, base, jogs } = plan;
  const along = 1 - axis;
  const c = jogs.length ? jogs[jogs.length - 1].to : base;
  const P2 = (cv: number, av: number): P => (axis === 0 ? [cv, av] : [av, cv]);
  // Ends on the ring at the current lateral position.
  const startHits = lineHits(ring, axis, base);
  const endHits = lineHits(ring, axis, c);
  if (!startHits || !endHits || startHits.length !== 2 || endHits.length !== 2) return null;
  const pts: P[] = [P2(base, startHits[0])];
  let cur = base;
  for (const j of jogs) {
    // The jog must stay well inside the ring (measured half a unit either side: the ring may step right there).
    for (const off of [-0.5, 0.5]) {
      const h = lineHits(ring, along as 0 | 1, j.at + off);
      if (!h || h.length !== 2 || Math.min(cur, j.to) < h[0] + 12 || Math.max(cur, j.to) > h[1] - 12) return null;
    }
    if (j.at <= pts[pts.length - 1][along] + 6) return null;
    pts.push(P2(cur, j.at), P2(j.to, j.at));
    cur = j.to;
  }
  if (endHits[1] <= pts[pts.length - 1][along] + 6) return null;
  pts.push(P2(cur, endHits[1]));
  return pts;
}

/** Parallel roads must leave blocks at least minDepth deep between them. */
function clearOfParallels(g: Graph, path: P[], cls: RoadClass, p: LayoutParams): boolean {
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    const horizontal = az === bz;
    for (const e of g.live()) {
      const A = g.nodes[g.edges[e].a];
      const B = g.nodes[g.edges[e].b];
      if (horizontal !== (A.z === B.z)) continue;
      const lo = horizontal ? Math.max(Math.min(ax, bx), Math.min(A.x, B.x)) : Math.max(Math.min(az, bz), Math.min(A.z, B.z));
      const hi = horizontal ? Math.min(Math.max(ax, bx), Math.max(A.x, B.x)) : Math.min(Math.max(az, bz), Math.max(A.z, B.z));
      if (hi - lo <= 0) continue;
      const gap = (horizontal ? Math.abs(A.z - az) : Math.abs(A.x - ax)) * UNIT;
      if (gap < halfWidth(cls) + halfWidth(g.edges[e].cls) + p.minDepth) return false;
    }
  }
  return true;
}

/** Every edge at least minGap long (junctions and bends apart). */
function spacingOk(g: Graph, minGap: number): boolean {
  for (const e of g.live()) if (g.len(e) < minGap) return false;
  return true;
}

/** Cuts an arterial at a crossing boulevard past ~half its length: everything beyond goes. Returns the T node. */
function cutArterial(g: Graph, path: P[], r: Rng): number {
  // Nodes along the path in order, with their distance along it.
  const along: { n: number; s: number; seg: number }[] = [];
  let s0 = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const [ax, az] = path[i];
    const [bx, bz] = path[i + 1];
    const L = Math.abs(bx - ax) + Math.abs(bz - az);
    for (let n = 0; n < g.nodes.length; n++) {
      const N = g.nodes[n];
      if (g.degree(n) === 0) continue;
      const on = az === bz ? N.z === az && N.x >= Math.min(ax, bx) && N.x <= Math.max(ax, bx) : N.x === ax && N.z >= Math.min(az, bz) && N.z <= Math.max(az, bz);
      if (on) along.push({ n, s: s0 + Math.abs(N.x - ax) + Math.abs(N.z - az), seg: i });
    }
    s0 += L;
  }
  const total = s0;
  const crossings = along.filter((a) => g.degree(a.n) === 4 && a.s > total * 0.4 && a.s < total * 0.75);
  if (crossings.length === 0) return -1;
  const cut = r.pick(crossings);
  // Remove path edges beyond the cut.
  const beyond = (x: number, z: number) => {
    let s = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const on = az === bz ? z === az && x >= Math.min(ax, bx) && x <= Math.max(ax, bx) : x === ax && z >= Math.min(az, bz) && z <= Math.max(az, bz);
      if (on) return s + Math.abs(x - ax) + Math.abs(z - az) > cut.s;
      s += Math.abs(bx - ax) + Math.abs(bz - az);
    }
    return false;
  };
  for (const e of g.live()) {
    const A = g.nodes[g.edges[e].a];
    const B = g.nodes[g.edges[e].b];
    if (beyond((A.x + B.x) / 2, (A.z + B.z) / 2)) g.unlink(e);
  }
  g.tidy();
  return g.degree(cut.n) === 3 ? cut.n : -1;
}

/** One street split of a face, by its district's rules: an L across a corner or a street wall to wall. */
function splitFace(g: Graph, f: Face, r: Rng, p: LayoutParams, prof: DistrictProfile, minGap: number, maxRun: number, cls: RoadClass): boolean {
  const b = bbox(f.poly);
  const longFirst = b.maxX - b.minX >= b.maxZ - b.minZ;
  return splitBlock(g, f, r, p, cls, prof.continueChance, prof.lChance, longFirst, minGap, maxRun) > 0;
}

/**
 * An alley through a block. Residential blocks get rear lanes along their long
 * side (split across the short side); elsewhere mid-block passages (across the
 * long side). Returns the alley length (grid units), 0 if none fits.
 */
function splitWithAlley(g: Graph, f: Face, r: Rng, p: LayoutParams, d: District, minGap: number, maxRun: number): number {
  const b = bbox(f.poly);
  const wide = b.maxX - b.minX >= b.maxZ - b.minZ;
  return splitBlock(g, f, r, p, 'alley', 0.15, 0, d === 'residential' ? !wide : wide, minGap, maxRun);
}

/**
 * Splits a face with one new road: an L (with chance lChance), else a straight
 * road wall to wall, else one with a sideways jog. `longFirst`: try the line
 * across the longer side first (the result: two squarer blocks). Every grid
 * position is a candidate: continuations of roads arriving from outside
 * (crossroads, preferred with continueChance) and the rest (T junctions), middle
 * positions first so blocks come out evenly sized. Returns the length added
 * (grid units), 0 if nothing fits.
 */
function splitBlock(g: Graph, f: Face, r: Rng, p: LayoutParams, cls: RoadClass, continueChance: number, lChance: number, longFirst: boolean, minGap: number, maxRun: number): number {
  const b = bbox(f.poly);
  const length = (path: P[]) => path.reduce((s, q, i) => (i ? s + Math.abs(q[0] - path[i - 1][0]) + Math.abs(q[1] - path[i - 1][1]) : 0), 0);
  if (r.chance(lChance)) {
    const l = trySplitL(g, f, r, p, minGap, maxRun, cls);
    if (l) return length(l);
  }
  const wantCross = r.chance(continueChance);
  const wide = b.maxX - b.minX >= b.maxZ - b.minZ;
  // Axis 0 = a line x = c, which splits the x extent.
  const axes = (wide === longFirst ? [0, 1] : [1, 0]) as (0 | 1)[];
  const positions = (axis: 0 | 1) => {
    const lo = axis === 0 ? b.minX : b.minZ;
    const hi = axis === 0 ? b.maxX : b.maxZ;
    const cont = new Set<number>();
    for (const side of f.sideNodes) for (const n of side.slice(1, -1)) cont.add(axis === 0 ? g.nodes[n].x : g.nodes[n].z);
    const mid = (lo + hi) / 2;
    const scored: { c: number; score: number }[] = [];
    for (let c = lo + 1; c < hi; c++) {
      // Distance from the middle plus noise; continuations first or last.
      let score = Math.abs(c - mid) / (hi - lo) + r.next() * 0.35;
      if (cont.has(c)) score += wantCross ? -1 : 1;
      scored.push({ c, score });
    }
    return scored.sort((a, z) => a.score - z.score).map((s) => s.c);
  };
  for (const axis of axes) {
    for (const c of positions(axis)) {
      const seg = straightCandidate(g, f, axis, c, cls, p, minGap, maxRun);
      if (seg && tryInsert(g, seg, cls, p)) return length(seg);
    }
  }
  // Too wide for one straight road: one with a sideways jog in the middle.
  for (const axis of axes) {
    for (const c of positions(axis)) {
      const path = jogCandidate(g, f, axis, c, cls, p, minGap, maxRun);
      if (path && tryInsert(g, path, cls, p)) return length(path);
    }
  }
  return 0;
}

/** Inserts a path, keeping it only if every block it touches stays a usable shape. */
function tryInsert(g: Graph, path: P[], cls: RoadClass, p: LayoutParams): boolean {
  const snap = g.clone();
  if (!g.insertPath(path, cls)) return false;
  if (blocksOk(g, path, p)) return true;
  g.restore(snap);
  return false;
}

/**
 * Blocks next to a path: lot polygon not inverted, and no neck narrower than
 * 2/3 of minDepth (two sides facing each other across the inside of the block).
 */
function blocksOk(g: Graph, path: P[], p: LayoutParams): boolean {
  const touched = new Set<number>();
  for (let i = 0; i + 1 < path.length; i++) {
    for (let n = 0; n < g.nodes.length; n++) if (g.degree(n) > 0 && onSeg([g.nodes[n].x, g.nodes[n].z], path[i], path[i + 1])) touched.add(n);
  }
  for (const f of faces(g)) {
    if (!f.half.some((h) => touched.has(h.from))) continue;
    const centre = f.poly.map(([x, z]) => [x * UNIT, z * UNIT] as [number, number]);
    const lot = offsetRectilinear(centre, f.sides.map((c) => halfWidth(c)));
    if (Math.sign(polygonArea(lot)) !== Math.sign(polygonArea(centre)) || Math.abs(polygonArea(lot)) < 400) return false;
    if (selfIntersects(lot) || narrowest(lot) < (p.minDepth * 2) / 3) return false;
  }
  return true;
}

/** Do two non-adjacent sides of a rectilinear polygon cross (an inset that folded over itself)? */
function selfIntersects(poly: [number, number][]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = poly[i];
    const [bx, bz] = poly[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const [cx, cz] = poly[j];
      const [dx, dz] = poly[(j + 1) % n];
      const h1 = Math.abs(az - bz) < 1e-6;
      const h2 = Math.abs(cz - dz) < 1e-6;
      if (h1 === h2) continue;
      // One horizontal, one vertical: crossing strictly inside both.
      const [hx0, hx1, hz] = h1 ? [Math.min(ax, bx), Math.max(ax, bx), az] : [Math.min(cx, dx), Math.max(cx, dx), cz];
      const [vz0, vz1, vx] = h1 ? [Math.min(cz, dz), Math.max(cz, dz), cx] : [Math.min(az, bz), Math.max(az, bz), ax];
      if (vx > hx0 + 1e-6 && vx < hx1 - 1e-6 && hz > vz0 + 1e-6 && hz < vz1 - 1e-6) return true;
    }
  }
  return false;
}

/** Narrowest inside width of a rectilinear polygon: parallel sides facing each other across the inside. */
function narrowest(poly: [number, number][]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % poly.length];
    const hz = Math.abs(a1[1] - a2[1]) < 1e-6;
    for (let j = i + 1; j < poly.length; j++) {
      const c1 = poly[j];
      const c2 = poly[(j + 1) % poly.length];
      if ((Math.abs(c1[1] - c2[1]) < 1e-6) !== hz) continue;
      const k = hz ? 0 : 1;
      const lo = Math.max(Math.min(a1[k], a2[k]), Math.min(c1[k], c2[k]));
      const hi = Math.min(Math.max(a1[k], a2[k]), Math.max(c1[k], c2[k]));
      if (hi - lo <= 1e-6) continue;
      const d = Math.abs(hz ? c1[1] - a1[1] : c1[0] - a1[0]);
      // Two sides on one line, overlapping: the block pinches to nothing there.
      if (d < 1e-6) return 0;
      if (d >= min) continue;
      // Only if the space between them is inside the polygon (a neck), not a notch outside.
      const m = (lo + hi) / 2;
      const mid: [number, number] = hz ? [m, (a1[1] + c1[1]) / 2] : [(a1[0] + c1[0]) / 2, m];
      if (pointInPoly(mid, poly)) min = d;
    }
  }
  return min;
}

/**
 * A street across the face along line c that jogs sideways halfway (two 90° bends),
 * for faces too wide for one straight run.
 */
function jogCandidate(g: Graph, f: Face, axis: 0 | 1, c: number, cls: RoadClass, p: LayoutParams, minGap: number, maxRun: number): P[] | null {
  const hits = lineHits(f.poly, axis, c);
  if (!hits || hits.length < 2) return null;
  const P2 = (cv: number, av: number): P => (axis === 0 ? [cv, av] : [av, cv]);
  const dir = axis === 0 ? 1 : 0;
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const [h0, h1] = [hits[i], hits[i + 1]];
    if (h1 - h0 < 3 * minGap) continue;
    // Bend points from the middle outwards, both sides, a few jog widths.
    const span = h1 - h0;
    const tries: { m: number; c2: number }[] = [];
    for (const t of [0.5, 0.42, 0.58, 0.35, 0.65]) for (const d of [6, 8, 10, 12]) for (const sign of [1, -1]) tries.push({ m: Math.round(h0 + span * t), c2: c + sign * d });
    for (const { m, c2 } of tries) {
      const hits2 = lineHits(f.poly, axis, c2);
      if (!hits2) continue;
      let k1: number | null = null;
      for (let j = 0; j + 1 < hits2.length; j += 2) if (hits2[j] < m && m < hits2[j + 1]) k1 = hits2[j + 1];
      if (k1 === null || m - h0 < minGap || k1 - m < minGap) continue;
      const path: P[] = [P2(c, h0), P2(c, m), P2(c2, m), P2(c2, k1)];
      const legs: P[][] = [path.slice(0, 2), path.slice(1, 3), path.slice(2, 4)];
      if (!legs.every((l) => insideFace(f, l) && segmentValid(g, f, l, cls, p, minGap))) continue;
      // Straight runs of both long legs, continued through the junctions at their ends.
      const end0 = g.nodeAt(...path[0]);
      const end1 = g.nodeAt(...path[3]);
      const run0 = m - h0 + (end0 !== undefined ? g.run(end0, (dir + 2) % 4) : 0);
      const run1 = k1 - m + (end1 !== undefined ? g.run(end1, dir) : 0);
      if (run0 <= maxRun && run1 <= maxRun) return path;
    }
  }
  return null;
}

/** An inside interval of the line through the face that makes a valid street (longest first). */
function straightCandidate(g: Graph, f: Face, axis: 0 | 1, c: number, cls: RoadClass, p: LayoutParams, minGap: number, maxRun: number): P[] | null {
  const hits = lineHits(f.poly, axis, c);
  if (!hits || hits.length < 2) return null;
  const intervals: [number, number][] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) intervals.push([hits[i], hits[i + 1]]);
  intervals.sort((a, z) => z[1] - z[0] - (a[1] - a[0]));
  const P2 = (av: number): P => (axis === 0 ? [c, av] : [av, c]);
  const dir = axis === 0 ? 1 : 0;
  for (const [h0, h1] of intervals) {
    const seg: P[] = [P2(h0), P2(h1)];
    if (!segmentValid(g, f, seg, cls, p, minGap)) continue;
    // Straight run through the junctions at both ends.
    let run = h1 - h0;
    const end0 = g.nodeAt(...seg[0]);
    const end1 = g.nodeAt(...seg[1]);
    if (end0 !== undefined) run += g.run(end0, (dir + 2) % 4);
    if (end1 !== undefined) run += g.run(end1, dir);
    if (run <= maxRun) return seg;
  }
  return null;
}

/**
 * Checks for a new street segment inside a face: its ends land on the face's sides
 * at least minGap from other nodes (or exactly on one: a crossroads), and parallel
 * sides it runs along are far enough for a block between them.
 */
function segmentValid(g: Graph, f: Face, seg: P[], cls: RoadClass, p: LayoutParams, minGap: number): boolean {
  const [a, b] = seg;
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < minGap) return false;
  for (const end of [a, b]) {
    const n = g.nodeAt(end[0], end[1]);
    if (n !== undefined && g.degree(n) > 0) {
      // Joining an existing node: only where a street arrives from outside (crossroads), never at a bend.
      if (g.degree(n) !== 3 || g.locked.has(n)) return false;
      continue;
    }
    // Distance to the nodes on the side it lands on.
    for (const side of f.sideNodes) {
      const pts = side.map((id) => g.nodes[id]);
      const onSide = pts.some((q, i) => i + 1 < pts.length && onSeg(end, [q.x, q.z], [pts[i + 1].x, pts[i + 1].z]));
      if (!onSide) continue;
      for (const q of pts) if (Math.abs(q.x - end[0]) + Math.abs(q.z - end[1]) < minGap) return false;
    }
  }
  // Parallel sides of the face along the segment.
  const horizontal = a[1] === b[1];
  for (let i = 0; i < f.poly.length; i++) {
    const q1 = f.poly[i];
    const q2 = f.poly[(i + 1) % f.poly.length];
    if ((q1[1] === q2[1]) !== horizontal) continue;
    const k = horizontal ? 0 : 1;
    const lo = Math.max(Math.min(a[k], b[k]), Math.min(q1[k], q2[k]));
    const hi = Math.min(Math.max(a[k], b[k]), Math.max(q1[k], q2[k]));
    if (hi - lo <= 0) continue;
    const gap = Math.abs(horizontal ? q1[1] - a[1] : q1[0] - a[0]) * UNIT;
    if (gap < halfWidth(cls) + halfWidth(f.sides[i]) + p.minDepth) return false;
  }
  return true;
}

function onSeg(p: P, a: P, b: P): boolean {
  if (a[1] === b[1]) return p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]);
  return p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

/** Cuts a convex corner of the face off with an L-shaped street (a 90° bend inside the block). */
function trySplitL(g: Graph, f: Face, r: Rng, p: LayoutParams, minGap: number, maxRun: number, cls: RoadClass): P[] | null {
  const n = f.poly.length;
  const s = Math.sign(polygonArea(f.poly));
  const corners = r.shuffle([...Array(n).keys()]);
  for (const i of corners) {
    const C = f.poly[i];
    const prev = f.poly[(i - 1 + n) % n];
    const next = f.poly[(i + 1) % n];
    const e1: P = [Math.sign(next[0] - C[0]), Math.sign(next[1] - C[1])];
    const e2: P = [Math.sign(prev[0] - C[0]), Math.sign(prev[1] - C[1])];
    // Convex corner: the interior lies between e1 and e2 (cross product sign matches the face orientation).
    if (Math.sign(e1[0] * e2[1] - e1[1] * e2[0]) !== s) continue;
    const lenNext = Math.abs(next[0] - C[0]) + Math.abs(next[1] - C[1]);
    const lenPrev = Math.abs(prev[0] - C[0]) + Math.abs(prev[1] - C[1]);
    const prevCls = f.sides[(i - 1 + n) % n];
    const nextCls = f.sides[i];
    const aMin = Math.ceil((halfWidth(prevCls) + halfWidth(cls) + p.minDepth) / UNIT);
    const bMin = Math.ceil((halfWidth(nextCls) + halfWidth(cls) + p.minDepth) / UNIT);
    if (lenNext - minGap < aMin || lenPrev - minGap < bMin) continue;
    for (let t = 0; t < 6; t++) {
      const a = r.int(aMin, Math.min(lenNext - minGap, aMin + 10));
      const b = r.int(bMin, Math.min(lenPrev - minGap, bMin + 10));
      const P1: P = [C[0] + a * e1[0], C[1] + a * e1[1]];
      const B: P = [P1[0] + b * e2[0], P1[1] + b * e2[1]];
      const P2: P = [C[0] + b * e2[0], C[1] + b * e2[1]];
      if (!insideFace(f, [P1, B]) || !insideFace(f, [B, P2])) continue;
      if (!segmentValid(g, f, [P1, B], cls, p, minGap) || !segmentValid(g, f, [B, P2], cls, p, minGap)) continue;
      // A leg landing on a T continues the street beyond it: keep that straight run short too.
      const n1 = g.nodeAt(...P1);
      const n2 = g.nodeAt(...P2);
      if (n1 !== undefined && b + g.run(n1, dirOf(B[0], B[1], P1[0], P1[1])) > maxRun) continue;
      if (n2 !== undefined && a + g.run(n2, dirOf(B[0], B[1], P2[0], P2[1])) > maxRun) continue;
      if (tryInsert(g, [P1, B, P2], cls, p)) return [P1, B, P2];
    }
  }
  return null;
}

/** The segment's interior does not touch any side of the face. */
function insideFace(f: Face, seg: P[]): boolean {
  const [a, b] = seg;
  const steps = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  for (let k = 1; k < steps; k++) {
    const q: P = [a[0] + (Math.sign(b[0] - a[0]) * k), a[1] + (Math.sign(b[1] - a[1]) * k)];
    for (let i = 0; i < f.poly.length; i++) if (onSeg(q, f.poly[i], f.poly[(i + 1) % f.poly.length])) return false;
  }
  return pointInPoly([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], f.poly);
}

function pointInPoly(q: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > q[1] !== zj > q[1] && q[0] < ((xj - xi) * (q[1] - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// --- result -------------------------------------------------------------------------------------

function finish(g: Graph, p: LayoutParams, ring: P[], vistaNodes: number[], districts: DistrictMap, large: LargeMark[], arterials: number): CityLayout {
  // Compact ids.
  const nodeId = new Map<number, number>();
  const nodes: LayoutNode[] = [];
  for (let n = 0; n < g.nodes.length; n++) {
    if (g.degree(n) === 0) continue;
    nodeId.set(n, nodes.length);
    const o = g.nodes[n].out;
    const deg = g.degree(n);
    const kind: NodeKind = deg === 4 ? 'cross' : deg === 3 ? 'tee' : (o[0] >= 0 && o[2] >= 0) || (o[1] >= 0 && o[3] >= 0) ? 'pass' : 'bend';
    nodes.push({ id: nodes.length, x: g.nodes[n].x * UNIT, z: g.nodes[n].z * UNIT, kind, out: [-1, -1, -1, -1] });
  }
  const edgeId = new Map<number, number>();
  const edges: LayoutEdge[] = [];
  for (const e of g.live()) {
    edgeId.set(e, edges.length);
    const E = g.edges[e];
    edges.push({ id: edges.length, a: nodeId.get(E.a)!, b: nodeId.get(E.b)!, cls: E.cls, rank: E.rank, length: g.len(e) * UNIT });
  }
  for (const [old, id] of nodeId) nodes[id].out = g.nodes[old].out.map((e) => (e >= 0 ? edgeId.get(e)! : -1)) as LayoutNode['out'];

  const vistas = vistaNodes.filter((n) => nodeId.has(n)).map((n) => nodeId.get(n)!);
  const blocks: LayoutBlock[] = faces(g).map((f, i) => {
    const centre = f.poly.map(([x, z]) => [x * UNIT, z * UNIT] as [number, number]);
    const [cx, cz] = centroid(f.poly);
    const district = districts.at(cx * UNIT, cz * UNIT);
    // The block's own sidewalk (its district's width) along every side but alleys.
    const sidewalk = SIDEWALK[district];
    const kerb = offsetRectilinear(centre, f.sides.map((c) => kerbOffset(c)));
    const lot = offsetRectilinear(centre, f.sides.map((c) => kerbOffset(c) + (ROAD_PROFILE[c].sidewalk ? sidewalk : 0)));
    return {
      id: i,
      kind: large.some((m) => pointInPoly([m.x, m.z], f.poly)) ? ('large' as BlockKind) : ('buildings' as BlockKind),
      district,
      sidewalk,
      centre,
      sides: f.sides,
      kerb,
      lot,
      area: Math.abs(polygonArea(lot)),
      edges: f.half.map((h) => edgeId.get(h.e)!),
      landmark: false,
    };
  });
  // The landmark block is the one the boulevard looks at: just across the through road, opposite the stem of the T.
  for (const v of vistas) {
    const N = nodes[v];
    const stem = N.out.findIndex((e, d) => e >= 0 && N.out[(d + 2) % 4] < 0);
    if (stem < 0) continue;
    const through = edges[N.out[(stem + 1) % 4]].cls;
    const d = halfWidth(through) + 2;
    const across: [number, number] = [N.x - DX[stem] * d, N.z - DZ[stem] * d];
    const blk = blocks.find((b) => pointInPoly(across, b.lot));
    if (blk) blk.landmark = true;
  }
  assignUses(blocks, p, districts);
  const centreRing = ring.map(([x, z]) => [x * UNIT, z * UNIT] as [number, number]);
  const outline = {
    centre: centreRing,
    kerb: offsetRectilinear(centreRing, centreRing.map(() => -kerbOffset('boulevard'))),
    edge: offsetRectilinear(centreRing, centreRing.map(() => -(kerbOffset('boulevard') + RING_OUTER_SIDEWALK))),
  };
  const bb = bbox(outline.edge);
  return { params: p, nodes, edges, blocks, outline, vistas, districts: districts.centres, arterials, bounds: { minX: bb.minX, minZ: bb.minZ, maxX: bb.maxX, maxZ: bb.maxZ } };
}

export function centroid(poly: [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const q of poly) {
    x += q[0];
    z += q[1];
  }
  return [x / poly.length, z / poly.length];
}

/** Lot width × depth of a block's bounding box, m (short side first). */
function lotSize(b: LayoutBlock): [number, number] {
  const bb = bbox(b.lot);
  const w = bb.maxX - bb.minX;
  const h = bb.maxZ - bb.minZ;
  return [Math.min(w, h), Math.max(w, h)];
}

/**
 * Uses of the large parcels (from their district: malls and stadiums in commercial
 * areas, factories and warehouses in industry, parks in residential areas...),
 * at least one park and one car park in town, and the downtown plaza.
 */
function assignUses(blocks: LayoutBlock[], p: LayoutParams, districts: DistrictMap): void {
  const r = stream(p.seed, 'uses');
  const big = blocks.filter((b) => b.kind === 'large');
  for (const b of big) {
    const uses = DISTRICT[b.district].uses;
    // Most likely use first: half the time, else any.
    let use = r.chance(0.5) ? uses[0] : r.pick(uses);
    const [short, long] = lotSize(b);
    if (use === 'stadium' && (short < 95 || long < 125 || b.lot.length !== 4)) use = 'mall';
    if (use === 'landmark' && b.lot.length !== 4) use = 'hospital';
    b.use = use;
  }
  const has = (u: ParcelUse) => big.some((b) => b.use === u);
  const pickFor = (u: ParcelUse, prefer: District[]) => {
    if (has(u)) return;
    // Another large parcel in a fitting district whose use is not unique, else a plain block that is big enough.
    const counts = (x?: ParcelUse) => big.filter((b) => b.use === x).length;
    const swap = big.filter((b) => prefer.includes(b.district) && counts(b.use) > 1)[0];
    if (swap) {
      swap.use = u;
      return;
    }
    const plain = r.shuffle(blocks.filter((b) => b.kind === 'buildings' && !b.landmark && prefer.includes(b.district) && b.lot.length === 4 && b.area >= 5000));
    if (plain[0]) {
      plain[0].kind = 'large';
      plain[0].use = u;
      big.push(plain[0]);
    }
  };
  pickFor('park', ['residential', 'commercial', 'downtown']);
  pickFor('parking', ['commercial', 'industrial', 'downtown']);
  // Plaza: a compact downtown block nearest the downtown centre.
  const dc = districts.centres.find((c) => c.kind === 'downtown')!;
  const plaza = blocks
    .filter((b) => b.kind === 'buildings' && !b.landmark && b.district === 'downtown' && b.lot.length === 4 && b.area >= 1500 && b.area <= 9000)
    .sort((a, b) => Math.hypot(centroid(a.lot)[0] - dc.x, centroid(a.lot)[1] - dc.z) - Math.hypot(centroid(b.lot)[0] - dc.x, centroid(b.lot)[1] - dc.z))[0];
  if (plaza) plaza.kind = 'plaza';
}

// --- checks -------------------------------------------------------------------------------------

export interface LayoutStats {
  nodes: Record<NodeKind, number>;
  /** Road length by class and by rank, m. */
  length: Record<RoadClass, number>;
  rankLength: Record<RoadRank, number>;
  /** Main arterials placed. */
  arterials: number;
  blocks: Record<BlockKind, number>;
  /** Blocks and mean lot area (m², plain building blocks only) per district. */
  districts: Record<District, { blocks: number; meanArea: number }>;
  uses: Partial<Record<ParcelUse, number>>;
  connected: boolean;
  deadEnds: number;
  /** Shortest edge (junction / bend spacing), m. */
  minEdge: number;
  /** Longest straight run of a street / alley, of the ring and of an arterial, m. */
  maxStraight: number;
  maxRingStraight: number;
  maxArterialStraight: number;
  /** Shortest straight piece of an arterial (between jogs, ring or the vista T), m. */
  minArterialPiece: number;
  /** Block lot areas, m². */
  minBlockArea: number;
  maxBlockArea: number;
  /** Narrowest inside width of any block lot, m. */
  minBlockSide: number;
  landmarks: number;
}

export function layoutStats(l: CityLayout): LayoutStats {
  const nodes: Record<NodeKind, number> = { cross: 0, tee: 0, bend: 0, pass: 0 };
  for (const n of l.nodes) nodes[n.kind]++;
  const length = Object.fromEntries(ROAD_CLASSES.map((c) => [c, 0])) as Record<RoadClass, number>;
  const rankLength: Record<RoadRank, number> = { ring: 0, arterial: 0, local: 0 };
  for (const e of l.edges) {
    length[e.cls] += e.length;
    rankLength[e.rank] += e.length;
  }
  const blocks: Record<BlockKind, number> = { buildings: 0, plaza: 0, large: 0 };
  for (const b of l.blocks) blocks[b.kind]++;
  const districts = Object.fromEntries(DISTRICTS.map((d) => {
    const own = l.blocks.filter((b) => b.district === d);
    const plain = own.filter((b) => b.kind === 'buildings' && !b.landmark);
    return [d, { blocks: own.length, meanArea: plain.length ? Math.round(plain.reduce((s, b) => s + b.area, 0) / plain.length) : 0 }];
  })) as LayoutStats['districts'];
  const uses: LayoutStats['uses'] = {};
  for (const b of l.blocks) if (b.use) uses[b.use] = (uses[b.use] ?? 0) + 1;
  // Connectivity.
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of l.nodes[n].out) {
      if (e < 0) continue;
      const o = l.edges[e].a === n ? l.edges[e].b : l.edges[e].a;
      if (!seen.has(o)) {
        seen.add(o);
        stack.push(o);
      }
    }
  }
  const deadEnds = l.nodes.filter((n) => n.out.filter((e) => e >= 0).length === 1).length;
  // Straight runs: walk each line from its start node.
  let maxStraight = 0;
  let maxRingStraight = 0;
  let maxArterialStraight = 0;
  for (const n of l.nodes) {
    for (const d of [0, 1]) {
      if (n.out[d] < 0 || n.out[d + 2] >= 0) continue;
      let len = 0;
      let cur = n.id;
      for (let guard = 0; guard < 100000; guard++) {
        const e = l.nodes[cur].out[d];
        if (e < 0) break;
        len += l.edges[e].length;
        cur = l.edges[e].a === cur ? l.edges[e].b : l.edges[e].a;
      }
      const rank = l.edges[n.out[d]].rank;
      if (rank === 'ring') maxRingStraight = Math.max(maxRingStraight, len);
      else if (rank === 'arterial') maxArterialStraight = Math.max(maxArterialStraight, len);
      else maxStraight = Math.max(maxStraight, len);
    }
  }
  // Arterial pieces: straight arterial runs between bends / ends (not through crossings).
  let minArterialPiece = Infinity;
  for (const n of l.nodes) {
    for (let d = 0; d < 4; d++) {
      const e0 = n.out[d];
      if (e0 < 0 || l.edges[e0].rank !== 'arterial') continue;
      const back = n.out[(d + 2) % 4];
      if (back >= 0 && l.edges[back].rank === 'arterial') continue;
      let len = 0;
      let cur = n.id;
      for (let guard = 0; guard < 100000; guard++) {
        const e = l.nodes[cur].out[d];
        if (e < 0 || l.edges[e].rank !== 'arterial') break;
        len += l.edges[e].length;
        cur = l.edges[e].a === cur ? l.edges[e].b : l.edges[e].a;
      }
      minArterialPiece = Math.min(minArterialPiece, len);
    }
  }
  const minBlockSide = Math.min(...l.blocks.map((b) => narrowest(b.lot)));
  return {
    nodes,
    length: Object.fromEntries(ROAD_CLASSES.map((c) => [c, Math.round(length[c])])) as Record<RoadClass, number>,
    rankLength: { ring: Math.round(rankLength.ring), arterial: Math.round(rankLength.arterial), local: Math.round(rankLength.local) },
    arterials: l.arterials,
    blocks,
    districts,
    uses,
    connected: seen.size === l.nodes.length,
    deadEnds,
    minEdge: Math.min(...l.edges.map((e) => e.length)),
    maxStraight,
    maxRingStraight,
    maxArterialStraight,
    minArterialPiece,
    minBlockArea: Math.round(Math.min(...l.blocks.map((b) => b.area))),
    maxBlockArea: Math.round(Math.max(...l.blocks.map((b) => b.area))),
    minBlockSide: Math.round(minBlockSide * 10) / 10,
    landmarks: l.blocks.filter((b) => b.landmark).length,
  };
}
