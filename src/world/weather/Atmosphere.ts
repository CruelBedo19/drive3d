import type { TimePreset, WeatherKind } from '../../settings/Profile';

/** Preset → hour of day. */
export const PRESET_HOURS: Record<TimePreset, number> = { morning: 8, noon: 13, evening: 19.25, night: 23 };

/** Everything the renderer needs for one weather + time combination. Colours are 0xRRGGBB. */
export interface Atmosphere {
  hour: number;
  sky: number;
  fogColor: number;
  /** Multiplies the world's fog distances (1 = clear day). */
  visibility: number;
  sunColor: number;
  sunIntensity: number;
  /** Unit vector from the scene towards the light (sun by day, moon by night). */
  sunDirection: { x: number; y: number; z: number };
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  exposure: number;
  /** 0 = day, 1 = full night (headlights, street lights later). */
  night: number;
  /** Road wetness 0..1 (visual today; the hook for wet grip later). */
  wetness: number;
  /** Rain particle density 0..1. */
  rain: number;
}

interface Key {
  h: number;
  sky: number;
  sun: number;
  sunI: number;
  hemi: number;
  ground: number;
  hemiI: number;
  exposure: number;
}

/**
 * Clear-sky keyframes over the day. Noon matches the original fixed lighting.
 * Night keeps enough blue ambient light to drive (dark, not black).
 */
const DAY: readonly Key[] = [
  { h: 0, sky: 0x0a1222, sun: 0x8fa6ff, sunI: 0.35, hemi: 0x41558a, ground: 0x0e1016, hemiI: 0.55, exposure: 1.05 },
  { h: 5, sky: 0x0e1730, sun: 0x8fa6ff, sunI: 0.3, hemi: 0x42568a, ground: 0x0f1118, hemiI: 0.55, exposure: 1.05 },
  { h: 6.5, sky: 0xe7a17c, sun: 0xffad73, sunI: 0.9, hemi: 0xc7b3c4, ground: 0x2c2620, hemiI: 0.75, exposure: 1.0 },
  { h: 8, sky: 0xa9c5e2, sun: 0xfff0d6, sunI: 1.8, hemi: 0xdcecff, ground: 0x3a3328, hemiI: 1.0, exposure: 1.0 },
  { h: 13, sky: 0x9fb8cf, sun: 0xfff2dd, sunI: 2.2, hemi: 0xdfeeff, ground: 0x3a3328, hemiI: 1.1, exposure: 1.0 },
  { h: 17, sky: 0xa7bcd0, sun: 0xffe7c4, sunI: 1.9, hemi: 0xdfe8f5, ground: 0x3a3328, hemiI: 1.0, exposure: 1.0 },
  { h: 19.25, sky: 0xe68b5c, sun: 0xff9358, sunI: 1.0, hemi: 0xc9a7a4, ground: 0x2a2320, hemiI: 0.7, exposure: 1.0 },
  { h: 20.75, sky: 0x2b3456, sun: 0x8c98c8, sunI: 0.35, hemi: 0x46557f, ground: 0x111318, hemiI: 0.55, exposure: 1.05 },
  { h: 24, sky: 0x0a1222, sun: 0x8fa6ff, sunI: 0.35, hemi: 0x41558a, ground: 0x0e1016, hemiI: 0.55, exposure: 1.05 },
];

/** How each weather changes the clear-sky look. */
const WEATHER: Record<WeatherKind, { grey: number; greyMix: number; sun: number; hemi: number; visibility: number; wetness: number; rain: number }> = {
  clear: { grey: 0x000000, greyMix: 0, sun: 1, hemi: 1, visibility: 1, wetness: 0, rain: 0 },
  cloudy: { grey: 0x8b949d, greyMix: 0.6, sun: 0.35, hemi: 1.2, visibility: 0.8, wetness: 0, rain: 0 },
  rain: { grey: 0x5f6870, greyMix: 0.78, sun: 0.18, hemi: 1.15, visibility: 0.5, wetness: 1, rain: 1 },
  fog: { grey: 0xb3bac1, greyMix: 0.85, sun: 0.35, hemi: 1.15, visibility: 0.22, wetness: 0.25, rain: 0 },
};

export function computeAtmosphere(weather: WeatherKind, hour: number): Atmosphere {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < DAY.length - 2 && DAY[i + 1].h <= h) i++;
  const a = DAY[i];
  const b = DAY[i + 1];
  const t = (h - a.h) / (b.h - a.h);
  const w = WEATHER[weather];

  // Sun path: up at 6:00, highest at 13:00, down at 20:00. Below the horizon the moon lights the scene.
  const dayAngle = ((h - 6) / 14) * Math.PI;
  const elevation = Math.sin(dayAngle);
  const night = clamp01((0.08 - elevation) / 0.25);
  const sunEl = elevation > 0 ? Math.max(0.15, elevation) * 1.1 : 0.9;
  const az = elevation > 0 ? dayAngle - Math.PI / 2 : 0.6;
  const dir = normalize({ x: Math.sin(az) * 0.8, y: sunEl, z: -Math.cos(az) * 0.6 - 0.3 });

  // Overcast skies go grey by day and dark grey-blue by night.
  const sky = mix(lerpColor(a.sky, b.sky, t), darken(w.grey, 1 - night * 0.85), w.greyMix);
  return {
    hour: h,
    sky,
    fogColor: sky,
    visibility: w.visibility * (1 - night * 0.25),
    sunColor: lerpColor(a.sun, b.sun, t),
    sunIntensity: lerp(a.sunI, b.sunI, t) * lerp(w.sun, 1, night * 0.5),
    sunDirection: dir,
    hemiSky: mix(lerpColor(a.hemi, b.hemi, t), 0xc8d0d8, w.greyMix * 0.5 * (1 - night)),
    hemiGround: lerpColor(a.ground, b.ground, t),
    hemiIntensity: lerp(a.hemiI, b.hemiI, t) * w.hemi,
    exposure: lerp(a.exposure, b.exposure, t),
    night,
    wetness: w.wetness,
    rain: w.rain,
  };
}

/** Surface grip factor for wet roads: the API wet physics will use. Deliberately 1 today (no handling change). */
export function wetGripFactor(_wetness: number): number {
  return 1;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function normalize(v: { x: number; y: number; z: number }) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

export function lerpColor(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 0xff;
  const r = Math.round(lerp(ch(a, 16), ch(b, 16), t));
  const g = Math.round(lerp(ch(a, 8), ch(b, 8), t));
  const bl = Math.round(lerp(ch(a, 0), ch(b, 0), t));
  return (r << 16) | (g << 8) | bl;
}

const mix = lerpColor;

function darken(c: number, k: number): number {
  return lerpColor(0x000000, c, k);
}
