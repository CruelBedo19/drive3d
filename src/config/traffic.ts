/**
 * AI traffic data: vehicle classes (size, mass, how they accelerate and brake,
 * which lanes they use), driver profiles (speed band, following distance,
 * temper), density / variety per setting and the bubble around the player.
 * Speeds in km/h here (converted where used), distances in metres.
 */

import MODEL_SIZES from './trafficModels.json';

export type TrafficModelId = keyof typeof MODEL_SIZES;
/** Built-in low-poly shapes (fallbacks, headless tests) and one class per prepared model. */
export type TrafficClassId = 'car' | 'fastCar' | 'van' | 'truck' | TrafficModelId;
export type DriverProfileId = 'slow' | 'normal' | 'fast' | 'veryFast' | 'truck' | 'bus';
/** What a prepared model is (scripts/prepare-traffic.ts): sets its handling, lanes and drivers. */
export type TrafficKind = 'car' | 'suv' | 'pickup' | 'van' | 'police' | 'lightTruck' | 'truck' | 'bus';
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
   * Look: a prepared GLB from the traffic car pack (public/assets/traffic/<model>.glb, wheels
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

type KindClass = Omit<TrafficClass, 'length' | 'width' | 'height' | 'wheelRadius' | 'axles' | 'paints' | 'model' | 'shape'>;

/** Handling, lanes and drivers per kind of prepared model. */
const KINDS: Record<TrafficKind, KindClass> = {
  car: { label: 'Binek', heavy: false, mass: 1350, accel: 1.8, comfortBrake: 2.6, maxLane: 2, profiles: { slow: 0.25, normal: 0.6, fast: 0.15 } },
  suv: { label: 'SUV', heavy: false, mass: 2100, accel: 1.7, comfortBrake: 2.6, maxLane: 2, profiles: { normal: 0.7, fast: 0.3 } },
  pickup: { label: 'Pikap', heavy: false, mass: 2000, accel: 1.5, comfortBrake: 2.4, maxLane: 2, profiles: { slow: 0.3, normal: 0.6, fast: 0.1 } },
  van: { label: 'Van', heavy: false, mass: 2600, accel: 1.2, comfortBrake: 2.2, maxLane: 2, profiles: { slow: 0.45, normal: 0.55 } },
  police: { label: 'Polis', heavy: false, mass: 1800, accel: 2.4, comfortBrake: 3, maxLane: 2, profiles: { normal: 0.4, fast: 0.6 } },
  lightTruck: { label: 'Kamyonet', heavy: false, mass: 4500, accel: 0.9, comfortBrake: 2, maxLane: 1, profiles: { slow: 0.7, normal: 0.3 } },
  truck: { label: 'Kamyon', heavy: true, mass: 16000, accel: 0.55, comfortBrake: 1.6, maxLane: 1, profiles: { truck: 1 } },
  bus: { label: 'Otobüs', heavy: true, mass: 13000, accel: 0.7, comfortBrake: 1.8, maxLane: 1, profiles: { bus: 1 } },
};

const MODELS = MODEL_SIZES as Record<TrafficModelId, { kind: string; length: number; width: number; height: number; paint: number }>;
const MODEL_IDS = Object.keys(MODELS) as TrafficModelId[];
const kindOf = (id: TrafficModelId) => MODELS[id].kind as TrafficKind;

/** A class drawn with a prepared model: size, kind and main colour come from the model (scripts/prepare-traffic.ts). */
function modelled(model: TrafficModelId): TrafficClass {
  const s = MODELS[model];
  // `paint`: the model's main colour, for its low-poly stand-in if the model cannot be loaded.
  return { ...KINDS[kindOf(model)], model, length: s.length, width: s.width, height: s.height, wheelRadius: 0.4, axles: [], paints: [s.paint] };
}

export const TRAFFIC_CLASSES: Record<TrafficClassId, TrafficClass> = {
  car: { label: 'Binek', shape: 'car', heavy: false, length: 4.6, width: 1.82, height: 1.45, mass: 1450, accel: 1.8, comfortBrake: 2.6, maxLane: 2, wheelRadius: 0.32, axles: [1.4, -1.35], profiles: { slow: 0.25, normal: 0.6, fast: 0.15 }, paints: GERMAN_PAINTS },
  fastCar: { label: 'Hızlı binek', shape: 'fastCar', heavy: false, length: 4.7, width: 1.88, height: 1.32, mass: 1650, accel: 3.2, comfortBrake: 3.2, maxLane: 2, wheelRadius: 0.34, axles: [1.45, -1.4], profiles: { normal: 0.15, fast: 0.6, veryFast: 0.25 }, paints: [0x1d1f22, 0xf2f2f0, 0x6b6f75, 0x1f3354, 0xb02020, 0x9aa3ab, 0x2a4f8a] },
  van: { label: 'Van', shape: 'van', heavy: false, length: 5.3, width: 2.0, height: 2.45, mass: 2600, accel: 1.2, comfortBrake: 2.2, maxLane: 2, wheelRadius: 0.36, axles: [1.75, -1.65], profiles: { slow: 0.45, normal: 0.55 }, paints: [0xf2f2f0, 0xf2f2f0, 0xc8ccd0, 0x6b6f75, 0x1f3354, 0xd0a020] },
  truck: { label: 'Tır', shape: 'truck', heavy: true, length: 16.5, width: 2.55, height: 3.9, mass: 18000, accel: 0.55, comfortBrake: 1.6, maxLane: 1, wheelRadius: 0.5, axles: [6.4, 3.0, -4.2, -5.6, -7.0], profiles: { truck: 1 }, paints: [0xf2f2f0, 0x1f3354, 0x8a1f1f, 0x2e5d34, 0xd8d4c8, 0x6b6f75] },
  // Orchids Simulator Traffic Car Pack (Oren garage, CC BY 4.0): one class per vehicle.
  ...(Object.fromEntries(MODEL_IDS.map((id) => [id, modelled(id)])) as Record<TrafficModelId, TrafficClass>),
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

/** Share of each kind per variety setting; a kind's share is split evenly between its models. */
const KIND_MIX: Record<TrafficVariety, Partial<Record<TrafficKind, number>>> = {
  mixed: { car: 0.5, suv: 0.12, pickup: 0.08, van: 0.12, police: 0.04, lightTruck: 0.07, truck: 0.04, bus: 0.03 },
  carsOnly: { car: 0.7, suv: 0.15, pickup: 0.07, van: 0.05, police: 0.03 },
  heavy: { car: 0.3, suv: 0.08, pickup: 0.08, van: 0.14, police: 0.03, lightTruck: 0.15, truck: 0.12, bus: 0.1 },
};

function mix(shares: Partial<Record<TrafficKind, number>>): Partial<Record<TrafficClassId, number>> {
  const out: Partial<Record<TrafficClassId, number>> = {};
  for (const [kind, share] of Object.entries(shares) as [TrafficKind, number][]) {
    const ids = MODEL_IDS.filter((id) => kindOf(id) === kind);
    for (const id of ids) out[id] = share / ids.length;
  }
  return out;
}

/**
 * Class mix per variety setting (weights). Only the modelled vehicles are spawned; the built-in low-poly
 * classes (car, fastCar, van, truck) stay defined as fallbacks / for the headless tests but never appear in the game.
 */
export const TRAFFIC_VARIETY: Record<TrafficVariety, Partial<Record<TrafficClassId, number>>> = {
  mixed: mix(KIND_MIX.mixed),
  carsOnly: mix(KIND_MIX.carsOnly),
  heavy: mix(KIND_MIX.heavy),
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

/**
 * City V2 traffic (src/traffic/city): the same vehicles and models, town
 * drivers (wanted speed a share of each road's limit), a smaller bubble and
 * counts per density setting. Long lorries stay out of town except with the
 * "heavy" variety.
 */
export const CITY_TRAFFIC = {
  /** Vehicles at once per density setting. */
  count: { low: 30, medium: 60, high: 90, veryHigh: 120 } as Record<Exclude<TrafficDensity, 'off'>, number>,
  /** New vehicles appear between these distances from the player, m (closer only behind the player), and leave beyond `despawn`. */
  spawnMin: 170,
  spawnBehindMin: 70,
  spawnMax: 380,
  despawn: 430,
  /** Distance tiers, m: near vehicles get a collision body and decide every step. */
  nearRange: 80,
  mediumRange: 250,
  /** Physics steps between decisions per tier. */
  decisionEvery: { near: 1, medium: 2, far: 4 },
  bodyPool: 20,
  /** Driver's wanted speed as a share of the limit, and time gap kept, s (each driver picks one in the band). */
  speedShare: [0.88, 1.08] as const,
  headway: [1.1, 1.7] as const,
  /** Bumper-to-bumper gap when stopped, m. */
  minGap: 2.2,
  /** Time gaps to vehicles with priority that a driver needs before entering a junction, s. */
  gapStop: 5,
  gapYield: 4,
  gapLeft: 4.5,
  gapRight: 3,
  /** After waiting this long at an uncontrolled junction a driver only waits for the junction box to clear, s. */
  impatience: 6,
  /** Room needed on the exit lane before entering a junction, m (beyond the vehicle's own length). */
  exitRoom: 2.5,
  /** A vehicle waiting longer than this is gridlocked and removed once out of sight, s. */
  stuck: 60,
} as const;

/**
 * Models used in town: a short list keeps the draw calls down (each model drawn is one or two instanced meshes, and
 * their shadows), common cars first, one bus and one small lorry.
 */
export const CITY_MODELS: readonly TrafficModelId[] = ['sedan_grey', 'sedan_silver', 'sedan_red', 'sedan_white_old', 'sedan_green', 'hatch_blue', 'hatch_red', 'suv_black', 'offroad_white', 'van_white', 'pickup_white', 'citybus', 'box_truck_small'];

/** City class mix: the variety's mix over the town's models (the long lorries only with the heavy variety). */
export function cityVariety(v: TrafficVariety): Partial<Record<TrafficClassId, number>> {
  const ids: readonly TrafficClassId[] = v === 'heavy' ? [...CITY_MODELS, 'lorry_box'] : CITY_MODELS;
  const out: Partial<Record<TrafficClassId, number>> = {};
  for (const id of ids) {
    // Each kind's share in this variety, split over the town's models of that kind.
    const kind = kindOf(id as TrafficModelId);
    const same = ids.filter((o) => kindOf(o as TrafficModelId) === kind).length;
    const share = KIND_MIX[v][kind] ?? 0;
    if (share > 0) out[id] = share / same;
  }
  return out;
}
