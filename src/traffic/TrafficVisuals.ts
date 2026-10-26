import * as THREE from 'three';
import { TRAFFIC, TRAFFIC_CLASSES, type TrafficClassId } from '../config/traffic';
import { trafficModel } from './TrafficModelLibrary';
import { buildTrafficModel, modelLamps, type LampLayout, type TrafficModel } from './TrafficModels';
import type { TrafficVehicle } from './TrafficVehicle';

/** Most vehicles of one class, and glow points for all classes together (vehicles × 8). */
const CAPACITY = 100;
const GLOW_VEHICLES = 128;
/** Most vehicles drawn with one shared far stand-in (all classes together). */
const FAR_CAPACITY = 128;
const WHEELS_MAX = CAPACITY * 10;
const CLASS_IDS = Object.keys(TRAFFIC_CLASSES) as TrafficClassId[];
const hasDom = typeof document !== 'undefined';

const HEAD_ON = new THREE.Color(1, 0.97, 0.88);
const HEAD_OFF = new THREE.Color(0.5, 0.52, 0.55);
const TAIL_OFF = new THREE.Color(0.22, 0.02, 0.02);
const TAIL_ON = new THREE.Color(0.6, 0.04, 0.03);
const BRAKE = new THREE.Color(1, 0.08, 0.06);
const IND_OFF = new THREE.Color(0.3, 0.17, 0.04);
const IND_ON = new THREE.Color(1, 0.62, 0.06);

/** One way of drawing a class: instanced body parts plus (built-in shapes) switchable lamp meshes. */
interface DrawSet {
  /** Built-in shape (owned, disposed here); null for a prepared model (shared, never disposed here). */
  shape: TrafficModel | null;
  /** One body for a built-in shape (paint per instance), one per material for a prepared model. */
  bodies: THREE.InstancedMesh[];
  lamps: THREE.InstancedMesh[];
  head: THREE.InstancedMesh | null;
  tail: THREE.InstancedMesh | null;
  indLeft: THREE.InstancedMesh | null;
  indRight: THREE.InstancedMesh | null;
  painted: boolean;
  /** Instances written this frame. */
  count: number;
}

interface ClassMeshes {
  lamps: LampLayout;
  /** Near (or only) look: the prepared model, else the built-in shape. */
  near: DrawSet;
  /** Prepared models only: the light built-in shape used beyond MODEL_LOD_DISTANCE. */
  far: DrawSet | null;
  /** Vehicles in slot order (dense: 0..count-1). */
  slots: TrafficVehicle[];
}

/**
 * Beyond this distance from the camera a prepared model is drawn as a low-poly stand-in of its own size and
 * colour (body, cabin glass, wheels, working lamps): a few pixels tall there, and ~20× fewer triangles. The band
 * around it keeps a vehicle from switching back and forth at the edge.
 */
const MODEL_LOD_DISTANCE = 110;
const MODEL_LOD_BAND = 10;

/**
 * Draws all traffic with a handful of instanced meshes: per class a body
 * (instance colour = paint), headlights, tail / brake lights and indicators
 * (instance colour = lamp state), one shared wheel mesh, and one point cloud
 * of lamp glows for the dark. No per-vehicle lights: only the few vehicles
 * nearest the camera at night borrow a pooled, shadowless spot light, so the
 * shader's light count never changes.
 */
export class TrafficVisuals {
  readonly group = new THREE.Group();
  private readonly classes = new Map<TrafficClassId, ClassMeshes>();
  /** Far stand-ins shared by every prepared model (scaled per instance to its size): one for cars, one for tall vehicles. */
  private readonly farSets: Record<'car' | 'van', DrawSet>;
  /** Where the stand-ins take over, m (debug / comparisons may move it). */
  lodDistance = MODEL_LOD_DISTANCE;
  /** Vehicles currently drawn as a stand-in (hysteresis). */
  private readonly farNow = new WeakSet<TrafficVehicle>();
  private readonly ms = new THREE.Matrix4();
  private readonly sc = new THREE.Vector3();
  private readonly wheels: THREE.InstancedMesh;
  private readonly wheelGeo: THREE.CylinderGeometry;
  private readonly wheelMat: THREE.MeshStandardMaterial;
  private readonly bodyMat: THREE.MeshStandardMaterial;
  /** The far stand-ins' body: less metallic than the built-in shapes, so the paint reads as the model's does. */
  private readonly standInMat: THREE.MeshStandardMaterial;
  private readonly lampMat: THREE.MeshBasicMaterial;
  private readonly glow: THREE.Points;
  private readonly glowGeo: THREE.BufferGeometry;
  private readonly glowMat: THREE.PointsMaterial;
  private readonly glowTex: THREE.Texture | null;
  private readonly spots: THREE.SpotLight[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly mw = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly p = new THREE.Vector3();
  private readonly s1 = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();
  private readonly lp = new THREE.Vector3();

  constructor() {
    this.group.name = 'traffic';
    this.bodyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, metalness: 0.35 });
    this.lampMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.standInMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.12 });
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], shadow: boolean, color: boolean, capacity = CAPACITY) => {
      const mesh = new THREE.InstancedMesh(geo, mat, capacity);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = shadow;
      mesh.receiveShadow = shadow;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      if (color) {
        mesh.setColorAt(0, this.c.set(0xffffff));
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      }
      this.group.add(mesh);
      return mesh;
    };
    const shapeSet = (id: TrafficClassId, capacity = CAPACITY, bodyMat = this.bodyMat): DrawSet => {
      const shape = buildTrafficModel(id);
      const head = mk(shape.head, this.lampMat, false, true, capacity);
      const tail = mk(shape.tail, this.lampMat, false, true, capacity);
      const indLeft = mk(shape.indLeft, this.lampMat, false, true, capacity);
      const indRight = mk(shape.indRight, this.lampMat, false, true, capacity);
      return { shape, bodies: [mk(shape.body, bodyMat, true, true, capacity)], lamps: [head, tail, indLeft, indRight], head, tail, indLeft, indRight, painted: true, count: 0 };
    };
    this.farSets = { car: shapeSet('car', FAR_CAPACITY, this.standInMat), van: shapeSet('van', FAR_CAPACITY, this.standInMat) };
    for (const id of CLASS_IDS) {
      const klass = TRAFFIC_CLASSES[id];
      const parts = klass.model ? trafficModel(klass.model) : undefined;
      if (parts && parts.length) {
        const near: DrawSet = { shape: null, bodies: parts.map((p) => mk(p.geometry, p.material, true, false)), lamps: [], head: null, tail: null, indLeft: null, indRight: null, painted: false, count: 0 };
        // Drawn as the model at every distance (no box stand-ins).
        this.classes.set(id, { lamps: modelLamps(id), near, far: null, slots: [] });
      } else {
        const near = shapeSet(id);
        this.classes.set(id, { lamps: klass.model ? modelLamps(id) : near.shape!.lamps, near, far: null, slots: [] });
      }
    }
    this.wheelGeo = new THREE.CylinderGeometry(1, 1, 1, 12);
    this.wheelGeo.rotateZ(Math.PI / 2);
    this.wheelMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.85 });
    this.wheels = new THREE.InstancedMesh(this.wheelGeo, this.wheelMat, WHEELS_MAX);
    this.wheels.count = 0;
    this.wheels.frustumCulled = false;
    this.wheels.castShadow = true;
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this.wheels);
    // Lamp glows: 8 points per vehicle (2 head, 2 tail, 4 indicators); black = off (additive).
    this.glowGeo = new THREE.BufferGeometry();
    this.glowGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(GLOW_VEHICLES * 8 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(GLOW_VEHICLES * 8 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.glowGeo.setDrawRange(0, 0);
    this.glowTex = hasDom ? glowTexture() : null;
    this.glowMat = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: true, vertexColors: true, map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.glow = new THREE.Points(this.glowGeo, this.glowMat);
    this.glow.frustumCulled = false;
    this.glow.renderOrder = 2;
    this.group.add(this.glow);
    for (let i = 0; i < TRAFFIC.realLights; i++) {
      const spot = new THREE.SpotLight(0xfff1d8, 0, 70, 0.5, 0.6, 1.5);
      spot.castShadow = false;
      this.group.add(spot, spot.target);
      this.spots.push(spot);
    }
  }

  add(v: TrafficVehicle): void {
    const c = this.classes.get(v.classId)!;
    v.slot = c.slots.length;
    c.slots.push(v);
  }

  remove(v: TrafficVehicle): void {
    const c = this.classes.get(v.classId)!;
    const last = c.slots.pop()!;
    if (last !== v) {
      c.slots[v.slot] = last;
      last.slot = v.slot;
    }
    v.slot = -1;
  }

  /**
   * @param alpha interpolation between the last two simulation steps
   * @param time seconds (indicator blink)
   * @param camera camera position (real lights go to the nearest lit vehicles)
   * @param dark 0..1 how dark it is (glow strength)
   */
  update(alpha: number, time: number, camera: THREE.Vector3, dark: number): void {
    const blink = Math.floor(time * 2.8) % 2 === 0;
    let w = 0;
    let g = 0;
    const gp = this.glowGeo.attributes.position as THREE.BufferAttribute;
    const gc = this.glowGeo.attributes.color as THREE.BufferAttribute;
    const lit: { v: TrafficVehicle; d: number }[] = [];
    const inSq = (this.lodDistance - MODEL_LOD_BAND) ** 2;
    const outSq = (this.lodDistance + MODEL_LOD_BAND) ** 2;
    this.farSets.car.count = 0;
    this.farSets.van.count = 0;
    for (const [id, cm] of this.classes) {
      const n = cm.slots.length;
      cm.near.count = 0;
      if (cm.far) cm.far.count = 0;
      const k = TRAFFIC_CLASSES[id];
      const L = cm.lamps;
      // The stand-in for this class (prepared models only), its size relative to the built-in shape, its wheels.
      const standIn = k.model && !cm.near.shape ? (k.heavy || k.height > 1.8 ? 'van' : 'car') : null;
      const base = standIn ? TRAFFIC_CLASSES[standIn] : k;
      const sx = k.width / base.width;
      const sy = k.height / base.height;
      const sz = k.length / base.length;
      for (let i = 0; i < n; i++) {
        const v = cm.slots[i];
        const a = v.prev;
        const b = v.pose;
        const t = alpha;
        this.p.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
        let dy = b.yaw - a.yaw;
        if (dy > Math.PI) dy -= Math.PI * 2;
        else if (dy < -Math.PI) dy += Math.PI * 2;
        this.e.set(a.pitch + (b.pitch - a.pitch) * t, a.yaw + dy * t, a.roll + (b.roll - a.roll) * t, 'YXZ');
        this.q.setFromEuler(this.e);
        this.m.compose(this.p, this.q, this.s1);
        let far = false;
        if (standIn) {
          const d2 = this.p.distanceToSquared(camera);
          far = this.farNow.has(v) ? d2 > inSq : d2 > outSq;
          if (far) this.farNow.add(v);
          else this.farNow.delete(v);
        }
        const set = far ? this.farSets[standIn!] : cm.near;
        if (set.count >= (far ? FAR_CAPACITY : CAPACITY)) continue;
        const j = set.count++;
        // The stand-in is the built-in shape stretched to this model's size.
        const mm = far ? this.ms.copy(this.m).scale(this.sc.set(sx, sy, sz)) : this.m;
        for (const m of set.bodies) m.setMatrixAt(j, mm);
        for (const m of set.lamps) m.setMatrixAt(j, mm);
        if (set.painted) set.bodies[0].setColorAt(j, this.c.set(v.paint));
        const hazard = v.indicator === 2;
        const leftOn = blink && (v.indicator === 1 || hazard);
        const rightOn = blink && (v.indicator === -1 || hazard);
        set.head?.setColorAt(j, v.headlights ? HEAD_ON : HEAD_OFF);
        set.tail?.setColorAt(j, v.brake ? BRAKE : v.headlights ? TAIL_ON : TAIL_OFF);
        set.indLeft?.setColorAt(j, leftOn ? IND_ON : IND_OFF);
        set.indRight?.setColorAt(j, rightOn ? IND_ON : IND_OFF);
        // Wheels: near / medium only (far ones are a few pixels); prepared models have theirs in the model, stand-ins need them.
        const wheels = far ? base : k;
        const wr = far ? base.wheelRadius * sy : k.wheelRadius;
        if ((v.tier < 2 || far) && w + wheels.axles.length * 2 <= WHEELS_MAX) {
          for (const az of wheels.axles) {
            const z = far ? az * sz : az;
            for (const side of [1, -1]) {
              this.mw.makeRotationX(v.wheelAngle);
              this.mw.scale(this.lp.set(0.26, wr, wr));
              this.mw.setPosition(side * (k.width / 2 - 0.13), wr, z);
              this.mw.premultiply(this.m);
              this.wheels.setMatrixAt(w++, this.mw);
            }
          }
        }
        // Glows.
        if (g + 8 <= GLOW_VEHICLES * 8) {
          // Prepared models have no switchable lamp meshes: their glows show by day too.
          const day = set.shape ? 0 : 0.35;
          const head = v.headlights ? Math.max(dark, day * 0.6) : 0;
          const tail = v.brake ? 0.9 + day : v.headlights ? 0.45 * Math.max(dark, day) : 0;
          const put = (lx: number, ly: number, lz: number, r: number, gg: number, bb: number) => {
            this.lp.set(lx, ly, lz).applyMatrix4(this.m);
            gp.setXYZ(g, this.lp.x, this.lp.y, this.lp.z);
            gc.setXYZ(g, r, gg, bb);
            g++;
          };
          put(L.head[0], L.head[1], L.head[2] + 0.1, head, head * 0.95, head * 0.8);
          put(-L.head[0], L.head[1], L.head[2] + 0.1, head, head * 0.95, head * 0.8);
          put(L.tail[0], L.tail[1], L.tail[2] - 0.1, tail, tail * 0.06, tail * 0.04);
          put(-L.tail[0], L.tail[1], L.tail[2] - 0.1, tail, tail * 0.06, tail * 0.04);
          const il = leftOn ? 0.8 : 0;
          const ir = rightOn ? 0.8 : 0;
          put(L.indFront[0], L.indFront[1], L.indFront[2] + 0.1, il, il * 0.55, 0);
          put(L.indRear[0], L.indRear[1], L.indRear[2] - 0.1, il, il * 0.55, 0);
          put(-L.indFront[0], L.indFront[1], L.indFront[2] + 0.1, ir, ir * 0.55, 0);
          put(-L.indRear[0], L.indRear[1], L.indRear[2] - 0.1, ir, ir * 0.55, 0);
        }
        if (v.headlights && dark > 0.3) lit.push({ v, d: this.p.distanceToSquared(camera) });
      }
      for (const set of cm.far ? [cm.near, cm.far] : [cm.near]) this.commit(set);
    }
    this.commit(this.farSets.car);
    this.commit(this.farSets.van);
    this.wheels.count = w;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.glowGeo.setDrawRange(0, g);
    gp.needsUpdate = true;
    gc.needsUpdate = true;
    // Real light for the nearest lit vehicles (within 120 m), the rest glow only.
    lit.sort((x, y) => x.d - y.d);
    this.spots.forEach((spot, i) => {
      const item = lit[i];
      if (!item || item.d > 120 * 120) {
        spot.intensity = 0;
        return;
      }
      const pose = item.v.pose;
      const fx = Math.sin(pose.yaw);
      const fz = Math.cos(pose.yaw);
      const front = item.v.klass.length / 2;
      spot.position.set(pose.x + fx * front, pose.y + 0.8, pose.z + fz * front);
      spot.target.position.set(pose.x + fx * (front + 25), pose.y - 0.5, pose.z + fz * (front + 25));
      spot.intensity = 120 * dark;
    });
  }

  private commit(set: DrawSet): void {
    for (const mesh of [...set.bodies, ...set.lamps]) {
      mesh.count = set.count;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  /** Vehicles drawn as the model / as a stand-in in the last update (F2, tests). */
  get drawnStandIns(): number {
    return this.farSets.car.count + this.farSets.van.count;
  }

  dispose(): void {
    for (const set of [this.farSets.car, this.farSets.van]) {
      for (const g of [set.shape!.body, set.shape!.head, set.shape!.tail, set.shape!.indLeft, set.shape!.indRight]) g.dispose();
      for (const m of [...set.bodies, ...set.lamps]) m.dispose();
    }
    for (const c of this.classes.values()) {
      for (const set of c.far ? [c.near, c.far] : [c.near]) {
        if (set.shape) for (const g of [set.shape.body, set.shape.head, set.shape.tail, set.shape.indLeft, set.shape.indRight]) g.dispose();
        for (const m of [...set.bodies, ...set.lamps]) m.dispose();
      }
    }
    this.wheels.dispose();
    this.wheelGeo.dispose();
    this.wheelMat.dispose();
    this.bodyMat.dispose();
    this.standInMat.dispose();
    this.lampMat.dispose();
    this.glowGeo.dispose();
    this.glowMat.dispose();
    this.glowTex?.dispose();
    for (const s of this.spots) s.dispose();
    this.group.removeFromParent();
  }
}

/** Soft round glow sprite. */
function glowTexture(): THREE.Texture | null {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
