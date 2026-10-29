import * as THREE from 'three';
import { TRAFFIC_CLASSES, type TrafficModelId } from '../../config/traffic';
import { trafficModel } from '../../traffic/TrafficModelLibrary';
import { buildTrafficModel } from '../../traffic/TrafficModels';
import type { CityV2Data } from './CityV2Data';

/**
 * Low-poly cars of the traffic pack that fit a 2.5 × 5 m stall (scripts/lib/cityV2/props.ts): a short list keeps
 * the draw calls down (one per model part, two parts at most).
 */
export const PARKED_MODELS: readonly TrafficModelId[] = ['sedan_green', 'sedan_grey', 'sedan_maroon', 'sedan_orange', 'sedan_pink', 'sedan_red', 'sedan_silver', 'sedan_white_old', 'sedan_rusty', 'offroad_white', 'offroad_green'];
/** Share of the stalls taken, by parcel use. */
const OCCUPANCY: Record<string, number> = { parking: 0.62, mall: 0.52, factory: 0.42, warehouse: 0.38 };
const OCCUPANCY_DEFAULT = 0.45;
/** Lots are raised to sidewalk level (scripts/lib/cityV2/ground.ts LEVEL.raised), m. */
const GROUND = 0.15;
/** Chunk size (as the props'), and distances: the model up to NEAR, a low-poly stand-in up to FAR, m. */
const CHUNK = 125;
const NEAR = 90;
const FAR = 260;
const HYSTERESIS = 8;
const SHADOW_MARGIN = 6;

export interface ParkedCar {
  model: number;
  x: number;
  z: number;
  /** Facing (forward = (sin yaw, cos yaw)). */
  yaw: number;
}

interface Chunk {
  bounds: [number, number, number, number];
  sphere: THREE.Sphere;
  /** Per model: model matrices (near); all cars: stand-in matrices (scaled to each model) and paint (far). */
  near: Float32Array[];
  far: Float32Array;
  farColors: Float32Array;
  /** 0 near, 1 far, 2 beyond; in the view (with a shadow margin). */
  band: number;
  inView: boolean;
}

/** Deterministic 0..1 from an index and a seed. */
function hash01(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * Parked cars on the parking spots the props step laid out (A4 `props.spots`):
 * a deterministic share of the stalls per lot use, each a traffic-pack car,
 * nose in or (a third of them) reversed in. Drawn as instanced models near the
 * camera and as one instanced low-poly stand-in further away, culled per
 * 125 m chunk by distance and view; buffers refilled only when a chunk changes.
 * Each car is a box collider, built with its streaming cell (CityV2Track).
 */
export class CityV2ParkedCars {
  readonly group = new THREE.Group();
  readonly cars: ParkedCar[] = [];
  /** Car indices by streaming cell key "cx,cz". */
  readonly byCell = new Map<string, number[]>();
  private readonly chunks: Chunk[] = [];
  private readonly counts: number[];
  /** Per model, its instanced parts (null until the model has loaded; without it the stand-in is drawn near too). */
  private readonly nearMeshes: (THREE.InstancedMesh[] | null)[];
  private readonly farMesh: THREE.InstancedMesh | null = null;
  private readonly farGeo: THREE.BufferGeometry | null = null;
  private readonly farMat: THREE.MeshStandardMaterial | null = null;
  private dirty = true;
  /** Last update (F2 / tests): cars drawn as models / stand-ins, ms. */
  drawnNear = 0;
  drawnFar = 0;
  updateMs = 0;

  constructor(data: CityV2Data, seed: number, draw = typeof document !== 'undefined') {
    const json = data.json;
    const props = json.props;
    this.counts = PARKED_MODELS.map(() => 0);
    this.nearMeshes = PARKED_MODELS.map(() => null);
    if (!props) return;
    const f = data.f32;
    const [so, sn] = props.spots;
    for (let i = 0; i < sn; i++) {
      const o = so + i * 4;
      const lot = props.lots[f[o + 3]];
      if (hash01(i, seed) >= (OCCUPANCY[lot?.use ?? ''] ?? OCCUPANCY_DEFAULT)) continue;
      const model = Math.floor(hash01(i, seed ^ 0x51ed) * PARKED_MODELS.length);
      // The spot's yaw points into the stall: nose in, or reversed in.
      const yaw = f[o + 2] + (hash01(i, seed ^ 0x2b) < 0.33 ? Math.PI : 0);
      const car: ParkedCar = { model, x: f[o], z: f[o + 1], yaw };
      const k = `${Math.floor(car.x / json.cell)},${Math.floor(car.z / json.cell)}`;
      const list = this.byCell.get(k);
      if (list) list.push(this.cars.length);
      else this.byCell.set(k, [this.cars.length]);
      this.cars.push(car);
      this.counts[model]++;
    }
    this.buildChunks();
    if (!draw) return;
    this.group.name = 'parked-cars';
    // The stand-in: the built-in car shape, scaled per model, painted with the model's main colour.
    const shape = buildTrafficModel('car');
    for (const g of [shape.head, shape.tail, shape.indLeft, shape.indRight]) g.dispose();
    this.farGeo = shape.body;
    this.farMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.3 });
    this.farMesh = new THREE.InstancedMesh(this.farGeo, this.farMat, Math.max(1, this.cars.length));
    this.farMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, this.cars.length) * 3), 3);
    this.farMesh.count = 0;
    this.farMesh.frustumCulled = false;
    this.farMesh.receiveShadow = true;
    this.group.add(this.farMesh);
  }

  private buildChunks(): void {
    const groups = new Map<string, number[]>();
    this.cars.forEach((c, i) => {
      const k = `${Math.floor(c.x / CHUNK)},${Math.floor(c.z / CHUNK)}`;
      const l = groups.get(k);
      if (l) l.push(i);
      else groups.set(k, [i]);
    });
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const base = TRAFFIC_CLASSES.car;
    for (const ids of groups.values()) {
      let x0 = Infinity;
      let z0 = Infinity;
      let x1 = -Infinity;
      let z1 = -Infinity;
      const per: number[][] = PARKED_MODELS.map(() => []);
      for (const i of ids) {
        const c = this.cars[i];
        x0 = Math.min(x0, c.x - 3);
        z0 = Math.min(z0, c.z - 3);
        x1 = Math.max(x1, c.x + 3);
        z1 = Math.max(z1, c.z + 3);
        per[c.model].push(i);
      }
      const near = per.map((list) => {
        const a = new Float32Array(list.length * 16);
        list.forEach((i, k) => {
          const c = this.cars[i];
          m.compose(p.set(c.x, GROUND, c.z), q.setFromAxisAngle(up, c.yaw), s.set(1, 1, 1)).toArray(a, k * 16);
        });
        return a;
      });
      const far = new Float32Array(ids.length * 16);
      const farColors = new Float32Array(ids.length * 3);
      let k = 0;
      for (const list of per) {
        for (const i of list) {
          const c = this.cars[i];
          const t = TRAFFIC_CLASSES[PARKED_MODELS[c.model]];
          m.compose(p.set(c.x, GROUND, c.z), q.setFromAxisAngle(up, c.yaw), s.set(t.width / base.width, t.height / base.height, t.length / base.length)).toArray(far, k * 16);
          col.set(t.paints[0]).toArray(farColors, k * 3);
          k++;
        }
      }
      const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, 1, (z0 + z1) / 2), Math.hypot(x1 - x0, z1 - z0) / 2 + 3 + SHADOW_MARGIN);
      this.chunks.push({ bounds: [x0, z0, x1, z1], sphere, near, far, farColors, band: -1, inView: false });
    }
  }

  /** Models loaded since the last frame get their instanced parts. */
  private adoptModels(): void {
    PARKED_MODELS.forEach((id, i) => {
      if (this.nearMeshes[i] || !this.counts[i]) return;
      const parts = trafficModel(id);
      if (!parts?.length) return;
      this.nearMeshes[i] = parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, this.counts[i]);
        mesh.count = 0;
        mesh.frustumCulled = false;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
        return mesh;
      });
      this.dirty = true;
    });
  }

  /** Per frame: distance band and view of each chunk; buffers refilled when one changed (or a model arrived). */
  update(camera: THREE.Vector3, frustum: THREE.Frustum | null): void {
    if (!this.farMesh) return;
    const t0 = performance.now();
    this.adoptModels();
    let changed = this.dirty;
    for (const c of this.chunks) {
      const [x0, z0, x1, z1] = c.bounds;
      const d = Math.hypot(Math.max(x0 - camera.x, 0, camera.x - x1), Math.max(z0 - camera.z, 0, camera.z - z1));
      const bandAt = (dd: number) => (dd < NEAR ? 0 : dd < FAR ? 1 : 2);
      let band = bandAt(d);
      // Past a threshold by less than HYSTERESIS: keep the band it had.
      if (band !== c.band && c.band >= 0 && bandAt(band > c.band ? d - HYSTERESIS : d + HYSTERESIS) === c.band) band = c.band;
      const seen = band < 2 && (!frustum || frustum.intersectsSphere(c.sphere));
      if (band !== c.band || seen !== c.inView) changed = true;
      c.band = band;
      c.inView = seen;
    }
    if (changed) this.refill();
    this.updateMs = performance.now() - t0;
  }

  private refill(): void {
    const far = this.farMesh!;
    const fill = this.counts.map(() => 0);
    let nf = 0;
    let nn = 0;
    const farM = far.instanceMatrix.array as Float32Array;
    const farC = far.instanceColor!.array as Float32Array;
    for (const c of this.chunks) {
      if (!c.inView) continue;
      let k = 0;
      c.near.forEach((mats, mi) => {
        const n = mats.length / 16;
        const meshes = this.nearMeshes[mi];
        if (c.band === 0 && meshes) {
          for (const mesh of meshes) (mesh.instanceMatrix.array as Float32Array).set(mats, fill[mi] * 16);
          fill[mi] += n;
          nn += n;
        } else {
          farM.set(c.far.subarray(k * 16, (k + n) * 16), nf * 16);
          farC.set(c.farColors.subarray(k * 3, (k + n) * 3), nf * 3);
          nf += n;
        }
        k += n;
      });
    }
    // Only the instances in use are uploaded; empty meshes are hidden (three would still draw zero instances).
    const commit = (mesh: THREE.InstancedMesh, n: number) => {
      mesh.count = n;
      mesh.visible = n > 0;
      if (!n) return;
      for (const attr of mesh.instanceColor ? [mesh.instanceMatrix, mesh.instanceColor] : [mesh.instanceMatrix]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, n * attr.itemSize);
        attr.needsUpdate = true;
      }
    };
    this.nearMeshes.forEach((meshes, mi) => {
      for (const mesh of meshes ?? []) commit(mesh, fill[mi]);
    });
    commit(far, nf);
    this.drawnNear = nn;
    this.drawnFar = nf;
    this.dirty = false;
  }

  /** Collider box of a car: centre, half extents and yaw. */
  box(i: number): { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number } {
    const c = this.cars[i];
    const t = TRAFFIC_CLASSES[PARKED_MODELS[c.model]];
    const hy = t.height * 0.42;
    return { x: c.x, y: GROUND + 0.12 + hy, z: c.z, hx: t.width / 2, hy, hz: t.length / 2, yaw: c.yaw };
  }

  /** Draw calls (model parts with instances, the stand-in), for F2. */
  get drawCalls(): number {
    let n = this.farMesh && this.farMesh.count ? 1 : 0;
    for (const meshes of this.nearMeshes) for (const m of meshes ?? []) if (m.count) n++;
    return n;
  }

  dispose(): void {
    // Model geometry and materials belong to the shared traffic library: only the instance buffers go.
    for (const meshes of this.nearMeshes) for (const m of meshes ?? []) m.dispose();
    this.farMesh?.dispose();
    this.farGeo?.dispose();
    this.farMat?.dispose();
    this.group.removeFromParent();
  }
}
