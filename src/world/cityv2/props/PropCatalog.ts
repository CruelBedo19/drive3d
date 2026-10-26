import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PROPS, SIGNAL_HEADS, SIGNAL_LAMPS, type PropKitPiece } from '../propKit';

const hasDom = typeof document !== 'undefined';

/** One drawn part of a prototype: geometry + material (each part is one InstancedMesh). */
export interface PropPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  shadow: boolean;
  tris: number;
}

export interface PropModel {
  near: PropPart[];
  /** Cheaper level beyond PropDef.mid (trees, lamps); null: `near` at every distance. */
  mid: PropPart[] | null;
  /** Colours by instance variant (trees, bushes, containers); null: none. */
  palette: THREE.Color[] | null;
}

type MatKey =
  | 'metal'
  | 'metalLight'
  | 'iron'
  | 'concrete'
  | 'soil'
  | 'bark'
  | 'leaf'
  | 'lamp'
  | 'pool'
  | 'lens'
  | 'sign'
  | 'wood'
  | 'binGreen'
  | 'red'
  | 'utility'
  | 'glass'
  | 'fence'
  | 'container'
  | 'markWhite'
  | 'markYellow'
  | 'path'
  | 'grass'
  | 'pit';

/** Sign atlas tiles (4 × 2 of 256 px): stop, yield, 30, parking, crossing, bus stop. */
const SIGN_TILE = { stop: 0, yield: 1, speed30: 2, parking: 3, crossing: 4, bus: 5 } as const;

/**
 * The street props' meshes: the kit's own props (geometry from the data file)
 * and the rest built here from primitives in the kit's low-poly, flat-shaded
 * look. Built once per loaded city; all prototypes share about twenty
 * materials. Works without a DOM (tests): sign faces, the fence mesh and the
 * container ribs are canvas textures only in a browser, plain colours otherwise.
 *
 * Lamp heads use one emissive material whose strength follows the night
 * (setNight); signal lenses are dark here, the lit lamps are drawn by
 * CityV2Props on top of them.
 */
export class PropCatalog {
  readonly models: PropModel[];
  readonly materials = new Map<MatKey, THREE.Material>();
  private readonly textures: THREE.Texture[] = [];
  private readonly geometries = new Set<THREE.BufferGeometry>();

  constructor(kit: PropKitPiece[], f32: Float32Array, u32: Uint32Array) {
    this.createMaterials();
    const kitGeo = new Map<string, { geometry: THREE.BufferGeometry; mat: string }[]>();
    for (const piece of kit) {
      kitGeo.set(
        piece.name,
        piece.prims.map((p) => {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(f32.slice(p.pos[0], p.pos[0] + p.pos[1] * 3), 3));
          g.setAttribute('normal', new THREE.BufferAttribute(f32.slice(p.nor[0], p.nor[0] + p.nor[1] * 3), 3));
          g.setIndex(new THREE.BufferAttribute(u32.slice(p.idx[0], p.idx[0] + p.idx[1]), 1));
          return { geometry: g, mat: p.mat };
        }),
      );
    }
    this.models = PROPS.map((def) => this.build(def.id, def.kit ? kitGeo.get(def.kit) ?? [] : []));
    for (const m of this.models) {
      for (const p of [...m.near, ...(m.mid ?? [])]) this.geometries.add(p.geometry);
    }
    for (const list of kitGeo.values()) for (const k of list) if (!this.geometries.has(k.geometry)) k.geometry.dispose();
  }

  /** Lamp heads: dim by day, bright at night (0..1); the light pools under them show from dusk on. */
  setNight(night: number): void {
    const m = this.materials.get('lamp') as THREE.MeshStandardMaterial;
    m.emissiveIntensity = 0.25 + 2.6 * night;
    const pool = this.materials.get('pool') as THREE.MeshBasicMaterial;
    pool.visible = night > 0.05;
    pool.color.setRGB(0.42 * night, 0.35 * night, 0.22 * night);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials.values()) m.dispose();
    for (const t of this.textures) t.dispose();
  }

  // --- materials -----------------------------------------------------------------------------------

  private createMaterials(): void {
    const std = (key: MatKey, p: THREE.MeshStandardMaterialParameters) => this.materials.set(key, new THREE.MeshStandardMaterial({ name: `cv2_prop_${key}`, ...p }));
    const decal = (key: MatKey, color: number, roughness: number) =>
      std(key, { color, roughness, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    std('metal', { color: 0x5b6168, roughness: 0.5, metalness: 0.6 });
    std('metalLight', { color: 0x9aa0a6, roughness: 0.45, metalness: 0.6 });
    std('iron', { color: 0x2c2f33, roughness: 0.6, metalness: 0.4 });
    std('concrete', { color: 0xb3afa6, roughness: 0.92 });
    std('soil', { color: 0x3a2b1f, roughness: 1 });
    std('bark', { color: 0x75604c, roughness: 1 });
    std('leaf', { color: 0xffffff, roughness: 0.9, vertexColors: true });
    std('lamp', { color: 0xfff4dc, emissive: 0xffdca0, emissiveIntensity: 0.25, roughness: 0.4 });
    // Light pool on the ground under a lamp: radial vertex colours, added to what is there (no real light per lamp).
    this.materials.set('pool', new THREE.MeshBasicMaterial({ name: 'cv2_prop_pool', color: 0x000000, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6, visible: false }));
    std('lens', { color: 0x15171a, roughness: 0.25 });
    std('wood', { color: 0x8a5a35, roughness: 0.8 });
    std('binGreen', { color: 0x2f4f3a, roughness: 0.6, metalness: 0.2 });
    std('red', { color: 0xb3221b, roughness: 0.5 });
    std('utility', { color: 0x7b877e, roughness: 0.7, metalness: 0.2 });
    std('glass', { color: 0xbcd4de, roughness: 0.1, transparent: true, opacity: 0.32, depthWrite: false });
    decal('markWhite', 0xd6d6cf, 0.6);
    decal('markYellow', 0xcf8f12, 0.6);
    decal('path', 0xa59c8a, 1);
    decal('grass', 0x4c6633, 1);
    decal('pit', 0x2c251e, 1);
    const sign = hasDom ? signAtlas() : null;
    const fence = hasDom ? fenceTexture() : null;
    const ribs = hasDom ? ribTexture() : null;
    for (const t of [sign, fence, ribs]) if (t) this.textures.push(t);
    std('sign', { color: sign ? 0xffffff : 0xc8c8c8, map: sign, roughness: 0.5, emissive: 0xffffff, emissiveMap: sign, emissiveIntensity: sign ? 0.08 : 0 });
    std('fence', fence ? { color: 0xa4aab0, roughness: 0.5, metalness: 0.5, alphaMap: fence, alphaTest: 0.5, side: THREE.DoubleSide } : { color: 0xa4aab0, roughness: 0.5, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    std('container', { color: 0xffffff, map: ribs, roughness: 0.7, metalness: 0.3 });
  }

  private mat(key: MatKey): THREE.Material {
    return this.materials.get(key)!;
  }

  private part(geometry: THREE.BufferGeometry, key: MatKey, shadow: boolean): PropPart {
    return { geometry, material: this.mat(key), shadow, tris: (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3 };
  }

  // --- prototypes ----------------------------------------------------------------------------------

  private build(id: string, kit: { geometry: THREE.BufferGeometry; mat: string }[]): PropModel {
    const greens = [0x587a3c, 0x4a6b35, 0x637f41, 0x6e8446].map((c) => new THREE.Color(c));
    const leafPalette = greens;
    const kitParts = (shadow: boolean) => kit.map((k) => this.part(k.geometry, (k.mat === 'soil' ? 'soil' : k.mat === 'metal' ? 'metal' : k.mat === 'iron' ? 'iron' : 'concrete') as MatKey, shadow));
    switch (id) {
      case 'tree_small':
        return this.tree(2.2, 0.1, [[0, 3.1, 0, 1.25], [0.55, 2.8, 0.3, 0.95], [-0.45, 3.0, -0.35, 1.0]], leafPalette, 1);
      case 'tree_medium':
        return this.tree(3, 0.16, [[0, 4.7, 0, 1.8], [0.9, 4.1, 0.4, 1.35], [-0.8, 4.3, -0.5, 1.45], [0.2, 5.6, -0.3, 1.2]], leafPalette, 2);
      case 'tree_large':
        return this.tree(3.8, 0.26, [[0, 6.8, 0, 2.5], [1.5, 6, 0.6, 1.9], [-1.4, 6.2, -0.7, 2], [0.4, 8, -0.4, 1.7], [-0.5, 5.4, 1.3, 1.6]], leafPalette, 3);
      case 'tree_conifer': {
        const trunk = cyl(0.13, 0.18, 1.6, 6, 0, 0, 0);
        const crown = merge([cone(2, 3.2, 8, 0, 1.2, 0), cone(1.55, 2.8, 8, 0, 3, 0), cone(1.05, 2.4, 7, 0, 4.7, 0)]);
        tintBottom(crown, 0, 7.5);
        const mid = cone(1.8, 6.4, 6, 0, 1.2, 0);
        tintBottom(mid, 0, 7.5);
        return { near: [this.part(trunk, 'bark', true), this.part(crown, 'leaf', true)], mid: [this.part(cyl(0.13, 0.18, 1.6, 4, 0, 0, 0), 'bark', true), this.part(mid, 'leaf', true)], palette: [0x2f5428, 0x2a4a26, 0x36602e, 0x3a5a2a].map((c) => new THREE.Color(c)) };
      }
      case 'bush': {
        const g = blobs([[0, 0.45, 0, 0.6], [0.45, 0.35, 0.2, 0.45], [-0.4, 0.38, -0.2, 0.5]], 1, 5);
        tintBottom(g, 0, 1.1);
        return { near: [this.part(g, 'leaf', false)], mid: null, palette: [0x4f6f34, 0x45632f, 0x5a773b, 0x617a3a].map((c) => new THREE.Color(c)) };
      }
      case 'grass_patch':
        return { near: [this.part(flat(new THREE.CircleGeometry(0.5, 12)), 'grass', false)], mid: null, palette: null };
      case 'tree_pit':
        return { near: [this.part(flat(new THREE.PlaneGeometry(1.3, 1.3)), 'pit', false)], mid: null, palette: null };
      case 'verge':
      case 'path':
        return { near: [this.part(flat(new THREE.PlaneGeometry(1, 1)), id === 'verge' ? 'grass' : 'path', false)], mid: null, palette: null };
      case 'lamp_arterial':
        return this.armLamp(10, 2.6, 0.13);
      case 'lamp_street':
        return this.armLamp(8, 1.9, 0.11);
      case 'lamp_median': {
        const pole = merge([cyl(0.2, 0.22, 0.5, 8, 0, 0, 0), cyl(0.1, 0.15, 10, 8, 0, 0, 0), box(4.6, 0.09, 0.09, 0, 9.9, 0)]);
        const heads = merge([box(0.95, 0.13, 0.36, 2.3, 9.86, 0), box(0.95, 0.13, 0.36, -2.3, 9.86, 0)]);
        const glow = merge([box(0.78, 0.06, 0.28, 2.3, 9.77, 0), box(0.78, 0.06, 0.28, -2.3, 9.77, 0)]);
        const light = this.part(merge([pool(8.5, 3.2, 0), pool(8.5, -3.2, 0)]), 'pool', false);
        return { near: [this.part(pole, 'metal', true), this.part(heads, 'iron', true), this.part(glow, 'lamp', false), light], mid: [this.part(merge([cyl(0.1, 0.15, 10, 4, 0, 0, 0), box(4.6, 0.09, 0.09, 0, 9.9, 0)]), 'metal', true), this.part(glow, 'lamp', false), light], palette: null };
      }
      case 'lamp_residential': {
        const pole = merge([cyl(0.12, 0.14, 0.4, 8, 0, 0, 0), cyl(0.06, 0.08, 5.4, 6, 0, 0, 0), cone(0.32, 0.25, 6, 0, 5.95, 0)]);
        const glow = cyl(0.2, 0.15, 0.5, 6, 0, 5.45, 0);
        const light = this.part(pool(6, 0, 0), 'pool', false);
        return { near: [this.part(pole, 'iron', true), this.part(glow, 'lamp', false), light], mid: [this.part(cyl(0.06, 0.08, 5.6, 4, 0, 0, 0), 'iron', true), this.part(glow, 'lamp', false), light], palette: null };
      }
      case 'lamp_park': {
        const pole = merge([cyl(0.1, 0.12, 0.3, 8, 0, 0, 0), cyl(0.05, 0.06, 3.3, 6, 0, 0, 0), cone(0.18, 0.12, 6, 0, 3.75, 0)]);
        const globe = new THREE.IcosahedronGeometry(0.22, 1).translate(0, 3.55, 0);
        return { near: [this.part(pole, 'iron', false), this.part(globe, 'lamp', false), this.part(pool(4, 0, 0), 'pool', false)], mid: null, palette: null };
      }
      case 'lamp_flood': {
        const pole = merge([cyl(0.22, 0.24, 0.5, 8, 0, 0, 0), cyl(0.12, 0.18, 12, 8, 0, 0, 0), box(1.8, 0.1, 0.1, 0, 11.8, 0.15)]);
        // Two floodlights on a cross bar, tilted down towards +z.
        const heads = merge([tilted(box(0.6, 0.4, 0.16, 0, 0, 0), 0.55, -0.6, 11.6, 0.35), tilted(box(0.6, 0.4, 0.16, 0, 0, 0), 0.55, 0.6, 11.6, 0.35)]);
        const glow = merge([tilted(box(0.5, 0.32, 0.02, 0, 0, 0.09), 0.55, -0.6, 11.6, 0.35), tilted(box(0.5, 0.32, 0.02, 0, 0, 0.09), 0.55, 0.6, 11.6, 0.35)]);
        const light = this.part(pool(11, 0, 6), 'pool', false);
        return { near: [this.part(pole, 'metal', true), this.part(heads, 'iron', true), this.part(glow, 'lamp', false), light], mid: [this.part(cyl(0.12, 0.18, 12, 4, 0, 0, 0), 'metal', true), this.part(glow, 'lamp', false), light], palette: null };
      }
      case 'signal_pole':
      case 'signal_mast':
      case 'signal_mast_long':
        return this.signal(id);
      case 'sign_stop':
        return this.sign(octagon(0.4), SIGN_TILE.stop);
      case 'sign_yield':
        return this.sign(triangle(0.9), SIGN_TILE.yield);
      case 'sign_speed30':
        return this.sign(new THREE.CircleGeometry(0.34, 20), SIGN_TILE.speed30);
      case 'sign_parking':
        return this.sign(new THREE.PlaneGeometry(0.62, 0.62), SIGN_TILE.parking);
      case 'sign_crossing':
        return this.sign(new THREE.PlaneGeometry(0.62, 0.62), SIGN_TILE.crossing);
      case 'bench': {
        const slats = merge([box(1.7, 0.045, 0.12, 0, 0.45, 0.13), box(1.7, 0.045, 0.12, 0, 0.45, -0.02), box(1.7, 0.045, 0.12, 0, 0.45, -0.17), tilted(box(1.7, 0.12, 0.04, 0, 0, 0), -0.25, 0, 0.66, -0.25), tilted(box(1.7, 0.12, 0.04, 0, 0, 0), -0.25, 0, 0.82, -0.29)]);
        const legs = merge([box(0.06, 0.45, 0.5, -0.7, 0.225, -0.02), box(0.06, 0.45, 0.5, 0.7, 0.225, -0.02), box(0.06, 0.45, 0.06, -0.7, 0.67, -0.27), box(0.06, 0.45, 0.06, 0.7, 0.67, -0.27)]);
        return { near: [this.part(slats, 'wood', false), this.part(legs, 'iron', false)], mid: null, palette: null };
      }
      case 'bin': {
        const body = merge([cyl(0.24, 0.22, 0.85, 10, 0, 0, 0), cyl(0.27, 0.27, 0.06, 10, 0, 0.85, 0)]);
        return { near: [this.part(body, 'binGreen', false)], mid: null, palette: null };
      }
      case 'hydrant': {
        const body = merge([cyl(0.15, 0.17, 0.08, 8, 0, 0, 0), cyl(0.11, 0.11, 0.55, 8, 0, 0.08, 0), cone(0.13, 0.16, 8, 0, 0.63, 0), box(0.36, 0.08, 0.08, 0, 0.42, 0), box(0.08, 0.08, 0.2, 0, 0.42, 0.1)]);
        return { near: [this.part(body, 'red', false)], mid: null, palette: null };
      }
      case 'utility_box': {
        const body = merge([box(1, 1.25, 0.5, 0, 0.625, 0), box(1.06, 0.06, 0.56, 0, 1.28, 0), box(0.02, 1.0, 0.01, 0, 0.62, 0.255)]);
        return { near: [this.part(body, 'utility', false)], mid: null, palette: null };
      }
      case 'bus_shelter': {
        const frame = merge([box(4.1, 0.1, 1.6, 0, 2.5, 0), box(0.08, 2.5, 0.08, -1.95, 1.25, -0.7), box(0.08, 2.5, 0.08, 1.95, 1.25, -0.7), box(0.08, 2.5, 0.08, -1.95, 1.25, 0.55), box(0.08, 2.5, 0.08, 1.95, 1.25, 0.55), box(1.8, 0.05, 0.4, 0, 0.48, -0.45), box(0.05, 2.6, 0.05, 2.45, 1.3, 0.55)]);
        const glass = merge([box(3.8, 2.0, 0.02, 0, 1.3, -0.72), box(0.02, 2.0, 1.1, -1.95, 1.3, -0.15), box(0.02, 2.0, 1.1, 1.95, 1.3, -0.15)]);
        const plate = new THREE.PlaneGeometry(0.5, 0.5).translate(0, 0, 0.03);
        tileUv(plate, SIGN_TILE.bus);
        const sign = merge([plate.translate(2.45, 2.35, 0.55)]);
        return { near: [this.part(frame, 'iron', true), this.part(glass, 'glass', false), this.part(sign, 'sign', false)], mid: null, palette: null };
      }
      case 'bike_rack': {
        const loops = merge([-0.9, -0.3, 0.3, 0.9].map((x) => new THREE.TorusGeometry(0.36, 0.025, 5, 10, Math.PI).rotateY(Math.PI / 2).translate(x, 0.5, 0)));
        const legs = merge([-0.9, -0.3, 0.3, 0.9].flatMap((x) => [cyl(0.025, 0.025, 0.5, 5, x, 0, 0.36), cyl(0.025, 0.025, 0.5, 5, x, 0, -0.36)]));
        return { near: [this.part(merge([loops, legs]), 'metalLight', false)], mid: null, palette: null };
      }
      case 'barrier': {
        const s = new THREE.Shape();
        s.moveTo(-0.3, 0);
        s.lineTo(0.3, 0);
        s.lineTo(0.3, 0.08);
        s.lineTo(0.12, 0.3);
        s.lineTo(0.08, 0.8);
        s.lineTo(-0.08, 0.8);
        s.lineTo(-0.12, 0.3);
        s.lineTo(-0.3, 0.08);
        const g = new THREE.ExtrudeGeometry(s, { depth: 2, bevelEnabled: false }).translate(0, 0, -1).rotateY(Math.PI / 2);
        return { near: [this.part(clean(g), 'concrete', false)], mid: null, palette: null };
      }
      case 'fence': {
        const posts = merge([-3, 0, 3].map((x) => cyl(0.035, 0.035, 2, 5, x, 0, 0)).concat([box(6, 0.04, 0.04, 0, 1.98, 0), box(6, 0.04, 0.04, 0, 0.08, 0)]));
        const mesh = new THREE.PlaneGeometry(6, 1.86).translate(0, 1.03, 0);
        // 25 cm diamonds.
        mesh.setAttribute('uv', new THREE.Float32BufferAttribute([0, 7.5, 24, 7.5, 0, 0, 24, 0], 2));
        return { near: [this.part(posts, 'metalLight', false), this.part(mesh, 'fence', false)], mid: null, palette: null };
      }
      case 'container': {
        // ISO 20 ft box, long side along z; the rib texture repeats across every face.
        const body = box(2.44, 2.59, 6.06, 0, 1.295, 0);
        return { near: [this.part(body, 'container', true)], mid: null, palette: [0x9c3b2c, 0x2f5a8a, 0x3f7a4a, 0xb08a2e, 0x6b6f74, 0x8a4f2a].map((c) => new THREE.Color(c)) };
      }
      case 'stall_row': {
        const lines = merge([0, 1, 2, 3, 4, 5].map((k) => flat(new THREE.PlaneGeometry(0.12, 5)).translate(-6.25 + 2.5 * k, 0, 2.5)));
        return { near: [this.part(lines, 'markWhite', false)], mid: null, palette: null };
      }
      case 'hatch': {
        // Loading zone: yellow border and bars (unit square, scaled to the zone).
        const bars = [flat(new THREE.PlaneGeometry(1, 0.03)).translate(0, 0, -0.485), flat(new THREE.PlaneGeometry(1, 0.03)).translate(0, 0, 0.485), flat(new THREE.PlaneGeometry(0.02, 1)).translate(-0.49, 0, 0), flat(new THREE.PlaneGeometry(0.02, 1)).translate(0.49, 0, 0)];
        for (let k = -3; k <= 3; k++) bars.push(flat(new THREE.PlaneGeometry(0.96, 0.05)).translate(0, 0, k * 0.13));
        return { near: [this.part(merge(bars), 'markYellow', false)], mid: null, palette: null };
      }
      case 'bollard':
      case 'manhole':
      case 'drain':
        return { near: kitParts(false), mid: null, palette: null };
      case 'planter':
      case 'planter_long': {
        const top = id === 'planter' ? 0.58 : 0.5;
        const shrubs = blobs(id === 'planter' ? [[0, top + 0.3, 0, 0.55], [0.45, top + 0.2, 0.35, 0.4], [-0.4, top + 0.22, -0.3, 0.42], [0.35, top + 0.2, -0.4, 0.35]] : [[0, top + 0.28, 0, 0.5], [0.5, top + 0.2, 0.1, 0.38], [-0.5, top + 0.2, -0.1, 0.4]], 1, 7);
        tintBottom(shrubs, top, top + 0.9);
        return { near: [...kitParts(false), this.part(shrubs, 'leaf', false)], mid: null, palette: [new THREE.Color(0x4f7a32)] };
      }
    }
    throw new Error(`No model for prop ${id}`);
  }

  /** Broadleaf tree: trunk + crown of jittered blobs (flat shaded), darker underneath; mid level one blob. */
  private tree(trunkH: number, trunkR: number, crown: [number, number, number, number][], palette: THREE.Color[], seed: number): PropModel {
    const trunk = merge([cyl(trunkR * 0.7, trunkR, trunkH + crown[0][3] * 0.6, 6, 0, 0, 0)]);
    const g = blobs(crown, 1, seed);
    let top = 0;
    let bottom = Infinity;
    let r = 0;
    for (const [x, y, z, rad] of crown) {
      top = Math.max(top, y + rad);
      bottom = Math.min(bottom, y - rad);
      r = Math.max(r, Math.hypot(x, z) + rad);
    }
    tintBottom(g, bottom, top);
    const mid = blobs([[0, 0, 0, 1]], 0, seed + 10).scale(r * 0.9, 1, r * 0.9);
    fitY(mid, bottom, top);
    tintBottom(mid, bottom, top);
    return {
      near: [this.part(trunk, 'bark', true), this.part(g, 'leaf', true)],
      mid: [this.part(cyl(trunkR * 0.7, trunkR, trunkH + 0.5, 4, 0, 0, 0), 'bark', true), this.part(mid, 'leaf', true)],
      palette,
    };
  }

  /** Cobra-head street lamp: pole, arm reaching over the road (+z), head with the lit glass underneath, light pool. */
  private armLamp(h: number, arm: number, r: number): PropModel {
    const pole = merge([cyl(r * 1.6, r * 1.7, 0.5, 8, 0, 0, 0), cyl(r * 0.7, r, h, 8, 0, 0, 0), tilted(box(0.08, 0.08, arm, 0, 0, arm / 2), -0.08, 0, h - 0.1, 0)]);
    const head = box(0.34, 0.13, 0.95, 0, h - 0.05 + arm * 0.08, arm + 0.3);
    const glow = box(0.26, 0.06, 0.74, 0, h - 0.14 + arm * 0.08, arm + 0.3);
    const light = this.part(pool(h * 0.9, 0, arm + 0.3), 'pool', false);
    return {
      near: [this.part(pole, 'metal', true), this.part(head, 'iron', true), this.part(glow, 'lamp', false), light],
      mid: [this.part(merge([cyl(r * 0.7, r, h, 4, 0, 0, 0), box(0.08, 0.08, arm, 0, h - 0.1, arm / 2)]), 'metal', true), this.part(glow, 'lamp', false), light],
      palette: null,
    };
  }

  /** Signal pole / mast arm with its heads (black body, back plate, three dark lenses each). */
  private signal(id: string): PropModel {
    const heads = SIGNAL_HEADS[id];
    const mast = heads.length > 1;
    const reach = mast ? -heads[1][0] : 0;
    const poleH = mast ? 6 : 3.5;
    const body: THREE.BufferGeometry[] = [cyl(0.12, 0.14, 0.3, 8, 0, 0, 0), cyl(mast ? 0.1 : 0.07, mast ? 0.13 : 0.08, poleH, 8, 0, 0, 0)];
    if (mast) body.push(box(reach + 0.4, 0.12, 0.12, -(reach + 0.4) / 2 + 0.1, 5.85, 0), box(0.05, 0.4, 0.05, -reach, 5.85 - 0.2, 0));
    const housings: THREE.BufferGeometry[] = [];
    const lenses: THREE.BufferGeometry[] = [];
    for (const [hx, hy, hz] of heads) {
      housings.push(box(0.34, 0.96, 0.26, hx, hy, hz), box(0.56, 1.16, 0.03, hx, hy, hz - 0.14));
      for (const [lx, ly, lz] of SIGNAL_LAMPS) lenses.push(new THREE.CircleGeometry(0.11, 10).translate(hx + lx, hy + ly, hz + lz - 0.035));
    }
    return { near: [this.part(merge(body), 'metal', true), this.part(merge(housings), 'iron', true), this.part(merge(lenses), 'lens', false)], mid: null, palette: null };
  }

  /** Post with a sign face (atlas tile) and a plain back. */
  private sign(face: THREE.BufferGeometry, tile: number): PropModel {
    tileUv(face, tile);
    const front = face.clone().translate(0, 2.15, 0.035);
    const back = face.clone().rotateY(Math.PI).translate(0, 2.15, 0.03);
    face.dispose();
    const post = cyl(0.03, 0.03, 2.5, 6, 0, 0, 0);
    return { near: [this.part(post, 'metalLight', false), this.part(merge([front]), 'sign', false), this.part(merge([back]), 'metalLight', false)], mid: null, palette: null };
  }
}

// --- geometry helpers ------------------------------------------------------------------------------

/** Plain geometry: non-indexed, position / normal / uv only (merging needs the same attributes everywhere). */
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const name of Object.keys(n.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(name)) n.deleteAttribute(name);
  if (!n.getAttribute('uv')) n.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((n.getAttribute('position').count) * 2), 2));
  if (n !== g) g.dispose();
  return n;
}

function merge(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map(clean);
  const hasColor = parts.some((p) => p.getAttribute('color'));
  if (hasColor) for (const p of parts) if (!p.getAttribute('color')) p.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(p.getAttribute('position').count * 3).fill(1), 3));
  const g = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!;
  if (parts.length > 1) for (const p of parts) p.dispose();
  return g;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

/** Cylinder standing on y (base at y), radius rTop at the top. */
function cyl(rTop: number, rBottom: number, h: number, seg: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg).translate(x, y + h / 2, z);
}

function cone(r: number, h: number, seg: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, h, seg).translate(x, y + h / 2, z);
}

/** A part rotated about x by `angle` and moved to (x, y, z). */
function tilted(g: THREE.BufferGeometry, angle: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return g.rotateX(angle).translate(x, y, z);
}

/** Light pool: a flat disc of radius r at (x, z), 2 cm up, white in the middle fading to black at the rim. */
function pool(r: number, x: number, z: number): THREE.BufferGeometry {
  const g = flat(new THREE.CircleGeometry(r, 18)).translate(x, 0.02, z);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const d = Math.hypot(pos.getX(i) - x, pos.getZ(i) - z) / r;
    col.fill(d < 0.01 ? 1 : 0, i * 3, i * 3 + 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Lies a plane / disc flat, facing up. */
function flat(g: THREE.BufferGeometry): THREE.BufferGeometry {
  return g.rotateX(-Math.PI / 2);
}

function octagon(r: number): THREE.BufferGeometry {
  return new THREE.CircleGeometry(r, 8).rotateZ(Math.PI / 8);
}

/** Point-down triangle (yield), side s. */
function triangle(s: number): THREE.BufferGeometry {
  const h = (s * Math.sqrt(3)) / 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-s / 2, h / 3, 0, 0, (-2 * h) / 3, 0, s / 2, h / 3, 0], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 0.5, 0, 1, 1], 2));
  g.setIndex([0, 1, 2]);
  return g;
}

/** Maps a flat face's uv (its own 0..1 box) into a sign atlas tile. */
function tileUv(g: THREE.BufferGeometry, tile: number): void {
  const pos = g.getAttribute('position');
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    x0 = Math.min(x0, pos.getX(i));
    x1 = Math.max(x1, pos.getX(i));
    y0 = Math.min(y0, pos.getY(i));
    y1 = Math.max(y1, pos.getY(i));
  }
  const c = tile % 4;
  const r = Math.floor(tile / 4);
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const u = (pos.getX(i) - x0) / (x1 - x0);
    const v = (pos.getY(i) - y0) / (y1 - y0);
    // Canvas row r (from the top) is v in [1 − (r + 1) / 2, 1 − r / 2]; a small inset keeps neighbours out.
    uv[i * 2] = (c + 0.02 + u * 0.96) / 4;
    uv[i * 2 + 1] = 1 - (r + 1) / 2 + (0.02 + v * 0.96) / 2;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** Crown / bush: icosahedra with their vertices pushed in and out a little (same push for shared corners). */
function blobs(list: [number, number, number, number][], detail: number, seed: number): THREE.BufferGeometry {
  const parts = list.map(([x, y, z, r], k) => {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const h = Math.sin(px * 12.9898 + py * 78.233 + pz * 37.719 + seed * 13.1 + k * 7.7) * 43758.5453;
      const f = 0.82 + 0.3 * (h - Math.floor(h));
      pos.setXYZ(i, x + px * r * f, y + py * r * f * 0.9, z + pz * r * f);
    }
    g.computeVertexNormals();
    return g;
  });
  return merge(parts);
}

/** Vertex colours: darker towards the bottom of [y0, y1] (self-shadowed crowns). */
function tintBottom(g: THREE.BufferGeometry, y0: number, y1: number): void {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / Math.max(0.01, y1 - y0)));
    const v = 0.55 + 0.45 * t;
    col[i * 3] = v;
    col[i * 3 + 1] = v;
    col[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/** Moves / scales a geometry vertically so it spans [y0, y1]. */
function fitY(g: THREE.BufferGeometry, y0: number, y1: number): void {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const s = (y1 - y0) / Math.max(0.01, b.max.y - b.min.y);
  g.translate(0, -b.min.y, 0).scale(1, s, 1).translate(0, y0, 0);
}

// --- canvas textures (browser only) ------------------------------------------------------------------

function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true): THREE.Texture | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  draw(ctx);
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Sign faces in the European style: stop, yield, 30, parking, pedestrian crossing, bus stop. */
function signAtlas(): THREE.Texture | null {
  return canvasTexture(1024, 512, (ctx) => {
    const T = 256;
    const tile = (k: number, draw: (cx: number, cy: number) => void) => draw((k % 4) * T + T / 2, Math.floor(k / 4) * T + T / 2);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, 1024, 512);
    const text = (s: string, x: number, y: number, size: number, color: string) => {
      ctx.fillStyle = color;
      ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s, x, y);
    };
    tile(SIGN_TILE.stop, (cx, cy) => {
      ctx.fillStyle = '#c4161c';
      ctx.fillRect(cx - T / 2, cy - T / 2, T, T);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 10;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        const x = cx + Math.cos(a) * T * 0.44;
        const y = cy + Math.sin(a) * T * 0.44;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      text('STOP', cx, cy + 4, 74, '#ffffff');
    });
    tile(SIGN_TILE.yield, (cx, cy) => {
      ctx.fillStyle = '#c4161c';
      ctx.fillRect(cx - T / 2, cy - T / 2, T, T);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      // The face is point-down; uv v runs up, so the inner triangle is drawn point-down too.
      ctx.moveTo(cx - T * 0.3, cy - T * 0.26);
      ctx.lineTo(cx + T * 0.3, cy - T * 0.26);
      ctx.lineTo(cx, cy + T * 0.3);
      ctx.closePath();
      ctx.fill();
    });
    tile(SIGN_TILE.speed30, (cx, cy) => {
      ctx.fillStyle = '#c4161c';
      ctx.fillRect(cx - T / 2, cy - T / 2, T, T);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, T * 0.36, 0, Math.PI * 2);
      ctx.fill();
      text('30', cx, cy + 6, 110, '#111111');
    });
    tile(SIGN_TILE.parking, (cx, cy) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - T / 2, cy - T / 2, T, T);
      ctx.fillStyle = '#1d4ea0';
      ctx.fillRect(cx - T / 2 + 12, cy - T / 2 + 12, T - 24, T - 24);
      text('P', cx, cy + 8, 170, '#ffffff');
    });
    tile(SIGN_TILE.crossing, (cx, cy) => {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - T / 2, cy - T / 2, T, T);
      ctx.fillStyle = '#1d4ea0';
      ctx.fillRect(cx - T / 2 + 12, cy - T / 2 + 12, T - 24, T - 24);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(cx, cy - T * 0.34);
      ctx.lineTo(cx + T * 0.34, cy + T * 0.28);
      ctx.lineTo(cx - T * 0.34, cy + T * 0.28);
      ctx.closePath();
      ctx.fill();
      // Walking figure and zebra bars.
      ctx.fillStyle = '#111111';
      ctx.beginPath();
      ctx.arc(cx + 4, cy - T * 0.1, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(cx - 6, cy - T * 0.05, 16, 50);
      for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * 26 - 9, cy + T * 0.18, 16, 14);
    });
    tile(SIGN_TILE.bus, (cx, cy) => {
      ctx.fillStyle = '#f2c200';
      ctx.beginPath();
      ctx.arc(cx, cy, T * 0.46, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c7a3a';
      ctx.beginPath();
      ctx.arc(cx, cy, T * 0.38, 0, Math.PI * 2);
      ctx.fill();
      text('H', cx, cy + 8, 150, '#f2c200');
    });
  });
}

/** Chain-link: diamond wires on transparent (alpha map: white = wire). */
function fenceTexture(): THREE.Texture | null {
  const t = canvasTexture(
    64,
    64,
    (ctx) => {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, 64, 64);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(64, 64);
      ctx.moveTo(64, 0);
      ctx.lineTo(0, 64);
      ctx.stroke();
    },
    false,
  );
  if (t) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  return t;
}

/** Container sides: vertical ribs (light / dark bands), tinted by the instance colour. */
function ribTexture(): THREE.Texture | null {
  const t = canvasTexture(64, 8, (ctx) => {
    for (let x = 0; x < 64; x++) {
      const v = 200 + Math.round(45 * Math.sin((x / 64) * Math.PI * 2 * 4));
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x, 0, 1, 8);
    }
  });
  if (t) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 1);
  }
  return t;
}
