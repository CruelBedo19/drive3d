import type { VehicleDefinition } from '../../config/vehicleTypes';
import { GltfCarVisual } from './GltfCarVisual';
import { PlaceholderCarVisual } from './PlaceholderCarVisual';
import type { VehicleVisual } from './VehicleVisual';

/** Picks the visual implementation for a car. */
export function createVehicleVisual(def: VehicleDefinition): VehicleVisual {
  if (def.visual.kind === 'gltf' && def.visual.model) {
    return new GltfCarVisual(def.physics, def.visual);
  }
  return new PlaceholderCarVisual(def.physics, def.visual);
}
