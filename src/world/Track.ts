import type * as THREE from 'three';
import type { MapDataProvider } from '../ui/map/MapData';

/** What a track may use each frame to cull detail. */
export interface TrackView {
  camera: THREE.Vector3;
  /** Trees and other decoration farther than this (m) may be hidden. */
  vegetationDistance: number;
}

export interface SpawnPoint {
  position: THREE.Vector3;
  yaw: number;
}

/** Named start positions for the admin test environment. */
export interface TestPoint extends SpawnPoint {
  id: string;
  label: string;
}

/**
 * What the game needs from a driving world. Static geometry and colliders are
 * built in the constructor; `mapData` feeds the minimap.
 */
export interface Track extends MapDataProvider {
  readonly group: THREE.Group;
  readonly spawn: SpawnPoint;
  readonly testPoints: readonly TestPoint[];
  /** Below this height the car is respawned automatically. */
  readonly killHeight: number;
  /** Optional fog distances for the scene (large worlds see further). */
  readonly fog?: { near: number; far: number };
  /** Data attribution to show on screen while this track is loaded. */
  readonly attribution?: string;
  /** Per-frame: dynamic props, and detail culling around the camera. */
  update(view?: TrackView): void;
  /** Wet-road look 0..1 (weather). Visual only. */
  setWetness?(wetness: number): void;
  dispose(): void;
}
