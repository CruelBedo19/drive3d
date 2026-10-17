/**
 * Headless driving tests: runs the real vehicle code in Rapier without a
 * browser and checks the behaviour Phase 1 promises. `npm run test:sim`.
 */
import * as THREE from 'three';
import { VehiclePhysics } from '../src/vehicle/physics/VehiclePhysics';
import { bodySlipDeg, buildConfig, check, finish, kmh, makeSim, run, section, upY } from './lib/sim';

const config = buildConfig();

async function main(): Promise<void> {
  section('Phase 1: core driving (STREET)');
  // 1. Settling at rest.
  {
    const s = await makeSim(false);
    run(s, 3, []);
    const y = s.vehicle.physics.position.y;
    const rest = VehiclePhysics.restHeight(config);
    check('rest: all wheels grounded', s.vehicle.telemetry.groundedWheels === 4, `${s.vehicle.telemetry.groundedWheels}/4`);
    check('rest: settles near rest height', Math.abs(y - rest) < 0.04, `y=${y.toFixed(3)} expected≈${rest.toFixed(3)}`);
    check('rest: stationary, level', kmh(s) < 0.2 && upY(s) > 0.999, `${kmh(s).toFixed(2)} km/h, up.y=${upY(s).toFixed(4)}`);
    check('rest: gear N', s.vehicle.telemetry.gear === 'N', s.vehicle.telemetry.gear);
  }

  // 2. Acceleration, gears, top speed (open ground).
  {
    const s = await makeSim(false);
    run(s, 0.5, []);
    let t100 = -1;
    const start = s.time;
    const gears = new Set<string>();
    let maxRpm = 0;
    run(s, 40, ['KeyW'], (x) => {
      gears.add(x.vehicle.telemetry.gear);
      maxRpm = Math.max(maxRpm, x.vehicle.telemetry.rpm);
      if (t100 < 0 && kmh(x) >= 100) t100 = x.time - start;
    });
    check('accel: 0-100 km/h in 4.5..9 s', t100 > 4.5 && t100 < 9, `${t100.toFixed(2)} s`);
    check('accel: shifts through 1..6', ['1', '2', '3', '4', '5', '6'].every((g) => gears.has(g)), [...gears].join(','));
    check('accel: rpm never above redline+50', maxRpm <= config.engine.redlineRpm + 50, `max ${maxRpm.toFixed(0)}`);
    check('accel: top speed near limit', kmh(s) > config.maxSpeedKmh - 15 && kmh(s) < config.maxSpeedKmh + 6, `${kmh(s).toFixed(1)} km/h`);
    const p = s.vehicle.physics;
    check('accel: straight & stable at top speed', Math.abs(p.position.x) < 1 && upY(s) > 0.99, `x drift ${p.position.x.toFixed(3)} m`);

    // 3. Braking from top speed, still straight.
    const z0 = p.position.z;
    let stopT = -1;
    const t0 = s.time;
    run(s, 15, ['KeyS'], (x) => {
      if (x.vehicle.physics.forwardSpeed < 0.5) {
        stopT = x.time - t0;
        return true;
      }
    });
    check('brake: stops from top speed < 8 s', stopT > 0 && stopT < 8, `${stopT.toFixed(2)} s, ${(p.position.z - z0).toFixed(0)} m`);
    check('brake: stays straight', Math.abs(p.position.x) < 1.5 && upY(s) > 0.98, `x ${p.position.x.toFixed(2)}`);
  }

  // 4. 100-0 braking distance.
  {
    const s = await makeSim(false);
    run(s, 20, ['KeyW'], (x) => kmh(x) >= 100);
    const z0 = s.vehicle.physics.position.z;
    run(s, 10, ['KeyS'], (x) => x.vehicle.physics.forwardSpeed < 0.3);
    const d = s.vehicle.physics.position.z - z0;
    check('brake: 100-0 in 30..55 m', d > 30 && d < 55, `${d.toFixed(1)} m`);
  }

  // 5. Reverse.
  {
    const s = await makeSim(false);
    run(s, 0.5, []);
    run(s, 3, ['KeyS']);
    const v = s.vehicle.physics.forwardSpeed;
    check('reverse: S from rest drives backwards', v < -3 && s.vehicle.telemetry.gear === 'R', `${(v * 3.6).toFixed(1)} km/h, gear ${s.vehicle.telemetry.gear}`);
    run(s, 4, ['KeyW'], (x) => x.vehicle.physics.forwardSpeed > 3);
    check('reverse: W after reverse goes forward', s.vehicle.physics.forwardSpeed > 3 && s.vehicle.telemetry.gear === '1', `gear ${s.vehicle.telemetry.gear}`);
  }

  // 6. Cornering at 60 and 140 km/h with full lock, then release.
  for (const target of [60, 140]) {
    const s = await makeSim(false);
    run(s, 30, ['KeyW'], (x) => kmh(x) >= target);
    let minUp = 1;
    let maxSlip = 0;
    let lat = 0;
    run(s, 3, ['KeyD'], (x) => {
      minUp = Math.min(minUp, upY(x));
      maxSlip = Math.max(maxSlip, bodySlipDeg(x));
      const p = x.vehicle.physics;
      lat = Math.abs(p.linearVelocity.length() * p.angularVelocity.y) / 9.81;
    });
    check(`corner ${target}: no rollover`, minUp > 0.93, `min up.y ${minUp.toFixed(3)}`);
    check(`corner ${target}: no spin (body slip < 12°)`, maxSlip < 12, `${maxSlip.toFixed(1)}°`);
    check(`corner ${target}: lateral grip 0.5..1.2 g`, lat > 0.5 && lat < 1.2, `${lat.toFixed(2)} g`);
    const yawBefore = s.vehicle.physics.angularVelocity.y;
    run(s, 2, ['KeyW']);
    check(`corner ${target}: recovers when released`, Math.abs(s.vehicle.physics.angularVelocity.y) < 0.1 && bodySlipDeg(s) < 3, `yaw ${yawBefore.toFixed(2)} -> ${s.vehicle.physics.angularVelocity.y.toFixed(3)} rad/s`);
    if (target === 60) {
      check('steer: right input turns right', yawBefore < 0, `yaw rate ${yawBefore.toFixed(2)} (negative = right)`);
    }
  }

  // 7. Handbrake turn: rear steps out, then grips again.
  {
    const s = await makeSim(false);
    run(s, 20, ['KeyW'], (x) => kmh(x) >= 70);
    run(s, 0.25, ['KeyD']);
    let maxSlip = 0;
    run(s, 0.9, ['KeyD', 'Space'], (x) => {
      maxSlip = Math.max(maxSlip, bodySlipDeg(x));
    });
    check('handbrake: rear slides (body slip > 15°)', maxSlip > 15, `${maxSlip.toFixed(1)}°`);
    check('handbrake: does not roll over', upY(s) > 0.9, `up.y ${upY(s).toFixed(3)}`);
    run(s, 3, ['KeyW']);
    check('handbrake: grips again after release', bodySlipDeg(s) < 5 || kmh(s) < 5, `slip ${bodySlipDeg(s).toFixed(1)}° at ${kmh(s).toFixed(0)} km/h`);
  }

  // 8. Normal driving does not slide: moderate steering at 80 km/h.
  {
    const s = await makeSim(false);
    run(s, 20, ['KeyW'], (x) => kmh(x) >= 80);
    let maxSlide = 0;
    run(s, 2, ['KeyW', 'KeyA'], (x) => {
      for (const w of x.vehicle.physics.wheels) maxSlide = Math.max(maxSlide, w.slide);
    });
    check('grip: accelerating corner keeps body slip low', bodySlipDeg(s) < 8, `slip ${bodySlipDeg(s).toFixed(1)}°, max wheel slide ${maxSlide.toFixed(2)}`);
  }

  // 8b. Full throttle + full lock in 2nd gear (most torque at the rear): TC keeps it in line.
  {
    const s = await makeSim(false);
    run(s, 20, ['KeyW'], (x) => kmh(x) >= 45);
    let maxSlip = 0;
    run(s, 2.5, ['KeyW', 'KeyD'], (x) => {
      maxSlip = Math.max(maxSlip, bodySlipDeg(x));
    });
    check('grip: 2nd gear power + full lock, no spin', maxSlip < 10 && upY(s) > 0.95, `max body slip ${maxSlip.toFixed(1)}°, gear ${s.vehicle.telemetry.gear}`);
  }

  // 9. Head-on into the infield crash wall (z = 95) at ~90 km/h.
  {
    const s = await makeSim(true, 0, -20, 0);
    let maxZ = -Infinity;
    run(s, 12, ['KeyW'], (x) => {
      maxZ = Math.max(maxZ, x.vehicle.physics.position.z);
    });
    const p = s.vehicle.physics;
    check('collision: wall stops the car (no tunnelling)', maxZ < 95, `max z ${maxZ.toFixed(2)} (wall face 94.5)`);
    run(s, 2, []);
    check('collision: upright after crash', upY(s) > 0.95, `up.y ${upY(s).toFixed(3)} z ${p.position.z.toFixed(2)}`);
  }

  // 10. Barrier scrape along the outer barrier of the main straight.
  {
    const s = await makeSim(true, 64, -100, 0.12);
    let minUp = 1;
    let maxX = -Infinity;
    run(s, 4, ['KeyW'], (x) => {
      minUp = Math.min(minUp, upY(x));
      maxX = Math.max(maxX, x.vehicle.physics.position.x);
    });
    // Barrier inner face at x = 68; body half width 0.86, so contact means maxX ≈ 67.
    check('collision: barrier contact, car stays on track', maxX > 66.5 && maxX < 67.6 && minUp > 0.85, `max x ${maxX.toFixed(2)}, min up.y ${minUp.toFixed(2)}`);
  }

  // 11. Ramp jump: airborne, lands on wheels.
  {
    const s = await makeSim(true, -20, -85, 0);
    let airborne = false;
    run(s, 12, ['KeyW'], (x) => {
      if (x.vehicle.telemetry.groundedWheels === 0) airborne = true;
      return x.vehicle.physics.position.z > -20;
    });
    run(s, 2, []);
    check('ramp: car leaves ground and lands upright', airborne && upY(s) > 0.95 && s.vehicle.telemetry.groundedWheels === 4, `airborne=${airborne} up.y ${upY(s).toFixed(3)}`);
  }

  // 12. Recovery: upside-down car is reset upright and settles.
  {
    const s = await makeSim(false);
    const body = s.vehicle.physics.body;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    body.setTranslation({ x: 3, y: 1.5, z: 7 }, true);
    run(s, 2, []);
    check('respawn: flipped car is upside down', upY(s) < -0.9, `up.y ${upY(s).toFixed(2)}`);
    s.vehicle.reset(new THREE.Vector3(3, VehiclePhysics.restHeight(config) + 0.3, 7), 1.0);
    run(s, 2, []);
    check('respawn: reset upright, grounded, still', upY(s) > 0.999 && s.vehicle.telemetry.groundedWheels === 4 && kmh(s) < 0.3, `up.y ${upY(s).toFixed(4)}, yaw ${s.vehicle.yaw.toFixed(2)}`);
  }

  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
