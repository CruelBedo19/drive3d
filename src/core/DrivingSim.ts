import * as THREE from 'three';
import { GAME_CONFIG } from '../config/gameConfig';
import type { DrivingInput } from '../input/DrivingInput';
import { Vehicle } from '../vehicle/Vehicle';
import { VehiclePhysics } from '../vehicle/physics/VehiclePhysics';
import type { Track } from '../world/Track';
import { type PhysicsWorld, RAPIER } from './PhysicsWorld';

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

  private accumulator = 0;
  private stepRequested = false;
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

  /** Runs one fixed step on the next advance(), even with dt = 0 (admin single step). */
  requestStep(): void {
    this.stepRequested = true;
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
    if (this.stepRequested) {
      this.accumulator = Math.max(this.accumulator, fixedDt);
      this.stepRequested = false;
    }
    let steps = 0;
    while (this.accumulator >= fixedDt && steps < GAME_CONFIG.physics.maxStepsPerFrame) {
      this.driving.update(fixedDt);
      this.vehicle.fixedUpdate(fixedDt, this.driving.controls);
      this.physics.step();
      this.vehicle.postPhysics();
      this.onStep?.(fixedDt);
      this.accumulator -= fixedDt;
      steps++;
    }
    // Still behind after the cap: drop the backlog rather than spiral.
    if (steps === GAME_CONFIG.physics.maxStepsPerFrame) this.accumulator = 0;
    this.stepsThisFrame = steps;
    if (this.vehicle.physics.position.y < this.track.killHeight) this.respawnAtStart();
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

  /** Back to the track's start position. */
  respawnAtStart(): void {
    const s = this.track.spawn;
    this.placeOnGround(s.position, s.yaw);
  }

  /** Car at a ground point (y = road surface), standing still. */
  placeOnGround(ground: THREE.Vector3, yaw: number): void {
    this._pos.copy(ground).setY(ground.y + VehiclePhysics.restHeight(this.vehicle.config) + 0.05);
    this.place(this._pos, yaw);
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
