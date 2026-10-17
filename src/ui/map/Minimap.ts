import type { MinimapMode } from '../../settings/Settings';
import type { MapData, MapMarker, MapPath } from './MapData';

export interface MinimapView {
  /** Player position on the ground plane, m. */
  x: number;
  z: number;
  /** Player heading, rad (vehicle yaw: forward = (sin yaw, cos yaw) in x, z). */
  yaw: number;
  mode: MinimapMode;
  /** Metres from the centre to the edge. */
  radius: number;
  /** Canvas size in pixels (square). */
  size: number;
}

/** In rotating mode the player sits lower on the map, so more of the road ahead is visible. */
export const ROTATING_CENTER_Y = 0.62;

/** Player position on the canvas, px. */
export function minimapCenter(v: Pick<MinimapView, 'mode' | 'size'>): [number, number] {
  return [v.size / 2, v.size * (v.mode === 'rotating' ? ROTATING_CENTER_Y : 0.5)];
}

/**
 * World (x, z) → canvas pixels as a 2D affine [a, b, c, d, e, f] (canvas
 * setTransform order). The player is at minimapCenter(). Fixed: north (-z) up.
 * Rotating: the player's heading points up, the car's right is screen right.
 */
export function minimapTransform(v: MinimapView): [number, number, number, number, number, number] {
  const k = v.size / 2 / v.radius;
  let a: number, b: number, c: number, d: number;
  if (v.mode === 'rotating') {
    const s = Math.sin(v.yaw);
    const co = Math.cos(v.yaw);
    // Rows: screen right = car right (-cos, sin), screen down = backwards (-sin, -cos).
    a = -k * co;
    c = k * s;
    b = -k * s;
    d = -k * co;
  } else {
    a = k;
    b = 0;
    c = 0;
    d = k;
  }
  const [hx, hy] = minimapCenter(v);
  return [a, b, c, d, hx - (a * v.x + c * v.z), hy - (b * v.x + d * v.z)];
}

/** Direction of the player arrow on screen, rad clockwise from straight up. */
export function arrowAngle(v: Pick<MinimapView, 'yaw' | 'mode'>): number {
  return v.mode === 'rotating' ? 0 : Math.atan2(Math.sin(v.yaw), -Math.cos(v.yaw));
}

const STYLE = {
  background: 'rgba(12, 14, 18, 0.62)',
  trackEdge: 'rgba(0, 0, 0, 0.55)',
  track: '#c9ced6',
  road: '#9aa1ab',
  area: 'rgba(201, 206, 214, 0.35)',
  route: '#4fd1c5',
  player: '#4fd1c5',
  start: '#ffffff',
};
const MIN_PATH_PX = 3;
/** Zoom out with speed: radius grows by this fraction at SPEED_ZOOM_FULL m/s. */
const SPEED_ZOOM = 0.6;
const SPEED_ZOOM_FULL = 60;

/**
 * Canvas minimap. Paths are turned into Path2D once (in world metres); each
 * frame only sets a transform and strokes them, then draws the markers and the
 * player arrow. No DOM nodes per map feature, no 3D render.
 */
export class Minimap {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private data: MapData | null = null;
  private paths: { path: MapPath; shape: Path2D }[] = [];
  private pixelSize = 0;
  private radius = 0;
  private readonly view: MinimapView = { x: 0, z: 0, yaw: 0, mode: 'rotating', radius: 100, size: 100 };

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'hud-minimap-canvas';
    parent.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  setData(data: MapData): void {
    this.data = data;
    this.radius = data.viewRadius;
    this.paths = data.paths.map((path) => {
      const shape = new Path2D();
      const p = path.points;
      shape.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) shape.lineTo(p[i], p[i + 1]);
      if (path.closed) shape.closePath();
      return { path, shape };
    });
  }

  /** Call when the element's CSS size may have changed. */
  resize(cssSize: number): void {
    const px = Math.max(16, Math.round(cssSize * Math.min(2, window.devicePixelRatio || 1)));
    if (px === this.pixelSize) return;
    this.pixelSize = px;
    this.canvas.width = px;
    this.canvas.height = px;
  }

  draw(x: number, z: number, yaw: number, speed: number, mode: MinimapMode, dt: number): void {
    const data = this.data;
    if (!data || this.pixelSize === 0) return;
    const wanted = data.viewRadius * (1 + SPEED_ZOOM * Math.min(1, Math.abs(speed) / SPEED_ZOOM_FULL));
    this.radius += (wanted - this.radius) * (1 - Math.exp(-2 * dt));
    const v = this.view;
    v.x = x;
    v.z = z;
    v.yaw = yaw;
    v.mode = mode;
    v.radius = this.radius;
    v.size = this.pixelSize;

    const ctx = this.ctx;
    const size = this.pixelSize;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = STYLE.background;
    ctx.fillRect(0, 0, size, size);

    const t = minimapTransform(v);
    const k = size / 2 / v.radius;
    ctx.setTransform(t[0], t[1], t[2], t[3], t[4], t[5]);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const { path, shape } of this.paths) {
      const w = Math.max(MIN_PATH_PX, path.width * k) / k;
      if (path.kind === 'area') {
        ctx.fillStyle = STYLE.area;
        ctx.fill(shape);
        continue;
      }
      ctx.strokeStyle = STYLE.trackEdge;
      ctx.lineWidth = w + 2 / k;
      ctx.stroke(shape);
      ctx.strokeStyle = path.kind === 'route' ? STYLE.route : path.kind === 'road' ? STYLE.road : STYLE.track;
      ctx.lineWidth = w;
      ctx.stroke(shape);
    }
    for (const m of data.markers) this.drawMarker(m, k, size);

    // Player arrow.
    const [px, py] = minimapCenter(v);
    ctx.setTransform(1, 0, 0, 1, px, py);
    ctx.rotate(arrowAngle(v));
    const s = size * 0.055;
    ctx.beginPath();
    ctx.moveTo(0, -s * 1.4);
    ctx.lineTo(s, s);
    ctx.lineTo(0, s * 0.45);
    ctx.lineTo(-s, s);
    ctx.closePath();
    ctx.fillStyle = STYLE.player;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.lineWidth = Math.max(1, size * 0.008);
    ctx.fill();
    ctx.stroke();

    if (mode === 'rotating') this.drawNorth(v, size);
  }

  private drawMarker(m: MapMarker, k: number, size: number): void {
    const ctx = this.ctx;
    if (m.kind === 'start') {
      // Start / finish: a bar across the track.
      ctx.save();
      ctx.translate(m.x, m.z);
      ctx.rotate(-(m.yaw ?? 0));
      const half = Math.max(size * 0.05, 6) / k;
      ctx.fillStyle = STYLE.start;
      ctx.fillRect(-half, -1.2 / k, half * 2, 2.4 / k);
      ctx.restore();
      return;
    }
    ctx.beginPath();
    ctx.arc(m.x, m.z, (size * 0.02) / k, 0, Math.PI * 2);
    ctx.fillStyle = STYLE.route;
    ctx.fill();
  }

  /** Small "N" on the rim, pointing to north (-z) in rotating mode. */
  private drawNorth(v: MinimapView, size: number): void {
    const ctx = this.ctx;
    const t = minimapTransform({ ...v, x: 0, z: 0 });
    // Screen direction of world north (0, -1) without translation.
    const dx = -t[2];
    const dy = -t[3];
    const len = Math.hypot(dx, dy) || 1;
    const r = size / 2 - size * 0.08;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Placed on a circle around the canvas centre (not the player), so it stays inside.
    ctx.font = `600 ${Math.round(size * 0.075)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(244, 246, 248, 0.75)';
    ctx.fillText('N', size / 2 + (dx / len) * r, size / 2 + (dy / len) * r);
  }
}
