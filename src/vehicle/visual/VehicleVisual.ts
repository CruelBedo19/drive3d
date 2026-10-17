import type * as THREE from 'three';

/** What a visual needs to pose one wheel. */
export interface WheelPose {
  /** Wheel centre in the physics body frame. */
  readonly position: THREE.Vector3;
  /** Wheel centre height relative to its static ride height, metres (+ = compressed / up). */
  suspensionOffset: number;
  /** Road-wheel angle, rad, positive = left. */
  steerAngle: number;
  /** Accumulated wheel rotation, rad. */
  spinAngle: number;
}

/** Everything the vehicle hands its visual each frame. */
export interface VehicleVisualState {
  readonly wheels: readonly WheelPose[];
  /** Steering wheel position, -1 (left) .. +1 (right). */
  steeringWheel: number;
  braking: boolean;
  reversing: boolean;
  headlights: boolean;
}

/**
 * Contract between the vehicle and whatever draws it.
 *
 * The vehicle places `root` at the (interpolated) physics body transform and
 * hands over the visual state each frame. The placeholder and glTF visuals
 * implement the same interface, so swapping models never touches physics.
 */
export interface VehicleVisual {
  readonly root: THREE.Object3D;
  /** Camera mount for hood view, body frame. */
  readonly hoodCameraOffset: THREE.Vector3;
  update(state: VehicleVisualState): void;
  dispose(): void;
}
