import * as THREE from 'three';
import type { TrafficSystem } from './TrafficSystem';

export interface TrafficDebugFlags {
  lanes: boolean;
  nodes: boolean;
  targets: boolean;
  ranges: boolean;
}

/**
 * F2 traffic drawing: lane centre lines and nodes around the player (from the
 * lane network, i.e. what the AI follows), each vehicle's link to the car it
 * follows / the lane it is moving to, and its look-ahead range.
 */
export class TrafficDebugView {
  readonly group = new THREE.Group();
  readonly flags: TrafficDebugFlags = { lanes: false, nodes: false, targets: false, ranges: false };
  private readonly lanes: THREE.LineSegments;
  private readonly nodes: THREE.Points;
  private readonly links: THREE.LineSegments;
  private builtAt = -Infinity;

  constructor() {
    this.group.name = 'traffic-debug';
    this.lanes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x2ee6ff, depthTest: false, transparent: true }));
    this.nodes = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xffe14a, size: 6, sizeAttenuation: false, depthTest: false }));
    this.links = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true }));
    for (const o of [this.lanes, this.nodes, this.links]) {
      o.frustumCulled = false;
      o.renderOrder = 10;
      this.group.add(o);
    }
  }

  get anyOn(): boolean {
    return this.flags.lanes || this.flags.nodes || this.flags.targets || this.flags.ranges;
  }

  update(sys: TrafficSystem): void {
    this.group.visible = this.anyOn;
    if (!this.anyOn) return;
    const sp = sys.playerS;
    if (Math.abs(sp - this.builtAt) > 40) {
      this.builtAt = sp;
      const seg: number[] = [];
      const pts: number[] = [];
      for (const lane of sys.net.lanes) {
        const n = sys.net.nodes(lane.id, sp - 300, sp + 600, 20);
        for (let i = 0; i + 5 < n.length; i += 3) seg.push(n[i], n[i + 1] + 0.3, n[i + 2], n[i + 3], n[i + 4] + 0.3, n[i + 5]);
        for (let i = 0; i < n.length; i += 3) pts.push(n[i], n[i + 1] + 0.3, n[i + 2]);
      }
      this.lanes.geometry.dispose();
      this.lanes.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
      this.nodes.geometry.dispose();
      this.nodes.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    }
    this.lanes.visible = this.flags.lanes;
    this.nodes.visible = this.flags.nodes;
    const pos: number[] = [];
    const col: number[] = [];
    const byId = new Map(sys.vehicles.map((v) => [v.id, v]));
    for (const v of sys.vehicles) {
      if (v.tier === 2) continue;
      const p = v.pose;
      const fx = Math.sin(p.yaw);
      const fz = Math.cos(p.yaw);
      if (this.flags.ranges) {
        const r = Math.min(300, Math.max(60, v.v * 6 + 25));
        pos.push(p.x, p.y + 1.5, p.z, p.x + fx * r, p.y + 1.5, p.z + fz * r);
        col.push(0.4, 0.4, 1, 0.4, 0.4, 1);
      }
      if (this.flags.targets) {
        const lead = v.leadId >= 0 ? byId.get(v.leadId) : null;
        if (lead) {
          const close = v.leadGap < v.desiredGap;
          pos.push(p.x, p.y + 2, p.z, lead.pose.x, lead.pose.y + 2, lead.pose.z);
          col.push(close ? 1 : 0.2, close ? 0.2 : 1, 0.2, close ? 1 : 0.2, close ? 0.2 : 1, 0.2);
        }
        if (v.state === 'indicate' || v.state === 'changing' || v.state === 'aborting') {
          const target = sys.net.offsetAt(v.carriageway, v.toLane);
          const ahead = v.s + v.dir * Math.max(20, v.v * 2);
          const smp = sys.net.sample(sys.net.laneId(v.carriageway, 0), ahead, {} as never, target);
          pos.push(p.x, p.y + 2.2, p.z, smp.x, smp.y + 2.2, smp.z);
          col.push(1, 0.65, 0, 1, 0.65, 0);
        }
      }
    }
    this.links.geometry.dispose();
    this.links.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }

  dispose(): void {
    for (const o of [this.lanes, this.nodes, this.links]) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
