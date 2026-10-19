/**
 * Automatic, rule-based visual cleanup of the city geometry (run by
 * scripts/prepare-city.ts after the audit). Only the drawn geometry changes;
 * colliders are built from a snapshot of the original geometry.
 *
 * Per prototype (fixes every placement of it at once), from its own
 * coplanar / duplicate findings:
 *  - exact duplicate triangle, same material: dropped (the other one stays);
 *  - exact duplicate, different material, or a smaller face lying on a larger
 *    one within 1 cm, same facing: the smaller (detail) face is pushed 4 mm
 *    out along its normal (window on a wall, sign on a facade, decal on a floor);
 *  - back-to-back pair (both faces of a zero-thickness panel): dropped only when
 *    the two are the same material and cover each other completely (materials
 *    are double-sided, so one face draws both sides); otherwise the smaller is
 *    pushed 4 mm along its normal;
 *  - the downward-facing bottom of a building / prop at its very lowest level
 *    (it rests on the ground and is never seen) is dropped.
 * Displacements are per vertex (connected faces follow by a few mm), capped at 6 mm.
 */
import type { Mesh, Primitive } from '@gltf-transform/core';
import type { AuditResult } from './cityAnalysis';

export const DETAIL_OFFSET = 0.004;
const MAX_OFFSET = 0.006;

export interface ProtoTriangles {
  /** For each proto triangle: its primitive, and the position of its three indices in that primitive's index array. */
  prim: Primitive[];
  slot: number[];
}

/** Triangle order of a mesh as the audit sees it (primitive by primitive, index order). */
export function triangleMap(mesh: Mesh): ProtoTriangles {
  const prim: Primitive[] = [];
  const slot: number[] = [];
  for (const p of mesh.listPrimitives()) {
    const n = p.getIndices()!.getCount() / 3;
    for (let k = 0; k < n; k++) {
      prim.push(p);
      slot.push(k);
    }
  }
  return { prim, slot };
}

export interface CleanupStats {
  removedDuplicates: number;
  removedBackToBack: number;
  removedBottoms: number;
  offsetFaces: number;
}

/**
 * Applies a prototype's own findings. `audit` was run on one placement of the
 * prototype alone (world metres); `scale` = metres per local unit;
 * `down(triangle)` says whether a triangle is a bottom face at the lowest level.
 */
export function cleanPrototype(mesh: Mesh, audit: AuditResult, scale: number, isBottom: (t: number) => boolean, stats: CleanupStats, split = false): void {
  const map = triangleMap(mesh);
  const n = map.prim.length;
  const remove = new Uint8Array(n);
  const push = new Uint8Array(n);
  for (const [dup, , same] of audit.dups) {
    if (same) {
      remove[dup] = 1;
      stats.removedDuplicates++;
    } else push[dup] = 1;
  }
  const area = audit.areas;
  for (const p of audit.pairs) {
    if (remove[p.i] || remove[p.j]) continue;
    const small = area[p.i] < area[p.j] ? p.i : area[p.j] < area[p.i] ? p.j : Math.max(p.i, p.j);
    if (p.kind === 'safeDuplicate') {
      remove[small] = 1;
      stats.removedDuplicates++;
    } else if (p.kind === 'backToBack') {
      const sameMat = materialOf(map, p.i) === materialOf(map, p.j);
      const full = p.ratio > 0.95 && Math.min(area[p.i], area[p.j]) / Math.max(area[p.i], area[p.j]) > 0.95;
      if (sameMat && full) {
        remove[small] = 1;
        stats.removedBackToBack++;
      } else push[small] = 1;
    } else if (p.kind === 'likelyZFight') push[small] = 1;
  }
  for (let t = 0; t < n; t++) {
    if (!remove[t] && isBottom(t)) {
      remove[t] = 1;
      stats.removedBottoms++;
    }
  }
  // Second round (`split`): a pushed face gets its own corners first, so a neighbour sharing them
  // (an overlapping face of the same mesh) stays where it is.
  if (split) for (const prim of mesh.listPrimitives()) {
    const I = prim.getIndices()!.getArray()!;
    const extra: number[] = [];
    let next = prim.getAttribute('POSITION')!.getCount();
    const out = Uint32Array.from(I);
    for (let t = 0; t < n; t++) {
      if (map.prim[t] !== prim || !push[t] || remove[t]) continue;
      const s = map.slot[t] * 3;
      for (let c = 0; c < 3; c++) {
        extra.push(I[s + c]);
        out[s + c] = next++;
      }
    }
    if (!extra.length) continue;
    for (const sem of prim.listSemantics()) {
      const acc = prim.getAttribute(sem)!;
      const size = acc.getElementSize();
      const src = acc.getArray()!;
      const grown = new (src.constructor as Float32ArrayConstructor)(src.length + extra.length * size);
      grown.set(src);
      extra.forEach((v, k) => {
        for (let c = 0; c < size; c++) grown[src.length + k * size + c] = src[v * size + c];
      });
      acc.setArray(grown);
    }
    prim.getIndices()!.setArray(out);
  }
  // Per-primitive edit: displaced vertices (max along each pushed face normal), filtered indices.
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!;
    const idx = prim.getIndices()!;
    const P = Float32Array.from(pos.getArray() as ArrayLike<number>);
    const I = idx.getArray()!;
    const disp = new Float32Array(P.length);
    const keep: number[] = [];
    let changed = false;
    for (let t = 0; t < n; t++) {
      if (map.prim[t] !== prim) continue;
      const s = map.slot[t] * 3;
      const a = I[s], b = I[s + 1], c = I[s + 2];
      if (remove[t]) {
        changed = true;
        continue;
      }
      keep.push(a, b, c);
      if (!push[t]) continue;
      const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
      const wx = P[c * 3] - P[a * 3], wy = P[c * 3 + 1] - P[a * 3 + 1], wz = P[c * 3 + 2] - P[a * 3 + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz);
      if (l === 0) continue;
      const d = DETAIL_OFFSET / scale / l;
      nx *= d;
      ny *= d;
      nz *= d;
      for (const v of [a, b, c]) {
        disp[v * 3] += nx;
        disp[v * 3 + 1] += ny;
        disp[v * 3 + 2] += nz;
      }
      stats.offsetFaces++;
      changed = true;
    }
    if (!changed) continue;
    const cap = MAX_OFFSET / scale;
    for (let v = 0; v < disp.length; v += 3) {
      let dx = disp[v], dy = disp[v + 1], dz = disp[v + 2];
      const l = Math.hypot(dx, dy, dz);
      if (l === 0) continue;
      if (l > cap) {
        dx *= cap / l;
        dy *= cap / l;
        dz *= cap / l;
      }
      P[v] += dx;
      P[v + 1] += dy;
      P[v + 2] += dz;
    }
    pos.setArray(P);
    idx.setArray(new Uint32Array(keep));
  }
}

function materialOf(map: ProtoTriangles, t: number): string {
  return map.prim[t].getMaterial()?.getName() ?? '';
}

/** Pushes every vertex of a mesh along its normal (a small detail piece lying on another piece). */
export function offsetAlongNormals(mesh: Mesh, metres: number, scale: number): void {
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION')!;
    const nor = prim.getAttribute('NORMAL');
    if (!nor) continue;
    const P = Float32Array.from(pos.getArray() as ArrayLike<number>);
    const N = nor.getArray()!;
    const d = metres / scale;
    for (let i = 0; i < P.length; i++) P[i] += N[i] * d;
    pos.setArray(P);
  }
}
