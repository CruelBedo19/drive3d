import type { VehicleConfig } from '../vehicleTypes';
import type { RealCarSpec } from './realSpecs';

/** Air density, kg/m³. */
const RHO = 1.225;
/** The test car the base handling was tuned on: its mass and wheel. */
const BASE_MASS = 1400;
const BASE_WHEEL_RADIUS = 0.34;

/** Peak friction per tyre kind (the test car runs 1.05: a good sports tyre). */
const TYRE_FRICTION: Record<RealCarSpec['tyre'], number> = { touring: 0.93, classic: 0.97, road: 1.0, sport: 1.05, cup: 1.17, slick: 1.42 };
/** Ride frequency relative to the test car per chassis character (springs, dampers, anti-roll bars scale with its square). */
const RIDE: Record<RealCarSpec['chassis'], number> = { comfort: 0.85, offroad: 0.85, sport: 1.0, race: 1.3 };
/** Centre of mass height relative to the body origin, m (test car -0.12). */
const COG: Record<RealCarSpec['cog'], number> = { low: -0.17, normal: -0.12, high: 0.02 };
/**
 * Driveline efficiency and seconds of torque cut per shift, per gearbox kind. The physics already loses energy to
 * wheel and engine inertia, tyre slip and rolling resistance, so these are the gearbox / diff losses only.
 */
const GEARBOX: Record<RealCarSpec['gearbox']['kind'], { efficiency: number; shiftTime: number }> = {
  manual: { efficiency: 0.94, shiftTime: 0.2 },
  dct: { efficiency: 0.93, shiftTime: 0.06 },
  automatic: { efficiency: 0.91, shiftTime: 0.12 },
  sequential: { efficiency: 0.95, shiftTime: 0.05 },
};
/**
 * Braking grip over the tyre's own (game feel: cars stop ~40 % shorter than the real ones would, so braking for
 * a junction or a car ahead feels sure-footed). Brake force rises with it.
 */
const BRAKING_GRIP = 1.6;
/** Traction / braking grip as a share of the lateral grip per tyre kind (test car 1.12). */
const TYRE_LONGITUDINAL: Record<RealCarSpec['tyre'], number> = { touring: 1.12, classic: 1.12, road: 1.15, sport: 1.22, cup: 1.25, slick: 1.3 };

/**
 * Torque curve (fraction of peak torque by rpm) from the factory figures: a
 * boosted engine holds its peak over the published band, a naturally
 * aspirated one peaks at its torque rpm; both meet the published peak power at
 * its rpm and fall off a little towards the red line. The engine model also
 * caps torque × ω at the peak power.
 */
export function torqueCurve(e: RealCarSpec['engine']): [number, number][] {
  const w = (rpm: number) => (rpm * Math.PI) / 30;
  const atPower = (kw: number, rpm: number) => Math.min(1, (kw * 1000) / w(rpm) / e.torqueNm);
  const [t0, t1] = e.torqueRpm;
  const pts: [number, number][] = e.boosted
    ? [
        [0, 0.38],
        [e.idleRpm, 0.48],
        [Math.max(e.idleRpm + 200, t0 * 0.65), 0.78],
        [t0, 1],
        [t1, 1],
      ]
    : [
        [0, 0.5],
        [e.idleRpm, 0.6],
        [Math.max(e.idleRpm + 200, t0 * 0.55), 0.85],
        [t0, 1],
      ];
  if (e.powerRpm > pts[pts.length - 1][0] + 100) pts.push([e.powerRpm, atPower(e.powerKw, e.powerRpm)]);
  if (e.redlineRpm > pts[pts.length - 1][0] + 100) pts.push([e.redlineRpm, atPower(e.powerKw * 0.95, e.redlineRpm)]);
  pts.push([e.redlineRpm + 400, pts[pts.length - 1][1] * 0.8]);
  return pts;
}

/**
 * A fitted car's physics from its factory data: mass and weight split, engine
 * (power, torque band, revs), gearbox (ratios, final drive scaled so the road
 * speed per rpm stays true on the model's wheel radius), drivetrain, drag and
 * downforce, tyres, brakes and springs scaled to the mass. Everything not in
 * the data (tyre curve shapes, steering, assists, suspension geometry) stays as
 * tuned on the test car.
 */
export function realPhysics(base: VehicleConfig, spec: RealCarSpec): VehicleConfig {
  const m = spec.massKg;
  const ride = RIDE[spec.chassis];
  const spring = (m / BASE_MASS) * ride * ride;
  const damp = (m / BASE_MASS) * ride;
  const wheelbase = base.front.z - base.rear.z;
  const r = base.wheel.radius;
  const gb = GEARBOX[spec.gearbox.kind];
  const e = spec.engine;
  const brakeG = spec.tyre === 'slick' ? 1.45 : spec.tyre === 'cup' ? 1.25 : spec.chassis === 'offroad' || spec.chassis === 'comfort' ? 1.0 : 1.1;
  return {
    ...base,
    drivetrain: spec.drivetrain,
    awdFrontSplit: spec.awdFrontSplit ?? base.awdFrontSplit,
    maxSpeedKmh: spec.limiterKmh,
    vmaxKmh: spec.vmaxKmh,
    driftRearGrip: spec.driftRearGrip,
    chassis: {
      ...base.chassis,
      mass: m,
      // Weight split: the centre of mass sits frontWeight of the wheelbase ahead of the rear axle.
      centerOfMass: { x: 0, y: COG[spec.cog], z: base.rear.z + spec.frontWeight * wheelbase },
      dragCoefficient: 0.5 * RHO * spec.cd * spec.frontalArea,
      downforce: spec.downforce,
    },
    front: { ...base.front, antiRoll: base.front.antiRoll * spring },
    rear: { ...base.rear, antiRoll: base.rear.antiRoll * spring },
    suspension: {
      ...base.suspension,
      restLength: spec.chassis === 'race' ? 0.28 : spec.chassis === 'offroad' ? 0.42 : spec.chassis === 'comfort' ? 0.38 : base.suspension.restLength,
      stiffness: base.suspension.stiffness * spring,
      compressionDamping: base.suspension.compressionDamping * damp,
      reboundDamping: base.suspension.reboundDamping * damp,
      bumpStopStiffness: base.suspension.bumpStopStiffness * (m / BASE_MASS),
    },
    wheel: { ...base.wheel, inertia: base.wheel.inertia * (r / BASE_WHEEL_RADIUS) ** 2 * Math.sqrt(m / BASE_MASS) },
    differential: spec.chassis === 'comfort' ? { type: 'OPEN', powerLock: 0, coastLock: 0, preload: 0 } : base.differential,
    tires: { ...base.tires, friction: TYRE_FRICTION[spec.tyre], longitudinalGrip: TYRE_LONGITUDINAL[spec.tyre], brakingGrip: BRAKING_GRIP },
    brakes: {
      ...base.brakes,
      maxForce: m * 9.81 * brakeG * BRAKING_GRIP,
      frontBias: Math.min(0.72, Math.max(0.55, spec.frontWeight + 0.12)),
      handbrakeForce: base.brakes.handbrakeForce * (m / BASE_MASS),
    },
    engine: {
      ...base.engine,
      idleRpm: e.idleRpm,
      redlineRpm: e.redlineRpm,
      maxPowerKw: e.powerKw,
      peakTorqueNm: e.torqueNm,
      torqueCurve: torqueCurve(e),
      engineBrakingNm: Math.round(e.torqueNm * 0.18),
      inertia: Math.min(0.3, 0.1 + e.torqueNm / 5000),
      launchRpm: e.boosted ? 2500 : Math.min(3500, e.redlineRpm * 0.35),
      freeRevRate: e.redlineRpm >= 8000 ? 13000 : e.boosted ? 8000 : 10000,
    },
    gearbox: {
      ratios: [...spec.gearbox.ratios],
      reverseRatio: spec.gearbox.reverse,
      // The model's wheel is not the real tyre: the same rpm gives the real road speed.
      finalDrive: spec.gearbox.finalDrive * (r / spec.tyreRadius),
      efficiency: gb.efficiency - (spec.drivetrain === 'AWD' ? 0.02 : 0),
      shiftUpRpm: Math.round(e.redlineRpm * 0.96),
      shiftDownRpm: Math.round(e.redlineRpm * 0.4),
      shiftTime: gb.shiftTime,
    },
  };
}
