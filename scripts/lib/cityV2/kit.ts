/**
 * The Downtown City MegaKit (Quaternius, CC0, free "Standard" version) as plain
 * geometry: every piece of the glTF export read once, node transforms baked,
 * primitives kept per kit material. Textures are not loaded here: the prepare
 * step builds its own consolidated materials and loads each texture once.
 *
 * Kit conventions (checked by `kitReport`): metres, +Y up, wall modules face
 * +Z with the facade at z = 0 and the back at z ≈ -0.2, pivot at the bottom
 * centre, 2 m (or 4 m) wide, 1 / 3 / 4 m tall. Streets: asphalt at y = -0.15,
 * sidewalk tops at y = 0.
 */
import { NodeIO, type Accessor, type JSONDocument } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';

/** Relative to the repository root (the source is not in git: see .gitignore). */
export const KIT_DIR = 'assets-src/maps/downtown-city-megakit/Exports/glTF (Godot)';

export type KitFamily = 'street' | 'sidewalk' | 'decal' | 'building' | 'prop' | 'wall' | 'cornice' | 'roof' | 'door' | 'stairs' | 'floor';

export interface KitPrim {
  /** Kit material name (MI_RedBrick, MI_Glass...). */
  material: string;
  /** Non-opaque in the kit (glass, decals). */
  blend: boolean;
  position: Float32Array;
  normal: Float32Array | null;
  uv: Float32Array | null;
  index: Uint32Array;
}

export interface KitPiece {
  name: string;
  family: KitFamily;
  prims: KitPrim[];
  min: [number, number, number];
  max: [number, number, number];
  tris: number;
}

export interface Kit {
  dir: string;
  pieces: Map<string, KitPiece>;
}

const FAMILY: [RegExp, KitFamily][] = [
  [/^Street_/, 'street'],
  [/^Sidewalk_/, 'sidewalk'],
  [/^Decal_/, 'decal'],
  [/^Building_/, 'building'],
  [/^Prop_/, 'prop'],
  [/^Cornice_/, 'cornice'],
  [/^Roof_/, 'roof'],
  [/^Door(Frame)?_/, 'door'],
  [/^(Stairs|Entrance)_/, 'stairs'],
  [/^Floor_/, 'floor'],
  [/^(Brick|Metal|Trim)_/, 'wall'],
];

export function kitFamily(name: string): KitFamily {
  for (const [re, f] of FAMILY) if (re.test(name)) return f;
  throw new Error(`Unknown kit piece family: ${name}`);
}

export function kitAvailable(root: string): boolean {
  return existsSync(join(root, KIT_DIR));
}

/** Reads every .gltf of the kit (geometry and material names only), ~1-2 s. */
export async function loadKit(root: string): Promise<Kit> {
  const dir = join(root, KIT_DIR);
  if (!existsSync(dir)) throw new Error(`Kit not found: ${dir} (upload the Downtown City MegaKit there, see README)`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const pieces = new Map<string, KitPiece>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.gltf')).sort()) {
    const name = file.replace(/\.gltf$/, '');
    pieces.set(name, await readPiece(io, dir, file, name));
  }
  return { dir, pieces };
}

async function readPiece(io: NodeIO, dir: string, file: string, name: string): Promise<KitPiece> {
  const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  // Geometry only: drop the texture references (the PNGs are loaded once by the material builder).
  delete json.images;
  delete json.textures;
  delete json.samplers;
  for (const m of json.materials ?? []) {
    delete m.normalTexture;
    delete m.occlusionTexture;
    delete m.emissiveTexture;
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture;
      delete m.pbrMetallicRoughness.metallicRoughnessTexture;
    }
  }
  const resources: Record<string, Uint8Array> = {};
  for (const b of json.buffers ?? []) if (b.uri) resources[b.uri] = new Uint8Array(readFileSync(join(dir, decodeURIComponent(b.uri))));
  const doc = await io.readJSON({ json, resources } as JSONDocument);
  const prims: KitPrim[] = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    m.fromArray(node.getWorldMatrix());
    nm.getNormalMatrix(m);
    for (const p of mesh.listPrimitives()) {
      if (p.getMode() !== 4) throw new Error(`${name}: primitive mode ${p.getMode()} (triangles expected)`);
      const posA = p.getAttribute('POSITION');
      if (!posA) continue;
      const position = floats(posA);
      for (let i = 0; i < position.length; i += 3) {
        v.fromArray(position, i).applyMatrix4(m).toArray(position, i);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], position[i + k]);
          max[k] = Math.max(max[k], position[i + k]);
        }
      }
      const norA = p.getAttribute('NORMAL');
      const normal = norA ? floats(norA) : null;
      if (normal) for (let i = 0; i < normal.length; i += 3) v.fromArray(normal, i).applyMatrix3(nm).normalize().toArray(normal, i);
      const uvA = p.getAttribute('TEXCOORD_0');
      const idxA = p.getIndices();
      const index = idxA ? Uint32Array.from(idxA.getArray() as ArrayLike<number>) : Uint32Array.from({ length: posA.getCount() }, (_, i) => i);
      const mat = p.getMaterial();
      prims.push({ material: mat?.getName() ?? 'none', blend: mat?.getAlphaMode() === 'BLEND', position, normal, uv: uvA ? floats(uvA) : null, index });
      tris += index.length / 3;
    }
  }
  return { name, family: kitFamily(name), prims, min, max, tris };
}

/** Plain float copy (also turns normalised integer attributes into floats). */
function floats(a: Accessor): Float32Array {
  const arr = a.getArray();
  if (arr instanceof Float32Array && !a.getNormalized()) return arr.slice();
  const n = a.getElementSize();
  const out = new Float32Array(a.getCount() * n);
  const el: number[] = [];
  for (let i = 0; i < a.getCount(); i++) {
    a.getElement(i, el);
    for (let k = 0; k < n; k++) out[i * n + k] = el[k];
  }
  return out;
}

const round = (x: number) => (Math.abs(x) < 0.005 ? 0 : x).toFixed(2);

/** Human-readable catalogue and convention checks (`npm run prepare:city-v2 -- --catalog`). */
export function kitReport(kit: Kit): string {
  const out: string[] = [];
  const pieces = [...kit.pieces.values()];
  const byFamily = new Map<KitFamily, KitPiece[]>();
  for (const p of pieces) byFamily.set(p.family, [...(byFamily.get(p.family) ?? []), p]);
  out.push(`Kit: ${pieces.length} pieces, ${pieces.reduce((s, p) => s + p.tris, 0)} triangles (${kit.dir})`);
  for (const [f, list] of byFamily) out.push(`  ${f.padEnd(9)} ${String(list.length).padStart(3)}  ${list.map((p) => p.name).join(' ')}`);

  // Materials: how often, blended or not.
  const mats = new Map<string, { prims: number; pieces: Set<string>; blend: boolean }>();
  for (const p of pieces) for (const pr of p.prims) {
    const e = mats.get(pr.material) ?? { prims: 0, pieces: new Set<string>(), blend: pr.blend };
    e.prims++;
    e.pieces.add(p.name);
    mats.set(pr.material, e);
  }
  out.push('', `Materials (${mats.size}):`);
  for (const [n, e] of [...mats].sort((a, b) => b[1].prims - a[1].prims)) out.push(`  ${n.padEnd(24)} ${String(e.pieces.size).padStart(3)} pieces${e.blend ? '  BLEND' : ''}`);

  // Wall-module convention: centred in x, standing on y = 0, facade at z ≈ 0 facing +Z, back at z ≈ -0.2.
  out.push('', 'Wall modules (facade at z = 0 facing +Z, pivot bottom centre, 2 / 4 m wide):');
  const panels = pieces.filter((p) => p.family === 'wall' && !/Column|Angle|Corner|Ornament|Interior|Guard|TopCover/.test(p.name));
  const bad: string[] = [];
  for (const p of panels) {
    const w = p.max[0] - p.min[0];
    const issues: string[] = [];
    if (Math.abs(p.min[0] + p.max[0]) > 0.02) issues.push(`x not centred [${round(p.min[0])}, ${round(p.max[0])}]`);
    if (Math.abs(w - 2) > 0.05 && Math.abs(w - 4) > 0.05) issues.push(`width ${round(w)}`);
    if (Math.abs(p.min[1]) > 0.02) issues.push(`base y ${round(p.min[1])}`);
    if (p.max[2] < -0.01 || p.max[2] > 0.15) issues.push(`front z ${round(p.max[2])}`);
    if (p.min[2] > -0.15 || p.min[2] < -0.3) issues.push(`back z ${round(p.min[2])}`);
    if (issues.length) bad.push(`  ${p.name}: ${issues.join(', ')}`);
  }
  out.push(`  ${panels.length - bad.length} / ${panels.length} follow it`, ...bad);
  out.push('', 'Odd-shaped wall pieces (corners, columns: placed by their own rule):');
  for (const p of pieces.filter((p) => p.family === 'wall' && !panels.includes(p)))
    out.push(`  ${p.name.padEnd(32)} [${p.min.map(round)}] .. [${p.max.map(round)}]`);

  // What the prepare step removes or replaces.
  const uses = (re: RegExp) => pieces.filter((p) => p.prims.some((pr) => re.test(pr.material))).map((p) => p.name);
  out.push('', `Interior-only materials (dropped): ${uses(/^MI_Interior/).length} pieces`);
  out.push(`Glass (dropped, windows become opaque): ${uses(/^MI_Glass/).length} pieces`);
  out.push(`Fake interior (one opaque window material): ${uses(/^MI_FakeInterior/).length} pieces`);

  // Street levels and decal texture rectangles (the decal atlas is reused by the road builder).
  out.push('', 'Streets (asphalt y / top y):');
  for (const p of byFamily.get('street') ?? []) {
    const asphalt = p.prims.filter((pr) => pr.material === 'MI_Asphalt').flatMap((pr) => [...pr.position.filter((_, i) => i % 3 === 1)]);
    out.push(`  ${p.name.padEnd(34)} size ${round(p.max[0] - p.min[0])} × ${round(p.max[2] - p.min[2])}  asphalt y ${asphalt.length ? round(Math.min(...asphalt)) : '-'}  top ${round(p.max[1])}`);
  }
  out.push('', 'Decal atlas rectangles (T_Street_Decals uv):');
  for (const p of byFamily.get('decal') ?? []) {
    const uv = p.prims.flatMap((pr) => (pr.uv ? [...pr.uv] : []));
    const us = uv.filter((_, i) => i % 2 === 0);
    const vs = uv.filter((_, i) => i % 2 === 1);
    out.push(`  ${p.name.padEnd(36)} u ${round(Math.min(...us))}..${round(Math.max(...us))}  v ${round(Math.min(...vs))}..${round(Math.max(...vs))}  y ${round(p.min[1])}`);
  }
  out.push('', 'Prefab buildings:');
  for (const p of byFamily.get('building') ?? []) out.push(`  ${p.name.padEnd(24)} ${round(p.max[0] - p.min[0])} × ${round(p.max[2] - p.min[2])} m, ${round(p.max[1])} m tall, ${p.tris} tris, ${new Set(p.prims.map((pr) => pr.material)).size} materials`);
  return out.join('\n');
}
