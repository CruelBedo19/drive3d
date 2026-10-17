import type { DifferentialConfig } from '../../config/vehicleTypes';
import { clamp } from '../../utils/math';

/**
 * Axle differential: splits input torque between a left and right wheel.
 *
 * OPEN: always 50/50 torque, so the wheel with less grip limits the axle
 *       (an unloaded inside wheel spins up).
 * LSD:  clutch-type limited slip. Torque is moved from the faster wheel to the
 *       slower one, up to a locking limit of preload + lock * |input torque|.
 *       The transfer is computed implicitly (what would equalise the wheel
 *       speeds this step), so a stiff lock stays numerically stable.
 *
 * New types (viscous, torsen, welded / spool) slot in as further cases.
 */
export class Differential {
  readonly config: DifferentialConfig;
  /** Torque moved from left to right last step, Nm (for telemetry / tests). */
  transfer = 0;

  constructor(config: DifferentialConfig) {
    this.config = config;
  }

  /**
   * @param torque input torque at the axle (after gearbox and final drive), Nm
   * @param omegaL / omegaR wheel angular velocities, rad/s
   * @param inertiaL / inertiaR wheel inertias, kg·m²
   * @param out receives [left, right] torques
   */
  split(torque: number, omegaL: number, omegaR: number, inertiaL: number, inertiaR: number, dt: number, out: [number, number]): void {
    const half = torque * 0.5;
    const c = this.config;
    if (c.type === 'OPEN') {
      this.transfer = 0;
    } else {
      const needed = ((omegaL - omegaR) * ((inertiaL * inertiaR) / (inertiaL + inertiaR))) / dt;
      const lock = c.preload + Math.abs(torque) * (torque >= 0 ? c.powerLock : c.coastLock);
      this.transfer = clamp(needed, -lock, lock);
    }
    out[0] = half - this.transfer;
    out[1] = half + this.transfer;
  }
}
