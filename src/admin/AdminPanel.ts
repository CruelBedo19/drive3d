import './admin.css';
import { SETUP_IDS, applySetup, type SetupId } from '../config/setups';
import type { VehicleConfig } from '../config/vehicleTypes';
import type { AdminHost } from './AdminHost';
import { getPath, setPath } from './configPath';
import { TelemetryGraph } from './TelemetryGraph';
import { TUNING_GROUPS, type TuningParam } from './tuningSchema';
import { TuningStore } from './TuningStore';
import { MapAdminPane } from './MapAdminPane';
import { TrafficAdminPane } from './TrafficAdminPane';
import { WeatherAdminPane } from './WeatherAdminPane';

interface ParamRow {
  param: TuningParam;
  row: HTMLElement;
  range?: HTMLInputElement;
  input: HTMLInputElement | HTMLSelectElement;
}

const GRAPH_CHANNELS = [
  { label: 'km/h', color: '#4fd1c5', max: 250 },
  { label: 'drift°', color: '#f6ad55', max: 90 },
  { label: 'gaz', color: '#68d391', max: 1 },
  { label: 'fren', color: '#fc8181', max: 1 },
  { label: 'arka kayma', color: '#b794f4', max: 3 },
  { label: 'yanal g', color: '#63b3ed', max: 1.5 },
];

/**
 * Super-admin overlay (F2): live vehicle tuning, presets, import / export, and
 * a test environment (teleports, slow motion, measurements, telemetry graph).
 */
export class AdminPanel {
  readonly root: HTMLElement;
  private readonly host: AdminHost;
  private readonly rows: ParamRow[] = [];
  private readonly groupEls = new Map<string, HTMLDetailsElement>();
  private readonly graph = new TelemetryGraph(GRAPH_CHANNELS);
  private readonly graphValues = new Float32Array(GRAPH_CHANNELS.length);
  private readonly measureEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly presetList: HTMLElement;
  private readonly setupButtons = new Map<SetupId, HTMLButtonElement>();
  private readonly timeButtons = new Map<number, HTMLButtonElement>();
  private readonly pauseButton: HTMLButtonElement;
  private tab: 'tune' | 'test' | 'world' = 'tune';
  private weatherPane: WeatherAdminPane | null = null;
  private mapPane: MapAdminPane | null = null;
  private trafficPane: TrafficAdminPane | null = null;
  private open = false;
  private uiTimer = 0;
  private base: VehicleConfig;
  private statusTimer = 0;

  constructor(parent: HTMLElement, host: AdminHost) {
    this.host = host;
    this.base = host.baseConfig(host.setupId);
    this.root = el('aside', 'admin');
    this.root.hidden = true;
    this.root.innerHTML = `
      <header class="admin-head">
        <div><strong>SÜPER ADMİN</strong><span class="admin-sub">F2 ile aç / kapat</span></div>
        <button class="admin-x" data-act="close" title="Kapat">×</button>
      </header>
      <nav class="admin-tabs">
        <button data-tab="tune" class="on">Araç ayarları</button>
        <button data-tab="test">Test ortamı</button>
        <button data-tab="world">Dünya / Hava</button>
      </nav>
      <div class="admin-status"></div>
      <section class="admin-body" data-pane="tune">
        <div class="admin-block">
          <label class="admin-label">Araç</label>
          <select class="admin-car"></select>
          <label class="admin-label">Setup (temel ayar)</label>
          <div class="admin-seg admin-setups"></div>
          <div class="admin-actions">
            <button data-act="reset">Setup'a sıfırla</button>
            <button data-act="save">Preset kaydet</button>
            <button data-act="export">JSON dışa aktar</button>
            <button data-act="import">JSON içe aktar</button>
          </div>
          <div class="admin-presets"></div>
          <input class="admin-search" type="search" placeholder="Ayar ara… (ör. grip, fren)" />
        </div>
        <div class="admin-groups"></div>
      </section>
      <section class="admin-body" data-pane="test" hidden>
        <div class="admin-block">
          <label class="admin-label">Işınlan</label>
          <div class="admin-grid admin-teleports"></div>
        </div>
        <div class="admin-block">
          <label class="admin-label">Zaman</label>
          <div class="admin-seg admin-time"></div>
          <div class="admin-actions">
            <button data-act="pause">Duraklat (P)</button>
            <button data-act="step">Tek adım (.)</button>
          </div>
        </div>
        <div class="admin-block">
          <label class="admin-label">Ölçümler <button class="admin-mini" data-act="measure-reset">sıfırla</button></label>
          <div class="admin-measure"></div>
          <p class="admin-hint">0-100: dur, sonra tam gaz. 100-0: 100 km/h üstünde S'ye basılı tut.</p>
        </div>
        <div class="admin-block admin-graph-wrap">
          <label class="admin-label">Canlı telemetri (son 10 s)</label>
        </div>
        <div class="admin-block">
          <label class="admin-label">Görünüm</label>
          <div class="admin-actions">
            <button data-act="debug">Debug paneli (F3)</button>
            <button data-act="colliders">Collider'lar (F4)</button>
          </div>
        </div>
      </section>
      <section class="admin-body" data-pane="world" hidden></section>`;
    parent.appendChild(this.root);
    if (host.trackDebug && host.regenerateTrack) {
      const pane = new MapAdminPane({ trackDebug: () => host.trackDebug?.() ?? null, regenerateTrack: (seed) => host.regenerateTrack?.(seed) });
      if (pane.available) {
        this.mapPane = pane;
        this.q('[data-pane="world"]').appendChild(pane.root);
      }
    }
    if (host.trafficDebug && host.trafficSelectNext) {
      const pane = new TrafficAdminPane({ trafficDebug: () => host.trafficDebug?.() ?? null, trafficSelectNext: () => host.trafficSelectNext?.(), get trafficFlags() { return host.trafficFlags ?? null; } });
      if (pane.available) {
        this.trafficPane = pane;
        this.q('[data-pane="world"]').appendChild(pane.root);
      }
    }
    if (host.weather) {
      this.weatherPane = new WeatherAdminPane(host.weather);
      this.q('[data-pane="world"]').appendChild(this.weatherPane.root);
    }

    this.statusEl = this.q('.admin-status');
    this.measureEl = this.q('.admin-measure');
    this.presetList = this.q('.admin-presets');
    this.pauseButton = this.q<HTMLButtonElement>('[data-act="pause"]');
    this.q('.admin-graph-wrap').appendChild(this.graph.canvas);

    this.buildCarSelect();
    this.buildSetupButtons();
    this.buildGroups();
    this.buildTestPane();
    this.renderPresets();
    this.syncInputs();

    this.root.addEventListener('click', this.onClick);
    // Hand the keyboard back to the car after using a control: a focused button
    // would re-trigger on Space (handbrake), a focused select would swallow WASD.
    this.root.addEventListener('click', (e) => {
      if (e.target instanceof HTMLButtonElement) e.target.blur();
    });
    this.root.addEventListener('change', (e) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) e.target.blur();
    });
    this.root.addEventListener('keydown', (e) => {
      if ((e.key === 'Escape' || e.key === 'Enter') && e.target instanceof HTMLElement) e.target.blur();
    });
    this.q<HTMLInputElement>('.admin-search').addEventListener('input', (e) => this.filter((e.target as HTMLInputElement).value));

    const saved = TuningStore.loadPanelState();
    if (saved?.open) this.toggle();
  }

  toggle(): void {
    this.open = !this.open;
    this.root.hidden = !this.open;
    document.body.classList.toggle('admin-open', this.open);
    this.savePanelState();
  }

  /** Call every rendered frame with the real (unscaled) frame time. */
  update(dt: number): void {
    const v = this.host.vehicle;
    const t = v.telemetry;
    const w = v.physics.wheels;
    const g = this.graphValues;
    g[0] = t.speedKmh;
    g[1] = t.bodySlipDeg;
    g[2] = t.throttle;
    g[3] = t.brake;
    g[4] = Math.max(w[2].combinedSlip, w[3].combinedSlip);
    g[5] = (v.physics.linearVelocity.length() * Math.abs(v.physics.angularVelocity.y)) / 9.81;
    if (!this.host.paused) this.graph.push(dt * this.host.timeScale, g);

    if (this.statusTimer > 0) {
      this.statusTimer -= dt;
      if (this.statusTimer <= 0) this.statusEl.textContent = '';
    }
    if (!this.open) return;
    this.uiTimer += dt;
    if (this.uiTimer < 0.1) return;
    this.uiTimer = 0;
    if (this.tab === 'test') {
      this.graph.draw();
      this.renderMeasurements();
    } else if (this.tab === 'world') {
      this.weatherPane?.sync();
      this.mapPane?.sync();
      this.trafficPane?.sync();
    }
  }

  dispose(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.remove();
    document.body.classList.remove('admin-open');
  }

  // --- building ---------------------------------------------------------------

  private buildCarSelect(): void {
    const select = this.q<HTMLSelectElement>('.admin-car');
    for (const id of this.host.carIds) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = id;
      o.selected = id === this.host.carId;
      select.appendChild(o);
    }
    select.addEventListener('change', () => {
      const url = new URL(window.location.href);
      url.searchParams.set('car', select.value);
      url.searchParams.set('admin', '1');
      window.location.href = url.toString();
    });
  }

  private buildSetupButtons(): void {
    const wrap = this.q('.admin-setups');
    for (const id of SETUP_IDS) {
      const b = el('button', '') as HTMLButtonElement;
      b.textContent = id;
      b.addEventListener('click', () => this.selectSetup(id));
      wrap.appendChild(b);
      this.setupButtons.set(id, b);
    }
  }

  private buildGroups(): void {
    const wrap = this.q('.admin-groups');
    const savedGroups = TuningStore.loadPanelState()?.groups ?? {};
    for (const group of TUNING_GROUPS) {
      const details = document.createElement('details');
      details.className = 'admin-group';
      details.open = savedGroups[group.id] ?? group.id === 'tires';
      details.innerHTML = `<summary>${group.title}<span class="admin-count"></span></summary>`;
      details.addEventListener('toggle', () => this.savePanelState());
      for (const param of group.params) details.appendChild(this.buildRow(param));
      wrap.appendChild(details);
      this.groupEls.set(group.id, details);
    }
  }

  private buildRow(param: TuningParam): HTMLElement {
    const row = el('div', 'admin-row');
    row.dataset.search = `${param.label} ${param.path}`.toLowerCase();
    const head = el('div', 'admin-row-head');
    head.innerHTML = `<span class="admin-name" title="${param.path}">${param.label}</span>`;
    const resetBtn = el('button', 'admin-reset') as HTMLButtonElement;
    resetBtn.textContent = '↺';
    resetBtn.title = "Setup değerine dön";
    head.appendChild(resetBtn);
    row.appendChild(head);
    if (param.hint) {
      const hint = el('div', 'admin-hint');
      hint.textContent = param.hint;
      row.appendChild(hint);
    }

    const ctl = el('div', 'admin-ctl');
    let entry: ParamRow;
    if (param.kind === 'number') {
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(param.min);
      range.max = String(param.max);
      range.step = String(param.step);
      const input = document.createElement('input');
      input.type = 'number';
      input.step = String(param.step);
      const unit = el('span', 'admin-unit');
      unit.textContent = param.unit ?? '';
      ctl.append(range, input, unit);
      range.addEventListener('input', () => {
        input.value = range.value;
        this.edit(param, Number(range.value));
      });
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        range.value = String(value);
        this.edit(param, value);
      });
      entry = { param, row, range, input };
    } else if (param.kind === 'select') {
      const select = document.createElement('select');
      for (const opt of param.options) {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt;
        select.appendChild(o);
      }
      select.addEventListener('change', () => this.edit(param, select.value));
      ctl.appendChild(select);
      entry = { param, row, input: select };
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.addEventListener('change', () => {
        const values = input.value.split(',').map((x) => Number(x.trim()));
        if (values.length === 0 || values.some((x) => !Number.isFinite(x) || x <= 0)) {
          this.status('Geçersiz liste: pozitif sayılar, virgülle', true);
          this.syncInputs();
          return;
        }
        this.edit(param, values);
      });
      ctl.appendChild(input);
      entry = { param, row, input };
    }
    row.appendChild(ctl);
    resetBtn.addEventListener('click', () => {
      const value = getPath(this.base, param.path);
      this.edit(param, Array.isArray(value) ? [...value] : value);
      this.syncInputs();
    });
    this.rows.push(entry);
    return row;
  }

  private buildTestPane(): void {
    const tp = this.q('.admin-teleports');
    for (const p of this.host.testPoints) {
      const b = el('button', '') as HTMLButtonElement;
      b.textContent = p.label;
      b.addEventListener('click', () => {
        this.host.teleport(p.id);
        this.status(`Işınlandı: ${p.label}`);
      });
      tp.appendChild(b);
    }
    const time = this.q('.admin-time');
    for (const scale of [1, 0.5, 0.25, 0.1]) {
      const b = el('button', '') as HTMLButtonElement;
      b.textContent = `${scale}×`;
      b.addEventListener('click', () => this.setTimeScale(scale));
      time.appendChild(b);
      this.timeButtons.set(scale, b);
    }
    this.syncTimeButtons();
  }

  // --- actions -----------------------------------------------------------------

  private readonly onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement;
    const tab = target.dataset.tab as 'tune' | 'test' | 'world' | undefined;
    if (tab) {
      this.tab = tab;
      for (const b of this.root.querySelectorAll<HTMLElement>('[data-tab]')) b.classList.toggle('on', b.dataset.tab === tab);
      for (const pane of this.root.querySelectorAll<HTMLElement>('[data-pane]')) pane.hidden = pane.dataset.pane !== tab;
      return;
    }
    switch (target.dataset.act) {
      case 'close':
        this.toggle();
        break;
      case 'reset':
        this.selectSetup(this.host.setupId);
        break;
      case 'save':
        this.savePreset();
        break;
      case 'export':
        void this.exportJson();
        break;
      case 'import':
        this.importJson();
        break;
      case 'pause':
        this.togglePause();
        break;
      case 'step':
        this.host.stepOnce();
        break;
      case 'measure-reset':
        this.host.measurements.reset();
        this.renderMeasurements();
        break;
      case 'debug':
        this.host.toggleDebugPanel();
        break;
      case 'colliders':
        this.host.toggleColliders();
        break;
    }
  };

  /** Keyboard shortcuts that only make sense with admin mode on. */
  handleKey(code: string): void {
    if (code === 'KeyP') this.togglePause();
    if (code === 'Period') this.host.stepOnce();
  }

  private edit(param: TuningParam, value: unknown): void {
    setPath(this.host.vehicle.config, param.path, value);
    this.host.configEdited();
    this.persist();
    this.markChanged();
  }

  private selectSetup(id: SetupId): void {
    this.host.setupId = id;
    this.base = this.host.baseConfig(id);
    this.host.applyConfig(this.base);
    this.persist();
    this.syncInputs();
    this.status(`${id} setup yüklendi`);
  }

  private savePreset(): void {
    const name = window.prompt('Preset adı:', `${this.host.carId}-${this.host.setupId}-${new Date().toLocaleTimeString('tr-TR')}`);
    if (!name) return;
    const ok = TuningStore.savePreset({ name, carId: this.host.carId, savedAt: new Date().toISOString(), config: structuredClone(this.host.vehicle.config) });
    this.status(ok ? `Kaydedildi: ${name}` : 'Kaydedilemedi (tarayıcı depolaması kapalı)', !ok);
    this.renderPresets();
  }

  private renderPresets(): void {
    const list = TuningStore.listPresets().filter((p) => p.carId === this.host.carId);
    this.presetList.innerHTML = list.length ? '<label class="admin-label">Kayıtlı presetler</label>' : '';
    for (const p of list) {
      const row = el('div', 'admin-preset');
      const load = el('button', '') as HTMLButtonElement;
      load.textContent = p.name;
      load.title = `Yükle (${new Date(p.savedAt).toLocaleString('tr-TR')})`;
      load.addEventListener('click', () => {
        this.loadConfig(p.config);
        this.status(`Yüklendi: ${p.name}`);
      });
      const del = el('button', 'admin-mini') as HTMLButtonElement;
      del.textContent = 'sil';
      del.addEventListener('click', () => {
        if (!window.confirm(`"${p.name}" silinsin mi?`)) return;
        TuningStore.deletePreset(p.name);
        this.renderPresets();
      });
      row.append(load, del);
      this.presetList.appendChild(row);
    }
  }

  private async exportJson(): Promise<void> {
    const json = JSON.stringify({ carId: this.host.carId, setup: this.host.setupId, config: this.host.vehicle.config }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.host.carId}-${this.host.setupId.toLowerCase()}-tuning.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    try {
      await navigator.clipboard.writeText(json);
      this.status('JSON indirildi ve panoya kopyalandı');
    } catch {
      this.status('JSON indirildi');
    }
  }

  private importJson(): void {
    const text = window.prompt('Dışa aktarılmış JSON (tamamı veya sadece config):');
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { config?: unknown };
      const cfg = (parsed && typeof parsed === 'object' && 'config' in parsed ? parsed.config : parsed) as object;
      this.loadConfig(cfg as VehicleConfig);
      this.status('JSON içe aktarıldı');
    } catch (err) {
      this.status(`İçe aktarılamadı: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  }

  /** Merges an untrusted config over the current setup base and validates every tunable. */
  private loadConfig(cfg: VehicleConfig): void {
    if (typeof cfg !== 'object' || cfg === null) throw new Error('config nesnesi değil');
    const merged = applySetup(this.base, cfg);
    for (const { param } of this.rows) {
      const v = getPath(merged, param.path);
      const ok =
        param.kind === 'number'
          ? typeof v === 'number' && Number.isFinite(v)
          : param.kind === 'select'
            ? param.options.includes(String(v))
            : Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && x > 0);
      if (!ok) throw new Error(`geçersiz değer: ${param.path}`);
    }
    this.host.applyConfig(merged);
    this.persist();
    this.syncInputs();
  }

  private togglePause(): void {
    this.host.paused = !this.host.paused;
    this.pauseButton.textContent = this.host.paused ? 'Devam (P)' : 'Duraklat (P)';
    this.pauseButton.classList.toggle('on', this.host.paused);
  }

  private setTimeScale(scale: number): void {
    this.host.timeScale = scale;
    this.syncTimeButtons();
  }

  // --- view sync ------------------------------------------------------------------

  private syncInputs(): void {
    const cfg = this.host.vehicle.config;
    for (const { param, range, input } of this.rows) {
      const v = getPath(cfg, param.path);
      if (param.kind === 'list') input.value = (v as number[]).join(', ');
      else input.value = String(v);
      if (range) range.value = String(v);
    }
    for (const [id, b] of this.setupButtons) b.classList.toggle('on', id === this.host.setupId);
    this.markChanged();
  }

  /** Highlights values that differ from the selected setup, and counts them per group. */
  private markChanged(): void {
    const cfg = this.host.vehicle.config;
    for (const r of this.rows) {
      const a = getPath(cfg, r.param.path);
      const b = getPath(this.base, r.param.path);
      r.row.classList.toggle('changed', JSON.stringify(a) !== JSON.stringify(b));
    }
    for (const group of TUNING_GROUPS) {
      const el = this.groupEls.get(group.id);
      if (!el) continue;
      const n = el.querySelectorAll('.admin-row.changed').length;
      (el.querySelector('.admin-count') as HTMLElement).textContent = n ? ` · ${n} değişik` : '';
    }
  }

  private syncTimeButtons(): void {
    for (const [s, b] of this.timeButtons) b.classList.toggle('on', s === this.host.timeScale);
  }

  private filter(query: string): void {
    const q = query.trim().toLowerCase();
    for (const r of this.rows) r.row.hidden = q !== '' && !r.row.dataset.search?.includes(q);
    for (const d of this.groupEls.values()) {
      const any = [...d.querySelectorAll<HTMLElement>('.admin-row')].some((x) => !x.hidden);
      d.hidden = !any;
      if (q) d.open = any;
    }
  }

  private renderMeasurements(): void {
    const r = this.host.measurements.results;
    const s = (v: number | null, unit: string, digits = 2) => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`);
    this.measureEl.innerHTML = `
      <div><span>0-100 km/h</span><b>${s(r.zeroTo100, 's')}</b></div>
      <div><span>en iyi 0-100</span><b>${s(r.best0To100, 's')}</b></div>
      <div><span>0-200 km/h</span><b>${s(r.zeroTo200, 's')}</b></div>
      <div><span>100-0 fren</span><b>${s(r.brake100To0, 'm', 1)}</b></div>
      <div><span>maks. hız</span><b>${r.topSpeed.toFixed(1)} km/h</b></div>
      <div><span>maks. yanal</span><b>${r.maxLateralG.toFixed(2)} g</b></div>
      <div><span>drift (şimdi)</span><b>${r.currentDrift.toFixed(1)} s</b></div>
      <div><span>en uzun drift</span><b>${r.bestDrift.toFixed(1)} s</b></div>`;
  }

  private persist(): void {
    TuningStore.saveWorking(this.host.carId, this.host.setupId, this.host.vehicle.config, this.base);
  }

  private savePanelState(): void {
    const groups: Record<string, boolean> = {};
    for (const [id, d] of this.groupEls) groups[id] = d.open;
    TuningStore.savePanelState({ open: this.open, groups });
  }

  private status(text: string, error = false): void {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('err', error);
    this.statusTimer = 3;
  }

  private q<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) throw new Error(`admin element missing: ${selector}`);
    return found;
  }
}

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

