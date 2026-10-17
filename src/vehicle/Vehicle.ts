import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import type { VehicleConfig } from '../config/vehicleTypes';
import type { DriverControls } from '../input/DrivingInput';
import { DEG2RAD, MS_TO_KMH, clamp01, lerp, moveTowards, smoothstep } from '../utils/math';
import { Differential } from './powertrain/Differential';
import { VehiclePhysics } from './physics/VehiclePhysics';
import { Powertrain } from './powertrain/Powertrain';
import { GEAR_NEUTRAL, GEAR_REVERSE } from './powertrain/Gearbox';
import { Steering } from './Steering';
import type { VehicleVisual, VehicleVisualState, WheelPose } from './visual/VehicleVisual';
import { WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR } from './physics/WheelState';

/** Below this |speed| (m/s) S / W switch between braking and changing direction. */
const DIRECTION_CHANGE_SPEED = 1.0;
/** Seconds of standing still with no input before the gearbox drops to N. */
const IDLE_TO_NEUTRAL = 0.6;
/** Brake applied automatically when stopped with no input (keeps the car parked). */
const HOLD_BRAKE = 0.25;
/** Recovery strength while the slide is still growing (vs. 1 once it shrinks). */
const RECOVERY_GROWING_FACTOR = 0.8;

/** Read-only snapshot for HUD, debug, camera, and future audio / effects. */
export interface VehicleTelemetry {
  speedKmh: number;
  forwardSpeed: number;
  rpm: number;
  gear: string;
  groundedWheels: number;
  throttle: number;
  brake: number;
  handbrake: number;
  steerAngle: number;
  /** Direction of the body's velocity relative to its heading, degrees (drift angle). */
  bodySlipDeg: number;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
}

/**
 * A drivable car: physics + powertrain + steering + driver logic, plus an
 * interchangeable visual. Fixed-rate logic in fixedUpdate(), per-frame
 * presentation (interpolation, wheel poses) in render().
 */
export class Vehicle {
  readonly config: VehicleConfig;
  readonly physics: VehiclePhysics;
  readonly powertrain: Powertrain;
  readonly steering: Steering;
  readonly frontDiff: Differential;
  readonly rearDiff: Differential;
  readonly visual: VehicleVisual;
  readonly telemetry: VehicleTelemetry;

  /** Interpolated transform of the body, valid after render(). */
  readonly renderPosition = new THREE.Vector3();
  readonly renderQuaternion = new THREE.Quaternion();

  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private readonly currPos = new THREE.Vector3();
  private readonly currQuat = new THREE.Quaternion();
  private readonly wheelPoses: WheelPose[];
  private readonly visualState: VehicleVisualState;
  private staticSuspensionLength = 0;
  /** Front torque fraction from the drivetrain layout. */
  private frontDriveShare = 0;
  private readonly _split: [number, number] = [0, 0];
  private readonly _v = new THREE.Vector3();
  private readonly _r = new THREE.Vector3();
  private idleTime = 0;
  private prevSlip = 0;
  /** Smoothed slide-recovery strength (see updateRecovery). */
  recoveryLevel = 0;

  constructor(world: World, config: VehicleConfig, visual: VehicleVisual, position: THREE.Vector3, yaw: number) {
    this.config = config;
    this.physics = new VehiclePhysics(world, config, position, yaw);
    this.powertrain = new Powertrain(config);
    this.steering = new Steering(config.steering);
    this.frontDiff = new Differential(config.differential);
    this.rearDiff = new Differential(config.differential);
    this.refreshDerived();
    this.visual = visual;
    this.wheelPoses = this.physics.wheels.map(() => ({ position: new THREE.Vector3(), suspensionOffset: 0, steerAngle: 0, spinAngle: 0 }));
    this.visualState = { wheels: this.wheelPoses, steeringWheel: 0, braking: false, reversing: false, headlights: false };
    this.telemetry = {
      speedKmh: 0,
      forwardSpeed: 0,
      rpm: 0,
      gear: 'N',
      groundedWheels: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
      steerAngle: 0,
      bodySlipDeg: 0,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
    };
    this.snapInterpolation();
  }

  /** Driver logic and force application for one fixed step. Call before world.step(). */
  fixedUpdate(dt: number, controls: DriverControls): void {
    const p = this.physics;
    p.readBodyState();
    const cfg = this.config;
    const v = p.forwardSpeed;
    const gb = this.powertrain.gearbox;

    // --- Pedals -> throttle / brake / gear direction (automatic) -------------
    let throttle = 0;
    let brake = 0;
    const wantsForward = controls.throttle > 0.05;
    const wantsBack = controls.brake > 0.05;

    if (gb.gear === GEAR_REVERSE) {
      if (wantsForward) {
        if (v < -DIRECTION_CHANGE_SPEED) brake = controls.throttle;
        else gb.select(1);
      } else {
        throttle = controls.brake;
      }
    }
    if (gb.gear !== GEAR_REVERSE) {
      throttle = controls.throttle;
      if (wantsBack) {
        if (v > DIRECTION_CHANGE_SPEED || wantsForward) {
          brake = controls.brake;
        } else {
          gb.select(GEAR_REVERSE);
          throttle = controls.brake;
        }
      }
      if (gb.gear === GEAR_NEUTRAL && wantsForward) gb.select(1);
    }

    // Parked: drop to N after a moment and hold the car.
    if (!wantsForward && !wantsBack && Math.abs(v) < 0.5) {
      this.idleTime += dt;
      if (this.idleTime > IDLE_TO_NEUTRAL) gb.select(GEAR_NEUTRAL);
      brake = Math.max(brake, HOLD_BRAKE);
    } else {
      this.idleTime = 0;
    }

    // Soft limiter near top speed (and a lower one in reverse).
    const kmh = Math.abs(v) * MS_TO_KMH;
    const limit = gb.gear === GEAR_REVERSE ? cfg.maxReverseKmh : cfg.maxSpeedKmh;
    throttle *= clamp01((limit - kmh) / 5);

    // --- Powertrain ------------------------------------------------------------
    const hb = controls.handbrake;
    const pt = this.powertrain;
    pt.update(dt, throttle, this.drivenWheelOmega(), v / cfg.wheel.radius);

    // --- Steering --------------------------------------------------------------
    const bodySlip = this.bodySlip();
    this.steering.update(dt, controls.steer, v, this.frontAxleSlip(), cfg.tires.peakSlipAngle, bodySlip);
    p.recoveryLevel = this.updateRecovery(dt, bodySlip);

    // --- Driveline: torque split, differentials, wheel inertia --------------------
    const wheels = p.wheels;
    const baseInertia = cfg.wheel.inertia;
    const front = this.frontDriveShare;
    // Pulling the handbrake declutches a rear-driven axle (as on a real RWD car).
    const rearDeclutched = hb > 0.5;
    const rear = rearDeclutched ? 0 : 1 - front;
    const reflected = pt.reflectedInertia;
    wheels[WHEEL_FL].inertia = wheels[WHEEL_FR].inertia = baseInertia + reflected * front * 0.5;
    wheels[WHEEL_RL].inertia = wheels[WHEEL_RR].inertia = baseInertia + reflected * rear * 0.5;
    this.splitAxle(this.frontDiff, pt.wheelTorque * front, WHEEL_FL, WHEEL_FR, dt);
    this.splitAxle(this.rearDiff, pt.wheelTorque * rear, WHEEL_RL, WHEEL_RR, dt);

    // --- Brakes and steering per wheel -------------------------------------------
    const b = cfg.brakes;
    const r = cfg.wheel.radius;
    // During slide recovery the rear tyres progressively regain grip, up to the
    // front's level: a loose drift rear would otherwise keep the car rotating.
    const rearRecoveryGrip = 1 + Math.max(0, cfg.front.grip / cfg.rear.grip - 1) * this.recoveryLevel;
    for (const w of wheels) {
      const cmd = w.command;
      cmd.brakeTorque = brake * b.maxForce * (w.isFront ? b.frontBias : 1 - b.frontBias) * 0.5 * r;
      cmd.handbrakeTorque = w.isFront ? 0 : hb * b.handbrakeForce * 0.5 * r;
      cmd.gripScale = w.isFront ? 1 : lerp(1, b.handbrakeRearGrip, hb) * rearRecoveryGrip;
      w.steerAngle = w.isFront ? this.steering.angle : 0;
    }

    p.step(dt);

    const t = this.telemetry;
    t.throttle = throttle;
    t.brake = brake;
    t.handbrake = hb;
  }

  /** Records the post-step state for interpolation. Call after world.step(). */
  postPhysics(): void {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.physics.readBodyState();
    this.currPos.copy(this.physics.position);
    this.currQuat.copy(this.physics.quaternion);
  }

  /** Per-frame presentation. `alpha` = fraction of a fixed step since the last physics step. */
  render(alpha: number): void {
    this.renderPosition.lerpVectors(this.prevPos, this.currPos, alpha);
    this.renderQuaternion.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
    const root = this.visual.root;
    root.position.copy(this.renderPosition);
    root.quaternion.copy(this.renderQuaternion);

    const susp = this.config.suspension;
    const wheels = this.physics.wheels;
    for (let i = 0; i < wheels.length; i++) {
      const w = wheels[i];
      const pose = this.wheelPoses[i];
      const len = w.grounded ? Math.min(w.suspensionLength, susp.restLength) : susp.restLength;
      pose.position.copy(w.hardpoint);
      pose.position.y -= len;
      pose.suspensionOffset = this.staticSuspensionLength - len;
      pose.steerAngle = w.steerAngle;
      pose.spinAngle = w.spinAngle;
    }
    const vs = this.visualState;
    vs.steeringWheel = this.steering.position;
    vs.braking = this.telemetry.brake > 0.05;
    vs.reversing = this.powertrain.gearbox.gear === GEAR_REVERSE;
    this.visual.update(vs);

    const p = this.physics;
    const t = this.telemetry;
    t.velocity.copy(p.linearVelocity);
    t.position.copy(this.renderPosition);
    t.speedKmh = p.linearVelocity.length() * MS_TO_KMH;
    t.forwardSpeed = p.forwardSpeed;
    t.rpm = this.powertrain.rpm;
    t.gear = this.powertrain.gearbox.label;
    t.groundedWheels = p.groundedWheels;
    t.steerAngle = this.steering.angle;
    const vx = p.linearVelocity.dot(p.left);
    const vz = p.linearVelocity.dot(p.forward);
    t.bodySlipDeg = Math.abs(vz) + Math.abs(vx) > 1 ? (Math.atan2(Math.abs(vx), Math.abs(vz)) * 180) / Math.PI : 0;
  }

  /** Puts the car upright at `position` with `yaw`, stopped, in neutral. */
  reset(position: THREE.Vector3, yaw: number): void {
    this.physics.reset(position, yaw);
    this.powertrain.reset();
    this.steering.reset();
    this.idleTime = 0;
    this.recoveryLevel = 0;
    this.prevSlip = 0;
    this.snapInterpolation();
  }

  /**
   * Applies edits made to `config` while driving (admin / tuning panel).
   * Sub-objects must be edited in place: physics, steering, gearbox and diffs
   * hold references to them.
   */
  refreshConfig(): void {
    this.physics.refreshConfig();
    this.refreshDerived();
  }

  private refreshDerived(): void {
    const c = this.config;
    this.frontDriveShare = c.drivetrain === 'FWD' ? 1 : c.drivetrain === 'AWD' ? c.awdFrontSplit : 0;
    this.staticSuspensionLength = VehiclePhysics.staticSuspensionLength(c);
  }

  /** Current heading around world Y, radians (0 = +Z). */
  get yaw(): number {
    const f = this.physics.forward;
    return Math.atan2(f.x, f.z);
  }

  dispose(): void {
    this.physics.dispose();
    this.visual.dispose();
  }

  /** Average spin of the driven wheels, rad/s (what the engine sees through the gearbox). */
  private drivenWheelOmega(): number {
    const w = this.physics.wheels;
    const front = (w[WHEEL_FL].angularVelocity + w[WHEEL_FR].angularVelocity) * 0.5;
    const rear = (w[WHEEL_RL].angularVelocity + w[WHEEL_RR].angularVelocity) * 0.5;
    return front * this.frontDriveShare + rear * (1 - this.frontDriveShare);
  }

  private splitAxle(diff: Differential, torque: number, left: number, right: number, dt: number): void {
    const w = this.physics.wheels;
    const l = w[left];
    const r = w[right];
    if (torque === 0 && diff.config.type === 'OPEN') {
      l.command.driveTorque = 0;
      r.command.driveTorque = 0;
      return;
    }
    diff.split(torque, l.angularVelocity, r.angularVelocity, l.inertia, r.inertia, dt, this._split);
    // Undriven axles have no diff coupling; a declutched driven axle keeps its LSD preload.
    const driven = (left === WHEEL_FL ? this.frontDriveShare : 1 - this.frontDriveShare) > 0;
    l.command.driveTorque = driven ? this._split[0] : 0;
    r.command.driveTorque = driven ? this._split[1] : 0;
  }

  /**
   * Slide recovery strength (0..1), progressive and smoothed. Grows when the
   * driver has centred the wheel (so isn't counter-steering), the car is sliding
   * and moving forwards, and is strongest once the slide angle is shrinking.
   */
  private updateRecovery(dt: number, bodySlip: number): number {
    const strength = this.config.assists.recovery;
    const abs = Math.abs(bodySlip);
    let target = 0;
    const p = this.physics;
    // Yaw the driver is asking for through the steering input alone (bicycle model).
    const c = this.config;
    const driverAngle = -this.steering.position * c.steering.maxAngleDeg * DEG2RAD;
    p.recoveryYawTarget = (p.forwardSpeed * Math.tan(driverAngle)) / (c.front.z - c.rear.z);
    const centred = 1 - smoothstep(0.05, 0.25, Math.abs(this.steering.position));
    p.driverCentred = centred;
    if (strength > 0 && p.forwardSpeed > 3) {
      // Sliding, or rotating much more than the steering asks for (a slow power-on circle).
      const yawExcess = Math.abs(p.angularVelocity.dot(p.up) - p.recoveryYawTarget);
      const sliding = Math.max(smoothstep(3 * DEG2RAD, 10 * DEG2RAD, abs), smoothstep(0.04, 0.2, yawExcess));
      const shrinking = abs < this.prevSlip ? 1 : RECOVERY_GROWING_FACTOR;
      target = strength * centred * sliding * shrinking;
    }
    this.prevSlip = abs;
    this.recoveryLevel = moveTowards(this.recoveryLevel, target, (target > this.recoveryLevel ? 3 : 1.5) * dt);
    return this.recoveryLevel;
  }

  /** Direction of travel at the centre of mass relative to the nose, rad (+ = left). 0 when slow or reversing. */
  private bodySlip(): number {
    const p = this.physics;
    if (p.forwardSpeed < 3) return 0;
    return Math.atan2(p.linearVelocity.dot(p.left), p.forwardSpeed);
  }

  /** Direction the front axle is travelling relative to the car, rad (+ = left). 0 when slow or reversing. */
  private frontAxleSlip(): number {
    const p = this.physics;
    if (p.forwardSpeed < 3) return 0;
    const com = this.config.chassis.centerOfMass;
    this._r.copy(p.forward).multiplyScalar(this.config.front.z - com.z);
    this._v.crossVectors(p.angularVelocity, this._r).add(p.linearVelocity);
    return Math.atan2(this._v.dot(p.left), this._v.dot(p.forward));
  }

  private snapInterpolation(): void {
    this.physics.readBodyState();
    this.currPos.copy(this.physics.position);
    this.currQuat.copy(this.physics.quaternion);
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.renderPosition.copy(this.currPos);
    this.renderQuaternion.copy(this.currQuat);
  }
}
