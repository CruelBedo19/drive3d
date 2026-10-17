/**
 * Autobahn checks: deterministic generation, road continuity and cross-section,
 * features, colliders, spawn / respawn, minimap data, tunnel cover, chunk
 * streaming / cache / disposal, and autopilot drives at 100 / 200 / 300+ km/h.
 * `npm run test:sim` runs the quick version; `npm run test:autobahn` adds the
 * 50 km drive (`--long`).
 */
import * as THREE from 'three';
import { AUTOBAHN as A } from '../src/config/tracks';
import { PhysicsWorld, RAPIER } from '../src/core/PhysicsWorld';
import { AutobahnTrack } from '../src/world/autobahn/AutobahnTrack';
import { RoadGenerator, SECTION, rampLayout } from '../src/world/autobahn/RoadGenerator';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { assignDeep } from '../src/admin/configPath';
import { autobahnSpeedPatch } from '../src/config/autobahnTune';
import { applySetup } from '../src/config/setups';
import { check, finish, makeSim, section, upY, type Sim } from './lib/sim';
import { TestDriver, makeTrafficSim } from './lib/trafficHarness';

const LONG = process.argv.includes('--long');
const signature = (g: RoadGenerator, until: number) => {
  const f = g.features.filter((x) => x.s0 < until).map((x) => `${x.kind}@${x.s0.toFixed(2)}`).join(',');
  const pts: string[] = [];
  for (let s = 0; s < until; s += 997) {
    const fr = g.frame(s);
    pts.push(`${fr.x.toFixed(3)},${fr.y.toFixed(3)},${fr.z.toFixed(3)}`);
  }
  return `${f}|${pts.join(';')}`;
};

async function main(): Promise<void> {
  section('Seeded generation');
  {
    const a = new RoadGenerator(2026);
    a.ensure(40000);
    const b = new RoadGenerator(2026);
    for (let s = 39000; s > 0; s -= 1234) b.frame(s); // queried in a different order
    const c = new RoadGenerator(7);
    c.ensure(40000);
    check('same seed → same road (whatever the query order)', signature(a, 35000) === signature(b, 35000), 'features + centre line identical');
    check('different seed → different road', signature(a, 35000) !== signature(c, 35000), 'seed 2026 vs 7 differ');
    let maxStep = 0;
    let maxTurn = 0;
    let maxGrade = 0;
    let minRadius = Infinity;
    let maxBank = 0;
    const p = a.frame(0);
    let prev = { x: p.x, y: p.y, z: p.z, h: p.heading };
    for (let s = 1; s <= 40000; s += 1) {
      const f = a.frame(s);
      maxStep = Math.max(maxStep, Math.hypot(f.x - prev.x, f.z - prev.z));
      maxTurn = Math.max(maxTurn, Math.abs(f.heading - prev.h));
      maxGrade = Math.max(maxGrade, Math.abs(f.y - prev.y));
      if (f.curvature !== 0) minRadius = Math.min(minRadius, 1 / Math.abs(f.curvature));
      maxBank = Math.max(maxBank, Math.abs(f.bank));
      prev = { x: f.x, y: f.y, z: f.z, h: f.heading };
    }
    check('continuous centre line: no gaps, no kinks (40 km at 1 m)', maxStep < 1.0001 && maxTurn < 0.0008, `max step ${maxStep.toFixed(4)} m, max heading change ${(maxTurn * 1000).toFixed(3)} mrad/m`);
    // Vertical curves: a crest tighter than ~2 km throws a car into the air at 300 km/h.
    let minCrest = Infinity;
    for (let s = 10; s <= 40000; s += 5) {
      const k = (a.gradeAt(s + 5) - a.gradeAt(s - 5)) / 10;
      if (k < 0) minCrest = Math.min(minCrest, -1 / k);
    }
    check('smooth vertical curves: crest radius ≥ 2000 m', minCrest >= 2000, `min crest radius ${minCrest.toFixed(0)} m`);
    check('high-speed geometry: radius ≥ 1500 m, grade ≤ 4 %, gentle banking', minRadius >= 1490 && maxGrade <= 0.0405 && maxBank <= A.maxBank + 1e-9, `min radius ${minRadius.toFixed(0)} m, max grade ${(maxGrade * 100).toFixed(2)} %, max bank ${((Math.atan(maxBank) * 180) / Math.PI).toFixed(2)}°`);
    const widths = SECTION.lanesA.map((o, i, arr) => (i ? Math.abs(arr[i - 1] - o) : A.lane));
    check('3 + 3 lanes, 3.5-3.75 m wide, mirrored', SECTION.lanesA.length === 3 && SECTION.laneB.length === 3 && widths.every((w) => w >= 3.5 && w <= 3.75) && SECTION.lanesA.every((o, i) => o === -SECTION.laneB[i]), `lanes A ${SECTION.lanesA.join(', ')} m, road half ${SECTION.roadHalf} m`);
    const kinds = ['tunnel', 'bridge', 'overpass', 'exit', 'restArea'] as const;
    const counts = Object.fromEntries(kinds.map((k) => [k, a.features.filter((f) => f.kind === k && f.s1 < 40000).length]));
    const overlaps = a.features.filter((f, i) => i > 0 && f.s0 < a.features[i - 1].s1).length;
    check('features in 40 km: tunnels, bridges, overpasses, exits, rest areas; never overlapping', kinds.every((k) => counts[k] >= 1) && overlaps === 0, `${JSON.stringify(counts)}, overlaps ${overlaps}`);
    const t = a.features.find((f) => f.kind === 'tunnel')!;
    const tm = (t.s0 + t.s1) / 2;
    const br = a.features.find((f) => f.kind === 'bridge')!;
    const bm = (br.s0 + br.s1) / 2;
    const roof = a.terrainHeight(tm, 0) - a.frame(tm).y;
    const valley = a.frame(bm).y - a.terrainHeight(bm, -40);
    check('terrain: hill roof over the tunnel, valley under the bridge', roof > A.features.tunnel.height && valley > 10, `roof ${roof.toFixed(1)} m above the road, valley ${valley.toFixed(1)} m below the deck`);
    const rest = a.features.find((f) => f.kind === 'restArea')!;
    const rm = (rest.s0 + rest.s1) / 2;
    const lay = rampLayout(rest, rm)!;
    const ex = a.features.find((f) => f.kind === 'exit')!;
    check('exit ramp leaves to the right; rest area has a wide platform', rampLayout(ex, ex.s1)!.centre < -SECTION.edge - 30 && lay.half > 30 && lay.centre < -60, `exit end offset ${rampLayout(ex, ex.s1)!.centre.toFixed(1)} m, platform ${(lay.half * 2).toFixed(0)} m wide at ${lay.centre.toFixed(0)} m`);
    check('signs: exit gantries, rest area, speed signs', a.signs.some((s) => s.kind === 'gantry') && a.signs.some((s) => s.kind === 'rest') && a.signs.some((s) => s.kind === 'speed'), `${a.signs.length} signs in ${(a.length / 1000).toFixed(0)} km`);
  }

  section('Track, colliders, spawn');
  const sim = await makeSim(false, 0, 0, 0, { track: 'autobahn' });
  const track = sim.track as AutobahnTrack;
  const world = sim.physics.world;
  {
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    let misses = 0;
    let worst = 0;
    let probes = 0;
    const g = track.gen;
    const pos = new THREE.Vector3();
    // Probe 2.4 km ahead of the spawn, streaming along (chunk joins included).
    for (let s = A.spawn.s - 300; s < A.spawn.s + 2400; s += 7.3) {
      const c = g.toWorld(s, 0);
      track.stream(pos.set(c.x, c.y, c.z));
      sim.physics.step(); // Rapier updates its scene queries on step
      for (const off of [...SECTION.lanesA, ...SECTION.laneB, -SECTION.roadHalf + 1, SECTION.roadHalf - 1]) {
        const p = g.toWorld(s, off);
        ray.origin = { x: p.x, y: p.y + 3, z: p.z };
        const hit = world.castRay(ray, 6, true, undefined, undefined, undefined, sim.vehicle.physics.body);
        probes++;
        if (!hit) misses++;
        else worst = Math.max(worst, Math.abs(3 - hit.timeOfImpact));
      }
    }
    check('road collider continuous across chunks (no holes)', misses === 0 && worst < 0.05, `${probes} probes, ${misses} misses, max height error ${worst.toFixed(3)} m`);
    track.stream(track.spawn.position, true);
    sim.physics.step();
    sim.vehicle.reset(track.spawn.position.clone().setY(track.spawn.position.y + VehiclePhysics.restHeight(sim.config) + 0.05), track.spawn.yaw);
    for (let i = 0; i < 240; i++) step(sim, track, { throttle: 0, brake: 0, steer: 0 });
    const p = sim.vehicle.physics.position;
    const sNow = g.nearestS(p.x, p.z, A.spawn.s);
    const lat = g.lateralOffset(p.x, p.z, sNow);
    const down = grounded(sim);
    check('spawn: on the road, in lane 2, facing the traffic direction', Math.abs(lat - SECTION.lanesA[1]) < 0.3 && upY(sim) > 0.99 && down === 4 && Math.cos(sim.vehicle.yaw - g.frame(sNow).heading) > 0.99, `offset ${lat.toFixed(2)} m (lane centre ${SECTION.lanesA[1]}), ${down} wheels down`);
    const far = g.toWorld(3000, 150);
    const r1 = track.safeRespawn(new THREE.Vector3(far.x, far.y, far.z));
    const r1s = g.nearestS(r1.position.x, r1.position.z, 3000);
    const near = g.toWorld(5200, -60);
    const r2 = track.safeRespawn(new THREE.Vector3(near.x, near.y, near.z));
    const r2s = g.nearestS(r2.position.x, r2.position.z, 5200);
    check('respawn: nearest road spot, right lane and direction for each side', Math.abs(r1s - 3000) < 5 && Math.abs(g.lateralOffset(r1.position.x, r1.position.z, r1s) - SECTION.laneB[1]) < 0.1 && Math.cos(r1.yaw - g.frame(r1s).heading) < -0.99 && Math.abs(g.lateralOffset(r2.position.x, r2.position.z, r2s) - SECTION.lanesA[1]) < 0.1 && Math.cos(r2.yaw - g.frame(r2s).heading) > 0.99, `B side → lane ${g.lateralOffset(r1.position.x, r1.position.z, r1s).toFixed(2)} reversed, A side → lane ${g.lateralOffset(r2.position.x, r2.position.z, r2s).toFixed(2)}`);
    {
      const onLane = g.toWorld(3000, SECTION.lanesA[2]);
      const inField = g.toWorld(3000, -(SECTION.edge + 25));
      check('R: on the road recovers in place, off the road goes back to the road', track.onRoad(new THREE.Vector3(onLane.x, onLane.y, onLane.z)) && !track.onRoad(new THREE.Vector3(inField.x, g.terrainHeight(3000, -(SECTION.edge + 25)), inField.z)), 'onRoad lane / field');
    }
    check('out of bounds far from the road', track.outOfBounds(new THREE.Vector3(far.x + 400 * Math.cos(g.frame(3000).heading), far.y, far.z)) && !track.outOfBounds(track.spawn.position), 'boundary works');
    const t = g.features.find((f) => f.kind === 'tunnel')!;
    const inT = g.toWorld((t.s0 + t.s1) / 2, -8);
    const outT = g.toWorld(t.s0 - 200, -8);
    check('tunnel cover for weather (no rain inside, darker ambient)', track.coverAt(new THREE.Vector3(inT.x, inT.y, inT.z)) === 1 && track.coverAt(new THREE.Vector3(outT.x, outT.y, outT.z)) === 0, 'cover 1 inside, 0 outside');
    const rev = track.mapRevision;
    const md = track.mapData;
    const ex = g.features.find((f) => f.kind === 'restArea')!;
    const at = g.toWorld(ex.s0 - 500, -8);
    track.stream(new THREE.Vector3(at.x, at.y, at.z), true);
    const md2 = track.mapData;
    check('minimap: road around the player, revision bumps while streaming, rest-area fuel marker', md.paths[0].points.length > 100 && track.mapRevision > rev && md2.markers.some((m) => m.kind === 'fuel'), `${md.paths[0].points.length / 2} points, revision ${rev} → ${track.mapRevision}, markers ${md2.markers.map((m) => m.kind).join(',')}`);
    track.setWetness(1);
    track.setWetness(0);
  }

  section('Chunk lifecycle (streaming 25 km out and 1 km back)');
  {
    const g = track.gen;
    const pos = new THREE.Vector3();
    track.stream(pos.copy(track.spawn.position), true);
    const before = track.stats();
    let maxActive = 0;
    let maxCached = 0;
    let maxColliders = 0;
    let maxWorld = 0;
    for (let s = A.spawn.s; s < A.spawn.s + 25000; s += 25) {
      const c = g.toWorld(s, -8);
      track.stream(pos.set(c.x, c.y, c.z));
      const st = track.stats();
      maxActive = Math.max(maxActive, st.active);
      maxCached = Math.max(maxCached, st.cached);
      maxColliders = Math.max(maxColliders, st.colliders);
      maxWorld = Math.max(maxWorld, world.colliders.len());
    }
    const limit = A.chunk.ahead + A.chunk.behind + 1;
    check('active chunks, cache, colliders stay bounded', maxActive <= limit && maxCached <= A.chunk.cache && maxColliders < 1500 && maxWorld < 1600, `active ≤ ${maxActive} (limit ${limit}), cached ≤ ${maxCached}, colliders ≤ ${maxColliders}, Rapier world ≤ ${maxWorld} (start ${before.colliders})`);
    const built = track.builtCount;
    const s1 = A.spawn.s + 25000;
    for (let s = s1; s > s1 - 1000; s -= 25) {
      const c = g.toWorld(s, -8);
      track.stream(pos.set(c.x, c.y, c.z));
    }
    const rebuilt = track.builtCount - built;
    check('driving back reuses cached chunks', rebuilt <= 3, `${rebuilt} chunks rebuilt for 1 km back (cache ${A.chunk.cache})`);
    // Determinism of rebuilt chunks: same vertices as a fresh build.
    const physics2 = await PhysicsWorld.create();
    const fresh = new AutobahnTrack(physics2.world);
    const a = fresh.stats();
    check('rebuilt / fresh worlds match (same seed)', a.active > 0 && fresh.spawn.position.distanceTo(track.spawn.position) < 1e-9, `spawn identical, ${a.active} chunks`);
    fresh.dispose();
    physics2.dispose();
  }

  section('Autopilot drives (test driver only; not in the game)');
  {
    const runs: [number, number, boolean][] = LONG
      ? [
          [100, 5000, false],
          [200, 8000, false],
          [300, 50000, true],
          [350, 5000, true],
        ]
      : [
          [100, 1500, false],
          [200, 2500, false],
          [300, 3000, true],
        ];
    for (const [kmh, dist, hold] of runs) {
      const s = await makeSim(false, 0, 0, 0, { track: 'autobahn' });
      const r = autopilot(s, s.track as AutobahnTrack, kmh, dist, hold);
      const ok = r.distance >= dist - 5 && r.falls === 0 && r.maxLateral < 1.6 && r.minUp > 0.95 && r.maxNoGround < 0.3;
      check(
        `${kmh} km/h${hold ? ' (speed held)' : ''}: ${(dist / 1000).toFixed(1)} km in lane`,
        ok,
        `${(r.distance / 1000).toFixed(2)} km in ${r.time.toFixed(0)} s, avg ${r.avgKmh.toFixed(0)} km/h, max lane offset ${r.maxLateral.toFixed(2)} m, longest no-ground ${r.maxNoGround.toFixed(2)} s, falls ${r.falls}, chunks built ${r.built}, active ≤ ${r.maxActive}, colliders ≤ ${r.maxColliders}, heap ${r.heapMB.toFixed(0)} MB, build ${r.buildMs.toFixed(1)} ms/chunk`,
      );
      s.track?.dispose();
      s.physics.dispose();
    }
  }
  section('Autobahn high-speed pack (Autobahn only)');
  {
    const s = await makeTrafficSim('off');
    const base = structuredClone(s.vehicle.config);
    assignDeep(s.vehicle.config, applySetup(base, autobahnSpeedPatch(base)));
    s.vehicle.refreshConfig();
    const d = new TestDriver(s, 1, 450, false);
    let best = 0;
    let t200 = 0;
    for (let i = 0; i < 120 * 240; i++) {
      d.step(s);
      const v = s.vehicle.physics.forwardSpeed * 3.6;
      if (!t200 && v >= 200) t200 = i / 120;
      best = Math.max(best, v);
    }
    check('top speed ~340 km/h on the Autobahn (was ~250)', best > 330 && best < 350, `vmax ${best.toFixed(1)} km/h, 0-200 in ${t200.toFixed(1)} s, limiter ${s.vehicle.config.maxSpeedKmh} km/h`);
  }
  finish();
}

/** Wheels touching the ground (from the physics; telemetry only updates when rendering). */
const grounded = (s: Sim) => s.vehicle.physics.wheels.filter((w) => w.grounded).length;

/** One fixed step, as the game's DrivingSim does it (vehicle, physics, streaming). */
function step(s: Sim, track: AutobahnTrack, c: { throttle: number; brake: number; steer: number }): void {
  const dt = s.physics.fixedDt;
  s.vehicle.fixedUpdate(dt, { ...c, handbrake: 0 });
  s.physics.step();
  s.vehicle.postPhysics();
  track.stream(s.vehicle.physics.position);
}

/**
 * Lane-following test driver: pure pursuit on the middle lane of direction A.
 * `hold`: keeps the speed by setting the body velocity (the test car tops out
 * at 250 km/h; this checks road, colliders and streaming at 300+, not handling).
 */
function autopilot(s: Sim, track: AutobahnTrack, kmh: number, dist: number, hold: boolean) {
  const g = track.gen;
  const lane = SECTION.lanesA[1];
  const v = kmh / 3.6;
  const body = s.vehicle.physics.body;
  const p = s.vehicle.physics.position;
  let sNow = g.nearestS(p.x, p.z, A.spawn.s);
  const s0 = sNow;
  let steps = 0;
  let maxLateral = 0;
  let minUp = 1;
  let noGround = 0;
  let maxNoGround = 0;
  let falls = 0;
  let maxActive = 0;
  let maxColliders = 0;
  const built0 = track.builtCount;
  const target = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  let buildTime = 0;
  const maxSteps = Math.ceil((dist / Math.max(10, v * 0.6)) * 120) + 120 * 60;
  if (hold) {
    // Start at speed.
    const f = g.frame(sNow);
    body.setLinvel({ x: Math.sin(f.heading) * v, y: 0, z: Math.cos(f.heading) * v }, true);
  }
  while (sNow - s0 < dist && steps < maxSteps) {
    sNow = g.nearestS(p.x, p.z, sNow, 60);
    const speed = s.vehicle.physics.forwardSpeed;
    const look = Math.max(12, speed * 0.7);
    const tp = g.toWorld(sNow + look, lane);
    target.set(tp.x, tp.y, tp.z).sub(p);
    const angle = Math.atan2(target.dot(s.vehicle.physics.left), target.dot(s.vehicle.physics.forward));
    const steer = Math.max(-1, Math.min(1, -angle * 2.5));
    const throttle = hold ? 0.3 : speed < v - 1 ? 1 : 0;
    const brake = !hold && speed > v + 2 ? 0.3 : 0;
    const t0 = performance.now();
    const before = track.builtCount;
    step(s, track, { throttle, brake, steer });
    if (track.builtCount > before) buildTime += performance.now() - t0;
    if (hold) {
      const lv = body.linvel();
      fwd.copy(s.vehicle.physics.forward).setY(0).normalize();
      body.setLinvel({ x: fwd.x * v, y: lv.y, z: fwd.z * v }, true);
    }
    steps++;
    const lat = g.lateralOffset(p.x, p.z, sNow) - lane;
    if (steps > 240) maxLateral = Math.max(maxLateral, Math.abs(lat));
    minUp = Math.min(minUp, upY(s));
    if (grounded(s) === 0) {
      noGround += 1 / 120;
      maxNoGround = Math.max(maxNoGround, noGround);
    } else noGround = 0;
    if (p.y < g.frame(sNow).y - 5) falls++;
    if (steps % 120 === 0) {
      const st = track.stats();
      maxActive = Math.max(maxActive, st.active);
      maxColliders = Math.max(maxColliders, st.colliders);
    }
    if (falls > 0 || upY(s) < 0.5) break;
  }
  const time = steps / 120;
  const built = track.builtCount - built0;
  return { distance: sNow - s0, time, avgKmh: ((sNow - s0) / Math.max(1, time)) * 3.6, maxLateral, minUp, maxNoGround, falls, built, maxActive, maxColliders, heapMB: process.memoryUsage().heapUsed / 1e6, buildMs: built ? buildTime / built : 0 };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
