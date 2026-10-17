/**
 * Raw keyboard state, by physical key code (KeyboardEvent.code) so the layout
 * (QWERTY / Turkish Q / AZERTY) does not matter. Gamepad can be added here later.
 */
export class InputManager {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly pressedShift = new Set<string>();
  private readonly target: Window;

  /** Keys whose browser default (scrolling, page find...) must not fire. */
  private static readonly CAPTURED = new Set([
    'Space',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'F2',
    'F3',
    'F4',
  ]);

  constructor(target: Window = window) {
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True only on the frame the key went down. */
  wasPressed(code: string): boolean {
    return this.pressed.has(code);
  }

  /**
   * True on the frame the key went down with Shift held at that moment. Read from
   * the event itself, so a quick Shift+key tap between two frames is not lost.
   */
  wasPressedWithShift(code: string): boolean {
    return this.pressedShift.has(code);
  }

  /** Clears one-frame state. Call once at the end of every rendered frame. */
  endFrame(): void {
    this.pressed.clear();
    this.pressedShift.clear();
  }

  dispose(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // Typing into a form field (admin panel) must not drive the car.
    if (isFormField(e.target)) return;
    if (InputManager.CAPTURED.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      this.pressed.add(e.code);
      if (e.shiftKey) this.pressedShift.add(e.code);
    }
    this.down.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  /** Losing focus must not leave the throttle stuck down. */
  private readonly onBlur = (): void => {
    this.down.clear();
  };
}

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return target.type !== 'range' && target.type !== 'button' && target.type !== 'checkbox';
  return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}
