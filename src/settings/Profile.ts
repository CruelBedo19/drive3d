import { canonicalTrackId } from '../config/tracks';
import { safeLocalStorage } from './Settings';

/**
 * The player's last choices (map, car, setup, weather, time of day), saved so
 * the next visit starts where they left off. Separate from settings: these are
 * picked in the menus, not on the settings screen.
 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'heavyRain' | 'fog';
/** 'custom' = use customHour. */
export type TimePreset = 'morning' | 'noon' | 'evening' | 'night' | 'custom';

export interface Profile {
  trackId: string;
  carId: string;
  setup: string;
  weather: WeatherKind;
  time: TimePreset;
  /** Exact hour 0..24 for time 'custom' (older saves: set = overrides the preset), or null. */
  customHour: number | null;
}

export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'rain', 'heavyRain', 'fog'];
export const TIME_PRESETS: readonly TimePreset[] = ['morning', 'noon', 'evening', 'night', 'custom'];

export const PROFILE_VERSION = 1;
export const PROFILE_KEY = 'drive3d.profile';

export interface ProfileRules {
  trackIds: readonly string[];
  carIds: readonly string[];
  setups: readonly string[];
  defaults: Pick<Profile, 'trackId' | 'carId' | 'setup'>;
}

export function sanitizeProfile(raw: unknown, rules: ProfileRules): Profile {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def);
  const hour = src.customHour;
  const customHour = typeof hour === 'number' && Number.isFinite(hour) && hour >= 0 && hour < 24 ? hour : null;
  let time = pick(src.time, TIME_PRESETS, 'noon');
  // 'custom' without an hour is meaningless; an hour with a preset (older saves) means custom.
  if (time === 'custom' && customHour === null) time = 'noon';
  if (customHour !== null && time !== 'custom') time = 'custom';
  return {
    trackId: pick(canonicalTrackId(typeof src.trackId === 'string' ? src.trackId : null) ?? src.trackId, rules.trackIds, rules.defaults.trackId),
    carId: pick(src.carId, rules.carIds, rules.defaults.carId),
    setup: pick(src.setup, rules.setups, rules.defaults.setup),
    weather: pick(src.weather, WEATHER_KINDS, 'clear'),
    time,
    customHour: time === 'custom' ? customHour : null,
  };
}

export class ProfileStore {
  private current: Profile;
  private readonly rules: ProfileRules;
  private readonly storage: Storage | null;

  constructor(rules: ProfileRules, storage: Storage | null = safeLocalStorage()) {
    this.rules = rules;
    this.storage = storage;
    let raw: unknown = null;
    try {
      const text = storage?.getItem(PROFILE_KEY);
      const parsed = text ? (JSON.parse(text) as { version?: unknown }) : null;
      raw = parsed && parsed.version === PROFILE_VERSION ? parsed : null;
    } catch {
      raw = null;
    }
    this.current = sanitizeProfile(raw, rules);
  }

  get value(): Readonly<Profile> {
    return this.current;
  }

  update(patch: Partial<Profile>): void {
    this.current = sanitizeProfile({ ...this.current, ...patch }, this.rules);
    try {
      this.storage?.setItem(PROFILE_KEY, JSON.stringify({ version: PROFILE_VERSION, ...this.current }));
    } catch {
      // Not saved; still used for this session.
    }
  }
}

/** The hour a profile asks for. */
export function profileHour(p: Pick<Profile, 'time' | 'customHour'>, presetHours: Record<Exclude<TimePreset, 'custom'>, number>): number {
  return p.time === 'custom' && p.customHour !== null ? p.customHour : presetHours[p.time === 'custom' ? 'noon' : p.time];
}
