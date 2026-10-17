import type { ControlSettings } from '../settings/Settings';
import type { CameraRig, CameraTarget } from './CameraRig';

/** The part of InputManager the camera keys need (also faked in tests). */
export interface KeyReader {
  isDown(code: string): boolean;
  wasPressed(code: string): boolean;
}

/** Binding ("KeyV", "Shift+KeyC") → is the key held. Shift prefixes only matter for presses. */
export function bindingCode(binding: string): string {
  return binding.startsWith('Shift+') ? binding.slice(6) : binding;
}

/**
 * Camera keys for one frame. V (camera binding) cycles chase → close → hood;
 * holding C (lookBack binding) looks backwards until it is released. With
 * `enabled` false (any menu / pause) nothing reaches the camera and a held
 * look-back is released. Returns the new mode name when it changed.
 */
export function updateCameraInput(input: KeyReader, controls: Pick<ControlSettings, 'camera' | 'lookBack'>, rig: CameraRig, target: CameraTarget, enabled: boolean): string | null {
  if (!enabled) {
    rig.setLookBack(false);
    return null;
  }
  rig.setLookBack(input.isDown(bindingCode(controls.lookBack)));
  if (input.wasPressed(bindingCode(controls.camera))) {
    rig.next(target);
    return rig.mode.name;
  }
  return null;
}
