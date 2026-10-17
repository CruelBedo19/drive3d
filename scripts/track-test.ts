/**
 * Nordschleife track checks: centre-line data, collider coverage, test points,
 * and (with --lap) a full lap with a centre-line-following autopilot (real
 * vehicle code). Part of `npm run test:sim`; `npm run test:track` adds the lap.
 */
import * as THREE from 'three';
import { NORDSCHLEIFE } from '../src/config/tracks';
import { RAPIER } from '../src/core/PhysicsWorld';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { NordschleifeTrack } from '../src/world/nordschleife/NordschleifeTrack';
import data from '../src/world/tracks/nordschleife.json';
import { check, finish, kmh, makeSim, run, runControls, section, upY, type Sim } from './lib/sim';

async function main(): Promise<void> {
  section('Centre line data (OpenStreetMap + SRTM)');
  {
    const pts = data.points;
    const n = pts.length;
    let len = 0;
    let maxGap = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
      len += d;
      maxGap = Math.max(maxGap, d);
    }
    check('lap length matches the real 20.8 km', len > 20500 && len < 21000, `${(len / 1000).toFixed(2)} km, ${n} points`);
    check('closed loop, evenly spaced', maxGap < data.spacing * 1.2, `largest gap ${maxGap.toFixed(1)} m (closing segment included)`);
    const ys = pts.map((p) => p[1]);
    const range = Math.max(...ys) - Math.min(...ys);
    check('real elevation range (~300 m)', range > 250 && range < 340, `${range.toFixed(0)} m`);
    const crossings = selfIntersections(pts);
    check('centre line never crosses itself', crossings === 0, `${crossings} crossings`);
    const names = ['Hatzenbach', 'Flugplatz', 'Adenauer Forst', 'Karussell', 'Pflanzgarten', 'Döttinger Höhe'];
    const missing = names.filter((name) => !data.corners.some((c) => c.name === name));
    check('corner names present', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${data.corners.length} named corners`);
  }

  section('Build and colliders');
  const t0 = performance.now();
  const s = await makeSim(false, 0, 0, 0, { track: 'nordschleife' });
  const buildMs = performance.now() - t0;
  const track = s.track as NordschleifeTrack;
  check('track builds quickly', buildMs < 3000, `${buildMs.toFixed(0)} ms (world + track + car), ${s.physics.world.colliders.len()} colliders, ${track.group.children.length} meshes`);
  run(s, 2, []);
  check('car settles at the spawn', upY(s) > 0.99 && kmh(s) < 1, `up ${upY(s).toFixed(3)}, ${kmh(s).toFixed(1)} km/h, ${s.vehicle.telemetry.groundedWheels} wheels down`);
  {
    // Down-rays across the cross-section every 25 m: the ground must be there, at road height.
    // Probes sit 1.3 m past each sample: a ray exactly on a triangle edge can miss in Rapier
    // (float edge case, ~0.1% of exact-edge rays), which says nothing about holes.
    const frames = track.curve.frames(25);
    const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const half = NORDSCHLEIFE.width / 2;
    const offsets = [0, half - 0.3, -(half - 0.3), half + NORDSCHLEIFE.shoulder - 0.6, -(half + NORDSCHLEIFE.shoulder - 0.6)];
    let misses = 0;
    let worst = 0;
    const at = new THREE.Vector3();
    for (let i = 0; i < frames.count; i++) {
      track.curve.pose(i * frames.step + 1.3, at);
      for (const off of offsets) {
        const x = frames.position[i * 3] + frames.left[i * 3] * off + frames.tangent[i * 3] * 1.3;
        const y = at.y;
        const z = frames.position[i * 3 + 2] + frames.left[i * 3 + 2] * off + frames.tangent[i * 3 + 2] * 1.3;
        ray.origin = { x, y: y + 3, z };
        const hit = s.physics.world.castRay(ray, 6, true, undefined, undefined, undefined, s.vehicle.physics.body);
        if (!hit) misses++;
        else worst = Math.max(worst, Math.abs(3 - hit.timeOfImpact));
      }
    }
    check('no holes: road and grass under every probe', misses === 0, `${frames.count * offsets.length} probes, ${misses} misses, max height error ${worst.toFixed(3)} m`);
  }

  section('Admin test points: teleport + 3 s full throttle');
  for (const p of track.testPoints) {
    const pos = p.position.clone();
    pos.y += VehiclePhysics.restHeight(s.config) + 0.05;
    s.vehicle.reset(pos, p.yaw);
    s.driving.reset();
    run(s, 3, ['KeyW']);
    const ok = s.vehicle.physics.position.y > track.killHeight && upY(s) > 0.9 && kmh(s) > 40;
    check(`${p.id}: drives off on the road`, ok, `${kmh(s).toFixed(0)} km/h, up ${upY(s).toFixed(2)}`);
  }

  // The lap takes ~2 min of CPU: `npm run test:track` runs it, `test:sim` skips it.
  if (process.argv.includes('--lap')) {
    section('Full lap, autopilot on the centre line (STREET, ≤ 130 km/h)');
    const lap = await makeSim(false, 0, 0, 0, { track: 'nordschleife' });
    const result = autopilotLap(lap, lap.track as NordschleifeTrack);
    check('completes a lap without leaving the track', result.done && result.maxOffset < NORDSCHLEIFE.width / 2 + NORDSCHLEIFE.shoulder, `${result.done ? 'lap' : 'stopped'} at ${(result.distance / 1000).toFixed(2)} km in ${formatTime(result.time)}, avg ${result.avgKmh.toFixed(0)} km/h, max ${result.maxKmh.toFixed(0)} km/h, max offset ${result.maxOffset.toFixed(2)} m, min up ${result.minUp.toFixed(2)}, max airtime ${result.maxAir.toFixed(2)} s`);
  }
  finish();
}

/** Pure-pursuit driver: steers at a point ahead on the centre line, speed from upcoming curvature. */
function autopilotLap(s: Sim, track: NordschleifeTrack) {
  const f = track.curve.frames(2);
  const n = f.count;
  let idx = nearest(f, s.vehicle.physics.position, 0, n);
  const startIdx = idx;
  let travelled = 0;
  let maxOffset = 0;
  let maxKmh = 0;
  let minUp = 1;
  let air = 0;
  let maxAir = 0;
  let done = false;
  const target = new THREE.Vector3();
  const maxSteps = 120 * 60 * 20;
  let steps = 0;
  runControls(s, maxSteps / 120, (x) => {
    const p = x.vehicle.physics;
    const prev = idx;
    idx = nearest(f, p.position, idx, 40);
    travelled += ((idx - prev + n) % n) * f.step;
    if (travelled > f.length - 20 && ((idx - startIdx + n) % n) < 20) {
      done = true;
      return true;
    }
    const lateral = (p.position.x - f.position[idx * 3]) * f.left[idx * 3] + (p.position.z - f.position[idx * 3 + 2]) * f.left[idx * 3 + 2];
    maxOffset = Math.max(maxOffset, Math.abs(lateral));
    const v = Math.max(0, p.forwardSpeed);
    const look = Math.round(Math.max(8, v * 0.6) / f.step);
    const ti = (idx + look) % n;
    target.set(f.position[ti * 3], f.position[ti * 3 + 1], f.position[ti * 3 + 2]).sub(p.position);
    const angle = Math.atan2(target.dot(p.left), target.dot(p.forward));
    x.controls.steer = Math.max(-1, Math.min(1, -angle * 3));
    let kMax = 0;
    for (let k = 0; k < Math.round(Math.max(60, v * 3) / f.step); k++) kMax = Math.max(kMax, Math.abs(f.curvature[(idx + k) % n]));
    const vTarget = Math.min(130 / 3.6, Math.sqrt((0.75 * 9.81) / Math.max(kMax, 1e-4)));
    x.controls.throttle = v < vTarget - 1 ? 1 : 0;
    x.controls.brake = v > vTarget + 2 ? Math.min(1, (v - vTarget) / 6) : 0;
    x.controls.handbrake = 0;
    maxKmh = Math.max(maxKmh, kmh(x));
    minUp = Math.min(minUp, upY(x));
    if (x.vehicle.telemetry.groundedWheels === 0) {
      air += 1 / 120;
      maxAir = Math.max(maxAir, air);
    } else air = 0;
    if (p.position.y < track.killHeight || upY(x) < 0.5 || maxOffset > 15) return true;
    steps++;
  });
  return { done, distance: travelled, time: steps / 120, avgKmh: (travelled / Math.max(1, steps / 120)) * 3.6, maxKmh, maxOffset, minUp, maxAir };
}

function nearest(f: { count: number; position: Float32Array }, p: THREE.Vector3, around: number, window: number): number {
  let best = around;
  let bestD = Infinity;
  const from = window >= f.count ? 0 : around - window;
  const to = window >= f.count ? f.count : around + window;
  for (let k = from; k < to; k++) {
    const i = ((k % f.count) + f.count) % f.count;
    const d = (f.position[i * 3] - p.x) ** 2 + (f.position[i * 3 + 2] - p.z) ** 2 + (f.position[i * 3 + 1] - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Plan-view segment crossings between non-adjacent segments (grid accelerated). */
function selfIntersections(pts: number[][]): number {
  const n = pts.length;
  const cell = 40;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    for (const [x, z] of [[a[0], a[2]], [b[0], b[2]]]) {
      const key = `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
      const list = grid.get(key) ?? [];
      if (!list.includes(i)) list.push(i);
      grid.set(key, list);
    }
  }
  let count = 0;
  const seen = new Set<string>();
  for (const list of grid.values()) {
    for (const i of list) {
      for (const j of list) {
        if (j <= i + 1 || (i === 0 && j === n - 1)) continue;
        const key = `${i},${j}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) count++;
      }
    }
  }
  return count;
}

function segmentsCross(a: number[], b: number[], c: number[], d: number[]): boolean {
  const o = (p: number[], q: number[], r: number[]) => (q[0] - p[0]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[0] - p[0]);
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
