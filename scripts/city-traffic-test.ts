/**
 * City V2 traffic and parked cars (A5), headless, on the prepared city
 * (public/assets/city_v2, npm run prepare:city).
 *
 * Lane graph: every lane continues, every lane and connector can be reached
 * from every other, lanes lie on the asphalt, conflicts are symmetric. Traffic
 * (no player in the way): nobody enters a signalled junction on red, stop
 * signs are stopped at, vehicles do not drive into each other, no gridlock
 * builds up, speeds are town speeds, the same seed gives the same traffic, a
 * step stays cheap with 120 vehicles. With the real car: the AI queues behind
 * the player, waits while the player stands in a junction, and a hit leaves a
 * wreck that is removed once out of sight; collision bodies only near the
 * player; the drawn signals and the drivers share one clock. Parked cars: the
 * same seed parks the same cars, a share of the stalls per lot use, none on a
 * road, in a building or in another car, colliders streamed with the cells
 * (a parked car stops the player), drawn by distance and view.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { CITY_TRAFFIC, TRAFFIC_CLASSES, type TrafficDensity } from '../src/config/traffic';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { CityLaneGraph, type CitySeg } from '../src/traffic/city/CityLaneGraph';
import { CityTrafficSystem } from '../src/traffic/city/CityTrafficSystem';
import { obbOverlap, type PlayerProbe } from '../src/traffic/TrafficSystem';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { setCityV2Assets } from '../src/world/cityv2/CityV2Assets';
import { parseCityV2Data, type CityV2Data, type CityV2Json } from '../src/world/cityv2/CityV2Data';
import { CityV2ParkedCars, PARKED_MODELS } from '../src/world/cityv2/CityV2ParkedCars';
import type { CityV2Track } from '../src/world/cityv2/CityV2Track';
import { signalPhase } from '../src/world/cityv2/propKit';
import { DT, check, finish, makeSim, section } from './lib/sim';

const GAME_DIR = join(import.meta.dirname, '../public/assets/city_v2');

function loadData(): CityV2Data {
  const json = JSON.parse(readFileSync(join(GAME_DIR, 'city-data.json'), 'utf8')) as CityV2Json;
  const buf = readFileSync(join(GAME_DIR, 'city-data.bin'));
  const data = parseCityV2Data(json, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  setCityV2Assets({ data, ground: new Map(), buildings: null, bytes: 0, loadMs: 0 });
  return data;
}

/** A player probe parked far above town: the traffic runs undisturbed around (x, z). */
function skyProbe(x: number, z: number): PlayerProbe {
  return { position: new THREE.Vector3(x, 60, z), velocity: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, 1), halfExtents: { x: 0.95, y: 0.7, z: 2.3 } };
}

interface FlowLog {
  entries: number;
  redRuns: string[];
  stopRuns: number;
  stopEntries: number;
  overlapSamples: number;
  samples: number;
  speed: number;
  stepMs: number[];
}

/** Runs a traffic system in its own world for `seconds`, watching every junction entry. */
function flow(graph: CityLaneGraph, x: number, z: number, density: TrafficDensity, seconds: number, seed = 2026): { sys: CityTrafficSystem; log: FlowLog; physics: PhysicsWorld } {
  const physics = flowWorld!;
  const sys = new CityTrafficSystem(physics.world, graph, { signalTime: 0 }, skyProbe(x, z), seed, density, 'mixed');
  const log: FlowLog = { entries: 0, redRuns: [], stopRuns: 0, stopEntries: 0, overlapSamples: 0, samples: 0, speed: 0, stepMs: [] };
  const last = new Map<number, { seg: number; locked: boolean; stopped: boolean }>();
  const isJunction = (c: CitySeg) => graph.nodes[c.node].edges.length >= 3;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const t0 = performance.now();
    sys.beforeStep(DT);
    physics.step();
    sys.afterStep(DT);
    log.stepMs.push(performance.now() - t0);
    for (const v of sys.vehicles) {
      const was = last.get(v.id);
      if (was && was.seg !== v.seg) {
        const a = graph.segs[was.seg];
        const b = graph.segs[v.seg];
        if (a.kind === 'lane' && b.kind === 'connector' && isJunction(b)) {
          log.entries++;
          // Red for over a second (the all-red second covers whoever entered on yellow), not the second of two junctions taken as one.
          if (a.control === 'signal' && !was.locked && signalPhase(a.group, sys.time) === 0 && signalPhase(a.group, sys.time - 1.2) === 0) log.redRuns.push(`#${v.id} lane ${a.id} at ${sys.time.toFixed(1)} s`);
          if (a.control === 'stop' && !was.locked) {
            log.stopEntries++;
            if (!was.stopped) log.stopRuns++;
          }
        }
      }
      last.set(v.id, { seg: v.seg, locked: v.locked, stopped: v.stopped });
    }
    if (i % 120 === 0) {
      log.samples++;
      if (sys.overlaps()) log.overlapSamples++;
      for (const v of sys.vehicles) log.speed += v.v / Math.max(1, sys.vehicles.length);
    }
  }
  log.speed = (log.speed / log.samples) * 3.6;
  return { sys, log, physics };
}
let flowWorld: PhysicsWorld | null = null;

const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))];
const digest = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 12);

async function main(): Promise<void> {
  const data = loadData();
  const json = data.json;
  flowWorld = await PhysicsWorld.create();

  section('City traffic (A5): lane graph');
  const t0 = performance.now();
  const graph = new CityLaneGraph(json);
  const buildMs = performance.now() - t0;
  const lanes = graph.segs.filter((s) => s.kind === 'lane');
  const conns = graph.segs.filter((s) => s.kind === 'connector');
  check('lane graph built from the road graph', lanes.length > 1000 && conns.length > lanes.length && buildMs < 800, `${lanes.length} lanes, ${conns.length} connectors (${conns.filter((c) => c.turn === 'left').length} left, ${conns.filter((c) => c.turn === 'right').length} right) in ${buildMs.toFixed(0)} ms`);
  const reach = (forward: boolean) => {
    const prev = new Map<number, number[]>();
    if (!forward) for (const s of graph.segs) for (const n of s.next) prev.set(n, [...(prev.get(n) ?? []), s.id]);
    const seen = new Set([lanes[0].id]);
    const stack = [lanes[0].id];
    while (stack.length) {
      const s = stack.pop()!;
      for (const n of forward ? graph.segs[s].next : (prev.get(s) ?? [])) if (!seen.has(n)) seen.add(n), stack.push(n);
    }
    return seen.size;
  };
  const dead = lanes.filter((l) => !l.next.length).length;
  check('every lane continues; every lane / connector reachable from every other', dead === 0 && reach(true) === graph.segs.length && reach(false) === graph.segs.length, `${dead} dead ends, forward ${reach(true)} / backward ${reach(false)} of ${graph.segs.length}`);
  const asym = conns.filter((c) => c.conflicts.some((k) => !graph.segs[k].conflicts.includes(c.id))).length;
  const merges = conns.filter((c) => conns.some((d) => d !== c && d.to === c.to && d.node === c.node && d.from !== c.from && !c.conflicts.includes(d.id))).length;
  check('connector conflicts symmetric, every merge a conflict', asym === 0 && merges === 0, `${asym} one-sided, ${merges} merges not listed; ${(conns.reduce((a, c) => a + c.conflicts.length, 0) / conns.length).toFixed(1)} conflicts per connector`);

  section('City traffic: lanes on the asphalt');
  {
    const s = await makeSim(false, 0, 0, 0, { track: 'city' });
    const track = s.track as CityV2Track;
    const p = new THREE.Vector3();
    const smp = { x: 0, z: 0, heading: 0 };
    let n = 0;
    const off: string[] = [];
    for (const seg of graph.segs) {
      for (const t of [0.02, 0.5, 0.98]) {
        graph.sample(seg, seg.length * t, smp);
        p.set(smp.x, 0, smp.z);
        n++;
        if (!track.onRoad(p)) off.push(`${seg.kind} ${seg.id} (${smp.x.toFixed(1)}, ${smp.z.toFixed(1)})`);
      }
    }
    check('lane and connector points on the asphalt', off.length === 0, off.length ? `${off.length} off: ${off.slice(0, 4).join('; ')}` : `${n} points checked`);
    check('the track carries the lane graph and the signal clock', track.laneGraph.segs.length === graph.segs.length && track.signalTime === 0, `${track.laneGraph.segs.length} segments, signalTime ${track.signalTime}`);
    track.dispose();
    s.physics.dispose();
  }

  section('City traffic: flow (no player in the way)');
  {
    const { sys, log } = flow(graph, 0, 0, 'veryHigh', 240);
    const st = sys.stats();
    check('downtown, very high: nobody enters a signalled junction on red', log.redRuns.length === 0 && log.entries > 1500, `${log.entries} junction entries, ${log.redRuns.length} on red ${log.redRuns.slice(0, 3).join(', ')}`);
    check('stop signs: a full stop before entering', log.stopRuns === 0, `${log.stopEntries} entries from stop signs, ${log.stopRuns} without stopping`);
    check('vehicles do not drive into each other', log.overlapSamples <= Math.max(2, log.samples * 0.03), `overlapping bodies in ${log.overlapSamples} of ${log.samples} samples (1 s apart)`);
    const waits = sys.vehicles.map((v) => v.stillT);
    check('no gridlock: few vehicles stuck, short waits', st.stuck <= 4 && Math.max(0, ...waits) < CITY_TRAFFIC.stuck, `${st.stuck} removed as gridlocked, longest standing now ${Math.max(0, ...waits).toFixed(0)} s, ${st.active} active`);
    check('town speeds', log.speed > 12 && log.speed < 45, `${log.speed.toFixed(1)} km/h average`);
    const mean = log.stepMs.reduce((a, b) => a + b, 0) / log.stepMs.length;
    check('cheap: a step with 120 vehicles', mean < 0.3 && pct(log.stepMs.slice(120), 0.99) < 1.5, `${mean.toFixed(3)} ms mean, p99 ${pct(log.stepMs.slice(120), 0.99).toFixed(3)} ms, ${st.active} vehicles`);
    sys.dispose();
  }
  {
    const { sys, log } = flow(graph, -603, 836, 'high', 180);
    const st = sys.stats();
    check('residential, high: rules kept, no gridlock', log.redRuns.length === 0 && log.stopRuns === 0 && st.stuck <= 2 && log.overlapSamples <= Math.max(2, log.samples * 0.03), `${log.entries} entries, ${log.redRuns.length} red, ${log.stopRuns}/${log.stopEntries} stop signs run, ${st.stuck} stuck, overlaps in ${log.overlapSamples}/${log.samples}, ${log.speed.toFixed(1)} km/h`);
    sys.dispose();
  }
  {
    const pos = (seed: number) => {
      const { sys } = flow(graph, 300, -300, 'medium', 30, seed);
      const out = sys.vehicles.map((v) => [v.seg, +v.s.toFixed(3), v.classId]);
      sys.dispose();
      return digest(out);
    };
    const a = pos(2026);
    const b = pos(2026);
    const c = pos(7);
    check('deterministic: same seed → same traffic; another seed → other', a === b && a !== c, `${a} · ${b} · seed 7 ${c}`);
  }

  section('City traffic: with the player');
  const s = await makeSim(false, 0, 0, 0, { track: 'city' });
  const track = s.track as CityV2Track;
  const p = s.vehicle.physics;
  const probe: PlayerProbe = { position: p.position, velocity: p.linearVelocity, forward: p.forward, halfExtents: s.config.chassis.halfExtents };
  const traffic = new CityTrafficSystem(s.physics.world, track.laneGraph, track, probe, 2026, 'high', 'mixed');
  // Standing still: the handbrake (the brake key held at a standstill selects reverse).
  const step = (controls = { throttle: 0, brake: 0, steer: 0, handbrake: 1 }) => {
    s.vehicle.fixedUpdate(DT, controls);
    traffic.beforeStep(DT);
    s.physics.step();
    s.vehicle.postPhysics();
    traffic.afterStep(DT);
    track.stream(p.position);
  };
  const place = (x: number, z: number, yaw: number, speed = 0) => {
    track.stream(new THREE.Vector3(x, 0, z), true);
    s.vehicle.reset(new THREE.Vector3(x, VehiclePhysics.restHeight(s.config) + 0.02, z), yaw);
    s.vehicle.physics.body.setLinvel({ x: Math.sin(yaw) * speed, y: 0, z: Math.cos(yaw) * speed }, true);
    for (const w of s.vehicle.physics.wheels) w.angularVelocity = speed / s.config.wheel.radius;
    traffic.onTeleport();
  };
  const smp = { x: 0, z: 0, heading: 0 };
  {
    // A long street lane: the player stands 90 m in, an AI car comes from behind at 35 km/h.
    const lane = lanes.find((l) => l.cls === 'street' && l.length > 140 && Math.hypot(graph.sample(l, 90, smp).x - track.spawn.position.x, smp.z - track.spawn.position.z) < 900)!;
    graph.sample(lane, 90, smp);
    traffic.manual = true;
    place(smp.x, smp.z, smp.heading);
    for (let i = 0; i < 60; i++) step();
    const ai = traffic.spawnForTest('sedan_grey', lane.id, 15, 35 / 3.6);
    for (let i = 0; i < 12 * 120; i++) step();
    const gap = 90 - ai.s - ai.klass.length / 2 - s.config.chassis.halfExtents.z;
    check('the AI queues behind the player standing in its lane', ai.v < 0.3 && gap > 0.8 && gap < 9 && traffic.stats().crashes === 0, `stopped ${gap.toFixed(1)} m behind, ${(ai.v * 3.6).toFixed(1)} km/h, crashes ${traffic.stats().crashes}`);
  }
  {
    // The player stands in a junction on the path of an AI car arriving on the main road: it waits, then goes once the box is clear.
    const lane = lanes.find((l) => l.control === 'priority' && l.length > 60 && l.next.some((c) => graph.segs[c].turn === 'straight' && graph.segs[c].length > 14))!;
    const conn = graph.segs[lane.next.find((c) => graph.segs[c].turn === 'straight')!];
    graph.sample(conn, conn.length / 2, smp);
    place(smp.x, smp.z, smp.heading + Math.PI / 2);
    for (let i = 0; i < 60; i++) step();
    const ai = traffic.spawnForTest('sedan_red', lane.id, lane.length - 45, 30 / 3.6, [conn.id, conn.to]);
    let held = '';
    for (let i = 0; i < 10 * 120; i++) {
      step();
      if (ai.hold) held = ai.hold;
    }
    const waiting = ai.seg === lane.id;
    // The player drives on out of the junction (40 m down the road): the AI goes on.
    const exit = graph.segs[conn.to];
    graph.sample(exit, Math.min(exit.length - 3, 40), smp);
    place(smp.x, smp.z, smp.heading);
    traffic.manual = true;
    const again = traffic.spawnForTest('sedan_red', lane.id, lane.length - 45, 30 / 3.6, [conn.id, conn.to]);
    for (let i = 0; i < 10 * 120; i++) step();
    const went = again.seg !== lane.id;
    check('the AI waits while the player stands in its junction, then goes', waiting && held === 'oyuncu' && went && traffic.stats().crashes === 0, `held (${held || '—'}) at the line: ${waiting}; went once clear: ${went}; crashes ${traffic.stats().crashes}`);
  }
  {
    // Hit an AI car from behind at speed: it becomes a wreck with hazard lights; removed once the player is far and time has passed.
    const lane = lanes.find((l) => l.cls === 'boulevard' && l.length > 150)!;
    graph.sample(lane, 20, smp);
    place(smp.x, smp.z, smp.heading, 50 / 3.6);
    const ai = traffic.spawnForTest('sedan_silver', lane.id, 45, 0);
    ai.desired = 0;
    let bodies = 0;
    for (let i = 0; i < 5 * 120; i++) {
      step({ throttle: 1, brake: 0, steer: 0, handbrake: 0 });
      bodies = Math.max(bodies, traffic.stats().bodies);
    }
    const wreck = ai.state === 'crashed' && ai.indicator === 2;
    place(track.spawn.position.x, track.spawn.position.z, track.spawn.yaw);
    check('a hit leaves a wreck with hazard lights (removed when the player leaves)', wreck && traffic.stats().crashes >= 1 && !traffic.vehicles.includes(ai), `state ${ai.state}, crashes ${traffic.stats().crashes}, removed: ${!traffic.vehicles.includes(ai)}; collision bodies ≤ ${bodies}`);
  }
  {
    traffic.manual = false;
    traffic.onTeleport();
    let maxBodies = 0;
    let farBody = 0;
    for (let i = 0; i < 30 * 120; i++) {
      step();
      if (i % 60) continue;
      maxBodies = Math.max(maxBodies, traffic.stats().bodies);
      for (const v of traffic.vehicles) if (v.body && Math.hypot(v.pose.x - p.position.x, v.pose.z - p.position.z) > CITY_TRAFFIC.nearRange + 20) farBody++;
    }
    check('collision bodies only near the player, from a small pool', maxBodies <= CITY_TRAFFIC.bodyPool && farBody === 0, `≤ ${maxBodies} bodies (pool ${CITY_TRAFFIC.bodyPool}), ${farBody} far vehicles with a body; ${traffic.vehicles.length} vehicles`);
    const clockOk = Math.abs(track.signalTime - traffic.time) < 1e-9;
    check('the drawn signals and the drivers share one clock', clockOk && traffic.time > 30, `track.signalTime ${track.signalTime.toFixed(2)} s = traffic ${traffic.time.toFixed(2)} s`);
  }
  traffic.dispose();

  section('Parked cars');
  const parked = new CityV2ParkedCars(data, json.layout.seed, false);
  const again = new CityV2ParkedCars(data, json.layout.seed, false);
  const other = new CityV2ParkedCars(data, 7, false);
  const spots = json.props!.spots[1];
  check('deterministic: same seed → same cars; another seed → others', digest(parked.cars) === digest(again.cars) && digest(parked.cars) !== digest(other.cars), `${parked.cars.length} cars on ${spots} stalls (${((100 * parked.cars.length) / spots).toFixed(0)} %), ${digest(parked.cars)} · ${digest(again.cars)} · seed 7 ${digest(other.cars)}`);
  {
    const byUse = new Map<string, [number, number]>();
    const f = data.f32;
    const [so, sn] = json.props!.spots;
    for (let i = 0; i < sn; i++) {
      const use = json.props!.lots[f[so + i * 4 + 3]].use;
      const e = byUse.get(use) ?? [0, 0];
      e[1]++;
      byUse.set(use, e);
    }
    // Count per use from the spot each car stands on.
    const at = new Map<string, number>();
    for (let i = 0; i < sn; i++) at.set(`${f[so + i * 4].toFixed(2)},${f[so + i * 4 + 1].toFixed(2)}`, i);
    for (const c of parked.cars) {
      const i = at.get(`${c.x.toFixed(2)},${c.z.toFixed(2)}`)!;
      byUse.get(json.props!.lots[f[so + i * 4 + 3]].use)![0]++;
    }
    const shares = [...byUse].map(([u, [n, t]]) => `${u} ${((100 * n) / t).toFixed(0)} %`);
    const fits = PARKED_MODELS.every((id) => TRAFFIC_CLASSES[id].length <= 4.85 && TRAFFIC_CLASSES[id].width <= 2.3);
    check('a share of the stalls by lot use; every model fits a 2.5 × 5 m stall', fits && [...byUse.values()].every(([n, t]) => n / t > 0.2 && n / t < 0.75), shares.join(', '));
  }
  {
    const s2 = await makeSim(false, 0, 0, 0, { track: 'city' });
    const tr = s2.track as CityV2Track;
    const q = new THREE.Vector3();
    const onRoad = parked.cars.filter((c) => [0, 1, 2, 3, 4].some((k) => {
      const b = parked.box(parked.cars.indexOf(c));
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      const [u, w] = [[0, 0], [1, 1], [1, -1], [-1, 1], [-1, -1]][k];
      q.set(c.x + fz * b.hx * u + fx * b.hz * w, 0, c.z - fx * b.hx * u + fz * b.hz * w);
      return tr.onRoad(q);
    }));
    // Buildings (their wall boxes) and each other.
    const f = data.f32;
    const rects: [number, number, number, number][] = [];
    for (const c of json.cells) for (let i = 0; i < c.boxes[1]; i++) {
      const o = c.boxes[0] + i * 10;
      rects.push([f[o] - f[o + 3], f[o + 2] - f[o + 5], f[o] + f[o + 3], f[o + 2] + f[o + 5]]);
    }
    const inBuilding = parked.cars.filter((c) => rects.some((r) => c.x > r[0] && c.x < r[2] && c.z > r[1] && c.z < r[3])).length;
    let overlaps = 0;
    const bins = new Map<string, number[]>();
    parked.cars.forEach((c, i) => {
      const k = `${Math.floor(c.x / 10)},${Math.floor(c.z / 10)}`;
      bins.set(k, [...(bins.get(k) ?? []), i]);
    });
    parked.cars.forEach((c, i) => {
      const a = parked.box(i);
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        for (const j of bins.get(`${Math.floor(c.x / 10) + dx},${Math.floor(c.z / 10) + dz}`) ?? []) {
          if (j <= i) continue;
          const b = parked.box(j);
          if (obbOverlap(a.x, a.z, a.yaw, a.hx - 0.05, a.hz - 0.05, b.x, b.z, b.yaw, b.hx - 0.05, b.hz - 0.05)) overlaps++;
        }
      }
    });
    check('parked cars off the road, out of buildings, clear of each other', onRoad.length === 0 && inBuilding === 0 && overlaps === 0, `${onRoad.length} touching a road, ${inBuilding} in a building, ${overlaps} overlapping pairs (${parked.cars.length} cars)`);
    // Colliders: only in the cells with physics; a parked car stops the player.
    let max = 0;
    const [ro, rn] = json.roads;
    for (let i = 0; i < rn; i += Math.floor(rn / 40)) {
      q.set(f[ro + i * 5], 0, f[ro + i * 5 + 2]);
      tr.stream(q);
      max = Math.max(max, tr.stats().parkedBoxes);
    }
    const target = parked.cars.reduce((best, c) => (Math.hypot(c.x - tr.spawn.position.x, c.z - tr.spawn.position.z) < Math.hypot(best.x - tr.spawn.position.x, best.z - tr.spawn.position.z) ? c : best));
    const yaw = target.yaw;
    const sx = target.x - Math.sin(yaw) * 9;
    const sz = target.z - Math.cos(yaw) * 9;
    tr.stream(new THREE.Vector3(sx, 0, sz), true);
    s2.vehicle.reset(new THREE.Vector3(sx, VehiclePhysics.restHeight(s2.config) + 0.17, sz), yaw);
    s2.vehicle.physics.body.setLinvel({ x: Math.sin(yaw) * 6, y: 0, z: Math.cos(yaw) * 6 }, true);
    for (let i = 0; i < 240; i++) {
      s2.vehicle.fixedUpdate(DT, { throttle: 0.3, brake: 0, steer: 0, handbrake: 0 });
      s2.physics.step();
      s2.vehicle.postPhysics();
      tr.stream(s2.vehicle.physics.position);
    }
    const pos = s2.vehicle.physics.position;
    const passed = (pos.x - target.x) * Math.sin(yaw) + (pos.z - target.z) * Math.cos(yaw);
    check('parked-car colliders streamed with the cells; a parked car stops the player', max > 0 && max < parked.cars.length * 0.3 && passed < -2, `${parked.cars.length} cars in town, ≤ ${max} boxes active; player ${(-passed).toFixed(1)} m short of the car's centre after 2 s at 22 km/h`);
    tr.dispose();
    s2.physics.dispose();
  }
  {
    // Drawing (stand-ins headless: no models load without a browser): by distance and view.
    const drawn = new CityV2ParkedCars(data, json.layout.seed, true);
    const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.25, 2000);
    const frustum = new THREE.Frustum();
    const at = (x: number, z: number, lx: number, lz: number) => {
      cam.position.set(x, 3, z);
      cam.lookAt(lx, 0, lz);
      cam.updateMatrixWorld();
      frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
      drawn.update(cam.position, frustum);
      return drawn.drawnNear + drawn.drawnFar;
    };
    const lot = json.props!.lots.find((l) => l.use === 'parking')!;
    const [ex, ez, eyaw] = lot.entrances[0];
    const looking = at(ex - Math.sin(eyaw) * 10, ez - Math.cos(eyaw) * 10, ex + Math.sin(eyaw) * 40, ez + Math.cos(eyaw) * 40);
    const away = at(ex - Math.sin(eyaw) * 200, ez - Math.cos(eyaw) * 200, ex - Math.sin(eyaw) * 300, ez - Math.cos(eyaw) * 300);
    const far = at(ex + 2000, ez + 2000, ex + 2100, ez + 2000);
    const t1 = performance.now();
    for (let i = 0; i < 300; i++) at(ex - Math.sin(eyaw) * 10 + i, ez - Math.cos(eyaw) * 10, ex + Math.sin(eyaw) * 40, ez + Math.cos(eyaw) * 40);
    const ms = (performance.now() - t1) / 300;
    check('parked cars drawn by distance and view (refills only on change)', looking > 20 && away < looking / 2 && far === 0 && ms < 0.3, `${looking} drawn looking into a lot, ${away} from 200 m out looking away, ${far} from 2.8 km; ${ms.toFixed(3)} ms per update (moving 1 m a frame)`);
    drawn.dispose();
  }
  track.dispose();
  s.physics.dispose();
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
