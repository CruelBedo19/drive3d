/** Top-level game state; GameFlow moves between them. */
export type GameState = 'BOOT' | 'MAIN_MENU' | 'MAP_SELECT' | 'CAR_CONFIRM' | 'GARAGE' | 'LOADING' | 'DRIVING' | 'PAUSED' | 'SETTINGS';

/** Only here does the car take player input and the simulation run. */
export const acceptsDrivingInput = (s: GameState) => s === 'DRIVING';
/** A driving session (track + car) exists in these states. */
export const hasSession = (s: GameState, settingsFromPause: boolean) => s === 'DRIVING' || s === 'PAUSED' || (s === 'SETTINGS' && settingsFromPause);
/** The driving HUD is shown while driving and stays behind the pause overlay. */
export const showsDrivingHud = (s: GameState) => s === 'DRIVING' || s === 'PAUSED';
/** The garage / showroom scene is shown behind these screens. */
export const showsShowroom = (s: GameState, settingsFromPause: boolean) =>
  s === 'MAIN_MENU' || s === 'MAP_SELECT' || s === 'CAR_CONFIRM' || s === 'GARAGE' || (s === 'SETTINGS' && !settingsFromPause);
