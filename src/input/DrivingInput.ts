import { moveTowards } from '../utils/math';
import type { InputManager } from './InputManager';

/** Driver intent, independent of device. Values are smoothed, not raw key states. */
export interface DriverControls {
  /** 0..1 (W) */
  throttle: number;
  /** 0..1 (S): brake, or reverse throttle once stopped. */
  brake: number;
  /** -1 (left) .. +1 (right), raw target; the vehicle's steering smooths it. */
  steer: number;
  /** 0..1 (Space) */
  handbrake: number;
}

/** The rebindable driving keys (KeyboardEvent.code). */
export interface DrivingBindings {
  throttle: string;
  brake: string;
  left: string;
  right: string;
  handbrake: string;
}

export const DEFAULT_DRIVING_BINDINGS: DrivingBindings = { throttle: 'KeyW', brake: 'KeyS', left: 'KeyA', right: 'KeyD', handbrake: 'Space' };

/** Arrow keys always work as well, whatever the bindings. */
const FIXED_ALTERNATES: Partial<Record<keyof DrivingBindings, string>> = {
  throttle: 'ArrowUp',
  brake: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
};

/** Pedal rise / fall rates, full travel per second. Keyboards are on/off, pedals are not. */
const THROTTLE_UP = 7;
const THROTTLE_DOWN = 8;
const BRAKE_UP = 6;
const BRAKE_DOWN = 10;
const HANDBRAKE_UP = 6;
const HANDBRAKE_DOWN = 5;

export class DrivingInput {
  readonly controls: DriverControls = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  private readonly input: InputManager;
  private readonly bindings: () => DrivingBindings;

  /** `bindings` is read every step, so rebinding in the settings applies at once. */
  constructor(input: InputManager, bindings: () => DrivingBindings = () => DEFAULT_DRIVING_BINDINGS) {
    this.input = input;
    this.bindings = bindings;
  }

  /** Advances smoothing by dt. Called at the fixed physics rate. */
  update(dt: number): void {
    const c = this.controls;
    const b = this.bindings();
    const throttle = this.held(b, 'throttle') ? 1 : 0;
    const brake = this.held(b, 'brake') ? 1 : 0;
    const handbrake = this.held(b, 'handbrake') ? 1 : 0;
    c.throttle = moveTowards(c.throttle, throttle, (throttle > c.throttle ? THROTTLE_UP : THROTTLE_DOWN) * dt);
    c.brake = moveTowards(c.brake, brake, (brake > c.brake ? BRAKE_UP : BRAKE_DOWN) * dt);
    c.handbrake = moveTowards(c.handbrake, handbrake, (handbrake > c.handbrake ? HANDBRAKE_UP : HANDBRAKE_DOWN) * dt);
    c.steer = (this.held(b, 'right') ? 1 : 0) - (this.held(b, 'left') ? 1 : 0);
  }

  reset(): void {
    this.controls.throttle = 0;
    this.controls.brake = 0;
    this.controls.steer = 0;
    this.controls.handbrake = 0;
  }

  private held(b: DrivingBindings, action: keyof DrivingBindings): boolean {
    const alt = FIXED_ALTERNATES[action];
    return this.input.isDown(b[action].replace(/^Shift\+/, '')) || (alt !== undefined && this.input.isDown(alt));
  }
}
