import * as THREE from 'three';
import { CHASE_CLOSE, CHASE_NORMAL, CameraRig, ChaseCamera, HoodCamera, type CameraTarget } from '../camera/CameraRig';
import { bindingCode, updateCameraInput } from '../camera/cameraInput';
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
import { createTrack } from '../world/createTrack';
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
  weather: WeatherKind;
  hour: number;
}

const VEGETATION_DISTANCE: Record<VegetationDistance, number> = { low: 220, medium: 450, high: 900 };
const DEFAULT_FOG = { near: 150, far: 650 };
/** Headlight beam (one spot light parented to the car, off by day). */
const HEADLIGHT = { intensity: 180, distance: 90, angle: 0.5, penumbra: 0.45, decay: 1.4 };

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
  /** Simulation speed (admin slow motion). 1 = real time. */
  timeScale = 1;
  /** Admin pause (P), separate from the pause menu. */
  paused = false;

  private readonly ctx: SessionContext;
  private readonly car: CarEntry;
  private readonly visual: VehicleVisual;
  private readonly cameraRig: CameraRig;
  private readonly cameraTarget: CameraTarget;
  private readonly hud: Hud;
  private readonly headlight: THREE.SpotLight;
  private readonly unsubscribeSettings: () => void;
  private readonly fps = new FpsCounter();
  private readonly debug: DebugOverlay | null;
  private readonly physicsDebug: PhysicsDebugRenderer | null;
  private readonly admin: AdminPanel | null = null;
  private settings: Readonly<GameSettings>;
  private disposed = false;

  constructor(ctx: SessionContext, physics: PhysicsWorld, options: SessionOptions) {
    this.ctx = ctx;
    this.car = options.car;
    this.carId = options.car.id;
    this.carIds = ctx.carIds;
    this.setupId = options.setup;
    this.settings = ctx.settings.value;
    const renderer = ctx.renderer;

    const track = createTrack(options.track, physics.world);
    renderer.scene.add(track.group);
    renderer.setFog(track.fog?.near ?? DEFAULT_FOG.near, track.fog?.far ?? DEFAULT_FOG.far);

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
    this.vehicle = new Vehicle(physics.world, config, this.visual, start, spawn.yaw);
    renderer.scene.add(this.visual.root);
    const driving = new DrivingInput(ctx.input, () => this.settings.controls);
    this.sim = new DrivingSim(physics, track, this.vehicle, driving);
    if (ctx.admin) this.sim.onStep = (dt) => this.measure(dt);

    this.headlight = new THREE.SpotLight(0xfff4e0, 0, HEADLIGHT.distance, HEADLIGHT.angle, HEADLIGHT.penumbra, HEADLIGHT.decay);
    this.headlight.position.set(0, 0.7, 2.3);
    this.headlight.target.position.set(0, -0.6, 14);
    this.visual.root.add(this.headlight, this.headlight.target);

    this.weather = new WeatherManager(renderer, track, options.weather, options.hour);

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
      this.hud.applySettings(s.ui);
      const k = s.controls;
      this.hud.setHelp(
        `${keyLabel(k.throttle)}/${keyLabel(k.brake)} gaz-fren · ${keyLabel(k.left)}/${keyLabel(k.right)} direksiyon · ${keyLabel(k.handbrake)} el freni · ` +
          `${keyLabel(k.camera)} kamera · ${keyLabel(k.lookBack)} arkaya bak · ${keyLabel(k.recover)} düzelt · ${keyLabel(k.respawn)} başa dön · Esc duraklat`,
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
    return applySetup(this.car.definition.physics, SETUPS[setup]);
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
    this.cameraRig.reset(this.cameraTarget);
  }

  stepOnce(): void {
    this.paused = true;
    this.sim.requestStep();
  }

  toggleDebugPanel(): boolean {
    this.debug?.toggle();
    return this.debug !== null;
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

  /** "Yeniden başlat": back to the start line, standing still. */
  restart(): void {
    this.sim.respawnAtStart();
    this.cameraRig.reset(this.cameraTarget);
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

    const simDt = running && !this.paused ? dt * this.timeScale : 0;
    this.sim.advance(simDt, running);
    // Paused (admin single-stepping or pause menu): show the newest physics state.
    const alpha = !running || this.paused ? 1 : this.sim.alpha;
    this.vehicle.render(alpha);

    const camera = this.ctx.renderer.camera;
    this.cameraTarget.forwardSpeed = this.vehicle.telemetry.forwardSpeed;
    this.cameraRig.update(simDt, this.cameraTarget);
    this.ctx.renderer.setShadowFocus(this.vehicle.renderPosition);
    this.sim.track.update({ camera: camera.position, vegetationDistance: VEGETATION_DISTANCE[this.settings.graphics.vegetationDistance] });
    this.weather.update(running ? dt : 0, camera.position);
    this.headlight.intensity = this.weather.headlights ? HEADLIGHT.intensity : 0;

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
    this.weather.dispose();
    this.headlight.dispose();
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
      if (input.wasPressed('KeyP')) this.admin.handleKey('KeyP');
      if (input.wasPressed('Period')) this.admin.handleKey('Period');
    }
    const respawn = pressedBinding(input, c.respawn);
    if (respawn) {
      this.sim.respawnAtStart();
      this.cameraRig.reset(this.cameraTarget);
    } else if (pressedBinding(input, c.recover)) {
      this.sim.recoverInPlace();
      this.cameraRig.reset(this.cameraTarget);
    }
  }
}

/** A binding fired this frame ("Shift+KeyR" needs Shift held at the press; plain "KeyR" ignores Shift). */
function pressedBinding(input: InputManager, binding: string): boolean {
  const code = bindingCode(binding);
  return binding.startsWith('Shift+') ? input.wasPressedWithShift(code) : input.wasPressed(code);
}
