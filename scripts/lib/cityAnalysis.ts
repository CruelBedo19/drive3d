/**
 * Whole-map geometry audit for the city (run by scripts/prepare-city.ts).
 *
 * Every placed triangle of the source is brought to world metres and checked
 * for the causes of flicker and waste:
 *
 *  1. duplicate placements: the same prototype twice at (almost) the same transform;
 *  2. duplicate triangles: the same triangle (corners within 2 mm, any order)
 *     drawn more than once, same or different material;
 *  3. near-coplanar overlaps (z-fighting): two triangles in (almost) the same
 *     plane, facing the same way, overlapping in area: same material on top of
 *     itself, a detail layer (marking, window, decal) on a surface, or both
 *     faces of a zero-thickness wall (all materials are double-sided here, so
 *     the back face of one fights the front face of the other);
 *  4. intersecting pieces: placements whose boxes interpenetrate a lot
 *     (not a wall meeting a roof, not a small part inside a big one);
 *  5. cell seams: the same triangle in two 250 m cells.
 *
 * Findings are classified (safe duplicate / likely z-fighting / fighting only
 * at distance / intentional / ambiguous) for the report and a debug overlay;
 * nothing is changed here.
 */

export interface AuditPiece {
  /** World triangles (x, y, z × 3 per triangle). */
  tris: Float32Array;
  /** Material name per triangle range: [startTriangle, material]. */
  materials: { start: number; name: string }[];
  protoId: number;
  category: string;
  name: string;
  /** World matrix (column-major 4×4), metres. */
  m: ArrayLike<number>;
  min: number[];
  max: number[];
  /** Cell key the piece (or each triangle, for baked ground) is drawn in. */
  baked: boolean;
}

export type FindingKind = 'safeDuplicate' | 'likelyZFight' | 'layered' | 'distanceZFight' | 'backToBack' | 'ambiguous' | 'intersection' | 'seam';

export interface AuditReport {
  pieces: number;
  triangles: number;
  duplicatePlacements: { count: number; triangles: number };
  duplicateTriangles: { sameMaterial: number; differentMaterial: number; where: Record<string, number> };
  coplanar: {
    pairsChecked: number;
    safeDuplicate: number;
    likelyZFight: number;
    layered: number;
    distanceZFight: number;
    backToBack: number;
    intentionalEdge: number;
    byCategoryPair: Record<string, number>;
    byMaterialPair: Record<string, number>;
    /** Distinct piece pairs / single pieces involved (≈ "surfaces"). */
    piecePairs: number;
    selfOverlaps: number;
    byWhere: Record<string, number>;
    /** Per kind: distinct triangles involved, overlapping area (m²), pieces involved. */
    summary: Record<string, { triangles: number; areaM2: number; pieces: number }>;
  };
  intersections: { intentional: number; containedDetail: number; ambiguous: number; examples: string[] };
  seams: number;
  seconds: number;
}

export interface AuditPair {
  /** Global triangle indices (pieceStart[piece] + triangle in piece). */
  i: number;
  j: number;
  kind: FindingKind;
  dist: number;
  ratio: number;
}

export interface AuditResult {
  report: AuditReport;
  /** Debug overlay: triangles (9 floats) per kind, capped. */
  debug: Record<FindingKind, number[]>;
  /** With collectPairs: every finding pair, exact duplicates ([duplicate, original, same material]) and piece starts. */
  pairs: AuditPair[];
  dups: [number, number, boolean][];
  pieceStart: Uint32Array;
  pieceOf: Uint32Array;
  areas: Float32Array;
}

const DEBUG_CAP = 15000; // triangles per kind in the overlay file (keeps it ≈ 3 MB)

export function auditCity(pieces: AuditPiece[], cellOf: (x: number, z: number) => string, log: (s: string) => void, opts: { collectPairs?: boolean } = {}): AuditResult {
  const pairsOut: AuditPair[] = [];
  const dupsOut: [number, number, boolean][] = [];
  const t0 = Date.now();
  const debug: Record<FindingKind, number[]> = { safeDuplicate: [], likelyZFight: [], layered: [], distanceZFight: [], backToBack: [], ambiguous: [], intersection: [], seam: [] };
  const addDebug = (k: FindingKind, tri: ArrayLike<number>, o = 0) => {
    if (debug[k].length < DEBUG_CAP * 9) for (let i = 0; i < 9; i++) debug[k].push(tri[o + i]);
  };

  // --- 1. Duplicate placements -------------------------------------------------------------------
  const placementKey = (p: AuditPiece) => {
    const m = p.m;
    const r = (v: number, q: number) => Math.round(v / q);
    return `${p.protoId}|${r(m[0], 1e-3)},${r(m[1], 1e-3)},${r(m[2], 1e-3)},${r(m[4], 1e-3)},${r(m[5], 1e-3)},${r(m[6], 1e-3)},${r(m[8], 1e-3)},${r(m[9], 1e-3)},${r(m[10], 1e-3)}|${r(m[12], 0.005)},${r(m[13], 0.005)},${r(m[14], 0.005)}`;
  };
  const placements = new Map<string, number>();
  let dupPlacements = 0;
  let dupPlacementTris = 0;
  for (const p of pieces) {
    const k = placementKey(p);
    if (placements.has(k)) {
      dupPlacements++;
      dupPlacementTris += p.tris.length / 9;
    } else placements.set(k, 1);
  }
  log(`audit: ${dupPlacements} duplicate placements`);

  // --- 2. Flatten all triangles with plane data ---------------------------------------------------------
  let total = 0;
  for (const p of pieces) total += p.tris.length / 9;
  const P = new Float32Array(total * 9);
  const N = new Float32Array(total * 4); // nx, ny, nz, d
  const A = new Float32Array(total); // area
  const piece = new Uint32Array(total);
  const pieceStart = new Uint32Array(pieces.length);
  const mat = new Uint16Array(total);
  const matNames: string[] = [];
  const matId = new Map<string, number>();
  let t = 0;
  pieces.forEach((p, pi) => {
    pieceStart[pi] = t;
    const n = p.tris.length / 9;
    let mi = 0;
    for (let k = 0; k < n; k++, t++) {
      while (mi + 1 < p.materials.length && p.materials[mi + 1].start <= k) mi++;
      const name = p.materials[mi].name;
      let id = matId.get(name);
      if (id === undefined) {
        matId.set(name, (id = matNames.length));
        matNames.push(name);
      }
      mat[t] = id;
      piece[t] = pi;
      const o = k * 9;
      for (let c = 0; c < 9; c++) P[t * 9 + c] = p.tris[o + c];
      const ux = p.tris[o + 3] - p.tris[o], uy = p.tris[o + 4] - p.tris[o + 1], uz = p.tris[o + 5] - p.tris[o + 2];
      const wx = p.tris[o + 6] - p.tris[o], wy = p.tris[o + 7] - p.tris[o + 1], wz = p.tris[o + 8] - p.tris[o + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      A[t] = len / 2;
      if (len > 0) {
        nx /= len;
        ny /= len;
        nz /= len;
      }
      N[t * 4] = nx;
      N[t * 4 + 1] = ny;
      N[t * 4 + 2] = nz;
      N[t * 4 + 3] = nx * p.tris[o] + ny * p.tris[o + 1] + nz * p.tris[o + 2];
    }
  });
  log(`audit: ${total} triangles in ${pieces.length} pieces`);

  // --- 3. Exact (2 mm) duplicate triangles and cell seams ---------------------------------------------------
  const triKey = (i: number) => {
    const q = (v: number) => Math.round(v * 500);
    const c = [0, 1, 2].map((k) => `${q(P[i * 9 + k * 3])},${q(P[i * 9 + k * 3 + 1])},${q(P[i * 9 + k * 3 + 2])}`).sort();
    return c.join('|');
  };
  const seen = new Map<string, number>();
  const dupWhere: Record<string, number> = {};
  /** Where a pair lives: inside one piece, between baked ground pieces, between a baked and a placed piece, between placed pieces. */
  const where = (i: number, j: number) => (piece[i] === piece[j] ? 'self' : pieces[piece[i]].baked && pieces[piece[j]].baked ? 'baked-baked' : pieces[piece[i]].baked || pieces[piece[j]].baked ? 'baked-placed' : 'placed-placed');
  let dupSame = 0;
  let dupDiff = 0;
  const isDup = new Uint8Array(total);
  const cellSeen = new Map<string, string>();
  let seams = 0;
  for (let i = 0; i < total; i++) {
    if (A[i] < 1e-6) continue;
    const k = triKey(i);
    const j = seen.get(k);
    if (j === undefined) seen.set(k, i);
    else {
      isDup[i] = 1;
      if (opts.collectPairs) dupsOut.push([i, j, mat[j] === mat[i]]);
      const w = where(i, j);
      dupWhere[w] = (dupWhere[w] ?? 0) + 1;
      if (mat[j] === mat[i]) {
        dupSame++;
        addDebug('safeDuplicate', P, i * 9);
      } else {
        dupDiff++;
        addDebug('likelyZFight', P, i * 9);
      }
    }
    // Baked triangles are drawn in the cell of their centroid; a placement in its centre's cell.
    const p = pieces[piece[i]];
    const cx = p.baked ? (P[i * 9] + P[i * 9 + 3] + P[i * 9 + 6]) / 3 : (p.min[0] + p.max[0]) / 2;
    const cz = p.baked ? (P[i * 9 + 2] + P[i * 9 + 5] + P[i * 9 + 8]) / 3 : (p.min[2] + p.max[2]) / 2;
    const cell = cellOf(cx, cz);
    const prev = cellSeen.get(k);
    if (prev === undefined) cellSeen.set(k, cell);
    else if (prev !== cell) {
      seams++;
      addDebug('seam', P, i * 9);
    }
  }
  seen.clear();
  cellSeen.clear();
  log(`audit: duplicate triangles ${dupSame} same material, ${dupDiff} different material; seam duplicates ${seams}`);

  // --- 4. Near-coplanar overlaps -----------------------------------------------------------------------------
  // Bin by quantised normal (both orientations share a bin) and plane offset; then a 6 m grid inside the plane.
  const MIN_AREA = 0.01;
  const DIST_COPLANAR = 0.0015;
  const DIST_LIKELY = 0.01;
  const DIST_FAR = 0.05;
  const bins = new Map<string, number[]>();
  const planeKey = (i: number, dShift: number) => {
    let nx = N[i * 4], ny = N[i * 4 + 1], nz = N[i * 4 + 2];
    let d = N[i * 4 + 3];
    // Canonical orientation: first non-zero component positive.
    if (nx < -1e-6 || (Math.abs(nx) <= 1e-6 && (ny < -1e-6 || (Math.abs(ny) <= 1e-6 && nz < 0)))) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      d = -d;
    }
    return `${Math.round(nx * 40)},${Math.round(ny * 40)},${Math.round(nz * 40)}|${Math.floor(d / DIST_FAR) + dShift}`;
  };
  for (let i = 0; i < total; i++) {
    if (A[i] < MIN_AREA || isDup[i]) continue;
    if (pieces[piece[i]].category === 'vegetation') continue; // leaf cards overlap by design (alpha)
    const k = planeKey(i, 0);
    let l = bins.get(k);
    if (!l) bins.set(k, (l = []));
    l.push(i);
  }
  const cop = { pairsChecked: 0, safeDuplicate: 0, likelyZFight: 0, layered: 0, distanceZFight: 0, backToBack: 0, intentionalEdge: 0, byCategoryPair: {} as Record<string, number>, byMaterialPair: {} as Record<string, number>, piecePairs: 0, selfOverlaps: 0, byWhere: {} as Record<string, number>, summary: {} as Record<string, { triangles: number; areaM2: number; pieces: number }> };
  const kindTris: Record<string, Set<number>> = {};
  const kindPieces: Record<string, Set<number>> = {};
  const kindArea: Record<string, number> = {};
  const piecePairSet = new Set<string>();
  const flagged = new Uint8Array(total);
  const u = [0, 0, 0];
  const v = [0, 0, 0];
  const tri2 = (i: number, out: number[]) => {
    for (let k = 0; k < 3; k++) {
      const x = P[i * 9 + k * 3], y = P[i * 9 + k * 3 + 1], z = P[i * 9 + k * 3 + 2];
      out[k * 2] = x * u[0] + y * u[1] + z * u[2];
      out[k * 2 + 1] = x * v[0] + y * v[1] + z * v[2];
    }
  };
  const ta = [0, 0, 0, 0, 0, 0];
  const tb = [0, 0, 0, 0, 0, 0];
  for (const [key, list0] of bins) {
    // Merge the neighbouring offset bin so planes straddling a bin edge are compared too.
    const [nk, dk] = key.split('|');
    const next = bins.get(`${nk}|${Number(dk) + 1}`) ?? [];
    const list = next.length ? list0.concat(next) : list0;
    if (list.length < 2) continue;
    // Plane basis from the bin normal.
    const n0 = nk.split(',').map((x) => Number(x) / 40);
    const nl = Math.hypot(n0[0], n0[1], n0[2]) || 1;
    const nn = [n0[0] / nl, n0[1] / nl, n0[2] / nl];
    const helper = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    u[0] = helper[1] * nn[2] - helper[2] * nn[1];
    u[1] = helper[2] * nn[0] - helper[0] * nn[2];
    u[2] = helper[0] * nn[1] - helper[1] * nn[0];
    const ul = Math.hypot(u[0], u[1], u[2]);
    u[0] /= ul;
    u[1] /= ul;
    u[2] /= ul;
    v[0] = nn[1] * u[2] - nn[2] * u[1];
    v[1] = nn[2] * u[0] - nn[0] * u[2];
    v[2] = nn[0] * u[1] - nn[1] * u[0];
    const G = 6;
    const grid = new Map<string, number[]>();
    const box = new Float32Array(list.length * 4);
    list.forEach((i, li) => {
      tri2(i, ta);
      const x0 = Math.min(ta[0], ta[2], ta[4]), x1 = Math.max(ta[0], ta[2], ta[4]);
      const y0 = Math.min(ta[1], ta[3], ta[5]), y1 = Math.max(ta[1], ta[3], ta[5]);
      box[li * 4] = x0;
      box[li * 4 + 1] = y0;
      box[li * 4 + 2] = x1;
      box[li * 4 + 3] = y1;
      for (let gx = Math.floor(x0 / G); gx <= Math.floor(x1 / G) && gx - Math.floor(x0 / G) < 40; gx++)
        for (let gy = Math.floor(y0 / G); gy <= Math.floor(y1 / G) && gy - Math.floor(y0 / G) < 40; gy++) {
          const gk = `${gx},${gy}`;
          let l = grid.get(gk);
          if (!l) grid.set(gk, (l = []));
          l.push(li);
        }
    });
    const done = new Set<number>();
    for (const cellList of grid.values()) {
      if (cellList.length < 2) continue;
      for (let a = 0; a < cellList.length; a++) {
        for (let b = a + 1; b < cellList.length; b++) {
          const la = cellList[a], lb = cellList[b];
          const pairId = la < lb ? la * list.length + lb : lb * list.length + la;
          if (done.has(pairId)) continue;
          done.add(pairId);
          if (box[la * 4] > box[lb * 4 + 2] || box[lb * 4] > box[la * 4 + 2] || box[la * 4 + 1] > box[lb * 4 + 3] || box[lb * 4 + 1] > box[la * 4 + 3]) continue;
          const i = list[la], j = list[lb];
          const dot = N[i * 4] * N[j * 4] + N[i * 4 + 1] * N[j * 4 + 1] + N[i * 4 + 2] * N[j * 4 + 2];
          if (Math.abs(dot) < 0.999) continue;
          // Distance of j's corners from i's plane.
          let dist = 0;
          for (let k = 0; k < 3; k++) dist = Math.max(dist, Math.abs(N[i * 4] * P[j * 9 + k * 3] + N[i * 4 + 1] * P[j * 9 + k * 3 + 1] + N[i * 4 + 2] * P[j * 9 + k * 3 + 2] - N[i * 4 + 3]));
          if (dist > DIST_FAR) continue;
          cop.pairsChecked++;
          tri2(i, ta);
          tri2(j, tb);
          const ov = overlapArea(ta, tb);
          const ratio = ov / Math.min(A[i], A[j]);
          if (ratio < 0.05 || ov < 0.005) {
            cop.intentionalEdge++;
            continue;
          }
          const pi = piece[i], pj = piece[j];
          const same = mat[i] === mat[j];
          let kind: FindingKind;
          if (dot < 0 && dist < DIST_COPLANAR) kind = 'backToBack';
          else if (dot > 0 && same && dist < 0.0005 && ratio > 0.9) kind = 'safeDuplicate';
          // Truly coplanar (< 1.5 mm) fights at any distance; 1.5 mm - 1 cm is a controlled layer
          // (resolved by the depth buffer up to ~100 m); 1-5 cm fights only far away.
          else if (dist < DIST_COPLANAR) kind = 'likelyZFight';
          else if (dist <= DIST_LIKELY) kind = 'layered';
          else kind = 'distanceZFight';
          cop[kind]++;
          if (opts.collectPairs) pairsOut.push({ i, j, kind, dist, ratio });
          (kindTris[kind] ??= new Set()).add(i).add(j);
          (kindPieces[kind] ??= new Set()).add(piece[i]).add(piece[j]);
          kindArea[kind] = (kindArea[kind] ?? 0) + ov;
          const wk = `${kind}:${where(i, j)}`;
          cop.byWhere[wk] = (cop.byWhere[wk] ?? 0) + 1;
          const ca = pieces[pi].category, cb = pieces[pj].category;
          const cpk = [ca, cb].sort().join('+');
          cop.byCategoryPair[`${kind}:${cpk}`] = (cop.byCategoryPair[`${kind}:${cpk}`] ?? 0) + 1;
          const mpk = [matNames[mat[i]], matNames[mat[j]]].sort().join(' + ');
          if (kind !== 'backToBack') cop.byMaterialPair[mpk] = (cop.byMaterialPair[mpk] ?? 0) + 1;
          if (pi === pj) cop.selfOverlaps++;
          piecePairSet.add(pi < pj ? `${pi}-${pj}` : `${pj}-${pi}`);
          // Overlay: the smaller (usually the detail layer) of the two.
          const small = A[i] < A[j] ? i : j;
          if (!flagged[small]) {
            flagged[small] = 1;
            addDebug(kind, P, small * 9);
          }
        }
      }
    }
  }
  cop.piecePairs = piecePairSet.size;
  for (const k of Object.keys(kindTris)) cop.summary[k] = { triangles: kindTris[k].size, areaM2: Math.round(kindArea[k]), pieces: kindPieces[k].size };
  log(`audit: coplanar pairs checked ${cop.pairsChecked}: duplicate ${cop.safeDuplicate}, coplanar z-fight ${cop.likelyZFight}, layered 1.5 mm-1 cm ${cop.layered}, at distance ${cop.distanceZFight}, back-to-back ${cop.backToBack}`);

  // --- 5. Intersecting placements (boxes) -------------------------------------------------------------------------------
  const solid = pieces.map((p, i) => ({ p, i })).filter(({ p }) => !p.baked && (p.category === 'building' || p.category === 'prop'));
  const ib = new Map<string, number[]>();
  solid.forEach(({ p }, k) => {
    for (let x = Math.floor(p.min[0] / 50); x <= Math.floor(p.max[0] / 50); x++)
      for (let z = Math.floor(p.min[2] / 50); z <= Math.floor(p.max[2] / 50); z++) {
        const key = `${x},${z}`;
        let l = ib.get(key);
        if (!l) ib.set(key, (l = []));
        l.push(k);
      }
  });
  const inter = { intentional: 0, containedDetail: 0, ambiguous: 0, examples: [] as string[] };
  const doneI = new Set<string>();
  const vol = (mn: number[], mx: number[]) => Math.max(0, mx[0] - mn[0]) * Math.max(0, mx[1] - mn[1]) * Math.max(0, mx[2] - mn[2]);
  for (const l of ib.values()) {
    for (let a = 0; a < l.length; a++) {
      for (let b = a + 1; b < l.length; b++) {
        const key = l[a] < l[b] ? `${l[a]}-${l[b]}` : `${l[b]}-${l[a]}`;
        if (doneI.has(key)) continue;
        doneI.add(key);
        const A1 = solid[l[a]].p;
        const B1 = solid[l[b]].p;
        const mn = [0, 1, 2].map((k) => Math.max(A1.min[k], B1.min[k]));
        const mx = [0, 1, 2].map((k) => Math.min(A1.max[k], B1.max[k]));
        const ov = vol(mn, mx);
        if (ov <= 0) continue;
        const va = vol(A1.min, A1.max);
        const vb = vol(B1.min, B1.max);
        const small = Math.min(va, vb);
        const frac = ov / Math.max(small, 1e-6);
        if (frac > 0.95 && small < 0.2 * Math.max(va, vb)) inter.containedDetail++;
        else if (frac < 0.25) inter.intentional++;
        else {
          inter.ambiguous++;
          if (inter.examples.length < 12) inter.examples.push(`${A1.name} × ${B1.name} (${(frac * 100).toFixed(0)}%)`);
          // Overlay: the shared box as two triangles on its top.
          const y = mx[1];
          addDebug('intersection', [mn[0], y, mn[2], mx[0], y, mn[2], mx[0], y, mx[2]]);
          addDebug('intersection', [mn[0], y, mn[2], mx[0], y, mx[2], mn[0], y, mx[2]]);
        }
      }
    }
  }
  log(`audit: intersecting placements: ambiguous ${inter.ambiguous}, intentional ${inter.intentional}, details inside others ${inter.containedDetail}`);

  return {
    report: {
      pieces: pieces.length,
      triangles: total,
      duplicatePlacements: { count: dupPlacements, triangles: dupPlacementTris },
      duplicateTriangles: { sameMaterial: dupSame, differentMaterial: dupDiff, where: dupWhere },
      coplanar: cop,
      intersections: inter,
      seams,
      seconds: (Date.now() - t0) / 1000,
    },
    debug,
    pairs: pairsOut,
    dups: dupsOut,
    pieceStart,
    pieceOf: piece,
    areas: A,
  };
}

/** Area of the intersection of two 2D triangles (convex clipping). */
function overlapArea(a: number[], b: number[]): number {
  let poly: number[][] = [
    [a[0], a[1]],
    [a[2], a[3]],
    [a[4], a[5]],
  ];
  // Clip edges of b, oriented counter-clockwise.
  const bp = [
    [b[0], b[1]],
    [b[2], b[3]],
    [b[4], b[5]],
  ];
  if ((bp[1][0] - bp[0][0]) * (bp[2][1] - bp[0][1]) - (bp[1][1] - bp[0][1]) * (bp[2][0] - bp[0][0]) < 0) bp.reverse();
  for (let e = 0; e < 3 && poly.length; e++) {
    const p1 = bp[e];
    const p2 = bp[(e + 1) % 3];
    const inside = (p: number[]) => (p2[0] - p1[0]) * (p[1] - p1[1]) - (p2[1] - p1[1]) * (p[0] - p1[0]) >= 0;
    const out: number[][] = [];
    for (let k = 0; k < poly.length; k++) {
      const cur = poly[k];
      const prev = poly[(k + poly.length - 1) % poly.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci !== pi) {
        const dx = cur[0] - prev[0];
        const dy = cur[1] - prev[1];
        const ex = p2[0] - p1[0];
        const ey = p2[1] - p1[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) > 1e-12) {
          const s = ((p1[0] - prev[0]) * ey - (p1[1] - prev[1]) * ex) / den;
          out.push([prev[0] + dx * s, prev[1] + dy * s]);
        }
      }
      if (ci) out.push(cur);
    }
    poly = out;
  }
  let area = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    area += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(area) / 2;
}
