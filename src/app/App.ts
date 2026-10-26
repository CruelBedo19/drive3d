import { AudioManager } from '../audio/AudioManager';
import { preloadAssets } from './AssetPreloader';
import { loadCityV2 } from '../world/cityv2/CityV2Assets';
import { CAR_REGISTRY, getCar } from '../config/carRegistry';
import { SETUP_IDS, isSetupId, type SetupId } from '../config/setups';
import { DEFAULT_TRACK, TRACK_IDS, isTrackId, type TrackId } from '../config/tracks';
import { GameFlow } from '../core/GameFlow';
import { acceptsDrivingInput, hasSession, showsDrivingHud, showsShowroom, type GameState } from '../core/GameState';
import { Game, type SessionContext } from '../core/Game';
import { PhysicsWorld } from '../core/PhysicsWorld';
import { Renderer } from '../core/Renderer';
import { GarageScene } from '../garage/GarageScene';
import { InputManager } from '../input/InputManager';
import { ProfileStore, profileHour, type Profile } from '../settings/Profile';
import { SettingsStore, type GameSettings } from '../settings/Settings';
import { CarConfirm, GarageUi, LoadingScreen, MainMenu, MapSelect, PauseMenu, TIME_LABELS, WEATHER_LABELS, carTitle, formatHour } from '../ui/screens/MenuScreens';
import type { Screen } from '../ui/screens/Screen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { loadTrafficModels } from '../traffic/TrafficModelLibrary';
import { FrameTimer } from '../utils/FrameTimer';
import { vehicleAssets } from '../vehicle/visual/VehicleAssetCache';
import { TRACK_CATALOG, trackInfo } from '../world/trackCatalog';
import { PRESET_HOURS } from '../world/weather/WeatherState';

export interface AppOptions {
  admin: boolean;
  /** Developer start (?track= / ?car= / ?setup=): skip the menus, nothing is saved. */
  direct: { track?: TrackId; car?: string; setup?: SetupId; seed?: number } | null;
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * The game shell: owns the long-lived systems (renderer, input, settings,
 * profile, audio), the menu screens and the single animation loop. GameFlow
 * decides the state; this class reacts: it shows the right screen, creates the
 * showroom or a driving session when needed and disposes what is no longer
 * shown, so moving between menus, garage and tracks never leaks scenes or loops.
 */
export class App {
  readonly flow = new GameFlow();
  readonly settings = new SettingsStore();
  readonly profile: ProfileStore;
  readonly audio: AudioManager;
  private readonly container: HTMLElement;
  private readonly options: AppOptions;
  private readonly renderer: Renderer;
  private readonly input = new InputManager();
  private readonly frameTimer: FrameTimer;
  private readonly screens: Partial<Record<GameState, Screen>>;
  private readonly mainMenu: MainMenu;
  private readonly mapSelect: MapSelect;
  private readonly carConfirm: CarConfirm;
  private readonly garageUi: GarageUi;
  private readonly loading: LoadingScreen;
  private readonly settingsScreen: SettingsScreen;
  private readonly unsubscribe: (() => void)[] = [];
  private showroom: GarageScene | null = null;
  private showroomCar = '';
  private game: Game | null = null;
  /** Bumped per load so a superseded load throws its result away. */
  private loadToken = 0;
  private sessionOverride: Partial<Pick<Profile, 'trackId' | 'carId' | 'setup'>> = {};
  private rafId = 0;
  private lastFrame = -1;
  private fpsLimit = 0;
  private disposed = false;

  constructor(container: HTMLElement, options: AppOptions) {
    this.container = container;
    this.options = options;
    this.renderer = new Renderer(container, this.settings.value.graphics.antialias);
    this.frameTimer = new FrameTimer(this.renderer.renderer.getContext());
    this.profile = new ProfileStore({ trackIds: TRACK_IDS, carIds: CAR_REGISTRY.map((c) => c.id), setups: SETUP_IDS, defaults: { trackId: DEFAULT_TRACK, carId: CAR_REGISTRY[0].id, setup: 'STREET' } });
    this.audio = new AudioManager(this.settings.value.audio);

    this.mainMenu = new MainMenu(container, {
      drive: () => this.flow.go('MAP_SELECT'),
      garage: () => this.flow.go('GARAGE'),
      settings: () => this.flow.go('SETTINGS'),
    });
    this.mapSelect = new MapSelect(container, TRACK_CATALOG, this.profile.value, {
      back: () => this.flow.back(),
      next: (trackId) => {
        this.profile.update({ trackId });
        this.flow.go('CAR_CONFIRM');
      },
      changed: (patch) => {
        this.profile.update(patch);
        this.mapSelect.setProfile(this.profile.value);
      },
    });
    this.carConfirm = new CarConfirm(container, {
      back: () => this.flow.back(),
      garage: () => this.flow.go('GARAGE'),
      drive: () => this.startDriving(),
      setup: (setup) => {
        this.profile.update({ setup });
        this.renderConfirm();
      },
    });
    this.garageUi = new GarageUi(container, {
      back: () => this.flow.back(),
      select: (carId) => {
        this.profile.update({ carId, setup: getCar(carId).defaultSetup });
        this.mainMenu.setCar(getCar(carId), this.profile.value.setup);
      },
      preview: (carId) => this.showCar(carId),
    });
    this.loading = new LoadingScreen(container);
    this.settingsScreen = new SettingsScreen(container, this.settings, () => this.flow.back());
    const pause = new PauseMenu(container, {
      resume: () => this.flow.go('DRIVING'),
      restart: () => {
        this.game?.restart();
        this.flow.go('DRIVING');
      },
      settings: () => this.flow.go('SETTINGS'),
      maps: () => this.flow.go('MAP_SELECT'),
      garage: () => this.flow.go('GARAGE'),
      mainMenu: () => this.flow.go('MAIN_MENU'),
    });
    this.screens = {
      MAIN_MENU: this.mainMenu,
      MAP_SELECT: this.mapSelect,
      CAR_CONFIRM: this.carConfirm,
      GARAGE: this.garageUi,
      LOADING: this.loading,
      PAUSED: pause,
      SETTINGS: this.settingsScreen,
    };

    this.unsubscribe.push(
      this.flow.subscribe((state, prev) => this.onState(state, prev)),
      this.settings.subscribe((s) => this.applySettings(s)),
    );
    window.addEventListener('keydown', this.onKeyDown);
  }

  /** The driving session, if one is running (dev tools, tests). */
  get session(): Game | null {
    return this.game;
  }

  get state(): GameState {
    return this.flow.state;
  }

  start(): void {
    this.rafId = requestAnimationFrame(this.frame);
    void this.boot();
  }

  /**
   * Site opened: the physics engine and the car the menu shows first (with a progress bar), then the menus (or
   * the direct drive). Other cars load when asked for; the traffic models start loading in the background.
   */
  private async boot(): Promise<void> {
    this.loading.set('Drive3D', 'Oyun dosyaları yükleniyor');
    this.loading.show();
    const direct = this.options.direct;
    const car = getCar(direct?.car ?? this.profile.value.carId);
    try {
      await preloadAssets(car.definition.visual.model?.url, carTitle(car), (p) => this.loading.progress(p.fraction, p.totalMB > 0 ? `${p.label} · ${p.loadedMB.toFixed(1)} / ${p.totalMB.toFixed(1)} MB` : p.label));
    } catch (err) {
      // Not fatal: the car then loads (or falls back) when shown.
      console.warn('Preloading failed', err);
    }
    if (this.disposed) return;
    this.loading.progress(null);
    // After the menu's first frames (car upload, shader compilation), so parsing them does not delay those.
    setTimeout(() => void loadTrafficModels(), 3000);
    if (direct) {
      this.sessionOverride = { trackId: direct.track, carId: direct.car, setup: direct.setup };
      this.flow.go('LOADING');
      void this.loadSession();
    } else {
      this.flow.go('MAIN_MENU');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    window.removeEventListener('keydown', this.onKeyDown);
    for (const u of this.unsubscribe) u();
    this.loadToken++;
    this.disposeSession();
    this.disposeShowroom();
    for (const s of Object.values(this.screens)) s?.dispose();
    this.audio.dispose();
    this.frameTimer.dispose();
    this.input.dispose();
    this.renderer.dispose();
  }

  // --- State reactions ------------------------------------------------------------

  private onState(state: GameState, prev: GameState): void {
    const fromPause = this.flow.settingsFromPause;
    // A key pressed on the previous screen must not act on this one (slow frames can merge them).
    this.input.endFrame();
    for (const [s, screen] of Object.entries(this.screens) as [GameState, Screen][]) {
      if (s !== state) screen.hide();
    }

    // Resources: a session lives in DRIVING / PAUSED (and settings opened from pause);
    // the showroom lives behind the menus. Whatever is not needed now is released.
    if (!hasSession(state, fromPause) && state !== 'LOADING') this.disposeSession();
    if (showsShowroom(state, fromPause)) this.ensureShowroom();
    else this.disposeShowroom();

    if (this.game) this.game.setHudVisible(showsDrivingHud(state));
    if (state === 'PAUSED' && prev === 'DRIVING') this.game?.onPause();

    const p = this.effectiveProfile();
    switch (state) {
      case 'MAIN_MENU':
        this.mainMenu.setCar(getCar(p.carId), p.setup);
        break;
      case 'MAP_SELECT':
        this.mapSelect.setProfile(this.profile.value);
        break;
      case 'CAR_CONFIRM':
        this.renderConfirm();
        break;
      case 'GARAGE':
        this.garageUi.open(p.carId);
        break;
    }
    if (this.showroom) {
      this.showroom.setMode(state === 'GARAGE' ? 'garage' : 'showcase');
      this.showCar(state === 'GARAGE' ? this.garageUi.previewId : p.carId);
      if (state === 'GARAGE') this.prefetchNeighbours(this.garageUi.previewId);
    }
    this.screens[state]?.show();
  }

  private applySettings(s: Readonly<GameSettings>): void {
    this.renderer.applyGraphics(s.graphics);
    this.audio.apply(s.audio);
    this.fpsLimit = Number(s.graphics.fpsLimit);
  }

  /** Profile with this run's developer overrides (?track / ?car) applied. */
  private effectiveProfile(): Profile {
    const p = this.profile.value;
    const o = this.sessionOverride;
    return { ...p, trackId: o.trackId ?? p.trackId, carId: getCar(o.carId ?? p.carId).id, setup: o.setup ?? p.setup };
  }

  private renderConfirm(): void {
    const p = this.effectiveProfile();
    const hour = profileHour(p, PRESET_HOURS);
    const when = p.time === 'custom' ? formatHour(hour) : `${TIME_LABELS[p.time]} ${formatHour(hour)}`;
    this.carConfirm.render(getCar(p.carId), p.setup, trackInfo(p.trackId), `${WEATHER_LABELS[p.weather]} · ${when}`);
  }

  private startDriving(): void {
    this.sessionOverride = {};
    this.flow.go('LOADING');
    void this.loadSession();
  }

  // --- Driving session --------------------------------------------------------------

  private async loadSession(): Promise<void> {
    const token = ++this.loadToken;
    const p = this.effectiveProfile();
    const car = getCar(p.carId);
    const track = isTrackId(p.trackId) ? p.trackId : DEFAULT_TRACK;
    const setup: SetupId = isSetupId(p.setup) ? p.setup : car.defaultSetup;
    this.loading.set(trackInfo(track)?.name ?? track, `${carTitle(car)} · ${setup}`);
    this.disposeSession();
    try {
      this.loading.stage('Fizik motoru hazırlanıyor…');
      await nextFrame();
      if (track === 'city') {
        // ~10 MB once per page (kept for later drives).
        await loadCityV2((f, mb, total) => this.loading.progress(f, `Şehir yükleniyor · ${mb.toFixed(1)} / ${total.toFixed(1)} MB`));
        if (token !== this.loadToken) return;
        this.loading.progress(null);
      }
      // The car's model (a cache hit when the garage or the menu showed it) and the traffic models.
      const carUrl = car.definition.visual.model?.url;
      if (carUrl && !vehicleAssets.has(carUrl)) {
        this.loading.stage('Araç modeli yükleniyor…');
        await vehicleAssets.prefetch(carUrl, (l, t) => this.loading.progress(t > 0 ? l / t : null, `Araç modeli yükleniyor · ${(l / 1e6).toFixed(1)}${t > 0 ? ` / ${(t / 1e6).toFixed(1)}` : ''} MB`));
        this.loading.progress(null);
        if (token !== this.loadToken) return;
      }
      this.loading.stage('Trafik modelleri hazırlanıyor…');
      await loadTrafficModels();
      if (token !== this.loadToken) return;
      const physics = await PhysicsWorld.create();
      if (token !== this.loadToken) return physics.dispose();
      this.loading.stage('Pist oluşturuluyor…');
      await nextFrame();
      await nextFrame();
      if (token !== this.loadToken) return physics.dispose();
      const ctx: SessionContext = { container: this.container, renderer: this.renderer, input: this.input, settings: this.settings, admin: this.options.admin, carIds: CAR_REGISTRY.map((c) => c.id), frameTimer: this.frameTimer };
      const game = new Game(ctx, physics, { car, setup, track, weather: p.weather, hour: profileHour(p, PRESET_HOURS), seed: this.options.direct?.seed });
      this.loading.stage('Araç modeli yükleniyor…');
      await game.modelReady;
      if (token !== this.loadToken) return game.dispose();
      this.game = game;
      this.flow.go('DRIVING');
    } catch (err) {
      console.error(err);
      if (token !== this.loadToken) return;
      this.disposeSession();
      this.loading.stage(`Yüklenemedi: ${err instanceof Error ? err.message : String(err)}`);
      setTimeout(() => {
        if (this.flow.state === 'LOADING') this.flow.go('MAIN_MENU');
      }, 2500);
    }
  }

  private disposeSession(): void {
    this.game?.dispose();
    this.game = null;
  }

  // --- Showroom (menus / garage background) -------------------------------------------

  private ensureShowroom(): void {
    if (this.showroom) return;
    this.showroom = new GarageScene(this.renderer.renderer.domElement, this.settings.value.graphics.shadows !== 'off');
    this.showroomCar = '';
  }

  private showCar(carId: string): void {
    if (!this.showroom || carId === this.showroomCar) return;
    this.showroomCar = carId;
    this.showroom.setCar(getCar(carId).definition);
    if (this.flow.state === 'GARAGE') this.prefetchNeighbours(carId);
  }

  /** Garage: once the shown car is in, the previous and next ones load in the background (never all of them). */
  private prefetchNeighbours(carId: string): void {
    const url = (id: string) => getCar(id).definition.visual.model?.url;
    const shown = url(carId);
    const i = CAR_REGISTRY.findIndex((c) => c.id === carId);
    const n = CAR_REGISTRY.length;
    const neighbours = [CAR_REGISTRY[(i + 1) % n].id, CAR_REGISTRY[(i - 1 + n) % n].id];
    void (shown ? vehicleAssets.prefetch(shown) : Promise.resolve()).then(() => {
      // Still on this car: the user may have moved on while it loaded.
      if (this.showroomCar !== carId || this.flow.state !== 'GARAGE') return;
      for (const id of neighbours) {
        const u = url(id);
        if (u) void vehicleAssets.prefetch(u);
      }
    });
  }

  private disposeShowroom(): void {
    this.showroom?.dispose();
    this.showroom = null;
    this.showroomCar = '';
  }

  // --- Loop and keys --------------------------------------------------------------------

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    if (this.fpsLimit > 0 && this.lastFrame >= 0 && now - this.lastFrame < 1000 / this.fpsLimit - 1) return;
    // Clamp long frames (tab switch, breakpoint) so physics doesn't try to catch up.
    const dt = this.lastFrame < 0 ? 0 : Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.frameTimer.begin();
    const state = this.flow.state;
    if (this.game && hasSession(state, this.flow.settingsFromPause)) {
      this.game.tick(dt, acceptsDrivingInput(state));
    } else if (this.showroom) {
      const { width, height } = this.renderer.size;
      this.showroom.update(dt, width, height);
      this.renderer.render(this.showroom.scene, this.showroom.camera);
    }
    this.frameTimer.end(dt);
    this.input.endFrame();
  };

  /** Esc goes back / pauses; ← → switch cars in the garage. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (e.code === 'Escape') {
      if (this.settingsScreen.isCapturing) return;
      e.preventDefault();
      this.flow.escape();
    } else if (this.flow.state === 'GARAGE' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      this.garageUi.step(e.code === 'ArrowLeft' ? -1 : 1);
    }
  };
}
