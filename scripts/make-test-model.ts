/**
 * Generates public/assets/vehicles/test-car/test-car.glb: an unbranded test car
 * used to exercise the glTF pipeline. Node names intentionally differ from the
 * logical names (see src/config/vehicles/testGltfCar.ts). `npm run make:test-model`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// GLTFExporter reads Blobs through FileReader, which Node lacks.
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    void blob.arrayBuffer().then((b) => {
      this.result = b;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((b) => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString('base64')}`;
      this.onloadend?.();
    });
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = NodeFileReader;

const std = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.5, ...extra });

const car = new THREE.Group();
car.name = 'TestCar';

// Body: lower shell + tapered cabin, roughly matching the placeholder physics box.
const chassis = new THREE.Group();
chassis.name = 'Chassis';
const paint = std(0x2f6fd2, { metalness: 0.4, roughness: 0.35 });
const lower = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.5, 4.4), paint);
lower.position.y = 0.02;
const hood = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 1.3), paint);
hood.position.set(0, 0.32, 1.45);
const cabin = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.78, 0.46, 4, 1), std(0x2b3644, { metalness: 0.5, roughness: 0.2 }));
cabin.rotation.y = Math.PI / 4;
cabin.scale.set(1.35, 1, 1.9);
cabin.position.set(0, 0.5, -0.3);
chassis.add(lower, hood, cabin);
car.add(chassis);

// Wheels, named their own way. Each wheel has its origin away from the centre
// on purpose: the loader must pivot around the geometry centre.
const tyre = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 24);
tyre.rotateZ(Math.PI / 2);
const rim = new THREE.CylinderGeometry(0.22, 0.22, 0.25, 12);
rim.rotateZ(Math.PI / 2);
const spoke = new THREE.BoxGeometry(0.26, 0.4, 0.06);
const wheelDefs: [string, number, number][] = [
  ['Wheel_Front_L', 0.82, 1.35],
  ['Wheel_Front_R', -0.82, 1.35],
  ['Wheel_Rear_L', 0.82, -1.3],
  ['Wheel_Rear_R', -0.82, -1.3],
];
for (const [name, x, z] of wheelDefs) {
  const wheel = new THREE.Group();
  wheel.name = name;
  wheel.position.set(x, -0.155 + 0.1, z); // origin 10 cm above the wheel centre
  const offset = new THREE.Group();
  offset.position.y = -0.1;
  offset.add(new THREE.Mesh(tyre, std(0x1d1e22, { roughness: 0.9 })), new THREE.Mesh(rim, std(0xc0c6ce, { metalness: 0.8 })), new THREE.Mesh(spoke, std(0x50545a)));
  wheel.add(offset);
  car.add(wheel);
}

// Interior steering wheel (spins about its local Z).
const steering = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.025, 8, 20), std(0x111111));
steering.name = 'SteeringWheel';
steering.position.set(0.37, 0.45, 0.35);
steering.rotation.x = -0.4;
car.add(steering);

// Lamps.
const lampGeo = new THREE.BoxGeometry(0.34, 0.1, 0.04);
const lamp = (name: string, color: number, x: number, z: number) => {
  const m = new THREE.Mesh(lampGeo, std(color, { emissive: color, emissiveIntensity: 1 }));
  m.name = name;
  m.position.set(x, 0.12, z);
  car.add(m);
};
lamp('Lamp_Head_L', 0xfff2cc, 0.6, 2.21);
lamp('Lamp_Head_R', 0xfff2cc, -0.6, 2.21);
lamp('Lamp_Brake_L', 0xff2020, 0.6, -2.21);
lamp('Lamp_Brake_R', 0xff2020, -0.6, -2.21);
const rev = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 0.04), std(0xffffff, { emissive: 0xffffff, emissiveIntensity: 1 }));
rev.name = 'Lamp_Reverse';
rev.position.set(0, 0.12, -2.21);
car.add(rev);

const glb = await new GLTFExporter().parseAsync(car, { binary: true });
const dir = new URL('../public/assets/vehicles/test-car/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('test-car.glb', dir), Buffer.from(glb as ArrayBuffer));
console.log(`wrote ${new URL('test-car.glb', dir).pathname} (${(glb as ArrayBuffer).byteLength} bytes)`);
