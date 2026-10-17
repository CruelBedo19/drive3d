/**
 * F2 → Dünya / Hava → Harita: live numbers of a procedural track (seed, chunks,
 * curvature, elevation, banking, environment, objects, colliders) and a seed
 * box to rebuild the road. Debug only: the player's saved profile is untouched.
 */
export interface MapDebugHost {
  trackDebug(): Record<string, string | number> | null;
  regenerateTrack(seed: number): void;
}

export class MapAdminPane {
  readonly root: HTMLElement;
  private readonly host: MapDebugHost;
  private readonly table: HTMLElement;
  private readonly seedInput: HTMLInputElement;

  constructor(host: MapDebugHost) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'admin-block';
    this.root.innerHTML = `
      <label class="admin-label">Harita (procedural)</label>
      <dl class="admin-kv"></dl>
      <div class="admin-actions"><input class="admin-seed" type="number" min="0" step="1" aria-label="Seed"><button data-regen>Yeniden üret</button><button data-random>Rastgele seed</button></div>
      <p class="admin-hint">Sadece bu sürüş için; araç yeni yolun başına konur.</p>`;
    this.table = this.root.querySelector('.admin-kv') as HTMLElement;
    this.seedInput = this.root.querySelector('.admin-seed') as HTMLInputElement;
    this.root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.dataset.regen !== undefined) this.host.regenerateTrack(Math.max(0, Math.floor(Number(this.seedInput.value) || 0)));
      else if (t.dataset.random !== undefined) {
        const seed = Math.floor(Math.random() * 1e6);
        this.seedInput.value = String(seed);
        this.host.regenerateTrack(seed);
      }
    });
    this.sync();
  }

  /** False when the current track has nothing to show (static maps). */
  get available(): boolean {
    return this.host.trackDebug() !== null;
  }

  sync(): void {
    const info = this.host.trackDebug();
    if (!info) return;
    if (document.activeElement !== this.seedInput) this.seedInput.value = String(info.Seed ?? '');
    this.table.innerHTML = Object.entries(info)
      .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
      .join('');
  }
}
