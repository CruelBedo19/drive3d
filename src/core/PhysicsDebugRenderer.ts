import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';

/**
 * Draws Rapier's collider wireframes (F4, dev only), to check that visuals
 * and colliders line up. Reuses one buffer, regrown only when it is too small.
 */
export class PhysicsDebugRenderer {
  readonly lines: THREE.LineSegments;
  enabled = false;

  private readonly world: World;
  private readonly geometry = new THREE.BufferGeometry();
  private capacity = 0;
  private position: THREE.BufferAttribute | null = null;
  private color: THREE.BufferAttribute | null = null;

  constructor(world: World, scene: THREE.Scene) {
    this.world = world;
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.8 });
    this.lines = new THREE.LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  toggle(): void {
    this.enabled = !this.enabled;
    this.lines.visible = this.enabled;
  }

  update(): void {
    if (!this.enabled) return;
    const { vertices, colors } = this.world.debugRender();
    const count = vertices.length / 3;
    if (count > this.capacity) {
      this.capacity = Math.ceil(count * 1.5);
      this.position = new THREE.BufferAttribute(new Float32Array(this.capacity * 3), 3);
      this.color = new THREE.BufferAttribute(new Float32Array(this.capacity * 4), 4);
      this.position.setUsage(THREE.DynamicDrawUsage);
      this.color.setUsage(THREE.DynamicDrawUsage);
      this.geometry.setAttribute('position', this.position);
      this.geometry.setAttribute('color', this.color);
    }
    if (!this.position || !this.color) return;
    (this.position.array as Float32Array).set(vertices);
    (this.color.array as Float32Array).set(colors);
    this.position.needsUpdate = true;
    this.color.needsUpdate = true;
    this.geometry.setDrawRange(0, count);
  }

  dispose(): void {
    this.lines.removeFromParent();
    this.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}
