/** Shared headless test harness: real vehicle code, Rapier world, no browser. */
import * as THREE from 'three';
import { PhysicsWorld, RAPIER } from '../../src/core/PhysicsWorld';
import { SETUPS, applySetup, type SetupId } from '../../src/config/setups';
import { placeholderStreet } from '../../src/config/vehicles/placeholderStreet';
import type { VehicleConfig, VehicleSetup } from '../../src/config/vehicleTypes';
import { DrivingInput, type DriverControls } from '../../src/input/DrivingInput';
import type { InputManager } from '../../src/input/InputManager';
import { Vehicle } from '../../src/vehicle/Vehicle';
import { VehiclePhysics } from '../../src/vehicle/physics/VehiclePhysics';
import { PlaceholderCarVisual } from '../../src/vehicle/visual/PlaceholderCarVisual';
import type { TrackId } from '../../src/config/tracks';
import { TestTrack } from '../../src/world/TestTrack';
import type { Track } from '../../src/world/Track';
import { createTrack } from '../../src/world/createTrack';

export const DT = 1 / 120;

export interface Sim {
  physics: PhysicsWorld;
  vehicle: Vehicle;
  config: VehicleConfig;
  keys: Set<string>;
  driving: DrivingInput;
  /** Direct controls for runControls() (bypasses keyboard smoothing). */
  controls: DriverControls;
  time: number;
  /** Set when built with `track` (e.g. the Nordschleife). */
  track?: Track;
}

export interface SimOptions {
  setup?: SetupId;
  /** Extra overrides on top of the setup (e.g. TC off, drivetrain). */
  override?: VehicleSetup;
  /** Build this track and spawn at its start (ignores withTrack / x / z / yaw). */
  track?: TrackId;
}

export function buildConfig(opts: SimOptions = {}): VehicleConfig {
  const withSetup = applySetup(placeholderStreet.physics, SETUPS[opts.setup ?? 'STREET']);
  return opts.override ? applySetup(withSetup, opts.override) : withSetup;
}

export async function makeSim(withTrack: boolean, x = 0, z = 0, yaw = 0, opts: SimOptions = {}): Promise<Sim> {
  const physics = await PhysicsWorld.create();
  let track: Track | undefined;
  if (opts.track) {
    track = createTrack(opts.track, physics.world);
  } else if (withTrack) {
    new TestTrack(physics.world);
  } else {
    const fixed = physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    physics.world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0), fixed);
  }
  const config = buildConfig(opts);
  const pos = new THREE.Vector3(x, VehiclePhysics.restHeight(config) + 0.05, z);
  if (track) {
    pos.copy(track.spawn.position).y += VehiclePhysics.restHeight(config) + 0.05;
    yaw = track.spawn.yaw;
  }
  const vehicle = new Vehicle(physics.world, config, new PlaceholderCarVisual(config, placeholderStreet.visual), pos, yaw);
  const keys = new Set<string>();
  const fake = { isDown: (c: string) => keys.has(c) } as unknown as InputManager;
  const controls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  return { physics, vehicle, config, keys, driving: new DrivingInput(fake), controls, time: 0, track };
}

function stepOnce(sim: Sim, controls: DriverControls): void {
  sim.vehicle.fixedUpdate(DT, controls);
  sim.physics.step();
  sim.vehicle.postPhysics();
  sim.vehicle.render(1);
  sim.time += DT;
}

/** Drives with keyboard keys held (through the real input smoothing). */
export function run(sim: Sim, seconds: number, keys: string[], each?: (s: Sim) => boolean | void): void {
  sim.keys.clear();
  for (const k of keys) sim.keys.add(k);
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    sim.driving.update(DT);
    stepOnce(sim, sim.driving.controls);
    if (each && each(sim) === true) return;
  }
}

/** Drives with analog controls; `drive` may change sim.controls every step. */
export function runControls(sim: Sim, seconds: number, drive: (s: Sim) => boolean | void): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (drive(sim) === true) return;
    stepOnce(sim, sim.controls);
  }
}

export const kmh = (s: Sim) => s.vehicle.telemetry.speedKmh;
export const upY = (s: Sim) => s.vehicle.physics.up.y;
export function bodySlipDeg(s: Sim): number {
  const p = s.vehicle.physics;
  const v = p.linearVelocity;
  return (Math.atan2(Math.abs(v.dot(p.left)), Math.abs(v.dot(p.forward))) * 180) / Math.PI;
}
/** Signed body slip, rad: + = travelling to the left of the nose. */
export function bodySlipSigned(s: Sim): number {
  const p = s.vehicle.physics;
  const v = p.linearVelocity;
  return Math.atan2(v.dot(p.left), Math.max(Math.abs(v.dot(p.forward)), 0.1));
}

/** Keyboard drift driver: only full left / right / nothing and full throttle / none, like a player. */
export function keyboardDrift(s: Sim, seconds = 6): { band: number; spins: number; maxDeg: number; endKmh: number; counterFrac: number } {
  run(s, 30, ['KeyW'], (x) => kmh(x) >= 60);
  run(s, 0.25, ['KeyW', 'KeyD']);
  run(s, 0.3, ['KeyW', 'KeyD', 'Space']);
  let band = 0;
  let spins = 0;
  let maxDeg = 0;
  let spun = false;
  let bandSteps = 0;
  let counterSteps = 0;
  const steps = Math.round(seconds / DT);
  // Small reaction delay: the decision is re-made every 0.1 s, not every step.
  let keys: string[] = [];
  for (let i = 0; i < steps; i++) {
    if (i % 12 === 0) {
      const beta = bodySlipSigned(s); // + = travelling left of the nose (car drifting right)
      const deg = Math.abs(beta) * 57.3;
      const counter = beta > 0 ? 'KeyA' : 'KeyD';
      const into = beta > 0 ? 'KeyD' : 'KeyA';
      if (deg > 40) keys = [counter];
      else if (deg < 18) keys = ['KeyW', into];
      else keys = ['KeyW', counter];
    }
    run(s, DT, keys);
    const deg = bodySlipDeg(s);
    maxDeg = Math.max(maxDeg, deg);
    if (deg > 15 && deg < 50 && kmh(s) > 20) {
      band += DT;
      bandSteps++;
      // Counter-steer: front wheels turned towards the direction of travel (out of the turn).
      if (Math.sign(s.vehicle.steering.angle) === Math.sign(bodySlipSigned(s))) counterSteps++;
    }
    if (!spun && (deg > 85 || s.vehicle.physics.forwardSpeed < 0)) {
      spins++;
      spun = true;
    }
    if (deg < 40 && s.vehicle.physics.forwardSpeed > 0) spun = false;
  }
  return { band, spins, maxDeg, endKmh: kmh(s), counterFrac: bandSteps ? counterSteps / bandSteps : 0 };
}

let failures = 0;
let total = 0;
export function check(name: string, ok: boolean, detail: string): void {
  total++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
}

export function section(title: string): void {
  console.log(`\n== ${title}`);
}

export function finish(): void {
  console.log(failures === 0 ? `\nALL PASS (${total})` : `\n${failures} of ${total} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}
