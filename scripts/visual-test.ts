/**
 * Visual pipeline tests: glTF loading, node mapping, fallback, the shared car
 * model cache, and physics -> visual wheel synchronisation (placeholder and
 * glTF). Part of `npm run test:sim`.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { testGltfCar } from '../src/config/vehicles/testGltfCar';
import type { VehicleModelConfig, VehicleVisualConfig } from '../src/config/vehicleTypes';
import { Vehicle } from '../src/vehicle/Vehicle';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { GltfCarVisual, type ModelLoader } from '../src/vehicle/visual/GltfCarVisual';
import { VehicleAssetCache } from '../src/vehicle/visual/VehicleAssetCache';
import type { PlaceholderCarVisual } from '../src/vehicle/visual/PlaceholderCarVisual';
import type { VehicleVisualState, WheelPose } from '../src/vehicle/visual/VehicleVisual';
import { PhysicsWorld, RAPIER } from '../src/core/PhysicsWorld';
import { DT, buildConfig, check, finish, makeSim, runControls, section } from './lib/sim';

const glbPath = new URL('../public/assets/vehicles/test-car/test-car.glb', import.meta.url);
const fileLoader: ModelLoader = async () => {
  const buf = readFileSync(glbPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new GLTFLoader().parseAsync(ab, '');
};
const failingLoader: ModelLoader = () => Promise.reject(new Error('404 Not Found'));

const physicsCfg = buildConfig();
const baseModel = testGltfCar.visual.model as VehicleModelConfig;

function visualConfig(model: Partial<VehicleModelConfig>): VehicleVisualConfig {
  return { ...testGltfCar.visual, model: { ...baseModel, ...model, nodes: { ...baseModel.nodes, ...(model.nodes ?? {}) } } };
}

function poses(): WheelPose[] {
  return [0, 1, 2, 3].map(() => ({ position: new THREE.Vector3(), suspensionOffset: 0, steerAngle: 0, spinAngle: 0 }));
}

function state(): VehicleVisualState {
  return { wheels: poses(), steeringWheel: 0, braking: false, reversing: false, headlights: false };
}

function countPlaceholderWheels(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry instanceof THREE.CylinderGeometry && m.geometry.parameters.radiusTop === physicsCfg.wheel.radius) n++;
  });
  return n;
}

async function main(): Promise<void> {
  // Silence the expected fallback warnings, but keep them countable.
  const warnings: string[] = [];
  console.warn = (msg: string) => warnings.push(String(msg));

  section('glTF loading and node mapping');
  {
    const v = new GltfCarVisual(physicsCfg, testGltfCar.visual, fileLoader);
    check('placeholder shown while loading', v.status === 'loading' && countPlaceholderWheels(v.root) === 4, `status ${v.status}`);
    const ok = await v.ready;
    check('test GLB loads and replaces the placeholder', ok && v.status === 'loaded' && countPlaceholderWheels(v.root) === 0, `status ${v.status}`);
    check('all four wheel nodes mapped from custom names', v.wheelRigs.length === 4 && v.missingNodes.length === 0, `rigs ${v.wheelRigs.length}, missing [${v.missingNodes.join(', ')}]`);
    const statLen = VehiclePhysics.staticSuspensionLength(physicsCfg);
    const expected = [
      [physicsCfg.front.halfTrack, physicsCfg.front.z],
      [-physicsCfg.front.halfTrack, physicsCfg.front.z],
      [physicsCfg.rear.halfTrack, physicsCfg.rear.z],
      [-physicsCfg.rear.halfTrack, physicsCfg.rear.z],
    ];
    const err = Math.max(
      ...v.wheelRigs.map((r, i) =>
        r.restPosition.distanceTo(new THREE.Vector3(expected[i][0], physicsCfg.front.hardpointY - statLen, expected[i][1])),
      ),
    );
    check('wheel pivots sit on the geometry centre', err < 0.01, `max offset from physics wheel centre ${(err * 100).toFixed(2)} cm`);
  }
  {
    const v = new GltfCarVisual(
      physicsCfg,
      visualConfig({ nodes: { ...baseModel.nodes, wheelFL: ['nope', 'wheel-front-l'], wheelRR: 'WHEEL_REAR_R' } }),
      fileLoader,
    );
    await v.ready;
    check('mapping: candidates + case/punctuation-insensitive match', v.status === 'loaded' && v.wheelRigs.length === 4, `status ${v.status}`);
  }
  {
    const v = new GltfCarVisual(physicsCfg, visualConfig({ nodes: { ...baseModel.nodes, steeringWheel: 'NoSuchNode' } }), fileLoader);
    await v.ready;
    check('missing optional node: model still used, reported', v.status === 'loaded' && v.missingNodes.some((m) => m.startsWith('steeringWheel')), `missing [${v.missingNodes.join(', ')}]`);
  }

  section('Fallback');
  {
    const v = new GltfCarVisual(physicsCfg, visualConfig({ nodes: { ...baseModel.nodes, wheelRL: 'NoSuchWheel' } }), fileLoader);
    const ok = await v.ready;
    check('missing wheel node: placeholder stays', !ok && v.status === 'fallback' && countPlaceholderWheels(v.root) === 4, `status ${v.status}`);
  }
  {
    const before = warnings.length;
    const v = new GltfCarVisual(physicsCfg, testGltfCar.visual, failingLoader);
    const ok = await v.ready;
    const s = state();
    s.wheels[0].steerAngle = 0.4;
    v.update(s); // must not throw while on the fallback
    check('load failure: placeholder stays and keeps working', !ok && v.status === 'fallback' && countPlaceholderWheels(v.root) === 4 && warnings.length > before, `status ${v.status}, warning "${warnings.at(-1)?.slice(0, 60)}…"`);
  }

  section('Shared car model cache');
  {
    let loads = 0;
    const counting: ModelLoader = (url) => {
      loads++;
      return fileLoader(url);
    };
    const cache = new VehicleAssetCache(counting, 1);
    const url = baseModel.url;
    const a = new GltfCarVisual(physicsCfg, testGltfCar.visual, cache);
    const b = new GltfCarVisual(physicsCfg, testGltfCar.visual, cache);
    await Promise.all([a.ready, b.ready]);
    const meshes = (v: GltfCarVisual) => {
      const out: THREE.Mesh[] = [];
      v.root.traverse((o) => (o as THREE.Mesh).isMesh && out.push(o as THREE.Mesh));
      return out;
    };
    const geoA = new Set(meshes(a).map((m) => m.geometry));
    check('two users of one model: one download / parse, shared geometry', loads === 1 && a.status === 'loaded' && b.status === 'loaded' && meshes(b).some((m) => geoA.has(m.geometry)), `loads ${loads}`);
    let disposed = 0;
    for (const g of geoA) g.addEventListener('dispose', () => disposed++);
    a.dispose();
    b.dispose();
    check('released model stays cached while idle (no dispose)', disposed === 0 && cache.has(url), `disposed ${disposed}`);
    const c = new GltfCarVisual(physicsCfg, testGltfCar.visual, cache);
    await c.ready;
    check('coming back to a cached model: no new download / parse', loads === 1 && c.status === 'loaded', `loads ${loads}`);
    c.dispose();
    // A second idle model beyond maxIdle 1 pushes the least recently used one out.
    await cache.prefetch('other.glb');
    await new Promise((r) => setTimeout(r, 0));
    check('idle models beyond the limit are disposed (LRU)', !cache.has(url) && disposed > 0 && cache.size === 1, `cached ${cache.size}, geometries disposed ${disposed}`);
    const late = new GltfCarVisual(physicsCfg, testGltfCar.visual, cache);
    late.dispose(); // disposed before its model arrived
    await late.ready;
    cache.clearIdle();
    check('visual disposed while loading: model released, nothing leaks', late.status === 'loading' && cache.size === 0, `status ${late.status}, cached ${cache.size}`);
    let fail = true;
    const flaky = new VehicleAssetCache((u) => (fail ? Promise.reject(new Error('offline')) : fileLoader(u)));
    const f1 = new GltfCarVisual(physicsCfg, testGltfCar.visual, flaky);
    await f1.ready;
    fail = false;
    const f2 = new GltfCarVisual(physicsCfg, testGltfCar.visual, flaky);
    await f2.ready;
    check('failed load is not cached: next request tries again', f1.status === 'fallback' && f2.status === 'loaded', `${f1.status} → ${f2.status}`);
  }

  section('Wheel visual synchronisation');
  {
    const v = new GltfCarVisual(physicsCfg, testGltfCar.visual, fileLoader);
    await v.ready;
    const s = state();
    s.wheels[0].suspensionOffset = 0.05;
    s.wheels[0].steerAngle = 0.3;
    s.wheels[0].spinAngle = 1.2;
    s.steeringWheel = 1;
    s.braking = true;
    s.reversing = true;
    const rig = v.wheelRigs[0];
    const restY = rig.restPosition.y;
    v.update(s);
    check('glTF wheel: suspension, steer and spin applied', Math.abs(rig.pivot.position.y - (restY + 0.05)) < 1e-6 && rig.pivot.rotation.y === 0.3 && rig.spinner.rotation.x === 1.2, `y +${(rig.pivot.position.y - restY).toFixed(3)}, steer ${rig.pivot.rotation.y}, spin ${rig.spinner.rotation.x}`);
    const sw = v.root.getObjectByName('SteeringWheel') as THREE.Object3D;
    const swQuat = sw.quaternion.clone();
    s.steeringWheel = -1;
    v.update(s);
    check('glTF steering wheel turns with steering', swQuat.angleTo(sw.quaternion) > 3, `rotation between full left and right ${((swQuat.angleTo(sw.quaternion) * 180) / Math.PI).toFixed(0)}°`);
    const brake = (v.root.getObjectByName('Lamp_Brake_L') as THREE.Mesh).material as THREE.MeshStandardMaterial;
    const on = brake.emissiveIntensity;
    s.braking = false;
    v.update(s);
    check('glTF brake lights follow braking', on > 1 && brake.emissiveIntensity < 0.5, `on ${on.toFixed(2)}, off ${brake.emissiveIntensity.toFixed(2)}`);
  }
  {
    // Placeholder in a real drive: steer, spin, suspension follow physics.
    const sim = await makeSim(false);
    const rigs = (sim.vehicle.visual as PlaceholderCarVisual).wheels;
    sim.controls.throttle = 1;
    runControls(sim, 4, () => {});
    sim.controls.throttle = 0.2;
    sim.controls.steer = 1;
    runControls(sim, 0.5, () => {});
    const fl = sim.vehicle.physics.wheels[0];
    check('placeholder: front wheel steer = physics steer', Math.abs(rigs[0].pivot.rotation.y - fl.steerAngle) < 1e-9 && fl.steerAngle < -0.05, `${rigs[0].pivot.rotation.y.toFixed(3)} rad`);
    check('placeholder: rear wheels not steered', rigs[2].pivot.rotation.y === 0, `${rigs[2].pivot.rotation.y}`);
    const spin0 = rigs[2].spinner.rotation.x;
    runControls(sim, DT * 3, () => {});
    check('placeholder: wheels spin with physics', rigs[2].spinner.rotation.x !== spin0 && rigs[2].spinner.rotation.x === sim.vehicle.physics.wheels[2].spinAngle, `Δ ${(rigs[2].spinner.rotation.x - spin0).toFixed(3)} rad`);
    sim.controls.throttle = 0;
    sim.controls.steer = 0;
    runControls(sim, 1.5, () => {}); // settle, coasting straight
    const frontY0 = rigs[0].pivot.position.y;
    const rearY0 = rigs[2].pivot.position.y;
    sim.controls.brake = 1;
    runControls(sim, 0.35, () => {});
    const dFront = rigs[0].pivot.position.y - frontY0;
    const dRear = rigs[2].pivot.position.y - rearY0;
    check('placeholder: suspension travel (nose dive) visible', dFront > 0.005 && dRear < 0, `front wheel +${(dFront * 100).toFixed(1)} cm, rear ${(dRear * 100).toFixed(1)} cm (body frame)`);
  }
  {
    // glTF car in a real drive.
    const physics = await PhysicsWorld.create();
    const fixed = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(500, 0.5, 500).setTranslation(0, -0.5, 0), fixed);
    const visual = new GltfCarVisual(physicsCfg, testGltfCar.visual, fileLoader);
    await visual.ready;
    const car = new Vehicle(physics.world, physicsCfg, visual, new THREE.Vector3(0, VehiclePhysics.restHeight(physicsCfg), 0), 0);
    const controls = { throttle: 1, brake: 0, steer: 1, handbrake: 0 };
    for (let i = 0; i < 240; i++) {
      car.fixedUpdate(DT, controls);
      physics.step();
      car.postPhysics();
    }
    car.render(1);
    const rigs = visual.wheelRigs;
    const w = car.physics.wheels;
    check('glTF car: wheels follow physics while driving', Math.abs(rigs[0].pivot.rotation.y - w[0].steerAngle) < 1e-9 && rigs[3].spinner.rotation.x === w[3].spinAngle && visual.root.position.distanceTo(car.renderPosition) < 1e-9, `steer ${w[0].steerAngle.toFixed(3)}, spin ${w[3].spinAngle.toFixed(2)}`);
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
