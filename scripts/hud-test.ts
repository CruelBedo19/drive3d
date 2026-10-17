/**
 * HUD logic without a browser: settings persistence and validation, minimap
 * projection (fixed / rotating), map data from both tracks. Part of `npm run test:sim`.
 */
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { SettingsStore, defaultSettings, sanitizeSettings } from '../src/settings/Settings';
import { ROTATING_CENTER_Y, arrowAngle, minimapTransform, type MinimapView } from '../src/ui/map/Minimap';
import { createTrack } from '../src/world/createTrack';
import { check, finish, section } from './lib/sim';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

function project(v: MinimapView, x: number, z: number): [number, number] {
  const [a, b, c, d, e, f] = minimapTransform(v);
  return [a * x + c * z + e, b * x + d * z + f];
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

async function main(): Promise<void> {
  section('Settings');
  {
    const def = defaultSettings();
    check('defaults: minimap bottom left, rotating, km/h, HUD on', def.ui.minimap && def.ui.minimapSide === 'left' && def.ui.speedUnit === 'kmh' && def.ui.hud && def.ui.hudScale === 1, JSON.stringify(def.ui));
    const bad = sanitizeSettings({ ui: { minimapSide: 'top', hudScale: 9, showFps: 'yes', speedUnit: 'mph', extra: 1 } });
    check('invalid stored values fall back, valid ones kept, range clamped', bad.ui.minimapSide === 'left' && bad.ui.hudScale === 1.4 && bad.ui.showFps === false && bad.ui.speedUnit === 'mph' && !('extra' in bad.ui), JSON.stringify(bad.ui));
    check('garbage in storage gives defaults', JSON.stringify(sanitizeSettings('nope')) === JSON.stringify(def), 'string input');

    const storage = new MemoryStorage();
    const store = new SettingsStore(storage as unknown as Storage);
    let calls = 0;
    store.subscribe(() => calls++);
    store.set('ui', 'minimapSide', 'right');
    store.set('ui', 'speedUnit', 'mph');
    const reloaded = new SettingsStore(storage as unknown as Storage);
    check('changes are saved and restored', reloaded.value.ui.minimapSide === 'right' && reloaded.value.ui.speedUnit === 'mph' && calls === 3, `listener calls ${calls}, stored ${[...storage.data.values()][0]}`);
    storage.data.set([...storage.data.keys()][0], '{broken json');
    check('corrupt storage does not crash', new SettingsStore(storage as unknown as Storage).value.ui.minimapSide === 'left', 'falls back to defaults');
  }

  section('Minimap projection');
  {
    const base: MinimapView = { x: 100, z: -50, yaw: 0, mode: 'fixed', radius: 200, size: 200 };
    const [cx, cy] = project(base, 100, -50);
    const [rx, ry] = project({ ...base, mode: 'rotating', yaw: 1 }, 100, -50);
    check('player at the centre (fixed), lower down when rotating', near(cx, 100) && near(cy, 100) && near(rx, 100) && near(ry, 200 * ROTATING_CENTER_Y), `fixed ${cx}, ${cy} · rotating ${rx.toFixed(1)}, ${ry.toFixed(1)}`);
    const [nx, ny] = project(base, 100, -150);
    check('fixed: north (-z) is up, scale = size / 2 / radius', near(nx, 100) && near(ny, 50), `100 m north → ${nx.toFixed(1)}, ${ny.toFixed(1)}`);
    for (const yaw of [0, 0.7, Math.PI / 2, -2.4, Math.PI]) {
      const v = { ...base, mode: 'rotating' as const, yaw };
      const ahead = project(v, 100 + Math.sin(yaw) * 100, -50 + Math.cos(yaw) * 100);
      const right = project(v, 100 - Math.cos(yaw) * 100, -50 + Math.sin(yaw) * 100);
      const cy = 200 * ROTATING_CENTER_Y;
      check(`rotating, yaw ${yaw.toFixed(2)}: heading up, car's right on the right`, near(ahead[0], 100, 1e-4) && near(ahead[1], cy - 50, 1e-4) && near(right[0], 150, 1e-4) && near(right[1], cy, 1e-4), `ahead → ${ahead.map((n) => n.toFixed(1))}, right → ${right.map((n) => n.toFixed(1))}`);
    }
    // Fixed mode: the arrow points where the car is heading on the map.
    const yaw = 0.9;
    const v = { ...base, yaw };
    const ahead = project(v, 100 + Math.sin(yaw) * 10, -50 + Math.cos(yaw) * 10);
    const screenAngle = Math.atan2(ahead[0] - 100, -(ahead[1] - 100));
    check('fixed: arrow follows the heading', near(arrowAngle(v), screenAngle), `arrow ${arrowAngle(v).toFixed(3)} rad, map heading ${screenAngle.toFixed(3)} rad`);
    check('rotating: arrow straight up', arrowAngle({ yaw: 1.2, mode: 'rotating' }) === 0, '0 rad');
  }

  section('Map data from tracks');
  for (const id of ['test', 'nordschleife'] as const) {
    const physics = await PhysicsWorld.create();
    const track = createTrack(id, physics.world);
    const m = track.mapData;
    const points = m.paths.reduce((n, p) => n + p.points.length / 2, 0);
    const start = m.markers.find((k) => k.kind === 'start');
    // Spawn should lie on (near) the main path.
    const main = m.paths.find((p) => p.kind === 'track');
    let best = Infinity;
    if (main) {
      const p = main.points;
      const n = p.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        best = Math.min(best, segmentDistance(track.spawn.position.x, track.spawn.position.z, p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]));
      }
    }
    check(`${id}: track path, start marker, spawn on the path`, !!main && !!start && best < 12, `${m.paths.length} paths, ${points} points, spawn ${best.toFixed(1)} m from path, view radius ${m.viewRadius} m`);
    if (id === 'nordschleife') check('nordschleife: light enough for a per-frame Path2D', points < 5000, `${points} points for ${(main ? main.points.length / 2 : 0)} vertices`);
    physics.dispose();
  }
  finish();
}

function segmentDistance(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
