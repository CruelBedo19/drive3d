/** Frames per second averaged over a short window. */
export class FpsCounter {
  fps = 0;
  /** Average frame time over the last window, ms. */
  frameMs = 0;
  private frames = 0;
  private elapsed = 0;
  private readonly window: number;

  constructor(windowSeconds = 0.5) {
    this.window = windowSeconds;
  }

  tick(dt: number): void {
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed >= this.window) {
      this.fps = this.frames / this.elapsed;
      this.frameMs = (this.elapsed / this.frames) * 1000;
      this.frames = 0;
      this.elapsed = 0;
    }
  }
}
