/**
 * Builds one Autobahn chunk: the world slice s ∈ [s0, s1]. Everything is a pure
 * function of the generator (seed) and the chunk index, so a chunk rebuilt
 * later is identical. Geometry is merged per material and positioned relative
 * to the chunk origin (keeps float32 vertex precision far from the world
 * origin); repeated props are instanced. Collision is returned as specs (one
 * road trimesh, one terrain-band trimesh, ramp trimeshes, box segments for
 * barriers) for the track to turn into one fixed Rapier body.
 *
 * Ideas from Three.js Driving Simulator (chunk = reusable world slice with every
 * feature overlapping it; ribbons share edges so joins are invisible; small Y
 * stacking for markings) and Nightdrive (road ribbons + carved terrain apron,
 * instanced vegetation rejected near the road). Own code.
 */
import * as THREE from 'three';
import { AUTOBAHN as A } from '../../config/tracks';
import type { AutobahnAssets } from './AutobahnAssets';
import { hash2, rampLayout, SECTION, type Feature, type Frame, type RoadGenerator, type SignPlacement } from './RoadGenerator';

export type ColliderSpec =
  | { kind: 'trimesh'; vertices: Float32Array; indices: Uint32Array }
  | { kind: 'cuboid'; half: [number, number, number]; pos: [number, number, number]; rot: [number, number, number, number] };

export interface ChunkBuild {
  index: number;
  s0: number;
  s1: number;
  origin: THREE.Vector3;
  group: THREE.Group;
  colliders: ColliderSpec[];
  /** Geometry created for this chunk (shared materials / assets are not included). */
  disposables: { dispose(): void }[];
  meshes: number;
  instances: number;
  /** Tree chunks for distance culling. */
  vegetation: THREE.InstancedMesh[];
}

const ROW_STEP = 4;
const UP = new THREE.Vector3(0, 1, 0);

/** Geometry accumulator for one material (positions relative to the chunk origin). */
class Bucket {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly idx: number[] = [];
  readonly colored: boolean;
  constructor(colored = false) {
    this.colored = colored;
  }

  vertex(x: number, y: number, z: number, u: number, v: number, c?: [number, number, number]): number {
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    if (this.colored) this.col.push(...(c ?? [1, 1, 1]));
    return this.pos.length / 3 - 1;
  }

  /** Grid of rows × cols vertices (already added in row-major order from `base`), counter-clockwise from above. */
  grid(base: number, rows: number, cols: number, flip = false): void {
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = base + r * cols + c;
        const b = a + 1;
        const d = a + cols;
        const e = d + 1;
        // Rows run forward, columns from right (negative offset) to left: (a, d, b) faces up.
        if (flip) this.idx.push(a, b, d, b, e, d);
        else this.idx.push(a, d, b, b, d, e);
      }
    }
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.colored) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

export class ChunkBuilder {
  private readonly gen: RoadGenerator;
  private readonly assets: AutobahnAssets;
  private readonly f: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private origin = new THREE.Vector3();

  constructor(gen: RoadGenerator, assets: AutobahnAssets) {
    this.gen = gen;
    this.assets = assets;
  }

  build(index: number): ChunkBuild {
    const L = A.chunk.length;
    const s0 = index * L;
    const s1 = s0 + L;
    const gen = this.gen;
    gen.ensure(s1 + 50);
    const o = gen.frame(s0);
    this.origin = new THREE.Vector3(o.x, o.y, o.z);
    const out: ChunkBuild = { index, s0, s1, origin: this.origin.clone(), group: new THREE.Group(), colliders: [], disposables: [], meshes: 0, instances: 0, vegetation: [] };
    out.group.position.copy(this.origin);
    out.group.name = `autobahn-chunk-${index}`;

    const features = gen.featuresIn(s0, s1, 40);
    const tunnels = features.filter((f) => f.kind === 'tunnel');
    const sideFeatures = features.filter((f) => f.kind === 'exit' || f.kind === 'restArea');
    const rows = this.rows(s0, s1);
    const inTunnel = (s: number) => tunnels.some((t) => s >= t.s0 && s <= t.s1);
    const sideGap = (s: number) => sideFeatures.some((f) => s >= f.s0 && s <= f.s1);

    const buckets = {
      asphalt: new Bucket(),
      shoulder: new Bucket(),
      gravel: new Bucket(),
      marking: new Bucket(),
      dashed: new Bucket(),
      concrete: new Bucket(),
      tunnel: new Bucket(),
      metal: new Bucket(),
      terrain: new Bucket(true),
      noiseWall: new Bucket(),
    };
    const inst = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; list: THREE.Matrix4[]; veg?: boolean; shadow?: boolean }>();
    const addInst = (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, matrix: THREE.Matrix4, opts: { veg?: boolean; shadow?: boolean } = {}) => {
      let e = inst.get(key);
      if (!e) {
        e = { geo, mat, list: [], ...opts };
        inst.set(key, e);
      }
      e.list.push(matrix.clone());
    };

    // --- road surface ------------------------------------------------------------------
    const S = SECTION;
    const laneEdge = A.medianHalf + A.innerStrip + A.lanes * A.lane;
    this.ribbon(buckets.asphalt, rows, [-laneEdge, -A.medianHalf, A.medianHalf, laneEdge], 0, 0.15);
    for (const side of [1, -1]) {
      const a = [laneEdge, S.roadHalf].map((x) => x * side).sort((p, q) => p - q);
      this.ribbon(buckets.shoulder, rows, a, 0, 0.15);
      const b = [S.roadHalf, S.edge].map((x) => x * side).sort((p, q) => p - q);
      this.ribbon(buckets.gravel, rows, b, 0, 0.3);
    }
    // Collision: one trimesh across the whole road (columns at every slope change).
    out.colliders.push(this.trimesh(rows, [-S.edge, -S.roadHalf, -A.medianHalf, 0, A.medianHalf, S.roadHalf, S.edge], () => 0));

    // --- markings (lifted decals, continuous dashes in world s) -----------------------------
    const mk = A.markings;
    for (const side of [1, -1]) {
      const inner = (A.medianHalf + A.innerStrip) * side;
      const outer = laneEdge * side;
      this.strip(buckets.marking, rows, inner - (side * mk.width) / 2, inner + (side * mk.width) / 2, mk.lift);
      this.strip(buckets.marking, rows, outer - side * mk.edgeWidth, outer, mk.lift, (s) => !sideGap(s) || side > 0);
      for (let l = 1; l < A.lanes; l++) {
        const c = (A.medianHalf + A.innerStrip + A.lane * l) * side;
        this.strip(buckets.dashed, rows, c - mk.width / 2, c + mk.width / 2, mk.lift, undefined, 1 / (mk.dash + mk.gap));
      }
      // Exits: the outer edge line turns dashed along the deceleration taper.
      if (side < 0) for (const f of sideFeatures) this.strip(buckets.dashed, rows.filter((s) => s >= f.s0 - 250 && s <= f.s0), outer - mk.edgeWidth * side * -1, outer, mk.lift, undefined, 1 / 9);
    }

    // --- median barrier (concrete), guard rails, tunnel walls -------------------------------
    const mb = A.medianBarrier;
    this.wall(buckets.concrete, rows, -mb.width / 2, mb.width / 2, mb.height, (s) => !inTunnel(s) || true);
    this.boxSegments(out.colliders, s0, s1, 0, mb.width / 2, mb.height, () => true, 0);
    const g = A.guardrail;
    for (const side of [1, -1] as const) {
      const off = side * (S.edge - 0.15);
      const keep = (s: number) => !inTunnel(s) && !(side < 0 && sideGap(s));
      this.railStrip(buckets.metal, rows, off, g.height - 0.35, g.height, keep);
      for (let s = Math.ceil(s0 / g.post) * g.post; s < s1; s += g.post) {
        if (!keep(s)) continue;
        this.placeOnRoad(s, off, 0, 0.12, g.height, 0.12);
        addInst('post', this.assets.box, this.assets.metal, this.m);
      }
      this.boxSegments(out.colliders, s0, s1, off, 0.4, g.height, keep, side);
      // Tunnel walls collide instead of the rails.
      this.boxSegments(out.colliders, s0, s1, side * (S.edge - 0.2), 0.6, 4, inTunnel, side);
    }

    // --- terrain ------------------------------------------------------------------------
    const tRows = this.rows(s0, s1, A.terrain.step);
    for (const side of [1, -1] as const) {
      const offs = A.terrain.offsets.map((d) => side * (S.edge + d)).sort((p, q) => p - q);
      this.terrainRibbon(buckets.terrain, tRows, offs);
      const band = offs.filter((x) => Math.abs(x) <= S.edge + A.terrain.colliderBand + 1);
      out.colliders.push(this.terrainCollider(tRows, band));
    }
    // Under the road: valley floor under bridges, hill roof over tunnels.
    if (features.some((f) => f.kind === 'bridge' || f.kind === 'tunnel')) this.terrainRibbon(buckets.terrain, tRows, [-S.edge, -S.roadHalf, 0, S.roadHalf, S.edge]);

    // --- vegetation (deterministic per chunk) ---------------------------------------------
    this.trees(index, s0, s1, features, addInst);

    // --- roadside details -----------------------------------------------------------------
    for (let s = Math.ceil(s0 / 50) * 50; s < s1; s += 50) {
      if (inTunnel(s)) continue;
      for (const side of [1, -1] as const) {
        if (side < 0 && sideGap(s)) continue;
        const off = side * (S.roadHalf + 0.5);
        this.placeOnRoad(s, off, 0, 0.12, 1.05, 0.14);
        addInst('rpost', this.assets.box, this.assets.post, this.m);
        this.placeOnRoad(s, off, 0.82, 0.13, 0.12, 0.15);
        addInst('reflector', this.assets.box, this.assets.reflector, this.m);
      }
    }
    for (let s = Math.ceil(s0 / 2000) * 2000; s < s1; s += 2000) {
      if (inTunnel(s) || sideGap(s)) continue;
      this.placeOnRoad(s, -(S.roadHalf + 0.9), 0, 0.5, 1.3, 0.4);
      addInst('phone', this.assets.box, this.assets.phone, this.m, { shadow: true });
    }
    // Noise barriers in open country now and then (visual only, beyond the rail).
    if (hash2(this.gen.seed, Math.floor(s0 / 1000), 91) < 0.25 && this.gen.dominantEnvironment(s0) === 'open') {
      for (const side of [1, -1] as const) this.wall(buckets.noiseWall, rows, side * (S.edge + 5) - 0.15, side * (S.edge + 5) + 0.15, 4, (s) => !inTunnel(s) && !(side < 0 && sideGap(s)), true);
    }

    // --- features ---------------------------------------------------------------------------
    for (const f of features) {
      if (f.kind === 'tunnel') this.tunnel(f, rows, buckets.tunnel, buckets.concrete, addInst, s0, s1);
      else if (f.kind === 'bridge') this.bridge(f, rows, buckets.concrete, addInst, s0, s1);
      else if (f.kind === 'overpass') this.overpass(f, buckets.concrete, buckets.metal, out.colliders, addInst, s0, s1);
      else this.sideRoad(f, buckets, out.colliders, addInst, s0, s1);
    }

    // --- signs ----------------------------------------------------------------------------
    for (const sign of this.gen.signsIn(s0, s1)) this.sign(sign, addInst, out);

    // --- assemble ---------------------------------------------------------------------------
    const mats: Record<keyof typeof buckets, THREE.Material> = {
      asphalt: this.assets.asphalt,
      shoulder: this.assets.shoulder,
      gravel: this.assets.gravel,
      marking: this.assets.marking,
      dashed: this.assets.dashed,
      concrete: this.assets.concrete,
      tunnel: this.assets.tunnel,
      metal: this.assets.metal,
      terrain: this.assets.terrain,
      noiseWall: this.assets.noiseWall,
    };
    for (const [key, bucket] of Object.entries(buckets) as [keyof typeof buckets, Bucket][]) {
      if (bucket.empty) continue;
      const geo = bucket.geometry();
      out.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, mats[key]);
      mesh.receiveShadow = true;
      mesh.castShadow = key === 'concrete' || key === 'tunnel' || key === 'metal' || key === 'noiseWall';
      if (key === 'marking' || key === 'dashed') mesh.renderOrder = 1;
      out.group.add(mesh);
      out.meshes++;
    }
    for (const e of inst.values()) {
      const mesh = new THREE.InstancedMesh(e.geo, e.mat, e.list.length);
      e.list.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = e.shadow ?? e.veg ?? false;
      mesh.receiveShadow = true;
      out.group.add(mesh);
      out.meshes++;
      out.instances += e.list.length;
      if (e.veg) out.vegetation.push(mesh);
      out.disposables.push({ dispose: () => mesh.dispose() });
    }
    return out;
  }

  // --- geometry helpers ---------------------------------------------------------------------

  /** Row positions along s: every ROW_STEP m, both ends included. */
  private rows(s0: number, s1: number, step = ROW_STEP): number[] {
    const n = Math.max(1, Math.round((s1 - s0) / step));
    return Array.from({ length: n + 1 }, (_, i) => s0 + ((s1 - s0) * i) / n);
  }

  private local(s: number, off: number, lift: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.gen.frame(s, this.f);
    const clamped = Math.max(-SECTION.edge, Math.min(SECTION.edge, off));
    out.set(f.x + Math.cos(f.heading) * off - this.origin.x, this.gen.surfaceY(f, clamped) + lift - this.origin.y, f.z - Math.sin(f.heading) * off - this.origin.z);
    return out;
  }

  /** Road-surface ribbon across `offs` (ascending). */
  private ribbon(b: Bucket, rows: number[], offs: number[], lift: number, uvScale: number): void {
    const base = b.pos.length / 3;
    for (const s of rows) for (const off of offs) {
      this.local(s, off, lift, this.v);
      b.vertex(this.v.x, this.v.y, this.v.z, off * uvScale, s * uvScale);
    }
    b.grid(base, rows.length, offs.length);
  }

  /** Thin flat strip (markings) between two offsets; rows where `keep` is false are skipped. */
  private strip(b: Bucket, rows: number[], a: number, c: number, lift: number, keep?: (s: number) => boolean, vScale = 1): void {
    const lo = Math.min(a, c);
    const hi = Math.max(a, c);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const base = b.pos.length / 3;
        for (const s of run) for (const off of [lo, hi]) {
          this.local(s, off, lift, this.v);
          b.vertex(this.v.x, this.v.y, this.v.z, off === lo ? 0 : 1, s * vScale);
        }
        b.grid(base, run.length, 2);
      }
      run = [];
    };
    for (const s of rows) {
      if (!keep || keep(s)) run.push(s);
      else flush();
    }
    flush();
  }

  /** Box-section wall (barrier, noise wall) between two offsets, `height` tall. */
  private wall(b: Bucket, rows: number[], a: number, c: number, height: number, keep: (s: number) => boolean, flat = false): void {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        // Four faces as separate grids: right side, top, left side (ends are hidden by neighbours).
        const prof: [number, number][] = [
          [a, 0],
          [a + (flat ? 0 : (c - a) * 0.25), height],
          [c - (flat ? 0 : (c - a) * 0.25), height],
          [c, 0],
        ];
        for (let k = 0; k < 3; k++) {
          const base = b.pos.length / 3;
          for (const s of run) for (const [off, y] of [prof[k], prof[k + 1]]) {
            this.local(s, off, y, this.v);
            b.vertex(this.v.x, this.v.y, this.v.z, k * 0.3, s * 0.1);
          }
          b.grid(base, run.length, 2);
        }
      }
      run = [];
    };
    for (const s of rows) {
      if (keep(s)) run.push(s);
      else flush();
    }
    flush();
  }

  /** Vertical guard-rail band at `off` from y0 to y1 (double-sided by two grids). */
  private railStrip(b: Bucket, rows: number[], off: number, y0: number, y1: number, keep: (s: number) => boolean): void {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        for (const flip of [false, true]) {
          const base = b.pos.length / 3;
          for (const s of run) for (const y of [y0, y1]) {
            this.local(s, off, y, this.v);
            b.vertex(this.v.x, this.v.y, this.v.z, 0, s * 0.1);
          }
          b.grid(base, run.length, 2, flip);
        }
      }
      run = [];
    };
    for (const s of rows) {
      if (keep(s)) run.push(s);
      else flush();
    }
    flush();
  }

  private terrainRibbon(b: Bucket, rows: number[], offs: number[]): void {
    const base = b.pos.length / 3;
    const color = new THREE.Color();
    for (const s of rows) {
      const f = this.gen.frame(s, this.f);
      const env = this.gen.environmentAt(s);
      const cos = Math.cos(f.heading);
      const sin = Math.sin(f.heading);
      const fx = f.x;
      const fz = f.z;
      for (const off of offs) {
        const y = this.gen.terrainHeight(s, off);
        const shade = 0.85 + hash2(this.gen.seed, Math.round(s / 10), Math.round(off)) * 0.15;
        color.setRGB(0.24 * env.forest + 0.42 * env.open + 0.4 * env.hilly, 0.36 * env.forest + 0.52 * env.open + 0.43 * env.hilly, 0.18 * env.forest + 0.24 * env.open + 0.26 * env.hilly).multiplyScalar(shade);
        b.vertex(fx + cos * off - this.origin.x, y - this.origin.y, fz - sin * off - this.origin.z, off / 12, s / 12, [color.r, color.g, color.b]);
      }
    }
    b.grid(base, rows.length, offs.length);
  }

  /** Road trimesh (with lifted columns where `lift` says). */
  private trimesh(rows: number[], offs: number[], lift: (s: number, off: number) => number): ColliderSpec {
    const vertices = new Float32Array(rows.length * offs.length * 3);
    let k = 0;
    for (const s of rows) for (const off of offs) {
      this.local(s, off, lift(s, off), this.v);
      vertices[k++] = this.v.x;
      vertices[k++] = this.v.y;
      vertices[k++] = this.v.z;
    }
    return { kind: 'trimesh', vertices, indices: gridIndices(rows.length, offs.length) };
  }

  private terrainCollider(rows: number[], offs: number[]): ColliderSpec {
    const vertices = new Float32Array(rows.length * offs.length * 3);
    let k = 0;
    for (const s of rows) {
      const f = this.gen.frame(s, this.f);
      for (const off of offs) {
        vertices[k++] = f.x + Math.cos(f.heading) * off - this.origin.x;
        vertices[k++] = this.gen.terrainHeight(s, off) - this.origin.y;
        vertices[k++] = f.z - Math.sin(f.heading) * off - this.origin.z;
      }
    }
    return { kind: 'trimesh', vertices, indices: gridIndices(rows.length, offs.length) };
  }

  /**
   * Barrier collision as box segments along the road (10 m each, thickness
   * pushed outwards from the face so 300 km/h impacts don't tunnel).
   */
  private boxSegments(out: ColliderSpec[], s0: number, s1: number, off: number, half: number, height: number, keep: (s: number) => boolean, side: number): void {
    const seg = 10;
    for (let s = s0; s < s1 - 0.01; s += seg) {
      const e = Math.min(s1, s + seg);
      const mid = (s + e) / 2;
      if (!keep(mid)) continue;
      const a = this.local(s, off, 0, new THREE.Vector3());
      const c = this.local(e, off, 0, new THREE.Vector3());
      const dir = c.clone().sub(a);
      const len = dir.length() + 0.2;
      dir.normalize();
      const x = new THREE.Vector3().crossVectors(UP, dir).normalize();
      const up = new THREE.Vector3().crossVectors(dir, x);
      this.q.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, up, dir));
      const thick = side === 0 ? half : 0.5;
      const centre = a.add(c).multiplyScalar(0.5);
      centre.addScaledVector(x, side * (thick - 0.1));
      centre.y += height / 2;
      out.push({ kind: 'cuboid', half: [thick, height / 2, len / 2], pos: [centre.x, centre.y, centre.z], rot: [this.q.x, this.q.y, this.q.z, this.q.w] });
    }
  }

  /** Sets this.m: a box of size (w, h, d) standing on the road at (s, off), aligned with it. */
  private placeOnRoad(s: number, off: number, y: number, w: number, h: number, d: number, yawExtra = 0): void {
    this.local(s, off, y + h / 2, this.v);
    const f = this.gen.frame(s, this.f);
    this.q.setFromAxisAngle(UP, f.heading + yawExtra);
    this.m.compose(this.v, this.q, this.sc.set(w, h, d));
  }

  // --- vegetation ---------------------------------------------------------------------------

  private trees(index: number, s0: number, s1: number, features: Feature[], add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { veg?: boolean; shadow?: boolean }) => void): void {
    const T = A.trees;
    const seed = this.gen.seed ^ T.seed;
    const minOff = SECTION.edge + 9;
    let i = 0;
    for (let s = s0; s < s1; s += T.spacing) {
      const env = this.gen.environmentAt(s);
      const density = env.forest * 0.8 + env.open * 0.12 + env.hilly * 0.42;
      for (let off = minOff; off < T.maxOffset; off += T.spacing) {
        for (const side of [1, -1]) {
          i++;
          const h0 = hash2(seed, index * 4096 + i, side);
          // Thinner further out (fog hides it) and in open country.
          if (h0 > density * (1 - (off / T.maxOffset) * 0.55)) continue;
          const ss = s + (hash2(seed, i, 3) - 0.5) * T.spacing;
          const oo = side * (off + (hash2(seed, i, 5) - 0.5) * T.spacing);
          if (features.some((f) => blocksTrees(f, ss, oo))) continue;
          const y = this.gen.terrainHeight(ss, oo) - this.origin.y;
          const f = this.gen.frame(ss, this.f);
          const x = f.x + Math.cos(f.heading) * oo - this.origin.x;
          const z = f.z - Math.sin(f.heading) * oo - this.origin.z;
          const tall = 9 + hash2(seed, i, 7) * 11;
          const conifer = hash2(seed, i, 9) < env.forest * 0.85 + env.hilly * 0.7 + 0.1;
          this.q.setFromAxisAngle(UP, hash2(seed, i, 11) * 6.28);
          this.m.compose(this.v.set(x, y - 0.3, z), this.q, this.sc.set(0.5, tall * 0.35, 0.5));
          add('trunk', this.assets.cylinder, this.assets.trunk, this.m, { veg: true });
          if (conifer) {
            const r = 1.8 + hash2(seed, i, 13) * 1.4;
            this.m.compose(this.v.set(x, y + tall * 0.2, z), this.q, this.sc.set(r, tall * 0.85, r));
            add('conifer', this.assets.cone, this.assets.conifer, this.m, { veg: true });
          } else {
            const r = 2.6 + hash2(seed, i, 13) * 2;
            this.m.compose(this.v.set(x, y + tall * 0.55, z), this.q, this.sc.set(r, r * 0.85, r));
            add('broadleaf', this.assets.sphere, this.assets.broadleaf, this.m, { veg: true });
          }
        }
      }
    }
  }

  // --- features -------------------------------------------------------------------------------

  private tunnel(f: Feature, rows: number[], tube: Bucket, concrete: Bucket, add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void, s0: number, s1: number): void {
    const H = A.features.tunnel.height;
    const e = SECTION.edge - 0.1;
    const inside = rows.filter((s) => s >= f.s0 && s <= f.s1);
    if (inside.length >= 2) {
      // Tube profile (right wall → ceiling → left wall), drawn double-sided.
      const prof: [number, number][] = [
        [-e, 0],
        [-e, H - 2.2],
        [-e + 4, H],
        [e - 4, H],
        [e, H - 2.2],
        [e, 0],
      ];
      for (let k = 0; k < prof.length - 1; k++) {
        const base = tube.pos.length / 3;
        for (const s of inside) for (const [off, y] of [prof[k], prof[k + 1]]) {
          this.local(s, off, y, this.v);
          tube.vertex(this.v.x, this.v.y, this.v.z, k * 0.25, s * 0.1);
        }
        tube.grid(base, inside.length, 2);
      }
      // Lights along the ceiling, both sides.
      for (let s = Math.ceil(Math.max(s0, f.s0) / 12) * 12; s < Math.min(s1, f.s1); s += 12) {
        for (const side of [1, -1]) {
          this.placeOnRoad(s, side * (e - 4.6), H - 0.35, 0.35, 0.12, 2.2);
          add('tlight', this.assets.box, this.assets.lamp, this.m);
        }
      }
    }
    // Portals: a concrete face around the opening.
    for (const sp of [f.s0, f.s1]) {
      if (sp < s0 || sp >= s1) continue;
      const fr = this.gen.frame(sp, this.f);
      const wallW = 40;
      this.local(sp, 0, H + 3, this.v);
      this.q.setFromAxisAngle(UP, fr.heading);
      this.boxInto(concrete, this.v, this.q, new THREE.Vector3(2 * e + 2 * wallW, 6, 1.2));
      for (const side of [1, -1]) {
        this.local(sp, side * (e + wallW / 2 + 0.6), 0, this.v);
        this.v.y += (H + 6) / 2 - 1;
        this.boxInto(concrete, this.v, this.q, new THREE.Vector3(wallW, H + 8, 1.2));
      }
      // Portal lamps.
      for (const side of [1, -1]) {
        this.placeOnRoad(sp, side * (e + 1.5), 0, 0.2, 9, 0.2);
        add('pole', this.assets.box, this.assets.metal, this.m);
        this.placeOnRoad(sp, side * (e + 0.6), 8.8, 1.4, 0.25, 0.5);
        add('lamphead', this.assets.box, this.assets.lamp, this.m);
      }
    }
  }

  private bridge(f: Feature, rows: number[], concrete: Bucket, add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void, s0: number, s1: number): void {
    const span = rows.filter((s) => s >= f.s0 && s <= f.s1);
    if (span.length >= 2) {
      // Deck edge fascia below the road on both sides.
      for (const side of [1, -1]) {
        const off = side * SECTION.edge;
        const base = concrete.pos.length / 3;
        for (const s of span) for (const y of [0.1, -1.6]) {
          this.local(s, off, y, this.v);
          concrete.vertex(this.v.x, this.v.y, this.v.z, 0, s * 0.1);
        }
        concrete.grid(base, span.length, 2, side < 0);
      }
    }
    // Piers every 40 m: from under the deck down to the valley floor.
    for (let s = Math.ceil(Math.max(s0, f.s0 + 20) / 40) * 40; s < Math.min(s1, f.s1 - 20); s += 40) {
      for (const off of [-(SECTION.roadHalf - 3), 0, SECTION.roadHalf - 3]) {
        const top = this.local(s, off, -1.4, new THREE.Vector3());
        const ground = this.gen.terrainHeight(s, off) - this.origin.y;
        const h = top.y - ground;
        if (h < 1) continue;
        const fr = this.gen.frame(s, this.f);
        this.q.setFromAxisAngle(UP, fr.heading);
        this.m.compose(this.v.set(top.x, ground + h / 2, top.z), this.q, this.sc.set(2.2, h, 2.2));
        add('pier', this.assets.box, this.assets.concrete, this.m, { shadow: true });
      }
    }
  }

  private overpass(f: Feature, concrete: Bucket, metal: Bucket, colliders: ColliderSpec[], add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void, s0: number, s1: number): void {
    const mid = (f.s0 + f.s1) / 2;
    if (mid < s0 || mid >= s1) return;
    const cfg = A.features.overpass;
    const fr = this.gen.frame(mid, this.f);
    const heading = fr.heading;
    const deckY = fr.y + cfg.height - this.origin.y;
    const reach = SECTION.edge + 70;
    this.local(mid, 0, 0, this.v);
    this.q.setFromAxisAngle(UP, heading);
    const deck = new THREE.Vector3(this.v.x, deckY + 0.6, this.v.z);
    this.boxInto(concrete, deck, this.q, new THREE.Vector3(reach * 2, 1.2, cfg.width));
    // Parapets on the crossing road.
    for (const side of [1, -1]) {
      const p = deck.clone().add(new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)).multiplyScalar(side * (cfg.width / 2 - 0.2)));
      p.y += 1.1;
      this.boxInto(metal, p, this.q, new THREE.Vector3(reach * 2, 0.9, 0.15));
    }
    // Piers: in the median and just outside both rails (with colliders).
    for (const off of [0, SECTION.edge + 3, -(SECTION.edge + 3)]) {
      const base = this.local(mid, off, 0, new THREE.Vector3());
      const h = deckY - base.y + 0.2;
      this.m.compose(this.v.set(base.x, base.y + h / 2 - 0.4, base.z), this.q, this.sc.set(off === 0 ? 1.1 : 2.4, h + 0.8, cfg.width * 0.7));
      add('opier', this.assets.box, this.assets.concrete, this.m, { shadow: true });
      colliders.push({ kind: 'cuboid', half: [off === 0 ? 0.55 : 1.2, h / 2, cfg.width * 0.35], pos: [base.x, base.y + h / 2 - 0.4, base.z], rot: [this.q.x, this.q.y, this.q.z, this.q.w] });
    }
  }

  private sideRoad(
    f: Feature,
    b: { asphalt: Bucket; marking: Bucket; metal: Bucket; concrete: Bucket },
    colliders: ColliderSpec[],
    add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void,
    s0: number,
    s1: number,
  ): void {
    const a = Math.max(s0, f.s0);
    const e = Math.min(s1, f.s1);
    if (e - a < 1) return;
    const rows = this.rows(a, e, 4);
    // Ramp / platform surface: 5 columns across (edge lines sit on the outer ones).
    const layout = (s: number) => rampLayout(f, s)!;
    const surf = (s: number, off: number) => {
      const fr = this.gen.frame(s, this.f);
      const y = this.gen.surfaceY(fr, -SECTION.edge) + layout(s).dy;
      return new THREE.Vector3(fr.x + Math.cos(fr.heading) * off - this.origin.x, y - this.origin.y, fr.z - Math.sin(fr.heading) * off - this.origin.z);
    };
    const cols = [-1, -0.94, 0, 0.94, 1];
    const base = b.asphalt.pos.length / 3;
    const verts: number[] = [];
    for (const s of rows) {
      const l = layout(s);
      for (const c of cols) {
        const p = surf(s, l.centre + c * l.half);
        b.asphalt.vertex(p.x, p.y, p.z, (l.centre + c * l.half) * 0.15, s * 0.15);
        verts.push(p.x, p.y, p.z);
      }
    }
    b.asphalt.grid(base, rows.length, cols.length);
    colliders.push({ kind: 'trimesh', vertices: new Float32Array(verts), indices: gridIndices(rows.length, cols.length) });
    // Edge lines.
    for (const [c0, c1] of [
      [-0.97, -0.92],
      [0.92, 0.97],
    ]) {
      const mb = b.marking.pos.length / 3;
      for (const s of rows) {
        const l = layout(s);
        for (const c of [c0, c1]) {
          const p = surf(s, l.centre + c * l.half);
          b.marking.vertex(p.x, p.y + A.markings.lift, p.z, 0, s);
        }
      }
      b.marking.grid(mb, rows.length, 2);
    }
    // Outer guard rail of the ramp (and its collision).
    for (let s = a; s < e - 0.01; s += 10) {
      const s2 = Math.min(e, s + 10);
      const p0 = surf(s, layout(s).centre - layout(s).half - 0.6);
      const p1 = surf(s2, layout(s2).centre - layout(s2).half - 0.6);
      const dir = p1.clone().sub(p0);
      const len = dir.length();
      if (len < 0.5) continue;
      dir.normalize();
      this.q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(dir.x, 0, dir.z).normalize());
      const c = p0.add(p1).multiplyScalar(0.5);
      c.y += A.guardrail.height - 0.15;
      this.boxInto(b.metal, c, this.q, new THREE.Vector3(0.08, 0.35, len + 0.2));
      colliders.push({ kind: 'cuboid', half: [0.4, 0.5, len / 2 + 0.1], pos: [c.x, c.y - 0.1, c.z], rot: [this.q.x, this.q.y, this.q.z, this.q.w] });
    }
    // Exit: crash cushion + chevron where the ramp ends (secondary roads attach here later).
    if (f.kind === 'exit' && f.s1 >= s0 && f.s1 < s1) {
      const l = layout(f.s1);
      const p = surf(f.s1, l.centre);
      const fr = this.gen.frame(f.s1, this.f);
      this.q.setFromAxisAngle(UP, fr.heading);
      this.m.compose(this.v.set(p.x, p.y + 0.8, p.z), this.q, this.sc.set(l.half * 2 + 1, 1.6, 0.6));
      add('chevron', this.assets.box, this.assets.chevron, this.m, { shadow: true });
      colliders.push({ kind: 'cuboid', half: [l.half + 0.5, 0.8, 0.3], pos: [p.x, p.y + 0.8, p.z], rot: [this.q.x, this.q.y, this.q.z, this.q.w] });
    }
    // Rest area: fuel station canopy, pumps, shop, parking lines, lamps.
    if (f.kind === 'restArea') {
      const mid = (f.s0 + f.s1) / 2;
      if (mid >= s0 && mid < s1) this.restArea(f, mid, colliders, add);
    }
  }

  private restArea(f: Feature, mid: number, colliders: ColliderSpec[], add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void): void {
    const l = rampLayout(f, mid)!;
    const fr = this.gen.frame(mid, this.f);
    const yBase = this.gen.surfaceY(fr, -SECTION.edge) - this.origin.y;
    const at = (ds: number, off: number) => {
      const g = this.gen.frame(mid + ds, this.f);
      return new THREE.Vector3(g.x + Math.cos(g.heading) * off - this.origin.x, yBase, g.z - Math.sin(g.heading) * off - this.origin.z);
    };
    this.q.setFromAxisAngle(UP, fr.heading);
    const rot: [number, number, number, number] = [this.q.x, this.q.y, this.q.z, this.q.w];
    // Canopy over the pumps (towards the road) and the shop further back.
    const canopy = at(-40, l.centre + 10);
    this.m.compose(this.v.set(canopy.x, canopy.y + 5.6, canopy.z), this.q, this.sc.set(16, 0.5, 26));
    add('roof', this.assets.box, this.assets.roof, this.m, { shadow: true });
    for (const [dx, dz] of [
      [-6, -11],
      [6, -11],
      [-6, 11],
      [6, 11],
    ]) {
      const p = at(-40 + dz, l.centre + 10 + dx);
      this.m.compose(this.v.set(p.x, p.y + 2.8, p.z), this.q, this.sc.set(0.4, 5.6, 0.4));
      add('canopyPost', this.assets.box, this.assets.metal, this.m, { shadow: true });
      colliders.push({ kind: 'cuboid', half: [0.2, 2.8, 0.2], pos: [p.x, p.y + 2.8, p.z], rot });
    }
    for (const dz of [-6, 6]) {
      for (const dx of [-3, 3]) {
        const p = at(-40 + dz, l.centre + 10 + dx);
        this.m.compose(this.v.set(p.x, p.y + 0.8, p.z), this.q, this.sc.set(0.7, 1.6, 1.1));
        add('pump', this.assets.box, this.assets.building, this.m, { shadow: true });
        colliders.push({ kind: 'cuboid', half: [0.35, 0.8, 0.55], pos: [p.x, p.y + 0.8, p.z], rot });
      }
    }
    const shop = at(-40, l.centre - 20);
    this.m.compose(this.v.set(shop.x, shop.y + 2.6, shop.z), this.q, this.sc.set(12, 5.2, 24));
    add('shop', this.assets.box, this.assets.building, this.m, { shadow: true });
    colliders.push({ kind: 'cuboid', half: [6, 2.6, 12], pos: [shop.x, shop.y + 2.6, shop.z], rot });
    // Parking bays (lines) downstream of the station.
    for (let k = 0; k < 14; k++) {
      const p = at(20 + k * 3, l.centre - 4);
      this.m.compose(this.v.set(p.x, p.y + 0.015, p.z), this.q, this.sc.set(5, 0.02, 0.12));
      add('bay', this.assets.box, this.assets.post, this.m);
    }
    // Lamps around the platform (the only street lighting on the Autobahn).
    for (const ds of [-90, -30, 30, 90]) {
      for (const off of [l.centre + l.half - 2, l.centre - l.half + 2]) {
        const p = at(ds, off);
        this.m.compose(this.v.set(p.x, p.y + 4.5, p.z), this.q, this.sc.set(0.18, 9, 0.18));
        add('pole', this.assets.box, this.assets.metal, this.m);
        this.m.compose(this.v.set(p.x, p.y + 9, p.z), this.q, this.sc.set(0.9, 0.2, 0.5));
        add('lamphead', this.assets.box, this.assets.lamp, this.m);
      }
    }
  }

  // --- signs -----------------------------------------------------------------------------------

  private sign(sg: SignPlacement, add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void, out: ChunkBuild): void {
    const fr = { ...this.gen.frame(sg.s, this.f) };
    // Faces the approaching (direction A) driver. Own copy: placeOnRoad() reuses this.q.
    const face = new THREE.Quaternion().setFromAxisAngle(UP, fr.heading + Math.PI);
    const panel = (centre: THREE.Vector3, w: number, h: number, mat: THREE.Material) => {
      const geo = new THREE.PlaneGeometry(w, h);
      out.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(centre);
      mesh.quaternion.copy(face);
      out.group.add(mesh);
      out.meshes++;
      // Back plate so it isn't see-through from behind.
      this.m.compose(centre.clone().add(new THREE.Vector3(Math.sin(fr.heading), 0, Math.cos(fr.heading)).multiplyScalar(0.06)), face, this.sc.set(w, h, 0.08));
      add('signback', this.assets.box, this.assets.metal, this.m, { shadow: true });
    };
    const poles = (offs: number[], height: number) => {
      for (const off of offs) {
        this.placeOnRoad(sg.s, off, 0, 0.15, height, 0.15);
        add('pole', this.assets.box, this.assets.metal, this.m, { shadow: true });
      }
    };
    const road = (off: number, y: number) => this.local(sg.s, off, y, new THREE.Vector3());
    if (sg.kind === 'gantry') {
      // Over direction A: posts at the outer rail and the median, beam across, one big panel.
      const right = -(SECTION.edge + 0.8);
      const left = -0.9;
      poles([right, left], 7.4);
      const a = road(right, 7.1);
      const c = road(left, 7.1);
      const beam = a.clone().add(c).multiplyScalar(0.5);
      this.boxInto2(add, beam, Math.abs(right - left) + 0.6, 0.35, 0.35, fr.heading);
      panel(road(-(A.medianHalf + A.innerStrip + 1.5 * A.lane + 1.5), 5.3), 9, 3.2, this.assets.sign('blue', sg.text));
    } else if (sg.kind === 'speed') {
      const off = -(SECTION.edge + 1.2);
      poles([off], 2.6);
      panel(road(off, 3.2), 1.3, 1.3, this.assets.sign('speed', sg.text, sg.value));
    } else if (sg.kind === 'gore') {
      const off = -(SECTION.edge + 2.5);
      poles([off], 1.6);
      panel(road(off, 2.2), 2.4, 1.2, this.assets.sign('gore', sg.text));
    } else {
      const off = -(SECTION.edge + 3.2);
      poles([off - 1.4, off + 1.4], 3);
      panel(road(off, 3.6), 4.4, 2.2, this.assets.sign('blue', sg.text));
    }
  }

  // --- small helpers -------------------------------------------------------------------------

  /** Axis-aligned-in-local-frame box added to a merged bucket (24 vertices: flat faces). */
  private boxInto(b: Bucket, centre: THREE.Vector3, q: THREE.Quaternion, size: THREE.Vector3): void {
    const box = new THREE.BoxGeometry(size.x, size.y, size.z);
    box.applyQuaternion(q);
    box.translate(centre.x, centre.y, centre.z);
    const p = box.attributes.position;
    const uv = box.attributes.uv;
    const base = b.pos.length / 3;
    for (let i = 0; i < p.count; i++) b.vertex(p.getX(i), p.getY(i), p.getZ(i), uv.getX(i), uv.getY(i));
    const idx = box.index!;
    for (let i = 0; i < idx.count; i++) b.idx.push(base + idx.getX(i));
    box.dispose();
  }

  private boxInto2(add: (key: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, o?: { shadow?: boolean }) => void, centre: THREE.Vector3, w: number, h: number, d: number, heading: number): void {
    this.q.setFromAxisAngle(UP, heading);
    this.m.compose(centre, this.q, this.sc.set(w, h, d));
    add('beam', this.assets.box, this.assets.metal, this.m, { shadow: true });
  }
}

/** Index buffer for a rows × cols vertex grid (counter-clockwise from above). */
function gridIndices(rows: number, cols: number): Uint32Array {
  const out = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      out.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], k);
      k += 6;
    }
  }
  return out;
}

/** Keep trees off ramps, rest areas, overpass embankments and tunnel portals. */
function blocksTrees(f: Feature, s: number, off: number): boolean {
  if (f.kind === 'overpass') return Math.abs(s - (f.s0 + f.s1) / 2) < 45;
  if (f.kind === 'tunnel') return (Math.abs(s - f.s0) < 50 || Math.abs(s - f.s1) < 50) && Math.abs(off) < SECTION.edge + 60;
  if ((f.kind === 'exit' || f.kind === 'restArea') && off < 0 && s >= f.s0 - 10 && s <= f.s1 + 10) {
    const l = rampLayout(f, Math.max(f.s0, Math.min(f.s1, s)));
    return !!l && Math.abs(off - l.centre) < l.half + 14;
  }
  return false;
}
