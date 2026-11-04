import { CAR_REGISTRY, carRatings, carSpecs, type CarEntry } from '../../config/carRegistry';
import { SETUP_IDS, type SetupId } from '../../config/setups';
import type { Profile, TimePreset, WeatherKind } from '../../settings/Profile';
import { TIME_PRESETS, WEATHER_KINDS } from '../../settings/Profile';
import type { TrackInfo } from '../../world/trackCatalog';
import { PRESET_HOURS } from '../../world/weather/WeatherState';
import { profileHour } from '../../settings/Profile';
import { Screen, drawOutline, esc } from './Screen';

export const WEATHER_LABELS: Record<WeatherKind, string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rainy', heavyRain: 'Heavy Rain', fog: 'Foggy' };
export const TIME_LABELS: Record<TimePreset, string> = { morning: 'Morning', noon: 'Noon', evening: 'Evening', night: 'Night', custom: 'Custom' };

export function formatHour(h: number): string {
  const total = Math.round(h * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export function carTitle(c: CarEntry): string {
  return `${c.brand} ${c.model}${c.year ? ` (${c.year})` : ''}`;
}

// --- Main menu ------------------------------------------------------------------

export interface MainMenuActions {
  drive(): void;
  garage(): void;
  settings(): void;
}

export class MainMenu extends Screen {
  private readonly carLine: HTMLElement;

  constructor(parent: HTMLElement, actions: MainMenuActions) {
    super(parent, 'screen-main');
    this.root.innerHTML = `
      <div class="menu-col">
        <div class="brand"><span class="brand-mark">DRIVE</span><span class="brand-3d">3D</span></div>
        <nav class="menu-list">
          <button class="menu-btn is-primary" data-action="drive" data-autofocus>DRIVE</button>
          <button class="menu-btn" data-action="garage">GARAGE</button>
          <button class="menu-btn" data-action="settings">SETTINGS</button>
        </nav>
        <div class="menu-car"></div>
      </div>
      <div class="menu-foot">Enter to select · Esc back</div>`;
    this.carLine = this.q('.menu-car');
    this.on('drive', actions.drive);
    this.on('garage', actions.garage);
    this.on('settings', actions.settings);
  }

  setCar(car: CarEntry, setup: string): void {
    this.carLine.innerHTML = `<span class="label">Selected car</span><b>${esc(carTitle(car))}</b><span class="tag">${esc(setup)}</span>`;
  }
}

// --- Map select -----------------------------------------------------------------

export interface MapSelectActions {
  back(): void;
  next(trackId: string): void;
  changed(patch: Partial<Profile>): void;
}

export class MapSelect extends Screen {
  private readonly tracks: readonly TrackInfo[];
  private selected: string;
  private profile: Profile;

  constructor(parent: HTMLElement, tracks: readonly TrackInfo[], profile: Profile, actions: MapSelectActions) {
    super(parent, 'screen-maps');
    this.tracks = tracks;
    this.profile = profile;
    this.selected = profile.trackId;
    this.root.innerHTML = `
      <header class="screen-head"><button class="back-btn" data-action="back" aria-label="Back">‹</button><h1>SELECT MAP</h1></header>
      <div class="map-cards">${tracks
        .map(
          (t) => `
        <button class="map-card" data-action="pick" data-id="${t.id}">
          <canvas class="map-thumb" data-thumb="${t.id}"></canvas>
          <div class="map-meta">
            <span class="tag">${esc(t.type)}</span>
            <h2>${esc(t.name)}</h2>
            <p>${esc(t.description)}</p>
            ${t.tags ? `<div class="map-tags">${t.tags.map((g) => `<span>${esc(g)}</span>`).join('')}</div>` : ''}
            <dl class="stats">
              <div><dt>Length</dt><dd>${Number.isFinite(t.length) ? `${(t.length / 1000).toFixed(2)} km` : 'Unlimited'}</dd></div>
              ${t.elevation ? `<div><dt>Elevation</dt><dd>${t.elevation} m</dd></div>` : ''}
              ${t.corners ? `<div><dt>Named corners</dt><dd>${t.corners}</dd></div>` : ''}
              <div><dt>Environment</dt><dd>${esc(t.environment)}</dd></div>
            </dl>
          </div>
        </button>`,
        )
        .join('')}</div>
      <div class="conditions">
        <div class="seg" role="group" aria-label="Weather"><span class="seg-label">Weather</span>${WEATHER_KINDS.map((w) => `<button data-action="weather" data-value="${w}">${WEATHER_LABELS[w]}</button>`).join('')}</div>
        <div class="seg" role="group" aria-label="Time"><span class="seg-label">Time</span>${TIME_PRESETS.map((t) => `<button data-action="time" data-value="${t}">${TIME_LABELS[t]}</button>`).join('')}</div>
        <label class="custom-time"><span>Hour</span> <input type="range" class="custom-hour" min="0" max="1439" step="1" aria-label="Custom time (minutes)"><output class="custom-out"></output></label>
      </div>
      <footer class="screen-foot"><button class="menu-btn is-primary" data-action="next" data-autofocus>CONTINUE</button></footer>`;
    this.on('back', actions.back);
    this.on('pick', (el) => {
      this.selected = el.dataset.id ?? this.selected;
      actions.changed({ trackId: this.selected });
      this.refresh();
    });
    this.on('next', () => actions.next(this.selected));
    this.on('weather', (el) => {
      actions.changed({ weather: el.dataset.value as WeatherKind });
    });
    const range = this.q<HTMLInputElement>('.custom-hour');
    this.on('time', (el) => {
      const time = el.dataset.value as TimePreset;
      // "Özel" starts from the hour currently shown and opens the slider.
      if (time === 'custom') actions.changed({ time, customHour: Number(range.value) / 60 });
      else actions.changed({ time, customHour: null });
    });
    // The slider works in minutes (00:00 … 23:59) so every value is exact.
    range.addEventListener('input', () => actions.changed({ time: 'custom', customHour: Number(range.value) / 60 }));
  }

  setProfile(profile: Profile): void {
    this.profile = profile;
    this.selected = profile.trackId;
    this.refresh();
  }

  protected override onShow(): void {
    for (const t of this.tracks) drawOutline(this.q<HTMLCanvasElement>(`[data-thumb="${t.id}"]`), t.outline, t.closed);
    this.refresh();
  }

  private refresh(): void {
    for (const card of this.root.querySelectorAll<HTMLElement>('.map-card')) card.classList.toggle('is-selected', card.dataset.id === this.selected);
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-action="weather"]')) b.classList.toggle('is-on', b.dataset.value === this.profile.weather);
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-action="time"]')) b.classList.toggle('is-on', b.dataset.value === this.profile.time);
    const hour = profileHour(this.profile, PRESET_HOURS);
    const isCustom = this.profile.time === 'custom';
    this.q('.custom-time').classList.toggle('is-off', !isCustom);
    this.q<HTMLInputElement>('.custom-hour').value = String(Math.round(hour * 60));
    this.q('.custom-out').textContent = formatHour(hour);
  }
}

// --- Car confirm ----------------------------------------------------------------

export interface CarConfirmActions {
  back(): void;
  garage(): void;
  drive(): void;
  setup(setup: SetupId): void;
}

export class CarConfirm extends Screen {
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, actions: CarConfirmActions) {
    super(parent, 'screen-confirm');
    this.root.innerHTML = `
      <header class="screen-head"><button class="back-btn" data-action="back" aria-label="Back">‹</button><h1>VEHICLE CONFIRM</h1></header>
      <section class="panel confirm-panel"></section>
      <footer class="screen-foot">
        <button class="menu-btn" data-action="garage">GO TO GARAGE</button>
        <button class="menu-btn is-primary" data-action="drive" data-autofocus>DRIVE</button>
      </footer>`;
    this.body = this.q('.confirm-panel');
    this.on('back', actions.back);
    this.on('garage', actions.garage);
    this.on('drive', actions.drive);
    this.on('setup', (el) => actions.setup(el.dataset.value as SetupId));
  }

  render(car: CarEntry, setup: string, track: TrackInfo | undefined, conditions: string): void {
    const s = carSpecs(car.definition.physics);
    this.body.innerHTML = `
      <span class="tag">${car.placeholder ? 'Placeholder model' : car.testPhysics ? 'Test vehicle physics' : esc(car.brand)}</span>
      <h2>${esc(carTitle(car))}</h2>
      <dl class="stats">
        <div><dt>Power</dt><dd>${s.powerPs} PS</dd></div>
        <div><dt>Torque</dt><dd>${s.torqueNm} Nm</dd></div>
        <div><dt>Weight</dt><dd>${s.massKg} kg</dd></div>
        <div><dt>Drivetrain</dt><dd>${s.drivetrain}</dd></div>
      </dl>
      <div class="seg" role="group" aria-label="Setup"><span class="seg-label">Setup</span>${SETUP_IDS.map((id) => `<button data-action="setup" data-value="${id}" class="${id === setup ? 'is-on' : ''}">${id}</button>`).join('')}</div>
      <p class="confirm-trip"><span class="label">Track</span> ${esc(track?.name ?? '')} <span class="label">Conditions</span> ${esc(conditions)}</p>`;
  }
}

// --- Garage ---------------------------------------------------------------------

export interface GarageActions {
  back(): void;
  select(carId: string): void;
  preview(carId: string): void;
}

export class GarageUi extends Screen {
  private index = 0;
  private selectedId = '';
  private readonly info: HTMLElement;
  private readonly actions: GarageActions;

  constructor(parent: HTMLElement, actions: GarageActions) {
    super(parent, 'screen-garage');
    this.actions = actions;
    this.root.innerHTML = `
      <header class="screen-head"><button class="back-btn" data-action="back" aria-label="Back">‹</button><h1>GARAGE</h1></header>
      <button class="garage-arrow is-left" data-action="prev" aria-label="Previous car">‹</button>
      <button class="garage-arrow is-right" data-action="next" aria-label="Next car">›</button>
      <section class="panel garage-panel"></section>
      <div class="garage-hint">Drag to rotate · Scroll to zoom · ← → switch car</div>`;
    this.info = this.q('.garage-panel');
    this.on('back', actions.back);
    this.on('prev', () => this.step(-1));
    this.on('next', () => this.step(1));
    this.on('select', () => {
      const car = CAR_REGISTRY[this.index];
      this.selectedId = car.id;
      actions.select(car.id);
      this.render();
    });
  }

  /** Opens on the currently selected car. */
  open(selectedId: string): void {
    this.selectedId = selectedId;
    this.index = Math.max(0, CAR_REGISTRY.findIndex((c) => c.id === selectedId));
    this.render();
  }

  /** ← / → keys. */
  step(delta: number): void {
    this.index = (this.index + delta + CAR_REGISTRY.length) % CAR_REGISTRY.length;
    this.actions.preview(CAR_REGISTRY[this.index].id);
    this.render();
  }

  get previewId(): string {
    return CAR_REGISTRY[this.index].id;
  }

  private render(): void {
    const car = CAR_REGISTRY[this.index];
    const s = carSpecs(car.definition.physics);
    const r = carRatings(car);
    const bar = (label: string, v: number) => `<div class="rating"><span>${label}</span><i><b style="width:${v}%"></b></i><em>${v}</em></div>`;
    const isSelected = car.id === this.selectedId;
    this.info.innerHTML = `
      <div class="garage-count">${this.index + 1} / ${CAR_REGISTRY.length}</div>
      <span class="tag">${car.placeholder ? 'Placeholder' : esc(car.brand)}</span>
      <h2>${esc(car.model)}</h2>
      <p class="garage-brand">${esc(car.brand)}${car.year ? ` · ${car.year}` : ''}</p>
      <p class="garage-desc">${esc(car.description)}${car.testPhysics ? ' Currently using test vehicle physics (dimensions are the car\'s).' : ''}</p>
      <dl class="stats stats-grid">
        <div><dt>Power</dt><dd>${s.powerPs} PS</dd></div>
        <div><dt>Torque</dt><dd>${s.torqueNm} Nm</dd></div>
        <div><dt>Weight</dt><dd>${s.massKg} kg</dd></div>
        <div><dt>Drivetrain</dt><dd>${s.drivetrain}</dd></div>
        <div><dt>Top speed</dt><dd>${s.maxSpeedKmh} km/h</dd></div>
        <div><dt>Wheelbase</dt><dd>${s.wheelbaseM.toFixed(2)} m</dd></div>
      </dl>
      <div class="ratings">${bar('Speed', r.speed)}${bar('Acceleration', r.acceleration)}${bar('Handling', r.handling)}${bar('Braking', r.braking)}</div>
      <button class="menu-btn is-primary garage-select" data-action="select" ${isSelected ? 'disabled' : 'data-autofocus'}>${isSelected ? 'SELECTED' : 'SELECT THIS CAR'}</button>
      ${car.credit ? `<p class="garage-credit">Model: ${esc(car.credit)}</p>` : ''}`;
  }
}

// --- Loading ----------------------------------------------------------------------

export class LoadingScreen extends Screen {
  constructor(parent: HTMLElement) {
    super(parent, 'screen-loading');
    this.root.innerHTML = `
      <div class="loading-box">
        <span class="label">Loading</span>
        <h1 class="loading-map"></h1>
        <p class="loading-car"></p>
        <div class="spinner" aria-hidden="true"></div>
        <div class="loading-bar" hidden><span></span></div>
        <p class="loading-stage" role="status"></p>
      </div>`;
  }

  /** Progress bar 0..1 with a line of text (null hides the bar: steps without a measurable %). */
  progress(fraction: number | null, text = ''): void {
    const bar = this.q('.loading-bar');
    bar.hidden = fraction === null;
    if (fraction !== null) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(fraction * 100)}%`;
    this.stage(text);
  }

  set(map: string, car: string): void {
    this.q('.loading-map').textContent = map;
    this.q('.loading-car').textContent = car;
    this.progress(null);
  }

  /** What is being prepared right now (there is no measurable % for track generation). */
  stage(text: string): void {
    this.q('.loading-stage').textContent = text;
  }
}

// --- Pause ------------------------------------------------------------------------

export interface PauseActions {
  resume(): void;
  restart(): void;
  settings(): void;
  maps(): void;
  garage(): void;
  mainMenu(): void;
}

export class PauseMenu extends Screen {
  constructor(parent: HTMLElement, actions: PauseActions) {
    super(parent, 'screen-pause');
    this.root.innerHTML = `
      <div class="pause-box">
        <h1>PAUSED</h1>
        <nav class="menu-list">
          <button class="menu-btn is-primary" data-action="resume" data-autofocus>RESUME</button>
          <button class="menu-btn" data-action="restart">RESTART</button>
          <button class="menu-btn" data-action="settings">SETTINGS</button>
          <button class="menu-btn" data-action="maps">SELECT MAP</button>
          <button class="menu-btn" data-action="garage">GARAGE</button>
          <button class="menu-btn" data-action="mainMenu">MAIN MENU</button>
        </nav>
        <p class="menu-foot-inline">Esc to resume</p>
      </div>`;
    for (const k of Object.keys(actions) as (keyof PauseActions)[]) this.on(k, () => actions[k]());
  }
}
