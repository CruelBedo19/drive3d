/**
 * Base for full-screen menu overlays. Built once, shown / hidden by the App as
 * the GameState changes. Clicks are handled by delegation on `data-action`, so
 * re-rendered content needs no new listeners.
 */
export abstract class Screen {
  readonly root: HTMLElement;
  private readonly handlers = new Map<string, (el: HTMLElement) => void>();

  protected constructor(parent: HTMLElement, className: string) {
    this.root = document.createElement('div');
    this.root.className = `screen ${className}`;
    this.root.hidden = true;
    parent.appendChild(this.root);
    this.root.addEventListener('click', this.onClick);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  show(): void {
    this.root.hidden = false;
    this.onShow();
    // Keyboard users land on the main button.
    this.root.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
  }

  hide(): void {
    if (this.root.hidden) return;
    this.root.hidden = true;
    if (document.activeElement instanceof HTMLElement && this.root.contains(document.activeElement)) document.activeElement.blur();
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
  }

  protected onShow(): void {}

  protected on(action: string, handler: (el: HTMLElement) => void): void {
    this.handlers.set(action, handler);
  }

  protected q<T extends HTMLElement = HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`screen element missing: ${selector}`);
    return el;
  }

  private readonly onClick = (e: MouseEvent): void => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el || !this.root.contains(el) || (el as HTMLButtonElement).disabled) return;
    this.handlers.get(el.dataset.action ?? '')?.(el);
  };
}

/** Escapes text for use inside innerHTML templates. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** Draws a track outline (x, z pairs) fitted into a canvas. */
export function drawOutline(canvas: HTMLCanvasElement, outline: Float32Array, closed: boolean, color = '#e8ecf1'): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || canvas.width;
  const h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    minX = Math.min(minX, outline[i]);
    maxX = Math.max(maxX, outline[i]);
    minZ = Math.min(minZ, outline[i + 1]);
    maxZ = Math.max(maxZ, outline[i + 1]);
  }
  const pad = 0.12;
  const k = Math.min((canvas.width * (1 - 2 * pad)) / (maxX - minX || 1), (canvas.height * (1 - 2 * pad)) / (maxZ - minZ || 1));
  const ox = (canvas.width - (maxX - minX) * k) / 2 - minX * k;
  const oz = (canvas.height - (maxZ - minZ) * k) / 2 - minZ * k;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.beginPath();
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i] * k + ox;
    const y = outline[i + 1] * k + oz;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  if (closed) ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 7 * dpr;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();
  // Start / finish dot.
  ctx.fillStyle = '#4fd1c5';
  ctx.beginPath();
  ctx.arc(outline[0] * k + ox, outline[1] * k + oz, 5 * dpr, 0, Math.PI * 2);
  ctx.fill();
}
