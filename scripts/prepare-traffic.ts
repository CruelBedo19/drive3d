/**
 * Splits the "Generic civil service vehicles pack" (assets-src/vehicles,
 * Comrade1280, CC BY 4.0) into one small game-ready GLB per vehicle for the AI
 * traffic: metres, nose towards +Z, centred, ground at y = 0, transforms baked,
 * meshes merged per material, textures resized and re-encoded as WebP.
 *
 * The vehicles stand at angles in the source scene: each one's long axis is
 * found from its vertices (principal axis on the ground plane) and turned onto
 * Z; `flip` turns a model that then faces backwards. Sizes go to
 * src/config/trafficModels.json, which the traffic classes read.
 *
 * `npm run prepare:traffic`
 */
import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, dedup, flatten, join, prune, textureCompress, weld } from '@gltf-transform/functions';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = joinPath(ROOT, 'assets-src/vehicles/generic_civil_service_vehicles_pack.glb');
const OUT = joinPath(ROOT, 'public/assets/traffic');
const SIZES = joinPath(ROOT, 'src/config/trafficModels.json');

/** Source node → game id, and whether it faces -Z after aligning (turned 180°). */
const VEHICLES: { node: string; id: string; flip: boolean }[] = [
  { node: 'taxi', id: 'taxi', flip: false },
  { node: 'police_sedan', id: 'police', flip: false },
  { node: 'postvan', id: 'postvan', flip: false },
  { node: 'ambulance', id: 'ambulance', flip: false },
  { node: 'citybus', id: 'citybus', flip: true },
  { node: 'school_bus', id: 'schoolbus', flip: true },
  { node: 'garbage_truck', id: 'garbagetruck', flip: false },
  { node: 'rdservtruck', id: 'servicetruck', flip: true },
  { node: 'towtruck', id: 'towtruck', flip: true },
  { node: 'fire_truck', id: 'firetruck', flip: true },
];

const FLIPS = new Set((process.env.TRAFFIC_FLIP ?? '').split(',').filter(Boolean));

function meshNodes(n: Node, out: Node[] = []): Node[] {
  if (n.getMesh()) out.push(n);
  for (const c of n.listChildren()) meshNodes(c, out);
  return out;
}

/** World-space vertex positions (after transforms were baked). */
function positions(nodes: Node[]): number[][] {
  const out: number[][] = [];
  for (const n of nodes) {
    for (const p of n.getMesh()!.listPrimitives()) {
      const a = p.getAttribute('POSITION')!;
      const v = [0, 0, 0];
      for (let i = 0; i < a.getCount(); i++) out.push([...a.getElement(i, v)]);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  mkdirSync(OUT, { recursive: true });
  const sizes: Record<string, { length: number; width: number; height: number }> = {};
  for (const veh of VEHICLES) {
    const doc = await io.read(SOURCE);
    const root = doc.getRoot();
    const scene = root.getDefaultScene() ?? root.listScenes()[0];
    const rootNode = root.listNodes().find((n) => n.getName() === 'RootNode')!;
    for (const c of rootNode.listChildren()) if (c.getName() !== veh.node) c.dispose();
    await doc.transform(flatten());
    let nodes = scene.listChildren().flatMap((n) => meshNodes(n));
    for (const n of nodes) clearNodeTransform(n);

    // Principal axis on the ground plane → +Z.
    const pts = positions(nodes);
    let mx = 0;
    let mz = 0;
    for (const p of pts) {
      mx += p[0];
      mz += p[2];
    }
    mx /= pts.length;
    mz /= pts.length;
    let cxx = 0;
    let czz = 0;
    let cxz = 0;
    for (const p of pts) {
      const dx = p[0] - mx;
      const dz = p[2] - mz;
      cxx += dx * dx;
      czz += dz * dz;
      cxz += dx * dz;
    }
    const axis = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    const phi = axis - Math.PI / 2 + (veh.flip !== FLIPS.has(veh.id) ? Math.PI : 0);
    const q: [number, number, number, number] = [0, Math.sin(phi / 2), 0, Math.cos(phi / 2)];
    for (const n of nodes) {
      n.setTranslation([-mx, 0, -mz]);
      clearNodeTransform(n);
      n.setRotation(q);
      clearNodeTransform(n);
    }
    // Centre the box, ground at 0.
    const after = positions(nodes);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const p of after) for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
    const c = [(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2];
    const body = doc.createNode('Body');
    scene.addChild(body);
    for (const n of nodes) {
      n.setTranslation([-c[0], -c[1], -c[2]]);
      clearNodeTransform(n);
      body.addChild(n);
    }
    for (const n of scene.listChildren()) if (n !== body) n.dispose();
    nodes = meshNodes(body);
    await doc.transform(prune(), dedup(), weld(), join(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }));
    await io.write(joinPath(OUT, `${veh.id}.glb`), doc);
    sizes[veh.id] = { length: +(max[2] - min[2]).toFixed(3), width: +(max[0] - min[0]).toFixed(3), height: +(max[1] - min[1]).toFixed(3) };
    console.log(veh.id.padEnd(13), `${sizes[veh.id].length} × ${sizes[veh.id].width} × ${sizes[veh.id].height} m`);
  }
  writeFileSync(SIZES, `${JSON.stringify(sizes, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
