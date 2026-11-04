import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { createBuildingMaterials, decodeArrayTexture, type BuildingMaterials } from './CityV2Buildings';
import { CITY_V2_URLS, parseCityV2Data, type CityV2Data, type CityV2Json } from './CityV2Data';
import { assetUrl } from '../../core/assetUrl';

export interface CityV2Assets {
  data: CityV2Data;
  /** Ground meshes by node name (g_<cx>_<cz>_<material>), world placement baked. Empty without a browser. */
  ground: Map<string, THREE.Mesh>;
  /** Building materials (texture arrays); null without a browser. */
  buildings: BuildingMaterials | null;
  /** Loaded files, bytes, and the time it took, ms. */
  bytes: number;
  loadMs: number;
}

let assets: CityV2Assets | null = null;
let loading: Promise<CityV2Assets> | null = null;

/** The loaded City V2, or null (the loading screen loads it first). */
export function cityV2Assets(): CityV2Assets | null {
  return assets;
}

/** Tests: data only (no meshes). */
export function setCityV2Assets(a: CityV2Assets): void {
  assets = a;
}

/**
 * Downloads and decodes City V2 once per page (meshopt-compressed ground glb,
 * layout / collision binary) and keeps it for later sessions.
 * `onProgress(0..1, MB loaded, MB total)`.
 */
export function loadCityV2(onProgress?: (fraction: number, loadedMB: number, totalMB: number) => void): Promise<CityV2Assets> {
  if (assets) return Promise.resolve(assets);
  if (loading) return loading;
  loading = (async () => {
    const t0 = performance.now();
    const files = [CITY_V2_URLS.json, CITY_V2_URLS.bin, CITY_V2_URLS.glb, CITY_V2_URLS.albedo, CITY_V2_URLS.normal];
    const sizes = await Promise.all(files.map(async (u) => Number((await fetch(u, { method: 'HEAD' })).headers.get('content-length')) || 1e6));
    const total = sizes.reduce((a, b) => a + b, 0);
    const got = files.map(() => 0);
    const sum = () => got.reduce((a, b) => a + b, 0);
    const report = () => onProgress?.(Math.min(1, sum() / total) * 0.9, sum() / 1e6, total / 1e6);
    const fetchBytes = async (i: number): Promise<ArrayBuffer> => {
      const res = await fetch(files[i]);
      if (!res.ok || !res.body) throw new Error(`${res.status} ${files[i]}`);
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got[i] += value.byteLength;
        report();
      }
      const out = new Uint8Array(got[i]);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.byteLength;
      }
      return out.buffer;
    };
    const [jsonBuf, bin, glb, albedo, normal] = await Promise.all(files.map((_, i) => fetchBytes(i)));
    const json = JSON.parse(new TextDecoder().decode(jsonBuf)) as CityV2Json;
    const data = parseCityV2Data(json, bin);
    onProgress?.(0.92, total / 1e6, total / 1e6);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(glb, assetUrl('/assets/city_v2/'));
    gltf.scene.updateMatrixWorld(true);
    const ground = new Map<string, THREE.Mesh>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // A node holds one primitive: the mesh may carry the node's name or sit under it.
      const name = /^g_/.test(mesh.name) ? mesh.name : mesh.parent?.name ?? '';
      if (!/^g_/.test(name)) return;
      mesh.matrix.copy(mesh.matrixWorld);
      mesh.matrixAutoUpdate = false;
      ground.set(name, mesh);
    });
    const b = json.buildings;
    const buildings = createBuildingMaterials(await decodeArrayTexture(albedo, b.albedo.size, true), await decodeArrayTexture(normal, b.normal.size, false));
    onProgress?.(1, total / 1e6, total / 1e6);
    assets = { data, ground, buildings, bytes: total, loadMs: performance.now() - t0 };
    return assets;
  })();
  loading.catch(() => (loading = null));
  return loading;
}
