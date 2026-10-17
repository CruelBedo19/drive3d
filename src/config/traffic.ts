/**
 * AI traffic data: vehicle classes (size, mass, how they accelerate and brake,
 * which lanes they use), driver profiles (speed band, following distance,
 * temper), density / variety per setting and the bubble around the player.
 * Speeds in km/h here (converted where used), distances in metres.
 */

import MODEL_SIZES from './trafficModels.json';

export type TrafficClassId =
  | 'car'
  | 'fastCar'
  | 'van'
  | 'truck'
  | 'taxi'
  | 'police'
  | 'postvan'
  | 'ambulance'
  | 'citybus'
  | 'schoolbus'
  | 'garbageTruck'
  | 'serviceTruck'
  | 'towTruck'
  | 'fireTruck';
export type DriverProfileId = 'slow' | 'normal' | 'fast' | 'veryFast' | 'truck' | 'bus';
export type TrafficModelId = keyof typeof MODEL_SIZES;
export type TrafficDensity = 'off' | 'low' | 'medium' | 'high' | 'veryHigh';
export type TrafficVariety = 'mixed' | 'carsOnly' | 'heavy';
/** How many drivers are bold enough to cut in close in front of others (the player included). */
export type TrafficCutIns = 'off' | 'some' | 'many';
export const CUT_IN_SHARE: Record<TrafficCutIns, number> = { off: 0, some: 0.15, many: 0.35 };

export interface TrafficClass {
  label: string;
  /** Body size (length, width, height), m. */
  length: number;
  width: number;
  height: number;
  /** Mass when it turns into a free rigid body after a crash, kg. */
  mass: number;
  /** Strongest acceleration / comfortable braking, m/s². */
  accel: number;
  comfortBrake: number;
  /** Highest lane index it uses (0 = right lane). Trucks stay out of the left lane. */
  maxLane: number;
  /** Wheel radius and axle positions along the body (from the centre), m. */
  wheelRadius: number;
  axles: readonly number[];
  /** Driver profiles this class gets, with weights. */
  profiles: Partial<Record<DriverProfileId, number>>;
  /** Body colours to pick from (hex); textured models keep their own look. */
  paints: readonly number[];
  /** Heavy vehicle (truck, bus): slower lane changes, careful in fog, never joins from behind. */
  heavy: boolean;
  /**
   * Look: a prepared GLB from the civil vehicles pack (public/assets/traffic/<model>.glb, wheels
   * part of the model), or one of the built-in low-poly shapes.
   */
  model?: TrafficModelId;
  shape?: 'car' | 'fastCar' | 'van' | 'truck';
}

export interface DriverProfile {
  label: string;
  /** Wanted speed band, km/h (each driver picks a fixed value inside it). */
  speed: readonly [number, number];
  /** Time gap kept to the car in front, s. */
  headway: number;
  /** Bumper-to-bumper gap when stopped, m. */
  minGap: number;
  /** How much slower (km/h) the car in front must be before overtaking. */
  overtakeDelta: number;
  /** Rear time-to-collision needed before pulling out, s (larger = more careful). */
  rearTtc: number;
  /** Share of the curve / tunnel speed advice it follows (1 = all). */
  compliance: number;
}

const GERMAN_PAINTS = [0xc8ccd0, 0x1d1f22, 0xf2f2f0, 0x6b6f75, 0x1f3354, 0x8a1f1f, 0x3d4a3a, 0x9aa3ab, 0x2b2b30, 0xd8d4c8];

/** A class drawn with a prepared model: its size comes from the model (scripts/prepare-traffic.ts). */
function modelled(model: TrafficModelId, paint: number, c: Omit<TrafficClass, 'length' | 'width' | 'height' | 'wheelRadius' | 'axles' | 'paints' | 'model'>): TrafficClass {
  const s = MODEL_SIZES[model];
  // `paint`: the model's main colour, for its low-poly stand-in in the distance.
  return { ...c, model, length: s.length, width: s.width, height: s.height, wheelRadius: 0.4, axles: [], paints: [paint] };
}

export const TRAFFIC_CLASSES: Record<TrafficClassId, TrafficClass> = {
  car: { label: 'Binek', shape: 'car', heavy: false, length: 4.6, width: 1.82, height: 1.45, mass: 1450, accel: 1.8, comfortBrake: 2.6, maxLane: 2, wheelRadius: 0.32, axles: [1.4, -1.35], profiles: { slow: 0.25, normal: 0.6, fast: 0.15 }, paints: GERMAN_PAINTS },
  fastCar: { label: 'Hızlı binek', shape: 'fastCar', heavy: false, length: 4.7, width: 1.88, height: 1.32, mass: 1650, accel: 3.2, comfortBrake: 3.2, maxLane: 2, wheelRadius: 0.34, axles: [1.45, -1.4], profiles: { normal: 0.15, fast: 0.6, veryFast: 0.25 }, paints: [0x1d1f22, 0xf2f2f0, 0x6b6f75, 0x1f3354, 0xb02020, 0x9aa3ab, 0x2a4f8a] },
  van: { label: 'Van', shape: 'van', heavy: false, length: 5.3, width: 2.0, height: 2.45, mass: 2600, accel: 1.2, comfortBrake: 2.2, maxLane: 2, wheelRadius: 0.36, axles: [1.75, -1.65], profiles: { slow: 0.45, normal: 0.55 }, paints: [0xf2f2f0, 0xf2f2f0, 0xc8ccd0, 0x6b6f75, 0x1f3354, 0xd0a020] },
  truck: { label: 'Tır', shape: 'truck', heavy: true, length: 16.5, width: 2.55, height: 3.9, mass: 18000, accel: 0.55, comfortBrake: 1.6, maxLane: 1, wheelRadius: 0.5, axles: [6.4, 3.0, -4.2, -5.6, -7.0], profiles: { truck: 1 }, paints: [0xf2f2f0, 0x1f3354, 0x8a1f1f, 0x2e5d34, 0xd8d4c8, 0x6b6f75] },
  // Civil vehicles pack (Comrade1280, CC BY 4.0).
  taxi: modelled('taxi', 0xe8a317, { label: 'Taksi', heavy: false, mass: 1700, accel: 1.8, comfortBrake: 2.6, maxLane: 2, profiles: { normal: 0.7, fast: 0.3 } }),
  police: modelled('police', 0x26282c, { label: 'Polis', heavy: false, mass: 1850, accel: 2.4, comfortBrake: 3, maxLane: 2, profiles: { normal: 0.4, fast: 0.6 } }),
  postvan: modelled('postvan', 0x1f3a8a, { label: 'Posta aracı', heavy: false, mass: 2600, accel: 1.2, comfortBrake: 2.2, maxLane: 2, profiles: { slow: 0.5, normal: 0.5 } }),
  ambulance: modelled('ambulance', 0xf2f2f0, { label: 'Ambulans', heavy: false, mass: 4200, accel: 1.1, comfortBrake: 2.2, maxLane: 2, profiles: { normal: 0.7, fast: 0.3 } }),
  citybus: modelled('citybus', 0xd8dadc, { label: 'Otobüs', heavy: true, mass: 13000, accel: 0.7, comfortBrake: 1.8, maxLane: 1, profiles: { bus: 1 } }),
  schoolbus: modelled('schoolbus', 0xe8b020, { label: 'Okul otobüsü', heavy: true, mass: 11000, accel: 0.7, comfortBrake: 1.8, maxLane: 1, profiles: { bus: 1 } }),
  garbageTruck: modelled('garbagetruck', 0x2e5d34, { label: 'Çöp kamyonu', heavy: true, mass: 16000, accel: 0.55, comfortBrake: 1.6, maxLane: 1, profiles: { truck: 1 } }),
  serviceTruck: modelled('servicetruck', 0xf2f2f0, { label: 'Yol servis aracı', heavy: false, mass: 3500, accel: 1.1, comfortBrake: 2.2, maxLane: 1, profiles: { slow: 0.7, normal: 0.3 } }),
  towTruck: modelled('towtruck', 0xe8a020, { label: 'Çekici', heavy: true, mass: 7500, accel: 0.8, comfortBrake: 1.8, maxLane: 1, profiles: { truck: 1 } }),
  fireTruck: modelled('firetruck', 0xb02020, { label: 'İtfaiye', heavy: true, mass: 15000, accel: 0.7, comfortBrake: 1.8, maxLane: 1, profiles: { truck: 1 } }),
};

export const DRIVER_PROFILES: Record<DriverProfileId, DriverProfile> = {
  slow: { label: 'Yavaş', speed: [95, 120], headway: 1.9, minGap: 3, overtakeDelta: 14, rearTtc: 9, compliance: 1 },
  normal: { label: 'Normal', speed: [115, 150], headway: 1.5, minGap: 2.5, overtakeDelta: 10, rearTtc: 7, compliance: 1 },
  fast: { label: 'Hızlı', speed: [145, 190], headway: 1.2, minGap: 2.5, overtakeDelta: 8, rearTtc: 6, compliance: 0.95 },
  veryFast: { label: 'Çok hızlı', speed: [180, 230], headway: 1.0, minGap: 2, overtakeDelta: 6, rearTtc: 5.5, compliance: 0.9 },
  truck: { label: 'Kamyon', speed: [82, 95], headway: 2.2, minGap: 4, overtakeDelta: 7, rearTtc: 11, compliance: 1 },
  bus: { label: 'Otobüs', speed: [88, 100], headway: 2.1, minGap: 4, overtakeDelta: 8, rearTtc: 11, compliance: 1 },
};

/** Vehicles per km per carriageway, and the most allowed at once (both carriageways). */
export const TRAFFIC_DENSITY: Record<Exclude<TrafficDensity, 'off'>, { perKm: number; max: number }> = {
  low: { perKm: 3, max: 18 },
  medium: { perKm: 7, max: 36 },
  high: { perKm: 13, max: 64 },
  veryHigh: { perKm: 22, max: 100 },
};

/** Order the in-game key steps through, and the names shown. */
export const TRAFFIC_DENSITY_STEPS: readonly TrafficDensity[] = ['off', 'low', 'medium', 'high', 'veryHigh'];
export const TRAFFIC_DENSITY_LABELS: Record<TrafficDensity, string> = { off: 'Kapalı', low: 'Düşük', medium: 'Orta', high: 'Yüksek', veryHigh: 'Çok yüksek' };

/** Class mix per variety setting (weights). */
export const TRAFFIC_VARIETY: Record<TrafficVariety, Partial<Record<TrafficClassId, number>>> = {
  mixed: { car: 0.3, fastCar: 0.12, van: 0.06, truck: 0.1, taxi: 0.1, police: 0.05, postvan: 0.06, ambulance: 0.03, citybus: 0.04, schoolbus: 0.02, garbageTruck: 0.03, serviceTruck: 0.04, towTruck: 0.03, fireTruck: 0.02 },
  carsOnly: { car: 0.42, fastCar: 0.2, taxi: 0.18, police: 0.08, van: 0.04, postvan: 0.05, ambulance: 0.03 },
  heavy: { car: 0.22, fastCar: 0.06, van: 0.06, truck: 0.22, taxi: 0.06, postvan: 0.06, citybus: 0.08, schoolbus: 0.04, garbageTruck: 0.06, serviceTruck: 0.05, towTruck: 0.05, fireTruck: 0.04 },
};

export const TRAFFIC = {
  /** Simulated stretch around the player: behind / ahead along the road, m. */
  behind: 650,
  ahead: 2100,
  /** Never spawn closer to the camera than this (m), and not in plain view under it. */
  spawnMinDistance: 1300,
  /** Distance tiers (from the player), m, with hysteresis band. */
  nearRange: 130,
  mediumRange: 650,
  tierHysteresis: 20,
  /** Decision rates per tier (physics steps between decisions at 120 Hz). */
  decisionEvery: { near: 1, medium: 4, far: 12 },
  /** Kinematic bodies (player can hit them) kept in a pool. */
  bodyPool: 24,
  /** How far behind / ahead a driver looks for other vehicles, m. */
  lookAhead: 300,
  /** Far enough back to see a 300 km/h car closing at ~200 km/h 9 s before it arrives. */
  lookBehind: 600,
  /** Comfortable / emergency deceleration limits, m/s², and how fast acceleration may change, m/s³. */
  maxBrake: 8.5,
  jerk: 4,
  emergencyJerk: 25,
  /** Lane change: indicator time before moving, s; duration = base + speed (m/s) × perSpeed, s. */
  indicateTime: 1.4,
  laneChangeBase: 3.2,
  laneChangePerSpeed: 0.02,
  /** Rear gap time-to-collision below which a started lane change is aborted, s. */
  abortTtc: 2.5,
  /** Time spent in a lane before considering a move back right, s. */
  keepRightDelay: 3.5,
  /** Lateral acceleration drivers accept in curves, m/s² (speed advice = √(a / curvature)). */
  curveLateral: 2.8,
  /** Tunnel speed advice, km/h. */
  tunnelSpeed: 110,
  /** Weather: wanted speed × (1 - rainSlow × rain), headway × (1 + rainHeadway × rain). */
  rainSlow: 0.14,
  rainHeadway: 0.45,
  /** Fog: drivers keep their stopping distance within this share of the visibility. */
  fogSight: 0.6,
  /** Real (shadowless) spot lights lent to the nearest AI headlights at night. */
  realLights: 2,
} as const;
