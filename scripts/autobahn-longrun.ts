/**
 * 100 km long run on the Autobahn with AI traffic (medium) and the infinite
 * landscape running as in the game: 20 km at 130 km/h, 30 km at 200 km/h,
 * 50 km at 300 km/h (speed held by the test harness only; the test car tops
 * out at 250 km/h). A careful test driver keeps its distance and picks lanes.
 *
 * Checked: road gaps (wheels off the ground / falls), landscape coverage,
 * AI crashes and overlaps, unsafe lane changes, player tunnelling through AI,
 * bounded chunks / tiles / traffic / colliders, heap growth, generation and
 * traffic update times. `npm run test:longrun`.
 */
import * as THREE from 'three';
import { AUTOBAHN as A } from '../src/config/tracks';
import { TerrainTiles } from '../src/world/autobahn/TerrainTiles';
import { check, finish, section } from './lib/sim';
import { TestDriver, makeTrafficSim } from './lib/trafficHarness';

const SEGMENTS = [
  { km: 20, kmh: 130, hold: false },
  { km: 30, kmh: 200, hold: false },
  { km: 50, kmh: 300, hold: true },
];

async function main(): Promise<void> {
  const s = await makeTrafficSim('medium');
  const t = s.traffic;
  const track = s.track;
  const cam = new THREE.Vector3();
  const heap0 = process.memoryUsage().heapUsed;
  let heapMax = heap0;
  let maxActive = 0;
  let maxColliders = 0;
  let maxWorld = 0;
  let maxTraffic = 0;
  let maxTiles = 0;
  let maxFrameGen = 0;
  let genTotal = 0;
  let frames = 0;
  let trafficMs = 0;
  let trafficSteps = 0;
  let maxOverlap = 0;
  let coverageHoles = 0;
  let tunnelling = 0;
  let falls = 0;
  let noGround = 0;
  let maxNoGround = 0;
  let playerHits = 0;
  const results: string[] = [];
  const t0 = performance.now();
  for (const seg of SEGMENTS) {
    section(`${seg.km} km at ${seg.kmh} km/h${seg.hold ? ' (speed held)' : ''}`);
    const driver = new TestDriver(s, 1, seg.kmh, seg.hold, true);
    const start = driver.s;
    let steps = 0;
    let speedSum = 0;
    let maxSpeed = 0;
    let atTarget = 0;
    const crashes0 = t.stats().crashes;
    while (driver.s - start < seg.km * 1000 && steps < 120 * 3600) {
      const ta = performance.now();
      driver.step(s);
      steps++;
      trafficSteps++;
      speedSum += s.vehicle.physics.forwardSpeed;
      maxSpeed = Math.max(maxSpeed, s.vehicle.physics.forwardSpeed);
      if (s.vehicle.physics.forwardSpeed * 3.6 > seg.kmh * 0.95) atTarget++;
      const ph = s.vehicle.physics;
      if (ph.wheels.every((w) => !w.grounded)) {
        noGround += 1 / 120;
        maxNoGround = Math.max(maxNoGround, noGround);
      } else noGround = 0;
      if (ph.position.y < track.gen.frame(driver.s).y - 5) {
        falls++;
        break;
      }
      // Player passing through an AI body without any contact.
      for (const v of t.vehicles) {
        if (v.carriageway !== t.playerCarriageway || v.state === 'crashed') continue;
        if (Math.abs(v.s - driver.s) < 1 && Math.abs(v.lanePos - t.playerLanePos) < 0.3) tunnelling++;
      }
      void ta;
      // Render frames at 60 Hz: landscape update with the game's budget.
      if (steps % 2 === 0) {
        cam.copy(ph.position).add(new THREE.Vector3(-Math.sin(s.vehicle.yaw) * 6, 2.2, -Math.cos(s.vehicle.yaw) * 6));
        const tg = performance.now();
        track.update({ camera: cam, vegetationDistance: 450, cameraFar: A.fog.far * 1.2 });
        const gen = performance.now() - tg;
        maxFrameGen = Math.max(maxFrameGen, gen);
        genTotal += gen;
        frames++;
      }
      if (steps % 120 === 0) {
        const st = track.stats();
        const ts = t.stats();
        maxActive = Math.max(maxActive, st.active);
        maxColliders = Math.max(maxColliders, st.colliders);
        maxWorld = Math.max(maxWorld, s.physics.world.colliders.len());
        maxTraffic = Math.max(maxTraffic, ts.active);
        trafficMs += ts.updateMs;
        maxTiles = Math.max(maxTiles, track.worldStats().visible.reduce((a, b) => a + b, 0));
        maxOverlap = Math.max(maxOverlap, t.overlaps());
        heapMax = Math.max(heapMax, process.memoryUsage().heapUsed);
      }
      if (steps % (120 * 30) === 0) {
        // Coverage: the visible tiles cover ±3 km around the camera once the queue is empty.
        const ws = track.worldStats();
        if (ws.queued === 0) {
          const keys = track.landscape.visibleTiles.map((k) => k.split(':').map(Number));
          for (let dx = -3000; dx <= 3000; dx += 250)
            for (let dz = -3000; dz <= 3000; dz += 250) {
              const x = cam.x + dx;
              const z = cam.z + dz;
              if (!keys.some(([lv, tx, tz]) => x >= tx * TerrainTiles.size(lv) && x < (tx + 1) * TerrainTiles.size(lv) && z >= tz * TerrainTiles.size(lv) && z < (tz + 1) * TerrainTiles.size(lv))) coverageHoles++;
            }
        }
      }
    }
    const time = steps / 120;
    const crashes = t.stats().crashes - crashes0;
    playerHits += crashes;
    const line = `${((driver.s - start) / 1000).toFixed(1)} km in ${time.toFixed(0)} s, avg ${((speedSum / steps) * 3.6).toFixed(0)} km/h, max ${(maxSpeed * 3.6).toFixed(0)}, ${((atTarget / steps) * 100).toFixed(0)} % of the time at target (traffic holds it back otherwise), AI crashes ${crashes}, lane changes ${t.stats().laneChanges}`;
    results.push(line);
    check(`${seg.km} km at ${seg.kmh} km/h completed`, driver.s - start >= seg.km * 1000 - 5 && falls === 0, line);
  }
  const ts = t.stats();
  section('Totals (100 km)');
  check('road: no falls, no long airtime', falls === 0 && maxNoGround < 0.3, `falls ${falls}, longest no-ground ${maxNoGround.toFixed(2)} s`);
  check('landscape: no coverage holes around the camera', coverageHoles === 0, `holes ${coverageHoles}, visible tiles ≤ ${maxTiles}`);
  check('AI: no overlaps, no unsafe lane changes', maxOverlap === 0 && t.unsafeLaneChanges === 0, `max overlapping pairs ${maxOverlap}, unsafe lane changes ${t.unsafeLaneChanges}, lane changes ${ts.laneChanges} (rejected ${ts.rejectedLaneChanges}, aborted ${ts.abortedLaneChanges})`);
  check('AI crashes only from player contact (none here: careful driver)', ts.crashes === 0, `crashes ${ts.crashes}`);
  check('no tunnelling through AI', tunnelling === 0, `steps with the player inside an AI body ${tunnelling}`);
  check('bounded: chunks, colliders, traffic', maxActive <= A.chunk.ahead + A.chunk.behind + 1 && maxTraffic <= 36 && maxWorld < 1100, `active chunks ≤ ${maxActive}, track colliders ≤ ${maxColliders}, Rapier world ≤ ${maxWorld}, traffic ≤ ${maxTraffic}, spawned ${ts.spawned}, despawned ${ts.despawned}`);
  const heap1 = process.memoryUsage().heapUsed;
  check('memory: heap stays flat', heapMax - heap0 < 250e6, `heap ${(heap0 / 1e6).toFixed(0)} → ${(heap1 / 1e6).toFixed(0)} MB (max ${(heapMax / 1e6).toFixed(0)})`);
  check('generation and traffic update times', genTotal / frames < 6 && trafficMs / Math.max(1, trafficSteps / 120) < 0.5, `landscape+road per frame avg ${(genTotal / frames).toFixed(2)} ms, worst ${maxFrameGen.toFixed(1)} ms; traffic per step avg ${(trafficMs / Math.max(1, trafficSteps / 120)).toFixed(3)} ms (node)`);
  console.log(`\nwall time ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  void playerHits;
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
