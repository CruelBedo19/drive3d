import { AUTOBAHN as A } from '../config/tracks';
import { TRAFFIC } from '../config/traffic';
import { SECTION, rampLayout, type Feature, type FeatureKind, type Frame, type RoadGenerator } from '../world/autobahn/RoadGenerator';

/** Carriageway: A drives towards +s, B towards -s (right-hand traffic on both). */
export type Carriageway = 0 | 1;
export type RoadSection = 'normal' | FeatureKind;

/** A lane: carriageway + index (0 = right / slow lane … 2 = left / fast lane). */
export interface Lane {
  id: number;
  carriageway: Carriageway;
  index: number;
  /** Lateral offset of the lane centre from the median (road frame, + = left of direction A). */
  offset: number;
  /** +1 for carriageway A (s grows), -1 for B. */
  direction: 1 | -1;
  /** Lane ids to the driver's left / right, -1 at the edge. */
  left: number;
  right: number;
}

/** Everything a driver needs about a lane at one road distance. */
export interface LaneSample {
  x: number;
  y: number;
  z: number;
  /** Heading of travel (vehicle yaw), rad. */
  heading: number;
  /** Curvature in the travel direction, 1/m (+ = turning left). */
  curvature: number;
  bank: number;
  /** Rise per metre in the travel direction. */
  grade: number;
  /** Speed advice (curve, tunnel), m/s. */
  advice: number;
  section: RoadSection;
}

/** Future lane connections (exits, entries, rest areas): described, not yet used by the AI. */
export interface LaneConnection {
  kind: 'exit' | 'restAreaOut' | 'restAreaIn';
  /** Lane it branches off / joins. */
  laneId: number;
  /** Where it diverges / merges, road distance. */
  s: number;
  feature: Feature;
}

/**
 * Authoritative traffic lanes of the Autobahn, derived from the road
 * generator (never from the rendered mesh): 3 + 3 lane centre lines with
 * position, heading in the travel direction, curvature, banking, grade, speed
 * advice, neighbours and the road section. Carriageway A runs with s, B
 * against it; index 0 is each carriageway's right lane (German keep-right).
 * Exits and rest areas are listed as connections so the AI can use them later.
 */
export class TrafficLaneNetwork {
  readonly gen: RoadGenerator;
  readonly lanes: readonly Lane[];
  private readonly f: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };

  constructor(gen: RoadGenerator) {
    this.gen = gen;
    const lanes: Lane[] = [];
    for (const cw of [0, 1] as const) {
      for (let index = 0; index < A.lanes; index++) {
        // lanesA is fast lane first (nearest the median); index 0 = right lane = outermost.
        const k = A.lanes - 1 - index;
        lanes.push({
          id: cw * A.lanes + index,
          carriageway: cw,
          index,
          offset: cw === 0 ? SECTION.lanesA[k] : SECTION.laneB[k],
          direction: cw === 0 ? 1 : -1,
          left: index < A.lanes - 1 ? cw * A.lanes + index + 1 : -1,
          right: index > 0 ? cw * A.lanes + index - 1 : -1,
        });
      }
    }
    this.lanes = lanes;
  }

  laneId(carriageway: Carriageway, index: number): number {
    return carriageway * A.lanes + index;
  }

  /** Lateral offset (road frame) for a carriageway and a fractional lane position. */
  offsetAt(carriageway: Carriageway, lanePos: number): number {
    const a = this.lanes[this.laneId(carriageway, 0)].offset;
    const step = (carriageway === 0 ? 1 : -1) * A.lane;
    // Moving left (higher index) goes towards the median: offset rises for A, falls for B.
    return a + lanePos * step;
  }

  /** Lane sample at road distance s, at lateral offset `off` (defaults to the lane centre). */
  sample(laneId: number, s: number, out: LaneSample, off?: number): LaneSample {
    const lane = this.lanes[laneId];
    const f = this.gen.frame(s, this.f);
    const o = off ?? lane.offset;
    out.x = f.x + Math.cos(f.heading) * o;
    out.z = f.z - Math.sin(f.heading) * o;
    out.y = this.gen.surfaceY(f, o);
    out.heading = lane.direction > 0 ? f.heading : f.heading + Math.PI;
    out.curvature = f.curvature * lane.direction;
    out.bank = f.bank;
    out.grade = this.gen.gradeAt(s) * lane.direction;
    out.section = this.sectionAt(s);
    out.advice = this.advice(s, out.section);
    return out;
  }

  /** Speed advice at s (m/s): curves by lateral acceleration, tunnels by their limit. */
  advice(s: number, section: RoadSection = this.sectionAt(s)): number {
    const k = Math.abs(this.gen.curvatureAt(s));
    const curve = k > 1e-6 ? Math.sqrt(TRAFFIC.curveLateral / k) : Infinity;
    const tunnel = section === 'tunnel' ? TRAFFIC.tunnelSpeed / 3.6 : Infinity;
    return Math.min(curve, tunnel, 90);
  }

  sectionAt(s: number): RoadSection {
    for (const ft of this.gen.featuresIn(s, s)) return ft.kind;
    return 'normal';
  }

  /** Lane centre points every `step` m (debug drawing). */
  nodes(laneId: number, s0: number, s1: number, step: number): Float32Array {
    const out: number[] = [];
    const smp = {} as LaneSample;
    for (let s = Math.max(0, s0); s <= s1; s += step) {
      this.sample(laneId, s, smp);
      out.push(smp.x, smp.y, smp.z);
    }
    return new Float32Array(out);
  }

  /** Exits / rest-area ramps branching off or joining between s0 and s1 (carriageway A, right lane). */
  connectionsIn(s0: number, s1: number): LaneConnection[] {
    const out: LaneConnection[] = [];
    for (const ft of this.gen.featuresIn(s0, s1)) {
      if (ft.kind === 'exit') out.push({ kind: 'exit', laneId: 0, s: ft.s0, feature: ft });
      else if (ft.kind === 'restArea') {
        out.push({ kind: 'restAreaOut', laneId: 0, s: ft.s0, feature: ft });
        out.push({ kind: 'restAreaIn', laneId: 0, s: ft.s1, feature: ft });
      }
    }
    return out;
  }

  /** Ramp centre offset at s for a connection (future use: the lane the AI would follow off the road). */
  rampOffset(c: LaneConnection, s: number): number | null {
    return rampLayout(c.feature, s)?.centre ?? null;
  }
}
