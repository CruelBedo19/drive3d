/**
 * Automatic test-drive measurements. Fed once per physics step with plain
 * numbers so it can be unit-tested without a vehicle.
 */
export interface MeasurementSample {
  /** km/h, from physics velocity. */
  speedKmh: number;
  /** Signed forward speed, m/s. */
  forwardSpeed: number;
  brake: number;
  /** Lateral acceleration, g. */
  lateralG: number;
  /** Body slip, degrees. */
  driftDeg: number;
  /** Distance covered this step, m. */
  distance: number;
}

export interface MeasurementResults {
  /** Latest run from standstill, seconds. */
  zeroTo100: number | null;
  zeroTo200: number | null;
  best0To100: number | null;
  /** Latest full stop from >= 100 km/h with the brake held, metres. */
  brake100To0: number | null;
  topSpeed: number;
  maxLateralG: number;
  /** Longest continuous drift (> 15°, > 20 km/h), seconds. */
  bestDrift: number;
  currentDrift: number;
}

const DRIFT_MIN_DEG = 15;
const DRIFT_MIN_KMH = 20;

export class Measurements {
  readonly results: MeasurementResults = {
    zeroTo100: null,
    zeroTo200: null,
    best0To100: null,
    brake100To0: null,
    topSpeed: 0,
    maxLateralG: 0,
    bestDrift: 0,
    currentDrift: 0,
  };

  /** Running 0-100 / 0-200 timer; null when no run from standstill is in progress. */
  private runTime: number | null = null;
  private runHit100 = false;
  /** 100-0 state: armed above 100 km/h with the brake held, measuring from the 100 km/h crossing. */
  private brakeArmed = false;
  private brakeDistance: number | null = null;

  update(dt: number, s: MeasurementSample): void {
    const r = this.results;

    // Acceleration runs start at standstill and end at 200 km/h (or when reversing).
    if (s.speedKmh < 0.5) {
      this.runTime = 0;
      this.runHit100 = false;
    } else if (this.runTime !== null) {
      this.runTime += dt;
      if (s.forwardSpeed < 0) {
        this.runTime = null;
      } else {
        if (!this.runHit100 && s.speedKmh >= 100) {
          this.runHit100 = true;
          r.zeroTo100 = this.runTime;
          r.best0To100 = r.best0To100 === null ? this.runTime : Math.min(r.best0To100, this.runTime);
        }
        if (s.speedKmh >= 200) {
          r.zeroTo200 = this.runTime;
          this.runTime = null;
        }
      }
    }

    // 100-0: brake hard above 100 km/h; distance counts from the moment speed
    // drops through 100. Releasing the brake cancels the run.
    if (s.brake < 0.5) {
      this.brakeArmed = false;
      this.brakeDistance = null;
    } else if (this.brakeDistance === null) {
      if (s.speedKmh >= 100) this.brakeArmed = s.brake > 0.9;
      else if (this.brakeArmed) {
        this.brakeArmed = false;
        this.brakeDistance = s.distance;
      }
    } else {
      this.brakeDistance += s.distance;
      if (s.speedKmh < 0.5) {
        r.brake100To0 = this.brakeDistance;
        this.brakeDistance = null;
      }
    }

    r.topSpeed = Math.max(r.topSpeed, s.speedKmh);
    if (s.speedKmh > 10) r.maxLateralG = Math.max(r.maxLateralG, s.lateralG);

    if (s.driftDeg > DRIFT_MIN_DEG && s.speedKmh > DRIFT_MIN_KMH) {
      r.currentDrift += dt;
      r.bestDrift = Math.max(r.bestDrift, r.currentDrift);
    } else {
      r.currentDrift = 0;
    }
  }

  reset(): void {
    const r = this.results;
    r.zeroTo100 = r.zeroTo200 = r.best0To100 = r.brake100To0 = null;
    r.topSpeed = r.maxLateralG = r.bestDrift = r.currentDrift = 0;
    this.runTime = null;
    this.runHit100 = false;
    this.brakeDistance = null;
    this.brakeArmed = false;
  }
}
