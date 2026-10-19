import { CHASE_CLOSE, CHASE_NORMAL, CameraRig, ChaseCamera, HoodCamera, type CameraTarget } from '../camera/CameraRig';
import { bindingCode, updateCameraInput } from '../camera/cameraInput';
import { autobahnSpeedPatch } from '../config/autobahnTune';
import type { CarEntry } from '../config/carRegistry';
import { SETUPS, applySetup, isSetupId, type SetupId } from '../config/setups';
import type { AdminHost } from '../admin/AdminHost';
import { AdminPanel } from '../admin/AdminPanel';
import { assignDeep } from '../admin/configPath';
import { Measurements } from '../admin/Measurements';
import { TuningStore } from '../admin/TuningStore';
import type { VehicleConfig } from '../config/vehicleTypes';
import type { TrackId } from '../config/tracks';
import { DrivingInput } from '../input/DrivingInput';
import type { InputManager } from '../input/InputManager';
import type { WeatherKind } from '../settings/Profile';
import { keyLabel, type GameSettings, type SettingsStore, type VegetationDistance } from '../settings/Settings';
import { DebugOverlay } from '../ui/DebugOverlay';
import { Hud, type HudFrame } from '../ui/Hud';
import type { AssistState } from '../ui/hud/Speedometer';
import { FpsCounter } from '../utils/FpsCounter';
import type { FrameTimer } from '../utils/FrameTimer';
import { Vehicle } from '../vehicle/Vehicle';
import { VehiclePhysics } from '../vehicle/physics/VehiclePhysics';
import { createVehicleVisual } from '../vehicle/visual/createVehicleVisual';
import type { VehicleVisual } from '../vehicle/visual/VehicleVisual';
import * as THREE from 'three';
import { TrafficDebugView, type TrafficDebugFlags } from '../traffic/TrafficDebugView';
import { TRAFFIC_DENSITY_LABELS, TRAFFIC_DENSITY_STEPS } from '../config/traffic';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { TrafficVisuals } from '../traffic/TrafficVisuals';
import { createTrack } from '../world/createTrack';
import type { TrackView } from '../world/Track';
import { HeadlightController, HeadlightRig } from '../world/weather/Headlights';
import { WeatherManager } from '../world/weather/WeatherManager';
import { DrivingSim } from './DrivingSim';
import { PhysicsDebugRenderer } from './PhysicsDebugRenderer';
import type { PhysicsWorld } from './PhysicsWorld';
import type { Renderer } from './Renderer';

/** Shared, long-lived systems a session borrows from the App (never disposed by it). */
export interface SessionContext {
  container: HTMLElement;
  renderer: Renderer;
  input: InputManager;
  settings: SettingsStore;
  /** Super-admin mode: tuning panel, test tools, saved working tune. */
  admin: boolean;
  /** Selectable car ids (admin car switcher). */
  carIds: readonly string[];
  /** Real frame cost (CPU / GPU), for the FPS capacity readout. */
  frameTimer: FrameTimer;
}

export interface SessionOptions {
  car: CarEntry;
  setup: SetupId;
  track: TrackId;
  /** Procedural tracks: world seed (default from the track config). */
  seed?: number;
  weather: WeatherKind;
  hour: number;
}

const VEGETATION_DISTANCE: Record<VegetationDistance, number> = { low: 220, medium: 450, high: 900 };
const DEFAULT_FOG = { near: 150, far: 650 };

/**
 * One driving session: track, car, camera, HUD, weather, admin tools. Created
 * by the App when loading finishes and disposed when the player leaves; the
 * App owns the only animation loop and calls tick() each frame.
 */
export class Game implements AdminHost {
  readonly carId: string;
  readonly carIds: readonly string[];
  readonly vehicle: Vehicle;
  readonly sim: DrivingSim;
  readonly measurements = new Measurements();
  readonly weather: WeatherManager;
  setupId: SetupId;
  readonly trackId: TrackId;
  /** Simulation speed (admin slow motion). 1 = real time. */
  timeScale = 1;

  private readonly ctx: SessionContext;
  private readonly car: CarEntry;
  private readonly visual: VehicleVisual;
  private readonly cameraRig: CameraRig;
  private readonly cameraTarget: CameraTarget;
  private readonly hud: Hud;
  /** Light switch (manual / auto + L) and the light itself. */
  readonly headlights: HeadlightController;
  private readonly headlightRig: HeadlightRig;
  /** Read by the visual proxy: model lamp meshes glow when on. */
  private lampsOn = false;
  private readonly unsubscribeSettings: () => void;
  private readonly fps = new FpsCounter();
  private readonly debug: DebugOverlay | null;
  private readonly physicsDebug: PhysicsDebugRenderer | null;
  private readonly admin: AdminPanel | null = null;
  private settings: Readonly<GameSettings>;
  private mapRevision: number | undefined;
  private disposed = false;
  /** AI traffic (worlds with a lane network) with its drawing, debug view and minimap buffers. */
  traffic: TrafficSystem | null = null;
  private trafficVisuals: TrafficVisuals | null = null;
  private trafficDebugView: TrafficDebugView | null = null;
  private trafficClock = 0;
  private readonly trafficXZ = new Float32Array(256);
  private readonly trafficWreck = new Uint8Array(128);

  constructor(ctx: SessionContext, physics: PhysicsWorld, options: SessionOptions) {
    this.ctx = ctx;
    this.car = options.car;
    this.carId = options.car.id;
    this.carIds = ctx.carIds;
    this.setupId = options.setup;
    this.trackId = options.track;
    this.settings = ctx.settings.value;
    const renderer = ctx.renderer;

    const track = createTrack(options.track, physics.world, options.seed);
    renderer.scene.add(track.group);
    renderer.setFog(track.fog?.near ?? DEFAULT_FOG.near, track.fog?.far ?? DEFAULT_FOG.far);
    renderer.camera.near = track.cameraNear ?? 0.05;
    renderer.camera.updateProjectionMatrix();

    // In admin mode the last working tune for this car comes back after a reload.
    const saved = ctx.admin ? TuningStore.loadWorking(this.carId) : null;
    if (saved && isSetupId(saved.setup)) this.setupId = saved.setup;
    let config = this.baseConfig(this.setupId);
    if (saved) {
      try {
        config = applySetup(config, saved.patch);
      } catch {
        TuningStore.clearWorking(this.carId);
      }
    }
    this.visual = createVehicleVisual(this.car.definition);
    const spawn = track.spawn;
    const start = spawn.position.clone().setY(spawn.position.y + VehiclePhysics.restHeight(config) + 0.05);
    // The vehicle drives its visual every frame; this thin proxy adds the headlight state
    // (the vehicle code itself doesn't know about the light switch).
    const real = this.visual;
    const proxy: VehicleVisual = {
      root: real.root,
      hoodCameraOffset: real.hoodCameraOffset,
      update: (state) => {
        state.headlights = this.lampsOn;
        real.update(state);
      },
      dispose: () => real.dispose(),
    };
    this.vehicle = new Vehicle(physics.world, config, proxy, start, spawn.yaw);
    renderer.scene.add(this.visual.root);
    const driving = new DrivingInput(ctx.input, () => this.settings.controls);
    this.sim = new DrivingSim(physics, track, this.vehicle, driving);
    if (ctx.admin) this.sim.onStep = (dt) => this.measure(dt);

    // One shadowless spot light at the nose (works for every car, with or without lamp meshes).
    this.headlightRig = new HeadlightRig(config.chassis.halfExtents.z * 0.98, 0.05);
    this.visual.root.add(this.headlightRig.group);
    this.headlights = new HeadlightController(this.settings.ui.headlightMode);

    this.weather = new WeatherManager(renderer, track, options.weather, options.hour, this.settings.graphics.weatherQuality);
    this.createTraffic();

    this.cameraTarget = {
      position: this.vehicle.renderPosition,
      quaternion: this.vehicle.renderQuaternion,
      forwardSpeed: 0,
      hoodOffset: this.visual.hoodCameraOffset,
    };
    this.cameraRig = new CameraRig(renderer.camera, [new ChaseCamera('chase', CHASE_NORMAL), new ChaseCamera('close', CHASE_CLOSE), new HoodCamera()]);
    this.cameraRig.reset(this.cameraTarget);

    this.hud = new Hud(ctx.container, config.engine.redlineRpm);
    this.hud.setMapData(track.mapData);
    if (track.attribution) this.hud.setAttribution(track.attribution);
    this.hud.setVisible(false);
    this.unsubscribeSettings = ctx.settings.subscribe((s) => {
      this.settings = s;
      this.weather.setQuality(s.graphics.weatherQuality);
      this.headlights.setMode(s.ui.headlightMode);
      this.hud.applySettings(s.ui);
      this.traffic?.setDensity(s.traffic.density);
      this.traffic?.setVariety(s.traffic.variety);
      this.traffic?.setCutIns(s.traffic.cutIns);
      const k = s.controls;
      this.hud.setHelp(
        `${keyLabel(k.throttle)}/${keyLabel(k.brake)} gaz-fren · ${keyLabel(k.left)}/${keyLabel(k.right)} direksiyon · ${keyLabel(k.handbrake)} el freni · ` +
          `${keyLabel(k.camera)} kamera · ${keyLabel(k.lookBack)} arkaya bak · ${keyLabel(k.headlights)} far · ${keyLabel(k.map)} harita · ${this.traffic ? `${keyLabel(k.trafficDensity)} trafik · ` : ''}${keyLabel(k.recover)} düzelt · ${keyLabel(k.respawn)} başa dön · Esc duraklat`,
      );
    });

    if (import.meta.env.DEV || ctx.admin) {
      this.debug = new DebugOverlay(ctx.container);
      this.physicsDebug = new PhysicsDebugRenderer(physics.world, renderer.scene);
    } else {
      this.debug = null;
      this.physicsDebug = null;
    }
    if (ctx.admin) this.admin = new AdminPanel(ctx.container, this);
    this.updateLabel();
  }

  // --- AdminHost -------------------------------------------------------------

  get testPoints() {
    return this.sim.track.testPoints;
  }

  baseConfig(setup: SetupId): VehicleConfig {
    const config = applySetup(this.car.definition.physics, SETUPS[setup]);
    // Autobahn only: the high-speed pack (~340 km/h); every other map drives the setup as is.
    return this.trackId === 'autobahn' ? applySetup(config, autobahnSpeedPatch(config)) : config;
  }

  applyConfig(config: VehicleConfig): void {
    assignDeep(this.vehicle.config, config);
    this.configEdited();
  }

  configEdited(): void {
    this.vehicle.refreshConfig();
    this.updateLabel();
  }

  teleport(id: string): void {
    const p = this.sim.track.testPoints.find((t) => t.id === id);
    if (!p) return;
    this.sim.placeOnGround(p.position, p.yaw);
    this.resetView();
  }


  toggleDebugPanel(): boolean {
    this.debug?.toggle();
    return this.debug !== null;
  }

  trackDebug(): Record<string, string | number> | null {
    return this.sim.track.debugInfo?.() ?? null;
  }

  trackDebugLayers(): { id: string; label: string; on: boolean }[] {
    return this.sim.track.debugLayers?.() ?? [];
  }

  setTrackDebugLayer(id: string, on: boolean): void {
    this.sim.track.setDebugLayer?.(id, on);
  }

  /** F2: rebuild a procedural road from another seed and put the car at its start. */
  regenerateTrack(seed: number): void {
    if (!this.sim.track.regenerate) return;
    this.sim.track.regenerate(seed);
    // The lanes belong to the old road: new traffic on the new one.
    this.disposeTraffic();
    this.createTraffic();
    this.sim.restartAtSpawn();
    this.resetView();
  }

  trafficDebug(): { stats: Record<string, string | number>; selected: Record<string, string | number> | null } | null {
    const t = this.traffic;
    if (!t) return null;
    const s = t.stats();
    const stats: Record<string, string | number> = {
      'Aktif araç': s.active,
      'Yakın / orta / uzak': `${s.near} / ${s.medium} / ${s.far}`,
      'Spawn / despawn': `${s.spawned} / ${s.despawned}`,
      'Spawn hızı (/dk)': s.spawnRate.toFixed(1),
      'Şerit doluluğu (sağ/orta/sol)': s.laneOccupancy.join(' / '),
      'Ortalama hız (km/h)': s.avgSpeedKmh.toFixed(0),
      'Şerit değiştirme': s.laneChanges,
      'Reddedilen / iptal': `${s.rejectedLaneChanges} / ${s.abortedLaneChanges}`,
      Kaza: s.crashes,
      'Önüne kırma': s.cutIns,
      'Çarpışma gövdesi': s.bodies,
      'Güncelleme ms (adım / kare)': `${s.updateMs.toFixed(3)} / ${s.renderMs.toFixed(3)}`,
    };
    const v = t.selected;
    const selected = v
      ? {
          Tür: v.klass.label,
          Sürücü: v.profile.label,
          'Hız (km/h)': (v.v * 3.6).toFixed(0),
          'Hedef hız (km/h)': (t.wantedSpeed(v) * 3.6).toFixed(0),
          Şerit: `${v.carriageway === 0 ? 'A' : 'B'} ${['sağ', 'orta', 'sol'][v.lane]}`,
          Durum: v.bold ? `${v.state} (cesur)` : v.state,
          'Öndeki araç (m)': Number.isFinite(v.leadGap) ? v.leadGap.toFixed(1) : '—',
          'İstenen boşluk (m)': v.desiredGap.toFixed(1),
          'Şerit değiştirme hedefi': v.state === 'cruise' ? '—' : ['sağ', 'orta', 'sol'][v.toLane],
          Seviye: ['yakın', 'orta', 'uzak'][v.tier],
        }
      : null;
    return { stats, selected };
  }

  trafficSelectNext(): void {
    this.traffic?.selectNext();
  }

  get trafficFlags(): TrafficDebugFlags | null {
    return this.trafficDebugView?.flags ?? null;
  }

  private createTraffic(): void {
    const net = this.sim.track.laneNetwork;
    if (!net) return;
    const p = this.vehicle.physics;
    const traffic = new TrafficSystem(this.sim.physics.world, net, { position: p.position, velocity: p.linearVelocity, forward: p.forward, halfExtents: this.vehicle.config.chassis.halfExtents }, net.gen.seed, this.settings.traffic.density, this.settings.traffic.variety, this.settings.traffic.cutIns);
    const visuals = new TrafficVisuals();
    traffic.onSpawn = (v) => visuals.add(v);
    traffic.onDespawn = (v) => visuals.remove(v);
    this.ctx.renderer.scene.add(visuals.group);
    this.traffic = traffic;
    this.trafficVisuals = visuals;
    this.trafficDebugView = new TrafficDebugView();
    this.ctx.renderer.scene.add(this.trafficDebugView.group);
    this.sim.systems.push(traffic);
  }

  private disposeTraffic(): void {
    if (!this.traffic) return;
    const i = this.sim.systems.indexOf(this.traffic);
    if (i >= 0) this.sim.systems.splice(i, 1);
    this.traffic.dispose();
    this.trafficVisuals?.dispose();
    this.trafficDebugView?.dispose();
    this.traffic = null;
    this.trafficVisuals = null;
    this.trafficDebugView = null;
    this.hud.setTraffic(this.trafficXZ, this.trafficWreck, 0);
  }

  /** Per frame: weather for the drivers, drawing, debug lines, minimap dots. */
  private updateTraffic(dt: number, alpha: number, camera: THREE.Vector3): void {
    const t = this.traffic;
    if (!t || !this.trafficVisuals) return;
    const t0 = performance.now();
    const w = this.weather.snapshot;
    const c = t.conditions;
    c.rain = w.rain;
    c.visibility = w.visibility;
    c.fogFar = this.sim.track.fog?.far ?? DEFAULT_FOG.far;
    c.night = w.night;
    c.daylight = w.daylight;
    this.trafficClock += dt;
    this.trafficVisuals.update(alpha, this.trafficClock, camera, Math.max(w.night, 1 - w.daylight));
    this.trafficDebugView?.update(t);
    let n = 0;
    if (this.settings.traffic.minimapDots) {
      for (const v of t.vehicles) {
        if (n >= 128) break;
        this.trafficXZ[n * 2] = v.pose.x;
        this.trafficXZ[n * 2 + 1] = v.pose.z;
        this.trafficWreck[n] = v.state === 'crashed' ? 1 : 0;
        n++;
      }
    }
    this.hud.setTraffic(this.trafficXZ, this.trafficWreck, n);
    t.renderMs = performance.now() - t0;
  }

  toggleColliders(): boolean {
    this.physicsDebug?.toggle();
    return this.physicsDebug?.enabled ?? false;
  }

  // --- Session ---------------------------------------------------------------

  /** Read-only access for dev tooling (exposed on window in dev builds). */
  get telemetry() {
    return this.vehicle.telemetry;
  }

  /** Resolves when the car's model has loaded (or fell back to the placeholder). */
  get modelReady(): Promise<boolean> {
    const ready = (this.visual as { ready?: Promise<boolean> }).ready;
    return ready ?? Promise.resolve(true);
  }

  get cameraModeName(): string {
    return this.cameraRig.mode.name;
  }

  get lookingBack(): boolean {
    return this.cameraRig.lookingBack;
  }

  /** The HUD shows while driving and stays behind the pause overlay. */
  setHudVisible(visible: boolean): void {
    this.hud.setVisible(visible);
  }

  /** After the car jumps somewhere: camera behind it, tunnel lighting without a fade. */
  private resetView(): void {
    this.cameraRig.reset(this.cameraTarget);
    this.weather.snapCover();
  }

  /** "Yeniden başlat": back to the start line, standing still. */
  restart(): void {
    this.sim.restartAtSpawn();
    this.resetView();
  }

  /** Entering the pause menu: drop held input so nothing carries over on resume. */
  onPause(): void {
    this.sim.releaseInput();
    this.cameraRig.setLookBack(false);
  }

  /**
   * One rendered frame. `running` is true only in DRIVING: otherwise (pause)
   * nothing is simulated, no gameplay key reaches the car or the camera, and
   * the frozen scene is still drawn.
   */
  tick(dt: number, running: boolean): void {
    if (this.disposed) return;
    const input = this.ctx.input;
    if (running) this.handleActions();
    if (input.wasPressed('F3')) this.debug?.toggle();
    if (input.wasPressed('F4')) this.physicsDebug?.toggle();
    const cameraChange = updateCameraInput(input, this.settings.controls, this.cameraRig, this.cameraTarget, running);
    if (cameraChange) {
      this.hud.showToast(`Kamera: ${cameraChange}`);
      this.updateLabel();
    }

    const simDt = running ? dt * this.timeScale : 0;
    this.sim.advance(simDt, running);
    // Pause menu: show the newest physics state.
    const alpha = !running ? 1 : this.sim.alpha;
    this.vehicle.render(alpha);

    const camera = this.ctx.renderer.camera;
    this.cameraTarget.forwardSpeed = this.vehicle.telemetry.forwardSpeed;
    this.cameraRig.update(simDt, this.cameraTarget);
    this.ctx.renderer.setShadowFocus(this.vehicle.renderPosition);
    const view = this.trackView;
    view.camera = camera.position;
    view.vegetationDistance = VEGETATION_DISTANCE[this.settings.graphics.vegetationDistance];
    view.fogColor = this.ctx.renderer.fog.color;
    view.visibility = this.weather.snapshot.visibility;
    view.cameraFar = camera.far;
    this.sim.track.update(view);
    this.updateTraffic(dt, alpha, camera.position);
    this.weather.setCover(this.sim.track.coverAt?.(camera.position) ?? 0);
    this.weather.update(running ? dt * this.timeScale : 0, camera.position, this.vehicle.physics.linearVelocity);
    // Streamed tracks change their map as chunks load.
    const rev = this.sim.track.mapRevision;
    if (rev !== undefined && rev !== this.mapRevision) {
      this.mapRevision = rev;
      this.hud.setMapData(this.sim.track.mapData);
    }
    const w = this.weather.snapshot;
    this.lampsOn = this.headlights.update(this.weather.headlightsWanted);
    this.headlightRig.update(this.lampsOn, Math.min(1, w.rain * 0.9 + (1 - Math.min(1, w.visibility)) * 0.8), Math.max(w.night, 1 - w.daylight));

    this.fps.tick(dt);
    this.hud.update(dt, this.hudFrame());
    if (this.debug) {
      const t = this.ctx.frameTimer;
      this.debug.perf = `frame cost CPU ${t.cpuMs.toFixed(2)} ms · GPU ${t.hasGpuTiming ? `${t.gpuMs.toFixed(2)} ms` : 'n/a'} → max ~${Math.round(t.capacityFps)} FPS`;
    }
    this.debug?.update(dt, this.vehicle, this.fps.fps, this.fps.frameMs, this.sim.stepsThisFrame, this.physicsDebug?.enabled ?? false);
    this.physicsDebug?.update();
    this.admin?.update(dt);
    this.ctx.renderer.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSettings();
    this.hud.dispose();
    this.admin?.dispose();
    this.debug?.dispose();
    this.physicsDebug?.dispose();
    this.disposeTraffic();
    this.weather.dispose();
    this.headlightRig.dispose();
    this.visual.root.removeFromParent();
    this.sim.track.group.removeFromParent();
    this.sim.dispose();
  }

  private updateLabel(): void {
    const modified = JSON.stringify(this.baseConfig(this.setupId)) !== JSON.stringify(this.vehicle.config);
    if (this.debug) this.debug.label = `${this.car.brand} ${this.car.model} · ${this.setupId}${modified ? ' · özel ayar' : ''} · kamera ${this.cameraRig.mode.name}`;
  }

  private measure(dt: number): void {
    const p = this.vehicle.physics;
    const t = this.vehicle.telemetry;
    const speed = p.linearVelocity.length();
    const sample = this.measureSample;
    sample.speedKmh = speed * 3.6;
    sample.forwardSpeed = p.forwardSpeed;
    sample.brake = t.brake;
    sample.lateralG = (speed * Math.abs(p.angularVelocity.y)) / 9.81;
    const vx = p.linearVelocity.dot(p.left);
    sample.driftDeg = speed > 1 ? (Math.atan2(Math.abs(vx), Math.abs(p.forwardSpeed)) * 180) / Math.PI : 0;
    sample.distance = speed * dt;
    this.measurements.update(dt, sample);
  }

  private readonly trackView: TrackView = { camera: new THREE.Vector3(), vegetationDistance: 450 };

  private readonly measureSample = { speedKmh: 0, forwardSpeed: 0, brake: 0, lateralG: 0, driftDeg: 0, distance: 0 };

  private readonly frameData: HudFrame = { speedKmh: 0, rpm: 0, gear: 'N', tc: 'off', abs: 'off', handbrake: false, x: 0, z: 0, yaw: 0, speed: 0, fps: 0, capacityFps: 0 };

  /** Player-facing numbers for the HUD (read only: nothing here feeds back into the physics). */
  private hudFrame(): HudFrame {
    const f = this.frameData;
    const v = this.vehicle;
    const t = v.telemetry;
    const a = v.config.assists;
    const wheels = v.physics.wheels;
    f.speedKmh = t.speedKmh;
    f.rpm = t.rpm;
    f.gear = t.gear;
    f.handbrake = t.handbrake > 0.3;
    // TC lamp: on when traction control or the drift wheelspin limiter is enabled, lit while it cuts torque.
    let tc: AssistState = a.tractionControl > 0 || a.wheelspinLimit > 0 ? 'on' : 'off';
    if (tc === 'on' && t.throttle > 0.1 && wheels.some((w) => w.tcScale < 0.95 || w.spinScale < 0.95)) tc = 'active';
    f.tc = tc;
    // ABS lamp: lit while braking hard enough that a wheel sits at its slip limit.
    let abs: AssistState = a.abs > 0 ? 'on' : 'off';
    if (abs === 'on' && t.brake > 0.2 && t.speedKmh > 15 && wheels.some((w) => w.slipRatio < -0.06)) abs = 'active';
    f.abs = abs;
    f.x = v.renderPosition.x;
    f.z = v.renderPosition.z;
    f.yaw = v.yaw;
    f.speed = t.forwardSpeed;
    f.fps = this.fps.fps;
    f.capacityFps = this.ctx.frameTimer.capacityFps;
    return f;
  }

  /** Gameplay keys other than the camera (only called while driving). */
  private handleActions(): void {
    const input = this.ctx.input;
    const c = this.settings.controls;
    if (this.admin) {
      if (input.wasPressed('F2')) this.admin.toggle();
    }
    if (pressedBinding(input, c.headlights)) {
      this.headlights.toggle();
      this.hud.showToast(`Farlar: ${this.headlights.on ? 'açık' : 'kapalı'}${this.headlights.mode === 'auto' ? ' (otomatik geçici olarak değişti)' : ''}`);
    }
    if (pressedBinding(input, c.map)) this.hud.setMapExpanded(!this.hud.mapExpanded);
    if (this.traffic && pressedBinding(input, c.trafficDensity)) {
      // Step the density without leaving the drive (saved like the settings screen does).
      const steps = TRAFFIC_DENSITY_STEPS;
      const next = steps[(steps.indexOf(this.settings.traffic.density) + 1) % steps.length];
      this.ctx.settings.set('traffic', 'density', next);
      this.hud.showToast(`Trafik: ${TRAFFIC_DENSITY_LABELS[next]}`);
    }
    const respawn = pressedBinding(input, c.respawn);
    if (respawn) {
      this.sim.respawnAtStart();
      this.resetView();
    } else if (pressedBinding(input, c.recover)) {
      // Off the road on a streamed world (Autobahn): back onto the nearest lane, facing the traffic.
      const track = this.sim.track;
      if (track.onRoad && track.safeRespawn && !track.onRoad(this.vehicle.physics.position)) this.sim.respawnAtStart();
      else this.sim.recoverInPlace();
      this.resetView();
    }
  }
}

/** A binding fired this frame ("Shift+KeyR" needs Shift held at the press; plain "KeyR" ignores Shift). */
function pressedBinding(input: InputManager, binding: string): boolean {
  const code = bindingCode(binding);
  return binding.startsWith('Shift+') ? input.wasPressedWithShift(code) : input.wasPressed(code);
}
