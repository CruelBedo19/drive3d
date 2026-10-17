import { SETUPS, applySetup, type SetupId } from './setups';
import type { VehicleConfig, VehicleDefinition } from './vehicleTypes';
import { fittedCar } from './vehicles/fittedCar';

/**
 * Selectable cars (garage, car confirm, ?car=). The test cars (placeholderStreet,
 * testGltfCar) are not listed: they stay in config/vehicles/ for the headless tests only. Data only: a real car is one
 * entry here plus its VehicleDefinition file in config/vehicles/ (physics +
 * GLB path, wheel / light node mappings, hood camera). Not limited to three:
 * the garage shows whatever is listed.
 *
 * Specs shown in the garage (power, torque, mass, drivetrain, top speed,
 * wheelbase, track, wheel radius, dimensions) are read from the physics
 * config, never typed twice.
 */
export interface CarEntry {
  id: string;
  /** Older ids that still resolve to this car (?car=placeholder). */
  aliases?: readonly string[];
  brand: string;
  model: string;
  year: number | null;
  /** Image URL for menus; when missing the UI draws a placeholder. */
  thumbnail?: string;
  /** Physics + visual (GLB path, node mappings) definition. */
  definition: VehicleDefinition;
  /** Setup the car starts with. */
  defaultSetup: SetupId;
  /** True while the slot uses a stand-in model / data, waiting for the real car. */
  placeholder: boolean;
  /** True while the car drives on the test car's handling (only its dimensions are its own). */
  testPhysics?: boolean;
  description: string;
  /** Model credit (CC-BY attribution), shown in the garage and listed in CREDITS.md. */
  credit?: string;
}

const real = (id: string, brand: string, model: string, year: number, color: number, credit: string, description: string, extras: { headlights?: boolean; brakeLights?: boolean; steeringWheel?: boolean } = {}): CarEntry => ({
  id,
  brand,
  model,
  year,
  definition: fittedCar({ id, name: `${brand} ${model}`, bodyColor: color, ...extras }),
  defaultSetup: 'STREET',
  placeholder: false,
  testPhysics: true,
  description,
  credit,
});

export const CAR_REGISTRY: readonly CarEntry[] = [
  real('bmw_m3_e92', 'BMW', 'M3 (E92)', 2008, 0x1d3f8a, 'Galaxy Car Showroom · CC BY 4.0', 'V8 atmosferik coupé.', { headlights: true, brakeLights: true, steeringWheel: true }),
  real('bmw_m4_f82', 'BMW', 'M4 (F82)', 2014, 0x2a5fb0, 'Galaxy Car Showroom · CC BY 4.0', 'Çift turbo sıralı altı coupé.'),
  real('amg_c63s_w205', 'Mercedes-AMG', 'C 63 S Coupé (W205)', 2017, 0x9a9a9a, 'GT Cars: Hyperspeed · CC BY 4.0', 'V8 biturbo coupé.', { headlights: true, brakeLights: true }),
  real('amg_one', 'Mercedes-AMG', 'ONE', 2022, 0xb8b8b8, '3dblender_1 · CC BY 4.0', 'F1 kökenli hibrit hiper otomobil.', { brakeLights: true }),
];

export const DEFAULT_CAR_ID = 'bmw_m3_e92';

/** Registry id or alias → entry. */
export function findCar(id: string | null | undefined): CarEntry | undefined {
  if (!id) return undefined;
  return CAR_REGISTRY.find((c) => c.id === id || c.aliases?.includes(id));
}

export function getCar(id: string | null | undefined): CarEntry {
  return findCar(id) ?? (findCar(DEFAULT_CAR_ID) as CarEntry);
}

export interface CarSpecs {
  powerKw: number;
  powerPs: number;
  torqueNm: number;
  massKg: number;
  drivetrain: string;
  maxSpeedKmh: number;
  wheelbaseM: number;
  trackFrontM: number;
  trackRearM: number;
  wheelRadiusM: number;
  /** Body length × width × height, m. */
  dimensions: [number, number, number];
}

export function carSpecs(physics: VehicleConfig): CarSpecs {
  const c = physics.chassis;
  return {
    powerKw: physics.engine.maxPowerKw,
    powerPs: Math.round(physics.engine.maxPowerKw * 1.35962),
    torqueNm: physics.engine.peakTorqueNm,
    massKg: c.mass,
    drivetrain: physics.drivetrain,
    maxSpeedKmh: physics.maxSpeedKmh,
    wheelbaseM: physics.front.z - physics.rear.z,
    trackFrontM: physics.front.halfTrack * 2,
    trackRearM: physics.rear.halfTrack * 2,
    wheelRadiusM: physics.wheel.radius,
    dimensions: [c.halfExtents.z * 2, c.halfExtents.x * 2, (c.halfExtents.y + c.cabinHalfExtents.y) * 2 + physics.wheel.radius],
  };
}

/** 0..100 bars for the garage, from the car's config with its setup applied. */
export interface CarRatings {
  speed: number;
  acceleration: number;
  handling: number;
  braking: number;
}

export function carRatings(entry: CarEntry, setup: SetupId = entry.defaultSetup): CarRatings {
  const p = applySetup(entry.definition.physics, SETUPS[setup]);
  const scale = (v: number, lo: number, hi: number) => Math.round(Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100)));
  const kwPerTonne = p.engine.maxPowerKw / (p.chassis.mass / 1000);
  const grip = p.tires.friction * ((p.front.grip + p.rear.grip) / 2) + p.chassis.downforce * 0.03;
  const decel = p.brakes.maxForce / p.chassis.mass;
  return {
    speed: scale(p.maxSpeedKmh, 150, 350),
    acceleration: scale(kwPerTonne, 60, 400),
    handling: scale(grip, 0.8, 1.6),
    braking: scale(decel, 6, 16),
  };
}

/** Problems with registry entries (empty when everything is usable). */
export function validateRegistry(entries: readonly CarEntry[] = CAR_REGISTRY): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of entries) {
    for (const id of [e.id, ...(e.aliases ?? [])]) {
      if (ids.has(id)) errors.push(`${e.id}: duplicate id or alias "${id}"`);
      ids.add(id);
    }
    if (!e.brand || !e.model) errors.push(`${e.id}: brand and model are required`);
    if (!(e.defaultSetup in SETUPS)) errors.push(`${e.id}: unknown setup ${e.defaultSetup}`);
    const p = e.definition.physics;
    if (!(p.chassis.mass > 0) || !(p.engine.maxPowerKw > 0) || !(p.wheel.radius > 0) || !(p.front.z > p.rear.z)) errors.push(`${e.id}: physics config incomplete`);
    const v = e.definition.visual;
    if (v.kind === 'gltf') {
      const m = v.model;
      if (!m?.url) errors.push(`${e.id}: glTF visual without model url`);
      else for (const w of ['wheelFL', 'wheelFR', 'wheelRL', 'wheelRR'] as const) if (!m.nodes[w]) errors.push(`${e.id}: missing wheel node mapping ${w}`);
    }
  }
  return errors;
}
