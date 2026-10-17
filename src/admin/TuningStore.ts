import type { VehicleConfig, VehicleSetup } from '../config/vehicleTypes';

/**
 * Tuning persistence in this browser's localStorage: the working tune per car
 * (restored on reload while admin mode is on) and named presets. Every access
 * is guarded, since storage can be unavailable (private mode, blocked).
 */
const PREFIX = 'drive3d.admin.';

export interface NamedPreset {
  name: string;
  carId: string;
  savedAt: string;
  config: VehicleConfig;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    if (value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const TuningStore = {
  /**
   * Working tune = only the values that differ from the chosen setup, so later
   * improvements to the base tune still reach everything the user didn't touch.
   */
  loadWorking(carId: string): { setup: string; patch: VehicleSetup } | null {
    return read(`working.v2.${carId}`);
  },
  saveWorking(carId: string, setup: string, config: VehicleConfig, base: VehicleConfig): void {
    write(`working.v2.${carId}`, { setup, patch: diff(base, config) ?? {} });
  },
  clearWorking(carId: string): void {
    write(`working.v2.${carId}`, null);
  },
  listPresets(): NamedPreset[] {
    return read<NamedPreset[]>('presets') ?? [];
  },
  savePreset(preset: NamedPreset): boolean {
    const list = TuningStore.listPresets().filter((p) => p.name !== preset.name);
    list.push(preset);
    return write('presets', list);
  },
  deletePreset(name: string): void {
    write('presets', TuningStore.listPresets().filter((p) => p.name !== name));
  },
  loadPanelState(): { open: boolean; groups: Record<string, boolean> } | null {
    return read('panel');
  },
  savePanelState(state: { open: boolean; groups: Record<string, boolean> }): void {
    write('panel', state);
  },
};

/** Values in `next` that differ from `base` (arrays compared whole). undefined if equal. */
export function diff(base: unknown, next: unknown): VehicleSetup | undefined {
  if (typeof base === 'object' && base !== null && !Array.isArray(base) && typeof next === 'object' && next !== null && !Array.isArray(next)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(next)) {
      const d = diff((base as Record<string, unknown>)[key], value);
      if (d !== undefined) out[key] = d;
    }
    return Object.keys(out).length ? (out as VehicleSetup) : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(next) ? undefined : (next as VehicleSetup);
}
