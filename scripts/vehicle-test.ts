/**
 * Phase 2 physics tests: wheel spin, slip, brakes, drivetrains, differentials,
 * and the STREET / SPORT / DRIFT setups. Part of `npm run test:sim`.
 */
import { Differential } from '../src/vehicle/powertrain/Differential';
import { WHEEL_FL, WHEEL_FR, WHEEL_RL, WHEEL_RR } from '../src/vehicle/physics/WheelState';
import { DEG2RAD, sampleCurveSmooth } from '../src/utils/math';
import { corneringReport, driftAngleReport, mistakeReport } from './handling-report';
import { CAR_REGISTRY } from '../src/config/carRegistry';
import { applySetup, setupFor } from '../src/config/setups';
import { DT, bodySlipDeg, bodySlipSigned, buildConfig, check, finish, keyboardDrift, kmh, makeSim, runControls, section, upY, type Sim, type SimOptions } from './lib/sim';

const NO_TC = { assists: { tractionControl: 0 } };

async function sim(opts: SimOptions = {}): Promise<Sim> {
  return makeSim(false, 0, 0, 0, opts);
}

/** Full throttle straight until `target` km/h (or timeout). Returns seconds taken. */
function speedTo(s: Sim, target: number, timeout = 30): number {
  const t0 = s.time;
  runControls(s, timeout, (x) => {
    x.controls.throttle = 1;
    x.controls.brake = 0;
    x.controls.steer = 0;
    x.controls.handbrake = 0;
    return kmh(x) >= target;
  });
  return s.time - t0;
}

function setControls(s: Sim, throttle: number, brake: number, steer: number, handbrake = 0): void {
  s.controls.throttle = throttle;
  s.controls.brake = brake;
  s.controls.steer = steer;
  s.controls.handbrake = handbrake;
}

/**
 * Simple drift driver: flick + handbrake to start, then point the front wheels
 * along the direction of travel (counter-steer) and ride the throttle to hold
 * a target angle. Returns seconds spent between 15° and 50° and other stats.
 */
function holdDrift(s: Sim, seconds = 6) {
  const target = 0.5;
  speedTo(s, 55);
  setControls(s, 1, 0, -1);
  runControls(s, 0.2, () => {});
  setControls(s, 1, 0, -1, 1);
  runControls(s, 0.25, () => {});
  const maxA = s.config.steering.maxAngleDeg * DEG2RAD;
  let inBand = 0;
  let maxDeg = 0;
  let counterSteer = 0;
  let minSpeed = Infinity;
  const steps = Math.round(seconds * 120);
  let i = 0;
  runControls(s, seconds, (x) => {
    const beta = bodySlipSigned(x);
    x.controls.handbrake = 0;
    x.controls.steer = Math.max(-1, Math.min(1, -(beta * 0.9) / maxA));
    x.controls.throttle = Math.max(0.15, Math.min(1, 0.65 + 2.5 * (target - Math.abs(beta))));
    const deg = Math.abs(beta) / DEG2RAD;
    maxDeg = Math.max(maxDeg, deg);
    if (i > 120) {
      minSpeed = Math.min(minSpeed, kmh(x));
      if (deg > 15 && deg < 50) {
        inBand++;
        // Counter-steer: front wheels turned against the yaw rotation.
        const yaw = x.vehicle.physics.angularVelocity.y;
        if (Math.sign(x.vehicle.steering.angle) === -Math.sign(yaw)) counterSteer++;
      }
    }
    i++;
    return i >= steps;
  });
  return { band: inBand / 120, maxDeg, counterFrac: inBand > 0 ? counterSteer / inBand : 0, minSpeed };
}

/** Full throttle + full right lock from 45 km/h for 2.5 s. */
function powerCorner(s: Sim): { maxSlip: number; maxRearSlip: number; maxFrontSlip: number } {
  speedTo(s, 45);
  let maxSlip = 0;
  let maxRearSlip = 0;
  let maxFrontSlip = 0;
  setControls(s, 1, 0, 1);
  runControls(s, 2.5, (x) => {
    const w = x.vehicle.physics.wheels;
    maxSlip = Math.max(maxSlip, bodySlipDeg(x));
    maxRearSlip = Math.max(maxRearSlip, w[WHEEL_RL].combinedSlip, w[WHEEL_RR].combinedSlip);
    maxFrontSlip = Math.max(maxFrontSlip, w[WHEEL_FL].combinedSlip, w[WHEEL_FR].combinedSlip);
  });
  return { maxSlip, maxRearSlip, maxFrontSlip };
}

async function main(): Promise<void> {
  section('Wheel dynamics');
  {
    const s = await sim();
    speedTo(s, 80);
    setControls(s, 0, 0, 0);
    runControls(s, 0.5, () => {});
    const r = s.config.wheel.radius;
    const errs = s.vehicle.physics.wheels.map((w) => Math.abs(w.angularVelocity * r - w.longitudinalSpeed) / Math.abs(w.longitudinalSpeed));
    check('wheel ω matches ground speed when rolling', errs.every((e) => e < 0.03), `max error ${(Math.max(...errs) * 100).toFixed(2)}%`);
    const w0 = s.vehicle.physics.wheels[0];
    check('wheel ω ≈ v / r at 80 km/h', Math.abs(w0.angularVelocity - 80 / 3.6 / r) < 3, `ω ${w0.angularVelocity.toFixed(1)} rad/s (v/r ${(80 / 3.6 / r).toFixed(1)})`);
  }
  {
    const s = await sim({ override: NO_TC });
    let maxRear = 0;
    let maxFront = 0;
    let maxRpm = 0;
    setControls(s, 1, 0, 0);
    runControls(s, 1.5, (x) => {
      const w = x.vehicle.physics.wheels;
      maxRear = Math.max(maxRear, w[WHEEL_RL].slipRatio, w[WHEEL_RR].slipRatio);
      maxFront = Math.max(maxFront, Math.abs(w[WHEEL_FL].slipRatio), Math.abs(w[WHEEL_FR].slipRatio));
      maxRpm = Math.max(maxRpm, x.vehicle.telemetry.rpm);
    });
    check('wheel spin: RWD launch without TC spins rears', maxRear > 0.3, `max rear slip ratio ${maxRear.toFixed(2)}`);
    check('wheel spin: undriven fronts just roll', maxFront < 0.05, `max front |slip ratio| ${maxFront.toFixed(3)}`);
    const sTc = await sim();
    let maxRearTc = 0;
    setControls(sTc, 1, 0, 0);
    runControls(sTc, 1.5, (x) => {
      const w = x.vehicle.physics.wheels;
      if (x.time > 0.3) maxRearTc = Math.max(maxRearTc, w[WHEEL_RL].slipRatio, w[WHEEL_RR].slipRatio);
    });
    check('wheel spin: STREET TC limits launch wheelspin', maxRearTc < 0.35 && maxRearTc < maxRear * 0.6, `max rear slip ratio ${maxRearTc.toFixed(2)} (no TC ${maxRear.toFixed(2)})`);
  }
  {
    const off = powerCorner(await sim({ override: NO_TC }));
    const on = powerCorner(await sim());
    check('traction loss: no TC, power + lock exceeds rear grip', off.maxRearSlip > 1.5 && off.maxSlip > on.maxSlip + 5, `rear slip ${off.maxRearSlip.toFixed(1)}, body ${off.maxSlip.toFixed(1)}° (TC on ${on.maxSlip.toFixed(1)}°)`);
  }

  section('Braking');
  {
    const brakeRun = async (abs: number) => {
      const s = await sim({ override: { assists: { abs } } });
      speedTo(s, 100);
      const z0 = s.vehicle.physics.position.z;
      let lockedSteps = 0;
      let minKappa = 0;
      setControls(s, 0, 1, 0);
      runControls(s, 8, (x) => {
        // Like real ABS, judge it above ~15 km/h; it hands over to the brakes just before a stop.
        if (kmh(x) > 15) for (const w of x.vehicle.physics.wheels) {
          if (w.locked) lockedSteps++;
          minKappa = Math.min(minKappa, w.slipRatio);
        }
        return x.vehicle.physics.forwardSpeed < 0.5;
      });
      return { dist: s.vehicle.physics.position.z - z0, lockedSteps, minKappa };
    };
    const absOn = await brakeRun(1);
    const absOff = await brakeRun(0);
    check('ABS: wheels keep rolling under full brake', absOn.minKappa > -0.35 && absOn.lockedSteps < 40, `min slip ${absOn.minKappa.toFixed(2)}, locked wheel-steps ${absOn.lockedSteps}, ${absOn.dist.toFixed(1)} m`);
    check('no ABS: full brake locks wheels', absOff.minKappa <= -0.9 && absOff.lockedSteps > 200, `min slip ${absOff.minKappa.toFixed(2)}, locked wheel-steps ${absOff.lockedSteps}, ${absOff.dist.toFixed(1)} m`);

    const steerWhileBraking = async (abs: number) => {
      const s = await sim({ override: { assists: { abs } } });
      speedTo(s, 80);
      let yaw = 0;
      setControls(s, 0, 1, 1);
      runControls(s, 1.0, (x) => {
        yaw = Math.max(yaw, Math.abs(x.vehicle.physics.angularVelocity.y));
      });
      return yaw;
    };
    const yawAbs = await steerWhileBraking(1);
    const yawLocked = await steerWhileBraking(0);
    check('locked fronts lose steering, ABS keeps it', yawAbs > yawLocked * 2, `max yaw rate ABS ${yawAbs.toFixed(2)} vs locked ${yawLocked.toFixed(2)} rad/s`);
  }
  {
    const s = await sim();
    speedTo(s, 60);
    let rearForce = 0;
    let frontForce = 0;
    setControls(s, 0, 0, 0, 1);
    runControls(s, 0.5, (x) => {
      const w = x.vehicle.physics.wheels;
      rearForce = Math.min(rearForce, w[WHEEL_RL].longitudinalForce, w[WHEEL_RR].longitudinalForce);
      frontForce = Math.max(frontForce, Math.abs(w[WHEEL_FL].longitudinalForce), Math.abs(w[WHEEL_FR].longitudinalForce));
    });
    // STREET's handbrake drags the rears near (not past) the grip limit; DRIFT's locks them.
    check('handbrake brakes the rear wheels only', rearForce < -1800 && frontForce < 150, `rear tyre force ${rearForce.toFixed(0)} N, front max ${frontForce.toFixed(0)} N`);
  }

  section('Drivetrain torque distribution');
  const accelSample = async (drivetrain: 'RWD' | 'FWD' | 'AWD') => {
    const s = await sim({ override: { drivetrain } });
    speedTo(s, 40);
    setControls(s, 1, 0, 0);
    let front = 0;
    let rear = 0;
    runControls(s, 1.0, (x) => {
      const w = x.vehicle.physics.wheels;
      front += w[WHEEL_FL].command.driveTorque + w[WHEEL_FR].command.driveTorque;
      rear += w[WHEEL_RL].command.driveTorque + w[WHEEL_RR].command.driveTorque;
    });
    return { front, rear, frontShare: front / (front + rear) };
  };
  {
    const rwd = await accelSample('RWD');
    check('RWD: all drive torque on the rear axle', rwd.front === 0 && rwd.rear > 0, `front ${rwd.front.toFixed(0)}, rear ${rwd.rear.toFixed(0)}`);
    const fwd = await accelSample('FWD');
    check('FWD: all drive torque on the front axle', fwd.rear === 0 && fwd.front > 0, `front ${fwd.front.toFixed(0)}, rear ${fwd.rear.toFixed(0)}`);
    const awd = await accelSample('AWD');
    check('AWD: front share matches awdFrontSplit (0.40)', Math.abs(awd.frontShare - 0.4) < 0.02, `front share ${awd.frontShare.toFixed(3)}`);
  }
  {
    const t = async (drivetrain: 'RWD' | 'AWD') => speedTo(await sim({ override: { drivetrain, ...NO_TC } }), 100);
    const tRwd = await t('RWD');
    const tAwd = await t('AWD');
    check('AWD launches harder than RWD without TC', tAwd < tRwd - 0.2, `0-100 AWD ${tAwd.toFixed(2)} s vs RWD ${tRwd.toFixed(2)} s`);
  }
  {
    const fwd = powerCorner(await sim({ override: { drivetrain: 'FWD', ...NO_TC } }));
    const rwd = powerCorner(await sim({ override: NO_TC }));
    check('FWD power-on corner: fronts slide (understeer)', fwd.maxFrontSlip > fwd.maxRearSlip && fwd.maxSlip < 10, `front ${fwd.maxFrontSlip.toFixed(1)} rear ${fwd.maxRearSlip.toFixed(1)}, body ${fwd.maxSlip.toFixed(1)}°`);
    check('RWD power-on corner: rears slide (oversteer)', rwd.maxRearSlip > rwd.maxFrontSlip && rwd.maxSlip > 15, `front ${rwd.maxFrontSlip.toFixed(1)} rear ${rwd.maxRearSlip.toFixed(1)}, body ${rwd.maxSlip.toFixed(1)}°`);
  }

  section('Differential');
  {
    const out: [number, number] = [0, 0];
    const open = new Differential({ type: 'OPEN', powerLock: 0, coastLock: 0, preload: 0 });
    open.split(1000, 50, 10, 1.5, 1.5, 1 / 120, out);
    check('OPEN diff: equal torque despite speed difference', out[0] === 500 && out[1] === 500, `${out[0]} / ${out[1]} Nm`);
    const lsd = new Differential({ type: 'LSD', powerLock: 0.5, coastLock: 0.2, preload: 50 });
    lsd.split(1000, 50, 10, 1.5, 1.5, 1 / 120, out);
    check('LSD: torque moves to the slower wheel, capped by lock', out[1] > out[0] && Math.abs(lsd.transfer) <= 50 + 500 + 1e-9, `${out[0].toFixed(0)} / ${out[1].toFixed(0)} Nm (transfer ${lsd.transfer.toFixed(0)}, cap 550)`);
    lsd.split(1000, 30, 30, 1.5, 1.5, 1 / 120, out);
    check('LSD: no transfer when wheels turn together', out[0] === 500 && out[1] === 500, `${out[0]} / ${out[1]} Nm`);
    lsd.split(-400, 30, 31, 1.5, 1.5, 1 / 120, out);
    check('LSD: coast lock caps engine-braking transfer', Math.abs(lsd.transfer) <= 50 + 80 + 1e-9, `transfer ${lsd.transfer.toFixed(1)} Nm (cap 130)`);
  }
  {
    const splitMu = async (type: 'OPEN' | 'LSD') => {
      const s = await sim({ override: { ...NO_TC, differential: { type, powerLock: 0.6, coastLock: 0.3, preload: 100 } } });
      s.vehicle.physics.wheels[WHEEL_RL].surfaceGrip = 0.2; // ice under the left rear
      let ratio = 0;
      // Part throttle: more than the ice wheel can take, less than the grippy one can.
      setControls(s, 0.4, 0, 0);
      runControls(s, 3, (x) => {
        const w = x.vehicle.physics.wheels;
        if (x.time > 1) ratio = Math.max(ratio, w[WHEEL_RL].angularVelocity / Math.max(1, w[WHEEL_RR].angularVelocity));
      });
      return { speed: kmh(s), ratio };
    };
    const open = await splitMu('OPEN');
    const lsd = await splitMu('LSD');
    check('split-µ OPEN: wheel on ice spins, car crawls', open.ratio > 2, `RL/RR spin ratio ${open.ratio.toFixed(1)}, ${open.speed.toFixed(1)} km/h after 3 s`);
    check('split-µ LSD: drives the grippy wheel, much faster', lsd.speed > open.speed * 1.3, `LSD ${lsd.speed.toFixed(1)} km/h vs OPEN ${open.speed.toFixed(1)} km/h`);
  }

  section('STREET stability');
  {
    const s = await sim();
    speedTo(s, 120);
    let maxSlip = 0;
    let minUp = 1;
    const phase = (steer: number, t: number) => {
      setControls(s, 0.3, 0, steer);
      runControls(s, t, (x) => {
        maxSlip = Math.max(maxSlip, bodySlipDeg(x));
        minUp = Math.min(minUp, upY(x));
      });
    };
    phase(-1, 0.5);
    phase(1, 0.7);
    phase(0, 2);
    const yaw = Math.abs(s.vehicle.physics.angularVelocity.y);
    check('STREET: 120 km/h lane change stays composed', maxSlip < 8 && minUp > 0.95 && yaw < 0.05, `max slip ${maxSlip.toFixed(1)}°, settled yaw ${yaw.toFixed(3)} rad/s`);
    const drift = holdDrift(await sim());
    check('STREET: refuses to hold a drift', drift.band < 1, `in 15-50° band ${drift.band.toFixed(2)} s, max ${drift.maxDeg.toFixed(0)}°`);
  }

  section('SPORT');
  {
    const yawAfter = async (setup: 'STREET' | 'SPORT') => {
      const s = await sim({ setup });
      speedTo(s, 80);
      setControls(s, 0.3, 0, 1);
      runControls(s, 0.1, () => {});
      return Math.abs(s.vehicle.physics.angularVelocity.y);
    };
    const street = await yawAfter('STREET');
    const sport = await yawAfter('SPORT');
    check('SPORT: quicker turn-in than STREET', sport > street * 1.15, `yaw rate after 0.1 s: SPORT ${sport.toFixed(2)} vs STREET ${street.toFixed(2)} rad/s`);
    const sportPower = powerCorner(await sim({ setup: 'SPORT' }));
    const streetPower = powerCorner(await sim());
    check('SPORT: power-on corner stays controllable', sportPower.maxSlip < 8 && streetPower.maxSlip < 8, `body slip SPORT ${sportPower.maxSlip.toFixed(1)}° vs STREET ${streetPower.maxSlip.toFixed(1)}°`);
    const cs = await corneringReport('SPORT');
    const cst = await corneringReport('STREET');
    const g = (v: string) => Number.parseFloat(v);
    const front = (v: string) => Number.parseFloat(v.split('F/R ')[1]);
    check('SPORT: ≥10% more cornering grip than STREET', [60, 100, 140].every((k) => g(cs[`@${k}`]) > g(cst[`@${k}`]) * 1.1), `SPORT ${[60, 100, 140].map((k) => g(cs[`@${k}`]).toFixed(2)).join('/')} g vs STREET ${[60, 100, 140].map((k) => g(cst[`@${k}`]).toFixed(2)).join('/')} g`);
    check('SPORT: front tyres held at their peak (no understeer slide)', [60, 100, 140].every((k) => front(cs[`@${k}`]) <= 1.2), `front slip ${[60, 100, 140].map((k) => front(cs[`@${k}`]).toFixed(2)).join('/')} (1 = peak)`);
    const s = await sim({ setup: 'SPORT' });
    speedTo(s, 100);
    let maxSlip = 0;
    setControls(s, 0, 0, 1);
    runControls(s, 3, (x) => {
      maxSlip = Math.max(maxSlip, bodySlipDeg(x));
    });
    check('SPORT: off-throttle 100 km/h full lock stays in line', maxSlip < 10 && upY(s) > 0.95, `max body slip ${maxSlip.toFixed(1)}°`);
  }

  section('DRIFT');
  {
    const lockAt = async (setup: 'STREET' | 'DRIFT') => {
      const s = await sim({ setup });
      setControls(s, 0, 0, 1);
      runControls(s, 1, () => {});
      return Math.abs(s.vehicle.steering.angle) / DEG2RAD;
    };
    const street = await lockAt('STREET');
    const drift = await lockAt('DRIFT');
    check('DRIFT: much more steering lock', drift > street * 1.3, `${drift.toFixed(1)}° vs STREET ${street.toFixed(1)}°`);

    // Driven like a player: full left / right / nothing, full throttle or none.
    const held = keyboardDrift(await sim({ setup: 'DRIFT' }));
    check('DRIFT: keyboard driver holds a 15-50° drift', held.band > 2.5 && held.spins === 0 && held.endKmh > 25, `in band ${held.band.toFixed(1)} of 6 s, spins ${held.spins}, max ${held.maxDeg.toFixed(0)}°, end ${held.endKmh.toFixed(0)} km/h`);
    check('DRIFT: slide is held with counter-steer', held.counterFrac > 0.65, `counter-steering ${(held.counterFrac * 100).toFixed(0)}% of the drift`);
    const kbStreet = keyboardDrift(await sim());
    const kbSport = keyboardDrift(await sim({ setup: 'SPORT' }));
    check('STREET / SPORT: same driver cannot drift, never spins', kbStreet.band < 1 && kbSport.band < 1.5 && kbStreet.spins + kbSport.spins === 0, `STREET ${kbStreet.band.toFixed(1)} s, SPORT ${kbSport.band.toFixed(1)} s in band`);

    {
      const c = buildConfig({ setup: 'DRIFT' }).assists.stabilityCurve ?? [];
      const at = (deg: number) => sampleCurveSmooth(c, deg);
      const zone = [15, 25, 35, 45].map(at);
      const rising = [45, 50, 55, 60, 70, 80, 90].map(at);
      check('DRIFT assist: almost silent in the 15-45° zone', zone.every((v) => v <= 0.05), zone.map((v) => v.toFixed(2)).join(' '));
      check('DRIFT assist: rises smoothly past 45°', rising.every((v, i) => i === 0 || v >= rising[i - 1]) && at(80) > at(45) * 10, rising.map((v) => v.toFixed(2)).join(' '));
      const angles = await driftAngleReport('DRIFT');
      const avg = (row: string) => Number.parseFloat(row.split('avg ')[1]);
      check('DRIFT: throttle changes the drift angle', avg(angles[2]) > avg(angles[0]) + 12, angles.map((r) => r.split(' assist')[0]).join(' | '));
      check('DRIFT: controlled drift gets ~no assist', angles.slice(0, 3).every((r) => Number.parseFloat(r.split('assist ')[1]) < 0.05), angles.slice(0, 3).map((r) => r.split('assist ')[1].split(' ')[0]).join(' / '));
      const mistakes = await mistakeReport('DRIFT', undefined, 60);
      check('DRIFT: gross mistake can spin / lose it, late catch is saved', /SPIN|max (9\d|1\d\d)°/.test(mistakes[1]) && mistakes[2].includes('caught'), mistakes.map((m) => m.replace(/\s+/g, ' ').slice(5, 80)).join(' | '));
    }
    {
      const d = await sim({ setup: 'DRIFT' });
      speedTo(d, 60);
      let locked = false;
      setControls(d, 0, 0, 0, 1);
      runControls(d, 0.5, (x) => {
        const w = x.vehicle.physics.wheels;
        locked ||= w[WHEEL_RL].locked && w[WHEEL_RR].locked;
      });
      check('DRIFT: handbrake locks the rear wheels', locked, `rear locked ${locked}`);
    }

    const s = await sim({ setup: 'DRIFT' });
    speedTo(s, 150);
    const x0 = s.vehicle.physics.position.x;
    setControls(s, 0.6, 0, 0);
    runControls(s, 3, () => {});
    const dx = Math.abs(s.vehicle.physics.position.x - x0);
    check('DRIFT: still straight and stable at 150 km/h', dx < 1 && Math.abs(s.vehicle.physics.angularVelocity.y) < 0.02, `lateral drift ${dx.toFixed(3)} m`);
  }

  section('Selectable cars (factory data): brakes, stopping, drift');
  {
    const cars = CAR_REGISTRY.map((c) => ({ id: c.id, physics: c.definition.physics }));
    const brakeRows: string[] = [];
    let worst = 0;
    for (const c of cars) {
      // Keyboard S from 100 km/h (input smoothing included) until stopped.
      const s = await makeSim(false, 0, 0, 0, { override: structuredClone(c.physics) });
      runControls(s, 0.25, () => {});
      s.vehicle.physics.body.setLinvel({ x: 0, y: 0, z: 100 / 3.6 }, true);
      for (const w of s.vehicle.physics.wheels) w.angularVelocity = 100 / 3.6 / s.config.wheel.radius;
      const z0 = s.vehicle.physics.position.z;
      s.keys.add('KeyS');
      for (let i = 0; i < 6 * 120; i++) {
        s.driving.update(DT);
        s.vehicle.fixedUpdate(DT, s.driving.controls);
        s.physics.step();
        s.vehicle.postPhysics();
        if (s.vehicle.physics.forwardSpeed < 0.2) break;
      }
      const d = s.vehicle.physics.position.z - z0;
      worst = Math.max(worst, d);
      brakeRows.push(`${c.id} ${d.toFixed(0)}`);
      // Held S after stopping: the car stays put a moment before reversing.
      if (c.id === 'bmw_m3_e92') {
        const zStop = s.vehicle.physics.position.z;
        for (let i = 0; i < 0.5 * 120; i++) {
          s.driving.update(DT);
          s.vehicle.fixedUpdate(DT, s.driving.controls);
          s.physics.step();
          s.vehicle.postPhysics();
        }
        const rolled = zStop - s.vehicle.physics.position.z;
        check('braking to a stop with S holds the car (no roll into reverse)', rolled < 0.1, `${rolled.toFixed(2)} m back in the 0.5 s after stopping`);
      }
    }
    check('every car stops from 100 km/h within 30 m (keyboard)', worst < 30, brakeRows.join(', ') + ' m');
    const driftRows: string[] = [];
    let bad = 0;
    for (const c of cars) {
      const cfg = applySetup(c.physics, setupFor(c.physics, 'DRIFT'));
      const d = keyboardDrift(await makeSim(false, 0, 0, 0, { override: cfg }));
      const ok = d.band > 3 && d.spins === 0 && d.maxDeg < 60;
      if (!ok) bad++;
      driftRows.push(`${c.id} ${d.band.toFixed(1)} s/${d.maxDeg.toFixed(0)}°${ok ? '' : ' ✗'}`);
    }
    check('DRIFT: every car holds a keyboard drift (15-50° most of 6 s, no spin)', bad === 0, driftRows.join(', '));
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
