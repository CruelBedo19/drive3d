/**
 * Splits the "Orchids Simulator Traffic Car Pack" (assets-src/vehicles/arabalar/trafik,
 * Oren garage, CC BY 4.0) into one small game-ready GLB per vehicle for the AI
 * traffic: metres, nose towards +Z, centred, ground at y = 0, transforms baked,
 * meshes merged per material, textures resized and re-encoded as WebP.
 *
 * The pack is one flat scene of unnamed meshes with the vehicles parked side by
 * side, all already facing +Z: meshes whose ground-plane boxes overlap form one
 * vehicle (small loose parts such as mirrors join the vehicle around them), and
 * each vehicle below is picked by a point inside it in the source scene. Sizes,
 * kind and main colour go to src/config/trafficModels.json, from which
 * src/config/traffic.ts makes one traffic class per vehicle.
 *
 * `npm run prepare:traffic`
 */
import { NodeIO, getBounds, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, dedup, flatten, join, prune, textureCompress, weld } from '@gltf-transform/functions';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = joinPath(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = joinPath(ROOT, 'assets-src/vehicles/arabalar/trafik/orchids_simulator_traffic_car_pack.glb');
const OUT = joinPath(ROOT, 'public/assets/traffic');
const SIZES = joinPath(ROOT, 'src/config/trafficModels.json');

/** What a vehicle is: sets its handling, lanes and drivers (src/config/traffic.ts). */
type Kind = 'car' | 'suv' | 'pickup' | 'van' | 'police' | 'lightTruck' | 'truck' | 'bus';

/** Game id, kind and a point (x, z) inside the vehicle in the source scene; `scale` fixes a model built too big. */
const VEHICLES: { id: string; kind: Kind; at: [number, number]; scale?: number }[] = [
  { id: 'lorry_tarp', kind: 'truck', at: [-14.48, 1.86] },
  { id: 'lorry_box', kind: 'truck', at: [-14.24, 14.13] },
  { id: 'sedan_rusty', kind: 'car', at: [-11.99, 4.4] },
  { id: 'sedan_green', kind: 'car', at: [-11.62, -1.11] },
  { id: 'box_truck', kind: 'lightTruck', at: [-10.73, 11.5] },
  { id: 'box_truck_small', kind: 'lightTruck', at: [-10.73, 17.65] },
  { id: 'sedan_silver', kind: 'car', at: [-9.72, -1.02] },
  { id: 'sedan_white_old', kind: 'car', at: [-9.71, 4.46] },
  { id: 'flatbed_truck', kind: 'lightTruck', at: [-7.21, 11.5] },
  { id: 'sedan_grey', kind: 'car', at: [-7.84, -1.18] },
  { id: 'flatbed_small', kind: 'lightTruck', at: [-7.21, 17.65] },
  { id: 'hatch_green', kind: 'car', at: [-7.08, 4.88] },
  { id: 'sedan_orange', kind: 'car', at: [-5.55, -1.08] },
  { id: 'suv_boxy', kind: 'suv', at: [-4.45, 5.13] },
  { id: 'van_high', kind: 'van', at: [-3.7, 17.65] },
  { id: 'sedan_maroon', kind: 'car', at: [-3.86, -1.3] },
  { id: 'van_box', kind: 'van', at: [-3.7, 11.5] },
  { id: 'offroad_white', kind: 'suv', at: [-1.98, -1.08] },
  { id: 'sedan_blue', kind: 'car', at: [-1.7, 3.91] },
  { id: 'van_white', kind: 'van', at: [-0.19, 11.5] },
  { id: 'pickup_white', kind: 'pickup', at: [-0.19, 17.65] },
  { id: 'offroad_green', kind: 'suv', at: [0.06, -1.11] },
  { id: 'flatbed_van', kind: 'lightTruck', at: [2.23, -2.4] },
  { id: 'sedan_pink', kind: 'car', at: [0.55, 4.54] },
  { id: 'suv_black', kind: 'suv', at: [2.71, 11.5] },
  { id: 'sedan_red', kind: 'car', at: [2.77, 5.07] },
  { id: 'pickup_red', kind: 'pickup', at: [2.71, 17.65] },
  { id: 'minibus_yellow', kind: 'van', at: [4.82, -1.31] },
  { id: 'police_offroad', kind: 'police', at: [4.97, 4.31] },
  { id: 'hatch_blue', kind: 'car', at: [5.34, 11.5] },
  { id: 'hatch_white', kind: 'car', at: [5.34, 17.65] },
  { id: 'truck_military', kind: 'truck', at: [7.63, -1.92] },
  { id: 'sedan_red_small', kind: 'car', at: [7.98, 17.65] },
  { id: 'hatch_lightblue', kind: 'car', at: [7.98, 11.5] },
  { id: 'police_small', kind: 'police', at: [7.31, 4.42] },
  // Modelled 14.4 m long and 3.7 m high: scaled to a real 11.4 m city bus.
  { id: 'citybus', kind: 'bus', at: [11.02, -0.29], scale: 0.79 },
  { id: 'hatch_mint', kind: 'car', at: [10.59, 14.6] },
  { id: 'hatch_red', kind: 'car', at: [10.61, 10.29] },
  { id: 'hatch_red_2', kind: 'car', at: [10.61, 18.87] },
  { id: 'van_small_red', kind: 'van', at: [13.25, 11.5] },
  { id: 'pickup_brown', kind: 'pickup', at: [13.97, -1.88] },
  { id: 'sedan_white', kind: 'car', at: [14.14, 4.09] },
  { id: 'hatch_grey', kind: 'car', at: [13.25, 17.65] },
];

interface Box {
  min: number[];
  max: number[];
}

function meshNodes(n: Node, out: Node[] = []): Node[] {
  if (n.getMesh()) out.push(n);
  for (const c of n.listChildren()) meshNodes(c, out);
  return out;
}

/** Mesh nodes of the flattened source, grouped into vehicles. */
function clusters(nodes: Node[]): { nodes: Node[]; box: Box }[] {
  const boxes: Box[] = nodes.map((n) => getBounds(n));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // Overlap by more than 10 cm on the ground plane: neighbours parked close together stay apart.
  const overlap = (a: Box, b: Box, m: number) => a.min[0] + m <= b.max[0] && b.min[0] + m <= a.max[0] && a.min[2] + m <= b.max[2] && b.min[2] + m <= a.max[2];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (overlap(boxes[i], boxes[j], 0.1)) parent[find(i)] = find(j);
  const groups = new Map<number, number[]>();
  nodes.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const out = [...groups.values()].map((idx) => ({ idx, box: union(idx.map((i) => boxes[i])) }));
  // Loose small parts (mirrors) join the vehicle whose box (plus 30 cm) holds them.
  const big = out.filter((g) => Math.max(g.box.max[0] - g.box.min[0], g.box.max[2] - g.box.min[2]) >= 0.6);
  for (const g of out) {
    if (big.includes(g)) continue;
    const c = [(g.box.min[0] + g.box.max[0]) / 2, (g.box.min[2] + g.box.max[2]) / 2];
    const host = big.find((h) => c[0] > h.box.min[0] - 0.3 && c[0] < h.box.max[0] + 0.3 && c[1] > h.box.min[2] - 0.3 && c[1] < h.box.max[2] + 0.3);
    if (!host) throw new Error(`loose part at ${c.map((v) => v.toFixed(2))} belongs to no vehicle`);
    host.idx.push(...g.idx);
    host.box = union([host.box, g.box]);
  }
  return big.map((g) => ({ nodes: g.idx.map((i) => nodes[i]), box: g.box }));
}

function union(boxes: Box[]): Box {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], b.min[k]);
    max[k] = Math.max(max[k], b.max[k]);
  }
  return { min, max };
}

async function readFlat(io: NodeIO) {
  const doc = await io.read(SOURCE);
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  await doc.transform(flatten());
  const nodes = scene.listChildren().flatMap((n) => meshNodes(n));
  for (const n of nodes) clearNodeTransform(n);
  return { doc, scene, nodes };
}

/**
 * The vehicle's paint: the base colour (texture × factor) covering the largest area of its body above the
 * wheels (sides, roof, bonnet), near-black left out (tyres, glass, trim, the floor). Not the mean, which those
 * would muddy. A first guess for its low-poly stand-in in the distance: scripts/traffic-paint.mjs then
 * measures the colour as rendered (glass, liveries) and replaces it.
 */
async function mainColour(nodes: Node[]): Promise<number> {
  // Area per colour bin (16 levels a channel, sRGB), and the colours that fell into it.
  const bins = new Map<number, { area: number; sum: [number, number, number] }>();
  const toSrgb = (lin: number) => 255 * Math.pow(Math.min(1, Math.max(0, lin)), 1 / 2.2);
  const toLin = (srgb: number) => Math.pow(srgb / 255, 2.2);
  // Only the body above the wheels counts.
  let minY = Infinity;
  let maxY = -Infinity;
  const q = [0, 0, 0];
  for (const n of nodes) for (const p of n.getMesh()!.listPrimitives()) {
    const pos = p.getAttribute('POSITION')!;
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, q);
      minY = Math.min(minY, q[1]);
      maxY = Math.max(maxY, q[1]);
    }
  }
  const above = minY + (maxY - minY) * 0.35;
  const pixels = new Map<object, { data: Buffer; w: number; h: number; ch: number } | null>();
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const uv = [[0, 0], [0, 0], [0, 0]];
  for (const n of nodes) for (const p of n.getMesh()!.listPrimitives()) {
    const mat = p.getMaterial();
    const f = mat?.getBaseColorFactor() ?? [1, 1, 1, 1];
    const tex = mat?.getBaseColorTexture() ?? null;
    if (tex && !pixels.has(tex)) {
      const img = tex.getImage();
      if (!img) pixels.set(tex, null);
      else {
        const { data, info } = await sharp(Buffer.from(img)).raw().toBuffer({ resolveWithObject: true });
        pixels.set(tex, { data, w: info.width, h: info.height, ch: info.channels });
      }
    }
    const px = tex ? pixels.get(tex) ?? null : null;
    const pos = p.getAttribute('POSITION')!;
    const tc = p.getAttribute('TEXCOORD_0');
    const idx = p.getIndices();
    const count = idx ? idx.getCount() : pos.getCount();
    for (let i = 0; i < count; i += 3) {
      const v = [0, 1, 2].map((k) => (idx ? idx.getScalar(i + k) : i + k));
      pos.getElement(v[0], a);
      pos.getElement(v[1], b);
      pos.getElement(v[2], c);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const len = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
      if (len === 0 || (a[1] + b[1] + c[1]) / 3 < above) continue;
      let col = [255, 255, 255];
      if (px && tc) {
        for (let k = 0; k < 3; k++) tc.getElement(v[k], uv[k]);
        const u = (uv[0][0] + uv[1][0] + uv[2][0]) / 3;
        const t = (uv[0][1] + uv[1][1] + uv[2][1]) / 3;
        const x = Math.min(px.w - 1, Math.max(0, Math.floor((u - Math.floor(u)) * px.w)));
        const y = Math.min(px.h - 1, Math.max(0, Math.floor((t - Math.floor(t)) * px.h)));
        const o = (y * px.w + x) * px.ch;
        col = [px.data[o], px.data[o + 1], px.data[o + 2]];
      }
      // The texture is sRGB, the factor linear.
      const c3 = [0, 1, 2].map((k) => toSrgb(toLin(col[k]) * f[k])) as [number, number, number];
      if (Math.max(...c3) < 45) continue;
      const key = (Math.floor(c3[0] / 16) << 8) | (Math.floor(c3[1] / 16) << 4) | Math.floor(c3[2] / 16);
      const bin = bins.get(key) ?? { area: 0, sum: [0, 0, 0] };
      bin.area += len;
      for (let k = 0; k < 3; k++) bin.sum[k] += c3[k] * len;
      bins.set(key, bin);
    }
  }
  let best: { area: number; sum: [number, number, number] } | null = null;
  for (const b of bins.values()) if (!best || b.area > best.area) best = b;
  const rgb = best ? best.sum.map((v) => Math.round(Math.min(255, v / best!.area))) : [128, 128, 128];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

async function main(): Promise<void> {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  mkdirSync(OUT, { recursive: true });
  for (const f of readdirSync(OUT)) if (f.endsWith('.glb')) rmSync(joinPath(OUT, f));
  const all = (await readFlat(io)).nodes;
  // Each copy of the scene is cut down by node name.
  if (new Set(all.map((n) => n.getName())).size !== all.length) throw new Error('mesh node names are not unique');
  const groups = clusters(all);
  const pick = (at: [number, number]) => groups.findIndex((g) => at[0] > g.box.min[0] && at[0] < g.box.max[0] && at[1] > g.box.min[2] && at[1] < g.box.max[2]);
  const used = new Set<number>();
  const sizes: Record<string, { kind: Kind; length: number; width: number; height: number; paint: number }> = {};
  for (const veh of VEHICLES) {
    const k = pick(veh.at);
    if (k < 0 || used.has(k)) throw new Error(`${veh.id}: no vehicle (or one already taken) at ${veh.at}`);
    used.add(k);
    // A fresh copy per vehicle: everything else is dropped, then the shared resources are pruned.
    const { doc, scene, nodes } = await readFlat(io);
    const names = new Set(groups[k].nodes.map((n) => n.getName()));
    const keep = nodes.filter((n) => names.has(n.getName()));
    for (const n of nodes) if (!names.has(n.getName())) n.dispose();
    const sc = veh.scale ?? 1;
    const b0 = union(keep.map((n) => getBounds(n)));
    const c = [(b0.min[0] + b0.max[0]) / 2, b0.min[1], (b0.min[2] + b0.max[2]) / 2];
    const body = doc.createNode('Body');
    scene.addChild(body);
    for (const n of keep) {
      n.setScale([sc, sc, sc]).setTranslation([-c[0] * sc, -c[1] * sc, -c[2] * sc]);
      clearNodeTransform(n);
      body.addChild(n);
    }
    const b = union(keep.map((n) => getBounds(n)));
    for (const n of scene.listChildren()) if (n !== body) n.dispose();
    const paint = await mainColour(keep);
    await doc.transform(prune(), dedup(), weld(), join(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512] }));
    await io.write(joinPath(OUT, `${veh.id}.glb`), doc);
    const r = (v: number) => +v.toFixed(3);
    sizes[veh.id] = { kind: veh.kind, length: r(b.max[2] - b.min[2]), width: r(b.max[0] - b.min[0]), height: r(b.max[1] - b.min[1]), paint };
    console.log(veh.id.padEnd(16), veh.kind.padEnd(10), `${sizes[veh.id].length} × ${sizes[veh.id].width} × ${sizes[veh.id].height} m`, `#${paint.toString(16).padStart(6, '0')}`);
  }
  if (used.size !== groups.length) console.warn(`${groups.length - used.size} vehicle(s) in the pack left out`);
  writeFileSync(SIZES, `${JSON.stringify(sizes, null, 2)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
