import {
  SETTINGS_SCHEMA,
  SETTING_SECTIONS,
  findKeyConflicts,
  isBindableKey,
  keyLabel,
  type GameSettings,
  type SettingField,
  type SettingsSection,
  type SettingsStore,
} from '../../settings/Settings';
import { Screen, esc } from './Screen';

/**
 * Full settings screen: one tab per schema section, rows generated from
 * SETTINGS_SCHEMA. Key bindings are captured by pressing the new key; keys used
 * twice are flagged. Changes apply and save immediately.
 */
export class SettingsScreen extends Screen {
  private readonly store: SettingsStore;
  private section: SettingsSection = 'ui';
  private capturing: SettingField | null = null;
  private readonly unsubscribe: () => void;
  private readonly body: HTMLElement;
  private readonly note: HTMLElement;

  constructor(parent: HTMLElement, store: SettingsStore, back: () => void) {
    super(parent, 'screen-settings');
    this.store = store;
    this.root.innerHTML = `
      <header class="screen-head"><button class="back-btn" data-action="back" aria-label="Back">‹</button><h1>SETTINGS</h1></header>
      <div class="settings-layout">
        <nav class="settings-tabs">${SETTING_SECTIONS.map((s) => `<button data-action="tab" data-section="${s.id}">${esc(s.label)}</button>`).join('')}</nav>
        <section class="panel settings-body"></section>
      </div>
      <footer class="screen-foot settings-foot">
        <span class="settings-note" role="status"></span>
        <button class="menu-btn" data-action="resetSection">RESET SECTION</button>
        <button class="menu-btn" data-action="resetAll">RESET TO DEFAULTS</button>
      </footer>`;
    this.body = this.q('.settings-body');
    this.note = this.q('.settings-note');
    this.on('back', back);
    this.on('tab', (el) => {
      this.section = el.dataset.section as SettingsSection;
      this.render();
    });
    this.on('resetSection', () => store.reset(this.section));
    this.on('resetAll', () => store.reset());
    this.on('bind', (el) => this.startCapture(el.dataset.key ?? ''));
    this.body.addEventListener('change', this.onInput);
    this.body.addEventListener('input', this.onInput);
    this.unsubscribe = store.subscribe((s) => this.sync(s));
    this.render();
  }

  /** True while waiting for a key to bind (Esc then cancels the capture, not the screen). */
  get isCapturing(): boolean {
    return this.capturing !== null;
  }

  override hide(): void {
    this.stopCapture();
    super.hide();
  }

  override dispose(): void {
    this.stopCapture();
    this.unsubscribe();
    super.dispose();
  }

  private render(): void {
    for (const b of this.root.querySelectorAll<HTMLElement>('.settings-tabs button')) b.classList.toggle('is-on', b.dataset.section === this.section);
    const fields = SETTINGS_SCHEMA.filter((f) => f.section === this.section);
    this.body.innerHTML = fields.map((f) => this.row(f)).join('') + (this.section === 'controls' ? `<p class="settings-fixed">Arrow keys always work for throttle / brake / steering. Esc, F2–F4, P and . are game / developer keys.</p>` : '') + (this.section === 'audio' ? `<p class="settings-fixed">The audio system is not yet playing sound; these values will be used when audio arrives.</p>` : '');
    this.sync(this.store.value);
  }

  private row(f: SettingField): string {
    const id = `set-${f.section}-${f.key}`;
    const label = `<label for="${id}">${esc(f.label)}${f.hint ? `<small>${esc(f.hint)}</small>` : ''}</label>`;
    let control = '';
    if (f.type === 'toggle') control = `<input id="${id}" type="checkbox" class="settings-toggle" data-key="${f.key}">`;
    else if (f.type === 'select') control = `<select id="${id}" data-key="${f.key}">${f.options.map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('')}</select>`;
    else if (f.type === 'range') control = `<input id="${id}" type="range" min="${f.min}" max="${f.max}" step="${f.step}" data-key="${f.key}"><output data-out="${f.key}"></output>`;
    else control = `<button id="${id}" class="key-btn" data-action="bind" data-key="${f.key}"></button>`;
    return `<div class="settings-row" data-row="${f.key}">${label}<div class="settings-control">${control}</div></div>`;
  }

  private readonly onInput = (e: Event): void => {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const key = el.dataset.key;
    const field = SETTINGS_SCHEMA.find((f) => f.section === this.section && f.key === key);
    if (!field || field.type === 'key') return;
    if (field.type === 'toggle') this.store.set(this.section, field.key, (el as HTMLInputElement).checked);
    else if (field.type === 'range') this.store.set(this.section, field.key, Number(el.value));
    else this.store.set(this.section, field.key, el.value);
  };

  private sync(s: Readonly<GameSettings>): void {
    const values = s[this.section] as unknown as Record<string, unknown>;
    for (const f of SETTINGS_SCHEMA.filter((x) => x.section === this.section)) {
      const v = values[f.key];
      const el = this.body.querySelector<HTMLInputElement>(`[data-key="${f.key}"]`);
      if (!el) continue;
      if (f.type === 'toggle') el.checked = v === true;
      else if (f.type === 'key') el.textContent = this.capturing === f ? 'Press a key…' : keyLabel(String(v));
      else el.value = String(v);
      if (f.type === 'range') {
        const out = this.body.querySelector(`[data-out="${f.key}"]`);
        if (out) out.textContent = f.format ? f.format(Number(v)) : String(v);
      }
    }
    if (this.section === 'controls') {
      const conflicts = findKeyConflicts(s.controls);
      const bad = new Set(conflicts.flatMap((c) => c.actions as string[]));
      for (const row of this.body.querySelectorAll<HTMLElement>('.settings-row')) row.classList.toggle('is-conflict', bad.has(row.dataset.row ?? ''));
      if (conflicts.length) {
        const name = (a: string) => SETTINGS_SCHEMA.find((f) => f.section === 'controls' && f.key === a)?.label ?? a;
        this.note.textContent = `Warning: ${conflicts.map((c) => `${keyLabel(c.key)} → ${c.actions.map(name).join(' + ')}`).join(' · ')}`;
        this.note.classList.add('is-warn');
        return;
      }
    }
    if (!this.capturing) {
      this.note.textContent = '';
      this.note.classList.remove('is-warn');
    }
  }

  private startCapture(key: string): void {
    this.stopCapture();
    this.capturing = SETTINGS_SCHEMA.find((f) => f.section === 'controls' && f.key === key) ?? null;
    if (!this.capturing) return;
    this.note.textContent = 'Press a key (can be combined with Shift) · Esc to cancel';
    this.note.classList.remove('is-warn');
    window.addEventListener('keydown', this.onCaptureKey, true);
    this.sync(this.store.value);
  }

  private stopCapture(): void {
    if (!this.capturing) return;
    this.capturing = null;
    window.removeEventListener('keydown', this.onCaptureKey, true);
  }

  /** Capture phase: the key never reaches the game or the menus. */
  private readonly onCaptureKey = (e: KeyboardEvent): void => {
    const field = this.capturing;
    if (!field) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code.startsWith('Shift') || e.code.startsWith('Control') || e.code.startsWith('Alt') || e.code.startsWith('Meta')) return;
    if (e.code === 'Escape') {
      this.stopCapture();
      this.note.textContent = '';
      this.sync(this.store.value);
      return;
    }
    const binding = e.shiftKey ? `Shift+${e.code}` : e.code;
    if (!isBindableKey(binding)) {
      this.note.textContent = `${keyLabel(binding)} is reserved (game / developer key).`;
      this.note.classList.add('is-warn');
      return;
    }
    this.stopCapture();
    this.store.set('controls', field.key, binding);
  };
}
