/*
 * GPU rain adapted from the rain vertex shader of "Procedural Weather — Three.js
 * Skill" by Kingsley (MIT, https://github.com/CK42BB/procedural-weather-threejs):
 * static line segments animated entirely in the vertex shader (fall + wrap in a
 * box around the camera). Changes here: world-stable wrapping (drops don't slide
 * with the camera), streaks slanted by the car's motion, distance fade, a draw
 * range from the intensity, and brightness that follows the light.
 */
import * as THREE from 'three';

export interface RainQuality {
  /** Drops at full intensity. */
  drops: number;
}

const RADIUS = 26;
const HEIGHT = 22;
const FALL = 17;

const VERT = /* glsl */ `
attribute vec2 aSeed;   // x: fall-speed variation, y: phase
attribute float aEnd;   // 0 = head of the streak, 1 = tail
uniform float uTime;
uniform vec3 uCamera;
uniform vec3 uStreak;   // tail offset (falling direction seen from the moving car) * length
uniform float uRadius;
uniform float uHeight;
uniform float uFall;
varying float vAlpha;

void main() {
  float speed = uFall * (0.82 + aSeed.x * 0.36);
  float y = mod(position.y - uTime * speed + aSeed.y * uHeight, uHeight);
  // Columns are fixed in the world and wrapped into the box around the camera.
  vec2 rel = mod(position.xz - uCamera.xz + uRadius, 2.0 * uRadius) - uRadius;
  vec3 world = vec3(uCamera.x + rel.x, uCamera.y - uHeight * 0.4 + y, uCamera.z + rel.y);
  world += uStreak * aEnd;
  float d = length(rel);
  vAlpha = smoothstep(uRadius, uRadius * 0.55, d) * smoothstep(0.0, 2.5, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  if (vAlpha < 0.01) discard;
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
}`;

export class Rain {
  readonly object: THREE.LineSegments;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private drops = 0;
  private time = 0;
  private readonly fallDir = new THREE.Vector3();

  constructor(quality: RainQuality) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uCamera: { value: new THREE.Vector3() },
        uStreak: { value: new THREE.Vector3(0, -1, 0) },
        uRadius: { value: RADIUS },
        uHeight: { value: HEIGHT },
        uFall: { value: FALL },
        uColor: { value: new THREE.Color(0xc8d2dc) },
        uOpacity: { value: 0.4 },
      },
      transparent: true,
      depthWrite: false,
    });
    this.object = new THREE.LineSegments(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.visible = false;
    this.object.renderOrder = 5;
    this.setQuality(quality);
  }

  /** Rebuilds the (static) drop buffer for a new count. Only on settings changes. */
  setQuality(q: RainQuality): void {
    if (q.drops === this.drops) return;
    this.drops = q.drops;
    const n = q.drops;
    const pos = new Float32Array(n * 6);
    const seed = new Float32Array(n * 4);
    const end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = (Math.random() * 2 - 1) * RADIUS * 4;
      const y = Math.random() * HEIGHT;
      const z = (Math.random() * 2 - 1) * RADIUS * 4;
      const s = Math.random();
      const p = Math.random();
      pos.set([x, y, z, x, y, z], i * 6);
      seed.set([s, p, s, p], i * 4);
      end[i * 2 + 1] = 1;
    }
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 2));
    this.geometry.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    this.geometry.setDrawRange(0, 0);
  }

  /**
   * @param intensity 0..1 (sets how many drops are drawn and how long they are)
   * @param velocity car velocity (m/s): the faster you drive, the flatter the rain seems to fall
   * @param brightness 0..1 from the light level (rain is grey at night, not glowing)
   */
  update(dt: number, camera: THREE.Vector3, intensity: number, velocity: THREE.Vector3, brightness: number): void {
    const active = Math.floor(this.drops * Math.min(1, intensity));
    this.object.visible = active > 0;
    if (!this.object.visible) return;
    this.time += dt;
    const u = this.material.uniforms;
    u.uTime.value = this.time;
    (u.uCamera.value as THREE.Vector3).copy(camera);
    const length = 0.7 + intensity * 0.9;
    this.fallDir.set(-velocity.x, -FALL, -velocity.z).normalize().multiplyScalar(length);
    (u.uStreak.value as THREE.Vector3).copy(this.fallDir);
    u.uOpacity.value = (0.22 + intensity * 0.3) * (0.35 + 0.65 * brightness);
    this.geometry.setDrawRange(0, active * 2);
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.object.removeFromParent();
  }
}
