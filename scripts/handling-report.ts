/**
 * Handling report: drives every setup through the same keyboard maneuvers and
 * prints the numbers used for tuning. `npm run handling [-- '<json override>']`
 */
import type { SetupId } from '../src/config/setups';
import type { VehicleSetup } from '../src/config/vehicleTypes';
import { DEG2RAD, sampleCurveSmooth } from '../src/utils/math';
import { bodySlipDeg, bodySlipSigned, buildConfig, keyboardDrift, kmh, makeSim, run, runControls, type Sim } from './lib/sim';

export async function report(setup: SetupId, override?: VehicleSetup) {
  const opts = { setup, override };
  const out: Record<string, string> = {};

  let s = await makeSim(false, 0, 0, 0, opts);
  const t0 = s.time;
  let t100 = NaN;
  run(s, 20, ['KeyW'], (x) => {
    if (kmh(x) >= 100) {
      t100 = x.time - t0;
      return true;
    }
  });
  out['0-100'] = `${t100.toFixed(2)}s`;

  s = await makeSim(false, 0, 0, 0, opts);
  run(s, 30, ['KeyW'], (x) => kmh(x) >= 120);
  let lane = 0;
  const track = (x: Sim) => {
    lane = Math.max(lane, bodySlipDeg(x));
  };
  run(s, 0.5, ['KeyA'], track);
  run(s, 0.7, ['KeyD'], track);
  run(s, 2, [], track);
  out['lane120'] = `${lane.toFixed(1)}°`;

  s = await makeSim(false, 0, 0, 0, opts);
  run(s, 20, ['KeyW'], (x) => kmh(x) >= 45);
  let pc = 0;
  run(s, 2.5, ['KeyW', 'KeyD'], (x) => {
    pc = Math.max(pc, bodySlipDeg(x));
  });
  out['powerCorner'] = `${pc.toFixed(1)}°`;

  s = await makeSim(false, 0, 0, 0, opts);
  run(s, 20, ['KeyW'], (x) => kmh(x) >= 70);
  run(s, 0.25, ['KeyD']);
  let hb = 0;
  run(s, 0.9, ['KeyD', 'Space'], (x) => {
    hb = Math.max(hb, bodySlipDeg(x));
  });
  run(s, 3, ['KeyW']);
  out['handbrake'] = `${hb.toFixed(1)}° → ${bodySlipDeg(s).toFixed(0)}° @${kmh(s).toFixed(0)}`;

  const ds = await makeSim(false, 0, 0, 0, opts);
  const d = keyboardDrift(ds);
  // Exit: lift off and let go of the wheel; the car should straighten up by itself.
  let exitT = NaN;
  const tExit = ds.time;
  run(ds, 3, [], (x) => {
    if (bodySlipDeg(x) < 5) {
      exitT = x.time - tExit;
      return true;
    }
  });
  out['kbDrift'] = `${d.band.toFixed(1)}/6s spins ${d.spins} max ${d.maxDeg.toFixed(0)}° end ${d.endKmh.toFixed(0)} exit ${Number.isNaN(exitT) ? '>3' : exitT.toFixed(1)}s`;
  return out;
}

if (process.argv[1]?.endsWith('handling-report.ts') && !process.argv[2]?.startsWith('--')) {
  const override = process.argv[2] ? (JSON.parse(process.argv[2]) as VehicleSetup) : undefined;
  const only = process.argv[3] as SetupId | undefined;
  for (const setup of (only ? [only] : ['STREET', 'SPORT', 'DRIFT']) as SetupId[]) {
    const r = await report(setup, override);
    console.log(setup.padEnd(7), Object.entries(r).map(([k, v]) => `${k} ${v}`).join(' | '));
  }
}

/** SPORT-focused cornering numbers: steady lateral g, front/rear slip balance, turn-in. */
export async function corneringReport(setup: SetupId, override?: VehicleSetup) {
  const opts = { setup, override };
  const out: Record<string, string> = {};
  for (const speed of [60, 100, 140]) {
    const s = await makeSim(false, 0, 0, 0, opts);
    runControls(s, 30, (x) => {
      x.controls.throttle = 1;
      return kmh(x) >= speed;
    });
    let g = 0, front = 0, rear = 0, n = 0, maxSlip = 0;
    runControls(s, 3, (x) => {
      // Hold speed roughly: part throttle, steer at 60% (a normal, committed corner).
      x.controls.throttle = kmh(x) < speed ? 0.6 : 0.15;
      x.controls.steer = 0.6;
      maxSlip = Math.max(maxSlip, bodySlipDeg(x));
      if (x.time > 0) {
        const p = x.vehicle.physics;
        const w = p.wheels;
        g += (p.linearVelocity.length() * Math.abs(p.angularVelocity.y)) / 9.81;
        front += (w[0].combinedSlip + w[1].combinedSlip) / 2;
        rear += (w[2].combinedSlip + w[3].combinedSlip) / 2;
        n++;
      }
    });
    out[`@${speed}`] = `${(g / n).toFixed(2)}g F/R ${(front / n).toFixed(2)}/${(rear / n).toFixed(2)} slip ${maxSlip.toFixed(1)}°`;
  }
  {
    const s = await makeSim(false, 0, 0, 0, opts);
    runControls(s, 30, (x) => {
      x.controls.throttle = 1;
      return kmh(x) >= 100;
    });
    const yaw: number[] = [];
    let i = 0;
    runControls(s, 0.31, (x) => {
      x.controls.throttle = 0.3;
      x.controls.steer = 1;
      if (++i % 18 === 0) yaw.push(Math.abs(x.vehicle.physics.angularVelocity.y));
    });
    out['turnIn100'] = yaw.map((y) => y.toFixed(2)).join('/');
  }
  return out;
}

/**
 * Drift behaviour by angle: an analog driver tries to hold each target angle with
 * throttle + counter-steer; reports the angle reached, spins, and how much the
 * spin assist intervened (mean strength, mean yaw acceleration).
 */
export async function driftAngleReport(setup: SetupId, override?: VehicleSetup) {
  const rows: string[] = [];
  for (const target of [20, 35, 50, 65]) {
    const s = await makeSim(false, 0, 0, 0, { setup, override });
    runControls(s, 30, (x) => {
      x.controls.throttle = 1;
      return kmh(x) >= 60;
    });
    s.controls.steer = -1;
    runControls(s, 0.2, () => {});
    s.controls.handbrake = 1;
    runControls(s, 0.3, () => {});
    s.controls.handbrake = 0;
    const maxA = s.config.steering.maxAngleDeg * DEG2RAD;
    let sum = 0, n = 0, level = 0, accel = 0, spins = 0, spun = false;
    // Like a player: keep turning in with full throttle until the angle is there...
    s.controls.handbrake = 0;
    runControls(s, 1.5, (x) => {
      x.controls.steer = -1;
      x.controls.throttle = 1;
      return Math.abs(bodySlipSigned(x)) / DEG2RAD >= target * 0.8;
    });
    // ...then hold it: front wheels pointed along the direction of travel, throttle rides the angle.
    runControls(s, 6, (x) => {
      const beta = bodySlipSigned(x);
      const deg = Math.abs(beta) / DEG2RAD;
      x.controls.steer = Math.max(-1, Math.min(1, -beta / maxA));
      x.controls.throttle = Math.max(0, Math.min(1, 0.55 + 0.05 * (target - deg)));
      if (x.time > 1) {
        sum += deg;
        n++;
        level += x.vehicle.physics.stabilityLevel;
        accel += Math.abs(x.vehicle.physics.stabilityYawAccel);
      }
      if (!spun && (deg > 90 || x.vehicle.physics.forwardSpeed < 0)) {
        spins++;
        spun = true;
      }
    });
    rows.push(`target ${target}° → avg ${(sum / n).toFixed(0)}° assist ${(level / n).toFixed(2)} (${(accel / n).toFixed(2)} rad/s²) spins ${spins} end ${kmh(s).toFixed(0)}km/h`);
  }
  return rows;
}

/** Assist strength the curve gives per angle (what the code would apply without counter-steer relief). */
export function curveTable(setup: SetupId): string {
  const c = buildConfig({ setup }).assists.stabilityCurve;
  if (!c) return 'threshold mode';
  return [0, 10, 15, 25, 35, 45, 50, 55, 60, 65, 70, 80, 90].map((d) => `${d}°:${sampleCurveSmooth(c, d).toFixed(2)}`).join(' ');
}

if (process.argv[1]?.endsWith('handling-report.ts') && process.argv[2] === '--detail') {
  for (const setup of ['STREET', 'SPORT'] as SetupId[]) {
    const r = await corneringReport(setup);
    console.log('corner', setup.padEnd(6), Object.entries(r).map(([k, v]) => `${k} ${v}`).join(' | '));
  }
  console.log('DRIFT curve', curveTable('DRIFT'));
  const dOverride = process.argv[3] ? (JSON.parse(process.argv[3]) as VehicleSetup) : undefined;
  for (const row of await driftAngleReport('DRIFT', dOverride)) console.log('DRIFT', row);
}

/** Driver mistakes in a drift: can the car be spun, and does the assist catch it? */
export async function mistakeReport(setup: SetupId, override?: VehicleSetup, entryKmh = 60) {
  const cases: [string, (beta: number) => { steer: number; throttle: number }][] = [
    ['full throttle, wheel straight', () => ({ steer: 0, throttle: 1 })],
    ['full throttle, steering INTO the slide', (b) => ({ steer: Math.sign(b), throttle: 1 })],
    ['full throttle, late counter-steer (0.5 s)', (b) => ({ steer: -Math.sign(b) * 0.6, throttle: 1 })],
  ];
  const rows: string[] = [];
  for (const [name, drive] of cases) {
    const s = await makeSim(false, 0, 0, 0, { setup, override });
    runControls(s, 30, (x) => {
      x.controls.throttle = 1;
      return kmh(x) >= entryKmh;
    });
    s.controls.steer = -1;
    runControls(s, 0.2, () => {});
    s.controls.handbrake = 1;
    runControls(s, 0.3, () => {});
    s.controls.handbrake = 0;
    let max = 0, spun = false, peakLevel = 0, t = 0;
    runControls(s, 3, (x) => {
      t += 1 / 120;
      const beta = bodySlipSigned(x);
      const c = name.includes('late') && t < 0.5 ? { steer: Math.sign(beta), throttle: 1 } : drive(beta);
      x.controls.steer = c.steer;
      x.controls.throttle = c.throttle;
      const deg = Math.abs(Math.atan2(x.vehicle.physics.linearVelocity.dot(x.vehicle.physics.left), x.vehicle.physics.forwardSpeed)) / DEG2RAD;
      max = Math.max(max, deg);
      peakLevel = Math.max(peakLevel, x.vehicle.physics.stabilityLevel);
      if (deg > 100) spun = true;
    });
    rows.push(`${entryKmh}km/h ${name.padEnd(42)} max ${max.toFixed(0)}° ${spun ? 'SPIN' : 'caught'} (peak assist ${peakLevel.toFixed(2)})`);
  }
  return rows;
}

if (process.argv[1]?.endsWith('handling-report.ts') && process.argv[2] === '--mistakes') {
  const override = process.argv[3] ? (JSON.parse(process.argv[3]) as VehicleSetup) : undefined;
  for (const v of [60, 90]) for (const row of await mistakeReport('DRIFT', override, v)) console.log('DRIFT', row);
}

if (process.argv[1]?.endsWith('handling-report.ts') && process.argv[2] === '--sport') {
  const override = process.argv[3] ? (JSON.parse(process.argv[3]) as VehicleSetup) : undefined;
  const c = await corneringReport('SPORT', override);
  console.log('corner', Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' | '));
  const r = await report('SPORT', override);
  console.log('SPORT ', Object.entries(r).map(([k, v]) => `${k} ${v}`).join(' | '));
}
