import { SETUPS, applySetup, type SetupId } from './setups';
import type { VehicleConfig, VehicleDefinition } from './vehicleTypes';
import { placeholderStreet } from './vehicles/placeholderStreet';
import { testGltfCar } from './vehicles/testGltfCar';

/**
 * Selectable cars (garage, car confirm, ?car=). Data only: a real car is one
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
  description: string;
}

/** Slot 3 placeholder: the test car's physics with its own colour until the real car arrives. */
const slot3Definition: VehicleDefinition = {
  physics: { ...placeholderStreet.physics, id: 'car_03', name: 'Slot 3' },
  visual: { ...placeholderStreet.visual, bodyColor: 0xd9d9d9 },
};

export const CAR_REGISTRY: readonly CarEntry[] = [
  {
    id: 'car_01',
    aliases: ['placeholder'],
    brand: 'Drive3D',
    model: 'Test Car',
    year: null,
    definition: placeholderStreet,
    defaultSetup: 'STREET',
    placeholder: true,
    description: 'Dengeli arkadan itişli test aracı. Handling ayarlarının referansı.',
  },
  {
    id: 'car_02',
    aliases: ['test-gltf'],
    brand: 'Drive3D',
    model: 'glTF Test Car',
    year: null,
    definition: testGltfCar,
    defaultSetup: 'STREET',
    placeholder: true,
    description: 'GLB yükleme ve node eşleme hattının test modeli (aynı fizik).',
  },
  {
    id: 'car_03',
    brand: 'Boş slot',
    model: 'Araç 3',
    year: null,
    definition: slot3Definition,
    defaultSetup: 'STREET',
    placeholder: true,
    description: 'Gerçek araç modeli eklenene kadar yer tutucu.',
  },
];

export const DEFAULT_CAR_ID = 'car_01';

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
