import * as THREE from 'three';
import { AUTOBAHN as A } from '../../config/tracks';
import { RAPIER } from '../../core/PhysicsWorld';
import type { MapData, MapMarker, MapPath } from '../../ui/map/MapData';
import type { SpawnPoint, TestPoint, Track, TrackView } from '../Track';
import { applyWetness } from '../weather/wetSurface';
import { AutobahnAssets } from './AutobahnAssets';
import { ChunkBuilder, type ChunkBuild } from './ChunkBuilder';
import { DistantScenery } from './DistantScenery';
import { TerrainTiles } from './TerrainTiles';
import { RoadGenerator, SECTION, rampLayout } from './RoadGenerator';
import { TerrainField } from './TerrainField';
import { TrafficLaneNetwork } from '../../traffic/TrafficLaneNetwork';

export type ChunkState = 'active' | 'cached';

interface Chunk {
  build: ChunkBuild;
  state: ChunkState;
  body: RAPIER.RigidBody | null;
  colliders: number;
}

const FOG_COLOR = new THREE.Color(0xb4c9de);

/**
 * Procedural, streamed German Autobahn (3 + 3 lanes): an endless road generated
 * from a seed, built in 200 m chunks around the player. Chunks ahead are built
 * a few per frame (the one under the car and the next are built at once if ever
 * missing), chunks behind are parked in a small cache (no colliders, not
 * drawn) and then disposed, so long drives keep memory, meshes and colliders
 * flat. Same seed → same road, so the minimap, spawn, tests and bug reports are
 * reproducible.
 *
 * Around the road: an endless landscape (TerrainTiles, LOD rings around the
 * camera, biome terrain, trees, buildings) and horizon silhouettes plus a far
 * road strip (DistantScenery). Road chunks and landscape share the frame's
 * build budget (AUTOBAHN.world.roadBudget / worldBudget).
 */
export class AutobahnTrack implements Track {
  readonly group = new THREE.Group();
  spawn: SpawnPoint;
  testPoints: readonly TestPoint[];
  readonly killHeight = -400;
  readonly fog = A.fog;
  gen: RoadGenerator;
  /** Authoritative AI lanes, from the same generator. */
  laneNetwork!: TrafficLaneNetwork;
  private readonly world: RAPIER.World;
  private readonly assets = new AutobahnAssets();
  private builder: ChunkBuilder;
  private field!: TerrainField;
  private tiles!: TerrainTiles;
  private scenery!: DistantScenery;
  /** Build time spent this frame on road chunks / landscape tiles, ms (F2). */
  roadMs = 0;
  worldMs = 0;
  private vegetationDistance = 450;
  private readonly chunks = new Map<number, Chunk>();
  /** Road distance of the player (last stream position). */
  private sNear: number;
  private revision = 0;
  private mapCache: MapData | null = null;
  private mapRevisionBuilt = -1;
  /** Chunks built so far (debug / tests). */
  builtCount = 0;
  private wetness = 0;

  constructor(world: RAPIER.World, seed: number = A.seed) {
    this.world = world;
    this.group.name = 'autobahn';
    this.gen = new RoadGenerator(seed);
    this.laneNetwork = new TrafficLaneNetwork(this.gen);
    this.field = new TerrainField(this.gen);
    this.builder = new ChunkBuilder(this.gen, this.field, this.assets);
    this.makeWorld();
    this.sNear = A.spawn.s;
    this.spawn = this.makeSpawn();
    this.testPoints = this.makeTestPoints();
    this.stream(this.spawn.position, true);
  }

  private makeWorld(): void {
    this.tiles = new TerrainTiles(this.field, this.assets);
    this.scenery = new DistantScenery(this.gen, this.field, this.assets);
    this.group.add(this.tiles.group, this.scenery.group);
  }

  get seed(): number {
    return this.gen.seed;
  }

  /** Bumped whenever the set of loaded chunks changes (the minimap redraws). */
  get mapRevision(): number {
    return this.revision;
  }

  get mapData(): MapData {
    if (this.mapCache && this.mapRevisionBuilt === this.revision) return this.mapCache;
    this.mapCache = this.buildMapData();
    this.mapRevisionBuilt = this.revision;
    return this.mapCache;
  }

  /** Road distance the player is at. */
  get progress(): number {
    return this.sNear;
  }

  // --- streaming -------------------------------------------------------------------------

  /**
   * Keeps the chunks around `position` loaded. `immediate`: build everything now
   * (spawn / teleport); otherwise only what is urgently needed plus a time budget.
   */
  stream(position: THREE.Vector3, immediate = false): void {
    this.sNear = immediate ? this.gen.nearestSGlobal(position.x, position.z) : this.gen.nearestS(position.x, position.z, this.sNear, 120);
    // The landscape projects points kilometres ahead onto the road: keep the plan ahead of it.
    this.gen.ensure(this.sNear + A.world.tile * 2 ** A.world.levels * 1.6);
    const L = A.chunk.length;
    const ci = Math.floor(this.sNear / L);
    const first = Math.max(0, ci - A.chunk.behind);
    const last = ci + A.chunk.ahead;
    let changed = false;

    // Park or drop chunks out of range.
    for (const [i, c] of this.chunks) {
      if (i >= first && i <= last) continue;
      if (c.state === 'active') {
        this.deactivate(c);
        changed = true;
      }
    }
    this.trimCache(first, last);

    // Wanted chunks in priority order: current, then ahead, then behind.
    const wanted: number[] = [];
    for (let i = ci; i <= last; i++) wanted.push(i);
    for (let i = ci - 1; i >= first; i--) wanted.push(i);
    const t0 = performance.now();
    for (const i of wanted) {
      const c = this.chunks.get(i);
      if (c) {
        if (c.state === 'cached') {
          this.activate(c);
          changed = true;
        }
        continue;
      }
      const urgent = immediate || Math.abs(i - ci) <= 1;
      if (!urgent && performance.now() - t0 > A.world.roadBudget) continue;
      const build = this.builder.build(i);
      this.builtCount++;
      const chunk: Chunk = { build, state: 'cached', body: null, colliders: 0 };
      this.chunks.set(i, chunk);
      this.activate(chunk);
      changed = true;
    }
    this.roadMs += performance.now() - t0;
    if (changed) this.revision++;
    if (immediate) {
      // Spawn / teleport: the landscape around the new spot at once.
      const tw = performance.now();
      this.tiles.update(position, Infinity, this.vegetationDistance * 3);
      this.scenery.update(position, this.sNear, FOG_COLOR, 1, A.fog.far * 1.2);
      this.worldMs += performance.now() - tw;
    }
  }

  update(view?: TrackView): void {
    if (!view) return;
    this.roadMs = 0;
    this.worldMs = 0;
    this.vegetationDistance = view.vegetationDistance;
    this.stream(view.camera);
    const tw = performance.now();
    const far = view.cameraFar ?? A.fog.far * 1.2;
    // Landscape trees reach further than the roadside ones: they stand in stands, not rows.
    this.tiles.update(view.camera, A.world.worldBudget, view.vegetationDistance * 3, far * 1.1);
    this.scenery.update(view.camera, this.sNear, view.fogColor ?? FOG_COLOR, view.visibility ?? 1, far);
    this.worldMs += performance.now() - tw;
    for (const c of this.chunks.values()) {
      if (c.state !== 'active') continue;
      const d = c.build.group.position.distanceTo(view.camera) - A.chunk.length;
      const visible = d < view.vegetationDistance;
      for (const m of c.build.vegetation) m.visible = visible;
      const bushes = d < view.vegetationDistance * 0.5;
      for (const m of c.build.shrubs) m.visible = bushes;
    }
  }

  /** Re-applied to every chunk (they share materials). */
  setWetness(wetness: number): void {
    this.wetness = wetness;
    for (const w of this.assets.wettable) applyWetness(w, wetness);
  }

  // --- player safety ---------------------------------------------------------------------

  /** Nearest safe spot on the road: middle lane of the carriageway the car is on, facing its traffic direction. */
  safeRespawn(near: THREE.Vector3): SpawnPoint {
    const s = Math.max(50, this.locate(near));
    const off = this.gen.lateralOffset(near.x, near.z, s);
    const lane = off > 0 ? SECTION.laneB[A.spawn.lane] : SECTION.lanesA[A.spawn.lane];
    const f = this.gen.frame(s);
    const p = this.gen.toWorld(s, lane);
    this.stream(new THREE.Vector3(p.x, p.y, p.z));
    return { position: new THREE.Vector3(p.x, p.y, p.z), yaw: off > 0 ? f.heading + Math.PI : f.heading };
  }

  /** On the carriageways, shoulders or verge (ramps and rest areas count as off the main road). */
  onRoad(pos: THREE.Vector3): boolean {
    const s = this.locate(pos);
    const off = this.gen.lateralOffset(pos.x, pos.z, s);
    const f = this.gen.frame(s);
    return Math.abs(off) <= SECTION.edge + 0.5 && Math.abs(pos.y - f.y) < 8;
  }

  /** Too far from the road (the world is only built along it). */
  outOfBounds(pos: THREE.Vector3): boolean {
    const s = this.locate(pos);
    const off = this.gen.lateralOffset(pos.x, pos.z, s);
    if (Math.abs(off) > A.boundary) return true;
    return pos.y < this.gen.terrainHeight(s, off) - 40;
  }

  /** 0..1: how much roof is over this point (tunnels), smoothed at the portals. */
  coverAt(pos: THREE.Vector3): number {
    const s = this.locate(pos);
    const off = this.gen.lateralOffset(pos.x, pos.z, s);
    if (Math.abs(off) > SECTION.edge + 2) return 0;
    for (const f of this.gen.featuresIn(s - 30, s + 30)) {
      if (f.kind !== 'tunnel') continue;
      const inside = Math.min(s - f.s0, f.s1 - s);
      return Math.max(0, Math.min(1, (inside + 10) / 25));
    }
    return 0;
  }

  /** Road distance of a world point: searched near the player first, anywhere if that is not close. */
  private locate(pos: THREE.Vector3): number {
    const s = this.gen.nearestS(pos.x, pos.z, this.sNear, 600);
    // The window can end before the true nearest point: accept only a point really close to the road.
    const f = this.gen.frame(s);
    if (Math.hypot(pos.x - f.x, pos.z - f.z) < A.boundary * 2) return s;
    return this.gen.nearestSGlobal(pos.x, pos.z);
  }

  // --- debug / admin -------------------------------------------------------------------------

  /** Live numbers for F2. */
  debugInfo(): Record<string, string | number> {
    const f = this.gen.frame(this.sNear);
    const ts = this.tiles.stats();
    let active = 0;
    let cached = 0;
    let meshes = 0;
    let instances = 0;
    let colliders = 0;
    for (const c of this.chunks.values()) {
      if (c.state === 'active') {
        active++;
        meshes += c.build.meshes;
        instances += c.build.instances;
        colliders += c.colliders;
      } else cached++;
    }
    return {
      Seed: this.gen.seed,
      'Konum (km)': (this.sNear / 1000).toFixed(2),
      'Mevcut chunk': Math.floor(this.sNear / A.chunk.length),
      'Aktif / önbellek': `${active} / ${cached}`,
      'Üretilen mesafe (km)': (this.gen.length / 1000).toFixed(1),
      'Eğrilik yarıçapı (m)': f.curvature === 0 ? '∞' : Math.round(1 / Math.abs(f.curvature)),
      'Yükseklik (m)': f.y.toFixed(1),
      'Eğim (%)': (this.gen.gradeAt(this.sNear) * 100).toFixed(1),
      'Banking (°)': ((Math.atan(f.bank) * 180) / Math.PI).toFixed(2),
      Biyom: this.gen.biomeAt(this.sNear, SECTION.edge + 80),
      'Mesh / instance': `${meshes} / ${instances}`,
      'Collider (aktif)': colliders,
      'Toplam üretilen chunk': this.builtCount,
      'Arazi tile (L0/L1/L2/L3)': ts.visible.join(' / '),
      'Arazi tile üretilen / önbellek / kuyruk': `${ts.built} / ${ts.cached} / ${ts.queued}`,
      'Bitki instance (tile)': ts.vegetation,
      'Bina (tile)': ts.buildings,
      'Uzak manzara obje': this.scenery.objectCount,
      'Üretim ms (yol / dünya)': `${this.roadMs.toFixed(2)} / ${this.worldMs.toFixed(2)}`,
      'Tile üretim ms (ort.)': ts.buildMs.toFixed(2),
    };
  }

  /** Landscape tile numbers (tests / F2). */
  worldStats() {
    return this.tiles.stats();
  }

  /** The landscape tiles (tests). */
  get landscape(): TerrainTiles {
    return this.tiles;
  }

  /** Counts for tests: active / cached chunks, colliders and meshes. */
  stats(): { active: number; cached: number; colliders: number; meshes: number; bodies: number } {
    let active = 0;
    let cached = 0;
    let colliders = 0;
    let meshes = 0;
    let bodies = 0;
    for (const c of this.chunks.values()) {
      if (c.state === 'active') active++;
      else cached++;
      colliders += c.colliders;
      meshes += c.build.meshes;
      if (c.body) bodies++;
    }
    return { active, cached, colliders, meshes, bodies };
  }

  /** Throws the world away and builds the road of another seed (F2 debug). */
  regenerate(seed: number): void {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.tiles.dispose();
    this.scenery.dispose();
    this.gen = new RoadGenerator(seed);
    this.laneNetwork = new TrafficLaneNetwork(this.gen);
    this.field = new TerrainField(this.gen);
    this.builder = new ChunkBuilder(this.gen, this.field, this.assets);
    this.makeWorld();
    this.sNear = A.spawn.s;
    this.spawn = this.makeSpawn();
    this.testPoints = this.makeTestPoints();
    this.stream(this.spawn.position, true);
    this.setWetness(this.wetness);
    this.revision++;
  }

  dispose(): void {
    for (const c of this.chunks.values()) this.disposeChunk(c);
    this.chunks.clear();
    this.tiles.dispose();
    this.scenery.dispose();
    this.assets.dispose();
    this.group.removeFromParent();
  }

  // --- internals ------------------------------------------------------------------------------

  private activate(c: Chunk): void {
    const b = c.build;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(b.origin.x, b.origin.y, b.origin.z));
    let n = 0;
    for (const spec of b.colliders) {
      if (spec.kind === 'trimesh') {
        if (spec.indices.length < 3) continue;
        this.world.createCollider(RAPIER.ColliderDesc.trimesh(spec.vertices, spec.indices, RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES).setFriction(0.9), body);
      } else {
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(...spec.half)
            .setTranslation(...spec.pos)
            .setRotation({ x: spec.rot[0], y: spec.rot[1], z: spec.rot[2], w: spec.rot[3] })
            .setFriction(0.3)
            .setRestitution(0.15),
          body,
        );
      }
      n++;
    }
    c.body = body;
    c.colliders = n;
    c.state = 'active';
    this.group.add(b.group);
  }

  private deactivate(c: Chunk): void {
    if (c.body) this.world.removeRigidBody(c.body);
    c.body = null;
    c.colliders = 0;
    c.state = 'cached';
    c.build.group.removeFromParent();
  }

  /** Keeps at most `cache` parked chunks (the nearest to the player); the rest are disposed. */
  private trimCache(first: number, last: number): void {
    const parked = [...this.chunks.entries()].filter(([i, c]) => c.state === 'cached' && (i < first || i > last));
    if (parked.length <= A.chunk.cache) return;
    const mid = (first + last) / 2;
    parked.sort((a, b) => Math.abs(b[0] - mid) - Math.abs(a[0] - mid));
    for (const [i, c] of parked.slice(0, parked.length - A.chunk.cache)) {
      this.disposeChunk(c);
      this.chunks.delete(i);
    }
  }

  private disposeChunk(c: Chunk): void {
    if (c.state === 'active') this.deactivate(c);
    for (const d of c.build.disposables) d.dispose();
    c.build.group.clear();
  }

  private makeSpawn(): SpawnPoint {
    const s = A.spawn.s;
    const p = this.gen.toWorld(s, SECTION.lanesA[A.spawn.lane]);
    return { position: new THREE.Vector3(p.x, p.y, p.z), yaw: this.gen.frame(s).heading };
  }

  /** Start plus the first of each feature (for the admin teleports). */
  private makeTestPoints(): TestPoint[] {
    const out: TestPoint[] = [{ id: 'start', label: 'Start (km 0.6)', ...this.makeSpawn() }];
    this.gen.ensure(30000);
    const labels: Record<string, string> = { tunnel: 'Tünel', bridge: 'Viyadük', exit: 'Ausfahrt', restArea: 'Raststätte', overpass: 'Üst geçit' };
    for (const kind of ['tunnel', 'bridge', 'exit', 'restArea'] as const) {
      const f = this.gen.features.find((x) => x.kind === kind);
      if (!f) continue;
      const s = Math.max(100, f.s0 - 400);
      const p = this.gen.toWorld(s, SECTION.lanesA[A.spawn.lane]);
      out.push({ id: kind, label: `${labels[kind]} (km ${(f.s0 / 1000).toFixed(1)})`, position: new THREE.Vector3(p.x, p.y, p.z), yaw: this.gen.frame(s).heading });
    }
    return out;
  }

  /** Road around the player for the minimap (the road is endless: only the loaded stretch is drawn). */
  private buildMapData(): MapData {
    // Long enough for the big map (M) too.
    const s0 = Math.max(0, this.sNear - 3000);
    const s1 = this.sNear + 4500;
    const line = (fn: (s: number) => [number, number] | null, a: number, b: number, step: number): Float32Array => {
      const pts: number[] = [];
      for (let s = a; s <= b; s += step) {
        const p = fn(s);
        if (p) pts.push(p[0], p[1]);
      }
      return new Float32Array(pts);
    };
    const f = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
    const paths: MapPath[] = [
      {
        kind: 'track',
        points: line(
          (s) => {
            this.gen.frame(s, f);
            return [f.x, f.z];
          },
          s0,
          s1,
          20,
        ),
        closed: false,
        width: SECTION.roadHalf * 2,
      },
    ];
    const markers: MapMarker[] = [];
    for (const ft of this.gen.featuresIn(s0, s1)) {
      if (ft.kind !== 'exit' && ft.kind !== 'restArea') continue;
      paths.push({
        kind: ft.kind === 'restArea' ? 'area' : 'road',
        points: line(
          (s) => {
            const l = rampLayout(ft, s);
            if (!l) return null;
            this.gen.frame(s, f);
            return [f.x + Math.cos(f.heading) * l.centre, f.z - Math.sin(f.heading) * l.centre];
          },
          ft.s0,
          ft.s1,
          10,
        ),
        closed: false,
        width: ft.kind === 'restArea' ? 20 : 8,
      });
      const mid = ft.kind === 'restArea' ? (ft.s0 + ft.s1) / 2 : ft.s0;
      const l = rampLayout(ft, mid);
      this.gen.frame(mid, f);
      const off = l?.centre ?? -SECTION.edge;
      markers.push({ kind: ft.kind === 'restArea' ? 'fuel' : 'poi', x: f.x + Math.cos(f.heading) * off, z: f.z - Math.sin(f.heading) * off, label: ft.name });
    }
    return { paths, markers, viewRadius: 650 };
  }
}
