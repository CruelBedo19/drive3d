import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

/** Bytes downloaded so far (total 0 when unknown). */
export type LoadProgress = (loaded: number, total: number) => void;

/** Turns a URL into a glTF scene (GLTFLoader, a test stub...). */
export type SceneLoader = (url: string, onProgress?: LoadProgress) => Promise<{ scene: THREE.Object3D }>;

interface Entry {
  /** The parsed model; never shown itself, every user gets a clone. */
  template: Promise<THREE.Object3D>;
  users: number;
  /** Bumped on every use: the least recently used idle model is released first. */
  lastUsed: number;
  failed: boolean;
}

/**
 * Player car models, downloaded and parsed once and shared by the garage and
 * driving sessions. Each user gets a clone that shares the template's
 * geometries, materials and textures (the GPU uploads them once), so moving a
 * car from the garage to a drive, restarting, or coming back to a car seen a
 * moment ago costs no network and no parsing.
 *
 * Models nobody uses stay cached up to `maxIdle`; beyond that the least
 * recently used one is disposed (geometries, materials and their textures), so
 * browsing every car in the garage never keeps all of them in memory.
 */
export class VehicleAssetCache {
  private readonly entries = new Map<string, Entry>();
  private readonly load: SceneLoader;
  private readonly maxIdle: number;
  private clock = 0;
  /** Downloads + parses started (for diagnostics / tests: a cache hit does not count). */
  loads = 0;

  constructor(load: SceneLoader, maxIdle = 4) {
    this.load = load;
    this.maxIdle = maxIdle;
  }

  /** A clone of the model for one user; pair every call with release(url). */
  async acquire(url: string): Promise<THREE.Object3D> {
    const entry = this.entry(url);
    entry.users++;
    entry.lastUsed = ++this.clock;
    try {
      return (await entry.template).clone(true);
    } catch (err) {
      this.release(url);
      throw err;
    }
  }

  /** The user of a clone from acquire() is done with it (the clone itself needs no disposing). */
  release(url: string): void {
    const entry = this.entries.get(url);
    if (!entry) return;
    entry.users = Math.max(0, entry.users - 1);
    entry.lastUsed = ++this.clock;
    this.trim();
  }

  /**
   * Starts loading a model nobody needs yet (the menu car, garage neighbours); it is then cached like an idle
   * one. `onProgress` only reports when this call starts the download.
   */
  prefetch(url: string, onProgress?: LoadProgress): Promise<void> {
    const entry = this.entry(url, onProgress);
    entry.lastUsed = ++this.clock;
    const done = entry.template.then(
      () => undefined,
      () => undefined,
    );
    this.trim();
    return done;
  }

  /** Whether the model is cached (loaded or loading). */
  has(url: string): boolean {
    return this.entries.has(url);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Releases every cached model that has no user. */
  clearIdle(): void {
    for (const [url, e] of this.entries) if (e.users === 0) this.evict(url, e);
  }

  private entry(url: string, onProgress?: LoadProgress): Entry {
    let entry = this.entries.get(url);
    if (!entry || entry.failed) {
      this.loads++;
      const e: Entry = { template: Promise.resolve(new THREE.Object3D()), users: 0, lastUsed: 0, failed: false };
      e.template = this.load(url, onProgress).then(
        (gltf) => prepareTemplate(gltf.scene),
        (err: unknown) => {
          // Not kept: the next request tries again.
          e.failed = true;
          if (this.entries.get(url) === e) this.entries.delete(url);
          throw err;
        },
      );
      this.entries.set(url, e);
      entry = e;
    }
    return entry;
  }

  private trim(): void {
    const idle = [...this.entries].filter(([, e]) => e.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let i = 0; i < idle.length - this.maxIdle; i++) this.evict(idle[i][0], idle[i][1]);
  }

  private evict(url: string, entry: Entry): void {
    this.entries.delete(url);
    // A model still loading is disposed when it arrives.
    void entry.template.then(disposeObject, () => undefined);
  }
}

/** Once per parsed model: transmissive glass becomes plain glass (shared by every clone). */
function prepareTemplate(scene: THREE.Object3D): THREE.Object3D {
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) mesh.material = Array.isArray(mesh.material) ? mesh.material.map(withoutTransmission) : withoutTransmission(mesh.material);
  });
  return scene;
}

/** Frees a model's GPU resources: geometries, materials and every texture they use. */
export function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
      m.dispose();
    }
  });
  for (const t of textures) t.dispose();
}

/**
 * Transmissive glass (KHR_materials_transmission) makes three.js draw every opaque object a second time into a
 * transmission target each frame, so a small lens costs as much as the whole scene. Such materials become
 * plain tinted, glossy, alpha-blended glass instead: the lamp housing still shows through, emissive (brake
 * lights) still works, nothing is refracted.
 */
export function withoutTransmission(material: THREE.Material): THREE.Material {
  const m = material as THREE.MeshPhysicalMaterial;
  if (!m.isMeshPhysicalMaterial || m.transmission <= 0) return material;
  const done = replaced.get(m);
  if (done) return done;
  const glass = new THREE.MeshStandardMaterial({
    name: m.name,
    color: m.color,
    map: m.map,
    emissive: m.emissive,
    emissiveMap: m.emissiveMap,
    emissiveIntensity: m.emissiveIntensity,
    normalMap: m.normalMap,
    roughness: Math.max(m.roughness, 0.08),
    metalness: 0,
    envMapIntensity: 1.5,
    transparent: true,
    // The transmitted share becomes coverage: a fully transmissive lens is a strongly tinted, see-through one.
    opacity: Math.min(1, Math.max(m.opacity, 0.35 + 0.3 * m.transmission)),
    depthWrite: false,
    side: m.side,
  });
  glass.userData = { ...m.userData, transmissionRemoved: m.transmission };
  replaced.set(m, glass);
  m.dispose();
  return glass;
}

/** One replacement per original material, so meshes sharing a lens keep sharing it. */
const replaced = new WeakMap<THREE.Material, THREE.Material>();

/** GLTFLoader for the prepared car models (meshopt-compressed geometry, see scripts/prepare-cars.ts). */
export function gltfLoader(): SceneLoader {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return (url, onProgress) => loader.loadAsync(url, onProgress && ((e) => onProgress(e.loaded, e.lengthComputable ? e.total : 0)));
}

/** The one cache every player car model goes through (garage, driving, restarts). */
export const vehicleAssets = new VehicleAssetCache(gltfLoader());
