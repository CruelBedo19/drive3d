/**
 * City V2 street props (A4): the prototype catalogue shared by the placement
 * step (scripts/lib/cityV2/props.ts) and the game (props/PropCatalog.ts builds
 * their meshes). Independent of three.js so the headless tests can load it.
 *
 * Every prop is a prototype instanced many times: one record per copy
 * (PROP_STRIDE floats: x, y, z, yaw, scale x / y / z, variant), grouped per
 * 125 m chunk (a quarter of a 250 m streaming cell) and prototype.
 *
 *  far     beyond this distance (m, to the chunk) the prototype is not drawn
 *  mid     beyond this one its cheaper level is drawn (trees, lamps)
 *  collider box half extents (centred hy above the base), only for props a car
 *          obviously cannot drive through; streamed with the cell's colliders
 *  radius  footprint used to keep props apart when placing them, m
 *
 * Models: the kit's own props (Prop_Bollard, Prop_Planter_Single,
 * Sidewalk_Planter, Prop_ManholeCover, Prop_Drain; Quaternius, CC0) as
 * geometry, everything else built from primitives by PropCatalog.ts (the
 * free kit has no trees, lights, signals, signs or street furniture).
 */

export type PropCategory =
  | 'tree'
  | 'bush'
  | 'grass'
  | 'lamp'
  | 'signal'
  | 'sign'
  | 'bench'
  | 'bin'
  | 'bollard'
  | 'planter'
  | 'hydrant'
  | 'utility'
  | 'busstop'
  | 'bikerack'
  | 'barrier'
  | 'fence'
  | 'container'
  | 'marking'
  | 'path'
  | 'street';

export interface PropDef {
  id: string;
  category: PropCategory;
  far: number;
  mid?: number;
  collider?: [number, number, number];
  radius: number;
  shadow: boolean;
  /** Geometry from the kit (piece name) rather than built from primitives. */
  kit?: string;
}

/** Floats per instance: x, y, z, yaw, sx, sy, sz, variant. */
export const PROP_STRIDE = 8;
/** Chunk size, m: four per 250 m streaming cell. */
export const PROP_CHUNK = 125;

const TINY = 110;
const SMALL = 200;
const LARGE = 460;

export const PROPS: readonly PropDef[] = [
  { id: 'tree_small', category: 'tree', far: LARGE, mid: 110, radius: 1.6, shadow: true },
  { id: 'tree_medium', category: 'tree', far: LARGE, mid: 120, radius: 2.2, shadow: true },
  { id: 'tree_large', category: 'tree', far: LARGE, mid: 140, radius: 3, shadow: true },
  { id: 'tree_conifer', category: 'tree', far: LARGE, mid: 130, radius: 2, shadow: true },
  { id: 'bush', category: 'bush', far: SMALL, radius: 0.9, shadow: false },
  { id: 'grass_patch', category: 'grass', far: TINY, radius: 1, shadow: false },
  { id: 'tree_pit', category: 'grass', far: TINY, radius: 0.7, shadow: false },
  { id: 'verge', category: 'grass', far: SMALL, radius: 0, shadow: false },
  { id: 'lamp_arterial', category: 'lamp', far: LARGE, mid: 220, collider: [0.14, 5, 0.14], radius: 0.6, shadow: true },
  { id: 'lamp_median', category: 'lamp', far: LARGE, mid: 220, collider: [0.16, 5, 0.16], radius: 0.6, shadow: true },
  { id: 'lamp_street', category: 'lamp', far: LARGE, mid: 200, collider: [0.12, 4, 0.12], radius: 0.6, shadow: true },
  { id: 'lamp_residential', category: 'lamp', far: LARGE, mid: 180, collider: [0.1, 3, 0.1], radius: 0.6, shadow: true },
  { id: 'lamp_park', category: 'lamp', far: SMALL, collider: [0.08, 1.8, 0.08], radius: 0.6, shadow: false },
  { id: 'lamp_flood', category: 'lamp', far: LARGE, mid: 220, collider: [0.16, 6, 0.16], radius: 0.8, shadow: true },
  { id: 'signal_pole', category: 'signal', far: LARGE, mid: 200, collider: [0.12, 1.8, 0.12], radius: 0.6, shadow: true },
  { id: 'signal_mast', category: 'signal', far: LARGE, mid: 200, collider: [0.16, 3, 0.16], radius: 0.6, shadow: true },
  { id: 'signal_mast_long', category: 'signal', far: LARGE, mid: 200, collider: [0.16, 3, 0.16], radius: 0.6, shadow: true },
  { id: 'sign_stop', category: 'sign', far: SMALL, radius: 0.4, shadow: false },
  { id: 'sign_yield', category: 'sign', far: SMALL, radius: 0.4, shadow: false },
  { id: 'sign_speed30', category: 'sign', far: SMALL, radius: 0.4, shadow: false },
  { id: 'sign_parking', category: 'sign', far: SMALL, radius: 0.4, shadow: false },
  { id: 'sign_crossing', category: 'sign', far: SMALL, radius: 0.4, shadow: false },
  { id: 'bench', category: 'bench', far: TINY, radius: 1.1, shadow: false },
  { id: 'bin', category: 'bin', far: TINY, radius: 0.5, shadow: false },
  { id: 'bollard', category: 'bollard', far: TINY, radius: 0.4, shadow: false, kit: 'Prop_Bollard' },
  { id: 'planter', category: 'planter', far: SMALL, collider: [1, 0.3, 1], radius: 1.5, shadow: false, kit: 'Prop_Planter_Single' },
  { id: 'planter_long', category: 'planter', far: SMALL, collider: [1, 0.26, 0.88], radius: 1.4, shadow: false, kit: 'Sidewalk_Planter' },
  { id: 'hydrant', category: 'hydrant', far: TINY, radius: 0.5, shadow: false },
  { id: 'utility_box', category: 'utility', far: SMALL, collider: [0.5, 0.65, 0.3], radius: 0.8, shadow: false },
  { id: 'bus_shelter', category: 'busstop', far: SMALL, collider: [2, 1.25, 0.75], radius: 2.6, shadow: true },
  { id: 'bike_rack', category: 'bikerack', far: TINY, radius: 1.3, shadow: false },
  { id: 'barrier', category: 'barrier', far: SMALL, collider: [1, 0.4, 0.3], radius: 1.1, shadow: false },
  { id: 'fence', category: 'fence', far: SMALL, collider: [3, 1, 0.06], radius: 0, shadow: false },
  { id: 'container', category: 'container', far: LARGE, mid: 160, collider: [1.22, 1.3, 3.05], radius: 3.4, shadow: true },
  { id: 'stall_row', category: 'marking', far: SMALL, radius: 0, shadow: false },
  { id: 'hatch', category: 'marking', far: SMALL, radius: 0, shadow: false },
  { id: 'path', category: 'path', far: SMALL, radius: 0, shadow: false },
  { id: 'manhole', category: 'street', far: TINY, radius: 0, shadow: false, kit: 'Prop_ManholeCover' },
  { id: 'drain', category: 'street', far: TINY, radius: 0, shadow: false, kit: 'Prop_Drain' },
];

export const PROP_INDEX: Readonly<Record<string, number>> = Object.fromEntries(PROPS.map((p, i) => [p.id, i]));

/**
 * Signal heads per signal prototype, relative to the pole's foot (m; the signal faces +z, the arm reaches over the
 * lanes towards −x): one on the pole, and a mast's second one over the middle of the arriving lanes.
 */
export const SIGNAL_HEADS: Readonly<Record<string, readonly [number, number, number][]>> = {
  signal_pole: [[0, 2.9, 0.2]],
  signal_mast: [[0, 2.9, 0.2], [-4.1, 5.4, 0]],
  signal_mast_long: [[0, 2.9, 0.2], [-6, 5.4, 0]],
};

/** Signal head: its three lamps (red, yellow, green) relative to the head centre, m (head faces +z). */
export const SIGNAL_LAMPS: readonly [number, number, number][] = [
  [0, 0.3, 0.17],
  [0, 0, 0.17],
  [0, -0.3, 0.17],
];

/** Signal cycle, s: group 0 (approaches along x) green, yellow, all red, then red while group 1 runs. */
export const SIGNAL_CYCLE = 30;

/**
 * Signal state of a group at time t (s): 0 red, 1 yellow, 2 green. Green 11 s, yellow 3 s, then 1 s with
 * every approach red before the other group turns green (cars that entered on yellow clear the junction).
 */
export function signalPhase(group: number, t: number): number {
  const c = (((t + (group ? SIGNAL_CYCLE / 2 : 0)) % SIGNAL_CYCLE) + SIGNAL_CYCLE) % SIGNAL_CYCLE;
  return c < 11 ? 2 : c < 14 ? 1 : 0;
}

/** Kit prop geometry: per primitive its material and ranges in the data file (f32 positions / normals, u32 indices). */
export interface PropKitPiece {
  name: string;
  prims: { mat: 'concrete' | 'soil' | 'metal' | 'iron'; pos: [number, number]; nor: [number, number]; idx: [number, number] }[];
}

export interface PropChunk {
  /** Chunk grid position (PROP_CHUNK m) and the streaming cell it belongs to. */
  cx: number;
  cz: number;
  cell: [number, number];
  /** Extent of its props [minX, minZ, maxX, maxZ, maxY], m. */
  bounds: [number, number, number, number, number];
  /** [prototype, float offset, count] per prototype present. */
  items: [number, number, number][];
}

export type JunctionControl = 'signal' | 'stop' | 'yield' | 'priority' | 'none';

/** A junction of the road graph and how each approach is controlled (data for later traffic AI). */
export interface PropJunction {
  /** Layout node id. */
  id: number;
  x: number;
  z: number;
  kind: 'cross' | 'tee';
  control: JunctionControl;
  approaches: {
    /** Index in roadGraph. */
    edge: number;
    /** Travel direction towards the junction. */
    dir: [number, number];
    control: JunctionControl;
    /** Middle of the stop line across the arriving lanes. */
    stop: [number, number];
    /** Signal group (0: approaches along x, 1: along z); -1 without signals. */
    group: number;
  }[];
}

/** A traffic signal (pole or mast arm) at a junction approach. */
export interface PropSignal {
  junction: number;
  edge: number;
  group: number;
  /** Instance (prototype signal_pole / signal_mast) in the chunk data. */
  x: number;
  z: number;
  yaw: number;
  /** Head centres, world m (heads face along yaw). */
  heads: [number, number, number][];
}

export interface PropParkingLot {
  /** Layout block id and use (parking, mall, factory, ...). */
  block: number;
  use: string;
  district: string;
  /** Entrances: point on the lot edge and the direction into the lot. */
  entrances: [number, number, number][];
  /** First spot and count in the spot list. */
  spots: [number, number];
}

export interface CityV2PropsJson {
  protos: string[];
  stride: number;
  chunk: number;
  chunks: PropChunk[];
  kit: PropKitPiece[];
  /** Parking spots: 4 floats each (centre x, z, yaw of the stall's long axis pointing in, lot index). */
  spots: [number, number];
  lots: PropParkingLot[];
  junctions: PropJunction[];
  signals: PropSignal[];
  /** Props placed, per district (and special parcels) and category. */
  counts: Record<string, Partial<Record<PropCategory, number>>>;
  total: number;
  /** Prop collider boxes in all cells. */
  colliders: number;
  /** Large parcels left for later assets (mall, hospital, stadium, landmark): block id, use, reserved rectangle. */
  reserved: { block: number; use: string; rect: [number, number, number, number] }[];
}
