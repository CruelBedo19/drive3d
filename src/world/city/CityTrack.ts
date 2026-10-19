import * as THREE from 'three';
import { RAPIER } from '../../core/PhysicsWorld';
import type { MapData } from '../../ui/map/MapData';
import type { SpawnPoint, TestPoint, Track, TrackView } from '../Track';
import { applyWetness } from '../weather/wetSurface';
import { nodeName, type CityAssets, type ProtoPart } from './CityAssets';
import type { CityCell } from './CityData';

/** Streaming radii (m, from the cell centre): drawn, detailed (full prototypes) and with colliders. */
const RENDER_RADIUS = 1150;
const DETAIL_RADIUS = 320;
const PHYSICS_RADIUS = 330;
const HYSTERESIS = 120;
/** Build time per frame for cells that are not urgent, ms. */
const BUILD_BUDGET = 4;

type Bucket = 'base' | 'trees' | 'small';

interface CellLook {
  group: THREE.Group;
  buckets: Record<Bucket, THREE.Mesh[]>;
  triangles: number;
  disposables: THREE.BufferGeometry[];
}

interface CellState {
  def: CityCell;
  key: string;
  cx: number;
  cz: number;
  /** Ground meshes (shared, from the loaded city) and merged instances, near (full) and far (LOD). */
  ground: THREE.Group | null;
  near: CellLook | null;
  far: CellLook | null;
  body: RAPIER.RigidBody | null;
  colliders: number;
}

/**
 * The city map: an open-world town (≈ 5.5 × 2.75 km of terrain, ≈ 2 × 2 km of
 * streets) streamed in 250 m cells around the camera.
 *
 * A cell's ground (streets, blocks, beach, hills, bridges) comes baked from
 * the prepared glb; its buildings, trees and props are instances of shared
 * prototypes, merged per material when the cell loads (a handful of draw calls
 * per cell instead of hundreds of objects). Cells further than DETAIL_RADIUS
 * use simplified prototypes (LOD); small things (bushes, bins, signs) and
 * trees are hidden with distance. Only cells around the car get colliders:
 * the baked ground as a trimesh, buildings / big props as oriented boxes,
 * tree trunks as slim boxes, nothing for small decoration.
 */
export class CityTrack implements Track {
  readonly group = new THREE.Group();
  readonly spawn: SpawnPoint;
  readonly testPoints: readonly TestPoint[];
  readonly killHeight: number;
  readonly fog = { near: 180, far: 1250 };
  /** Depth precision for kilometres of facades (z-fighting at 100–300 m); the hood camera still clears it. */
  readonly cameraNear = 0.25;
  readonly attribution = '"drive for speed - map" · amogusstrikesback2 · CC BY-NC 4.0';
  private readonly world: RAPIER.World;
  private readonly assets: CityAssets;
  private readonly cells = new Map<string, CellState>();
  private readonly roadBins = new Map<string, number[]>();
  private readonly wettable: { material: THREE.MeshStandardMaterial; roughness: number; color: THREE.Color }[] = [];
  private readonly ocean: THREE.Mesh;
  private readonly mapCache: MapData;
  private vegetationDistance = 450;
  private focus = new THREE.Vector3();
  /** Build time this frame, ms (F2), and of the first build around the spawn. */
  buildMs = 0;
  initMs = 0;
  builtCount = 0;

  constructor(world: RAPIER.World, assets: CityAssets) {
    this.world = world;
    this.assets = assets;
    this.group.name = 'city';
    const j = assets.data.json;
    for (const def of j.cells) {
      const key = `${def.cx},${def.cz}`;
      this.cells.set(key, { def, key, cx: (def.cx + 0.5) * j.cell, cz: (def.cz + 0.5) * j.cell, ground: null, near: null, far: null, body: null, colliders: 0 });
    }
    // Road points in 50 m bins for the nearest-road search.
    const [off, n] = j.roads;
    const f = assets.data.f32;
    for (let i = 0; i < n; i++) {
      const k = `${Math.floor(f[off + i * 4] / 50)},${Math.floor(f[off + i * 4 + 2] / 50)}`;
      let l = this.roadBins.get(k);
      if (!l) this.roadBins.set(k, (l = []));
      l.push(i);
    }
    this.killHeight = j.bounds.minY - 20;
    this.spawn = { position: new THREE.Vector3(j.spawn.x, j.spawn.y, j.spawn.z), yaw: j.spawn.yaw };
    this.testPoints = [{ id: 'start', label: 'Başlangıç', ...this.spawn }, ...j.teleports.map((t) => ({ id: t.id, label: t.label, position: new THREE.Vector3(t.x, t.y, t.z), yaw: t.yaw }))];
    // Street surfaces get the wet look.
    const seen = new Set<THREE.Material>();
    for (const mesh of assets.ground.values()) {
      const m = mesh.material as THREE.MeshStandardMaterial;
      if (seen.has(m) || !m.isMeshStandardMaterial || !/street|parking|block|piso/i.test(m.name)) continue;
      seen.add(m);
      this.wettable.push({ material: m, roughness: m.roughness, color: m.color.clone() });
    }
    // Sea around the town (visual; falling in respawns the car).
    this.ocean = new THREE.Mesh(new THREE.PlaneGeometry(30000, 30000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x1f4560, roughness: 0.25, metalness: 0.1 }));
    this.ocean.position.set((j.bounds.minX + j.bounds.maxX) / 2, -1.2, (j.bounds.minZ + j.bounds.maxZ) / 2);
    this.ocean.receiveShadow = true;
    this.group.add(this.ocean);
    this.mapCache = { paths: [], markers: [], viewRadius: 260, image: j.minimap };
    const t0 = performance.now();
    this.stream(this.spawn.position, true);
    this.initMs = performance.now() - t0;
  }

  get mapData(): MapData {
    return this.mapCache;
  }

  // --- streaming --------------------------------------------------------------------------

  stream(position: THREE.Vector3, immediate = false): void {
    this.focus.copy(position);
    const t0 = performance.now();
    // Nearest first, so the cells around the car are always ready.
    const order = [...this.cells.values()].map((c) => ({ c, d: Math.hypot(c.cx - position.x, c.cz - position.z) })).sort((a, b) => a.d - b.d);
    for (const { c, d } of order) {
      // Physics around the car only.
      if (d < PHYSICS_RADIUS && !c.body) this.addBody(c);
      else if (d > PHYSICS_RADIUS + HYSTERESIS && c.body) this.removeBody(c);
      if (d > RENDER_RADIUS + HYSTERESIS) {
        this.unload(c);
        continue;
      }
      if (d > RENDER_RADIUS) continue;
      // Spawn / teleport: the cells around the car at once, the rest over the next frames.
      const urgent = d < (immediate ? DETAIL_RADIUS + 150 : 260);
      const budgetLeft = urgent || performance.now() - t0 < BUILD_BUDGET;
      if (!c.ground) this.addGround(c);
      const wantNear = d < DETAIL_RADIUS;
      if (wantNear && !c.near && budgetLeft) c.near = this.buildLook(c, false);
      if (!wantNear && !c.far && budgetLeft) c.far = this.buildLook(c, true);
      // Show the right look (keep the other until the right one exists).
      const show = wantNear ? c.near ?? c.far : c.far ?? c.near;
      for (const look of [c.near, c.far]) if (look) look.group.visible = look === show;
      // Free the detailed look once well outside its range.
      if (d > DETAIL_RADIUS + HYSTERESIS && c.near && c.far) this.disposeLook(c, 'near');
    }
    this.buildMs = performance.now() - t0;
  }

  update(view?: TrackView): void {
    if (!view) return;
    this.vegetationDistance = view.vegetationDistance;
    this.stream(view.camera);
    const smallRange = Math.max(140, this.vegetationDistance * 0.4);
    const treeRange = Math.max(300, this.vegetationDistance * 1.15);
    const cam = view.camera;
    const near = (m: THREE.Mesh, range: number) => {
      const s = m.geometry.boundingSphere!;
      return Math.hypot(s.center.x - cam.x, s.center.z - cam.z) - s.radius < range;
    };
    for (const c of this.cells.values()) {
      for (const look of [c.near, c.far]) {
        if (!look || !look.group.visible) continue;
        for (const m of look.buckets.small) m.visible = near(m, smallRange);
        for (const m of look.buckets.trees) m.visible = near(m, treeRange);
      }
    }
  }

  private addGround(c: CellState): void {
    const g = new THREE.Group();
    g.name = `city-ground-${c.key}`;
    for (const name of c.def.ground) {
      const mesh = this.assets.ground.get(nodeName(name));
      if (!mesh) continue;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    c.ground = g;
    this.group.add(g);
  }

  /** Merges a cell's instances per material (and per culling bucket): full prototypes or their LOD. */
  private buildLook(c: CellState, lod: boolean): CellLook {
    const { data, protos, lods } = this.assets;
    const f = data.f32;
    const [off, n] = c.def.inst;
    type Batch = { parts: { part: ProtoPart; m: THREE.Matrix4 }[]; verts: number; idx: number; material: THREE.Material; bucket: Bucket };
    const batches = new Map<string, Batch>();
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const o = off + i * 13;
      const id = f[o];
      const proto = data.protoById.get(id);
      const parts = (lod ? lods.get(id) : undefined) ?? protos.get(id);
      if (!proto || !parts) continue;
      m.set(f[o + 1], f[o + 4], f[o + 7], f[o + 10], f[o + 2], f[o + 5], f[o + 8], f[o + 11], f[o + 3], f[o + 6], f[o + 9], f[o + 12], 0, 0, 0, 1);
      const small = proto.category === 'prop' || (proto.category === 'vegetation' && !/tree/i.test(proto.name));
      const bucket: Bucket = small ? 'small' : proto.category === 'vegetation' ? 'trees' : 'base';
      // Trees and small things in 125 m sub-blocks: they are hidden with distance, per block.
      const sub = bucket === 'base' ? '' : `${Math.floor((f[o + 10] - c.def.cx * 250) / 125)}${Math.floor((f[o + 12] - c.def.cz * 250) / 125)}`;
      for (const part of parts) {
        const key = `${bucket}|${sub}|${part.material.uuid}`;
        let b = batches.get(key);
        if (!b) batches.set(key, (b = { parts: [], verts: 0, idx: 0, material: part.material, bucket }));
        b.parts.push({ part, m: m.clone() });
        b.verts += part.geometry.getAttribute('position').count;
        b.idx += part.geometry.index ? part.geometry.index.count : part.geometry.getAttribute('position').count;
      }
    }
    const look: CellLook = { group: new THREE.Group(), buckets: { base: [], trees: [], small: [] }, triangles: 0, disposables: [] };
    look.group.name = `city-${lod ? 'far' : 'near'}-${c.key}`;
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    for (const b of batches.values()) {
      const pos = new Float32Array(b.verts * 3);
      const nor = new Float32Array(b.verts * 3);
      const uv = new Float32Array(b.verts * 2);
      const index = new Uint32Array(b.idx);
      let vo = 0;
      let io = 0;
      for (const { part, m: pm } of b.parts) {
        const g = part.geometry;
        const p = g.getAttribute('position') as THREE.BufferAttribute;
        const nA = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
        const uA = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
        nm.getNormalMatrix(pm);
        for (let k = 0; k < p.count; k++) {
          v.fromBufferAttribute(p, k).applyMatrix4(pm);
          pos[(vo + k) * 3] = v.x;
          pos[(vo + k) * 3 + 1] = v.y;
          pos[(vo + k) * 3 + 2] = v.z;
          if (nA) {
            v.fromBufferAttribute(nA, k).applyMatrix3(nm).normalize();
            nor[(vo + k) * 3] = v.x;
            nor[(vo + k) * 3 + 1] = v.y;
            nor[(vo + k) * 3 + 2] = v.z;
          }
          if (uA) {
            uv[(vo + k) * 2] = uA.getX(k);
            uv[(vo + k) * 2 + 1] = uA.getY(k);
          }
        }
        if (g.index) {
          const ia = g.index.array;
          for (let k = 0; k < ia.length; k++) index[io + k] = ia[k] + vo;
          io += ia.length;
        } else {
          for (let k = 0; k < p.count; k++) index[io + k] = vo + k;
          io += p.count;
        }
        vo += p.count;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, b.material);
      // Only the detailed cells (around the car, where the shadow map is) cast shadows.
      mesh.castShadow = !lod && b.bucket !== 'small';
      mesh.receiveShadow = true;
      look.group.add(mesh);
      look.buckets[b.bucket].push(mesh);
      look.disposables.push(geo);
      look.triangles += index.length / 3;
    }
    this.group.add(look.group);
    this.builtCount++;
    return look;
  }

  private disposeLook(c: CellState, which: 'near' | 'far'): void {
    const look = c[which];
    if (!look) return;
    look.group.removeFromParent();
    for (const g of look.disposables) g.dispose();
    c[which] = null;
  }

  private unload(c: CellState): void {
    this.disposeLook(c, 'near');
    this.disposeLook(c, 'far');
    if (c.ground) {
      // Ground meshes belong to the loaded city (reused by the next session): only detach them.
      c.ground.removeFromParent();
      c.ground.clear();
      c.ground = null;
    }
  }

  private addBody(c: CellState): void {
    const { f32, u32 } = this.assets.data;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    let n = 0;
    const [vo, vc, io, tc] = c.def.trimesh;
    if (tc > 0) {
      // Already welded and cleaned by the prepare step.
      const verts = f32.slice(vo, vo + vc * 3);
      const idx = u32.slice(io, io + tc * 3);
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(0.9), body);
      n++;
    }
    const [bo, bc] = c.def.boxes;
    for (let i = 0; i < bc; i++) {
      const o = bo + i * 10;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(Math.max(0.05, f32[o + 3]), Math.max(0.05, f32[o + 4]), Math.max(0.05, f32[o + 5]))
          .setTranslation(f32[o], f32[o + 1], f32[o + 2])
          .setRotation({ x: f32[o + 6], y: f32[o + 7], z: f32[o + 8], w: f32[o + 9] })
          .setFriction(0.4)
          .setRestitution(0.1),
        body,
      );
      n++;
    }
    c.body = body;
    c.colliders = n;
  }

  private removeBody(c: CellState): void {
    if (c.body) this.world.removeRigidBody(c.body);
    c.body = null;
    c.colliders = 0;
  }

  // --- player safety ------------------------------------------------------------------------

  /** Nearest road point (prefers points at about the car's height: under a bridge stays under it). */
  safeRespawn(near: THREE.Vector3): SpawnPoint {
    const p = this.nearestRoad(near);
    return { position: new THREE.Vector3(p[0], p[1], p[2]), yaw: p[3] };
  }

  /** Road point [x, y, z, heading] closest to a world position. */
  nearestRoad(pos: THREE.Vector3): [number, number, number, number] {
    const f = this.assets.data.f32;
    const off = this.assets.data.json.roads[0];
    let best = -1;
    let bestD = Infinity;
    const bx = Math.floor(pos.x / 50);
    const bz = Math.floor(pos.z / 50);
    for (let r = 1; r < 80 && best < 0; r += r < 4 ? 1 : 8) {
      for (let i = -r; i <= r; i++) for (let k = -r; k <= r; k++) {
        for (const j of this.roadBins.get(`${bx + i},${bz + k}`) ?? []) {
          const o = off + j * 4;
          const d = (f[o] - pos.x) ** 2 + (f[o + 2] - pos.z) ** 2 + ((f[o + 1] - pos.y) * 3) ** 2;
          if (d < bestD) {
            bestD = d;
            best = j;
          }
        }
      }
    }
    const o = off + Math.max(0, best) * 4;
    return [f[o], f[o + 1], f[o + 2], f[o + 3]];
  }

  outOfBounds(pos: THREE.Vector3): boolean {
    const b = this.assets.data.json.bounds;
    return pos.x < b.minX - 150 || pos.x > b.maxX + 150 || pos.z < b.minZ - 150 || pos.z > b.maxZ + 150;
  }

  /** On a street (within ~6 m of a road point at about the same height). */
  onRoad(pos: THREE.Vector3): boolean {
    const p = this.nearestRoad(pos);
    return Math.hypot(p[0] - pos.x, p[2] - pos.z) < 7 && Math.abs(p[1] - pos.y) < 4;
  }

  setWetness(wetness: number): void {
    for (const w of this.wettable) applyWetness(w, wetness);
  }

  // --- debug --------------------------------------------------------------------------------

  stats(): { cells: number; drawn: number; detailed: number; physics: number; colliders: number; triangles: number; meshes: number; byBucket: Record<'ground' | 'base' | 'trees' | 'small', number> } {
    let drawn = 0;
    let detailed = 0;
    let physics = 0;
    let colliders = 0;
    let triangles = 0;
    let meshes = 0;
    const byBucket = { ground: 0, base: 0, trees: 0, small: 0 };
    for (const c of this.cells.values()) {
      if (c.ground) {
        drawn++;
        meshes += c.ground.children.length;
        for (const m of c.ground.children) {
          const n = ((m as THREE.Mesh).geometry.index?.count ?? (m as THREE.Mesh).geometry.getAttribute('position').count) / 3;
          triangles += n;
          byBucket.ground += n;
        }
      }
      const look = c.near?.group.visible ? c.near : c.far?.group.visible ? c.far : null;
      if (c.near?.group.visible) detailed++;
      if (look) {
        for (const b of ['base', 'trees', 'small'] as const) for (const m of look.buckets[b]) if (m.visible) {
          meshes++;
          const n = (m.geometry.index?.count ?? 0) / 3;
          triangles += n;
          byBucket[b] += n;
        }
      }
      if (c.body) {
        physics++;
        colliders += c.colliders;
      }
    }
    for (const k of Object.keys(byBucket) as (keyof typeof byBucket)[]) byBucket[k] = Math.round(byBucket[k]);
    return { cells: this.cells.size, drawn, detailed, physics, colliders, triangles: Math.round(triangles), meshes, byBucket };
  }

  debugInfo(): Record<string, string | number> {
    const s = this.stats();
    const p = this.nearestRoad(this.focus);
    return {
      'Hücre (toplam / çizilen / detaylı)': `${s.cells} / ${s.drawn} / ${s.detailed}`,
      'Fizik hücresi / collider': `${s.physics} / ${s.colliders}`,
      'Görünür mesh / üçgen': `${s.meshes} / ${s.triangles}`,
      'Üçgen (zemin / bina / ağaç / küçük)': `${s.byBucket.ground} / ${s.byBucket.base} / ${s.byBucket.trees} / ${s.byBucket.small}`,
      'Üretim ms (bu kare / ilk kurulum)': `${this.buildMs.toFixed(2)} / ${this.initMs.toFixed(0)}`,
      'Toplam üretilen görünüm': this.builtCount,
      'En yakın yol (m)': Math.hypot(p[0] - this.focus.x, p[2] - this.focus.z).toFixed(1),
    };
  }

  // --- audit overlay (F2) --------------------------------------------------------------------

  private debugMeshes = new Map<string, THREE.Object3D>();
  private debugOn = new Set<string>();
  private debugData: Promise<{ kinds: string[]; counts: number[]; tris: Float32Array } | null> | null = null;

  debugLayers(): { id: string; label: string; on: boolean }[] {
    const labels: [string, string][] = [
      ['likelyZFight', 'Z-fighting adayları'],
      ['layered', 'Kontrollü katman (1.5 mm-1 cm)'],
      ['distanceZFight', 'Uzakta z-fighting'],
      ['backToBack', 'Sırt sırta yüzeyler'],
      ['safeDuplicate', 'Kopya yüzeyler'],
      ['intersection', 'Şüpheli kesişimler'],
      ['seam', 'Chunk sınırı kopyaları'],
      ['cells', 'Chunk sınırları'],
    ];
    return labels.map(([id, label]) => ({ id, label, on: this.debugOn.has(id) }));
  }

  setDebugLayer(id: string, on: boolean): void {
    if (on) this.debugOn.add(id);
    else this.debugOn.delete(id);
    const existing = this.debugMeshes.get(id);
    if (existing) {
      existing.visible = on;
      return;
    }
    if (!on) return;
    if (id === 'cells') {
      const j = this.assets.data.json;
      const pts: number[] = [];
      const b = j.bounds;
      for (let x = Math.floor(b.minX / j.cell) * j.cell; x <= b.maxX; x += j.cell) pts.push(x, 1, b.minZ, x, 1, b.maxZ);
      for (let z = Math.floor(b.minZ / j.cell) * j.cell; z <= b.maxZ; z += j.cell) pts.push(b.minX, 1, z, b.maxX, 1, z);
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)), new THREE.LineBasicMaterial({ color: 0xff3df5 }));
      this.group.add(lines);
      this.debugMeshes.set(id, lines);
      return;
    }
    this.debugData ??= fetch('/assets/city/city-debug.json')
      .then(async (r) => {
        const meta = (await r.json()) as { kinds: string[]; counts: number[] };
        const bin = await (await fetch('/assets/city/city-debug.bin')).arrayBuffer();
        return { ...meta, tris: new Float32Array(bin) };
      })
      .catch(() => null);
    void this.debugData.then((d) => {
      if (!d || this.debugMeshes.has(id)) return;
      const k = d.kinds.indexOf(id);
      if (k < 0) return;
      const start = d.counts.slice(0, k).reduce((s, n) => s + n, 0) * 9;
      const tris = d.tris.slice(start, start + d.counts[k] * 9);
      const colours: Record<string, number> = { layered: 0x5aff5a, likelyZFight: 0xff2a2a, distanceZFight: 0xff9a2a, backToBack: 0x2a8cff, safeDuplicate: 0xffee2a, intersection: 0xb02aff, seam: 0x2affd0 };
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(tris, 3));
      // Drawn over the surfaces (polygon offset towards the camera, translucent): a debug view only.
      const mat = new THREE.MeshBasicMaterial({ color: colours[id] ?? 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8, fog: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 20;
      mesh.visible = this.debugOn.has(id);
      this.group.add(mesh);
      this.debugMeshes.set(id, mesh);
    });
  }

  dispose(): void {
    for (const o of this.debugMeshes.values()) {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
      o.removeFromParent();
    }
    for (const c of this.cells.values()) {
      this.unload(c);
      this.removeBody(c);
    }
    this.ocean.geometry.dispose();
    (this.ocean.material as THREE.Material).dispose();
    this.setWetness(0);
    this.group.removeFromParent();
  }
}
