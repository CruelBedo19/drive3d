import type { UiSettings } from '../settings/Settings';
import { Speedometer, type SpeedometerState } from './hud/Speedometer';
import type { MapData } from './map/MapData';
import { Minimap } from './map/Minimap';

/** Seconds the controls hint stays up after loading. */
const HELP_SECONDS = 12;
const TOAST_SECONDS = 1.6;
/** Base size of the speedometer and minimap, px at 100% HUD scale. */
const PANEL_SIZE = 210;

export interface HudFrame extends SpeedometerState {
  /** Player position on the ground plane and heading, for the minimap. */
  x: number;
  z: number;
  yaw: number;
  /** m/s, for the minimap zoom. */
  speed: number;
  fps: number;
  /** FPS the measured frame cost would allow without the display cap (0 = unknown). */
  capacityFps: number;
}

/**
 * Player driving HUD: speedometer (bottom right), minimap (bottom left by
 * default), optional FPS, short notices and the data credit. The top of the
 * screen stays free for race information. Developer telemetry lives in the
 * F3 debug overlay, not here. Layout and sizes come from CSS variables, so the
 * HUD scales with the setting and the viewport.
 */
export class Hud {
  readonly root: HTMLElement;
  private readonly speedo: Speedometer;
  private readonly mapBox: HTMLElement;
  private readonly minimap: Minimap;
  private readonly fpsEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly helpEl: HTMLElement;
  private readonly creditEl: HTMLElement;
  private readonly resizeObserver: ResizeObserver;
  private settings: UiSettings | null = null;
  private visible = true;
  private lastFps = -1;
  private toastTime = 0;
  private helpTime = HELP_SECONDS;

  constructor(parent: HTMLElement, redlineRpm: number) {
    this.root = el('div', 'hud');
    this.root.style.setProperty('--hud-panel', `${PANEL_SIZE}px`);
    this.speedo = new Speedometer(this.root, redlineRpm);
    this.mapBox = el('div', 'hud-minimap');
    this.root.appendChild(this.mapBox);
    this.minimap = new Minimap(this.mapBox);
    this.fpsEl = this.add('hud-fps');
    this.toastEl = this.add('hud-toast');
    this.helpEl = this.add('hud-help');
    this.creditEl = this.add('hud-attribution');
    parent.appendChild(this.root);
    this.resizeObserver = new ResizeObserver(() => this.minimap.resize(this.mapBox.clientWidth));
    this.resizeObserver.observe(this.mapBox);
  }

  setMapData(data: MapData): void {
    this.minimap.setData(data);
  }

  /** AI traffic as minimap dots (count 0 hides them). */
  setTraffic(xz: Float32Array, flags: Uint8Array, count: number): void {
    this.minimap.setTraffic(xz, flags, count);
  }

  /** Big map in the middle of the screen (M), or back to the corner minimap. */
  setMapExpanded(on: boolean): void {
    this.minimap.expanded = on;
    this.root.classList.toggle('map-expanded', on);
  }

  get mapExpanded(): boolean {
    return this.minimap.expanded;
  }

  /** Controls hint (shown for a few seconds after loading), built from the current bindings. */
  setHelp(text: string): void {
    this.helpEl.textContent = text;
  }

  /** Data credit line (map data licences). */
  setAttribution(text: string): void {
    this.creditEl.textContent = text;
  }

  applySettings(ui: UiSettings): void {
    this.settings = ui;
    const r = this.root;
    r.style.setProperty('--hud-scale', String(ui.hudScale));
    r.classList.toggle('no-speedo', !ui.speedometer);
    r.classList.toggle('no-minimap', !ui.minimap);
    r.classList.toggle('minimap-right', ui.minimapSide === 'right');
    r.classList.toggle('no-fps', !ui.showFps);
    this.speedo.setUnit(ui.speedUnit);
    this.applyVisibility();
  }

  /** Shown only while driving (and when the HUD setting is on). */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.applyVisibility();
  }

  /** Short notice (camera change...), fades by itself. */
  showToast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('is-on');
    this.toastTime = TOAST_SECONDS;
  }

  update(dt: number, f: HudFrame): void {
    if (this.toastTime > 0) {
      this.toastTime -= dt;
      if (this.toastTime <= 0) this.toastEl.classList.remove('is-on');
    }
    if (this.helpTime > 0) {
      this.helpTime -= dt;
      if (this.helpTime <= 0) this.helpEl.classList.add('is-off');
    }
    const ui = this.settings;
    if (!ui || this.root.hidden) return;
    if (ui.speedometer) this.speedo.update(f);
    if (ui.minimap || this.minimap.expanded) this.minimap.draw(f.x, f.z, f.yaw, f.speed, ui.minimapMode, dt);
    if (ui.showFps) {
      const fps = Math.round(f.fps);
      // Capacity is rounded to 10 so the text doesn't flicker every frame.
      const cap = Math.round(f.capacityFps / 10) * 10;
      const key = fps * 100000 + cap;
      if (key !== this.lastFps) {
        this.lastFps = key;
        this.fpsEl.textContent = cap > fps ? `${fps} FPS · max ~${cap}` : `${fps} FPS`;
        this.fpsEl.title = 'Capped by display refresh. "max": the FPS this machine could reach based on frame cost.';
      }
    }
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.root.remove();
  }

  private applyVisibility(): void {
    this.root.hidden = !(this.visible && (this.settings?.hud ?? true));
  }

  private add(className: string): HTMLElement {
    const e = el('div', className);
    this.root.appendChild(e);
    return e;
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}
