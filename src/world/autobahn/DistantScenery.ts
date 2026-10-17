import * as THREE from 'three';
import { AUTOBAHN as A } from '../../config/tracks';
import type { AutobahnAssets } from './AutobahnAssets';
import { fbm, ridged } from './noise';
import { SECTION, type Frame, type RoadGenerator } from './RoadGenerator';
import type { TerrainField } from './TerrainField';

const RING_SEGMENTS = 192;
/** Silhouette layers: notional distance (m), noise scale, height, haze (0 = clear, 1 = fog colour), base colour. */
const LAYERS = [
  { distance: 9000, scale: 7000, height: 420, haze: 0.5, colour: new THREE.Color(0x35503a) },
  { distance: 16000, scale: 12000, height: 900, haze: 0.7, colour: new THREE.Color(0x4f6273) },
] as const;

/**
 * Cheap things on the horizon, no collision: two rings of hill / mountain
 * silhouettes around the camera, and a low-detail strip of road beyond the
 * loaded chunks.
 *
 * The rings stay centred on the camera (they are "at infinity"), but their
 * profile is sampled from a world-space noise at a notional distance, so it
 * changes slowly and consistently as the car travels, the same for the same
 * seed. They are drawn without scene fog and tinted towards the fog colour by
 * weather / time of day instead, so they fade out in fog and darken at night.
 *
 * The far road strip lets the road continue to the horizon past the streamed
 * chunks: asphalt, verges and a terrain apron at the landscape's own height,
 * sunk a little so the detailed chunk road always draws over it where both exist.
 */
export class DistantScenery {
  readonly group = new THREE.Group();
  private readonly gen: RoadGenerator;
  private readonly field: TerrainField;
  private readonly rings: { mesh: THREE.Mesh; material: THREE.MeshBasicMaterial; geo: THREE.BufferGeometry }[] = [];
  private readonly road: THREE.Mesh;
  private readonly roadMaterial: THREE.MeshStandardMaterial;
  private ringCentre = new THREE.Vector2(Infinity, Infinity);
  private roadS = -Infinity;
  private readonly f: Frame = { x: 0, y: 0, z: 0, heading: 0, curvature: 0, bank: 0 };
  private readonly tmp = new THREE.Color();
  private ringRadius = 3000;

  constructor(gen: RoadGenerator, field: TerrainField, assets: AutobahnAssets) {
    this.gen = gen;
    this.field = field;
    this.group.name = 'autobahn-distant';
    for (const layer of LAYERS) {
      const geo = new THREE.BufferGeometry();
      const n = RING_SEGMENTS + 1;
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
      // Darker at the foot of the range, lighter at the crest (cheap aerial shading).
      const col = new Float32Array(n * 2 * 3);
      for (let i = 0; i < n; i++) {
        col.set([0.8, 0.8, 0.8], i * 6);
        col.set([1.1, 1.1, 1.12], i * 6 + 3);
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const idx: number[] = [];
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = i * 2;
        // Faces inwards (seen from the centre).
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
      }
      geo.setIndex(idx);
      const material = new THREE.MeshBasicMaterial({ color: layer.colour, vertexColors: true, fog: false, side: THREE.DoubleSide, depthWrite: true });
      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      mesh.renderOrder = -1;
      mesh.name = 'horizon-ring';
      this.group.add(mesh);
      this.rings.push({ mesh, material, geo });
    }
    this.roadMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 6, map: assets.terrain.map });
    this.road = new THREE.Mesh(new THREE.BufferGeometry(), this.roadMaterial);
    this.road.name = 'far-road';
    this.road.receiveShadow = false;
    this.group.add(this.road);
  }

  /** Silhouette count + far road rows (F2). */
  get objectCount(): number {
    return this.rings.length + 1;
  }

  /**
   * @param cam camera position; @param sNear player road distance;
   * @param fogColor current fog colour; @param visibility weather visibility (1 clear);
   * @param far camera far plane (the rings sit just inside it).
   */
  update(cam: THREE.Vector3, sNear: number, fogColor: THREE.Color, visibility: number, far: number): void {
    this.ringRadius = far * 0.93;
    if (Math.hypot(cam.x - this.ringCentre.x, cam.z - this.ringCentre.y) > 150 || Math.abs(this.rings[0].mesh.userData.radius - this.ringRadius) > 1) this.buildRings(cam);
    for (const r of this.rings) r.mesh.position.set(cam.x, cam.y, cam.z);
    LAYERS.forEach((layer, i) => {
      // Haze: the layer's own air, thicker when visibility drops; fully fog-coloured in thick fog.
      const k = 1 - (1 - layer.haze) * Math.min(1, Math.max(0, visibility)) ** 1.5;
      this.rings[i].material.color.copy(this.tmp.copy(layer.colour).lerp(fogColor, k));
    });
    if (Math.abs(sNear - this.roadS) > 200) this.buildRoad(sNear);
  }

  dispose(): void {
    for (const r of this.rings) {
      r.geo.dispose();
      r.material.dispose();
    }
    this.road.geometry.dispose();
    this.roadMaterial.dispose();
    this.group.removeFromParent();
  }

  private buildRings(cam: THREE.Vector3): void {
    this.ringCentre.set(cam.x, cam.z);
    const R = this.ringRadius;
    LAYERS.forEach((layer, li) => {
      const pos = this.rings[li].geo.attributes.position as THREE.BufferAttribute;
      const seed = this.gen.seed + 101 + li * 17;
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = Math.cos(a);
        const wx = cam.x + dx * layer.distance;
        const wz = cam.z + dz * layer.distance;
        // Ranges come and go (mask) so the horizon is not one endless wall.
        const mask = 0.25 + 0.75 * Math.max(0, fbm(seed, wx / (layer.scale * 3), wz / (layer.scale * 3), 2) + 0.35);
        const h = (ridged(seed, wx / layer.scale, wz / layer.scale, 4) * layer.height + 60) * mask;
        // Apparent height: the angle the ridge would subtend from the camera, at the ring radius.
        const top = (h * R) / layer.distance;
        pos.setXYZ(i * 2, dx * R, -R * 0.06, dz * R);
        pos.setXYZ(i * 2 + 1, dx * R, Math.max(R * 0.004, top - 40 * (R / layer.distance)), dz * R);
      }
      pos.needsUpdate = true;
      this.rings[li].geo.computeBoundingSphere();
      this.rings[li].mesh.userData.radius = R;
    });
  }

  private buildRoad(sNear: number): void {
    this.roadS = sNear;
    const fr = A.world.farRoad;
    const gen = this.gen;
    const s0 = Math.max(0, sNear - fr.behind);
    const s1 = sNear + fr.ahead;
    gen.ensure(s1 + 50);
    const o = gen.frame(sNear, this.f);
    const ox = o.x;
    const oy = o.y;
    const oz = o.z;
    // Columns across: terrain apron, verge, asphalt …, mirrored.
    const E = SECTION.edge;
    const offs = [-(E + 30), -E, -SECTION.roadHalf, SECTION.roadHalf, E, E + 30];
    const rows = Math.floor((s1 - s0) / fr.step) + 1;
    const pos = new Float32Array(rows * offs.length * 3);
    const col = new Float32Array(rows * offs.length * 3);
    const uv = new Float32Array(rows * offs.length * 2);
    const c: [number, number, number] = [0, 0, 0];
    let v = 0;
    for (let r = 0; r < rows; r++) {
      const s = s0 + r * fr.step;
      const f = gen.frame(s, this.f);
      const cos = Math.cos(f.heading);
      const sin = Math.sin(f.heading);
      const fx = f.x;
      const fz = f.z;
      const fh = f.heading;
      for (const off of offs) {
        const x = fx + cos * off;
        const z = fz - sin * off;
        const apron = Math.abs(off) > E + 1;
        let y: number;
        if (apron) {
          y = gen.terrainHeight(s, off) - 0.6;
          this.field.colour(x, z, gen.weights, 1, 0.3, off, c, 0);
        } else {
          gen.frame(s, this.f);
          this.f.heading = fh;
          y = gen.surfaceY(this.f, off) - 0.25;
          const asphalt = Math.abs(off) <= SECTION.roadHalf + 0.01;
          c[0] = c[1] = c[2] = asphalt ? 0.2 : 0.33;
        }
        pos[v * 3] = x - ox;
        pos[v * 3 + 1] = y - oy;
        pos[v * 3 + 2] = z - oz;
        col.set(c, v * 3);
        uv[v * 2] = off / 12;
        uv[v * 2 + 1] = s / 12;
        v++;
      }
    }
    const idx: number[] = [];
    const cols = offs.length;
    for (let r = 0; r < rows - 1; r++) {
      for (let k = 0; k < cols - 1; k++) {
        const a = r * cols + k;
        idx.push(a, a + cols, a + 1, a + 1, a + cols, a + cols + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    this.road.geometry.dispose();
    this.road.geometry = geo;
    this.road.position.set(ox, oy, oz);
  }
}
