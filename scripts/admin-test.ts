/**
 * Admin / test-environment tests: live tuning reaches the physics, config
 * helpers keep references, measurements are right. Part of `npm run test:sim`.
 */
import { Measurements, type MeasurementSample } from '../src/admin/Measurements';
import { assignDeep, getPath, setPath } from '../src/admin/configPath';
import { TUNING_GROUPS } from '../src/admin/tuningSchema';
import { diff } from '../src/admin/TuningStore';
import { SETUPS, applySetup } from '../src/config/setups';
import { placeholderStreet } from '../src/config/vehicles/placeholderStreet';
import { WHEEL_FL, WHEEL_FR } from '../src/vehicle/physics/WheelState';
import { bodySlipDeg, check, finish, kmh, makeSim, runControls, section, type Sim } from './lib/sim';

function sample(over: Partial<MeasurementSample>): MeasurementSample {
  return { speedKmh: 0, forwardSpeed: 0, brake: 0, lateralG: 0, driftDeg: 0, distance: 0, ...over };
}

function edit(s: Sim, path: string, value: unknown): void {
  setPath(s.vehicle.config, path, value);
  s.vehicle.refreshConfig();
}

/** Rapier recomputes mass properties during a step. */
function stepWorld(s: Sim): void {
  s.physics.step();
}

async function main(): Promise<void> {
  section('Measurements');
  {
    const m = new Measurements();
    const dt = 1 / 120;
    for (let i = 0; i < 60; i++) m.update(dt, sample({}));
    // Linear 0 -> 110 km/h over 5 s: 100 km/h at 4.545 s.
    for (let t = dt; t <= 5 + 1e-9; t += dt) {
      const kmhNow = (110 * t) / 5;
      m.update(dt, sample({ speedKmh: kmhNow, forwardSpeed: kmhNow / 3.6, distance: (kmhNow / 3.6) * dt }));
    }
    const r = m.results;
    check('0-100 timed from first movement', r.zeroTo100 !== null && Math.abs(r.zeroTo100 - 4.545) < 0.02, `${r.zeroTo100?.toFixed(3)} s (expected 4.545)`);
    // Brake 110 -> 0 at 10 m/s²: distance from 100 km/h = v²/2a = 38.58 m.
    let v = 110 / 3.6;
    while (v > 0) {
      const nv = Math.max(0, v - 10 * dt);
      m.update(dt, sample({ speedKmh: nv * 3.6, forwardSpeed: nv, brake: 1, distance: ((v + nv) / 2) * dt }));
      v = nv;
    }
    check('100-0 braking distance', r.brake100To0 !== null && Math.abs(r.brake100To0 - 38.58) < 1.2, `${r.brake100To0?.toFixed(2)} m (expected ≈38.6)`);
    check('top speed tracked', Math.abs(r.topSpeed - 110) < 0.5, `${r.topSpeed.toFixed(1)} km/h`);
    for (let i = 0; i < 240; i++) m.update(dt, sample({ speedKmh: 50, forwardSpeed: 13, driftDeg: 30, lateralG: 0.8 }));
    m.update(dt, sample({ speedKmh: 50, forwardSpeed: 13, driftDeg: 5 }));
    check('drift duration and lateral g', Math.abs(r.bestDrift - 2) < 0.02 && r.currentDrift === 0 && r.maxLateralG === 0.8, `best drift ${r.bestDrift.toFixed(2)} s, max ${r.maxLateralG} g`);
    const m2 = new Measurements();
    m2.update(dt, sample({ speedKmh: 120, forwardSpeed: 33, brake: 1, distance: 0.3 }));
    m2.update(dt, sample({ speedKmh: 110, forwardSpeed: 30, brake: 0, distance: 0.3 }));
    m2.update(dt, sample({ speedKmh: 0, forwardSpeed: 0, brake: 1, distance: 0 }));
    check('releasing the brake cancels the 100-0 run', m2.results.brake100To0 === null, `${m2.results.brake100To0}`);
  }

  section('Config helpers');
  {
    const live = structuredClone(placeholderStreet.physics);
    const steeringRef = live.steering;
    const ratiosBefore = live.gearbox.ratios;
    const drift = applySetup(placeholderStreet.physics, SETUPS.DRIFT);
    assignDeep(live, drift);
    check('assignDeep keeps sub-object references', live.steering === steeringRef && live.steering.maxAngleDeg === 52, `maxAngle ${live.steering.maxAngleDeg}`);
    (drift.gearbox.ratios as number[])[0] = 99;
    check('assignDeep copies arrays (no aliasing)', live.gearbox.ratios[0] !== 99 && live.gearbox.ratios !== ratiosBefore, `1st ratio ${live.gearbox.ratios[0]}`);
    const evil = JSON.parse('{"__proto__": {"polluted": true}, "chassis": {"mass": 1500}}');
    const merged = applySetup(placeholderStreet.physics, evil);
    assignDeep(live, evil);
    check('imported JSON cannot pollute prototypes', ({} as Record<string, unknown>).polluted === undefined && merged.chassis.mass === 1500, `mass ${merged.chassis.mass}`);
    const tuned = applySetup(placeholderStreet.physics, { rear: { grip: 0.7 }, gearbox: { ratios: [3, 2, 1.5, 1.2, 1, 0.8] } });
    const patch = diff(placeholderStreet.physics, tuned);
    check('working tune stores only changed values', JSON.stringify(patch) === JSON.stringify({ rear: { grip: 0.7 }, gearbox: { ratios: [3, 2, 1.5, 1.2, 1, 0.8] } }), JSON.stringify(patch));
    const missing = TUNING_GROUPS.flatMap((g) => g.params).filter((p) => getPath(placeholderStreet.physics, p.path) === undefined);
    check('every panel parameter exists in the config', missing.length === 0, missing.length ? missing.map((p) => p.path).join(', ') : `${TUNING_GROUPS.flatMap((g) => g.params).length} parameters`);
  }

  section('Live tuning reaches the physics');
  {
    const s = await makeSim(false);
    edit(s, 'chassis.mass', 2000);
    stepWorld(s);
    check('mass edit updates the rigid body', Math.abs(s.vehicle.physics.body.mass() - 2000) < 0.01, `body mass ${s.vehicle.physics.body.mass().toFixed(1)} kg`);

    s.controls.throttle = 1;
    runControls(s, 1, () => {});
    edit(s, 'drivetrain', 'FWD');
    let front = 0;
    runControls(s, 0.5, (x) => {
      const w = x.vehicle.physics.wheels;
      front = Math.max(front, w[WHEEL_FL].command.driveTorque + w[WHEEL_FR].command.driveTorque);
    });
    check('drivetrain switch while driving', front > 0, `front axle torque ${front.toFixed(0)} Nm`);

    edit(s, 'steering.maxAngleDeg', 50);
    const s2 = await makeSim(false);
    edit(s2, 'steering.maxAngleDeg', 50);
    s2.controls.steer = 1;
    runControls(s2, 1, () => {});
    check('steering lock edit applies', Math.abs(Math.abs(s2.vehicle.steering.angle) * (180 / Math.PI) - 50) < 0.1, `${(Math.abs(s2.vehicle.steering.angle) * 180 / Math.PI).toFixed(1)}°`);

    // Rear grip cut mid-corner makes the car oversteer.
    const corner = async (rearGrip: number | null) => {
      const c = await makeSim(false);
      c.controls.throttle = 1;
      runControls(c, 20, (x) => kmh(x) >= 70);
      if (rearGrip !== null) edit(c, 'rear.grip', rearGrip);
      c.controls.throttle = 0.3;
      c.controls.steer = 1;
      let max = 0;
      runControls(c, 2, (x) => {
        max = Math.max(max, bodySlipDeg(x));
      });
      return max;
    };
    const normal = await corner(null);
    const slippery = await corner(0.6);
    check('grip edit changes handling live', slippery > normal + 10, `body slip ${slippery.toFixed(1)}° vs ${normal.toFixed(1)}°`);

    const s3 = await makeSim(false);
    edit(s3, 'chassis.centerOfMass.y', 0.2);
    edit(s3, 'chassis.centerOfMass.z', 0.4);
    stepWorld(s3);
    const com = s3.vehicle.physics.body.localCom();
    check('centre-of-mass edit updates the body', Math.abs(com.y - 0.2) < 1e-6 && Math.abs(com.z - 0.4) < 1e-6, `local CoM ${com.x.toFixed(2)}, ${com.y.toFixed(2)}, ${com.z.toFixed(2)}`);
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
