import type { Drivetrain } from '../vehicleTypes';

/**
 * Factory data of the selectable cars (manufacturer figures; the few that are
 * not published are marked "est." and chosen to match published performance).
 * Masses are EU kerb weights (driver included, 75 kg); race cars at their
 * minimum weight plus a driver. fittedCar() turns these into a physics config
 * on top of each model's own measurements (carFits.json).
 */
export interface RealCarSpec {
  massKg: number;
  /** Share of the weight on the front axle. */
  frontWeight: number;
  drivetrain: Drivetrain;
  /** AWD: share of the torque sent to the front axle. */
  awdFrontSplit?: number;
  engine: {
    /** Short description for the garage, e.g. "4.0 V8". */
    label: string;
    powerKw: number;
    /** Rpm of peak power (the end of its plateau). */
    powerRpm: number;
    torqueNm: number;
    /** Rpm band of peak torque. */
    torqueRpm: readonly [number, number];
    idleRpm: number;
    redlineRpm: number;
    /** Forced induction (or electric help): a flat torque plateau instead of a peak. */
    boosted: boolean;
  };
  gearbox: {
    kind: 'manual' | 'dct' | 'automatic' | 'sequential';
    ratios: readonly number[];
    finalDrive: number;
    reverse: number;
  };
  /** Speed limiter on public roads, and the car's top speed without it (Autobahn), km/h. */
  limiterKmh: number;
  vmaxKmh: number;
  /** Drag coefficient and frontal area, m². */
  cd: number;
  frontalArea: number;
  /** Downforce, N / (m/s)² (race aero, wings). */
  downforce: number;
  /** Real tyre rolling radius (rear), m: gear speeds are kept true on the model's own wheels. */
  tyreRadius: number;
  tyre: 'touring' | 'road' | 'sport' | 'cup' | 'slick' | 'classic';
  /** Ride / chassis character. */
  chassis: 'comfort' | 'sport' | 'race' | 'offroad';
  /** Centre of mass: low (mid-engine, race), normal, high (SUV). */
  cog: 'low' | 'normal' | 'high';
  /**
   * DRIFT setup rear grip: the value that held a keyboard drift best on average (entries at 50 / 60 / 70 km/h,
   * both directions) in a sweep of 0.90-1.10; see setups/index.ts driftPack.
   */
  driftRearGrip?: number;
}

export const REAL_SPECS: Record<string, RealCarSpec> = {
  bmw_m3_e92: {
    massKg: 1655,
    frontWeight: 0.52,
    drivetrain: 'RWD',
    engine: { label: '4.0 V8 (S65)', powerKw: 309, powerRpm: 8300, torqueNm: 400, torqueRpm: [3900, 3900], idleRpm: 800, redlineRpm: 8400, boosted: false },
    gearbox: { kind: 'manual', ratios: [4.055, 2.396, 1.582, 1.192, 1.0, 0.872], finalDrive: 3.846, reverse: 3.68 },
    limiterKmh: 250,
    vmaxKmh: 290,
    cd: 0.31,
    frontalArea: 2.12,
    downforce: 0.25,
    tyreRadius: 0.333,
    tyre: 'sport',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 1.02,
  },
  bmw_m4_f82: {
    massKg: 1612,
    frontWeight: 0.52,
    drivetrain: 'RWD',
    engine: { label: '3.0 I6 biturbo (S55)', powerKw: 317, powerRpm: 7300, torqueNm: 550, torqueRpm: [1850, 5500], idleRpm: 750, redlineRpm: 7600, boosted: true },
    gearbox: { kind: 'dct', ratios: [4.806, 2.593, 1.701, 1.277, 1.0, 0.844, 0.671], finalDrive: 3.462, reverse: 4.172 },
    limiterKmh: 250,
    vmaxKmh: 300,
    cd: 0.34,
    frontalArea: 2.17,
    downforce: 0.25,
    tyreRadius: 0.338,
    tyre: 'sport',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 0.90,
  },
  amg_c63s_w205: {
    massKg: 1800,
    frontWeight: 0.54,
    drivetrain: 'RWD',
    engine: { label: '4.0 V8 biturbo (M177)', powerKw: 375, powerRpm: 6250, torqueNm: 700, torqueRpm: [2000, 4500], idleRpm: 700, redlineRpm: 7000, boosted: true },
    gearbox: { kind: 'automatic', ratios: [4.377, 2.859, 1.921, 1.368, 1.0, 0.82, 0.728], finalDrive: 2.82, reverse: 3.416 },
    limiterKmh: 290,
    vmaxKmh: 300,
    cd: 0.32,
    frontalArea: 2.2,
    downforce: 0.25,
    tyreRadius: 0.34,
    tyre: 'sport',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 0.90,
  },
  amg_one: {
    // 1.6 V6 turbo hybrid with four electric motors (two driving the front axle): 782 kW combined.
    // Combined torque is not published (est. 800 Nm); gear ratios est. Quicker here than the published 0-100 2.9 s / 0-200 7.0 s.
    massKg: 1770,
    frontWeight: 0.42,
    drivetrain: 'AWD',
    awdFrontSplit: 0.25,
    engine: { label: '1.6 V6 turbo hybrid', powerKw: 782, powerRpm: 9000, torqueNm: 800, torqueRpm: [2500, 7000], idleRpm: 1200, redlineRpm: 11000, boosted: true },
    gearbox: { kind: 'sequential', ratios: [3.0, 2.2, 1.75, 1.45, 1.23, 1.08, 0.97], finalDrive: 4.25, reverse: 3.2 },
    limiterKmh: 352,
    vmaxKmh: 352,
    cd: 0.4,
    frontalArea: 1.85,
    downforce: 1.3,
    tyreRadius: 0.355,
    tyre: 'cup',
    chassis: 'race',
    cog: 'low',
    driftRearGrip: 1.06,
  },
  porsche_911_gt3_rsr: {
    // 4.2 flat-six (power as balanced for racing, ~515 PS); sequential 6-speed ratios est.
    massKg: 1320,
    frontWeight: 0.42,
    drivetrain: 'RWD',
    engine: { label: '4.2 boxer altı', powerKw: 379, powerRpm: 8400, torqueNm: 465, torqueRpm: [6000, 7500], idleRpm: 1500, redlineRpm: 9400, boosted: false },
    gearbox: { kind: 'sequential', ratios: [3.1, 2.25, 1.8, 1.5, 1.27, 1.1], finalDrive: 3.7, reverse: 3.2 },
    limiterKmh: 300,
    vmaxKmh: 300,
    cd: 0.45,
    frontalArea: 1.9,
    downforce: 1.4,
    tyreRadius: 0.355,
    tyre: 'slick',
    chassis: 'race',
    cog: 'low',
    driftRearGrip: 1.10,
  },
  audi_rs6_c8: {
    massKg: 2150,
    frontWeight: 0.57,
    drivetrain: 'AWD',
    awdFrontSplit: 0.4,
    engine: { label: '4.0 V8 biturbo', powerKw: 441, powerRpm: 6250, torqueNm: 800, torqueRpm: [2050, 4500], idleRpm: 650, redlineRpm: 6800, boosted: true },
    gearbox: { kind: 'automatic', ratios: [4.714, 3.143, 2.106, 1.667, 1.285, 1.0, 0.839, 0.667], finalDrive: 3.204, reverse: 3.317 },
    limiterKmh: 250,
    vmaxKmh: 305,
    cd: 0.34,
    frontalArea: 2.43,
    downforce: 0.2,
    tyreRadius: 0.365,
    tyre: 'sport',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 0.98,
  },
  bmw_m3_e36: {
    massKg: 1535,
    frontWeight: 0.5,
    drivetrain: 'RWD',
    engine: { label: '3.0 I6 (S50)', powerKw: 210, powerRpm: 7000, torqueNm: 320, torqueRpm: [3600, 3600], idleRpm: 850, redlineRpm: 7280, boosted: false },
    gearbox: { kind: 'manual', ratios: [4.2, 2.49, 1.66, 1.24, 1.0], finalDrive: 3.15, reverse: 3.85 },
    limiterKmh: 250,
    vmaxKmh: 280,
    cd: 0.33,
    frontalArea: 1.95,
    downforce: 0.2,
    tyreRadius: 0.314,
    tyre: 'road',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 0.94,
  },
  bmw_m3_g81: {
    massKg: 1940,
    frontWeight: 0.53,
    drivetrain: 'AWD',
    awdFrontSplit: 0.3,
    engine: { label: '3.0 I6 biturbo (S58)', powerKw: 375, powerRpm: 6250, torqueNm: 650, torqueRpm: [2750, 5500], idleRpm: 700, redlineRpm: 7200, boosted: true },
    gearbox: { kind: 'automatic', ratios: [5.0, 3.2, 2.143, 1.72, 1.313, 1.0, 0.823, 0.64], finalDrive: 3.154, reverse: 3.456 },
    limiterKmh: 280,
    vmaxKmh: 290,
    cd: 0.31,
    frontalArea: 2.3,
    downforce: 0.2,
    tyreRadius: 0.34,
    tyre: 'sport',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 1.06,
  },
  ferrari_f40: {
    // Gear ratios est. (5-speed manual, 324 km/h at the red line in 5th).
    massKg: 1325,
    frontWeight: 0.42,
    drivetrain: 'RWD',
    engine: { label: '2.9 V8 biturbo', powerKw: 352, powerRpm: 7000, torqueNm: 577, torqueRpm: [4000, 4500], idleRpm: 1000, redlineRpm: 7750, boosted: true },
    gearbox: { kind: 'manual', ratios: [3.08, 2.04, 1.53, 1.21, 0.97], finalDrive: 3.07, reverse: 3.1 },
    limiterKmh: 324,
    vmaxKmh: 324,
    cd: 0.34,
    frontalArea: 1.75,
    downforce: 0.4,
    tyreRadius: 0.333,
    tyre: 'classic',
    chassis: 'race',
    cog: 'low',
    driftRearGrip: 1.06,
  },
  honda_civic_ek9: {
    massKg: 1110,
    frontWeight: 0.62,
    drivetrain: 'FWD',
    engine: { label: '1.6 I4 VTEC (B16B)', powerKw: 136, powerRpm: 8200, torqueNm: 160, torqueRpm: [7500, 7500], idleRpm: 900, redlineRpm: 8400, boosted: false },
    gearbox: { kind: 'manual', ratios: [3.23, 2.105, 1.458, 1.107, 0.848], finalDrive: 4.4, reverse: 3.0 },
    // No limiter: top speed is where drag meets power (~230 km/h).
    limiterKmh: 240,
    vmaxKmh: 240,
    cd: 0.33,
    frontalArea: 1.9,
    downforce: 0.15,
    tyreRadius: 0.298,
    tyre: 'road',
    chassis: 'sport',
    cog: 'normal',
    driftRearGrip: 0.90,
  },
  honda_nsx: {
    massKg: 1440,
    frontWeight: 0.42,
    drivetrain: 'RWD',
    engine: { label: '3.0 V6 VTEC (C30A)', powerKw: 206, powerRpm: 7300, torqueNm: 294, torqueRpm: [5400, 5400], idleRpm: 800, redlineRpm: 8000, boosted: false },
    gearbox: { kind: 'manual', ratios: [3.066, 1.956, 1.428, 1.125, 0.896], finalDrive: 4.062, reverse: 2.9 },
    limiterKmh: 270,
    vmaxKmh: 270,
    cd: 0.32,
    frontalArea: 1.8,
    downforce: 0.2,
    tyreRadius: 0.316,
    tyre: 'classic',
    chassis: 'sport',
    cog: 'low',
    driftRearGrip: 1.06,
  },
  brabus_g900: {
    // Brabus 900 on the G 63: 4.5 V8 biturbo, 662 kW, 1250 Nm.
    massKg: 2560,
    frontWeight: 0.52,
    drivetrain: 'AWD',
    awdFrontSplit: 0.4,
    engine: { label: '4.5 V8 biturbo (Brabus)', powerKw: 662, powerRpm: 6600, torqueNm: 1250, torqueRpm: [2900, 4200], idleRpm: 700, redlineRpm: 6800, boosted: true },
    gearbox: { kind: 'automatic', ratios: [5.354, 3.243, 2.252, 1.636, 1.211, 1.0, 0.865, 0.717, 0.601], finalDrive: 3.69, reverse: 4.8 },
    limiterKmh: 280,
    vmaxKmh: 280,
    cd: 0.54,
    frontalArea: 3.05,
    downforce: 0.05,
    tyreRadius: 0.397,
    tyre: 'touring',
    chassis: 'offroad',
    cog: 'high',
    driftRearGrip: 0.90,
  },
  maybach_gls600: {
    massKg: 2785,
    frontWeight: 0.52,
    drivetrain: 'AWD',
    awdFrontSplit: 0.45,
    engine: { label: '4.0 V8 biturbo + EQ Boost', powerKw: 410, powerRpm: 6500, torqueNm: 730, torqueRpm: [2500, 4500], idleRpm: 600, redlineRpm: 6500, boosted: true },
    gearbox: { kind: 'automatic', ratios: [5.354, 3.243, 2.252, 1.636, 1.211, 1.0, 0.865, 0.717, 0.601], finalDrive: 3.07, reverse: 4.8 },
    limiterKmh: 250,
    vmaxKmh: 250,
    cd: 0.32,
    frontalArea: 2.95,
    downforce: 0.05,
    tyreRadius: 0.4,
    tyre: 'touring',
    chassis: 'comfort',
    cog: 'high',
    driftRearGrip: 0.98,
  },
};
