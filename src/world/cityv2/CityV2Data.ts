/**
 * The prepared City V2 (scripts/prepare-city-v2.ts): the first city's data
 * layout (CityData.ts: 250 m cells, prototype instances, colliders, road
 * points) plus what the procedural town adds: the extent of each cell's
 * geometry (streaming is measured to it, a block may reach past its cell),
 * an always-loaded collider for the land around town, and the road graph.
 * Independent of three.js so the headless tests can load it too.
 *
 * city-data.bin: Float32 building instances (prototype, x, z, yaw, stretch, colour variant), collider
 * boxes (centre, half extents, quaternion: the buildings), welded trimesh
 * vertices, road points (x, y, z, heading, half-width of the road there),
 * building modules and prototype placements (buildingKit.ts), kit prop
 * geometry, prop instances per chunk and parking spots (propKit.ts), prop
 * collider boxes per cell, then Uint32 trimesh, module and kit prop indices.
 */
import type { BuildingsJson } from './buildingKit';
import type { CityV2PropsJson } from './propKit';
import type { RoadClass } from './roadProfiles';

/** Streaming-cell and prototype records (the layout the first city used, kept for this one). */
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

export interface CityV2Cell extends CityCell {
  /** Extent of the cell's ground and colliders [minX, minZ, maxX, maxZ], m. */
  bounds: [number, number, number, number];
  /** Triangles of its ground meshes (all materials). */
  tris: number;
  /** Prop collider boxes (same layout as `boxes`), streamed with the cell's colliders. */
  propBoxes?: [number, number];
}

/** A road of the layout graph: centre line from a to b (m). */
export interface CityV2Road {
  a: [number, number];
  b: [number, number];
  cls: RoadClass;
  rank: 'ring' | 'arterial' | 'local';
}

export interface CityV2Json extends Omit<CityJson, 'cells'> {
  cells: CityV2Cell[];
  /** Land around town and the ring's outer kerb: [vertex float offset, vertex count, index offset, triangle count] and boxes (walls). */
  outer: { trimesh: [number, number, number, number]; boxes: [number, number] };
  /** Road points are 5 floats: x, y, z, heading (forward = (sin h, cos h)), half-width of the asphalt. */
  roadStride: 5;
  roadGraph: CityV2Road[];
  /** Building modules, prototypes, texture arrays, the sample areas (A3); cell `inst` records are INSTANCE_STRIDE floats. */
  buildings: BuildingsJson;
  layout: { seed: number; size: number; blocks: number; districts: Record<string, number> };
  /** Street props (A4): instances per chunk, junction control, signals, parking (propKit.ts). */
  props?: CityV2PropsJson;
}

export interface CityV2Data {
  json: CityV2Json;
  f32: Float32Array;
  u32: Uint32Array;
}

export const CITY_V2_URLS = {
  glb: '/assets/city_v2/city.glb',
  json: '/assets/city_v2/city-data.json',
  bin: '/assets/city_v2/city-data.bin',
  albedo: '/assets/city_v2/buildings-albedo.webp',
  normal: '/assets/city_v2/buildings-normal.webp',
} as const;

export function parseCityV2Data(json: CityV2Json, bin: ArrayBuffer): CityV2Data {
  const f32 = new Float32Array(bin, 0, json.floats);
  const u32 = new Uint32Array(bin, json.floats * 4, json.ints);
  return { json, f32, u32 };
}
