import type { SteeringConfig } from '../config/vehicleTypes';
import { DEG2RAD, MS_TO_KMH, lerp, moveTowards, smoothstep } from '../utils/math';

/** Steering speed at the very start of a key press, as a fraction of full speed. */
const KEY_RAMP_START = 0.35;

/**
 * Speed-sensitive steering. The wheel position moves towards the target at a
 * limited rate (no instant full lock) and the available lock shrinks with speed.
 */
export class Steering {
  readonly config: SteeringConfig;
  /** Smoothed steering-wheel position, -1 (left) .. +1 (right). */
  position = 0;
  /** Road-wheel angle, radians, positive = left (vehicle frame +X). */
  angle = 0;

  /** How long the current steering key direction has been held, s. */
  private holdTime = 0;
  private holdDir = 0;

  constructor(config: SteeringConfig) {
    this.config = config;
  }

  /**
   * @param target driver input, -1 (left) .. +1 (right)
   * @param speed forward speed, m/s
   * @param frontSlip direction of the front axle's velocity relative to the car,
   *   rad, positive = left. 0 when driving straight; large while sliding.
   * @param peakSlipAngle tyre peak slip angle, rad
   * @param bodySlip direction of travel at the centre of mass relative to the nose, rad
   */
  update(dt: number, target: number, speed: number, frontSlip: number, peakSlipAngle: number, bodySlip = 0): void {
    const c = this.config;
    const kmh = Math.abs(speed) * MS_TO_KMH;
    const t = smoothstep(0, c.highSpeedKmh, kmh);

    // Keyboard ramp: a fresh key press starts slow and speeds up while held.
    const dir = Math.sign(target);
    if (dir !== 0 && dir === this.holdDir) this.holdTime += dt;
    else this.holdTime = 0;
    this.holdDir = dir;
    const ramp = c.keyboardRamp > 0 ? lerp(KEY_RAMP_START, 1, Math.min(1, this.holdTime / c.keyboardRamp)) : 1;

    const returning = target === 0 || Math.sign(target) !== Math.sign(this.position);
    const rate = returning ? c.returnSpeed : c.steerSpeed * lerp(1, c.highSpeedRateScale, t) * ramp;
    this.position = moveTowards(this.position, target, rate * dt);

    const absMax = c.maxAngleDeg * DEG2RAD;
    const shaped = c.inputExpo !== 1 ? Math.sign(this.position) * Math.abs(this.position) ** c.inputExpo : this.position;
    let angle = -shaped * lerp(c.maxAngleDeg, c.highSpeedAngleDeg, t) * DEG2RAD;
    if (c.countersteerAssist > 0 && Math.abs(speed) > 3) {
      // Fades in as the car starts to slide (4..12° of body slip), so normal
      // cornering is untouched, and fades out as the driver steers, so assist
      // and driver never add up to an over-correction.
      const sliding = smoothstep(4 * DEG2RAD, 12 * DEG2RAD, Math.abs(bodySlip));
      angle += c.countersteerAssist * sliding * (1 - Math.abs(this.position)) * frontSlip;
    }
    if (c.counterSteerLimitDeg > 0 && Math.abs(frontSlip) > 3 * DEG2RAD && Math.abs(speed) > 3) {
      // Pointing the wheels further out than the direction of travel makes the
      // front grab and whip the car the other way: cap how far beyond it they go.
      const beyond = angle - frontSlip;
      const limit = c.counterSteerLimitDeg * DEG2RAD;
      if (beyond * frontSlip > 0 && Math.abs(beyond) > limit) angle = frontSlip + Math.sign(beyond) * limit;
    }
    if (c.gripLimitFactor > 0 && Math.abs(speed) > 3) {
      // Keep the front tyres near their peak slip angle: the window is centred on
      // where the front axle is actually travelling, so counter-steer into a
      // slide is always available while over-steering into understeer is not.
      const window = peakSlipAngle * c.gripLimitFactor;
      const lo = Math.max(-absMax, frontSlip - window);
      const hi = Math.min(absMax, frontSlip + window);
      if (lo <= hi) angle = Math.min(hi, Math.max(lo, angle));
    }
    this.angle = angle;
  }

  reset(): void {
    this.position = 0;
    this.angle = 0;
    this.holdTime = 0;
    this.holdDir = 0;
  }
}
