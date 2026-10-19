import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';
import type { DrivingInput } from '../input/DrivingInput';
import { Vehicle } from '../vehicle/Vehicle';
import { VehiclePhysics } from '../vehicle/physics/VehiclePhysics';
import type { Track } from '../world/Track';
import { type PhysicsWorld, RAPIER } from './PhysicsWorld';

/** Something that steps with the physics (AI traffic): before and after each world step. */
export interface SimSystem {
  beforeStep(dt: number): void;
  afterStep(dt: number): void;
  /** The car was put somewhere new (spawn, respawn, teleport). */
  onTeleport?(): void;
}

/**
 * The simulation part of a driving session, with no rendering or DOM: fixed
 * 120 Hz steps from an accumulator, driver input read only while stepping, and
 * the respawn helpers. Pausing = not advancing: no step runs, so the car
 * neither moves nor reads input. Headless tests drive this class directly.
 */
export class DrivingSim {
  readonly physics: PhysicsWorld;
  readonly track: Track;
  readonly vehicle: Vehicle;
  readonly driving: DrivingInput;
  /** Called after each physics step (admin measurements). */
  onStep: ((dt: number) => void) | null = null;
  stepsThisFrame = 0;
  /** Extra systems stepped with the physics, in order. */
  readonly systems: SimSystem[] = [];

  private accumulator = 0;
  private readonly respawnRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly _pos = new THREE.Vector3();

  constructor(physics: PhysicsWorld, track: Track, vehicle: Vehicle, driving: DrivingInput) {
    this.physics = physics;
    this.track = track;
    this.vehicle = vehicle;
    this.driving = driving;
  }

  /** Interpolation factor between the last two physics states. */
  get alpha(): number {
    return this.accumulator / this.physics.fixedDt;
  }

  /**
   * Advances simulated time by dt (already scaled). `running` false (pause,
   * menus): nothing is simulated and the accumulated time is dropped.
   */
  advance(dt: number, running: boolean): number {
    if (!running) {
      this.accumulator = 0;
      this.stepsThisFrame = 0;
      return 0;
    }
    const fixedDt = this.physics.fixedDt;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= fixedDt && steps < GAME_CONFIG.physics.maxStepsPerFrame) {
      this.driving.update(fixedDt);
      this.vehicle.fixedUpdate(fixedDt, this.driving.controls);
      for (const s of this.systems) s.beforeStep(fixedDt);
      this.physics.step();
      this.vehicle.postPhysics();
      for (const s of this.systems) s.afterStep(fixedDt);
      this.onStep?.(fixedDt);
      this.accumulator -= fixedDt;
      steps++;
    }
    // Still behind after the cap: drop the backlog rather than spiral.
    if (steps === GAME_CONFIG.physics.maxStepsPerFrame) this.accumulator = 0;
    this.stepsThisFrame = steps;
    const pos = this.vehicle.physics.position;
    // Streamed worlds build ahead of the car (cheap when nothing is due).
    if (steps > 0) this.track.stream?.(pos);
    if (pos.y < this.track.killHeight || this.track.outOfBounds?.(pos)) this.respawnAtStart();
    return steps;
  }

  /** Put the car back on its wheels where it is, keeping its heading. */
  recoverInPlace(): void {
    const p = this.vehicle.physics.position;
    const ray = this.respawnRay;
    ray.origin.x = p.x;
    ray.origin.y = p.y + 20;
    ray.origin.z = p.z;
    const hit = this.physics.world.castRay(ray, 60, true, undefined, undefined, undefined, this.vehicle.physics.body);
    const groundY = hit ? ray.origin.y - hit.timeOfImpact : 0;
    this._pos.set(p.x, groundY + VehiclePhysics.restHeight(this.vehicle.config) + 0.3, p.z);
    this.place(this._pos, this.vehicle.yaw);
  }

  /** Back to the road: the nearest safe spot on streamed tracks, else the start position. */
  respawnAtStart(): void {
    const s = this.track.safeRespawn?.(this.vehicle.physics.position) ?? this.track.spawn;
    this.placeOnGround(s.position, s.yaw);
  }

  /** Back to the very start (restart). */
  restartAtSpawn(): void {
    const s = this.track.spawn;
    this.placeOnGround(s.position, s.yaw);
  }

  /** Car at a ground point (y = road surface), standing still. */
  placeOnGround(ground: THREE.Vector3, yaw: number): void {
    if (this.track.stream) {
      this.track.stream(ground, true);
      // New colliders only become visible to ray casts after a world step (Rapier's scene queries);
      // the car is reset right after, so this step changes nothing else.
      this.physics.step();
    }
    this._pos.copy(ground).setY(ground.y + VehiclePhysics.restHeight(this.vehicle.config) + 0.05);
    this.place(this._pos, yaw);
    for (const s of this.systems) s.onTeleport?.();
  }

  /** Clears any held driver input (entering pause / menus). */
  releaseInput(): void {
    this.driving.reset();
  }

  dispose(): void {
    this.vehicle.dispose();
    this.track.dispose();
    this.physics.dispose();
  }

  private place(position: THREE.Vector3, yaw: number): void {
    this.vehicle.reset(position, yaw);
    this.driving.reset();
    this.accumulator = 0;
    this.vehicle.render(0);
  }
}
