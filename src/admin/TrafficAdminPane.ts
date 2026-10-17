import type { TrafficDebugFlags } from '../traffic/TrafficDebugView';

/** What the traffic pane reads and toggles (implemented by Game). */
export interface TrafficDebugHost {
  trafficDebug(): { stats: Record<string, string | number>; selected: Record<string, string | number> | null } | null;
  trafficSelectNext(): void;
  readonly trafficFlags: TrafficDebugFlags | null;
}

const FLAG_LABELS: Record<keyof TrafficDebugFlags, string> = { lanes: 'Şerit çizgileri', nodes: 'Şerit noktaları', targets: 'AI hedefi', ranges: 'Algılama mesafesi' };

/**
 * F2 → Dünya → Trafik: live traffic numbers (counts per tier, spawns, lane
 * use, speeds, lane changes, update cost), one selected AI vehicle in detail,
 * and the debug drawing toggles.
 */
export class TrafficAdminPane {
  readonly root: HTMLElement;
  private readonly host: TrafficDebugHost;
  private readonly table: HTMLElement;
  private readonly sel: HTMLElement;

  constructor(host: TrafficDebugHost) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'admin-block';
    const flags = host.trafficFlags;
    const toggles = flags ? (Object.keys(FLAG_LABELS) as (keyof TrafficDebugFlags)[]).map((k) => `<button data-flag="${k}" class="${flags[k] ? 'on' : ''}">${FLAG_LABELS[k]}</button>`).join('') : '';
    this.root.innerHTML = `
      <label class="admin-label">Trafik</label>
      <dl class="admin-kv" data-stats></dl>
      <label class="admin-label">Seçili araç <button class="admin-mini" data-next>sonraki</button></label>
      <dl class="admin-kv" data-selected></dl>
      <div class="admin-actions">${toggles}</div>`;
    this.table = this.root.querySelector('[data-stats]') as HTMLElement;
    this.sel = this.root.querySelector('[data-selected]') as HTMLElement;
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.next !== undefined) this.host.trafficSelectNext();
      const flag = t.dataset.flag as keyof TrafficDebugFlags | undefined;
      const f = this.host.trafficFlags;
      if (flag && f) {
        f[flag] = !f[flag];
        t.classList.toggle('on', f[flag]);
      }
    });
    this.sync();
  }

  get available(): boolean {
    return this.host.trafficDebug() !== null;
  }

  sync(): void {
    const info = this.host.trafficDebug();
    if (!info) return;
    const kv = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
    this.table.innerHTML = kv(info.stats);
    this.sel.innerHTML = info.selected ? kv(info.selected) : '<dt>—</dt><dd>"sonraki" ile seç</dd>';
  }
}
