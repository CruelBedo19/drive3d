/**
 * Turns the downloaded car models (assets-src/vehicles/*.glb) into game-ready
 * GLBs with one common layout, so every car loads the same way:
 *
 *   metres, nose towards +Z, left = +X, ground at y = 0, centred between the
 *   wheels; root nodes Body, WheelFL, WheelFR, WheelRL, WheelRR (each wheel
 *   group holds its tyre, rim, cap ... meshes), optional HeadLights,
 *   TailLights, SteeringWheel (origin at the wheel's centre).
 *
 * Wheels are found by shape and position (round, low, at the corners); parts
 * inside a wheel spin with it unless they match `noSpin` (brake calipers).
 * Meshes holding both wheels of an axle are split into left / right halves.
 * Meshes of one part sharing a material are merged (fewer draw calls), and a
 * recipe may simplify its geometry by region (`simplify`). Textures are resized
 * and re-encoded as WebP; geometry is welded, quantised and meshopt-compressed
 * (EXT_meshopt_compression: the game's loader needs the meshopt decoder). Measurements (wheelbase, track,
 * wheel radius, body size) go to src/config/vehicles/carFits.json, from which
 * each car's physics dimensions are set.
 *
 * `npm run prepare:cars` (or `-- <id>` for one car).
 */
import { Document, NodeIO, type Mesh, type Node, type Primitive, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, compactPrimitive, dedup, flatten, join as joinPrimitives, meshopt, prune, textureCompress, weld } from '@gltf-transform/functions';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder, MeshoptSimplifier, type Flags } from 'meshoptimizer';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FITS = join(ROOT, 'src/config/vehicles/carFits.json');

interface Recipe {
  id: string;
  source: string;
  /** Rotation around Y (degrees) that turns the model's nose towards +Z. */
  rotateY: number;
  /** Real wheelbase in metres: sets the scale. */
  wheelbase: number;
  /** Meshes (node or material name) inside a wheel that must not spin. */
  noSpin?: RegExp;
  /** Meshes to drop entirely (spares, duplicate LODs). */
  exclude?: RegExp;
  /** Split meshes that contain both wheels of an axle into left / right. */
  splitAxles?: boolean;
  /** Meshes (node or material name) holding parts of several wheels: split into the four corners first. */
  wheelSplit?: RegExp;
  /** Lamp meshes by node or material name; head / tail decided by position (front / rear half). */
  lamps?: RegExp;
  /** Head lamp meshes (node or material name): only their front half (z > 0) becomes HeadLights. */
  headLamps?: RegExp;
  /** Brake / tail lamp meshes: only their rear half (z < 0) becomes TailLights. */
  tailLamps?: RegExp;
  steeringWheel?: RegExp;
  /** Longest texture side after resizing. */
  textureSize: number;
  /** Merge the meshes of each part (body, each wheel, lamp group) that share a material: far fewer draw calls. */
  merge?: boolean;
  /** Region-aware simplification for heavy models (absolute errors in metres; see simplifyByRegion). */
  simplify?: SimplifyRecipe;
}

interface SimplifyRecipe {
  /** Cabin volume in the prepared frame (min, max corners): triangles inside it are interior. */
  cabin: [[number, number, number], [number, number, number]];
  /** Body outside the cabin: seams (normals / UVs) kept, so badges and decals stay put. */
  exterior: number;
  /** Wheel groups: may collapse across seams where normals / UVs barely change. */
  wheels: number;
  /** Seen only through the windows: collapses across seams more freely. */
  interior: number;
}

/**
 * Lamp materials picked from where each material's triangles sit (front / rear 0.5 m, height, side), colour
 * and emissive, not from names alone; cars without a clear match have no mapping (the feature stays off).
 */
const LAMPS = {
  // Emissive-textured lens material at both ends. Front only: lit at the rear, its white emissive texture
  // turns a brake light orange-white instead of red, so the M4 has no brake light mapping.
  m4: /^Puncheffnuminnernalphaalphaitapuncheffnuminnernalph1_diff$/,
};

const RECIPES: Recipe[] = [
  {
    id: 'bmw_m3_e92',
    source: '2008_bmw_m3_e92.glb',
    rotateY: 180,
    wheelbase: 2.761,
    lamps: /HeadLight|TailLight/i,
    steeringWheel: /^SteeringWheel/i,
    textureSize: 2048,
    merge: true,
  },
  { id: 'bmw_m4_f82', source: '2014_bmw_m4_f82.glb', rotateY: 180, wheelbase: 2.812, textureSize: 2048, merge: true, headLamps: LAMPS.m4 },
  {
    id: 'amg_c63s_w205',
    source: 'mercedes-amg_c_63_coupe_s_w205.glb',
    rotateY: 0,
    wheelbase: 2.84,
    splitAxles: true,
    lamps: /vehiclelights/i,
    textureSize: 1024,
    merge: true,
  },
  {
    id: 'amg_one',
    source: 'mercedes_amg_one.glb',
    rotateY: 0,
    wheelbase: 2.72,
    noSpin: /caliper/i,
    lamps: /brake_lamp/i,
    textureSize: 2048,
    merge: true,
  },
  // Second batch (assets-src/vehicles/arabalar/, Sketchfab "reduced" exports).
  { id: 'porsche_911_gt3_rsr', source: 'arabalar/2022_porche_911_gt3_rsr-ressduced.glb', rotateY: 0, wheelbase: 2.51, textureSize: 1024, merge: true, tailLamps: /^Meshpart1Mtl$/ },
  { id: 'audi_rs6_c8', source: 'arabalar/audi_rs_6_avant_c8-reduced.glb', rotateY: 0, wheelbase: 2.929, textureSize: 1024, merge: true, headLamps: /LightA_Material1$/, tailLamps: /LightA_Material1$|^red_glass$/ },
  { id: 'bmw_m3_e36', source: 'arabalar/bmw_e36_m3.glb', rotateY: 0, wheelbase: 2.7, exclude: /^Scene$/, wheelSplit: /^(Tire|SeconadryColor|Textures)\.001$/, textureSize: 1024, merge: true, headLamps: /^(HeadLights|Light)$/, tailLamps: /^RearLights$/ },
  { id: 'bmw_m3_g81', source: 'arabalar/bmw_m3_competition_tourning_g81-reduced.glb', rotateY: 0, wheelbase: 2.857, textureSize: 1024, merge: true, headLamps: /_(running_front|headlight_low|headlight_high)$/, tailLamps: /_(taillight|running_rear)$/ },
  { id: 'ferrari_f40', source: 'arabalar/ferrari_f40-reduced.glb', rotateY: 0, wheelbase: 2.45, textureSize: 1024, merge: true, headLamps: /^(F40_Headlights|super_headlight)$/, tailLamps: /^super_brakelight$/ },
  { id: 'honda_civic_ek9', source: 'arabalar/honda_civic_type_r_-98_free_asset-reduced.glb', rotateY: 0, wheelbase: 2.62, textureSize: 1024, merge: true, tailLamps: /^Glass_02_MAT$/ },
  { id: 'honda_nsx', source: 'arabalar/honda_nsx_1990-reduced.glb', rotateY: 0, wheelbase: 2.53, textureSize: 1024, merge: true, tailLamps: /^Material\.009$/ },
  {
    id: 'brabus_g900',
    source: 'arabalar/mercedes_amg_g900_by_brabus-reduced.glb',
    rotateY: 0,
    wheelbase: 2.89,
    wheelSplit: /_wheel|michelin|rimdetail|diamondcutrim/i,
    textureSize: 512,
    merge: true,
    headLamps: /^leather02_weave_18$/,
    tailLamps: /^(plastic5_14|ExtWindowsGlass_1)$/,
    // 355k triangles: a third of them in the cabin. The box stays inside the door panels and glass.
    simplify: { cabin: [[-0.82, 0.6, -1.95], [0.82, 1.85, 0.75]], exterior: 0.001, wheels: 0.001, interior: 0.008 },
  },
  { id: 'maybach_gls600', source: 'arabalar/mersedes-_benz_maybach_gls_600-reduced.glb', rotateY: 0, wheelbase: 3.135, textureSize: 1024, merge: true, headLamps: /^lsiggls\.001$/, tailLamps: /^(gls_run\.001|etk800_glass\.002)$/ },
];

const CORNERS = ['WheelFL', 'WheelFR', 'WheelRL', 'WheelRR'] as const;
type Corner = (typeof CORNERS)[number];

interface Box {
  min: number[];
  max: number[];
}
const size = (b: Box) => [0, 1, 2].map((k) => b.max[k] - b.min[k]);
const centre = (b: Box) => [0, 1, 2].map((k) => (b.max[k] + b.min[k]) / 2);

export interface CarFit {
  /** Wheel centre height above ground, = tyre radius. */
  wheelRadius: number;
  wheelWidth: number;
  wheelbase: number;
  /** Axle positions along +Z (front positive) relative to the model origin. */
  frontZ: number;
  rearZ: number;
  frontHalfTrack: number;
  rearHalfTrack: number;
  /** Body bounding box, metres. */
  length: number;
  width: number;
  height: number;
  /** Lowest point of the body above the ground (ground clearance of the model). */
  minY: number;
  scale: number;
  sizeMB: number;
}

async function prepare(recipe: Recipe, io: NodeIO): Promise<CarFit> {
  const src = join(ROOT, 'assets-src/vehicles', recipe.source);
  const doc = await io.read(src);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];

  // Names of every mesh node's ancestors: flattening drops the hierarchy, and the
  // meaningful names ("HeadLightL", "SteeringWheel") are often on a parent.
  ancestry.clear();
  const walk = (n: Node, names: string[]) => {
    const here = [...names, n.getName()];
    if (n.getMesh()) ancestry.set(n, here);
    for (const c of n.listChildren()) walk(c, here);
  };
  for (const n of scene.listChildren()) walk(n, []);

  // 1. Rotate the whole model, bring every mesh node to the scene root and bake transforms into vertices.
  const pivot = doc.createNode('orient').setRotation(quatY(recipe.rotateY));
  for (const child of scene.listChildren()) pivot.addChild(child);
  scene.addChild(pivot);
  await doc.transform(flatten());
  let meshNodes = listMeshNodes(scene);
  for (const n of meshNodes) clearNodeTransform(n);
  for (const n of scene.listChildren()) if (!n.getMesh() && n.listChildren().length === 0) n.dispose();

  if (recipe.exclude) for (const n of meshNodes) if (matches(n, recipe.exclude)) n.dispose();
  meshNodes = listMeshNodes(scene);

  // 2. Overall box (ignoring tiny outliers is not needed: these models are clean).
  let all = unionBox(meshNodes.map(boundsOf));
  const height = all.max[1] - all.min[1];

  // 3. Split axle meshes (one mesh, both wheels) into left / right halves.
  if (recipe.splitAxles) {
    const cx = centre(all)[0];
    for (const n of [...meshNodes]) {
      const b = boundsOf(n);
      const s = size(b);
      if (isRound(s, 'x') || !(Math.abs(s[1] - s[2]) / Math.max(s[1], s[2]) < 0.25) || s[0] < (all.max[0] - all.min[0]) * 0.6 || centre(b)[1] - all.min[1] > height * 0.45) continue;
      splitNode(doc, scene, n, (p) => p[0] < cx);
    }
    meshNodes = listMeshNodes(scene);
  }
  if (recipe.wheelSplit) {
    const c = centre(all);
    for (const n of [...meshNodes]) {
      if (!matches(n, recipe.wheelSplit)) continue;
      for (const half of splitNode(doc, scene, n, (p) => p[0] < c[0])) if (half) splitNode(doc, scene, half, (p) => p[2] < c[2]);
    }
    meshNodes = listMeshNodes(scene);
  }

  // 4. Wheels: the biggest round low mesh near each corner is the tyre; parts inside its cylinder join it.
  all = unionBox(meshNodes.map(boundsOf));
  const mid = centre(all);
  const tyres = new Map<Corner, { node: Node; box: Box }>();
  const candidates: { corner: Corner; box: Box }[] = [];
  for (const n of meshNodes) {
    const b = boundsOf(n);
    const s = size(b);
    const c = centre(b);
    if (!isRound(s, 'x') || c[1] - all.min[1] > height * 0.45 || s[1] < height * 0.2 || s[0] > s[1]) continue;
    const corner = cornerOf(c, mid);
    candidates.push({ corner, box: b });
    const prev = tyres.get(corner);
    if (!prev || s[1] * s[2] > size(prev.box)[1] * size(prev.box)[2]) tyres.set(corner, { node: n, box: b });
  }
  if (tyres.size !== 4) throw new Error(`${recipe.id}: found ${tyres.size} wheels (${[...tyres.keys()].join(', ')})`);
  // A tyre modelled as separate inner and outer walls: as big as each other, the wheel spans both.
  for (const [corner, t] of tyres) {
    const area = size(t.box)[1] * size(t.box)[2];
    const same = candidates.filter((k) => k.corner === corner && size(k.box)[1] * size(k.box)[2] >= area * 0.97);
    t.box = unionBox(same.map((k) => k.box));
  }

  const wheelInfo = CORNERS.map((corner) => {
    const t = tyres.get(corner)!;
    const c = centre(t.box);
    const s = size(t.box);
    return { corner, c, r: Math.max(s[1], s[2]) / 2, w: s[0] };
  });
  const groups = new Map<Corner, Node[]>(CORNERS.map((c) => [c, []]));
  for (const n of meshNodes) {
    const b = boundsOf(n);
    for (const wi of wheelInfo) {
      if (inWheel(b, wi.c, wi.r, wi.w) && !(recipe.noSpin && matches(n, recipe.noSpin))) {
        groups.get(wi.corner)!.push(n);
        break;
      }
    }
  }

  // 5. Scale from the real wheelbase, then centre: x between the wheels, z mid-wheelbase, ground at 0.
  const frontZ = (wheelInfo[0].c[2] + wheelInfo[1].c[2]) / 2;
  const rearZ = (wheelInfo[2].c[2] + wheelInfo[3].c[2]) / 2;
  if (frontZ <= rearZ) throw new Error(`${recipe.id}: front wheels are behind the rear ones: wrong rotateY`);
  const scale = recipe.wheelbase / (frontZ - rearZ);
  const cx = wheelInfo.reduce((s, w) => s + w.c[0], 0) / 4;
  const ground = Math.min(...wheelInfo.map((w) => w.c[1] - w.r));
  const cz = (frontZ + rearZ) / 2;
  for (const n of listMeshNodes(scene)) {
    n.setScale([scale, scale, scale]).setTranslation([-cx * scale, -ground * scale, -cz * scale]);
    clearNodeTransform(n);
  }

  // 6. Final layout.
  const body = doc.createNode('Body');
  scene.addChild(body);
  const wheelSet = new Set<Node>();
  for (const corner of CORNERS) {
    const g = doc.createNode(corner);
    scene.addChild(g);
    for (const n of groups.get(corner)!) {
      g.addChild(n);
      wheelSet.add(n);
    }
  }
  const lampFront = doc.createNode('HeadLights');
  const lampRear = doc.createNode('TailLights');
  const steering = doc.createNode('SteeringWheel');
  const steeringParts: Node[] = [];
  for (const n of listMeshNodes(scene)) {
    if (wheelSet.has(n)) continue;
    const head = recipe.headLamps && matches(n, recipe.headLamps);
    const tail = recipe.tailLamps && matches(n, recipe.tailLamps);
    if (head || tail) {
      // Only the half at the lamp's own end; whatever the material also covers elsewhere stays body.
      const [front, rear] = splitNode(doc, scene, n, (p) => p[2] > 0);
      if (front) (head ? lampFront : body).addChild(front);
      if (rear) (tail ? lampRear : body).addChild(rear);
    } else if (recipe.lamps && matches(n, recipe.lamps)) {
      const b = boundsOf(n);
      // A lamp mesh spanning front and back is split by position.
      if (b.min[2] < -0.5 && b.max[2] > 0.5) {
        const [front, rear] = splitNode(doc, scene, n, (p) => p[2] > 0);
        if (front) lampFront.addChild(front);
        if (rear) lampRear.addChild(rear);
      } else (centre(b)[2] > 0 ? lampFront : lampRear).addChild(n);
    } else if (recipe.steeringWheel && matches(n, recipe.steeringWheel)) {
      steeringParts.push(n);
    } else {
      body.addChild(n);
    }
  }
  for (const lamp of [lampFront, lampRear]) if (lamp.listChildren().length) body.addChild(lamp);
  if (steeringParts.length) {
    // Origin at the wheel's centre so the game can turn it in place.
    const c = centre(unionBox(steeringParts.map(boundsOf)));
    steering.setTranslation(c as [number, number, number]);
    for (const n of steeringParts) {
      n.setTranslation([-c[0], -c[1], -c[2]]);
      clearNodeTransform(n);
      steering.addChild(n);
    }
    body.addChild(steering);
  }
  for (const n of scene.listChildren()) if (!n.getMesh() && n.listChildren().length === 0) n.dispose();

  // 7. Clean up and shrink.
  await doc.transform(prune(), dedup(), ...(recipe.merge ? [joinPrimitives({ keepNamed: false }), prune()] : []), weld());
  if (recipe.simplify) simplifyByRegion(doc, scene, recipe.simplify);
  await doc.transform(
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [recipe.textureSize, recipe.textureSize] }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );

  const outDir = join(ROOT, 'public/assets/vehicles', recipe.id);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${recipe.id}.glb`);
  await io.write(out, doc);

  // Measurements in the final frame.
  const bodyBox = unionBox(listMeshNodesDeep(scene).map((n) => worldBounds(n)));
  const wheels = CORNERS.map((corner) => {
    const g = scene.listChildren().find((n) => n.getName() === corner)!;
    return unionBox(g.listChildren().map(worldBounds));
  });
  const wc = wheels.map(centre);
  const parts = CORNERS.map((corner) => scene.listChildren().find((n) => n.getName() === corner)!.listChildren().length);
  const named = (name: string) => listMeshNodesDeep(scene).some((n) => n.getParentNode()?.getName() === name);
  console.log(`  wheel parts ${parts.join('/')}, head lamps ${named('HeadLights')}, tail lamps ${named('TailLights')}, steering wheel ${named('SteeringWheel')}`);
  const ws = wheels.map(size);
  const sizeMB = readFileSync(out).length / 1e6;
  return {
    wheelRadius: round(Math.max(...ws.map((s) => Math.max(s[1], s[2]) / 2))),
    wheelWidth: round(Math.max(...ws.map((s) => s[0]))),
    wheelbase: round((wc[0][2] + wc[1][2]) / 2 - (wc[2][2] + wc[3][2]) / 2),
    frontZ: round((wc[0][2] + wc[1][2]) / 2),
    rearZ: round((wc[2][2] + wc[3][2]) / 2),
    frontHalfTrack: round((wc[0][0] - wc[1][0]) / 2),
    rearHalfTrack: round((wc[2][0] - wc[3][0]) / 2),
    length: round(bodyBox.max[2] - bodyBox.min[2]),
    width: round(bodyBox.max[0] - bodyBox.min[0]),
    height: round(bodyBox.max[1] - bodyBox.min[1]),
    minY: round(bodyBox.min[1]),
    scale: round(scale, 5),
    sizeMB: round(sizeMB, 2),
  };
}

// --- simplification --------------------------------------------------------------------

/**
 * Splits every primitive's triangles into cabin / outside sets (by centroid) and simplifies each set on its own
 * with the border between them locked, then puts them back into the same primitive: no extra draw calls, no
 * cracks. Glass (alpha blend) is never touched; nothing is pruned, so no part disappears.
 */
function simplifyByRegion(doc: Document, scene: { listChildren(): Node[] }, s: SimplifyRecipe): void {
  const [lo, hi] = s.cabin;
  const inCabin = (p: number[]) => p[0] > lo[0] && p[0] < hi[0] && p[1] > lo[1] && p[1] < hi[1] && p[2] > lo[2] && p[2] < hi[2];
  const before = { interior: 0, exterior: 0, wheels: 0 };
  const after = { interior: 0, exterior: 0, wheels: 0 };
  const walk = (n: Node, wheel: boolean) => {
    const m = n.getWorldMatrix();
    for (const prim of n.getMesh()?.listPrimitives() ?? []) {
      if (prim.getMaterial()?.getAlphaMode() === 'BLEND') continue;
      const pos = prim.getAttribute('POSITION')!;
      const idx = prim.getIndices()!;
      const inside: number[] = [];
      const outside: number[] = [];
      const p = [0, 0, 0];
      for (let i = 0; i < idx.getCount(); i += 3) {
        const c = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
          pos.getElement(idx.getScalar(i + k), p);
          for (let a = 0; a < 3; a++) c[a] += p[a] / 3;
        }
        const w = [0, 1, 2].map((a) => m[a] * c[0] + m[4 + a] * c[1] + m[8 + a] * c[2] + m[12 + a]);
        (!wheel && inCabin(w) ? inside : outside).push(idx.getScalar(i), idx.getScalar(i + 1), idx.getScalar(i + 2));
      }
      const outKind = wheel ? 'wheels' : 'exterior';
      const a = simplifySet(prim, inside, s.interior, 0.02);
      const b = simplifySet(prim, outside, s[outKind], wheel ? 0.1 : 0);
      before.interior += inside.length / 3;
      before[outKind] += outside.length / 3;
      after.interior += a.length / 3;
      after[outKind] += b.length / 3;
      const merged = new Uint32Array(a.length + b.length);
      merged.set(a, 0);
      merged.set(b, a.length);
      idx.dispose();
      prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(pos.getCount() > 65535 ? merged : new Uint16Array(merged)));
      compactPrimitive(prim);
    }
    for (const c of n.listChildren()) walk(c, wheel);
  };
  for (const n of scene.listChildren()) walk(n, n.getName().startsWith('Wheel'));
  for (const k of ['interior', 'exterior', 'wheels'] as const) console.log(`  simplify ${k}: ${before[k]} → ${after[k]} triangles`);
}

/**
 * meshoptimizer simplification of one triangle set, error in metres. `attributeWeight` > 0 lets it collapse
 * across normal / UV seams (Permissive) while weighing how much they change; 0 keeps every seam.
 */
function simplifySet(prim: Primitive, set: number[], error: number, attributeWeight: number): Uint32Array {
  const indices = new Uint32Array(set);
  if (!(error > 0) || indices.length === 0) return indices;
  const pos = prim.getAttribute('POSITION')!;
  const count = pos.getCount();
  const positions = new Float32Array(count * 3);
  const el = [0, 0, 0];
  for (let i = 0; i < count; i++) positions.set(pos.getElement(i, el), i * 3);
  const flags: Flags[] = ['LockBorder', 'ErrorAbsolute'];
  if (attributeWeight > 0) {
    const nrm = prim.getAttribute('NORMAL');
    const uv = prim.getAttribute('TEXCOORD_0');
    const stride = (nrm ? 3 : 0) + (uv ? 2 : 0);
    if (stride > 0) {
      const attrs = new Float32Array(count * stride);
      for (let i = 0; i < count; i++) {
        let o = i * stride;
        if (nrm) for (const v of nrm.getElement(i, el)) attrs[o++] = v;
        if (uv) for (const v of uv.getElement(i, [0, 0])) attrs[o++] = v;
      }
      return MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, attrs, stride, new Array(stride).fill(attributeWeight), null, 0, error, [...flags, 'Permissive'])[0];
    }
  }
  return MeshoptSimplifier.simplify(indices, positions, 3, 0, error, flags)[0];
}

// --- helpers -------------------------------------------------------------------------

function quatY(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

function listMeshNodes(scene: { listChildren(): Node[] }): Node[] {
  return scene.listChildren().filter((n) => n.getMesh());
}

function listMeshNodesDeep(scene: { listChildren(): Node[] }): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (n.getMesh()) out.push(n);
    n.listChildren().forEach(walk);
  };
  scene.listChildren().forEach(walk);
  return out;
}

const ancestry = new Map<Node, string[]>();

function matches(n: Node, re: RegExp): boolean {
  const mesh = n.getMesh();
  const names = [...(ancestry.get(n) ?? [n.getName()]), mesh?.getName() ?? '', ...(mesh?.listPrimitives().map((p) => p.getMaterial()?.getName() ?? '') ?? [])];
  return names.some((s) => re.test(s));
}

function boundsOf(n: Node): Box {
  return getBounds(n);
}

function worldBounds(n: Node): Box {
  return getBounds(n);
}

function unionBox(boxes: Box[]): Box {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], b.min[k]);
    max[k] = Math.max(max[k], b.max[k]);
  }
  return { min, max };
}

/** Round in the plane across `axis` (a wheel's side view). */
function isRound(s: number[], axis: 'x'): boolean {
  void axis;
  return Math.abs(s[1] - s[2]) / Math.max(s[1], s[2]) < 0.2 && s[0] < Math.max(s[1], s[2]) * 0.9;
}

function cornerOf(c: number[], mid: number[]): Corner {
  const front = c[2] > mid[2];
  const left = c[0] > mid[0];
  return front ? (left ? 'WheelFL' : 'WheelFR') : left ? 'WheelRL' : 'WheelRR';
}

/** The whole box lies inside the wheel's cylinder (a little margin). */
function inWheel(b: Box, c: number[], r: number, w: number): boolean {
  const rr = r * 1.04;
  for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) if (Math.hypot(y - c[1], z - c[2]) > rr * 1.15 && (Math.abs(y - c[1]) > rr || Math.abs(z - c[2]) > rr)) return false;
  return b.min[0] >= c[0] - w * 0.9 && b.max[0] <= c[0] + w * 0.9;
}

/** Splits a mesh node in two by which side of `test` each triangle's centroid falls. Returns [kept-true, kept-false]. */
function splitNode(doc: Document, scene: { addChild(n: Node): unknown }, node: Node, test: (p: number[]) => boolean): [Node | null, Node | null] {
  const mesh = node.getMesh() as Mesh;
  const meshA = doc.createMesh(`${mesh.getName()}_a`);
  const meshB = doc.createMesh(`${mesh.getName()}_b`);
  for (const prim of mesh.listPrimitives()) {
    const [a, b] = splitPrimitive(doc, prim, test);
    if (a) meshA.addPrimitive(a);
    if (b) meshB.addPrimitive(b);
  }
  const out: [Node | null, Node | null] = [null, null];
  if (meshA.listPrimitives().length) {
    out[0] = doc.createNode(`${node.getName()}_a`).setMesh(meshA);
    scene.addChild(out[0]);
  }
  if (meshB.listPrimitives().length) {
    out[1] = doc.createNode(`${node.getName()}_b`).setMesh(meshB);
    scene.addChild(out[1]);
  }
  node.dispose();
  return out;
}

function splitPrimitive(doc: Document, prim: Primitive, test: (p: number[]) => boolean): [Primitive | null, Primitive | null] {
  const pos = prim.getAttribute('POSITION');
  if (!pos) return [prim, null];
  const count = pos.getCount();
  const idx = prim.getIndices();
  const tri: number[] = [];
  if (idx) for (let i = 0; i < idx.getCount(); i++) tri.push(idx.getScalar(i));
  else for (let i = 0; i < count; i++) tri.push(i);
  const a: number[] = [];
  const b: number[] = [];
  const p = [0, 0, 0];
  const q = [0, 0, 0];
  for (let i = 0; i < tri.length; i += 3) {
    const cen = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      pos.getElement(tri[i + k], p);
      cen[0] += p[0] / 3;
      cen[1] += p[1] / 3;
      cen[2] += p[2] / 3;
    }
    (test(cen) ? a : b).push(tri[i], tri[i + 1], tri[i + 2]);
  }
  void q;
  const make = (list: number[]) => {
    if (!list.length) return null;
    const out = prim.clone();
    const acc = doc.createAccessor().setType('SCALAR').setArray(count > 65535 ? new Uint32Array(list) : new Uint16Array(list));
    out.setIndices(acc);
    compactPrimitive(out);
    return out;
  };
  return [make(a), make(b)];
}

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

async function main(): Promise<void> {
  const only = process.argv[2];
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const fits: Record<string, CarFit> = existsSync(FITS) ? JSON.parse(readFileSync(FITS, 'utf8')) : {};
  for (const r of RECIPES) {
    if (only && r.id !== only) continue;
    const t0 = performance.now();
    const fit = await prepare(r, io);
    fits[r.id] = fit;
    console.log(`${r.id}: ${fit.sizeMB} MB, wheelbase ${fit.wheelbase} m, track ${(fit.frontHalfTrack * 2).toFixed(2)}/${(fit.rearHalfTrack * 2).toFixed(2)} m, wheel r ${fit.wheelRadius} m, body ${fit.length}×${fit.width}×${fit.height} m, scale ${fit.scale} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  }
  writeFileSync(FITS, `${JSON.stringify(fits, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
