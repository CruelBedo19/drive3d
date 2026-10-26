import * as THREE from 'three';
import {
  BUILDING_LAYERS,
  BUILDING_SLOTS,
  CARD_LEVEL,
  CARD_WINDOW_FLAG,
  INSTANCE_STRIDE,
  PROTO_LEVELS,
  SLOT_INDEX,
  SLOT_VARIANTS,
  assembleProto,
  type AssembledMesh,
  type BuildingProto,
} from './buildingKit';
import type { CityV2Data } from './CityV2Data';

/**
 * Levels of detail. A building in a cell near the camera is drawn by itself,
 * by distance to its footprint (radius subtracted): the ground floor as
 * modelled with relief floors above (near), relief (street), its card (mid).
 * A cell whose buildings are all CELL_MERGE away is drawn as one mesh of
 * their cards (the same geometry, merged: one draw call for the cell), and
 * beyond CELL_FAR as textured boxes with painted window rows (all such
 * buildings in one draw). Hysteresis keeps buildings and cells from
 * flickering between two levels.
 *
 * Culling against the view: three.js tests a whole mesh (an InstancedMesh's
 * bounds span all its instances), so instanced buildings and far boxes are
 * culled one by one here (a prototype seen once would otherwise send every
 * copy in range to the GPU, the far boxes the whole town). Merged cells are
 * one mesh per 250 m cell, culled by three.js. Measured against far boxes in
 * 125 / 250 / 500 m chunk meshes: as few boxes as the exact test only with
 * 125 m chunks, at up to 150 more draw calls; one buffer refilled when the
 * boxes in view change costs well under a millisecond.
 */
const LIMITS = [35, 110];
const HYSTERESIS = 10;
const CELL_MERGE = 220;
const CELL_FAR = 450;
const CELL_HYSTERESIS = 25;
/** A merged cell is let go this far beyond CELL_FAR (its mesh is ~1.5 MB), m. */
const CELL_KEEP = 75;
/** Shadow casters (near and street levels) are kept this far outside the view: their shadow may still fall into it, m. */
const SHADOW_REACH = 40;
const LEVEL_NAMES = ['near', 'street', 'mid'];
/** Levels are re-chosen when the camera has moved this far, m; further than JUMP (a teleport) everything is built at once. */
const RECHECK = 5;
const JUMP = 150;
/**
 * Geometry built per frame while driving (prototype levels, merged cells), ms; what is not ready yet is drawn a
 * level coarser. A cell merge is spread over frames (building by building) to stay within it.
 */
const BUILD_BUDGET_MS = 3;
/** Prototype levels other than cards not drawn for this long are let go (rebuilt when needed again), ms. */
const LEVEL_KEEP_MS = 30000;
/** Lots are 15 cm above the asphalt. */
const BASE = 0.15;
/** Card windows: drawn this much nearer in depth (clip z, × w), so they never fight with the wall right behind them. */
const CARD_WINDOW_PULL = 6e-7;

export interface BuildingMaterials {
  /** Every near / mid building surface: texture arrays + per-vertex slot (layer, tint, roughness, sky light share). */
  facade: THREE.MeshStandardMaterial;
  /** Far boxes: the building's wall texture, window rows drawn by the shader. */
  far: THREE.MeshStandardMaterial;
  textures: THREE.Texture[];
}

/** Texture arrays from the prepared images (layers stacked top to bottom). */
export async function decodeArrayTexture(bytes: ArrayBuffer, size: number, srgb: boolean): Promise<THREE.DataArrayTexture> {
  const layers = BUILDING_LAYERS.length;
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = new OffscreenCanvas(size, size * layers);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = new Uint8Array(ctx.getImageData(0, 0, size, size * layers).data.buffer);
  const t = new THREE.DataArrayTexture(data, size, size, layers);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Slot tables as shader uniforms: tint + desaturation, (layer, roughness, sky share), variant targets. */
function slotUniforms(): { tint: THREE.Vector4[]; surf: THREE.Vector4[]; variants: THREE.Vector4[] } {
  return {
    tint: BUILDING_SLOTS.map((s) => new THREE.Vector4(s.tint[0], s.tint[1], s.tint[2], s.desat)),
    surf: BUILDING_SLOTS.map((s) => new THREE.Vector4(BUILDING_LAYERS.indexOf(s.layer), s.roughness, s.env, 0)),
    variants: SLOT_VARIANTS.map((v) => new THREE.Vector4(v[0], v[1], v[2], v[3])),
  };
}

const ALBEDO_TINT = `diffuseColor.rgb *= mix( bAlb, vec3( dot( bAlb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), vBTint.w ) * vBTint.rgb;`;

/**
 * Facade texture read. One-colour surfaces (relief trims, card boxes: one uv on all corners) read the
 * average of the 32 × 32 texel block around that uv, at the block's centre: their interpolated uv
 * wobbles by rounding noise, and a single texel there would flip between neighbours (speckles).
 * They have no tangent frame either (their uv derivatives are that noise), so no normal map.
 */
const FACADE_READ = `vec2 bUvd = fwidth( vNormalMapUv );
bool bFlat = bUvd.x + bUvd.y < 1e-5;
vec3 bAlb = bFlat ? textureLod( bAlbedo, vec3( ( floor( vNormalMapUv * 32.0 ) + 0.5 ) / 32.0, vBSurf.x ), 5.0 ).rgb : texture( bAlbedo, vec3( vNormalMapUv, vBSurf.x ) ).rgb;
${ALBEDO_TINT}`;

const SKY_SHARE = `#include <lights_fragment_maps>
iblIrradiance *= vBSurf.z;
#if defined( RE_IndirectSpecular )
radiance *= vBSurf.z;
#endif`;

/**
 * One material for all building surfaces. A vertex's slot (buildingKit.ts)
 * picks its texture layer, tint (with optional desaturation: the kit's pale
 * brick, dark and green trims are recoloured from one texture), roughness and
 * share of the sky's environment light; windows are glossy room cards. An
 * instance's colour variant maps its slots to others (SLOT_VARIANTS).
 * Built on MeshStandardMaterial (lights, shadows, fog, instancing as usual):
 * only the texture reads, roughness and the environment share are replaced.
 */
export function createBuildingMaterials(albedo: THREE.DataArrayTexture, normal: THREE.DataArrayTexture): BuildingMaterials {
  const n = BUILDING_SLOTS.length;
  const u = slotUniforms();
  // A 1 × 1 normal map turns on three's normal-map path (uv and tangent frame); the arrays replace its reads.
  const flat = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
  flat.needsUpdate = true;
  const facade = new THREE.MeshStandardMaterial({ name: 'cv2_building', roughness: 1, metalness: 0, normalMap: flat });
  // Kit uv run down the image (glTF): with derived tangents the green channel is flipped, as GLTFLoader does.
  facade.normalScale.set(1, -1);
  facade.onBeforeCompile = (sh) => {
    sh.uniforms.bAlbedo = { value: albedo };
    sh.uniforms.bNormal = { value: normal };
    sh.uniforms.bSlotTint = { value: u.tint };
    sh.uniforms.bSlotSurf = { value: u.surf };
    sh.uniforms.bSlotVar = { value: u.variants };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float slot;
attribute float variant;
uniform vec4 bSlotTint[ ${n} ];
uniform vec4 bSlotSurf[ ${n} ];
uniform vec4 bSlotVar[ ${n} ];
flat varying vec4 vBTint;
flat varying vec3 vBSurf;`,
      )
      .replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
float bPull = step( ${CARD_WINDOW_FLAG - 0.5}, slot );
int bSlot = int( slot - ${CARD_WINDOW_FLAG}.0 * bPull + 0.5 );
bSlot = int( bSlotVar[ bSlot ][ int( variant + 0.5 ) ] + 0.5 );
vBTint = bSlotTint[ bSlot ];
vBSurf = bSlotSurf[ bSlot ].xyz;`,
      )
      .replace('#include <project_vertex>', `#include <project_vertex>\ngl_Position.z -= bPull * ${CARD_WINDOW_PULL} * gl_Position.w;`);
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2DArray bAlbedo;
uniform highp sampler2DArray bNormal;
flat varying vec4 vBTint;
flat varying vec3 vBSurf;`,
      )
      .replace('#include <map_fragment>', FACADE_READ)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vBSurf.y;')
      .replace(
        '#include <normal_fragment_maps>',
        `if ( !bFlat ) {
	vec3 mapN = texture( bNormal, vec3( vNormalMapUv, vBSurf.x ) ).xyz * 2.0 - 1.0;
	mapN.xy *= normalScale;
	normal = normalize( tbn * mapN );
}`,
      )
      .replace('#include <lights_fragment_maps>', SKY_SHARE);
  };
  facade.customProgramCacheKey = () => 'cv2_building';

  // Far boxes: x −0.5..0.5, y 0..1, z −1..0 scaled per building; `bFar` = (wall slot, ground floor height, roof slot).
  const far = new THREE.MeshStandardMaterial({ name: 'cv2_building_far', roughness: 1, metalness: 0 });
  far.onBeforeCompile = (sh) => {
    sh.uniforms.bAlbedo = { value: albedo };
    sh.uniforms.bSlotTint = { value: u.tint };
    sh.uniforms.bSlotSurf = { value: u.surf };
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec3 bFar;
uniform vec4 bSlotTint[ ${n} ];
uniform vec4 bSlotSurf[ ${n} ];
varying vec3 vBoxP;
flat varying vec3 vBoxN;
flat varying float vBoxH;
flat varying float vBoxG;
flat varying vec4 vBTint;
flat varying vec3 vBSurf;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vec3 bScale = vec3( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
vBoxP = position * bScale;
vBoxN = normal;
vBoxH = bScale.y;
vBoxG = bFar.y;
int bSlot = int( ( normal.y > 0.5 ? bFar.z : bFar.x ) + 0.5 );
vBTint = bSlotTint[ bSlot ];
vBSurf = bSlotSurf[ bSlot ].xyz;`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform highp sampler2DArray bAlbedo;
varying vec3 vBoxP;
flat varying vec3 vBoxN;
flat varying float vBoxH;
flat varying float vBoxG;
flat varying vec4 vBTint;
flat varying vec3 vBSurf;`,
      )
      .replace(
        '#include <map_fragment>',
        `// Walls in metres like the kit's (1 uv per 2 m), the roof in plan.
vec2 bUv = abs( vBoxN.y ) > 0.5 ? vBoxP.xz / 2.0 : vec2( ( abs( vBoxN.z ) > 0.5 ? vBoxP.x : vBoxP.z ) / 2.0, -vBoxP.y / 2.0 );
vec3 bAlb = texture( bAlbedo, vec3( bUv, vBSurf.x ) ).rgb;
${ALBEDO_TINT}
// Window rows: 2 m columns, 3 m floors above the ground floor, none on the roof or the parapet.
// Where a window is smaller than about a pixel the pattern fades to its average (no shimmer).
if ( abs( vBoxN.y ) < 0.5 && vBoxP.y > 0.6 && vBoxP.y < vBoxH - 1.5 ) {
	float g = vBoxP.y < vBoxG ? 0.0 : vBoxG;
	vec2 bc = vec2( ( abs( vBoxN.z ) > 0.5 ? vBoxP.x : vBoxP.z ) / 2.0, ( vBoxP.y - g ) / ( g > 0.0 ? 3.0 : vBoxG ) );
	vec2 bf = fract( bc );
	float win = step( 0.22, bf.x ) * step( bf.x, 0.78 ) * step( 0.2, bf.y ) * step( bf.y, 0.85 );
	float sharp = clamp( 1.5 - 2.0 * max( fwidth( bc.x ), fwidth( bc.y ) ), 0.0, 1.0 );
	diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.025, 0.03, 0.04 ), mix( 0.36, win, sharp ) );
}`,
      )
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = roughness * vBSurf.y;')
      .replace('#include <lights_fragment_maps>', SKY_SHARE);
  };
  far.customProgramCacheKey = () => 'cv2_building_far';
  return { facade, far, textures: [albedo, normal, flat] };
}

interface Building {
  proto: BuildingProto;
  x: number;
  z: number;
  yaw: number;
  /** Stretch of frontage and depth (lots off the module grid). */
  sx: number;
  sz: number;
  variant: number;
  /** Footprint centre and radius (distance is measured to the footprint, roughly). */
  cx: number;
  cz: number;
  r: number;
  /** Bounding sphere of the whole building: centre height and radius. */
  cy: number;
  rs: number;
  /** Level wanted (0 near, 1 street, 2 mid) and level drawn (a coarser one until the wanted one is built). */
  lod: number;
  drawn: number;
  /** In view at the last refill (buildings drawn by themselves). */
  shown: boolean;
  /** Far box in view at the last refill. */
  farShown: boolean;
  /** Instanced mesh keys per level. */
  keys: string[];
  matrix: THREE.Matrix4;
}

interface Cell {
  buildings: Building[];
  /** Footprints' extent [minX, minZ, maxX, maxZ]. */
  bounds: [number, number, number, number];
  /** 0: buildings by themselves; 1: merged cards; 2: far boxes. */
  state: number;
  /** As drawn (merged waits for its mesh). */
  drawn: number;
  merged: THREE.Mesh | null;
  mergedTris: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _sphere = new THREE.Sphere();

/**
 * Building geometry with compact attributes: normals as bytes (flat facades), slots as bytes (< 128 with the card
 * window flag), 16-bit indices where they fit.
 */
function compactGeometry(position: Float32Array, normal: Float32Array, uv: Float32Array, slot: Float32Array, index: Uint32Array): THREE.BufferGeometry {
  const n = new Int8Array(normal.length);
  for (let i = 0; i < normal.length; i++) n[i] = Math.round(normal[i] * 127);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3, true));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('slot', new THREE.BufferAttribute(Uint8Array.from(slot), 1));
  g.setIndex(new THREE.BufferAttribute(slot.length <= 65536 ? Uint16Array.from(index) : index, 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * The buildings of City V2. Prototype levels are assembled from their modules
 * when first needed (a few per frame while driving); each prototype and level
 * is one InstancedMesh with room for all its instances (no reallocation). Which
 * buildings and cells are at which level is re-chosen as the camera moves.
 */
export class CityV2Buildings {
  readonly group = new THREE.Group();
  private readonly data: CityV2Data;
  private readonly mats: BuildingMaterials | null;
  private readonly buildings: Building[] = [];
  private readonly cells: Cell[] = [];
  private readonly perProto = new Map<number, number>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly cards = new Map<number, AssembledMesh>();
  private readonly meshes = new Map<string, THREE.InstancedMesh>();
  /** When each prototype level was last drawn (performance.now()). */
  private readonly used = new Map<string, number>();
  private lastSweep = 0;
  /** Geometry jobs: each runs until done (true) or past the deadline (false: resumed next frame). */
  private readonly queue = new Map<string, (deadline: number) => boolean>();
  private readonly far: THREE.InstancedMesh | null = null;
  private readonly farBox: THREE.BufferGeometry | null = null;
  private readonly farData: THREE.InstancedBufferAttribute | null = null;
  private last = new THREE.Vector3(Infinity, 0, Infinity);
  /** Buildings per level in range (near, street, mid, in merged cells, far), whatever the view. */
  counts = [0, 0, 0, 0, 0];
  /** In view: buildings drawn by themselves left out (culled), far boxes drawn; triangles and draw calls drawn. */
  culled = 0;
  farShown = 0;
  triangles = 0;
  draws = { instanced: 0, merged: 0, far: 0 };
  /** Geometry built in the last update, ms. */
  buildMs = 0;
  /** Culling against the view (off: every building in range drawn, as before it; for A/B measurements). */
  cullView = true;
  /** Buildings drawn a level coarser than wanted (their level is not built yet), geometry jobs waiting. */
  waiting = 0;
  queued = 0;

  constructor(data: CityV2Data, mats: BuildingMaterials | null) {
    this.data = data;
    this.mats = mats;
    this.group.name = 'city_v2-buildings';
    const { json, f32 } = data;
    for (const c of json.cells) {
      const [o, n] = c.inst;
      if (!n) continue;
      const cell: Cell = { buildings: [], bounds: [Infinity, Infinity, -Infinity, -Infinity], state: -1, drawn: -1, merged: null, mergedTris: 0 };
      for (let i = 0; i < n; i++) {
        const k = o + i * INSTANCE_STRIDE;
        const proto = json.buildings.protos[f32[k]];
        const yaw = f32[k + 3];
        const sx = f32[k + 4];
        const sz = f32[k + 5];
        // Front centre → footprint centre: half the depth back along −(sin, cos).
        const cx = f32[k + 1] - (Math.sin(yaw) * proto.d * sz) / 2;
        const cz = f32[k + 2] - (Math.cos(yaw) * proto.d * sz) / 2;
        const r = Math.hypot(proto.w * sx, proto.d * sz) / 2;
        _q.setFromAxisAngle(_up, yaw);
        const matrix = new THREE.Matrix4().compose(_p.set(f32[k + 1], BASE, f32[k + 2]), _q, _s.set(sx, 1, sz));
        const keys = LEVEL_NAMES.map((_, lod) => `${proto.id}:${lod}`);
        const b: Building = { proto, x: f32[k + 1], z: f32[k + 2], yaw, sx, sz, variant: f32[k + 6], cx, cz, r, cy: BASE + proto.h / 2, rs: Math.hypot(r, proto.h / 2), lod: -1, drawn: -1, shown: false, farShown: false, keys, matrix };
        this.buildings.push(b);
        cell.buildings.push(b);
        cell.bounds = [Math.min(cell.bounds[0], cx - r), Math.min(cell.bounds[1], cz - r), Math.max(cell.bounds[2], cx + r), Math.max(cell.bounds[3], cz + r)];
        this.perProto.set(proto.id, (this.perProto.get(proto.id) ?? 0) + 1);
      }
      this.cells.push(cell);
    }
    if (!mats || this.buildings.length === 0) return;
    // Cards of every prototype up front: they are cheap and every cell merge needs them.
    for (const id of this.perProto.keys()) this.geometry(json.buildings.protos[id], CARD_LEVEL);
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.deleteAttribute('uv');
    box.translate(0, 0.5, -0.5);
    this.farData = new THREE.InstancedBufferAttribute(new Float32Array(this.buildings.length * 3), 3);
    box.setAttribute('bFar', this.farData);
    this.farBox = box;
    this.far = new THREE.InstancedMesh(box, mats.far, this.buildings.length);
    this.far.name = 'buildings-far';
    this.far.count = 0;
    this.far.visible = false;
    // Culled box by box (refill): three's test of the whole mesh would only recompute its bounds every change.
    this.far.frustumCulled = false;
    this.far.castShadow = false;
    this.far.receiveShadow = true;
    this.group.add(this.far);
  }

  get total(): number {
    return this.buildings.length;
  }

  private card(proto: BuildingProto): AssembledMesh {
    let m = this.cards.get(proto.id);
    if (!m) {
      const { json, f32, u32 } = this.data;
      m = assembleProto(proto, json.buildings.modules, CARD_LEVEL, f32, u32);
      this.cards.set(proto.id, m);
    }
    return m;
  }

  private geometry(proto: BuildingProto, lod: number): THREE.BufferGeometry {
    const key = `${proto.id}:${lod}`;
    let g = this.geometries.get(key);
    if (!g) {
      const { json, f32, u32 } = this.data;
      const m = lod === CARD_LEVEL ? this.card(proto) : assembleProto(proto, json.buildings.modules, lod, f32, u32);
      g = compactGeometry(m.position, m.normal, m.uv, m.slot, m.index);
      g.setAttribute('variant', new THREE.InstancedBufferAttribute(new Float32Array(this.perProto.get(proto.id) ?? 1), 1));
      this.geometries.set(key, g);
      const mesh = new THREE.InstancedMesh(g, this.mats!.facade, this.perProto.get(proto.id) ?? 1);
      mesh.name = `building-${proto.name}-${LEVEL_NAMES[lod]}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.castShadow = lod < CARD_LEVEL;
      mesh.receiveShadow = true;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
    return g;
  }

  /** One mesh of the cell's cards, in world space, colour variants applied; yields after each building. */
  private *mergeCell(cell: Cell): Generator<void, void, void> {
    let verts = 0;
    let idx = 0;
    for (const b of cell.buildings) {
      const m = this.card(b.proto);
      verts += m.slot.length;
      idx += m.index.length;
    }
    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const slot = new Float32Array(verts);
    const index = new Uint32Array(idx);
    let v = 0;
    let t = 0;
    for (const b of cell.buildings) {
      const m = this.card(b.proto);
      for (let i = 0; i < m.index.length; i++) index[t + i] = m.index[i] + v;
      t += m.index.length;
      // Rotation about y, scale (sx, 1, sz), translation: the normal turns with the yaw and the inverse scale.
      const e = b.matrix.elements;
      const cos = Math.cos(b.yaw);
      const sin = Math.sin(b.yaw);
      const P = m.position;
      const N = m.normal;
      const variants = SLOT_VARIANTS;
      for (let i = 0; i < m.slot.length; i++, v++) {
        const x = P[i * 3];
        const z = P[i * 3 + 2];
        position[v * 3] = e[0] * x + e[8] * z + e[12];
        position[v * 3 + 1] = P[i * 3 + 1] + e[13];
        position[v * 3 + 2] = e[2] * x + e[10] * z + e[14];
        const nx = N[i * 3] / b.sx;
        const nz = N[i * 3 + 2] / b.sz;
        const ny = N[i * 3 + 1];
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        normal[v * 3] = (cos * nx + sin * nz) / len;
        normal[v * 3 + 1] = ny / len;
        normal[v * 3 + 2] = (-sin * nx + cos * nz) / len;
        uv[v * 2] = m.uv[i * 2];
        uv[v * 2 + 1] = m.uv[i * 2 + 1];
        const flag = m.slot[i] >= CARD_WINDOW_FLAG ? CARD_WINDOW_FLAG : 0;
        slot[v] = variants[m.slot[i] - flag][b.variant] + flag;
      }
      yield;
    }
    const g = compactGeometry(position, normal, uv, slot, index);
    // Variants are applied above.
    g.setAttribute('variant', new THREE.BufferAttribute(new Uint8Array(verts), 1));
    const mesh = new THREE.Mesh(g, this.mats!.facade);
    mesh.name = 'buildings-cell';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.visible = false;
    cell.merged = mesh;
    cell.mergedTris = idx / 3;
    this.group.add(mesh);
  }

  private request(key: string, job: (deadline: number) => boolean): void {
    if (!this.queue.has(key)) this.queue.set(key, job);
  }

  /**
   * Re-chooses levels around the camera, builds what they need (within the frame budget) and refills the
   * instance buffers that changed. With the view's frustum, buildings drawn by themselves outside it are left
   * out (checked every frame: the view turns without the camera moving).
   */
  update(camera: THREE.Vector3, force = false, frustum: THREE.Frustum | null = null): void {
    if (!this.mats || this.buildings.length === 0) return;
    const moved = Math.hypot(camera.x - this.last.x, camera.z - this.last.z);
    const all = force || moved > JUMP;
    if (!all && moved < RECHECK && this.queue.size === 0 && !frustum) return;
    const t0 = performance.now();
    if (moved >= RECHECK || all) {
      this.last.copy(camera);
      this.choose(camera);
    }
    // Build what the chosen levels need: everything at once after a jump, else within the budget.
    const deadline = all ? Infinity : t0 + BUILD_BUDGET_MS;
    for (const [key, job] of this.queue) {
      if (performance.now() > deadline) break;
      if (job(deadline)) this.queue.delete(key);
    }
    this.buildMs = performance.now() - t0;
    this.refill(this.cullView ? frustum : null);
    if (t0 - this.lastSweep > 2000) this.release(t0);
  }

  /**
   * Lets go of near and street levels no building has drawn for LEVEL_KEEP_MS (cards stay: cell merges need
   * them). Levels of buildings in range are kept even while out of view (turning round needs them again).
   */
  private release(now: number): void {
    this.lastSweep = now;
    const wanted = new Set<string>();
    for (const c of this.cells) if (c.drawn === 0) for (const b of c.buildings) wanted.add(b.keys[b.drawn]);
    for (const [key, g] of this.geometries) {
      if (wanted.has(key)) this.used.set(key, now);
      if (Number(key.split(':')[1]) === CARD_LEVEL || now - (this.used.get(key) ?? now) < LEVEL_KEEP_MS) continue;
      const mesh = this.meshes.get(key)!;
      if (mesh.count > 0) continue;
      mesh.removeFromParent();
      mesh.dispose();
      g.dispose();
      this.meshes.delete(key);
      this.geometries.delete(key);
      this.used.delete(key);
    }
  }

  /** Wanted levels: per cell by its distance, per building in cells drawn building by building. */
  private choose(camera: THREE.Vector3): void {
    for (const cell of this.cells) {
      const [x0, z0, x1, z1] = cell.bounds;
      const d = Math.hypot(Math.max(x0 - camera.x, 0, camera.x - x1), Math.max(z0 - camera.z, 0, camera.z - z1));
      const merge = CELL_MERGE + (cell.state === 0 ? CELL_HYSTERESIS : 0);
      const far = CELL_FAR + (cell.state >= 0 && cell.state <= 1 ? CELL_HYSTERESIS : 0);
      cell.state = d < merge ? 0 : d < far ? 1 : 2;
      if (cell.state === 1 && !cell.merged) {
        const steps = this.mergeCell(cell);
        this.request(`cell:${this.cells.indexOf(cell)}`, (deadline) => {
          while (!steps.next().done) if (performance.now() > deadline) return false;
          return true;
        });
      }
      // Merged meshes of cells long out of reach are let go.
      if (cell.state === 2 && cell.merged && d > CELL_FAR + CELL_KEEP) {
        cell.merged.removeFromParent();
        cell.merged.geometry.dispose();
        cell.merged = null;
      }
      if (cell.state !== 0) continue;
      for (const b of cell.buildings) {
        const db = Math.max(0, Math.hypot(b.cx - camera.x, b.cz - camera.z) - b.r);
        const h = (level: number) => LIMITS[level] + (b.lod >= 0 && b.lod <= level ? HYSTERESIS : 0);
        b.lod = db < h(0) ? 0 : db < h(1) ? 1 : 2;
        if (!this.geometries.has(`${b.proto.id}:${b.lod}`)) {
          const { proto, lod } = b;
          this.request(`${proto.id}:${lod}`, () => {
            this.geometry(proto, lod);
            return true;
          });
        }
      }
    }
  }

  /** Instance buffers, merged cells and far boxes as drawn now (in view, with a frustum). */
  private refill(frustum: THREE.Frustum | null): void {
    const groups = new Map<string, Building[]>();
    const far: Building[] = [];
    let farChanged = false;
    this.counts = [0, 0, 0, 0, 0];
    this.waiting = 0;
    this.queued = this.queue.size;
    this.culled = 0;
    this.farShown = 0;
    this.triangles = 0;
    this.draws = { instanced: 0, merged: 0, far: 0 };
    let changed = false;
    for (const cell of this.cells) {
      // A merged cell waits for its mesh as it was: boxes if it came from far, else its buildings.
      const drawn = cell.state === 1 && !cell.merged ? (cell.drawn === 2 ? 2 : 0) : cell.state;
      if (drawn !== cell.drawn) {
        changed = true;
        if (drawn === 2 || cell.drawn === 2) farChanged = true;
      }
      cell.drawn = drawn;
      if (cell.merged) cell.merged.visible = drawn === 1;
      if (drawn === 1) {
        this.counts[3] += cell.buildings.length;
        if (frustum && !frustum.intersectsObject(cell.merged!)) continue;
        this.triangles += cell.mergedTris;
        this.draws.merged++;
        continue;
      }
      if (drawn === 2) {
        this.counts[4] += cell.buildings.length;
        for (const b of cell.buildings) {
          _sphere.center.set(b.cx, b.cy, b.cz);
          _sphere.radius = b.rs;
          const shown = !frustum || frustum.intersectsSphere(_sphere);
          if (shown !== b.farShown) farChanged = true;
          b.farShown = shown;
          if (shown) far.push(b);
        }
        continue;
      }
      for (const b of cell.buildings) {
        // Wanted level if built, else the next coarser one that is (cards always are).
        let lod = Math.max(b.lod, 0);
        while (lod < CARD_LEVEL && !this.geometries.has(b.keys[lod])) lod++;
        if (lod !== Math.max(b.lod, 0)) this.waiting++;
        if (lod !== b.drawn) changed = true;
        b.drawn = lod;
        this.counts[lod]++;
        _sphere.center.set(b.cx, b.cy, b.cz);
        _sphere.radius = b.rs + (lod < CARD_LEVEL ? SHADOW_REACH : 0);
        const shown = !frustum || frustum.intersectsSphere(_sphere);
        if (shown !== b.shown) changed = true;
        b.shown = shown;
        if (!shown) {
          this.culled++;
          continue;
        }
        const list = groups.get(b.keys[lod]);
        if (list) list.push(b);
        else groups.set(b.keys[lod], [b]);
        this.triangles += b.proto.tris[lod];
      }
    }
    this.draws.instanced = groups.size;
    this.farShown = far.length;
    this.draws.far = far.length ? 1 : 0;
    this.triangles += far.length * 12;
    if (farChanged) this.refillFar(far);
    if (!changed) return;
    // Empty meshes are hidden: three would still issue a draw call for zero instances.
    for (const [key, mesh] of this.meshes) {
      if (groups.has(key)) continue;
      mesh.count = 0;
      mesh.visible = false;
    }
    for (const [key, list] of groups) {
      const mesh = this.meshes.get(key)!;
      const variant = mesh.geometry.getAttribute('variant') as THREE.InstancedBufferAttribute;
      list.forEach((b, i) => {
        mesh.setMatrixAt(i, b.matrix);
        variant.array[i] = b.variant;
      });
      mesh.count = list.length;
      mesh.visible = true;
      this.used.set(key, performance.now());
      mesh.instanceMatrix.needsUpdate = true;
      variant.needsUpdate = true;
      mesh.boundingSphere = null;
    }
  }

  /** Far boxes in view, rewritten when they change (a cell went to or from far, the view turned). */
  private refillFar(far: Building[]): void {
    const fm = this.far!;
    const fd = this.farData!;
    const roof = SLOT_INDEX.roof;
    far.forEach((b, i) => {
      fm.setMatrixAt(i, _m.copy(b.matrix).scale(_s.set(b.proto.w, b.proto.h, b.proto.d)));
      fd.setXYZ(i, SLOT_VARIANTS[b.proto.wallSlot][b.variant], b.proto.ground, roof);
    });
    fm.count = far.length;
    fm.visible = far.length > 0;
    fm.instanceMatrix.needsUpdate = true;
    fd.needsUpdate = true;
  }

  /** Prototype levels assembled so far (of PROTO_LEVELS per prototype used), cells merged. */
  built(): { levels: number; of: number; cells: number } {
    return { levels: this.geometries.size, of: this.perProto.size * PROTO_LEVELS, cells: this.cells.filter((c) => c.merged).length };
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) mesh.dispose();
    for (const g of this.geometries.values()) g.dispose();
    for (const c of this.cells) c.merged?.geometry.dispose();
    this.far?.dispose();
    this.farBox?.dispose();
    this.meshes.clear();
    this.geometries.clear();
    this.group.removeFromParent();
  }
}

