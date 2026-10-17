import type { GameState } from './GameState';

/** Which screens each state may go to (back() and escape() follow the history instead). */
const ALLOWED: Record<GameState, readonly GameState[]> = {
  BOOT: ['MAIN_MENU', 'LOADING'],
  MAIN_MENU: ['MAP_SELECT', 'GARAGE', 'SETTINGS'],
  MAP_SELECT: ['CAR_CONFIRM'],
  CAR_CONFIRM: ['GARAGE', 'LOADING'],
  GARAGE: [],
  LOADING: ['DRIVING', 'MAIN_MENU'],
  DRIVING: ['PAUSED'],
  PAUSED: ['DRIVING', 'SETTINGS', 'LOADING', 'MAP_SELECT', 'GARAGE', 'MAIN_MENU'],
  SETTINGS: [],
};

/** Leaving these never leaves a way back to them. */
const TRANSIENT: ReadonlySet<GameState> = new Set(['BOOT', 'LOADING']);

export type FlowListener = (state: GameState, previous: GameState) => void;

/**
 * The one place screen changes happen. Keeps a history so Esc / "Geri" return
 * to the screen that opened the current one (settings from the pause menu go
 * back to the pause menu, from the main menu to the main menu). Pure logic: the
 * App reacts to changes through listeners.
 */
export class GameFlow {
  private current: GameState = 'BOOT';
  private history: GameState[] = [];
  private readonly listeners = new Set<FlowListener>();

  get state(): GameState {
    return this.current;
  }

  /** The screen back() returns to, if any. */
  get previous(): GameState | undefined {
    return this.history[this.history.length - 1];
  }

  /** Settings opened from the pause menu (a driving session is still alive behind it). */
  get settingsFromPause(): boolean {
    return this.current === 'SETTINGS' && this.previous === 'PAUSED';
  }

  canGo(next: GameState): boolean {
    return ALLOWED[this.current].includes(next);
  }

  go(next: GameState): void {
    if (!this.canGo(next)) throw new Error(`GameFlow: ${this.current} → ${next} not allowed`);
    const prev = this.current;
    if (next === 'DRIVING' || next === 'MAIN_MENU') {
      // Entering a session or the main menu starts a fresh history.
      this.history = [];
    } else if (prev === 'PAUSED' && (next === 'MAP_SELECT' || next === 'GARAGE')) {
      // Leaving a session for a menu: "back" from there goes to the main menu, not the dead session.
      this.history = ['MAIN_MENU'];
    } else if (next === 'LOADING') {
      this.history = [];
    } else if (!TRANSIENT.has(prev)) {
      this.history.push(prev);
    }
    this.current = next;
    this.emit(prev);
  }

  /** Previous screen; false when there is nowhere to go back to. */
  back(): boolean {
    const target = this.history.pop();
    if (!target) return false;
    const prev = this.current;
    this.current = target;
    this.emit(prev);
    return true;
  }

  /** Esc: driving ⇄ pause, otherwise one screen back. */
  escape(): boolean {
    if (this.current === 'DRIVING') {
      this.go('PAUSED');
      return true;
    }
    if (this.current === 'PAUSED') {
      this.go('DRIVING');
      return true;
    }
    if (this.current === 'LOADING' || this.current === 'BOOT') return false;
    return this.back();
  }

  subscribe(listener: FlowListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(prev: GameState): void {
    for (const l of this.listeners) l(this.current, prev);
  }
}
