import type * as THREE from 'three';
import type { TrafficLaneNetwork } from '../traffic/TrafficLaneNetwork';
import type { MapDataProvider } from '../ui/map/MapData';

/** What a track may use each frame to cull detail. */
export interface TrackView {
  camera: THREE.Vector3;
  /** Trees and other decoration farther than this (m) may be hidden. */
  vegetationDistance: number;
  /** Current fog colour and weather visibility (1 = clear): distant scenery tints itself with them. */
  fogColor?: THREE.Color;
  visibility?: number;
  /** Camera far plane, m (nothing beyond it is drawn). */
  cameraFar?: number;
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
  /** Camera near plane, m (default 0.05). Larger buys depth precision for dense, far-reaching geometry. */
  readonly cameraNear?: number;
  /** Data attribution to show on screen while this track is loaded. */
  readonly attribution?: string;
  /** Per-frame: dynamic props, and detail culling around the camera. */
  update(view?: TrackView): void;
  /** Wet-road look 0..1 (weather): darker, smoother asphalt reflecting a little more sky. Visual only. */
  setWetness?(wetness: number): void;
  /**
   * Streamed worlds: keep the world (meshes + colliders) built around this
   * point. Called by the simulation every step; `immediate` builds everything
   * at once (spawn, teleport).
   */
  stream?(position: THREE.Vector3, immediate?: boolean): void;
  /** Nearest safe place to put the car back (else the spawn point). */
  safeRespawn?(near: THREE.Vector3): SpawnPoint;
  /** Is this point on the road surface (lanes, shoulders, verge)? R then recovers in place, else back onto the road. */
  onRoad?(position: THREE.Vector3): boolean;
  /** Too far from the playable area: the car is brought back. */
  outOfBounds?(position: THREE.Vector3): boolean;
  /** 0..1 roof over this point (tunnels): no rain, darker ambient light. */
  coverAt?(position: THREE.Vector3): number;
  /** Changes when `mapData` changes (streamed worlds); static tracks leave it undefined. */
  readonly mapRevision?: number;
  /** Developer numbers for F2. */
  debugInfo?(): Record<string, string | number>;
  /** Debug overlays the track can draw (F2), and switching one on / off. */
  debugLayers?(): { id: string; label: string; on: boolean }[];
  setDebugLayer?(id: string, on: boolean): void;
  /** Rebuild the world from another seed (procedural tracks, F2). */
  regenerate?(seed: number): void;
  readonly seed?: number;
  /** Traffic lanes (worlds with AI traffic). */
  readonly laneNetwork?: TrafficLaneNetwork;
  dispose(): void;
}
