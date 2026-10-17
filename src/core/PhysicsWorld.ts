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

  step(): void {
    this.world.step();
  }

  dispose(): void {
    this.world.free();
  }
}
