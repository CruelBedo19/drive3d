import type { SpeedUnit } from '../../settings/Settings';

export type AssistState = 'off' | 'on' | 'active';

export interface SpeedometerState {
  speedKmh: number;
  rpm: number;
  gear: string;
  tc: AssistState;
  abs: AssistState;
  handbrake: boolean;
}

const KMH_TO_MPH = 0.621371;
/** RPM arc: 240° sweep, gap at the bottom (SVG angles, clockwise from +x). */
const ARC_START = 150;
const ARC_SWEEP = 240;
const R = 84;

/**
 * Bottom-right cluster: RPM arc with redline zone, big digital speed, gear,
 * TC / ABS lamps and a handbrake warning. One SVG built once; per frame only
 * changed values are written.
 */
export class Speedometer {
  readonly root: HTMLElement;
  private readonly fill: SVGPathElement;
  private readonly speedEl: HTMLElement;
  private readonly unitEl: HTMLElement;
  private readonly gearEl: HTMLElement;
  private readonly tcEl: HTMLElement;
  private readonly absEl: HTMLElement;
  private readonly hbEl: HTMLElement;
  private readonly gaugeMax: number;
  private readonly redline: number;
  private unit: SpeedUnit = 'kmh';

  private last = { speed: -1, rpm: -1, gear: '', tc: '', abs: '', hb: false, red: false };

  constructor(parent: HTMLElement, redlineRpm: number) {
    this.redline = redlineRpm;
    this.gaugeMax = Math.ceil((redlineRpm * 1.1) / 1000) * 1000;
    this.root = document.createElement('div');
    this.root.className = 'hud-speedo';
    this.root.innerHTML = `
      <svg class="hud-speedo-gauge" viewBox="0 0 200 200" aria-hidden="true">
        <path class="hud-arc-track" d="${arc(0, 1)}" />
        <path class="hud-arc-red" d="${arc(this.redline / this.gaugeMax, 1)}" />
        <path class="hud-arc-fill" d="${arc(0, 1)}" pathLength="1000" stroke-dasharray="0 1000" />
        <g class="hud-arc-ticks">${this.ticks()}</g>
      </svg>
      <div class="hud-speedo-readout">
        <div class="hud-speedo-speed">0</div>
        <div class="hud-speedo-unit">km/h</div>
        <div class="hud-speedo-gear"><span>GEAR</span><b>N</b></div>
      </div>
      <div class="hud-speedo-lamps">
        <span class="hud-lamp" data-lamp="tc">TC</span>
        <span class="hud-lamp" data-lamp="abs">ABS</span>
        <span class="hud-lamp hud-lamp-warn" data-lamp="hb" data-state="off">EL FRENİ</span>
      </div>`;
    parent.appendChild(this.root);
    this.fill = this.root.querySelector('.hud-arc-fill') as SVGPathElement;
    this.speedEl = this.q('.hud-speedo-speed');
    this.unitEl = this.q('.hud-speedo-unit');
    this.gearEl = this.q('.hud-speedo-gear b');
    this.tcEl = this.q('[data-lamp="tc"]');
    this.absEl = this.q('[data-lamp="abs"]');
    this.hbEl = this.q('[data-lamp="hb"]');
  }

  setUnit(unit: SpeedUnit): void {
    this.unit = unit;
    this.unitEl.textContent = unit === 'mph' ? 'mph' : 'km/h';
    this.last.speed = -1;
  }

  update(s: SpeedometerState): void {
    const l = this.last;
    const speed = Math.round(this.unit === 'mph' ? s.speedKmh * KMH_TO_MPH : s.speedKmh);
    if (speed !== l.speed) {
      l.speed = speed;
      this.speedEl.textContent = String(speed);
    }
    const rpm = Math.round(s.rpm / 25) * 25;
    if (rpm !== l.rpm) {
      l.rpm = rpm;
      const frac = Math.min(1, Math.max(0, rpm / this.gaugeMax));
      this.fill.setAttribute('stroke-dasharray', `${(frac * 1000).toFixed(1)} 1000`);
      const red = rpm >= this.redline * 0.97;
      if (red !== l.red) {
        l.red = red;
        this.root.classList.toggle('is-redline', red);
      }
    }
    if (s.gear !== l.gear) {
      l.gear = s.gear;
      this.gearEl.textContent = s.gear;
    }
    if (s.tc !== l.tc) {
      l.tc = s.tc;
      this.tcEl.dataset.state = s.tc;
    }
    if (s.abs !== l.abs) {
      l.abs = s.abs;
      this.absEl.dataset.state = s.abs;
    }
    if (s.handbrake !== l.hb) {
      l.hb = s.handbrake;
      this.hbEl.dataset.state = s.handbrake ? 'active' : 'off';
    }
  }

  private ticks(): string {
    const out: string[] = [];
    for (let r = 0; r <= this.gaugeMax; r += 1000) {
      const a = ((ARC_START + (r / this.gaugeMax) * ARC_SWEEP) * Math.PI) / 180;
      const inner = R - 13;
      const outer = R - 7;
      const red = r >= this.redline ? ' class="is-red"' : '';
      out.push(`<line${red} x1="${(100 + Math.cos(a) * inner).toFixed(1)}" y1="${(100 + Math.sin(a) * inner).toFixed(1)}" x2="${(100 + Math.cos(a) * outer).toFixed(1)}" y2="${(100 + Math.sin(a) * outer).toFixed(1)}" />`);
    }
    return out.join('');
  }

  private q(selector: string): HTMLElement {
    const found = this.root.querySelector<HTMLElement>(selector);
    if (!found) throw new Error(`HUD element missing: ${selector}`);
    return found;
  }
}

/** SVG arc path along the gauge from fraction f0 to f1 of the sweep. */
function arc(f0: number, f1: number): string {
  const a0 = ((ARC_START + f0 * ARC_SWEEP) * Math.PI) / 180;
  const a1 = ((ARC_START + f1 * ARC_SWEEP) * Math.PI) / 180;
  const large = (f1 - f0) * ARC_SWEEP > 180 ? 1 : 0;
  const p = (a: number) => `${(100 + Math.cos(a) * R).toFixed(2)} ${(100 + Math.sin(a) * R).toFixed(2)}`;
  return `M ${p(a0)} A ${R} ${R} 0 ${large} 1 ${p(a1)}`;
}

