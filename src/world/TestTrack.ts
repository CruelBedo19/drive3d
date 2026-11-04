import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';
import { RAPIER } from '../core/PhysicsWorld';
import type { MapData } from '../ui/map/MapData';
import { applyWetness, type WettableMaterial } from './weather/wetSurface';
import type { SpawnPoint, TestPoint, Track } from './Track';

/** A placed box: centre, half extents, yaw around world Y. */
interface BoxPiece {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  /** Optional pitch (around local X), used for the ramp. */
  pitch?: number;
}

interface DynamicProp {
  body: RAPIER.RigidBody;
  index: number;
}

// Layout: a stadium-shaped circuit (two long straights joined by 180° turns),
// open infield for handbrake practice, run-off area, outer walls.
export const STRAIGHT_LENGTH = 240;
export const TURN_RADIUS = 60;
export const TRACK_WIDTH = 16;
const SEGMENT_LENGTH = 4;
const BARRIER = { hy: 0.45, hz: 0.3 }; // half height, half thickness
const WALL = { hy: 1.5, hz: 0.5 };
const WALL_HALF_X = 115;
const WALL_HALF_Z = 225;
const GROUND_HALF = 260;
/** Painted skidpad circle in the infield. */
const SKIDPAD = { x: -28, z: 35, r: 15 };

/**
 * Physics test ground. Static geometry lives on one fixed body with many
 * colliders; visuals use InstancedMesh so the whole track costs a few draw calls.
 */
export class TestTrack implements Track {
  readonly group = new THREE.Group();
  readonly killHeight = GAME_CONFIG.world.killHeight;
  readonly spawn: SpawnPoint = { position: new THREE.Vector3(TURN_RADIUS, 0, -80), yaw: 0 };
  readonly testPoints: readonly TestPoint[] = [
    { id: 'start', label: 'Start (main straight)', position: new THREE.Vector3(TURN_RADIUS, 0, -80), yaw: 0 },
    { id: 'speed', label: 'Speed / brake test (420 m)', position: new THREE.Vector3(92, 0, -205), yaw: 0 },
    { id: 'chicane', label: 'Chicane (back straight)', position: new THREE.Vector3(-TURN_RADIUS, 0, 80), yaw: Math.PI },
    { id: 'skidpad', label: 'Skidpad (r = 15 m)', position: new THREE.Vector3(SKIDPAD.x + SKIDPAD.r, 0, SKIDPAD.z - 25), yaw: 0 },
    { id: 'slalom', label: 'Slalom (dubalar)', position: new THREE.Vector3(15, 0, -55), yaw: 0 },
    { id: 'ramp', label: 'Rampa', position: new THREE.Vector3(-20, 0, -90), yaw: 0 },
    { id: 'wall', label: 'Crash wall', position: new THREE.Vector3(0, 0, 40), yaw: 0 },
  ];

  readonly mapData: MapData = {
    paths: [
      { kind: 'track', points: stadiumLine(TURN_RADIUS), closed: true, width: TRACK_WIDTH },
      { kind: 'area', points: circleLine(SKIDPAD.x, SKIDPAD.z, SKIDPAD.r), closed: true, width: 8 },
    ],
    markers: [{ kind: 'start', x: TURN_RADIUS, z: -70, yaw: 0 }],
    viewRadius: 140,
  };

  private ground: WettableMaterial | null = null;
  private readonly world: RAPIER.World;
  private readonly props: DynamicProp[] = [];
  private propMesh: THREE.InstancedMesh | null = null;
  private readonly disposables: { dispose(): void }[] = [];
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3(1, 1, 1);

  constructor(world: RAPIER.World) {
    this.world = world;
    const fixed = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    this.buildGround(fixed);

    const barriers: BoxPiece[] = [];
    const outer = TURN_RADIUS + TRACK_WIDTH / 2 + BARRIER.hz;
    const inner = TURN_RADIUS - TRACK_WIDTH / 2 - BARRIER.hz;
    this.stadiumBarrier(outer, barriers, () => true);
    // Gaps in the inner barrier on both straights give access to the infield.
    this.stadiumBarrier(inner, barriers, (x, z) => Math.abs(z) > 18 || Math.abs(x) < inner - 1);
    // Chicane on the back straight (x = -R).
    barriers.push(
      { x: -TURN_RADIUS - 4.5, y: BARRIER.hy, z: -60, hx: 3.5, hy: BARRIER.hy, hz: BARRIER.hz * 2, yaw: 0 },
      { x: -TURN_RADIUS + 4.5, y: BARRIER.hy, z: -35, hx: 3.5, hy: BARRIER.hy, hz: BARRIER.hz * 2, yaw: 0 },
      { x: -TURN_RADIUS - 4.5, y: BARRIER.hy, z: -10, hx: 3.5, hy: BARRIER.hy, hz: BARRIER.hz * 2, yaw: 0 },
    );
    this.addStatic(fixed, barriers, 0xc9ccd2, 0.25);

    const walls: BoxPiece[] = [
      { x: 0, y: WALL.hy, z: WALL_HALF_Z, hx: WALL_HALF_X, hy: WALL.hy, hz: WALL.hz, yaw: 0 },
      { x: 0, y: WALL.hy, z: -WALL_HALF_Z, hx: WALL_HALF_X, hy: WALL.hy, hz: WALL.hz, yaw: 0 },
      { x: WALL_HALF_X, y: WALL.hy, z: 0, hx: WALL_HALF_Z, hy: WALL.hy, hz: WALL.hz, yaw: Math.PI / 2 },
      { x: -WALL_HALF_X, y: WALL.hy, z: 0, hx: WALL_HALF_Z, hy: WALL.hy, hz: WALL.hz, yaw: Math.PI / 2 },
      // Crash wall in the infield, for head-on collision tests.
      { x: 0, y: WALL.hy, z: 95, hx: 12, hy: WALL.hy, hz: WALL.hz, yaw: 0 },
    ];
    this.addStatic(fixed, walls, 0x8d8f94, 0.2);

    // Small kicker ramp in the infield: suspension and airborne test.
    const rampLen = 10;
    const rampAngle = 0.09;
    this.addStatic(
      fixed,
      [{ x: -20, y: Math.sin(rampAngle) * rampLen * 0.5 - 0.25, z: -60, hx: 3, hy: 0.25, hz: rampLen / 2, yaw: 0, pitch: -rampAngle }],
      0xb58b3a,
      0.8,
    );

    this.buildMarkings();
    this.buildCones();
  }

  /** Syncs dynamic props (cones) to their physics bodies. Call once per frame. */
  update(): void {
    const mesh = this.propMesh;
    if (!mesh) return;
    let dirty = false;
    for (const prop of this.props) {
      if (prop.body.isSleeping()) continue;
      const t = prop.body.translation();
      const r = prop.body.rotation();
      this._p.set(t.x, t.y, t.z);
      this._q.set(r.x, r.y, r.z, r.w);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(prop.index, this._m);
      dirty = true;
    }
    if (dirty) mesh.instanceMatrix.needsUpdate = true;
  }

  /** Wet look for the ground (darker, smoother, faint sky reflection). Visual only. */
  setWetness(wetness: number): void {
    if (this.ground) applyWetness(this.ground, wetness);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }

  private buildGround(fixed: RAPIER.RigidBody): void {
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(GROUND_HALF, 0.5, GROUND_HALF).setTranslation(0, -0.5, 0).setFriction(0.9),
      fixed,
    );
    const geo = this.track(new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2));
    geo.rotateX(-Math.PI / 2);
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95 }));
    this.ground = { material: mat, roughness: mat.roughness, color: mat.color.clone() };
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    this.group.add(ground);

    // A faint grid makes speed and sliding readable on an otherwise flat surface.
    const grid = new THREE.GridHelper(GROUND_HALF * 2, GROUND_HALF / 5, 0x55595f, 0x474a50);
    grid.position.y = 0.005;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.track(grid.geometry);
    this.track(grid.material as THREE.Material);
    this.group.add(grid);
  }

  /** Samples a stadium of given radius into box segments. `keep(x, z)` filters segments. */
  private stadiumBarrier(radius: number, out: BoxPiece[], keep: (x: number, z: number) => boolean): void {
    const pts: THREE.Vector2[] = [];
    const half = STRAIGHT_LENGTH / 2;
    const straightSteps = Math.ceil(STRAIGHT_LENGTH / SEGMENT_LENGTH);
    const arcSteps = Math.ceil((Math.PI * radius) / SEGMENT_LENGTH);
    for (let i = 0; i < straightSteps; i++) pts.push(new THREE.Vector2(radius, -half + (i / straightSteps) * STRAIGHT_LENGTH));
    for (let i = 0; i < arcSteps; i++) {
      const a = (i / arcSteps) * Math.PI;
      pts.push(new THREE.Vector2(Math.cos(a) * radius, half + Math.sin(a) * radius));
    }
    for (let i = 0; i < straightSteps; i++) pts.push(new THREE.Vector2(-radius, half - (i / straightSteps) * STRAIGHT_LENGTH));
    for (let i = 0; i < arcSteps; i++) {
      const a = Math.PI + (i / arcSteps) * Math.PI;
      pts.push(new THREE.Vector2(Math.cos(a) * radius, -half + Math.sin(a) * radius));
    }
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const mx = (a.x + b.x) / 2;
      const mz = (a.y + b.y) / 2;
      if (!keep(mx, mz)) continue;
      const len = a.distanceTo(b);
      out.push({
        x: mx,
        y: BARRIER.hy,
        z: mz,
        hx: BARRIER.hz,
        hy: BARRIER.hy,
        hz: len / 2 + 0.05, // slight overlap closes seams on curves
        yaw: Math.atan2(b.x - a.x, b.y - a.y),
      });
    }
  }

  /** Adds colliders on the fixed body and one InstancedMesh for all pieces. */
  private addStatic(fixed: RAPIER.RigidBody, pieces: BoxPiece[], color: number, friction: number): void {
    const geo = this.track(new THREE.BoxGeometry(1, 1, 1));
    const mat = this.track(new THREE.MeshStandardMaterial({ color, roughness: 0.85 }));
    const mesh = new THREE.InstancedMesh(geo, mat, pieces.length);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    pieces.forEach((p, i) => {
      euler.set(p.pitch ?? 0, p.yaw, 0);
      this._q.setFromEuler(euler);
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(p.hx, p.hy, p.hz)
          .setTranslation(p.x, p.y, p.z)
          .setRotation({ x: this._q.x, y: this._q.y, z: this._q.z, w: this._q.w })
          .setFriction(friction)
          .setRestitution(0.15),
        fixed,
      );
      this._p.set(p.x, p.y, p.z);
      this._s.set(p.hx * 2, p.hy * 2, p.hz * 2);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
    });
    this._s.set(1, 1, 1);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** Dashed centre lines on the straights and a start line, purely visual. */
  private buildMarkings(): void {
    const dashes: { x: number; z: number; w: number; l: number }[] = [];
    const half = STRAIGHT_LENGTH / 2;
    for (let z = -half; z < half; z += 8) {
      dashes.push({ x: TURN_RADIUS, z: z + 2, w: 0.15, l: 3 });
      dashes.push({ x: -TURN_RADIUS, z: z + 2, w: 0.15, l: 3 });
    }
    dashes.push({ x: TURN_RADIUS, z: -70, w: TRACK_WIDTH, l: 0.6 });

    const markings: { x: number; z: number; w: number; l: number; yaw: number }[] = dashes.map((d) => ({ ...d, yaw: 0 }));
    for (const radius of [SKIDPAD.r - 4, SKIDPAD.r + 4]) {
      const segs = Math.round((Math.PI * 2 * radius) / 3);
      for (let i = 0; i < segs; i += 2) {
        const a = ((i + 0.5) / segs) * Math.PI * 2;
        markings.push({ x: SKIDPAD.x + Math.cos(a) * radius, z: SKIDPAD.z + Math.sin(a) * radius, w: 0.15, l: 2.6, yaw: -a });
      }
    }

    const geo = this.track(new THREE.PlaneGeometry(1, 1));
    geo.rotateX(-Math.PI / 2);
    const mat = this.track(new THREE.MeshBasicMaterial({ color: 0xe8e8e8 }));
    const mesh = new THREE.InstancedMesh(geo, mat, markings.length);
    const up = new THREE.Vector3(0, 1, 0);
    markings.forEach((d, i) => {
      this._q.setFromAxisAngle(up, d.yaw);
      this._p.set(d.x, 0.01, d.z);
      this._s.set(d.w, 1, d.l);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
    });
    this._s.set(1, 1, 1);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
  }

  /** Light dynamic cones: a slalom in the infield, to test collisions with movable objects. */
  private buildCones(): void {
    const halfHeight = 0.35;
    const radius = 0.22;
    const positions: [number, number][] = [];
    for (let i = 0; i < 10; i++) positions.push([15, -30 + i * 9]);
    for (let i = 0; i < 6; i++) positions.push([28 + (i % 2) * 3, 40 + Math.floor(i / 2) * 3]);

    const geo = this.track(new THREE.ConeGeometry(radius, halfHeight * 2, 12));
    const mat = this.track(new THREE.MeshStandardMaterial({ color: 0xff6a1a, roughness: 0.6 }));
    const mesh = new THREE.InstancedMesh(geo, mat, positions.length);
    mesh.castShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; // cones move; bounding sphere would go stale

    positions.forEach(([x, z], i) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, halfHeight, z).setLinearDamping(0.3).setAngularDamping(0.5),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.cone(halfHeight, radius).setMass(3).setFriction(0.6).setRestitution(0.2),
        body,
      );
      this.props.push({ body, index: i });
      this._q.identity();
      this._p.set(x, halfHeight, z);
      this._m.compose(this._p, this._q, this._s);
      mesh.setMatrixAt(i, this._m);
    });
    this.propMesh = mesh;
    this.group.add(mesh);
  }

  private track<T extends { dispose(): void }>(resource: T): T {
    this.disposables.push(resource);
    return resource;
  }
}

/** Centre line of the stadium circuit as x, z pairs (straights along z, turns at both ends). */
export function stadiumLine(radius: number): Float32Array {
  const half = STRAIGHT_LENGTH / 2;
  const out: number[] = [radius, -half, radius, half];
  for (let i = 1; i < 24; i++) {
    const a = (i / 24) * Math.PI;
    out.push(Math.cos(a) * radius, half + Math.sin(a) * radius);
  }
  out.push(-radius, half, -radius, -half);
  for (let i = 1; i < 24; i++) {
    const a = Math.PI + (i / 24) * Math.PI;
    out.push(Math.cos(a) * radius, -half + Math.sin(a) * radius);
  }
  return new Float32Array(out);
}

function circleLine(cx: number, cz: number, r: number): Float32Array {
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cz + Math.sin(a) * r);
  }
  return new Float32Array(out);
}
