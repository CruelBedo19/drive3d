import type { GearboxConfig } from '../../config/vehicleTypes';

export const GEAR_REVERSE = -1;
export const GEAR_NEUTRAL = 0;

/**
 * Simple automatic gearbox. Gear numbering: -1 = R, 0 = N, 1..n = forward.
 * Shift decisions live in updateAutomatic() so a manual mode can bypass it later.
 */
export class Gearbox {
  readonly config: GearboxConfig;
  gear = GEAR_NEUTRAL;
  /** > 0 while a shift is in progress (no torque transmitted). */
  shiftTimer = 0;

  constructor(config: GearboxConfig) {
    this.config = config;
  }

  get forwardGears(): number {
    return this.config.ratios.length;
  }

  get isShifting(): boolean {
    return this.shiftTimer > 0;
  }

  /** Ratio of the current gear including final drive, signed (negative in reverse). */
  get totalRatio(): number {
    return this.ratioOf(this.gear);
  }

  ratioOf(gear: number): number {
    const c = this.config;
    if (gear === GEAR_NEUTRAL) return 0;
    if (gear === GEAR_REVERSE) return -c.reverseRatio * c.finalDrive;
    return c.ratios[gear - 1] * c.finalDrive;
  }

  get label(): string {
    if (this.gear === GEAR_REVERSE) return 'R';
    if (this.gear === GEAR_NEUTRAL) return 'N';
    return String(this.gear);
  }

  /** Direct gear selection (used for N / R / 1 transitions). */
  select(gear: number): void {
    if (gear === this.gear) return;
    // Engaging from N is instant; R <-> 1 goes through a normal shift pause.
    const fromNeutral = this.gear === GEAR_NEUTRAL;
    this.gear = gear;
    this.shiftTimer = gear === GEAR_NEUTRAL || fromNeutral ? 0 : this.config.shiftTime;
  }

  /**
   * Picks the next forward gear from the rpm the engine *would* have in the
   * current gear. `rpm` is the wheel-driven rpm (not clamped to idle).
   */
  updateAutomatic(dt: number, rpm: number, throttle: number, redlineRpm: number): void {
    if (this.shiftTimer > 0) {
      this.shiftTimer = Math.max(0, this.shiftTimer - dt);
      return;
    }
    if (this.gear < 1) return;
    const c = this.config;
    const upRpm = throttle > 0.1 ? c.shiftUpRpm : c.shiftUpRpm * 0.55;
    if (this.gear < this.forwardGears && (rpm > upRpm || rpm > redlineRpm - 100)) {
      // Only upshift if the next gear still has usable revs.
      const nextRpm = (rpm * c.ratios[this.gear]) / c.ratios[this.gear - 1];
      if (nextRpm > c.shiftDownRpm * 0.9 || rpm > redlineRpm - 100) this.shift(this.gear + 1);
      return;
    }
    const downRpm = throttle > 0.6 ? c.shiftDownRpm : c.shiftDownRpm * 0.6;
    if (this.gear > 1 && rpm < downRpm) {
      const lowerRpm = (rpm * c.ratios[this.gear - 2]) / c.ratios[this.gear - 1];
      if (lowerRpm < c.shiftUpRpm * 0.92) this.shift(this.gear - 1);
    }
  }

  private shift(gear: number): void {
    this.gear = gear;
    this.shiftTimer = this.config.shiftTime;
  }
}
