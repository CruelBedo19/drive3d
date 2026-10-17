import * as THREE from 'three';
import { clamp, damp, dampAngle } from '../utils/math';

/** What a camera follows. Filled from the vehicle's interpolated render state. */
export interface CameraTarget {
  readonly position: THREE.Vector3;
  readonly quaternion: THREE.Quaternion;
  /** Signed speed along the target's forward axis, m/s. */
  forwardSpeed: number;
  /** Body-frame mount for first-person / hood views. */
  readonly hoodOffset: THREE.Vector3;
}

export interface CameraMode {
  readonly name: string;
  /** Snap to the ideal pose (on activate, respawn). */
  reset(target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack?: number): void;
  /** `lookBack`: 0 = normal view, 1 = looking backwards (blends in between). */
  update(dt: number, target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack?: number): void;
}

/** How fast the look-back view blends in and out (1/s): ~0.15 s to settle, no long wait. */
const LOOK_BACK_LAMBDA = 20;

export interface ChaseSettings {
  distance: number;
  height: number;
  lookHeight: number;
  lookAhead: number;
  /** Heading follow rate; lower = camera swings wider in turns. */
  yawLambda: number;
  /** Offset follow rate (bumps, distance changes). */
  offsetLambda: number;
  heightLambda: number;
  /** Extra distance per m/s of speed. */
  distancePerSpeed: number;
  /** Metres of pull-back per m/s² of longitudinal acceleration (negative under braking). */
  accelInfluence: number;
  maxAccelOffset: number;
  fovBase: number;
  fovBoost: number;
  /** Speed (m/s) at which the full FOV boost applies. */
  fovSpeed: number;
}

const _fwd = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();

/** Third-person chase camera with lag on heading, height and acceleration. */
export class ChaseCamera implements CameraMode {
  readonly name: string;
  private readonly s: ChaseSettings;
  private yaw = 0;
  private height = 0;
  private distance = 0;
  private accel = 0;
  private prevSpeed = 0;
  private fov = 60;

  constructor(name: string, settings: ChaseSettings) {
    this.name = name;
    this.s = settings;
  }

  reset(target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack = 0): void {
    this.yaw = headingOf(target.quaternion, this.yaw);
    this.height = target.position.y;
    this.distance = this.s.distance + Math.abs(target.forwardSpeed) * this.s.distancePerSpeed;
    this.accel = 0;
    this.prevSpeed = target.forwardSpeed;
    this.fov = this.s.fovBase;
    this.apply(target, camera, lookBack);
  }

  update(dt: number, target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack = 0): void {
    const s = this.s;
    if (dt <= 0) {
      this.apply(target, camera, lookBack);
      return;
    }
    const speed = target.forwardSpeed;
    const absSpeed = Math.abs(speed);

    this.yaw = dampAngle(this.yaw, headingOf(target.quaternion, this.yaw), s.yawLambda, dt);
    this.height = damp(this.height, target.position.y, s.heightLambda, dt);

    // Smoothed longitudinal acceleration: pull back when accelerating, close in when braking.
    const rawAccel = (speed - this.prevSpeed) / dt;
    this.prevSpeed = speed;
    this.accel = damp(this.accel, clamp(rawAccel, -30, 30), 3, dt);
    const accelOffset = clamp(this.accel * Math.sign(speed || 1) * s.accelInfluence, -s.maxAccelOffset, s.maxAccelOffset);
    const wanted = s.distance + absSpeed * s.distancePerSpeed + accelOffset;
    this.distance = damp(this.distance, wanted, s.offsetLambda, dt);

    const fovTarget = s.fovBase + s.fovBoost * clamp(absSpeed / s.fovSpeed, 0, 1);
    this.fov = damp(this.fov, fovTarget, 2.5, dt);

    this.apply(target, camera, lookBack);
  }

  /** Looking back swings the same chase view to the front of the car, facing backwards. */
  private apply(target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack: number): void {
    const s = this.s;
    const yaw = this.yaw + lookBack * Math.PI;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const p = target.position;
    _desired.set(p.x - sin * this.distance, this.height + s.height, p.z - cos * this.distance);
    // Never below the car (relative, so hilly tracks work too).
    _desired.y = Math.max(_desired.y, p.y + 0.4);
    camera.position.copy(_desired);
    _look.set(p.x + sin * s.lookAhead, this.height + s.lookHeight, p.z + cos * s.lookAhead);
    camera.up.set(0, 1, 0);
    camera.lookAt(_look);
    setFov(camera, this.fov);
  }
}

/** Camera fixed to the car just above the hood. */
export class HoodCamera implements CameraMode {
  readonly name = 'hood';
  private readonly fovBase: number;
  private readonly fovBoost: number;
  private fov: number;
  private static readonly FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  constructor(fovBase = 70, fovBoost = 8) {
    this.fovBase = fovBase;
    this.fovBoost = fovBoost;
    this.fov = fovBase;
  }

  private readonly rear = new THREE.Vector3();

  reset(target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack = 0): void {
    this.fov = this.fovBase;
    this.update(0, target, camera, lookBack);
  }

  update(dt: number, target: CameraTarget, camera: THREE.PerspectiveCamera, lookBack = 0): void {
    if (lookBack > 0.5) {
      // Rear-facing mount over the back of the car (a blend through the cabin would look wrong).
      const h = target.hoodOffset;
      this.rear.set(h.x, h.y + 0.05, -Math.abs(h.z) - 0.9);
      camera.position.copy(this.rear).applyQuaternion(target.quaternion).add(target.position);
      camera.quaternion.copy(target.quaternion);
    } else {
      camera.position.copy(target.hoodOffset).applyQuaternion(target.quaternion).add(target.position);
      // three.js cameras look down -Z; the car faces +Z.
      camera.quaternion.copy(target.quaternion).multiply(HoodCamera.FLIP);
    }
    if (dt > 0) {
      const t = clamp(Math.abs(target.forwardSpeed) / 60, 0, 1);
      this.fov = damp(this.fov, this.fovBase + this.fovBoost * t, 2.5, dt);
    }
    setFov(camera, this.fov);
  }
}

/** Owns the modes, cycles through them (V) and handles the hold-to-look-back view (C). */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private readonly modes: CameraMode[];
  private index = 0;
  private lookBackWanted = false;
  /** 0..1, eased towards lookBackWanted. */
  private lookBack = 0;

  constructor(camera: THREE.PerspectiveCamera, modes: CameraMode[]) {
    this.camera = camera;
    this.modes = modes;
  }

  get mode(): CameraMode {
    return this.modes[this.index];
  }

  /** True while the look-back key is held. Never changes the selected mode. */
  get lookingBack(): boolean {
    return this.lookBackWanted;
  }

  /** Current look-back blend, 0..1. */
  get lookBackAmount(): number {
    return this.lookBack;
  }

  next(target: CameraTarget): void {
    this.index = (this.index + 1) % this.modes.length;
    this.mode.reset(target, this.camera, this.lookBack);
  }

  setLookBack(active: boolean): void {
    this.lookBackWanted = active;
  }

  reset(target: CameraTarget): void {
    this.lookBack = this.lookBackWanted ? 1 : 0;
    this.mode.reset(target, this.camera, this.lookBack);
  }

  update(dt: number, target: CameraTarget): void {
    const goal = this.lookBackWanted ? 1 : 0;
    // Real (unscaled) time is not available here; a paused sim passes dt = 0, so blend on a floor.
    this.lookBack = damp(this.lookBack, goal, LOOK_BACK_LAMBDA, Math.max(dt, 1 / 120));
    if (Math.abs(this.lookBack - goal) < 0.01) this.lookBack = goal;
    this.mode.update(dt, target, this.camera, this.lookBack);
  }
}

/** Default chase presets. */
export const CHASE_NORMAL: ChaseSettings = {
  distance: 6.2,
  height: 2.0,
  lookHeight: 0.9,
  lookAhead: 2.5,
  yawLambda: 5,
  offsetLambda: 4,
  heightLambda: 6,
  distancePerSpeed: 0.025,
  accelInfluence: 0.12,
  maxAccelOffset: 1.0,
  fovBase: 62,
  fovBoost: 12,
  fovSpeed: 60,
};

export const CHASE_CLOSE: ChaseSettings = {
  ...CHASE_NORMAL,
  distance: 4.4,
  height: 1.45,
  lookHeight: 0.75,
  lookAhead: 2.0,
  yawLambda: 6.5,
  accelInfluence: 0.08,
  maxAccelOffset: 0.7,
  fovBase: 66,
};

function headingOf(q: THREE.Quaternion, fallback: number): number {
  _fwd.set(0, 0, 1).applyQuaternion(q);
  // Nose pointing straight up/down: keep the previous heading.
  if (_fwd.x * _fwd.x + _fwd.z * _fwd.z < 0.01) return fallback;
  return Math.atan2(_fwd.x, _fwd.z);
}

function setFov(camera: THREE.PerspectiveCamera, fov: number): void {
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
