/**
 * How fast this PC could run the game without the display's refresh cap.
 * Browsers present frames at the monitor rate (vsync) and give JavaScript no way
 * around it, so the FPS counter tops out at 60 / 144. This measures what one
 * frame really costs: CPU time of the frame's work, and GPU time of its draw
 * calls through EXT_disjoint_timer_query_webgl2 where the browser offers it.
 * Capacity = 1000 / max(CPU ms, GPU ms) (CPU and GPU work overlap).
 */

interface TimerExt {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Smoothing of the displayed numbers (per second). */
const SMOOTHING = 3;

export class FrameTimer {
  /** Smoothed CPU time per frame, ms. */
  cpuMs = 0;
  /** Smoothed GPU time per frame, ms (0 when not measurable). */
  gpuMs = 0;
  private readonly gl: WebGL2RenderingContext | null;
  private readonly ext: TimerExt | null;
  private readonly pending: WebGLQuery[] = [];
  private readonly free: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  private start = 0;

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : null;
    this.ext = (this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) ?? null;
  }

  /** True when GPU time is measured too (otherwise capacity is CPU-only, an upper bound). */
  get hasGpuTiming(): boolean {
    return this.ext !== null;
  }

  /** Frames per second the frame cost allows, 0 until measured. */
  get capacityFps(): number {
    const ms = Math.max(this.cpuMs, this.gpuMs);
    return ms > 0 ? 1000 / ms : 0;
  }

  begin(): void {
    this.start = performance.now();
    const gl = this.gl;
    if (!gl || !this.ext || this.active) return;
    this.active = this.free.pop() ?? gl.createQuery();
    if (this.active) gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }

  end(dt: number): void {
    const cpu = performance.now() - this.start;
    const k = 1 - Math.exp(-SMOOTHING * Math.max(dt, 1 / 240));
    this.cpuMs += (cpu - this.cpuMs) * k;
    const gl = this.gl;
    if (!gl || !this.ext) return;
    if (this.active) {
      gl.endQuery(this.ext.TIME_ELAPSED_EXT);
      this.pending.push(this.active);
      this.active = null;
    }
    // Results arrive a few frames later; read every finished query, oldest first.
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pending.shift();
      if (!disjoint) {
        const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
        this.gpuMs += (ms - this.gpuMs) * k;
      }
      this.free.push(q);
    }
  }

  dispose(): void {
    if (!this.gl) return;
    for (const q of [...this.pending, ...this.free]) this.gl.deleteQuery(q);
    if (this.active) this.gl.deleteQuery(this.active);
    this.pending.length = 0;
    this.free.length = 0;
    this.active = null;
  }
}
