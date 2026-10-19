/**
 * The prepared city (scripts/prepare-city.ts): layout and collision data,
 * independent of three.js so the headless tests can load it too.
 *
 * city-data.json describes cells and prototypes; city-data.bin holds the
 * numbers: Float32 instance records (prototype id + 3×4 matrix), collider
 * boxes (centre, half extents, quaternion), welded trimesh vertices and road
 * points (x, y, z, heading), then Uint32 trimesh indices.
 */

export interface CityProto {
  id: number;
  name: string;
  category: 'ground' | 'water' | 'building' | 'vegetation' | 'prop';
  tris: number;
  lod: boolean;
  collider: 'box' | 'trunk' | null;
}

export interface CityCell {
  cx: number;
  cz: number;
  /** [float offset, count] of 13-float instance records. */
  inst: [number, number];
  /** [float offset, count] of 10-float boxes. */
  boxes: [number, number];
  /** [vertex float offset, vertex count, index offset, triangle count]. */
  trimesh: [number, number, number, number];
  /** Names of this cell's baked ground meshes in city.glb. */
  ground: string[];
}

export interface CityTeleport {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface CityJson {
  version: number;
  source: string;
  cell: number;
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  protos: CityProto[];
  cells: CityCell[];
  roads: [number, number];
  spawn: { x: number; y: number; z: number; yaw: number };
  teleports: CityTeleport[];
  minimap: { url: string; minX: number; minZ: number; maxX: number; maxZ: number };
  floats: number;
  ints: number;
}

export interface CityData {
  json: CityJson;
  f32: Float32Array;
  u32: Uint32Array;
  protoById: Map<number, CityProto>;
}

export const CITY_URLS = {
  glb: '/assets/city/city.glb',
  json: '/assets/city/city-data.json',
  bin: '/assets/city/city-data.bin',
} as const;

export function parseCityData(json: CityJson, bin: ArrayBuffer): CityData {
  const f32 = new Float32Array(bin, 0, json.floats);
  const u32 = new Uint32Array(bin, json.floats * 4, json.ints);
  return { json, f32, u32, protoById: new Map(json.protos.map((p) => [p.id, p])) };
}
