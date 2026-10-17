/**
 * Vehicle configuration types.
 *
 * A vehicle is described by plain data so that new cars (RS6, M3, GT-R...) and
 * tuning setups (STREET / SPORT / DRIFT) are just different objects fed into the
 * same physics code. Units are SI unless the field name says otherwise.
 *
 * Local vehicle frame: +Z forward, +Y up, +X left (glTF convention, so models
 * exported facing +Z drop in without rotation).
 */

export type Drivetrain = 'FWD' | 'RWD' | 'AWD';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ChassisConfig {
  /** kg */
  mass: number;
  /** Half extents of the main body collider, metres. */
  halfExtents: Vec3;
  /** Optional cabin collider (roof), so a flipped car rests on something sensible. */
  cabinHalfExtents: Vec3;
  cabinOffset: Vec3;
  /** Centre of mass in the local frame, relative to the body origin. Lower = harder to roll. */
  centerOfMass: Vec3;
  /** Multiplies the box inertia computed from halfExtents (x = pitch, y = yaw, z = roll). */
  inertiaScale: Vec3;
  linearDamping: number;
  angularDamping: number;
  /** 0.5 * rho * Cd * A, in N / (m/s)^2. */
  dragCoefficient: number;
  /** Rolling resistance coefficient (fraction of wheel load). */
  rollingResistance: number;
  /** Downforce, N / (m/s)^2. */
  downforce: number;
}

export interface AxleConfig {
  /** Longitudinal position of the axle, metres (+ = front). */
  z: number;
  /** Half the track width (distance from centre line to the wheel hardpoint). */
  halfTrack: number;
  /** Height of the suspension hardpoint in the body frame. */
  hardpointY: number;
  /** Anti-roll bar stiffness, N/m of left/right compression difference. */
  antiRoll: number;
  /** Tyre grip multiplier for this axle (scales tires.friction). */
  grip: number;
}

export interface SuspensionConfig {
  /** Spring travel at rest (fully extended), metres. */
  restLength: number;
  /** N/m */
  stiffness: number;
  /** N/(m/s) while compressing. */
  compressionDamping: number;
  /** N/(m/s) while extending. */
  reboundDamping: number;
  /** Extra stiffness once the spring passes this fraction of its travel. */
  bumpStopStart: number;
  bumpStopStiffness: number;
}

export interface WheelConfig {
  radius: number;
  width: number;
  /** Rotational inertia of one wheel + tyre + brake disc, kg·m². */
  inertia: number;
}

export type DifferentialType = 'OPEN' | 'LSD';

/**
 * Axle differential (used on every driven axle). AWD splits torque front/rear
 * with a fixed ratio (awdFrontSplit) before the axle diffs.
 */
export interface DifferentialConfig {
  type: DifferentialType;
  /** LSD: locking torque as a fraction of input torque under power (0..1). */
  powerLock: number;
  /** LSD: same, under engine braking / coast. */
  coastLock: number;
  /** LSD: locking torque available even with no input torque, Nm. */
  preload: number;
}

export interface TireConfig {
  /** Peak friction coefficient on asphalt. */
  friction: number;
  /** Fraction of lateral grip available longitudinally (traction / braking). */
  longitudinalGrip: number;
  /** Slip angle (rad) where lateral force peaks. */
  peakSlipAngle: number;
  /** Slip ratio where longitudinal force peaks (0.08..0.15 for road tyres). */
  peakSlipRatio: number;
  /**
   * Shape of the lateral curve after the peak (Pacejka "C"). 1.0 = no drop-off,
   * ~1.3 = gentle, predictable slide, >1.6 = snappy.
   */
  curveShape: number;
  /**
   * 0 = tyre forces act at centre-of-mass height (no body roll from cornering),
   * 1 = at the contact patch (fully physical). Low values keep the car from tipping.
   */
  rollInfluence: number;
}

export interface SteeringConfig {
  /** Maximum road-wheel angle at standstill, degrees. */
  maxAngleDeg: number;
  /** Maximum road-wheel angle at highSpeed, degrees. */
  highSpeedAngleDeg: number;
  /** Speed (km/h) where the high-speed limit is fully applied. */
  highSpeedKmh: number;
  /** Steering input rate, full lock per second (turning in). */
  steerSpeed: number;
  /** Rate when returning towards centre. */
  returnSpeed: number;
  /** Turn-in rate multiplier at highSpeedKmh (smaller = calmer at speed). */
  highSpeedRateScale: number;
  /**
   * Caps lock to what the front tyres can use at the current speed
   * (wheelbase * mu * g / v² + peak slip * this factor). 0 disables the cap.
   */
  gripLimitFactor: number;
  /**
   * Counter-steer help (0..1): while the car slides, the front wheels are turned
   * towards the direction of travel by this fraction automatically. Fades out
   * while the driver steers, so the two never add up to an over-correction.
   */
  countersteerAssist: number;
  /**
   * Keyboard ramp: seconds of holding A/D until the steering moves at full
   * speed (short taps move it slowly = small corrections). 0 = linear.
   */
  keyboardRamp: number;
  /** Steering curve: road-wheel angle = max x |input|^expo. 1 = linear, >1 = finer near centre. */
  inputExpo: number;
  /**
   * While sliding, the front wheels may point at most this far beyond the
   * direction of travel (stops counter-steer over-correction / tank-slappers). 0 = off.
   */
  counterSteerLimitDeg: number;
}

/** Driver aids, 0 = off, 1 = full. Setups (e.g. DRIFT) turn them down. */
export interface AssistConfig {
  /**
   * Caps each driven wheel's torque at what its tyre can transmit given the
   * cornering load (prevents wheelspin and power oversteer). 1 = ideal TC.
   */
  tractionControl: number;
  /** Same for service brakes: prevents wheel lock. The handbrake is never limited. */
  abs: number;
  /**
   * Spin limiter (0..1): beyond maxSlipDeg of body slip, a yaw correction pulls
   * the car back towards its direction of travel. 0 = off (pure physics).
   */
  stability: number;
  /** Body slip angle the spin limiter allows before it intervenes, degrees. */
  maxSlipDeg: number;
  /**
   * Progressive mode: [drift angle in degrees, assist strength 0..1] points.
   * Replaces the hard maxSlipDeg threshold with a smooth curve when present.
   */
  stabilityCurve?: ReadonlyArray<readonly [number, number]>;
  /**
   * Progressive mode: how much the assist backs off while the driver is
   * counter-steering (0 = never, 1 = fully), fading out as a spin becomes likely.
   */
  countersteerRelief?: number;
  /**
   * Driven-wheel slip-ratio limiter (drift TC): wheelspin above this slip ratio
   * is cut back, but sideways sliding is left alone. 0 = off.
   */
  wheelspinLimit: number;
  /**
   * Progressive slide recovery (0..1): once the driver centres the wheel and
   * stops counter-steering, rear traction, yaw and sideways speed are
   * gradually tidied up so the car settles back onto its path. 0 = off.
   */
  recovery: number;
}

export interface BrakeConfig {
  /** Total service brake force at the contact patches, N. */
  maxForce: number;
  /** Fraction of brake force on the front axle. */
  frontBias: number;
  /** Rear-axle force from the handbrake, N. */
  handbrakeForce: number;
  /** Rear grip multiplier while the handbrake is fully pulled (0..1). */
  handbrakeRearGrip: number;
}

export interface EngineConfig {
  idleRpm: number;
  redlineRpm: number;
  /** Power cap, kW. Torque is clipped so torque * omega never exceeds it. */
  maxPowerKw: number;
  peakTorqueNm: number;
  /** [rpm, fraction of peak torque], ascending rpm. */
  torqueCurve: ReadonlyArray<readonly [number, number]>;
  /** Engine braking torque at redline with the throttle closed, Nm. */
  engineBrakingNm: number;
  /** Crank + flywheel inertia, kg·m². Reflected to the wheels through the gear ratio. */
  inertia: number;
  /** Clutch-slip rpm above idle while launching in 1st / R. */
  launchRpm: number;
  /** How fast free (declutched) revs change, rpm/s. */
  freeRevRate: number;
}

export interface GearboxConfig {
  /** Forward ratios, index 0 = 1st gear. */
  ratios: readonly number[];
  reverseRatio: number;
  finalDrive: number;
  /** Driveline efficiency 0..1. */
  efficiency: number;
  shiftUpRpm: number;
  shiftDownRpm: number;
  /** Seconds of torque interruption per shift. */
  shiftTime: number;
}

export interface VehicleConfig {
  id: string;
  name: string;
  drivetrain: Drivetrain;
  /** Front torque fraction for AWD (ignored otherwise). */
  awdFrontSplit: number;
  maxSpeedKmh: number;
  maxReverseKmh: number;
  chassis: ChassisConfig;
  front: AxleConfig;
  rear: AxleConfig;
  suspension: SuspensionConfig;
  wheel: WheelConfig;
  differential: DifferentialConfig;
  tires: TireConfig;
  steering: SteeringConfig;
  brakes: BrakeConfig;
  assists: AssistConfig;
  engine: EngineConfig;
  gearbox: GearboxConfig;
}

/** Recursive partial, used for setups (STREET / SPORT / DRIFT) and tuning parts. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends ReadonlyArray<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type VehicleSetup = DeepPartial<VehicleConfig>;

/** One node name or several candidates (first match wins, case-insensitive fallback). */
export type NodeName = string | readonly string[];

/**
 * Maps the logical parts the game drives to node names inside a glTF model.
 * Every model can name its nodes differently; only wheels are required.
 */
export interface VehicleNodeMap {
  body?: NodeName;
  wheelFL: NodeName;
  wheelFR: NodeName;
  wheelRL: NodeName;
  wheelRR: NodeName;
  steeringWheel?: NodeName;
  headlights?: NodeName;
  brakeLights?: NodeName;
  reverseLights?: NodeName;
}

export interface VehicleModelConfig {
  /** URL of the .glb / .gltf, e.g. /assets/vehicles/<car>/<car>.glb */
  url: string;
  nodes: VehicleNodeMap;
  /** Uniform scale applied to the model (models in cm need 0.01). */
  scale: number;
  /** Rotation around Y so the model faces +Z, degrees. */
  rotationYDeg: number;
  /** Model offset relative to the physics body origin, metres (after scale / rotation). */
  offset: Vec3;
  /**
   * 'model': wheels stay where the model puts them (only suspension travel is added).
   * 'physics': wheels are moved to the physics wheel positions.
   */
  wheelPlacement: 'model' | 'physics';
  /** Local axis the steering wheel spins around, and its rotation at full lock, degrees. */
  steeringWheelAxis: 'x' | 'y' | 'z';
  steeringWheelMaxDeg: number;
  /** Hood camera mount in the body frame; falls back to a placeholder estimate. */
  hoodCamera?: Vec3;
}

/** How a car looks. Kept separate from physics so a GLB can replace the placeholder. */
export interface VehicleVisualConfig {
  kind: 'placeholder' | 'gltf';
  /** Required for 'gltf'. If loading fails the placeholder is shown instead. */
  model?: VehicleModelConfig;
  /** Placeholder body colour. */
  bodyColor: number;
}

export interface VehicleDefinition {
  physics: VehicleConfig;
  visual: VehicleVisualConfig;
}
