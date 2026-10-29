import * as THREE from 'three';
import { RAPIER } from '../../core/PhysicsWorld';
import { CITY_TRAFFIC as C, TRAFFIC, TRAFFIC_CLASSES, DRIVER_PROFILES, cityVariety, type TrafficClassId, type TrafficCutIns, type TrafficDensity, type TrafficVariety } from '../../config/traffic';
import { signalPhase } from '../../world/cityv2/propKit';
import { obbOverlap, type PlayerProbe, type TrafficConditions } from '../TrafficSystem';
import type { TrafficPose, TrafficVehicle } from '../TrafficVehicle';
import type { CityLaneGraph, CitySeg } from './CityLaneGraph';

/** A city vehicle: the shared vehicle record (drawing, minimap) plus where it is on the lane graph. */
export interface CityVehicle extends TrafficVehicle {
  /** Current segment; `s` is the distance along it. */
  seg: number;
  /** Segments it will drive next (kept ≥ 5 long). */
  route: number[];
  /** Wanted speed as a share of each road's limit; time gap kept, s. */
  share: number;
  headway: number;
  /** Seconds waiting at the line, whether it came to a full stop (stop sign), whether it may enter the junction ahead. */
  waitT: number;
  stopped: boolean;
  /** Seconds standing still (any reason): gridlock detection. */
  stillT: number;
  /** Junction connector it has committed to enter (-1 none): claimed until it gets there. */
  gate: number;
  /** The junction right after it, committed together when the lane between is too short to wait on (-1 none). */
  gate2: number;
  /** Through the first of two such junctions: it goes on through the second whatever happens. */
  locked: boolean;
  /** Why it is held at the line (debug): '' when not. */
  hold: string;
  /** Connector its tail is still in after leaving it (-1 none), and how far until the tail is out, m. */
  tailConn: number;
  tailLeft: number;
}

export interface CityTrafficStats {
  active: number;
  near: number;
  medium: number;
  far: number;
  spawned: number;
  despawned: number;
  avgSpeedKmh: number;
  /** Vehicles held at a junction right now, and why. */
  held: Record<string, number>;
  /** Junctions entered (and of those, without having been let in: could not stop), vehicles removed as gridlocked, crashes. */
  entries: number;
  unlet: number;
  stuck: number;
  crashes: number;
  bodies: number;
  updateMs: number;
  renderMs: number;
}

interface PoolBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  owner: CityVehicle | null;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
/** Strongest braking a driver uses (emergency), m/s². */
const MAX_BRAKE = 8;
/** Braking a driver plans with before a turn or a red light, m/s². */
const PLAN_BRAKE = 2.2;
/** Vehicles longer than this (buses, lorries) sweep wide in a turn, m. */
const LONG = 7;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * AI traffic for City V2 on the lane graph (CityLaneGraph), in a bubble
 * around the player.
 *
 * Each vehicle is a light kinematic agent following its route (lane,
 * connector through a junction, lane, …; turns picked at random, bigger roads
 * a little more often). Speed: Intelligent Driver Model towards the vehicle
 * ahead along the route (or the player, when in its path), the road's limit
 * and the speed advice of the turns coming up.
 *
 * Junctions: a driver may enter only when
 *  - its signal is green (yellow only when too close to stop), the signal
 *    plan being the one drawn on the poles (signalPhase, same clock);
 *  - at a stop sign, after a full stop;
 *  - no vehicle is on, or committed to, a connector that crosses or merges
 *    with its own, and the player is not in its path;
 *  - there is room on the exit lane (no blocking the box);
 *  - vehicles with priority are far enough away: side roads (stop / yield)
 *    give way to the main road, left turns to oncoming traffic, at equal
 *    junctions drivers give way to the right. Only moving vehicles count, and
 *    after a while at an uncontrolled junction only the box must be clear, so
 *    nobody waits on someone who waits on them.
 * Once committed a driver goes (no stopping in the box).
 *
 * Vehicles near the player get a pooled kinematic Rapier box; on contact it
 * turns dynamic (real mass), and a real hit leaves a wreck with hazard lights
 * that the others queue behind (removed once out of sight).
 */
export class CityTrafficSystem {
  readonly graph: CityLaneGraph;
  readonly vehicles: CityVehicle[] = [];
  onSpawn: ((v: TrafficVehicle) => void) | null = null;
  onDespawn: ((v: TrafficVehicle) => void) | null = null;
  density: TrafficDensity;
  variety: TrafficVariety;
  conditions: TrafficConditions = { rain: 0, visibility: 1, fogFar: 1400, night: 0, daylight: 1 };
  selectedId = -1;
  renderMs = 0;
  /** Simulation clock, s (drives the signal plan: `clock.signalTime` follows it). */
  time = 0;
  private readonly clock: { signalTime: number };
  private readonly world: RAPIER.World;
  private readonly player: PlayerProbe;
  private readonly rand: () => number;
  private nextId = 1;
  /** Vehicles per segment ordered by distance along it (rebuilt every step), and segments touched. */
  private readonly occ: CityVehicle[][];
  private readonly touched: number[] = [];
  /** Vehicles committed to a connector they have not reached yet, and vehicles whose tail is still in one, per connector. */
  private readonly claims: Int16Array;
  private readonly tails: Int16Array;
  private readonly pool: PoolBody[] = [];
  private needsFill = true;
  private spawnTimer = 0;
  private autoSpawn = true;
  private readonly smp = { x: 0, z: 0, heading: 0 };
  private readonly near: number[] = [];
  private stepMs: number[] = [];
  private counters = { spawned: 0, despawned: 0, entries: 0, unlet: 0, stuck: 0, crashes: 0 };
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();

  constructor(world: RAPIER.World, graph: CityLaneGraph, clock: { signalTime: number }, player: PlayerProbe, seed: number, density: TrafficDensity, variety: TrafficVariety) {
    this.world = world;
    this.graph = graph;
    this.clock = clock;
    this.player = player;
    this.density = density;
    this.variety = variety;
    this.rand = mulberry32((seed ^ 0xc17e) >>> 0);
    this.occ = graph.segs.map(() => []);
    this.claims = new Int16Array(graph.segs.length);
    this.tails = new Int16Array(graph.segs.length);
    for (let i = 0; i < C.bodyPool; i++) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -2000 - i * 10, 0).setCcdEnabled(true).setEnabled(false));
      const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 2).setFriction(0.6).setRestitution(0.1), body);
      this.pool.push({ body, collider, owner: null });
    }
  }

  // --- control -----------------------------------------------------------------------------

  setDensity(d: TrafficDensity): void {
    if (d === this.density) return;
    this.density = d;
    if (d === 'off') this.clear();
    else if (!this.vehicles.length) this.needsFill = true;
  }

  setVariety(v: TrafficVariety): void {
    this.variety = v;
  }

  /** Bold drivers are a motorway thing: nothing to set in town. */
  setCutIns(_cutIns: TrafficCutIns): void {}

  onTeleport(): void {
    this.clear();
    this.needsFill = true;
  }

  clear(): void {
    for (const v of [...this.vehicles]) this.despawn(v, false);
    this.claims.fill(0);
    this.tails.fill(0);
  }

  /** Stop spawning on its own (tests that place every vehicle themselves). */
  set manual(on: boolean) {
    this.autoSpawn = !on;
    this.needsFill = false;
  }

  // --- simulation ------------------------------------------------------------------------------

  beforeStep(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    this.clock.signalTime = this.time;
    if (this.density !== 'off' && this.needsFill && this.autoSpawn) {
      this.fill();
      this.needsFill = false;
    }
    this.buildOccupancy();
    for (const v of this.vehicles) {
      if (v.state === 'probe' || v.state === 'crashed') continue;
      this.updateTier(v);
      if (--v.decisionIn <= 0) {
        // Close behind someone or in a junction box: every step, whatever the distance to the player.
        const urgent = v.leadGap < 15 || this.graph.segs[v.seg].kind === 'connector';
        const every = v.tier === 0 || urgent ? C.decisionEvery.near : v.tier === 1 ? C.decisionEvery.medium : C.decisionEvery.far;
        this.decide(v, every * dt);
        v.decisionIn = every;
      }
      this.integrate(v, dt);
    }
    this.updateBodies(dt);
    this.spawnTimer += dt;
    if (this.spawnTimer >= 0.25) {
      this.spawnTimer = 0;
      this.manageBubble();
    }
    this.stepMs.push(performance.now() - t0);
    if (this.stepMs.length > 120) this.stepMs.shift();
  }

  afterStep(dt: number): void {
    for (const v of this.vehicles) {
      if (!v.body || (v.state !== 'probe' && v.state !== 'crashed')) continue;
      const lv = v.body.linvel();
      if (v.state === 'probe') {
        v.probeT += dt;
        if (Math.hypot(lv.x - v.probeVx, lv.z - v.probeVz) > 1.5) this.crash(v);
        else if (v.probeT > 0.35) this.unprobe(v);
      } else v.crashT += dt;
      this.readBody(v);
    }
  }

  private buildOccupancy(): void {
    for (const id of this.touched) this.occ[id].length = 0;
    this.touched.length = 0;
    for (const v of this.vehicles) {
      const l = this.occ[v.seg];
      if (!l.length) this.touched.push(v.seg);
      l.push(v);
    }
    for (const id of this.touched) {
      const l = this.occ[id];
      for (let i = 1; i < l.length; i++) {
        const e = l[i];
        let j = i - 1;
        while (j >= 0 && l[j].s > e.s) {
          l[j + 1] = l[j];
          j--;
        }
        l[j + 1] = e;
      }
    }
  }

  private updateTier(v: CityVehicle): void {
    const p = this.player.position;
    const d = Math.hypot(v.pose.x - p.x, v.pose.z - p.z);
    const tier = d < C.nearRange ? 0 : d < C.mediumRange ? 1 : 2;
    if (tier !== v.tier) {
      v.tier = tier;
      v.decisionIn = Math.min(v.decisionIn, 1);
    }
  }

  /** Wanted speed: the road's limit × the driver's share, rain, and the speed advice of what comes next within braking distance. */
  wantedSpeed(v: CityVehicle): number {
    const g = this.graph.segs;
    const rain = clamp(this.conditions.rain, 0, 1);
    const share = v.share * (1 - TRAFFIC.rainSlow * rain);
    let v0 = g[v.seg].speed * share;
    let dist = g[v.seg].length - v.s;
    for (const id of v.route) {
      const seg = g[id];
      const sp = seg.speed * share;
      if (sp < v0) v0 = Math.min(v0, Math.sqrt(sp * sp + 2 * PLAN_BRAKE * Math.max(0, dist)));
      dist += seg.length;
      if (dist > 80) break;
    }
    return Math.max(1, v0);
  }

  private decide(v: CityVehicle, _dt: number): void {
    const g = this.graph.segs;
    const seg = g[v.seg];
    const v0 = this.wantedSpeed(v);
    const T = v.headway * (1 + TRAFFIC.rainHeadway * clamp(this.conditions.rain, 0, 1));
    const look = Math.max(40, v.v * 4 + 20);
    // Vehicle ahead along the route.
    let best = Infinity;
    let leadV = 0;
    let leadId = -1;
    const mine = this.occ[v.seg];
    const i = mine.indexOf(v);
    if (i >= 0 && i + 1 < mine.length) {
      const o = mine[i + 1];
      best = o.s - v.s - (o.klass.length + v.klass.length) / 2;
      leadV = o.state === 'crashed' ? 0 : o.v;
      leadId = o.id;
    } else {
      let dist = seg.length - v.s;
      // Someone just turned off this lane another way (or this vehicle did, onto a connector beside its): still in
      // front until it has pulled away by both lengths, the two paths being side by side at first (a bus's swept
      // path reaches the next one).
      const turnedOff = seg.kind === 'lane' ? seg.next.filter((c) => c !== v.route[0]) : g[seg.from].next.filter((c) => c !== seg.id);
      for (const c of turnedOff) {
        const o = this.occ[c][0];
        if (!o) continue;
        const gap = (seg.kind === 'lane' ? dist + o.s : o.s - v.s) - (o.klass.length + v.klass.length) / 2;
        if (o.s < o.klass.length + v.klass.length + 2 && (seg.kind === 'lane' || o.s > v.s) && gap < best) {
          best = gap;
          leadV = o.state === 'crashed' ? 0 : o.v;
          leadId = o.id;
        }
      }
      for (const id of v.route) {
        if (dist > look) break;
        const l = this.occ[id];
        if (l.length) {
          const o = l[0];
          const gap = dist + o.s - (o.klass.length + v.klass.length) / 2;
          if (gap < best) {
            best = gap;
            leadV = o.state === 'crashed' ? 0 : o.v;
            leadId = o.id;
          }
          break;
        }
        dist += g[id].length;
      }
    }
    // The player, when in the path ahead.
    const pg = this.playerGap(v, look);
    if (pg && pg.gap < best) {
      best = pg.gap;
      leadV = pg.v;
      leadId = -2;
    }
    let a = this.idm(v, v0, T, best, leadV);
    v.leadId = leadId;
    v.leadGap = best;
    // The next junction entry along the route (also past short lanes between two junctions): stop at its line unless allowed in.
    v.hold = '';
    let dist = seg.length - v.s;
    let prev = seg;
    let gate: CitySeg | null = null;
    for (const id of v.route) {
      const r = g[id];
      if (r.kind === 'connector' && prev.kind === 'lane' && this.isJunction(r)) {
        gate = r;
        break;
      }
      if (dist > 80) break;
      dist += r.length;
      prev = r;
    }
    if (gate) {
      const lane = prev;
      const toLine = dist - v.klass.length / 2;
      // A lane too short to wait on before the next junction: both junctions are entered as one.
      const exit = g[gate.to];
      const after = exit.next.length ? g[v.route[v.route.indexOf(exit.id) + 1] ?? exit.next[0]] : null;
      const gate2 = after && exit.length < v.klass.length + C.exitRoom + 2 && this.isJunction(after) ? after : null;
      // Committed on green but held up on the way: a red light still stops it while it can stop.
      if (v.gate === gate.id && !v.locked && lane.control === 'signal' && signalPhase(lane.group, this.time) === 0 && toLine > (v.v * v.v) / (2 * 5) + 0.5) this.uncommit(v);
      if (v.gate !== gate.id && toLine < 60) {
        if (v.gate >= 0) this.uncommit(v);
        const why = this.blocked(v, lane, gate, toLine, false) || (gate2 ? this.blocked(v, exit, gate2, toLine + gate.length + exit.length, true) : '');
        if (why) {
          v.hold = why;
          a = Math.min(a, this.idm(v, v0, T, Math.max(0.05, toLine - 0.3), 0));
        } else if (toLine < Math.max(3, (v.v * v.v) / (2 * 3.5) + 1)) {
          // Too close to stop comfortably: it goes, and the junction knows.
          v.gate = gate.id;
          this.claims[gate.id]++;
          if (gate2) {
            v.gate2 = gate2.id;
            this.claims[gate2.id]++;
          }
        }
      }
    }
    v.aTarget = clamp(a, -MAX_BRAKE, v.klass.accel);
    // Indicators: before and through a turn.
    const turnSeg = seg.kind === 'connector' ? seg : v.route.length && seg.length - v.s < 35 ? g[v.route[0]] : null;
    v.indicator = turnSeg && turnSeg.kind === 'connector' ? (turnSeg.turn === 'left' ? 1 : turnSeg.turn === 'right' ? -1 : 0) : 0;
  }

  private isJunction(c: CitySeg): boolean {
    return this.graph.nodes[c.node].edges.length >= 3;
  }

  private uncommit(v: CityVehicle): void {
    if (v.gate >= 0) this.claims[v.gate] = Math.max(0, this.claims[v.gate] - 1);
    if (v.gate2 >= 0) this.claims[v.gate2] = Math.max(0, this.claims[v.gate2] - 1);
    v.gate = -1;
    v.gate2 = -1;
    v.locked = false;
  }

  /** Intelligent Driver Model acceleration with a gap (bumper to bumper, m) to something moving at `leadV`. */
  private idm(v: CityVehicle, v0: number, T: number, gap: number, leadV: number): number {
    const a = v.klass.accel;
    const b = v.klass.comfortBrake;
    const free = 1 - (v.v / v0) ** 4;
    if (!Number.isFinite(gap)) return a * free;
    const sStar = C.minGap + Math.max(0, v.v * T + (v.v * (v.v - leadV)) / (2 * Math.sqrt(a * b)));
    v.desiredGap = sStar;
    return a * (free - (sStar / Math.max(gap, 0.2)) ** 2);
  }

  /** Gap to the player if it is in this vehicle's path within `look` m (bumper to bumper), and its speed along the vehicle's heading. */
  private playerGap(v: CityVehicle, look: number): { gap: number; v: number } | null {
    const p = this.player.position;
    const he = this.player.halfExtents;
    const dx = p.x - v.pose.x;
    const dz = p.z - v.pose.z;
    if (dx * dx + dz * dz > (look + 10) ** 2 || Math.abs(p.y - v.pose.y) > 4) return null;
    const fx = Math.sin(v.pose.yaw);
    const fz = Math.cos(v.pose.yaw);
    const d = dx * fx + dz * fz;
    const lat = dx * fz - dz * fx;
    if (d <= 0 || Math.abs(lat) > v.klass.width / 2 + he.x + 0.5) return null;
    const vel = this.player.velocity;
    return { gap: d - v.klass.length / 2 - he.z, v: Math.max(0, vel.x * fx + vel.z * fz) };
  }

  /** Why a vehicle may not enter the junction ahead ('' = it may). */
  private blocked(v: CityVehicle, lane: CitySeg, conn: CitySeg, toLine: number, chained: boolean): string {
    const g = this.graph.segs;
    // The second of two junctions joined by a lane too short to wait on works as one junction with the first: its
    // own signal or stop sign is not obeyed separately (the stop is made at the first line), it gives way instead.
    const control = chained && (lane.control === 'signal' || lane.control === 'stop') ? 'yield' : lane.control;
    if (control === 'signal') {
      const ph = signalPhase(lane.group, this.time);
      if (ph === 0) return 'kırmızı';
      // Yellow: go only if too close to stop comfortably.
      if (ph === 1 && toLine > (v.v * v.v) / (2 * 3.5)) return 'sarı';
    }
    if (control === 'stop') {
      if (!v.stopped && toLine < 3 && v.v < 0.4) v.stopped = true;
      if (!v.stopped) return 'dur';
    }
    // Junction box: nobody on (or committed to) a crossing / merging connector; no turning beside a vehicle turning
    // on the next connector when either is a bus or lorry (its swept path reaches the other).
    for (const k of conn.conflicts) {
      if (this.occ[k].length || this.claims[k] || this.tails[k]) return 'kavşak dolu';
    }
    for (const k of conn.beside) {
      if (this.occ[k].some((o) => o.klass.length > LONG || v.klass.length > LONG)) return 'kavşak dolu';
    }
    // Room on the exit lane.
    const exit = g[conn.to];
    const first = this.occ[exit.id][0];
    // Vehicles already on (or committed to) the same connector need their room there first.
    const ahead = this.claims[conn.id] + this.occ[conn.id].length;
    if (first && first.v < 3 && first.s - first.klass.length / 2 < v.klass.length + C.exitRoom + ahead * 6.5) return 'çıkış dolu';
    // A short lane up to the next junction must have room for everyone heading there, should they all have to stop.
    // (Lanes too short to wait on are not waited on: the two junctions are taken as one, see decide.)
    if (exit.length < 60 && exit.length >= v.klass.length + C.exitRoom + 2 && this.graph.nodes[exit.node].edges.length >= 3) {
      let used = this.claims[conn.id] * 6.5;
      for (const o of this.occ[exit.id]) used += o.klass.length + C.minGap;
      for (const o of this.occ[conn.id]) used += o.klass.length + C.minGap;
      if (exit.length - used < v.klass.length + C.minGap) return 'çıkış dolu';
    }
    const qOn = this.occ[conn.id];
    if (qOn.length && qOn[0].v < 1 && qOn[0].s < v.klass.length + 2) return 'çıkış dolu';
    // The player in the junction, on this path.
    if (this.playerOn(conn, exit, v.klass.length + C.exitRoom)) return 'oyuncu';
    // Vehicles with priority.
    const patient = v.waitT < C.impatience;
    for (const k of conn.conflicts) {
      const other = g[k];
      const from = g[other.from];
      let gap = 0;
      if (control === 'signal') {
        if (conn.turn === 'left' && other.turn !== 'left' && from.group === lane.group) gap = C.gapLeft;
      } else if (control === 'stop' || control === 'yield') {
        if (from.control !== 'stop' && from.control !== 'yield') gap = control === 'stop' ? C.gapStop : C.gapYield;
      } else if (control === 'priority') {
        if (conn.turn === 'left' && other.turn !== 'left' && from.control === 'priority') gap = C.gapLeft;
      } else if (patient) {
        // Equal roads: the main road first, then whoever comes from the right; left turns wait for oncoming traffic.
        if (from.control === 'priority') gap = C.gapYield;
        else if (from.control === 'none' && this.fromRight(lane, from)) gap = C.gapRight;
        else if (conn.turn === 'left' && other.turn !== 'left' && from.control === 'none') gap = C.gapLeft;
      }
      if (!gap) continue;
      const q = this.occ[from.id];
      // The vehicle nearest the line on that lane, if it is heading for that connector and moving (or committed).
      for (let i = q.length - 1; i >= 0; i--) {
        const o = q[i];
        if (o.route[0] !== k) break;
        if (o.gate !== k && o.gate2 !== k && (o.v < 0.5 || o.waitT > 1)) break;
        const eta = (from.length - o.s - o.klass.length / 2) / Math.max(o.v, 0.5);
        if (eta < gap) return 'yol ver';
        break;
      }
    }
    return '';
  }

  /** Does lane `b` arrive from the driver's right as seen from lane `a`? */
  private fromRight(a: CitySeg, b: CitySeg): boolean {
    // a's right is (−t.z, t.x): b comes from there when it travels towards a's left, (t.z, −t.x).
    const tax = a.px[1] - a.px[0];
    const taz = a.pz[1] - a.pz[0];
    const tbx = b.px[1] - b.px[0];
    const tbz = b.pz[1] - b.pz[0];
    return (tbx * taz - tbz * tax) / (Math.hypot(tax, taz) * Math.hypot(tbx, tbz)) > 0.7;
  }

  /** Is the player's car on (or within reach of) a connector's path, or at the start of the lane after it (where this vehicle would end up)? */
  private playerOn(conn: CitySeg, exit: CitySeg, room: number): boolean {
    const p = this.player.position;
    if (Math.abs(p.y) > 4) return false;
    const reach = 1.2 + Math.max(this.player.halfExtents.x, this.player.halfExtents.z);
    if (nearPolyline(conn, p.x, p.z, Infinity) < reach) return true;
    return nearPolyline(exit, p.x, p.z, room) < reach;
  }

  private integrate(v: CityVehicle, dt: number): void {
    const emergency = v.aTarget < -4 || v.leadGap < 2;
    const j = (emergency ? TRAFFIC.emergencyJerk : TRAFFIC.jerk * 1.5) * dt;
    v.a += clamp(v.aTarget - v.a, -j, j);
    v.v += v.a * dt;
    if (v.v <= 0) {
      v.v = 0;
      if (v.a < 0) v.a = 0;
    }
    v.s += v.v * dt;
    const g = this.graph.segs;
    if (v.tailConn >= 0) {
      v.tailLeft -= v.v * dt;
      if (v.tailLeft <= 0) this.clearTail(v);
    }
    while (v.s >= g[v.seg].length && v.route.length) {
      v.s -= g[v.seg].length;
      const left = g[v.seg];
      if (left.kind === 'connector' && this.isJunction(left)) {
        // Its tail stays in the junction box for another half length.
        this.clearTail(v);
        v.tailConn = left.id;
        v.tailLeft = v.klass.length / 2 + 0.5 - v.s;
        this.tails[left.id]++;
      }
      const next = v.route.shift()!;
      const letIn = next === v.gate;
      if (letIn) {
        this.claims[next] = Math.max(0, this.claims[next] - 1);
        this.counters.entries++;
        // Through the first of two junctions taken as one: the second is now its gate, and it goes.
        v.gate = v.gate2;
        v.gate2 = -1;
        v.locked = v.gate >= 0;
      }
      if (g[next].kind === 'connector' && this.isJunction(g[next])) {
        // Into a junction without having been let in (could not stop in time): counted, should stay rare.
        if (!letIn) this.counters.unlet++;
        v.stopped = false;
        v.waitT = 0;
      }
      v.seg = next;
      this.extendRoute(v);
    }
    if (v.hold && v.v < 0.5) v.waitT += dt;
    v.stillT = v.v < 0.5 ? v.stillT + dt : 0;
    v.brake = v.a < -0.7 || (v.v < 2 && v.aTarget < 0);
    v.wheelAngle += (v.v * dt) / v.klass.wheelRadius;
    this.updatePose(v);
  }

  private clearTail(v: CityVehicle): void {
    if (v.tailConn >= 0) this.tails[v.tailConn] = Math.max(0, this.tails[v.tailConn] - 1);
    v.tailConn = -1;
  }

  /** Keeps five segments planned (enough to see past short lanes to the next junction): at each lane end a turn at random (straight on most likely, bigger roads a little more). */
  private extendRoute(v: CityVehicle): void {
    const g = this.graph.segs;
    while (v.route.length < 5) {
      const last = g[v.route.length ? v.route[v.route.length - 1] : v.seg];
      if (!last.next.length) return;
      if (last.next.length === 1) {
        v.route.push(last.next[0]);
        continue;
      }
      let total = 0;
      const w = (id: number) => {
        const c = g[id];
        const to = g[c.to];
        const turn = c.shift ? 0.15 : c.turn === 'straight' ? 1 : c.turn === 'right' ? 0.55 : 0.45;
        const road = to.cls === 'arterial3' ? 1.4 : to.cls === 'boulevard' ? 1.25 : to.cls === 'avenue' ? 1.1 : to.cls === 'alley' ? 0.25 : 1;
        return turn * road;
      };
      for (const id of last.next) total += w(id);
      let r = this.rand() * total;
      let pick = last.next[0];
      for (const id of last.next) {
        r -= w(id);
        if (r <= 0) {
          pick = id;
          break;
        }
      }
      v.route.push(pick);
    }
  }

  private updatePose(v: CityVehicle): void {
    const p = v.prev;
    const c = v.pose;
    p.x = c.x;
    p.y = c.y;
    p.z = c.z;
    p.yaw = c.yaw;
    p.pitch = c.pitch;
    p.roll = c.roll;
    const smp = this.graph.sample(this.graph.segs[v.seg], v.s, this.smp);
    c.x = smp.x;
    c.y = 0;
    c.z = smp.z;
    c.yaw = smp.heading;
    c.pitch = clamp(-v.a * 0.006, -0.03, 0.03);
    c.roll = 0;
    const k = this.conditions;
    v.headlights = k.night > 0.25 || k.daylight < 0.5 || k.rain > 0.35 || k.visibility < 0.55;
  }

  // --- collision bodies ------------------------------------------------------------------------

  private updateBodies(dt: number): void {
    const p = this.player.position;
    const pv = this.player.velocity;
    const pf = this.player.forward;
    const he = this.player.halfExtents;
    for (const v of this.vehicles) {
      if (v.state === 'probe' || v.state === 'crashed') continue;
      const want = v.tier === 0;
      if (want && !v.body) this.acquire(v);
      else if (!want && v.body) this.release(v);
      if (!v.body) continue;
      const c = v.pose;
      v.body.setNextKinematicTranslation({ x: c.x, y: c.y, z: c.z });
      v.body.setNextKinematicRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
      const vx = Math.sin(c.yaw) * v.v;
      const vz = Math.cos(c.yaw) * v.v;
      const rel = Math.hypot(pv.x - vx, pv.z - vz);
      const margin = rel * dt * 3 + 0.25;
      if (Math.abs(p.y - (c.y + v.klass.height / 2)) < v.klass.height / 2 + he.y + 1 && obbOverlap(p.x, p.z, Math.atan2(pf.x, pf.z), he.x + margin, he.z + margin, c.x, c.z, c.yaw, v.klass.width / 2, v.klass.length / 2)) {
        this.probe(v, vx, vz);
      }
    }
  }

  private acquire(v: CityVehicle): void {
    const slot = this.pool.find((b) => !b.owner);
    if (!slot) return;
    slot.owner = v;
    const k = v.klass;
    const hy = k.height * 0.42;
    slot.collider.setHalfExtents({ x: k.width / 2, y: hy, z: k.length / 2 });
    slot.collider.setTranslationWrtParent({ x: 0, y: hy + 0.12, z: 0 });
    slot.collider.setMass(k.mass);
    slot.collider.setFriction(0.6);
    const b = slot.body;
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    b.setTranslation({ x: v.pose.x, y: v.pose.y, z: v.pose.z }, true);
    b.setRotation({ x: 0, y: Math.sin(v.pose.yaw / 2), z: 0, w: Math.cos(v.pose.yaw / 2) }, true);
    b.setEnabled(true);
    v.body = b;
  }

  private release(v: CityVehicle): void {
    const slot = this.pool.find((b) => b.owner === v);
    v.body = null;
    if (!slot) return;
    slot.owner = null;
    const b = slot.body;
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    b.setEnabled(false);
    b.setTranslation({ x: 0, y: -2000, z: 0 }, false);
  }

  private colliderOf(v: CityVehicle): RAPIER.Collider | null {
    return this.pool.find((b) => b.owner === v)?.collider ?? null;
  }

  private probe(v: CityVehicle, vx: number, vz: number): void {
    const b = v.body!;
    b.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    b.setTranslation({ x: v.pose.x, y: v.pose.y + 0.02, z: v.pose.z }, true);
    b.setLinvel({ x: vx, y: 0, z: vz }, true);
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.colliderOf(v)?.setFriction(0);
    v.state = 'probe';
    v.probeT = 0;
    v.probeVx = vx;
    v.probeVz = vz;
  }

  private crash(v: CityVehicle): void {
    v.state = 'crashed';
    v.crashT = 0;
    v.indicator = 2;
    v.brake = false;
    v.a = 0;
    v.aTarget = 0;
    v.v = 0;
    this.colliderOf(v)?.setFriction(0.7);
    this.counters.crashes++;
  }

  /** It didn't touch after all: back on its path as a kinematic agent. */
  private unprobe(v: CityVehicle): void {
    const b = v.body!;
    const lv = b.linvel();
    v.v = Math.max(0, lv.x * Math.sin(v.pose.yaw) + lv.z * Math.cos(v.pose.yaw));
    v.state = 'cruise';
    this.colliderOf(v)?.setFriction(0.6);
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.updatePose(v);
  }

  /** Pose from a dynamic body (a probe or a wreck); its place on the graph stays (a wreck blocks its lane). */
  private readBody(v: CityVehicle): void {
    const b = v.body!;
    const t = b.translation();
    const r = b.rotation();
    Object.assign(v.prev, v.pose);
    this._q.set(r.x, r.y, r.z, r.w);
    this._e.setFromQuaternion(this._q, 'YXZ');
    const c = v.pose;
    c.x = t.x;
    c.y = t.y;
    c.z = t.z;
    c.yaw = this._e.y;
    c.pitch = this._e.x;
    c.roll = this._e.z;
  }

  // --- spawning ----------------------------------------------------------------------------------

  private target(): number {
    return this.density === 'off' ? 0 : C.count[this.density];
  }

  private manageBubble(): void {
    const p = this.player.position;
    for (const v of [...this.vehicles]) {
      const d = Math.hypot(v.pose.x - p.x, v.pose.z - p.z);
      if (d > C.despawn) this.despawn(v, true);
      else if (v.state === 'crashed' && ((v.crashT > 20 && d > 120) || v.crashT > 120)) this.despawn(v, true);
      else if (v.stillT > C.stuck && d > 120) {
        this.counters.stuck++;
        this.despawn(v, true);
      }
    }
    if (this.density === 'off' || !this.autoSpawn) return;
    const deficit = this.target() - this.vehicles.length;
    if (deficit <= 0) return;
    const lanes = this.graph.lanesNear(p.x, p.z, C.spawnMax, this.near);
    for (let k = 0; k < Math.min(3, deficit); k++) this.trySpawn(lanes, C.spawnMin, C.spawnMax, true);
  }

  /** Fills the bubble at once (start, teleport), keeping clear of the player. */
  private fill(): void {
    const target = this.target();
    const p = this.player.position;
    const lanes = this.graph.lanesNear(p.x, p.z, C.spawnMax, this.near);
    for (let tries = 0; this.vehicles.length < target && tries < target * 8; tries++) this.trySpawn(lanes, 45, C.spawnMax, false);
  }

  /** One attempt at a new vehicle on a random lane of `lanes` (those around the player), between rMin and rMax from it. */
  private trySpawn(lanes: readonly number[], rMin: number, rMax: number, hidden: boolean): boolean {
    const p = this.player.position;
    const g = this.graph;
    if (!lanes.length) return false;
    const seg = g.segs[lanes[Math.floor(this.rand() * lanes.length)]];
    // Alleys and short stubs get little traffic of their own.
    if (seg.length < 20 || (seg.cls === 'alley' && this.rand() < 0.75)) return false;
    // Not within stopping distance of a junction's line (a red light there could not be obeyed).
    const end = this.graph.nodes[seg.node].edges.length >= 3 ? 30 : 6;
    if (seg.length < end + 8) return false;
    const s = 6 + this.rand() * (seg.length - end - 6);
    const at = g.sample(seg, s, this.smp);
    const dx = at.x - p.x;
    const dz = at.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d > rMax) return false;
    const f = this.player.forward;
    const behind = (dx * f.x + dz * f.z) / Math.max(d, 1) < -0.3;
    if (d < (hidden && behind ? C.spawnBehindMin : rMin)) return false;
    // Clear of the vehicles on that lane.
    for (const o of this.occ[seg.id]) if (Math.abs(o.s - s) < 16 + o.klass.length) return false;
    const pick = this.pickClass();
    const klass = TRAFFIC_CLASSES[pick];
    if (klass.length > seg.length * 0.5) return false;
    this.spawnVehicle(pick, seg.id, s, Math.min(seg.speed * 0.8, 12));
    return true;
  }

  private pickClass(): TrafficClassId {
    const w = cityVariety(this.variety);
    let total = 0;
    for (const k in w) total += w[k as TrafficClassId] ?? 0;
    let r = this.rand() * total;
    for (const k in w) {
      r -= w[k as TrafficClassId] ?? 0;
      if (r <= 0) return k as TrafficClassId;
    }
    return Object.keys(w)[0] as TrafficClassId;
  }

  private spawnVehicle(classId: TrafficClassId, seg: number, s: number, speed: number): CityVehicle {
    const klass = TRAFFIC_CLASSES[classId];
    const pose = (): TrafficPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
    const lane = this.graph.segs[seg];
    const v: CityVehicle = {
      id: this.nextId++,
      classId,
      klass,
      profileId: 'normal',
      profile: DRIVER_PROFILES.normal,
      paint: klass.paints[Math.floor(this.rand() * klass.paints.length)],
      carriageway: 0,
      dir: 1,
      s,
      lanePos: lane.lane,
      lane: lane.lane,
      v: speed,
      a: 0,
      aTarget: 0,
      desired: lane.speed,
      bold: false,
      state: 'cruise',
      tier: 2,
      fromLane: lane.lane,
      toLane: lane.lane,
      lcT: 0,
      lcDuration: 0,
      indicateT: 0,
      indicator: 0,
      brake: false,
      headlights: false,
      laneTime: 0,
      cooldown: 0,
      decisionIn: 1 + Math.floor(this.rand() * 4),
      leadId: -1,
      leadGap: Infinity,
      desiredGap: 0,
      body: null,
      probeT: 0,
      probeVx: 0,
      probeVz: 0,
      crashT: 0,
      slot: -1,
      prev: pose(),
      pose: pose(),
      wheelAngle: this.rand() * 6,
      alive: true,
      seg,
      route: [],
      share: C.speedShare[0] + this.rand() * (C.speedShare[1] - C.speedShare[0]),
      headway: (klass.heavy ? 0.4 : 0) + C.headway[0] + this.rand() * (C.headway[1] - C.headway[0]),
      waitT: 0,
      stopped: false,
      stillT: 0,
      gate: -1,
      gate2: -1,
      locked: false,
      hold: '',
      tailConn: -1,
      tailLeft: 0,
    };
    this.extendRoute(v);
    this.updateTier(v);
    this.updatePose(v);
    Object.assign(v.prev, v.pose);
    this.vehicles.push(v);
    // Visible to the next spawn's clearance check at once.
    const l = this.occ[seg];
    if (!l.length) this.touched.push(seg);
    l.push(v);
    l.sort((a, b) => a.s - b.s);
    this.counters.spawned++;
    this.onSpawn?.(v);
    return v;
  }

  private despawn(v: CityVehicle, counted: boolean): void {
    if (v.body) this.release(v);
    this.uncommit(v);
    this.clearTail(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    const l = this.occ[v.seg];
    const k = l.indexOf(v);
    if (k >= 0) l.splice(k, 1);
    if (counted) this.counters.despawned++;
    if (this.selectedId === v.id) this.selectedId = -1;
    this.onDespawn?.(v);
  }

  // --- debug / tests -----------------------------------------------------------------------------

  stats(): CityTrafficStats {
    let near = 0;
    let medium = 0;
    let far = 0;
    let speed = 0;
    const held: Record<string, number> = {};
    for (const v of this.vehicles) {
      if (v.tier === 0) near++;
      else if (v.tier === 1) medium++;
      else far++;
      speed += v.v;
      if (v.hold) held[v.hold] = (held[v.hold] ?? 0) + 1;
    }
    const ms = this.stepMs.length ? this.stepMs.reduce((a, b) => a + b, 0) / this.stepMs.length : 0;
    return {
      active: this.vehicles.length,
      near,
      medium,
      far,
      spawned: this.counters.spawned,
      despawned: this.counters.despawned,
      avgSpeedKmh: this.vehicles.length ? (speed / this.vehicles.length) * 3.6 : 0,
      held,
      entries: this.counters.entries,
      unlet: this.counters.unlet,
      stuck: this.counters.stuck,
      crashes: this.counters.crashes,
      bodies: this.pool.filter((b) => b.owner).length,
      updateMs: ms,
      renderMs: this.renderMs,
    };
  }

  /** Pairs of AI vehicles (not wrecks) whose bodies overlap right now. */
  overlaps(): number {
    let n = 0;
    const list = this.vehicles.filter((v) => v.state !== 'crashed' && v.state !== 'probe');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (Math.abs(a.pose.x - b.pose.x) > 20 || Math.abs(a.pose.z - b.pose.z) > 20) continue;
        if (obbOverlap(a.pose.x, a.pose.z, a.pose.yaw, a.klass.width / 2 - 0.1, a.klass.length / 2 - 0.2, b.pose.x, b.pose.z, b.pose.yaw, b.klass.width / 2 - 0.1, b.klass.length / 2 - 0.2)) n++;
      }
    }
    return n;
  }

  /** Cycle the vehicle shown in F2 (nearest first). */
  selectNext(): void {
    if (!this.vehicles.length) return;
    const p = this.player.position;
    const d = (v: CityVehicle) => (v.pose.x - p.x) ** 2 + (v.pose.z - p.z) ** 2;
    const sorted = [...this.vehicles].sort((a, b) => d(a) - d(b));
    const i = sorted.findIndex((v) => v.id === this.selectedId);
    this.selectedId = sorted[(i + 1) % sorted.length].id;
  }

  get selected(): CityVehicle | null {
    return this.vehicles.find((v) => v.id === this.selectedId) ?? null;
  }

  /** Spawns one vehicle at an exact place (tests); `route` fixes the segments it drives next. */
  spawnForTest(classId: TrafficClassId, seg: number, s: number, speed: number, route?: number[]): CityVehicle {
    this.buildOccupancy();
    const v = this.spawnVehicle(classId, seg, s, speed);
    if (route) {
      v.route = [...route];
      this.extendRoute(v);
    }
    return v;
  }

  dispose(): void {
    this.clear();
    for (const b of this.pool) this.world.removeRigidBody(b.body);
    this.pool.length = 0;
  }
}

/** Distance from (x, z) to a segment's polyline, over its first `upTo` metres, m. */
function nearPolyline(seg: CitySeg, x: number, z: number, upTo: number): number {
  let best = Infinity;
  for (let i = 1; i < seg.px.length && seg.cum[i - 1] < upTo; i++) {
    const ax = seg.px[i - 1];
    const az = seg.pz[i - 1];
    let dx = seg.px[i] - ax;
    let dz = seg.pz[i] - az;
    // Only the first `upTo` metres of this piece.
    const l = seg.cum[i] - seg.cum[i - 1];
    const keep = Math.min(1, (upTo - seg.cum[i - 1]) / (l || 1));
    dx *= keep;
    dz *= keep;
    const ll = dx * dx + dz * dz;
    const t = ll > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / ll)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t - x, az + dz * t - z));
  }
  return best;
}
