import type { VehicleConfig, VehicleSetup } from '../vehicleTypes';
import { placeholderStreet } from '../vehicles/placeholderStreet';

/**
 * Setups are partial overrides applied on top of a car's base config. They are
 * pure data: the same physics code runs every setup.
 *
 * STREET: the car's base tune (no overrides).
 * SPORT:  fast, sharp, high grip: sticky tyres, quick steering held at the
 *         front tyres' peak, more power. A small power slide is caught at ~14°.
 * DRIFT:  big lock, low rear grip, aggressive LSD, no TC, light counter-steer
 *         help, and a progressive spin assist that stays out of the 15-45° zone.
 */
export type SetupId = 'STREET' | 'SPORT' | 'DRIFT';

export const SETUP_IDS: readonly SetupId[] = ['STREET', 'SPORT', 'DRIFT'];

export const SETUPS: Record<SetupId, VehicleSetup> = {
  STREET: {},

  SPORT: {
    steering: {
      steerSpeed: 4.6,
      returnSpeed: 6,
      // The tyre-based limit decides high-speed lock; this only keeps it from going twitchy.
      highSpeedAngleDeg: 12,
      highSpeedKmh: 230,
      highSpeedRateScale: 0.72,
      // Keeps the front tyres near their peak: maximum front grip, no understeer slide.
      gripLimitFactor: 1.15,
      countersteerAssist: 0.6,
    },
    tires: { friction: 1.15, longitudinalGrip: 1.15 },
    assists: { tractionControl: 0.75, abs: 0.9, stability: 0.85, maxSlipDeg: 14 },
    differential: { type: 'LSD', powerLock: 0.3, coastLock: 0.15, preload: 60 },
    suspension: { stiffness: 44000, compressionDamping: 3500, reboundDamping: 4400 },
    front: { grip: 1.12, antiRoll: 15000 },
    rear: { grip: 1.2, antiRoll: 15000 },
    // Strong aero: grip grows with speed so 100-180 km/h corners stay fast.
    chassis: { downforce: 3.0 },
    engine: { maxPowerKw: 320, peakTorqueNm: 470 },
    brakes: { maxForce: 18000 },
  },

  DRIFT: {
    steering: {
      maxAngleDeg: 52,
      highSpeedAngleDeg: 16,
      steerSpeed: 3.8,
      returnSpeed: 6,
      highSpeedRateScale: 0.85,
      gripLimitFactor: 4,
      // Light help only (and only while the driver isn't steering): the driver catches the slide.
      countersteerAssist: 0.35,
      // Keyboard: taps make small corrections, holding reaches full lock in ~0.45 s.
      keyboardRamp: 0.3,
      inputExpo: 1.5,
      // Wheels never point more than 10° beyond the direction of travel.
      counterSteerLimitDeg: 10,
    },
    assists: {
      tractionControl: 0,
      abs: 0.4,
      // Overall gain of the progressive assist; the curve below shapes it by angle.
      // Low on purpose: big mistakes (full throttle, steering into the slide) can still spin.
      stability: 0.17,
      maxSlipDeg: 90,
      // Progressive spin assist (drift angle in degrees -> strength): a light tidy-up
      // when grip returns, almost nothing in the 15-45° drift zone, easing in from
      // 45°, strong past 80°. Effective gain = stability x curve.
      stabilityCurve: [
        [0, 0.1],
        [15, 0.03],
        [45, 0.03],
        [60, 0.25],
        [80, 0.5],
        [110, 0.75],
      ],
      countersteerRelief: 0.8,
      // Keyboard W is always 100%: cap wheelspin so the rear keeps some side grip.
      wheelspinLimit: 0.6,
      recovery: 0.8,
    },
    differential: { type: 'LSD', powerLock: 0.85, coastLock: 0.6, preload: 200 },
    suspension: { stiffness: 44000, compressionDamping: 3600, reboundDamping: 4500 },
    front: { grip: 1.08, antiRoll: 21000 },
    rear: { grip: 0.9, antiRoll: 9000 },
    // Sharper drop-off after the peak: the rear lets go more willingly.
    tires: { curveShape: 1.25 },
    engine: { maxPowerKw: 300, peakTorqueNm: 490 },
    brakes: { handbrakeForce: 9000, handbrakeRearGrip: 0.7 },
  },
};

/**
 * Values the setups were tuned as absolute numbers on the test car but that belong to a car's size and power
 * (engine, brakes, springs, bars, aero, tyres): for another car they are applied as the same ratio to its own.
 */
const SCALED: readonly (readonly [string, string])[] = [
  ['engine', 'maxPowerKw'],
  ['engine', 'peakTorqueNm'],
  ['brakes', 'maxForce'],
  ['brakes', 'handbrakeForce'],
  ['suspension', 'stiffness'],
  ['suspension', 'compressionDamping'],
  ['suspension', 'reboundDamping'],
  ['front', 'antiRoll'],
  ['rear', 'antiRoll'],
  ['chassis', 'downforce'],
  ['tires', 'friction'],
  ['tires', 'longitudinalGrip'],
];

/**
 * A setup for one car: SPORT on a 2.8 t SUV is that SUV's engine +X %, stiffer by the same share, not the test car's
 * numbers. Values in SCALED become car value × (setup / test car); everything else (steering, assists, diff, grip
 * balance) applies as written. On the test car itself this is exactly SETUPS[id].
 */
export function setupFor(car: VehicleConfig, id: SetupId): VehicleSetup {
  const out = structuredClone(SETUPS[id]) as Record<string, Record<string, unknown>>;
  const ref = placeholderStreet.physics as unknown as Record<string, Record<string, number>>;
  const own = car as unknown as Record<string, Record<string, number>>;
  for (const [group, key] of SCALED) {
    const v = out[group]?.[key];
    if (typeof v !== 'number') continue;
    out[group][key] = own[group][key] * (v / ref[group][key]);
  }
  if (id === 'DRIFT') driftPack(car, out);
  return out as VehicleSetup;
}

/**
 * DRIFT on a real car: the slide needs the rear to spin up and stay spinning. Heavy cars, or ones with little power
 * for their weight, would bog down mid-drift, and road tyres with a lot of traction hook up again: the setup brings
 * every car to at least the power per kg the drift was tuned with on the test car (and at most 1.4× it), and the tyres' traction to the
 * test car's (lateral grip, the car's own feel, stays).
 */
const DRIFT_POWER_CAP = 1.4;

function driftPack(car: VehicleConfig, out: Record<string, Record<string, unknown>>): void {
  const ref = placeholderStreet.physics;
  const tunedKwPerKg = (SETUPS.DRIFT.engine?.maxPowerKw ?? ref.engine.maxPowerKw) / ref.chassis.mass;
  const kw = out.engine.maxPowerKw as number;
  const floor = car.chassis.mass * tunedKwPerKg;
  // At most 1.4× that: on a keyboard the throttle is all or nothing, and more power only adds speed, not angle.
  const target = Math.min(Math.max(kw, floor), floor * DRIFT_POWER_CAP);
  if (target !== kw) {
    out.engine.maxPowerKw = target;
    out.engine.peakTorqueNm = (out.engine.peakTorqueNm as number) * (target / kw);
  }
  out.tires = { ...(out.tires ?? {}), longitudinalGrip: ref.tires.longitudinalGrip };
  // Heavier and longer than the test car, real cars rotate further once loose: a little more rear grip keeps the
  // slide at 30-45° instead of winding past 60° and bogging down.
  if (car.vmaxKmh) out.rear = { ...(out.rear ?? {}), grip: car.driftRearGrip ?? 0.95 };
  // Four-wheel drive in a drift: the front wheels pull the car straight and on into the steered direction, and
  // full throttle keeps adding speed instead of angle. DRIFT drives the rear wheels only (as BMW's 2WD or AMG's
  // drift modes do).
  // A front-wheel-drive car cannot hold a drift on the throttle at all: in DRIFT it drives the rear wheels too (a
  // game choice; STREET / SPORT keep it front-driven).
  if (car.drivetrain === 'AWD' || car.drivetrain === 'FWD') (out as Record<string, unknown>).drivetrain = 'RWD';
  // Drift gearing: the test car's ratios, the final drive set so every gear reaches the same road speed at this
  // car's red line on its wheels as on the test car's. Long first gears hold a slide in second, short ones bounce
  // the limiter in first (the drive cuts out and the tyres hook up), many-speed boxes shift away mid-drift.
  const g = ref.gearbox;
  const finalDrive = g.finalDrive * (car.wheel.radius / ref.wheel.radius) * (car.engine.redlineRpm / ref.engine.redlineRpm);
  out.gearbox = {
    ...(out.gearbox ?? {}),
    ratios: [...g.ratios],
    finalDrive,
    shiftUpRpm: car.engine.redlineRpm * (g.shiftUpRpm / ref.engine.redlineRpm),
    shiftDownRpm: car.engine.redlineRpm * (g.shiftDownRpm / ref.engine.redlineRpm),
  };
}

export function isSetupId(v: string | null): v is SetupId {
  return v !== null && (SETUP_IDS as readonly string[]).includes(v);
}

/** Returns a new config with `setup` deep-merged over `base`. Arrays are replaced, not merged. */
export function applySetup(base: VehicleConfig, setup: VehicleSetup): VehicleConfig {
  const merged = structuredClone(base);
  deepMerge(merged as unknown as Record<string, unknown>, setup);
  return merged;
}

function deepMerge(target: Record<string, unknown>, patch: object): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    // Patches can come from imported JSON: never touch prototypes.
    if (value === undefined || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      deepMerge(current, value);
    } else {
      target[key] = structuredClone(value);
    }
  }
  return target;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
