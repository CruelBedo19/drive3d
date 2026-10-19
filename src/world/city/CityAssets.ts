import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { CITY_URLS, parseCityData, type CityData, type CityJson } from './CityData';

/** One drawable piece of a prototype: geometry in the prototype's local frame and its material. */
export interface ProtoPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface CityAssets {
  data: CityData;
  /** Prototype parts by id (full detail) and the simplified LOD where one exists. Empty without a browser. */
  protos: Map<number, ProtoPart[]>;
  lods: Map<number, ProtoPart[]>;
  /** Baked ground meshes by their name in city.glb (world placement in their matrix). */
  ground: Map<string, THREE.Mesh>;
}

let assets: CityAssets | null = null;
let loading: Promise<CityAssets> | null = null;

/** The loaded city, or null (load it first: the loading screen does). */
export function cityAssets(): CityAssets | null {
  return assets;
}

/** Tests: data only (no meshes). */
export function setCityAssets(a: CityAssets): void {
  assets = a;
}

/**
 * Downloads and decodes the city once per page (~15 MB: meshopt-compressed
 * glb, layout / collision binary) and keeps it for every later session.
 * `onProgress(0..1, MB loaded, MB total)`.
 */
export function loadCity(onProgress?: (fraction: number, loadedMB: number, totalMB: number) => void): Promise<CityAssets> {
  if (assets) return Promise.resolve(assets);
  if (loading) return loading;
  loading = (async () => {
    const files = [CITY_URLS.json, CITY_URLS.bin, CITY_URLS.glb];
    const sizes = await Promise.all(files.map(async (u) => Number((await fetch(u, { method: 'HEAD' })).headers.get('content-length')) || 1e6));
    const total = sizes.reduce((a, b) => a + b, 0);
    const got = [0, 0, 0];
    const report = () => onProgress?.(Math.min(1, (got[0] + got[1] + got[2]) / total) * 0.9, (got[0] + got[1] + got[2]) / 1e6, total / 1e6);
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
    const [jsonBuf, bin, glb] = await Promise.all([fetchBytes(0), fetchBytes(1), fetchBytes(2)]);
    const json = JSON.parse(new TextDecoder().decode(jsonBuf)) as CityJson;
    const data = parseCityData(json, bin);
    onProgress?.(0.92, total / 1e6, total / 1e6);
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.parseAsync(glb, '/assets/city/');
    gltf.scene.updateMatrixWorld(true);
    const protos = new Map<number, ProtoPart[]>();
    const lods = new Map<number, ProtoPart[]>();
    const ground = new Map<string, THREE.Mesh>();
    gltf.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // A node holds one primitive (mesh named after the node) or a group of them.
      const name = mesh.parent && mesh.parent !== gltf.scene && !/^(protos|ground)$/.test(mesh.parent.name) ? mesh.parent.name : mesh.name;
      const proto = /^p(\d+)(_lod)?$/.exec(name);
      if (proto) {
        // Bake the node transform (quantisation scale / offset) into the prototype geometry.
        const geometry = toFloat(mesh.geometry).applyMatrix4(mesh.matrixWorld);
        const map = proto[2] ? lods : protos;
        const id = Number(proto[1]);
        const list = map.get(id) ?? [];
        list.push({ geometry, material: mesh.material as THREE.Material });
        map.set(id, list);
      } else if (/^g/.test(name)) {
        mesh.matrix.copy(mesh.matrixWorld);
        mesh.matrixAutoUpdate = false;
        ground.set(name, mesh);
      }
    });
    onProgress?.(1, total / 1e6, total / 1e6);
    assets = { data, protos, lods, ground };
    return assets;
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** Name as three.js stores it for a glTF node (some characters are stripped). */
export function nodeName(name: string): string {
  return THREE.PropertyBinding.sanitizeNodeName(name);
}

/**
 * Plain Float32 copy of a decoded geometry (meshopt stores quantised, normalised
 * integers: transforming those in place would clip them).
 */
function toFloat(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv'] as const) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(src.index.array as ArrayLike<number>), 1));
  return g;
}
