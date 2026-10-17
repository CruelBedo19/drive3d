import * as THREE from 'three';

const DROPS = 4500;
const BOX = { x: 70, y: 32, z: 70 };
const FALL_SPEED = 19;
const STREAK = 0.45;

/**
 * Rain streaks in a box that follows the camera. One LineSegments draw call;
 * positions move on the CPU (4.5k drops ≈ 27k floats per frame) and wrap in
 * the box, so no allocation after construction.
 */
export class Rain {
  readonly object: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly offsets: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.LineBasicMaterial;

  constructor() {
    this.positions = new Float32Array(DROPS * 6);
    this.offsets = new Float32Array(DROPS * 3);
    for (let i = 0; i < DROPS; i++) {
      this.offsets[i * 3] = (Math.random() - 0.5) * BOX.x;
      this.offsets[i * 3 + 1] = Math.random() * BOX.y;
      this.offsets[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
    }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.LineBasicMaterial({ color: 0xc4ccd6, transparent: true, opacity: 0.45, depthWrite: false, fog: true });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 5;
  }

  /** `intensity` 0..1 sets how many drops are drawn. */
  update(dt: number, centre: THREE.Vector3, intensity: number): void {
    this.object.visible = intensity > 0.01;
    if (!this.object.visible) return;
    const count = Math.floor(DROPS * intensity);
    const o = this.offsets;
    const p = this.positions;
    const fall = FALL_SPEED * dt;
    const baseY = centre.y - BOX.y * 0.35;
    for (let i = 0; i < count; i++) {
      let y = o[i * 3 + 1] - fall;
      if (y < 0) y += BOX.y;
      o[i * 3 + 1] = y;
      // Drops are placed relative to a grid snapped around the camera so they don't slide with it.
      const x = wrap(o[i * 3] - centre.x, BOX.x) + centre.x;
      const z = wrap(o[i * 3 + 2] - centre.z, BOX.z) + centre.z;
      const k = i * 6;
      p[k] = x;
      p[k + 1] = baseY + y;
      p[k + 2] = z;
      p[k + 3] = x + 0.04;
      p[k + 4] = baseY + y + STREAK;
      p[k + 5] = z;
    }
    this.geometry.setDrawRange(0, count * 2);
    (this.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}

/** Wraps v into [-size/2, size/2). */
function wrap(v: number, size: number): number {
  return ((((v + size / 2) % size) + size) % size) - size / 2;
}
