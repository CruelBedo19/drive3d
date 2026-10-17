/*
 * Strip geometry, asphalt noise texture and dash texture adapted from
 * Nordschleife Racer by Yassin Soliman (MIT License,
 * https://github.com/yassinsolim/nordschleife-racer, see third_party/nordschleife-racer/LICENSE).
 */
import * as THREE from 'three';
import type { TrackFrames } from './TrackCurve';

/** Lateral offset (m, + = left of travel) at sample i. */
export type Offset = number | ((i: number) => number);

export interface StripOptions {
  /** Inner and outer lateral offsets; `b` must be left of `a`. */
  a: Offset;
  b: Offset;
  /** Height above the centre line at a and at b. */
  liftA?: number;
  liftB?: number;
  /** UV scale: u per metre across, v per metre along. */
  uScale?: number;
  vScale?: number;
}

const resolve = (o: Offset, i: number) => (typeof o === 'number' ? o : o(i));

/** Accumulates strips (ribbons following the centre line) into one BufferGeometry. */
export class StripBuilder {
  private readonly positions: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];
  private readonly frames: TrackFrames;

  constructor(frames: TrackFrames) {
    this.frames = frames;
  }

  get empty(): boolean {
    return this.indices.length === 0;
  }

  /**
   * Adds a strip over samples first..last (inclusive, may run past the lap end).
   * A strip covering the whole lap shares its first vertices at the seam, so a
   * physics trimesh made from it has no edge there.
   */
  add(first: number, last: number, o: StripOptions): void {
    const f = this.frames;
    const base = this.positions.length / 3;
    const closed = last - first === f.count;
    if (closed) last--;
    const uScale = o.uScale ?? 1;
    const vScale = o.vScale ?? 1;
    for (let k = first; k <= last; k++) {
      const i = k % f.count;
      const px = f.position[i * 3];
      const py = f.position[i * 3 + 1];
      const pz = f.position[i * 3 + 2];
      const lx = f.left[i * 3];
      const lz = f.left[i * 3 + 2];
      const a = resolve(o.a, i);
      const b = resolve(o.b, i);
      const v = k * f.step * vScale;
      this.positions.push(px + lx * a, py + (o.liftA ?? 0), pz + lz * a, px + lx * b, py + (o.liftB ?? o.liftA ?? 0), pz + lz * b);
      this.uvs.push(a * uScale, v, b * uScale, v);
    }
    const quads = closed ? last - first + 1 : last - first;
    const wrap = (v: number) => (closed && v >= base + f.count * 2 ? v - f.count * 2 : v);
    for (let k = 0; k < quads; k++) {
      const p = base + k * 2;
      // Counter-clockwise seen from above: normals point up.
      this.indices.push(p, wrap(p + 2), p + 1, p + 1, wrap(p + 2), wrap(p + 3));
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.indices);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }

  /** Raw arrays for a physics trimesh. */
  arrays(): { vertices: Float32Array; indices: Uint32Array } {
    return { vertices: new Float32Array(this.positions), indices: new Uint32Array(this.indices) };
  }
}

const hasDom = typeof document !== 'undefined';

function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture | null {
  if (!hasDom) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Deterministic PRNG (mulberry32): the same track looks the same every load. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speckled surface (asphalt, grass): base colour plus random grain and a few streaks. */
export function noiseTexture(base: [number, number, number], grain: number, seed: number, colorSrgb = true): THREE.Texture | null {
  const tex = canvasTexture(256, 256, (ctx) => {
    const rand = rng(seed);
    ctx.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 5400; i++) {
      const d = (rand() - 0.5) * 2 * grain;
      ctx.fillStyle = `rgb(${base[0] + d},${base[1] + d},${base[2] + d})`;
      ctx.fillRect(rand() * 256, rand() * 256, 1, 1);
    }
    ctx.globalAlpha = 0.14;
    ctx.strokeStyle = 'rgb(20,22,26)';
    for (let i = 0; i < 18; i++) {
      ctx.beginPath();
      ctx.moveTo(rand() * 256, rand() * 256);
      ctx.lineTo(rand() * 256, rand() * 256);
      ctx.stroke();
    }
  });
  if (tex && colorSrgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Alpha map for the dashed centre line: one dash per texture repeat along v. */
export function dashTexture(dashFraction: number): THREE.Texture | null {
  const tex = canvasTexture(4, 64, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 4, 64);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 4, Math.round(64 * dashFraction));
  });
  if (tex) tex.wrapS = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Red / white kerb stripes: one red and one white block per texture repeat along v. */
export function kerbTexture(): THREE.Texture | null {
  const tex = canvasTexture(2, 2, (ctx) => {
    ctx.fillStyle = '#c8211c';
    ctx.fillRect(0, 0, 2, 1);
    ctx.fillStyle = '#f2f2f2';
    ctx.fillRect(0, 1, 2, 1);
  });
  if (tex) {
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  return tex;
}

/** Material for markings drawn on top of a surface without z-fighting. */
export function decalMaterial(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, ...params });
}
