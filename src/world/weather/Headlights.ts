import * as THREE from 'three';

export type HeadlightMode = 'manual' | 'auto';

/**
 * Light switch logic. Manual: L toggles. Auto: the lights follow the conditions
 * (night, heavy rain, very dark sky); L overrides them until the conditions
 * change by themselves (e.g. turned off at dusk: they stay off until auto would
 * switch, then auto takes over again).
 */
export class HeadlightController {
  mode: HeadlightMode;
  private manualOn = false;
  private override: boolean | null = null;
  private lastAuto: boolean | null = null;
  private current = false;

  constructor(mode: HeadlightMode) {
    this.mode = mode;
  }

  get on(): boolean {
    return this.current;
  }

  /** Whether auto mode wants light for these conditions. */
  static wanted(c: { night: number; rain: number; daylight: number }): boolean {
    return c.night > 0.4 || c.rain > 0.75 || c.daylight < 0.35;
  }

  toggle(): void {
    if (this.mode === 'manual') this.manualOn = !this.manualOn;
    else this.override = !this.current;
    this.current = this.mode === 'manual' ? this.manualOn : (this.override ?? this.current);
  }

  setMode(mode: HeadlightMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.manualOn = this.current;
    this.override = null;
  }

  update(autoWanted: boolean): boolean {
    if (this.mode === 'manual') {
      this.current = this.manualOn;
    } else {
      if (this.lastAuto !== null && autoWanted !== this.lastAuto) this.override = null;
      this.lastAuto = autoWanted;
      this.current = this.override ?? autoWanted;
    }
    return this.current;
  }
}

const BEAM_LENGTH = 26;
const BEAM_ANGLE = 0.42;

/**
 * The light itself: one shadowless spot light on the car's nose (two would
 * double the per-pixel cost for little gain) plus a faint additive cone of lit
 * air that only shows when there is rain or fog to light up and it is dark.
 * Parented to the car's visual root; nothing is allocated per frame.
 */
export class HeadlightRig {
  readonly group = new THREE.Group();
  private readonly spot: THREE.SpotLight;
  private readonly beamMaterial: THREE.MeshBasicMaterial;
  private readonly beamGeometry: THREE.ConeGeometry;

  /** @param noseZ front of the body, @param lampY lamp height, both in the car's body frame. */
  constructor(noseZ: number, lampY: number) {
    this.spot = new THREE.SpotLight(0xfff3dc, 0, 95, BEAM_ANGLE, 0.5, 1.4);
    this.spot.position.set(0, lampY, noseZ);
    this.spot.target.position.set(0, lampY - 1.4, noseZ + 18);
    this.spot.castShadow = false;
    this.beamMaterial = new THREE.MeshBasicMaterial({ color: 0xfff3d6, vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    this.beamGeometry = new THREE.ConeGeometry(BEAM_LENGTH * Math.tan(BEAM_ANGLE) * 0.8, BEAM_LENGTH, 16, 6, true);
    // Brightest at the lamp, fading to nothing at the far end (no visible rim).
    const p = this.beamGeometry.attributes.position;
    const rgba = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const a = Math.pow((p.getY(i) + BEAM_LENGTH / 2) / BEAM_LENGTH, 2);
      rgba.set([1, 1, 1, a], i * 4);
    }
    this.beamGeometry.setAttribute('color', new THREE.BufferAttribute(rgba, 4));
    // Cone tip at the lamp, opening forwards.
    this.beamGeometry.translate(0, -BEAM_LENGTH / 2, 0);
    this.beamGeometry.rotateX(-Math.PI / 2 + 0.05); // slightly down
    const beam = new THREE.Mesh(this.beamGeometry, this.beamMaterial);
    beam.position.set(0, lampY, noseZ);
    beam.renderOrder = 4;
    this.group.add(this.spot, this.spot.target, beam);
  }

  /** @param scatter how much there is in the air to light up (rain, fog) 0..1; @param dark 0..1 */
  update(on: boolean, scatter: number, dark: number): void {
    // Intensity stays a number (not a toggled light) so turning lights on never recompiles shaders.
    this.spot.intensity = on ? 190 : 0;
    this.beamMaterial.opacity = on ? dark * (0.02 + scatter * 0.06) : 0;
    this.beamMaterial.visible = this.beamMaterial.opacity > 0.004;
  }

  dispose(): void {
    this.spot.dispose();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();
    this.group.removeFromParent();
  }
}
