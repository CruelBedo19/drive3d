import * as THREE from 'three';

/** A road material and its dry look. */
export interface WettableMaterial {
  material: THREE.MeshStandardMaterial;
  roughness: number;
  color: THREE.Color;
}

/** Wet asphalt stops at this roughness: glossy, not a mirror or plastic. */
const WET_ROUGHNESS = 0.38;
const WET_DARKEN = 0.32;
/** Extra sky reflection when wet (the scene's sky environment map does the reflecting). */
const WET_REFLECTION = 0.5;

/**
 * Wet look for one road material: darker, smoother, with a bit more of the sky
 * environment reflected, all scaled by wetness. Only numbers change: no shader
 * recompiles while it rains in or dries out.
 */
export function applyWetness(w: WettableMaterial, wetness: number): void {
  const m = w.material;
  m.roughness = THREE.MathUtils.lerp(w.roughness, WET_ROUGHNESS, wetness);
  m.color.copy(w.color).multiplyScalar(1 - WET_DARKEN * wetness);
  m.envMapIntensity = 1 + WET_REFLECTION * wetness;
}
