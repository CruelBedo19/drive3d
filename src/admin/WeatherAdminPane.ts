import type { WeatherKind } from '../settings/Profile';
import { WEATHER_KINDS } from '../settings/Profile';
import type { WeatherManager } from '../world/weather/WeatherManager';
import { DEFAULT_TUNING, type WeatherTuning } from '../world/weather/WeatherState';

const LABELS: Record<WeatherKind, string> = { clear: 'Açık', cloudy: 'Bulutlu', rain: 'Yağmurlu', heavyRain: 'Yoğun yağmur', fog: 'Sisli' };

interface Slider {
  key: keyof WeatherTuning | 'hour' | 'timeRate';
  label: string;
  min: number;
  max: number;
  step: number;
  /** Overrides: unchecked = follow the weather (null). */
  override?: boolean;
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SLIDERS: Slider[] = [
  { key: 'hour', label: 'Saat', min: 0, max: 23.99, step: 0.05, format: (v) => `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.floor((v % 1) * 60)).padStart(2, '0')}` },
  { key: 'timeRate', label: 'Zaman akışı (saat / dk)', min: 0, max: 6, step: 0.25, format: (v) => (v === 0 ? 'durdu' : `${v}`) },
  { key: 'sunIntensity', label: 'Güneş şiddeti', min: 0, max: 2.5, step: 0.05, format: pct },
  { key: 'ambientIntensity', label: 'Ortam ışığı', min: 0, max: 2.5, step: 0.05, format: pct },
  { key: 'exposure', label: 'Pozlama', min: 0.4, max: 2, step: 0.02, format: pct },
  { key: 'fogDistance', label: 'Sis mesafesi', min: 0.1, max: 3, step: 0.05, format: pct },
  { key: 'clouds', label: 'Bulut miktarı', min: 0, max: 1, step: 0.02, override: true, format: pct },
  { key: 'rain', label: 'Yağmur şiddeti', min: 0, max: 1, step: 0.02, override: true, format: pct },
  { key: 'wetness', label: 'Islaklık', min: 0, max: 1, step: 0.02, override: true, format: pct },
  { key: 'wettingRate', label: 'Islanma (tam ıslak, s)', min: 2, max: 120, step: 1, format: (v) => `${v} s` },
  { key: 'dryingRate', label: 'Kuruma (tam kuru, s)', min: 5, max: 600, step: 5, format: (v) => `${v} s` },
];

/**
 * F2 → Dünya / Hava: live weather tuning for the running session. Changes live
 * in the session's WeatherState only; nothing is written to the player's
 * settings or profile.
 */
export class WeatherAdminPane {
  readonly root: HTMLElement;
  private readonly weather: WeatherManager;
  private readonly readout: HTMLElement;
  private readonly inputs = new Map<string, { range: HTMLInputElement; out: HTMLElement; auto?: HTMLInputElement }>();

  constructor(weather: WeatherManager) {
    this.weather = weather;
    this.root = document.createElement('div');
    this.root.innerHTML = `
      <div class="admin-block">
        <label class="admin-label">Hava (geçişli)</label>
        <div class="admin-seg admin-wx-presets">${WEATHER_KINDS.map((k) => `<button data-wx="${k}">${LABELS[k]}</button>`).join('')}</div>
        <label class="admin-check"><input type="checkbox" class="admin-wx-instant"> Anında uygula</label>
        <div class="admin-wx-readout admin-hint"></div>
      </div>
      <div class="admin-block admin-wx-sliders"></div>
      <div class="admin-actions"><button data-wx-reset>Ayarları sıfırla</button></div>
      <p class="admin-hint">Bu değerler sadece bu sürüş için; oyuncu ayarlarına kaydedilmez.</p>`;
    this.readout = this.root.querySelector('.admin-wx-readout') as HTMLElement;
    const list = this.root.querySelector('.admin-wx-sliders') as HTMLElement;
    for (const s of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `<div class="admin-row-head"><span class="admin-name">${s.label}</span><output></output></div><div class="admin-row-ctl">${s.override ? '<label class="admin-check"><input type="checkbox" class="auto"> otomatik</label>' : ''}<input type="range" min="${s.min}" max="${s.max}" step="${s.step}"></div>`;
      const range = row.querySelector('input[type=range]') as HTMLInputElement;
      const out = row.querySelector('output') as HTMLElement;
      const auto = (row.querySelector('input.auto') as HTMLInputElement | null) ?? undefined;
      range.addEventListener('input', () => {
        if (auto) auto.checked = false;
        this.set(s, Number(range.value));
      });
      auto?.addEventListener('change', () => this.set(s, auto.checked ? null : Number(range.value)));
      this.inputs.set(s.key, { range, out, auto });
      list.appendChild(row);
    }
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.wx) {
        const instant = (this.root.querySelector('.admin-wx-instant') as HTMLInputElement).checked;
        this.weather.setWeather(t.dataset.wx as WeatherKind, instant);
      } else if (t.dataset.wxReset !== undefined) {
        Object.assign(this.weather.state.tuning, DEFAULT_TUNING);
        this.weather.state.timeRate = 0;
      }
    });
    this.sync();
  }

  /** Refresh readouts (call ~10× a second while visible). */
  sync(): void {
    const st = this.weather.state;
    const snap = this.weather.snapshot;
    const t = st.tuning;
    for (const s of SLIDERS) {
      const ui = this.inputs.get(s.key);
      if (!ui) continue;
      let v: number | null;
      if (s.key === 'hour') v = st.hour;
      else if (s.key === 'timeRate') v = st.timeRate * 60;
      else if (s.key === 'wettingRate' || s.key === 'dryingRate') v = 1 / (t[s.key] as number);
      else v = t[s.key] as number | null;
      const shown = v ?? (s.key === 'clouds' ? snap.cloudCoverage : s.key === 'rain' ? snap.rain : s.key === 'wetness' ? snap.wetness : 0);
      if (document.activeElement !== ui.range) ui.range.value = String(shown);
      ui.out.textContent = s.format(shown);
      if (ui.auto) ui.auto.checked = v === null;
    }
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-wx]')) b.classList.toggle('on', b.dataset.wx === st.weather);
    this.readout.textContent = `Yol: ${snap.road === 'dry' ? 'kuru' : snap.road === 'damp' ? 'nemli' : 'ıslak'} (${Math.round(snap.wetness * 100)}%) · güneş ${snap.sunAltitudeDeg.toFixed(0)}° · görüş ${Math.round(snap.visibility * 100)}%`;
  }

  private set(s: Slider, value: number | null): void {
    const st = this.weather.state;
    if (s.key === 'hour') st.setHour(value ?? st.hour);
    else if (s.key === 'timeRate') st.timeRate = (value ?? 0) / 60;
    else if (s.key === 'wettingRate' || s.key === 'dryingRate') st.tuning[s.key] = 1 / Math.max(1, value ?? 1);
    else (st.tuning as unknown as Record<string, number | null>)[s.key] = value;
  }
}
