import * as THREE from 'three';

/** Wheel order used everywhere: physics, visuals, telemetry. */
export const WHEEL_FL = 0;
export const WHEEL_FR = 1;
export const WHEEL_RL = 2;
export const WHEEL_RR = 3;

/** Per-step commands for one wheel, filled by the vehicle before each physics step. */
export interface WheelCommand {
  /** Signed torque from the driveline, Nm (positive = forward). */
  driveTorque: number;
  /** Service brake torque magnitude, Nm. Subject to ABS. */
  brakeTorque: number;
  /** Handbrake torque magnitude, Nm. Never limited by ABS. */
  handbrakeTorque: number;
  /** Multiplies the tyre's grip this step (setups, effects...). */
  gripScale: number;
}

/** Simulation state of one wheel. Read by visuals, HUD, and later skid marks / smoke / audio. */
export class WheelState {
  readonly index: number;
  readonly isFront: boolean;
  readonly isLeft: boolean;
  /** Suspension hardpoint in the body frame. */
  readonly hardpoint: THREE.Vector3;

  readonly command: WheelCommand = { driveTorque: 0, brakeTorque: 0, handbrakeTorque: 0, gripScale: 1 };

  /** Grip of the surface under this wheel (1 = dry asphalt). Future: wet, grass, gravel. */
  surfaceGrip = 1;
  /** Rotational inertia this step: wheel + reflected engine/driveline, kg·m². Set by the vehicle. */
  inertia = 1;

  steerAngle = 0;
  grounded = false;
  /** 0 = fully extended, restLength = fully compressed. */
  compression = 0;
  prevCompression = 0;
  /** Current spring length (hardpoint to wheel centre). */
  suspensionLength = 0;
  /** Normal load on the tyre, N. */
  load = 0;
  /** Contact point and normal (world). Valid while grounded. */
  readonly contactPoint = new THREE.Vector3();
  readonly contactNormal = new THREE.Vector3(0, 1, 0);

  /** Wheel spin, rad/s (positive = rolling forward). */
  angularVelocity = 0;
  /** Accumulated rotation for visuals, rad. */
  spinAngle = 0;
  /** True while the brakes hold the wheel stationary relative to the hub. */
  locked = false;

  /** Velocity of the contact patch in the wheel frame, m/s. */
  longitudinalSpeed = 0;
  lateralSpeed = 0;
  /** (wheel surface speed - ground speed) / ground speed. >0 wheelspin, <0 braking slip, -1 locked. */
  slipRatio = 0;
  /** Slip angle, rad. */
  slipAngle = 0;
  /** Combined slip normalised to the peak (1 = at the grip limit). */
  combinedSlip = 0;
  /** Tyre forces this step, N (wheel frame). */
  longitudinalForce = 0;
  lateralForce = 0;
  /** Fraction of the grip used laterally last step (0..1), used by TC / ABS. */
  lateralUsage = 0;
  /** Traction-control torque multiplier for this wheel (1 = no intervention). */
  tcScale = 1;
  /** Wheelspin-limiter torque multiplier for this wheel (1 = no intervention). */
  spinScale = 1;
  /** 0..1, how far past the grip limit the tyre is (for skid marks / smoke later). */
  slide = 0;

  constructor(index: number, isFront: boolean, isLeft: boolean, hardpoint: THREE.Vector3) {
    this.index = index;
    this.isFront = isFront;
    this.isLeft = isLeft;
    this.hardpoint = hardpoint;
  }

  /** Visual / audio spin rate alias. */
  get spinRate(): number {
    return this.angularVelocity;
  }
}
