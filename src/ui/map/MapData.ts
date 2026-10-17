/**
 * Generic 2D map description, in world metres on the ground plane (x, z).
 * Tracks provide one today; an open-world city can later add roads, places
 * (garage, fuel, events) and a route without the minimap changing.
 */

export type MapPathKind = 'track' | 'road' | 'area' | 'route';

export interface MapPath {
  kind: MapPathKind;
  /** x0, z0, x1, z1, ... */
  points: Float32Array;
  closed: boolean;
  /** Real width in metres (drawn at least a few pixels wide). */
  width: number;
}

export type MapMarkerKind = 'start' | 'poi' | 'garage' | 'race' | 'fuel' | 'event' | 'waypoint';

export interface MapMarker {
  kind: MapMarkerKind;
  x: number;
  z: number;
  /** Heading for directional markers (start line), rad, same convention as vehicle yaw. */
  yaw?: number;
  label?: string;
}

export interface MapData {
  paths: readonly MapPath[];
  markers: readonly MapMarker[];
  /** Metres from the player to the minimap edge at standstill (zooms out a bit with speed). */
  viewRadius: number;
}

/** Anything the minimap can show; implemented by tracks today. */
export interface MapDataProvider {
  readonly mapData: MapData;
}

/**
 * Drops points closer than `minSpacing` to the last kept one: a 20 km track
 * does not need a point every 2 m at minimap scale.
 */
export function decimatePath(xz: ArrayLike<number>, minSpacing: number): Float32Array {
  const out: number[] = [xz[0], xz[1]];
  let lx = xz[0];
  let lz = xz[1];
  for (let i = 2; i < xz.length; i += 2) {
    const dx = xz[i] - lx;
    const dz = xz[i + 1] - lz;
    if (dx * dx + dz * dz >= minSpacing * minSpacing) {
      out.push(xz[i], xz[i + 1]);
      lx = xz[i];
      lz = xz[i + 1];
    }
  }
  return new Float32Array(out);
}
