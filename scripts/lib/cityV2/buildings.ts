/**
 * City V2 buildings: procedural building prototypes from the kit's facade
 * modules, and their placement on every ordinary block and large parcel of the
 * town (or only the A3 sample areas, one per district). Pure function of (layout, kit, seed).
 *
 * Modules: kit wall / window / shopfront / door / cornice / column / roof
 * pieces (2 or 4 m wide, 1 or 3 m tall, pivot bottom centre, facade facing +Z),
 * without their interior walls, floors and glass: the fake-interior card behind
 * each window stays and becomes the window (lit or dark room, glossy). Each
 * module also gets a fine and a coarse relief (its front cut into rectangles
 * at their depths, with the reveals between them) and a card.
 *
 * Prototypes: a style (which modules, which colours), a frontage and depth
 * (multiples of 2 m: the module grid), a number of floors, a window rhythm,
 * a ground floor (shops, an entrance) and, per side, whether it faces a street
 * (a full facade), is exposed (plain wall with a few windows) or is a party
 * wall against the neighbour (plain wall). A prototype is a list of module
 * placements; the game assembles and instances it.
 *
 * Placement walks each street side of a block's lot (the back of the sidewalk;
 * alleys are kept 2.5 m clear: their kerb ramp reaches into the lot), corners
 * first, and fills it with lots that fit the block and the buildings already
 * there. District rules: street wall downtown, gaps and front yards in
 * residential streets, big low buildings apart in industry. Outside downtown
 * the inside of a block behind the street rows is filled too (packArea), and
 * malls, stadiums, hospitals, factories, warehouses and the landmark block get
 * a complex in their middle (parcelCore); car parks, parks and the plaza stay
 * open. Then each district gets a catalogue
 * of prototypes that fit all its lots (sizes, both height classes, styles,
 * every floor count), and each lot the one that fits best (stretched to it,
 * unlike its neighbours down the street, a colour variant where it stands
 * next to the same prototype).
 */
import { MeshoptSimplifier } from 'meshoptimizer';
import {
  BUILDING_SLOTS,
  KIT_ROLE,
  MODULE_STRIDE,
  ROLES,
  SLOT_INDEX,
  PROTO_LEVELS,
  CARD_LEVEL,
  CARD_TILING,
  CARD_WINDOW_FLAG,
  MODULE_LODS,
  VARIANTS,
  WINDOW_SLOTS,
  assembleProto,
  type AssembledMesh,
  type BuildingArea,
  type BuildingModuleDef,
  type BuildingProto,
  type Role,
} from '../../../src/world/cityv2/buildingKit';
import type { Kit } from './kit';
import type { CityLayout, District, LayoutBlock, ParcelUse } from './layout';
import { stream, type Rng } from './rng';

// --- modules ---------------------------------------------------------------------------------------

export interface ModuleGeo {
  /** MODULE_STRIDE floats per vertex. */
  verts: Float32Array;
  index: Uint32Array;
}

export interface Module {
  name: string;
  stretch?: boolean;
  /** MODULE_LODS geometries: as modelled, fine relief, coarse relief, card (see buildingKit.ts). */
  lods: ModuleGeo[];
}

/** Roof pieces (slopes) at relief / card detail: simplified to this error, m. */
const ROOF_MID_ERROR = 0.25;
/** Modules this cheap as modelled are used as modelled at every level but the card. */
const CHEAP = 12;
/**
 * Relief: vertex lines closer than `lines` merge (fine: window bars and frames stay; coarse: the opening,
 * its surround and sill only), depths are kept to `depth` and steps shallower than `step` get no side
 * face (coarse: only the window reveals), m.
 */
const RELIEF = [
  { lines: 0.025, depth: 0.03, step: 0.02 },
  { lines: 0.08, depth: 0.05, step: 0.08 },
];

/** Unit quads, scaled per placement: a wall (x −0.5..0.5, y 0..1, facing +Z) and a roof (x, z −0.5..0.5, facing up). */
function builtinModules(): Module[] {
  const wall = role('wall');
  const roof = role('roof');
  // uv: 1 per 2 m (the kit's brick walls), times the placement's scale.
  const quadWall = new Float32Array([-0.5, 0, 0, 0, 0, 1, 0, 0, wall, 0.5, 0, 0, 0, 0, 1, 0.5, 0, wall, 0.5, 1, 0, 0, 0, 1, 0.5, -0.5, wall, -0.5, 1, 0, 0, 0, 1, 0, -0.5, wall]);
  const quadRoof = new Float32Array([-0.5, 0, 0.5, 0, 1, 0, 0, 0.5, roof, 0.5, 0, 0.5, 0, 1, 0, 0.5, 0.5, roof, 0.5, 0, -0.5, 0, 1, 0, 0.5, 0, roof, -0.5, 0, -0.5, 0, 1, 0, 0, 0, roof]);
  const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return [
    { name: 'quad_wall', stretch: true, lods: Array.from({ length: MODULE_LODS }, () => ({ verts: quadWall, index: idx })) },
    { name: 'quad_roof', stretch: true, lods: Array.from({ length: MODULE_LODS }, () => ({ verts: quadRoof, index: idx })) },
  ];
}

const role = (r: Role) => ROLES.indexOf(r);

type Box3 = { min: [number, number, number]; max: [number, number, number] };
type V3 = [number, number, number];
type UV = [number, number];

function boxOf(position: Float32Array): Box3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], position[i + k]);
      max[k] = Math.max(max[k], position[i + k]);
    }
  }
  return { min, max };
}

/** Collects quads into module geometry. */
class QuadBuf {
  verts: number[] = [];
  index: number[] = [];
  /** Corners in order (counter-clockwise seen from the front), one normal, uv per corner, a role. */
  quad(p: V3[], n: V3, uv: UV[], r: number): void {
    const b = this.verts.length / MODULE_STRIDE;
    for (let i = 0; i < 4; i++) this.verts.push(...p[i], ...n, ...uv[i], r);
    this.index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /** A box; flat uv (one colour). Faces: front, back, sides and top always, the bottom on request. */
  box(b: Box3, r: number, uv: UV, faces: { back?: boolean; bottom?: boolean } = {}): void {
    const [x0, y0, z0] = b.min;
    const [x1, y1, z1] = b.max;
    const u: UV[] = [uv, uv, uv, uv];
    this.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], u, r);
    if (faces.back !== false) this.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], u, r);
    this.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], u, r);
    this.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], u, r);
    this.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], u, r);
    if (faces.bottom) this.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], u, r);
  }
  geo(): ModuleGeo {
    return { verts: new Float32Array(this.verts), index: new Uint32Array(this.index) };
  }
}

interface Part {
  role: Role;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint32Array;
}

/** Front-facing area per role, and its area-weighted mean uv. */
function frontArea(parts: Part[]): Map<Role, { area: number; u: number; v: number }> {
  const out = new Map<Role, { area: number; u: number; v: number }>();
  for (const p of parts) {
    const e = out.get(p.role) ?? { area: 0, u: 0, v: 0 };
    const P = p.position;
    for (let t = 0; t < p.index.length; t += 3) {
      const [a, b, c] = [p.index[t], p.index[t + 1], p.index[t + 2]];
      const ux = P[b * 3] - P[a * 3];
      const uy = P[b * 3 + 1] - P[a * 3 + 1];
      const vx = P[c * 3] - P[a * 3];
      const vy = P[c * 3 + 1] - P[a * 3 + 1];
      // Area projected on the facade plane, front-facing only.
      const area = (ux * vy - uy * vx) / 2;
      if (area <= 0) continue;
      e.area += area;
      if (p.uv) {
        e.u += (area * (p.uv[a * 2] + p.uv[b * 2] + p.uv[c * 2])) / 3;
        e.v += (area * (p.uv[a * 2 + 1] + p.uv[b * 2 + 1] + p.uv[c * 2 + 1])) / 3;
      }
    }
    out.set(p.role, e);
  }
  return out;
}

/** The role covering most of the front (windows aside), and a uv inside it (its average). */
function mainRole(parts: Part[]): { main: Role; flatUv: UV } {
  const areas = frontArea(parts.filter((p) => p.role !== 'window'));
  let main: Role = parts.find((p) => p.role !== 'window')?.role ?? 'wall';
  let best = -1;
  for (const [r, e] of areas) {
    if (e.area > best) {
      best = e.area;
      main = r;
    }
  }
  const e = areas.get(main);
  return { main, flatUv: e && e.area > 0 ? [e.u / e.area, e.v / e.area] : [0.5, 0.5] };
}

/** Pieces that stand out of the facade (columns, cornices) rather than lie in it. */
const standsOut = (b: Box3) => b.max[2] > 0.25 || b.min[2] < -0.35;

/**
 * A dormer (Roof_Slate_Window_1) or a roof slope: the slate simplified (ROOF_MID_ERROR), the dormer's
 * trim a box with the window on its front.
 */
function roofOf(parts: Part[]): ModuleGeo {
  const geo: ModuleGeo[] = [];
  const q = new QuadBuf();
  const trim = parts.filter((p) => p.role !== 'slate' && p.role !== 'window' && boxOf(p.position).max[2] > 0.05);
  for (const p of parts) {
    if (trim.includes(p) || (p.role === 'window' && trim.length)) continue;
    const verts = toVerts(p);
    const target = Math.max(6, Math.floor((p.index.length * 0.15) / 3) * 3);
    const [index] = p.index.length > 12 ? MeshoptSimplifier.simplify(p.index, p.position, 3, target, ROOF_MID_ERROR, ['ErrorAbsolute', 'Prune']) : [p.index];
    geo.push({ verts, index });
  }
  if (trim.length) {
    const b = boxOf(new Float32Array(trim.flatMap((p) => [...p.position])));
    q.box(b, role(trim[0].role), mainRole(trim).flatUv, { back: false });
    const win = parts.filter((p) => p.role === 'window');
    if (win.length) {
      const w = boxOf(new Float32Array(win.flatMap((p) => [...p.position])));
      const z = b.max[2] + 0.01;
      const [x0, x1] = [Math.max(w.min[0], b.min[0] + 0.15), Math.min(w.max[0], b.max[0] - 0.15)];
      const [y0, y1] = [Math.max(w.min[1], b.min[1] + 0.15), Math.min(w.max[1], b.max[1] - 0.15)];
      q.quad([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, 1], [[0.15, 1], [0.85, 1], [0.85, 0], [0.15, 0]], role('window'));
    }
    geo.push(q.geo());
  }
  return merge(geo);
}

/**
 * Card: what is seen from 120 m and more. Pieces that stand out of the facade (columns, cornices) become
 * a box of their extent; panels a flat wall in the colour that covers most of their front plus the
 * window as a rectangle 2 cm in front of it (the game's card assembly merges the walls of a facade and
 * pulls windows towards the camera in depth, so they never fight with the wall).
 */
function cardOf(name: string, parts: Part[]): ModuleGeo {
  if (/^Roof_/.test(name)) return roofOf(parts);
  const all = boxOf(new Float32Array(parts.flatMap((p) => [...p.position])));
  const { main, flatUv } = mainRole(parts);
  const q = new QuadBuf();
  const [x0, y0] = all.min;
  const [x1, y1] = all.max;
  if (standsOut(all)) {
    q.box(all, role(main), flatUv);
    return q.geo();
  }
  const zf = Math.min(all.max[2], 0.05);
  const uvAt = (x: number, y: number): UV => (CARD_TILING.includes(main) ? [x / 2, -y / 2] : flatUv);
  q.quad([[x0, y0, zf], [x1, y0, zf], [x1, y1, zf], [x0, y1, zf]], [0, 0, 1], [uvAt(x0, y0), uvAt(x1, y0), uvAt(x1, y1), uvAt(x0, y1)], role(main));
  const win = parts.filter((p) => p.role === 'window');
  if (win.length) {
    const wb = boxOf(new Float32Array(win.flatMap((p) => [...p.position])));
    // The glass opening is smaller than the interior card behind it: use the frame's inner extent if known.
    const [wx0, wy0, wx1, wy1] = [wb.min[0] * 0.8, wb.min[1] + 0.15, wb.max[0] * 0.8, wb.max[1] - 0.15];
    const zw = zf + 0.02;
    q.quad([[wx0, wy0, zw], [wx1, wy0, zw], [wx1, wy1, zw], [wx0, wy1, zw]], [0, 0, 1], [[0.15, 1], [0.85, 1], [0.85, 0], [0.15, 0]], role('window'));
  }
  return q.geo();
}

/**
 * Columns and cornices: up to three boxes stacked along y (base, shaft, capital; band, overhang), each
 * the extent of the piece within its height range.
 */
function stackOf(name: string, parts: Part[]): ModuleGeo {
  const tris: { y0: number; y1: number; b: Box3 }[] = [];
  for (const p of parts) {
    const P = p.position;
    for (let t = 0; t < p.index.length; t += 3) {
      const v = [p.index[t], p.index[t + 1], p.index[t + 2]];
      const b = boxOf(new Float32Array(v.flatMap((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]])));
      tris.push({ y0: b.min[1], y1: b.max[1], b });
    }
  }
  const ys = cluster(tris.flatMap((t) => [t.y0, t.y1]), 0.08);
  let slabs: { y0: number; y1: number; b: Box3 }[] = [];
  for (let i = 0; i + 1 < ys.length; i++) {
    const [y0, y1] = [ys[i], ys[i + 1]];
    const mid = (y0 + y1) / 2;
    const hit = tris.filter((t) => t.y0 <= mid + 1e-4 && t.y1 >= mid - 1e-4);
    if (!hit.length) continue;
    const b: Box3 = { min: [Infinity, y0, Infinity], max: [-Infinity, y1, -Infinity] };
    for (const t of hit) {
      b.min[0] = Math.min(b.min[0], t.b.min[0]);
      b.min[2] = Math.min(b.min[2], t.b.min[2]);
      b.max[0] = Math.max(b.max[0], t.b.max[0]);
      b.max[2] = Math.max(b.max[2], t.b.max[2]);
    }
    slabs.push({ y0, y1, b });
  }
  const diff = (a: Box3, b: Box3) => Math.max(...[0, 2].flatMap((k) => [Math.abs(a.min[k] - b.min[k]), Math.abs(a.max[k] - b.max[k])]));
  const union = (a: { y0: number; y1: number; b: Box3 }, b: { y0: number; y1: number; b: Box3 }) => {
    const box: Box3 = { min: [Math.min(a.b.min[0], b.b.min[0]), a.y0, Math.min(a.b.min[2], b.b.min[2])], max: [Math.max(a.b.max[0], b.b.max[0]), b.y1, Math.max(a.b.max[2], b.b.max[2])] };
    return { y0: a.y0, y1: b.y1, b: box };
  };
  // Merge neighbours with (nearly) the same extent, then the most alike until three are left.
  for (;;) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i + 1 < slabs.length; i++) {
      const d = diff(slabs[i].b, slabs[i + 1].b);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0 || (bestD > 0.04 && slabs.length <= 3)) break;
    slabs = [...slabs.slice(0, best), union(slabs[best], slabs[best + 1]), ...slabs.slice(best + 2)];
  }
  const { main, flatUv } = mainRole(parts);
  const q = new QuadBuf();
  const cornice = /Cornice/.test(name);
  for (const [i, s] of slabs.entries()) {
    const b: Box3 = { min: [s.b.min[0], s.y0, s.b.min[2]], max: [s.b.max[0], s.y1, s.b.max[2]] };
    // The back is inside the building; a cornice's underside is seen from the street.
    q.box(b, role(main), flatUv, { back: b.min[2] > -0.05, bottom: cornice && (i === 0 || diff(slabs[i - 1].b, s.b) > 0.04) });
  }
  return q.geo();
}

/** Sorted values, runs closer than tol merged into their mean (the ends of the range kept). */
function cluster(values: number[], tol: number): number[] {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return v;
  const out: number[] = [];
  let run = [v[0]];
  for (let i = 1; i < v.length; i++) {
    if (v[i] - run[run.length - 1] < tol) run.push(v[i]);
    else {
      out.push(run.reduce((s, x) => s + x, 0) / run.length);
      run = [v[i]];
    }
  }
  out.push(run.reduce((s, x) => s + x, 0) / run.length);
  out[0] = v[0];
  out[out.length - 1] = v[v.length - 1];
  return out;
}

interface FrontTri {
  role: Role;
  /** Corners on the facade plane, and plane / uv as affine functions of (x, y): f0 + fx·x + fy·y. */
  p: [number, number][];
  z: V3;
  u: V3;
  v: V3;
  /** Planar walls (tiling textures, the module's main surface) and window cards keep their texture mapping (key); trims become one colour. */
  map: string;
  min: [number, number];
  max: [number, number];
}

const affine = (p: [number, number][], f: number[]): V3 => {
  const [[x0, y0], [x1, y1], [x2, y2]] = p;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const fx = ((f[1] - f[0]) * (y2 - y0) - (f[2] - f[0]) * (y1 - y0)) / det;
  const fy = ((x1 - x0) * (f[2] - f[0]) - (x2 - x0) * (f[1] - f[0])) / det;
  return [f[0] - fx * x0 - fy * y0, fx, fy];
};
const at = (f: V3, x: number, y: number) => f[0] + f[1] * x + f[2] * y;

/**
 * Relief of a facade panel: the front as seen straight on, cut along its own vertex lines (merged closer
 * than `lines`), each cell the nearest surface there; cells with the same surface and depth merge into
 * rectangles, and steps between depths get their side faces (window reveals, the edges of surrounds and
 * sills). Planar walls and windows keep their texture mapping, trims and mouldings become one colour
 * (the module's main surface keeps its mapping too: a stone wall stays stone).
 */
function reliefOf(parts: Part[], lines: number, depth: number, step: number): ModuleGeo {
  const tris: FrontTri[] = [];
  const { main } = mainRole(parts);
  for (const part of parts) {
    const P = part.position;
    const U = part.uv;
    for (let t = 0; t < part.index.length; t += 3) {
      const ids = [part.index[t], part.index[t + 1], part.index[t + 2]];
      const p = ids.map((i) => [P[i * 3], P[i * 3 + 1]] as [number, number]);
      const area = ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1])) / 2;
      // Front-facing, not edge-on.
      if (area < 1e-5) continue;
      const z = affine(p, ids.map((i) => P[i * 3 + 2]));
      const u = affine(p, ids.map((i) => (U ? U[i * 2] : 0)));
      const v = affine(p, ids.map((i) => (U ? U[i * 2 + 1] : 0)));
      const q = (n: number) => Math.round(n * 1000);
      const mapped = (CARD_TILING.includes(part.role) || part.role === 'window' || part.role === main) && area > 0.02 && Math.abs(z[1]) + Math.abs(z[2]) < 1e-3;
      const map = mapped ? [u, v].flatMap((f) => f.map(q)).join(',') : 'flat';
      tris.push({ role: part.role, p, z, u, v, map, min: [Math.min(...p.map((c) => c[0])), Math.min(...p.map((c) => c[1]))], max: [Math.max(...p.map((c) => c[0])), Math.max(...p.map((c) => c[1]))] });
    }
  }
  const xs = cluster(tris.flatMap((t) => t.p.map((c) => c[0])), lines);
  const ys = cluster(tris.flatMap((t) => t.p.map((c) => c[1])), lines);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  // Nearest surface at each cell centre.
  const cell: ({ t: FrontTri; z: number; key: string } | null)[] = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = (xs[i] + xs[i + 1]) / 2;
      const y = (ys[j] + ys[j + 1]) / 2;
      let best: FrontTri | null = null;
      let bz = -Infinity;
      for (const t of tris) {
        if (x < t.min[0] - 1e-6 || x > t.max[0] + 1e-6 || y < t.min[1] - 1e-6 || y > t.max[1] + 1e-6) continue;
        const [a, b, c] = t.p;
        const d = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
        const w1 = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / d;
        const w2 = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / d;
        if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
        const z = at(t.z, x, y);
        if (z > bz) {
          bz = z;
          best = t;
        }
      }
      if (!best) cell.push(null);
      else {
        const zq = Math.round(bz / depth);
        cell.push({ t: best, z: zq * depth, key: `${best.role}|${zq}|${best.map}` });
      }
    }
  }
  // One colour per role and module (as on the cards): a texel picked per rectangle would speckle.
  const mean = new Map([...frontArea(parts)].map(([r, e]) => [r, (e.area > 0 ? [e.u / e.area, e.v / e.area] : [0.5, 0.5]) as UV]));
  const q = new QuadBuf();
  const used = new Uint8Array(nx * ny);
  const key = (i: number, j: number) => cell[j * nx + i]?.key;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cell[j * nx + i];
      if (!c || used[j * nx + i]) continue;
      let w = 1;
      while (i + w < nx && !used[j * nx + i + w] && key(i + w, j) === c.key) w++;
      let h = 1;
      grow: while (j + h < ny) {
        for (let k = 0; k < w; k++) if (used[(j + h) * nx + i + k] || key(i + k, j + h) !== c.key) break grow;
        h++;
      }
      for (let jj = j; jj < j + h; jj++) for (let ii = i; ii < i + w; ii++) used[jj * nx + ii] = 1;
      const [x0, x1, y0, y1, z] = [xs[i], xs[i + w], ys[j], ys[j + h], c.z];
      // Texture: the surface's own mapping where it is planar (side faces: along their edge), else its role's colour.
      const flat = mean.get(c.t.role) ?? [0.5, 0.5];
      const uv = (x: number, y: number): UV => (c.t.map !== 'flat' ? [at(c.t.u, x, y), at(c.t.v, x, y)] : flat);
      const r = role(c.t.role);
      q.quad([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [0, 0, 1], [uv(x0, y0), uv(x1, y0), uv(x1, y1), uv(x0, y1)], r);
      // Side faces down to lower neighbours, per run of equal depth along each edge (none at the panel's edges).
      const sides: { n: V3; run: (k: number) => number | null; len: number; quad: (a: number, b: number, zn: number) => V3[] }[] = [
        { n: [1, 0, 0], len: h, run: (k) => (i + w < nx ? (cell[(j + k) * nx + i + w]?.z ?? null) : null), quad: (a, b, zn) => [[x1, ys[a], z], [x1, ys[a], zn], [x1, ys[b], zn], [x1, ys[b], z]] },
        { n: [-1, 0, 0], len: h, run: (k) => (i > 0 ? (cell[(j + k) * nx + i - 1]?.z ?? null) : null), quad: (a, b, zn) => [[x0, ys[a], zn], [x0, ys[a], z], [x0, ys[b], z], [x0, ys[b], zn]] },
        { n: [0, 1, 0], len: w, run: (k) => (j + h < ny ? (cell[(j + h) * nx + i + k]?.z ?? null) : null), quad: (a, b, zn) => [[xs[a], y1, z], [xs[b], y1, z], [xs[b], y1, zn], [xs[a], y1, zn]] },
        { n: [0, -1, 0], len: w, run: (k) => (j > 0 ? (cell[(j - 1) * nx + i + k]?.z ?? null) : null), quad: (a, b, zn) => [[xs[a], y0, zn], [xs[b], y0, zn], [xs[b], y0, z], [xs[a], y0, z]] },
      ];
      for (const s of sides) {
        const base = s.n[0] !== 0 ? j : i;
        let k = 0;
        while (k < s.len) {
          const zn = s.run(k);
          let e = k + 1;
          while (e < s.len && s.run(e) === zn) e++;
          if (zn !== null && z - zn >= step - 1e-6) {
            const p = s.quad(base + k, base + e, zn);
            q.quad(p, s.n, p.map(([x, y]) => uv(x, y)), r);
          }
          k = e;
        }
      }
    }
  }
  return q.geo();
}

function toVerts(p: Part): Float32Array {
  const n = p.position.length / 3;
  const verts = new Float32Array(n * MODULE_STRIDE);
  for (let i = 0; i < n; i++) {
    verts.set(p.position.subarray(i * 3, i * 3 + 3), i * MODULE_STRIDE);
    if (p.normal) verts.set(p.normal.subarray(i * 3, i * 3 + 3), i * MODULE_STRIDE + 3);
    else verts[i * MODULE_STRIDE + 4] = 1;
    if (p.uv) verts.set(p.uv.subarray(i * 2, i * 2 + 2), i * MODULE_STRIDE + 6);
    verts[i * MODULE_STRIDE + 8] = role(p.role);
  }
  return verts;
}

/** The kit pieces used, as modules (interior and glass dropped), plus the built-in quads. */
export async function buildModules(kit: Kit, names: readonly string[]): Promise<Module[]> {
  await MeshoptSimplifier.ready;
  const out = builtinModules();
  for (const name of names) {
    const piece = kit.pieces.get(name);
    if (!piece) throw new Error(`Kit piece missing: ${name}`);
    const parts: Part[] = [];
    const glass: Float32Array[] = [];
    for (const pr of piece.prims) {
      if (/^MI_Glass/.test(pr.material)) glass.push(pr.position);
      const r = KIT_ROLE[pr.material];
      if (r !== undefined) parts.push({ role: r, position: pr.position, normal: pr.normal, uv: pr.uv, index: pr.index });
    }
    // Glass with no room card behind it (door frames): the opening would show the empty inside of the
    // building, so a dark room card closes it just behind where the glass was.
    const cards = parts.filter((p) => p.role === 'window').map((p) => boxOf(p.position));
    for (const g of glass) {
      const b = boxOf(g);
      const covered = cards.some((c) => c.min[0] <= b.min[0] + 0.05 && c.max[0] >= b.max[0] - 0.05 && c.min[1] <= b.min[1] + 0.05 && c.max[1] >= b.max[1] - 0.05);
      if (covered) continue;
      const z = b.min[2] - 0.03;
      const position = new Float32Array([b.min[0], b.min[1], z, b.max[0], b.min[1], z, b.max[0], b.max[1], z, b.min[0], b.max[1], z]);
      parts.push({ role: 'window', position, normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uv: new Float32Array([0.15, 1, 0.85, 1, 0.85, 0, 0.15, 0]), index: new Uint32Array([0, 1, 2, 0, 2, 3]) });
      cards.push(b);
    }
    const near = merge(parts.map((p) => ({ verts: toVerts(p), index: p.index })));
    const card = cardOf(name, parts);
    const all = boxOf(new Float32Array(parts.flatMap((p) => [...p.position])));
    let relief: ModuleGeo[];
    if (near.index.length / 3 <= CHEAP) relief = [near, near];
    else if (/^Roof_/.test(name)) relief = [card, card];
    else if (standsOut(all) || /Cornice/.test(name)) {
      const s = stackOf(name, parts);
      relief = [s, s];
    } else relief = RELIEF.map((r) => reliefOf(parts, r.lines, r.depth, r.step));
    // Never more than the modelled piece.
    relief = relief.map((g) => (g.index.length < near.index.length ? g : near));
    out.push({ name, lods: [near, ...relief, card] });
  }
  return out;
}

/** Concatenates parts; drops vertices no triangle uses. */
function merge(parts: ModuleGeo[]): ModuleGeo {
  const verts: number[] = [];
  const index: number[] = [];
  for (const p of parts) {
    const remap = new Map<number, number>();
    for (const i of p.index) {
      let j = remap.get(i);
      if (j === undefined) {
        j = verts.length / MODULE_STRIDE;
        remap.set(i, j);
        for (let k = 0; k < MODULE_STRIDE; k++) verts.push(p.verts[i * MODULE_STRIDE + k]);
      }
      index.push(j);
    }
  }
  return { verts: new Float32Array(verts), index: new Uint32Array(index) };
}

// --- styles ---------------------------------------------------------------------------------------

interface Style {
  id: string;
  /** Slot per role (slot names); unset roles fall back to DEFAULT_ROLES. */
  roles: Partial<Record<Role, string>>;
  /** Upper floors: 2 m window modules, 4 m ones (bays), the 2 m plain wall. */
  windows: string[];
  wide: string[];
  plain: string;
  /** 1 m tall plain strip (parapets of exposed sides). */
  plain1: string;
  /** Ground floor: 2 m shop windows and plain bays, the 1 m band above them (4 m ground floor), the entrance. */
  shop: string[];
  shopWall: string;
  band: string | null;
  door: { frame: string; leaf: string | null };
  cornice: string;
  /** Pilasters on the building's street corners (bottom / middle / top floor pieces); L-shaped corner pieces wrap the corner. */
  column: { bottom: string; centre: string; top: string; wrap: boolean } | null;
  roof: 'flat' | 'mansard';
}

const DEFAULT_ROLES: Record<Role, string> = {
  brick: 'brick_red',
  brickPale: 'brick_pale',
  trim: 'trim',
  trimDark: 'trim_dark',
  trimGreen: 'trim_green',
  metal: 'metal',
  window: 'win_dark',
  slate: 'slate',
  roof: 'roof',
  concrete: 'concrete',
  wall: 'brick_red',
};

const STYLES: Record<string, Style> = {
  // Dark red-brown brick with tall dark metal windows and a black shopfront (the kit's main preview building).
  loft: {
    id: 'loft',
    roles: { brick: 'brick_brown', brickPale: 'brick_brown', trim: 'trim_dark', trimGreen: 'trim_dark', metal: 'metal_navy', wall: 'brick_brown' },
    windows: ['Metal_FullWindow', 'Metal_Window_Half'],
    wide: ['Metal_Window'],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: ['Metal_FirstFloor_Window'],
    shopWall: 'Metal_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Metal_Single', leaf: 'Door_2' },
    cornice: 'Cornice_Brick_Center',
    column: { bottom: 'Brick_CornerColumn_Bottom', centre: 'Brick_CornerColumn_Center', top: 'Brick_CornerColumn_Top', wrap: true },
    roof: 'flat',
  },
  // Pale brick, light stone trims, green shopfronts (the kit's pale apartment blocks).
  classic: {
    id: 'classic',
    roles: { brick: 'brick_pale', brickPale: 'brick_pale', trim: 'trim_light', trimDark: 'trim_green', metal: 'metal', wall: 'brick_pale' },
    windows: ['Brick_Window_Square_Single', 'Brick_Window_Trim_Single'],
    wide: ['Brick_Inset_Window', 'Brick_RedWhite_DoubleWindow'],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: ['Trim_FirstFloor_Window_001'],
    shopWall: 'Trim_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Wooden', leaf: null },
    cornice: 'Cornice_Trim_Center',
    column: { bottom: 'Trim_Column_Bottom', centre: 'Trim_Column_Center', top: 'Trim_Column_Top', wrap: false },
    roof: 'flat',
  },
  // Red brick with light trims.
  redbrick: {
    id: 'redbrick',
    roles: { brick: 'brick_red', brickPale: 'brick_red', trim: 'trim_light', trimDark: 'trim_dark', metal: 'metal', wall: 'brick_red' },
    windows: ['Brick_Window_Trim_Single', 'Brick_Window_Square_Single'],
    wide: ['Brick_Inset_Window_Curved_Small'],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: ['Metal_FirstFloor_Window'],
    shopWall: 'Metal_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Metal_Single', leaf: 'Door_2' },
    cornice: 'Cornice_Trim_Center',
    column: { bottom: 'Trim_Column_Bottom', centre: 'Trim_Column_Center', top: 'Trim_Column_Top', wrap: false },
    roof: 'flat',
  },
  // Navy metal panels and glass, concrete side walls.
  modern: {
    id: 'modern',
    roles: { metal: 'metal_navy', brick: 'brick_grey', brickPale: 'brick_grey', trim: 'trim_dark', trimGreen: 'trim_dark', wall: 'concrete' },
    windows: ['Metal_FullWindow', 'Metal_Window_Half'],
    wide: [],
    plain: 'Metal_Plain_3',
    plain1: 'Metal_Plain_1',
    shop: ['Metal_FirstFloor_Window'],
    shopWall: 'Metal_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Metal_Single', leaf: 'Door_2' },
    cornice: 'Cornice_Metal_Center',
    column: { bottom: 'Metal_Column_Bottom', centre: 'Metal_Column_Center', top: 'Metal_Column_Top', wrap: false },
    roof: 'flat',
  },
  // Beige stone (the kit's trim walls) with dark window frames.
  stone: {
    id: 'stone',
    roles: { trim: 'trim', trimDark: 'trim_dark', trimGreen: 'trim_green', brick: 'brick_pale', brickPale: 'brick_pale', wall: 'stone' },
    windows: ['Trim_Window'],
    wide: [],
    plain: 'Trim_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: ['Trim_FirstFloor_Window_001'],
    shopWall: 'Trim_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Wooden', leaf: null },
    cornice: 'Cornice_Trim_Center',
    column: { bottom: 'Trim_Column_Bottom', centre: 'Trim_Column_Center', top: 'Trim_Column_Top', wrap: false },
    roof: 'flat',
  },
  // Houses / small apartments: brick, square windows, a slate mansard roof.
  houseRed: {
    id: 'houseRed',
    roles: { brick: 'brick_red', brickPale: 'brick_red', trim: 'trim_light', wall: 'brick_red' },
    windows: ['Brick_Window_Square_Single', 'Brick_Window_Trim_Single'],
    wide: [],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: [],
    shopWall: 'Brick_Plain_3',
    band: null,
    door: { frame: 'DoorFrame_Wooden', leaf: null },
    cornice: 'Cornice_Brick_Center',
    column: null,
    roof: 'mansard',
  },
  housePale: {
    id: 'housePale',
    roles: { brick: 'brick_pale', brickPale: 'brick_pale', trim: 'trim_light', wall: 'brick_pale' },
    windows: ['Brick_Window_Square_Single', 'Brick_Window_Trim_Single'],
    wide: [],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: [],
    shopWall: 'Brick_Plain_3',
    band: null,
    door: { frame: 'DoorFrame_Wooden', leaf: null },
    cornice: 'Cornice_Brick_Center',
    column: null,
    roof: 'mansard',
  },
  // Low brick halls with big metal windows (workshops, depots: not the factories of the large parcels).
  works: {
    id: 'works',
    roles: { brick: 'brick_brown', brickPale: 'brick_brown', trim: 'trim_dark', trimGreen: 'trim_dark', metal: 'metal', wall: 'brick_brown' },
    windows: ['Metal_FullWindow'],
    wide: ['Metal_Window'],
    plain: 'Brick_Plain_3',
    plain1: 'Brick_Plain_1',
    shop: ['Metal_FirstFloor_Window'],
    shopWall: 'Metal_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Metal_Single', leaf: 'Door_2' },
    cornice: 'Cornice_Brick_Center',
    column: null,
    roof: 'flat',
  },
  worksGrey: {
    id: 'worksGrey',
    roles: { brick: 'brick_grey', brickPale: 'brick_grey', trim: 'trim_dark', trimGreen: 'trim_dark', metal: 'metal_navy', wall: 'concrete' },
    windows: ['Metal_FullWindow'],
    wide: ['Metal_Window'],
    plain: 'Metal_Plain_3',
    plain1: 'Metal_Plain_1',
    shop: ['Metal_FirstFloor_Window'],
    shopWall: 'Metal_FirstFloor_Wall',
    band: 'Metal_FirstFloor_Wall_1',
    door: { frame: 'DoorFrame_Metal_Single', leaf: 'Door_2' },
    cornice: 'Cornice_Metal_Center',
    column: null,
    roof: 'flat',
  },
};

/** Every kit piece a style can use (the module list of the prepared city). */
export const MODULE_PIECES: string[] = (() => {
  const s = new Set<string>(['Roof_Slate_Center', 'Roof_Slate_Corner', 'Roof_Slate_Window_1']);
  for (const st of Object.values(STYLES)) {
    for (const n of [...st.windows, ...st.wide, st.plain, st.plain1, ...st.shop, st.shopWall, st.band, st.door.frame, st.door.leaf, st.cornice]) if (n) s.add(n);
    if (st.column) for (const n of [st.column.bottom, st.column.centre, st.column.top]) s.add(n);
  }
  return [...s].sort();
})();

/** Largest stretch of a prototype instance (frontage or depth), and the most a frontage may shrink. */
const STRETCH = 1.2;
const SHRINK = 0.85;

interface DistrictRules {
  styles: [string, number][];
  floors: [number, number];
  /** Floors near the 3+3 arterials and the plaza. */
  tallFloors: [number, number];
  /** Ground floor height (shops: 3 m kit floor + 1 m band) or plain 3 m. */
  ground: 'shop' | 'house';
  /** Frontages and depths offered, m (multiples of 2). */
  widths: number[];
  depths: number[];
  /** Corner buildings (two street facades) at the lot's street corners: their sizes, largest first; none: no corner buildings. */
  corners: number[];
  /** Facade line behind the lot line, m [min, max]. */
  setback: [number, number];
  /** Space between neighbours, m [min, max]; chance of none at all. */
  gap: [number, number];
  touching: number;
  /** Clearance kept round the buildings filling the inside of a block behind the street rows, m; none: the inside stays a yard. */
  interior?: number;
  /** Prototypes the district's catalogue grows to before it only reuses (more only where none fits). */
  catalogue: number;
  /** Stretch of a reused prototype's frontage and depth to the lot [min, max]. */
  fit: [number, number];
  /** Instances may be stretched (≤ STRETCH) to fill a lot off the module grid (street walls). */
  stretch: boolean;
  patterns: Pattern[];
}

type Pattern = 'grid' | 'paired' | 'alt' | 'bay';

const RULES: Record<District, DistrictRules> = {
  downtown: {
    styles: [['loft', 3], ['classic', 3], ['modern', 2], ['stone', 2], ['redbrick', 2]],
    floors: [5, 8],
    tallFloors: [7, 10],
    ground: 'shop',
    widths: [8, 12, 16, 20, 24],
    depths: [10, 12, 16, 20],
    corners: [24, 20, 16, 12],
    setback: [0.6, 0.6],
    gap: [0, 0],
    touching: 1,
    catalogue: 30,
    fit: [SHRINK, STRETCH],
    stretch: true,
    patterns: ['grid', 'paired', 'bay', 'grid'],
  },
  commercial: {
    styles: [['modern', 3], ['loft', 2], ['redbrick', 2], ['classic', 2], ['stone', 1]],
    floors: [3, 7],
    tallFloors: [4, 7],
    ground: 'shop',
    widths: [16, 20, 24, 32],
    depths: [14, 16, 20, 24],
    corners: [24, 20, 16],
    setback: [0.6, 1.2],
    gap: [2, 4],
    touching: 0.7,
    interior: 4,
    catalogue: 20,
    fit: [SHRINK, STRETCH],
    stretch: true,
    patterns: ['grid', 'paired', 'bay'],
  },
  residential: {
    styles: [['houseRed', 3], ['housePale', 3], ['classic', 1]],
    floors: [2, 4],
    tallFloors: [2, 4],
    ground: 'house',
    widths: [8, 10, 12, 14],
    depths: [10, 12],
    corners: [],
    setback: [2, 4],
    gap: [2, 4],
    touching: 0,
    interior: 4,
    catalogue: 18,
    fit: [SHRINK, STRETCH],
    stretch: false,
    patterns: ['alt', 'grid', 'paired'],
  },
  industrial: {
    styles: [['works', 1], ['worksGrey', 1]],
    floors: [1, 3],
    tallFloors: [1, 3],
    ground: 'shop',
    widths: [24, 32, 40],
    depths: [20, 24, 32],
    corners: [],
    setback: [4, 8],
    gap: [6, 12],
    touching: 0,
    interior: 8,
    catalogue: 10,
    fit: [SHRINK, STRETCH],
    stretch: false,
    patterns: ['bay', 'alt'],
  },
};

// --- prototypes -------------------------------------------------------------------------------------

/** A side of a building: full street facade, exposed (plain, a few windows), or party wall (plain). */
type SideKind = 'S' | 'E' | 'P';

interface ProtoSpec {
  district: District;
  style: Style;
  w: number;
  d: number;
  floors: number;
  /** Left, right, back. */
  sides: [SideKind, SideKind, SideKind];
  pattern: Pattern;
  rng: Rng;
}

interface Placement {
  m: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  sx: number;
  sy: number;
  sz: number;
  win: number;
}

const place = (m: string, x: number, y: number, z: number, yaw = 0, sx = 1, sy = 1, sz = 1, win = -1): Placement => ({ m, x, y, z, yaw, sx, sy, sz, win });

/** Lit rooms in daylight read as dark glass with something behind: half dark, half lit. */
function windowSlot(rng: Rng): number {
  const r = rng.next();
  return r < 0.5 ? WINDOW_SLOTS[2] : r < 0.75 ? WINDOW_SLOTS[0] : WINDOW_SLOTS[1];
}

/** Column kinds across a facade of `cols` 2 m columns: W window, P plain, B / b a 4 m window (start / rest). */
function rhythm(cols: number, pattern: Pattern, hasWide: boolean): string[] {
  const out: string[] = [];
  if (pattern === 'bay' && hasWide && cols >= 3) {
    // P BB P BB P...: plain piers between 4 m bays, centred.
    const bays = Math.floor((cols - 1) / 3);
    const used = bays * 3 + 1;
    const pad = cols - used;
    for (let i = 0; i < Math.floor(pad / 2); i++) out.push('P');
    out.push('P');
    for (let b = 0; b < bays; b++) out.push('B', 'b', 'P');
    while (out.length < cols) out.push('P');
    return out;
  }
  if (pattern === 'paired' && cols >= 5) {
    const pairs = Math.floor((cols - 1) / 3);
    const used = pairs * 3 + 1;
    const pad = cols - used;
    for (let i = 0; i < Math.floor(pad / 2); i++) out.push('P');
    out.push('P');
    for (let b = 0; b < pairs; b++) out.push('W', 'W', 'P');
    while (out.length < cols) out.push('P');
    return out;
  }
  if (pattern === 'alt') {
    for (let i = 0; i < cols; i++) out.push(i % 2 === 0 ? 'W' : 'P');
    return out;
  }
  for (let i = 0; i < cols; i++) out.push('W');
  return out;
}

/**
 * One facade, in its own frame: x across (−len/2..len/2, left to right seen from the street), facing +Z.
 * Street facades get the full treatment; exposed sides a plain wall with every other window column;
 * party walls are a single plain quad (drawn by the caller).
 */
function facade(spec: ProtoSpec, len: number, kind: 'street' | 'exposed', groundH: number, top: number, doorAt: number | null): Placement[] {
  const { style, rng } = spec;
  const out: Placement[] = [];
  const cols = len / 2;
  const x0 = -len / 2 + 1;
  const pattern = kind === 'street' ? spec.pattern : 'alt';
  const kinds = rhythm(cols, pattern, style.wide.length > 0);
  const winA = rng.pick(style.windows);
  // Some buildings mix a second window type on alternate floors.
  const winB = style.windows.length > 1 && rng.chance(0.35) ? style.windows.find((w) => w !== winA)! : winA;
  const wide = style.wide.length ? rng.pick(style.wide) : null;
  // Ground floor.
  for (let c = 0; c < cols; c++) {
    const x = x0 + c * 2;
    if (c === doorAt) {
      out.push(place(style.door.frame, x, 0, 0));
      if (style.door.leaf) {
        out.push(place(style.door.leaf, x, 0, 0));
        out.push(place(style.door.leaf, x, 0, 0, 0, -1));
      }
    } else if (kind === 'street' && spec.district !== 'residential' && style.shop.length) {
      // Shopfronts, with a plain bay at the ends of wide fronts.
      const end = cols >= 6 && (c === 0 || c === cols - 1);
      out.push(end ? place(style.shopWall, x, 0, 0) : place(rng.pick(style.shop), x, 0, 0, 0, 1, 1, 1, windowSlot(rng)));
    } else {
      const k = kinds[c] === 'B' || kinds[c] === 'b' ? 'W' : kinds[c];
      out.push(k === 'W' ? place(winA, x, 0, 0, 0, 1, 1, 1, windowSlot(rng)) : place(style.plain, x, 0, 0));
    }
    if (groundH > 3) out.push(style.band ? place(style.band, x, 3, 0) : place(style.plain1, x, 3, 0));
  }
  // Upper floors.
  for (let y = groundH, f = 1; y < top - 0.01; y += 3, f++) {
    const win = f % 2 === 0 ? winB : winA;
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * 2;
      const k = kinds[c];
      if (k === 'B' && wide) out.push(place(wide, x + 1, y, 0, 0, 1, 1, 1, windowSlot(rng)));
      else if (k === 'b' && wide) continue;
      else if (k === 'W' || ((k === 'B' || k === 'b') && !wide)) out.push(place(win, x, y, 0, 0, 1, 1, 1, windowSlot(rng)));
      else out.push(place(style.plain, x, y, 0));
    }
  }
  // Cornice (street) or a plain parapet (exposed).
  for (let c = 0; c < cols; c++) out.push(place(kind === 'street' ? style.cornice : style.plain1, x0 + c * 2, top, 0));
  return out;
}

/** Building frame placement of a facade on side 0 front (+Z), 1 right (+X), 2 back (−Z), 3 left (−X). */
function toSide(p: Placement, side: number, w: number, d: number): Placement {
  const yaw = [0, Math.PI / 2, Math.PI, -Math.PI / 2][side];
  const [cx, cz] = [[0, 0], [w / 2, -d / 2], [0, -d], [-w / 2, -d / 2]][side];
  const c = Math.round(Math.cos(yaw));
  const s = Math.round(Math.sin(yaw));
  return { ...p, x: cx + c * p.x + s * p.z, z: cz - s * p.x + c * p.z, yaw: p.yaw + yaw };
}

function buildProto(spec: ProtoSpec): Placement[] {
  const { style, w, d, floors, rng } = spec;
  const groundH = spec.district === 'residential' ? 3 : 4;
  const top = groundH + 3 * (floors - 1);
  const out: Placement[] = [];
  const lens = [w, d, w, d];
  // Front, right, back, left (spec.sides is left, right, back).
  const kinds: SideKind[] = ['S', spec.sides[1], spec.sides[2], spec.sides[0]];
  for (let side = 0; side < 4; side++) {
    const k = kinds[side];
    const len = lens[side];
    if (k === 'P') {
      // Party wall: one plain quad up to the top of the parapet.
      out.push(toSide(place('quad_wall', 0, 0, 0, 0, len, top + 1, 1), side, w, d));
      continue;
    }
    // The entrance: off-centre on street fronts of shops, centred on houses.
    const cols = len / 2;
    const doorAt = side === 0 ? (spec.district === 'residential' ? Math.floor(cols / 2) : rng.int(Math.min(1, cols - 1), Math.max(0, cols - 2))) : null;
    for (const p of facade(spec, len, k === 'S' ? 'street' : 'exposed', groundH, top, doorAt)) out.push(toSide(p, side, w, d));
  }
  // Pilasters on corners where a street facade ends.
  if (style.column) {
    const corners: [number, number, number, number][] = [
      // x, z, sides meeting (front/right/back/left indices)
      [w / 2, 0, 0, 1],
      [-w / 2, 0, 0, 3],
      [w / 2, -d, 2, 1],
      [-w / 2, -d, 2, 3],
    ];
    for (const [x, z, a, b] of corners) {
      if (kinds[a] !== 'S' && kinds[b] !== 'S') continue;
      // L-shaped corner pieces wrap towards −x / −z of their own frame: turn them so that points into the building.
      const yaw = style.column.wrap ? cornerYaw(-Math.sign(x) || 1, z < 0 ? 1 : -1) : 0;
      out.push(place(style.column.bottom, x, 0, z, yaw));
      if (groundH > 3) out.push(place(style.column.centre, x, 3, z, yaw, 1, 1 / 3, 1));
      for (let y = groundH; y < top - 0.01; y += 3) out.push(place(y + 3 >= top - 0.01 ? style.column.top : style.column.centre, x, y, z, yaw));
    }
  }
  // Roof.
  if (style.roof === 'mansard' && w >= 6 && d >= 6) {
    // Slate slopes 2 m deep, 3 m tall on all sides, a dormer every few metres on the street side, flat top.
    for (let side = 0; side < 4; side++) {
      const len = lens[side];
      const cols = len / 2;
      for (let c = 1; c < cols - 1; c++) {
        const dormer = side === 0 && c % 2 === 1 && rng.chance(0.7);
        out.push(toSide(place(dormer ? 'Roof_Slate_Window_1' : 'Roof_Slate_Center', -len / 2 + 1 + c * 2, top + 1, 0, 0, 1, 1, 1, dormer ? windowSlot(rng) : -1), side, w, d));
      }
      out.push(toSide(place('Roof_Slate_Corner', -len / 2 + 1, top + 1, 0), side, w, d));
    }
    out.push(place('quad_roof', 0, top + 4, -d / 2, 0, w - 4, 1, d - 4));
  } else {
    out.push(place('quad_roof', 0, top + 0.85, -d / 2, 0, w - 0.2, 1, d - 0.2));
  }
  return out;
}

/** Yaw that turns an L corner piece (wrapping towards its −x and −z) to wrap towards (ix, iz). */
function cornerYaw(ix: number, iz: number): number {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
    const c = Math.round(Math.cos(yaw));
    const s = Math.round(Math.sin(yaw));
    // local (−1, −1) → (c·−1 + s·−1, −s·−1 + c·−1)
    if (-c - s === ix && s - c === iz) return yaw;
  }
  return 0;
}

// --- placement -------------------------------------------------------------------------------------

export interface BuildingInstance {
  proto: number;
  /** Front centre on the facade line, m; yaw: the front faces (sin, cos). */
  x: number;
  z: number;
  yaw: number;
  /** Stretch of the frontage and depth (lots off the 2 m module grid), 1 = as built. */
  sx: number;
  sz: number;
  /** Colour variant (VARIANTS). */
  variant: number;
  block: number;
  /** World footprint [minX, minZ, maxX, maxZ] of the walls (cornices reach 0.6 m further on street sides). */
  rect: [number, number, number, number];
  h: number;
}

export interface Buildings {
  modules: Module[];
  protos: BuildingProto[];
  /** Placements of all prototypes, PLACE_STRIDE floats each (module index...), in prototype order. */
  placements: number[];
  instances: BuildingInstance[];
  areas: BuildingArea[];
}

type Rect = [number, number, number, number];

const EPS = 1e-3;

function pointInPoly(poly: [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** An axis-aligned rectangle inside a rectilinear polygon: corners inside, no polygon corner inside it. */
function rectInPoly(poly: [number, number][], r: Rect): boolean {
  const [x0, z0, x1, z1] = [r[0] + EPS, r[1] + EPS, r[2] - EPS, r[3] - EPS];
  if (!pointInPoly(poly, x0, z0) || !pointInPoly(poly, x1, z0) || !pointInPoly(poly, x1, z1) || !pointInPoly(poly, x0, z1)) return false;
  for (const [x, z] of poly) if (x > x0 && x < x1 && z > z0 && z < z1) return false;
  return true;
}

const overlaps = (a: Rect, b: Rect, pad: number) => a[0] < b[2] + pad - EPS && b[0] < a[2] + pad - EPS && a[1] < b[3] + pad - EPS && b[1] < a[3] + pad - EPS;

/** Downtown blocks this close to the plaza are tall (the core of the skyline), m. */
const CORE = 200;
/** Lots this much further apart than the district's widest gap still count as neighbours down the street, m. */
const NEAR = 10;
/** A wall this far from a street side (nothing built in between) still faces the street, m. */
const REACH = 8;
/** Road classes, most important first (corner buildings front the more important road). */
const ROAD_RANK = ['arterial3', 'boulevard', 'avenue', 'street', 'alley'];

/** Block lot shrunk away from alleys (their kerb ramp reaches 1.9 m into the lot) and by the cornice overhang elsewhere. */
const ALLEY_CLEAR = 2.5;
const OVERHANG = 0.6;

interface Side {
  i: number;
  a: [number, number];
  b: [number, number];
  dir: [number, number];
  /** Outward (towards the street). */
  n: [number, number];
  len: number;
  street: boolean;
}

/** Sides of a lot polygon; without a block every side counts as a street side. */
function sidesOf(poly: [number, number][], block?: LayoutBlock): Side[] {
  const out: Side[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir: [number, number] = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let n: [number, number] = [-dir[1], dir[0]];
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    if (pointInPoly(poly, mx + n[0] * 0.05, mz + n[1] * 0.05)) n = [-n[0], -n[1]];
    out.push({ i, a, b, dir, n, len, street: !block || block.sides[i] !== 'alley' });
  }
  return out;
}

function offsetPoly(poly: [number, number][], dist: number[]): [number, number][] {
  // Each side moves inwards by its distance; corners are the crossings (rectilinear).
  const sides = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
    let n = [-dir[1], dir[0]];
    if (!pointInPoly(poly, (a[0] + b[0]) / 2 + n[0] * 0.05, (a[1] + b[1]) / 2 + n[1] * 0.05)) n = [-n[0], -n[1]];
    return n;
  });
  return poly.map(([x, z], i) => {
    const p = (i - 1 + poly.length) % poly.length;
    return [x + sides[p][0] * dist[p] + sides[i][0] * dist[i], z + sides[p][1] * dist[p] + sides[i][1] * dist[i]] as [number, number];
  });
}

/** The four sample areas of the A3 checkpoint: a few ordinary blocks of each district. */
export function checkpointAreas(l: CityLayout): { id: string; label: string; district: District; blocks: number[] }[] {
  const centroid = (b: LayoutBlock) => {
    let x = 0;
    let z = 0;
    for (const p of b.lot) {
      x += p[0];
      z += p[1];
    }
    return [x / b.lot.length, z / b.lot.length];
  };
  const plain = (d: District) => l.blocks.filter((b) => b.kind === 'buildings' && b.district === d && !b.landmark);
  const near = (list: LayoutBlock[], x: number, z: number, count: number, radius: number) =>
    list
      .map((b) => ({ b, d: Math.hypot(centroid(b)[0] - x, centroid(b)[1] - z) }))
      .filter((e) => e.d <= radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, count)
      .map((e) => e.b.id);
  const out: { id: string; label: string; district: District; blocks: number[] }[] = [];
  // Downtown: around the plaza (the landmark and the 3+3 crossing are next to it).
  const plaza = l.blocks.find((b) => b.kind === 'plaza');
  const dc = l.districts.find((d) => d.kind === 'downtown')!;
  const [px, pz] = plaza ? centroid(plaza) : [dc.x, dc.z];
  out.push({ id: 'downtown', label: 'A3: Downtown', district: 'downtown', blocks: near(plain('downtown'), px, pz, 10, 260) });
  // Commercial: blocks on a main road, the cluster nearest downtown.
  const onMain = plain('commercial').filter((b) => b.sides.some((s) => s === 'boulevard' || s === 'arterial3'));
  const first = onMain.sort((a, b) => Math.hypot(centroid(a)[0] - px, centroid(a)[1] - pz) - Math.hypot(centroid(b)[0] - px, centroid(b)[1] - pz))[0];
  if (first) out.push({ id: 'commercial', label: 'A3: Commercial', district: 'commercial', blocks: near(plain('commercial'), centroid(first)[0], centroid(first)[1], 5, 240) });
  // Residential and industrial: around the centre of that district nearest the middle of town.
  for (const d of ['residential', 'industrial'] as const) {
    const c = l.districts.filter((q) => q.kind === d).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
    if (!c) continue;
    const list = plain(d);
    const anchor = list.sort((a, b) => Math.hypot(centroid(a)[0] - c.x, centroid(a)[1] - c.z) - Math.hypot(centroid(b)[0] - c.x, centroid(b)[1] - c.z))[0];
    if (anchor) out.push({ id: d, label: `A3: ${d === 'residential' ? 'Residential' : 'Industrial'}`, district: d, blocks: near(list, centroid(anchor)[0], centroid(anchor)[1], d === 'residential' ? 6 : 4, 320) });
  }
  return out;
}

/**
 * Builds on every ordinary block (`buildings`, not the landmark one); large parcels (park, stadium,
 * hospital, mall, factory, warehouse, parking) and the plaza stay empty for their own assets. `sampleOnly`
 * builds the A3 sample areas alone (the checkpoint). The sample areas are reported either way (benchmark views).
 */
/**
 * Buildings on the large parcels, by use: the district whose buildings they are, tall or not, clearance between
 * them (0: one touching complex), the margin round them as a share of the parcel each way (parking, yard).
 */
const COMPLEX: Partial<Record<ParcelUse, { district: District; tall: boolean; pad: number; margin: number }>> = {
  mall: { district: 'commercial', tall: false, pad: 0, margin: 0.25 },
  stadium: { district: 'commercial', tall: false, pad: 0, margin: 0.25 },
  hospital: { district: 'commercial', tall: true, pad: 4, margin: 0.25 },
  landmark: { district: 'downtown', tall: true, pad: 2, margin: 0.25 },
  factory: { district: 'industrial', tall: false, pad: 8, margin: 0.16 },
  warehouse: { district: 'industrial', tall: false, pad: 6, margin: 0.16 },
};

/**
 * Where a large parcel's buildings stand: the middle (less the use's margin each way) of the largest rectangle on the
 * parcel (all of it, or the larger arm of an L), or null for a parcel without buildings (park, car park, plaza,
 * ordinary blocks).
 */
export function parcelCore(b: LayoutBlock): Rect | null {
  const use = b.kind === 'large' ? b.use : b.landmark ? 'landmark' : undefined;
  if (!use || !COMPLEX[use]) return null;
  // Rectilinear lot: its largest inner rectangle has corners on the lot's own x and z lines.
  const xs = [...new Set(b.lot.map((p) => p[0]))].sort((p, q) => p - q);
  const zs = [...new Set(b.lot.map((p) => p[1]))].sort((p, q) => p - q);
  let best: Rect | null = null;
  let area = 0;
  for (let i = 0; i < xs.length; i++) for (let k = i + 1; k < xs.length; k++) for (let j = 0; j < zs.length; j++) for (let m = j + 1; m < zs.length; m++) {
    const r: Rect = [xs[i], zs[j], xs[k], zs[m]];
    const a = (r[2] - r[0]) * (r[3] - r[1]);
    if (a > area && rectInPoly(b.lot, r)) {
      best = r;
      area = a;
    }
  }
  if (!best) return null;
  const w = (best[2] - best[0]) * COMPLEX[use].margin;
  const d = (best[3] - best[1]) * COMPLEX[use].margin;
  return [best[0] + w, best[1] + d, best[2] - w, best[3] - d];
}

/**
 * Fills the free part of `areas` (rectilinear; a building must be inside every one) with buildings of the
 * district's sizes: on a 2 m scan, at each free spot the first size that fits (larger ones first, in random order),
 * `pad` clear of everything in `taken` (which `push` must grow), its front on the nearest of `sides`.
 */
function packArea(areas: [number, number][][], sides: Side[], taken: { rect: Rect }[], rules: DistrictRules, pad: number, rng: Rng, push: (s: Side, rect: Rect, wp: number, dp: number) => void): void {
  let [x0, z0, x1, z1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of areas[0]) {
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  const minW = Math.min(...rules.widths);
  const minD = Math.min(...rules.depths);
  const sizes = rules.widths.flatMap((w) => rules.depths.map((d) => [w, d] as const));
  const clear = (r: Rect) => areas.every((a) => rectInPoly(a, r)) && !taken.some((p) => overlaps(p.rect, r, pad));
  for (let z = z0; z + minD <= z1 + EPS; z += 2) {
    for (let x = x0; x + minD <= x1 + EPS; x += 2) {
      if (taken.some((p) => overlaps(p.rect, [x, z, x, z], pad))) continue;
      // The nearest side (to a small building here) decides which way it faces.
      const cx = x + minW / 2;
      const cz = z + minD / 2;
      let side = sides[0];
      let best = Infinity;
      for (const s of sides) {
        const t = Math.max(0, Math.min(s.len, (cx - s.a[0]) * s.dir[0] + (cz - s.a[1]) * s.dir[1]));
        const dist = Math.hypot(cx - s.a[0] - s.dir[0] * t, cz - s.a[1] - s.dir[1] * t);
        if (dist < best) {
          best = dist;
          side = s;
        }
      }
      const along = Math.abs(side.n[1]) > 0.5;
      const order = sizes.map(([w, d]) => ({ w, d, k: w * d * rng.range(0.6, 1.4) })).sort((a, b) => b.k - a.k);
      for (const { w, d } of order) {
        const rect: Rect = along ? [x, z, x + w, z + d] : [x, z, x + d, z + w];
        if (!clear(rect)) continue;
        push(side, rect, w, d);
        break;
      }
    }
  }
}

export function generateBuildings(l: CityLayout, modules: Module[], seed: number, sampleOnly = false): Buildings {
  const moduleIndex = new Map(modules.map((m, i) => [m.name, i]));
  const protos: BuildingProto[] = [];
  const placements: number[] = [];
  const rng = stream(seed, 'buildings');
  const instances: BuildingInstance[] = [];
  const areas = checkpointAreas(l);
  // Blocks next to a 3+3 arterial or the plaza: taller downtown.
  const tallBlocks = new Set<number>();
  const plaza = l.blocks.find((b) => b.kind === 'plaza');
  const mid = (b: LayoutBlock) => [b.lot.reduce((t, p) => t + p[0], 0) / b.lot.length, b.lot.reduce((t, p) => t + p[1], 0) / b.lot.length];
  for (const b of l.blocks) {
    if (b.sides.includes('arterial3')) tallBlocks.add(b.id);
    if (plaza && b.edges.some((e) => plaza.edges.includes(e))) tallBlocks.add(b.id);
    // The downtown core around the plaza: the skyline peaks there.
    if (plaza && b.district === 'downtown' && Math.hypot(mid(b)[0] - mid(plaza)[0], mid(b)[1] - mid(plaza)[1]) < CORE) tallBlocks.add(b.id);
  }

  const floorRng = stream(seed, 'proto-floors');
  const floorBags: Record<string, number[]> = {};
  const makeProto = (district: District, w: number, d: number, sides: [SideKind, SideKind, SideKind], tall: boolean, nextTo: Set<string>): number => {
    const rules = RULES[district];
    const prng = stream(seed, `proto-${protos.length}`);
    // A style the other prototypes of its shape do not have (if the district has another).
    const styles = rules.styles.filter(([id]) => !nextTo.has(id));
    const choice = styles.length ? styles : rules.styles;
    const total = choice.reduce((s, [, wt]) => s + wt, 0);
    let pick = prng.next() * total;
    let styleId = choice[0][0];
    for (const [id, wt] of choice) {
      pick -= wt;
      if (pick < 0) {
        styleId = id;
        break;
      }
    }
    const style = STYLES[styleId];
    // Floors from a shuffled bag per district and height class: the catalogue spans the whole range evenly.
    const [f0, f1] = tall ? rules.tallFloors : rules.floors;
    const bag = (floorBags[`${district}|${tall}`] ??= []);
    if (!bag.length) bag.push(...floorRng.shuffle(Array.from({ length: f1 - f0 + 1 }, (_, k) => f0 + k)));
    const spec: ProtoSpec = { district, style, w, d, floors: bag.pop()!, sides, pattern: prng.pick(rules.patterns), rng: prng };
    const list = buildProto(spec);
    const slots = ROLES.map((r) => SLOT_INDEX[style.roles[r] ?? DEFAULT_ROLES[r]]);
    const offset = placements.length;
    for (const p of list) {
      const m = moduleIndex.get(p.m);
      if (m === undefined) throw new Error(`Module not prepared: ${p.m}`);
      placements.push(m, p.x, p.y, p.z, p.yaw, p.sx, p.sy, p.sz, p.win);
    }
    const groundH = district === 'residential' ? 3 : 4;
    const top = groundH + 3 * (spec.floors - 1);
    const h = style.roof === 'mansard' ? top + 4 : top + 1;
    const proto: BuildingProto = {
      id: protos.length,
      name: `${district.slice(0, 3)}-${style.id}-${w}x${d}-${spec.floors}F-${sides.join('')}`,
      district,
      style: style.id,
      w,
      d,
      h,
      floors: spec.floors,
      ground: groundH,
      slots,
      wallSlot: slots[ROLES.indexOf('wall')],
      place: [offset, list.length],
      tris: [],
    };
    protos.push(proto);
    sideKinds.push(sides);
    return proto.id;
  };
  const sideKinds: [SideKind, SideKind, SideKind][] = [];
  const RANK: Record<SideKind, number> = { P: 0, E: 1, S: 2 };

  /** A lot laid out in its block, waiting for a prototype: its size, what each side faces, its height class. */
  interface Lot {
    district: District;
    block: number;
    /** Size as built and the module-grid size it was laid out for, m. */
    wa: number;
    da: number;
    wp: number;
    dp: number;
    sides: [SideKind, SideKind, SideKind];
    tall: boolean;
    rect: Rect;
    /** Outward normal of its street side. */
    n: [number, number];
  }
  const lots: Lot[] = [];
  /** A prototype shape fits a lot: frontage and depth within the district's stretch, a facade wherever the lot needs one. */
  const fits = (w: number, d: number, have: [SideKind, SideKind, SideKind], q: Lot) => {
    const [lo, hi] = RULES[q.district].fit;
    const sx = q.wa / w;
    const sz = q.da / d;
    return sx >= lo - EPS && sx <= hi + EPS && sz >= lo - EPS && sz <= hi + EPS && have.every((k, i) => RANK[k] >= RANK[q.sides[i]]);
  };

  const plain = sampleOnly ? areas.flatMap((a) => a.blocks) : l.blocks.filter((b) => b.kind === 'buildings' && !b.landmark).map((b) => b.id);
  {
    for (const bid of plain) {
      const block = l.blocks[bid];
      const rules = RULES[block.district];
      const lotSides = sidesOf(block.lot, block);
      // Buildable: the lot less the alley clearance and the cornice overhang.
      const build = offsetPoly(block.lot, lotSides.map((s) => (s.street ? OVERHANG : ALLEY_CLEAR)));
      const sides = sidesOf(build, block);
      const placed: { rect: Rect; s: Side; wp: number; dp: number; wa: number; da: number }[] = [];
      const tall = tallBlocks.has(bid);
      /**
       * What a wall facing `out` looks onto: a street side of the lot with nothing built in between
       * (within REACH): street facade; an alley: exposed; else a party wall downtown, exposed elsewhere.
       */
      const sideKind = (self: number, out: [number, number]): SideKind => {
        const [x0, z0, x1, z1] = placed[self].rect;
        const wall = out[0] > 0 ? x1 : out[0] < 0 ? x0 : out[1] > 0 ? z1 : z0;
        const along: [number, number] = out[0] !== 0 ? [z0, z1] : [x0, x1];
        for (const s of sides) {
          if (s.n[0] !== out[0] || s.n[1] !== out[1]) continue;
          const line = out[0] !== 0 ? s.a[0] : s.a[1];
          const dist = (line - wall) * (out[0] + out[1]);
          if (dist < -EPS || dist > REACH) continue;
          const lo = Math.max(Math.min(out[0] !== 0 ? s.a[1] : s.a[0], out[0] !== 0 ? s.b[1] : s.b[0]), along[0]);
          const hi = Math.min(Math.max(out[0] !== 0 ? s.a[1] : s.a[0], out[0] !== 0 ? s.b[1] : s.b[0]), along[1]);
          if (hi - lo < (along[1] - along[0]) * 0.5) continue;
          // The strip between the wall and the street must be free.
          const strip: Rect = out[0] !== 0 ? [Math.min(wall, line), lo, Math.max(wall, line), hi] : [lo, Math.min(wall, line), hi, Math.max(wall, line)];
          if (dist > 0.5 && placed.some((p, i) => i !== self && overlaps(p.rect, strip, -0.05))) continue;
          return s.street ? 'S' : 'E';
        }
        return block.district === 'downtown' ? 'P' : 'E';
      };
      /**
       * A building at t along side s, wa wide (a prototype of frontage wp stretched to wa), setback behind
       * the side: the deepest prototype depth that fits the lot and clears the others by pad (the previous
       * one on this side may touch). Where stretching is allowed, the depth grows (≤ STRETCH) to what is
       * free behind it, so lots off the 2 m module grid do not leave slivers.
       */
      const tryPlace = (s: Side, t: number, setback: number, wa: number, depths: number[], pad: number, prev: number): { rect: Rect; dp: number; da: number } | null => {
        const rectAt = (d: number): Rect => {
          const ax = s.a[0] + s.dir[0] * t - s.n[0] * setback;
          const az = s.a[1] + s.dir[1] * t - s.n[1] * setback;
          const bx = ax + s.dir[0] * wa - s.n[0] * d;
          const bz = az + s.dir[1] * wa - s.n[1] * d;
          return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
        };
        const fits = (d: number) => {
          const rect = rectAt(d);
          return rectInPoly(build, rect) && !placed.some((p, i) => overlaps(p.rect, rect, i === prev ? 0 : pad));
        };
        const cap = rules.stretch ? Math.max(...depths) * STRETCH : Math.max(...depths);
        let free = 0;
        for (let d = Math.floor(cap * 2) / 2; d >= Math.min(...depths) - EPS; d -= 0.5) {
          if (fits(d)) {
            free = d;
            break;
          }
        }
        const dp = depths.find((d) => d <= free + EPS);
        if (!dp) return null;
        const da = rules.stretch ? Math.min(free, dp * STRETCH) : dp;
        return { rect: rectAt(da), dp, da };
      };
      const commit = (s: Side, rect: Rect, wp: number, dp: number, wa: number, da: number): number => {
        placed.push({ rect, s, wp, dp, wa, da });
        return placed.length - 1;
      };
      const depthsDesc = [...rules.depths].sort((a, b) => b - a);
      const minW = rules.widths[0];
      /** The width to build for a prototype frontage wp with `room` left on the side: stretched over a leftover too small for another building. */
      const widthFor = (wp: number, room: number) => (rules.stretch && ((room - wp > EPS && room - wp < minW + rules.gap[0] && room <= wp * STRETCH) || (wp > room && room >= wp * SHRINK)) ? room : wp);
      // Corners first, those on the most important roads before the others: a convex corner between two
      // street sides gets a building with both facades, its front on the more important road.
      const corners: { p: Side; s: Side; rank: number }[] = [];
      for (const s of sides) {
        const p = sides[(s.i - 1 + sides.length) % sides.length];
        // Convex: this side leaves the corner away from the previous side's street.
        if (!rules.corners.length || !s.street || !p.street || p.n[0] * s.dir[0] + p.n[1] * s.dir[1] > -0.5) continue;
        corners.push({ p, s, rank: Math.min(ROAD_RANK.indexOf(block.sides[p.i]), ROAD_RANK.indexOf(block.sides[s.i])) });
      }
      corners.sort((a, b) => a.rank - b.rank);
      for (const { p, s } of corners) {
        // Front on the more important road: at the start of s, or at the end of p.
        const front = ROAD_RANK.indexOf(block.sides[p.i]) < ROAD_RANK.indexOf(block.sides[s.i]) ? p : s;
        const other = front === s ? p : s;
        const sizes = rules.corners.filter((w) => w <= front.len + EPS);
        // One of the two largest that fit, else anything that fits.
        const order = [...rng.shuffle(sizes.slice(0, 2)), ...sizes.slice(2)];
        for (const wp of order) {
          const wa = widthFor(wp, front.len);
          const t = front === s ? 0 : front.len - wa;
          const got = tryPlace(front, t, 0, wa, depthsDesc.filter((d) => d <= other.len + EPS), 0, -1);
          if (got) {
            commit(front, got.rect, wp, got.dp, wa, got.da);
            break;
          }
        }
      }
      // Then the street sides, left to right. Without corner buildings a row keeps the setback from a street round
      // the corner as well (no side wall flush with the next street's sidewalk).
      for (const s of sides) {
        if (!s.street) continue;
        const keep = (k: number) => (!rules.corners.length && sides[(s.i + k + sides.length) % sides.length].street ? rules.setback[0] : 0);
        const end = s.len - keep(1);
        let t = keep(-1);
        let prev = -1;
        let guard = 0;
        while (t < end - 4 && guard++ < 400) {
          // Facade line behind the lot line; the buildable polygon already keeps the cornice overhang.
          const setback = Math.max(0, Math.round((rules.setback[0] + rng.next() * (rules.setback[1] - rules.setback[0]) - OVERHANG) * 2) / 2);
          // Room up to the end of the side or the next building already standing on it.
          let room = end - t;
          for (const [i, p] of placed.entries()) {
            const lo = Math.min((p.rect[0] - s.a[0]) * s.dir[0] + (p.rect[1] - s.a[1]) * s.dir[1], (p.rect[2] - s.a[0]) * s.dir[0] + (p.rect[3] - s.a[1]) * s.dir[1]);
            const depth = Math.min(...[[p.rect[0], p.rect[1]], [p.rect[2], p.rect[3]]].map(([x, z]) => (s.a[0] - x) * s.n[0] + (s.a[1] - z) * s.n[1]));
            if (lo > t + EPS && depth < setback + 2) room = Math.min(room, lo - t - (i === prev ? 0 : rules.gap[0]));
          }
          const widths = rules.widths.filter((w) => w <= room / (rules.stretch ? SHRINK : 1) + EPS);
          if (!widths.length) {
            t += 0.5;
            prev = -1;
            continue;
          }
          // Prefer a width that leaves either nothing, a leftover it can stretch over, or room for another building.
          const good = widths.filter((w) => room - w < EPS || widthFor(w, room) === room || room - w >= minW + rules.gap[0]);
          // Random order, the narrowest (a filler) rarely first.
          const order = (good.length ? good : widths)
            .map((w) => ({ w, k: rng.next() ** (w === minW ? 3 : 1) }))
            .sort((a, b) => b.k - a.k)
            .map((e) => e.w);
          let done = false;
          for (const wp of order) {
            const wa = widthFor(wp, room);
            const got = tryPlace(s, t, setback, wa, depthsDesc, rules.gap[0], prev);
            if (!got) continue;
            prev = commit(s, got.rect, wp, got.dp, wa, got.da);
            const gap = rng.chance(rules.touching) ? 0 : Math.round((rules.gap[0] + rng.next() * (rules.gap[1] - rules.gap[0])) / 2) * 2;
            if (gap > 0) prev = -1;
            t += wa + gap;
            done = true;
            break;
          }
          if (!done) {
            t += 0.5;
            prev = -1;
          }
        }
      }
      // Then the inside of the block behind the street rows (it would stay an empty yard): more buildings, none
      // nearer a street than the district's deepest setback (not in the gaps of the street rows).
      if (rules.interior !== undefined) {
        const inner = offsetPoly(build, sides.map((s) => (s.street ? rules.setback[1] : 0)));
        packArea([inner, build], sides, placed, rules, rules.interior, stream(seed, `inner${bid}`), (s, rect, wp, dp) => commit(s, rect, wp, dp, wp, dp));
      }
      // Once the block is complete each wall knows what it faces.
      for (const [i, q] of placed.entries()) {
        const n = q.s.n;
        const right: [number, number] = [n[1], -n[0]];
        const kinds: [SideKind, SideKind, SideKind] = [sideKind(i, [-right[0], -right[1]]), sideKind(i, right), sideKind(i, [-n[0], -n[1]])];
        lots.push({ district: block.district, block: bid, wa: q.wa, da: q.da, wp: q.wp, dp: q.dp, sides: kinds, tall, rect: q.rect, n });
      }
    }
  }

  // Large parcels with buildings (mall, hospital, stadium, landmark, factory, warehouse): a complex in the
  // middle (parcelCore), facades all round; the parking or yard round it is props.ts's.
  if (!sampleOnly) {
    for (const b of l.blocks) {
      const core = parcelCore(b);
      if (!core) continue;
      const c = COMPLEX[b.use ?? 'landmark']!;
      const [x0, z0, x1, z1] = core;
      const poly: [number, number][] = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      const taken: { rect: Rect }[] = [];
      packArea([poly], sidesOf(poly), taken, RULES[c.district], c.pad, stream(seed, `complex${b.id}`), (s, rect, wp, dp) => {
        taken.push({ rect });
        lots.push({ district: c.district, block: b.id, wa: wp, da: dp, wp, dp, sides: ['S', 'S', 'S'], tall: c.tall, rect, n: s.n });
      });
    }
  }

  // The catalogue, per district: the fewest prototype shapes (size and sides) that fit every lot (greedy
  // cover), then more prototypes of the busiest shapes in other styles, up to the district's catalogue
  // and one per three lots.
  const prng = stream(seed, 'building-protos');
  for (const district of [...new Set(lots.map((q) => q.district))]) {
    const rules = RULES[district];
    const mine = lots.filter((q) => q.district === district);
    // Halls are low: a facade on every side costs little and lets one prototype serve any lot.
    const shapeOf = (q: Lot): { w: number; d: number; sides: [SideKind, SideKind, SideKind]; tall: boolean } => ({ w: q.wp, d: q.dp, sides: district === 'industrial' ? ['S', 'S', 'S'] : q.sides, tall: q.tall });
    const candidates = [...new Map(mine.map((q) => { const c = shapeOf(q); return [`${c.w}x${c.d}|${c.sides.join('')}`, c] as const; })).values()];
    const open = new Set(mine);
    const shapes: { w: number; d: number; sides: [SideKind, SideKind, SideKind]; tall: boolean; lots: Lot[]; protos: number[] }[] = [];
    while (open.size) {
      let best = candidates[0];
      let bestN = -1;
      for (const c of candidates) {
        let n = 0;
        for (const q of open) if (fits(c.w, c.d, c.sides, q)) n++;
        if (n > bestN) {
          bestN = n;
          best = c;
        }
      }
      if (bestN <= 0) throw new Error(`No prototype shape fits a ${district} lot`);
      const served = mine.filter((q) => fits(best.w, best.d, best.sides, q));
      for (const q of served) open.delete(q);
      // Tall where most of the lots it serves are.
      const tall = served.filter((q) => q.tall).length * 2 > served.length;
      shapes.push({ ...best, tall, lots: served, protos: [makeProto(district, best.w, best.d, best.sides, tall, new Set())] });
    }
    // A shape serving tall lots (3+3 arterial, plaza) and low ones gets both height classes first: the skyline.
    let count = shapes.length;
    for (const sh of [...shapes].sort((a, b) => b.lots.length - a.lots.length)) {
      const tallLots = sh.lots.filter((q) => q.tall).length;
      if (count >= Math.min(rules.catalogue, mine.length / 3) || tallLots < 2 || tallLots === sh.lots.length) continue;
      const tall = !sh.tall;
      sh.protos.push(makeProto(district, sh.w, sh.d, sh.sides, tall, new Set(sh.protos.map((id) => protos[id].style))));
      count++;
    }
    // Never more than one prototype per three lots: few lots, few prototypes.
    for (; count < Math.min(rules.catalogue, mine.length / 3); count++) {
      const busiest = shapes.reduce((x, y) => (y.lots.length / y.protos.length > x.lots.length / x.protos.length ? y : x));
      if (busiest.lots.length / busiest.protos.length < 2) break;
      // Another style, the other height class if its lots have both.
      const both = busiest.lots.some((q) => q.tall) && busiest.lots.some((q) => !q.tall);
      const tall = both ? busiest.protos.length % 2 === 1 !== busiest.tall : busiest.tall;
      busiest.protos.push(makeProto(district, busiest.w, busiest.d, busiest.sides, tall, new Set(busiest.protos.map((id) => protos[id].style))));
    }
  }

  // Each lot gets the cheapest prototype that fits it: little stretch, few facades built for nothing, its
  // height class, not the prototype or style of a building it touches. One that still touches its own
  // prototype gets another colour variant.
  const chosen: number[] = [];
  const variants: number[] = [];
  for (const [i, q] of lots.entries()) {
    const rules = RULES[q.district];
    const touching = lots.map((_, k) => k).filter((k) => k < i && lots[k].block === q.block && overlaps(lots[k].rect, q.rect, 1));
    const avoid = new Set(touching.map((k) => chosen[k]));
    const nextTo = new Set([...avoid].map((id) => protos[id].style));
    // Down the street (gaps and all, also across a corner): no repeated prototype, outline or height either.
    const near = lots.map((_, k) => k).filter((k) => k < i && lots[k].block === q.block && overlaps(lots[k].rect, q.rect, rules.gap[1] + NEAR));
    const nearProto = new Set(near.map((k) => chosen[k]));
    const nearHeight = (h: number) => near.filter((k) => protos[chosen[k]].h === h).length;
    const nearOutline = (p: BuildingProto) => near.filter((k) => protos[chosen[k]].h === p.h && Math.abs(lots[k].wa - q.wa) < 2.5).length;
    let best = -1;
    let bestCost = Infinity;
    for (const p of protos) {
      const have = sideKinds[p.id];
      if (p.district !== q.district || !fits(p.w, p.d, have, q)) continue;
      const excess = have.reduce((sum, k, j) => sum + RANK[k] - RANK[q.sides[j]], 0);
      const height = q.tall ? (p.floors < rules.tallFloors[0] ? 1 : 0) : p.floors > rules.floors[1] ? 1 : 0;
      const cost =
        4 * Math.abs(Math.log(q.wa / p.w)) + 2 * Math.abs(Math.log(q.da / p.d)) + 0.25 * excess + 0.8 * height +
        (avoid.has(p.id) ? 3 : nearProto.has(p.id) ? 1.2 : 0) + (nextTo.has(p.style) ? 0.6 : 0) + 0.25 * nearHeight(p.h) + 0.4 * nearOutline(p) + 0.3 * prng.next();
      if (cost < bestCost) {
        bestCost = cost;
        best = p.id;
      }
    }
    const proto = best;
    const taken = new Set(touching.filter((k) => chosen[k] === proto).map((k) => variants[k]));
    const free = Array.from({ length: VARIANTS }, (_, v) => v).filter((v) => !taken.has(v));
    const variant = free.length ? prng.pick(free) : prng.int(0, VARIANTS - 1);
    chosen.push(proto);
    variants.push(variant);
    const { w, d, h } = protos[proto];
    const cx = (q.rect[0] + q.rect[2]) / 2 + (q.n[0] * q.da) / 2;
    const cz = (q.rect[1] + q.rect[3]) / 2 + (q.n[1] * q.da) / 2;
    instances.push({ proto, x: cx, z: cz, yaw: Math.atan2(q.n[0], q.n[1]), sx: q.wa / w, sz: q.da / d, variant, block: q.block, rect: q.rect, h });
  }

  // Triangles per prototype and level.
  const f32: number[] = [];
  const u32: number[] = [];
  const packed = packBuildings({ modules, protos, placements, instances, areas: [] }, f32, u32);
  const F = new Float32Array(f32);
  const U = new Uint32Array(u32);
  for (const p of packed.protos) {
    const levels = Array.from({ length: PROTO_LEVELS }, (_, lod) => assembleProto(p, packed.modules, lod, F, U));
    protos[p.id].tris = levels.map((m) => m.index.length / 3);
    protos[p.id].wallSlot = wallSlot(levels[CARD_LEVEL]);
  }
  return {
    modules,
    protos,
    placements,
    instances,
    areas: areas.map((a) => ({ ...a, buildings: instances.filter((i) => a.blocks.includes(i.block)).length })),
  };
}

/** The slot covering most of a card's walls (windows aside). */
function wallSlot(m: AssembledMesh): number {
  const area = new Map<number, number>();
  const P = m.position;
  for (let t = 0; t < m.index.length; t += 3) {
    const [a, b, c] = [m.index[t], m.index[t + 1], m.index[t + 2]];
    const slot = m.slot[a];
    if (slot >= CARD_WINDOW_FLAG || WINDOW_SLOTS.includes(slot) || Math.abs(m.normal[a * 3 + 1]) > 0.5) continue;
    const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const v = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    area.set(slot, (area.get(slot) ?? 0) + cross / 2);
  }
  return [...area].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0;
}

/**
 * Appends module geometry (MODULE_STRIDE floats per vertex, indices) and the
 * prototypes' placements to the city's binary arrays; returns the module table
 * and the prototypes with their placement offsets in those arrays.
 */
export function packBuildings(b: Buildings, f32: number[], u32: number[]): { modules: BuildingModuleDef[]; protos: BuildingProto[] } {
  const modules: BuildingModuleDef[] = [];
  for (const m of b.modules) {
    const lods: [number, number, number, number][] = [];
    for (const g of m.lods) {
      lods.push([f32.length, g.verts.length / MODULE_STRIDE, u32.length, g.index.length / 3]);
      for (const v of g.verts) f32.push(v);
      for (const i of g.index) u32.push(i);
    }
    modules.push(m.stretch ? { name: m.name, lods, stretch: true } : { name: m.name, lods });
  }
  const off = f32.length;
  for (const v of b.placements) f32.push(v);
  return { modules, protos: b.protos.map((p) => ({ ...p, place: [p.place[0] + off, p.place[1]] })) };
}

/** Slot table colour check: every slot used by a prototype exists (guards the role tables above). */
export function checkSlots(protos: BuildingProto[]): void {
  for (const p of protos) for (const s of p.slots) if (!(s >= 0 && s < BUILDING_SLOTS.length)) throw new Error(`${p.name}: bad slot ${s}`);
}
