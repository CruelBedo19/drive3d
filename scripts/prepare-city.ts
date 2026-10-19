/**
 * Turns the "drive for speed - map" city (assets-src/maps, amogusstrikesback2,
 * CC BY-NC 4.0, ~188 MB, 12,103 meshes, ~3 M triangles) into a streamable,
 * game-ready city:
 *
 *  public/assets/city/city.glb      prototypes + ground cells, meshopt-compressed, WebP textures
 *  public/assets/city/city-data.json / .bin   layout, colliders, road points (see CityData.ts)
 *  public/assets/city/city-map.png  top-down minimap image
 *
 *  - Units: the source is in centimetres under a 0.01 node: everything is
 *    baked to metres (+Y up), nothing is scaled at runtime.
 *  - Only 654 distinct geometries exist (trees, bushes, benches, houses are
 *    copies): each is stored once as a prototype; every placement becomes an
 *    instance matrix in its 250 m cell. The game merges a cell's instances
 *    per material when the cell streams in (few draw calls, little download).
 *  - Ground (streets, blocks, parking, beach, hills) and very large pieces are
 *    baked and cut into the cells by triangle; they are also the drive
 *    surface (trimesh colliders per cell). Buildings and big props get box
 *    colliders (their oriented bounding box), tree trunks a slim box; small
 *    decoration (bins, bags, signs, bushes, graffiti) none.
 *  - LOD: buildings and plants with > 300 triangles get a simplified
 *    prototype (meshoptimizer, sharing the vertex data) for distant cells.
 *  - Road points every ~8 m (position, height, street direction) for spawn,
 *    Shift+R and the minimap; zone centres become admin teleports.
 *
 * `npm run prepare:city`
 */
import { Document, NodeIO, type Accessor, type Material, type Mesh, type Node, type Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { createHash } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { auditCity, type AuditPiece, type AuditResult } from './lib/cityAnalysis';
import { DETAIL_OFFSET, cleanPrototype, offsetAlongNormals, type CleanupStats } from './lib/cityCleanup';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'assets-src/maps/drive_for_speed_-_map.glb');
/** `--out <dir>`: write elsewhere; `--no-cleanup`: the raw geometry, for before/after comparisons. */
const argOut = process.argv.indexOf('--out');
const OUT = argOut > 0 ? process.argv[argOut + 1] : join(ROOT, 'public/assets/city');
const CLEANUP = !process.argv.includes('--no-cleanup');
const CELL = 250;
const MAP_RES = 2; // metres per minimap pixel

const GROUND_MATS = new Set(['Blocks', 'Street', 'Street_1', 'Street_texture', 'Parking', 'MaterialPiso', 'Texture_garage_claro_PisoSombra', 'Texture_garage_claro_PisoSombra_1']);
const ROAD_MATS = new Set(['Street', 'Street_1']);
const BUILDING_MATS = new Set(['Building', 'Buildings_texture_1024', 'Buildings_texture_1025', 'Auxiliar_texture_1024', 'Default-Material']);
/** Props that are solid (you crash into them); other props are decoration. */
const SOLID_PROP = /barrera|barrier|valla|fence|container|contenedor|truck|scania|peterbilt|mercedes|concrete mixer|grua|bus ?stop|cartel|billboard|kiosk|ship|crane/i;

type Category = 'ground' | 'water' | 'building' | 'vegetation' | 'prop';

interface Proto {
  id: number;
  mesh: Mesh;
  name: string;
  material: string;
  category: Category;
  tris: number;
  /** Local AABB (source units). */
  min: number[];
  max: number[];
  lod?: Mesh;
  collider: 'box' | 'trunk' | null;
}

interface Instance {
  proto: Proto;
  m: Float64Array; // world matrix in metres (column-major)
  min: number[];
  max: number[];
  zone: string;
  category: Category;
  bake: boolean;
  /** Drawn matrix when it differs from `m` (overlapping copies separated by a few mm); colliders keep `m`. */
  draw?: Float64Array;
}

const mul = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => {
  const o = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
};
const xf = (m: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

function accessorBytes(a: Accessor | null): Buffer {
  if (!a) return Buffer.alloc(0);
  const arr = a.getArray()!;
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function geometryKey(mesh: Mesh): string {
  const h = createHash('md5');
  for (const p of mesh.listPrimitives()) {
    h.update(accessorBytes(p.getAttribute('POSITION')));
    h.update(accessorBytes(p.getIndices()));
    h.update(p.getMaterial()?.getName() ?? '');
  }
  return h.digest('hex');
}

function localBounds(mesh: Mesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  const v = [0, 0, 0];
  for (const p of mesh.listPrimitives()) {
    const a = p.getAttribute('POSITION')!;
    for (let i = 0; i < a.getCount(); i++) {
      a.getElement(i, v);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  }
  return { min, max };
}

function worldBox(m: ArrayLike<number>, min: number[], max: number[]): { min: number[]; max: number[] } {
  const wmin = [Infinity, Infinity, Infinity];
  const wmax = [-Infinity, -Infinity, -Infinity];
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const p = xf(m, x, y, z);
    for (let k = 0; k < 3; k++) {
      wmin[k] = Math.min(wmin[k], p[k]);
      wmax[k] = Math.max(wmax[k], p[k]);
    }
  }
  return { min: wmin, max: wmax };
}

/** Per cell & material: baked triangles in world metres. */
class CellBake {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(SOURCE);
  const root = doc.getRoot();
  const scene = root.listScenes()[0];

  // --- 1. Prototypes and instances ---------------------------------------------------------
  const S100 = new Float64Array([100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 100, 0, 0, 0, 0, 1]);
  const protos = new Map<string, Proto>();
  const instances: Instance[] = [];
  const zoneOf = (n: Node): string => {
    let p: Node | null = n;
    while (p) {
      const name = p.getName();
      if (/^(Zona_|Coast|BigPark|WaterPArk|Blocks|Buildings)/.test(name)) return name;
      p = p.getParentNode();
    }
    return 'other';
  };
  for (const n of root.listNodes()) {
    const mesh = n.getMesh();
    if (!mesh) continue;
    const key = geometryKey(mesh);
    let proto = protos.get(key);
    if (!proto) {
      const b = localBounds(mesh);
      const mat = mesh.listPrimitives()[0].getMaterial()?.getName() ?? '';
      const tris = mesh.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0);
      proto = { id: protos.size, mesh, name: n.getName().replace(/_[A-Za-z0-9 ]+_\d+$/, ''), material: mat, category: 'prop', tris, min: b.min, max: b.max, collider: null };
      protos.set(key, proto);
    }
    const m = mul(S100, n.getWorldMatrix());
    const wb = worldBox(m, proto.min, proto.max);
    instances.push({ proto, m, min: wb.min, max: wb.max, zone: zoneOf(n), category: 'prop', bake: false });
  }
  console.log(`${instances.length} placements, ${protos.size} distinct geometries`);

  // Categories (per instance: size decides whether a "Building" piece is really ground).
  for (const inst of instances) {
    const p = inst.proto;
    const ext = Math.max(inst.max[0] - inst.min[0], inst.max[2] - inst.min[2]);
    const h = inst.max[1] - inst.min[1];
    let c: Category;
    if (/^Water/.test(p.material)) c = 'water';
    else if (GROUND_MATS.has(p.material) || (ext > 60 && h < 6)) c = 'ground';
    else if (p.material === 'Vegetation') c = 'vegetation';
    else if (BUILDING_MATS.has(p.material)) c = 'building';
    else c = 'prop';
    inst.category = c;
    // Ground, water and huge pieces (hills, stadium, bridges, ships) are baked into the cells.
    inst.bake = c === 'ground' || c === 'water' || ext > 90;
  }
  for (const p of protos.values()) {
    const cats = instances.filter((i) => i.proto === p && !i.bake).map((i) => i.category);
    p.category = cats[0] ?? 'ground';
  }

  // --- 1b. Whole-map audit, then the automatic visual cleanup ---------------------------------------
  const cellOfXZ = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  /** World triangles of a placement from its prototype's current (or snapshot) geometry. */
  const pieceOf = (i: Instance, tris?: number[], drawn = false): AuditPiece => {
    const im = (drawn && i.draw) || i.m;
    const out: number[] = [];
    const materials: { start: number; name: string }[] = [];
    const pv = [0, 0, 0];
    if (tris) materials.push({ start: 0, name: '' });
    else
      for (const prim of i.proto.mesh.listPrimitives()) {
        materials.push({ start: out.length / 9, name: prim.getMaterial()?.getName() ?? '' });
        const pos = prim.getAttribute('POSITION')!;
        const idx = prim.getIndices()!;
        for (let k = 0; k < idx.getCount(); k++) {
          pos.getElement(idx.getScalar(k), pv);
          out.push(...xf(im, pv[0], pv[1], pv[2]));
        }
      }
    return { tris: new Float32Array(tris ?? out), materials, protoId: i.proto.id, category: i.category, name: i.proto.name, m: im, min: i.min, max: i.max, baked: i.bake };
  };
  const before = auditCity(instances.map((i) => pieceOf(i)), cellOfXZ, (s) => console.log(`before ${s}`));
  if (process.argv.includes('--audit-only')) {
    console.log(JSON.stringify(before.report, null, 1));
    return;
  }

  // Exact duplicate placements (same prototype, same transform): drop the copies.
  {
    const seenPlacement = new Set<string>();
    const r = (x: number, q: number) => Math.round(x / q);
    for (let k = instances.length - 1; k >= 0; k--) {
      const m = instances[k].m;
      const key = `${instances[k].proto.id}|${[0, 1, 2, 4, 5, 6, 8, 9, 10].map((c) => r(m[c], 1e-3)).join(',')}|${[12, 13, 14].map((c) => r(m[c], 0.005)).join(',')}`;
      if (seenPlacement.has(key)) instances.splice(k, 1);
      else seenPlacement.add(key);
    }
  }
  // Colliders and road data keep using the original geometry (snapshot before any visual change).
  const snapshot = new Map<Primitive, { pos: Float32Array; idx: Uint32Array }>();
  for (const p of protos.values()) for (const prim of p.mesh.listPrimitives()) snapshot.set(prim, { pos: Float32Array.from(prim.getAttribute('POSITION')!.getArray() as ArrayLike<number>), idx: Uint32Array.from(prim.getIndices()!.getArray() as ArrayLike<number>) });

  // Per prototype: its own duplicates, detail faces, redundant back-to-back faces, hidden bottoms.
  const cleanStats: CleanupStats = { removedDuplicates: 0, removedBackToBack: 0, removedBottoms: 0, offsetFaces: 0 };
  const firstOf = new Map<Proto, Instance>();
  for (const i of instances) if (!firstOf.has(i.proto)) firstOf.set(i.proto, i);
  for (const [p, inst] of CLEANUP ? firstOf : []) {
    const piece = pieceOf(inst);
    const a = auditCity([piece], cellOfXZ, () => {}, { collectPairs: true });
    const scale = Math.hypot(inst.m[0], inst.m[1], inst.m[2]);
    const restsOnGround = (inst.category === 'building' || inst.category === 'prop') && !inst.bake;
    // All placements must agree on "up" for the bottom rule (rotations about the vertical only).
    const upY = (m: ArrayLike<number>) => [m[4], m[5], m[6]].map((c) => c / Math.hypot(m[4], m[5], m[6]));
    const u0 = upY(inst.m);
    const sameUp = instances.every((o) => o.proto !== p || upY(o.m).every((c, k) => Math.abs(c - u0[k]) < 1e-3));
    const tri = piece.tris;
    const isBottom = (t: number) => {
      if (!restsOnGround || !sameUp) return false;
      const o = t * 9;
      const ux = tri[o + 3] - tri[o], uy = tri[o + 4] - tri[o + 1], uz = tri[o + 5] - tri[o + 2];
      const wx = tri[o + 6] - tri[o], wy = tri[o + 7] - tri[o + 1], wz = tri[o + 8] - tri[o + 2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      return l > 0 && ny / l < -0.98 && Math.max(tri[o + 1], tri[o + 4], tri[o + 7]) < inst.min[1] + 0.03;
    };
    cleanPrototype(p.mesh, a, scale, isBottom, cleanStats);
  }
  console.log(`cleanup: removed ${cleanStats.removedDuplicates} duplicate, ${cleanStats.removedBackToBack} redundant back-to-back, ${cleanStats.removedBottoms} hidden bottom faces; ${cleanStats.offsetFaces} detail faces pushed ${DETAIL_OFFSET * 1000} mm`);

  // Between pieces: what is left after the per-prototype pass.
  const betweenPieces = instances.map((i) => pieceOf(i));
  const between = auditCity(betweenPieces, cellOfXZ, (s) => console.log(`between pieces ${s}`), { collectPairs: true });
  const pieceIdx = (t: number) => between.pieceOf[t];
  // (a) Placed detail pieces lying on bigger placed pieces: push the detail prototype out 4 mm (all its placements).
  const vol = (i: Instance) => Math.max(1e-6, (i.max[0] - i.min[0]) * (i.max[1] - i.min[1]) * (i.max[2] - i.min[2]));
  const detailProtos = new Set<Proto>();
  const markDetail = (ti: number, tj: number) => {
    const a = instances[pieceIdx(ti)];
    const b = instances[pieceIdx(tj)];
    if (a === b || a.bake || b.bake) return;
    // The smaller piece goes 4 mm out (its faces win where the two coincide); the larger keeps its place.
    const [small, big] = vol(a) < vol(b) ? [a, b] : [b, a];
    if (small.proto !== big.proto && !detailProtos.has(big.proto)) detailProtos.add(small.proto);
  };
  for (const p of between.pairs) if (p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate') markDetail(p.i, p.j);
  for (const [d, o] of between.dups) markDetail(d, o);
  // (a') Overlapping placed pieces the prototype offset can't separate (two copies of the same
  // prototype sharing faces: stacked floors, wall modules end to end, a house placed twice). The
  // linked copies are coloured (linked ones differ) and copy level k is drawn moved by k steps along
  // one direction chosen per group so that every conflicting face normal of the group gets a share of
  // it (step 3…6 mm: ≥ 2.5 mm along each such normal).
  // Colliders keep the original matrix. Called again with what the first drawn audit still finds.
  const SEPARATE = 0.003;
  const MAX_MOVE = 0.01;
  const linked = new Map<Instance, Set<Instance>>();
  const conflictNormals = new Map<Instance, number[]>();
  const copyLevel = new Map<Instance, number>();
  const extraMove = new Map<Instance, number[]>(); // world metres, on top of the level move
  const DIRS: number[][] = [];
  for (let k = 0; k < 400; k++) {
    // Fibonacci half-sphere, pointing down: candidate move directions (a moved copy sinks into the
    // ground by a few mm rather than lifting off it).
    const y = -(1 - (k + 0.5) / 400);
    const r = Math.sqrt(1 - y * y);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    DIRS.push([Math.cos(phi) * r, y, Math.sin(phi) * r]);
  }
  const triNormal = (tris: Float32Array, local: number): number[] => {
    const o = local * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const wx = tris[o + 6] - tris[o], wy = tris[o + 7] - tris[o + 1], wz = tris[o + 8] - tris[o + 2];
    const n = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return n.map((c) => c / l);
  };
  let separated = 0;
  const separateCopies = (audit: AuditResult, pieces: AuditPiece[]): void => {
    const link = (ti: number, tj: number) => {
      const a = instances[audit.pieceOf[ti]];
      const b = instances[audit.pieceOf[tj]];
      if (a === b || a.bake || b.bake) return;
      const [small, big] = vol(a) < vol(b) ? [a, b] : [b, a];
      if (small.proto !== big.proto && detailProtos.has(small.proto) && !detailProtos.has(big.proto) && audit === between) return;
      for (const [x, y] of [[a, b], [b, a]]) {
        if (!linked.has(x)) linked.set(x, new Set());
        linked.get(x)!.add(y);
      }
      const k = audit.pieceOf[ti];
      const n = triNormal(pieces[k].tris, ti - audit.pieceStart[k]);
      for (const x of [a, b]) {
        if (!conflictNormals.has(x)) conflictNormals.set(x, []);
        conflictNormals.get(x)!.push(...n);
      }
    };
    for (const p of audit.pairs) if (p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate') link(p.i, p.j);
    for (const [d, o] of audit.dups) link(d, o);
    // Colouring (first pass) / a pair still conflicting in the drawn audit: the smaller one moves up a level.
    for (const k of [...linked.keys()].sort((x, y) => linked.get(y)!.size - linked.get(x)!.size)) {
      if (copyLevel.has(k)) continue;
      const used = new Set([...linked.get(k)!].map((n) => copyLevel.get(n)));
      let s = 0;
      while (used.has(s) && s < 2) s++;
      copyLevel.set(k, s);
    }
    if (audit !== between) {
      // Still conflicting: same level, the smaller goes a level up; different levels (the group's
      // direction is nearly along those faces), the higher one gets an extra move across them.
      const across = new Map<Instance, number[]>();
      for (const p of audit.pairs) {
        if (p.kind !== 'likelyZFight' && p.kind !== 'backToBack' && p.kind !== 'safeDuplicate') continue;
        const a = instances[audit.pieceOf[p.i]];
        const b = instances[audit.pieceOf[p.j]];
        if (a === b || a.bake || b.bake) continue;
        const la = copyLevel.get(a) ?? 0;
        const lb = copyLevel.get(b) ?? 0;
        if (la === lb) {
          const small = vol(a) <= vol(b) ? a : b;
          copyLevel.set(small, Math.min(2, la + 1));
        } else {
          const k = audit.pieceOf[p.i];
          const hi = la > lb ? a : b;
          if (!across.has(hi)) across.set(hi, []);
          across.get(hi)!.push(...triNormal(pieces[k].tris, p.i - audit.pieceStart[k]));
        }
      }
      for (const [inst, ns] of across) {
        let best = DIRS[0];
        let bestScore = -1;
        for (const d of DIRS) {
          let worst = 1;
          for (let i = 0; i < ns.length && worst > bestScore; i += 3) worst = Math.min(worst, Math.abs(d[0] * ns[i] + d[1] * ns[i + 1] + d[2] * ns[i + 2]));
          if (worst > bestScore) {
            bestScore = worst;
            best = d;
          }
        }
        const prev = extraMove.get(inst) ?? [0, 0, 0];
        const step = Math.min(0.006, Math.max(SEPARATE, 0.0025 / Math.max(bestScore, 1e-3)));
        extraMove.set(inst, prev.map((c, a) => c + best[a] * step));
      }
    }
    // One move direction per group of linked copies.
    const dirOf = new Map<Instance, { u: number[]; step: number }>();
    const none = { u: [0, -1, 0], step: 0 };
    for (const start of linked.keys()) {
      if (dirOf.has(start)) continue;
      const group: Instance[] = [];
      const stack = [start];
      dirOf.set(start, none);
      while (stack.length) {
        const x = stack.pop()!;
        group.push(x);
        for (const y of linked.get(x) ?? []) if (!dirOf.has(y)) {
          dirOf.set(y, none);
          stack.push(y);
        }
      }
      const ns = group.flatMap((g) => conflictNormals.get(g) ?? []);
      let best = DIRS[0];
      let bestScore = -1;
      for (const d of DIRS) {
        let worst = 1;
        for (let i = 0; i < ns.length && worst > bestScore; i += 3) worst = Math.min(worst, Math.abs(d[0] * ns[i] + d[1] * ns[i + 1] + d[2] * ns[i + 2]));
        if (worst > bestScore) {
          bestScore = worst;
          best = d;
        }
      }
      // Every conflicting face of the group ends up ≥ 2.5 mm from its twin; 3…6 mm per level.
      const step = Math.min(0.006, Math.max(SEPARATE, 0.0025 / Math.max(bestScore, 1e-3)));
      for (const g of group) dirOf.set(g, { u: best, step });
    }
    separated = 0;
    for (const [inst, level] of copyLevel) {
      inst.draw = undefined;
      if (level === 0 || !CLEANUP) continue;
      const { u, step } = dirOf.get(inst)!;
      const drawn = Float64Array.from(inst.m);
      const extra = extraMove.get(inst) ?? [0, 0, 0];
      const move = [0, 1, 2].map((a) => u[a] * step * level + extra[a]);
      const len = Math.hypot(move[0], move[1], move[2]);
      const k = len > MAX_MOVE ? MAX_MOVE / len : 1; // never more than 1 cm
      for (let a = 0; a < 3; a++) drawn[12 + a] += move[a] * k;
      inst.draw = drawn;
      separated++;
    }
    console.log(`overlapping copies: ${linked.size} placements linked, ${separated} drawn moved a few mm (colliders unchanged)`);
  };
  separateCopies(between, betweenPieces);
  if (CLEANUP) for (const p of detailProtos) offsetAlongNormals(p.mesh, DETAIL_OFFSET, Math.hypot(firstOf.get(p)!.m[0], firstOf.get(p)!.m[1], firstOf.get(p)!.m[2]));
  // (b) Ground surface hierarchy for baked pieces: ground → road → parking / floor → markings, 3 mm per layer,
  // plus 1 mm sub-layers so overlapping pieces of the same layer differ too.
  const rankOf = (mat: string) => (ROAD_MATS.has(mat) ? 1 : /^(Parking|Texture_garage|MaterialPiso)/.test(mat) ? 2 : /^(Street_texture|graffiti|BillboardBlack|Default-Material)/.test(mat) ? 3 : 0);
  const triMat: string[] = []; // material per global (between) triangle, for baked pieces
  instances.forEach((inst, k) => {
    if (!inst.bake) return;
    let t = between.pieceStart[k];
    for (const prim of inst.proto.mesh.listPrimitives()) for (let c = 0; c < prim.getIndices()!.getCount() / 3; c++) triMat[t++] = prim.getMaterial()?.getName() ?? '';
  });
  const neighbours = new Map<number, Set<number>>();
  const lower = new Set<number>(); // baked triangles under a placed piece's face: 2 mm down
  const skip = new Set<number>(); // baked duplicate triangles (same material): not drawn
  const pushOut = new Set<number>(); // baked faces on another baked piece's face (walls, bridge sides): 3 mm along their normal
  const smallerOf = (i: number, j: number) => (between.areas[i] < between.areas[j] ? i : between.areas[j] < between.areas[i] ? j : Math.max(i, j));
  for (const p of between.pairs) {
    const a = instances[pieceIdx(p.i)];
    const b = instances[pieceIdx(p.j)];
    if (a.bake && b.bake && a !== b && (p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate')) pushOut.add(smallerOf(p.i, p.j));
    if (p.kind === 'distanceZFight' || p.kind === 'backToBack' || p.kind === 'likelyZFight' || p.kind === 'safeDuplicate') {
      if (a.bake && b.bake && a !== b && rankOf(triMat[p.i]) === rankOf(triMat[p.j])) {
        const ka = pieceIdx(p.i);
        const kb = pieceIdx(p.j);
        if (!neighbours.has(ka)) neighbours.set(ka, new Set());
        if (!neighbours.has(kb)) neighbours.set(kb, new Set());
        neighbours.get(ka)!.add(kb);
        neighbours.get(kb)!.add(ka);
      } else if (a.bake !== b.bake && p.kind !== 'backToBack') lower.add(a.bake ? p.i : p.j);
    }
  }
  for (const [d, o, same] of between.dups) {
    const a = instances[pieceIdx(d)];
    const b = instances[pieceIdx(o)];
    if (a.bake && b.bake && same) skip.add(d);
    else if (a.bake && b.bake && a !== b) pushOut.add(smallerOf(d, o));
  }
  // Greedy colouring: pieces that overlap get different sub-layers (0, 1, 2).
  const sub = new Map<number, number>();
  for (const k of [...neighbours.keys()].sort((x, y) => neighbours.get(y)!.size - neighbours.get(x)!.size)) {
    const used = new Set([...neighbours.get(k)!].map((n) => sub.get(n)).filter((x) => x !== undefined));
    let s = 0;
    while (used.has(s) && s < 2) s++;
    sub.set(k, s);
  }
  console.log(`hierarchy: ${sub.size} ground pieces in sub-layers, ${lower.size} ground triangles lowered under placed pieces, ${skip.size} duplicate ground triangles not drawn, ${pushOut.size} baked faces marked to push out (non-horizontal ones moved), ${detailProtos.size} detail prototypes pushed out`);

  // --- 2. Bounds and cells ------------------------------------------------------------------
  const bmin = [Infinity, Infinity, Infinity];
  const bmax = [-Infinity, -Infinity, -Infinity];
  for (const i of instances) for (let k = 0; k < 3; k++) {
    bmin[k] = Math.min(bmin[k], i.min[k]);
    bmax[k] = Math.max(bmax[k], i.max[k]);
  }
  const cellKey = cellOfXZ;
  console.log(`city ${((bmax[0] - bmin[0]) / 1000).toFixed(2)} × ${((bmax[2] - bmin[2]) / 1000).toFixed(2)} km, height ${bmin[1].toFixed(0)} … ${bmax[1].toFixed(0)} m`);

  // --- 3. Bake ground / water / huge pieces into cells -----------------------------------------
  const bakes = new Map<string, Map<Material, CellBake>>(); // cell → material → triangles
  const colliderTris = new Map<string, number[]>(); // cell → xyz triangle soup (solid baked pieces, original geometry)
  const roadTris: number[] = []; // xyz triangles of streets (road points / minimap), original geometry
  const mapTris: { tri: number[]; colour: [number, number, number] }[] = [];
  const renderBaked = new Map<number, number[]>(); // instance → drawn world triangles (final audit)
  const renderBakedMats = new Map<number, { start: number; name: string }[]>();
  const bakeRefs = new Map<number, { b: CellBake; o: number }[]>(); // instance → where each drawn triangle went
  const v = [0, 0, 0];
  const nrm = [0, 0, 0];
  const t2 = [0, 0];
  let bakedTris = 0;
  instances.forEach((inst, ii) => {
    if (!inst.bake) return;
    const m = inst.m;
    const drawn: number[] = [];
    const drawnMats: { start: number; name: string }[] = [];
    renderBaked.set(ii, drawn);
    renderBakedMats.set(ii, drawnMats);
    const refs: { b: CellBake; o: number }[] = [];
    bakeRefs.set(ii, refs);
    const level = sub.get(ii) ?? 0;
    let gt = between.pieceStart[ii];
    for (const prim of inst.proto.mesh.listPrimitives()) {
      const mat = prim.getMaterial()!;
      const matName = mat.getName();
      const pos = prim.getAttribute('POSITION')!;
      const norA = prim.getAttribute('NORMAL');
      const uvA = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices()!;
      const orig = snapshot.get(prim)!;
      const isRoad = ROAD_MATS.has(matName);
      const solid = inst.category !== 'water';
      const colour: [number, number, number] = inst.category === 'water' ? [32, 64, 96] : isRoad ? [88, 92, 100] : matName === 'Parking' ? [70, 74, 80] : inst.category === 'ground' ? [52, 58, 50] : [40, 42, 48];
      const rank = rankOf(matName);
      drawnMats.push({ start: drawn.length / 9, name: matName });
      // Original triangles (colliders, streets, minimap): independent of the visual cleanup.
      for (let t = 0; t < orig.idx.length; t += 3) {
        const tri: number[] = [];
        for (let k = 0; k < 3; k++) {
          const i = orig.idx[t + k];
          tri.push(...xf(m, orig.pos[i * 3], orig.pos[i * 3 + 1], orig.pos[i * 3 + 2]));
        }
        const ck = cellKey((tri[0] + tri[3] + tri[6]) / 3, (tri[2] + tri[5] + tri[8]) / 3);
        if (solid) {
          let ct = colliderTris.get(ck);
          if (!ct) colliderTris.set(ck, (ct = []));
          ct.push(...tri);
        }
        if (isRoad) roadTris.push(...tri);
        const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2];
        const wx = tri[6] - tri[0], wy = tri[7] - tri[1], wz = tri[8] - tri[2];
        const ny = uz * wx - ux * wz;
        const len = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx) || 1;
        if (Math.abs(ny / len) > 0.6) mapTris.push({ tri, colour });
      }
      // Drawn triangles: cleaned geometry, layer offsets on up-facing surfaces.
      for (let t = 0; t < idx.getCount(); t += 3, gt++) {
        if (skip.has(gt) && CLEANUP) continue;
        const tri: number[] = [];
        const nn: number[] = [];
        const uu: number[] = [];
        for (let k = 0; k < 3; k++) {
          const i = idx.getScalar(t + k);
          pos.getElement(i, v);
          tri.push(...xf(m, v[0], v[1], v[2]));
          if (norA) {
            norA.getElement(i, nrm);
            const nx = m[0] * nrm[0] + m[4] * nrm[1] + m[8] * nrm[2];
            const ny = m[1] * nrm[0] + m[5] * nrm[1] + m[9] * nrm[2];
            const nz = m[2] * nrm[0] + m[6] * nrm[1] + m[10] * nrm[2];
            const l = Math.hypot(nx, ny, nz) || 1;
            nn.push(nx / l, ny / l, nz / l);
          } else nn.push(0, 1, 0);
          if (uvA) {
            uvA.getElement(i, t2);
            uu.push(t2[0], t2[1]);
          } else uu.push(0, 0);
        }
        const ux = tri[3] - tri[0], uy = tri[4] - tri[1], uz = tri[5] - tri[2];
        const wx = tri[6] - tri[0], wy = tri[7] - tri[1], wz = tri[8] - tri[2];
        const fny = uz * wx - ux * wz;
        const flen = Math.hypot(uy * wz - uz * wy, fny, ux * wy - uy * wx) || 1;
        if (!CLEANUP) {
          // Raw geometry: no layer offsets.
        } else if (fny / flen > 0.7) {
          // 2 mm per layer, 1 mm per sub-layer: at most 8 mm above the base ground.
          const dy = (rank * 2 + level) * 0.001 - (lower.has(gt) ? 0.002 : 0);
          tri[1] += dy;
          tri[4] += dy;
          tri[7] += dy;
        } else if (pushOut.has(gt)) {
          const k = SEPARATE / flen;
          const fnx = (uy * wz - uz * wy) * k, fnz = (ux * wy - uy * wx) * k;
          for (let c = 0; c < 9; c += 3) {
            tri[c] += fnx;
            tri[c + 1] += fny * k;
            tri[c + 2] += fnz;
          }
        }
        const ck = cellKey((tri[0] + tri[3] + tri[6]) / 3, (tri[2] + tri[5] + tri[8]) / 3);
        let cell = bakes.get(ck);
        if (!cell) bakes.set(ck, (cell = new Map()));
        let b = cell.get(mat);
        if (!b) cell.set(mat, (b = new CellBake()));
        refs.push({ b, o: b.pos.length });
        b.pos.push(...tri);
        b.nor.push(...nn);
        b.uv.push(...uu);
        drawn.push(...tri);
        bakedTris++;
      }
    }
  });
  console.log(`baked ${bakedTris} ground / large-piece triangles into ${bakes.size} cells`);

  // Audit of what is drawn now (placed pieces from the cleaned prototypes, baked pieces as drawn),
  // then one more round on what is still left, and the final audit.
  const drawnPieces = () => instances.map((i, k) => (i.bake ? { ...pieceOf(i, renderBaked.get(k)), materials: renderBakedMats.get(k)! } : pieceOf(i, undefined, true)));
  const residual = { rounds: 0, bakedMoved: 0, prototypesCleanedAgain: 0, copiesMoved: 0 };
  for (let round = 1; CLEANUP && round <= 5; round++) {
    const firstPieces = drawnPieces();
    const first = auditCity(firstPieces, cellOfXZ, (s) => console.log(`round ${round}: ${s}`), { collectPairs: true });
    const conflicts = first.pairs.filter((p) => p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate').length + first.dups.length;
    if (conflicts === 0) break;
    residual.rounds = round;
    // (1) Placed copies still conflicting: linked / moved up a level.
    separateCopies(first, firstPieces);
    residual.copiesMoved = separated;
    // (2) Baked triangles still on another face: 2.5 mm apart. Beside a placed piece the baked one goes
    // behind it (ground under a floor, a baked garage wall behind the building's wall); between two baked
    // pieces the smaller keeps its side (or goes to the front) of the larger; back-to-back: along its normal.
    const GAP = 0.0025;
    const tri = (t: number) => {
      const k = first.pieceOf[t];
      return { k, local: t - first.pieceStart[k], tris: firstPieces[k].tris };
    };
    const moves = new Map<number, number[]>();
    const consider = (kind: string, i: number, j: number) => {
      const A = instances[first.pieceOf[i]];
      const B = instances[first.pieceOf[j]];
      if (!A.bake && !B.bake) return;
      const both = A.bake && B.bake; // also two faces of one baked piece
      const [mv, ref] = both ? (first.areas[i] <= first.areas[j] ? [i, j] : [j, i]) : A.bake ? [i, j] : [j, i];
      const m = tri(mv);
      const r = tri(ref);
      let disp: number[];
      if (kind === 'backToBack') {
        const n = triNormal(m.tris, m.local);
        disp = n.map((c) => c * GAP * (both ? 1 : -1));
      } else {
        const n = triNormal(r.tris, r.local);
        const mo = m.local * 9;
        const ro = r.local * 9;
        let sd = 0;
        for (let a = 0; a < 3; a++) sd += ((m.tris[mo + a] + m.tris[mo + 3 + a] + m.tris[mo + 6 + a]) / 3 - r.tris[ro + a]) * n[a];
        const target = !both || sd < -0.0002 ? -GAP : GAP;
        disp = n.map((c) => c * (target - sd));
      }
      const prev = moves.get(mv);
      if (!prev || Math.hypot(...disp) > Math.hypot(...prev)) moves.set(mv, disp);
    };
    for (const p of first.pairs) if (p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate') consider(p.kind, p.i, p.j);
    for (const [d, o] of first.dups) consider('duplicate', d, o);
    for (const [t, disp] of moves) {
      const { k, local } = tri(t);
      const ref = bakeRefs.get(k)![local];
      const drawn = renderBaked.get(k)!;
      for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
        ref.b.pos[ref.o + v * 3 + a] += disp[a];
        drawn[local * 9 + v * 3 + a] += disp[a];
      }
    }
    residual.bakedMoved += moves.size;
    // (3) Faces of one placed prototype still on each other: that prototype's rules once more.
    const again = new Set<Proto>();
    for (const p of first.pairs) {
      if (p.kind !== 'likelyZFight' && p.kind !== 'backToBack' && p.kind !== 'safeDuplicate') continue;
      const A = instances[first.pieceOf[p.i]];
      if (A === instances[first.pieceOf[p.j]] && !A.bake) again.add(A.proto);
    }
    for (const p of again) {
      const inst = firstOf.get(p)!;
      const a = auditCity([pieceOf(inst)], cellOfXZ, () => {}, { collectPairs: true });
      cleanPrototype(p.mesh, a, Math.hypot(inst.m[0], inst.m[1], inst.m[2]), () => false, cleanStats, true);
    }
    residual.prototypesCleanedAgain += again.size;
    console.log(`round ${round}: ${conflicts} conflicts; ${separated} copies drawn apart, ${moves.size} baked triangles moved ${GAP * 1000} mm clear, ${again.size} prototypes cleaned again`);
  }
  {
    const moved = instances.filter((i) => i.draw).map((i) => Math.hypot(i.draw![12] - i.m[12], i.draw![13] - i.m[13], i.draw![14] - i.m[14]));
    const up = instances.filter((i) => i.draw).map((i) => i.draw![13] - i.m[13]);
    console.log(`copies moved: ${moved.length}, largest ${(Math.max(0, ...moved) * 1000).toFixed(1)} mm, over 1 cm ${moved.filter((d) => d > 0.01).length}, highest lift ${(Math.max(0, ...up) * 1000).toFixed(1)} mm`);
  }
  const afterPieces = drawnPieces();
  const after = auditCity(afterPieces, cellOfXZ, (s) => console.log(`after ${s}`), { collectPairs: true });
  {
    // What is left, by kind and place (top groups in the log).
    const tally = new Map<string, number>();
    const add = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
    const ny = (t: number) => {
      const k = after.pieceOf[t];
      const tr = afterPieces[k].tris;
      const o = (t - after.pieceStart[k]) * 9;
      const ux = tr[o + 3] - tr[o], uy = tr[o + 4] - tr[o + 1], uz = tr[o + 5] - tr[o + 2];
      const wx = tr[o + 6] - tr[o], wy = tr[o + 7] - tr[o + 1], wz = tr[o + 8] - tr[o + 2];
      const n = uz * wx - ux * wz;
      return n / (Math.hypot(uy * wz - uz * wy, n, ux * wy - uy * wx) || 1);
    };
    const matOf = (t: number) => {
      const k = after.pieceOf[t];
      const local = t - after.pieceStart[k];
      let name = '';
      for (const m of afterPieces[k].materials) if (m.start <= local) name = m.name;
      return name;
    };
    const describe = (kind: string, i: number, j: number) => {
      const a = instances[after.pieceOf[i]];
      const b = instances[after.pieceOf[j]];
      const dir = (t: number) => (ny(t) > 0.7 ? 'up' : ny(t) < -0.7 ? 'down' : 'side');
      if (a === b) add(`${kind} self ${a.bake ? 'baked' : 'placed'} ${a.proto.name} ${dir(i)}`);
      else if (a.bake && b.bake) add(`${kind} baked-baked ${dir(i)}/${dir(j)} ${[matOf(i), matOf(j)].sort().join('+')}`);
      else if (a.bake || b.bake) {
        const [bk, pl, tb, tp] = a.bake ? [a, b, i, j] : [b, a, j, i];
        add(`${kind} baked-placed ${dir(tb)}/${dir(tp)} ${matOf(tb)} + ${pl.proto.name}`);
        void bk;
      } else add(`${kind} placed-placed ${a.proto === b.proto ? 'same' : 'diff'} L${copyLevel.get(a) ?? '-'}/${copyLevel.get(b) ?? '-'} ${dir(i)} ${[a.proto.name, b.proto.name].sort().join(' + ')}`);
    };
    for (const p of after.pairs) if (p.kind === 'likelyZFight' || p.kind === 'backToBack' || p.kind === 'safeDuplicate') describe(p.kind, p.i, p.j);
    for (const [d, o, same] of after.dups) if (!same) describe('dupDiffMat', d, o);
    const groups = new Map<string, number>();
    for (const [k, n] of tally) {
      const g = k.split(' ').slice(0, 2).join(' ');
      groups.set(g, (groups.get(g) ?? 0) + n);
    }
    console.log('left:', JSON.stringify([...groups].sort((x, y) => y[1] - x[1])));
    console.log([...tally].sort((x, y) => y[1] - x[1]).slice(0, 25).map(([k, n]) => `  ${n}\t${k}`).join('\n'));
    if (process.argv.includes('--diag')) return;
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'city-audit.json'), JSON.stringify({ before: before.report, after: after.report, cleanup: cleanStats, hierarchy: { subLayered: sub.size, lowered: lower.size, skippedGroundDuplicates: skip.size, bakedPushOut: pushOut.size, detailPrototypes: detailProtos.size, separatedCopies: separated }, residual }, null, 1));
  {
    // Debug overlay: what is left after the cleanup.
    const kinds = Object.keys(after.debug) as (keyof typeof after.debug)[];
    const counts = kinds.map((k) => after.debug[k].length / 9);
    const all = new Float32Array(kinds.reduce((s, k) => s + after.debug[k].length, 0));
    let o = 0;
    for (const k of kinds) {
      all.set(after.debug[k], o);
      o += after.debug[k].length;
    }
    writeFileSync(join(OUT, 'city-debug.bin'), Buffer.from(all.buffer));
    writeFileSync(join(OUT, 'city-debug.json'), JSON.stringify({ kinds, counts }));
  }

  // --- 4. Output document: prototypes (+ LOD) and ground cell meshes ----------------------------------
  // Reuse the source document (materials / textures), drop every node, then add our own.
  for (const n of root.listNodes()) n.dispose();
  const out = doc;
  const outScene = scene;
  const buffer = root.listBuffers()[0];
  const used = new Set<Proto>();
  for (const i of instances) if (!i.bake) used.add(i.proto);
  const protoNode = out.createNode('protos');
  outScene.addChild(protoNode);
  let lodCount = 0;
  for (const p of used) {
    p.mesh.setName(`p${p.id}`);
    protoNode.addChild(out.createNode(`p${p.id}`).setMesh(p.mesh));
    // Colliders by kind and size.
    const sx = (p.max[0] - p.min[0]) * 100;
    const sy = (p.max[1] - p.min[1]) * 100;
    const sz = (p.max[2] - p.min[2]) * 100;
    if (p.category === 'building' && sy > 1.5 && Math.max(sx, sz) > 2.5) p.collider = 'box';
    else if (p.category === 'prop' && SOLID_PROP.test(p.name) && Math.max(sx, sy, sz) > 1.2) p.collider = 'box';
    else if (p.category === 'vegetation' && /tree/i.test(p.name) && sy > 4) p.collider = 'trunk';
    // LOD: simplified indices over the same vertices.
    if ((p.category === 'building' || p.category === 'vegetation') && p.tris > 300) {
      const lod = out.createMesh(`p${p.id}_lod`);
      for (const prim of p.mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION')!;
        const idx = prim.getIndices()!;
        const target = Math.max(36, Math.floor((idx.getCount() * 0.25) / 3) * 3);
        const src = Uint32Array.from(idx.getArray()!);
        const [simplified] = MeshoptSimplifier.simplify(src, new Float32Array(pos.getArray()!), 3, target, 0.02, ['LockBorder']);
        const lp = prim.clone();
        lp.setIndices(out.createAccessor().setType('SCALAR').setArray(new Uint32Array(simplified)).setBuffer(buffer));
        lod.addPrimitive(lp);
      }
      p.lod = lod;
      protoNode.addChild(out.createNode(`p${p.id}_lod`).setMesh(lod));
      lodCount++;
    }
  }
  const groundNode = out.createNode('ground');
  outScene.addChild(groundNode);
  const cellOrigins = new Map<string, [number, number]>();
  for (const [ck, mats] of bakes) {
    const [cx, cz] = ck.split(',').map(Number);
    const ox = cx * CELL;
    const oz = cz * CELL;
    cellOrigins.set(ck, [ox, oz]);
    let mi = 0;
    for (const [mat, b] of mats) {
      // Positions relative to the cell origin (float precision); the node carries the offset.
      const pos = new Float32Array(b.pos.length);
      for (let i = 0; i < b.pos.length; i += 3) {
        pos[i] = b.pos[i] - ox;
        pos[i + 1] = b.pos[i + 1];
        pos[i + 2] = b.pos[i + 2] - oz;
      }
      const prim: Primitive = out
        .createPrimitive()
        .setMaterial(mat)
        .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buffer))
        .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(b.nor)).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(new Float32Array(b.uv)).setBuffer(buffer));
      const mesh = out.createMesh(`g${ck}_${mi}`).addPrimitive(prim);
      groundNode.addChild(out.createNode(`g${ck}_${mi}`).setMesh(mesh).setTranslation([ox, 0, oz]));
      mi++;
    }
  }

  // --- 5. Road points (spawn, Shift+R, minimap), zones ---------------------------------------------
  const roadBins = new Map<string, number[]>(); // 20 m bins of road triangle indices
  const RB = 20;
  for (let t = 0; t < roadTris.length; t += 9) {
    const xs = [roadTris[t], roadTris[t + 3], roadTris[t + 6]];
    const zs = [roadTris[t + 2], roadTris[t + 5], roadTris[t + 8]];
    for (let bx = Math.floor(Math.min(...xs) / RB); bx <= Math.floor(Math.max(...xs) / RB); bx++)
      for (let bz = Math.floor(Math.min(...zs) / RB); bz <= Math.floor(Math.max(...zs) / RB); bz++) {
        const k = `${bx},${bz}`;
        let l = roadBins.get(k);
        if (!l) roadBins.set(k, (l = []));
        l.push(t);
      }
  }
  /** Highest road surface at (x, z), or null. */
  const roadHeight = (x: number, z: number): number | null => {
    let best: number | null = null;
    for (const t of roadBins.get(`${Math.floor(x / RB)},${Math.floor(z / RB)}`) ?? []) {
      const ax = roadTris[t], ay = roadTris[t + 1], az = roadTris[t + 2];
      const bx = roadTris[t + 3], by = roadTris[t + 4], bz = roadTris[t + 5];
      const cx = roadTris[t + 6], cy = roadTris[t + 7], cz = roadTris[t + 8];
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
      const l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
      const y = l1 * ay + l2 * by + l3 * cy;
      if (best === null || y > best) best = y;
    }
    return best;
  };
  const STEP = 8;
  const pts: number[][] = [];
  for (let x = Math.ceil(bmin[0] / STEP) * STEP; x < bmax[0]; x += STEP)
    for (let z = Math.ceil(bmin[2] / STEP) * STEP; z < bmax[2]; z += STEP) {
      const y = roadHeight(x, z);
      if (y === null) continue;
      // Keep points with road all round (not on the very edge of a street / bridge).
      if ([[3, 0], [-3, 0], [0, 3], [0, -3]].some(([dx, dz]) => roadHeight(x + dx, z + dz) === null)) continue;
      pts.push([x, y, z, 0]);
    }
  // Street direction: the longer axis of the road around each point.
  const ptBins = new Map<string, number[]>();
  pts.forEach((p, i) => {
    const k = `${Math.floor(p[0] / 32)},${Math.floor(p[2] / 32)}`;
    let l = ptBins.get(k);
    if (!l) ptBins.set(k, (l = []));
    l.push(i);
  });
  for (const p of pts) {
    let cxx = 0, czz = 0, cxz = 0;
    const bx = Math.floor(p[0] / 32), bz = Math.floor(p[2] / 32);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const k of ptBins.get(`${bx + i},${bz + j}`) ?? []) {
      const q = pts[k];
      const dx = q[0] - p[0], dz = q[2] - p[2];
      if (dx * dx + dz * dz > 24 * 24 || Math.abs(q[1] - p[1]) > 3) continue;
      cxx += dx * dx;
      czz += dz * dz;
      cxz += dx * dz;
    }
    const a = 0.5 * Math.atan2(2 * cxz, cxx - czz); // axis angle from +X
    p[3] = Math.atan2(Math.cos(a), Math.sin(a)); // as a heading (forward = (sin h, cos h))
  }
  console.log(`${pts.length} road points`);
  // Spawn: near the middle of the city, where the street runs straight for a while.
  // (The streets cover only part of the terrain: centre on them, not on the whole box.)
  const mid = [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length];
  let spawn = pts[0];
  let bestScore = -Infinity;
  for (const p of pts) {
    const d = Math.hypot(p[0] - mid[0], p[2] - mid[1]);
    if (d > 900) continue;
    let run = 0;
    for (let s = 8; s <= 120; s += 8) {
      const y = roadHeight(p[0] + Math.sin(p[3]) * s, p[2] + Math.cos(p[3]) * s);
      if (y === null || Math.abs(y - p[1]) > 2.5) break;
      run = s;
    }
    const score = run - d * 0.05;
    if (score > bestScore) {
      bestScore = score;
      spawn = p;
    }
  }
  const zones: Record<string, { x: number; z: number; n: number }> = {};
  for (const i of instances) {
    if (!i.zone.startsWith('Zona_')) continue;
    const z = (zones[i.zone] ??= { x: 0, z: 0, n: 0 });
    z.x += (i.min[0] + i.max[0]) / 2;
    z.z += (i.min[2] + i.max[2]) / 2;
    z.n++;
  }
  const nearestPoint = (x: number, z: number) => pts.reduce((a, b) => (Math.hypot(b[0] - x, b[2] - z) < Math.hypot(a[0] - x, a[2] - z) ? b : a));
  const teleports = Object.entries(zones).map(([name, z]) => {
    const p = nearestPoint(z.x / z.n, z.z / z.n);
    return { id: name.toLowerCase(), label: name.replace('Zona_', '').replace(/_/g, ' '), x: p[0], y: p[1], z: p[2], yaw: p[3] };
  });

  // --- 6. Binary layout: instances per cell, colliders, road points ------------------------------------
  const cells = new Map<string, { inst: Instance[] }>();
  for (const i of instances) {
    if (i.bake) continue;
    const ck = cellKey((i.min[0] + i.max[0]) / 2, (i.min[2] + i.max[2]) / 2);
    let c = cells.get(ck);
    if (!c) cells.set(ck, (c = { inst: [] }));
    c.inst.push(i);
  }
  const allKeys = new Set([...cells.keys(), ...bakes.keys()]);
  /** Does this instance's oriented box contain a road point (at car height)? */
  const boxBlocksRoad = (i: Instance): boolean => {
    const inv = invertAffine(i.m);
    const p = i.proto;
    for (let bx = Math.floor(i.min[0] / 32); bx <= Math.floor(i.max[0] / 32); bx++)
      for (let bz = Math.floor(i.min[2] / 32); bz <= Math.floor(i.max[2] / 32); bz++)
        for (const k of ptBins.get(`${bx},${bz}`) ?? []) {
          const q = pts[k];
          const l = xf(inv, q[0], q[1] + 1, q[2]);
          if (l[0] > p.min[0] && l[0] < p.max[0] && l[1] > p.min[1] && l[1] < p.max[1] && l[2] > p.min[2] && l[2] < p.max[2]) return true;
        }
    return false;
  };
  /** World triangles of an instance (its LOD when it has one) into a triangle soup. */
  /** Collider triangles of a building: its original geometry (before the visual cleanup), simplified like the LOD. */
  const appendTriangles = (i: Instance, outTris: number[]) => {
    for (const prim of i.proto.mesh.listPrimitives()) {
      const { pos, idx } = snapshot.get(prim)!;
      let use: ArrayLike<number> = idx;
      if (i.proto.tris > 300) {
        const target = Math.max(36, Math.floor((idx.length * 0.25) / 3) * 3);
        [use] = MeshoptSimplifier.simplify(idx, pos, 3, target, 0.02, ['LockBorder']);
      }
      for (let k = 0; k < use.length; k++) {
        const v0 = use[k] * 3;
        outTris.push(...xf(i.m, pos[v0], pos[v0 + 1], pos[v0 + 2]));
      }
    }
  };
  let meshColliders = 0;
  const blockers: { c: number[]; h: number[]; q: number[] }[] = [];
  const meshBlockers: Instance[] = [];
  const f32: number[] = [];
  const u32: number[] = [];
  const cellJson: object[] = [];
  let boxCount = 0;
  let trimeshTris = 0;
  for (const ck of [...allKeys].sort()) {
    const [cx, cz] = ck.split(',').map(Number);
    const c = cells.get(ck);
    const instOff = f32.length;
    for (const i of c?.inst ?? []) {
      f32.push(i.proto.id);
      // 3×4 affine part (column-major 4×4 without the last row).
      for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10, 12, 13, 14]) f32.push((i.draw ?? i.m)[k]);
    }
    const instCount = c?.inst.length ?? 0;
    // Boxes: oriented bounding boxes of solid instances: centre, half extents, rotation (quaternion).
    const boxOff = f32.length;
    let boxes = 0;
    for (const i of c?.inst ?? []) {
      const p = i.proto;
      if (!p.collider) continue;
      const m = i.m;
      // A box that would cover a street (L-shaped buildings, whole blocks in one mesh): collide
      // with the building's own (simplified) triangles instead.
      if (p.collider === 'box' && boxBlocksRoad(i)) {
        let ct = colliderTris.get(ck);
        if (!ct) colliderTris.set(ck, (ct = []));
        appendTriangles(i, ct);
        meshBlockers.push(i);
        meshColliders++;
        continue;
      }
      const sx = Math.hypot(m[0], m[1], m[2]);
      const sy = Math.hypot(m[4], m[5], m[6]);
      const sz = Math.hypot(m[8], m[9], m[10]);
      const lc = [(p.min[0] + p.max[0]) / 2, (p.min[1] + p.max[1]) / 2, (p.min[2] + p.max[2]) / 2];
      let hx = ((p.max[0] - p.min[0]) / 2) * sx;
      let hy = ((p.max[1] - p.min[1]) / 2) * sy;
      let hz = ((p.max[2] - p.min[2]) / 2) * sz;
      let centre = xf(m, lc[0], lc[1], lc[2]);
      if (p.collider === 'trunk') {
        // A slim trunk at the tree's foot, about 3.5 m tall.
        hx = hz = 0.3;
        hy = 1.75;
        centre = [centre[0], i.min[1] + 1.75, centre[2]];
      }
      const ax = [m[0] / sx, m[1] / sx, m[2] / sx];
      const ay = [m[4] / sy, m[5] / sy, m[6] / sy];
      let az = [m[8] / sz, m[9] / sz, m[10] / sz];
      // Mirrored placements: a box doesn't care about handedness, flip one axis back.
      const det = ax[0] * (ay[1] * az[2] - ay[2] * az[1]) - ax[1] * (ay[0] * az[2] - ay[2] * az[0]) + ax[2] * (ay[0] * az[1] - ay[1] * az[0]);
      if (det < 0) az = az.map((c) => -c);
      const q = quatFromBasis(ax, ay, az);
      f32.push(centre[0], centre[1], centre[2], hx, hy, hz, q[0], q[1], q[2], q[3]);
      blockers.push({ c: centre, h: [hx, hy, hz], q });
      boxes++;
    }
    boxCount += boxes;
    // Trimesh of the baked solid surfaces (merged duplicate vertices at runtime by Rapier).
    // Welded (shared corners stored once, 1 cm grid) to keep the file small.
    const tris = colliderTris.get(ck) ?? [];
    const vOff = f32.length;
    const iOff = u32.length;
    const welded = new Map<string, number>();
    let nv = 0;
    let kept = 0;
    const ids = [0, 0, 0];
    for (let t = 0; t < tris.length; t += 9) {
      // Degenerate triangles (no area, or corners welded together) break the physics trimesh: skip them.
      const ux = tris[t + 3] - tris[t], uy = tris[t + 4] - tris[t + 1], uz = tris[t + 5] - tris[t + 2];
      const wx = tris[t + 6] - tris[t], wy = tris[t + 7] - tris[t + 1], wz = tris[t + 8] - tris[t + 2];
      if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) < 1e-4) continue;
      for (let c = 0; c < 3; c++) {
        const k = t + c * 3;
        const key = `${Math.round(tris[k] * 100)},${Math.round(tris[k + 1] * 100)},${Math.round(tris[k + 2] * 100)}`;
        let id = welded.get(key);
        if (id === undefined) {
          welded.set(key, (id = nv++));
          f32.push(tris[k], tris[k + 1], tris[k + 2]);
        }
        ids[c] = id;
      }
      if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
      u32.push(ids[0], ids[1], ids[2]);
      kept++;
    }
    trimeshTris += kept;
    const ground = [...(bakes.get(ck)?.keys() ?? [])].map((_, mi) => `g${ck}_${mi}`);
    cellJson.push({ cx, cz, inst: [instOff, instCount], boxes: [boxOff, boxes], trimesh: [vOff, nv, iOff, kept], ground });
  }
  // Road points a car can be put on: not inside / right next to a solid box or building (bus stops,
  // trees on the pavement, steps), so spawn and Shift+R never drop the car onto an obstacle.
  const clear = pts.filter((q) => {
    for (const b of blockers) {
      const dx = q[0] - b.c[0], dy = q[1] + 1 - b.c[1], dz = q[2] - b.c[2];
      if (Math.abs(dx) > b.h[0] + b.h[2] + 3 || Math.abs(dz) > b.h[0] + b.h[2] + 3) continue;
      // Into the box's frame (inverse rotation by the conjugate quaternion).
      const l = rotate([-b.q[0], -b.q[1], -b.q[2], b.q[3]], [dx, dy, dz]);
      if (Math.abs(l[0]) < b.h[0] + 2.5 && Math.abs(l[1]) < b.h[1] + 1 && Math.abs(l[2]) < b.h[2] + 2.5) return false;
    }
    for (const i of meshBlockers) {
      const inv = invertAffine(i.m);
      const l = xf(inv, q[0], q[1] + 1, q[2]);
      const p = i.proto;
      // 2.5 m in the prototype's own units (the instance matrix carries the scale).
      const pad = 2.5 / Math.hypot(i.m[0], i.m[1], i.m[2]);
      if (l[0] > p.min[0] - pad && l[0] < p.max[0] + pad && l[1] > p.min[1] && l[1] < p.max[1] && l[2] > p.min[2] - pad && l[2] < p.max[2] + pad) return false;
    }
    return true;
  });
  console.log(`${clear.length} of ${pts.length} road points clear of obstacles`);
  const snap = (x: number, z: number, y: number) => clear.reduce((a, b) => ((b[0] - x) ** 2 + (b[2] - z) ** 2 + ((b[1] - y) * 3) ** 2 < (a[0] - x) ** 2 + (a[2] - z) ** 2 + ((a[1] - y) * 3) ** 2 ? b : a));
  const s2 = snap(spawn[0], spawn[2], spawn[1]);
  const spawnOut = { x: s2[0], y: s2[1], z: s2[2], yaw: s2[3] };
  const teleportsOut = teleports.map((tp) => {
    const q = snap(tp.x, tp.z, tp.y);
    return { ...tp, x: q[0], y: q[1], z: q[2], yaw: q[3] };
  });
  const roadOff = f32.length;
  for (const p of clear) f32.push(...p);

  // --- 7. Minimap image -------------------------------------------------------------------------------
  const W = Math.ceil((bmax[0] - bmin[0]) / MAP_RES);
  const H = Math.ceil((bmax[2] - bmin[2]) / MAP_RES);
  const img = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) img.writeUInt32BE(0x14181dff, i * 4);
  const fillTri = (ax: number, az: number, bx: number, bz: number, cx: number, cz: number, col: number[]) => {
    const px = (x: number) => (x - bmin[0]) / MAP_RES;
    const pz = (z: number) => (z - bmin[2]) / MAP_RES;
    const x0 = px(ax), y0 = pz(az), x1 = px(bx), y1 = pz(bz), x2 = px(cx), y2 = pz(cz);
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-9) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const l1 = ((y1 - y2) * (x + 0.5 - x2) + (x2 - x1) * (y + 0.5 - y2)) / d;
      const l2 = ((y2 - y0) * (x + 0.5 - x2) + (x0 - x2) * (y + 0.5 - y2)) / d;
      if (l1 < 0 || l2 < 0 || l1 + l2 > 1) continue;
      const o = (y * W + x) * 4;
      img[o] = col[0];
      img[o + 1] = col[1];
      img[o + 2] = col[2];
      img[o + 3] = 255;
    }
  };
  // Ground and water first, roads on top, then building footprints.
  mapTris.sort((a, b) => (a.colour[0] === 88 ? 1 : 0) - (b.colour[0] === 88 ? 1 : 0));
  for (const { tri, colour } of mapTris) fillTri(tri[0], tri[2], tri[3], tri[5], tri[6], tri[8], colour);
  for (const i of instances) {
    if (i.bake || i.category !== 'building' || i.max[1] - i.min[1] < 3) continue;
    const p = i.proto;
    const c = [[p.min[0], p.min[2]], [p.max[0], p.min[2]], [p.max[0], p.max[2]], [p.min[0], p.max[2]]].map(([x, z]) => xf(i.m, x, (p.min[1] + p.max[1]) / 2, z));
    fillTri(c[0][0], c[0][2], c[1][0], c[1][2], c[2][0], c[2][2], [30, 33, 38]);
    fillTri(c[0][0], c[0][2], c[2][0], c[2][2], c[3][0], c[3][2], [30, 33, 38]);
  }
  mkdirSync(OUT, { recursive: true });
  await sharp(img, { raw: { width: W, height: H, channels: 4 } }).png({ compressionLevel: 9, palette: true }).toFile(join(OUT, 'city-map.png'));

  // --- 8. Write -------------------------------------------------------------------------------------------
  const protoJson = [...used].map((p) => ({ id: p.id, name: p.name, category: p.category, tris: p.tris, lod: !!p.lod, collider: p.collider }));
  const json = {
    version: 1,
    source: 'drive for speed - map, by amogusstrikesback2 (CC BY-NC 4.0)',
    cell: CELL,
    bounds: { minX: bmin[0], minY: bmin[1], minZ: bmin[2], maxX: bmax[0], maxY: bmax[1], maxZ: bmax[2] },
    protos: protoJson,
    cells: cellJson,
    roads: [roadOff, clear.length],
    spawn: spawnOut,
    teleports: teleportsOut,
    minimap: { url: '/assets/city/city-map.png', minX: bmin[0], minZ: bmin[2], maxX: bmin[0] + W * MAP_RES, maxZ: bmin[2] + H * MAP_RES },
    floats: f32.length,
    ints: u32.length,
  };
  const bin = Buffer.alloc(f32.length * 4 + u32.length * 4);
  Buffer.from(new Float32Array(f32).buffer).copy(bin, 0);
  Buffer.from(new Uint32Array(u32).buffer).copy(bin, f32.length * 4);
  writeFileSync(join(OUT, 'city-data.bin'), bin);
  writeFileSync(join(OUT, 'city-data.json'), JSON.stringify(json));
  // Small summary for the map selection card (bundled with the code): outline = convex hull of the streets.
  const hull = convexHull(pts.map((p) => [p[0], p[2]]));
  writeFileSync(
    join(ROOT, 'src/world/tracks/city-info.json'),
    `${JSON.stringify({ name: 'Şehir', width: +((bmax[0] - bmin[0]) / 1000).toFixed(2), depth: +((bmax[2] - bmin[2]) / 1000).toFixed(2), elevation: Math.round(bmax[1] - bmin[1]), zones: teleports.length, outline: hull.flat().map((v) => Math.round(v)) })}\n`,
  );

  // meshopt compression; positions stay float: quantised to the mesh's extent (14 bits ≈ 15 mm in a
  // 250 m ground cell) they would erase the few-mm layer offsets of the cleanup.
  await out.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(?!POSITION$).*/, quantizeNormal: 10, quantizeTexcoord: 12 }),
  );
  out.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(join(OUT, 'city.glb'), out);

  const size = (f: string) => (statSync(join(OUT, f)).size / 1e6).toFixed(1);
  const renderTris = instances.reduce((s, i) => s + (i.bake ? 0 : i.proto.tris), 0) + bakedTris;
  console.log(`prototypes ${used.size} (${lodCount} with LOD), cells ${allKeys.size}, boxes ${boxCount}, buildings with mesh colliders ${meshColliders}, trimesh triangles ${trimeshTris}`);
  console.log(`triangles in the city ${renderTris}, stored ${[...used].reduce((s, p) => s + p.tris, 0) + bakedTris}`);
  console.log(`source ${(statSync(SOURCE).size / 1e6).toFixed(1)} MB → city.glb ${size('city.glb')} MB + data ${size('city-data.bin')} MB + ${size('city-data.json')} MB json + map ${size('city-map.png')} MB (${W}×${H}), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

/** Rotates vector v by quaternion q [x, y, z, w]. */
function rotate(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
}

/** Inverse of an affine column-major 4×4. */
function invertAffine(m: ArrayLike<number>): Float64Array {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  const r = [(e * k - f * h) / det, (c * h - b * k) / det, (b * f - c * e) / det, (f * g - d * k) / det, (a * k - c * g) / det, (c * d - a * f) / det, (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det];
  const o = new Float64Array(16);
  // r is row-major 3×3 of the inverse.
  o[0] = r[0]; o[4] = r[1]; o[8] = r[2];
  o[1] = r[3]; o[5] = r[4]; o[9] = r[5];
  o[2] = r[6]; o[6] = r[7]; o[10] = r[8];
  o[12] = -(o[0] * m[12] + o[4] * m[13] + o[8] * m[14]);
  o[13] = -(o[1] * m[12] + o[5] * m[13] + o[9] * m[14]);
  o[14] = -(o[2] * m[12] + o[6] * m[13] + o[10] * m[14]);
  o[15] = 1;
  return o;
}

/** Convex hull (monotone chain) of 2D points, counter-clockwise. */
function convexHull(points: number[][]): number[][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: number[][] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: number[][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Quaternion [x, y, z, w] from orthonormal basis columns. */
function quatFromBasis(x: number[], y: number[], z: number[]): [number, number, number, number] {
  const m00 = x[0], m10 = x[1], m20 = x[2];
  const m01 = y[0], m11 = y[1], m21 = y[2];
  const m02 = z[0], m12 = z[1], m22 = z[2];
  const tr = m00 + m11 + m22;
  let qx: number, qy: number, qz: number, qw: number;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  const l = Math.hypot(qx, qy, qz, qw) || 1;
  return [qx / l, qy / l, qz / l, qw / l];
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void Document;
