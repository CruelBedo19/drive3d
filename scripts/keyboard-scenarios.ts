/**
 * Real keyboard scenarios (taps, releases) through the real input path, with
 * timelines of what the car does. `npx tsx scripts/keyboard-scenarios.ts [setup] [scenario]`
 */
import type { SetupId } from '../src/config/setups';
import { DEG2RAD } from '../src/utils/math';
import { DT, bodySlipSigned, kmh, makeSim, run, type Sim } from './lib/sim';

export interface Snapshot {
  t: number;
  kmh: number;
  steerDeg: number;
  slipDeg: number;
  yawRate: number;
  vLat: number;
  heading: number;
  rearSlip: number;
  rearKappa: number;
  frontSlip: number;
  latG: number;
  assist: number;
  recovery: number;
}

export function snap(s: Sim, t0: number, heading0: number): Snapshot {
  const p = s.vehicle.physics;
  const w = p.wheels;
  return {
    t: s.time - t0,
    kmh: kmh(s),
    steerDeg: s.vehicle.steering.angle / DEG2RAD,
    slipDeg: bodySlipSigned(s) / DEG2RAD,
    yawRate: p.angularVelocity.y,
    vLat: p.linearVelocity.dot(p.left),
    heading: (s.vehicle.yaw - heading0) / DEG2RAD,
    rearSlip: (w[2].combinedSlip + w[3].combinedSlip) / 2,
    rearKappa: (w[2].slipRatio + w[3].slipRatio) / 2,
    frontSlip: (w[0].combinedSlip + w[1].combinedSlip) / 2,
    latG: (Math.abs(p.linearVelocity.dot(p.forward)) * Math.abs(p.angularVelocity.y)) / 9.81,
    assist: p.stabilityYawAccel,
    recovery: p.recoveryLevel,
  };
}

export function fmt(x: Snapshot): string {
  return `t ${x.t.toFixed(2).padStart(5)} ${x.kmh.toFixed(0).padStart(3)}km/h steer ${x.steerDeg.toFixed(1).padStart(6)}° slip ${x.slipDeg.toFixed(1).padStart(6)}° yaw ${x.yawRate.toFixed(2).padStart(5)} vLat ${x.vLat.toFixed(1).padStart(5)} hdg ${x.heading.toFixed(0).padStart(5)}° g ${x.latG.toFixed(2)} frontσ ${x.frontSlip.toFixed(2)} rearσ ${x.rearSlip.toFixed(2).padStart(4)} κ ${x.rearKappa.toFixed(2).padStart(5)} assist ${x.assist.toFixed(2)} rec ${x.recovery.toFixed(2)}`;
}

/** Holds `keys` for `seconds`, logging every `every` seconds. */
export function phase(s: Sim, seconds: number, keys: string[], log: Snapshot[], t0: number, h0: number, every = 0.1): void {
  const n = Math.round(seconds / DT);
  const k = Math.round(every / DT);
  for (let i = 0; i < n; i++) {
    run(s, DT, keys);
    if ((i + 1) % k === 0) log.push(snap(s, t0, h0));
  }
}

/** W to `speed`, then a keyboard drift entry to the left: A + handbrake tap. */
export function driftEntry(s: Sim, speed = 70): void {
  run(s, 30, ['KeyW'], (x) => kmh(x) >= speed);
  run(s, 0.35, ['KeyW', 'KeyA']);
  run(s, 0.25, ['KeyW', 'KeyA', 'Space']);
  run(s, 0.3, ['KeyW', 'KeyA']);
}

if (process.argv[1]?.endsWith('keyboard-scenarios.ts')) {
  const setup = (process.argv[2] ?? 'DRIFT') as SetupId;
  const scenario = process.argv[3] ?? 'all';
  const show = (title: string, log: Snapshot[]) => {
    console.log(`\n== ${setup} ${title}`);
    for (const x of log) console.log(fmt(x));
  };
  if (scenario === 'all' || scenario === 'tap') {
    const s = await makeSim(false, 0, 0, 0, { setup });
    run(s, 30, ['KeyW'], (x) => kmh(x) >= 60);
    const log: Snapshot[] = [];
    const t0 = s.time, h0 = s.vehicle.yaw;
    phase(s, 0.1, ['KeyW', 'KeyA'], log, t0, h0, 0.025);
    phase(s, 0.6, ['KeyW'], log, t0, h0, 0.1);
    show('W + short A tap (0.1 s)', log);
  }
  if (scenario === 'all' || scenario === 'counter') {
    const s = await makeSim(false, 0, 0, 0, { setup });
    driftEntry(s);
    const log: Snapshot[] = [];
    const t0 = s.time, h0 = s.vehicle.yaw;
    log.push(snap(s, t0, h0));
    phase(s, 0.15, ['KeyW', 'KeyD'], log, t0, h0, 0.05);
    phase(s, 3, ['KeyW'], log, t0, h0, 0.2);
    show('drift left → one D tap (0.15 s) → W only', log);
  }
  if (scenario === 'all' || scenario === 'recover') {
    const s = await makeSim(false, 0, 0, 0, { setup });
    driftEntry(s);
    const log: Snapshot[] = [];
    const t0 = s.time, h0 = s.vehicle.yaw;
    log.push(snap(s, t0, h0));
    phase(s, 0.6, ['KeyW', 'KeyD'], log, t0, h0, 0.2);
    phase(s, 4, ['KeyW'], log, t0, h0, 0.25);
    show('drift left → D counter 0.6 s → release, W only', log);
  }
  if (scenario === 'all' || scenario === 'sport') {
    for (const v of [80, 120, 160, 200]) {
      for (const hold of [0.2, 1.5]) {
        const s = await makeSim(false, 0, 0, 0, { setup });
        run(s, 40, ['KeyW'], (x) => kmh(x) >= v);
        const log: Snapshot[] = [];
        const t0 = s.time, h0 = s.vehicle.yaw;
        phase(s, hold, ['KeyW', 'KeyD'], log, t0, h0, hold / 4);
        phase(s, 0.5, ['KeyW'], log, t0, h0, 0.25);
        show(`${v} km/h, W + D held ${hold} s`, log);
      }
    }
  }
}
