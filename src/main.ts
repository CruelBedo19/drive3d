import './ui/styles.css';
import './ui/menu.css';
import { App } from './app/App';
import { findCar } from './config/carRegistry';
import { isSetupId } from './config/setups';
import { canonicalTrackId, isTrackId } from './config/tracks';

function boot(): void {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app container missing');

  // Developer / old links: ?track=test|nordschleife, ?car=<id>, ?setup=STREET|SPORT|DRIFT start driving
  // straight away (menus skipped, nothing saved); ?seed=<n> picks the Autobahn seed. ?admin: super-admin panel (always on in dev).
  const params = new URLSearchParams(window.location.search);
  const track = canonicalTrackId(params.get('track')?.toLowerCase() ?? null);
  const car = params.get('car');
  const setup = params.get('setup')?.toUpperCase() ?? null;
  const seedParam = params.get('seed');
  const seed = seedParam !== null && /^\d+$/.test(seedParam) ? Number(seedParam) : undefined;
  const direct =
    params.has('track') || params.has('car') || params.has('setup')
      ? { track: isTrackId(track) ? track : undefined, car: findCar(car)?.id, setup: isSetupId(setup) ? setup : undefined, seed }
      : null;
  const admin = import.meta.env.DEV || params.has('admin');

  const app = new App(container, { admin, direct });
  app.start();

  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__app = app;
    // Kept for dev tools and older scripts: the current driving session.
    Object.defineProperty(window, '__game', { configurable: true, get: () => app.session });
    import.meta.hot?.dispose(() => app.dispose());
  }
}

try {
  boot();
} catch (err) {
  console.error(err);
  const msg = document.createElement('pre');
  msg.className = 'boot-error';
  msg.textContent = `Oyun başlatılamadı:\n${err instanceof Error ? err.message : String(err)}`;
  document.body.appendChild(msg);
}
