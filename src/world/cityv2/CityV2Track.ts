import * as THREE from 'three';
import { RAPIER } from '../../core/PhysicsWorld';
import { CityLaneGraph } from '../../traffic/city/CityLaneGraph';
import type { MapData } from '../../ui/map/MapData';
import type { SpawnPoint, TestPoint, Track, TrackView } from '../Track';
import { applyWetness } from '../weather/wetSurface';
import type { CityV2Assets } from './CityV2Assets';
import { CityV2Buildings } from './CityV2Buildings';
import { CityV2ParkedCars } from './CityV2ParkedCars';
import { CityV2Props } from './CityV2Props';
import type { CityV2Cell } from './CityV2Data';
import { kerbOffset } from './roadProfiles';

/** Streaming distances (m, from the edge of a cell's geometry): drawn, lane markings drawn, with colliders. */
const RENDER_DISTANCE = 1500;
const MARKING_DISTANCE = 420;
const PHYSICS_DISTANCE = 150;
const HYSTERESIS = 60;
/** Anisotropic filtering for the ground textures (three.js clamps it to what the GPU offers). */
const GROUND_ANISOTROPY = 8;
/**
 * Share of the sky environment light per ground material, measured on screen
 * (blue − red of a sunny lot: +13 at the full share, +3 at 0.25). Light-grey
 * concrete otherwise takes on the sky's blue and read as ice or water.
 */
const ENV_LIGHT: Record<string, number> = { cv2_sidewalk: 0.25, cv2_lot: 0.25, cv2_garden: 0.35, cv2_plaza: 0.4, cv2_asphalt: 0.7, cv2_parking: 0.7, cv2_park: 0.35, cv2_land: 0.35, cv2_median: 0.35 };

interface CellState {
  def: CityV2Cell;
  key: string;
  ground: THREE.Group | null;
  markings: THREE.Mesh[];
  body: RAPIER.RigidBody | null;
  colliderTris: number;
  colliderBoxes: number;
  propBoxes: number;
  parkedBoxes: number;
}

/**
 * City V2: the procedural town (scripts/prepare-city-v2.ts), streamed in 250 m
 * cells like the first city. Each cell's ground is a handful of meshes (one per
 * material: asphalt, sidewalk + kerbs, lots, markings...) straight from the
 * prepared glb; only cells near the car get their trimesh collider (distance
 * measured to the cell's geometry, which can reach past the cell). The land
 * around town and its walls form one collider that is always there.
 *
 * Lane markings sit 12 mm above the asphalt and draw with polygon offset and
 * after it (Autobahn's markings), so they never fight with the road.
 */
export class CityV2Track implements Track {
  readonly group = new THREE.Group();
  readonly spawn: SpawnPoint;
  readonly testPoints: readonly TestPoint[];
  readonly killHeight = -20;
  readonly fog = { near: 220, far: 1400 };
  /** Depth precision for kilometres of kerbs and markings; the hood camera still clears it. */
  readonly cameraNear = 0.25;
  readonly attribution = 'Şehir · Downtown City MegaKit · Quaternius · CC0';
  private readonly world: RAPIER.World;
  private readonly assets: CityV2Assets;
  private readonly cells = new Map<string, CellState>();
  private readonly roadBins = new Map<string, number[]>();
  /** Road graph segments by the 50 m bins they pass (padded by the road's half-width). */
  private readonly graphBins = new Map<string, number[]>();
  /** Wet look per material, plus its share of sky light (`env`) and, for shares below 1, the wet boost and the intensity last written. */
  private readonly wettable: { material: THREE.MeshStandardMaterial; roughness: number; color: THREE.Color; env: number; wetBoost?: number; applied?: number }[] = [];
  private readonly outerBody: RAPIER.RigidBody;
  /** Buildings: instanced prototypes by level of detail, box colliders per cell. */
  readonly buildings: CityV2Buildings;
  /** Street props (A4): instanced prototypes per 125 m chunk, colliders of the solid ones per cell. */
  readonly props: CityV2Props;
  /** Parked cars on the lots' stalls (A5): instanced models near, stand-ins further, colliders per cell. */
  readonly parked: CityV2ParkedCars;
  /** Traffic lanes and junction connectors (A5), built from the road graph at load. */
  readonly laneGraph: CityLaneGraph;
  /** Clock of the signal plan, s: the city traffic advances it with the simulation (lights and drivers agree). */
  signalTime = 0;
  private readonly mapCache: MapData;
  private focus = new THREE.Vector3();
  /** Build time this frame / of the first build around the spawn, ms (F2). */
  buildMs = 0;
  initMs = 0;

  constructor(world: RAPIER.World, assets: CityV2Assets) {
    this.world = world;
    this.assets = assets;
    this.group.name = 'city_v2';
    const j = assets.data.json;
    for (const def of j.cells) {
      const key = `${def.cx},${def.cz}`;
      this.cells.set(key, { def, key, ground: null, markings: [], body: null, colliderTris: 0, colliderBoxes: 0, propBoxes: 0, parkedBoxes: 0 });
    }
    const f = assets.data.f32;
    const [off, n] = j.roads;
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(f[off + i * 5] / 50)},${Math.floor(f[off + i * 5 + 2] / 50)}`;
      let l = this.roadBins.get(k);
      if (!l) this.roadBins.set(k, (l = []));
      l.push(i);
    }
    j.roadGraph.forEach((r, i) => {
      const pad = kerbOffset(r.cls) + 1;
      for (let bx = Math.floor((Math.min(r.a[0], r.b[0]) - pad) / 50); bx <= Math.floor((Math.max(r.a[0], r.b[0]) + pad) / 50); bx++) {
        for (let bz = Math.floor((Math.min(r.a[1], r.b[1]) - pad) / 50); bz <= Math.floor((Math.max(r.a[1], r.b[1]) + pad) / 50); bz++) {
          const k = `${bx},${bz}`;
          let l = this.graphBins.get(k);
          if (!l) this.graphBins.set(k, (l = []));
          l.push(i);
        }
      }
    });
    this.spawn = { position: new THREE.Vector3(j.spawn.x, j.spawn.y, j.spawn.z), yaw: j.spawn.yaw };
    this.testPoints = [{ id: 'start', label: 'Başlangıç', ...this.spawn }, ...j.teleports.map((t) => ({ id: t.id, label: t.label, position: new THREE.Vector3(t.x, t.y, t.z), yaw: t.yaw }))];

    // Materials are shared by every cell: set them up once.
    const seen = new Set<THREE.Material>();
    for (const mesh of assets.ground.values()) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (seen.has(m)) continue;
      seen.add(m);
      // Ground seen at grazing angles: anisotropic filtering keeps the textures sharp and stops the
      // slab joints of the concrete aliasing into bands in the distance (GLTFLoader leaves it at 1).
      for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.aoMap]) {
        if (t && t.anisotropy < GROUND_ANISOTROPY) {
          t.anisotropy = GROUND_ANISOTROPY;
          t.needsUpdate = true;
        }
      }
      if (/marking/.test(m.name)) {
        m.polygonOffset = true;
        m.polygonOffsetFactor = -2;
        m.polygonOffsetUnits = -4;
      } else if (m.isMeshStandardMaterial && /asphalt|parking|sidewalk|lot|garden|plaza|park|land|median/.test(m.name)) {
        const env = ENV_LIGHT[m.name] ?? 1;
        this.wettable.push({ material: m, roughness: m.roughness, color: m.color.clone(), env });
      }
    }

    // The land around town and its walls: always there.
    this.outerBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.addTrimesh(this.outerBody, j.outer.trimesh);
    const [bo, bc] = j.outer.boxes;
    for (let i = 0; i < bc; i++) {
      const o = bo + i * 10;
      world.createCollider(RAPIER.ColliderDesc.cuboid(f[o + 3], f[o + 4], f[o + 5]).setTranslation(f[o], f[o + 1], f[o + 2]).setFriction(0.4), this.outerBody);
    }
    this.mapCache = { paths: [], markers: [], viewRadius: 260, image: j.minimap };
    this.buildings = new CityV2Buildings(assets.data, assets.buildings);
    this.group.add(this.buildings.group);
    this.props = new CityV2Props(assets.data);
    this.group.add(this.props.group);
    this.laneGraph = new CityLaneGraph(j);
    this.parked = new CityV2ParkedCars(assets.data, j.layout.seed);
    this.group.add(this.parked.group);
    const t0 = performance.now();
    this.stream(this.spawn.position, true);
    this.buildings.update(this.spawn.position, true);
    this.props.update(this.spawn.position, null, 450, 0, 0);
    this.initMs = performance.now() - t0;
  }

  get mapData(): MapData {
    return this.mapCache;
  }

  // --- streaming --------------------------------------------------------------------------

  /** Distance (x/z) from a point to a cell's geometry. */
  private distance(c: CellState, p: THREE.Vector3): number {
    const [x0, z0, x1, z1] = c.def.bounds;
    return Math.hypot(Math.max(x0 - p.x, 0, p.x - x1), Math.max(z0 - p.z, 0, p.z - z1));
  }

  stream(position: THREE.Vector3, _immediate = false): void {
    this.focus.copy(position);
    const t0 = performance.now();
    for (const c of this.cells.values()) {
      const d = this.distance(c, position);
      if (d < PHYSICS_DISTANCE && !c.body) this.addBody(c);
      else if (d > PHYSICS_DISTANCE + HYSTERESIS && c.body) this.removeBody(c);
      if (d < RENDER_DISTANCE && !c.ground) this.addGround(c);
      else if (d > RENDER_DISTANCE + HYSTERESIS && c.ground) this.removeGround(c);
    }
    this.buildMs = performance.now() - t0;
  }

  update(view?: TrackView): void {
    if (!view) return;
    this.stream(view.camera);
    this.buildings.update(view.camera, false, view.frustum ?? null);
    this.props.update(view.camera, view.frustum ?? null, view.vegetationDistance, view.night ?? 0, this.signalTime);
    this.parked.update(view.camera, view.frustum ?? null);
    // The sky environment map is re-rendered as the weather changes.
    this.syncEnvironment();
    // Markings are a few centimetres wide: beyond a few hundred metres they are sub-pixel, so not drawn at all.
    for (const c of this.cells.values()) {
      if (!c.ground) continue;
      const near = this.distance(c, view.camera) < MARKING_DISTANCE;
      for (const m of c.markings) m.visible = near;
    }
  }

  private addGround(c: CellState): void {
    const g = new THREE.Group();
    g.name = `city_v2-${c.key}`;
    for (const name of c.def.ground) {
      const mesh = this.assets.ground.get(name);
      if (!mesh) continue;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      if (/_marking$/.test(name)) {
        // After the road surfaces (Autobahn markings use the same order).
        mesh.renderOrder = 1;
        c.markings.push(mesh);
      }
      g.add(mesh);
    }
    c.ground = g;
    this.group.add(g);
  }

  private removeGround(c: CellState): void {
    // Ground meshes belong to the loaded city (reused by the next session): only detach them.
    c.ground?.removeFromParent();
    c.ground?.clear();
    c.ground = null;
    c.markings = [];
  }

  private addTrimesh(body: RAPIER.RigidBody, [vo, vc, io, tc]: [number, number, number, number]): number {
    if (tc <= 0) return 0;
    const { f32, u32 } = this.assets.data;
    // Welded by the prepare step; internal edges fixed so the chassis does not catch on triangle seams.
    const desc = RAPIER.ColliderDesc.trimesh(f32.slice(vo, vo + vc * 3), u32.slice(io, io + tc * 3), RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES).setFriction(0.9);
    this.world.createCollider(desc, body);
    return tc;
  }

  private addBody(c: CellState): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    c.colliderTris = this.addTrimesh(body, c.def.trimesh);
    // Buildings: one box each (walls only; cornices and sills are not solid).
    const f = this.assets.data.f32;
    const [bo, bc] = c.def.boxes;
    for (let i = 0; i < bc; i++) {
      const o = bo + i * 10;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(f[o + 3], f[o + 4], f[o + 5]).setTranslation(f[o], f[o + 1], f[o + 2]).setRotation({ x: f[o + 6], y: f[o + 7], z: f[o + 8], w: f[o + 9] }).setFriction(0.5),
        body,
      );
    }
    c.colliderBoxes = bc;
    // Solid props (poles, barriers, planters, containers, shelters, fences): boxes like the buildings'.
    const [po, pc] = c.def.propBoxes ?? [0, 0];
    for (let i = 0; i < pc; i++) {
      const o = po + i * 10;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(f[o + 3], f[o + 4], f[o + 5]).setTranslation(f[o], f[o + 1], f[o + 2]).setRotation({ x: f[o + 6], y: f[o + 7], z: f[o + 8], w: f[o + 9] }).setFriction(0.5),
        body,
      );
    }
    c.propBoxes = pc;
    // Parked cars: one box each.
    const parked = this.parked.byCell.get(c.key) ?? [];
    for (const i of parked) {
      const b = this.parked.box(i);
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z).setRotation({ x: 0, y: Math.sin(b.yaw / 2), z: 0, w: Math.cos(b.yaw / 2) }).setFriction(0.6), body);
    }
    c.parkedBoxes = parked.length;
    c.body = body;
  }

  private removeBody(c: CellState): void {
    if (c.body) this.world.removeRigidBody(c.body);
    c.body = null;
    c.colliderTris = 0;
    c.colliderBoxes = 0;
    c.propBoxes = 0;
    c.parkedBoxes = 0;
  }

  // --- player safety ------------------------------------------------------------------------

  /** Nearest lane point: the car goes back on the road, in the lane, facing the traffic direction. */
  safeRespawn(near: THREE.Vector3): SpawnPoint {
    const p = this.nearestRoad(near);
    return { position: new THREE.Vector3(p[0], p[1], p[2]), yaw: p[3] };
  }

  /** Lane point [x, y, z, heading, half-width of the road] closest to a position. */
  nearestRoad(pos: THREE.Vector3): [number, number, number, number, number] {
    const f = this.assets.data.f32;
    const off = this.assets.data.json.roads[0];
    let best = -1;
    let bestD = Infinity;
    const bx = Math.floor(pos.x / 50);
    const bz = Math.floor(pos.z / 50);
    for (let r = 1; r < 80 && best < 0; r += r < 4 ? 1 : 8) {
      for (let i = -r; i <= r; i++) for (let k = -r; k <= r; k++) {
        for (const j of this.roadBins.get(`${bx + i},${bz + k}`) ?? []) {
          const o = off + j * 5;
          const d = (f[o] - pos.x) ** 2 + (f[o + 2] - pos.z) ** 2;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    const o = off + Math.max(0, best) * 5;
    return [f[o], f[o + 1], f[o + 2], f[o + 3], f[o + 4]];
  }

  /** On the asphalt: within half a road's width of its centre line (junction boxes included), at road height. */
  onRoad(pos: THREE.Vector3): boolean {
    if (Math.abs(pos.y) > 3) return false;
    for (const i of this.graphBins.get(`${Math.floor(pos.x / 50)},${Math.floor(pos.z / 50)}`) ?? []) {
      const r = this.assets.data.json.roadGraph[i];
      const [ax, az] = r.a;
      const [bx, bz] = r.b;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((pos.x - ax) * dx + (pos.z - az) * dz) / (dx * dx + dz * dz)));
      if (Math.hypot(ax + dx * t - pos.x, az + dz * t - pos.z) <= kerbOffset(r.cls) + 0.5) return true;
    }
    return false;
  }

  outOfBounds(pos: THREE.Vector3): boolean {
    const b = this.assets.data.json.bounds;
    return pos.x < b.minX - 20 || pos.x > b.maxX + 20 || pos.z < b.minZ - 20 || pos.z > b.maxZ + 20;
  }

  setWetness(wetness: number): void {
    for (const w of this.wettable) applyWetness(w, wetness);
    this.syncEnvironment();
  }

  /**
   * Materials with less than the full sky light get the scene's environment map
   * as their own envMap: three.js scales scene.environment only by
   * scene.environmentIntensity, a material's envMapIntensity only its own envMap.
   * Their intensity is then the scene's × their share × the wet boost that
   * applyWetness wrote (1 when dry).
   */
  private syncEnvironment(): void {
    const scene = this.group.parent as THREE.Scene | null;
    if (!scene?.isScene) return;
    for (const w of this.wettable) {
      if (w.env >= 1) continue;
      const m = w.material;
      if (m.envMap !== scene.environment) {
        m.envMap = scene.environment;
        m.needsUpdate = true;
      }
      if (w.wetBoost === undefined || m.envMapIntensity !== w.applied) w.wetBoost = m.envMapIntensity;
      w.applied = w.wetBoost * w.env * scene.environmentIntensity;
      m.envMapIntensity = w.applied;
    }
  }

  // --- debug --------------------------------------------------------------------------------

  stats(): { cells: number; drawn: number; physics: number; colliderTris: number; colliderBoxes: number; propBoxes: number; parkedBoxes: number; meshes: number; markingsDrawn: number; triangles: number } {
    let propBoxes = 0;
    let parkedBoxes = 0;
    let drawn = 0;
    let physics = 0;
    let colliderTris = 0;
    let colliderBoxes = 0;
    let meshes = 0;
    let markingsDrawn = 0;
    let triangles = 0;
    for (const c of this.cells.values()) {
      if (c.ground) {
        drawn++;
        for (const o of c.ground.children) {
          const m = o as THREE.Mesh;
          if (!m.visible) continue;
          meshes++;
          if (c.markings.includes(m)) markingsDrawn++;
          triangles += (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
        }
      }
      if (c.body) {
        physics++;
        colliderTris += c.colliderTris;
        colliderBoxes += c.colliderBoxes;
        propBoxes += c.propBoxes;
        parkedBoxes += c.parkedBoxes;
      }
    }
    return { cells: this.cells.size, drawn, physics, colliderTris, colliderBoxes, propBoxes, parkedBoxes, meshes, markingsDrawn, triangles: Math.round(triangles) };
  }

  debugInfo(): Record<string, string | number> {
    const s = this.stats();
    const ps = this.props.stats();
    const built = this.buildings.built();
    const p = this.nearestRoad(this.focus);
    const j = this.assets.data.json;
    return {
      'Şehir (seed / boyut)': `${j.layout.seed} / ${j.layout.size} m · ${j.layout.blocks} blok`,
      'Hücre (toplam / çizilen / fizik)': `${s.cells} / ${s.drawn} / ${s.physics}`,
      'Collider üçgen / bina kutusu (aktif)': `${s.colliderTris} / ${s.colliderBoxes}`,
      'Görünür mesh / üçgen / çizgi mesh': `${s.meshes} / ${s.triangles} / ${s.markingsDrawn}`,
      'Bina (toplam / yakın / sokak / orta / hücre / uzak)': `${this.buildings.total} / ${this.buildings.counts.join(' / ')}`,
      'Bina görüş dışı / çizilen uzak kutu': `${this.buildings.culled} / ${this.buildings.farShown}`,
      'Bina üçgen / çizim (instanced + hücre + uzak)': `${this.buildings.triangles} / ${this.buildings.draws.instanced} + ${this.buildings.draws.merged} + ${this.buildings.draws.far}`,
      'Bina geometri (seviye / hücre) / ms': `${built.levels} of ${built.of} / ${built.cells} / ${this.buildings.buildMs.toFixed(2)}`,
      'Prop (toplam / menzilde / gönderilen)': `${ps.total} / ${ps.inRange} / ${ps.submitted}`,
      'Prop çizim / üçgen / chunk (görünen / toplam) / ms': `${ps.draws} / ${ps.triangles} / ${ps.chunksInView} of ${ps.chunks} / ${ps.updateMs.toFixed(2)}`,
      'Prop collider (aktif)': s.propBoxes,
      'Park etmiş araç (toplam / model / kutu / çizim / collider)': `${this.parked.cars.length} / ${this.parked.drawnNear} / ${this.parked.drawnFar} / ${this.parked.drawCalls} / ${s.parkedBoxes}`,
      'Trafik şeridi / kavşak bağlantısı': `${this.laneGraph.lanes.length} / ${this.laneGraph.segs.length - this.laneGraph.lanes.length}`,
      'Yükleme (MB / ms)': `${(this.assets.bytes / 1e6).toFixed(2)} / ${this.assets.loadMs.toFixed(0)}`,
      'Üretim ms (bu kare / ilk)': `${this.buildMs.toFixed(2)} / ${this.initMs.toFixed(0)}`,
      'En yakın şerit (m)': Math.hypot(p[0] - this.focus.x, p[2] - this.focus.z).toFixed(1),
    };
  }

  private debugMeshes = new Map<string, THREE.Object3D>();

  debugLayers(): { id: string; label: string; on: boolean }[] {
    return [
      { id: 'cells', label: 'Hücre sınırları', on: this.debugMeshes.get('cells')?.visible ?? false },
      { id: 'graph', label: 'Yol grafı (layout)', on: this.debugMeshes.get('graph')?.visible ?? false },
      { id: 'lanes', label: 'Şerit noktaları', on: this.debugMeshes.get('lanes')?.visible ?? false },
      { id: 'traffic', label: 'Trafik şeritleri ve kavşak bağlantıları', on: this.debugMeshes.get('traffic')?.visible ?? false },
    ];
  }

  setDebugLayer(id: string, on: boolean): void {
    let o = this.debugMeshes.get(id);
    if (!o && on) {
      const j = this.assets.data.json;
      const pts: number[] = [];
      let color = 0xff3df5;
      if (id === 'cells') {
        for (const c of j.cells) {
          const [x0, z0, x1, z1] = c.bounds;
          pts.push(x0, 0.5, z0, x1, 0.5, z0, x1, 0.5, z0, x1, 0.5, z1, x1, 0.5, z1, x0, 0.5, z1, x0, 0.5, z1, x0, 0.5, z0);
        }
      } else if (id === 'graph') {
        color = 0xffe14d;
        for (const r of j.roadGraph) pts.push(r.a[0], 0.3, r.a[1], r.b[0], 0.3, r.b[1]);
      } else if (id === 'lanes') {
        color = 0x2affd0;
        const f = this.assets.data.f32;
        const [off, n] = j.roads;
        for (let i = 0; i < n; i++) {
          const k = off + i * 5;
          pts.push(f[k], 0.3, f[k + 2], f[k] + Math.sin(f[k + 3]) * 3, 0.3, f[k + 2] + Math.cos(f[k + 3]) * 3);
        }
      } else if (id === 'traffic') {
        color = 0xff8a2a;
        for (const seg of this.laneGraph.segs) {
          for (let i = 1; i < seg.px.length; i++) pts.push(seg.px[i - 1], 0.35, seg.pz[i - 1], seg.px[i], 0.35, seg.pz[i]);
        }
      } else return;
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color, depthTest: false }));
      lines.renderOrder = 30;
      lines.frustumCulled = false;
      this.group.add(lines);
      this.debugMeshes.set(id, (o = lines));
    }
    if (o) o.visible = on;
  }

  dispose(): void {
    for (const o of this.debugMeshes.values()) {
      const m = o as THREE.LineSegments;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      o.removeFromParent();
    }
    for (const c of this.cells.values()) {
      this.removeGround(c);
      this.removeBody(c);
    }
    this.world.removeRigidBody(this.outerBody);
    this.buildings.dispose();
    this.props.dispose();
    this.parked.dispose();
    this.setWetness(0);
    // The materials outlive this session (kept with the loaded city): no envMap from this session's weather.
    for (const w of this.wettable) if (w.env < 1) w.material.envMap = null;
    this.group.removeFromParent();
  }
}
