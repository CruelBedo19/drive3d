import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { VehicleDefinition } from '../config/vehicleTypes';
import { VehiclePhysics } from '../vehicle/physics/VehiclePhysics';
import { createVehicleVisual } from '../vehicle/visual/createVehicleVisual';
import type { VehicleVisual, VehicleVisualState, WheelPose } from '../vehicle/visual/VehicleVisual';

export type GarageMode = 'showcase' | 'garage';

const FLOOR_RADIUS = 18;
const WALL_RADIUS = 17;
const ORBIT = { min: 3.6, max: 11, minPolar: 0.2, maxPolar: 1.42 };

/**
 * Dark showroom with the selected car on a turntable. 'showcase' (behind the
 * menus): slow automatic orbit, no input. 'garage': mouse drag orbits, wheel
 * zooms, clamped so the camera never goes under the floor or into the car.
 * Has its own scene and camera; rendered through the shared WebGL renderer.
 */
export class GarageScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120);
  private readonly controls: OrbitControls;
  private readonly owned: { dispose(): void }[] = [];
  private readonly key: THREE.SpotLight;
  private visual: VehicleVisual | null = null;
  private pose: VehicleVisualState | null = null;
  private carRoot = new THREE.Group();
  private mode: GarageMode = 'showcase';
  private time = 0;

  constructor(canvas: HTMLElement, shadows: boolean) {
    this.scene.background = new THREE.Color(0x07080a);
    this.scene.fog = new THREE.Fog(0x07080a, 14, 34);
    this.scene.add(this.carRoot);
    this.buildRoom();

    this.scene.add(new THREE.HemisphereLight(0x8fa3c0, 0x101114, 0.55));
    this.key = this.spot(0xffffff, 260, new THREE.Vector3(0, 9, 2.5), shadows);
    this.spot(0xbfd4ff, 90, new THREE.Vector3(-7, 4, -6), false);
    this.spot(0xffe2c4, 80, new THREE.Vector3(7, 3.5, 5), false);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.65, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = ORBIT.min;
    this.controls.maxDistance = ORBIT.max;
    this.controls.minPolarAngle = ORBIT.minPolar;
    this.controls.maxPolarAngle = ORBIT.maxPolar;
    this.camera.position.set(5.2, 1.7, 5.6);
    this.setMode('showcase');
  }

  /** Shows `def` on the turntable (the previous car's resources are released). */
  setCar(def: VehicleDefinition): void {
    this.disposeCar();
    const visual = createVehicleVisual(def);
    const p = def.physics;
    const rest = VehiclePhysics.restHeight(p);
    visual.root.position.y = rest;
    this.pose = staticPose(def, rest);
    visual.update(this.pose);
    visual.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.carRoot.add(visual.root);
    this.visual = visual;
  }

  setMode(mode: GarageMode): void {
    this.mode = mode;
    this.controls.enabled = mode === 'garage';
    this.controls.autoRotate = mode === 'showcase';
    this.controls.autoRotateSpeed = 0.55;
    if (mode === 'showcase') {
      // A lower, wider angle that leaves room for the menu on the left.
      this.controls.target.set(-1.1, 0.7, 0);
      this.camera.position.set(4.8, 1.35, 6.4);
    } else {
      this.controls.target.set(0, 0.65, 0);
    }
    this.controls.update();
  }

  get currentMode(): GarageMode {
    return this.mode;
  }

  update(dt: number, width: number, height: number): void {
    this.time += dt;
    const aspect = width / height;
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.controls.update(dt);
    // A glTF model arrives asynchronously: keep handing it the pose so its wheels are placed once loaded.
    if (this.visual && this.pose) this.visual.update(this.pose);
    // Keep the camera above the floor whatever OrbitControls allows near its limits.
    if (this.camera.position.y < 0.35) this.camera.position.y = 0.35;
    this.key.intensity = 260 + Math.sin(this.time * 0.6) * 6;
  }

  dispose(): void {
    this.controls.dispose();
    this.disposeCar();
    for (const o of this.owned) o.dispose();
    // Lights own their shadow maps (render targets): release them too.
    this.scene.traverse((o) => {
      if (o instanceof THREE.Light) o.dispose();
    });
    this.scene.clear();
  }

  private disposeCar(): void {
    if (!this.visual) return;
    this.visual.root.removeFromParent();
    this.visual.dispose();
    this.visual = null;
  }

  private spot(color: number, intensity: number, pos: THREE.Vector3, shadow: boolean): THREE.SpotLight {
    const s = new THREE.SpotLight(color, intensity, 30, 0.55, 0.6, 1.6);
    s.position.copy(pos);
    s.target.position.set(0, 0.4, 0);
    if (shadow) {
      s.castShadow = true;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.bias = -0.0004;
    }
    this.scene.add(s, s.target);
    return s;
  }

  private buildRoom(): void {
    const floorMat = this.own(new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.32, metalness: 0.25 }));
    const floor = new THREE.Mesh(this.own(new THREE.CircleGeometry(FLOOR_RADIUS, 64)), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const deck = new THREE.Mesh(this.own(new THREE.CylinderGeometry(3.4, 3.5, 0.06, 64)), this.own(new THREE.MeshStandardMaterial({ color: 0x1d2026, roughness: 0.45, metalness: 0.4 })));
    deck.position.y = -0.03;
    deck.receiveShadow = true;
    this.scene.add(deck);

    const ring = new THREE.Mesh(this.own(new THREE.RingGeometry(3.42, 3.5, 96)), this.own(new THREE.MeshBasicMaterial({ color: 0x4fd1c5 })));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    this.scene.add(ring);

    const wall = new THREE.Mesh(this.own(new THREE.CylinderGeometry(WALL_RADIUS, WALL_RADIUS, 9, 48, 1, true)), this.own(new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.9, side: THREE.BackSide })));
    wall.position.y = 4.5;
    this.scene.add(wall);

    // Vertical light strips around the room.
    const stripGeo = this.own(new THREE.BoxGeometry(0.08, 5, 0.08));
    const stripMat = this.own(new THREE.MeshBasicMaterial({ color: 0x9fb4c8 }));
    const strips = new THREE.InstancedMesh(stripGeo, stripMat, 16);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * (WALL_RADIUS - 0.3), 3, Math.sin(a) * (WALL_RADIUS - 0.3));
      strips.setMatrixAt(i, m);
    }
    this.scene.add(strips);
  }

  private own<T extends { dispose(): void }>(r: T): T {
    this.owned.push(r);
    return r;
  }
}

/** Wheels at static ride height (no physics in the garage). */
function staticPose(def: VehicleDefinition, rest: number): VehicleVisualState {
  const p = def.physics;
  const wheels: WheelPose[] = [
    [p.front.halfTrack, p.front.z],
    [-p.front.halfTrack, p.front.z],
    [p.rear.halfTrack, p.rear.z],
    [-p.rear.halfTrack, p.rear.z],
  ].map(([x, z]) => ({ position: new THREE.Vector3(x, p.wheel.radius - rest, z), suspensionOffset: 0, steerAngle: 0, spinAngle: 0 }));
  return { wheels, steeringWheel: 0, braking: false, reversing: false, headlights: false };
}
