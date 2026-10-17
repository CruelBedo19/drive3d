/**
 * Real-player keyboard scenarios (taps and releases through the real input
 * path) with measured steering, slip, yaw, sideways speed, recovery time and
 * heading error. Part of `npm run test:sim`.
 */
import { driftEntry, phase, snap, type Snapshot } from './keyboard-scenarios';
import { bodySlipDeg, check, finish, kmh, makeSim, run, section } from './lib/sim';

const fmt1 = (v: number) => v.toFixed(1);

async function main(): Promise<void> {
  section('SPORT: W + D at 80 / 120 / 160 / 200 km/h (tap 0.2 s, hold 1.5 s)');
  for (const v of [80, 120, 160, 200]) {
    for (const hold of [0.2, 1.5]) {
      const s = await makeSim(false, 0, 0, 0, { setup: 'SPORT' });
      run(s, 40, ['KeyW'], (x) => kmh(x) >= v);
      const log: Snapshot[] = [];
      const t0 = s.time;
      const h0 = s.vehicle.yaw;
      phase(s, hold, ['KeyW', 'KeyD'], log, t0, h0, 1 / 120);
      const during = log.slice();
      phase(s, 0.6, ['KeyW'], log, t0, h0, 1 / 120);
      const maxYaw = Math.max(...log.map((x) => Math.abs(x.yawRate)));
      const maxSlip = Math.max(...log.map((x) => Math.abs(x.slipDeg)));
      const maxSteer = Math.max(...during.map((x) => Math.abs(x.steerDeg)));
      const frontMax = Math.max(...during.map((x) => x.frontSlip));
      const rearMax = Math.max(...during.map((x) => x.rearSlip));
      const heading = Math.abs(log.at(-1)!.heading);
      // Mean lateral g over the last 0.5 s of the input (averages out the turn-in transient).
      const win = during.filter((x) => x.t > hold - 0.5);
      const latG = win.reduce((sum, x) => sum + x.latG, 0) / Math.max(1, win.length);
      // A short tap should change heading noticeably; holding should turn hard; neither by sliding the rear.
      const needHeading = hold < 1 ? 6 : 30;
      check(
        `SPORT ${v} km/h, D ${hold} s turns on grip`,
        heading > needHeading && maxSlip < 8 && rearMax < 1,
        `steer ${fmt1(maxSteer)}°, heading ${fmt1(heading)}°, peak yaw ${maxYaw.toFixed(2)} rad/s, ${hold < 1 ? '' : `mean ${latG.toFixed(2)} g, `}front σ ${frontMax.toFixed(2)}, rear σ ${rearMax.toFixed(2)}, body slip ${fmt1(maxSlip)}°`,
      );
    }
  }

  section('DRIFT test 1: W + short A tap');
  for (const tap of [0.1, 0.2]) {
    const s = await makeSim(false, 0, 0, 0, { setup: 'DRIFT' });
    run(s, 30, ['KeyW'], (x) => kmh(x) >= 60);
    const log: Snapshot[] = [];
    const t0 = s.time;
    const h0 = s.vehicle.yaw;
    phase(s, tap, ['KeyW', 'KeyA'], log, t0, h0, 1 / 120);
    phase(s, 0.6, ['KeyW'], log, t0, h0, 1 / 120);
    const maxSteer = Math.max(...log.map((x) => Math.abs(x.steerDeg)));
    const maxSlip = Math.max(...log.map((x) => Math.abs(x.slipDeg)));
    const lock = s.config.steering.maxAngleDeg;
    check(`A ${tap * 1000} ms tap = small correction`, maxSteer < lock * 0.3, `max steer ${fmt1(maxSteer)}° of ${lock}° lock, heading change ${fmt1(log.at(-1)!.heading)}°, max slip ${fmt1(maxSlip)}°`);
  }
  {
    const h = await makeSim(false, 0, 0, 0, { setup: 'DRIFT' });
    run(h, 30, ['KeyW'], (x) => kmh(x) >= 30);
    let tFull = NaN;
    const th = h.time;
    const ramp: string[] = [];
    let i = 0;
    run(h, 1.5, ['KeyW', 'KeyA'], (x) => {
      if (++i % 12 === 0) ramp.push(Math.abs(x.vehicle.steering.position).toFixed(2));
      if (Math.abs(x.vehicle.steering.position) >= 0.999) {
        tFull = x.time - th;
        return true;
      }
    });
    check('holding A still reaches full lock quickly', tFull > 0.25 && tFull < 0.6, `full lock after ${tFull.toFixed(2)} s, wheel position every 0.1 s: ${ramp.join(' → ')}`);
  }

  section('DRIFT test 2: drift → one counter-steer tap → release');
  for (const tap of [0.1, 0.2, 0.3]) {
    const s = await makeSim(false, 0, 0, 0, { setup: 'DRIFT' });
    driftEntry(s);
    const log: Snapshot[] = [];
    const t0 = s.time;
    const h0 = s.vehicle.yaw;
    log.push(snap(s, t0, h0));
    phase(s, tap, ['KeyW', 'KeyD'], log, t0, h0, 1 / 120);
    phase(s, 3, ['KeyW'], log, t0, h0, 1 / 120);
    const maxSlip = Math.max(...log.map((x) => Math.abs(x.slipDeg)));
    const settled = log.find((x) => x.t > tap && Math.abs(x.slipDeg) < 5 && Math.abs(x.yawRate) < 0.15);
    const end = log.at(-1)!;
    check(`D tap ${tap} s: no spin, settles`, maxSlip < 85 && settled !== undefined, `entry slip ${fmt1(log[0].slipDeg)}°, max ${fmt1(maxSlip)}°, settled after ${settled ? settled.t.toFixed(2) : '—'} s, end yaw ${end.yawRate.toFixed(2)} rad/s, vLat ${end.vLat.toFixed(2)} m/s`);
  }

  section('DRIFT test 3: drift → counter-steer → release wheel → W only');
  for (const [entry, hold] of [[70, 0.6], [50, 1.2], [90, 1.0], [110, 0.2]] as const) {
    const s = await makeSim(false, 0, 0, 0, { setup: 'DRIFT' });
    driftEntry(s, entry);
    const log: Snapshot[] = [];
    const t0 = s.time;
    const h0 = s.vehicle.yaw;
    phase(s, hold, ['KeyW', 'KeyD'], log, t0, h0, 1 / 120);
    const release = log.length;
    const atRelease = log[release - 1];
    phase(s, 5, ['KeyW'], log, t0, h0, 1 / 120);
    const after = log.slice(release);
    const rec = after.find((x) => Math.abs(x.slipDeg) < 5 && Math.abs(x.yawRate) < 0.15);
    const recT = rec ? rec.t - hold : NaN;
    // Heading error: how much the car keeps turning once it is straight (should be ~nothing).
    const fromRec = rec ? after.filter((x) => x.t >= rec.t) : [];
    const headingDrift = fromRec.length ? Math.abs(fromRec.at(-1)!.heading - fromRec[0].heading) : NaN;
    const span = fromRec.length ? fromRec.at(-1)!.t - fromRec[0].t : 0;
    const maxYawAfter = Math.max(...fromRec.map((x) => Math.abs(x.yawRate)));
    const maxVLat = Math.max(...fromRec.map((x) => Math.abs(x.vLat)));
    const maxSteerAfter = Math.max(...fromRec.map((x) => Math.abs(x.steerDeg)));
    const tag = `${entry} km/h entry, D ${hold} s`;
    check(`${tag}: releasing recovers`, recT < 2.5, `at release slip ${fmt1(atRelease.slipDeg)}°, yaw ${atRelease.yawRate.toFixed(2)} rad/s, vLat ${atRelease.vLat.toFixed(1)} m/s; recovered (|slip|<5°, |yaw|<0.15) ${recT.toFixed(2)} s after release`);
    check(`${tag}: then goes straight`, headingDrift < 15 && maxYawAfter < 0.3 && maxVLat < 1.2, `heading error ${fmt1(headingDrift)}° over ${span.toFixed(1)} s, max yaw ${maxYawAfter.toFixed(2)} rad/s, max vLat ${maxVLat.toFixed(2)} m/s, max steer ${fmt1(maxSteerAfter)}°, end ${kmh(s).toFixed(0)} km/h`);
  }

  section('DRIFT test 4: wrong steering (into the slide) + full throttle');
  {
    let spins = 0;
    const results: string[] = [];
    for (const v of [50, 70, 90]) {
      const s = await makeSim(false, 0, 0, 0, { setup: 'DRIFT' });
      driftEntry(s, v);
      let maxSlip = 0;
      let spun = false;
      run(s, 3, ['KeyW', 'KeyA'], (x) => {
        maxSlip = Math.max(maxSlip, bodySlipDeg(x));
        if (maxSlip > 85 || x.vehicle.physics.forwardSpeed < 0) spun = true;
      });
      if (spun) spins++;
      results.push(`${v} km/h: ${spun ? 'spin' : 'caught'} (max ${maxSlip.toFixed(0)}°)`);
    }
    check('a big mistake can still spin the car', spins >= 2, results.join(', '));
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
