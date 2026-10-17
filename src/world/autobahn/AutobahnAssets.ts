import * as THREE from 'three';
import { decalMaterial, kerbTexture, noiseTexture, dashTexture } from '../nordschleife/TrackMeshes';
import { AUTOBAHN as A } from '../../config/tracks';

const hasDom = typeof document !== 'undefined';

export type SignStyle = 'blue' | 'speed' | 'gore';

/**
 * Materials, shared geometries and sign textures used by every Autobahn chunk:
 * created once per track (never per chunk or per frame) and disposed with it.
 */
export class AutobahnAssets {
  readonly asphalt: THREE.MeshStandardMaterial;
  readonly shoulder: THREE.MeshStandardMaterial;
  readonly gravel: THREE.MeshStandardMaterial;
  readonly marking: THREE.MeshStandardMaterial;
  readonly dashed: THREE.MeshStandardMaterial;
  readonly concrete: THREE.MeshStandardMaterial;
  readonly tunnel: THREE.MeshStandardMaterial;
  readonly metal: THREE.MeshStandardMaterial;
  readonly terrain: THREE.MeshStandardMaterial;
  readonly trunk: THREE.MeshStandardMaterial;
  readonly conifer: THREE.MeshStandardMaterial;
  readonly broadleaf: THREE.MeshStandardMaterial;
  readonly shrub: THREE.MeshStandardMaterial;
  /** Landscape tiles: the terrain look, pushed behind the chunk ribbons where both overlap. */
  readonly terrainFar: THREE.MeshStandardMaterial;
  /** Simplified distant tree (crown only). */
  readonly farTree: THREE.MeshStandardMaterial;
  readonly farTreeGeo: THREE.ConeGeometry;
  readonly post: THREE.MeshStandardMaterial;
  readonly reflector: THREE.MeshStandardMaterial;
  readonly lamp: THREE.MeshStandardMaterial;
  readonly phone: THREE.MeshStandardMaterial;
  readonly building: THREE.MeshStandardMaterial;
  readonly roof: THREE.MeshStandardMaterial;
  readonly chevron: THREE.MeshStandardMaterial;
  readonly noiseWall: THREE.MeshStandardMaterial;
  readonly box = new THREE.BoxGeometry(1, 1, 1);
  readonly cone: THREE.ConeGeometry;
  readonly sphere: THREE.IcosahedronGeometry;
  readonly cylinder: THREE.CylinderGeometry;
  /** Materials whose look follows road wetness, with their dry values. */
  readonly wettable: { material: THREE.MeshStandardMaterial; roughness: number; color: THREE.Color }[] = [];
  private readonly signs = new Map<string, THREE.MeshStandardMaterial>();
  private readonly owned: { dispose(): void }[] = [];

  constructor() {
    const own = <T extends { dispose(): void }>(r: T): T => {
      this.owned.push(r);
      return r;
    };
    const tex = (t: THREE.Texture | null) => (t ? own(t) : null);
    this.asphalt = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0.02, map: tex(noiseTexture([52, 54, 58], 20, 11)) }));
    this.shoulder = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02, map: tex(noiseTexture([66, 67, 70], 22, 12)) }));
    this.gravel = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, map: tex(noiseTexture([92, 88, 80], 30, 13)) }));
    this.marking = own(decalMaterial({ color: 0xf2f2f2, roughness: 0.55 }));
    this.dashed = own(decalMaterial({ color: 0xf2f2f2, roughness: 0.55, alphaMap: tex(dashTexture(A.markings.dash / (A.markings.dash + A.markings.gap))), alphaTest: 0.5 }));
    this.concrete = own(new THREE.MeshStandardMaterial({ color: 0xb9b6ae, roughness: 0.85 }));
    this.tunnel = own(new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.8, side: THREE.DoubleSide }));
    this.metal = own(new THREE.MeshStandardMaterial({ color: 0xc0c5cc, roughness: 0.4, metalness: 0.7 }));
    this.terrain = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, vertexColors: true, map: tex(noiseTexture([200, 200, 200], 40, 14, false)) }));
    this.trunk = own(new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 }));
    this.conifer = own(new THREE.MeshStandardMaterial({ color: 0x23412a, roughness: 0.95 }));
    this.broadleaf = own(new THREE.MeshStandardMaterial({ color: 0x3d6a2e, roughness: 0.95 }));
    this.shrub = own(new THREE.MeshStandardMaterial({ color: 0x3a5a26, roughness: 1 }));
    this.terrainFar = own(this.terrain.clone());
    this.terrainFar.polygonOffset = true;
    this.terrainFar.polygonOffsetFactor = 2;
    this.terrainFar.polygonOffsetUnits = 4;
    this.farTree = own(new THREE.MeshStandardMaterial({ color: 0x2a4527, roughness: 1 }));
    this.farTreeGeo = own(new THREE.ConeGeometry(1, 1, 5));
    this.farTreeGeo.translate(0, 0.5, 0);
    this.post = own(new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.6 }));
    // Retro-reflectors: faint glow so they read at night (the headlights do the rest).
    this.reflector = own(new THREE.MeshStandardMaterial({ color: 0xffa230, emissive: 0xff8a10, emissiveIntensity: 0.9, roughness: 0.3 }));
    this.lamp = own(new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xffe2a8, emissiveIntensity: 2.2 }));
    this.phone = own(new THREE.MeshStandardMaterial({ color: 0xe8701a, roughness: 0.6 }));
    this.building = own(new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.85 }));
    this.roof = own(new THREE.MeshStandardMaterial({ color: 0x2b5d9a, roughness: 0.5, metalness: 0.3 }));
    this.chevron = own(new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, map: tex(kerbTexture()) }));
    this.noiseWall = own(new THREE.MeshStandardMaterial({ color: 0x7a8c78, roughness: 0.9 }));
    own(this.box);
    this.cone = own(new THREE.ConeGeometry(1, 1, 7));
    this.cone.translate(0, 0.5, 0);
    this.sphere = own(new THREE.IcosahedronGeometry(1, 1));
    this.cylinder = own(new THREE.CylinderGeometry(0.5, 0.5, 1, 8));
    this.cylinder.translate(0, 0.5, 0);
    for (const m of [this.asphalt, this.shoulder, this.marking, this.dashed]) this.wettable.push({ material: m, roughness: m.roughness, color: m.color.clone() });
  }

  /** Sign face material (canvas text, cached per text; plain colour without a DOM). */
  sign(style: SignStyle, lines: string[], value?: number): THREE.MeshStandardMaterial {
    const key = `${style}|${lines.join('|')}|${value ?? ''}`;
    const cached = this.signs.get(key);
    if (cached) return cached;
    const map = hasDom ? signTexture(style, lines) : null;
    const base = style === 'speed' ? 0xffffff : 0x1d4ea0;
    const m = new THREE.MeshStandardMaterial({ color: map ? 0xffffff : base, map, roughness: 0.5, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: map ? 0.12 : 0 });
    if (map) this.owned.push(map);
    this.owned.push(m);
    this.signs.set(key, m);
    return m;
  }

  dispose(): void {
    for (const o of this.owned) o.dispose();
    this.signs.clear();
  }
}

/** German-style sign face: blue panel with white border and text, or a round speed-limit disc. */
function signTexture(style: SignStyle, lines: string[]): THREE.Texture | null {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = style === 'speed' ? 512 : 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const w = canvas.width;
  const h = canvas.height;
  if (style === 'speed') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.47, 0, Math.PI * 2);
    ctx.fillStyle = '#d42b2b';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, w * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.fillStyle = '#111111';
    ctx.font = `bold ${Math.round(w * 0.3)}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(lines[0], w / 2, h / 2 + w * 0.02);
  } else {
    ctx.fillStyle = '#1d4ea0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 10;
    ctx.strokeRect(12, 12, w - 24, h - 24);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const n = lines.length;
    lines.forEach((line, i) => {
      const size = style === 'gore' ? 70 : i === 0 && /^\d+$/.test(line) ? 54 : 46;
      ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
      ctx.fillText(line, w / 2, h * ((i + 1) / (n + 1)));
    });
    if (style === 'gore') {
      // Arrow pointing up-right: the exit leaves to the right.
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(w * 0.78, h * 0.78);
      ctx.lineTo(w * 0.9, h * 0.38);
      ctx.moveTo(w * 0.8, h * 0.42);
      ctx.lineTo(w * 0.9, h * 0.38);
      ctx.lineTo(w * 0.93, h * 0.5);
      ctx.stroke();
    }
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
