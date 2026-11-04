import { PhysicsWorld } from '../core/PhysicsWorld';
import { vehicleAssets } from '../vehicle/visual/VehicleAssetCache';

export interface PreloadProgress {
  /** 0..1 over the car's bytes plus the physics engine. */
  fraction: number;
  /** What is being fetched / prepared right now. */
  label: string;
  loadedMB: number;
  totalMB: number;
}

/**
 * What the site needs before the main menu: the physics engine and the one car
 * shown behind the menu (into the shared VehicleAssetCache). Every other player
 * car loads when the garage or a drive asks for it; the traffic models load in
 * the background once the menu is up (App.boot) and a drive waits for them. A
 * car that fails here is not fatal: the showroom tries again or keeps the
 * stand-in.
 */
export async function preloadAssets(carUrl: string | undefined, carLabel: string, onProgress: (p: PreloadProgress) => void): Promise<void> {
  let physicsReady = false;
  let loaded = 0;
  let total = 0;
  const report = () => {
    const car = total > 0 ? loaded / total : 0;
    onProgress({ fraction: Math.min(1, car * 0.85 + (physicsReady ? 0.15 : 0)), label: carLabel, loadedMB: loaded / 1e6, totalMB: total / 1e6 });
  };
  onProgress({ fraction: 0, label: 'Preparing files…', loadedMB: 0, totalMB: 0 });
  const physics = PhysicsWorld.warmUp().then(() => {
    physicsReady = true;
    report();
  });
  const car = carUrl
    ? vehicleAssets.prefetch(carUrl, (l, t) => {
        loaded = l;
        total = t;
        report();
      })
    : Promise.resolve();
  await Promise.all([physics, car]);
  onProgress({ fraction: 1, label: 'Ready', loadedMB: total / 1e6, totalMB: total / 1e6 });
}
