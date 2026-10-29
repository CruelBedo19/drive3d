import RAPIER from '@dimforge/rapier3d-compat';
import { GAME_CONFIG } from '../config/gameConfig';

export { RAPIER };

/**
 * Thin owner of the Rapier world. Everything physical (track, vehicles, props)
 * creates its bodies through `world`; the game loop calls step() at a fixed rate.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly fixedDt: number;

  private constructor(world: RAPIER.World, fixedDt: number) {
    this.world = world;
    this.fixedDt = fixedDt;
  }

  private static ready: Promise<void> | null = null;

  /** Initialise Rapier's WASM ahead of time (the boot preloader), so the first session starts at once. */
  static async warmUp(): Promise<void> {
    PhysicsWorld.ready ??= RAPIER.init();
    await PhysicsWorld.ready;
  }

  /** Rapier's WASM must be initialised once before any other call (later sessions reuse it). */
  static async create(): Promise<PhysicsWorld> {
    PhysicsWorld.ready ??= RAPIER.init();
    await PhysicsWorld.ready;
    const cfg = GAME_CONFIG.physics;
    const world = new RAPIER.World({ x: 0, y: cfg.gravity, z: 0 });
    world.timestep = cfg.fixedDt;
    world.numSolverIterations = cfg.solverIterations;
    return new PhysicsWorld(world, cfg.fixedDt);
  }

  /**
   * One step of the pipeline. Not `World.step()`: since Rapier 0.21 it also walks every collider and body through JS
   * callbacks afterwards (mapNewSoftBodies: wrappers for pieces torn off soft bodies), ~0.14 µs and some garbage per
   * collider each step; this game makes every body and collider through the JS API, which wraps them already.
   */
  step(): void {
    const w = this.world;
    w.physicsPipeline.step(w.gravity, w.integrationParameters, w.islands, w.broadPhase, w.narrowPhase, w.bodies, w.colliders, w.softBodies, w.impulseJoints, w.multibodyJoints, w.ccdSolver);
  }

  dispose(): void {
    this.world.free();
  }
}
