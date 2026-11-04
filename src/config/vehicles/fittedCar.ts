import { VehiclePhysics } from '../../vehicle/physics/VehiclePhysics';
import type { VehicleConfig, VehicleDefinition, VehicleNodeMap } from '../vehicleTypes';
import carFits from './carFits.json';
import { placeholderStreet } from './placeholderStreet';
import { realPhysics } from './realPhysics';
import { REAL_SPECS } from './realSpecs';
import { assetUrl } from '../../core/assetUrl';

/** Measurements of a prepared model (scripts/prepare-cars.ts → carFits.json). */
export interface CarFit {
  wheelRadius: number;
  wheelWidth: number;
  wheelbase: number;
  frontZ: number;
  rearZ: number;
  frontHalfTrack: number;
  rearHalfTrack: number;
  length: number;
  width: number;
  height: number;
  minY: number;
}

export interface FittedCarOptions {
  /** Prepared model id: public/assets/vehicles/<id>/<id>.glb and its carFits.json entry. */
  id: string;
  name: string;
  bodyColor: number;
  /** Lamp groups the prepared model has (HeadLights / TailLights). */
  headlights?: boolean;
  brakeLights?: boolean;
  steeringWheel?: boolean;
}

/** Same front / rear axle split around the body origin as the test car (front 1.35, rear -1.30). */
const FRONT_SHARE = 1.35 / 2.65;

/**
 * A real car model: the dimensions come from the model (wheelbase, track, wheel
 * size, body size) so the wheels sit in the arches and the car collides with
 * its real shape; mass, weight split, engine, gearbox, drivetrain, aero, tyres,
 * brakes and springs from its factory data (realSpecs.ts → realPhysics.ts).
 * The handling model's own values (tyre curves, steering, assists) are the test
 * car's. A car without factory data drives entirely on the test car's physics.
 */
export function fittedCar(o: FittedCarOptions): VehicleDefinition {
  const fit = (carFits as Record<string, CarFit>)[o.id];
  if (!fit) throw new Error(`no carFits.json entry for ${o.id}: run npm run prepare:cars`);
  const base = placeholderStreet.physics;
  const frontZ = fit.wheelbase * FRONT_SHARE;
  const fitted: VehicleConfig = {
    ...base,
    id: o.id,
    name: o.name,
    chassis: {
      ...base.chassis,
      halfExtents: { x: fit.width * 0.44, y: base.chassis.halfExtents.y, z: fit.length * 0.48 },
      cabinHalfExtents: { x: fit.width * 0.37, y: base.chassis.cabinHalfExtents.y, z: fit.length * 0.235 },
    },
    front: { ...base.front, z: frontZ, halfTrack: fit.frontHalfTrack },
    rear: { ...base.rear, z: frontZ - fit.wheelbase, halfTrack: fit.rearHalfTrack },
    wheel: { ...base.wheel, radius: fit.wheelRadius, width: fit.wheelWidth },
  };
  const spec = REAL_SPECS[o.id];
  const physics = spec ? realPhysics(fitted, spec) : fitted;
  const rest = VehiclePhysics.restHeight(physics);
  const nodes: VehicleNodeMap = {
    body: 'Body',
    wheelFL: 'WheelFL',
    wheelFR: 'WheelFR',
    wheelRL: 'WheelRL',
    wheelRR: 'WheelRR',
  };
  if (o.headlights) nodes.headlights = 'HeadLights';
  if (o.brakeLights) nodes.brakeLights = 'TailLights';
  if (o.steeringWheel) nodes.steeringWheel = 'SteeringWheel';
  return {
    physics,
    visual: {
      kind: 'gltf',
      bodyColor: o.bodyColor,
      model: {
        url: assetUrl(`/assets/vehicles/${o.id}/${o.id}.glb`),
        nodes,
        scale: 1,
        rotationYDeg: 0,
        // The prepared model has its ground at y = 0 and its axles at ±wheelbase / 2.
        offset: { x: 0, y: -rest, z: frontZ - fit.frontZ },
        wheelPlacement: 'model',
        steeringWheelAxis: 'z',
        steeringWheelMaxDeg: 270,
        hoodCamera: { x: 0, y: fit.height * 0.8 - rest, z: fit.wheelbase * 0.25 },
      },
    },
  };
}
