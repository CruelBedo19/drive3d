import type { VehicleConfig, VehicleSetup } from './vehicleTypes';

/**
 * Autobahn high-speed pack: applied on top of the chosen setup only while
 * driving the Autobahn (other maps keep the cars exactly as tuned). Lower
 * drag, a little more power, a longer top gear and a higher speed limiter take
 * the cars from ~250 to ~340 km/h; low-speed behaviour barely changes
 * (0-200 km/h within ~10 %). Everything is scaled from the setup's own values.
 */
export const AUTOBAHN_SPEED = {
  maxSpeedKmh: 345,
  dragScale: 0.45,
  powerScale: 1.3,
  /** Top gear ratio × this (the gear below × its square root). */
  topGearScale: 0.78,
} as const;

export function autobahnSpeedPatch(c: VehicleConfig): VehicleSetup {
  const k = AUTOBAHN_SPEED;
  const ratios = [...c.gearbox.ratios];
  ratios[ratios.length - 1] *= k.topGearScale;
  if (ratios.length > 1) ratios[ratios.length - 2] *= Math.sqrt(k.topGearScale);
  return {
    maxSpeedKmh: Math.max(c.maxSpeedKmh, k.maxSpeedKmh),
    chassis: { dragCoefficient: c.chassis.dragCoefficient * k.dragScale },
    engine: { maxPowerKw: c.engine.maxPowerKw * k.powerScale },
    gearbox: { ratios },
  };
}
