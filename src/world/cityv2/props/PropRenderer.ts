import * as THREE from 'three';
import { PROPS } from '../propKit';
import type { PropCatalog, PropPart } from './PropCatalog';

interface Level {
  parts: PropPart[];
  meshes: THREE.InstancedMesh[];
  /** Instance buffers shared by the level's parts (one copy per prototype level). */
  matrix: THREE.InstancedBufferAttribute;
  color: THREE.InstancedBufferAttribute | null;
  fill: number;
  drawn: number;
}

/**
 * Draws the props: per prototype and level one InstancedMesh per part (all
 * parts share the level's instance buffers), sized for every copy in town.
 * CityV2Props refills them with the copies in view: begin(), push() per
 * chunk and prototype (a block copy of precomputed matrices), end(). Empty
 * meshes are hidden (three would still issue a draw call for zero
 * instances). The meshes are culled by CityV2Props per chunk, so three's
 * own test (whose bounds would span the whole town) is off.
 */
export class PropRenderer {
  readonly group = new THREE.Group();
  private readonly levels: (Level | null)[][] = [];
  /** Last end(): draw calls, triangles and instances sent. */
  draws = 0;
  triangles = 0;
  submitted = 0;

  constructor(catalog: PropCatalog, totals: number[]) {
    this.group.name = 'city_v2-props';
    PROPS.forEach((def, proto) => {
      const model = catalog.models[proto];
      const n = totals[proto] ?? 0;
      const make = (parts: PropPart[] | null, lod: number): Level | null => {
        if (!parts || n === 0) return null;
        const matrix = new THREE.InstancedBufferAttribute(new Float32Array(n * 16), 16);
        matrix.setUsage(THREE.DynamicDrawUsage);
        const color = model.palette ? new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3) : null;
        color?.setUsage(THREE.DynamicDrawUsage);
        const meshes = parts.map((p, k) => {
          const mesh = new THREE.InstancedMesh(p.geometry, p.material, n);
          mesh.name = `prop-${def.id}-${lod ? 'mid' : 'near'}-${k}`;
          mesh.instanceMatrix = matrix;
          if (color) mesh.instanceColor = color;
          mesh.count = 0;
          mesh.visible = false;
          mesh.frustumCulled = false;
          mesh.castShadow = p.shadow;
          mesh.receiveShadow = !(p.material as THREE.MeshStandardMaterial).polygonOffset;
          mesh.matrixAutoUpdate = false;
          // Transparent shelters draw after the opaque world.
          if ((p.material as THREE.Material).transparent) mesh.renderOrder = 2;
          // Ground decals (paths, verges, stall lines) after the ground, like the lane markings.
          else if ((p.material as THREE.MeshStandardMaterial).polygonOffset) mesh.renderOrder = 1;
          this.group.add(mesh);
          return mesh;
        });
        return { parts, meshes, matrix, color, fill: 0, drawn: -1 };
      };
      this.levels.push([make(model.near, 0), make(model.mid, 1)]);
    });
  }

  begin(): void {
    for (const lv of this.levels) for (const l of lv) if (l) l.fill = 0;
  }

  /** Copies `count` instances (16-float matrices, 3-float colours) of a prototype level. */
  push(proto: number, mid: boolean, matrices: Float32Array, colors: Float32Array | null, count: number): void {
    const lv = this.levels[proto];
    const l = (mid ? lv[1] : null) ?? lv[0];
    if (!l || count === 0) return;
    (l.matrix.array as Float32Array).set(matrices.subarray(0, count * 16), l.fill * 16);
    if (l.color && colors) (l.color.array as Float32Array).set(colors.subarray(0, count * 3), l.fill * 3);
    l.fill += count;
  }

  end(): void {
    this.draws = 0;
    this.triangles = 0;
    this.submitted = 0;
    for (const lv of this.levels) for (const l of lv) {
      if (!l) continue;
      for (const m of l.meshes) {
        m.count = l.fill;
        m.visible = l.fill > 0;
      }
      if (l.fill > 0) {
        l.matrix.clearUpdateRanges();
        l.matrix.addUpdateRange(0, l.fill * 16);
        l.matrix.needsUpdate = true;
        if (l.color) {
          l.color.clearUpdateRanges();
          l.color.addUpdateRange(0, l.fill * 3);
          l.color.needsUpdate = true;
        }
        this.draws += l.meshes.length;
        this.submitted += l.fill;
        for (const p of l.parts) this.triangles += p.tris * l.fill;
      }
      l.drawn = l.fill;
    }
  }

  /** Meshes (for tests): every instanced mesh with its prototype id and level. */
  meshes(): { id: string; mid: boolean; mesh: THREE.InstancedMesh }[] {
    const out: { id: string; mid: boolean; mesh: THREE.InstancedMesh }[] = [];
    this.levels.forEach((lv, proto) => lv.forEach((l, k) => l?.meshes.forEach((mesh) => out.push({ id: PROPS[proto].id, mid: k === 1, mesh }))));
    return out;
  }

  dispose(): void {
    for (const lv of this.levels) for (const l of lv) for (const m of l?.meshes ?? []) m.dispose();
    this.group.removeFromParent();
  }
}
