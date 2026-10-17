/** Global, non-vehicle tunables. */
export const GAME_CONFIG = {
  physics: {
    /** Fixed physics step. 120 Hz keeps stiff suspension springs stable. */
    fixedDt: 1 / 120,
    /** Upper bound on physics steps per rendered frame (avoids the spiral of death). */
    maxStepsPerFrame: 8,
    gravity: -9.81,
    solverIterations: 4,
  },
  render: {
    maxPixelRatio: 2,
    shadowMapSize: 2048,
    /** Half size of the area the sun shadow covers around the car. */
    shadowRange: 40,
  },
  world: {
    /** Below this height the car is respawned automatically. */
    killHeight: -30,
  },
} as const;
