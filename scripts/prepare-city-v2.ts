/**
 * City V2: a seeded, procedural town built from the Downtown City MegaKit
 * (Quaternius, CC0; assets-src/maps/downtown-city-megakit, not in git).
 *
 *  public/assets/city_v2/city.glb              ground per 250 m cell and material (meshopt, WebP kit textures)
 *  public/assets/city_v2/city-data.json / .bin cells, colliders, road points, spawn, teleports (CityV2Data.ts)
 *  public/assets/city_v2/city-map.png          minimap, drawn from the layout and the building footprints
 *  public/assets/city_v2/buildings-*.webp      building texture arrays (base colour with occlusion, normals), layers stacked
 *  src/world/tracks/city-v2-info.json          map selection card summary
 *
 * Stages (scripts/lib/cityV2/):
 *   kit.ts        the kit's glTF pieces, catalogue and convention checks
 *   layout.ts     street network, districts (districts.ts), blocks, large parcels, alleys
 *   ground.ts     asphalt / sidewalks / kerbs / lots / land from a 0.5 m raster, lane markings, colliders
 *   buildings.ts  building prototypes from the kit's facade modules, placed on every ordinary block
 *   props.ts      street props (A4): lamps, trees, signals, signs, furniture, parking, park, yards
 *   minimap.ts    top-down map image
 *
 *   npm run prepare:city [-- --seed n --size m --out dir]   the game files (2 × 2 km by default)
 *       --no-info: do not touch src/world/tracks/city-v2-info.json (test fixtures)
 *       --no-buildings: no buildings (the same city otherwise: a baseline for measurements)
 *       --sample-areas: buildings on the four A3 sample areas only (the checkpoint)
 *       --no-props: no street props (the A3 city: a baseline for measurements)
 *   npm run prepare:city -- --catalog                        kit report
 *   npm run prepare:city -- --layout-only [...]              layout review picture + summary only
 */
import { Document, NodeIO, TextureInfo, type Material, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, reorder, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { CityV2Cell, CityV2Json } from '../src/world/cityv2/CityV2Data';
import { BUILDING_LAYERS } from '../src/world/cityv2/buildingKit';
import { MODULE_PIECES, buildModules, generateBuildings, packBuildings, type Buildings } from './lib/cityV2/buildings';
import { CELL, LEVEL, MARGIN, buildGround, buildMarkings, type ColliderBuf, type GroundMat } from './lib/cityV2/ground';
import { KIT_DIR, kitReport, loadKit } from './lib/cityV2/kit';
import { generateLayout, layoutStats, type CityLayout, type LayoutEdge } from './lib/cityV2/layout';
import { kerbOffset, laneOffsets } from '../src/world/cityv2/roadProfiles';
import { renderLayout } from './lib/cityV2/minimap';
import { packKitProps, packProps, placeProps } from './lib/cityV2/props';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const SEED = Number(arg('seed') ?? 2026);
const SIZE = Number(arg('size') ?? 2000);
const OUT = resolve(arg('out') ?? join(ROOT, 'public/assets/city_v2'));
const URL_BASE = '/assets/city_v2';
/** Minimap resolution, m per pixel. */
const MAP_RES = 2;

/**
 * Ground materials from the kit's textures. The kit's ORM maps follow glTF (R occlusion, G roughness,
 * B metal; measured: Concrete G ≈ 0.88, MetalConcrete B up to 1 on its metal trims), except Dirt, whose
 * R channel is 0 (not an occlusion map: used as one it removes all ambient light).
 *  - `orm`: occlusion + roughness from the ORM map. `ao`: occlusion only, with a fixed `roughness`
 *    (matte concrete: the map's 0.8-0.9 still left a sky sheen at grazing angles).
 *  - Metal is always 0: none of these surfaces is metal (the MetalConcrete trims would mirror the sky).
 *  - `cropV`: T_MetalConcrete is a trim sheet: rusty metal in its top 40 %, a seam, then concrete. The
 *    kit's sidewalk tops use v 0.564-0.999 only (kitReport / Sidewalk_Straight_3m); tiling the whole sheet
 *    put a dark rust band on the sidewalks every 3 m (the "moiré" seen down long streets). Those rows are
 *    cut out into their own textures, repeated across in u and mirrored in v (the cut does not tile in v).
 *  - Markings: plain colour from the vertices (see ground.ts PAINT), no texture.
 */
const MATERIALS: Record<GroundMat, { base?: string; normal?: string; orm?: string; ao?: string; roughness?: number; tint?: [number, number, number]; cropV?: [number, number] }> = {
  asphalt: { base: 'T_Concrete_Asphalt_BaseColor', normal: 'T_Concrete_Normal', orm: 'T_Concrete_ORM' },
  parking: { base: 'T_Concrete_Asphalt_BaseColor', normal: 'T_Concrete_Normal', orm: 'T_Concrete_ORM', tint: [0.92, 0.92, 0.95] },
  sidewalk: { base: 'T_MetalConcrete_BaseColor', normal: 'T_MetalConcrete_Normal', ao: 'T_MetalConcrete_ORM', roughness: 0.95, cropV: [0.565, 0.999] },
  lot: { base: 'T_Concrete_BaseColor', normal: 'T_Concrete_Normal', ao: 'T_Concrete_ORM', roughness: 0.95, tint: [0.85, 0.85, 0.85] },
  plaza: { base: 'T_MarbleFloor_BaseColor', normal: 'T_MarbleFloor_Normal', orm: 'T_MarbleFloor_ORM' },
  park: { base: 'T_Dirt_BaseColor', normal: 'T_Dirt_Normal', roughness: 1, tint: [0.42, 0.62, 0.3] },
  land: { base: 'T_Dirt_BaseColor', normal: 'T_Dirt_Normal', roughness: 1, tint: [0.55, 0.6, 0.42] },
  median: { base: 'T_Dirt_BaseColor', normal: 'T_Dirt_Normal', roughness: 1, tint: [0.4, 0.58, 0.28] },
  marking: { roughness: 0.6 },
};

async function main(): Promise<void> {
  if (flag('catalog')) {
    console.log(kitReport(await loadKit(ROOT)));
    return;
  }
  const t0 = performance.now();
  const layout = generateLayout({ seed: SEED, size: SIZE });
  const stats = layoutStats(layout);
  const layoutMs = performance.now() - t0;
  if (flag('layout-only')) {
    mkdirSync(OUT, { recursive: true });
    const img = await renderLayout(layout, { metresPerPixel: 1, margin: 40, debug: true });
    writeFileSync(join(OUT, `city-v2-layout-${SEED}.png`), img.png);
    writeFileSync(join(OUT, `city-v2-layout-${SEED}.json`), JSON.stringify({ seed: SEED, size: SIZE, ms: Math.round(layoutMs), stats }, null, 1));
    console.log(`seed ${SEED}, ${SIZE} m: ${layout.nodes.length} nodes, ${layout.edges.length} edges, ${layout.blocks.length} blocks in ${layoutMs.toFixed(0)} ms`);
    console.log(JSON.stringify(stats));
    console.log(`→ ${join(OUT, `city-v2-layout-${SEED}.png`)}`);
    return;
  }

  // --- ground, markings ------------------------------------------------------------------------------
  const ground = buildGround(layout);
  const marks = buildMarkings(layout, ground.cells);
  console.log(`layout ${layoutMs.toFixed(0)} ms: ${layout.blocks.length} blocks, ${layout.edges.length} roads; ground ${ground.cells.size} cells, ${marks.quads} marking quads`);

  // --- road points, spawn, teleports -------------------------------------------------------------------
  const roads = roadPoints(layout);
  const spawn = spawnPoint(layout);
  const teleports = junctionTeleports(layout);
  console.log(`${roads.length / 5} road points, ${teleports.length} teleports, spawn (${spawn.x.toFixed(0)}, ${spawn.z.toFixed(0)})`);

  // --- buildings (every ordinary block; `--sample-areas`: the A3 sample areas only) ---------------------
  const tb = performance.now();
  const kit = await loadKit(ROOT);
  const modules = await buildModules(kit, MODULE_PIECES);
  const generated = generateBuildings(layout, modules, SEED, flag('sample-areas'));
  // `--no-buildings`: the same city and sample areas without buildings (the A3 baseline).
  const buildings: Buildings = flag('no-buildings') ? { ...generated, protos: [], placements: [], instances: [], areas: generated.areas.map((a) => ({ ...a, buildings: 0 })) } : generated;
  teleports.push(...areaTeleports(layout, buildings));
  const nearTris = buildings.instances.reduce((s, i) => s + buildings.protos[i.proto].tris[0], 0);
  console.log(
    `buildings ${(performance.now() - tb).toFixed(0)} ms: ${modules.length} modules, ${buildings.protos.length} prototypes, ${buildings.instances.length} instances ` +
      `(${buildings.areas.map((a) => `${a.id} ${a.buildings}`).join(', ')}), ${nearTris} triangles if all were near`,
  );

  // --- street props (A4): placement on the ground raster around the buildings; `--no-props`: none ----------------
  const tpr = performance.now();
  const placed = flag('no-props') ? { instances: [], spots: [], lots: [], junctions: [], signals: [], reserved: [], skipped: [] } : placeProps(layout, ground.raster, buildings.instances, SEED);
  console.log(`props ${(performance.now() - tpr).toFixed(0)} ms: ${placed.instances.length} instances, ${placed.signals.length} signals, ${placed.spots.length / 4} parking spots, ${placed.lots.length} lots`);
  if (placed.skipped.length) {
    const why = new Map<string, number>();
    for (const k of placed.skipped) why.set(`${k.id} (${k.why})`, (why.get(`${k.id} (${k.why})`) ?? 0) + 1);
    console.log(`junction signals / signs left out: ${[...why].map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  const byCell = new Map<string, Buildings['instances']>();
  for (const b of buildings.instances) {
    const key = `${Math.floor((b.rect[0] + b.rect[2]) / 2 / CELL)},${Math.floor((b.rect[1] + b.rect[3]) / 2 / CELL)}`;
    byCell.set(key, [...(byCell.get(key) ?? []), b]);
  }

  // --- binary data ----------------------------------------------------------------------------------------
  const f32: number[] = [];
  const u32: number[] = [];
  /** Welds identical vertices (exact) and appends a trimesh; returns its [vo, vc, io, tc]. */
  const pushTrimesh = (c: ColliderBuf): [number, number, number, number] => {
    const map = new Map<string, number>();
    const verts: number[] = [];
    const remap: number[] = [];
    for (let i = 0; i < c.pos.length / 3; i++) {
      const k = `${c.pos[i * 3].toFixed(4)},${c.pos[i * 3 + 1].toFixed(4)},${c.pos[i * 3 + 2].toFixed(4)}`;
      let id = map.get(k);
      if (id === undefined) {
        id = verts.length / 3;
        map.set(k, id);
        verts.push(c.pos[i * 3], c.pos[i * 3 + 1], c.pos[i * 3 + 2]);
      }
      remap.push(id);
    }
    const idx: number[] = [];
    for (let t = 0; t < c.idx.length; t += 3) {
      const a = remap[c.idx[t]];
      const b = remap[c.idx[t + 1]];
      const d = remap[c.idx[t + 2]];
      if (a !== b && b !== d && a !== d) idx.push(a, b, d);
    }
    const vo = f32.length;
    for (const v of verts) f32.push(v);
    const io = u32.length;
    for (const i of idx) u32.push(i);
    return [vo, verts.length / 3, io, idx.length / 3];
  };

  const propsPacked = packProps(placed, f32, packKitProps(kit, f32, u32), new Set(ground.cells.keys()));
  const cellsJson: CityV2Cell[] = [];
  let colliderTris = 0;
  let groundTris = 0;
  for (const c of [...ground.cells.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx)) {
    const trimesh = pushTrimesh(c.collider);
    colliderTris += trimesh[3];
    const names = [...c.meshes.keys()].map((m) => `g_${c.cx}_${c.cz}_${m}`);
    const tris = [...c.meshes.values()].reduce((s, b) => s + b.tris, 0);
    groundTris += tris;
    // Buildings: instances (prototype, front centre, yaw, stretch, colour variant) and one box collider each, on the lot (0.15 m up).
    const list = byCell.get(c.key) ?? [];
    const instOff = f32.length;
    for (const b of list) f32.push(b.proto, b.x, b.z, b.yaw, b.sx, b.sz, b.variant);
    const boxOff = f32.length;
    const bounds: [number, number, number, number] = [...c.bounds];
    for (const b of list) {
      const [x0, z0, x1, z1] = b.rect;
      f32.push((x0 + x1) / 2, LEVEL.raised + b.h / 2, (z0 + z1) / 2, (x1 - x0) / 2, b.h / 2, (z1 - z0) / 2, 0, 0, 0, 1);
      bounds[0] = Math.min(bounds[0], x0 - 1);
      bounds[1] = Math.min(bounds[1], z0 - 1);
      bounds[2] = Math.max(bounds[2], x1 + 1);
      bounds[3] = Math.max(bounds[3], z1 + 1);
    }
    // Prop colliders (lamp and signal poles, barriers, planters, containers...): streamed with the cell's.
    const propBoxes = propsPacked.boxesByCell.get(c.key) ?? [];
    const propOff = f32.length;
    for (const v of propBoxes) f32.push(v);
    cellsJson.push({ cx: c.cx, cz: c.cz, inst: [instOff, list.length], boxes: [boxOff, list.length], propBoxes: [propOff, propBoxes.length / 10], trimesh, ground: names, bounds, tris });
  }
  const unplaced = [...byCell.keys()].filter((k) => !ground.cells.has(k));
  if (unplaced.length) throw new Error(`Buildings outside the ground cells: ${unplaced.join(' ')}`);
  const packed = packBuildings(buildings, f32, u32);
  const outerMesh = pushTrimesh(ground.outer);
  const boxOff = f32.length;
  for (const w of ground.walls) f32.push(w.x, 1.5, w.z, w.hx, 3, w.hz, 0, 0, 0, 1);
  const roadOff = f32.length;
  for (const v of roads) f32.push(v);

  // --- minimap --------------------------------------------------------------------------------------------
  mkdirSync(OUT, { recursive: true });
  const footprints = buildings.instances.map((b) => ({ rect: b.rect, district: buildings.protos[b.proto].district }));
  const map = await renderLayout(layout, { metresPerPixel: MAP_RES, margin: MARGIN, debug: false, footprints });
  writeFileSync(join(OUT, 'city-map.png'), map.png);

  const json: CityV2Json = {
    version: 2,
    source: `City V2 seed ${SEED}, ${SIZE} m; Downtown City MegaKit by Quaternius (CC0)`,
    cell: CELL,
    bounds: { minX: ground.bounds.minX, minY: -1, minZ: ground.bounds.minZ, maxX: ground.bounds.maxX, maxY: 1, maxZ: ground.bounds.maxZ },
    protos: [],
    cells: cellsJson,
    roads: [roadOff, roads.length / 5],
    roadStride: 5,
    spawn,
    teleports,
    minimap: { url: `${URL_BASE}/city-map.png`, minX: map.minX, minZ: map.minZ, maxX: map.maxX, maxZ: map.maxZ },
    floats: f32.length,
    ints: u32.length,
    outer: { trimesh: outerMesh, boxes: [boxOff, ground.walls.length] },
    buildings: {
      albedo: { url: `${URL_BASE}/buildings-albedo.webp`, size: BUILDING_TEX },
      normal: { url: `${URL_BASE}/buildings-normal.webp`, size: BUILDING_NORMAL_TEX },
      modules: packed.modules,
      protos: packed.protos,
      areas: buildings.areas,
    },
    props: propsPacked.json,
    roadGraph: layout.edges.map((e) => ({ a: [layout.nodes[e.a].x, layout.nodes[e.a].z], b: [layout.nodes[e.b].x, layout.nodes[e.b].z], cls: e.cls, rank: e.rank })),
    layout: { seed: SEED, size: SIZE, blocks: layout.blocks.length, districts: Object.fromEntries(Object.entries(stats.districts).map(([d, v]) => [d, v.blocks])) },
  };
  const bin = Buffer.alloc(f32.length * 4 + u32.length * 4);
  Buffer.from(new Float32Array(f32).buffer).copy(bin, 0);
  Buffer.from(new Uint32Array(u32).buffer).copy(bin, f32.length * 4);
  writeFileSync(join(OUT, 'city-data.bin'), bin);
  writeFileSync(join(OUT, 'city-data.json'), JSON.stringify(json));
  // `--no-info`: test fixtures (another size / seed) leave the map card of the game's city alone.
  if (!flag('no-info')) writeFileSync(
    join(ROOT, 'src/world/tracks/city-v2-info.json'),
    `${JSON.stringify({
      seed: SEED,
      size: SIZE,
      blocks: layout.blocks.length,
      junctions: stats.nodes.cross + stats.nodes.tee,
      roadKm: +((stats.length.boulevard + stats.length.street + stats.length.alley) / 1000).toFixed(1),
      outline: layout.outline.centre.flat().map((v) => Math.round(v)),
    })}\n`,
  );

  // --- glb ---------------------------------------------------------------------------------------------------
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('city_v2');
  const kitDir = join(ROOT, KIT_DIR);
  const textures = new Map<string, Texture>();
  /** A kit texture, whole or (cropV) only the rows between v0 and v1 (glTF v: 0 = top of the image). */
  const tex = async (name: string, cropV?: [number, number]) => {
    const key = cropV ? `${name}@${cropV.join('-')}` : name;
    let t = textures.get(key);
    if (!t) {
      let png = readFileSync(join(kitDir, `${name}.png`));
      if (cropV) {
        const img = sharp(png);
        const { width = 0, height = 0 } = await img.metadata();
        const top = Math.round(cropV[0] * height);
        png = await img.extract({ left: 0, top, width, height: Math.round(cropV[1] * height) - top }).png().toBuffer();
      }
      t = doc.createTexture(key).setImage(new Uint8Array(png)).setMimeType('image/png');
      textures.set(key, t);
    }
    return t;
  };
  const materials = new Map<GroundMat, Material>();
  for (const [m, def] of Object.entries(MATERIALS) as [GroundMat, (typeof MATERIALS)[GroundMat]][]) {
    const mat = doc.createMaterial(`cv2_${m}`).setMetallicFactor(0).setRoughnessFactor(def.roughness ?? 1);
    if (def.base) mat.setBaseColorTexture(await tex(def.base, def.cropV));
    if (def.tint) mat.setBaseColorFactor([...def.tint, 1]);
    if (def.normal) mat.setNormalTexture(await tex(def.normal, def.cropV));
    if (def.orm) mat.setMetallicRoughnessTexture(await tex(def.orm, def.cropV)).setOcclusionTexture(await tex(def.orm, def.cropV));
    if (def.ao) mat.setOcclusionTexture(await tex(def.ao, def.cropV));
    if (def.cropV) {
      for (const info of [mat.getBaseColorTextureInfo(), mat.getNormalTextureInfo(), mat.getOcclusionTextureInfo(), mat.getMetallicRoughnessTextureInfo()]) {
        info?.setWrapS(TextureInfo.WrapMode.REPEAT).setWrapT(TextureInfo.WrapMode.MIRRORED_REPEAT);
      }
    }
    materials.set(m, mat);
  }
  const root = doc.createNode('ground');
  scene.addChild(root);
  for (const c of ground.cells.values()) {
    for (const [m, b] of c.meshes) {
      if (b.tris === 0) continue;
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.pos)).setBuffer(buffer))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.nor)).setBuffer(buffer))
        .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(b.uv)).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType('SCALAR').setArray(b.pos.length / 3 > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx)).setBuffer(buffer))
        .setMaterial(materials.get(m)!);
      if (b.col) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(b.col)).setBuffer(buffer));
      const name = `g_${c.cx}_${c.cz}_${m}`;
      root.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
    }
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  await MeshoptEncoder.ready;
  // Positions stay float: the 12 mm marking lift must survive (quantised to a 250 m cell they would not).
  await doc.transform(
    prune(),
    dedup(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024] }),
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    quantize({ pattern: /^(?!POSITION$).*/, quantizeNormal: 10, quantizeTexcoord: 14 }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  await io.write(join(OUT, 'city.glb'), doc);

  await buildingTextures(kitDir);
  const size = (f: string) => statSync(join(OUT, f)).size / 1e6;
  const total = size('city.glb') + size('city-data.bin') + size('city-data.json') + size('city-map.png') + size('buildings-albedo.webp') + size('buildings-normal.webp');
  console.log(`building textures ${size('buildings-albedo.webp').toFixed(2)} + ${size('buildings-normal.webp').toFixed(2)} MB`);
  console.log(`ground triangles ${groundTris}, collider triangles ${colliderTris} + outer ${outerMesh[3]}`);
  console.log(`city.glb ${size('city.glb').toFixed(2)} MB + data ${size('city-data.bin').toFixed(2)} MB + json ${size('city-data.json').toFixed(2)} MB + map ${size('city-map.png').toFixed(2)} MB = ${total.toFixed(2)} MB, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

// --- building textures --------------------------------------------------------------------------------

/** Texture array layer sizes, px. */
const BUILDING_TEX = 1024;
const BUILDING_NORMAL_TEX = 512;

/**
 * The building texture arrays as two images, layers stacked top to bottom: base
 * colour with the kit's occlusion multiplied in (half strength: the game has no
 * other ambient occlusion on facades) and normal maps. Interior cards have no
 * normal map: flat.
 */
async function buildingTextures(kitDir: string): Promise<void> {
  const S = BUILDING_TEX;
  const N = BUILDING_NORMAL_TEX;
  const albedo = Buffer.alloc(S * S * 3 * BUILDING_LAYERS.length);
  const normal = Buffer.alloc(N * N * 3 * BUILDING_LAYERS.length);
  const file = (n: string) => join(kitDir, `${n}.png`);
  for (const [i, name] of BUILDING_LAYERS.entries()) {
    const interior = !existsSync(file(`${name}_BaseColor`));
    const base = await sharp(file(interior ? name : `${name}_BaseColor`)).removeAlpha().resize(S, S).raw().toBuffer();
    // The asphalt roof uses the concrete's normal and occlusion maps (as the kit's MI_Asphalt does).
    const maps = name === 'T_Concrete_Asphalt' ? 'T_Concrete' : name;
    if (!interior) {
      const orm = await sharp(file(`${maps}_ORM`)).removeAlpha().resize(S, S).raw().toBuffer();
      for (let p = 0; p < S * S; p++) {
        const ao = 0.5 + 0.5 * (orm[p * 3] / 255);
        for (let k = 0; k < 3; k++) base[p * 3 + k] = Math.round(base[p * 3 + k] * ao);
      }
      (await sharp(file(`${maps}_Normal`)).removeAlpha().resize(N, N).raw().toBuffer()).copy(normal, i * N * N * 3);
    } else {
      for (let p = 0; p < N * N; p++) normal.set([128, 128, 255], (i * N * N + p) * 3);
    }
    base.copy(albedo, i * S * S * 3);
  }
  await sharp(albedo, { raw: { width: S, height: S * BUILDING_LAYERS.length, channels: 3 } }).webp({ quality: 88 }).toFile(join(OUT, 'buildings-albedo.webp'));
  await sharp(normal, { raw: { width: N, height: N * BUILDING_LAYERS.length, channels: 3 } }).webp({ quality: 92 }).toFile(join(OUT, 'buildings-normal.webp'));
}

// --- road points, spawn, teleports ----------------------------------------------------------------------

const heading = (dx: number, dz: number) => Math.atan2(dx, dz);

/** Half the asphalt of the widest other road at a node: where this road's own lanes end. */
function junctionBox(l: CityLayout, n: number, e: LayoutEdge): number {
  let w = 0;
  for (const o of l.nodes[n].out) if (o >= 0 && o !== e.id) w = Math.max(w, kerbOffset(l.edges[o].cls));
  return w;
}

/** Points every 8 m along every lane of every road (both directions), clear of the junction boxes. */
function roadPoints(l: CityLayout): number[] {
  const out: number[] = [];
  for (const e of l.edges) {
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const len = Math.hypot(B.x - A.x, B.z - A.z);
    const dx = (B.x - A.x) / len;
    const dz = (B.z - A.z) / len;
    const s0 = junctionBox(l, e.a, e) + 2;
    const s1 = len - junctionBox(l, e.b, e) - 2;
    const half = kerbOffset(e.cls);
    for (let s = s0; s <= s1; s += 8) {
      for (const o of laneOffsets(e.cls)) {
        // A → B on its right: −left = (−dz, dx); B → A on the other side.
        out.push(A.x + dx * s - dz * o, 0, A.z + dz * s + dx * o, heading(dx, dz), half);
        out.push(A.x + dx * s + dz * o, 0, A.z + dz * s - dx * o, heading(-dx, -dz), half);
      }
    }
  }
  return out;
}

/**
 * On the longest arterial road between two junctions, a third of the way along
 * (clear of both junctions), in the inner right lane, facing the longer stretch.
 */
function spawnPoint(l: CityLayout): { x: number; y: number; z: number; yaw: number } {
  const e = l.edges.filter((q) => q.rank === 'arterial').sort((a, b) => b.length - a.length)[0];
  const A = l.nodes[e.a];
  const B = l.nodes[e.b];
  const dx = (B.x - A.x) / e.length;
  const dz = (B.z - A.z) / e.length;
  // A lane point: road points start junctionBox + 2 m from A and repeat every 8 m.
  const s0 = junctionBox(l, e.a, e) + 2;
  const s = s0 + Math.round((e.length / 3 - s0) / 8) * 8;
  const o = laneOffsets(e.cls)[0];
  return { x: A.x + dx * s - dz * o, y: 0, z: A.z + dz * s + dx * o, yaw: heading(dx, dz) };
}

/**
 * Admin teleports: 40 m before one junction of each kind (boulevard × boulevard,
 * street × street, T's, bends, an alley mouth, the landmark T), in the right
 * lane and facing it, so every junction type can be driven through.
 */
function junctionTeleports(l: CityLayout): { id: string; label: string; x: number; y: number; z: number; yaw: number }[] {
  const out: { id: string; label: string; x: number; y: number; z: number; yaw: number }[] = [];
  const edgesAt = (n: number) => l.nodes[n].out.filter((e) => e >= 0).map((e) => l.edges[e]);
  // Divided main roads: the 3+3 axes and the 2+2 boulevards (with a median).
  const divided = (e: LayoutEdge) => e.cls === 'arterial3' || e.cls === 'boulevard';
  const kinds: { id: string; label: string; test: (n: number) => boolean }[] = [
    { id: 'cross-bb', label: 'Kavşak: bulvar × bulvar', test: (n) => l.nodes[n].kind === 'cross' && edgesAt(n).every((e) => divided(e)) },
    { id: 'cross-bs', label: 'Kavşak: bulvar × cadde', test: (n) => l.nodes[n].kind === 'cross' && edgesAt(n).some((e) => divided(e)) && edgesAt(n).some((e) => e.cls === 'street') },
    { id: 'cross-aa', label: 'Kavşak: ana cadde (2+2)', test: (n) => l.nodes[n].kind === 'cross' && edgesAt(n).some((e) => e.cls === 'avenue') },
    { id: 'cross-ss', label: 'Kavşak: cadde × cadde', test: (n) => l.nodes[n].kind === 'cross' && edgesAt(n).every((e) => e.cls === 'street') },
    { id: 'tee-bs', label: 'T: bulvara cadde', test: (n) => l.nodes[n].kind === 'tee' && edgesAt(n).filter((e) => divided(e)).length === 2 && edgesAt(n).some((e) => e.cls === 'street') },
    { id: 'tee-ss', label: 'T: cadde × cadde', test: (n) => l.nodes[n].kind === 'tee' && edgesAt(n).every((e) => e.cls === 'street') },
    { id: 'tee-alley', label: 'T: ara sokak ağzı', test: (n) => l.nodes[n].kind === 'tee' && edgesAt(n).some((e) => e.cls === 'alley') && edgesAt(n).some((e) => e.cls === 'street') },
    { id: 'bend-b', label: '90°: bulvar kırılması', test: (n) => l.nodes[n].kind === 'bend' && edgesAt(n).every((e) => e.rank === 'arterial') },
    { id: 'bend-ring', label: '90°: çevre yolu köşesi', test: (n) => l.nodes[n].kind === 'bend' && edgesAt(n).every((e) => e.rank === 'ring') },
    { id: 'bend-s', label: '90°: cadde dönüşü (L)', test: (n) => l.nodes[n].kind === 'bend' && edgesAt(n).every((e) => e.cls === 'street') },
    { id: 'vista', label: 'Landmark T (bulvar sonu)', test: (n) => l.vistas.includes(n) },
  ];
  for (const k of kinds) {
    // The candidate nearest the town centre with a long enough approach.
    const nodes = l.nodes.filter((n) => k.test(n.id)).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    for (const N of nodes) {
      // The landmark is seen from the boulevard that ends in front of it (the stem of the T); elsewhere the longest way in.
      const ways = edgesAt(N.id)
        .filter((e) => e.cls !== 'alley' && (k.id !== 'vista' || isStem(l, N.id, e)))
        .map((e) => ({ e, len: straightBack(l, N.id, e) }))
        .filter((w) => w.len >= junctionBox(l, N.id, w.e) + 24)
        .sort((a, b) => b.len - a.len);
      if (!ways.length) continue;
      const { e: approach, len } = ways[0];
      const O = l.nodes[approach.a === N.id ? approach.b : approach.a];
      const dx = (N.x - O.x) / approach.length;
      const dz = (N.z - O.z) / approach.length;
      // Up to 40 m back, staying clear of where the straight approach began.
      const dist = Math.min(40, len - 8);
      const o = laneOffsets(approach.cls)[0];
      out.push({ id: k.id, label: k.label, x: N.x - dx * dist - dz * o, y: 0, z: N.z - dz * dist + dx * o, yaw: heading(dx, dz) });
      break;
    }
  }
  return out;
}

/**
 * One teleport per building sample area (A3): on the most important road along
 * its blocks (downtown: the 3+3 arterial), in the right lane, a third of the
 * way along, looking down the road past the buildings.
 */
function areaTeleports(l: CityLayout, b: Buildings): { id: string; label: string; x: number; y: number; z: number; yaw: number }[] {
  const rank = ['arterial3', 'boulevard', 'avenue', 'street'];
  const out: { id: string; label: string; x: number; y: number; z: number; yaw: number }[] = [];
  for (const a of b.areas) {
    const edges = [...new Set(a.blocks.flatMap((id) => l.blocks[id].edges))].map((id) => l.edges[id]).filter((e) => rank.includes(e.cls) && e.length >= 40);
    // Most important class first, then the road with the most of the area's blocks along it, then the longest.
    const along = (e: LayoutEdge) => a.blocks.filter((id) => l.blocks[id].edges.includes(e.id)).length;
    edges.sort((p, q) => rank.indexOf(p.cls) - rank.indexOf(q.cls) || along(q) - along(p) || q.length - p.length);
    const e = edges[0];
    if (!e) continue;
    const A = l.nodes[e.a];
    const B = l.nodes[e.b];
    const dx = (B.x - A.x) / e.length;
    const dz = (B.z - A.z) / e.length;
    const s0 = junctionBox(l, e.a, e) + 2;
    const s = s0 + Math.max(0, Math.round((e.length / 3 - s0) / 8)) * 8;
    const o = laneOffsets(e.cls)[0];
    out.push({ id: `a3-${a.id}`, label: a.label, x: A.x + dx * s - dz * o, y: 0, z: A.z + dz * s + dx * o, yaw: heading(dx, dz) });
  }
  return out;
}

/**
 * How far one can go straight back from node n along road e, through junctions
 * where the road continues on the same line (up to 120 m), m.
 */
function straightBack(l: CityLayout, n: number, e: LayoutEdge): number {
  const d = l.nodes[n].out.indexOf(e.id);
  let len = 0;
  let cur = n;
  let edge = e.id;
  while (edge >= 0 && len < 120) {
    const E = l.edges[edge];
    len += E.length;
    cur = E.a === cur ? E.b : E.a;
    edge = l.nodes[cur].out[d];
  }
  return len;
}

function isStem(l: CityLayout, n: number, e: LayoutEdge): boolean {
  const out = l.nodes[n].out;
  const d = out.indexOf(e.id);
  return d >= 0 && out[(d + 2) % 4] < 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
