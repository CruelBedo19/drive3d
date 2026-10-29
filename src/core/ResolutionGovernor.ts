/** Frames slower than the budget by this factor count as slow (60 Hz budget: 20 ms, under 50 FPS). */
const SLOW = 1.2;
/** Each step draws this share of the pixels per axis of the step before. */
const STEP = 0.85;
/** Lowest share of the set resolution. */
const MIN = 0.55;
/** Seconds of slow frames before a step down. */
const DOWN_AFTER = 1.5;
/** Seconds of spare time before a step up, doubled (up to the max) each time a step up had to be undone. */
const UP_AFTER = 4;
const UP_AFTER_MAX = 60;

/**
 * Dynamic resolution: when frames take too long because of drawing (not the game's own CPU work, which fewer pixels
 * would not help), the 3D view is drawn at fewer pixels in steps, down to MIN; with time to spare it steps back up.
 * On a screen that caps the frame rate, spare GPU time cannot be seen without timer queries, so after a step up that
 * had to be undone it waits twice as long before the next try (no see-sawing).
 */
export class ResolutionGovernor {
  /** Share of the set resolution to draw, MIN..1. */
  scale = 1;
  private frameMs = 16.7;
  private slowFor = 0;
  private spareFor = 0;
  private upAfter = UP_AFTER;
  private sinceUp = Infinity;

  /**
   * One frame: its length (s), the smoothed CPU and GPU time of a frame (ms, GPU 0 when not measurable) and the
   * frame budget (ms: the FPS limit's, or 60 Hz). Returns the scale to draw at.
   */
  update(dt: number, cpuMs: number, gpuMs: number, budgetMs: number): number {
    // Pauses, tab switches, loading hitches: not a frame rate.
    if (dt <= 0 || dt > 0.25) return this.scale;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
    this.sinceUp += dt;
    const drawBound = gpuMs > 0 ? gpuMs > cpuMs : this.frameMs - cpuMs > 4;
    this.slowFor = this.frameMs > budgetMs * SLOW && drawBound ? this.slowFor + dt : 0;
    if (this.slowFor > DOWN_AFTER && this.scale > MIN) {
      if (this.sinceUp < 10) this.upAfter = Math.min(UP_AFTER_MAX, this.upAfter * 2);
      this.scale = Math.max(MIN, Math.round(this.scale * STEP * 100) / 100);
      this.slowFor = 0;
      this.spareFor = 0;
      return this.scale;
    }
    const spare = gpuMs > 0 ? Math.max(gpuMs, cpuMs) < budgetMs * 0.65 : this.frameMs < budgetMs * 1.05;
    this.spareFor = spare && this.scale < 1 ? this.spareFor + dt : 0;
    if (this.spareFor > this.upAfter) {
      this.scale = Math.min(1, Math.round((this.scale / STEP) * 100) / 100);
      this.spareFor = 0;
      this.sinceUp = 0;
    }
    return this.scale;
  }

  reset(): void {
    this.scale = 1;
    this.slowFor = 0;
    this.spareFor = 0;
    this.upAfter = UP_AFTER;
    this.sinceUp = Infinity;
  }
}
