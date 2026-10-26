/**
 * City V2 ground from the layout: streets, sidewalks, kerbs, block lots, the
 * land around the town, lane markings, and the colliders under them.
 *
 * Visual surfaces come from a 3 m raster (every layout coordinate is a multiple
 * of 3 m: centre lines on the 6 m grid, half-widths 3 / 6 / 9 m). Each raster
 * cell is exactly one thing (asphalt, sidewalk, lot, land), so junctions,
 * bends and T's join without gaps and nothing lies on top of anything else:
 * no coplanar overlaps, no z-fighting. Same-kind cells are merged into
 * rectangles per 250 m cell. Convex kerb corners between two sidewalks are
 * rounded like the kit's Sidewalk_Corner_Round_3m (radius 3 m around the lot
 * corner): that one raster cell becomes a quarter disc of sidewalk plus an
 * asphalt fillet.
 *
 * Heights follow the kit: asphalt at 0, sidewalks / lots / land 0.15 m higher,
 * vertical kerb faces between them. Lane markings are separate geometry 12 mm
 * above the asphalt (the Autobahn's `markings.lift`), drawn with polygon
 * offset (see CityV2Track).
 *
 * Colliders do not copy the vertical kerb: a 15 cm step under a raycast wheel
 * is a sudden 15 cm compression (a kick) going up, and a drop the wheel cannot
 * follow coming down. A sloped strip runs across every kerb line, from
 * RAMP_OUT out on the asphalt (the asphalt collider continues underneath: a
 * ray meets the strip first) to RAMP_IN inside the block, whose top is the
 * kerb outline inset by RAMP_IN: 15 cm over 2.4 m (≈ 3.6°), so a wheel rolls
 * on and, more importantly, off a kerb at 70 km/h without losing the ground.
 * RAMP_OUT is short so a car in its lane (wheels ≈ 0.7 m from the kerb) is not
 * touched; RAMP_IN stays inside the 3 m sidewalk. The visual kerb stays
 * vertical; near it the wheel sits a few centimetres off the drawn surface.
 */
import * as THREE from 'three';
import { ROAD_PROFILE, kerbOffset, medianHalf } from '../../../src/world/cityv2/roadProfiles';
import { offsetRectilinear, polygonArea, type CityLayout, type LayoutBlock, type LayoutEdge } from './layout';

/** Heights, m. */
export const LEVEL = { asphalt: 0, raised: 0.15, marking: 0.012 };
/** Streaming cell (the first city's size), m. */
export const CELL = 250;
/** Raster resolution, m: every road, median and sidewalk width is a multiple of it (roadProfiles.ts). */
const G = 0.5;
/** Segments per rounded kerb corner (radius = the block's sidewalk width). */
const ARC = 8;
/** Collider kerb ramp: from this far out on the asphalt to this far inside the block, m (15 cm over 2.4 m). */
export const RAMP_OUT = 0.5;
export const RAMP_IN = 1.9;
/** Land around the town, m beyond the ring's outer sidewalk. */
export const MARGIN = 120;

export type GroundMat = 'asphalt' | 'sidewalk' | 'lot' | 'park' | 'plaza' | 'parking' | 'land' | 'median' | 'marking';

/** Raster labels. */
const NONE = 0;
const ASPHALT = 1;
const SIDEWALK = 2;
const LOT = 3;
const PARK = 4;
const PLAZA = 5;
const PARKING = 6;
const LAND = 7;
const CORNER = 8;
const MEDIAN = 9;
/** Raster labels, for code outside this file (prop placement). */
export const RASTER = { NONE, ASPHALT, SIDEWALK, LOT, PARK, PLAZA, PARKING, LAND, CORNER, MEDIAN } as const;
const LABEL_MAT: Record<number, GroundMat> = { [ASPHALT]: 'asphalt', [SIDEWALK]: 'sidewalk', [LOT]: 'lot', [PARK]: 'park', [PLAZA]: 'plaza', [PARKING]: 'parking', [LAND]: 'land', [MEDIAN]: 'median' };
const raised = (l: number) => l !== NONE && l !== ASPHALT && l !== CORNER;
/** Texture repeat, m per tile. */
const TILE: Record<GroundMat, number> = { asphalt: 6, sidewalk: 3, lot: 8, park: 6, plaza: 4, parking: 6, land: 10, median: 6, marking: 1 };

export class MeshBuf {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  /** Linear RGB per vertex (lane markings only). */
  col: number[] | null = null;

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }

  /** A vertex with a colour (every vertex of the buffer must then have one). */
  vertColour(x: number, y: number, z: number, rgb: readonly [number, number, number]): number {
    (this.col ??= []).push(...rgb);
    return this.vert(x, y, z, 0, 1, 0, 0, 0);
  }

  /** Triangle, wound counter-clockwise seen from where its normal points. */
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  get tris(): number {
    return this.idx.length / 3;
  }
}

/** Collider triangles (welded per cell later by the writer). */
export class ColliderBuf {
  pos: number[] = [];
  idx: number[] = [];

  vert(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
}

export interface GroundCell {
  key: string;
  cx: number;
  cz: number;
  meshes: Map<GroundMat, MeshBuf>;
  collider: ColliderBuf;
  /** Extent of everything in this cell (x/z), m: streaming distance is measured to it. */
  bounds: [number, number, number, number];
}

export interface Ground {
  cells: Map<string, GroundCell>;
  /** The land and the ring's outer kerb ramp: one always-on collider, and walls around the land. */
  outer: ColliderBuf;
  walls: { x: number; z: number; hx: number; hz: number }[];
  /** World rectangle covered (land edge), m. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** The label raster (RASTER values, `res` m cells from (minX, minZ)): what each piece of ground is, for prop placement. */
  raster: GroundRaster;
}

export interface GroundRaster {
  lab: Uint8Array;
  W: number;
  H: number;
  minX: number;
  minZ: number;
  res: number;
}

/** Upward-facing triangles from earcut in x/z (earcut winding is not reliable for our purpose). */
function upTri(b: { tri(a: number, b: number, c: number): void }, p: number[], a: number, c: number, d: number): void {
  const ax = p[a * 3];
  const az = p[a * 3 + 2];
  const cross = (p[c * 3] - ax) * (p[d * 3 + 2] - az) - (p[c * 3 + 2] - az) * (p[d * 3] - ax);
  // Normal +y needs (c - a) × (d - a) to point up: x/z cross product negative.
  if (cross < 0) b.tri(a, c, d);
  else b.tri(a, d, c);
}

export function buildGround(l: CityLayout): Ground {
  const minX = Math.floor((l.bounds.minX - MARGIN) / G) * G;
  const minZ = Math.floor((l.bounds.minZ - MARGIN) / G) * G;
  const maxX = Math.ceil((l.bounds.maxX + MARGIN) / G) * G;
  const maxZ = Math.ceil((l.bounds.maxZ + MARGIN) / G) * G;
  const W = (maxX - minX) / G;
  const H = (maxZ - minZ) / G;
  const lab = new Uint8Array(W * H).fill(LAND);
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= W || j >= H ? NONE : lab[j * W + i]);

  /** Fills the cells whose centres are inside a rectilinear polygon (corners on the raster grid). */
  const fill = (poly: [number, number][], label: number) => {
    let zLo = Infinity;
    let zHi = -Infinity;
    for (const [, z] of poly) {
      zLo = Math.min(zLo, z);
      zHi = Math.max(zHi, z);
    }
    for (let j = Math.max(0, Math.round((zLo - minZ) / G)); j < Math.min(H, Math.round((zHi - minZ) / G)); j++) {
      const zc = minZ + (j + 0.5) * G;
      const xs: number[] = [];
      for (let k = 0; k < poly.length; k++) {
        const [x1, z1] = poly[k];
        const [x2, z2] = poly[(k + 1) % poly.length];
        if (x1 === x2 && Math.min(z1, z2) < zc && zc < Math.max(z1, z2)) xs.push(x1);
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.round((xs[k] - minX) / G); i < Math.round((xs[k + 1] - minX) / G); i++) lab[j * W + i] = label;
      }
    }
  };

  fill(l.outline.edge, SIDEWALK);
  fill(l.outline.kerb, ASPHALT);
  const lotLabel = (b: LayoutBlock) => (b.kind === 'plaza' ? PLAZA : b.use === 'park' ? PARK : b.use === 'parking' ? PARKING : LOT);
  for (const b of l.blocks) {
    fill(b.kerb, SIDEWALK);
    fill(b.lot, lotLabel(b));
  }
  // Medians: a raised island down the middle of the divided roads, open at every junction (left turns, crossings),
  // continuous round bends (each edge's island runs to the bend point plus half its width: they meet in a square).
  const medians = medianRects(l);
  for (const m of medians) fill(m.poly, MEDIAN);

  // Rounded corners: convex kerb corners with a sidewalk on both sides.
  interface Corner {
    K: [number, number];
    L: [number, number];
    u1: [number, number];
    u2: [number, number];
    /** Radius: the block's sidewalk width. */
    r: number;
  }
  const corners: Corner[] = [];
  const blockCorners = new Map<LayoutBlock, Set<number>>();
  for (const b of l.blocks) {
    const n = b.kerb.length;
    const s = Math.sign(polygonArea(b.kerb));
    const set = new Set<number>();
    for (let i = 0; i < n; i++) {
      const prev = b.kerb[(i - 1 + n) % n];
      const K = b.kerb[i];
      const next = b.kerb[(i + 1) % n];
      const cross = (K[0] - prev[0]) * (next[1] - K[1]) - (K[1] - prev[1]) * (next[0] - K[0]);
      if (Math.sign(cross) !== s) continue;
      if (!ROAD_PROFILE[b.sides[(i - 1 + n) % n]].sidewalk || !ROAD_PROFILE[b.sides[i]].sidewalk) continue;
      // Outward normals (towards the street) of the side before the corner (u1) and after it (u2):
      // K = L + w·u1 + w·u2 (w: the block's sidewalk), so each is the part of K − L across its side.
      const L = b.lot[i];
      const prevHorizontal = prev[1] === K[1];
      const u1: [number, number] = prevHorizontal ? [0, Math.sign(K[1] - L[1])] : [Math.sign(K[0] - L[0]), 0];
      const u2: [number, number] = prevHorizontal ? [Math.sign(K[0] - L[0]), 0] : [0, Math.sign(K[1] - L[1])];
      corners.push({ K, L, u1, u2, r: b.sidewalk });
      set.add(i);
      // The w × w square between the kerb corner and the lot corner is drawn by the corner itself.
      for (let cj = Math.round((Math.min(K[1], L[1]) - minZ) / G); cj < Math.round((Math.max(K[1], L[1]) - minZ) / G); cj++) {
        for (let ci = Math.round((Math.min(K[0], L[0]) - minX) / G); ci < Math.round((Math.max(K[0], L[0]) - minX) / G); ci++) lab[cj * W + ci] = CORNER;
      }
    }
    blockCorners.set(b, set);
  }

  // --- visual surfaces -----------------------------------------------------------------------------
  const cells = new Map<string, GroundCell>();
  const cellOf = (x: number, z: number): GroundCell => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const key = `${cx},${cz}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { key, cx, cz, meshes: new Map(), collider: new ColliderBuf(), bounds: [Infinity, Infinity, -Infinity, -Infinity] }));
    return c;
  };
  const grow = (c: GroundCell, x: number, z: number) => {
    c.bounds[0] = Math.min(c.bounds[0], x);
    c.bounds[1] = Math.min(c.bounds[1], z);
    c.bounds[2] = Math.max(c.bounds[2], x);
    c.bounds[3] = Math.max(c.bounds[3], z);
  };
  const mesh = (c: GroundCell, m: GroundMat): MeshBuf => {
    let b = c.meshes.get(m);
    if (!b) c.meshes.set(m, (b = new MeshBuf()));
    return b;
  };
  const heightOf = (label: number) => (label === ASPHALT ? LEVEL.asphalt : LEVEL.raised);

  // Rectangles: runs along rows (same label, same streaming cell), then grown downwards while the run repeats.
  const cellIx = (i: number) => Math.floor((minX + (i + 0.5) * G) / CELL);
  const cellIz = (j: number) => Math.floor((minZ + (j + 0.5) * G) / CELL);
  const open = new Map<string, { i0: number; i1: number; j0: number; j1: number; label: number }>();
  const rects: { i0: number; i1: number; j0: number; j1: number; label: number }[] = [];
  for (let j = 0; j <= H; j++) {
    const runs = new Set<string>();
    if (j < H) {
      let i = 0;
      while (i < W) {
        const label = lab[j * W + i];
        let k = i + 1;
        while (k < W && lab[j * W + k] === label && cellIx(k) === cellIx(i)) k++;
        if (label !== NONE && label !== CORNER) {
          const key = `${i},${k},${label}`;
          runs.add(key);
          const o = open.get(key);
          if (o && cellIz(j) === cellIz(o.j0)) o.j1 = j + 1;
          else {
            if (o) rects.push(o);
            open.set(key, { i0: i, i1: k, j0: j, j1: j + 1, label });
          }
        }
        i = k;
      }
    }
    for (const [key, o] of open) {
      if (!runs.has(key)) {
        rects.push(o);
        open.delete(key);
      }
    }
  }
  for (const r of rects) {
    const x0 = minX + r.i0 * G;
    const x1 = minX + r.i1 * G;
    const z0 = minZ + r.j0 * G;
    const z1 = minZ + r.j1 * G;
    const c = cellOf((x0 + x1) / 2, (z0 + z1) / 2);
    const m = LABEL_MAT[r.label];
    const b = mesh(c, m);
    const y = heightOf(r.label);
    const t = TILE[m];
    const a = b.vert(x0, y, z0, 0, 1, 0, x0 / t, z0 / t);
    const bb = b.vert(x1, y, z0, 0, 1, 0, x1 / t, z0 / t);
    const cc = b.vert(x1, y, z1, 0, 1, 0, x1 / t, z1 / t);
    const d = b.vert(x0, y, z1, 0, 1, 0, x0 / t, z1 / t);
    // Up-facing: (x0,z0) → (x0,z1) → (x1,z1) is counter-clockwise seen from above (+y).
    b.tri(a, d, cc);
    b.tri(a, cc, bb);
    grow(c, x0, z0);
    grow(c, x1, z1);
    if (r.label === ASPHALT) {
      // The asphalt collider is the visual asphalt.
      const col = c.collider;
      const p = [col.vert(x0, 0, z0), col.vert(x1, 0, z0), col.vert(x1, 0, z1), col.vert(x0, 0, z1)];
      col.tri(p[0], p[3], p[2]);
      col.tri(p[0], p[2], p[1]);
    }
  }

  // Kerb faces between asphalt and raised cells (not at rounded corners: those have their arc).
  const wall = (c: GroundCell, ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    const b = mesh(c, 'sidewalk');
    const len = Math.hypot(bx - ax, bz - az);
    const u0 = (ax + az) / TILE.sidewalk;
    const v0 = b.vert(ax, LEVEL.asphalt, az, nx, 0, nz, u0, 0);
    const v1 = b.vert(bx, LEVEL.asphalt, bz, nx, 0, nz, u0 + len / TILE.sidewalk, 0);
    const v2 = b.vert(bx, LEVEL.raised, bz, nx, 0, nz, u0 + len / TILE.sidewalk, LEVEL.raised / TILE.sidewalk);
    const v3 = b.vert(ax, LEVEL.raised, az, nx, 0, nz, u0, LEVEL.raised / TILE.sidewalk);
    // Facing (nx, nz): order so (v1 - v0) × (v3 - v0) points along the normal.
    const ex = bx - ax;
    const ez = bz - az;
    // (e, 0) × (0, 1, 0) = (-ez, 0, ex)... cross(e, up) = (ez*... ) computed explicitly:
    const cx = -ez; // (ex,0,ez) × (0,1,0) = (0*0 - ez*1, ez*0 - ex*0, ex*1 - 0*0) = (-ez, 0, ex)
    const cz = ex;
    if (cx * nx + cz * nz > 0) {
      b.tri(v0, v1, v2);
      b.tri(v0, v2, v3);
    } else {
      b.tri(v0, v2, v1);
      b.tri(v0, v3, v2);
    }
  };
  // Horizontal boundaries (between rows j-1 and j), merged into runs.
  for (let j = 1; j < H; j++) {
    let i = 0;
    while (i < W) {
      const up = at(i, j - 1);
      const dn = at(i, j);
      const kind = up === ASPHALT && raised(dn) ? 1 : dn === ASPHALT && raised(up) ? -1 : 0;
      if (!kind) {
        i++;
        continue;
      }
      let k = i + 1;
      while (k < W && cellIx(k) === cellIx(i)) {
        const u = at(k, j - 1);
        const d = at(k, j);
        const kk = u === ASPHALT && raised(d) ? 1 : d === ASPHALT && raised(u) ? -1 : 0;
        if (kk !== kind) break;
        k++;
      }
      const z = minZ + j * G;
      const x0 = minX + i * G;
      const x1 = minX + k * G;
      const c = cellOf((x0 + x1) / 2, z);
      // Face towards the asphalt.
      wall(c, x0, z, x1, z, 0, kind === 1 ? -1 : 1);
      grow(c, x0, z);
      grow(c, x1, z);
      i = k;
    }
  }
  // Vertical boundaries (between columns i-1 and i).
  for (let i = 1; i < W; i++) {
    let j = 0;
    while (j < H) {
      const lf = at(i - 1, j);
      const rt = at(i, j);
      const kind = lf === ASPHALT && raised(rt) ? 1 : rt === ASPHALT && raised(lf) ? -1 : 0;
      if (!kind) {
        j++;
        continue;
      }
      let k = j + 1;
      while (k < H && cellIz(k) === cellIz(j)) {
        const a = at(i - 1, k);
        const b = at(i, k);
        const kk = a === ASPHALT && raised(b) ? 1 : b === ASPHALT && raised(a) ? -1 : 0;
        if (kk !== kind) break;
        k++;
      }
      const x = minX + i * G;
      const z0 = minZ + j * G;
      const z1 = minZ + k * G;
      const c = cellOf(x, (z0 + z1) / 2);
      wall(c, x, z0, x, z1, kind === 1 ? -1 : 1, 0);
      grow(c, x, z0);
      grow(c, x, z1);
      j = k;
    }
  }

  // Rounded corners: quarter disc of sidewalk around L, asphalt fillet towards K, arc kerb face.
  const arc = (C: Corner, r: number): [number, number][] => {
    const pts: [number, number][] = [];
    for (let k = 0; k <= ARC; k++) {
      const a = (k / ARC) * (Math.PI / 2);
      pts.push([C.L[0] + r * (Math.cos(a) * C.u1[0] + Math.sin(a) * C.u2[0]), C.L[1] + r * (Math.cos(a) * C.u1[1] + Math.sin(a) * C.u2[1])]);
    }
    return pts;
  };
  for (const C of corners) {
    const c = cellOf((C.K[0] + C.L[0]) / 2, (C.K[1] + C.L[1]) / 2);
    const pts = arc(C, C.r);
    const sw = mesh(c, 'sidewalk');
    const as = mesh(c, 'asphalt');
    const ts = TILE.sidewalk;
    const ta = TILE.asphalt;
    const centre = sw.vert(C.L[0], LEVEL.raised, C.L[1], 0, 1, 0, C.L[0] / ts, C.L[1] / ts);
    const ring = pts.map(([x, z]) => sw.vert(x, LEVEL.raised, z, 0, 1, 0, x / ts, z / ts));
    for (let k = 0; k < ARC; k++) upTri(sw, sw.pos, centre, ring[k], ring[k + 1]);
    const kv = as.vert(C.K[0], LEVEL.asphalt, C.K[1], 0, 1, 0, C.K[0] / ta, C.K[1] / ta);
    const ringA = pts.map(([x, z]) => as.vert(x, LEVEL.asphalt, z, 0, 1, 0, x / ta, z / ta));
    for (let k = 0; k < ARC; k++) upTri(as, as.pos, kv, ringA[k], ringA[k + 1]);
    for (let k = 0; k < ARC; k++) {
      const [ax, az] = pts[k];
      const [bx, bz] = pts[k + 1];
      const mx = (ax + bx) / 2 - C.L[0];
      const mz = (az + bz) / 2 - C.L[1];
      const ml = Math.hypot(mx, mz);
      wall(c, ax, az, bx, bz, mx / ml, mz / ml);
    }
    // Fillet collider (asphalt level).
    const col = c.collider;
    const ck = col.vert(C.K[0], 0, C.K[1]);
    const cr = pts.map(([x, z]) => col.vert(x, 0, z));
    for (let k = 0; k < ARC; k++) upTri(col, col.pos, ck, cr[k], cr[k + 1]);
    grow(c, C.K[0], C.K[1]);
    grow(c, C.L[0], C.L[1]);
  }

  // --- block colliders: kerb outline → ramp → top ----------------------------------------------------
  for (const b of l.blocks) {
    const rounded = blockCorners.get(b)!;
    const outline = (inset: number): [number, number][] => {
      const poly = inset !== 0 ? offsetRectilinear(b.kerb, b.kerb.map(() => inset)) : b.kerb;
      const out: [number, number][] = [];
      for (let i = 0; i < poly.length; i++) {
        if (!rounded.has(i)) {
          out.push(poly[i]);
          continue;
        }
        // The arc starts on the side before the corner (angle 0 = along u1) and ends on the side after it.
        const C = corners.find((q) => q.K === b.kerb[i])!;
        out.push(...arc(C, C.r - inset));
      }
      return out;
    };
    const c0 = outline(-RAMP_OUT);
    const c1 = outline(RAMP_IN);
    const [cx, cz] = centroidOf(b.lot);
    const cell = cellOf(cx, cz);
    const col = cell.collider;
    const v0 = c0.map(([x, z]) => col.vert(x, LEVEL.asphalt, z));
    const v1 = c1.map(([x, z]) => col.vert(x, LEVEL.raised, z));
    for (let k = 0; k < c0.length; k++) {
      const k2 = (k + 1) % c0.length;
      // Ramp quad: the up side faces away from the block, triangles kept facing up-ish.
      rampQuad(col, v0[k], v0[k2], v1[k2], v1[k]);
    }
    const tris = THREE.ShapeUtils.triangulateShape(c1.map(([x, z]) => new THREE.Vector2(x, z)), []);
    for (const [a, bb, cc] of tris) upTri(col, col.pos, v1[a], v1[bb], v1[cc]);
    for (const [x, z] of c0) grow(cell, x, z);
  }

  // --- median colliders: the same ramp, its inner part limited by the island's width ------------------
  for (const m of medians) {
    const inset = Math.min(RAMP_IN, m.width / 2 - 0.25);
    const c0 = offsetRectilinear(m.poly, m.poly.map(() => -RAMP_OUT));
    const c1 = offsetRectilinear(m.poly, m.poly.map(() => inset));
    const [cx, cz] = centroidOf(m.poly);
    const cell = cellOf(cx, cz);
    const col = cell.collider;
    const v0 = c0.map(([x, z]) => col.vert(x, LEVEL.asphalt, z));
    const v1 = c1.map(([x, z]) => col.vert(x, LEVEL.raised, z));
    for (let k = 0; k < 4; k++) rampQuad(col, v0[k], v0[(k + 1) % 4], v1[(k + 1) % 4], v1[k]);
    upTri(col, col.pos, v1[0], v1[1], v1[2]);
    upTri(col, col.pos, v1[0], v1[2], v1[3]);
    for (const [x, z] of c0) grow(cell, x, z);
  }

  // --- the land: ring's outer kerb ramp and the flat land, walls at its edge --------------------------
  const outer = new ColliderBuf();
  const ringKerb = l.outline.kerb;
  // The ring's asphalt is inside its kerb: the ramp starts RAMP_OUT inside it and reaches the land RAMP_IN outside.
  const ringIn = offsetRectilinear(ringKerb, ringKerb.map(() => RAMP_OUT));
  const ringOut = offsetRectilinear(ringKerb, ringKerb.map(() => -RAMP_IN));
  const o0 = ringIn.map(([x, z]) => outer.vert(x, LEVEL.asphalt, z));
  const o1 = ringOut.map(([x, z]) => outer.vert(x, LEVEL.raised, z));
  for (let k = 0; k < o0.length; k++) rampQuad(outer, o0[k], o0[(k + 1) % o0.length], o1[(k + 1) % o0.length], o1[k]);
  const rect: [number, number][] = [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
  const landTris = THREE.ShapeUtils.triangulateShape(
    rect.map(([x, z]) => new THREE.Vector2(x, z)),
    [ringOut.map(([x, z]) => new THREE.Vector2(x, z))],
  );
  const all = [...rect, ...ringOut];
  const lv = all.map(([x, z]) => outer.vert(x, LEVEL.raised, z));
  for (const [a, b, c] of landTris) upTri(outer, outer.pos, lv[a], lv[b], lv[c]);
  const walls = [
    { x: (minX + maxX) / 2, z: minZ - 1, hx: (maxX - minX) / 2 + 2, hz: 1 },
    { x: (minX + maxX) / 2, z: maxZ + 1, hx: (maxX - minX) / 2 + 2, hz: 1 },
    { x: minX - 1, z: (minZ + maxZ) / 2, hx: 1, hz: (maxZ - minZ) / 2 + 2 },
    { x: maxX + 1, z: (minZ + maxZ) / 2, hx: 1, hz: (maxZ - minZ) / 2 + 2 },
  ];
  return { cells, outer, walls, bounds: { minX, minZ, maxX, maxZ }, raster: { lab, W, H, minX, minZ, res: G } };
}

/** Sloped quad between a low edge (a → b) and a high edge (c → d): both triangles facing up. */
function rampQuad(col: ColliderBuf, a: number, b: number, c: number, d: number): void {
  upTri(col, col.pos, a, b, c);
  upTri(col, col.pos, a, c, d);
}

/** Centre-line distance from a node to where this edge's own lanes start: half the widest other road's asphalt. */
export function junctionHalf(l: CityLayout, n: number, e: LayoutEdge): number {
  let w = 0;
  for (const o of l.nodes[n].out) if (o >= 0 && o !== e.id) w = Math.max(w, kerbOffset(l.edges[o].cls));
  return w;
}

/** A junction (T or crossroads), as opposed to a bend or a straight pass. */
export const isJunction = (l: CityLayout, n: number): boolean => l.nodes[n].kind === 'cross' || l.nodes[n].kind === 'tee';

/**
 * Median islands of the divided roads, one rectangle per edge: at a junction
 * it ends 5 m short of the junction box (the zebra crossing fits in front of
 * it); at a bend it runs to the bend point plus half its width, so the islands
 * of the two edges meet in a square.
 */
export function medianRects(l: CityLayout): { poly: [number, number][]; width: number; edge: number }[] {
  const out: { poly: [number, number][]; width: number; edge: number }[] = [];
  for (const e of l.edges) {
    const h = medianHalf(e.cls);
    if (h === 0) continue;
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const dx = (B.x - A.x) / e.length;
    const dz = (B.z - A.z) / e.length;
    const s0 = isJunction(l, e.a) ? junctionHalf(l, e.a, e) + 5 : -h;
    const s1 = isJunction(l, e.b) ? e.length - junctionHalf(l, e.b, e) - 5 : e.length + h;
    if (s1 - s0 < 4) continue;
    // Rectangle along the edge, ±h across (left of (dx, dz) is (dz, −dx)).
    const P = (s: number, o: number): [number, number] => [A.x + dx * s + dz * o, A.z + dz * s - dx * o];
    out.push({ poly: [P(s0, -h), P(s1, -h), P(s1, h), P(s0, h)], width: 2 * h, edge: e.id });
  }
  return out;
}

function centroidOf(poly: [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const q of poly) {
    x += q[0];
    z += q[1];
  }
  return [x / poly.length, z / poly.length];
}

// --- lane markings ------------------------------------------------------------------------------

/**
 * Marking colours (linear RGB), close to the kit's decal atlas lines. The line
 * shapes are the quads themselves, drawn opaque: an alpha-tested atlas lost
 * them at grazing angles (a long, thin atlas row mip-maps into its transparent
 * neighbours and falls under the alpha cutoff), even a few metres ahead.
 */
const PAINT = { white: [0.78, 0.78, 0.75], yellow: [0.82, 0.5, 0.03] } as const;

/**
 * Lane markings (centre lines, lane lines, stop lines, zebra crossings) per streaming cell.
 * Returns the quads written per layout edge (`byEdge[edge id]`) so tests can check every road got its lines.
 */
export function buildMarkings(l: CityLayout, cells: Map<string, GroundCell>): { quads: number; byEdge: number[] } {
  let quads = 0;
  const byEdge = l.edges.map(() => 0);
  let current = -1;
  const cellOf = (x: number, z: number): GroundCell => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const key = `${cx},${cz}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { key, cx, cz, meshes: new Map(), collider: new ColliderBuf(), bounds: [Infinity, Infinity, -Infinity, -Infinity] }));
    return c;
  };
  /** Flat quad along direction (dx, dz) from s0 to s1 at lateral offsets o0..o1 (left of the direction is +). */
  const strip = (ox: number, oz: number, dx: number, dz: number, s0: number, s1: number, o0: number, o1: number, paint: readonly [number, number, number]) => {
    if (s1 - s0 < 0.05) return;
    // Left of travel direction (dx, dz) in x/z: (dz, -dx) when +z is south and +x east (right-handed, y up).
    const lx = dz;
    const lz = -dx;
    const mx = ox + dx * (s0 + s1) / 2;
    const mz = oz + dz * (s0 + s1) / 2;
    const c = cellOf(mx, mz);
    let b = c.meshes.get('marking');
    if (!b) c.meshes.set('marking', (b = new MeshBuf()));
    const y = LEVEL.marking;
    const P = (s: number, o: number) => [ox + dx * s + lx * o, oz + dz * s + lz * o];
    const corners = [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)];
    const ids = corners.map(([x, z]) => b.vertColour(x, y, z, paint));
    upTri(b, b.pos, ids[0], ids[1], ids[2]);
    upTri(b, b.pos, ids[0], ids[2], ids[3]);
    for (const [x, z] of corners) {
      c.bounds[0] = Math.min(c.bounds[0], x);
      c.bounds[1] = Math.min(c.bounds[1], z);
      c.bounds[2] = Math.max(c.bounds[2], x);
      c.bounds[3] = Math.max(c.bounds[3], z);
    }
    quads++;
    if (current >= 0) byEdge[current]++;
  };
  for (const e of l.edges) {
    current = e.id;
    if (e.cls === 'alley') continue;
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const prof = ROAD_PROFILE[e.cls];
    const half = kerbOffset(e.cls);
    const mh = medianHalf(e.cls);
    // Junction ends get a zebra crossing (3 m) and a stop line; bends just stop the lines short of the corner.
    const junctionA = isJunction(l, e.a);
    const junctionB = isJunction(l, e.b);
    const startA = junctionHalf(l, e.a, e) + (junctionA ? 4 : 0.5);
    const endB = len - junctionHalf(l, e.b, e) - (junctionB ? 4 : 0.5);
    if (endB - startA < 4) continue;
    const line = (o: number, paint: readonly [number, number, number], from = startA, to = endB) => strip(A.x, A.z, dx, dz, from, to, o - 0.075, o + 0.075, paint);
    const dashed = (o: number, dash: number, gap: number) => {
      for (let s = startA + 1; s < endB - 1; s += dash + gap) strip(A.x, A.z, dx, dz, s, Math.min(s + dash, endB - 1), o - 0.075, o + 0.075, PAINT.white);
    };
    const zebra = (s: number) => {
      // Bars along the travel direction, 0.5 m wide, 0.6 m apart, 3 m long, across each carriageway (not the median).
      for (let o = -half + 0.5; o + 0.5 <= half - 0.3; o += 1.1) if (Math.abs(o + 0.25) > mh + 0.45) strip(A.x, A.z, dx, dz, s, s + 3, o, o + 0.5, PAINT.white);
    };
    if (junctionA) {
      zebra(startA - 3.5);
      // Stop line across the lanes arriving at A (they drive towards −d: our +left side).
      strip(A.x, A.z, dx, dz, startA - 0.1, startA + 0.3, mh + 0.2, half - 0.2, PAINT.white);
    }
    if (junctionB) {
      zebra(endB + 0.5);
      strip(A.x, A.z, dx, dz, endB - 0.3, endB + 0.1, -half + 0.2, -mh - 0.2, PAINT.white);
    }
    if (mh > 0) {
      // Divided road: a yellow line along each side of the median, dashed white between the lanes of a direction.
      for (const side of [-1, 1]) {
        line(side * (mh + 0.3), PAINT.yellow);
        for (let k = 1; k < prof.lanes; k++) dashed(side * (mh + prof.lane * k), 3, 6);
      }
    } else if (prof.lanes > 1) {
      // Undivided 2+2: double yellow in the middle, dashed white between the lanes of a direction.
      for (const [o0, o1] of [[-0.2, -0.07], [0.07, 0.2]]) strip(A.x, A.z, dx, dz, startA, endB, o0, o1, PAINT.yellow);
      for (const side of [-1, 1]) for (let k = 1; k < prof.lanes; k++) dashed(side * prof.lane * k, 3, 6);
    } else {
      // 1+1 street: dashed white centre line.
      dashed(0, 3, 3);
    }
    // Edge lines along the kerbs, clear of the stop lines.
    for (const o of [-half + 0.35, half - 0.35]) line(o, PAINT.white, startA + (junctionA ? 0.5 : 0), endB - (junctionB ? 0.5 : 0));
  }
  return { quads, byEdge };
}
