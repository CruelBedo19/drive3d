/** Scrolling multi-channel line graph on a canvas. Fixed ring buffers, no per-frame allocation. */

export interface GraphChannel {
  label: string;
  color: string;
  /** Value that maps to the top of the graph. */
  max: number;
  /** Value that maps to the bottom (default 0). */
  min?: number;
}

export class TelemetryGraph {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly channels: GraphChannel[];
  private readonly data: Float32Array[];
  private readonly capacity: number;
  private head = 0;
  private count = 0;
  private sampleTimer = 0;
  private readonly sampleInterval: number;

  /** @param seconds visible history @param rate samples per second */
  constructor(channels: GraphChannel[], seconds = 10, rate = 30) {
    this.channels = channels;
    this.capacity = seconds * rate;
    this.sampleInterval = 1 / rate;
    this.data = channels.map(() => new Float32Array(this.capacity));
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'admin-graph';
    this.canvas.width = 640;
    this.canvas.height = 260;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  /** Records `values` (one per channel) at the graph's sample rate. */
  push(dt: number, values: ArrayLike<number>): void {
    this.sampleTimer += dt;
    if (this.sampleTimer < this.sampleInterval) return;
    this.sampleTimer = 0;
    for (let c = 0; c < this.channels.length; c++) this.data[c][this.head] = values[c];
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
  }

  clear(): void {
    this.count = 0;
    this.head = 0;
  }

  draw(): void {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    const legendH = 26;
    const plotH = h - legendH;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(10, 12, 16, 0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((plotH * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const step = w / (this.capacity - 1);
    ctx.lineWidth = 2;
    for (let c = 0; c < this.channels.length; c++) {
      const ch = this.channels[c];
      const min = ch.min ?? 0;
      const buf = this.data[c];
      ctx.strokeStyle = ch.color;
      ctx.beginPath();
      for (let i = 0; i < this.count; i++) {
        const idx = (this.head - this.count + i + this.capacity) % this.capacity;
        const t = Math.min(1, Math.max(0, (buf[idx] - min) / (ch.max - min)));
        const x = (this.capacity - this.count + i) * step;
        const y = plotH - t * (plotH - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.font = '18px ui-monospace, monospace';
    let x = 8;
    for (let c = 0; c < this.channels.length; c++) {
      const ch = this.channels[c];
      const last = this.count > 0 ? this.data[c][(this.head - 1 + this.capacity) % this.capacity] : 0;
      ctx.fillStyle = ch.color;
      const text = `${ch.label} ${last.toFixed(ch.max > 10 ? 0 : 2)}`;
      ctx.fillText(text, x, h - 7);
      x += ctx.measureText(text).width + 16;
    }
  }
}
