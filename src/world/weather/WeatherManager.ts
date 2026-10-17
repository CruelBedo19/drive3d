import * as THREE from 'three';
import type { Renderer } from '../../core/Renderer';
import type { WeatherKind } from '../../settings/Profile';
import type { Track } from '../Track';
import { computeAtmosphere, wetGripFactor, type Atmosphere } from './Atmosphere';
import { Rain } from './Rain';

/**
 * Weather and time of day for the driving scene: sky, fog, sun / moon, ambient
 * light, exposure, rain and wet roads. Visual only. `gripFactor` is the hook wet
 * physics will read later; it stays 1 so handling is unchanged.
 */
export class WeatherManager {
  private readonly renderer: Renderer;
  private readonly track: Track;
  private readonly rain = new Rain();
  private readonly sunOffset = new THREE.Vector3();
  private current: Atmosphere;
  private kind: WeatherKind = 'clear';

  constructor(renderer: Renderer, track: Track, weather: WeatherKind, hour: number) {
    this.renderer = renderer;
    this.track = track;
    renderer.scene.add(this.rain.object);
    this.current = computeAtmosphere(weather, hour);
    this.set(weather, hour);
  }

  get atmosphere(): Readonly<Atmosphere> {
    return this.current;
  }

  get weather(): WeatherKind {
    return this.kind;
  }

  /** Headlights wanted: at night, at dusk and in rain or fog. */
  get headlights(): boolean {
    return this.current.night > 0.3 || this.kind === 'rain' || this.kind === 'fog';
  }

  /** Grip multiplier for wet roads (1 today, see wetGripFactor). */
  get gripFactor(): number {
    return wetGripFactor(this.current.wetness);
  }

  set(weather: WeatherKind, hour: number): void {
    this.kind = weather;
    const a = computeAtmosphere(weather, hour);
    this.current = a;
    const r = this.renderer;
    (r.scene.background as THREE.Color).setHex(a.sky);
    r.fog.color.setHex(a.fogColor);
    r.setWeatherFogScale(a.visibility);
    r.sun.color.setHex(a.sunColor);
    r.sun.intensity = a.sunIntensity;
    r.hemi.color.setHex(a.hemiSky);
    r.hemi.groundColor.setHex(a.hemiGround);
    r.hemi.intensity = a.hemiIntensity;
    r.renderer.toneMappingExposure = a.exposure;
    // The renderer keeps the sun at a fixed offset from the car for the shadow map.
    this.sunOffset.set(a.sunDirection.x, a.sunDirection.y, a.sunDirection.z).multiplyScalar(90);
    r.setSunOffset(this.sunOffset);
    this.track.setWetness?.(a.wetness);
  }

  update(dt: number, camera: THREE.Vector3): void {
    this.rain.update(dt, camera, this.current.rain);
  }

  dispose(): void {
    this.rain.dispose();
  }
}
