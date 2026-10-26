/**
 * AI traffic checks: lane network (6 lanes, directions, right-hand traffic),
 * spawning, car following, safe braking, overtaking and keeping right, the
 * rear-gap check (also against a 300 km/h player), trucks, weather, lights,
 * despawn / streaming, determinism and collisions with the player.
 */
import { AUTOBAHN as A } from '../src/config/tracks';
import { TRAFFIC } from '../src/config/traffic';
import { SECTION } from '../src/world/autobahn/RoadGenerator';
import type { LaneSample } from '../src/traffic/TrafficLaneNetwork';
import type { TrafficVehicle } from '../src/traffic/TrafficVehicle';
import { check, finish, section } from './lib/sim';
import { TestDriver, idle, makeTrafficSim, placePlayer, type TrafficSim } from './lib/trafficHarness';

/** A clean scenario: manual traffic, no auto spawns, bubble centred on `anchor`. */
async function scenario(anchor = 2500): Promise<TrafficSim> {
  const s = await makeTrafficSim('medium');
  s.traffic.manual = true;
  s.traffic.anchorS = anchor;
  return s;
}

const gapBetween = (a: TrafficVehicle, b: TrafficVehicle) => Math.abs(a.s - b.s) - (a.klass.length + b.klass.length) / 2;

async function main(): Promise<void> {
  section('Lane network');
  {
    const s = await scenario();
    const net = s.track.laneNetwork;
    const offs = net.lanes.map((l) => l.offset);
    const widthsOk = net.lanes.every((l) => l.right < 0 || Math.abs(Math.abs(l.offset - net.lanes[l.right].offset) - A.lane) < 1e-9);
    check('6 lanes from the road generator, 3.75 m apart, neighbours linked', net.lanes.length === 6 && widthsOk && net.lanes[0].left === 1 && net.lanes[2].left === -1 && net.lanes[0].right === -1, `offsets ${offs.map((o) => o.toFixed(3)).join(', ')}`);
    const smp = {} as LaneSample;
    const f = s.track.gen.frame(5000);
    net.sample(net.laneId(0, 0), 5000, smp);
    const hA = smp.heading;
    const kA = smp.curvature;
    // The right lane lies to the driver's right on both carriageways.
    const rightOf = (laneId: number, heading: number) => {
      net.sample(laneId, 5000, smp);
      const rx = -Math.cos(heading);
      const rz = Math.sin(heading);
      return (smp.x - f.x) * rx + (smp.z - f.z) * rz;
    };
    net.sample(net.laneId(1, 0), 5000, smp);
    const hB = smp.heading;
    const kB = smp.curvature;
    check('both carriageways: A with the road, B against it', Math.abs(hA - f.heading) < 1e-9 && Math.abs(hB - f.heading - Math.PI) < 1e-9 && Math.abs(kA + kB) < 1e-12, `heading A ${hA.toFixed(3)}, B ${hB.toFixed(3)}`);
    check('right-hand traffic: lane 0 is the right lane of each carriageway', rightOf(net.laneId(0, 0), hA) > 11 && rightOf(net.laneId(1, 0), hB) > 11 && rightOf(net.laneId(0, 2), hA) > 4, `A lane 0 ${rightOf(net.laneId(0, 0), hA).toFixed(2)} m right, B lane 0 ${rightOf(net.laneId(1, 0), hB).toFixed(2)} m right`);
    const sec = new Set<string>();
    for (let x = 0; x < 30000; x += 50) sec.add(net.sectionAt(x));
    const conns = net.connectionsIn(0, 30000);
    check('sections, speed advice and future exit / rest-area connections', sec.has('tunnel') && sec.has('bridge') && conns.some((c) => c.kind === 'exit') && conns.some((c) => c.kind === 'restAreaOut') && net.advice(5000) > 30, `sections ${[...sec].join(', ')}; ${conns.length} connections`);
  }

  section('Spawning');
  {
    const s = await makeTrafficSim('high');
    idle(s, 0.02);
    const t = s.traffic;
    const vs = t.vehicles;
    let minGap = Infinity;
    for (const a of vs) for (const b of vs) if (a !== b && a.carriageway === b.carriageway && a.lane === b.lane) minGap = Math.min(minGap, gapBetween(a, b));
    const onLanes = vs.every((v) => Math.abs(v.lanePos - v.lane) < 1e-6 && v.s > t.playerS - TRAFFIC.behind - 1 && v.s < t.playerS + TRAFFIC.ahead + 1);
    const nearPlayer = vs.filter((v) => v.carriageway === t.playerCarriageway && Math.abs(v.s - t.playerS) < 100).length;
    check('spawn valid: in lanes, inside the bubble, clear of the player', vs.length >= 40 && onLanes && nearPlayer === 0, `${vs.length} vehicles (high), ${nearPlayer} within 100 m of the player`);
    check('no spawn overlap (same lane gap ≥ 30 m)', minGap >= 30 && t.overlaps() === 0, `closest same-lane gap ${minGap.toFixed(1)} m`);
    const trucksLeft = vs.filter((v) => v.klass.heavy && v.lane > 1).length;
    const dense = await makeTrafficSim('veryHigh');
    idle(dense, 0.02);
    check('very high density: ~100 vehicles, still no overlaps', dense.traffic.vehicles.length >= 85 && dense.traffic.overlaps() === 0, `${dense.traffic.vehicles.length} vehicles (çok yüksek)`);
    check('trucks / buses never spawned in the left lane', trucksLeft === 0, `${vs.filter((v) => v.klass.heavy).length} heavy vehicles`);
    check('only the modelled vehicles spawn (no built-in box cars)', vs.every((v) => v.klass.model !== undefined), [...new Set(vs.map((v) => v.classId))].join(', '));
  }

  section('Car following and braking');
  {
    const s = await scenario(2600);
    const t = s.traffic;
    const lead = t.spawnForTest('truck', 'truck', 0, 0, 2600, 85 / 3.6, 85 / 3.6);
    const fol = t.spawnForTest('truck', 'truck', 0, 0, 2400, 92 / 3.6, 90 / 3.6);
    let maxJerk = 0;
    let lastA = fol.a;
    let minGap = Infinity;
    idle(s, 90, () => {
      t.anchorS = (lead.s + fol.s) / 2;
      maxJerk = Math.max(maxJerk, Math.abs(fol.a - lastA) * 120);
      lastA = fol.a;
      minGap = Math.min(minGap, gapBetween(lead, fol));
    });
    const gap = gapBetween(lead, fol);
    // Desired gap s* = minimum + speed × headway (IDM); at a steady state the free-road term
    // (wanted vs actual speed) stretches it to s* / √(1 - (v / v0)⁴).
    const sStar = fol.profile.minGap + fol.v * fol.profile.headway;
    const eq = sStar / Math.sqrt(1 - (fol.v / t.wantedSpeed(fol)) ** 4);
    check('car following: settles at the IDM gap (minimum + speed × headway), same speed', Math.abs(gap - eq) < eq * 0.25 && gap >= sStar * 0.9 && Math.abs(fol.v - lead.v) < 0.8, `gap ${gap.toFixed(1)} m (s* ${sStar.toFixed(1)}, steady state ${eq.toFixed(1)}), speeds ${(fol.v * 3.6).toFixed(0)} / ${(lead.v * 3.6).toFixed(0)} km/h`);
    check('smooth: jerk-limited acceleration while following', maxJerk <= TRAFFIC.jerk + 0.01 && minGap > 5, `max jerk ${maxJerk.toFixed(2)} m/s³, closest ${minGap.toFixed(1)} m`);

    // Safe braking: the leader brakes hard from 120 km/h, the follower stops behind it.
    const s2 = await scenario(3000);
    const t2 = s2.traffic;
    const l2 = t2.spawnForTest('car', 'normal', 0, 0, 3100, 120 / 3.6, 120 / 3.6);
    const f2 = t2.spawnForTest('car', 'normal', 0, 0, 3040, 120 / 3.6, 120 / 3.6);
    // Pure braking: neither may swerve into another lane here.
    l2.cooldown = f2.cooldown = 1e9;
    idle(s2, 8, () => (t2.anchorS = l2.s));
    l2.desired = 0.5;
    let braked = false;
    let min2 = Infinity;
    let maxDecel = 0;
    let brakeLights = false;
    idle(s2, 25, () => {
      t2.anchorS = l2.s;
      min2 = Math.min(min2, gapBetween(l2, f2));
      maxDecel = Math.max(maxDecel, -f2.a);
      if (f2.a < -1) braked = true;
      if (f2.brake) brakeLights = true;
    });
    check('safe braking: hard stop ahead, follower stops without contact', braked && min2 > 1 && f2.v < 1 && t2.stats().crashes === 0, `closest ${min2.toFixed(1)} m, max deceleration ${maxDecel.toFixed(1)} m/s², final speed ${(f2.v * 3.6).toFixed(1)} km/h`);
    check('brake lights while braking, off when cruising', brakeLights && !l2.brake === (l2.a > -0.7) && !t2.vehicles.some((v) => v.brake && v.a > -0.5 && v.v > 3), 'brake flag follows deceleration');
  }

  section('Overtaking, keeping right, rear gap');
  {
    const s = await scenario(2600);
    const t = s.traffic;
    const truck = t.spawnForTest('truck', 'truck', 0, 0, 2700, 85 / 3.6, 85 / 3.6);
    const car = t.spawnForTest('car', 'normal', 0, 0, 2450, 120 / 3.6, 135 / 3.6);
    let indicatedFirst = false;
    let movedAt = -1;
    let leftMax = 0;
    let passed = false;
    let indicatorRight = false;
    let returnedAt = -1;
    let time = 0;
    idle(s, 80, () => {
      time += 1 / 120;
      t.anchorS = car.s;
      if (car.indicator === 1 && car.lanePos < 0.01) indicatedFirst = true;
      if (movedAt < 0 && car.lanePos > 0.05) movedAt = time;
      leftMax = Math.max(leftMax, car.lanePos);
      if (car.s > truck.s + 30) passed = true;
      if (passed && car.indicator === -1) indicatorRight = true;
      if (passed && returnedAt < 0 && car.lanePos < 0.01 && car.state === 'cruise') returnedAt = time;
    });
    check('overtaking: indicator first, smooth move left, passes the slower truck', indicatedFirst && movedAt > 0 && leftMax > 0.95 && leftMax < 1.05 && passed, `pulled out after ${movedAt.toFixed(1)} s, max lane ${leftMax.toFixed(2)}`);
    check('keeps right: back in the right lane after passing (indicating right)', returnedAt > 0 && indicatorRight, `back right ${returnedAt > 0 ? (returnedAt - movedAt).toFixed(1) : '—'} s after pulling out`);

    // Rear-gap check: a fast car closing in the target lane blocks the overtake until it has passed.
    const s2 = await scenario(2600);
    const t2 = s2.traffic;
    t2.spawnForTest('truck', 'truck', 0, 0, 2700, 85 / 3.6, 85 / 3.6);
    const c2 = t2.spawnForTest('car', 'normal', 0, 0, 2640, 85 / 3.6, 130 / 3.6);
    const fast = t2.spawnForTest('fastCar', 'veryFast', 0, 1, 2520, 200 / 3.6, 210 / 3.6);
    let pulledOutEarly = false;
    let pulledOut = false;
    idle(s2, 25, () => {
      t2.anchorS = c2.s;
      if (c2.lanePos > 0.05 && fast.s < c2.s + 10) pulledOutEarly = true;
      if (c2.lanePos > 0.5) pulledOut = true;
    });
    check('rear-gap check: no pulling out in front of a 200 km/h car', !pulledOutEarly && pulledOut && t2.unsafeLaneChanges === 0, `overtook after the fast car passed: ${pulledOut}`);
  }

  section('300 km/h player approaching');
  {
    const s = await makeTrafficSim('medium');
    const t = s.traffic;
    t.manual = true;
    placePlayer(s, 1500, s.track.laneNetwork.offsetAt(0, 1), 300);
    const truck = t.spawnForTest('truck', 'truck', 0, 0, 2400, 85 / 3.6, 85 / 3.6);
    const car = t.spawnForTest('car', 'normal', 0, 0, 2340, 90 / 3.6, 135 / 3.6);
    car.cooldown = 0;
    // A player who brakes for traffic ahead (as a real one would), in the middle lane.
    const driver = new TestDriver(s, 1, 300, true, true);
    let startTtc = Infinity;
    let startedAhead = false;
    let changedAfter = false;
    let wasIn = false;
    for (let i = 0; i < 120 * 30; i++) {
      driver.step(s);
      const behind = car.s - driver.s;
      const closing = t.playerV - car.v;
      if (!wasIn && car.lanePos > 0.05) {
        wasIn = true;
        if (behind > 0) {
          startedAhead = true;
          startTtc = closing > 0 ? (behind - 5) / closing : Infinity;
        }
      }
      if (behind < -50 && car.lanePos > 0.5) changedAfter = true;
      // Once passed, keep the scene around the AI (the player drives on out of the bubble).
      if (behind < 0) t.anchorS = car.s;
    }
    check('a 300 km/h player behind: the AI does not pull out in front of it', !startedAhead || startTtc >= 6, startedAhead ? `pulled out with the player ${startTtc.toFixed(1)} s away` : 'waited for the player to pass');
    const overtook = car.s > truck.s + 20;
    check('…and still gets past the truck, without any contact', (changedAfter || overtook) && t.stats().crashes === 0, `passed the truck: ${overtook}, crashes ${t.stats().crashes}`);
  }

  section('Trucks, weather, lights');
  {
    const s = await makeTrafficSim('high', 'heavy');
    let truckLeft = 0;
    let truckFast = 0;
    idle(s, 60, () => {
      for (const v of s.traffic.vehicles) {
        if (!v.klass.heavy) continue;
        if (v.lanePos > 1.01) truckLeft++;
        if (v.v * 3.6 > 101) truckFast++;
      }
    });
    const nTrucks = s.traffic.vehicles.filter((v) => v.klass.heavy).length;
    check('trucks / buses: never in the left lane, ≤ 100 km/h', truckLeft === 0 && truckFast === 0 && nTrucks > 5, `${nTrucks} trucks over 60 s`);

    const w = await scenario(5000);
    const t = w.traffic;
    const v = t.spawnForTest('car', 'normal', 0, 1, 5000, 130 / 3.6, 140 / 3.6);
    const straight = (() => {
      for (let x = 4000; x < 40000; x += 100) if (w.track.laneNetwork.advice(x) >= 80 && w.track.laneNetwork.sectionAt(x) === 'normal') return x;
      return 5000;
    })();
    v.s = straight;
    const clear = t.wantedSpeed(v);
    t.conditions.rain = 1;
    t.conditions.visibility = 0.55;
    const rain = t.wantedSpeed(v);
    t.conditions.rain = 0;
    t.conditions.visibility = 0.22;
    const fog = t.wantedSpeed(v);
    check('weather: slower in heavy rain, much slower in fog', rain < clear * 0.9 && fog < 105 / 3.6, `wanted speed clear ${(clear * 3.6).toFixed(0)}, heavy rain ${(rain * 3.6).toFixed(0)}, fog ${(fog * 3.6).toFixed(0)} km/h`);

    t.conditions.visibility = 1;
    t.conditions.night = 0;
    t.conditions.daylight = 1;
    t.anchorS = v.s;
    idle(w, 0.1);
    const day = v.headlights;
    t.conditions.night = 1;
    t.conditions.daylight = 0;
    idle(w, 0.1);
    const night = v.headlights;
    t.conditions.night = 0;
    t.conditions.daylight = 1;
    const tunnel = w.track.gen.features.find((f) => f.kind === 'tunnel' && f.s0 > 3000)!;
    const tv = t.spawnForTest('car', 'normal', 0, 0, (tunnel.s0 + tunnel.s1) / 2, 100 / 3.6, 100 / 3.6);
    t.anchorS = tv.s;
    idle(w, 0.1);
    check('headlights: off by day, on at night', !day && night, `day ${day}, night ${night}`);
    check('headlights in tunnels (by day)', tv.headlights, `tunnel km ${(tunnel.s0 / 1000).toFixed(1)}`);
  }

  section('Despawn, streaming, determinism');
  {
    const s = await makeTrafficSim('medium');
    const t = s.traffic;
    idle(s, 1);
    const before = t.vehicles.length;
    const far = t.vehicles[0];
    far.s = t.playerS + TRAFFIC.ahead + 500;
    idle(s, 0.5);
    check('despawn beyond the bubble', !t.vehicles.includes(far) && t.stats().despawned >= 1, `${before} vehicles, despawned ${t.stats().despawned}`);
    placePlayer(s, 15000, s.track.laneNetwork.offsetAt(0, 1));
    t.onTeleport();
    idle(s, 1);
    const near = t.vehicles.filter((v) => v.carriageway === 0 && Math.abs(v.s - t.playerS) < 100).length;
    check('streaming: teleport refills the bubble around the new spot', t.vehicles.length >= before - 4 && near === 0 && t.vehicles.every((v) => Math.abs(v.s - 15000) < 2800), `${t.vehicles.length} vehicles around km 15`);

    const run = async () => {
      const r = await makeTrafficSim('medium');
      const d = new TestDriver(r, 1, 140, false, true);
      for (let i = 0; i < 120 * 40; i++) d.step(r);
      return r.traffic.vehicles.map((v) => `${v.id}:${v.s.toFixed(3)}:${v.lanePos.toFixed(3)}`).join('|');
    };
    const a = await run();
    const b = await run();
    check('deterministic traffic with the same seed and inputs', a === b && a.length > 0, `${a.split('|').length} vehicles identical after 40 s`);
  }

  section('Switching on, bold drivers');
  {
    const s = await makeTrafficSim('off');
    idle(s, 0.5);
    s.traffic.setDensity('medium');
    idle(s, 0.1);
    const near = s.traffic.vehicles.filter((v) => Math.abs(v.s - s.traffic.playerS) < 400).length;
    check('switching traffic on fills the road at once (also close by)', s.traffic.vehicles.length >= 30 && near >= 3, `${s.traffic.vehicles.length} vehicles 0.1 s after switching on, ${near} within 400 m`);

    // A bold driver just ahead in the next lane, a little faster than the player: it cuts in.
    const c = await makeTrafficSim('medium');
    c.traffic.manual = true;
    c.traffic.setCutIns('many');
    placePlayer(c, 2000, c.track.laneNetwork.offsetAt(0, 1), 110);
    const bold = c.traffic.spawnForTest('sedan_red', 'normal', 0, 0, 2030, 118 / 3.6, 125 / 3.6);
    bold.bold = true;
    bold.cooldown = 0;
    const driver = new TestDriver(c, 1, 110, false, false);
    let minTtc = Infinity;
    let cutIn = false;
    for (let i = 0; i < 120 * 30; i++) {
      driver.step(c);
      if (bold.state === 'changing' && bold.toLane === 1) {
        cutIn = true;
        const gap = bold.s - driver.s - (bold.klass.length + 4.6) / 2;
        const closing = c.traffic.playerV - bold.v;
        if (closing > 0) minTtc = Math.min(minTtc, gap / closing);
      }
    }
    check('bold drivers cut in front of the player, but never into a crash', cutIn && c.traffic.stats().cutIns >= 1 && c.traffic.stats().crashes === 0 && minTtc > 2, `cut in: ${cutIn}, closest time-to-collision ${Number.isFinite(minTtc) ? minTtc.toFixed(1) + ' s' : 'not closing'}, crashes ${c.traffic.stats().crashes}`);
  }

  section('Collisions with the player');
  {
    const s = await scenario(2000);
    const t = s.traffic;
    placePlayer(s, 1700, s.track.laneNetwork.offsetAt(0, 0), 200);
    t.anchorS = null;
    const target = t.spawnForTest('car', 'slow', 0, 0, 1900, 80 / 3.6, 80 / 3.6);
    target.cooldown = 1e9;
    const driver = new TestDriver(s, 0, 200, false);
    let tunnelled = false;
    let hit = false;
    let vBefore = 0;
    let vAfter = 0;
    let aiAfter = 0;
    let since = -1;
    for (let i = 0; i < 120 * 10; i++) {
      const v0 = s.vehicle.physics.forwardSpeed;
      driver.step(s);
      const rel = target.s - driver.s;
      if (!hit && target.state === 'crashed') {
        hit = true;
        vBefore = v0;
        since = 0;
      }
      if (since >= 0 && ++since === 6) {
        vAfter = s.vehicle.physics.forwardSpeed;
        aiAfter = target.v;
      }
      // Passing through: the player ends up ahead in the same lane without any contact.
      if (rel < -3 && !hit && Math.abs(t.playerLanePos - target.lanePos) < 0.6) tunnelled = true;
    }
    check('player can hit AI: contact registered, no tunnelling at 200 km/h', hit && !tunnelled, `player ${(vBefore * 3.6).toFixed(0)} → ${(vAfter * 3.6).toFixed(0)} km/h on impact (AI 80 km/h, ${target.klass.mass} kg)`);
    check('impact exchanges momentum (AI is a real mass, not a wall)', hit && vAfter > 0.2 * vBefore && aiAfter > 85 / 3.6, `AI 80 → ${(aiAfter * 3.6).toFixed(0)} km/h just after the hit, wreck has hazard lights: ${target.indicator === 2}`);
    // Other traffic drives around the wreck.
    const after = t.spawnForTest('car', 'normal', 0, 0, target.s - 300, 110 / 3.6, 120 / 3.6);
    t.anchorS = target.s;
    let hitWreck = false;
    idle(s, 30, () => {
      if (gapBetween(after, target) < 0.3 && Math.abs(after.lanePos - target.lanePos) < 0.8) hitWreck = true;
    });
    check('traffic brakes for / drives around a wreck', !hitWreck && t.stats().crashes === 1, `follower lane ${after.lanePos.toFixed(2)}, gap ${gapBetween(after, target).toFixed(1)} m`);
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void SECTION;
