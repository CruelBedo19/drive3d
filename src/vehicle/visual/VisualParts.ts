import * as THREE from 'three';
import type { WheelPose } from './VehicleVisual';

/**
 * Steer pivot -> spin node -> wheel geometry. Shared by the placeholder and
 * glTF visuals so both apply physics wheel data the same way.
 */
export class WheelRig {
  readonly pivot = new THREE.Object3D();
  readonly spinner = new THREE.Object3D();
  /** Wheel centre at static ride height, in the visual root frame. */
  readonly restPosition = new THREE.Vector3();
  /**
   * 'physics': the wheel goes exactly where the physics wheel is.
   * 'model': keep the model's x / z, add suspension travel to its rest height.
   */
  placement: 'physics' | 'model';

  constructor(placement: 'physics' | 'model') {
    this.placement = placement;
    this.pivot.add(this.spinner);
  }

  apply(pose: WheelPose): void {
    if (this.placement === 'physics') {
      this.pivot.position.copy(pose.position);
    } else {
      this.pivot.position.copy(this.restPosition);
      this.pivot.position.y += pose.suspensionOffset;
    }
    this.pivot.rotation.y = pose.steerAngle;
    this.spinner.rotation.x = pose.spinAngle;
  }
}

interface LampMaterial {
  material: THREE.MeshStandardMaterial;
  onColor: THREE.Color;
  onIntensity: number;
}

/**
 * A set of lamp meshes switched on / off through emissive. Materials are cloned
 * so toggling one car's brake lights never affects another car sharing them.
 */
export class LampGroup {
  private readonly lamps: LampMaterial[] = [];
  private on: boolean | null = null;
  private readonly offIntensity: number;
  /** Always light in the given colour, even where the model has its own emissive (a white lens texture). */
  private readonly forceColor: boolean;

  constructor(offIntensity = 0.05, forceColor = false) {
    this.offIntensity = offIntensity;
    this.forceColor = forceColor;
  }

  get size(): number {
    return this.lamps.length;
  }

  /** Adds every mesh under `node`. Non-standard materials are left untouched. */
  addNode(node: THREE.Object3D, fallbackColor: number): void {
    node.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const swap = (m: THREE.Material): THREE.Material => {
        if (!(m instanceof THREE.MeshStandardMaterial)) return m;
        const clone = m.clone();
        const hasEmissive = clone.emissive.getHex() !== 0;
        this.lamps.push({
          material: clone,
          onColor: hasEmissive && !this.forceColor ? clone.emissive.clone() : new THREE.Color(fallbackColor),
          onIntensity: Math.max(clone.emissiveIntensity, 1.5),
        });
        return clone;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    });
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    for (const l of this.lamps) {
      l.material.emissive.copy(l.onColor);
      l.material.emissiveIntensity = on ? l.onIntensity : this.offIntensity;
    }
  }

  dispose(): void {
    for (const l of this.lamps) l.material.dispose();
  }
}
