/**
 * City V2 buildings, shared by the prepare step and the game: the surface table
 * (texture layers, slots, per-instance colour variants), the data layout of
 * facade modules and building prototypes, and the assembly of a prototype's
 * mesh from its modules. Independent of three.js so the headless tests can
 * measure prototypes too.
 *
 * A facade module is a kit piece (Brick_Window_Square_Single...) with its
 * interior-only and glass parts removed, its kit materials turned into roles
 * (brick, trim, window...), at MODULE_LODS levels of detail: as modelled, a
 * fine and a coarse relief (the front cut into rectangles at their depths,
 * with the reveals between them: windows keep their depth and surround, not
 * their mouldings), and a card (a flat wall with the window in front). A
 * prototype is a list of module placements plus the slot each role gets in
 * that building (pale or red brick, dark or green trim...): the same module
 * looks different per building without another material.
 *
 * Every building surface is drawn by one material: base colour and normal
 * maps are texture arrays (one layer per kit texture), the slot table gives a
 * vertex its layer, tint, roughness and share of sky light (CityV2Buildings).
 */

/** Kit textures in the building texture arrays, by layer. */
export const BUILDING_LAYERS = [
  'T_RedBrick',
  'T_Trim',
  'T_MetalConcrete',
  'T_RoofSlate',
  'T_Concrete',
  'T_Concrete_Asphalt',
  'T_lit_interior_1',
  'T_lit_interior_2',
  'T_dark_interior',
] as const;
export type BuildingLayer = (typeof BUILDING_LAYERS)[number];

/** What a part of a module is, from its kit material; a building maps each role to a slot. */
export const ROLES = ['brick', 'brickPale', 'trim', 'trimDark', 'trimGreen', 'metal', 'window', 'slate', 'roof', 'concrete', 'wall'] as const;
export type Role = (typeof ROLES)[number];

/** Roles whose textures tile (bricks, concrete): cards keep their uv in metres; trim sheets get one flat colour. */
export const CARD_TILING: Role[] = ['brick', 'brickPale', 'concrete', 'wall', 'slate', 'roof'];

/** Kit material → role; materials not listed are dropped (interior walls / floors / ceilings, glass). */
export const KIT_ROLE: Record<string, Role> = {
  MI_RedBrick: 'brick',
  MI_RedBrick_Pale: 'brickPale',
  MI_Trim: 'trim',
  MI_Trim_Dark: 'trimDark',
  MI_Trim_Green: 'trimGreen',
  MI_Trim_MetalConcrete: 'metal',
  MI_FakeInterior: 'window',
  MI_FakeInterior_1: 'window',
  MI_FakeInterior_2: 'window',
  MI_FakeInterior_3: 'window',
  MI_FakeInterior_4: 'window',
  MI_Roof_Slate: 'slate',
  MI_Asphalt: 'roof',
  MI_Concrete: 'concrete',
};

export interface BuildingSlot {
  name: string;
  layer: BuildingLayer;
  /** Multiplies the (optionally desaturated) texture colour. */
  tint: [number, number, number];
  /** 0: texture colour as is; 1: its luminance only (then tinted). */
  desat: number;
  roughness: number;
  /** Share of the sky environment light (diffuse and reflections). */
  env: number;
}

/**
 * The kit's material variants (MI_RedBrick_Pale, MI_Trim_Dark, MI_Trim_Green...)
 * share one texture each and differ only in shader parameters the glTF export
 * does not carry; these tints recreate them (compared with the kit previews)
 * and add a few more for variety between buildings. The `_b` slots are the
 * second colour of a building variant (VARIANTS).
 */
export const BUILDING_SLOTS: BuildingSlot[] = [
  { name: 'brick_red', layer: 'T_RedBrick', tint: [0.95, 0.9, 0.88], desat: 0, roughness: 0.9, env: 0.35 },
  { name: 'brick_brown', layer: 'T_RedBrick', tint: [0.62, 0.48, 0.44], desat: 0.25, roughness: 0.9, env: 0.35 },
  { name: 'brick_pale', layer: 'T_RedBrick', tint: [1.42, 1.28, 1.2], desat: 1, roughness: 0.9, env: 0.35 },
  { name: 'brick_grey', layer: 'T_RedBrick', tint: [1.05, 1.06, 1.08], desat: 1, roughness: 0.9, env: 0.35 },
  { name: 'trim', layer: 'T_Trim', tint: [1.18, 1.1, 1.0], desat: 0.6, roughness: 0.85, env: 0.35 },
  { name: 'trim_light', layer: 'T_Trim', tint: [1.22, 1.2, 1.14], desat: 0.75, roughness: 0.85, env: 0.35 },
  { name: 'trim_dark', layer: 'T_Trim', tint: [0.3, 0.3, 0.32], desat: 1, roughness: 0.7, env: 0.6 },
  { name: 'trim_green', layer: 'T_Trim', tint: [0.24, 0.4, 0.32], desat: 1, roughness: 0.7, env: 0.6 },
  { name: 'metal', layer: 'T_MetalConcrete', tint: [0.85, 0.85, 0.85], desat: 0.3, roughness: 0.6, env: 0.6 },
  { name: 'metal_navy', layer: 'T_MetalConcrete', tint: [0.42, 0.48, 0.62], desat: 1, roughness: 0.6, env: 0.6 },
  { name: 'slate', layer: 'T_RoofSlate', tint: [0.8, 0.82, 0.86], desat: 0, roughness: 0.8, env: 0.35 },
  { name: 'roof', layer: 'T_Concrete_Asphalt', tint: [0.75, 0.75, 0.75], desat: 0, roughness: 0.95, env: 0.4 },
  { name: 'concrete', layer: 'T_Concrete', tint: [0.95, 0.95, 0.95], desat: 0, roughness: 0.9, env: 0.35 },
  { name: 'stone', layer: 'T_Concrete', tint: [1.22, 1.14, 0.98], desat: 1, roughness: 0.9, env: 0.35 },
  { name: 'win_lit1', layer: 'T_lit_interior_1', tint: [0.42, 0.42, 0.42], desat: 0, roughness: 0.12, env: 1 },
  { name: 'win_lit2', layer: 'T_lit_interior_2', tint: [0.42, 0.42, 0.42], desat: 0, roughness: 0.12, env: 1 },
  { name: 'win_dark', layer: 'T_dark_interior', tint: [0.42, 0.42, 0.42], desat: 0, roughness: 0.12, env: 1 },
  { name: 'trim_red', layer: 'T_Trim', tint: [0.62, 0.3, 0.24], desat: 1, roughness: 0.75, env: 0.35 },
  { name: 'brick_red_b', layer: 'T_RedBrick', tint: [0.8, 0.68, 0.62], desat: 0.15, roughness: 0.9, env: 0.35 },
  { name: 'brick_brown_b', layer: 'T_RedBrick', tint: [0.76, 0.56, 0.48], desat: 0.2, roughness: 0.9, env: 0.35 },
  { name: 'brick_pale_b', layer: 'T_RedBrick', tint: [1.3, 1.22, 1.2], desat: 1, roughness: 0.9, env: 0.35 },
  { name: 'brick_grey_b', layer: 'T_RedBrick', tint: [0.88, 0.88, 0.9], desat: 1, roughness: 0.9, env: 0.35 },
  { name: 'trim_b', layer: 'T_Trim', tint: [1.08, 1.04, 0.98], desat: 0.7, roughness: 0.85, env: 0.35 },
  { name: 'trim_light_b', layer: 'T_Trim', tint: [1.2, 1.12, 1.0], desat: 0.7, roughness: 0.85, env: 0.35 },
  { name: 'trim_dark_b', layer: 'T_Trim', tint: [0.24, 0.26, 0.3], desat: 1, roughness: 0.7, env: 0.6 },
  { name: 'trim_green_b', layer: 'T_Trim', tint: [0.2, 0.32, 0.38], desat: 1, roughness: 0.7, env: 0.6 },
  { name: 'metal_b', layer: 'T_MetalConcrete', tint: [0.74, 0.75, 0.78], desat: 0.5, roughness: 0.6, env: 0.6 },
  { name: 'metal_navy_b', layer: 'T_MetalConcrete', tint: [0.38, 0.44, 0.48], desat: 1, roughness: 0.6, env: 0.6 },
  { name: 'concrete_b', layer: 'T_Concrete', tint: [0.86, 0.85, 0.82], desat: 0.3, roughness: 0.9, env: 0.35 },
  { name: 'stone_b', layer: 'T_Concrete', tint: [1.12, 1.08, 1.0], desat: 1, roughness: 0.9, env: 0.35 },
];
export const SLOT_INDEX: Record<string, number> = Object.fromEntries(BUILDING_SLOTS.map((s, i) => [s.name, i]));
export const WINDOW_SLOTS = ['win_lit1', 'win_lit2', 'win_dark'].map((n) => SLOT_INDEX[n]);

/**
 * Cheap variety between instances of one prototype: variant k maps each slot
 * to another (0: as built; 1: second colours, dark and first lit windows
 * swapped; 2: dark and second lit windows swapped; 3: second colours).
 * `SLOT_VARIANTS[slot][k]` is the slot drawn.
 */
export const VARIANTS = 4;
export const SLOT_VARIANTS: number[][] = (() => {
  const swap = (a: string, b: string) => (n: string) => (n === a ? b : n === b ? a : n);
  const colour = (n: string) => (SLOT_INDEX[`${n}_b`] !== undefined ? `${n}_b` : n.endsWith('_b') ? n.slice(0, -2) : n);
  const maps: ((n: string) => string)[] = [(n) => n, (n) => swap('win_dark', 'win_lit1')(colour(n)), swap('win_dark', 'win_lit2'), colour];
  return BUILDING_SLOTS.map((s) => maps.map((f) => SLOT_INDEX[f(s.name)]));
})();

/** Card windows are drawn this much nearer in depth (clip space, × w): never behind the wall they sit on. */
export const CARD_WINDOW_FLAG = 64;

/** Module vertex: position (3), normal (3), uv (2), role index (1). */
export const MODULE_STRIDE = 9;
/** Module geometries: as modelled, fine relief, coarse relief, card. */
export const MODULE_LODS = 4;
/** Prototype placement: module, x, y, z, yaw (rad), scale x / y / z, window slot (−1: the building's). */
export const PLACE_STRIDE = 9;
/** Building instance: prototype id, x, z (front centre, on the lot line side), yaw (rad: local +Z = front), stretch of frontage and depth, colour variant. */
export const INSTANCE_STRIDE = 7;

export interface BuildingModuleDef {
  name: string;
  /** [vertex float offset, vertex count, index offset, triangle count] per geometry (MODULE_LODS). */
  lods: [number, number, number, number][];
  /** Built-in unit quad: scaled per placement, uv follows the scale (1 uv per 2 m like the kit's walls). */
  stretch?: boolean;
}

export interface BuildingProto {
  id: number;
  name: string;
  district: string;
  style: string;
  /** Frontage, depth, height to the top of the parapet / roof, m; floors. */
  w: number;
  d: number;
  h: number;
  floors: number;
  /** Ground floor height, m (windows above it are 3 m apart). */
  ground: number;
  /** Slot per role (ROLES order). */
  slots: number[];
  /** The slot covering most of the facades (far boxes are textured with it). */
  wallSlot: number;
  /** [float offset, count] of PLACE_STRIDE placements. */
  place: [number, number];
  /** Triangles per assembly level (PROTO_LEVELS). */
  tris: number[];
}

export interface BuildingArea {
  id: string;
  label: string;
  district: string;
  blocks: number[];
  /** Instances in the area. */
  buildings: number;
}

export interface BuildingsJson {
  /** Texture arrays: one image per kind, layers stacked top to bottom (BUILDING_LAYERS order). */
  albedo: { url: string; size: number };
  normal: { url: string; size: number };
  modules: BuildingModuleDef[];
  protos: BuildingProto[];
  areas: BuildingArea[];
}

/**
 * Levels a prototype is assembled at. 0 (near): the ground floor as modelled
 * (shopfronts, doors, the pilaster bases: placements below NEAR_MODELLED), the
 * next floors in fine relief (below NEAR_FINE), coarse relief above; 1
 * (street): coarse relief below NEAR_FINE, cards above; 2 (card): cards, the
 * walls of each facade plane merged into as few rectangles as they cover.
 */
export const PROTO_LEVELS = 3;
export const CARD_LEVEL = 2;
const NEAR_MODELLED = 2;
const NEAR_FINE = 8;

export interface AssembledMesh {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  /** Slot index per vertex (+ CARD_WINDOW_FLAG on card windows). */
  slot: Float32Array;
  index: Uint32Array;
}

/** A prototype's mesh (at an assembly level) in its own frame (front facade at z = 0 facing +Z, base at y = 0) from its placements. */
export function assembleProto(proto: BuildingProto, modules: BuildingModuleDef[], lod: number, f32: Float32Array, u32: Uint32Array): AssembledMesh {
  const [po, pc] = proto.place;
  let verts = 0;
  let tris = 0;
  const y = (p: number) => f32[p + 2];
  const level = (p: number) => (lod === 0 ? (y(p) < NEAR_MODELLED ? 0 : y(p) < NEAR_FINE ? 1 : 2) : lod === 1 ? (y(p) < NEAR_FINE ? 2 : 3) : 3);
  for (let i = 0; i < pc; i++) {
    const m = modules[f32[po + i * PLACE_STRIDE]];
    const l = m.lods[level(po + i * PLACE_STRIDE)];
    verts += l[1];
    tris += l[3];
  }
  const out: AssembledMesh = { position: new Float32Array(verts * 3), normal: new Float32Array(verts * 3), uv: new Float32Array(verts * 2), slot: new Float32Array(verts), index: new Uint32Array(tris * 3) };
  const roles = new Uint8Array(verts);
  let v = 0;
  let t = 0;
  for (let i = 0; i < pc; i++) {
    const p = po + i * PLACE_STRIDE;
    const m = modules[f32[p]];
    const lvl = level(p);
    const [vo, vc, io, tc] = m.lods[lvl];
    const x = f32[p + 1];
    const y = f32[p + 2];
    const z = f32[p + 3];
    const c = Math.cos(f32[p + 4]);
    const s = Math.sin(f32[p + 4]);
    const sx = f32[p + 5];
    const sy = f32[p + 6];
    const sz = f32[p + 7];
    const win = f32[p + 8];
    // A mirrored placement (a door leaf hung on the other side) turns its triangles over: wind them back.
    const mirror = sx * sy * sz < 0;
    for (let k = 0; k < tc * 3; k += 3) {
      out.index[t + k] = u32[io + k] + v;
      out.index[t + k + 1] = u32[io + k + (mirror ? 2 : 1)] + v;
      out.index[t + k + 2] = u32[io + k + (mirror ? 1 : 2)] + v;
    }
    t += tc * 3;
    for (let k = 0; k < vc; k++) {
      const o = vo + k * MODULE_STRIDE;
      const lx = f32[o] * sx;
      const ly = f32[o + 1] * sy;
      const lz = f32[o + 2] * sz;
      // Yaw about +Y: local +Z → (sin, 0, cos), local +X → (cos, 0, −sin).
      out.position[v * 3] = x + c * lx + s * lz;
      out.position[v * 3 + 1] = y + ly;
      out.position[v * 3 + 2] = z - s * lx + c * lz;
      const nx = f32[o + 3] * Math.sign(sx);
      const nz = f32[o + 5] * Math.sign(sz);
      out.normal[v * 3] = c * nx + s * nz;
      out.normal[v * 3 + 1] = f32[o + 4];
      out.normal[v * 3 + 2] = -s * nx + c * nz;
      // Stretched quads: walls repeat across x and y, roofs across x and z.
      out.uv[v * 2] = m.stretch ? f32[o + 6] * sx : f32[o + 6];
      out.uv[v * 2 + 1] = m.stretch ? f32[o + 7] * (f32[o + 4] > 0.5 ? sz : sy) : f32[o + 7];
      const role = f32[o + 8];
      roles[v] = role;
      out.slot[v] = ROLES[role] === 'window' && win >= 0 ? win : proto.slots[role];
      // Card windows sit 2 cm in front of their wall: drawn nearer in depth (see CARD_WINDOW_FLAG).
      if (lvl === 3 && ROLES[role] === 'window') out.slot[v] += CARD_WINDOW_FLAG;
      v++;
    }
  }
  return lod === CARD_LEVEL ? mergeCard(out, roles) : out;
}

/** Growable mesh arrays. */
class MeshBuf {
  position: number[] = [];
  normal: number[] = [];
  uv: number[] = [];
  slot: number[] = [];
  index: number[] = [];
  vertex(p: ArrayLike<number>, n: ArrayLike<number>, uv: ArrayLike<number>, slot: number): number {
    this.position.push(p[0], p[1], p[2]);
    this.normal.push(n[0], n[1], n[2]);
    this.uv.push(uv[0], uv[1]);
    this.slot.push(slot);
    return this.slot.length - 1;
  }
  mesh(): AssembledMesh {
    return { position: new Float32Array(this.position), normal: new Float32Array(this.normal), uv: new Float32Array(this.uv), slot: new Float32Array(this.slot), index: new Uint32Array(this.index) };
  }
}

interface CardRect {
  sign: number;
  /** Label of what may merge: slot and texture mapping. */
  key: string;
  slot: number;
  /** Flat uv, or null: tiling (uv in metres from the position). */
  uv: [number, number] | null;
  s0: number;
  s1: number;
  t0: number;
  t1: number;
}

/** In-plane coordinates of an axis-aligned plane: (s, t) = (z, y) for x planes, (x, y) for z planes, (x, z) for y planes. */
const PLANE_ST: [number, number][] = [
  [2, 1],
  [0, 2],
  [0, 1],
];

/**
 * Card level: axis-aligned quads (walls, the faces of the boxes standing for
 * columns and cornices) that lie in one plane merge into as few rectangles as
 * cover them, per slot and texture (tiling textures get their uv in metres
 * again); faces where two boxes meet (back to back in one plane) are dropped.
 * Windows stay one quad each (flagged by the assembly to be drawn in front of the wall).
 * Anything else (roof slopes) is kept as is.
 */
function mergeCard(m: AssembledMesh, roles: Uint8Array): AssembledMesh {
  const out = new MeshBuf();
  const planes = new Map<string, { axis: number; off: number; rects: CardRect[] }>();
  const idx = m.index;
  const P = m.position;
  const keepTri = (a: number, b: number, c: number, flag: number) => {
    const ids = [a, b, c].map((i) => out.vertex(P.subarray(i * 3, i * 3 + 3), m.normal.subarray(i * 3, i * 3 + 3), m.uv.subarray(i * 2, i * 2 + 2), m.slot[i] + flag));
    out.index.push(...ids);
  };
  let t = 0;
  while (t < idx.length) {
    const q = t + 6 <= idx.length && idx[t] === idx[t + 3] && idx[t + 2] === idx[t + 4] ? [idx[t], idx[t + 1], idx[t + 2], idx[t + 5]] : null;
    const rect = q ? quadRect(m, q) : null;
    if (!q || !rect) {
      keepTri(idx[t], idx[t + 1], idx[t + 2], 0);
      t += 3;
      continue;
    }
    t += 6;
    const role = ROLES[roles[q[0]]];
    if (role === 'window') {
      keepTri(q[0], q[1], q[2], 0);
      keepTri(q[0], q[2], q[3], 0);
      continue;
    }
    const tiling = CARD_TILING.includes(role);
    const u = m.uv;
    const flat = q.every((i) => Math.abs(u[i * 2] - u[q[0] * 2]) < 1e-4 && Math.abs(u[i * 2 + 1] - u[q[0] * 2 + 1]) < 1e-4);
    if (!tiling && !flat) {
      keepTri(q[0], q[1], q[2], 0);
      keepTri(q[0], q[2], q[3], 0);
      continue;
    }
    const slot = m.slot[q[0]];
    const uv: [number, number] | null = tiling ? null : [u[q[0] * 2], u[q[0] * 2 + 1]];
    const key = `${slot}|${uv ? uv.map((n) => n.toFixed(3)).join(',') : 't'}`;
    const pk = `${rect.axis}|${Math.round(rect.off * 100)}`;
    const plane = planes.get(pk) ?? { axis: rect.axis, off: Math.round(rect.off * 100) / 100, rects: [] };
    planes.set(pk, plane);
    plane.rects.push({ sign: rect.sign, key, slot, uv, s0: rect.s0, s1: rect.s1, t0: rect.t0, t1: rect.t1 });
  }
  for (const plane of planes.values()) mergePlane(plane.axis, plane.off, plane.rects, out);
  return out.mesh();
}

/** An axis-aligned rectangle quad: its plane (axis, offset, facing sign) and extent in the plane's (s, t). */
function quadRect(m: AssembledMesh, q: number[]): { axis: number; sign: number; off: number; s0: number; s1: number; t0: number; t1: number } | null {
  const n = m.normal;
  const P = m.position;
  let axis = -1;
  for (let k = 0; k < 3; k++) if (Math.abs(n[q[0] * 3 + k]) > 0.999) axis = k;
  if (axis < 0) return null;
  const sign = Math.sign(n[q[0] * 3 + axis]);
  const off = P[q[0] * 3 + axis];
  const [si, ti] = PLANE_ST[axis];
  let s0 = Infinity;
  let s1 = -Infinity;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const i of q) {
    if (Math.abs(P[i * 3 + axis] - off) > 1e-4 || Math.abs(n[i * 3 + axis] - sign) > 1e-3) return null;
    s0 = Math.min(s0, P[i * 3 + si]);
    s1 = Math.max(s1, P[i * 3 + si]);
    t0 = Math.min(t0, P[i * 3 + ti]);
    t1 = Math.max(t1, P[i * 3 + ti]);
  }
  // Every corner is a corner of the extent.
  for (const i of q) {
    const s = P[i * 3 + si];
    const tt = P[i * 3 + ti];
    if ((Math.abs(s - s0) > 1e-4 && Math.abs(s - s1) > 1e-4) || (Math.abs(tt - t0) > 1e-4 && Math.abs(tt - t1) > 1e-4)) return null;
  }
  if (s1 - s0 < 1e-4 || t1 - t0 < 1e-4) return null;
  return { axis, sign, off, s0, s1, t0, t1 };
}

const uniq = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.filter((x, i) => i === 0 || x - s[i - 1] > 1e-4);
};

/** Merges one plane's rectangles: a grid on their edges, cells labelled by what covers them, labels grown into rectangles. */
function mergePlane(axis: number, off: number, rects: CardRect[], out: MeshBuf): void {
  const ss = uniq(rects.flatMap((r) => [r.s0, r.s1]));
  const ts = uniq(rects.flatMap((r) => [r.t0, r.t1]));
  const ns = ss.length - 1;
  const nt = ts.length - 1;
  const label = new Int32Array(ns * nt).fill(-1);
  const front = new Uint8Array(ns * nt);
  const back = new Uint8Array(ns * nt);
  const find = (v: number[], x: number) => {
    let lo = 0;
    let hi = v.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] < x - 1e-4) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  rects.forEach((r, ri) => {
    const [i0, i1, j0, j1] = [find(ss, r.s0), find(ss, r.s1), find(ts, r.t0), find(ts, r.t1)];
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        label[j * ns + i] = ri;
        if (r.sign > 0) front[j * ns + i] = 1;
        else back[j * ns + i] = 1;
      }
    }
  });
  // Back to back: inside the merged boxes.
  for (let c = 0; c < label.length; c++) if (front[c] && back[c]) label[c] = -1;
  const key = (c: number) => (label[c] < 0 ? null : `${rects[label[c]].sign}|${rects[label[c]].key}`);
  const used = new Uint8Array(ns * nt);
  const [si, ti] = PLANE_ST[axis];
  for (let j = 0; j < nt; j++) {
    for (let i = 0; i < ns; i++) {
      const c = j * ns + i;
      const k = key(c);
      if (k === null || used[c]) continue;
      let w = 1;
      while (i + w < ns && !used[c + w] && key(c + w) === k) w++;
      let h = 1;
      grow: while (j + h < nt) {
        for (let d = 0; d < w; d++) if (used[(j + h) * ns + i + d] || key((j + h) * ns + i + d) !== k) break grow;
        h++;
      }
      for (let jj = j; jj < j + h; jj++) for (let ii = i; ii < i + w; ii++) used[jj * ns + ii] = 1;
      const r = rects[label[c]];
      const [s0, s1, t0, t1] = [ss[i], ss[i + w], ts[j], ts[j + h]];
      // Corners counter-clockwise seen from the side the face looks to.
      const st: [number, number][] =
        axis === 2 ? (r.sign > 0 ? [[s0, t0], [s1, t0], [s1, t1], [s0, t1]] : [[s1, t0], [s0, t0], [s0, t1], [s1, t1]])
        : axis === 0 ? (r.sign > 0 ? [[s1, t0], [s0, t0], [s0, t1], [s1, t1]] : [[s0, t0], [s1, t0], [s1, t1], [s0, t1]])
        : r.sign > 0 ? [[s0, t1], [s1, t1], [s1, t0], [s0, t0]] : [[s0, t0], [s1, t0], [s1, t1], [s0, t1]];
      const n = [0, 0, 0];
      n[axis] = r.sign;
      const ids = st.map(([s, t]) => {
        const p = [0, 0, 0];
        p[axis] = off;
        p[si] = s;
        p[ti] = t;
        // Tiling: 1 uv per 2 m, v down the wall (as the kit's walls); roofs and tops in plan.
        const uv = r.uv ?? (axis === 1 ? [p[0] / 2, p[2] / 2] : [s / 2, -t / 2]);
        return out.vertex(p, n, uv, r.slot);
      });
      out.index.push(ids[0], ids[1], ids[2], ids[0], ids[2], ids[3]);
    }
  }
}
