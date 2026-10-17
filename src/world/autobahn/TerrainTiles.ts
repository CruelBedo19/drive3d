import * as THREE from 'three';
import { AUTOBAHN as A } from '../../config/tracks';
import type { AutobahnAssets } from './AutobahnAssets';
import { BIOME_COUNT, BiomeMap } from './BiomeMap';
import { placeTree, treeDensity } from './ChunkBuilder';
import { hash2 } from './noise';
import { SECTION } from './RoadGenerator';
import { TerrainField } from './TerrainField';

const W = A.world;
const LEVELS = W.levels;

interface TileSpec {
  level: number;
  ix: number;
  iz: number;
  key: string;
}

interface Tile extends TileSpec {
  group: THREE.Group;
  /** Tree / building instances, culled by the vegetation distance. */
  vegetation: THREE.InstancedMesh[];
  vegInstances: number;
  buildings: number;
  disposables: { dispose(): void }[];
  cx: number;
  cz: number;
  size: number;
  lastUsed: number;
}

export interface TileStats {
  /** Tiles per level in the current rings, and how many of them are drawn (not beyond the far plane). */
  visible: number[];
  drawn: number;
  built: number;
  cached: number;
  queued: number;
  vegetation: number;
  buildings: number;
  /** Average build time of the last tiles, ms. */
  buildMs: number;
}

/**
 * The endless landscape around the road: square terrain tiles in nested LOD
 * rings around the camera. Level k tiles are `tile·2^k` metres with a fixed
 * vertex count, so detail halves with each ring. Level k covers the 3×3 tiles
 * of level k+1 around the camera minus what level k-1 covers, which keeps the
 * rings aligned and gap-free; skirts hide the small height steps where two
 * levels meet. Heights, colours and plants all come from TerrainField, the
 * same function the road chunks use, and inside the road corridor the tiles
 * sink under the chunks' detailed ribbons (polygon offset settles the rest).
 *
 * Tiles are built nearest-first within a per-frame time budget; the old set
 * stays visible until the new one is complete, then tiles that left the rings
 * are parked in a small cache and finally disposed.
 *
 * Ring layout after Procedural Terrains (ZyFou, MIT: chunk rings, skirts,
 * budgeted radial build queue) and Nightdrive (nested terrain rings around the
 * camera, tiles coordinated with a road corridor); own implementation.
 */
export class TerrainTiles {
  readonly group = new THREE.Group();
  private readonly field: TerrainField;
  private readonly assets: AutobahnAssets;
  private readonly tiles = new Map<string, Tile>();
  private desired: TileSpec[] = [];
  private desiredKeys = new Set<string>();
  private visibleKeys = new Set<string>();
  private queue: TileSpec[] = [];
  private ringKey = '';
  private frame = 0;
  private buildTimes: number[] = [];
  builtCount = 0;
  // Scratch buffers sized for the largest tile (segments + 3 border vertices per side).
  private readonly hBuf: Float64Array;
  private readonly offBuf: Float64Array;
  private readonly sBuf: Float64Array;
  private readonly roadBuf: Uint8Array;
  private readonly portalBuf: Uint8Array;
  private readonly wBuf: Float32Array;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly bw = new Float32Array(BIOME_COUNT);
  private readonly heightMemo = new Map<string, Float32Array>();

  constructor(field: TerrainField, assets: AutobahnAssets) {
    this.field = field;
    this.assets = assets;
    this.group.name = 'autobahn-landscape';
    const n = (Math.max(...W.segments) + 3) ** 2;
    this.hBuf = new Float64Array(n);
    this.offBuf = new Float64Array(n);
    this.sBuf = new Float64Array(n);
    this.roadBuf = new Uint8Array(n);
    this.portalBuf = new Uint8Array(n);
    this.wBuf = new Float32Array(n * BIOME_COUNT);
  }

  /** Tile size of a level, m. */
  static size(level: number): number {
    return W.tile * 2 ** level;
  }

  /**
   * Keeps the rings around `cam` built. `budgetMs` = build time allowed now
   * (Infinity: everything at once). `vegRange`: trees / buildings farther are hidden.
   */
  update(cam: THREE.Vector3, budgetMs: number, vegRange: number, maxDistance = Infinity): void {
    this.frame++;
    const c: number[] = [];
    for (let k = 1; k <= LEVELS; k++) c.push(Math.floor(cam.x / TerrainTiles.size(k)), Math.floor(cam.z / TerrainTiles.size(k)));
    const key = c.join(',');
    if (key !== this.ringKey) {
      this.ringKey = key;
      this.desired = this.computeDesired(cam);
      this.desiredKeys = new Set(this.desired.map((d) => d.key));
      // Finer and nearer first.
      this.queue = this.desired.filter((d) => !this.tiles.has(d.key));
      const dist = (d: TileSpec) => {
        const s = TerrainTiles.size(d.level);
        return Math.hypot((d.ix + 0.5) * s - cam.x, (d.iz + 0.5) * s - cam.z);
      };
      this.queue.sort((a, b) => a.level - b.level || dist(a) - dist(b));
    }
    const t0 = performance.now();
    while (this.queue.length > 0 && (budgetMs === Infinity || performance.now() - t0 < budgetMs)) {
      const spec = this.queue.shift()!;
      if (this.tiles.has(spec.key)) continue;
      const tb = performance.now();
      const tile = this.build(spec);
      this.buildTimes.push(performance.now() - tb);
      if (this.buildTimes.length > 32) this.buildTimes.shift();
      this.tiles.set(spec.key, tile);
      this.builtCount++;
    }
    if (this.tiles.size > this.desiredKeys.size + W.cache) this.trimCache();
    // Swap to the new set only once all of it exists (no holes while building).
    if (this.queue.length === 0 && !sameSet(this.visibleKeys, this.desiredKeys)) {
      for (const k of this.visibleKeys) if (!this.desiredKeys.has(k)) this.tiles.get(k)?.group.removeFromParent();
      for (const k of this.desiredKeys) {
        const t = this.tiles.get(k);
        if (t && !t.group.parent) this.group.add(t.group);
      }
      this.visibleKeys = new Set(this.desiredKeys);
      this.trimCache();
    }
    for (const k of this.visibleKeys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      t.lastUsed = this.frame;
      const d = Math.max(0, Math.hypot(t.cx - cam.x, t.cz - cam.z) - t.size * 0.7);
      t.group.visible = d < maxDistance;
      const veg = d < vegRange;
      for (const m of t.vegetation) m.visible = veg;
    }
  }

  stats(): TileStats {
    const visible = new Array(LEVELS).fill(0);
    let vegetation = 0;
    let buildings = 0;
    let drawn = 0;
    for (const k of this.visibleKeys) {
      const t = this.tiles.get(k);
      if (!t) continue;
      visible[t.level]++;
      if (!t.group.visible) continue;
      drawn++;
      if (t.vegetation.some((m) => m.visible)) {
        vegetation += t.vegInstances;
        buildings += t.buildings;
      }
    }
    const buildMs = this.buildTimes.length ? this.buildTimes.reduce((a, b) => a + b, 0) / this.buildTimes.length : 0;
    let cached = 0;
    for (const k of this.tiles.keys()) if (!this.visibleKeys.has(k) && !this.desiredKeys.has(k)) cached++;
    return { visible, drawn, built: this.builtCount, cached, queued: this.queue.length, vegetation, buildings, buildMs };
  }

  /** Heights of a tile's vertices (tests: seams and determinism). */
  tileHeights(level: number, ix: number, iz: number): Float32Array {
    const key = `${level}:${ix}:${iz}`;
    const memo = this.heightMemo.get(key);
    if (memo) return memo;
    const t = this.tiles.get(key) ?? this.build({ level, ix, iz, key: '' });
    const mesh = t.group.children[0] as THREE.Mesh;
    const pos = mesh.geometry.attributes.position;
    const segs = W.segments[level];
    const out = new Float32Array((segs + 1) ** 2);
    for (let i = 0; i < out.length; i++) out[i] = pos.getY(i);
    if (!this.tiles.has(key)) disposeTile(t);
    if (this.heightMemo.size > 256) this.heightMemo.clear();
    this.heightMemo.set(key, out);
    return out;
  }

  /** Rendered surface height of a level's tile at world (x, z), exactly as triangulated (tests: LOD seams). */
  surfaceAt(level: number, x: number, z: number): number {
    const size = TerrainTiles.size(level);
    const ix = Math.floor(x / size);
    const iz = Math.floor(z / size);
    const h = this.tileHeights(level, ix, iz);
    const segs = W.segments[level];
    const step = size / segs;
    const u = (x - ix * size) / step;
    const v = (z - iz * size) / step;
    const i = Math.min(segs - 1, Math.floor(u));
    const j = Math.min(segs - 1, Math.floor(v));
    const fu = u - i;
    const fv = v - j;
    const a = h[j * (segs + 1) + i];
    const b = h[j * (segs + 1) + i + 1];
    const c = h[(j + 1) * (segs + 1) + i];
    const d = h[(j + 1) * (segs + 1) + i + 1];
    // Triangles (a, c, b) and (b, c, d).
    return fu + fv <= 1 ? a + (b - a) * fu + (c - a) * fv : d + (c - d) * (1 - fu) + (b - d) * (1 - fv);
  }

  /** Keys of the tiles currently shown (tests). */
  get visibleTiles(): readonly string[] {
    return [...this.visibleKeys];
  }

  dispose(): void {
    for (const t of this.tiles.values()) disposeTile(t);
    this.tiles.clear();
    this.visibleKeys.clear();
    this.group.removeFromParent();
  }

  // --- internals ------------------------------------------------------------------------------

  private computeDesired(cam: THREE.Vector3): TileSpec[] {
    const out: TileSpec[] = [];
    for (let k = 0; k < LEVELS; k++) {
      const up = TerrainTiles.size(k + 1);
      const cx1 = Math.floor(cam.x / up);
      const cz1 = Math.floor(cam.z / up);
      const ck = TerrainTiles.size(k);
      const cxk = Math.floor(cam.x / ck);
      const czk = Math.floor(cam.z / ck);
      for (let ix = 2 * cx1 - 2; ix <= 2 * cx1 + 3; ix++) {
        for (let iz = 2 * cz1 - 2; iz <= 2 * cz1 + 3; iz++) {
          // The finer level already covers the 3×3 tiles around the camera.
          if (k > 0 && Math.abs(ix - cxk) <= 1 && Math.abs(iz - czk) <= 1) continue;
          out.push({ level: k, ix, iz, key: `${k}:${ix}:${iz}` });
        }
      }
    }
    return out;
  }

  private trimCache(): void {
    const parked = [...this.tiles.values()].filter((t) => !this.visibleKeys.has(t.key) && !this.desiredKeys.has(t.key));
    if (parked.length <= W.cache) return;
    parked.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of parked.slice(0, parked.length - W.cache)) {
      disposeTile(t);
      this.tiles.delete(t.key);
    }
  }

  private build(spec: TileSpec): Tile {
    const { level, ix, iz } = spec;
    const field = this.field;
    const gen = field.gen;
    const size = TerrainTiles.size(level);
    const segs = W.segments[level];
    const step = size / segs;
    const x0 = ix * size;
    const z0 = iz * size;
    const n = segs + 3; // one extra ring of samples on every side (for seamless normals)
    const H = this.hBuf;
    const OFF = this.offBuf;
    const S = this.sBuf;
    const ROAD = this.roadBuf;
    const WB = this.wBuf;
    const PORTAL = this.portalBuf;
    let guess = gen.nearestSGlobal(x0 + size / 2, z0 + size / 2);
    for (let j = 0; j < n; j++) {
      let rowGuess = j > 0 ? S[(j - 1) * n] : guess;
      for (let i = 0; i < n; i++) {
        const x = x0 + (i - 1) * step;
        const z = z0 + (j - 1) * step;
        const k = j * n + i;
        const h = field.height(x, z, rowGuess);
        rowGuess = field.s;
        S[k] = field.s;
        OFF[k] = field.off;
        ROAD[k] = field.onRoad ? 1 : 0;
        H[k] = ROAD[k] ? this.sunk(h, field.s, field.off, step * 1.5) : h;
        PORTAL[k] = ROAD[k] ? this.portalCode : 0;
        WB.set(gen.weights, k * BIOME_COUNT);
      }
      guess = S[j * n];
    }

    // Geometry: (segs+1)² grid + a skirt ring below the border.
    const gridN = (segs + 1) ** 2;
    const skirtN = 4 * segs;
    const pos = new Float32Array((gridN + skirtN) * 3);
    const nor = new Float32Array((gridN + skirtN) * 3);
    const col = new Float32Array((gridN + skirtN) * 3);
    const uv = new Float32Array((gridN + skirtN) * 2);
    const at = (i: number, j: number) => (j + 1) * n + (i + 1);
    let sumH = 0;
    for (let j = 0; j <= segs; j++) {
      for (let i = 0; i <= segs; i++) {
        const v = j * (segs + 1) + i;
        const k = at(i, j);
        const hx = (H[at(i + 1, j)] - H[at(i - 1, j)]) / (2 * step);
        const hz = (H[at(i, j + 1)] - H[at(i, j - 1)]) / (2 * step);
        const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
        pos[v * 3] = i * step;
        pos[v * 3 + 1] = H[k];
        pos[v * 3 + 2] = j * step;
        nor[v * 3] = -hx * inv;
        nor[v * 3 + 1] = inv;
        nor[v * 3 + 2] = -hz * inv;
        uv[v * 2] = (x0 + i * step) / 12;
        uv[v * 2 + 1] = (z0 + j * step) / 12;
        sumH += H[k];
        this.bw.set(WB.subarray(k * BIOME_COUNT, (k + 1) * BIOME_COUNT));
        // Distant tiles carry no trees: forests read as their canopy colour there.
        const canopy = level === 0 ? 0 : level === 1 ? 0.45 : 1;
        field.colour(x0 + i * step, z0 + j * step, this.bw, inv, canopy, ROAD[k] ? OFF[k] : 1e4, col, v * 3);
      }
    }
    // Skirt ring: border vertices in order around the tile, dropped by the level's skirt depth.
    const border: number[] = [];
    for (let i = 0; i < segs; i++) border.push(i); // north edge (j = 0), west → east
    for (let j = 0; j < segs; j++) border.push(j * (segs + 1) + segs); // east edge
    for (let i = segs; i > 0; i--) border.push(segs * (segs + 1) + i); // south edge
    for (let j = segs; j > 0; j--) border.push(j * (segs + 1)); // west edge
    const drop = W.skirt[level];
    border.forEach((b, e) => {
      const v = gridN + e;
      pos[v * 3] = pos[b * 3];
      pos[v * 3 + 1] = pos[b * 3 + 1] - drop;
      pos[v * 3 + 2] = pos[b * 3 + 2];
      for (let c = 0; c < 3; c++) {
        nor[v * 3 + c] = nor[b * 3 + c];
        col[v * 3 + c] = col[b * 3 + c] * 0.85;
      }
      uv[v * 2] = uv[b * 2];
      uv[v * 2 + 1] = uv[b * 2 + 1];
    });
    const idx: number[] = [];
    for (let j = 0; j < segs; j++) {
      for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i;
        const b = a + 1;
        const c = a + segs + 1;
        const d = c + 1;
        // A cell spanning a portal (tube lid on one side, road level on the other) would stand as a
        // slab in front of the opening: leave it out, the chunk's hill ribbon and portal face cover the spot.
        let codes = 0;
        for (const [ci, cj] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) codes |= 1 << PORTAL[at(ci, cj)];
        if ((codes & 6) === 6) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
    for (let e = 0; e < border.length; e++) {
      const a = border[e];
      const b = border[(e + 1) % border.length];
      const sa = gridN + e;
      const sb = gridN + ((e + 1) % border.length);
      // Both windings: a skirt is only ever seen from outside, from either side of the seam.
      idx.push(a, sa, b, b, sa, sb, a, b, sa, b, sb, sa);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.assets.terrainFar);
    mesh.receiveShadow = level === 0;
    mesh.name = `tile-${spec.key}`;
    const group = new THREE.Group();
    group.position.set(x0, 0, z0);
    group.add(mesh);
    const tile: Tile = { ...spec, key: spec.key || `${level}:${ix}:${iz}`, group, vegetation: [], vegInstances: 0, buildings: 0, disposables: [geo], cx: x0 + size / 2, cz: z0 + size / 2, size, lastUsed: this.frame };
    if (level <= 1) this.plant(tile, x0, z0, size, step, segs);
    void sumH;
    return tile;
  }

  /**
   * Height of a tile vertex inside the road corridor: sunk under the chunk ribbons, but over a
   * tunnel never into the tube (a coarse triangle would cut through its walls).
   */
  private sunk(h: number, s: number, off: number, margin: number): number {
    const out = h - TerrainField.corridorSink(off);
    this.portalCode = 0;
    // Within one grid step of the tube a vertex could pull a triangle into it.
    if (Math.abs(off) > SECTION.edge + 8 + margin) return out;
    for (const ft of this.field.gen.featuresIn(s - margin, s + margin)) {
      if (ft.kind !== 'tunnel') continue;
      const roof = this.field.gen.frame(s, this.fr).y + A.features.tunnel.height + 1.5;
      // Between the portals: always over the roof (the hill ribbon hides it); just outside: no lid.
      const inside = s >= ft.s0 && s <= ft.s1;
      this.portalCode = inside ? 1 : 2;
      return inside ? Math.max(out, roof) : Math.max(out, Math.min(h, roof));
    }
    return out;
  }
  /** Set by sunk(): 1 = over a tunnel tube, 2 = just outside a portal, 0 = elsewhere. */
  private portalCode = 0;
  private readonly fr = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };

  /** Trees (levels 0-1) and buildings outside the road corridor, from the biome weights. */
  private plant(tile: Tile, x0: number, z0: number, size: number, step: number, segs: number): void {
    const field = this.field;
    const gen = field.gen;
    const level = tile.level;
    const cell = W.treeCell[level];
    const seed = (gen.seed ^ 0x7ee5 ^ (level * 7919)) >>> 0;
    const n = segs + 3;
    const inst = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; list: THREE.Matrix4[] }>();
    const add = (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4) => {
      let e = inst.get(key);
      if (!e) inst.set(key, (e = { geo, mat, list: [] }));
      e.list.push(m.clone());
    };
    // Road coordinate guess for a point: from the nearest stored vertex.
    const guessAt = (x: number, z: number) => {
      const i = Math.max(0, Math.min(segs, Math.round((x - x0) / step)));
      const j = Math.max(0, Math.min(segs, Math.round((z - z0) / step)));
      return this.sBuf[(j + 1) * n + (i + 1)];
    };
    const minOff = A.world.corridor + (level === 0 ? -2 : 25);
    const cells = Math.floor(size / cell);
    let id = 0;
    for (let cz = 0; cz < cells; cz++) {
      for (let cx = 0; cx < cells; cx++) {
        id++;
        const gx = tile.ix * cells + cx;
        const gz = tile.iz * cells + cz;
        const h0 = hash2(seed, gx, gz);
        const x = x0 + (cx + hash2(seed + 1, gx, gz)) * cell;
        const z = z0 + (cz + hash2(seed + 2, gx, gz)) * cell;
        field.project(x, z, guessAt(x, z));
        if (field.onRoad && Math.abs(field.off) < minOff) continue;
        const w = field.onRoad ? gen.biomeWeights(field.s, field.off, x, z, gen.weights) : gen.biome.weights(x, z, gen.weights);
        if (h0 > treeDensity(w, seed, x, z)) continue;
        const conifer = hash2(seed + 3, gx, gz) < BiomeMap.mix(w, 'conifer');
        const y = field.onRoad ? gen.worldHeight(field.s, field.off, x, z) : gen.farHeight(x, z, w);
        if (level === 0) {
          placeTree(this.assets, seed, gx * 7 + gz * 131071, x - x0, y, z - z0, conifer, add, this.m, this.q, this.v, this.sc);
        } else {
          // Crown-only stand-in, a little larger: reads as forest at 0.5-1.5 km.
          const tall = 13 + hash2(seed + 4, gx, gz) * 9;
          const r = conifer ? 3 + hash2(seed + 5, gx, gz) * 1.5 : 4.5 + hash2(seed + 5, gx, gz) * 2;
          this.q.identity();
          this.m.compose(this.v.set(x - x0, y - 1, z - z0), this.q, this.sc.set(r, tall, r));
          add('far', this.assets.farTreeGeo, this.assets.farTree, this.m);
        }
      }
    }
    // Sheds, barns and warehouses: industrial areas and farmland.
    const bcell = 110;
    const bcells = Math.floor(size / bcell);
    for (let cz = 0; cz < bcells; cz++) {
      for (let cx = 0; cx < bcells; cx++) {
        const gx = Math.floor(x0 / bcell) + cx;
        const gz = Math.floor(z0 / bcell) + cz;
        const x = (gx + 0.2 + hash2(seed + 11, gx, gz) * 0.6) * bcell;
        const z = (gz + 0.2 + hash2(seed + 12, gx, gz) * 0.6) * bcell;
        field.project(x, z, guessAt(x, z));
        if (field.onRoad && Math.abs(field.off) < A.world.corridor + 20) continue;
        const w = field.onRoad ? gen.biomeWeights(field.s, field.off, x, z, gen.weights) : gen.biome.weights(x, z, gen.weights);
        const p = BiomeMap.mix(w, 'buildings');
        if (hash2(seed + 13, gx, gz) > p) continue;
        const industrial = BiomeMap.dominant(w) === 'industrial';
        const y = field.onRoad ? gen.worldHeight(field.s, field.off, x, z) : gen.farHeight(x, z, w);
        const r = hash2(seed + 14, gx, gz);
        const bw = industrial ? 30 + r * 40 : 10 + r * 10;
        const bd = industrial ? 20 + hash2(seed + 15, gx, gz) * 30 : 8 + r * 6;
        const bh = industrial ? 8 + hash2(seed + 16, gx, gz) * 7 : 5 + r * 3;
        this.q.setFromAxisAngle(this.v.set(0, 1, 0), hash2(seed + 17, gx, gz) < 0.5 ? 0 : Math.PI / 2);
        this.m.compose(this.v.set(x - x0, y + bh / 2 - 1, z - z0), this.q, this.sc.set(bw, bh + 2, bd));
        add('building', this.assets.box, this.assets.building, this.m);
        this.m.compose(this.v.set(x - x0, y + bh + 1.1, z - z0), this.q, this.sc.set(bw + 0.6, 0.4, bd + 0.6));
        add('roof', this.assets.box, industrial ? this.assets.concrete : this.assets.roof, this.m);
        tile.buildings++;
      }
    }
    for (const [key, e] of inst) {
      const mesh = new THREE.InstancedMesh(e.geo, e.mat, e.list.length);
      e.list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = level === 0 && key !== 'far';
      mesh.receiveShadow = level === 0;
      tile.group.add(mesh);
      tile.vegetation.push(mesh);
      if (key !== 'building' && key !== 'roof') tile.vegInstances += key === 'trunk' ? 0 : e.list.length;
      tile.disposables.push({ dispose: () => mesh.dispose() });
    }
  }
}

function disposeTile(t: Tile): void {
  t.group.removeFromParent();
  for (const d of t.disposables) d.dispose();
  t.group.clear();
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}
