import type { VehicleConfig } from '../../config/vehicleTypes';
import { damp, moveTowards } from '../../utils/math';
import { Engine } from './Engine';
import { Gearbox, GEAR_NEUTRAL, GEAR_REVERSE } from './Gearbox';

const RAD_TO_RPM = 60 / (Math.PI * 2);

/**
 * Engine + gearbox + clutch. Input: throttle and the driven wheels' spin.
 * Output: total drive torque at the driven wheels (before the differentials),
 * the engine inertia reflected to the wheels, and an rpm for HUD / audio.
 *
 * Engine rpm follows the driven wheels, so wheelspin revs the engine up and
 * hits the limiter like a real car.
 */
export class Powertrain {
  readonly engine: Engine;
  readonly gearbox: Gearbox;
  /** Engine rpm shown to the player. */
  rpm: number;
  /** Total signed torque delivered to the driven wheels, Nm. */
  wheelTorque = 0;
  /** Engine inertia seen at the driven wheels (sum over all of them), kg·m². 0 when declutched. */
  reflectedInertia = 0;
  /** True while the clutch slips (launch) or is open (N / shifting). */
  clutchSlipping = false;

  constructor(config: VehicleConfig) {
    this.engine = new Engine(config.engine);
    this.gearbox = new Gearbox(config.gearbox);
    this.rpm = config.engine.idleRpm;
  }

  /**
   * @param wheelOmega signed average angular velocity of the driven wheels, rad/s
   * @param groundOmega the same wheels' speed if they rolled without slip, rad/s.
   *   Shift decisions use it so wheelspin doesn't make the automatic hunt gears.
   */
  update(dt: number, throttle: number, wheelOmega: number, groundOmega: number): void {
    const e = this.engine.config;
    const gb = this.gearbox;
    const ratio = gb.totalRatio;

    // rpm the wheels force on the engine through the current gear.
    const wheelRpm = Math.abs(wheelOmega * ratio * RAD_TO_RPM);

    gb.updateAutomatic(dt, Math.abs(groundOmega * ratio * RAD_TO_RPM), throttle, e.redlineRpm);

    if (gb.gear === GEAR_NEUTRAL || gb.isShifting) {
      // Declutched: revs free-wheel towards throttle target (or the next gear's rpm while shifting).
      const target = gb.isShifting
        ? Math.max(e.idleRpm, Math.abs(wheelOmega * gb.totalRatio * RAD_TO_RPM))
        : e.idleRpm + throttle * (e.redlineRpm * 0.85 - e.idleRpm);
      this.rpm = moveTowards(this.rpm, target, e.freeRevRate * dt);
      this.wheelTorque = 0;
      this.reflectedInertia = 0;
      this.clutchSlipping = true;
      return;
    }

    // Engaged. In 1st / R the clutch slips at low speed so the car can launch.
    let rpm = Math.max(wheelRpm, e.idleRpm);
    if (gb.gear === 1 || gb.gear === GEAR_REVERSE) {
      rpm = Math.max(rpm, e.idleRpm + throttle * e.launchRpm);
    }
    this.clutchSlipping = rpm > wheelRpm + 50;
    rpm = Math.min(rpm, e.redlineRpm + 50);
    this.rpm = damp(this.rpm, rpm, 25, dt);

    let torque = this.engine.torque(this.rpm, throttle);
    // No engine braking below idle-equivalent wheel speed (clutch would open).
    if (torque < 0 && wheelRpm < e.idleRpm * 1.2) torque = 0;

    this.wheelTorque = torque * ratio * gb.config.efficiency;
    // A locked-up clutch couples the engine's inertia to the wheels through ratio².
    this.reflectedInertia = this.clutchSlipping ? 0 : e.inertia * ratio * ratio;
  }

  reset(): void {
    this.gearbox.select(GEAR_NEUTRAL);
    this.rpm = this.engine.config.idleRpm;
    this.wheelTorque = 0;
    this.reflectedInertia = 0;
  }
}
