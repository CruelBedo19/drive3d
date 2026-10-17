import type { EngineConfig } from '../../config/vehicleTypes';
import { sampleCurve } from '../../utils/math';

const RPM_TO_RAD = (Math.PI * 2) / 60;

/** Torque model only: given rpm and throttle, how many Nm does the crank deliver. */
export class Engine {
  readonly config: EngineConfig;

  constructor(config: EngineConfig) {
    this.config = config;
  }

  /** Full-throttle torque at `rpm`, clipped by the power cap. */
  maxTorqueAt(rpm: number): number {
    const curve = this.config.peakTorqueNm * sampleCurve(this.config.torqueCurve, rpm);
    const omega = Math.max(rpm, 1) * RPM_TO_RAD;
    return Math.min(curve, (this.config.maxPowerKw * 1000) / omega);
  }

  /** Net crank torque: throttle torque, or engine braking when the throttle is closed. */
  torque(rpm: number, throttle: number): number {
    const c = this.config;
    if (rpm >= c.redlineRpm) return 0; // rev limiter cuts fuel
    const drive = this.maxTorqueAt(rpm) * throttle;
    const braking = c.engineBrakingNm * (1 - throttle) * Math.max(0, (rpm - c.idleRpm) / (c.redlineRpm - c.idleRpm));
    return drive - braking;
  }
}
