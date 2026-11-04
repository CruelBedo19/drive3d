/**
 * Player settings, persisted (versioned) in this browser's localStorage. The
 * schema below is the single source of truth: defaults, validation of stored
 * values and the settings screen are all derived from it, so a new option is
 * one entry here.
 */

export type MinimapSide = 'left' | 'right';
export type MinimapMode = 'fixed' | 'rotating';
export type SpeedUnit = 'kmh' | 'mph';
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';
export type RenderDistance = 'short' | 'medium' | 'far';
export type VegetationDistance = 'low' | 'medium' | 'high';
export type WeatherQuality = 'low' | 'medium' | 'high';
export type HeadlightModeSetting = 'manual' | 'auto';
export type TrafficDensitySetting = 'off' | 'low' | 'medium' | 'high' | 'veryHigh';
export type TrafficVarietySetting = 'mixed' | 'carsOnly' | 'heavy';
export type TrafficCutInSetting = 'off' | 'some' | 'many';

export interface UiSettings {
  hud: boolean;
  speedometer: boolean;
  minimap: boolean;
  minimapSide: MinimapSide;
  minimapMode: MinimapMode;
  hudScale: number;
  showFps: boolean;
  speedUnit: SpeedUnit;
  headlightMode: HeadlightModeSetting;
}

/** Volumes 0..1. Applied through AudioManager; nothing plays sound yet. */
export interface AudioSettings {
  master: number;
  engine: number;
  tyres: number;
  ambience: number;
  music: number;
  musicEnabled: boolean;
  muteAll: boolean;
}

export interface GraphicsSettings {
  shadows: ShadowQuality;
  /** Fraction of the device pixel ratio the 3D view renders at. */
  resolutionScale: number;
  /** Draw at fewer pixels for a while when the frame rate drops (dynamic resolution). */
  autoResolution: boolean;
  renderDistance: RenderDistance;
  vegetationDistance: VegetationDistance;
  /** Frames per second cap as a string ('0' = unlimited). */
  fpsLimit: '30' | '60' | '120' | '0';
  /** Rain particle count, clouds, wet-road reflections. */
  weatherQuality: WeatherQuality;
  /** Only read when the renderer is created: needs a reload. */
  antialias: boolean;
}

/** Player key bindings: KeyboardEvent.code, optionally prefixed with "Shift+". */
export interface ControlSettings {
  throttle: string;
  brake: string;
  left: string;
  right: string;
  handbrake: string;
  camera: string;
  lookBack: string;
  recover: string;
  respawn: string;
  headlights: string;
  trafficDensity: string;
  map: string;
}

/** AI traffic (worlds that have it: the Autobahn). */
export interface TrafficSettings {
  density: TrafficDensitySetting;
  variety: TrafficVarietySetting;
  /** Bold drivers who cut in close in front of the player. */
  cutIns: TrafficCutInSetting;
  /** Traffic as dots on the minimap. */
  minimapDots: boolean;
}

export interface GameSettings {
  ui: UiSettings;
  audio: AudioSettings;
  graphics: GraphicsSettings;
  traffic: TrafficSettings;
  controls: ControlSettings;
}

export type SettingsSection = keyof GameSettings;

interface FieldBase {
  section: SettingsSection;
  key: string;
  label: string;
  /** Extra line under the label. */
  hint?: string;
}
export type SettingField =
  | (FieldBase & { type: 'toggle'; default: boolean })
  | (FieldBase & { type: 'select'; default: string; options: readonly { value: string; label: string }[] })
  | (FieldBase & { type: 'range'; default: number; min: number; max: number; step: number; format?: (v: number) => string })
  | (FieldBase & { type: 'key'; default: string });

export const SETTING_SECTIONS: readonly { id: SettingsSection; label: string }[] = [
  { id: 'ui', label: 'Interface' },
  { id: 'audio', label: 'Audio' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'controls', label: 'Controls' },
];

const percent = (v: number) => `${Math.round(v * 100)}%`;
const volume = (section: SettingsSection, key: string, label: string, def: number): SettingField => ({ section, key, label, type: 'range', default: def, min: 0, max: 1, step: 0.05, format: percent });

export const SETTINGS_SCHEMA: readonly SettingField[] = [
  // --- Interface ---------------------------------------------------------------
  { section: 'ui', key: 'hud', label: 'HUD', type: 'toggle', default: true },
  { section: 'ui', key: 'speedometer', label: 'Speedometer', type: 'toggle', default: true },
  { section: 'ui', key: 'minimap', label: 'Minimap', type: 'toggle', default: true },
  {
    section: 'ui',
    key: 'minimapSide',
    label: 'Minimap position',
    type: 'select',
    default: 'left',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
    ],
  },
  {
    section: 'ui',
    key: 'minimapMode',
    label: 'Minimap mode',
    type: 'select',
    default: 'rotating',
    options: [
      { value: 'fixed', label: 'Fixed map' },
      { value: 'rotating', label: 'Rotating with player' },
    ],
  },
  { section: 'ui', key: 'hudScale', label: 'HUD scale', type: 'range', default: 1, min: 0.7, max: 1.4, step: 0.05, format: percent },
  { section: 'ui', key: 'showFps', label: 'Show FPS', type: 'toggle', default: false },
  {
    section: 'ui',
    key: 'speedUnit',
    label: 'Speed unit',
    type: 'select',
    default: 'kmh',
    options: [
      { value: 'kmh', label: 'km/h' },
      { value: 'mph', label: 'mph' },
    ],
  },
  {
    section: 'ui',
    key: 'headlightMode',
    label: 'Headlights',
    hint: 'Auto: turns on at night, heavy rain and low light; L temporarily overrides',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Automatic' },
      { value: 'manual', label: 'Manual' },
    ],
  },

  // --- Audio --------------------------------------------------------------------
  volume('audio', 'master', 'Master volume', 0.8),
  volume('audio', 'engine', 'Engine volume', 1),
  volume('audio', 'tyres', 'Tyre volume', 1),
  volume('audio', 'ambience', 'Ambience volume', 0.8),
  volume('audio', 'music', 'Music volume', 0.6),
  { section: 'audio', key: 'musicEnabled', label: 'Music', type: 'toggle', default: true },
  { section: 'audio', key: 'muteAll', label: 'Mute all', type: 'toggle', default: false },

  // --- Graphics -----------------------------------------------------------------
  {
    section: 'graphics',
    key: 'shadows',
    label: 'Shadow quality',
    type: 'select',
    default: 'high',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  { section: 'graphics', key: 'resolutionScale', label: 'Resolution scale', type: 'range', default: 1, min: 0.5, max: 1, step: 0.05, format: percent },
  { section: 'graphics', key: 'autoResolution', label: 'Auto resolution', hint: 'Temporarily reduces resolution when FPS drops', type: 'toggle', default: true },
  {
    section: 'graphics',
    key: 'renderDistance',
    label: 'Render distance',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'short', label: 'Short' },
      { value: 'medium', label: 'Medium' },
      { value: 'far', label: 'Far' },
    ],
  },
  {
    section: 'graphics',
    key: 'vegetationDistance',
    label: 'Vegetation distance',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'low', label: 'Close' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'Far' },
    ],
  },
  {
    section: 'graphics',
    key: 'fpsLimit',
    label: 'FPS limit',
    type: 'select',
    default: '0',
    options: [
      { value: '30', label: '30' },
      { value: '60', label: '60' },
      { value: '120', label: '120' },
      { value: '0', label: 'Unlimited' },
    ],
  },
  {
    section: 'graphics',
    key: 'weatherQuality',
    label: 'Weather effects',
    hint: 'Rain density, clouds, wet road reflections',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
  },
  { section: 'graphics', key: 'antialias', label: 'Anti-aliasing', hint: 'Requires restart', type: 'toggle', default: true },

  // --- Traffic ------------------------------------------------------------------
  {
    section: 'traffic',
    key: 'density',
    label: 'Traffic density',
    hint: 'On the Autobahn and in the city; T changes it while driving',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'veryHigh', label: 'Very high' },
    ],
  },
  {
    section: 'traffic',
    key: 'variety',
    label: 'Traffic variety',
    type: 'select',
    default: 'mixed',
    options: [
      { value: 'mixed', label: 'Mixed' },
      { value: 'carsOnly', label: 'Mostly cars' },
      { value: 'heavy', label: 'Heavy vehicles' },
    ],
  },
  {
    section: 'traffic',
    key: 'cutIns',
    label: 'Cut-in drivers',
    hint: 'Some NPCs may cut in close in front of you',
    type: 'select',
    default: 'some',
    options: [
      { value: 'off', label: 'None' },
      { value: 'some', label: 'Occasional' },
      { value: 'many', label: 'Frequent' },
    ],
  },
  { section: 'traffic', key: 'minimapDots', label: 'Show traffic on minimap', type: 'toggle', default: true },

  // --- Controls -----------------------------------------------------------------
  { section: 'controls', key: 'throttle', label: 'Throttle', type: 'key', default: 'KeyW' },
  { section: 'controls', key: 'brake', label: 'Brake / reverse', type: 'key', default: 'KeyS' },
  { section: 'controls', key: 'left', label: 'Left', type: 'key', default: 'KeyA' },
  { section: 'controls', key: 'right', label: 'Right', type: 'key', default: 'KeyD' },
  { section: 'controls', key: 'handbrake', label: 'Handbrake', type: 'key', default: 'Space' },
  { section: 'controls', key: 'camera', label: 'Change camera', type: 'key', default: 'KeyV' },
  { section: 'controls', key: 'lookBack', label: 'Look back (hold)', type: 'key', default: 'KeyC' },
  { section: 'controls', key: 'recover', label: 'Recover car', hint: 'Autobahn: returns to the nearest lane if you go off the road', type: 'key', default: 'KeyR' },
  { section: 'controls', key: 'respawn', label: 'Respawn', type: 'key', default: 'Shift+KeyR' },
  { section: 'controls', key: 'headlights', label: 'Toggle headlights', type: 'key', default: 'KeyL' },
  { section: 'controls', key: 'map', label: 'Big map (toggle)', type: 'key', default: 'KeyM' },
  { section: 'controls', key: 'trafficDensity', label: 'Traffic density (cycle)', type: 'key', default: 'KeyT' },
];

/** Keys the game keeps for itself (menus, developer tools): not bindable. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set(['Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F11', 'F12', 'Tab']);

/** Current storage format. Bump when a change can't be read by sanitizeSettings(). */
export const SETTINGS_VERSION = 2;
export const SETTINGS_KEY = 'drive3d.settings';
/** v1 (phase 2 HUD) stored only the ui section under this key. */
const LEGACY_KEY_V1 = 'drive3d.settings.v1';

const KEY_PATTERN = /^(Shift\+)?[A-Za-z][A-Za-z0-9]*$/;

export function isBindableKey(binding: string): boolean {
  return KEY_PATTERN.test(binding) && !RESERVED_KEYS.has(binding.replace(/^Shift\+/, ''));
}

export function defaultSettings(): GameSettings {
  const out: Record<string, Record<string, unknown>> = { ui: {}, audio: {}, graphics: {}, traffic: {}, controls: {} };
  for (const f of SETTINGS_SCHEMA) out[f.section][f.key] = f.default;
  return out as unknown as GameSettings;
}

/** Takes stored (possibly old, partial or hand-edited) data; anything invalid falls back to its default. */
export function sanitizeSettings(raw: unknown): GameSettings {
  const out = defaultSettings() as unknown as Record<string, Record<string, unknown>>;
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  for (const f of SETTINGS_SCHEMA) {
    const section = src[f.section];
    if (typeof section !== 'object' || section === null) continue;
    const v = (section as Record<string, unknown>)[f.key];
    const target = out[f.section];
    if (f.type === 'toggle' && typeof v === 'boolean') target[f.key] = v;
    else if (f.type === 'select' && typeof v === 'string' && f.options.some((o) => o.value === v)) target[f.key] = v;
    else if (f.type === 'range' && typeof v === 'number' && Number.isFinite(v)) target[f.key] = Math.min(f.max, Math.max(f.min, v));
    else if (f.type === 'key' && typeof v === 'string' && isBindableKey(v)) target[f.key] = v;
  }
  return out as unknown as GameSettings;
}

/**
 * Reads whatever is stored: the current versioned format, the v1 ui-only
 * format (migrated), or nothing / something unreadable (defaults).
 */
export function loadStoredSettings(storage: Pick<Storage, 'getItem'> | null): { settings: GameSettings; migratedFrom: number | null } {
  const parse = (key: string): unknown => {
    try {
      const text = storage?.getItem(key);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };
  const current = parse(SETTINGS_KEY) as { version?: unknown } | null;
  if (current && typeof current === 'object') {
    // A newer or unknown version than this build understands: start clean rather than guess.
    if (current.version === SETTINGS_VERSION) return { settings: sanitizeSettings(current), migratedFrom: null };
    return { settings: defaultSettings(), migratedFrom: typeof current.version === 'number' ? current.version : 0 };
  }
  const v1 = parse(LEGACY_KEY_V1);
  if (v1 && typeof v1 === 'object') return { settings: sanitizeSettings({ ui: (v1 as { ui?: unknown }).ui }), migratedFrom: 1 };
  return { settings: defaultSettings(), migratedFrom: null };
}

/** Player actions that share a key. Each conflict is listed once. */
export function findKeyConflicts(controls: ControlSettings): { key: string; actions: (keyof ControlSettings)[] }[] {
  const byKey = new Map<string, (keyof ControlSettings)[]>();
  for (const [action, key] of Object.entries(controls) as [keyof ControlSettings, string][]) {
    const list = byKey.get(key) ?? [];
    list.push(action);
    byKey.set(key, list);
  }
  return [...byKey.entries()].filter(([, actions]) => actions.length > 1).map(([key, actions]) => ({ key, actions }));
}

/** Readable name for a binding: "KeyW" → "W", "Shift+KeyR" → "Shift + R". */
export function keyLabel(binding: string): string {
  const shift = binding.startsWith('Shift+');
  const code = shift ? binding.slice(6) : binding;
  let name = code;
  if (/^Key[A-Z]$/.test(code)) name = code.slice(3);
  else if (/^Digit\d$/.test(code)) name = code.slice(5);
  else if (code.startsWith('Arrow')) name = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code] ?? code;
  else if (code.startsWith('Numpad')) name = `Num ${code.slice(6)}`;
  return shift ? `Shift + ${name}` : name;
}

export type SettingsListener = (settings: Readonly<GameSettings>) => void;

export class SettingsStore {
  /** Set when stored settings came from an older format (or an unreadable newer one). */
  readonly migratedFrom: number | null;
  private current: GameSettings;
  private readonly listeners = new Set<SettingsListener>();
  private readonly storage: Storage | null;

  constructor(storage: Storage | null = safeLocalStorage()) {
    this.storage = storage;
    const { settings, migratedFrom } = loadStoredSettings(storage);
    this.current = settings;
    this.migratedFrom = migratedFrom;
    if (migratedFrom !== null) this.save();
  }

  get value(): Readonly<GameSettings> {
    return this.current;
  }

  /** Sets one field, saves and notifies. Invalid values are ignored (the previous value stays); ranges clamp. */
  set(section: SettingsSection, key: string, value: unknown): void {
    const field = SETTINGS_SCHEMA.find((f) => f.section === section && f.key === key);
    if (!field) return;
    const probe = sanitizeSettings({ [section]: { [key]: value } }) as unknown as Record<string, Record<string, unknown>>;
    const accepted = probe[section][key];
    // sanitize returns the default for invalid input: only take it when that was really asked for.
    if (accepted === field.default && value !== field.default && field.type !== 'range') return;
    const next = structuredClone(this.current) as unknown as Record<string, Record<string, unknown>>;
    next[section][key] = accepted;
    this.current = next as unknown as GameSettings;
    this.commit();
  }

  /** Back to defaults: one section, or everything. */
  reset(section?: SettingsSection): void {
    const defaults = defaultSettings();
    if (section) {
      const next = structuredClone(this.current) as unknown as Record<string, unknown>;
      next[section] = defaults[section];
      this.current = next as unknown as GameSettings;
    } else {
      this.current = defaults;
    }
    this.commit();
  }

  /** Calls `listener` now and on every change; returns the unsubscribe function. */
  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    listener(this.current);
    return () => this.listeners.delete(listener);
  }

  private commit(): void {
    this.save();
    for (const l of this.listeners) l(this.current);
  }

  private save(): void {
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify({ version: SETTINGS_VERSION, ...this.current }));
    } catch {
      // Storage full or blocked: settings still apply for this session.
    }
  }
}

export function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
