import * as THREE from 'three';
import type { CityV2Data } from './CityV2Data';
import { PROPS, PROP_STRIDE, SIGNAL_LAMPS, signalPhase, type CityV2PropsJson, type PropCategory } from './propKit';
import { PropCatalog } from './props/PropCatalog';
import { PropRenderer } from './props/PropRenderer';

/** Distance bands change only this far past a threshold (no flicker at the edge), m. */
const HYSTERESIS = 8;
/** Chunks count as in view this far outside the frustum: shadows of props just out of view still fall into it, m. */
const SHADOW_MARGIN = 12;
const SIGNAL_COLOURS = [0xff3a24, 0xffb20f, 0x2cff7a];

interface Item {
  proto: number;
  count: number;
  matrices: Float32Array;
  colors: Float32Array | null;
}

interface Chunk {
  bounds: [number, number, number, number, number];
  sphere: THREE.Sphere;
  items: Item[];
  /** Distance band (thresholds passed) and in-view flag as drawn. */
  band: number;
  inView: boolean;
  d: number;
  signals: number[];
}


/**
 * City V2 street props (A4): placed by scripts/lib/cityV2/props.ts, drawn as
 * instanced prototypes (PropRenderer), streamed and culled per 125 m chunk
 * (four per 250 m streaming cell):
 *
 *  - distance: each prototype has a draw distance (small things ~110 m,
 *    furniture ~200 m, trees / lamps / signals ~460 m, trees no further than
 *    the vegetation setting) and some a cheaper level beyond `mid`;
 *  - frustum: a chunk outside the view (plus a shadow margin) sends nothing;
 *  - the instance buffers are refilled only when a chunk changes band or
 *    view, as block copies of matrices built once at load: no per-frame
 *    allocation, a few hundred sphere tests per frame.
 *
 * Signals cycle through a simple fixed plan (signalPhase); their lit lamps
 * are three more instanced meshes refilled when the phase changes. Lamp heads
 * glow by night (PropCatalog.setNight). Colliders of solid props are part of
 * each cell's collider set (CityV2Track).
 */
export class CityV2Props {
  readonly group = new THREE.Group();
  readonly json: CityV2PropsJson | null;
  private readonly catalog: PropCatalog | null = null;
  private readonly renderer: PropRenderer | null = null;
  private readonly chunks: Chunk[] = [];
  /** Distance thresholds (sorted), each prototype's far / mid index in them. */
  private thresholds: number[] = [];
  private farIdx: number[] = [];
  private midIdx: number[] = [];
  private vegetation = -1;
  private readonly bulbs: THREE.InstancedMesh[] = [];
  /** Per signal: chunk, group, and per colour the bulb matrices of its heads. */
  private readonly signalBulbs: { group: number; matrices: Float32Array[] }[] = [];
  private phaseKey = -1;
  private dirty = true;
  /** Last update: ms, and whether the buffers were refilled. */
  updateMs = 0;
  refills = 0;
  /** In range of their draw distance whatever the view, sent to the GPU, chunks in view. */
  inRange = 0;
  submitted = 0;
  chunksInView = 0;
  litBulbs = 0;

  constructor(data: CityV2Data) {
    this.group.name = 'city_v2-props';
    this.json = data.json.props ?? null;
    const j = this.json;
    if (!j || j.total === 0) return;
    const ids = PROPS.map((p) => p.id).join(',');
    if (j.protos.join(',') !== ids) throw new Error(`City V2 props were prepared with another catalogue (${j.protos.length} vs ${PROPS.length} prototypes): run npm run prepare:city`);
    const { f32, u32 } = data;
    this.catalog = new PropCatalog(j.kit, f32, u32);
    const totals = PROPS.map(() => 0);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const chunkOf = new Map<string, number>();
    for (const c of j.chunks) {
      const items: Item[] = c.items.map(([proto, off, count]) => {
        totals[proto] += count;
        const matrices = new Float32Array(count * 16);
        const palette = this.catalog!.models[proto].palette;
        const colors = palette ? new Float32Array(count * 3) : null;
        for (let i = 0; i < count; i++) {
          const o = off + i * PROP_STRIDE;
          q.setFromAxisAngle(up, f32[o + 3]);
          m.compose(p.set(f32[o], f32[o + 1], f32[o + 2]), q, s.set(f32[o + 4], f32[o + 5], f32[o + 6]));
          m.toArray(matrices, i * 16);
          if (colors && palette) palette[f32[o + 7] % palette.length].toArray(colors, i * 3);
        }
        return { proto, count, matrices, colors };
      });
      const [x0, z0, x1, z1, y1] = c.bounds;
      const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, y1 / 2, (z0 + z1) / 2), Math.hypot((x1 - x0) / 2, (z1 - z0) / 2, y1 / 2) + SHADOW_MARGIN);
      chunkOf.set(`${c.cx},${c.cz}`, this.chunks.length);
      this.chunks.push({ bounds: c.bounds, sphere, items, band: -1, inView: false, d: Infinity, signals: [] });
    }
    this.renderer = new PropRenderer(this.catalog, totals);
    this.group.add(this.renderer.group);

    // Signal lamps: three instanced discs (red, yellow, green), one bulb per head of each signal.
    const heads = j.signals.reduce((a, sg) => a + sg.heads.length, 0);
    const disc = new THREE.CircleGeometry(0.1, 10);
    SIGNAL_COLOURS.forEach((colour, k) => {
      const mesh = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ color: colour }), Math.max(1, heads));
      mesh.name = `signal-lamps-${['red', 'yellow', 'green'][k]}`;
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.bulbs.push(mesh);
      this.group.add(mesh);
    });
    const off = new THREE.Vector3();
    j.signals.forEach((sg, idx) => {
      q.setFromAxisAngle(up, sg.yaw);
      const matrices = SIGNAL_LAMPS.map((lamp) => {
        const arr = new Float32Array(sg.heads.length * 16);
        sg.heads.forEach((h, i) => {
          off.set(lamp[0], lamp[1], lamp[2]).applyQuaternion(q);
          m.compose(p.set(h[0] + off.x, h[1] + off.y, h[2] + off.z), q, s.set(1, 1, 1));
          m.toArray(arr, i * 16);
        });
        return arr;
      });
      this.signalBulbs.push({ group: sg.group, matrices });
      const k = chunkOf.get(`${Math.floor(sg.x / j.chunk)},${Math.floor(sg.z / j.chunk)}`);
      if (k !== undefined) this.chunks[k].signals.push(idx);
    });
  }

  /** Thresholds for the current vegetation distance (trees are not drawn beyond it). */
  private setVegetation(vegetation: number): void {
    this.vegetation = vegetation;
    const far = PROPS.map((d) => (d.category === 'tree' ? Math.min(d.far, vegetation) : d.far));
    const mid = PROPS.map((d) => (d.mid !== undefined ? Math.min(d.mid, far[PROPS.indexOf(d)]) : Infinity));
    this.thresholds = [...new Set([...far, ...mid.filter((v) => v < Infinity)])].sort((a, b) => a - b);
    this.farIdx = far.map((f) => this.thresholds.indexOf(f));
    this.midIdx = mid.map((v) => (v < Infinity ? this.thresholds.indexOf(v) : -1));
    for (const c of this.chunks) c.band = -1;
    this.dirty = true;
  }

  private bandOf(d: number): number {
    let n = 0;
    while (n < this.thresholds.length && this.thresholds[n] <= d) n++;
    return n;
  }

  /**
   * Per frame: distance bands and view of every chunk; refills the instance buffers when one changed, the signal
   * lamps when the phase changed. `time` in s (signal plan), `night` 0..1 (lamp glow).
   */
  update(camera: THREE.Vector3, frustum: THREE.Frustum | null, vegetation: number, night: number, time: number): void {
    if (!this.renderer || !this.catalog || !this.json) return;
    const t0 = performance.now();
    if (vegetation !== this.vegetation) this.setVegetation(vegetation);
    this.catalog.setNight(night);
    let changed = this.dirty;
    let inView = 0;
    for (const c of this.chunks) {
      const [x0, z0, x1, z1] = c.bounds;
      const d = Math.hypot(Math.max(x0 - camera.x, 0, camera.x - x1), Math.max(z0 - camera.z, 0, camera.z - z1));
      c.d = d;
      let band = this.bandOf(d);
      if (band !== c.band && c.band >= 0) {
        // Past a threshold by less than HYSTERESIS: keep the band it had.
        const adj = this.bandOf(band > c.band ? d - HYSTERESIS : d + HYSTERESIS);
        if (adj === c.band) band = c.band;
      }
      const seen = band < this.thresholds.length && (!frustum || frustum.intersectsSphere(c.sphere));
      if (seen) inView++;
      if (band !== c.band || seen !== c.inView) changed = true;
      c.band = band;
      c.inView = seen;
    }
    this.chunksInView = inView;
    const phaseKey = signalPhase(0, time) * 3 + signalPhase(1, time);
    if (changed) this.refill();
    if (changed || phaseKey !== this.phaseKey) this.refillBulbs(time, phaseKey);
    this.refills = changed ? this.refills + 1 : this.refills;
    this.updateMs = performance.now() - t0;
  }

  private refill(): void {
    const r = this.renderer!;
    r.begin();
    let inRange = 0;
    for (const c of this.chunks) {
      for (const it of c.items) {
        if (c.band > this.farIdx[it.proto]) continue;
        inRange += it.count;
        if (!c.inView) continue;
        const mid = this.midIdx[it.proto] >= 0 && c.band > this.midIdx[it.proto];
        r.push(it.proto, mid, it.matrices, it.colors, it.count);
      }
    }
    r.end();
    this.inRange = inRange;
    this.submitted = r.submitted;
    this.dirty = false;
  }

  private refillBulbs(time: number, key: number): void {
    this.phaseKey = key;
    const fill = [0, 0, 0];
    const signalFar = this.farIdx[PROPS.findIndex((d) => d.category === 'signal')];
    for (const c of this.chunks) {
      if (!c.inView || c.band > signalFar) continue;
      for (const idx of c.signals) {
        const sb = this.signalBulbs[idx];
        const colour = signalPhase(sb.group, time);
        const src = sb.matrices[colour];
        const mesh = this.bulbs[colour];
        (mesh.instanceMatrix.array as Float32Array).set(src, fill[colour] * 16);
        fill[colour] += src.length / 16;
      }
    }
    this.litBulbs = 0;
    this.bulbs.forEach((mesh, k) => {
      mesh.count = fill[k];
      mesh.visible = fill[k] > 0;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, fill[k] * 16);
      mesh.instanceMatrix.needsUpdate = true;
      this.litBulbs += fill[k];
    });
  }

  /** Numbers for F2 / benchmarks: instances, draw calls and triangles sent, chunks in view, update cost. */
  stats(): { total: number; inRange: number; submitted: number; draws: number; triangles: number; chunks: number; chunksInView: number; updateMs: number; refills: number; litBulbs: number } {
    const r = this.renderer;
    const bulbDraws = this.bulbs.filter((b) => b.visible).length;
    return {
      total: this.json?.total ?? 0,
      inRange: this.inRange,
      submitted: this.submitted,
      draws: (r?.draws ?? 0) + bulbDraws,
      triangles: (r?.triangles ?? 0) + this.litBulbs * 10,
      chunks: this.chunks.length,
      chunksInView: this.chunksInView,
      updateMs: this.updateMs,
      refills: this.refills,
      litBulbs: this.litBulbs,
    };
  }

  /** Props per district and category as prepared. */
  counts(): Record<string, Partial<Record<PropCategory, number>>> {
    return this.json?.counts ?? {};
  }

  /** Instanced meshes with their prototype (tests). */
  meshes(): { id: string; mid: boolean; mesh: THREE.InstancedMesh }[] {
    return this.renderer?.meshes() ?? [];
  }

  dispose(): void {
    this.renderer?.dispose();
    this.catalog?.dispose();
    for (const b of this.bulbs) {
      b.dispose();
      (b.material as THREE.Material).dispose();
    }
    this.bulbs[0]?.geometry.dispose();
    this.group.removeFromParent();
  }
}
