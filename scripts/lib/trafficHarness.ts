/** Headless Autobahn + traffic harness: real vehicle, track, Rapier world and traffic, as the game steps them. */
import * as THREE from 'three';
import type { TrafficDensity, TrafficVariety } from '../../src/config/traffic';
import { TrafficSystem } from '../../src/traffic/TrafficSystem';
import type { AutobahnTrack } from '../../src/world/autobahn/AutobahnTrack';
import { makeSim, type Sim } from './sim';

export interface TrafficSim extends Sim {
  track: AutobahnTrack;
  traffic: TrafficSystem;
}

export async function makeTrafficSim(density: TrafficDensity = 'medium', variety: TrafficVariety = 'mixed', seed = 2026): Promise<TrafficSim> {
  const s = (await makeSim(false, 0, 0, 0, { track: 'autobahn' })) as TrafficSim;
  const p = s.vehicle.physics;
  s.traffic = new TrafficSystem(s.physics.world, s.track.laneNetwork, { position: p.position, velocity: p.linearVelocity, forward: p.forward, halfExtents: s.config.chassis.halfExtents }, seed, density, variety);
  return s;
}

/** One fixed step in the game's order: car, traffic, world, car post, traffic post, streaming. */
export function stepAll(s: TrafficSim, c: { throttle: number; brake: number; steer: number }): void {
  const dt = s.physics.fixedDt;
  s.vehicle.fixedUpdate(dt, { ...c, handbrake: 0 });
  s.traffic.beforeStep(dt);
  s.physics.step();
  s.vehicle.postPhysics();
  s.traffic.afterStep(dt);
  s.track.stream(s.vehicle.physics.position);
  s.time += dt;
}

/** Steps with the player standing still. */
export function idle(s: TrafficSim, seconds: number, each?: () => void): void {
  for (let i = 0; i < Math.round(seconds * 120); i++) {
    stepAll(s, { throttle: 0, brake: 1, steer: 0 });
    each?.();
  }
}

/** Puts the player at road distance s on a lateral offset, facing direction A, rolling at `kmh`. */
export function placePlayer(s: TrafficSim, roadS: number, off: number, kmh = 0): void {
  const g = s.track.gen;
  const p = g.toWorld(roadS, off);
  s.track.stream(new THREE.Vector3(p.x, p.y, p.z), true);
  s.physics.step();
  const f = g.frame(roadS);
  s.vehicle.reset(new THREE.Vector3(p.x, p.y + 0.6, p.z), f.heading);
  const v = kmh / 3.6;
  s.vehicle.physics.body.setLinvel({ x: Math.sin(f.heading) * v, y: 0, z: Math.cos(f.heading) * v }, true);
  s.vehicle.postPhysics();
}

/**
 * Test driver (not in the game): pure pursuit on a lateral offset of direction
 * A; `hold` keeps the speed by setting the body velocity (the test car tops
 * out at 250 km/h; the harness checks road / traffic at 300+, not handling).
 * `aware`: slows behind traffic and picks the freest lane like a careful driver.
 */
export class TestDriver {
  lane: number;
  kmh: number;
  hold: boolean;
  aware: boolean;
  private sNow: number;
  private readonly target = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private laneTimer = 0;
  private wanted: number;

  constructor(s: TrafficSim, lane: number, kmh: number, hold: boolean, aware = false) {
    this.lane = lane;
    this.kmh = kmh;
    this.hold = hold;
    this.aware = aware;
    const p = s.vehicle.physics.position;
    this.sNow = s.track.gen.nearestS(p.x, p.z, s.track.progress, 400);
    this.wanted = kmh;
  }

  get s(): number {
    return this.sNow;
  }

  step(s: TrafficSim): void {
    const g = s.track.gen;
    const ph = s.vehicle.physics;
    const p = ph.position;
    this.sNow = g.nearestS(p.x, p.z, this.sNow, 60);
    if (this.aware) this.plan(s);
    const off = s.track.laneNetwork.offsetAt(0, this.lane);
    const speed = ph.forwardSpeed;
    const look = Math.max(12, speed * 0.7);
    const tp = g.toWorld(this.sNow + look, off);
    this.target.set(tp.x, tp.y, tp.z).sub(p);
    const angle = Math.atan2(this.target.dot(ph.left), this.target.dot(ph.forward));
    const steer = Math.max(-1, Math.min(1, -angle * 2.5));
    const v = this.wanted / 3.6;
    const throttle = this.hold ? 0.3 : speed < v - 1 ? 1 : 0;
    const brake = !this.hold && speed > v + 2 ? 0.4 : 0;
    stepAll(s, { throttle, brake, steer });
    if (this.hold) {
      const lv = ph.body.linvel();
      this.fwd.copy(ph.forward).setY(0).normalize();
      // Smooth speed changes (≤ 6 m/s² either way) towards the wanted speed.
      const cur = Math.hypot(lv.x, lv.z);
      const next = cur + Math.max(-6 / 120, Math.min(6 / 120, v - cur));
      ph.body.setLinvel({ x: this.fwd.x * next, y: lv.y, z: this.fwd.z * next }, true);
    }
  }

  /** Careful driver: keeps 2 s to the vehicle ahead in its lane, moves to the freest lane now and then. */
  private plan(s: TrafficSim): void {
    const t = s.traffic;
    const ahead = (lane: number) => {
      let best = Infinity;
      let speed = Infinity;
      for (const v of t.vehicles) {
        if (v.carriageway !== 0) continue;
        if (Math.abs(v.lanePos - lane) > 0.7) continue;
        const d = v.s - this.sNow;
        if (d > 0 && d < best) {
          best = d;
          speed = v.v * 3.6;
        }
      }
      return { gap: best, speed };
    };
    const cur = ahead(this.lane);
    const v = Math.max(1, s.vehicle.physics.forwardSpeed);
    this.laneTimer -= 1 / 120;
    if (this.laneTimer <= 0 && cur.gap < v * 6) {
      // Freest neighbour lane, only if nothing is alongside or just behind there.
      for (const l of [this.lane + 1, this.lane - 1]) {
        if (l < 0 || l > 2) continue;
        const clear = !t.vehicles.some((x) => x.carriageway === 0 && Math.abs(x.lanePos - l) < 0.9 && x.s - this.sNow > -40 && x.s - this.sNow < 30);
        if (clear && ahead(l).gap > cur.gap + 40) {
          this.lane = l;
          this.laneTimer = 4;
          break;
        }
      }
    }
    const now = ahead(this.lane);
    const safe = now.gap - 10 - v * 2;
    this.wanted = safe < 0 ? Math.min(this.kmh, now.speed - 10) : safe < v * 3 ? Math.min(this.kmh, now.speed + safe / 3) : this.kmh;
    this.wanted = Math.max(30, this.wanted);
  }
}
