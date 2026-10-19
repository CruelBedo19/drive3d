/**
 * City map checks (headless: layout + collision data, no meshes): prepared
 * files and their sizes, cells, spawn and teleports on the road with all
 * wheels down, a drop test on road points across the town, colliders only
 * around the car while streaming, Shift+R to the nearest road, out-of-bounds,
 * and a drive through the streets.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { setCityAssets } from '../src/world/city/CityAssets';
import { parseCityData, type CityJson } from '../src/world/city/CityData';
import { CityTrack } from '../src/world/city/CityTrack';
import { check, finish, makeSim, section, upY } from './lib/sim';

const DIR = join(import.meta.dirname, '../public/assets/city');

function loadData() {
  const json = JSON.parse(readFileSync(join(DIR, 'city-data.json'), 'utf8')) as CityJson;
  const buf = readFileSync(join(DIR, 'city-data.bin'));
  const data = parseCityData(json, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  setCityAssets({ data, protos: new Map(), lods: new Map(), ground: new Map() });
  return data;
}

const grounded = (s: { vehicle: { physics: VehiclePhysics } }) => s.vehicle.physics.wheels.filter((w) => w.grounded).length;

async function main(): Promise<void> {
  section('Prepared files');
  const data = loadData();
  const j = data.json;
  const size = (f: string) => statSync(join(DIR, f)).size / 1e6;
  const total = size('city.glb') + size('city-data.bin') + size('city-data.json') + size('city-map.png');
  check('optimised city ≤ 25 MB (source 198 MB)', total < 25, `glb ${size('city.glb').toFixed(1)} + data ${size('city-data.bin').toFixed(1)} + json ${size('city-data.json').toFixed(2)} + map ${size('city-map.png').toFixed(2)} = ${total.toFixed(1)} MB`);
  const tris = j.protos.reduce((s, p) => s + p.tris, 0);
  check('cells of 250 m, prototypes, road points', j.cell === 250 && j.cells.length > 50 && j.protos.length > 100 && j.roads[1] > 2000, `${j.cells.length} cells, ${j.protos.length} prototypes (${tris} triangles), ${j.roads[1]} road points, ${j.teleports.length} zone teleports`);

  section('Spawn, teleports, drop test');
  const s = await makeSim(false, 0, 0, 0, { track: 'city' });
  const track = s.track as CityTrack;
  const place = (x: number, y: number, z: number, yaw: number) => {
    track.stream(new THREE.Vector3(x, y, z), true);
    s.physics.step();
    s.vehicle.reset(new THREE.Vector3(x, y + VehiclePhysics.restHeight(s.config) + 0.3, z), yaw);
  };
  const settle = (sec: number) => {
    for (let i = 0; i < sec * 120; i++) {
      s.vehicle.fixedUpdate(1 / 120, { throttle: 0, brake: 1, steer: 0, handbrake: 0 });
      s.physics.step();
      s.vehicle.postPhysics();
    }
  };
  const results: string[] = [];
  let bad = 0;
  for (const t of track.testPoints) {
    place(t.position.x, t.position.y, t.position.z, t.yaw);
    settle(2);
    const g = grounded(s);
    const dy = s.vehicle.physics.position.y - t.position.y;
    if (g < 4 || Math.abs(dy) > 1.5 || upY(s) < 0.9) bad++;
    results.push(`${t.id}:${g}w dy${dy.toFixed(2)}`);
  }
  check('spawn and every zone teleport: on the road, 4 wheels down, upright', bad === 0, results.join(', '));
  // Drop test on road points across the town.
  const f = data.f32;
  const [ro, rn] = j.roads;
  let tested = 0;
  let fails = 0;
  const failAt: string[] = [];
  for (let i = 0; i < rn; i += Math.max(1, Math.floor(rn / 120))) {
    const o = ro + i * 4;
    place(f[o], f[o + 1], f[o + 2], f[o + 3]);
    settle(1.2);
    tested++;
    const dy = s.vehicle.physics.position.y - f[o + 1];
    if (grounded(s) < 4 || Math.abs(dy) > 1.5) {
      fails++;
      if (failAt.length < 6) failAt.push(`(${f[o].toFixed(0)},${f[o + 1].toFixed(1)},${f[o + 2].toFixed(0)}) w${grounded(s)} dy${dy.toFixed(1)}`);
    }
  }
  check('drop test: the car stands on the streets everywhere', fails <= tested * 0.03, `${tested - fails}/${tested} road points fine${failAt.length ? `; e.g. ${failAt.join(' ')}` : ''}`);

  section('Streaming, respawn, bounds');
  {
    let maxPhysics = 0;
    let maxColliders = 0;
    const p = new THREE.Vector3();
    for (let i = 0; i < rn; i += Math.floor(rn / 40)) {
      const o = ro + i * 4;
      p.set(f[o], f[o + 1], f[o + 2]);
      track.stream(p);
      const st = track.stats();
      maxPhysics = Math.max(maxPhysics, st.physics);
      maxColliders = Math.max(maxColliders, st.colliders);
    }
    check('colliders only around the car (≤ 12 cells)', maxPhysics <= 12 && maxColliders < 4000, `≤ ${maxPhysics} physics cells, ≤ ${maxColliders} colliders, Rapier world ${s.physics.world.colliders.len()}`);
    const off = new THREE.Vector3(j.spawn.x + 37, j.spawn.y + 30, j.spawn.z + 23);
    const r = track.safeRespawn(off);
    check('Shift+R: nearest road point at street level', Math.hypot(r.position.x - off.x, r.position.z - off.z) < 80 && track.onRoad(r.position), `respawn ${Math.hypot(r.position.x - off.x, r.position.z - off.z).toFixed(1)} m away, on road ${track.onRoad(r.position)}`);
    const far = new THREE.Vector3(j.bounds.maxX + 400, 0, j.bounds.maxZ + 400);
    check('out of bounds beyond the map', track.outOfBounds(far) && !track.outOfBounds(track.spawn.position), 'ok');
  }

  section('Drive');
  {
    place(j.spawn.x, j.spawn.y, j.spawn.z, j.spawn.yaw);
    settle(1);
    const start = s.vehicle.physics.position.clone();
    let minUp = 1;
    let fell = false;
    for (let i = 0; i < 120 * 12; i++) {
      s.vehicle.fixedUpdate(1 / 120, { throttle: 0.6, brake: 0, steer: 0, handbrake: 0 });
      s.physics.step();
      s.vehicle.postPhysics();
      if (i % 12 === 0) track.stream(s.vehicle.physics.position);
      minUp = Math.min(minUp, upY(s));
      if (s.vehicle.physics.position.y < track.killHeight) fell = true;
    }
    const dist = s.vehicle.physics.position.distanceTo(start);
    check('drives along a street (12 s, gas, no steering): no falling through, stays upright', !fell && minUp > 0.8 && dist > 40, `${dist.toFixed(0)} m, min up ${minUp.toFixed(2)}`);
  }
  track.dispose();
  s.physics.dispose();
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void PhysicsWorld;
