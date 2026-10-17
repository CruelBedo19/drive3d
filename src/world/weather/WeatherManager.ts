import * as THREE from 'three';
import type { Renderer } from '../../core/Renderer';
import type { WeatherKind } from '../../settings/Profile';
import type { WeatherQuality } from '../../settings/Settings';
import type { Track } from '../Track';
import { HeadlightController } from './Headlights';
import { Rain } from './Rain';
import { SkyDome } from './SkyDome';
import { WeatherState, type WeatherSnapshot } from './WeatherState';

/** What each "Hava efektleri" level costs. Even High stays modest for a browser. */
export const WEATHER_QUALITY: Record<WeatherQuality, { drops: number; clouds: boolean; envRefresh: number }> = {
  low: { drops: 2500, clouds: false, envRefresh: 6 },
  medium: { drops: 6000, clouds: true, envRefresh: 2 },
  high: { drops: 12000, clouds: true, envRefresh: 1 },
};

/**
 * The one weather system of a driving session: a WeatherState (numbers) drawn
 * through the renderer's lights / fog / exposure, a procedural sky with clouds
 * and stars, GPU rain around the camera and the track's wet-road look. The sky
 * is also rendered into a small environment map (image-based light and
 * reflections: car paint and wet asphalt need it), refreshed only when the sky
 * changes.
 * Independent of the vehicle physics: `gripFactor` is the future wet-physics
 * hook and is 1.
 */
export class WeatherManager {
  readonly state: WeatherState;
  private readonly renderer: Renderer;
  private readonly track: Track;
  private readonly sky = new SkyDome();
  private readonly rain: Rain;
  private quality: WeatherQuality;
  private snap: WeatherSnapshot;
  private readonly lightDir = new THREE.Vector3();
  private lastWetness = -1;
  private env: THREE.WebGLRenderTarget | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envScene: THREE.Scene | null = null;
  private envKey = '';
  private envTimer = Infinity;
  /** 0..1 roof over the camera (tunnel), eased. */
  private cover = 0;
  private coverTarget = 0;
  private coverSnap = false;
  private readonly warm = new THREE.Color(0xffd7a0);
  private readonly tmp = new THREE.Color();

  constructor(renderer: Renderer, track: Track, weather: WeatherKind, hour: number, quality: WeatherQuality) {
    this.renderer = renderer;
    this.track = track;
    this.quality = quality;
    this.state = new WeatherState(weather, hour);
    this.rain = new Rain(WEATHER_QUALITY[quality]);
    renderer.scene.add(this.sky.sky, this.sky.stars, this.rain.object);
    this.sky.setCloudsEnabled(WEATHER_QUALITY[quality].clouds);
    this.snap = this.state.snapshot();
    this.apply(0, renderer.camera.position, new THREE.Vector3());
  }

  get snapshot(): Readonly<WeatherSnapshot> {
    return this.snap;
  }

  get weather(): WeatherKind {
    return this.state.weather;
  }

  /** Whether automatic headlights would be on now. */
  get headlightsWanted(): boolean {
    return HeadlightController.wanted(this.snap);
  }

  /** Grip multiplier for wet roads (1: weather is visual only for now). */
  get gripFactor(): number {
    return 1;
  }

  setWeather(kind: WeatherKind, instant = false): void {
    this.state.setWeather(kind, instant);
  }

  setHour(hour: number): void {
    this.state.setHour(hour);
  }

  /** Roof over the camera 0..1 (tunnels): no rain inside, tunnel lighting instead of the sky. */
  setCover(cover: number): void {
    this.coverTarget = cover;
  }

  /** Jump straight to the next cover target (teleports, respawns): no fade from where the car was. */
  snapCover(): void {
    this.coverSnap = true;
  }

  /** Current (eased) cover. */
  get underCover(): number {
    return this.cover;
  }

  setQuality(q: WeatherQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.rain.setQuality(WEATHER_QUALITY[q]);
    this.sky.setCloudsEnabled(WEATHER_QUALITY[q].clouds);
    this.envKey = '';
  }

  /**
   * @param dt simulated seconds (0 while paused: nothing moves, nothing dries)
   * @param camera camera position (rain and sky follow it)
   * @param velocity car velocity, for the rain's slant
   */
  update(dt: number, camera: THREE.Vector3, velocity: THREE.Vector3): void {
    this.state.update(dt);
    // Eyes adapt quickly but not instantly at a portal (and instantly on teleports / pause).
    this.cover = dt > 0 && !this.coverSnap ? this.cover + (this.coverTarget - this.cover) * (1 - Math.exp(-6 * dt)) : this.coverTarget;
    this.coverSnap = false;
    this.snap = this.state.snapshot();
    this.apply(dt, camera, velocity);
  }

  dispose(): void {
    this.sky.dispose();
    this.rain.dispose();
    this.disposeEnv();
    this.pmrem?.dispose();
    this.track.setWetness?.(0);
    this.renderer.scene.environment = null;
  }

  private apply(dt: number, camera: THREE.Vector3, velocity: THREE.Vector3): void {
    const s = this.snap;
    const r = this.renderer;
    (r.scene.background as THREE.Color).setHex(s.fogColor);
    r.fog.color.setHex(s.fogColor);
    r.setWeatherFogScale(s.visibility);
    const c = this.cover;
    r.sun.color.setHex(s.lightColor);
    // Under a roof the sky's light is mostly blocked and the tunnel lamps take over (warm, constant).
    r.sun.intensity = s.lightIntensity * (1 - 0.9 * c);
    r.hemi.color.copy(this.tmp.setHex(s.hemiSky)).lerp(this.warm, c * 0.7);
    r.hemi.groundColor.setHex(s.hemiGround).lerp(this.warm, c * 0.4);
    r.hemi.intensity = s.hemiIntensity + (0.8 - s.hemiIntensity) * c;
    r.renderer.toneMappingExposure = s.exposure;
    // The renderer keeps the light at a fixed offset from the car for the shadow map.
    r.setSunOffset(this.lightDir.set(s.light.x, s.light.y, s.light.z).multiplyScalar(90));
    this.sky.update(dt, camera, s);
    this.rain.update(dt, camera, s.rain * (1 - c), velocity, Math.max(0.15, s.daylight + s.night * 0.25));
    this.updateEnvironment(dt);
    r.scene.environmentIntensity = s.envIntensity * (1 - 0.8 * c);
    if (Math.abs(s.wetness - this.lastWetness) > 0.004) {
      this.lastWetness = s.wetness;
      this.track.setWetness?.(s.wetness);
    }
  }

  /** Re-renders the sky environment map when the sky looks different, rate-limited by quality. */
  private updateEnvironment(dt: number): void {
    const s = this.snap;
    this.envTimer += dt;
    const key = `${s.hour.toFixed(1)}|${s.overcast.toFixed(2)}|${s.cloudCoverage.toFixed(2)}|${s.night.toFixed(2)}`;
    if (!this.env || (key !== this.envKey && this.envTimer >= WEATHER_QUALITY[this.quality].envRefresh)) {
      this.envKey = key;
      this.envTimer = 0;
      this.renderEnv();
      this.renderer.scene.environment = this.env?.texture ?? null;
    }
  }

  /** Sky-only environment map (PMREM): image-based light and reflections for the scene. */
  private renderEnv(): void {
    const gl = this.renderer.renderer;
    if (!this.pmrem) this.pmrem = new THREE.PMREMGenerator(gl);
    if (!this.envScene) {
      this.envScene = new THREE.Scene();
      const mirror = new THREE.Mesh(this.sky.sky.geometry, this.sky.sky.material);
      mirror.scale.setScalar(100);
      mirror.frustumCulled = false;
      this.envScene.add(mirror);
    }
    const prev = this.env;
    // No sun disc in the environment: its HDR spike would sparkle on every glossy surface.
    const uniforms = (this.sky.sky.material as THREE.ShaderMaterial).uniforms;
    uniforms.showSunDisc.value = 0;
    this.env = this.pmrem.fromScene(this.envScene, 0, 0.1, 1000);
    uniforms.showSunDisc.value = 1;
    prev?.dispose();
  }

  private disposeEnv(): void {
    this.env?.dispose();
    this.env = null;
    this.envKey = '';
  }
}
