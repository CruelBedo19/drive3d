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
  { id: 'ui', label: 'Arayüz' },
  { id: 'audio', label: 'Ses' },
  { id: 'graphics', label: 'Grafik' },
  { id: 'traffic', label: 'Trafik' },
  { id: 'controls', label: 'Kontroller' },
];

const percent = (v: number) => `${Math.round(v * 100)}%`;
const volume = (section: SettingsSection, key: string, label: string, def: number): SettingField => ({ section, key, label, type: 'range', default: def, min: 0, max: 1, step: 0.05, format: percent });

export const SETTINGS_SCHEMA: readonly SettingField[] = [
  // --- Arayüz -----------------------------------------------------------------
  { section: 'ui', key: 'hud', label: 'HUD', type: 'toggle', default: true },
  { section: 'ui', key: 'speedometer', label: 'Hız göstergesi', type: 'toggle', default: true },
  { section: 'ui', key: 'minimap', label: 'Minimap', type: 'toggle', default: true },
  {
    section: 'ui',
    key: 'minimapSide',
    label: 'Harita konumu',
    type: 'select',
    default: 'left',
    options: [
      { value: 'left', label: 'Sol' },
      { value: 'right', label: 'Sağ' },
    ],
  },
  {
    section: 'ui',
    key: 'minimapMode',
    label: 'Harita modu',
    type: 'select',
    default: 'rotating',
    options: [
      { value: 'fixed', label: 'Sabit harita' },
      { value: 'rotating', label: 'Oyuncuya göre dönen' },
    ],
  },
  { section: 'ui', key: 'hudScale', label: 'HUD ölçeği', type: 'range', default: 1, min: 0.7, max: 1.4, step: 0.05, format: percent },
  { section: 'ui', key: 'showFps', label: 'FPS göster', type: 'toggle', default: false },
  {
    section: 'ui',
    key: 'speedUnit',
    label: 'Hız birimi',
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
    label: 'Farlar',
    hint: 'Otomatik: gece, yoğun yağmur ve karanlık havada açılır; L ile geçici olarak değiştirilir',
    type: 'select',
    default: 'auto',
    options: [
      { value: 'auto', label: 'Otomatik' },
      { value: 'manual', label: 'Manuel' },
    ],
  },

  // --- Ses ----------------------------------------------------------------------
  volume('audio', 'master', 'Ana ses', 0.8),
  volume('audio', 'engine', 'Motor sesi', 1),
  volume('audio', 'tyres', 'Lastik sesi', 1),
  volume('audio', 'ambience', 'Çevre sesi', 0.8),
  volume('audio', 'music', 'Müzik sesi', 0.6),
  { section: 'audio', key: 'musicEnabled', label: 'Müzik', type: 'toggle', default: true },
  { section: 'audio', key: 'muteAll', label: 'Tüm sesleri kapat', type: 'toggle', default: false },

  // --- Grafik -------------------------------------------------------------------
  {
    section: 'graphics',
    key: 'shadows',
    label: 'Gölge kalitesi',
    type: 'select',
    default: 'high',
    options: [
      { value: 'off', label: 'Kapalı' },
      { value: 'low', label: 'Düşük' },
      { value: 'medium', label: 'Orta' },
      { value: 'high', label: 'Yüksek' },
    ],
  },
  { section: 'graphics', key: 'resolutionScale', label: 'Çözünürlük ölçeği', type: 'range', default: 1, min: 0.5, max: 1, step: 0.05, format: percent },
  {
    section: 'graphics',
    key: 'renderDistance',
    label: 'Görüş mesafesi',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'short', label: 'Kısa' },
      { value: 'medium', label: 'Orta' },
      { value: 'far', label: 'Uzak' },
    ],
  },
  {
    section: 'graphics',
    key: 'vegetationDistance',
    label: 'Bitki örtüsü mesafesi',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'low', label: 'Yakın' },
      { value: 'medium', label: 'Orta' },
      { value: 'high', label: 'Uzak' },
    ],
  },
  {
    section: 'graphics',
    key: 'fpsLimit',
    label: 'FPS limiti',
    type: 'select',
    default: '0',
    options: [
      { value: '30', label: '30' },
      { value: '60', label: '60' },
      { value: '120', label: '120' },
      { value: '0', label: 'Sınırsız' },
    ],
  },
  {
    section: 'graphics',
    key: 'weatherQuality',
    label: 'Hava efektleri',
    hint: 'Yağmur yoğunluğu, bulutlar, ıslak yol yansıması',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'low', label: 'Düşük' },
      { value: 'medium', label: 'Orta' },
      { value: 'high', label: 'Yüksek' },
    ],
  },
  { section: 'graphics', key: 'antialias', label: 'Kenar yumuşatma', hint: 'Yeniden başlatma gerekir', type: 'toggle', default: true },

  // --- Trafik ----------------------------------------------------------------------
  {
    section: 'traffic',
    key: 'density',
    label: 'Trafik yoğunluğu',
    hint: 'Autobahn haritasında; sürerken T ile de değişir',
    type: 'select',
    default: 'medium',
    options: [
      { value: 'off', label: 'Kapalı' },
      { value: 'low', label: 'Düşük' },
      { value: 'medium', label: 'Orta' },
      { value: 'high', label: 'Yüksek' },
      { value: 'veryHigh', label: 'Çok yüksek' },
    ],
  },
  {
    section: 'traffic',
    key: 'variety',
    label: 'Trafik çeşitliliği',
    type: 'select',
    default: 'mixed',
    options: [
      { value: 'mixed', label: 'Karışık' },
      { value: 'carsOnly', label: 'Çoğunlukla otomobil' },
      { value: 'heavy', label: 'Yoğun ağır vasıta' },
    ],
  },
  {
    section: 'traffic',
    key: 'cutIns',
    label: 'Önüne kıran sürücüler',
    hint: 'Bazı NPC\'ler yakın mesafeden önüne geçebilir',
    type: 'select',
    default: 'some',
    options: [
      { value: 'off', label: 'Yok' },
      { value: 'some', label: 'Ara sıra' },
      { value: 'many', label: 'Sık' },
    ],
  },
  { section: 'traffic', key: 'minimapDots', label: 'Trafiği haritada göster', type: 'toggle', default: true },

  // --- Kontroller ---------------------------------------------------------------
  { section: 'controls', key: 'throttle', label: 'Gaz', type: 'key', default: 'KeyW' },
  { section: 'controls', key: 'brake', label: 'Fren / geri', type: 'key', default: 'KeyS' },
  { section: 'controls', key: 'left', label: 'Sol', type: 'key', default: 'KeyA' },
  { section: 'controls', key: 'right', label: 'Sağ', type: 'key', default: 'KeyD' },
  { section: 'controls', key: 'handbrake', label: 'El freni', type: 'key', default: 'Space' },
  { section: 'controls', key: 'camera', label: 'Kamera değiştir', type: 'key', default: 'KeyV' },
  { section: 'controls', key: 'lookBack', label: 'Arkaya bak (basılı tut)', type: 'key', default: 'KeyC' },
  { section: 'controls', key: 'recover', label: 'Aracı düzelt', hint: 'Autobahn: yoldan çıktıysan en yakın şeride döner', type: 'key', default: 'KeyR' },
  { section: 'controls', key: 'respawn', label: 'Başa dön (respawn)', type: 'key', default: 'Shift+KeyR' },
  { section: 'controls', key: 'headlights', label: 'Far aç / kapat', type: 'key', default: 'KeyL' },
  { section: 'controls', key: 'map', label: 'Büyük harita (aç / kapat)', type: 'key', default: 'KeyM' },
  { section: 'controls', key: 'trafficDensity', label: 'Trafik yoğunluğu (sırayla)', type: 'key', default: 'KeyT' },
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
