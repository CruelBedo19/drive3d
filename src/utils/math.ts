export const DEG2RAD = Math.PI / 180;
export const MS_TO_KMH = 3.6;

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential smoothing. `lambda` ~ 1/time-constant. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/** Like damp() but takes the shortest path around the circle. */
export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Piecewise linear lookup in an ascending [x, y] table, clamped at the ends. */
export function sampleCurve(curve: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = curve.length;
  if (x <= curve[0][0]) return curve[0][1];
  if (x >= curve[n - 1][0]) return curve[n - 1][1];
  for (let i = 1; i < n; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return lerp(y0, y1, (x - x0) / (x1 - x0));
    }
  }
  return curve[n - 1][1];
}

/** Like sampleCurve() but eases between points (smoothstep), so the result has no kinks. */
export function sampleCurveSmooth(curve: ReadonlyArray<readonly [number, number]>, x: number): number {
  const n = curve.length;
  if (x <= curve[0][0]) return curve[0][1];
  if (x >= curve[n - 1][0]) return curve[n - 1][1];
  for (let i = 1; i < n; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      const t = (x - x0) / (x1 - x0);
      return lerp(y0, y1, t * t * (3 - 2 * t));
    }
  }
  return curve[n - 1][1];
}
