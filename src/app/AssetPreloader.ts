import * as THREE from 'three';
import { CAR_REGISTRY } from '../config/carRegistry';
import { PhysicsWorld } from '../core/PhysicsWorld';
import { TRAFFIC_MODEL_IDS, loadTrafficModels, trafficModelUrl } from '../traffic/TrafficModelLibrary';

export interface PreloadProgress {
  /** 0..1 over all bytes (files) plus the final preparation step. */
  fraction: number;
  /** What is being fetched / prepared right now. */
  label: string;
  loadedMB: number;
  totalMB: number;
}

/**
 * Everything big the game needs, fetched once when the site opens: the player
 * cars' models, the traffic models and the physics engine. Files go into
 * three.js's cache (THREE.Cache), so every later GLTFLoader request for the same
 * URL (garage, car switch, each new session) is served from memory instead of
 * the network; the traffic models are also parsed now. A file that fails is
 * reported and skipped: it then loads (or falls back) on demand as before.
 */
export async function preloadAssets(onProgress: (p: PreloadProgress) => void): Promise<void> {
  enableFileCache();
  const cars = CAR_REGISTRY.flatMap((c) => (c.definition.visual.model ? [{ url: c.definition.visual.model.url, label: `${c.brand} ${c.model}` }] : []));
  const traffic = TRAFFIC_MODEL_IDS.map((id) => ({ url: trafficModelUrl(id), label: 'Trafik araçları' }));
  const items = [...cars, ...traffic];
  onProgress({ fraction: 0, label: 'Dosyalar hazırlanıyor…', loadedMB: 0, totalMB: 0 });
  // Sizes first (HEAD is cheap), so the bar moves by bytes, not by file count.
  const sizes = await Promise.all(
    items.map(async (it) => {
      try {
        const r = await fetch(it.url, { method: 'HEAD' });
        return Number(r.headers.get('content-length')) || 1e6;
      } catch {
        return 1e6;
      }
    }),
  );
  const total = sizes.reduce((a, b) => a + b, 0);
  let loaded = 0;
  const report = (label: string, prep = 0) => onProgress({ fraction: Math.min(1, (loaded / total) * 0.92 + prep * 0.08), label, loadedMB: loaded / 1e6, totalMB: total / 1e6 });
  report(items[0]?.label ?? '');
  // A few at a time: the bar fills steadily and the browser isn't flooded.
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      try {
        if (THREE.Cache.get(`file:${it.url}`)) {
          loaded += sizes[i];
          continue;
        }
        const res = await fetch(it.url);
        if (!res.ok || !res.body) throw new Error(`${res.status} ${it.url}`);
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.byteLength;
          loaded += value.byteLength;
          report(it.label);
        }
        const buf = new Uint8Array(got);
        let o = 0;
        for (const c of chunks) {
          buf.set(c, o);
          o += c.byteLength;
        }
        // Same key GLTFLoader's FileLoader uses ("file:" + the URL as requested).
        THREE.Cache.add(`file:${it.url}`, buf.buffer);
        loaded += Math.max(0, sizes[i] - got);
      } catch (err) {
        // Leaving the page cancels downloads: not worth a warning.
        if (!leaving) console.warn('Preload failed (will load on demand):', it.url, err);
        loaded += sizes[i];
      }
      report(it.label);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  report('Fizik motoru ve trafik modelleri hazırlanıyor…', 0.2);
  await PhysicsWorld.warmUp();
  report('Fizik motoru ve trafik modelleri hazırlanıyor…', 0.5);
  await loadTrafficModels();
  report('Hazır', 1);
}

let cacheReady = false;
let leaving = false;
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => (leaving = true));

/**
 * Turns on three.js's file cache for downloaded files only. GLTFLoader decodes
 * embedded textures through one-off blob: URLs; caching those would keep every
 * decoded texture alive after its car is gone, so they are never stored.
 */
function enableFileCache(): void {
  if (cacheReady) return;
  cacheReady = true;
  THREE.Cache.enabled = true;
  const add = THREE.Cache.add.bind(THREE.Cache);
  THREE.Cache.add = (key: string, file: unknown) => {
    if (key.includes('blob:') || key.includes('data:')) return;
    add(key, file);
  };
}
