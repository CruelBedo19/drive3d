import * as THREE from 'three';
import { RAPIER } from '../../core/PhysicsWorld';
import type { VehicleConfig } from '../../config/vehicleTypes';
import { DEG2RAD, clamp, lerp, moveTowards, sampleCurveSmooth, smoothstep } from '../../utils/math';
import { WheelState, WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR } from './WheelState';

const GRAVITY = 9.81;
/** Below this forward speed slip angles are computed against this floor to avoid noise. */
const SLIP_SPEED_FLOOR = 2.5;
/** TC / ABS never cut longitudinal grip below this fraction, so the car still drives and stops mid-corner. */
const MIN_ASSIST_LONG = 0.25;
/** Slip ratios are computed against at least this ground speed (m/s) so launches stay finite. */
const LONG_SLIP_FLOOR = 1.5;
/** Traction control keeps driven wheels at or below this combined slip (1 = peak). */
const TC_TARGET_SLIP = 0.9;
const TC_CUT_RATE = 25;
const TC_RESTORE_RATE = 3;
/** ABS lets brake torque reach slightly past the peak so braking stays firm. */
const ABS_MARGIN = 1.02;
/** Wheel-spin integration substeps per physics step. */
const WHEEL_SUBSTEPS = 8;
/** Spin limiter: yaw rate added per radian of excess slip (rad/s per rad, per second). */
const SPIN_RECOVERY_RATE = 25;
/** Spin limiter: fraction of the worsening yaw rate removed per second. */
const SPIN_RATE_DAMPING = 6;
/** Progressive limiter at full strength: yaw accel per radian of drift angle, and yaw-rate damping per second. */
const CURVE_RECOVERY_RATE = 14;
const CURVE_RATE_DAMPING = 7;
/** Counter-steer relief fades out between these drift angles (degrees). */
const RELIEF_FADE_START = 50;
const RELIEF_FADE_END = 70;
/** Wheelspin limiter: torque cut / restore rates (per second). */
const SPIN_CUT_RATE = 30;
const SPIN_RESTORE_RATE = 4;
/** Slip ratio the wheelspin limiter allows at full recovery (rear tyres grip again). */
const RECOVERY_SPIN_LIMIT = 0.06;
/** Slip ratio the wheelspin limiter allows while the steering is centred (just past the tyre peak). */
const CENTRED_SPIN_LIMIT = 0.08;
/** Recovery at full strength: yaw accel per radian of slide, yaw damping and sideways-speed damping per second. */
const RECOVERY_ALIGN_RATE = 4;
const RECOVERY_YAW_DAMPING = 4;
const RECOVERY_LATERAL_DAMPING = 1.2;

export const VEHICLE_COLLISION_GROUP = 0x0002;

/**
 * Raycast vehicle on top of a single Rapier rigid body.
 *
 * Rapier simulates the chassis (collisions, inertia, integration); this class
 * adds suspension and tyre forces as impulses each fixed step. Nothing here
 * knows about meshes: visuals read `wheels` and the body transform.
 */
export class VehiclePhysics {
  readonly config: VehicleConfig;
  readonly body: RAPIER.RigidBody;
  readonly wheels: WheelState[];

  /** Snapshot of the body state taken at the start of each step (world frame). */
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly linearVelocity = new THREE.Vector3();
  readonly angularVelocity = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly up = new THREE.Vector3(0, 1, 0);
  readonly left = new THREE.Vector3(1, 0, 0);

  /** Speed along the body's forward axis, m/s (negative when reversing). */
  forwardSpeed = 0;
  groundedWheels = 0;
  /** Spin assist strength used last step (0..1) and the yaw acceleration it applied, rad/s². */
  stabilityLevel = 0;
  stabilityYawAccel = 0;
  /** Slide recovery strength this step (0..1), set by the vehicle from driver input. */
  recoveryLevel = 0;
  /** Yaw rate the driver's steering input asks for, rad/s (recovery damps towards it). */
  recoveryYawTarget = 0;
  /** 1 while the driver's steering input is centred, 0 while steering (smoothed by the vehicle). */
  driverCentred = 0;

  private readonly world: RAPIER.World;
  private readonly localCom = new THREE.Vector3();
  private readonly ray: RAPIER.Ray;
  private peakB = 1;
  private yawInertia = 1;

  // Scratch objects, reused every step.
  private readonly _com = new THREE.Vector3();
  private readonly _hp = new THREE.Vector3();
  private readonly _down = new THREE.Vector3();
  private readonly _wf = new THREE.Vector3();
  private readonly _ws = new THREE.Vector3();
  private readonly _r = new THREE.Vector3();
  private readonly _v = new THREE.Vector3();
  private readonly _f = new THREE.Vector3();
  private readonly _p = new THREE.Vector3();
  private readonly _imp = { x: 0, y: 0, z: 0 };
  private readonly _pt = { x: 0, y: 0, z: 0 };
  private readonly _hitBodies: (RAPIER.RigidBody | null)[] = [null, null, null, null];

  constructor(world: RAPIER.World, config: VehicleConfig, position: THREE.Vector3, yaw: number) {
    this.world = world;
    this.config = config;
    const c = config.chassis;

    const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: rot.x, y: rot.y, z: rot.z, w: rot.w })
      .setLinearDamping(c.linearDamping)
      .setAngularDamping(c.angularDamping)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = world.createRigidBody(bodyDesc);

    // Mass comes from setAdditionalMassProperties, so colliders carry none.
    const groups = (VEHICLE_COLLISION_GROUP << 16) | 0xffff;
    const he = c.halfExtents;
    world.createCollider(
      RAPIER.ColliderDesc.roundCuboid(he.x - 0.05, he.y - 0.05, he.z - 0.05, 0.05)
        .setDensity(0)
        .setFriction(0.35)
        .setRestitution(0.1)
        .setCollisionGroups(groups),
      this.body,
    );
    const ch = c.cabinHalfExtents;
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(ch.x, ch.y, ch.z)
        .setTranslation(c.cabinOffset.x, c.cabinOffset.y, c.cabinOffset.z)
        .setDensity(0)
        .setFriction(0.35)
        .setRestitution(0.1)
        .setCollisionGroups(groups),
      this.body,
    );

    const f = config.front;
    const r = config.rear;
    this.wheels = [
      new WheelState(WHEEL_FL, true, true, new THREE.Vector3(f.halfTrack, f.hardpointY, f.z)),
      new WheelState(WHEEL_FR, true, false, new THREE.Vector3(-f.halfTrack, f.hardpointY, f.z)),
      new WheelState(WHEEL_RL, false, true, new THREE.Vector3(r.halfTrack, r.hardpointY, r.z)),
      new WheelState(WHEEL_RR, false, false, new THREE.Vector3(-r.halfTrack, r.hardpointY, r.z)),
    ];
    for (const wheel of this.wheels) wheel.suspensionLength = config.suspension.restLength;

    this.ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });

    this.refreshConfig();

    this.readBodyState();
  }

  /**
   * Re-reads config values this class caches (mass, inertia, centre of mass,
   * damping, tyre curve, wheel positions). Call after editing the config live.
   */
  refreshConfig(): void {
    const c = this.config.chassis;
    this.localCom.set(c.centerOfMass.x, c.centerOfMass.y, c.centerOfMass.z);
    // Box inertia of the main body, scaled. Higher roll inertia (z) resists tipping.
    const w = c.halfExtents.x * 2;
    const h = c.halfExtents.y * 2;
    const l = c.halfExtents.z * 2;
    const m = c.mass;
    const inertia = {
      x: (m / 12) * (h * h + l * l) * c.inertiaScale.x,
      y: (m / 12) * (w * w + l * l) * c.inertiaScale.y,
      z: (m / 12) * (w * w + h * h) * c.inertiaScale.z,
    };
    this.body.setAdditionalMassProperties(m, c.centerOfMass, inertia, { x: 0, y: 0, z: 0, w: 1 }, true);
    this.yawInertia = inertia.y;
    this.body.setLinearDamping(c.linearDamping);
    this.body.setAngularDamping(c.angularDamping);
    // Pacejka-style B so that sin(C * atan(B * s)) peaks at normalised slip s = 1.
    this.peakB = Math.tan(Math.PI / (2 * this.config.tires.curveShape));
    const f = this.config.front;
    const r = this.config.rear;
    this.wheels[WHEEL_FL].hardpoint.set(f.halfTrack, f.hardpointY, f.z);
    this.wheels[WHEEL_FR].hardpoint.set(-f.halfTrack, f.hardpointY, f.z);
    this.wheels[WHEEL_RL].hardpoint.set(r.halfTrack, r.hardpointY, r.z);
    this.wheels[WHEEL_RR].hardpoint.set(-r.halfTrack, r.hardpointY, r.z);
  }

  /** Spring length when the car sits at rest on flat ground (average corner load). */
  static staticSuspensionLength(config: VehicleConfig): number {
    const s = config.suspension;
    const staticCompression = Math.min((config.chassis.mass * GRAVITY) / 4 / s.stiffness, s.restLength * 0.8);
    return s.restLength - staticCompression;
  }

  /** Height of the body origin above flat ground when the car sits at rest. */
  static restHeight(config: VehicleConfig): number {
    return -config.front.hardpointY + VehiclePhysics.staticSuspensionLength(config) + config.wheel.radius;
  }

  /** Applies suspension, tyre and aero forces for one fixed step. Call before world.step(). */
  step(dt: number): void {
    this.readBodyState();
    const cfg = this.config;
    const susp = cfg.suspension;
    const radius = cfg.wheel.radius;
    const maxRay = susp.restLength + radius;

    this._com.copy(this.localCom).applyQuaternion(this.quaternion).add(this.position);
    this._down.copy(this.up).negate();

    // --- Pass 1: suspension raycasts and spring forces --------------------
    this.groundedWheels = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      this._hp.copy(w.hardpoint).applyQuaternion(this.quaternion).add(this.position);

      this.ray.origin.x = this._hp.x;
      this.ray.origin.y = this._hp.y;
      this.ray.origin.z = this._hp.z;
      this.ray.dir.x = this._down.x;
      this.ray.dir.y = this._down.y;
      this.ray.dir.z = this._down.z;

      const hit = this.world.castRayAndGetNormal(
        this.ray,
        maxRay,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      );

      w.prevCompression = w.compression;
      if (hit) {
        w.grounded = true;
        this.groundedWheels++;
        const springLen = hit.timeOfImpact - radius;
        w.suspensionLength = clamp(springLen, 0, susp.restLength);
        w.compression = susp.restLength - springLen; // may exceed restLength when bottoming out
        w.contactPoint.copy(this._hp).addScaledVector(this._down, hit.timeOfImpact);
        w.contactNormal.set(hit.normal.x, hit.normal.y, hit.normal.z);
        const parent = hit.collider.parent();
        this._hitBodies[i] = parent && parent.isDynamic() ? parent : null;
      } else {
        w.grounded = false;
        w.suspensionLength = susp.restLength;
        w.compression = 0;
        w.load = 0;
        this._hitBodies[i] = null;
      }
    }

    // Spring + damper + bump stop, then anti-roll bars per axle.
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) continue;
      const compVel = (w.compression - w.prevCompression) / dt;
      const damping = compVel > 0 ? susp.compressionDamping : susp.reboundDamping;
      let force = susp.stiffness * w.compression + damping * compVel;
      const bumpStart = susp.restLength * susp.bumpStopStart;
      if (w.compression > bumpStart) force += susp.bumpStopStiffness * (w.compression - bumpStart);
      w.load = force;
    }
    this.applyAntiRoll(this.wheels[WHEEL_FL], this.wheels[WHEEL_FR], cfg.front.antiRoll);
    this.applyAntiRoll(this.wheels[WHEEL_RL], this.wheels[WHEEL_RR], cfg.rear.antiRoll);

    // --- Pass 2: suspension forces, wheel spin, tyre forces ----------------
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      if (!w.grounded) {
        this.updateAirborneWheel(w, dt);
        continue;
      }
      w.load = Math.max(0, w.load);
      const load = Math.min(w.load, cfg.chassis.mass * GRAVITY * 1.5);
      const hitBody = this._hitBodies[i];

      // Suspension pushes along the body's up axis, at the hardpoint.
      this._hp.copy(w.hardpoint).applyQuaternion(this.quaternion).add(this.position);
      this._f.copy(this.up).multiplyScalar(load * dt);
      this.applyImpulse(this._f, this._hp, hitBody);

      // Wheel frame on the ground plane.
      const n = w.contactNormal;
      const cs = Math.cos(w.steerAngle);
      const sn = Math.sin(w.steerAngle);
      this._wf.copy(this.forward).multiplyScalar(cs).addScaledVector(this.left, sn);
      this._wf.addScaledVector(n, -n.dot(this._wf)).normalize();
      this._ws.crossVectors(n, this._wf); // points to the wheel's left

      // Velocity of the chassis at the contact patch: v + w x r.
      this._r.subVectors(w.contactPoint, this._com);
      this._v.crossVectors(this.angularVelocity, this._r).add(this.linearVelocity);
      const vLong = this._v.dot(this._wf);
      const vLat = this._v.dot(this._ws);
      w.longitudinalSpeed = vLong;
      w.lateralSpeed = vLat;

      this.solveTire(w, load, vLong, vLat, dt);
      const fx = w.longitudinalForce;
      const fy = w.lateralForce;

      // Rolling resistance acts on the chassis directly (never reverses motion).
      const massShare = load / GRAVITY;
      const roll = Math.min(cfg.chassis.rollingResistance * load, (Math.abs(vLong) * massShare) / dt);
      const fxTotal = fx - Math.sign(vLong) * roll;

      // Apply at the contact patch, raised towards the CoM by (1 - rollInfluence).
      const comHeight = this._p.subVectors(this._com, w.contactPoint).dot(this.up);
      this._p.copy(w.contactPoint).addScaledVector(this.up, comHeight * (1 - cfg.tires.rollInfluence));
      this._f.copy(this._wf).multiplyScalar(fxTotal * dt).addScaledVector(this._ws, fy * dt);
      this.applyImpulse(this._f, this._p, hitBody);
    }

    this.applySpinLimiter(dt);
    this.applyRecovery(dt);

    // --- Aero: drag opposes velocity, downforce grows with speed² ----------
    const speedSq = this.linearVelocity.lengthSq();
    if (speedSq > 0.01) {
      const speed = Math.sqrt(speedSq);
      this._f.copy(this.linearVelocity).multiplyScalar(-cfg.chassis.dragCoefficient * speed * dt);
      this._f.addScaledVector(this.up, -cfg.chassis.downforce * this.forwardSpeed * this.forwardSpeed * dt);
      this.applyImpulse(this._f, this._com, null);
    }
  }

  /**
   * Wheel spin + combined-slip tyre model for one grounded wheel.
   *
   * 1. Drive torque spins the wheel up, brake torque slows it (never reverses it).
   * 2. Slip ratio and slip angle are normalised by their peak values and combined:
   *    total force = mu * load * curve(|slip|), split along the slip direction.
   *    A spinning or locked wheel therefore loses most of its cornering force.
   * 3. Each force is capped at what would cancel its slip in one step, which keeps
   *    the stiff wheel / tyre coupling stable at any speed.
   * 4. The longitudinal reaction feeds back into wheel spin.
   * Results are written to the wheel state (forces, slips, spin).
   */
  private solveTire(w: WheelState, load: number, vLong: number, vLat: number, dt: number): void {
    const cfg = this.config;
    const tires = cfg.tires;
    const assists = cfg.assists;
    const r = cfg.wheel.radius;
    const cmd = w.command;
    const I = w.inertia;

    const axleGrip = w.isFront ? cfg.front.grip : cfg.rear.grip;
    const mu = tires.friction * axleGrip * cmd.gripScale * w.surfaceGrip;
    const maxF = mu * load;
    // Braking: the tyre's longitudinal grip × the car's braking grip (stronger stops than traction).
    const braking = cmd.brakeTorque > 0 && Math.abs(cmd.driveTorque) < cmd.brakeTorque;
    const longGrip = tires.longitudinalGrip * (braking ? (tires.brakingGrip ?? 1) : 1);
    const maxLong = maxF * longGrip;
    const massShare = load / GRAVITY;

    // Ideal TC / ABS: cap torques at what the tyre can still transmit while cornering.
    const longLeft = maxLong * Math.sqrt(Math.max(MIN_ASSIST_LONG * MIN_ASSIST_LONG, 1 - w.lateralUsage * w.lateralUsage));
    let drive = cmd.driveTorque;
    // During slide recovery, traction control fades in progressively (rear grip comes back).
    const tractionControl = Math.max(assists.tractionControl, this.recoveryLevel);
    if (tractionControl > 0) {
      // Feed-forward: never ask for more than the tyre's peak. Feedback: past the
      // peak force drops with slip, so cut torque quickly while the wheel is over
      // its target slip and give it back slowly once it hooks up.
      const over = drive * w.slipRatio > 0 ? w.combinedSlip - TC_TARGET_SLIP : -1;
      const target = over > 0 ? Math.max(0.1, 1 - over * 1.5) : 1;
      w.tcScale = moveTowards(w.tcScale, target, (target < w.tcScale ? TC_CUT_RATE : TC_RESTORE_RATE) * dt);
      const cap = longLeft * r * w.tcScale;
      const limited = clamp(drive, -cap, cap);
      drive = lerp(drive, limited, tractionControl);
    } else {
      w.tcScale = 1;
    }
    if (assists.wheelspinLimit > 0) {
      // Drift TC: only excess wheelspin is cut (slip ratio), sideways sliding is free.
      // During recovery the allowed spin shrinks so the rear tyres hook up again.
      // Wheel centred = the driver wants to go straight: allow little spin. Steering =
      // drifting: allow the configured spin.
      const base = lerp(assists.wheelspinLimit, Math.min(assists.wheelspinLimit, CENTRED_SPIN_LIMIT), this.driverCentred);
      const limit = lerp(base, RECOVERY_SPIN_LIMIT, this.recoveryLevel);
      const over = drive * w.slipRatio > 0 ? Math.abs(w.slipRatio) - limit : -1;
      const target = over > 0 ? Math.max(0.05, 1 - over * 30) : 1;
      w.spinScale = moveTowards(w.spinScale, target, (target < w.spinScale ? SPIN_CUT_RATE : SPIN_RESTORE_RATE) * dt);
      drive *= w.spinScale;
    } else {
      w.spinScale = 1;
    }
    let brake = cmd.brakeTorque;
    if (assists.abs > 0) brake = lerp(brake, Math.min(brake, longLeft * r * ABS_MARGIN), assists.abs);
    brake += cmd.handbrakeTorque;

    // The wheel / tyre coupling is much stiffer than the chassis, so wheel spin is
    // integrated in substeps with the chassis velocity held for this step.
    const h = dt / WHEEL_SUBSTEPS;
    const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), SLIP_SPEED_FLOOR));
    const sy = alpha / tires.peakSlipAngle;
    const slipFloor = Math.max(Math.abs(vLong), LONG_SLIP_FLOOR);
    const mFree = 1 / (1 / Math.max(massShare, 1) + (r * r) / I);
    const fyCap = (Math.abs(vLat) * massShare) / dt;
    let omega = w.angularVelocity;
    let locked = false;
    let fxSum = 0;
    let fySum = 0;
    for (let k = 0; k < WHEEL_SUBSTEPS; k++) {
      // 1. Driveline and brakes act on the wheel (brakes never reverse it).
      omega += (drive / I) * h;
      const brakeDelta = (brake / I) * h;
      locked = false;
      if (Math.abs(omega) <= brakeDelta) {
        omega = 0;
        locked = brake > 0;
      } else {
        omega -= Math.sign(omega) * brakeDelta;
      }

      // 2. Combined slip: both slips normalised by their peaks, force along the slip direction.
      const slipVel = omega * r - vLong;
      const sx = slipVel / slipFloor / tires.peakSlipRatio;
      const sigma = Math.sqrt(sx * sx + sy * sy);
      let fx = 0;
      let fy = 0;
      if (sigma > 1e-6) {
        const total = maxF * Math.sin(tires.curveShape * Math.atan(this.peakB * sigma));
        fx = ((total * sx) / sigma) * longGrip;
        fy = (-total * sy) / sigma;
      }

      // 3. Never more than what removes the slip. A brake-held wheel resists with
      // the whole corner mass; a free wheel shares the correction with its inertia.
      const fxCap = (Math.abs(slipVel) * (locked ? massShare : mFree)) / h;
      fx = clamp(fx, -fxCap, fxCap);
      fy = clamp(fy, -fyCap, fyCap);

      // 4. Ground reaction on the wheel; a locked wheel stays locked while the brake holds it.
      if (locked) {
        const reaction = fx * r;
        if (Math.abs(reaction) > brake) {
          omega = (-(reaction - Math.sign(reaction) * brake) / I) * h;
          locked = false;
        }
      } else {
        omega -= ((fx * r) / I) * h;
      }
      fxSum += fx;
      fySum += fy;
    }
    const fx = fxSum / WHEEL_SUBSTEPS;
    const fy = fySum / WHEEL_SUBSTEPS;
    // Slip after the reaction: what the tyre is really doing (TC, telemetry, effects).
    const kappa = (omega * r - vLong) / slipFloor;
    const sxPost = kappa / tires.peakSlipRatio;
    const sigma = Math.sqrt(sxPost * sxPost + sy * sy);

    w.angularVelocity = omega;
    w.spinAngle = (w.spinAngle + omega * dt) % (Math.PI * 2);
    w.locked = locked;
    w.slipRatio = clamp(kappa, -1, 10);
    w.slipAngle = alpha;
    w.combinedSlip = sigma;
    w.longitudinalForce = fx;
    w.lateralForce = fy;
    w.lateralUsage = maxF > 0 ? Math.min(1, Math.abs(fy) / maxF) : 0;
    w.slide = clamp(sigma - 1, 0, 1);
  }

  /** Wheel in the air: torques act on its inertia alone, slight bearing drag. */
  private updateAirborneWheel(w: WheelState, dt: number): void {
    const cmd = w.command;
    let omega = w.angularVelocity + (cmd.driveTorque / w.inertia) * dt;
    const brakeDelta = ((cmd.brakeTorque + cmd.handbrakeTorque) / w.inertia) * dt;
    omega = Math.abs(omega) <= brakeDelta ? 0 : omega - Math.sign(omega) * brakeDelta;
    omega *= 1 - Math.min(1, 0.3 * dt);
    w.angularVelocity = omega;
    w.spinAngle = (w.spinAngle + omega * dt) % (Math.PI * 2);
    w.locked = false;
    w.slide = 0;
    w.slipAngle = 0;
    w.slipRatio = 0;
    w.combinedSlip = 0;
    w.longitudinalForce = 0;
    w.lateralForce = 0;
    w.lateralUsage = 0;
  }

  /**
   * Arcade spin limiter.
   *
   * Threshold mode (no stabilityCurve): past maxSlipDeg of body slip it adds a
   * yaw impulse that turns the nose back towards the direction of travel and
   * damps the yaw rate that makes the slide worse. Inside the limit: pure physics.
   *
   * Progressive mode (stabilityCurve): the strength follows a smooth curve over
   * the drift angle, so it fades in instead of switching on. While the driver
   * counter-steers it backs off (countersteerRelief), but that relief fades out
   * as the angle approaches a spin, where the assist is meant to win.
   */
  private applySpinLimiter(dt: number): void {
    const a = this.config.assists;
    this.stabilityLevel = 0;
    this.stabilityYawAccel = 0;
    if (a.stability <= 0 || this.groundedWheels < 2) return;
    const vLat = this.linearVelocity.dot(this.left);
    const yawRate = this.angularVelocity.dot(this.up);
    let correction: number;

    if (a.stabilityCurve) {
      const vLong = this.forwardSpeed;
      if (vLat * vLat + vLong * vLong < 25) return; // below 18 km/h: no assist
      const beta = Math.atan2(vLat, vLong); // full range: + = travelling left of the nose
      const absDeg = Math.abs(beta) / DEG2RAD;
      const dir = Math.sign(beta);
      let level = sampleCurveSmooth(a.stabilityCurve, absDeg);
      // Driver counter-steering (front wheels pointing out of the slide): back off,
      // less and less as a spin gets closer.
      const steer = this.wheels[WHEEL_FL].steerAngle;
      const countering = steer * dir > 0 ? smoothstep(2 * DEG2RAD, 10 * DEG2RAD, Math.abs(steer)) : 0;
      const spinRisk = smoothstep(RELIEF_FADE_START, RELIEF_FADE_END, absDeg);
      level *= 1 - (a.countersteerRelief ?? 0) * countering * (1 - spinRisk);
      // Nose back towards the velocity, plus damping of yaw that grows the slide.
      correction = dir * Math.min(Math.abs(beta), Math.PI / 2) * CURVE_RECOVERY_RATE;
      if (yawRate * dir < 0) correction -= yawRate * CURVE_RATE_DAMPING;
      correction *= level;
      this.stabilityLevel = level;
    } else {
      if (this.forwardSpeed < 5) return;
      const beta = Math.atan2(vLat, this.forwardSpeed); // + = travelling left of the nose
      const excess = Math.abs(beta) - a.maxSlipDeg * DEG2RAD;
      if (excess <= 0) return;
      const dir = Math.sign(beta);
      // Positive yaw turns the nose left, which reduces a positive beta.
      correction = dir * excess * SPIN_RECOVERY_RATE;
      if (yawRate * dir < 0) correction -= yawRate * SPIN_RATE_DAMPING; // yaw making it worse
      this.stabilityLevel = 1;
    }

    const yawAccel = a.stability * correction;
    this.stabilityYawAccel = yawAccel;
    const dOmega = yawAccel * dt;
    this._imp.x = this.up.x * this.yawInertia * dOmega;
    this._imp.y = this.up.y * this.yawInertia * dOmega;
    this._imp.z = this.up.z * this.yawInertia * dOmega;
    this.body.applyTorqueImpulse(this._imp, true);
  }

  /**
   * Progressive slide recovery, scaled by recoveryLevel (0..1, computed by the
   * vehicle from the driver's inputs). It never moves the car directly: it adds
   * a gentle yaw impulse towards the direction of travel, damps yaw that grows
   * the slide, and bleeds off some sideways speed, all proportional to the slide.
   * Rear traction comes back through the wheelspin limiter (see solveTire).
   */
  private applyRecovery(dt: number): void {
    const level = this.recoveryLevel;
    if (level <= 0 || this.groundedWheels < 2 || this.forwardSpeed < 3) return;
    const vLat = this.linearVelocity.dot(this.left);
    const beta = Math.atan2(vLat, this.forwardSpeed);
    const dir = Math.sign(beta);
    const yawRate = this.angularVelocity.dot(this.up);
    // Nose towards the direction of travel, and yaw rate towards what the steering asks for.
    const correction = dir * Math.abs(beta) * RECOVERY_ALIGN_RATE - (yawRate - this.recoveryYawTarget) * RECOVERY_YAW_DAMPING;
    const dOmega = level * correction * dt;
    this._imp.x = this.up.x * this.yawInertia * dOmega;
    this._imp.y = this.up.y * this.yawInertia * dOmega;
    this._imp.z = this.up.z * this.yawInertia * dOmega;
    this.body.applyTorqueImpulse(this._imp, true);
    const dv = -vLat * Math.min(1, level * RECOVERY_LATERAL_DAMPING * dt) * this.config.chassis.mass;
    this._f.copy(this.left).multiplyScalar(dv);
    this.applyImpulse(this._f, this._com, null);
  }

  /** Teleports the car, upright, with the given yaw, and kills all motion. */
  reset(position: THREE.Vector3, yaw: number): void {
    const q = this.quaternion.setFromAxisAngle(this.up.set(0, 1, 0), yaw);
    this.body.setTranslation({ x: position.x, y: position.y, z: position.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    for (const w of this.wheels) {
      w.compression = 0;
      w.prevCompression = 0;
      w.suspensionLength = this.config.suspension.restLength;
      w.angularVelocity = 0;
      w.lateralUsage = 0;
      w.grounded = false;
    }
    this.readBodyState();
  }

  /** Copies the Rapier body state into the reusable THREE objects. */
  readBodyState(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const lv = this.body.linvel();
    const av = this.body.angvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.linearVelocity.set(lv.x, lv.y, lv.z);
    this.angularVelocity.set(av.x, av.y, av.z);
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.left.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.forwardSpeed = this.linearVelocity.dot(this.forward);
  }

  dispose(): void {
    this.world.removeRigidBody(this.body);
  }

  private applyAntiRoll(l: WheelState, r: WheelState, stiffness: number): void {
    if (!l.grounded && !r.grounded) return;
    const force = (l.compression - r.compression) * stiffness;
    if (l.grounded) l.load += force;
    if (r.grounded) r.load -= force;
  }

  /** Impulse on the chassis, and the opposite impulse on a dynamic body it stands on. */
  private applyImpulse(impulse: THREE.Vector3, point: THREE.Vector3, other: RAPIER.RigidBody | null): void {
    this._imp.x = impulse.x;
    this._imp.y = impulse.y;
    this._imp.z = impulse.z;
    this._pt.x = point.x;
    this._pt.y = point.y;
    this._pt.z = point.z;
    this.body.applyImpulseAtPoint(this._imp, this._pt, true);
    if (other) {
      this._imp.x = -impulse.x;
      this._imp.y = -impulse.y;
      this._imp.z = -impulse.z;
      other.applyImpulseAtPoint(this._imp, this._pt, true);
    }
  }
}
