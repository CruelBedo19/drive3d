/**
 * Deterministic Autobahn generator: everything is a pure function of the seed
 * and the distance along the road `s` (pattern from Nightdrive / Three.js Driving
 * Simulator: the road is a function of arc length; geometry, physics, scatter and
 * tests all read the same centre line). Own implementation:
 *
 *  - a seeded plan of straights and wide sweepers with clothoid-like curvature
 *    transitions (no kinks), and a grade profile with smooth vertical curves;
 *  - the centre line integrated forward in 2 m steps and cached, so any s is a
 *    lookup (and driving back reproduces the same road);
 *  - a feature timeline (tunnels, valley bridges, overpasses, exits, rest areas,
 *    environment zones, signs) that never overlaps;
 *  - terrain height: road-corridor carve + biome-weighted noise hills, a hill
 *    mass over tunnels, a valley under bridges, flat pads under ramps and rest
 *    areas; far from the road it blends into the free landscape (BiomeMap).
 *
 * Coordinates: x east, z south (as the rest of the game); heading h = vehicle
 * yaw (forward = (sin h, cos h), left = (cos h, -sin h)); lateral offset `off`
 * is positive to the left of the driving direction.
 */
import { BIOMES } from '../../config/biomes';
import { AUTOBAHN as A } from '../../config/tracks';
import { BIOME_COUNT, BiomeMap } from './BiomeMap';
import { fbm, hash2, ramp, ridged, smooth01 as smooth, valueNoise } from './noise';

export { hash2 };

export type Environment = 'forest' | 'open' | 'hilly';
export type FeatureKind = 'tunnel' | 'bridge' | 'overpass' | 'exit' | 'restArea';

export interface Feature {
  kind: FeatureKind;
  /** Start / end along the road (overpass: its centre ± half width). */
  s0: number;
  s1: number;
  /** Fictional name / number for signs. */
  name: string;
  index: number;
}

export interface SignPlacement {
  s: number;
  kind: 'gantry' | 'exitSoon' | 'gore' | 'rest' | 'distance' | 'speed';
  text: string[];
  /** Speed limit for 'speed' signs. */
  value?: number;
}

export interface Frame {
  x: number;
  y: number;
  z: number;
  heading: number;
  curvature: number;
  /** Superelevation slope (rise per metre to the right... see surfaceY). */
  bank: number;
}

/** Cross-section, derived from the config (no magic numbers elsewhere). */
export const SECTION = (() => {
  const carriageway = A.innerStrip + A.lanes * A.lane + A.shoulder;
  const roadHalf = A.medianHalf + carriageway;
  const edge = roadHalf + A.verge;
  /** Centre offsets of direction A's lanes (right side, negative), fast lane first. */
  const lanesA = Array.from({ length: A.lanes }, (_, i) => -(A.medianHalf + A.innerStrip + A.lane * (i + 0.5)));
  return { carriageway, roadHalf, edge, lanesA, laneB: lanesA.map((o) => -o) };
})();

const STEP = 2;
/** Rest-area platform half width (across the road). */
export const PLATFORM_HALF = 34;
const DESTINATIONS = ['Nordstadt', 'Zentrum', 'Flughafen', 'Industriegebiet', 'Waldheim', 'Bergdorf', 'Seetal', 'Neumarkt', 'Hafen', 'Lindenau'];
const REST_NAMES = ['Waldblick', 'Am Hang', 'Lindenhof', 'Seeblick', 'Eichenhain', 'Talrast'];

// --- seeded randomness ------------------------------------------------------------

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

const between = (r: () => number, range: readonly [number, number]) => range[0] + r() * (range[1] - range[0]);

interface CurveSeg {
  s0: number;
  s1: number;
  k: number;
}
interface GradeSeg {
  s0: number;
  grade: number;
}
interface EnvZone {
  s0: number;
  env: Environment;
}

export class RoadGenerator {
  readonly seed: number;
  /** Landscape regions around the road (same seed). */
  readonly biome: BiomeMap;
  /**
   * One random stream per planner: each plan depends only on the seed, never on
   * the order or distance in which the others were extended (same seed → same
   * road however it is queried).
   */
  private readonly rCurve: () => number;
  private readonly rGrade: () => number;
  private readonly rEnv: () => number;
  private readonly rFeature: () => number;
  /** Planned height at gradeEnd (sum of planned grades), independent of the integration. */
  private gradeY = 0;
  private readonly curves: CurveSeg[] = [];
  private curveEnd = 0;
  /** Planned heading after the last curve (sum of the curves' turns). */
  private plannedHeading = 0;
  private readonly grades: GradeSeg[] = [];
  private gradeEnd = 0;
  private readonly envs: EnvZone[] = [];
  private envEnd = 0;
  readonly features: Feature[] = [];
  readonly signs: SignPlacement[] = [];
  private featureEnd = 0;
  private readonly nextAt: Record<FeatureKind, number>;
  private readonly counters: Record<FeatureKind, number> = { tunnel: 0, bridge: 0, overpass: 0, exit: 0, restArea: 0 };
  // Centre line samples every STEP m from s = 0.
  private xs = new Float64Array(4096);
  private zs = new Float64Array(4096);
  private hs = new Float64Array(4096);
  private ys = new Float64Array(4096);
  private count = 0;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.biome = new BiomeMap(this.seed);
    this.rCurve = mulberry32(this.seed ^ 0x1b873593);
    this.rGrade = mulberry32(this.seed ^ 0xcc9e2d51);
    this.rEnv = mulberry32(this.seed ^ 0x85ebca6b);
    this.rFeature = mulberry32(this.seed ^ 0xc2b2ae35);
    const r = mulberry32(this.seed ^ 0x9e3779b9);
    const f = A.features;
    // First features come after the start straight; the first rest area early enough to find.
    this.nextAt = {
      tunnel: A.plan.startStraight + between(r, [2500, 5500]),
      bridge: A.plan.startStraight + between(r, [800, 3000]),
      overpass: A.plan.startStraight + between(r, [0, 1200]),
      exit: A.plan.startStraight + between(r, [1500, 3500]),
      restArea: f.restArea.first,
    };
    this.curveEnd = A.plan.startStraight;
    this.gradeEnd = A.plan.startStraight;
    this.grades.push({ s0: 0, grade: 0 });
    this.envs.push({ s0: 0, env: 'forest' });
    this.envEnd = between(r, A.features.environment.length);
    this.pushSample(0, 0, 0, 0);
  }

  /** Generated centre-line length so far. */
  get length(): number {
    return (this.count - 1) * STEP;
  }

  /** Make sure plan and centre line exist up to `s` (plus margin for look-ups). */
  ensure(s: number): void {
    const target = s + 600;
    while (this.curveEnd < target + 4000) this.planCurves();
    while (this.gradeEnd < target + 4000) this.planGrades();
    while (this.envEnd < target + 4000) this.planEnvironment();
    while (this.featureEnd < target + 4000) this.planFeature();
    while (this.length < target) this.integrate();
  }

  // --- the plan ------------------------------------------------------------------

  private planCurves(): void {
    const p = A.plan;
    const r = this.rCurve;
    // A straight, then a sweeper (sometimes reversed into an S).
    this.curveEnd += between(r, p.straight);
    const n = r() < 0.25 ? 2 : 1;
    let sign = r() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      let len = Math.max(between(r, p.curveLength), p.transition * 2.2);
      const radius = between(r, p.radius);
      // Keep the heading within ±(drift + turn) < 90° of the start direction: the road always
      // makes progress the same way and can never loop back over itself (the landscape around
      // it is then unambiguous). Random numbers are drawn the same way either way.
      if (Math.abs(this.plannedHeading) > p.headingDrift) sign = -Math.sign(this.plannedHeading);
      len = Math.min(len, p.maxTurn * radius + p.transition);
      const k = sign / radius;
      this.curves.push({ s0: this.curveEnd, s1: this.curveEnd + len, k });
      // Smoothstep ramps in and out each turn half as much as their length at full curvature.
      this.plannedHeading += k * (len - p.transition);
      this.curveEnd += len;
      sign = -sign;
    }
  }

  private planGrades(): void {
    const p = A.plan;
    const r = this.rGrade;
    // Random grade, nudged back towards the starting height so the road stays in a sensible band.
    const back = Math.max(-1, Math.min(1, this.gradeY / 140));
    const g = Math.max(-p.maxGrade, Math.min(p.maxGrade, (r() * 2 - 1) * p.maxGrade - back * p.maxGrade * 0.8));
    const grade = r() < 0.3 ? 0 : g;
    const len = between(r, p.gradeLength);
    this.grades.push({ s0: this.gradeEnd, grade });
    this.gradeEnd += len;
    this.gradeY += grade * len;
  }

  private planEnvironment(): void {
    const r = this.rEnv;
    const kinds: Environment[] = ['forest', 'open', 'hilly'];
    const prev = this.envs[this.envs.length - 1].env;
    const next = kinds.filter((k) => k !== prev)[r() < 0.5 ? 0 : 1];
    this.envs.push({ s0: this.envEnd, env: next });
    this.envEnd += between(r, A.features.environment.length);
  }

  private planFeature(): void {
    const f = A.features;
    const r = this.rFeature;
    // Earliest due feature first; pushed back so features never overlap.
    const kind = (Object.keys(this.nextAt) as FeatureKind[]).reduce((a, b) => (this.nextAt[a] <= this.nextAt[b] ? a : b));
    const margin = kind === 'overpass' ? 120 : 350;
    const last = this.features[this.features.length - 1];
    let s0 = Math.max(this.nextAt[kind], last ? last.s1 + margin : 0);
    let len: number;
    switch (kind) {
      case 'tunnel':
        len = between(r, f.tunnel.length);
        // Lead-in for the speed signs and portal hill.
        s0 = Math.max(s0, (last ? last.s1 : 0) + 900);
        break;
      case 'bridge':
        len = between(r, f.bridge.length);
        break;
      case 'overpass':
        len = f.overpass.width;
        break;
      case 'exit':
        len = f.exit.length;
        s0 = Math.max(s0, (last ? last.s1 : 0) + 1200);
        break;
      case 'restArea':
        len = f.restArea.length;
        s0 = Math.max(s0, (last ? last.s1 : 0) + 2200);
        break;
    }
    const index = this.counters[kind]++;
    const name = kind === 'restArea' ? REST_NAMES[(index + this.seed) % REST_NAMES.length] : kind === 'exit' ? DESTINATIONS[(index * 3 + this.seed) % DESTINATIONS.length] : `${kind} ${index + 1}`;
    const feature: Feature = { kind, s0, s1: s0 + len, name, index };
    this.features.push(feature);
    this.featureEnd = feature.s1;
    const every = kind === 'restArea' ? f.restArea.every : (f[kind] as { every: readonly [number, number] }).every;
    this.nextAt[kind] = feature.s1 + between(r, every);
    this.addSigns(feature, r);
  }

  private addSigns(f: Feature, r: () => number): void {
    const exitNo = 20 + f.index;
    if (f.kind === 'exit') {
      this.signs.push({ s: f.s0 - 1000, kind: 'exitSoon', text: [`${exitNo}`, f.name, '1000 m'] });
      this.signs.push({ s: f.s0 - 450, kind: 'gantry', text: [`${exitNo}`, f.name, 'AUSFAHRT'] });
      this.signs.push({ s: f.s0 + 40, kind: 'gore', text: ['AUSFAHRT'] });
      // Onward destinations after the exit.
      const a = DESTINATIONS[(f.index * 3 + 1 + this.seed) % DESTINATIONS.length];
      const b = DESTINATIONS[(f.index * 3 + 2 + this.seed) % DESTINATIONS.length];
      this.signs.push({ s: f.s1 + 400, kind: 'distance', text: [`${a}  ${Math.round(8 + r() * 20)} km`, `${b}  ${Math.round(30 + r() * 40)} km`] });
    } else if (f.kind === 'restArea') {
      this.signs.push({ s: f.s0 - 2000, kind: 'rest', text: ['Raststätte', f.name, '2 km'] });
      this.signs.push({ s: f.s0 - 600, kind: 'rest', text: ['Raststätte', f.name, '600 m'] });
      this.signs.push({ s: f.s0 + 40, kind: 'gore', text: ['RASTSTÄTTE'] });
    } else if (f.kind === 'tunnel') {
      this.signs.push({ s: f.s0 - 800, kind: 'speed', text: ['120'], value: 120 });
      this.signs.push({ s: f.s0 - 350, kind: 'speed', text: ['100'], value: 100 });
    } else if (f.kind === 'bridge' && r() < 0.4) {
      this.signs.push({ s: f.s0 - 400, kind: 'speed', text: ['120'], value: 120 });
    }
  }

  // --- centre line --------------------------------------------------------------

  private pushSample(x: number, y: number, z: number, h: number): void {
    if (this.count === this.xs.length) {
      const grow = (a: Float64Array) => {
        const b = new Float64Array(a.length * 2);
        b.set(a);
        return b;
      };
      this.xs = grow(this.xs);
      this.zs = grow(this.zs);
      this.hs = grow(this.hs);
      this.ys = grow(this.ys);
    }
    const i = this.count++;
    this.xs[i] = x;
    this.ys[i] = y;
    this.zs[i] = z;
    this.hs[i] = h;
  }

  /** One integration step (midpoint rule for heading and height). */
  private integrate(): void {
    const i = this.count - 1;
    const s = i * STEP;
    const k = this.curvatureAt(s + STEP / 2);
    const h = this.hs[i] + k * STEP;
    const hm = (this.hs[i] + h) / 2;
    const g = this.gradeAt(s + STEP / 2);
    this.pushSample(this.xs[i] + Math.sin(hm) * STEP, this.ys[i] + g * STEP, this.zs[i] + Math.cos(hm) * STEP, h);
  }

  curvatureAt(s: number): number {
    const T = A.plan.transition;
    // Curves are few and sorted: binary search for the one covering s.
    let lo = 0;
    let hi = this.curves.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = this.curves[mid];
      if (s < c.s0) hi = mid - 1;
      else if (s > c.s1) lo = mid + 1;
      else {
        // Smooth ramps in and out (continuous curvature: no steering jolt at speed).
        return c.k * ramp(s, c.s0, c.s0 + T) * (1 - ramp(s, c.s1 - T, c.s1));
      }
    }
    return 0;
  }

  gradeAt(s: number): number {
    const T = A.plan.gradeTransition;
    let i = this.grades.length - 1;
    // The blend into section i is centred on its start, so it begins T/2 before it.
    while (i > 0 && this.grades[i].s0 - T / 2 > s) i--;
    const cur = this.grades[i];
    const prev = i > 0 ? this.grades[i - 1].grade : cur.grade;
    return prev + (cur.grade - prev) * ramp(s, cur.s0 - T / 2, cur.s0 + T / 2);
  }

  bankAt(s: number): number {
    return Math.max(-A.maxBank, Math.min(A.maxBank, this.curvatureAt(s) * A.bankPerCurvature));
  }

  /** Interpolated centre-line frame at s (s ≥ 0). */
  frame(s: number, out: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 }): Frame {
    this.ensure(s);
    const f = Math.max(0, s) / STEP;
    const i = Math.min(Math.floor(f), this.count - 2);
    const t = f - i;
    out.x = this.xs[i] + (this.xs[i + 1] - this.xs[i]) * t;
    out.y = this.ys[i] + (this.ys[i + 1] - this.ys[i]) * t;
    out.z = this.zs[i] + (this.zs[i + 1] - this.zs[i]) * t;
    out.heading = this.hs[i] + (this.hs[i + 1] - this.hs[i]) * t;
    out.curvature = this.curvatureAt(s);
    out.bank = this.bankAt(s);
    return out;
  }

  /**
   * Road surface height at (s, off) for |off| ≤ edge: drainage crossfall away
   * from the median, plus superelevation tilting the whole road into curves.
   */
  surfaceY(f: Frame, off: number): number {
    return f.y - Math.abs(off) * A.crossfall - off * f.bank;
  }

  /** World position of road coordinate (s, off) at the surface (+ lift). */
  toWorld(s: number, off: number, lift = 0, out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
    const f = this.frame(s, this._f);
    out.x = f.x + Math.cos(f.heading) * off;
    out.z = f.z - Math.sin(f.heading) * off;
    out.y = this.surfaceY(f, Math.max(-SECTION.edge, Math.min(SECTION.edge, off))) + lift;
    return out;
  }
  private readonly _f: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };

  /** Closest centre-line distance to a world point, searching around `hint` (±window m). */
  nearestS(x: number, z: number, hint: number, window = 300): number {
    this.ensure(hint + window);
    const i0 = Math.max(0, Math.floor((hint - window) / STEP));
    const i1 = Math.min(this.count - 1, Math.ceil((hint + window) / STEP));
    let best = i0;
    let bestD = Infinity;
    for (let i = i0; i <= i1; i++) {
      const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    // Refine between the neighbouring samples (projection on the segment).
    const j = Math.min(best, this.count - 2);
    const dx = this.xs[j + 1] - this.xs[j];
    const dz = this.zs[j + 1] - this.zs[j];
    const t = Math.max(0, Math.min(1, ((x - this.xs[j]) * dx + (z - this.zs[j]) * dz) / (dx * dx + dz * dz)));
    return (j + t) * STEP;
  }

  /** Closest centre-line distance anywhere on the generated road (coarse scan, then refined). */
  nearestSGlobal(x: number, z: number): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i += 25) {
      const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return this.nearestS(x, z, best * STEP, 80);
  }

  /** Signed lateral offset of a world point from the centre line at s (+ = left). */
  lateralOffset(x: number, z: number, s: number): number {
    const f = this.frame(s, this._f);
    return (x - f.x) * Math.cos(f.heading) - (z - f.z) * Math.sin(f.heading);
  }

  // --- features, environment, terrain ------------------------------------------------

  featuresIn(s0: number, s1: number, margin = 0): Feature[] {
    this.ensure(s1);
    // Features are sorted and never overlap: binary search the first candidate.
    const list = this.features;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].s1 + margin < s0) lo = mid + 1;
      else hi = mid;
    }
    const out: Feature[] = [];
    for (let i = lo; i < list.length && list[i].s0 - margin <= s1; i++) out.push(list[i]);
    return out;
  }

  signsIn(s0: number, s1: number): SignPlacement[] {
    this.ensure(s1);
    return this.signs.filter((g) => g.s >= s0 && g.s < s1);
  }

  /** Environment weights at s (blended over the zone change). */
  environmentAt(s: number): Record<Environment, number> {
    this.ensure(s);
    const out: Record<Environment, number> = { forest: 0, open: 0, hilly: 0 };
    let i = this.envs.length - 1;
    while (i > 0 && this.envs[i].s0 > s) i--;
    const cur = this.envs[i];
    const prev = i > 0 ? this.envs[i - 1].env : cur.env;
    const b = A.features.environment.blend;
    const t = ramp(s, cur.s0 - b / 2, cur.s0 + b / 2);
    out[prev] += 1 - t;
    out[cur.env] += t;
    return out;
  }

  dominantEnvironment(s: number): Environment {
    const w = this.environmentAt(s);
    return (Object.keys(w) as Environment[]).reduce((a, b) => (w[a] >= w[b] ? a : b));
  }

  /** 0..1: inside a tunnel (1 between the portals). */
  tunnelAt(s: number): Feature | null {
    for (const f of this.featuresIn(s, s)) if (f.kind === 'tunnel') return f;
    return null;
  }

  /**
   * Terrain height at road coordinate (s, off). Under the road it sits just
   * below the surface (it shows only where the road is a bridge); beside it the
   * biome decides the hills (flat fields, rolling hills, rocky crests, valleys
   * falling away); it rises over tunnels, drops into valleys under bridges and
   * is flat under ramps / rest areas. The first 6 m beside the road stay flat:
   * terrain never covers the road.
   */
  terrainHeight(s: number, off: number): number {
    const f = this.frame(s, this._f2);
    const edge = SECTION.edge;
    const a = Math.abs(off) - edge;
    const side = off >= 0 ? 1 : -1;
    const roadEdge = this.surfaceY(f, side * edge);
    const x = f.x + Math.cos(f.heading) * off;
    const z = f.z - Math.sin(f.heading) * off;
    const w = this.biomeWeights(s, off, x, z, this._bw);
    const amp = BiomeMap.mix(w, 'nearAmp');
    const hills = valueNoise(this.seed, x / 420, z / 420) * 0.7 + valueNoise(this.seed + 7, x / 150, z / 150) * 0.3;
    let h: number;
    if (a < 0) h = this.surfaceY(f, off) - 0.4;
    else {
      const rough = valueNoise(this.seed + 11, x / 55, z / 55) * BiomeMap.mix(w, 'detail') + (ridged(this.seed + 13, x / 320, z / 320) - 0.35) * BiomeMap.mix(w, 'ridge');
      h = roadEdge - 0.4 + (hills * amp + rough * ramp(a, 25, 160)) * ramp(a, 6, 120) + BiomeMap.mix(w, 'sink') * ramp(a, 40, 420) - Math.min(a, 6) * 0.05;
    }

    for (const ft of this.featuresIn(s, s, 600)) {
      if (ft.kind === 'bridge') {
        const along = ramp(s, ft.s0 - 30, ft.s0 + 60) * (1 - ramp(s, ft.s1 - 60, ft.s1 + 30));
        const across = 1 - ramp(Math.abs(off), 140, 320);
        h -= A.features.bridge.depth * along * across;
      } else if (ft.kind === 'tunnel') {
        const hill = A.features.tunnel.hill;
        if (a < 0) {
          // Over the road only between the portals: a roof over the tube, just above the portal's
          // headwall at the portals and rising into the hill further in (no block standing over the opening).
          if (s >= ft.s0 && s <= ft.s1) {
            const H = A.features.tunnel.height;
            h = f.y + H + 3 + (hill - H - 3) * ramp(Math.min(s - ft.s0, ft.s1 - s), 0, 90);
          }
        } else {
          // A rolling hill: higher in the middle, uneven along and across, fading out sideways.
          const along = ramp(s, ft.s0 - 220, ft.s0 + 20) * (1 - ramp(s, ft.s1 - 20, ft.s1 + 220));
          const swell = 0.75 + 0.45 * valueNoise(this.seed + 3, x / 260, z / 260) + 0.25 * Math.sin(((s - ft.s0) / (ft.s1 - ft.s0)) * Math.PI);
          const across = 1 - ramp(a, 30, 480);
          // Cut slopes beside the road (~42°), but tall enough over the tube between the portals.
          let limit = roadEdge + 1 + Math.max(0, a - 1) * 0.9;
          if (s >= ft.s0 && s <= ft.s1) limit = Math.max(limit, roadEdge + A.features.tunnel.height + 2);
          h = Math.max(h, Math.min(roadEdge + (hill * swell * across + hills * Math.max(amp, 14) * 0.3) * along, limit));
        }
      } else if (ft.kind === 'overpass' && a >= 4) {
        // Embankments carry the crossing road up to its deck on both sides.
        const mid = (ft.s0 + ft.s1) / 2;
        const deck = f.y + A.features.overpass.height;
        const w = (1 - ramp(Math.abs(s - mid), 8, 40)) * ramp(a, 4, 14) * (1 - ramp(a, 60, 110));
        h = h + (deck - h) * w;
      } else if ((ft.kind === 'exit' || ft.kind === 'restArea') && side < 0 && a >= 0) {
        const pad = this.sidePadHeight(ft, s, off);
        if (pad !== null) {
          const w = 1 - ramp(Math.abs(pad.dist), pad.half, pad.half + 18);
          h = h + (pad.y - 0.4 - h) * w;
        }
      }
    }
    return h;
  }

  /**
   * Landscape height anywhere, given the point's road coordinate: the road
   * corridor terrain within 500 m of the centre line, blending into the free
   * landscape (biome hills, far mountain ranges) by 1.4 km.
   */
  worldHeight(s: number, off: number, x: number, z: number): number {
    const t = ramp(Math.abs(off), A.world.blendNear, A.world.blendFar);
    if (t >= 1) return this.farHeight(x, z, this.biome.weights(x, z, this._bw));
    const near = this.terrainHeight(s, off);
    if (t <= 0) return near;
    return near + (this.farHeight(x, z, this._bw) - near) * t;
  }

  /** Free landscape height (no road): biome base level and hills, occasional mountain ranges. */
  farHeight(x: number, z: number, w: Float32Array): number {
    const base = BiomeMap.mix(w, 'farBase') + BiomeMap.mix(w, 'farAmp') * fbm(this.seed + 21, x / 2600, z / 2600, 4);
    const range = ridged(this.seed + 23, x / 9000, z / 9000, 4) * A.world.mountains * ramp(fbm(this.seed + 25, x / 26000, z / 26000, 2), -0.15, 0.35);
    return base + range + valueNoise(this.seed + 11, x / 55, z / 55) * BiomeMap.mix(w, 'detail');
  }

  /** Biome weights at a road coordinate (adds the rest areas' surroundings). */
  biomeWeights(s: number, off: number, x: number, z: number, out: Float32Array): Float32Array {
    return this.biome.weights(x, z, out, this.serviceWeight(s, off));
  }

  /** 0..1: near a rest area (mown grass, few trees around it). */
  serviceWeight(s: number, off: number): number {
    let w = 0;
    for (const ft of this.featuresIn(s, s, 500)) {
      if (ft.kind !== 'restArea') continue;
      const d = Math.max(ft.s0 - s, s - ft.s1, 0);
      w = Math.max(w, (1 - ramp(d, 0, 450)) * (1 - ramp(Math.abs(off), 250, 650)));
    }
    return w;
  }

  /** Strongest biome around road distance s (F2 / tests). */
  biomeAt(s: number, off = 0): string {
    const f = this.frame(s, this._f3);
    const x = f.x + Math.cos(f.heading) * off;
    const z = f.z - Math.sin(f.heading) * off;
    return BIOMES[BiomeMap.dominant(this.biomeWeights(s, off, x, z, this._bw))].label;
  }
  private readonly _f3: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
  private readonly _bw = new Float32Array(BIOME_COUNT);
  /** Biome weights of the last terrain / landscape query (scratch, overwritten by the next one). */
  get weights(): Float32Array {
    return this._bw;
  }

  private readonly _f2: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };

  /** Ramp / platform surface near (s, off) for an exit or rest area, or null. */
  sidePadHeight(ft: Feature, s: number, off: number): { y: number; dist: number; half: number } | null {
    if (s < ft.s0 - 20 || s > ft.s1 + 20) return null;
    const lane = rampLayout(ft, Math.max(ft.s0, Math.min(ft.s1, s)));
    if (!lane) return null;
    const y = this.toWorld(s, -SECTION.edge, 0, this._w).y + lane.dy;
    return { y, dist: off - lane.centre, half: lane.half };
  }
  private readonly _w = { x: 0, y: 0, z: 0 };
}

/**
 * Side road layout of an exit / rest area at s: centre offset (negative = right
 * of direction A), half width and height change. The ramp leaves the road edge
 * and spreads outwards; a rest area has an exit ramp, a wide platform and a
 * re-entry ramp.
 */
export function rampLayout(ft: Feature, s: number): { centre: number; half: number; dy: number } | null {
  const edge = SECTION.edge;
  const rampHalf = 3.6;
  const t = (s - ft.s0) / (ft.s1 - ft.s0);
  if (t < 0 || t > 1) return null;
  if (ft.kind === 'exit') {
    const spread = A.features.exit.spread * smooth(t / 0.9);
    return { centre: -(edge + rampHalf + spread), half: rampHalf, dy: -A.features.exit.drop * smooth(t) };
  }
  if (ft.kind === 'restArea') {
    const off = A.features.restArea.offset;
    const len = ft.s1 - ft.s0;
    const inRamp = 260 / len;
    const outRamp = 1 - 260 / len;
    const reach = off - edge - rampHalf - 30;
    if (t < inRamp) return { centre: -(edge + rampHalf + reach * smooth(t / inRamp)), half: rampHalf, dy: 0 };
    if (t > outRamp) return { centre: -(edge + rampHalf + reach * smooth((1 - t) / (1 - outRamp))), half: rampHalf, dy: 0 };
    // The platform: widens from the ramp into a flat area set back from the road, then narrows again.
    const sIn = ft.s0 + 260;
    const sOut = ft.s1 - 260;
    const w = ramp(s, sIn, sIn + 70) * (1 - ramp(s, sOut - 70, sOut));
    const rampEnd = -(edge + rampHalf + reach);
    return { centre: rampEnd + (-off - rampEnd) * w, half: rampHalf + (PLATFORM_HALF - rampHalf) * w, dy: 0 };
  }
  return null;
}
