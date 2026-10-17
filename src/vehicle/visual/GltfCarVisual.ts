import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { NodeName, VehicleConfig, VehicleModelConfig, VehicleVisualConfig } from '../../config/vehicleTypes';
import { DEG2RAD } from '../../utils/math';
import { PlaceholderCarVisual } from './PlaceholderCarVisual';
import type { VehicleVisual, VehicleVisualState } from './VehicleVisual';
import { LampGroup, WheelRig } from './VisualParts';

/** Anything that turns a URL into a glTF scene (GLTFLoader, a cache, a test stub...). */
export type ModelLoader = (url: string) => Promise<{ scene: THREE.Object3D }>;

const defaultLoader: ModelLoader = (url) => new GLTFLoader().loadAsync(url);

const WHEEL_KEYS = ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'] as const;

/**
 * Car visual loaded from a .glb / .gltf.
 *
 * The placeholder is shown while the model loads and stays if loading or node
 * mapping fails, so a broken asset never leaves the player without a car.
 * Logical parts (wheels, steering wheel, lamps) are found by the names given in
 * the model config, so every model can keep its own naming.
 */
export class GltfCarVisual implements VehicleVisual {
  readonly root = new THREE.Group();
  readonly hoodCameraOffset = new THREE.Vector3();
  /** Resolves true once the model is shown, false if the placeholder stays. */
  readonly ready: Promise<boolean>;
  status: 'loading' | 'loaded' | 'fallback' = 'loading';
  /** Mapped names that were not found in the last model applied (for diagnostics). */
  missingNodes: string[] = [];

  private readonly model: VehicleModelConfig;
  private fallback: PlaceholderCarVisual | null;
  private container: THREE.Object3D | null = null;
  private wheels: WheelRig[] = [];
  private steeringWheel: { node: THREE.Object3D; base: THREE.Quaternion; axis: THREE.Vector3 } | null = null;
  private readonly headlights = new LampGroup(0.05);
  private readonly brakeLights = new LampGroup(0.3);
  private readonly reverseLights = new LampGroup(0);
  private disposed = false;
  private readonly _q = new THREE.Quaternion();

  constructor(physics: VehicleConfig, visual: VehicleVisualConfig, loader: ModelLoader = defaultLoader) {
    if (!visual.model) throw new Error('glTF visual needs visual.model');
    this.model = visual.model;
    this.fallback = new PlaceholderCarVisual(physics, visual);
    this.root.add(this.fallback.root);
    const hood = this.model.hoodCamera;
    if (hood) this.hoodCameraOffset.set(hood.x, hood.y, hood.z);
    else this.hoodCameraOffset.copy(this.fallback.hoodCameraOffset);

    this.ready = loader(this.model.url).then(
      (gltf) => {
        if (this.disposed) return false;
        try {
          this.applyModel(gltf.scene);
          return true;
        } catch (err) {
          this.useFallback(err);
          return false;
        }
      },
      (err: unknown) => {
        this.useFallback(err);
        return false;
      },
    );
  }

  /** Installs a loaded scene. Throws (leaving the placeholder in place) if wheel nodes are missing. */
  applyModel(scene: THREE.Object3D): void {
    const cfg = this.model;
    this.missingNodes = [];
    const nodes = cfg.nodes;
    const wheelNodes = WHEEL_KEYS.map((key) => this.find(scene, nodes[key], key));
    if (wheelNodes.some((n) => n === null)) {
      throw new Error(`wheel nodes not found: ${this.missingNodes.join(', ')}`);
    }

    const container = new THREE.Group();
    container.name = 'gltf-model';
    container.scale.setScalar(cfg.scale);
    container.rotation.y = cfg.rotationYDeg * DEG2RAD;
    container.position.set(cfg.offset.x, cfg.offset.y, cfg.offset.z);
    container.add(scene);
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });

    // Work in the root frame: detach root from the world transform while measuring.
    const parent = this.root.parent;
    const savedPos = this.root.position.clone();
    const savedQuat = this.root.quaternion.clone();
    this.root.removeFromParent();
    this.root.position.set(0, 0, 0);
    this.root.quaternion.identity();
    this.root.add(container);
    this.root.updateMatrixWorld(true);

    const box = new THREE.Box3();
    this.wheels = wheelNodes.map((node) => {
      const n = node as THREE.Object3D;
      const rig = new WheelRig(cfg.wheelPlacement);
      box.setFromObject(n);
      box.getCenter(rig.restPosition);
      rig.pivot.position.copy(rig.restPosition);
      this.root.add(rig.pivot);
      rig.pivot.updateMatrixWorld(true);
      rig.spinner.attach(n); // keeps the node's world transform, now spun about the wheel centre
      return rig;
    });

    const sw = nodes.steeringWheel ? this.find(scene, nodes.steeringWheel, 'steeringWheel') : null;
    if (sw) {
      const axis = new THREE.Vector3(cfg.steeringWheelAxis === 'x' ? 1 : 0, cfg.steeringWheelAxis === 'y' ? 1 : 0, cfg.steeringWheelAxis === 'z' ? 1 : 0);
      this.steeringWheel = { node: sw, base: sw.quaternion.clone(), axis };
    }
    this.collectLamps(scene, nodes.headlights, this.headlights, 0xfff0c0, 'headlights');
    this.collectLamps(scene, nodes.brakeLights, this.brakeLights, 0xff2020, 'brakeLights');
    this.collectLamps(scene, nodes.reverseLights, this.reverseLights, 0xffffff, 'reverseLights');
    if (nodes.body) this.find(scene, nodes.body, 'body');

    if (this.fallback) {
      this.fallback.dispose();
      this.fallback = null;
    }
    this.container = container;
    this.root.position.copy(savedPos);
    this.root.quaternion.copy(savedQuat);
    parent?.add(this.root);
    this.status = 'loaded';
    if (this.missingNodes.length > 0) console.warn(`[vehicle] ${cfg.url}: optional nodes not found: ${this.missingNodes.join(', ')}`);
  }

  update(state: VehicleVisualState): void {
    if (this.fallback) {
      this.fallback.update(state);
      return;
    }
    for (let i = 0; i < this.wheels.length; i++) this.wheels[i].apply(state.wheels[i]);
    if (this.steeringWheel) {
      const s = this.steeringWheel;
      this._q.setFromAxisAngle(s.axis, -state.steeringWheel * this.model.steeringWheelMaxDeg * DEG2RAD);
      s.node.quaternion.copy(s.base).multiply(this._q);
    }
    this.headlights.set(state.headlights);
    this.brakeLights.set(state.braking);
    this.reverseLights.set(state.reversing);
  }

  /** Wheel rigs of the loaded model (empty while the placeholder is shown). */
  get wheelRigs(): readonly WheelRig[] {
    return this.wheels;
  }

  dispose(): void {
    this.disposed = true;
    this.fallback?.dispose();
    this.container?.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose();
    });
    this.headlights.dispose();
    this.brakeLights.dispose();
    this.reverseLights.dispose();
    this.root.removeFromParent();
  }

  private useFallback(err: unknown): void {
    this.status = 'fallback';
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[vehicle] could not use model ${this.model.url} (${msg}); showing placeholder`);
  }

  /** Lamp mappings: every listed name that exists is used (left + right lamps, etc.). */
  private collectLamps(scene: THREE.Object3D, names: NodeName | undefined, group: LampGroup, color: number, key: string): void {
    if (!names) return;
    const list = typeof names === 'string' ? [names] : names;
    for (const name of list) {
      const node = this.find(scene, name, key);
      if (node) group.addNode(node, color);
    }
  }

  /** Candidates in order; exact name first, then case / punctuation-insensitive. */
  private find(scene: THREE.Object3D, names: NodeName, key: string): THREE.Object3D | null {
    const list = typeof names === 'string' ? [names] : names;
    for (const name of list) {
      const exact = scene.getObjectByName(name);
      if (exact) return exact;
    }
    for (const name of list) {
      const wanted = normalise(name);
      let found: THREE.Object3D | null = null;
      scene.traverse((obj) => {
        if (!found && normalise(obj.name) === wanted) found = obj;
      });
      if (found) return found;
    }
    this.missingNodes.push(`${key} (${list.join(' | ')})`);
    return null;
  }
}

function normalise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
