import type { VehicleDefinition } from '../vehicleTypes';
import { placeholderStreet } from './placeholderStreet';
import { testGltfCar } from './testGltfCar';

/** All drivable cars by id. New cars: add a file in this folder and register it here. */
export const VEHICLES: Record<string, VehicleDefinition> = {
  placeholder: placeholderStreet,
  'test-gltf': testGltfCar,
};

export const DEFAULT_VEHICLE = 'placeholder';
