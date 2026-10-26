import type { CityV2Json } from '../../world/cityv2/CityV2Data';
import type { JunctionControl, PropJunction } from '../../world/cityv2/propKit';
import { ROAD_PROFILE, kerbOffset, laneOffsets, type RoadClass } from '../../world/cityv2/roadProfiles';

export type Turn = 'straight' | 'left' | 'right';

/**
 * One piece of drivable path: a lane of a road edge (straight, from the far
 * side of one junction to the stop line of the next) or a connector through a
 * junction / bend (a curve from a lane's end to the start of a lane of another
 * edge). Both are polylines with cumulative lengths.
 */
export interface CitySeg {
  id: number;
  kind: 'lane' | 'connector';
  px: Float32Array;
  pz: Float32Array;
  /** Cumulative length at each point; the last one is the length. */
  cum: Float32Array;
  length: number;
  /** Speed limit (lanes) or speed advice for the curve (connectors), m/s. */
  speed: number;
  /** Lane: road edge (index in roadGraph), direction (+1 a→b, -1 b→a), lane index (0 innermost), lanes that way. */
  edge: number;
  dir: 1 | -1;
  lane: number;
  lanes: number;
  cls: RoadClass;
  /** Lane: node it ends at; connector: node it crosses. */
  node: number;
  /** Lane: connectors leaving its end; connector: the lane it leads into. */
  next: number[];
  /** Lane: how its end is controlled and its signal group (-1 none). */
  control: JunctionControl;
  group: number;
  /** Connector: entry lane, exit lane, turn, connectors at the same node whose paths cross or merge with it. */
  from: number;
  to: number;
  turn: Turn;
  /** Connector: straight on into the neighbouring lane (a lane change across the junction). */
  shift: boolean;
  conflicts: number[];
}

export interface CityNode {
  id: number;
  x: number;
  z: number;
  /** Road edges meeting here. */
  edges: number[];
  /** A real junction (T or crossroads); bends and straight passes are not. */
  junction: PropJunction | null;
  /** Distance from the node to where the lanes of each edge stop (stop line, or the start of a bend), by edge. */
  trim: Map<number, number>;
}

/** Wanted speeds by road class, km/h. */
const LIMIT_KMH: Record<RoadClass, number> = { arterial3: 60, boulevard: 55, avenue: 50, street: 40, alley: 22 };
/** Lateral acceleration drivers accept through turns, m/s². */
const TURN_LATERAL = 2.4;
/** Two connectors conflict if their centre lines come closer than this, m (two car widths plus a margin). */
const CONFLICT_DISTANCE = 2.4;
/** Distance from the junction box to the stop line, m (zebra crossing in between; scripts/lib/cityV2/props.ts). */
const STOP_LINE = 4;
const BIN = 100;

/**
 * The traffic lanes of City V2, built at load from the prepared road graph
 * (CityV2Json.roadGraph: straight, axis-aligned edges) and the junction data
 * the props step wrote (control per approach, signal groups). Pure data, no
 * three.js: the headless tests use it too.
 *
 * Lanes keep right; lane 0 is the innermost. At a junction the lanes end at
 * the stop line and connectors join them to the lanes of the other edges:
 * right turns from the outermost lane into the outermost, left turns from the
 * innermost into the innermost, straight on lane by lane; a lane with no such
 * movement (the middle lane at a T) turns towards its side. Every pair of
 * connectors at a node whose paths come within CONFLICT_DISTANCE (crossing or
 * merging) is listed as a conflict; the AI never has two vehicles on
 * conflicting connectors at once.
 */
export class CityLaneGraph {
  readonly segs: CitySeg[] = [];
  readonly nodes: CityNode[] = [];
  /** Lane segments only, and lane ids per 100 m bin (spawning, nearest lane). */
  readonly lanes: number[] = [];
  private readonly bins = new Map<string, number[]>();
  readonly roads: CityV2Json['roadGraph'];

  constructor(json: CityV2Json) {
    this.roads = json.roadGraph;
    const key = (p: [number, number]) => `${p[0]},${p[1]}`;
    const ids = new Map<string, number>();
    const nodeOf = (p: [number, number]): number => {
      let id = ids.get(key(p));
      if (id === undefined) {
        id = this.nodes.length;
        ids.set(key(p), id);
        this.nodes.push({ id, x: p[0], z: p[1], edges: [], junction: null, trim: new Map() });
      }
      return id;
    };
    const ends: [number, number][] = this.roads.map((r, i) => {
      const a = nodeOf(r.a);
      const b = nodeOf(r.b);
      this.nodes[a].edges.push(i);
      this.nodes[b].edges.push(i);
      return [a, b];
    });
    for (const j of json.props?.junctions ?? []) {
      const id = ids.get(`${j.x},${j.z}`);
      if (id !== undefined) this.nodes[id].junction = j;
    }
    // Where each edge's lanes stop at each node.
    for (const n of this.nodes) {
      for (const e of n.edges) {
        let other = 0;
        for (const o of n.edges) if (o !== e) other = Math.max(other, kerbOffset(this.roads[o].cls));
        let trim: number;
        if (n.edges.length >= 3) trim = other + STOP_LINE;
        else if (n.edges.length === 2 && !this.collinear(n, n.edges[0], n.edges[1])) trim = other + 1.5;
        else trim = 0.5;
        n.trim.set(e, trim);
      }
    }
    // Lanes.
    const laneIds = new Map<string, number>();
    this.roads.forEach((r, e) => {
      const [na, nb] = ends[e];
      const offs = laneOffsets(r.cls);
      for (const dir of [1, -1] as const) {
        const from = dir > 0 ? na : nb;
        const to = dir > 0 ? nb : na;
        const A = this.nodes[from];
        const B = this.nodes[to];
        const len = Math.hypot(B.x - A.x, B.z - A.z);
        const tx = (B.x - A.x) / len;
        const tz = (B.z - A.z) / len;
        // Driver's right (props.ts: r = (-t.z, t.x)).
        const rx = -tz;
        const rz = tx;
        let t0 = A.trim.get(e)!;
        let t1 = len - B.trim.get(e)!;
        if (t1 - t0 < 2) {
          // A short edge between two wide junctions: a 2 m stub in the middle (the connectors do the rest).
          const mid = (A.trim.get(e)! + len - B.trim.get(e)!) / 2;
          t0 = mid - 1;
          t1 = mid + 1;
        }
        const appr = B.junction?.approaches.find((a) => a.edge === e) ?? null;
        offs.forEach((off, k) => {
          const seg = this.newSeg('lane', [A.x + tx * t0 + rx * off, A.x + tx * t1 + rx * off], [A.z + tz * t0 + rz * off, A.z + tz * t1 + rz * off]);
          seg.speed = LIMIT_KMH[r.cls] / 3.6;
          seg.edge = e;
          seg.dir = dir;
          seg.lane = k;
          seg.lanes = offs.length;
          seg.cls = r.cls;
          seg.node = to;
          seg.control = appr?.control ?? 'none';
          seg.group = appr && appr.control === 'signal' ? appr.group : -1;
          laneIds.set(`${e},${dir},${k}`, seg.id);
          this.lanes.push(seg.id);
          const mx = Math.floor((A.x + B.x) / 2 / BIN);
          const mz = Math.floor((A.z + B.z) / 2 / BIN);
          const b = `${mx},${mz}`;
          const list = this.bins.get(b);
          if (list) list.push(seg.id);
          else this.bins.set(b, [seg.id]);
        });
      }
    });
    // Connectors at every node.
    for (const n of this.nodes) {
      const made: number[] = [];
      for (const ein of n.edges) {
        const rin = this.roads[ein];
        const dirIn: 1 | -1 = ends[ein][1] === n.id ? 1 : -1;
        const L = ROAD_PROFILE[rin.cls].lanes;
        const tin = this.travel(ein, dirIn);
        const outs = n.edges
          .filter((e) => e !== ein)
          .map((eout) => {
            const dirOut: 1 | -1 = ends[eout][0] === n.id ? 1 : -1;
            const t = this.travel(eout, dirOut);
            // Right of travel is (-t.z, t.x): a right turn heads that way.
            const side = t[0] * -tin[1] + t[1] * tin[0];
            const turn: Turn = t[0] * tin[0] + t[1] * tin[1] > 0.7 ? 'straight' : side > 0 ? 'right' : 'left';
            return { eout, dirOut, turn, L2: ROAD_PROFILE[this.roads[eout].cls].lanes };
          });
        for (let k = 0; k < L; k++) {
          const from = laneIds.get(`${ein},${dirIn},${k}`)!;
          const moves: { eout: number; dirOut: 1 | -1; turn: Turn; k2: number; shift?: boolean }[] = [];
          // A bend or a straight pass keeps every lane in its lane (no junction rules there, so no merging).
          for (const o of outs) {
            if (n.edges.length === 2) moves.push({ ...o, k2: Math.min(k, o.L2 - 1) });
            else if (o.turn === 'straight') {
              moves.push({ ...o, k2: Math.min(k, o.L2 - 1) });
              // Widening: the outermost lane also feeds the extra lanes.
              if (k === L - 1) for (let k2 = k + 1; k2 < o.L2; k2++) moves.push({ ...o, k2 });
              // There are no lane changes between junctions: straight on, a driver may move one lane over across the junction.
              for (const k2 of [k - 1, k + 1]) if (L >= 2 && k2 >= 0 && k2 < o.L2 && !moves.some((m) => m.eout === o.eout && m.k2 === k2)) moves.push({ ...o, k2, shift: true });
            }
            // Turns may end in the near half of the new road's lanes (both of two): no lane changes, so every lane gets traffic.
            else if (o.turn === 'right' && k === L - 1) for (let k2 = Math.floor((o.L2 - 1) / 2); k2 < o.L2; k2++) moves.push({ ...o, k2 });
            else if (o.turn === 'left' && k === 0) for (let k2 = 0; k2 <= Math.ceil((o.L2 - 1) / 2); k2++) moves.push({ ...o, k2 });
          }
          if (!moves.length) {
            // The middle lane at a T: turn towards its side.
            const want: Turn = k < L / 2 ? 'left' : 'right';
            const o = outs.find((x) => x.turn === want) ?? outs[0];
            if (o) moves.push({ ...o, k2: o.turn === 'right' ? Math.max(0, o.L2 - L + k) : Math.min(k, o.L2 - 1) });
          }
          for (const m of moves) {
            const to = laneIds.get(`${m.eout},${m.dirOut},${m.k2}`)!;
            const c = this.connector(n, from, to, m.turn);
            c.shift = m.shift ?? false;
            this.segs[from].next.push(c.id);
            made.push(c.id);
          }
        }
      }
      // Conflicts: paths that cross or merge (not those leaving the same lane).
      const box = made.map((id) => bounds(this.segs[id]));
      for (let i = 0; i < made.length; i++) {
        for (let j = i + 1; j < made.length; j++) {
          const a = this.segs[made[i]];
          const b = this.segs[made[j]];
          if (a.from === b.from) continue;
          const p = box[i];
          const q = box[j];
          const apart = p[0] > q[2] + CONFLICT_DISTANCE || q[0] > p[2] + CONFLICT_DISTANCE || p[1] > q[3] + CONFLICT_DISTANCE || q[1] > p[3] + CONFLICT_DISTANCE;
          if (a.to === b.to || (!apart && minDistance(a, b) < CONFLICT_DISTANCE)) {
            a.conflicts.push(b.id);
            b.conflicts.push(a.id);
          }
        }
      }
    }
  }

  private collinear(n: CityNode, e1: number, e2: number): boolean {
    const d = (e: number) => {
      const r = this.roads[e];
      const o = r.a[0] === n.x && r.a[1] === n.z ? r.b : r.a;
      const l = Math.hypot(o[0] - n.x, o[1] - n.z);
      return [(o[0] - n.x) / l, (o[1] - n.z) / l];
    };
    const a = d(e1);
    const b = d(e2);
    return a[0] * b[0] + a[1] * b[1] < -0.99;
  }

  /** Unit travel direction of an edge driven in `dir`. */
  private travel(e: number, dir: 1 | -1): [number, number] {
    const r = this.roads[e];
    const l = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
    return [((r.b[0] - r.a[0]) / l) * dir, ((r.b[1] - r.a[1]) / l) * dir];
  }

  private newSeg(kind: CitySeg['kind'], xs: number[], zs: number[]): CitySeg {
    const px = new Float32Array(xs);
    const pz = new Float32Array(zs);
    const cum = new Float32Array(xs.length);
    for (let i = 1; i < xs.length; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
    const seg: CitySeg = {
      id: this.segs.length,
      kind,
      px,
      pz,
      cum,
      length: cum[xs.length - 1],
      speed: 0,
      edge: -1,
      dir: 1,
      lane: 0,
      lanes: 1,
      cls: 'street',
      node: -1,
      next: [],
      control: 'none',
      group: -1,
      from: -1,
      to: -1,
      turn: 'straight',
      shift: false,
      conflicts: [],
    };
    this.segs.push(seg);
    return seg;
  }

  /** A curve from the end of lane `from` to the start of lane `to` (cubic Bézier, sampled). */
  private connector(n: CityNode, from: number, to: number, turn: Turn): CitySeg {
    const a = this.segs[from];
    const b = this.segs[to];
    const ia = a.px.length - 1;
    const p0 = [a.px[ia], a.pz[ia]];
    const p3 = [b.px[0], b.pz[0]];
    const t0 = [(a.px[ia] - a.px[0]) / a.length, (a.pz[ia] - a.pz[0]) / a.length];
    const t1 = [(b.px[1] - b.px[0]) / b.length, (b.pz[1] - b.pz[0]) / b.length];
    const d = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    let c1: number[];
    let c2: number[];
    let samples: number;
    if (turn === 'straight') {
      c1 = [p0[0] + (t0[0] * d) / 3, p0[1] + (t0[1] * d) / 3];
      c2 = [p3[0] - (t1[0] * d) / 3, p3[1] - (t1[1] * d) / 3];
      // A shift between lanes (the lane counts change) needs a gentle S; otherwise a straight line.
      const lateral = Math.abs((p3[0] - p0[0]) * -t0[1] + (p3[1] - p0[1]) * t0[0]);
      samples = lateral > 0.2 ? 8 : 1;
    } else {
      // Corner where the two tangent lines meet; control points 55 % of the way towards it (≈ a quarter circle).
      const den = t0[0] * t1[1] - t0[1] * t1[0];
      const u = ((p3[0] - p0[0]) * t1[1] - (p3[1] - p0[1]) * t1[0]) / den;
      const cx = p0[0] + t0[0] * u;
      const cz = p0[1] + t0[1] * u;
      c1 = [p0[0] + (cx - p0[0]) * 0.55, p0[1] + (cz - p0[1]) * 0.55];
      c2 = [p3[0] + (cx - p3[0]) * 0.55, p3[1] + (cz - p3[1]) * 0.55];
      samples = 8;
    }
    const xs: number[] = [];
    const zs: number[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const s = 1 - t;
      xs.push(s * s * s * p0[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * p3[0]);
      zs.push(s * s * s * p0[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * p3[1]);
    }
    const seg = this.newSeg('connector', xs, zs);
    seg.node = n.id;
    seg.from = from;
    seg.to = to;
    seg.turn = turn;
    seg.next = [to];
    seg.cls = a.cls;
    seg.lanes = 1;
    // Quarter circle: radius ≈ length / (π / 2).
    const radius = turn === 'straight' ? Infinity : seg.length / (Math.PI / 2);
    seg.speed = Math.min(Math.min(a.speed, b.speed), Math.sqrt(TURN_LATERAL * radius));
    return seg;
  }

  /** Point and heading (forward = (sin h, cos h)) at distance s along a segment. */
  sample(seg: CitySeg, s: number, out: { x: number; z: number; heading: number }): { x: number; z: number; heading: number } {
    const cum = seg.cum;
    const n = cum.length;
    let i = 1;
    while (i < n - 1 && cum[i] < s) i++;
    const l = cum[i] - cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / l));
    const dx = seg.px[i] - seg.px[i - 1];
    const dz = seg.pz[i] - seg.pz[i - 1];
    out.x = seg.px[i - 1] + dx * t;
    out.z = seg.pz[i - 1] + dz * t;
    out.heading = Math.atan2(dx, dz);
    return out;
  }

  /** Lane segments whose middle lies within `radius` of (x, z) (coarse: 100 m bins). */
  lanesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const r = Math.ceil(radius / BIN);
    const bx = Math.floor(x / BIN);
    const bz = Math.floor(z / BIN);
    for (let i = -r; i <= r; i++) {
      for (let k = -r; k <= r; k++) {
        const l = this.bins.get(`${bx + i},${bz + k}`);
        if (l) for (const id of l) out.push(id);
      }
    }
    return out;
  }
}

function bounds(s: CitySeg): [number, number, number, number] {
  let x0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < s.px.length; i++) {
    x0 = Math.min(x0, s.px[i]);
    x1 = Math.max(x1, s.px[i]);
    z0 = Math.min(z0, s.pz[i]);
    z1 = Math.max(z1, s.pz[i]);
  }
  return [x0, z0, x1, z1];
}

/** Smallest distance between two polylines, m (0 where they cross). */
function minDistance(a: CitySeg, b: CitySeg): number {
  let best = Infinity;
  for (let i = 1; i < a.px.length; i++) {
    for (let k = 1; k < b.px.length; k++) {
      const d = segDistance(a.px[i - 1], a.pz[i - 1], a.px[i], a.pz[i], b.px[k - 1], b.pz[k - 1], b.px[k], b.pz[k]);
      if (d < best) best = d;
      if (best === 0) return 0;
    }
  }
  return best;
}

function pointSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l = dx * dx + dz * dz;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

function segDistance(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): number {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(pointSeg(ax, az, cx, cz, dx, dz), pointSeg(bx, bz, cx, cz, dx, dz), pointSeg(cx, cz, ax, az, bx, bz), pointSeg(dx, dz, ax, az, bx, bz));
}
