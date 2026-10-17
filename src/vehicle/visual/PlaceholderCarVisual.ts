import * as THREE from 'three';
import type { VehicleConfig, VehicleVisualConfig } from '../../config/vehicleTypes';
import type { VehicleVisual, VehicleVisualState } from './VehicleVisual';
import { LampGroup, WheelRig } from './VisualParts';

/** Box-and-cylinder stand-in car, sized from the physics config. Also the glTF fallback. */
export class PlaceholderCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  readonly hoodCameraOffset: THREE.Vector3;
  readonly wheels: WheelRig[] = [];

  private readonly brakeLights = new LampGroup(0.35);
  private readonly reverseLights = new LampGroup(0);
  private readonly headlights = new LampGroup(0.6);
  private readonly disposables: { dispose(): void }[] = [];

  constructor(physics: VehicleConfig, visual: VehicleVisualConfig) {
    const c = physics.chassis;
    const model = new THREE.Group();
    this.root.add(model);

    const paint = this.track(new THREE.MeshStandardMaterial({ color: visual.bodyColor, roughness: 0.45, metalness: 0.3 }));
    const glass = this.track(new THREE.MeshStandardMaterial({ color: 0x3a4a5e, roughness: 0.2, metalness: 0.4 }));
    const dark = this.track(new THREE.MeshStandardMaterial({ color: 0x1c1d21, roughness: 0.9 }));
    const head = this.track(new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xfff0c0 }));
    const tail = this.track(new THREE.MeshStandardMaterial({ color: 0x8a0d0d, emissive: 0xff2020 }));
    const rev = this.track(new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xffffff }));

    const he = c.halfExtents;
    const body = new THREE.Mesh(this.track(new THREE.BoxGeometry(he.x * 2, he.y * 2, he.z * 2)), paint);
    body.castShadow = true;
    model.add(body);

    const ch = c.cabinHalfExtents;
    const cabin = new THREE.Mesh(this.track(new THREE.BoxGeometry(ch.x * 2, ch.y * 2, ch.z * 2)), glass);
    cabin.position.set(c.cabinOffset.x, c.cabinOffset.y - 0.04, c.cabinOffset.z);
    cabin.castShadow = true;
    model.add(cabin);

    const lampGeo = this.track(new THREE.BoxGeometry(0.35, 0.1, 0.04));
    const revGeo = this.track(new THREE.BoxGeometry(0.14, 0.08, 0.04));
    const heads = new THREE.Group();
    const brakes = new THREE.Group();
    const reverses = new THREE.Group();
    model.add(heads, brakes, reverses);
    for (const side of [1, -1]) {
      const headLamp = new THREE.Mesh(lampGeo, head);
      headLamp.position.set(side * (he.x - 0.25), 0.08, he.z + 0.01);
      heads.add(headLamp);
      const brakeLamp = new THREE.Mesh(lampGeo, tail);
      brakeLamp.position.set(side * (he.x - 0.25), 0.1, -he.z - 0.01);
      brakes.add(brakeLamp);
      const revLamp = new THREE.Mesh(revGeo, rev);
      revLamp.position.set(side * (he.x - 0.55), 0.1, -he.z - 0.01);
      reverses.add(revLamp);
    }
    this.headlights.addNode(heads, 0xfff0c0);
    this.brakeLights.addNode(brakes, 0xff2020);
    this.reverseLights.addNode(reverses, 0xffffff);

    // Wheels: pivot (steer) -> spinner (roll) -> tyre + rim + spoke.
    const w = physics.wheel;
    const tyreGeo = this.track(new THREE.CylinderGeometry(w.radius, w.radius, w.width, 20));
    tyreGeo.rotateZ(Math.PI / 2);
    const rimGeo = this.track(new THREE.CylinderGeometry(w.radius * 0.62, w.radius * 0.62, w.width + 0.01, 16));
    rimGeo.rotateZ(Math.PI / 2);
    const spokeGeo = this.track(new THREE.BoxGeometry(w.width + 0.02, w.radius * 1.15, 0.07));
    const hubMat = this.track(new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.7, roughness: 0.35 }));
    const spokeMat = this.track(new THREE.MeshStandardMaterial({ color: 0x55595f, metalness: 0.5, roughness: 0.5 }));
    for (let i = 0; i < 4; i++) {
      const rig = new WheelRig('physics');
      const tyre = new THREE.Mesh(tyreGeo, dark);
      tyre.castShadow = true;
      rig.spinner.add(tyre, new THREE.Mesh(rimGeo, hubMat), new THREE.Mesh(spokeGeo, spokeMat));
      this.root.add(rig.pivot);
      this.wheels.push(rig);
    }

    this.hoodCameraOffset = new THREE.Vector3(0, c.cabinOffset.y + 0.12, c.cabinOffset.z + ch.z + 0.1);
  }

  update(state: VehicleVisualState): void {
    for (let i = 0; i < this.wheels.length; i++) this.wheels[i].apply(state.wheels[i]);
    this.brakeLights.set(state.braking);
    this.reverseLights.set(state.reversing);
    this.headlights.set(state.headlights);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.brakeLights.dispose();
    this.reverseLights.dispose();
    this.headlights.dispose();
    this.root.removeFromParent();
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}
