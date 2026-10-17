/**
 * Weather and time of day as numbers, with no rendering: presets, smooth
 * transitions, road wetness and everything derived from the clock. The
 * WeatherManager turns a snapshot of this into sky, light, fog and rain.
 *
 * Approach (ideas, own code): time and weather produce smooth 0..1 signals
 * (sunlit, daylight, golden, overcast) and every colour is a blend driven by
 * them, so dusk and overcast are gradients rather than switches; road wetness
 * rises quickly with rain and dries slowly. Preset parameters move towards
 * the selected weather over a few seconds instead of cutting.
 */
import type { TimePreset, WeatherKind } from '../../settings/Profile';

/** Preset → hour of day. */
export const PRESET_HOURS: Record<Exclude<TimePreset, 'custom'>, number> = { morning: 7, noon: 13, evening: 19, night: 23 };

export interface WeatherParams {
  /** Sky cloud coverage 0..1. */
  clouds: number;
  /** Rain intensity 0..1. */
  rain: number;
  /** Haze / fog in the air 0..1 (greys the light, pulls in the fog). */
  haze: number;
  /** Multiplier on the world's fog distances (1 = clear air). */
  visibility: number;
}

export const WEATHER_PRESETS: Record<WeatherKind, WeatherParams> = {
  clear: { clouds: 0.08, rain: 0, haze: 0.04, visibility: 1 },
  cloudy: { clouds: 0.62, rain: 0, haze: 0.22, visibility: 0.85 },
  rain: { clouds: 0.86, rain: 0.55, haze: 0.42, visibility: 0.6 },
  heavyRain: { clouds: 1, rain: 1, haze: 0.62, visibility: 0.4 },
  fog: { clouds: 0.45, rain: 0, haze: 1, visibility: 0.22 },
};

/** Live adjustments from the admin panel (F2). Never saved with the player's settings. */
export interface WeatherTuning {
  sunIntensity: number;
  ambientIntensity: number;
  exposure: number;
  /** Multiplier on fog distances. */
  fogDistance: number;
  /** Overrides (null = follow the weather). */
  clouds: number | null;
  rain: number | null;
  wetness: number | null;
  /** Full-wet per second at full rain / full-dry per second. */
  wettingRate: number;
  dryingRate: number;
}

export const DEFAULT_TUNING: WeatherTuning = {
  sunIntensity: 1,
  ambientIntensity: 1,
  exposure: 1,
  fogDistance: 1,
  clouds: null,
  rain: null,
  wetness: null,
  // Accelerated for gameplay: a downpour soaks the road in ~20 s, it dries in ~90 s.
  wettingRate: 1 / 20,
  dryingRate: 1 / 90,
};

export type RoadState = 'dry' | 'damp' | 'wet';

/** Everything the renderer needs for one frame. Colours are 0xRRGGBB. */
export interface WeatherSnapshot {
  hour: number;
  /** Unit vector towards the sun (x east, y up, z south) and towards the light used (sun or moon). */
  sun: { x: number; y: number; z: number };
  light: { x: number; y: number; z: number };
  sunAltitudeDeg: number;
  sunlit: number;
  night: number;
  daylight: number;
  golden: number;
  overcast: number;
  lightColor: number;
  lightIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  /** Strength of the sky's image-based light on everything (car paint needs it). */
  envIntensity: number;
  fogColor: number;
  visibility: number;
  /** Sky shader inputs. */
  turbidity: number;
  rayleigh: number;
  mie: number;
  mieG: number;
  cloudCoverage: number;
  cloudDensity: number;
  stars: number;
  rain: number;
  wetness: number;
  road: RoadState;
}

// --- Sun path: Nürburgring latitude, summer-ish declination, CEST solar noon ------------------

const LATITUDE = 50.33 * (Math.PI / 180);
const DECLINATION = 8 * (Math.PI / 180);
/** Solar noon in local summer time (sunrise ~06:20, sunset ~19:40: the 07:00 and 19:00 presets get a low, warm sun). */
const SOLAR_NOON = 13;
const DEG = Math.PI / 180;

/** Altitude (rad) and azimuth (rad, from north turning east) for an hour of the day. */
export function sunPosition(hour: number): { altitude: number; azimuth: number } {
  const H = (hour - SOLAR_NOON) * 15 * DEG;
  const sinAlt = Math.sin(LATITUDE) * Math.sin(DECLINATION) + Math.cos(LATITUDE) * Math.cos(DECLINATION) * Math.cos(H);
  const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt)));
  const cosAlt = Math.max(1e-4, Math.cos(altitude));
  const cosAz = (Math.sin(DECLINATION) - Math.sin(LATITUDE) * sinAlt) / Math.max(1e-4, Math.cos(LATITUDE) * cosAlt);
  const sinAz = (-Math.sin(H) * Math.cos(DECLINATION)) / cosAlt;
  return { altitude, azimuth: Math.atan2(sinAz, Math.max(-1, Math.min(1, cosAz))) };
}

// --- Colours ------------------------------------------------------------------------------

const C = {
  sunHigh: 0xfff2dd,
  sunLow: 0xff8f45,
  moon: 0x8fa6d8,
  hemiDay: 0xdfeeff,
  hemiNight: 0x2b3b66,
  hemiGolden: 0xf0c49c,
  hemiOvercast: 0xc4ccd4,
  groundDay: 0x3a3328,
  groundNight: 0x0e1016,
  fogDay: 0xb4c9de,
  fogGolden: 0xe2a26c,
  fogNight: 0x0b1426,
  fogOvercast: 0x8e99a2,
  fogOvercastNight: 0x151a22,
};

const smooth = (t: number) => {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
};
const ramp = (v: number, a: number, b: number) => smooth((v - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function lerpColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const r = Math.round(lerp(ch(a, 16), ch(b, 16), t));
  const g = Math.round(lerp(ch(a, 8), ch(b, 8), t));
  const bl = Math.round(lerp(ch(a, 0), ch(b, 0), t));
  return (r << 16) | (g << 8) | bl;
}

/** Road state names for the UI: damp from 15 %, wet from 60 %. */
export function roadState(wetness: number): RoadState {
  return wetness >= 0.6 ? 'wet' : wetness >= 0.15 ? 'damp' : 'dry';
}

/** Surface grip factor for wet roads: the API wet physics will use. Deliberately 1 now (handling is frozen). */
export function wetGripFactor(_wetness: number): number {
  return 1;
}

export class WeatherState {
  hour: number;
  /** Clock speed in game hours per real second (0 = time stands still). */
  timeRate = 0;
  readonly tuning: WeatherTuning = { ...DEFAULT_TUNING };
  private targetKind: WeatherKind;
  /** Current (interpolating) preset parameters. */
  readonly params: WeatherParams;
  wetness: number;

  constructor(kind: WeatherKind, hour: number) {
    this.targetKind = kind;
    this.hour = ((hour % 24) + 24) % 24;
    this.params = { ...WEATHER_PRESETS[kind] };
    // Arriving in rain means it has been raining: the road starts wet.
    this.wetness = this.wetTarget(this.params.rain);
  }

  get weather(): WeatherKind {
    return this.targetKind;
  }

  /** Change weather. Default: rolls in over a few seconds; `instant` snaps (and soaks / dries the road). */
  setWeather(kind: WeatherKind, instant = false): void {
    this.targetKind = kind;
    if (instant) {
      Object.assign(this.params, WEATHER_PRESETS[kind]);
      this.wetness = this.wetTarget(this.params.rain);
    }
  }

  setHour(hour: number): void {
    this.hour = ((hour % 24) + 24) % 24;
  }

  /** Effective rain (with admin override). */
  get rain(): number {
    return this.tuning.rain ?? this.params.rain;
  }

  update(dt: number): void {
    if (dt <= 0) return;
    if (this.timeRate !== 0) this.setHour(this.hour + this.timeRate * dt);
    const target = WEATHER_PRESETS[this.targetKind];
    const p = this.params;
    // A squall arrives faster than it clears.
    const rainK = 1 - Math.exp(-(target.rain > p.rain ? 0.6 : 0.35) * dt);
    const k = 1 - Math.exp(-0.4 * dt);
    p.rain += (target.rain - p.rain) * rainK;
    p.clouds += (target.clouds - p.clouds) * k;
    p.haze += (target.haze - p.haze) * k;
    p.visibility += (target.visibility - p.visibility) * k;

    // Road: soaks with the rain (faster in heavier rain), dries slowly once it stops.
    const t = this.tuning;
    if (t.wetness !== null) {
      this.wetness = t.wetness;
      return;
    }
    const rain = this.rain;
    const cap = this.wetTarget(rain);
    if (this.wetness < cap) this.wetness = Math.min(cap, this.wetness + t.wettingRate * Math.max(rain, 0.2) * dt);
    else this.wetness = Math.max(cap, this.wetness - t.dryingRate * dt);
  }

  snapshot(): WeatherSnapshot {
    const p = this.params;
    const t = this.tuning;
    const rain = this.rain;
    const clouds = t.clouds ?? p.clouds;
    const { altitude, azimuth } = sunPosition(this.hour);
    const alt = altitude / DEG;
    const cosAlt = Math.cos(altitude);
    const sun = { x: cosAlt * Math.sin(azimuth), y: Math.sin(altitude), z: -cosAlt * Math.cos(azimuth) };

    const overcast = clamp01(p.haze * 0.55 + rain * 0.6 + clouds * 0.25);
    const sunlit = ramp(alt, -6.5, 4);
    const night = 1 - sunlit;
    const daylight = sunlit * (1 - 0.35 * overcast);
    const golden = ramp(alt, -5, 1.5) * (1 - ramp(alt, 4, 16)) * (1 - overcast * 0.8);

    // One directional light: the sun by day, the moon (opposite, kept above the horizon) by night.
    const sunUp = sun.y > -0.03;
    const light = sunUp ? { x: sun.x, y: Math.max(0.12, sun.y), z: sun.z } : { x: -sun.x, y: Math.max(0.35, -sun.y), z: -sun.z };
    const ll = Math.hypot(light.x, light.y, light.z);
    light.x /= ll;
    light.y /= ll;
    light.z /= ll;
    const lightColor = sunUp ? lerpColor(C.sunHigh, C.sunLow, golden) : C.moon;
    const lightIntensity = (daylight * 2.3 * (1 - overcast * 0.82) + night * 0.35 * (1 - overcast * 0.6)) * t.sunIntensity;

    let hemiSky = lerpColor(C.hemiNight, C.hemiDay, sunlit);
    hemiSky = lerpColor(hemiSky, C.hemiGolden, golden * 0.45);
    hemiSky = lerpColor(hemiSky, C.hemiOvercast, overcast * 0.6 * sunlit);
    const hemiGround = lerpColor(C.groundNight, C.groundDay, sunlit);
    // Overcast light is diffuse: the sky dome gives a bit more while the sun gives much less. Night keeps a drivable floor.
    // The sky environment light adds ambient too, so the hemisphere light is kept lower than it would be alone.
    const hemiIntensity = (0.45 + daylight * 0.4 + overcast * 0.15 * sunlit) * t.ambientIntensity;
    const envIntensity = (0.3 + daylight * 0.3 + golden * 0.2) * t.ambientIntensity;

    let fogColor = lerpColor(C.fogNight, C.fogDay, sunlit);
    fogColor = lerpColor(fogColor, C.fogGolden, golden * 0.7);
    fogColor = lerpColor(fogColor, lerpColor(C.fogOvercastNight, C.fogOvercast, sunlit), overcast * 0.85);

    return {
      hour: this.hour,
      sun,
      light,
      sunAltitudeDeg: alt,
      sunlit,
      night,
      daylight,
      golden,
      overcast,
      lightColor,
      lightIntensity,
      hemiSky,
      hemiGround,
      hemiIntensity,
      exposure: lerp(1, 1.08, night) * t.exposure,
      envIntensity,
      fogColor,
      visibility: p.visibility * (1 - night * 0.2) * t.fogDistance,
      turbidity: 2 + p.haze * 8 + rain * 6,
      rayleigh: Math.max(0.25, 1 + golden * 1.6 - overcast * 0.6),
      mie: 0.005 + p.haze * 0.015,
      mieG: 0.8 - overcast * 0.2,
      cloudCoverage: clouds,
      cloudDensity: 0.3 + clouds * 0.55 + rain * 0.15,
      stars: night * (1 - overcast) * (1 - clouds * 0.7),
      rain,
      wetness: this.wetness,
      road: roadState(this.wetness),
    };
  }

  /** Wetness the road settles at for a rain level (light rain leaves it damp, heavy rain soaks it). */
  private wetTarget(rain: number): number {
    return rain <= 0.02 ? 0 : clamp01(rain * 1.6);
  }
}
