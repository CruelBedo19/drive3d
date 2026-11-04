import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import MODEL_SIZES from '../config/trafficModels.json';
import type { TrafficModelId } from '../config/traffic';
import { withoutTransmission } from '../vehicle/visual/VehicleAssetCache';
import { assetUrl } from '../core/assetUrl';

/** One drawable piece of a traffic model: geometry in the model's frame and its material. */
export interface TrafficModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
}

export const TRAFFIC_MODEL_IDS = Object.keys(MODEL_SIZES) as TrafficModelId[];

export function trafficModelUrl(id: TrafficModelId): string {
  return assetUrl(`/assets/traffic/${id}.glb`);
}

const library = new Map<TrafficModelId, TrafficModelPart[]>();
let loading: Promise<void> | null = null;

/**
 * The civil vehicles pack, loaded once per page (the preloader starts it at
 * boot) and shared by every driving session: each model's meshes with their
 * transforms baked in, ready to become InstancedMesh parts. Never disposed by a
 * session. Without a browser (tests) nothing loads and the traffic falls back
 * to its built-in shapes.
 */
export function loadTrafficModels(onLoaded?: (id: TrafficModelId) => void): Promise<void> {
  if (loading) return loading;
  if (typeof window === 'undefined') return (loading = Promise.resolve());
  const loader = new GLTFLoader();
  loading = Promise.all(
    TRAFFIC_MODEL_IDS.map(async (id) => {
      try {
        const gltf = await loader.loadAsync(trafficModelUrl(id));
        gltf.scene.updateMatrixWorld(true);
        const parts: TrafficModelPart[] = [];
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
          parts.push({ geometry, material: Array.isArray(mesh.material) ? mesh.material.map(withoutTransmission) : withoutTransmission(mesh.material) });
        });
        library.set(id, parts);
      } catch (err) {
        console.warn(`Traffic model ${id} could not be loaded; using the built-in shape`, err);
      }
      onLoaded?.(id);
    }),
  ).then(() => undefined);
  return loading;
}

/** Parts of a loaded model (undefined until loaded, or when it failed). */
export function trafficModel(id: TrafficModelId): readonly TrafficModelPart[] | undefined {
  return library.get(id);
}
