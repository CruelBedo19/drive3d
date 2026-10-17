import * as THREE from 'three';
import { RAPIER } from '../core/PhysicsWorld';
import {
  DRIVER_PROFILES,
  TRAFFIC,
  TRAFFIC_CLASSES,
  TRAFFIC_DENSITY,
  TRAFFIC_VARIETY,
  type DriverProfileId,
  CUT_IN_SHARE,
  type TrafficClassId,
  type TrafficCutIns,
  type TrafficDensity,
  type TrafficVariety,
} from '../config/traffic';
import { AUTOBAHN as A } from '../config/tracks';
import type { Carriageway, LaneSample, TrafficLaneNetwork } from './TrafficLaneNetwork';
import type { TrafficPose, TrafficTier, TrafficVehicle } from './TrafficVehicle';

/** What the traffic may know about the player: where it is and how it moves right now (no intentions). */
export interface PlayerProbe {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  forward: THREE.Vector3;
  /** Half extents of the player's body box (x width, y height, z length). */
  halfExtents: { x: number; y: number; z: number };
}

/** Weather / light the drivers react to. */
export interface TrafficConditions {
  rain: number;
  /** Weather visibility multiplier (1 = clear air). */
  visibility: number;
  /** The world's clear-air fog distance, m. */
  fogFar: number;
  night: number;
  daylight: number;
}

export interface TrafficStats {
  active: number;
  near: number;
  medium: number;
  far: number;
  spawned: number;
  despawned: number;
  /** Spawns per minute (simulated time), last minute. */
  spawnRate: number;
  /** Vehicles per lane index (both carriageways): right, middle, left. */
  laneOccupancy: [number, number, number];
  avgSpeedKmh: number;
  laneChanges: number;
  rejectedLaneChanges: number;
  abortedLaneChanges: number;
  crashes: number;
  /** Bold drivers that cut into the player's lane. */
  cutIns: number;
  bodies: number;
  /** Simulation time spent in traffic per physics step (avg) and per rendered frame, ms. */
  updateMs: number;
  renderMs: number;
}

/** One entry in a lane's ordered list (a vehicle or the player). */
interface Entity {
  /** Progress along the travel direction: s × dir. */
  key: number;
  /** Speed along the travel direction, m/s. */
  v: number;
  len: number;
  /** Vehicle id, or -2 for the player. */
  id: number;
  veh: TrafficVehicle | null;
}

interface PoolBody {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  owner: TrafficVehicle | null;
}

const PLAYER_ID = -2;
const LANES = A.lanes;
const quintic = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);
const quinticD = (t: number) => 30 * t * t * (1 - t) * (1 - t);
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

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
 * AI motorway traffic in a bubble around the player.
 *
 * Each vehicle is a light kinematic agent on the lane network (no tyre or
 * suspension model): Intelligent Driver Model car following (smooth, jerk
 * limited acceleration and braking, gap = minimum + speed × headway), MOBIL
 * style lane decisions (overtake when the car ahead is clearly slower, keep
 * right afterwards, never pull out in front of a fast car: front / rear gaps,
 * closing speed and time-to-collision checked, the lane counted as taken
 * while someone moves into it), quintic lateral lane changes with indicators,
 * and lights from the weather, time of day and tunnels.
 *
 * Vehicles near the player get a pooled kinematic Rapier box so the player
 * can hit them. Just before a contact the box turns into a dynamic body with
 * the vehicle's real mass, so the impact exchanges momentum instead of the
 * player bouncing off an immovable wall; if it really was a hit, the vehicle
 * becomes a wreck (hazard lights) that the others brake for and pass.
 *
 * Tiers: near (full logic every step, collision body, wheels and lights
 * animated), medium (decisions at 30 Hz), far (decisions at 10 Hz, no wheels).
 * Vehicles are spawned out of sight at the bubble's edges and removed there.
 */
export class TrafficSystem {
  readonly net: TrafficLaneNetwork;
  readonly vehicles: TrafficVehicle[] = [];
  /** Called when vehicles appear / disappear (visuals keep their instance slots in sync). */
  onSpawn: ((v: TrafficVehicle) => void) | null = null;
  onDespawn: ((v: TrafficVehicle) => void) | null = null;
  density: TrafficDensity;
  variety: TrafficVariety;
  cutIns: TrafficCutIns = 'off';
  conditions: TrafficConditions = { rain: 0, visibility: 1, fogFar: 2600, night: 0, daylight: 1 };
  /** Player's road distance, carriageway, fractional lane and speed along its carriageway (debug / tests). */
  playerS = 0;
  playerCarriageway: Carriageway = 0;
  playerLanePos = 1;
  playerV = 0;
  selectedId = -1;
  /** Tests: centre the bubble and tiers here instead of on the player (null = player). */
  anchorS: number | null = null;
  private readonly world: RAPIER.World;
  private readonly player: PlayerProbe;
  private readonly rand: () => number;
  private nextId = 1;
  private time = 0;
  private spawnTimer = 0;
  private readonly lanes: Entity[][] = [];
  private readonly entities = new Map<number, Entity>();
  private readonly playerEntity: Entity = { key: 0, v: 0, len: 4.5, id: PLAYER_ID, veh: null };
  private playerOnRoad = false;
  private readonly pool: PoolBody[] = [];
  private needsFill = true;
  private readonly smp = {} as LaneSample;
  private readonly spawnTimes: number[] = [];
  private stepMs: number[] = [];
  renderMs = 0;
  private counters = { spawned: 0, despawned: 0, laneChanges: 0, rejected: 0, aborted: 0, crashes: 0, unsafe: 0, cutIns: 0 };
  private lastCutIn = -Infinity;

  constructor(world: RAPIER.World, net: TrafficLaneNetwork, player: PlayerProbe, seed: number, density: TrafficDensity, variety: TrafficVariety, cutIns: TrafficCutIns = 'off') {
    this.cutIns = cutIns;
    this.world = world;
    this.net = net;
    this.player = player;
    this.rand = mulberry32((seed ^ 0x7a11c) >>> 0);
    this.density = density;
    this.variety = variety;
    for (let i = 0; i < LANES * 2; i++) this.lanes.push([]);
    for (let i = 0; i < TRAFFIC.bodyPool; i++) {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -2000 - i * 10, 0).setCcdEnabled(true).setEnabled(false));
      const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(1, 1, 2).setFriction(0.6).setRestitution(0.1), body);
      this.pool.push({ body, collider, owner: null });
    }
  }

  // --- control -----------------------------------------------------------------------------

  setDensity(d: TrafficDensity): void {
    if (d === this.density) return;
    const wasOff = this.density === 'off';
    this.density = d;
    if (d === 'off') this.clear();
    else if (wasOff || this.vehicles.length === 0) {
      // Switched on while driving: the whole stretch at once, also close by (the player asked for it).
      this.needsFill = true;
      this.fillNear = true;
    }
  }
  private fillNear = false;

  /** Share of bold drivers for vehicles spawned from now on. */
  setCutIns(c: TrafficCutIns): void {
    this.cutIns = c;
  }

  setVariety(v: TrafficVariety): void {
    this.variety = v;
  }

  /** The player jumped (spawn, respawn, teleport): rebuild the traffic around the new spot. */
  onTeleport(): void {
    this.clear();
    this.needsFill = true;
  }

  /** Removes every vehicle (and frees its body). */
  clear(): void {
    for (const v of [...this.vehicles]) this.despawn(v, false);
  }

  // --- simulation ------------------------------------------------------------------------------

  /** One physics step, before the world steps: decisions, motion, kinematic body targets. */
  beforeStep(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    this.updatePlayer();
    if (this.density !== 'off' && this.needsFill && this.playerOnRoad && this.autoSpawn) {
      this.fill();
      this.needsFill = false;
    }
    this.buildLanes();
    for (const v of this.vehicles) {
      if (v.state === 'probe' || v.state === 'crashed') continue;
      this.updateTier(v);
      if (--v.decisionIn <= 0) {
        const every = v.tier === 0 ? TRAFFIC.decisionEvery.near : v.tier === 1 ? TRAFFIC.decisionEvery.medium : TRAFFIC.decisionEvery.far;
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

  /** After the world stepped: wrecks and probing bodies report where physics put them. */
  afterStep(dt: number): void {
    for (const v of this.vehicles) {
      if (!v.body || (v.state !== 'probe' && v.state !== 'crashed')) continue;
      const lv = v.body.linvel();
      if (v.state === 'probe') {
        v.probeT += dt;
        const dv = Math.hypot(lv.x - v.probeVx, lv.z - v.probeVz);
        if (dv > 1.5) this.crash(v);
        else if (v.probeT > 0.35) this.unprobe(v);
      } else v.crashT += dt;
      this.readBody(v);
    }
  }

  // --- player ------------------------------------------------------------------------------------

  private updatePlayer(): void {
    const p = this.player.position;
    const gen = this.net.gen;
    let s = gen.nearestS(p.x, p.z, this.playerS, 120);
    let off = gen.lateralOffset(p.x, p.z, s);
    // Lost track (teleport, respawn): search the whole road once.
    if (Math.abs(off) > A.boundary || Math.hypot(p.x - gen.frame(s).x, p.z - gen.frame(s).z) > A.boundary * 1.5) {
      s = gen.nearestSGlobal(p.x, p.z);
      off = gen.lateralOffset(p.x, p.z, s);
    }
    this.playerS = s;
    this.playerOnRoad = Math.abs(off) < A.boundary;
    const cw: Carriageway = off < 0 ? 0 : 1;
    this.playerCarriageway = cw;
    const lane0 = this.net.lanes[this.net.laneId(cw, 0)].offset;
    this.playerLanePos = (off - lane0) / ((cw === 0 ? 1 : -1) * A.lane);
    const f = gen.frame(s);
    const dir = cw === 0 ? 1 : -1;
    const vel = this.player.velocity;
    this.playerV = (vel.x * Math.sin(f.heading) + vel.z * Math.cos(f.heading)) * dir;
    const e = this.playerEntity;
    e.key = s * dir;
    e.v = this.playerV;
    e.len = this.player.halfExtents.z * 2;
  }

  // --- lane bookkeeping ----------------------------------------------------------------------

  /** Lane lists ordered by progress; a vehicle between lanes (or the player) is in every lane it overlaps. */
  private buildLanes(): void {
    for (const l of this.lanes) l.length = 0;
    for (const v of this.vehicles) {
      let e = this.entities.get(v.id);
      if (!e) this.entities.set(v.id, (e = { key: 0, v: 0, len: v.klass.length, id: v.id, veh: v }));
      e.key = v.s * v.dir;
      e.v = v.v;
      const half = (v.klass.width / 2 + 0.25) / A.lane + (v.state === 'crashed' ? 0.4 : 0);
      this.addToLanes(e, v.carriageway, v.lanePos, half);
    }
    if (this.playerOnRoad) this.addToLanes(this.playerEntity, this.playerCarriageway, this.playerLanePos, (this.player.halfExtents.x + 0.3) / A.lane);
    for (const l of this.lanes) insertionSort(l);
  }

  private addToLanes(e: Entity, cw: Carriageway, lanePos: number, half: number): void {
    for (let i = 0; i < LANES; i++) if (Math.abs(lanePos - i) < 0.5 + half) this.lanes[cw * LANES + i].push(e);
  }

  /** Nearest entity in front of `key` in a lane (excluding `selfId`). */
  private leader(laneId: number, key: number, selfId: number): Entity | null {
    const l = this.lanes[laneId];
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].key <= key) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < l.length; i++) if (l[i].id !== selfId) return l[i];
    return null;
  }

  /** Nearest entity behind `key` in a lane (excluding `selfId`). */
  private follower(laneId: number, key: number, selfId: number): Entity | null {
    const l = this.lanes[laneId];
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (l[mid].key < key) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0; i--) if (l[i].id !== selfId) return l[i];
    return null;
  }

  // --- driver ------------------------------------------------------------------------------------

  /** How far the driver can see in this weather, m. */
  private sight(): number {
    const c = this.conditions;
    return Math.max(60, c.fogFar * Math.min(1, c.visibility) * 0.5 * TRAFFIC.fogSight);
  }

  /** Wanted speed right now: personal speed, weather, curve / tunnel advice, sight distance. */
  wantedSpeed(v: TrafficVehicle): number {
    const c = this.conditions;
    let v0 = v.desired * (1 - TRAFFIC.rainSlow * clamp(c.rain, 0, 1));
    const look = v.s + v.dir * Math.max(40, v.v * 3);
    const advice = Math.min(this.net.advice(v.s), this.net.advice(look));
    v0 = Math.min(v0, advice * (2 - v.profile.compliance));
    // Stopping distance (1.5 s reaction + comfortable braking) within what can be seen.
    const b = v.klass.comfortBrake;
    const sight = this.sight();
    v0 = Math.min(v0, -1.5 * b + Math.sqrt(2.25 * b * b + 2 * b * sight));
    return Math.max(0.5, v0);
  }

  private headway(v: TrafficVehicle): number {
    const c = this.conditions;
    return v.profile.headway * (1 + TRAFFIC.rainHeadway * clamp(c.rain, 0, 1)) * (1 + 0.6 * (1 - clamp(c.visibility, 0, 1)));
  }

  /** Intelligent Driver Model acceleration towards `lead` (null: free road). */
  private idm(v: TrafficVehicle, v0: number, T: number, lead: Entity | null, myKey: number): { a: number; gap: number; sStar: number } {
    const a = v.klass.accel;
    const b = v.klass.comfortBrake;
    const free = 1 - (v.v / v0) ** 4;
    if (!lead) return { a: a * free, gap: Infinity, sStar: 0 };
    const gap = lead.key - myKey - (lead.len + v.klass.length) / 2;
    const dv = v.v - lead.v;
    const sStar = v.profile.minGap + Math.max(0, v.v * T + (v.v * dv) / (2 * Math.sqrt(a * b)));
    if (lead.key - myKey > TRAFFIC.lookAhead) return { a: a * free, gap, sStar };
    return { a: a * (free - (sStar / Math.max(gap, 0.3)) ** 2), gap, sStar };
  }

  private decide(v: TrafficVehicle, dt: number): void {
    const v0 = this.wantedSpeed(v);
    const T = this.headway(v);
    const key = v.s * v.dir;
    const cw = v.carriageway;
    // Car following in the lane(s) the vehicle occupies.
    const lanesNow = v.state === 'changing' || v.state === 'aborting' ? [v.fromLane, v.toLane] : [v.lane];
    let acc = Infinity;
    v.leadId = -1;
    v.leadGap = Infinity;
    v.desiredGap = 0;
    for (const li of lanesNow) {
      const lead = this.leader(this.net.laneId(cw, li), key, v.id);
      const r = this.idm(v, v0, T, lead, key);
      if (r.a < acc) {
        acc = r.a;
        if (lead) {
          v.leadId = lead.id;
          v.leadGap = r.gap;
          v.desiredGap = r.sStar;
        }
      }
    }
    v.aTarget = clamp(acc, -TRAFFIC.maxBrake, v.klass.accel);

    if (v.state === 'cruise' && v.cooldown <= 0) this.considerLaneChange(v, v0, T, key, dt);
    else if (v.state === 'indicate') {
      v.indicateT += dt;
      if (v.indicateT >= (v.bold ? 0.6 : TRAFFIC.indicateTime)) {
        if (this.laneSafe(v, v.toLane, T, false)) this.startChange(v);
        else if (v.indicateT > 6) {
          v.state = 'cruise';
          v.indicator = 0;
          v.cooldown = 3;
          this.counters.rejected++;
        }
      }
    } else if (v.state === 'changing' && v.lcT < 0.45 && !this.laneSafe(v, v.toLane, T, true)) {
      // Something fast appeared behind in the target lane: go back.
      this.counters.aborted++;
      v.state = 'aborting';
      const from = v.toLane;
      v.toLane = v.fromLane;
      v.fromLane = from;
      v.lcT = 1 - v.lcT;
      v.indicator = v.toLane > v.fromLane ? 1 : -1;
    }
  }

  private considerLaneChange(v: TrafficVehicle, v0: number, T: number, key: number, dt: number): void {
    const cw = v.carriageway;
    const lowVis = this.conditions.visibility < 0.45;
    const lead = this.leader(this.net.laneId(cw, v.lane), key, v.id);
    // Bold drivers now and then cut into the player's lane just ahead of it (a gap of ≥ 2.5 s is still kept).
    if (v.bold && this.playerOnRoad && cw === this.playerCarriageway && this.time - this.lastCutIn > (this.cutIns === 'many' ? 8 : 14)) {
      const pl = Math.round(this.playerLanePos);
      const ahead = (key - this.playerEntity.key) - (this.playerEntity.len + v.klass.length) / 2;
      if (Math.abs(pl - v.lane) === 1 && pl >= 0 && pl <= v.klass.maxLane && ahead > 4 && ahead < 70 && this.rand() < dt * (this.cutIns === 'many' ? 0.6 : 0.2)) {
        if (this.laneSafe(v, pl, T, false)) {
          this.startIndicate(v, pl);
          this.lastCutIn = this.time;
          this.counters.cutIns++;
          return;
        }
      }
    }
    // Overtake: the car in front is clearly slower than this driver wants to go.
    if (v.lane < v.klass.maxLane && lead) {
      const gap = lead.key - key - (lead.len + v.klass.length) / 2;
      const slower = lead.v < v0 - v.profile.overtakeDelta / 3.6;
      if (slower && gap < Math.max(60, v.v * 6 + 25) && !(lowVis && v.klass.heavy)) {
        if (this.laneSafe(v, v.lane + 1, T, false)) this.startIndicate(v, v.lane + 1);
        else {
          this.counters.rejected++;
          v.cooldown = 1.5;
        }
        return;
      }
    }
    // Keep right: move back once the right lane has room and won't need another overtake soon
    // (but not to pass a slower car on its right: no undertaking).
    if (v.lane > 0) {
      if (lead && lead.key - key < Math.max(80, v.v * 8) && lead.v < v0 - v.profile.overtakeDelta / 3.6) return;
      const courtesy = this.fastFollower(v, key);
      if (v.laneTime < (courtesy ? 1 : TRAFFIC.keepRightDelay)) return;
      const rl = this.leader(this.net.laneId(cw, v.lane - 1), key, v.id);
      const rGap = rl ? rl.key - key - (rl.len + v.klass.length) / 2 : Infinity;
      const roomy = !rl || rGap > v.v * 12 + 80 || (rGap > v.v * 6 + 40 && rl.v >= v0 - 6 / 3.6);
      if (roomy || courtesy) {
        if (this.laneSafe(v, v.lane - 1, T, false)) this.startIndicate(v, v.lane - 1);
        else v.cooldown = 1;
      }
    }
  }

  /** Someone much faster closing in behind in this lane (move over for them). */
  private fastFollower(v: TrafficVehicle, key: number): boolean {
    const f = this.follower(this.net.laneId(v.carriageway, v.lane), key, v.id);
    if (!f) return false;
    const gap = key - f.key - (f.len + v.klass.length) / 2;
    const closing = f.v - v.v;
    return closing > 8 && gap < TRAFFIC.lookBehind && gap / closing < 9;
  }

  /**
   * Is moving into `lane` safe now? Nothing alongside; enough room to the car
   * in front; the one behind is far enough, not closing too fast (its time to
   * collision above the driver's limit, more for a very fast car such as a
   * 300 km/h player) and would not need to brake hard. `abort`: the looser
   * test that decides whether a started change goes back.
   */
  laneSafe(v: TrafficVehicle, lane: number, T: number, abort: boolean): boolean {
    if (lane < 0 || lane >= LANES || lane > v.klass.maxLane) return false;
    const laneId = this.net.laneId(v.carriageway, lane);
    const key = v.s * v.dir;
    const L = v.klass.length;
    const sight = Math.min(this.sight() * 1.4, TRAFFIC.lookBehind);
    const list = this.lanes[laneId];
    for (const e of list) {
      if (e.id === v.id) continue;
      // Alongside (overlapping bumpers, with a margin).
      if (Math.abs(e.key - key) < (e.len + L) / 2 + (abort ? 0.5 : 2)) return false;
    }
    const lead = this.leader(laneId, key, v.id);
    if (lead && lead.key - key < TRAFFIC.lookAhead) {
      const gap = lead.key - key - (lead.len + L) / 2;
      if (gap < (abort ? 1 : v.profile.minGap + v.v * T * 0.5 + 2)) return false;
      if (!abort && lead.v < v.v && gap / (v.v - lead.v) < 4) return false;
    }
    const f = this.follower(laneId, key, v.id);
    if (f && key - f.key < sight) {
      const gap = key - f.key - (f.len + L) / 2;
      const bold = v.bold && !abort;
      if (gap < (abort ? 0.5 : bold ? 2 + f.v * 0.15 : 4 + f.v * 0.5)) return false;
      const closing = f.v - v.v;
      if (closing > 0) {
        const fast = f.id === PLAYER_ID && f.v > 55 ? 2 : 0;
        const lowVis = this.conditions.visibility < 0.45 ? 1.5 : 1;
        const need = abort ? TRAFFIC.abortTtc : bold ? 2.5 : (v.profile.rearTtc + fast) * lowVis;
        if (gap / closing < need) return false;
      }
      // Braking it would force on the follower (generic driver).
      const sStar = 2.5 + Math.max(0, f.v * 1.2 + (f.v * closing) / (2 * Math.sqrt(2 * 3)));
      const bF = 2 * (1 - (sStar / Math.max(gap, 0.3)) ** 2);
      if (bF < (bold ? -9 : abort ? -5 : -2)) return false;
    } else if (!f && !abort && this.conditions.visibility < 0.3) {
      // Thick fog: what isn't visible may still be coming.
      return false;
    }
    return true;
  }

  private startIndicate(v: TrafficVehicle, lane: number): void {
    v.state = 'indicate';
    v.toLane = lane;
    v.fromLane = v.lane;
    v.indicateT = 0;
    v.indicator = lane > v.lane ? 1 : -1;
  }

  private startChange(v: TrafficVehicle): void {
    v.state = 'changing';
    v.lcT = 0;
    v.lcDuration = (TRAFFIC.laneChangeBase + v.v * TRAFFIC.laneChangePerSpeed + (v.klass.heavy ? 1.5 : 0)) * (v.bold ? 0.7 : 1);
    this.counters.laneChanges++;
    // Audit (tests): would the follower in the target lane have to brake hard now?
    const laneId = this.net.laneId(v.carriageway, v.toLane);
    const key = v.s * v.dir;
    const f = this.follower(laneId, key, v.id);
    if (f) {
      const gap = key - f.key - (f.len + v.klass.length) / 2;
      const closing = f.v - v.v;
      if (gap < 0 || (closing > 0 && gap / closing < 1.5)) this.counters.unsafe++;
    }
  }

  private get centreS(): number {
    return this.anchorS ?? this.playerS;
  }

  private updateTier(v: TrafficVehicle): void {
    const d = Math.abs(v.s - this.centreS);
    const h = TRAFFIC.tierHysteresis;
    let tier: TrafficTier = v.tier;
    if (d < TRAFFIC.nearRange - (v.tier === 0 ? -h : 0)) tier = 0;
    else if (d < TRAFFIC.mediumRange - (v.tier <= 1 ? -h : 0)) tier = 1;
    else tier = 2;
    if (tier !== v.tier) {
      v.tier = tier;
      v.decisionIn = Math.min(v.decisionIn, 1);
    }
  }

  private integrate(v: TrafficVehicle, dt: number): void {
    const emergency = v.aTarget < -4 || v.leadGap < 3;
    const j = (emergency ? TRAFFIC.emergencyJerk : TRAFFIC.jerk) * dt;
    v.a += clamp(v.aTarget - v.a, -j, j);
    v.v += v.a * dt;
    if (v.v <= 0) {
      v.v = 0;
      if (v.a < 0) v.a = 0;
    }
    v.s += v.dir * v.v * dt;
    if (v.state === 'changing' || v.state === 'aborting') {
      v.lcT = Math.min(1, v.lcT + dt / (v.state === 'aborting' ? Math.min(v.lcDuration, 1.8) : v.lcDuration));
      v.lanePos = v.fromLane + (v.toLane - v.fromLane) * quintic(v.lcT);
      v.lane = v.lcT >= 0.5 ? v.toLane : v.fromLane;
      if (v.lcT >= 1) {
        v.state = 'cruise';
        v.lane = v.toLane;
        v.lanePos = v.toLane;
        v.indicator = 0;
        v.laneTime = 0;
        v.cooldown = 2;
      }
    }
    v.laneTime += dt;
    v.cooldown -= dt;
    v.brake = v.a < -0.7 || (v.v < 2 && v.aTarget < 0);
    v.wheelAngle += (v.v * dt) / v.klass.wheelRadius;
    this.updatePose(v);
  }

  /** Road pose from (s, lanePos): lane-change yaw, pitch from slope and braking, roll from crossfall. */
  private updatePose(v: TrafficVehicle): void {
    const p = v.prev;
    const c = v.pose;
    p.x = c.x;
    p.y = c.y;
    p.z = c.z;
    p.yaw = c.yaw;
    p.pitch = c.pitch;
    p.roll = c.roll;
    const off = this.net.offsetAt(v.carriageway, v.lanePos);
    const smp = this.net.sample(this.net.laneId(v.carriageway, 0), v.s, this.smp, off);
    c.x = smp.x;
    c.y = smp.y;
    c.z = smp.z;
    let lat = 0;
    if (v.state === 'changing' || v.state === 'aborting') {
      const dur = v.state === 'aborting' ? Math.min(v.lcDuration, 1.8) : v.lcDuration;
      lat = ((v.toLane - v.fromLane) * A.lane * quinticD(v.lcT)) / dur;
    }
    c.yaw = smp.heading + Math.atan2(lat, Math.max(v.v, 1));
    c.pitch = -Math.atan(smp.grade) + clamp(-v.a * 0.006, -0.03, 0.03);
    // Road tilt towards the driver's left: crossfall away from the median plus banking.
    const tilt = v.dir * (-Math.sign(off) * A.crossfall - smp.bank);
    c.roll = Math.atan(tilt) - clamp(lat * 0.01, -0.02, 0.02);
    v.headlights = this.lightsWanted(v.s);
  }

  private lightsWanted(s: number): boolean {
    const c = this.conditions;
    if (c.night > 0.25 || c.daylight < 0.5 || c.rain > 0.35 || c.visibility < 0.55) return true;
    for (const ft of this.net.gen.featuresIn(s - 80, s + 80)) if (ft.kind === 'tunnel') return true;
    return false;
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
      // About to touch the player: become a real mass so the hit exchanges momentum.
      const vx = Math.sin(c.yaw) * v.v;
      const vz = Math.cos(c.yaw) * v.v;
      const rel = Math.hypot(pv.x - vx, pv.z - vz);
      const margin = rel * dt * 3 + 0.25;
      if (Math.abs(p.y - (c.y + v.klass.height / 2)) < v.klass.height / 2 + he.y + 1 && obbOverlap(p.x, p.z, Math.atan2(pf.x, pf.z), he.x + margin, he.z + margin, c.x, c.z, c.yaw, v.klass.width / 2, v.klass.length / 2)) {
        this.probe(v, vx, vz);
      }
    }
  }

  private acquire(v: TrafficVehicle): void {
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

  private release(v: TrafficVehicle): void {
    const slot = this.pool.find((b) => b.owner === v);
    v.body = null;
    if (!slot) return;
    slot.owner = null;
    const b = slot.body;
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    b.setEnabled(false);
    b.setTranslation({ x: 0, y: -2000, z: 0 }, false);
  }

  private probe(v: TrafficVehicle, vx: number, vz: number): void {
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

  private crash(v: TrafficVehicle): void {
    v.state = 'crashed';
    v.crashT = 0;
    v.indicator = 2;
    v.brake = false;
    v.a = 0;
    v.aTarget = 0;
    this.colliderOf(v)?.setFriction(0.7);
    this.counters.crashes++;
  }

  /** It didn't touch after all: back on its lane as a kinematic agent. */
  private unprobe(v: TrafficVehicle): void {
    const b = v.body!;
    this.readBody(v);
    const lv = b.linvel();
    const f = this.net.gen.frame(v.s);
    v.v = Math.max(0, (lv.x * Math.sin(f.heading) + lv.z * Math.cos(f.heading)) * v.dir);
    v.lane = clamp(Math.round(v.lanePos), 0, Math.min(LANES - 1, v.klass.maxLane));
    v.lanePos = v.lane;
    v.state = 'cruise';
    v.indicator = 0;
    this.colliderOf(v)?.setFriction(0.6);
    b.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    this.updatePose(v);
  }

  private colliderOf(v: TrafficVehicle): RAPIER.Collider | null {
    return this.pool.find((b) => b.owner === v)?.collider ?? null;
  }

  /** Pose and road coordinates from a dynamic body. */
  private readBody(v: TrafficVehicle): void {
    const b = v.body!;
    const t = b.translation();
    const r = b.rotation();
    const p = v.prev;
    const c = v.pose;
    Object.assign(p, c);
    this._q.set(r.x, r.y, r.z, r.w);
    this._e.setFromQuaternion(this._q, 'YXZ');
    c.x = t.x;
    c.y = t.y;
    c.z = t.z;
    c.yaw = this._e.y;
    c.pitch = this._e.x;
    c.roll = this._e.z;
    const gen = this.net.gen;
    v.s = gen.nearestS(t.x, t.z, v.s, 40);
    const off = gen.lateralOffset(t.x, t.z, v.s);
    const lane0 = this.net.lanes[this.net.laneId(v.carriageway, 0)].offset;
    v.lanePos = (off - lane0) / ((v.carriageway === 0 ? 1 : -1) * A.lane);
    const lv = b.linvel();
    const f = gen.frame(v.s);
    v.v = (lv.x * Math.sin(f.heading) + lv.z * Math.cos(f.heading)) * v.dir;
  }
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();

  // --- spawning ----------------------------------------------------------------------------------

  private targetPerCarriageway(): number {
    if (this.density === 'off') return 0;
    const d = TRAFFIC_DENSITY[this.density];
    return Math.min(d.max / 2, Math.round((d.perKm * (TRAFFIC.behind + TRAFFIC.ahead)) / 1000));
  }

  private manageBubble(): void {
    const sp = this.centreS;
    for (const v of [...this.vehicles]) {
      const rel = v.s - sp;
      if (rel < -TRAFFIC.behind - 60 || rel > TRAFFIC.ahead + 150) this.despawn(v, true);
    }
    if (this.density === 'off' || !this.playerOnRoad || !this.autoSpawn) return;
    const target = this.targetPerCarriageway();
    for (const cw of [0, 1] as const) {
      const count = this.vehicles.reduce((n, v) => n + (v.carriageway === cw ? 1 : 0), 0);
      const deficit = target - count;
      if (deficit <= 0) continue;
      // Far short (density raised while driving): top up a few at a time anywhere out of sight —
      // beyond the spawn distance ahead or well behind — instead of waiting for the edges.
      const topUp = deficit > 2;
      for (let k = 0; k < (topUp ? 4 : 1); k++) {
        if (topUp) {
          const ahead = this.rand() < 0.75;
          const s = ahead ? sp + TRAFFIC.spawnMinDistance + this.rand() * (TRAFFIC.ahead - TRAFFIC.spawnMinDistance) : sp - TRAFFIC.behind + this.rand() * (TRAFFIC.behind - 300);
          this.trySpawn(cw, s, !ahead && cw === 0);
          continue;
        }
        // Where new traffic enters the bubble: ahead for the oncoming side and when the player is
        // faster than traffic; behind (out of sight) when it is slower, so faster cars come past.
        const ahead = cw === 1 || this.playerV > 38 || this.rand() < 0.5;
        const s = ahead ? sp + TRAFFIC.ahead - this.rand() * 300 : sp - TRAFFIC.behind + this.rand() * 120;
        this.trySpawn(cw, s, !ahead);
      }
    }
  }

  /** Fills the whole bubble at once (start, teleport), keeping clear of the player. */
  private fill(): void {
    const target = this.targetPerCarriageway();
    const sp = this.playerS;
    for (const cw of [0, 1] as const) {
      for (let tries = 0, n = 0; n < target && tries < target * 6; tries++) {
        const s = sp - TRAFFIC.behind + this.rand() * (TRAFFIC.behind + TRAFFIC.ahead);
        const clear = this.fillNear ? 35 : cw === this.playerCarriageway ? 120 : 60;
        if (Math.abs(s - sp) < clear) continue;
        if (this.trySpawn(cw, s, false)) n++;
      }
    }
    // The initial fill is not traffic flowing in: keep it out of the spawn rate.
    this.spawnTimes.length = 0;
    this.fillNear = false;
  }

  private pick<T extends string>(weights: Partial<Record<T, number>>): T {
    let total = 0;
    for (const k in weights) total += weights[k] ?? 0;
    let r = this.rand() * total;
    for (const k in weights) {
      r -= weights[k] ?? 0;
      if (r <= 0) return k;
    }
    return Object.keys(weights)[0] as T;
  }

  private trySpawn(cw: Carriageway, s: number, behind: boolean): boolean {
    if (s < 50) return false;
    const classId = this.pick<TrafficClassId>(TRAFFIC_VARIETY[this.variety]);
    const klass = TRAFFIC_CLASSES[classId];
    let profileId = this.pick<DriverProfileId>(klass.profiles);
    // Entering from behind: only drivers fast enough to catch up are worth spawning there.
    if (behind && !klass.heavy && (profileId === 'slow' || profileId === 'normal')) profileId = this.rand() < 0.7 ? 'fast' : 'veryFast';
    if (behind && klass.heavy) return false;
    const profile = DRIVER_PROFILES[profileId];
    const desired = (profile.speed[0] + this.rand() * (profile.speed[1] - profile.speed[0])) / 3.6;
    const prefs: Record<DriverProfileId, number[]> = { truck: [0, 0, 0, 1], bus: [0, 0, 0, 1], slow: [0, 0, 0, 1], normal: [0, 0, 1, 1, 2], fast: [1, 1, 2, 2, 0], veryFast: [2, 2, 2, 1] };
    const order = prefs[profileId];
    const first = order[Math.floor(this.rand() * order.length)];
    const dir = cw === 0 ? 1 : -1;
    for (const lane of [first, ...[0, 1, 2].filter((l) => l !== first)]) {
      if (lane > klass.maxLane) continue;
      const laneId = this.net.laneId(cw, lane);
      const key = s * dir;
      const T = profile.headway;
      const v0 = Math.min(desired, this.net.advice(s));
      // Clear of everyone in the lane (and the player) by a speed-dependent gap, both ways.
      const need = Math.max(35, v0 * T * 1.5) + klass.length;
      const tooClose = this.lanes[laneId].some((e) => Math.abs(e.key - key) < need + e.len / 2 + (e.id === PLAYER_ID ? 60 : 0));
      if (tooClose) continue;
      if (Math.abs(s - this.playerS) < 60) continue;
      const lead = this.leader(laneId, key, -99);
      const v = lead && lead.key - key < 200 ? Math.min(v0, Math.max(5, lead.v)) : v0;
      this.spawnVehicle(classId, profileId, cw, lane, s, v, desired);
      return true;
    }
    return false;
  }

  private spawnVehicle(classId: TrafficClassId, profileId: DriverProfileId, cw: Carriageway, lane: number, s: number, speed: number, desired: number): TrafficVehicle {
    const klass = TRAFFIC_CLASSES[classId];
    const pose = (): TrafficPose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 });
    const v: TrafficVehicle = {
      id: this.nextId++,
      classId,
      klass,
      profileId,
      profile: DRIVER_PROFILES[profileId],
      paint: klass.paints[Math.floor(this.rand() * klass.paints.length)],
      carriageway: cw,
      dir: cw === 0 ? 1 : -1,
      s,
      lanePos: lane,
      lane,
      v: speed,
      a: 0,
      aTarget: 0,
      desired,
      bold: !klass.heavy && this.rand() < CUT_IN_SHARE[this.cutIns],
      state: 'cruise',
      tier: 2,
      fromLane: lane,
      toLane: lane,
      lcT: 0,
      lcDuration: 4,
      indicateT: 0,
      indicator: 0,
      brake: false,
      headlights: false,
      laneTime: 0,
      cooldown: 2 + this.rand() * 3,
      decisionIn: 1 + Math.floor(this.rand() * 12),
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
    };
    this.updateTier(v);
    this.updatePose(v);
    Object.assign(v.prev, v.pose);
    this.vehicles.push(v);
    // Visible to the others' checks at once (two spawns never pick the same gap).
    this.entities.set(v.id, { key: s * v.dir, v: speed, len: klass.length, id: v.id, veh: v });
    this.addToLanes(this.entities.get(v.id)!, cw, lane, (klass.width / 2 + 0.25) / A.lane);
    for (const l of this.lanes) insertionSort(l);
    this.counters.spawned++;
    this.spawnTimes.push(this.time);
    this.onSpawn?.(v);
    return v;
  }

  private despawn(v: TrafficVehicle, counted: boolean): void {
    if (v.body) this.release(v);
    const i = this.vehicles.indexOf(v);
    if (i >= 0) this.vehicles.splice(i, 1);
    this.entities.delete(v.id);
    for (const l of this.lanes) {
      const k = l.findIndex((e) => e.id === v.id);
      if (k >= 0) l.splice(k, 1);
    }
    if (counted) this.counters.despawned++;
    if (this.selectedId === v.id) this.selectedId = -1;
    this.onDespawn?.(v);
  }

  // --- debug / tests -----------------------------------------------------------------------------

  stats(): TrafficStats {
    let near = 0;
    let medium = 0;
    let far = 0;
    let speed = 0;
    const occ: [number, number, number] = [0, 0, 0];
    for (const v of this.vehicles) {
      if (v.tier === 0) near++;
      else if (v.tier === 1) medium++;
      else far++;
      speed += v.v;
      occ[Math.max(0, Math.min(2, v.lane))]++;
    }
    while (this.spawnTimes.length && this.spawnTimes[0] < this.time - 60) this.spawnTimes.shift();
    const ms = this.stepMs.length ? this.stepMs.reduce((a, b) => a + b, 0) / this.stepMs.length : 0;
    return {
      active: this.vehicles.length,
      near,
      medium,
      far,
      spawned: this.counters.spawned,
      despawned: this.counters.despawned,
      spawnRate: this.spawnTimes.length * (60 / Math.max(1, Math.min(60, this.time))),
      laneOccupancy: occ,
      avgSpeedKmh: this.vehicles.length ? (speed / this.vehicles.length) * 3.6 : 0,
      laneChanges: this.counters.laneChanges,
      rejectedLaneChanges: this.counters.rejected,
      abortedLaneChanges: this.counters.aborted,
      crashes: this.counters.crashes,
      cutIns: this.counters.cutIns,
      bodies: this.pool.filter((b) => b.owner).length,
      updateMs: ms,
      renderMs: this.renderMs,
    };
  }

  /** Lane changes started while the follower in the target lane was already within 1.5 s (should stay 0). */
  get unsafeLaneChanges(): number {
    return this.counters.unsafe;
  }

  /** Pairs of AI vehicles (not wrecks) whose bodies overlap right now. */
  overlaps(): number {
    let n = 0;
    const list = this.vehicles.filter((v) => v.state !== 'crashed' && v.state !== 'probe');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.carriageway !== b.carriageway || Math.abs(a.s - b.s) > 25) continue;
        if (obbOverlap(a.pose.x, a.pose.z, a.pose.yaw, a.klass.width / 2, a.klass.length / 2, b.pose.x, b.pose.z, b.pose.yaw, b.klass.width / 2, b.klass.length / 2)) n++;
      }
    }
    return n;
  }

  /** Cycle the vehicle shown in F2 (nearest first). */
  selectNext(): void {
    if (!this.vehicles.length) return;
    const sorted = [...this.vehicles].sort((a, b) => Math.abs(a.s - this.playerS) - Math.abs(b.s - this.playerS));
    const i = sorted.findIndex((v) => v.id === this.selectedId);
    this.selectedId = sorted[(i + 1) % sorted.length].id;
  }

  get selected(): TrafficVehicle | null {
    return this.vehicles.find((v) => v.id === this.selectedId) ?? null;
  }

  /** Spawns one vehicle at an exact place (tests). */
  spawnForTest(classId: TrafficClassId, profileId: DriverProfileId, cw: Carriageway, lane: number, s: number, speed: number, desired = speed): TrafficVehicle {
    this.buildLanes();
    return this.spawnVehicle(classId, profileId, cw, lane, s, speed, desired);
  }

  /** Stop spawning / filling on its own (tests that place every vehicle themselves). */
  set manual(on: boolean) {
    this.autoSpawn = !on;
    this.needsFill = false;
  }
  private autoSpawn = true;

  dispose(): void {
    this.clear();
    for (const b of this.pool) this.world.removeRigidBody(b.body);
    this.pool.length = 0;
  }
}

/** Insertion sort by key (lists are nearly sorted from the previous step). */
function insertionSort(l: Entity[]): void {
  for (let i = 1; i < l.length; i++) {
    const e = l[i];
    let j = i - 1;
    while (j >= 0 && l[j].key > e.key) {
      l[j + 1] = l[j];
      j--;
    }
    l[j + 1] = e;
  }
}

/** Do two rectangles (centre, yaw, half width along x / half length along the heading) overlap? */
export function obbOverlap(ax: number, az: number, ay: number, aw: number, al: number, bx: number, bz: number, by: number, bw: number, bl: number): boolean {
  const axes = [
    [Math.cos(ay), -Math.sin(ay)],
    [Math.sin(ay), Math.cos(ay)],
    [Math.cos(by), -Math.sin(by)],
    [Math.sin(by), Math.cos(by)],
  ];
  const dx = bx - ax;
  const dz = bz - az;
  for (const [ux, uz] of axes) {
    const ra = aw * Math.abs(Math.cos(ay) * ux - Math.sin(ay) * uz) + al * Math.abs(Math.sin(ay) * ux + Math.cos(ay) * uz);
    const rb = bw * Math.abs(Math.cos(by) * ux - Math.sin(by) * uz) + bl * Math.abs(Math.sin(by) * ux + Math.cos(by) * uz);
    if (Math.abs(dx * ux + dz * uz) > ra + rb) return false;
  }
  return true;
}
