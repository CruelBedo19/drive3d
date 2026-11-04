import type { VehicleDefinition } from '../vehicleTypes';
import { placeholderStreet } from './placeholderStreet';
import { assetUrl } from '../../core/assetUrl';

/**
 * Pipeline test car: placeholder physics with a generated, unbranded glTF model
 * (scripts/make-test-model.ts). Its node names deliberately differ from the
 * logical names to exercise the mapping.
 */
export const testGltfCar: VehicleDefinition = {
  physics: { ...placeholderStreet.physics, id: 'test-gltf', name: 'glTF Test Car' },
  visual: {
    kind: 'gltf',
    bodyColor: 0x2f6fd2,
    model: {
      url: assetUrl('/assets/vehicles/test-car/test-car.glb'),
      nodes: {
        body: 'Chassis',
        wheelFL: ['Wheel_Front_L', 'wheel_FL'],
        wheelFR: ['Wheel_Front_R', 'wheel_FR'],
        wheelRL: ['Wheel_Rear_L', 'wheel_RL'],
        wheelRR: ['Wheel_Rear_R', 'wheel_RR'],
        steeringWheel: 'SteeringWheel',
        headlights: ['Lamp_Head_L', 'Lamp_Head_R'],
        brakeLights: ['Lamp_Brake_L', 'Lamp_Brake_R'],
        reverseLights: ['Lamp_Reverse'],
      },
      scale: 1,
      rotationYDeg: 0,
      offset: { x: 0, y: 0, z: 0 },
      wheelPlacement: 'model',
      steeringWheelAxis: 'z',
      steeringWheelMaxDeg: 270,
    },
  },
};
