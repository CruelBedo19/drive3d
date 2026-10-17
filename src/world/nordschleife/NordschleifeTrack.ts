import * as THREE from 'three';
import { NORDSCHLEIFE as C } from '../../config/tracks';
import { RAPIER } from '../../core/PhysicsWorld';
import { decimatePath, type MapData } from '../../ui/map/MapData';
import type { SpawnPoint, TestPoint, Track, TrackView } from '../Track';
import trackData from '../tracks/nordschleife.json';
import { TrackCurve, type TrackData, type TrackFrames } from './TrackCurve';
import { StripBuilder, type Offset, dashTexture, decalMaterial, kerbTexture, noiseTexture, rng } from './TrackMeshes';

/** Admin teleport points: shortly before these corners (OSM way names). */
const TEST_CORNERS: [id: string, corner: string][] = [
  ['hatzenbach', 'Hatzenbach'],
  ['flugplatz', 'Flugplatz'],
  ['fuchsroehre', 'Fuchsröhre'],
  ['adenauer', 'Adenauer Forst'],
  ['bergwerk', 'Bergwerk'],
  ['karussell', 'Karussell'],
  ['pflanzgarten', 'Pflanzgarten'],
  ['doettinger', 'Döttinger Höhe'],
];
const TEST_POINT_LEAD = 80;
const SKIRT_WIDTH = 12;
const SKIRT_DROP = 20;
/** Barrier colliders are thicker than the rail, extending outwards, so fast impacts don't tunnel. */
const BARRIER_COLLIDER_THICKNESS = 0.8;
const KERB_MIN_RUN = 5;
const KERB_EXTEND = 3;

/**
 * The Nürburgring Nordschleife (20.7 km), built from an OpenStreetMap centre line
 * with real elevation. Cross-section, kerbs, rails, trees and colliders are generated
 * here (see NORDSCHLEIFE in config/tracks.ts). Visuals are chunked for culling;
 * physics is one fixed body: a ground trimesh plus box guard rails.
 */
export class NordschleifeTrack implements Track {
  readonly group = new THREE.Group();
  readonly spawn: SpawnPoint;
  readonly testPoints: readonly TestPoint[];
  readonly killHeight: number;
  readonly fog = C.fog;
  readonly attribution = 'Pist: © OpenStreetMap contributors (ODbL) · yükseklik: SRTM';
  readonly curve: TrackCurve;
  readonly mapData: MapData;

  private readonly world: RAPIER.World;
  private readonly body: RAPIER.RigidBody;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly half = C.width / 2;
  /** Tree chunks with their bounding-sphere centre, for vegetation-distance culling. */
  private readonly treeChunks: { meshes: THREE.InstancedMesh[]; centre: THREE.Vector3; radius: number }[] = [];
  /** Materials that look wet in the rain, with their dry values. */
  private readonly wettable: { material: THREE.MeshStandardMaterial; roughness: number; color: THREE.Color }[] = [];
  private readonly rail = C.width / 2 + C.shoulder;

  constructor(world: RAPIER.World) {
    this.world = world;
    this.group.name = 'nordschleife';
    this.curve = new TrackCurve(trackData as TrackData);
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    const maxReach = this.rail + C.verge + SKIRT_WIDTH;
    const visual = this.curve.frames(C.visualStep, maxReach);
    const physics = this.curve.frames(C.colliderStep, maxReach);

    this.buildGroundCollider(physics);
    this.buildBarriers(physics);
    this.buildSurfaces(visual);
    this.buildTrees(visual);
    this.buildStartLine();

    const pos = new THREE.Vector3();
    const spawnYaw = this.curve.pose(C.spawnDistance, pos);
    this.spawn = { position: pos.clone(), yaw: spawnYaw };
    const points: TestPoint[] = [{ id: 'start', label: 'Start (T13)', ...this.spawn }];
    for (const [id, name] of TEST_CORNERS) {
      const corner = this.curve.data.corners.find((c) => c.name === name);
      if (!corner) continue;
      const yaw = this.curve.pose(corner.distance - TEST_POINT_LEAD, pos);
      points.push({ id, label: `${name} (${(corner.distance / 1000).toFixed(1)} km)`, position: pos.clone(), yaw });
    }
    this.testPoints = points;

    this.mapData = this.buildMapData();

    let minY = Infinity;
    for (const p of this.curve.data.points) minY = Math.min(minY, p[1]);
    this.killHeight = minY - 40;
  }

  /** Hides tree chunks beyond the vegetation distance (whole chunks: cheap, ~100 checks a frame). */
  update(view?: TrackView): void {
    if (!view) return;
    for (const c of this.treeChunks) {
      const visible = c.centre.distanceTo(view.camera) - c.radius < view.vegetationDistance;
      if (c.meshes[0].visible !== visible) for (const m of c.meshes) m.visible = visible;
    }
  }

  /** Wet look: darker, smoother asphalt and markings that catch light. Visual only. */
  setWetness(wetness: number): void {
    for (const w of this.wettable) {
      w.material.roughness = THREE.MathUtils.lerp(w.roughness, 0.22, wetness);
      w.material.color.copy(w.color).multiplyScalar(1 - 0.35 * wetness);
    }
  }

  /** The real track shape for the minimap: centre line every ~6 m, start line marker. */
  private buildMapData(): MapData {
    const f = this.curve.frames(3);
    const xz = new Float32Array(f.count * 2);
    for (let i = 0; i < f.count; i++) {
      xz[i * 2] = f.position[i * 3];
      xz[i * 2 + 1] = f.position[i * 3 + 2];
    }
    const start = new THREE.Vector3();
    const yaw = this.curve.pose(0, start);
    return {
      paths: [{ kind: 'track', points: decimatePath(xz, 6), closed: true, width: C.width }],
      markers: [{ kind: 'start', x: start.x, z: start.z, yaw }],
      viewRadius: 420,
    };
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }

  /** Outer edge of the drivable ground on each side at sample i. */
  private vergeEdge(f: TrackFrames, i: number, side: 1 | -1): number {
    const clear = side > 0 ? f.clearLeft[i] : f.clearRight[i];
    return Math.max(this.rail + 0.5, Math.min(this.rail + C.verge, clear));
  }

  /**
   * One trimesh for all drivable ground. It is split into columns across the
   * track (verge, grass, asphalt halves): a single wide quad per sample would be
   * twisted on cambered, climbing corners and put the surface up to 0.2 m off.
   */
  private buildGroundCollider(f: TrackFrames): void {
    const strip = new StripBuilder(f);
    const edges: Offset[] = [(i) => -this.vergeEdge(f, i, -1), -this.rail, -this.half, 0, this.half, this.rail, (i) => this.vergeEdge(f, i, 1)];
    for (let c = 0; c < edges.length - 1; c++) strip.add(0, f.count, { a: edges[c], b: edges[c + 1] });
    const { vertices, indices } = strip.arrays();
    // Columns share their edge vertices exactly; merging them makes one connected mesh.
    const flags = RAPIER.TriMeshFlags.MERGE_DUPLICATE_VERTICES;
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices, flags).setFriction(0.9), this.body);
  }

  /** Guard rails on both sides: one cuboid collider per segment, rendered as instanced boxes. */
  private buildBarriers(f: TrackFrames): void {
    const { height, thickness } = C.barrier;
    const n = f.count;
    const chunkSize = Math.round(C.chunkLength / f.step);
    const geo = this.own(new THREE.BoxGeometry(1, 1, 1));
    const mat = this.own(new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.45, metalness: 0.6 }));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const up = new THREE.Vector3();
    const x = new THREE.Vector3();
    const basis = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const m = new THREE.Matrix4();
    const centre = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let c0 = 0; c0 < n; c0 += chunkSize) {
      const c1 = Math.min(n, c0 + chunkSize);
      const mesh = new THREE.InstancedMesh(geo, mat, (c1 - c0) * 2);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      let k = 0;
      for (let i = c0; i < c1; i++) {
        const j = (i + 1) % n;
        for (const side of [1, -1] as const) {
          const off = side * this.rail;
          a.set(f.position[i * 3] + f.left[i * 3] * off, f.position[i * 3 + 1], f.position[i * 3 + 2] + f.left[i * 3 + 2] * off);
          b.set(f.position[j * 3] + f.left[j * 3] * off, f.position[j * 3 + 1], f.position[j * 3 + 2] + f.left[j * 3 + 2] * off);
          dir.subVectors(b, a);
          const len = dir.length() + 0.15; // slight overlap closes seams on curves
          dir.normalize();
          x.set(0, 1, 0).cross(dir).normalize(); // left of travel
          up.crossVectors(dir, x);
          basis.makeBasis(x, up, dir);
          q.setFromRotationMatrix(basis);
          centre.addVectors(a, b).multiplyScalar(0.5);
          centre.y += height / 2;

          // Collider: inner face on the rail, thickness outwards.
          const hc = BARRIER_COLLIDER_THICKNESS / 2;
          this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(hc, height / 2, len / 2)
              .setTranslation(centre.x + x.x * side * (hc - thickness / 2), centre.y, centre.z + x.z * side * (hc - thickness / 2))
              .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
              .setFriction(0.25)
              .setRestitution(0.15),
            this.body,
          );
          scale.set(thickness, height, len);
          m.compose(centre, q, scale);
          mesh.setMatrixAt(k++, m);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.group.add(mesh);
    }
  }

  /** Asphalt, painted lines, kerbs, grass and the ground skirt, chunked along the lap. */
  private buildSurfaces(f: TrackFrames): void {
    const half = this.half;
    const rail = this.rail;
    const asphaltMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.02, map: this.ownTex(noiseTexture([46, 49, 54], 24, 1)) }));
    const lineMat = this.own(decalMaterial({ color: 0xf1f1f1, roughness: 0.55 }));
    const dash = C.centreDash;
    const dashMat = this.own(decalMaterial({ color: 0xf4f4f4, roughness: 0.45, alphaMap: this.ownTex(dashTexture(dash.dash / (dash.dash + dash.gap))), alphaTest: 0.5, transparent: false }));
    const kerbMat = this.own(decalMaterial({ color: 0xffffff, roughness: 0.6, map: this.ownTex(kerbTexture()) }));
    const grassMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: this.ownTex(noiseTexture([62, 92, 46], 18, 2)) }));
    const vergeMat = this.own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: this.ownTex(noiseTexture([44, 66, 36], 16, 3)) }));
    for (const material of [asphaltMat, lineMat, dashMat, kerbMat]) this.wettable.push({ material, roughness: material.roughness, color: material.color.clone() });
    const kerbs = { [1]: this.kerbRuns(f, 1), [-1]: this.kerbRuns(f, -1) };
    const verge = (side: 1 | -1) => (i: number) => this.vergeEdge(f, i, side);
    // The skirt hides the end of the world; it is left out where another part of the lap is close.
    const skirt = (side: 1 | -1) => (i: number) => this.vergeEdge(f, i, side) + ((side > 0 ? f.clearLeft[i] : f.clearRight[i]) >= rail + C.verge + SKIRT_WIDTH ? SKIRT_WIDTH : 0);

    const chunkSize = Math.round(C.chunkLength / f.step);
    const e = C.edgeLine;
    const k = C.kerb;
    for (let c0 = 0; c0 < f.count; c0 += chunkSize) {
      const c1 = Math.min(f.count, c0 + chunkSize);
      const asphalt = new StripBuilder(f);
      // Two halves, like the collider columns, so the visible road matches the physics surface.
      asphalt.add(c0, c1, { a: -half, b: 0, uScale: 1 / 6, vScale: 1 / 6 });
      asphalt.add(c0, c1, { a: 0, b: half, uScale: 1 / 6, vScale: 1 / 6 });
      const lines = new StripBuilder(f);
      lines.add(c0, c1, { a: half - e.inset - e.width, b: half - e.inset });
      lines.add(c0, c1, { a: -half + e.inset, b: -half + e.inset + e.width });
      const centre = new StripBuilder(f);
      centre.add(c0, c1, { a: -dash.width / 2, b: dash.width / 2, vScale: 1 / (dash.dash + dash.gap) });
      const kerb = new StripBuilder(f);
      for (const side of [1, -1] as const) {
        for (const [r0, r1] of kerbs[side]) {
          const s0 = Math.max(r0, c0);
          const s1 = Math.min(r1, c1);
          if (s1 <= s0) continue;
          const inner = half - 0.25;
          const opts = side > 0 ? { a: inner, b: inner + k.width } : { a: -inner - k.width, b: -inner };
          kerb.add(s0, s1, { ...opts, liftA: k.height, vScale: 1 / (2 * k.stripe) });
        }
      }
      const grass = new StripBuilder(f);
      grass.add(c0, c1, { a: half, b: rail, uScale: 1 / 5, vScale: 1 / 5 });
      grass.add(c0, c1, { a: -rail, b: -half, uScale: 1 / 5, vScale: 1 / 5 });
      const ground = new StripBuilder(f);
      ground.add(c0, c1, { a: rail, b: verge(1), uScale: 1 / 8, vScale: 1 / 8 });
      ground.add(c0, c1, { a: (i) => -verge(-1)(i), b: -rail, uScale: 1 / 8, vScale: 1 / 8 });
      ground.add(c0, c1, { a: verge(1), b: skirt(1), liftB: -SKIRT_DROP, uScale: 1 / 8, vScale: 1 / 8 });
      ground.add(c0, c1, { a: (i) => -skirt(-1)(i), b: (i) => -verge(-1)(i), liftA: -SKIRT_DROP, liftB: 0, uScale: 1 / 8, vScale: 1 / 8 });

      this.addMesh(asphalt, asphaltMat, 0);
      this.addMesh(grass, grassMat, 0);
      this.addMesh(ground, vergeMat, 0);
      this.addMesh(lines, lineMat, 1);
      this.addMesh(centre, dashMat, 1);
      if (!kerb.empty) this.addMesh(kerb, kerbMat, 1);
    }
  }

  /** Sample ranges with a kerb on `side`: inside of corners and outside of tight ones. */
  private kerbRuns(f: TrackFrames, side: 1 | -1): [number, number][] {
    const n = f.count;
    const want = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const k = f.curvature[i] * side;
      if (k > 1 / C.kerb.insideRadius || k < -1 / C.kerb.outsideRadius) want[i] = 1;
    }
    const runs: [number, number][] = [];
    let i = 0;
    while (i < n) {
      if (!want[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && want[j + 1]) j++;
      if (j - i + 1 >= KERB_MIN_RUN) runs.push([Math.max(0, i - KERB_EXTEND), Math.min(n, j + KERB_EXTEND)]);
      i = j + 1;
    }
    return runs;
  }

  /** Two-part instanced trees (trunk, crown) scattered on the verge, chunked for culling. */
  private buildTrees(f: TrackFrames): void {
    const t = C.trees;
    const rand = rng(t.seed);
    const trunkGeo = this.own(new THREE.CylinderGeometry(0.18, 0.28, 1, 6));
    trunkGeo.translate(0, 0.5, 0);
    const crownGeo = this.own(new THREE.ConeGeometry(1, 1, 7));
    crownGeo.translate(0, 0.5, 0);
    const trunkMat = this.own(new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }));
    const crownMat = this.own(new THREE.MeshStandardMaterial({ color: 0x24432a, roughness: 0.95 }));
    const every = Math.max(1, Math.round(t.spacing / f.step));
    const chunkSize = Math.round(C.chunkLength / f.step);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const s = new THREE.Vector3();
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (let c0 = 0; c0 < f.count; c0 += chunkSize) {
      const c1 = Math.min(f.count, c0 + chunkSize);
      const trees: { x: number; y: number; z: number; h: number; r: number }[] = [];
      for (let i = c0; i < c1; i += every) {
        for (const side of [1, -1] as const) {
          const outer = this.vergeEdge(f, i, side) - 1.5;
          const inner = this.rail + 3;
          if (outer - inner < 2) continue;
          for (let row = 0; row < 2; row++) {
            if (rand() < 0.35) continue;
            const off = side * (inner + rand() * (outer - inner));
            const along = (rand() - 0.5) * t.spacing;
            const tx = f.tangent[i * 3];
            const tz = f.tangent[i * 3 + 2];
            trees.push({
              x: f.position[i * 3] + f.left[i * 3] * off + tx * along,
              y: f.position[i * 3 + 1],
              z: f.position[i * 3 + 2] + f.left[i * 3 + 2] * off + tz * along,
              h: t.minHeight + rand() * (t.maxHeight - t.minHeight),
              r: 1.6 + rand() * 1.4,
            });
          }
        }
      }
      if (!trees.length) continue;
      const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
      const crowns = new THREE.InstancedMesh(crownGeo, crownMat, trees.length);
      trees.forEach((tr, idx) => {
        q.setFromAxisAngle(yAxis, tr.h * 7.3);
        pos.set(tr.x, tr.y - 0.3, tr.z);
        s.set(1, tr.h * 0.35, 1);
        m.compose(pos, q, s);
        trunks.setMatrixAt(idx, m);
        pos.y += tr.h * 0.25;
        s.set(tr.r, tr.h * 0.8, tr.r);
        m.compose(pos, q, s);
        crowns.setMatrixAt(idx, m);
      });
      for (const mesh of [trunks, crowns]) {
        mesh.castShadow = true;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
        this.group.add(mesh);
      }
      const sphere = crowns.boundingSphere;
      if (sphere) this.treeChunks.push({ meshes: [trunks, crowns], centre: sphere.center.clone(), radius: sphere.radius });
    }
  }

  private buildStartLine(): void {
    const pos = new THREE.Vector3();
    const yaw = this.curve.pose(0, pos);
    const geo = this.own(new THREE.PlaneGeometry(C.width, 0.6));
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(geo, this.own(decalMaterial({ color: 0xf6f6f6, roughness: 0.5 })));
    mesh.position.copy(pos);
    mesh.position.y += 0.01;
    mesh.rotation.y = yaw;
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  private addMesh(builder: StripBuilder, material: THREE.Material, renderOrder: number): void {
    const mesh = new THREE.Mesh(this.own(builder.build()), material);
    mesh.receiveShadow = true;
    mesh.renderOrder = renderOrder;
    this.group.add(mesh);
  }

  private own<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }

  private ownTex(tex: THREE.Texture | null): THREE.Texture | null {
    if (tex) this.disposables.push(tex);
    return tex;
  }
}
