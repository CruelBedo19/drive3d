/**
 * City V2 checks (headless).
 *
 * Layout (scripts/lib/cityV2/layout.ts): same seed → same city, different seeds →
 * different cities and characters; on every seed a connected network without
 * dead ends, junction spacing, straight limits (300-500 m arterial runs, streets
 * ≤ 350 m), no cramped blocks, the junction mix, 2-3 main arterials, 1.5-3 km of
 * alleys per km², protected large parcels with uses, all four districts with
 * their block sizes in order, the plaza and the landmark T; then 2 × 2 km.
 *
 * The prepared game files (public/assets/city_v2, npm run prepare:city) with
 * the real car physics: sizes, spawn on a boulevard, every teleport, a drop test
 * across town, driving through every junction type (straight and turning),
 * 15 cm kerbs hit square and at a shallow angle at several speeds, straight runs
 * at 100 and 200 km/h over cell seams, colliders only near the car. Buildings
 * (every ordinary block; special parcels, the plaza and the landmark block
 * empty): on their lots and off every road surface, no overlaps or identical
 * neighbours, little repetition down a street, floors by district, levels of
 * detail, solid. Street props (A4): the same seed places the same props, none
 * on a road surface, in a building or in a junction's sight lines, chunks
 * streamed and culled by distance and view, parking spots on parking ground,
 * signals tied to signalled junctions, prop colliders only near the car.
 * `--layout-only` skips the game-file part.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { setCityV2Assets } from '../src/world/cityv2/CityV2Assets';
import { parseCityV2Data, type CityV2Json } from '../src/world/cityv2/CityV2Data';
import type { CityV2Track } from '../src/world/cityv2/CityV2Track';
import { DISTRICTS } from './lib/cityV2/districts';
import { RAMP_IN, RASTER, buildGround, buildMarkings, type GroundRaster } from './lib/cityV2/ground';
import { packProps, placeProps } from './lib/cityV2/props';
import { CityV2Props } from '../src/world/cityv2/CityV2Props';
import { PROPS, PROP_INDEX, type PropCategory } from '../src/world/cityv2/propKit';
import { BUILDING_LAYERS, INSTANCE_STRIDE, type BuildingProto } from '../src/world/cityv2/buildingKit';
import { CityV2Buildings, createBuildingMaterials } from '../src/world/cityv2/CityV2Buildings';
import { generateLayout, layoutStats, polygonArea, type CityLayout, type LayoutStats } from './lib/cityV2/layout';
import { kerbOffset, laneOffsets, type RoadClass } from '../src/world/cityv2/roadProfiles';
import { DT, check, finish, makeSim, section, section as sectionOf, upY, type Sim } from './lib/sim';

const SEEDS = [2026, 42, 99, 7, 1];

const hash = (l: CityLayout) => createHash('sha1').update(JSON.stringify({ n: l.nodes, e: l.edges, b: l.blocks })).digest('hex').slice(0, 12);

type Rule = { name: string; test: (l: CityLayout, s: LayoutStats) => [boolean, string] };

/** Rules for any size; `km2` scales the per-area ones. */
function rules(km2: number, arterials: [number, number], wide: number): Rule[] {
  return [
    { name: 'connected, no dead ends', test: (_, s) => [s.connected && s.deadEnds === 0, `connected ${s.connected}, ${s.deadEnds} dead ends`] },
    { name: 'junctions / bends ≥ 24 m apart', test: (_, s) => [s.minEdge >= 24, `${s.minEdge} m`] },
    { name: `${arterials[0]}-${arterials[1]} main arterials`, test: (_, s) => [s.arterials >= arterials[0] && s.arterials <= arterials[1], `${s.arterials}`] },
    { name: 'arterial runs 300-520 m, ring ≤ 520 m', test: (_, s) => [s.maxArterialStraight >= 300 && s.maxArterialStraight <= 520 && s.maxRingStraight <= 520, `arterial ${s.maxArterialStraight}, ring ${s.maxRingStraight} m`] },
    { name: 'streets ≤ 350 m (≤ 405 in stepped corners)', test: (_, s) => [s.maxStraight <= 405, `${s.maxStraight} m`] },
    { name: 'blocks ≥ 15 m wide, none inverted / tiny', test: (l, s) => {
      const bad = l.blocks.filter((b) => Math.sign(polygonArea(b.lot)) !== Math.sign(polygonArea(b.centre)) || b.area < 400).length;
      return [s.minBlockSide >= 15 && bad === 0, `${s.minBlockSide} m, ${bad} bad`];
    } },
    { name: 'no huge unsplit block (≤ 45 000 m²)', test: (_, s) => [s.maxBlockArea <= 45000, `${s.maxBlockArea} m²`] },
    { name: 'junction mix (crossroads, T, bends)', test: (_, s) => [s.nodes.cross >= 15 * km2 && s.nodes.tee >= 100 * km2 && s.nodes.bend >= 20 * km2, `${s.nodes.cross}+ ${s.nodes.tee}T ${s.nodes.bend}L`] },
    { name: `hierarchy: ${wide} × 3+3 axis, 2+2 boulevards and avenues, streets, alleys`, test: (l, s) => {
      // A 3+3 axis crosses the town: between 0.6 and 1.3 town widths of road each.
      const size = l.params.size;
      const ok = s.length.arterial3 >= 0.6 * size * wide && s.length.arterial3 <= 1.3 * size * wide && s.length.boulevard > 0 && s.length.avenue > 0 && s.length.street > 0 && s.length.alley > 0;
      return [ok, Object.entries(s.length).map(([c, m]) => `${c} ${(m / 1000).toFixed(2)} km`).join(', ')];
    } },
    { name: 'alleys 1.5-3 km per km²', test: (_, s) => [s.length.alley >= 1500 * km2 && s.length.alley <= 3000 * km2, `${(s.length.alley / 1000).toFixed(2)} km`] },
    { name: 'large parcels: ≥ 2 per km², park and car park', test: (_, s) => [s.blocks.large >= 2 * km2 && (s.uses.park ?? 0) >= 1 && (s.uses.parking ?? 0) >= 1, `${s.blocks.large}: ${JSON.stringify(s.uses)}`] },
    { name: 'all four districts (≥ 3 blocks each)', test: (_, s) => [DISTRICTS.every((d) => s.districts[d].blocks >= 3), DISTRICTS.map((d) => `${d} ${s.districts[d].blocks}`).join(', ')] },
    { name: 'block size: downtown < commercial < industrial', test: (_, s) => {
      const m = (d: (typeof DISTRICTS)[number]) => s.districts[d].meanArea;
      return [m('downtown') < m('commercial') && m('commercial') < m('industrial') && m('residential') < m('industrial'), DISTRICTS.map((d) => `${d} ${m(d)}`).join(', ')];
    } },
    { name: 'lane markings on every road that needs them', test: (l) => {
      // Streets and boulevards with more than 12 m between their junction boxes carry lines; alleys none.
      const m = buildMarkings(l, buildGround(l).cells);
      const box = (n: number, id: number) => Math.max(0, ...l.nodes[n].out.filter((o) => o >= 0 && o !== id).map((o) => kerbOffset(l.edges[o].cls)));
      const missing = l.edges.filter((e) => e.cls !== 'alley' && e.length - box(e.a, e.id) - box(e.b, e.id) > 12 && m.byEdge[e.id] === 0);
      const onAlleys = l.edges.filter((e) => e.cls === 'alley' && m.byEdge[e.id] > 0).length;
      return [missing.length === 0 && onAlleys === 0, `${missing.length} roads without lines${missing.length ? ` (e.g. #${missing[0].id})` : ''}, ${onAlleys} alleys with lines, ${m.quads} quads`];
    } },
    { name: 'downtown plaza, one landmark at a boulevard T', test: (l, s) => [s.blocks.plaza === 1 && l.blocks.find((b) => b.kind === 'plaza')?.district === 'downtown' && l.vistas.length === 1 && s.landmarks === 1 && l.nodes[l.vistas[0]].kind === 'tee', `plaza ${s.blocks.plaza}, vistas ${l.vistas.length}, landmarks ${s.landmarks}`] },
  ];
}

function runRules(title: string, layouts: { seed: number; l: CityLayout }[], rs: Rule[]): void {
  section(title);
  const stats = layouts.map(({ seed, l }) => ({ seed, l, s: layoutStats(l) }));
  for (const r of rs) {
    const fails: string[] = [];
    const details: string[] = [];
    for (const { seed, l, s } of stats) {
      const [ok, detail] = r.test(l, s);
      if (!ok) fails.push(`${seed}: ${detail}`);
      details.push(detail);
    }
    check(r.name, fails.length === 0, fails.length ? fails.join('; ') : layouts.length === 1 ? details[0] : `${layouts.length} seeds`);
  }
  for (const { seed, l, s } of stats) {
    console.log(`      ${seed}: ${l.blocks.length} blocks · ${s.arterials} arterials, longest ${s.maxArterialStraight} m · ${s.nodes.cross}+/${s.nodes.tee}T/${s.nodes.bend}L · alley ${(s.length.alley / 1000).toFixed(2)} km · large ${s.blocks.large} ${JSON.stringify(s.uses)}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes('--props-only')) {
    await streetProps(GAME_DIR);
    finish();
  }
  section('Layout: determinism and variety');
  {
    const a = generateLayout({ seed: 2026 });
    const b = generateLayout({ seed: 2026 });
    check('same seed → identical layout', hash(a) === hash(b), `${hash(a)} / ${hash(b)}`);
    const all = SEEDS.map((s) => generateLayout({ seed: s }));
    const hashes = all.map(hash);
    check('different seeds → different layouts', new Set(hashes).size === SEEDS.length, hashes.join(' '));
    // Character, not only streets: where industry and downtown sit, and how much of the town each district takes.
    const where = all.map((l) => {
      const c = (k: string) => l.districts.find((d) => d.kind === k)!;
      const ind = c('industrial');
      const side = Math.abs(ind.x) > Math.abs(ind.z) ? (ind.x > 0 ? 'E' : 'W') : ind.z > 0 ? 'S' : 'N';
      const share = DISTRICTS.map((d) => Math.round((100 * l.blocks.filter((b) => b.district === d).length) / l.blocks.length));
      return { side, share, down: c('downtown') };
    });
    const sides = new Set(where.map((w) => w.side));
    const shares = new Set(where.map((w) => w.share.join('/')));
    check('seeds vary the district layout (industry side, shares)', sides.size >= 2 && shares.size === SEEDS.length, `industry ${where.map((w) => w.side).join(' ')} · downtown/commercial/residential/industrial % ${where.map((w) => w.share.join('/')).join(' · ')}`);
  }

  runRules('Layout: 1 × 1 km', SEEDS.map((seed) => ({ seed, l: generateLayout({ seed }) })), rules(1, [2, 3], 1));

  {
    const t0 = performance.now();
    const l = generateLayout({ seed: 2026, size: 2000 });
    const ms = performance.now() - t0;
    runRules('Layout: 2 × 2 km', [{ seed: 2026, l }], rules(4, [4, 6], 2));
    check('2 × 2 km generated in < 20 s', ms < 20000, `${ms.toFixed(0)} ms, ${l.blocks.length} blocks, ${l.nodes.length} nodes`);
  }
  if (!process.argv.includes('--layout-only')) {
    await drive(GAME_DIR, '2 × 2 km');
    await streetProps(GAME_DIR);
    await drive(fixture1km(), '1 × 1 km fixture');
  }
  finish();
}

// --- prepared game files, real physics ----------------------------------------------------------------

/** The game's prepared city (2 × 2 km, npm run prepare:city). */
const GAME_DIR = join(import.meta.dirname, '../public/assets/city_v2');

/**
 * The 1 × 1 km regression fixture (same seed): built into the temp folder by
 * the prepare script (~3 s), or taken from CITY_V2_FIXTURE.
 */
function fixture1km(): string {
  if (process.env.CITY_V2_FIXTURE) return process.env.CITY_V2_FIXTURE;
  const dir = join(tmpdir(), 'drive3d-city-v2-1km');
  const r = spawnSync('npx', ['tsx', join(import.meta.dirname, 'prepare-city-v2.ts'), '--size', '1000', '--no-info', '--out', dir], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(join(dir, 'city-data.json'))) throw new Error(`1 km fixture failed: ${r.stderr}`);
  return dir;
}

function loadData(dir: string) {
  const json = JSON.parse(readFileSync(join(dir, 'city-data.json'), 'utf8')) as CityV2Json;
  const buf = readFileSync(join(dir, 'city-data.bin'));
  const data = parseCityV2Data(json, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  setCityV2Assets({ data, ground: new Map(), buildings: null, bytes: 0, loadMs: 0 });
  return data;
}

const grounded = (s: Sim) => s.vehicle.physics.wheels.filter((w) => w.grounded).length;
const kmh = (s: Sim) => s.vehicle.physics.linearVelocity.length() * 3.6;

/** Puts the car at (x, z) facing yaw, already rolling at `speed` km/h, with its cells streamed in. */
function launch(s: Sim, track: CityV2Track, x: number, z: number, yaw: number, speed: number): void {
  track.stream(new THREE.Vector3(x, 0, z), true);
  s.vehicle.reset(new THREE.Vector3(x, VehiclePhysics.restHeight(s.config) + 0.02, z), yaw);
  const v = speed / 3.6;
  s.vehicle.physics.body.setLinvel({ x: Math.sin(yaw) * v, y: 0, z: Math.cos(yaw) * v }, true);
  for (const w of s.vehicle.physics.wheels) w.angularVelocity = v / s.config.wheel.radius;
}

interface RunLog {
  minUp: number;
  /** Fastest the chassis moved upwards, m/s (a kick from the ground). */
  maxVy: number;
  /** Longest time with no wheel on the ground, s. */
  airborne: number;
  /** Fewest wheels on the ground at any step. */
  minGrounded: number;
  /** Largest vertical acceleration of the chassis, m/s². */
  maxAy: number;
  /** Waypoints passed (within 4 m). */
  reached: number;
  fell: boolean;
  bad: boolean;
}

/** Steps the car: pure-pursuit steering through `waypoints` (or a fixed steer), cruise control at `speed` km/h. */
function cruise(s: Sim, track: CityV2Track, seconds: number, speed: number, waypoints: [number, number][] = [], fixedSteer?: number): RunLog {
  const log: RunLog = { minUp: 1, maxVy: 0, airborne: 0, minGrounded: 4, maxAy: 0, reached: 0, fell: false, bad: false };
  let air = 0;
  let tail = 0;
  let lastVy = s.vehicle.physics.linearVelocity.y;
  const steps = Math.round(seconds / DT);
  // The first 0.25 s settle the car from launch (it starts 2 cm above its rest height): not judged.
  const settle = Math.round(0.25 / DT);
  for (let i = 0; i < steps; i++) {
    // With a route: stop right after its last waypoint (judged there).
    if (waypoints.length && log.reached === waypoints.length && (tail += DT) > 0.1) break;
    const p = s.vehicle.physics.position;
    const f = s.vehicle.physics.forward;
    while (log.reached < waypoints.length && Math.hypot(waypoints[log.reached][0] - p.x, waypoints[log.reached][1] - p.z) < 4) log.reached++;
    let steer = fixedSteer ?? 0;
    if (fixedSteer === undefined && log.reached < waypoints.length) {
      const tx = waypoints[log.reached][0] - p.x;
      const tz = waypoints[log.reached][1] - p.z;
      // Right of forward (fx, fz) is (−fz, fx); steer +1 = right.
      const lat = tx * -f.z + tz * f.x;
      const lon = tx * f.x + tz * f.z;
      steer = Math.max(-1, Math.min(1, Math.atan2(lat, lon) * 2.2));
    }
    const v = kmh(s);
    const throttle = v < speed - 2 ? 0.6 : v < speed ? 0.25 : 0;
    const brake = v > speed + 8 ? 0.4 : 0;
    s.vehicle.fixedUpdate(DT, { throttle, brake, steer, handbrake: 0 });
    s.physics.step();
    s.vehicle.postPhysics();
    if (i % 12 === 0) track.stream(s.vehicle.physics.position);
    const vy = s.vehicle.physics.linearVelocity.y;
    const dvy = Math.abs(vy - lastVy) / DT;
    lastVy = vy;
    if (i < settle) continue;
    log.maxAy = Math.max(log.maxAy, dvy);
    log.maxVy = Math.max(log.maxVy, vy);
    log.minUp = Math.min(log.minUp, upY(s));
    const g = grounded(s);
    log.minGrounded = Math.min(log.minGrounded, g);
    air = g === 0 ? air + DT : 0;
    log.airborne = Math.max(log.airborne, air);
    if (s.vehicle.physics.position.y < track.killHeight) log.fell = true;
    if (!Number.isFinite(s.vehicle.physics.position.y)) log.bad = true;
  }
  return log;
}

const fmt = (l: RunLog) => `up ≥ ${l.minUp.toFixed(3)}, vy ≤ ${l.maxVy.toFixed(2)} m/s, |ay| ≤ ${l.maxAy.toFixed(0)} m/s², wheels ≥ ${l.minGrounded}, air ${l.airborne.toFixed(2)} s`;

async function drive(dir: string, label: string): Promise<void> {
  const section = (t: string) => sectionOf(`${label} · ${t}`);
  section('Prepared files');
  const data = loadData(dir);
  const j = data.json;
  const size = (f: string) => statSync(join(dir, f)).size / 1e6;
  const total = size('city.glb') + size('city-data.bin') + size('city-data.json') + size('city-map.png');
  check('prepared city ≤ 15 MB', total <= 15, `glb ${size('city.glb').toFixed(2)} + data ${size('city-data.bin').toFixed(2)} + json ${size('city-data.json').toFixed(2)} + map ${size('city-map.png').toFixed(2)} = ${total.toFixed(2)} MB`);
  const tris = j.cells.reduce((a, c) => a + c.tris, 0);
  check('250 m cells with ground and colliders, lane points', j.cell === 250 && j.cells.length >= 9 && j.roads[1] > 1000, `${j.cells.length} cells, ${tris} ground triangles, ${j.cells.reduce((a, c) => a + c.trimesh[3], 0)} collider triangles, ${j.roads[1]} lane points, ${j.teleports.length} teleports`);
  {
    // The glb's own description (JSON chunk): markings drawn from geometry and vertex colours, never alpha-tested.
    const glb = readFileSync(join(dir, 'city.glb'));
    const gltf = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
      materials: { name: string; alphaMode?: string; pbrMetallicRoughness?: { baseColorTexture?: unknown; metallicFactor?: number } }[];
      meshes: { name: string; primitives: { attributes: Record<string, number>; material: number }[] }[];
    };
    const mark = gltf.materials.findIndex((m) => m.name === 'cv2_marking');
    const markMeshes = gltf.meshes.filter((m) => /_marking$/.test(m.name));
    const noColour = markMeshes.filter((m) => m.primitives.some((p) => p.attributes.COLOR_0 === undefined || p.material !== mark)).length;
    const mat = gltf.materials[mark];
    const metal = gltf.materials.filter((m) => (m.pbrMetallicRoughness?.metallicFactor ?? 1) !== 0).map((m) => m.name);
    check('markings opaque with vertex colours, no metal ground', mark >= 0 && (mat.alphaMode ?? 'OPAQUE') === 'OPAQUE' && !mat.pbrMetallicRoughness?.baseColorTexture && noColour === 0 && markMeshes.length > 0 && metal.length === 0, `${markMeshes.length} marking meshes, ${noColour} without colours, alpha ${mat?.alphaMode ?? 'OPAQUE'}, metallic: ${metal.join(', ') || 'none'}`);
  }
  const kinds = ['cross-bb', 'cross-bs', 'cross-aa', 'cross-ss', 'tee-bs', 'tee-ss', 'tee-alley', 'bend-b', 'bend-ring', 'bend-s', 'vista'];
  check('a teleport for every junction type', kinds.every((k) => j.teleports.some((t) => t.id === k)), `missing: ${kinds.filter((k) => !j.teleports.some((t) => t.id === k)).join(', ') || 'none'}`);

  const s = await makeSim(false, 0, 0, 0, { track: 'city' });
  const track = s.track as CityV2Track;

  section('Spawn, teleports, drop test');
  {
    const sp = track.spawn.position;
    const lane = track.nearestRoad(sp);
    check('spawn on a divided main road (≥ 17 m of asphalt), facing along it', lane[4] >= kerbOffset('boulevard') && Math.hypot(lane[0] - sp.x, lane[2] - sp.z) < 1 && Math.cos(lane[3] - track.spawn.yaw) > 0.99, `half-width ${lane[4]} m, ${Math.hypot(lane[0] - sp.x, lane[2] - sp.z).toFixed(2)} m from the lane`);
    const results: string[] = [];
    let bad = 0;
    for (const t of track.testPoints) {
      launch(s, track, t.position.x, t.position.z, t.yaw, 0);
      const log = cruise(s, track, 2, 0);
      const dy = s.vehicle.physics.position.y - VehiclePhysics.restHeight(s.config);
      const onRoad = track.onRoad(s.vehicle.physics.position);
      const ok = grounded(s) === 4 && Math.abs(dy) < 0.15 && log.minUp > 0.99 && onRoad;
      if (!ok) bad++;
      results.push(`${t.id}:${grounded(s)}w dy${dy.toFixed(2)}${ok ? '' : ` ✗ (up ${log.minUp.toFixed(3)}, road ${onRoad})`}`);
    }
    check('spawn and every teleport: on the road, 4 wheels down, level', bad === 0, results.join(' '));
    const f = data.f32;
    const [ro, rn] = j.roads;
    let tested = 0;
    let fails = 0;
    const failAt: string[] = [];
    for (let i = 0; i < rn; i += Math.max(1, Math.floor(rn / 150))) {
      const o = ro + i * 5;
      launch(s, track, f[o], f[o + 2], f[o + 3], 0);
      cruise(s, track, 1, 0);
      tested++;
      const dy = s.vehicle.physics.position.y - VehiclePhysics.restHeight(s.config);
      if (grounded(s) < 4 || Math.abs(dy) > 0.15) {
        fails++;
        if (failAt.length < 6) failAt.push(`(${f[o].toFixed(0)},${f[o + 2].toFixed(0)}) w${grounded(s)} dy${dy.toFixed(2)}`);
      }
    }
    check('drop test on lane points across town: 4 wheels, at road height', fails === 0, `${tested - fails}/${tested}${failAt.length ? `; e.g. ${failAt.join(' ')}` : ''}`);
  }

  section('Buildings (every ordinary block)');
  {
    const b = j.buildings;
    const f = data.f32;
    const l = generateLayout({ seed: j.layout.seed, size: j.layout.size });
    type Inst = { proto: BuildingProto; x: number; z: number; yaw: number; sx: number; sz: number; variant: number; rect: [number, number, number, number]; block?: number };
    const inst: Inst[] = [];
    let boxes = 0;
    for (const c of j.cells) {
      boxes += c.boxes[1];
      for (let i = 0; i < c.inst[1]; i++) {
        const o = c.inst[0] + i * INSTANCE_STRIDE;
        const proto = b.protos[f[o]];
        const [x, z, yaw, sx, sz, variant] = [f[o + 1], f[o + 2], f[o + 3], f[o + 4], f[o + 5], f[o + 6]];
        // Corners: front centre ± half the frontage along local +X (cos, −sin), back along −(sin, cos).
        const xs: number[] = [];
        const zs: number[] = [];
        for (const [u, v] of [[-0.5, 0], [0.5, 0], [-0.5, 1], [0.5, 1]]) {
          xs.push(x + Math.cos(yaw) * proto.w * sx * u - Math.sin(yaw) * proto.d * sz * v);
          zs.push(z - Math.sin(yaw) * proto.w * sx * u - Math.cos(yaw) * proto.d * sz * v);
        }
        inst.push({ proto, x, z, yaw, sx, sz, variant, rect: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] });
      }
    }
    const byArea = b.areas.map((a) => `${a.id} ${a.buildings}`).join(', ');
    check('sample areas (benchmark views): buildings in each of the four districts, one box collider per building', b.areas.length === 4 && b.areas.every((a) => a.buildings > 0) && boxes === inst.length && inst.length > 0, `${inst.length} buildings (${byArea}), ${boxes} boxes, ${b.protos.length} prototypes`);
    const inPoly = (poly: [number, number][], x: number, z: number) => {
      let inside = false;
      for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
        const [xi, zi] = poly[i];
        const [xk, zk] = poly[k];
        if (zi > z !== zk > z && x < ((xk - xi) * (z - zi)) / (zk - zi) + xi) inside = !inside;
      }
      return inside;
    };
    // Off the road: walls plus the 0.6 m cornice overhang inside a building block's lot (behind the sidewalk),
    // clear of every asphalt edge (and of the alleys' kerb ramp), not on special parcels or the plaza.
    const bad: string[] = [];
    for (const q of inst) {
      const [x0, z0, x1, z1] = [q.rect[0] - 0.6, q.rect[1] - 0.6, q.rect[2] + 0.6, q.rect[3] + 0.6];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const block = l.blocks.find((k) => inPoly(k.lot, cx, cz));
      const corners = [[x0 + 1e-3, z0 + 1e-3], [x1 - 1e-3, z0 + 1e-3], [x1 - 1e-3, z1 - 1e-3], [x0 + 1e-3, z1 - 1e-3]];
      const inside = !!block && corners.every(([x, z]) => inPoly(block.lot, x, z)) && !block.lot.some(([x, z]) => x > x0 + 1e-3 && x < x1 - 1e-3 && z > z0 + 1e-3 && z < z1 - 1e-3);
      let road = '';
      for (const r of j.roadGraph) {
        // Distance between the rectangle and the road's centre line (axis-aligned both).
        const dx = Math.max(Math.min(r.a[0], r.b[0]) - x1, 0, x0 - Math.max(r.a[0], r.b[0]));
        const dz = Math.max(Math.min(r.a[1], r.b[1]) - z1, 0, z0 - Math.max(r.a[1], r.b[1]));
        const need = kerbOffset(r.cls) + (r.cls === 'alley' ? RAMP_IN : 0);
        if (Math.hypot(dx, dz) < need - 1e-3) road = `${r.cls} ${Math.hypot(dx, dz).toFixed(2)} < ${need}`;
      }
      if (!inside || road || block?.kind !== 'buildings' || block.landmark) bad.push(`${q.proto.name}@(${q.x.toFixed(0)},${q.z.toFixed(0)}) ${!inside ? 'outside its lot' : ''} ${road} ${block && block.kind !== 'buildings' ? block.use ?? block.kind : ''}${block?.landmark ? 'landmark' : ''}`);
      if (block) q.block = block.id;
    }
    check('buildings stay on their lots: off roads, sidewalks, medians, junctions, special parcels, the plaza and the landmark block', bad.length === 0, bad.length ? bad.slice(0, 5).join('; ') : `${inst.length} checked against ${j.roadGraph.length} roads`);
    const ordinary = l.blocks.filter((k) => k.kind === 'buildings' && !k.landmark);
    const built = new Set(inst.map((q) => q.block));
    const empty = ordinary.filter((k) => !built.has(k.id));
    const special = l.blocks.filter((k) => k.kind !== 'buildings' || k.landmark).map((k) => k.use ?? (k.landmark ? 'landmark' : k.kind));
    check('every ordinary block built on (a few small ones may stay empty); special parcels empty', empty.length <= ordinary.length * 0.03, `${ordinary.length - empty.length}/${ordinary.length} ordinary blocks built; empty: ${[...new Set(special)].map((u) => `${u} ${special.filter((x) => x === u).length}`).join(', ')}`);
    let overlap = 0;
    let sameNext = 0;
    let sameOther = 0;
    for (let i = 0; i < inst.length; i++) {
      for (let k = i + 1; k < inst.length; k++) {
        const [a, c] = [inst[i].rect, inst[k].rect];
        const gx = Math.max(a[0] - c[2], c[0] - a[2]);
        const gz = Math.max(a[1] - c[3], c[1] - a[3]);
        if (gx < -1e-3 && gz < -1e-3) overlap++;
        // Touching (or nearly): never the same prototype in the same colour variant side by side.
        else if (Math.max(gx, gz) < 1 && inst[i].proto.id === inst[k].proto.id) {
          if (inst[i].variant === inst[k].variant) sameNext++;
          else sameOther++;
        }
      }
    }
    check('no two buildings overlap, no identical neighbours (same prototype only in another colour variant)', overlap === 0 && sameNext === 0, `${overlap} overlaps, ${sameNext} identical neighbours, ${sameOther} same prototype in another variant`);
    const perDistrict = (d: string) => b.protos.filter((p) => p.district === d).length;
    check('prototype catalogue: at most 90, reused (≥ 10 buildings each on average)', b.protos.length <= 90 && inst.length >= 10 * b.protos.length, `${b.protos.length} prototypes (${b.areas.map((a) => `${a.district} ${perDistrict(a.district)}`).join(', ')}) for ${inst.length} buildings`);
    // Down a street (same block, same facing, in order): the next building is rarely the same prototype, rarely the same outline.
    const rows = new Map<string, Inst[]>();
    for (const q of inst) {
      const k = `${q.block}|${Math.round((q.yaw * 2) / Math.PI)}`;
      rows.set(k, [...(rows.get(k) ?? []), q]);
    }
    let pairs = 0;
    let sameProto = 0;
    let sameOutline = 0;
    let longest = 1;
    for (const row of rows.values()) {
      const along = (q: Inst) => q.x * Math.cos(q.yaw) - q.z * Math.sin(q.yaw);
      row.sort((p, q) => along(p) - along(q));
      let run = 1;
      for (let i = 1; i < row.length; i++) {
        const [p, q] = [row[i - 1], row[i]];
        pairs++;
        if (p.proto.id === q.proto.id) sameProto++;
        if (p.proto.h === q.proto.h && Math.abs(p.proto.w * p.sx - q.proto.w * q.sx) < 2.5) sameOutline++;
        run = p.proto.h === q.proto.h ? run + 1 : 1;
        longest = Math.max(longest, run);
      }
    }
    check('down a street: next building the same prototype < 5 %, same outline (frontage and height) < 12 %, ≤ 5 equal heights in a row', sameProto < 0.05 * pairs && sameOutline < 0.12 * pairs && longest <= 5, `${pairs} neighbours: same prototype ${((sameProto / pairs) * 100).toFixed(1)} %, same outline ${((sameOutline / pairs) * 100).toFixed(1)} %, longest equal-height run ${longest}`);
    const FLOORS: Record<string, [number, number]> = { downtown: [5, 10], commercial: [3, 7], residential: [2, 4], industrial: [1, 3] };
    const floorsBad = b.protos.filter((p) => p.floors < FLOORS[p.district][0] || p.floors > FLOORS[p.district][1]);
    const heights = (d: string) => [...new Set(inst.filter((q) => q.proto.district === d).map((q) => q.proto.floors))].sort((x, y) => x - y);
    check('floors by district (downtown 5-10, commercial 3-7, residential 2-4, industrial 1-3), several heights each', floorsBad.length === 0 && b.areas.every((a) => heights(a.district).length >= 2), b.areas.map((a) => `${a.district} ${heights(a.district).join('/')}`).join(' · '));
    const stretch = Math.max(...inst.map((q) => Math.max(q.sx, q.sz)));
    const shrink = Math.min(...inst.map((q) => Math.min(q.sx, q.sz)));
    check('prototypes fitted to their lots: stretched ≤ 20 %, narrowed ≤ 15 %', stretch <= 1.2 + 1e-4 && shrink >= 0.85 - 1e-4, `${((stretch - 1) * 100).toFixed(1)} % / ${((shrink - 1) * 100).toFixed(1)} %`);
    // Over all prototypes (a one-floor hall is nearly all street level).
    const sum = (k: number) => b.protos.reduce((t, p) => t + p.tris[k], 0);
    check('levels of detail: street level ≤ 30 %, cards ≤ 6 % of the near triangles', sum(1) <= 0.3 * sum(0) && sum(2) <= 0.06 * sum(0), `near ${Math.min(...b.protos.map((p) => p.tris[0]))}-${Math.max(...b.protos.map((p) => p.tris[0]))} triangles per prototype; street ${((sum(1) / sum(0)) * 100).toFixed(1)} %, cards ${((sum(2) / sum(0)) * 100).toFixed(1)} %`);
    // Relief and cards stand in for the kit's modules: never more triangles than the module as modelled.
    const heavier = b.modules.filter((m) => m.lods.some((l) => l[3] > m.lods[0][3] && !/^Roof_|Cornice|Column/.test(m.name)));
    check('module levels: relief and card never heavier than the modelled piece (facade panels)', b.modules.every((m) => m.lods.length === 4) && heavier.length === 0, heavier.length ? heavier.map((m) => `${m.name} ${m.lods.map((l) => l[3]).join('/')}`).join(', ') : `${b.modules.length} modules × 4 levels`);

    // Buildings are solid: drive at one from the street.
    const target = inst.filter((q) => q.proto.district === 'downtown' || q.proto.district === 'commercial').sort((p, q) => Math.hypot(p.x, p.z) - Math.hypot(q.x, q.z))[0];
    if (target) {
      const lane = track.nearestRoad(new THREE.Vector3(target.x + Math.sin(target.yaw) * 12, 0, target.z + Math.cos(target.yaw) * 12));
      // From the lane, straight at the facade (opposite to its facing).
      const yaw = target.yaw + Math.PI;
      const sx = lane[0];
      const sz = lane[2];
      launch(s, track, sx, sz, yaw, 30);
      cruise(s, track, 4, 30, [], 0);
      const p = s.vehicle.physics.position;
      const [x0, z0, x1, z1] = target.rect;
      const inside = p.x > x0 && p.x < x1 && p.z > z0 && p.z < z1;
      const front = (p.x - target.x) * Math.sin(target.yaw) + (p.z - target.z) * Math.cos(target.yaw);
      check('a building stops the car (box collider)', !inside && front > -0.5 && kmh(s) < 15, `${target.proto.name}: car ${front.toFixed(1)} m in front of the facade, ${kmh(s).toFixed(0)} km/h after 4 s at 30 km/h`);
    }
  }

  section('Junctions: through every type, straight and turning');
  {
    const nodes = new Map<string, { x: number; z: number; dirs: [number, number, number, RoadClass][] }>();
    for (const r of j.roadGraph) {
      for (const [p, q] of [[r.a, r.b], [r.b, r.a]] as const) {
        const k = `${p[0]},${p[1]}`;
        let n = nodes.get(k);
        if (!n) nodes.set(k, (n = { x: p[0], z: p[1], dirs: [] }));
        const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
        n.dirs.push([(q[0] - p[0]) / L, (q[1] - p[1]) / L, L, r.cls]);
      }
    }
    const lines: string[] = [];
    let bad = 0;
    for (const t of track.testPoints.filter((q) => q.id !== 'start')) {
      const fx = Math.sin(t.yaw);
      const fz = Math.cos(t.yaw);
      // The junction straight ahead of the teleport (placed before one, in the right lane).
      let node: { x: number; z: number; dirs: [number, number, number, RoadClass][] } | null = null;
      let bestD = Infinity;
      for (const n of nodes.values()) {
        const ax = n.x - t.position.x;
        const az = n.z - t.position.z;
        const along = ax * fx + az * fz;
        const across = Math.abs(ax * -fz + az * fx);
        if (along > 5 && along < 80 && across < 6 && along < bestD) {
          bestD = along;
          node = n;
        }
      }
      if (!node) {
        lines.push(`${t.id}: no junction ahead ✗`);
        bad++;
        continue;
      }
      // The road the teleport arrives on (behind it, from the junction): its innermost right lane.
      const inCls = node.dirs.find(([dx, dz]) => dx * fx + dz * fz < -0.9)?.[3] ?? 'street';
      const laneIn = laneOffsets(inCls)[0];
      for (const [dx, dz, exitLen, exitCls] of node.dirs.filter(([dx, dz]) => dx * fx + dz * fz > -0.5)) {
        const straight = dx * fx + dz * fz > 0.5;
        // Innermost right lanes in and out: right of (dx, dz) is (−dz, dx). Points outside the junction box.
        const lane = laneOffsets(exitCls)[0];
        const box = Math.max(...node.dirs.map((q) => kerbOffset(q[3]))) + 2;
        // The entry point only if it is still ahead (a teleport close to its junction starts inside the box):
        // turning back for it ran the car into the buildings beside the road.
        const entry: [number, number] = [node.x - fx * box - fz * laneIn, node.z - fz * box + fx * laneIn];
        const wps: [number, number][] = [
          ...((entry[0] - t.position.x) * fx + (entry[1] - t.position.z) * fz > 0 ? [entry] : []),
          [node.x + dx * box - dz * lane, node.z + dz * box + dx * lane],
          // The last point stays on the exit road (it may be shorter than 32 m).
          [node.x + dx * Math.min(32, exitLen - 4) - dz * lane, node.z + dz * Math.min(32, exitLen - 4) + dx * lane],
        ];
        const v = straight ? 40 : 25;
        launch(s, track, t.position.x, t.position.z, t.yaw, v);
        const log = cruise(s, track, 16, v, wps);
        const ok = log.reached === wps.length && log.minUp > 0.95 && log.minGrounded >= 3 && !log.fell && track.onRoad(s.vehicle.physics.position);
        if (!ok) bad++;
        const end = s.vehicle.physics.position;
        lines.push(`${t.id}/${straight ? 'straight' : 'turn'} ${v} km/h: ${log.reached}/${wps.length} waypoints, up ≥ ${log.minUp.toFixed(3)}, wheels ≥ ${log.minGrounded}${ok ? '' : ` ✗ (junction (${node.x}, ${node.z}), exit (${dx.toFixed(0)}, ${dz.toFixed(0)}), end (${end.x.toFixed(1)}, ${end.z.toFixed(1)}) on road ${track.onRoad(end)})`}`);
      }
    }
    check('every junction type driven through (every exit)', bad === 0, `${lines.length} runs`);
    for (const line of lines) console.log(`      ${line}`);
  }

  section('Kerbs (15 cm): hit square and at a shallow angle');
  {
    // A straight street lane near the centre with 60 m of the same lane ahead.
    const f = data.f32;
    const [ro, rn] = j.roads;
    let pick = -1;
    for (let i = 0; i < rn && pick < 0; i++) {
      const o = ro + i * 5;
      if (f[o + 4] !== kerbOffset('street')) continue;
      const p = new THREE.Vector3(f[o] + Math.sin(f[o + 3]) * 60, 0, f[o + 2] + Math.cos(f[o + 3]) * 60);
      const q = track.nearestRoad(p);
      if (Math.hypot(q[0] - p.x, q[2] - p.z) < 1 && Math.cos(q[3] - f[o + 3]) > 0.999 && Math.hypot(f[o], f[o + 2]) < 400) pick = i;
    }
    const o = ro + pick * 5;
    const [x, z, h] = [f[o], f[o + 2], f[o + 3]];
    // Right of heading h: forward (sin h, cos h), right (−cos h, sin h) = heading h − π/2.
    const right = h - Math.PI / 2;
    const lines: string[] = [];
    let bad = 0;
    for (const v of [15, 30, 50]) {
      // Square on: from the far lane (6 m back), straight across the near lane into the kerb 1.5 m to the right.
      launch(s, track, x - Math.sin(right) * 4.5, z - Math.cos(right) * 4.5, right, v);
      const log = cruise(s, track, 2.5, v, [], 0);
      const ok = log.minUp > 0.9 && log.minGrounded >= 3 && log.maxAy < 40 && log.maxVy < 1.6 && !log.bad && !log.fell;
      if (!ok) bad++;
      lines.push(`square ${v} km/h: ${fmt(log)}${ok ? '' : ' ✗'}`);
    }
    for (const v of [40, 70]) {
      // Shallow: 8° to the right from the centre line, 6 m across (kerb at 3.5 m): all wheels over the kerb, not into the
      // buildings behind it.
      launch(s, track, x, z, h - (8 * Math.PI) / 180, v);
      const y0 = s.vehicle.physics.position.y;
      const log = cruise(s, track, 6 / ((v / 3.6) * Math.sin((8 * Math.PI) / 180)), v, [], 0);
      // Up on the sidewalk at the end (15 cm).
      const up = s.vehicle.physics.position.y - y0;
      const ok = log.minUp > 0.9 && log.minGrounded >= 3 && log.maxAy < 40 && log.maxVy < 1.6 && !log.bad && !log.fell && up > 0.1;
      if (!ok) bad++;
      lines.push(`8° ${v} km/h: ${fmt(log)}, ${up.toFixed(2)} m up at the end${ok ? '' : ' ✗'}`);
    }
    check('kerb hits: no kick (|ay| < 40 m/s²), ≥ 3 wheels down, upright', bad === 0, `street lane at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    for (const line of lines) console.log(`      ${line}`);
  }

  section('Speed: 100 and 200 km/h on the longest straight boulevard (cell seams, junction boxes)');
  {
    // Collinear arterial segments merged into straight runs (through crossroads); the longest one.
    const runs = new Map<string, [number, number][]>();
    const runClass = new Map<string, RoadClass>();
    for (const r of j.roadGraph) {
      if (r.rank !== 'arterial') continue;
      const vertical = r.a[0] === r.b[0];
      const key = vertical ? `x${r.a[0]}` : `z${r.a[1]}`;
      const k = vertical ? 1 : 0;
      (runs.get(key) ?? runs.set(key, []).get(key)!).push([Math.min(r.a[k], r.b[k]), Math.max(r.a[k], r.b[k])]);
      runClass.set(key, r.cls);
    }
    let best = { key: '', lo: 0, hi: 0 };
    for (const [key, spans] of runs) {
      spans.sort((a, b) => a[0] - b[0]);
      let [lo, hi] = spans[0];
      for (const [a, b] of [...spans.slice(1), [Infinity, Infinity] as [number, number]]) {
        if (a <= hi) hi = Math.max(hi, b);
        else {
          if (hi - lo > best.hi - best.lo) best = { key, lo, hi };
          [lo, hi] = [a, b];
        }
      }
    }
    const c = Number(best.key.slice(1));
    const vertical = best.key[0] === 'x';
    // Driving towards +z (vertical) or +x: heading 0 or π/2; in the innermost right lane ((−dz, dx) is right).
    const yaw = vertical ? 0 : Math.PI / 2;
    const o = laneOffsets(runClass.get(best.key)!)[0];
    const [sx, sz] = vertical ? [c - o, best.lo + 20] : [best.lo + 20, c + o];
    for (const v of [100, 200]) {
      launch(s, track, sx, sz, yaw, v);
      const start = s.vehicle.physics.position.clone();
      const log = cruise(s, track, (best.hi - best.lo - 70) / (v / 3.6), v, [], 0);
      const dist = s.vehicle.physics.position.distanceTo(start);
      const ok = log.minUp > 0.98 && log.minGrounded === 4 && log.maxVy < 0.5 && !log.fell;
      check(`${v} km/h straight: level, all wheels down, no kicks`, ok, `${dist.toFixed(0)} m of a ${(best.hi - best.lo).toFixed(0)} m straight, ${kmh(s).toFixed(0)} km/h · ${fmt(log)}`);
    }
  }

  section('Buildings at 200 km/h: levels of detail and cells while driving');
  {
    // The game's building renderer (no GPU needed to choose levels and build meshes), 1 × 1 texture arrays.
    const tp = track.testPoints.find((t) => t.id === 'a3-downtown');
    if (tp) {
      const tex = () => new THREE.DataArrayTexture(new Uint8Array(4 * BUILDING_LAYERS.length), 1, 1, BUILDING_LAYERS.length);
      const mats = createBuildingMaterials(tex(), tex());
      const b = new CityV2Buildings(data, mats);
      const cam = new THREE.Vector3();
      const camera = () => {
        // Chase camera: 6 m behind, 2.5 m up.
        const p = s.vehicle.physics.position;
        const f = s.vehicle.physics.forward;
        return cam.set(p.x - f.x * 6, p.y + 2.5, p.z - f.z * 6);
      };
      // The straight road the downtown teleport is on (collinear segments through the crossings), both ways
      // in the right lane, from 20 m after its start to 50 m before its end.
      const vertical = Math.abs(Math.sin(tp.yaw)) < 0.5;
      const k = vertical ? 0 : 1;
      const along = vertical ? tp.position.z : tp.position.x;
      const line = j.roadGraph.filter((r) => r.a[k] === r.b[k] && Math.abs(r.a[k] - (vertical ? tp.position.x : tp.position.z)) < 12);
      const c = line.find((r) => Math.min(r.a[1 - k], r.b[1 - k]) <= along && Math.max(r.a[1 - k], r.b[1 - k]) >= along)?.a[k] ?? 0;
      let [lo, hi] = [along, along];
      for (let grown = true; grown; ) {
        grown = false;
        for (const r of line) {
          if (r.a[k] !== c) continue;
          const [a, z] = [Math.min(r.a[1 - k], r.b[1 - k]), Math.max(r.a[1 - k], r.b[1 - k])];
          if (a <= hi + 1e-3 && z >= lo - 1e-3 && (a < lo || z > hi)) {
            [lo, hi] = [Math.min(lo, a), Math.max(hi, z)];
            grown = true;
          }
        }
      }
      const o = laneOffsets(line.find((r) => r.a[k] === c)?.cls ?? 'arterial3')[0];
      const seconds = (hi - lo - 70) / (200 / 3.6);
      // +z: x = c − o; −z: x = c + o; +x: z = c + o; −x: z = c − o.
      const ends: [number, number, number][] = vertical ? [[c - o, lo + 20, 0], [c + o, hi - 20, Math.PI]] : [[lo + 20, c + o, Math.PI / 2], [hi - 20, c - o, -Math.PI / 2]];
      const run = ([x, z, yaw]: [number, number, number]) => {
        launch(s, track, x, z, yaw, 200);
        const log = { maxMs: 0, waitFrames: 0, maxWait: 0, minGrounded: 4, minUp: 1, steps: 0 };
        for (let i = 0; i < Math.round(seconds / DT); i++) {
          const v = kmh(s);
          s.vehicle.fixedUpdate(DT, { throttle: v < 198 ? 0.6 : v < 200 ? 0.25 : 0, brake: 0, steer: 0, handbrake: 0 });
          s.physics.step();
          s.vehicle.postPhysics();
          if (i % 12 === 0) track.stream(s.vehicle.physics.position);
          const t0 = performance.now();
          b.update(camera());
          log.maxMs = Math.max(log.maxMs, performance.now() - t0);
          if (b.waiting) log.waitFrames++;
          log.maxWait = Math.max(log.maxWait, b.waiting);
          log.steps++;
          // The first 0.25 s settle the car from launch (2 cm above its rest height): not judged.
          if (i < Math.round(0.25 / DT)) continue;
          log.minGrounded = Math.min(log.minGrounded, grounded(s));
          log.minUp = Math.min(log.minUp, upY(s));
        }
        return log;
      };
      launch(s, track, ends[0][0], ends[0][1], ends[0][2], 200);
      b.update(camera(), true);
      const start = s.vehicle.physics.position.clone();
      const there = run(ends[0]);
      const dist = s.vehicle.physics.position.distanceTo(start);
      const back = run(ends[1]);
      const built = b.built();
      // The same round trip again: everything it needs is built already.
      run(ends[0]);
      run(ends[1]);
      const again = b.built();
      const frames = (l: typeof there) => `update ≤ ${l.maxMs.toFixed(1)} ms, ${l.waitFrames}/${l.steps} steps with buildings a level coarser (≤ ${l.maxWait}), wheels ≥ ${l.minGrounded}, up ≥ ${l.minUp.toFixed(3)}`;
      check(
        '200 km/h through downtown (both ways): level updates within a frame, car level on all wheels',
        there.maxMs < 16 && back.maxMs < 16 && there.minGrounded === 4 && back.minGrounded === 4 && there.minUp > 0.98 && back.minUp > 0.98 && dist > 150,
        `${dist.toFixed(0)} m of a ${(hi - lo).toFixed(0)} m straight; there: ${frames(there)}; back: ${frames(back)}`,
      );
      check('the same round trip again builds nothing new (levels and merged cells are kept)', again.levels === built.levels && again.cells === built.cells, `${built.levels} of ${built.of} prototype levels, ${built.cells} merged cells after the first; ${again.levels} / ${again.cells} after the second`);
      b.dispose();
      for (const t of mats.textures) t.dispose();
    }
  }

  section('Buildings: culled against the view (nothing behind the camera sent to the GPU)');
  {
    // The game's building renderer with a real camera frustum, at every district teleport looking both ways.
    const tex = () => new THREE.DataArrayTexture(new Uint8Array(4 * BUILDING_LAYERS.length), 1, 1, BUILDING_LAYERS.length);
    const mats = createBuildingMaterials(tex(), tex());
    const b = new CityV2Buildings(data, mats);
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.25, 2000);
    const frustum = new THREE.Frustum();
    const e = new THREE.Matrix4();
    const c = new THREE.Vector3();
    const fwd = new THREE.Vector3();
    /** Instances sent (instanced levels and far boxes) and those entirely behind the camera (40 m shadow margin for casters). */
    const sent = () => {
      let n = 0;
      let behind = 0;
      b.group.traverse((o) => {
        const m = o as THREE.InstancedMesh;
        if (!m.isInstancedMesh || !m.visible) return;
        const s = m.geometry.boundingSphere ?? (m.geometry.computeBoundingSphere(), m.geometry.boundingSphere!);
        for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, e);
          c.copy(s.center).applyMatrix4(e);
          const r = s.radius * e.getMaxScaleOnAxis() + (m.castShadow ? 40 : 0);
          n++;
          if (c.sub(camera.position).dot(fwd) < -r) behind++;
        }
      });
      return { n, behind };
    };
    const rows: string[] = [];
    let ok = true;
    let behindBefore = 0;
    for (const id of ['a3-downtown', 'a3-commercial', 'a3-residential', 'a3-industrial']) {
      const tp = track.testPoints.find((t) => t.id === id);
      if (!tp) continue;
      for (const turn of [0, Math.PI]) {
        // Chase view: 6 m behind the car, 2.5 m up, looking along it.
        const yaw = tp.yaw + turn;
        fwd.set(Math.sin(yaw), 0, Math.cos(yaw));
        camera.position.set(tp.position.x - fwd.x * 6, 2.5, tp.position.z - fwd.z * 6);
        camera.lookAt(camera.position.x + fwd.x * 50, 2, camera.position.z + fwd.z * 50);
        camera.updateMatrixWorld();
        frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        b.cullView = false;
        b.update(camera.position, true, frustum);
        const all = sent();
        b.cullView = true;
        b.update(camera.position, false, frustum);
        const culled = sent();
        // Every far box in range is either drawn (in view) or left out (not): none behind.
        const pass = culled.behind === 0 && culled.n < all.n && b.culled + b.counts[4] - b.farShown > 0;
        ok &&= pass;
        behindBefore += all.behind;
        rows.push(`${id.slice(3)}${turn ? '@180' : ''} ${all.n}→${culled.n} (${all.behind}→${culled.behind} behind)`);
      }
    }
    check('instances and far boxes outside the view are not drawn; turning round swaps them (sent before → after)', ok && rows.length === 8 && behindBefore > 0, rows.join(', '));
    b.dispose();
    for (const t of mats.textures) t.dispose();
  }

  section('Across town: residential → commercial → downtown → industrial at 50, 100 and 200 km/h');
  {
    const stops = ['a3-residential', 'a3-commercial', 'a3-downtown', 'a3-industrial'].map((id) => track.testPoints.find((t) => t.id === id));
    if (stops.every((t) => t)) {
      // Road graph: the quickest way by the bigger roads (alleys only if nothing else).
      const key = (p: [number, number]) => `${p[0]},${p[1]}`;
      const adj = new Map<string, { to: [number, number]; cost: number; cls: RoadClass }[]>();
      const PREFER: Record<RoadClass, number> = { arterial3: 0.6, boulevard: 0.7, avenue: 0.85, street: 1, alley: 5 };
      for (const r of j.roadGraph) {
        const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
        for (const [p, q] of [[r.a, r.b], [r.b, r.a]] as const) (adj.get(key(p)) ?? adj.set(key(p), []).get(key(p))!).push({ to: q, cost: len * PREFER[r.cls], cls: r.cls });
      }
      const nodes = [...adj.keys()].map((k) => k.split(',').map(Number) as [number, number]);
      // The nearest junction ahead of (side 1) or behind (side −1) a teleport, on its road.
      const along = (t: { position: THREE.Vector3; yaw: number }, side: number) => {
        const [fx, fz] = [Math.sin(t.yaw) * side, Math.cos(t.yaw) * side];
        return nodes
          .filter(([x, z]) => (x - t.position.x) * fx + (z - t.position.z) * fz > 0 && Math.abs((x - t.position.x) * fz - (z - t.position.z) * fx) < 12)
          .sort((p, q) => Math.hypot(p[0] - t.position.x, p[1] - t.position.z) - Math.hypot(q[0] - t.position.x, q[1] - t.position.z))[0];
      };
      /**
       * Quickest way from node `from` (reached from `back`) to node `to` reached from `via` (the stop's road, in its
       * direction): states are (node, previous node), never straight back the way the car came (no U-turns).
       */
      const path = (back: [number, number], from: [number, number], via: [number, number], to: [number, number]) => {
        const sk = (n: string, p: string) => `${n}|${p}`;
        const first = sk(key(from), key(back));
        const goal = sk(key(to), key(via));
        const dist = new Map([[first, 0]]);
        const prev = new Map<string, { state: string; cls: RoadClass }>();
        const open = new Set([first]);
        while (open.size) {
          let k = '';
          for (const o of open) if (!k || dist.get(o)! < dist.get(k)!) k = o;
          open.delete(k);
          if (k === goal) break;
          const [n, p] = k.split('|');
          for (const e of adj.get(n) ?? []) {
            if (key(e.to) === p) continue;
            const next = sk(key(e.to), n);
            const d = dist.get(k)! + e.cost;
            if (d < (dist.get(next) ?? Infinity)) {
              dist.set(next, d);
              prev.set(next, { state: k, cls: e.cls });
              open.add(next);
            }
          }
        }
        // Each node with the class of the road that leads to it.
        const out: { p: [number, number]; cls: RoadClass }[] = [];
        for (let k = goal; prev.has(k); k = prev.get(k)!.state) out.unshift({ p: k.split('|')[0].split(',').map(Number) as [number, number], cls: prev.get(k)!.cls });
        return out;
      };
      const ends = stops.map((t) => [along(t!, -1), along(t!, 1)]);
      const roadOf = (a: [number, number], b: [number, number]) => adj.get(key(a))?.find((e) => key(e.to) === key(b))?.cls ?? 'street';
      // From behind the first stop: its road, then each leg to the next stop's road.
      const route: { p: [number, number]; cls: RoadClass }[] = [{ p: ends[0][0], cls: 'street' }, { p: ends[0][1], cls: roadOf(ends[0][0], ends[0][1]) }];
      for (let i = 0; i + 1 < ends.length; i++) route.push(...path(ends[i][0], ends[i][1], ends[i + 1][0], ends[i + 1][1]));
      // Right-hand lane line: at a turn, where the offset lines of the roads in and out cross (axis-aligned roads).
      const lane = (i: number) => laneOffsets(route[i].cls)[0];
      const first = stops[0]!.position;
      const line: [number, number][] = [[first.x, first.z]];
      for (let i = 1; i < route.length; i++) {
        const [a, b] = [route[i - 1].p, route[i].p];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const d1: [number, number] = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
        // Right of (dx, dz) is (−dz, dx).
        let [x, z] = [b[0] - d1[1] * lane(i), b[1] + d1[0] * lane(i)];
        const next = route[i + 1];
        if (next) {
          const L2 = Math.hypot(next.p[0] - b[0], next.p[1] - b[1]) || 1;
          const d2: [number, number] = [(next.p[0] - b[0]) / L2, (next.p[1] - b[1]) / L2];
          if (Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) < 0.5) [x, z] = [x - d2[1] * lane(i + 1), z + d2[0] * lane(i + 1)];
        }
        line.push([x, z]);
      }
      // Turns rounded (a quadratic curve through the corner): right turns tight and slow, left turns wide.
      const path2: [number, number][] = [line[0]];
      /** Speed through each point of the rounded line, km/h (Infinity: none asked). */
      const slow: number[] = [Infinity];
      let turns = 0;
      for (let i = 1; i < line.length - 1; i++) {
        const [a, q, c] = [line[i - 1], line[i], line[i + 1]];
        const [l1, l2] = [Math.hypot(q[0] - a[0], q[1] - a[1]), Math.hypot(c[0] - q[0], c[1] - q[1])];
        const d1 = [(q[0] - a[0]) / l1, (q[1] - a[1]) / l1];
        const d2 = [(c[0] - q[0]) / l2, (c[1] - q[1]) / l2];
        if (d1[0] * d2[0] + d1[1] * d2[1] > 0.9) {
          path2.push(q);
          slow.push(Infinity);
          continue;
        }
        turns++;
        // Right of d1 is (−d1z, d1x): turning right when d2 points there.
        const right = -d1[1] * d2[0] + d1[0] * d2[1] > 0;
        const r = Math.min(right ? 6 : 12, l1 / 2, l2 / 2);
        const [p0, p2] = [[q[0] - d1[0] * r, q[1] - d1[1] * r], [q[0] + d2[0] * r, q[1] + d2[1] * r]];
        for (let n = 0; n <= 6; n++) {
          const u = n / 6;
          path2.push([(1 - u) ** 2 * p0[0] + 2 * u * (1 - u) * q[0] + u * u * p2[0], (1 - u) ** 2 * p0[1] + 2 * u * (1 - u) * q[1] + u * u * p2[1]]);
          slow.push(right ? 15 : 25);
        }
      }
      path2.push(line[line.length - 1]);
      slow.push(Infinity);
      line.splice(0, line.length, ...path2);
      const seg = line.slice(1).map((q, i) => Math.hypot(q[0] - line[i][0], q[1] - line[i][1]) || 1e-3);
      const total = seg.reduce((a, c) => a + c, 0);
      // Buildings and the cell their box collider belongs to (the track's cell state, read for the test).
      const cellStates = [...(track as unknown as { cells: Map<string, { def: { inst: [number, number] }; body: unknown }> }).cells.values()];
      const bodies: { x: number; z: number; cell: (typeof cellStates)[0] }[] = [];
      for (const c of j.cells) {
        const state = cellStates.find((q) => q.def.inst[0] === c.inst[0] && q.def.inst[1] === c.inst[1]);
        for (let i = 0; state && i < c.inst[1]; i++) bodies.push({ x: data.f32[c.inst[0] + i * INSTANCE_STRIDE + 1], z: data.f32[c.inst[0] + i * INSTANCE_STRIDE + 2], cell: state });
      }
      const tex = () => new THREE.DataArrayTexture(new Uint8Array(4 * BUILDING_LAYERS.length), 1, 1, BUILDING_LAYERS.length);
      const mats = createBuildingMaterials(tex(), tex());
      const b = new CityV2Buildings(data, mats);
      const cam = new THREE.Vector3();
      const lines: string[] = [];
      let bad = 0;
      for (const v of [50, 100, 200]) {
        launch(s, track, line[0][0], line[0][1], Math.atan2(line[1][0] - line[0][0], line[1][1] - line[0][1]), 20);
        b.update(cam.set(line[0][0], 2.5, line[0][1]), true);
        const log = { upd: 0, updSum: 0, stream: 0, step: 0, waitSteps: 0, maxWait: 0, late: 0, off: 0, offRoad: 0, minGrounded: 4, minUp: 1, top: 0, steps: 0, done: false };
        let k = 0;
        const limit = Math.round((total / (v / 3.6) + 240) / DT);
        for (let i = 0; i < limit; i++) {
          const p = s.vehicle.physics.position;
          const f = s.vehicle.physics.forward;
          // Progress: the segment the car is on (past the end of one: the next).
          const along = (q: number) => ((p.x - line[q][0]) * (line[q + 1][0] - line[q][0]) + (p.z - line[q][1]) * (line[q + 1][1] - line[q][1])) / (seg[q] * seg[q]);
          while (k < seg.length - 1 && along(k) >= 1) k++;
          const t = Math.max(0, Math.min(1, along(k)));
          const [a, c] = [line[k], line[k + 1]];
          if (k === seg.length - 1 && t > 0.98) {
            log.done = true;
            break;
          }
          log.off = Math.max(log.off, Math.hypot(a[0] + (c[0] - a[0]) * t - p.x, a[1] + (c[1] - a[1]) * t - p.z));
          // Pure pursuit: a point `look` m further along the line.
          const speed = kmh(s);
          let look = Math.max(3.5, (speed / 3.6) * 0.35);
          let q = k;
          let left = seg[k] * (1 - t);
          while (look > left && q < seg.length - 1) {
            look -= left;
            q++;
            left = seg[q];
          }
          const r = Math.min(1, 1 - (left - look) / seg[q]);
          const [tx, tz] = [line[q][0] + (line[q + 1][0] - line[q][0]) * r, line[q][1] + (line[q + 1][1] - line[q][1]) * r];
          const lat = (tx - p.x) * -f.z + (tz - p.z) * f.x;
          const lon = (tx - p.x) * f.x + (tz - p.z) * f.z;
          const steer = Math.max(-1, Math.min(1, Math.atan2(lat, lon) * 2.2));
          // Speed: down to each turn's speed in time, braking at 5 m/s².
          let want = v;
          let to = seg[k] * (1 - t);
          for (let n = k + 1; n < line.length && to < 400; n++) {
            if (slow[n] < want) want = Math.min(want, Math.sqrt((slow[n] / 3.6) ** 2 + 2 * 5 * Math.max(0, to - 4)) * 3.6);
            to += seg[n] ?? 0;
          }
          s.vehicle.fixedUpdate(DT, { throttle: speed < want - 2 ? 0.7 : speed < want ? 0.25 : 0, brake: speed > want + 3 ? Math.min(1, (speed - want) / 25) : 0, steer, handbrake: 0 });
          const t0 = performance.now();
          s.physics.step();
          s.vehicle.postPhysics();
          log.step = Math.max(log.step, performance.now() - t0);
          if (i % 12 === 0) {
            const t1 = performance.now();
            track.stream(p);
            log.stream = Math.max(log.stream, performance.now() - t1);
          }
          const t2 = performance.now();
          b.update(cam.set(p.x - f.x * 6, p.y + 2.5, p.z - f.z * 6));
          const ms = performance.now() - t2;
          log.upd = Math.max(log.upd, ms);
          log.updSum += ms;
          if (b.waiting) log.waitSteps++;
          log.maxWait = Math.max(log.maxWait, b.waiting);
          // Every building within 40 m has its box collider.
          for (const o of bodies) if (!o.cell.body && Math.abs(o.x - p.x) < 40 && Math.abs(o.z - p.z) < 40) log.late++;
          log.top = Math.max(log.top, speed);
          if (i % 6 === 0 && !track.onRoad(p)) log.offRoad++;
          log.steps++;
          if (i < Math.round(0.25 / DT)) continue;
          log.minGrounded = Math.min(log.minGrounded, grounded(s));
          log.minUp = Math.min(log.minUp, upY(s));
        }
        const ok = log.done && log.upd < 16 && log.late === 0 && log.offRoad === 0 && log.minGrounded >= 3 && log.minUp > 0.9;
        if (!ok) bad++;
        lines.push(
          `${v} km/h: ${log.done ? 'arrived' : 'did not arrive'} after ${(log.steps * DT).toFixed(0)} s (top ${log.top.toFixed(0)} km/h), off the lane line ≤ ${log.off.toFixed(1)} m, ${log.offRoad} samples off the road, wheels ≥ ${log.minGrounded}, up ≥ ${log.minUp.toFixed(3)} · ` +
            `buildings: update ≤ ${log.upd.toFixed(1)} ms (mean ${(log.updSum / Math.max(1, log.steps)).toFixed(2)}), ${log.waitSteps}/${log.steps} steps a level coarser (≤ ${log.maxWait}) · ` +
            `colliders late ${log.late}, stream ≤ ${log.stream.toFixed(1)} ms, physics step ≤ ${log.step.toFixed(1)} ms${ok ? '' : ' ✗'}`,
        );
      }
      const built = b.built();
      check('across town at 50 / 100 / 200 km/h (as fast as the turns allow): arrives on the road, colliders in time, building updates within a frame', bad === 0, `${(total / 1000).toFixed(2)} km, ${turns} turns; ${built.levels} of ${built.of} prototype levels, ${built.cells} merged cells built`);
      for (const l of lines) console.log(`      ${l}`);
      b.dispose();
      for (const t of mats.textures) t.dispose();
    }
  }

  section('Streaming, respawn, bounds');
  {
    let maxPhysics = 0;
    let maxTris = 0;
    const f = data.f32;
    const [ro, rn] = j.roads;
    const p = new THREE.Vector3();
    for (let i = 0; i < rn; i += Math.floor(rn / 60)) {
      p.set(f[ro + i * 5], 0, f[ro + i * 5 + 2]);
      track.stream(p);
      const st = track.stats();
      maxPhysics = Math.max(maxPhysics, st.physics);
      maxTris = Math.max(maxTris, st.colliderTris);
    }
    check('colliders only near the car (≤ 9 cells)', maxPhysics <= 9, `≤ ${maxPhysics} cells, ≤ ${maxTris} triangles, Rapier world ${s.physics.world.colliders.len()} colliders`);
    const off = new THREE.Vector3(track.spawn.position.x + 23, 5, track.spawn.position.z + 31);
    const r = track.safeRespawn(off);
    check('Shift+R: nearest lane, on the road', track.onRoad(r.position) && r.position.distanceTo(off) < 40, `${r.position.distanceTo(off).toFixed(1)} m away`);
    check('out of bounds beyond the land', track.outOfBounds(new THREE.Vector3(j.bounds.maxX + 100, 0, 0)) && !track.outOfBounds(track.spawn.position), 'ok');
  }
  track.dispose();
  s.physics.dispose();
}

// --- street props (A4) ---------------------------------------------------------------------------------

async function streetProps(dir: string): Promise<void> {
  const section = (t: string) => sectionOf(`2 × 2 km · ${t}`);
  section('Street props (A4): placement');
  const data = loadData(dir);
  const j = data.json;
  const f = data.f32;
  const pj = j.props;
  if (!pj) {
    check('props prepared', false, 'no props in the prepared city (npm run prepare:city)');
    return;
  }
  const districtTotal = (d: string) => Object.values(pj.counts[d] ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  check('props prepared: a controlled amount, every district', pj.total > 5000 && pj.total < 25000 && DISTRICTS.every((d) => districtTotal(d) > 500), `${pj.total} instances in ${pj.chunks.length} chunks; ${DISTRICTS.map((d) => `${d} ${districtTotal(d)}`).join(', ')}`);
  const layout = generateLayout({ seed: j.layout.seed, size: j.layout.size });
  const ground = buildGround(layout);
  const rects: [number, number, number, number][] = [];
  for (const c of j.cells) for (let i = 0; i < c.boxes[1]; i++) {
    const o = c.boxes[0] + i * 10;
    rects.push([f[o] - f[o + 3], f[o + 2] - f[o + 5], f[o] + f[o + 3], f[o + 2] + f[o + 5]]);
  }
  /** Instance floats of a props section, chunk by chunk (as packed). */
  const floats = (props: typeof pj, arr: ArrayLike<number>): Float32Array => {
    const res: number[] = [];
    for (const c of props.chunks) for (const [, o, n] of c.items) for (let i = 0; i < n * props.stride; i++) res.push(arr[o + i]);
    return new Float32Array(res);
  };
  const digest = (a: Float32Array) => createHash('sha1').update(new Uint8Array(a.buffer)).digest('hex').slice(0, 12);
  const fresh = () => {
    const f32: number[] = [];
    const packed = packProps(placeProps(layout, ground.raster, rects.map((rect) => ({ rect })), j.layout.seed), f32, [], new Set(j.cells.map((c) => `${c.cx},${c.cz}`)));
    return `${digest(floats(packed.json, f32))}/${packed.json.total}`;
  };
  const a = fresh();
  const b = fresh();
  const prepared = `${digest(floats(pj, f))}/${pj.total}`;
  const l7 = generateLayout({ seed: 7, size: 1000 });
  const other = placeProps(l7, buildGround(l7).raster, [], 7).instances.length;
  check('deterministic: same seed → same props (twice, and as prepared); another seed → others', a === b && a.split('/')[1] === prepared.split('/')[1] && other !== pj.total, `${a} · ${b} · prepared ${prepared} · seed 7 (1 km) ${other} instances`);

  // Every instance, decoded.
  const all: { id: string; cat: PropCategory; x: number; y: number; z: number; yaw: number; s: number }[] = [];
  for (const c of pj.chunks) for (const [proto, o, n] of c.items) for (let i = 0; i < n; i++) {
    const k = o + i * pj.stride;
    all.push({ id: PROPS[proto].id, cat: PROPS[proto].category, x: f[k], y: f[k + 1], z: f[k + 2], yaw: f[k + 3], s: Math.max(f[k + 4], f[k + 6]) });
  }
  const R: GroundRaster = ground.raster;
  const label = (x: number, z: number): number => R.lab[Math.floor((z - R.minZ) / R.res) * R.W + Math.floor((x - R.minX) / R.res)];
  const roadLabels: number[] = [RASTER.ASPHALT, RASTER.CORNER, RASTER.NONE];
  // Off the road: everything but manholes / drains stands on raised ground (not asphalt, not a kerb corner).
  const flatCats = new Set<PropCategory>(['street', 'marking', 'grass', 'path', 'fence']);
  const onRoad = all.filter((p) => !flatCats.has(p.cat) && roadLabels.includes(label(p.x, p.z)));
  const streetOff = all.filter((p) => p.cat === 'street' && label(p.x, p.z) !== RASTER.ASPHALT);
  const roadBad = [...onRoad, ...streetOff];
  check('no props on the road (manholes and drains only on asphalt)', roadBad.length === 0, roadBad.length ? roadBad.slice(0, 5).map((p) => `${p.id} (${p.x.toFixed(1)}, ${p.z.toFixed(1)}) on ${label(p.x, p.z)}`).join('; ') : `${all.length} instances checked against the ground raster`);
  // Off the buildings: no prop inside a footprint (half its radius of slack).
  const BB = 40;
  const bins = new Map<string, number[]>();
  rects.forEach((r, i) => {
    for (let x = Math.floor(r[0] / BB); x <= Math.floor(r[2] / BB); x++) {
      for (let z = Math.floor(r[1] / BB); z <= Math.floor(r[3] / BB); z++) {
        const key = `${x},${z}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key)!.push(i);
      }
    }
  });
  const inBuilding = all.filter((p) => {
    const r0 = PROPS[PROP_INDEX[p.id]].radius * p.s * 0.5;
    return (bins.get(`${Math.floor(p.x / BB)},${Math.floor(p.z / BB)}`) ?? []).some((i) => {
      const [x0, z0, x1, z1] = rects[i];
      return p.x > x0 - r0 && p.x < x1 + r0 && p.z > z0 - r0 && p.z < z1 + r0;
    });
  });
  check('no props inside buildings', inBuilding.length === 0, inBuilding.length ? inBuilding.slice(0, 5).map((p) => `${p.id} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).join('; ') : `${all.length} instances against ${rects.length} footprints`);
  // Sight lines: nothing tall or bushy in a junction's box plus 8 m along both roads.
  const tall = new Set<PropCategory>(['tree', 'bush', 'planter', 'busstop', 'container', 'utility']);
  const blocking = all.filter((p) => tall.has(p.cat) && pj.junctions.some((jn) => {
    const reach = Math.max(...jn.approaches.map((ap) => kerbOffset(j.roadGraph[ap.edge].cls))) + 8;
    return Math.abs(jn.x - p.x) < reach && Math.abs(jn.z - p.z) < reach;
  }));
  check('junctions kept clear (no trees, bushes, planters, shelters, containers in the sight box)', blocking.length === 0, blocking.length ? blocking.slice(0, 5).map((p) => `${p.id} (${p.x.toFixed(1)}, ${p.z.toFixed(1)})`).join('; ') : `${all.filter((p) => tall.has(p.cat)).length} tall props, ${pj.junctions.length} junctions`);
  // Grounded: raised props at the sidewalk height (decals ≤ 2 cm above), road props at the asphalt, stacked containers on containers.
  const badY = all.filter((p) => (p.cat === 'street' ? Math.abs(p.y) > 0.01 : p.id === 'container' ? Math.abs(p.y - 0.15) > 0.01 && Math.abs(p.y - 2.75) > 0.01 : Math.abs(p.y - 0.16) > 0.011));
  check('props on the ground (not floating, not sunk)', badY.length === 0, badY.length ? badY.slice(0, 5).map((p) => `${p.id} y ${p.y.toFixed(3)}`).join('; ') : 'sidewalk / lot props at 0.15 m, decals ≤ 2 cm above, manholes and drains on the asphalt, stacked containers on containers');

  section('Street props: parking, signals, signs');
  {
    const spots = Array.from({ length: pj.spots[1] }, (_, i) => [0, 1, 2, 3].map((k) => f[pj.spots[0] + i * 4 + k]));
    const lotLabels: number[] = [RASTER.PARKING, RASTER.LOT];
    const offLot = spots.filter(([x, z]) => !lotLabels.includes(label(x, z)));
    const grid = new Map<string, number[][]>();
    const cellKey = (x: number, z: number) => `${Math.floor(x / 10)},${Math.floor(z / 10)}`;
    for (const sp of spots) {
      const key = cellKey(sp[0], sp[1]);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(sp);
    }
    let overlap = 0;
    for (const sp of spots) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const q of grid.get(cellKey(sp[0] + dx * 10, sp[1] + dz * 10)) ?? []) if (q !== sp && Math.hypot(q[0] - sp[0], q[1] - sp[1]) < 2.4) overlap++;
      }
    }
    const lotsOk = pj.lots.every((l) => l.spots[1] > 0 && l.entrances.length > 0) && spots.every((sp) => sp[3] >= 0 && sp[3] < pj.lots.length);
    const parkingLots = pj.lots.filter((l) => l.use === 'parking').length;
    check('parking spots: on parking / lot ground, 2.5 m apart, each lot with spots and an entrance', spots.length > 1000 && offLot.length === 0 && overlap === 0 && lotsOk && parkingLots === layout.blocks.filter((bl) => bl.use === 'parking').length, `${spots.length} spots in ${pj.lots.length} lots (${parkingLots} car parks, the rest malls and yards); ${offLot.length} off the lot, ${overlap} overlapping`);
    const byId = new Map(pj.junctions.map((jn) => [jn.id, jn]));
    const badSignal = pj.signals.filter((sg) => {
      const jn = byId.get(sg.junction);
      const ap = jn?.approaches.find((x) => x.edge === sg.edge);
      // The head faces the drivers arriving (against their direction), near their stop line.
      return !jn || jn.control !== 'signal' || !ap || ap.control !== 'signal' || Math.sin(sg.yaw) * -ap.dir[0] + Math.cos(sg.yaw) * -ap.dir[1] < 0.99 || Math.hypot(sg.x - ap.stop[0], sg.z - ap.stop[1]) > 16;
    });
    const signalled = pj.junctions.filter((jn) => jn.control === 'signal');
    const covered = signalled.filter((jn) => pj.signals.filter((sg) => sg.junction === jn.id).length >= jn.approaches.length - 1);
    const minorSignal = signalled.filter((jn) => jn.approaches.every((ap) => ['street', 'alley'].includes(j.roadGraph[ap.edge].cls)));
    check('signals: each tied to a signalled junction and approach, facing its drivers; main crossings only', badSignal.length === 0 && covered.length === signalled.length && minorSignal.length === 0 && signalled.length > 10, `${pj.signals.length} signals at ${signalled.length} junctions (of ${pj.junctions.length}); ${badSignal.length} misplaced, ${signalled.length - covered.length} junctions missing more than one, ${minorSignal.length} on minor streets only`);
    const stopSigns = all.filter((p) => p.id === 'sign_stop' || p.id === 'sign_yield');
    const stopOnMajor = pj.junctions.flatMap((jn) => jn.approaches.filter((ap) => (ap.control === 'stop' || ap.control === 'yield') && !['street', 'alley'].includes(j.roadGraph[ap.edge].cls)));
    const byControl = ['signal', 'stop', 'yield', 'priority', 'none'].map((c) => `${c} ${pj.junctions.reduce((n, jn) => n + jn.approaches.filter((ap) => ap.control === c).length, 0)}`);
    check('stop / yield only on minor approaches to bigger roads (signs where a sidewalk allows)', stopOnMajor.length === 0 && stopSigns.length > 50, `${stopSigns.length} signs; approaches: ${byControl.join(', ')}`);
  }

  section('Street props: streaming and culling');
  {
    const props = new CityV2Props(data);
    const at = new THREE.Vector3();
    const e = new THREE.Matrix4();
    /** Instances sent now (first part of each prototype level). */
    const decode = () => {
      const res: { id: string; x: number; z: number; mid: boolean }[] = [];
      for (const { id, mid, mesh } of props.meshes()) {
        if (!mesh.visible || !mesh.name.endsWith('-0')) continue;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, e);
          res.push({ id, x: e.elements[12], z: e.elements[14], mid });
        }
      }
      return res;
    };
    // Distance: nothing sent beyond its draw distance (+ the chunk it shares), everything near is sent.
    at.set(12, 0, 300);
    props.update(at, null, 450, 0, 0);
    const sent = decode();
    const dist = (p: { x: number; z: number }, x: number, z: number) => Math.hypot(p.x - x, p.z - z);
    const tooFar = sent.filter((p) => dist(p, at.x, at.z) > PROPS[PROP_INDEX[p.id]].far + 180);
    const nearAll = all.filter((p) => dist(p, at.x, at.z) < 60).length;
    const nearSent = sent.filter((p) => dist(p, at.x, at.z) < 60).length;
    const midNear = sent.filter((p) => p.mid && dist(p, at.x, at.z) < (PROPS[PROP_INDEX[p.id]].mid ?? 0) - 130).length;
    check('distance culling: per prototype draw distance, cheap level only far away', tooFar.length === 0 && nearSent === nearAll && midNear === 0 && sent.length < all.length * 0.4, `${sent.length} of ${all.length} sent at (12, 300); ${nearSent}/${nearAll} within 60 m; ${tooFar.length} beyond their distance; ${midNear} near ones at the cheap level`);
    // Chunks follow the camera; standing still refills nothing.
    const r0 = props.refills;
    props.update(at, null, 450, 0, 0);
    const still = props.refills === r0;
    const inRangeHere = props.inRange;
    at.set(-700, 0, 420);
    props.update(at, null, 450, 0, 0);
    const there = decode();
    const leftBehind = there.filter((p) => dist(p, 12, 300) < 100).length;
    check('chunk streaming: chunks follow the camera, no refill when nothing changes', still && leftBehind === 0 && there.length > 0 && props.inRange !== inRangeHere, `refill when still: ${!still}; after moving 730 m: ${there.length} sent, ${leftBehind} left at the old spot; in range ${inRangeHere} → ${props.inRange}`);
    // Frustum: a chase camera at the downtown crossing, both ways.
    const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.25, 2000);
    const frustum = new THREE.Frustum();
    const view = new THREE.Matrix4();
    const look = (x: number, z: number, yaw: number) => {
      camera.position.set(x, 2.5, z);
      camera.lookAt(x + Math.sin(yaw) * 50, 2, z + Math.cos(yaw) * 50);
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    };
    const rows: string[] = [];
    let ok = true;
    for (const yaw of [Math.PI, 0]) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      look(12 - fx * 6, 250 - fz * 6, yaw);
      props.update(camera.position, null, 450, 0, 0);
      const before = decode();
      props.update(camera.position, frustum, 450, 0, 0);
      const after = decode();
      // Behind the camera by more than a chunk (125 m) plus the shadow margin: must not be sent.
      const behind = (list: typeof after) => list.filter((p) => (p.x - camera.position.x) * fx + (p.z - camera.position.z) * fz < -190).length;
      ok &&= behind(after) === 0 && after.length < before.length * 0.75 && behind(before) > 0;
      rows.push(`${yaw ? 'south' : 'north'} ${before.length}→${after.length} (${behind(before)}→${behind(after)} far behind)`);
    }
    check('frustum culling: chunks behind the camera send nothing; turning round swaps them', ok, rows.join(', '));
    // CPU cost of the culling (no allocation per frame): an update every 2 m along 1 km with a turning view.
    const t0 = performance.now();
    let n = 0;
    let worst = 0;
    for (let z = -500; z < 500; z += 2, n++) {
      look(12, z, z / 120);
      const t = performance.now();
      props.update(camera.position, frustum, 450, 0, n / 60);
      worst = Math.max(worst, performance.now() - t);
    }
    const mean = (performance.now() - t0) / n;
    check('culling cost: < 0.5 ms a frame on average (refills included)', mean < 0.5, `${mean.toFixed(3)} ms mean, ${worst.toFixed(2)} ms worst over ${n} updates (${props.refills} refills, ${props.stats().chunks} chunks)`);
    props.dispose();
  }

  section('Street props: colliders');
  {
    const s = await makeSim(false, 0, 0, 0, { track: 'city' });
    const track = s.track as CityV2Track;
    let max = 0;
    let cells = 0;
    const p = new THREE.Vector3();
    const [ro, rn] = j.roads;
    for (let i = 0; i < rn; i += Math.floor(rn / 40)) {
      p.set(f[ro + i * 5], 0, f[ro + i * 5 + 2]);
      track.stream(p);
      const st = track.stats();
      max = Math.max(max, st.propBoxes);
      cells = Math.max(cells, st.physics);
    }
    const solid = PROPS.filter((d) => d.collider).map((d) => `${d.id} ${all.filter((q) => q.id === d.id).length}`);
    const smallSolid = PROPS.filter((d) => d.collider && ['bench', 'bin', 'sign', 'tree', 'bush', 'hydrant', 'bollard', 'grass', 'marking'].includes(d.category));
    check('prop colliders streamed with the cells (only near the car), small props without', max > 0 && max < pj.colliders * 0.25 && cells <= 9 && smallSolid.length === 0, `${pj.colliders} boxes in town, ≤ ${max} active (≤ ${cells} cells); solid: ${solid.join(', ')}`);
    // A street lamp stops a car (box collider): from 8 m in front of it at 30 km/h, straight at the pole.
    const lamp = all.filter((q) => q.id === 'lamp_street').sort((x, y) => dist2(x, track.spawn.position) - dist2(y, track.spawn.position))[0];
    const yaw = lamp.yaw + Math.PI;
    launch(s, track, lamp.x - Math.sin(yaw) * 8, lamp.z - Math.cos(yaw) * 8, yaw, 30);
    for (let i = 0; i < 240; i++) {
      s.vehicle.fixedUpdate(DT, { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
      s.physics.step();
      s.vehicle.postPhysics();
      track.stream(s.vehicle.physics.position);
    }
    const pos = s.vehicle.physics.position;
    const passed = (pos.x - lamp.x) * Math.sin(yaw) + (pos.z - lamp.z) * Math.cos(yaw);
    check('a street lamp stops the car (pole collider)', passed < 0.5 && kmh(s) < 15, `car ${(-passed).toFixed(1)} m before the pole at (${lamp.x.toFixed(0)}, ${lamp.z.toFixed(0)}), ${kmh(s).toFixed(0)} km/h after 4 s`);
    track.dispose();
    s.physics.dispose();
  }
}

const dist2 = (p: { x: number; z: number }, q: THREE.Vector3) => (p.x - q.x) ** 2 + (p.z - q.z) ** 2;

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
