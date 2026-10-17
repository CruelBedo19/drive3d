/** Measures CPU cost of one physics step (vehicle forces + Rapier) on the test track. */
import * as THREE from 'three';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { placeholderStreet } from '../src/config/vehicles/placeholderStreet';
import { Vehicle } from '../src/vehicle/Vehicle';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { PlaceholderCarVisual } from '../src/vehicle/visual/PlaceholderCarVisual';
import { TestTrack } from '../src/world/TestTrack';

const physics = await PhysicsWorld.create();
new TestTrack(physics.world);
const cfg = placeholderStreet.physics;
const v = new Vehicle(physics.world, cfg, new PlaceholderCarVisual(cfg, placeholderStreet.visual), new THREE.Vector3(60, VehiclePhysics.restHeight(cfg), -80), 0);
const controls = { throttle: 1, brake: 0, steer: 0.3, handbrake: 0 };
const N = 6000;
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  v.fixedUpdate(physics.fixedDt, controls);
  physics.step();
  v.postPhysics();
}
const ms = (performance.now() - t0) / N;
console.log(`${ms.toFixed(3)} ms per step, ${(ms * 2).toFixed(3)} ms per 60 Hz frame (2 steps)`);
