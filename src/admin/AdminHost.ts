import type { SetupId } from '../config/setups';
import type { VehicleConfig } from '../config/vehicleTypes';
import type { Vehicle } from '../vehicle/Vehicle';
import type { TestPoint } from '../world/Track';
import type { WeatherManager } from '../world/weather/WeatherManager';
import type { Measurements } from './Measurements';

/** What the admin panel may do to the running game. Implemented by Game. */
export interface AdminHost {
  readonly carId: string;
  readonly carIds: readonly string[];
  readonly vehicle: Vehicle;
  readonly testPoints: readonly TestPoint[];
  readonly measurements: Measurements;
  setupId: SetupId;
  /** Car base config with a setup applied (fresh copy). */
  baseConfig(setup: SetupId): VehicleConfig;
  /** Replaces the live config values (in place) and applies them. */
  applyConfig(config: VehicleConfig): void;
  /** Call after editing vehicle.config fields directly. */
  configEdited(): void;
  teleport(id: string): void;
  timeScale: number;
  paused: boolean;
  stepOnce(): void;
  toggleDebugPanel(): boolean;
  toggleColliders(): boolean;
  /** Live weather of the session (World / Weather tab), if any. */
  readonly weather?: WeatherManager;
}
