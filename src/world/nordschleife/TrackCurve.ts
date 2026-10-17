/*
 * Adapted from Nordschleife Racer by Yassin Soliman (MIT License,
 * https://github.com/yassinsolim/nordschleife-racer, see third_party/nordschleife-racer/LICENSE):
 * centripetal Catmull-Rom centre line sampled into frames whose side vector is
 * up × tangent with its sign kept continuous.
 */
import * as THREE from 'three';

/** Centre-line data as produced by scripts/build-nordschleife.ts. */
export interface TrackData {
  name: string;
  closed: boolean;
  /** Lap length, m. */
  length: number;
  /** Distance between consecutive points, m. */
  spacing: number;
  points: number[][];
  corners: { name: string; distance: number }[];
}

/** Evenly spaced samples along the closed centre line. */
export interface TrackFrames {
  count: number;
  /** Sample spacing, m. */
  step: number;
  /** Lap length of the sampled line, m. */
  length: number;
  /** xyz per sample. */
  position: Float32Array;
  /** Unit forward direction per sample. */
  tangent: Float32Array;
  /** Unit horizontal direction to the left of travel per sample. */
  left: Float32Array;
  /** Signed plan-view curvature, 1/m (+ = turning left). */
  curvature: Float32Array;
  /**
   * How far the ground may extend to each side before it would reach another
   * part of the track (or fold over itself on the inside of a corner), m.
   */
  clearLeft: Float32Array;
  clearRight: Float32Array;
}

/** Track sections closer than this along the lap are the same section, not a neighbour. */
const NEIGHBOUR_MIN_SEPARATION = 150;
const CLEARANCE_CELL = 50;

const UP = new THREE.Vector3(0, 1, 0);

export class TrackCurve {
  readonly data: TrackData;
  readonly curve: THREE.CatmullRomCurve3;

  constructor(data: TrackData) {
    if (!Array.isArray(data.points) || data.points.length < 4) throw new Error(`[Track] invalid centre line: ${data.name}`);
    this.data = data;
    const pts = data.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    this.curve = new THREE.CatmullRomCurve3(pts, data.closed, 'centripetal', 0.5);
  }

  get length(): number {
    return this.data.length;
  }

  /**
   * Samples every `step` metres. The source points are evenly spaced, so the
   * curve's own parameter is already proportional to distance (no arc-length table).
   */
  frames(step: number, maxClearance = 60): TrackFrames {
    const count = Math.max(4, Math.round(this.data.length / step));
    const position = new Float32Array(count * 3);
    const tangent = new Float32Array(count * 3);
    const left = new Float32Array(count * 3);
    const curvature = new Float32Array(count);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    const side = new THREE.Vector3();
    const prevSide = new THREE.Vector3(1, 0, 0);
    for (let i = 0; i < count; i++) {
      const u = i / count;
      this.curve.getPoint(u, p);
      this.curve.getTangent(u, t).normalize();
      side.crossVectors(UP, t);
      if (side.lengthSq() < 1e-8) side.copy(prevSide);
      else side.normalize();
      prevSide.copy(side);
      p.toArray(position, i * 3);
      t.toArray(tangent, i * 3);
      side.toArray(left, i * 3);
    }
    // Curvature from the heading change over ±10 m (smooth enough for kerb placement).
    // Actual spacing: the lap is not an exact multiple of the requested step.
    step = this.data.length / count;
    const span = Math.max(1, Math.round(10 / step));
    for (let i = 0; i < count; i++) {
      const a = ((i - span + count) % count) * 3;
      const b = ((i + span) % count) * 3;
      const ha = Math.atan2(tangent[a], tangent[a + 2]);
      const hb = Math.atan2(tangent[b], tangent[b + 2]);
      let dh = hb - ha;
      if (dh > Math.PI) dh -= Math.PI * 2;
      if (dh < -Math.PI) dh += Math.PI * 2;
      curvature[i] = dh / (2 * span * step);
    }
    const { clearLeft, clearRight } = this.clearance(count, position, left, curvature, maxClearance);
    return { count, step, length: this.data.length, position, tangent, left, curvature, clearLeft, clearRight };
  }

  /**
   * Lateral room per sample: half the gap to the nearest other section of the
   * lap on that side (spatial hash, plan view), and 85% of the corner radius on
   * the inside of a bend.
   */
  private clearance(count: number, position: Float32Array, left: Float32Array, curvature: Float32Array, max: number) {
    const clearLeft = new Float32Array(count).fill(max);
    const clearRight = new Float32Array(count).fill(max);
    const cells = new Map<string, number[]>();
    const key = (x: number, z: number) => `${Math.floor(x / CLEARANCE_CELL)},${Math.floor(z / CLEARANCE_CELL)}`;
    for (let i = 0; i < count; i++) {
      const k = key(position[i * 3], position[i * 3 + 2]);
      const list = cells.get(k);
      if (list) list.push(i);
      else cells.set(k, [i]);
    }
    const step = this.data.length / count;
    const minSep = Math.round(NEIGHBOUR_MIN_SEPARATION / step);
    const reach = Math.ceil((max * 2) / CLEARANCE_CELL);
    for (let i = 0; i < count; i++) {
      const x = position[i * 3];
      const z = position[i * 3 + 2];
      const cx = Math.floor(x / CLEARANCE_CELL);
      const cz = Math.floor(z / CLEARANCE_CELL);
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        for (let gz = cz - reach; gz <= cz + reach; gz++) {
          const list = cells.get(`${gx},${gz}`);
          if (!list) continue;
          for (const j of list) {
            const sep = Math.abs(i - j);
            if (Math.min(sep, count - sep) < minSep) continue;
            const dx = position[j * 3] - x;
            const dz = position[j * 3 + 2] - z;
            const half = Math.hypot(dx, dz) / 2 - 1;
            if (half >= max) continue;
            const side = dx * left[i * 3] + dz * left[i * 3 + 2];
            if (side >= 0) clearLeft[i] = Math.min(clearLeft[i], Math.max(0, half));
            else clearRight[i] = Math.min(clearRight[i], Math.max(0, half));
          }
        }
      }
      const k = curvature[i];
      if (Math.abs(k) > 1e-6) {
        const inside = 0.85 / Math.abs(k);
        if (k > 0) clearLeft[i] = Math.min(clearLeft[i], inside);
        else clearRight[i] = Math.min(clearRight[i], inside);
      }
    }
    return { clearLeft: minFilter(clearLeft, 3), clearRight: minFilter(clearRight, 3) };
  }

  /** Point and heading at `distance` along the lap. */
  pose(distance: number, outPosition: THREE.Vector3): number {
    const u = (((distance / this.data.length) % 1) + 1) % 1;
    this.curve.getPoint(u, outPosition);
    const t = this.curve.getTangent(u);
    return Math.atan2(t.x, t.z);
  }
}

/** Running minimum over ±`radius` samples (closed), so clearance changes are not abrupt. */
function minFilter(values: Float32Array, radius: number): Float32Array {
  const n = values.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let m = values[i];
    for (let j = -radius; j <= radius; j++) m = Math.min(m, values[(i + j + n) % n]);
    out[i] = m;
  }
  return out;
}
