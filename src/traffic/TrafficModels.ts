import * as THREE from 'three';
import { TRAFFIC_CLASSES, type TrafficClassId } from '../config/traffic';

/**
 * Low-poly traffic bodies built from boxes (a few hundred triangles each), one
 * merged geometry per class. Vertex colours mark what takes the instance's
 * paint (white) and what stays dark (glass, bumpers, chassis), so one
 * InstancedMesh draws every car of a class in its own colour. Local frame like
 * the player car: +Z forward, +X left, y up, origin on the ground at the centre.
 *
 * Lamps are separate geometries (pairs merged) so their colour can switch per
 * instance: headlights, tail / brake lights, left and right indicators.
 */

const PAINT: [number, number, number] = [1, 1, 1];
const GLASS: [number, number, number] = [0.07, 0.08, 0.1];
const BLACK: [number, number, number] = [0.06, 0.06, 0.07];
const GREY: [number, number, number] = [0.32, 0.33, 0.35];

/** Face order of THREE.BoxGeometry: +x, -x, +y, -y, +z, -z. */
type FaceColours = [number, number, number][];

class Builder {
  readonly geos: THREE.BufferGeometry[] = [];

  box(w: number, h: number, l: number, x: number, y: number, z: number, faces: FaceColours | [number, number, number]): this {
    const g = new THREE.BoxGeometry(w, h, l);
    g.translate(x, y + h / 2, z);
    const per = Array.isArray(faces[0]) ? (faces as FaceColours) : Array(6).fill(faces);
    const col = new Float32Array(24 * 3);
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) col.set(per[f], (f * 4 + v) * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geos.push(g.toNonIndexed());
    g.dispose();
    return this;
  }

  /** Sloped box (windscreen / cabin taper): top face shorter than the bottom, shifted along z. */
  cabin(w: number, h: number, lBottom: number, lTop: number, x: number, y: number, z: number, glass: [number, number, number], roof: [number, number, number]): this {
    const g = new THREE.BoxGeometry(w, h, lBottom);
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) if (p.getY(i) > 0) p.setZ(i, p.getZ(i) * (lTop / lBottom) - (lBottom - lTop) * 0.1);
    g.translate(x, y + h / 2, z);
    const col = new Float32Array(24 * 3);
    for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) col.set(f === 2 ? roof : glass, (f * 4 + v) * 3);
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    this.geos.push(g.toNonIndexed());
    g.dispose();
    return this;
  }

  merge(): THREE.BufferGeometry {
    const out = mergeNonIndexed(this.geos);
    for (const g of this.geos) g.dispose();
    out.computeVertexNormals();
    out.computeBoundingSphere();
    return out;
  }
}

function mergeNonIndexed(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array as Float32Array, o * 3);
    col.set(g.attributes.color.array as Float32Array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

/** Lamp positions (left side; mirrored for the right) per class: x, y, z, and lamp size. */
export interface LampLayout {
  head: [number, number, number];
  tail: [number, number, number];
  indFront: [number, number, number];
  indRear: [number, number, number];
  size: [number, number];
}

export interface TrafficModel {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  tail: THREE.BufferGeometry;
  indLeft: THREE.BufferGeometry;
  indRight: THREE.BufferGeometry;
  lamps: LampLayout;
}

function lampPair(points: [number, number, number][], w: number, h: number, forward: boolean): THREE.BufferGeometry {
  const b = new Builder();
  for (const [x, y, z] of points) b.box(w, h, 0.06, x, y - h / 2, z + (forward ? 0.02 : -0.02), PAINT);
  return b.merge();
}

/**
 * Built-in shape for a class: its own low-poly body for the procedural classes;
 * for classes drawn with a prepared model, the nearest shape stretched to the
 * model's size (used only if the model could not be loaded).
 */
export function buildTrafficModel(id: TrafficClassId): TrafficModel {
  const k = TRAFFIC_CLASSES[id];
  const shape = k.shape ?? (k.heavy ? 'truck' : k.height > 1.8 ? 'van' : 'car');
  const m = buildShape(shape);
  if (shape === id) return m;
  const base = TRAFFIC_CLASSES[shape];
  const sx = k.width / base.width;
  const sy = k.height / base.height;
  const sz = k.length / base.length;
  for (const g of [m.body, m.head, m.tail, m.indLeft, m.indRight]) g.scale(sx, sy, sz);
  const s = (p: [number, number, number]): [number, number, number] => [p[0] * sx, p[1] * sy, p[2] * sz];
  m.lamps = { head: s(m.lamps.head), tail: s(m.lamps.tail), indFront: s(m.lamps.indFront), indRear: s(m.lamps.indRear), size: m.lamps.size };
  return m;
}

/** Where a prepared model's lamps are (for the glows and lights): from its size. */
export function modelLamps(id: TrafficClassId): LampLayout {
  const k = TRAFFIC_CLASSES[id];
  const W = k.width;
  const L = k.length;
  const y = Math.min(1.05, k.height * 0.42);
  return { head: [W / 2 - 0.35, y, L / 2 - 0.08], tail: [W / 2 - 0.25, y + 0.05, -L / 2 + 0.06], indFront: [W / 2 - 0.12, y, L / 2 - 0.1], indRear: [W / 2 - 0.12, y - 0.08, -L / 2 + 0.06], size: [0.3, 0.12] };
}

function buildShape(id: 'car' | 'fastCar' | 'van' | 'truck'): TrafficModel {
  const c = TRAFFIC_CLASSES[id];
  const L = c.length;
  const W = c.width;
  const b = new Builder();
  let lamps: LampLayout;
  if (id === 'car' || id === 'fastCar') {
    const fast = id === 'fastCar';
    const bodyH = fast ? 0.62 : 0.72;
    const base = 0.2;
    b.box(W, bodyH, L, 0, base, 0, PAINT);
    // Greenhouse: dark glass all round, painted roof, set back a little.
    const cabH = c.height - base - bodyH;
    b.cabin(W * 0.84, cabH, L * (fast ? 0.46 : 0.52), L * (fast ? 0.3 : 0.38), 0, base + bodyH, fast ? -0.35 : -0.2, GLASS, PAINT);
    b.box(W * 1.01, 0.2, 0.18, 0, base, L / 2 - 0.05, BLACK); // front bumper
    b.box(W * 1.01, 0.22, 0.18, 0, base, -L / 2 + 0.05, BLACK); // rear bumper
    b.box(W * 0.96, 0.12, L * 0.92, 0, 0.12, 0, BLACK); // sills / underbody
    const ly = base + bodyH * 0.72;
    lamps = { head: [W / 2 - 0.32, ly, L / 2], tail: [W / 2 - 0.25, ly + 0.03, -L / 2], indFront: [W / 2 - 0.1, ly - 0.05, L / 2], indRear: [W / 2 - 0.08, ly - 0.12, -L / 2], size: [0.34, 0.11] };
  } else if (id === 'van') {
    const base = 0.3;
    const H = c.height - base;
    b.box(W, H * 0.62, L, 0, base, 0, PAINT);
    // Upper body: glass band at the front cab, paint behind.
    b.box(W, H * 0.38, L * 0.68, 0, base + H * 0.62, -L * 0.16, PAINT);
    b.cabin(W * 0.98, H * 0.38, L * 0.32, L * 0.24, 0, base + H * 0.62, L * 0.34, GLASS, PAINT);
    b.box(W * 1.01, 0.26, 0.16, 0, base - 0.05, L / 2 - 0.05, BLACK);
    b.box(W * 1.01, 0.26, 0.16, 0, base - 0.05, -L / 2 + 0.05, BLACK);
    b.box(W * 0.95, 0.2, L * 0.92, 0, 0.15, 0, BLACK);
    lamps = { head: [W / 2 - 0.3, base + 0.55, L / 2], tail: [W / 2 - 0.12, base + 0.75, -L / 2], indFront: [W / 2 - 0.08, base + 0.5, L / 2], indRear: [W / 2 - 0.12, base + 0.5, -L / 2], size: [0.3, 0.16] };
  } else {
    // Articulated truck drawn as one rigid body: cab at the front, box trailer behind.
    const cabL = 2.35;
    const cabZ = L / 2 - cabL / 2;
    b.box(W, 2.1, cabL, 0, 0.75, cabZ, PAINT);
    b.box(W * 0.98, 1.0, cabL * 0.9, 0, 2.85, cabZ - 0.05, [PAINT, PAINT, PAINT, PAINT, GLASS, PAINT]);
    b.box(W * 0.9, 0.9, 0.08, 0, 1.75, L / 2 + 0.01, GLASS); // windscreen
    b.box(W * 1.01, 0.45, 0.2, 0, 0.35, L / 2 - 0.08, GREY); // bumper
    const trailerL = L - cabL - 0.35;
    const trailerZ = -L / 2 + trailerL / 2;
    b.box(c.width, c.height - 1.15, trailerL, 0, 1.15, trailerZ, [PAINT, PAINT, PAINT, GREY, GREY, GREY]);
    b.box(W * 0.7, 0.35, L * 0.94, 0, 0.6, 0, BLACK); // chassis rails
    b.box(W * 0.98, 0.22, 0.12, 0, 0.55, -L / 2 + 0.04, GREY); // under-ride guard
    lamps = { head: [W / 2 - 0.35, 0.75, L / 2], tail: [W / 2 - 0.2, 0.9, -L / 2], indFront: [W / 2 - 0.08, 0.95, L / 2], indRear: [W / 2 - 0.35, 0.9, -L / 2], size: [0.3, 0.14] };
  }
  const [sw, sh] = lamps.size;
  const mirror = (p: [number, number, number]): [number, number, number][] => [p, [-p[0], p[1], p[2]]];
  return {
    body: b.merge(),
    head: lampPair(mirror(lamps.head), sw, sh, true),
    tail: lampPair(mirror(lamps.tail), sw, sh, false),
    indLeft: lampPair([lamps.indFront, lamps.indRear], 0.12, 0.08, true),
    indRight: lampPair([[-lamps.indFront[0], lamps.indFront[1], lamps.indFront[2]], [-lamps.indRear[0], lamps.indRear[1], lamps.indRear[2]]], 0.12, 0.08, true),
    lamps,
  };
}
