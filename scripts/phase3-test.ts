/**
 * Phase 3 shell logic without a browser: game flow, settings (versioned,
 * bindings), V / C camera keys, map and car selection, weather, pause.
 * Part of `npm run test:sim`.
 */
import * as THREE from 'three';
import { CHASE_CLOSE, CHASE_NORMAL, CameraRig, ChaseCamera, HoodCamera, type CameraTarget } from '../src/camera/CameraRig';
import { updateCameraInput, type KeyReader } from '../src/camera/cameraInput';
import { channelGains } from '../src/audio/AudioManager';
import { CAR_REGISTRY, carRatings, carSpecs, findCar, getCar, validateRegistry, type CarEntry } from '../src/config/carRegistry';
import { SETUP_IDS } from '../src/config/setups';
import { TRACK_IDS } from '../src/config/tracks';
import { DrivingSim } from '../src/core/DrivingSim';
import { GameFlow } from '../src/core/GameFlow';
import { acceptsDrivingInput, hasSession, showsDrivingHud, showsShowroom } from '../src/core/GameState';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { ProfileStore, type ProfileRules } from '../src/settings/Profile';
import { SETTINGS_KEY, SettingsStore, defaultSettings, findKeyConflicts, isBindableKey, keyLabel } from '../src/settings/Settings';
import { GltfCarVisual } from '../src/vehicle/visual/GltfCarVisual';
import { NordschleifeTrack } from '../src/world/nordschleife/NordschleifeTrack';
import { TestTrack } from '../src/world/TestTrack';
import { createTrack } from '../src/world/createTrack';
import { TRACK_CATALOG, trackInfo } from '../src/world/trackCatalog';
import { PRESET_HOURS, computeAtmosphere, wetGripFactor } from '../src/world/weather/Atmosphere';
import data from '../src/world/tracks/nordschleife.json';
import { check, finish, makeSim, section } from './lib/sim';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

class FakeKeys implements KeyReader {
  down = new Set<string>();
  pressed = new Set<string>();
  isDown(c: string) {
    return this.down.has(c);
  }
  wasPressed(c: string) {
    return this.pressed.has(c);
  }
}

const rules: ProfileRules = { trackIds: TRACK_IDS, carIds: CAR_REGISTRY.map((c) => c.id), setups: SETUP_IDS, defaults: { trackId: 'test', carId: 'car_01', setup: 'STREET' } };

async function main(): Promise<void> {
  section('Game state');
  {
    const f = new GameFlow();
    const seen: string[] = [];
    f.subscribe((s) => seen.push(s));
    f.go('MAIN_MENU');
    f.go('MAP_SELECT');
    f.go('CAR_CONFIRM');
    f.go('GARAGE');
    f.back();
    const garageBack = f.state;
    f.go('LOADING');
    f.go('DRIVING');
    check('boot → menu → map → car → garage → back → loading → driving', seen.join(',') === 'MAIN_MENU,MAP_SELECT,CAR_CONFIRM,GARAGE,CAR_CONFIRM,LOADING,DRIVING' && garageBack === 'CAR_CONFIRM', seen.join(' → '));
    check('driving input only in DRIVING', acceptsDrivingInput('DRIVING') && !['PAUSED', 'MAIN_MENU', 'SETTINGS', 'LOADING', 'GARAGE', 'MAP_SELECT'].some((s) => acceptsDrivingInput(s as never)), 'policy');
    f.escape();
    const paused = f.state;
    f.escape();
    const resumed = f.state;
    check('Esc: driving → pause → driving', paused === 'PAUSED' && resumed === 'DRIVING', `${paused} → ${resumed}`);
    f.go('PAUSED');
    f.go('SETTINGS');
    const fromPause = f.settingsFromPause && hasSession(f.state, f.settingsFromPause) && !showsShowroom(f.state, true);
    f.escape();
    check('pause → settings → Esc → pause (session kept alive behind)', fromPause && f.state === 'PAUSED', f.state);
    f.go('MAIN_MENU');
    check('return to main menu clears the history', f.state === 'MAIN_MENU' && f.previous === undefined && !f.escape(), `previous ${f.previous}`);
    f.go('SETTINGS');
    f.escape();
    check('menu → settings → Esc → menu (no session)', f.state === 'MAIN_MENU' && !hasSession('SETTINGS', false) && showsShowroom('SETTINGS', false), f.state);
    const g = new GameFlow();
    g.go('MAIN_MENU');
    g.go('MAP_SELECT');
    g.go('CAR_CONFIRM');
    g.go('LOADING');
    g.go('DRIVING');
    g.go('PAUSED');
    g.go('GARAGE');
    g.back();
    check('pause → garage → back goes to the main menu (session is gone)', g.state === 'MAIN_MENU', g.state);
    let threw = false;
    try {
      new GameFlow().go('DRIVING');
    } catch {
      threw = true;
    }
    check('invalid transitions are rejected', threw, 'BOOT → DRIVING throws');
    check('HUD visible only while driving / behind pause', showsDrivingHud('DRIVING') && showsDrivingHud('PAUSED') && !showsDrivingHud('MAIN_MENU') && !showsDrivingHud('LOADING'), 'policy');
  }

  section('Settings');
  {
    const storage = new MemoryStorage();
    const a = new SettingsStore(storage as unknown as Storage);
    a.set('audio', 'master', 0.35);
    a.set('audio', 'muteAll', true);
    a.set('graphics', 'shadows', 'low');
    a.set('graphics', 'resolutionScale', 0.75);
    a.set('graphics', 'fpsLimit', '60');
    a.set('controls', 'camera', 'KeyB');
    const b = new SettingsStore(storage as unknown as Storage).value;
    check('audio save / load', b.audio.master === 0.35 && b.audio.muteAll, JSON.stringify(b.audio));
    check('graphics save / load', b.graphics.shadows === 'low' && b.graphics.resolutionScale === 0.75 && b.graphics.fpsLimit === '60', JSON.stringify(b.graphics));
    check('controls save / load', b.controls.camera === 'KeyB' && b.controls.lookBack === 'KeyC', JSON.stringify(b.controls));
    const stored = JSON.parse(storage.data.get(SETTINGS_KEY) ?? '{}');
    check('stored with a version', stored.version === 2, `version ${stored.version}`);
    a.set('graphics', 'shadows', 'ultra');
    a.set('audio', 'master', 7);
    a.set('controls', 'throttle', 'Escape');
    a.set('controls', 'brake', '<script>');
    const v = a.value;
    check('invalid values fall back / clamp / are refused', v.graphics.shadows === 'low' && v.audio.master === 1 && v.controls.throttle === 'KeyW' && v.controls.brake === 'KeyS', `shadows ${v.graphics.shadows}, master ${v.audio.master}, throttle ${v.controls.throttle}`);
    const legacy = new MemoryStorage();
    legacy.setItem('drive3d.settings.v1', JSON.stringify({ ui: { minimapSide: 'right', speedUnit: 'mph' } }));
    const migrated = new SettingsStore(legacy as unknown as Storage);
    check('v1 (ui only) migrates to v2, other sections default', migrated.migratedFrom === 1 && migrated.value.ui.minimapSide === 'right' && migrated.value.audio.master === 0.8 && JSON.parse(legacy.data.get(SETTINGS_KEY) ?? '{}').version === 2, `migratedFrom ${migrated.migratedFrom}`);
    const future = new MemoryStorage();
    future.setItem(SETTINGS_KEY, JSON.stringify({ version: 99, ui: { minimapSide: 'right' } }));
    const reset = new SettingsStore(future as unknown as Storage);
    check('unknown newer version resets to defaults', reset.migratedFrom === 99 && JSON.stringify(reset.value) === JSON.stringify(defaultSettings()), `migratedFrom ${reset.migratedFrom}`);
    const controls = { ...defaultSettings().controls, camera: 'KeyC' };
    const conflicts = findKeyConflicts(controls);
    check('duplicate key detection', conflicts.length === 1 && conflicts[0].key === 'KeyC' && conflicts[0].actions.includes('camera') && conflicts[0].actions.includes('lookBack') && findKeyConflicts(defaultSettings().controls).length === 0, JSON.stringify(conflicts));
    check('reserved keys not bindable; Shift combos allowed', !isBindableKey('F2') && !isBindableKey('Escape') && isBindableKey('Shift+KeyR') && keyLabel('Shift+KeyR') === 'Shift + R', 'F2/Escape refused');
    a.reset('controls');
    check('reset one section', a.value.controls.camera === 'KeyV' && a.value.graphics.shadows === 'low', 'controls back to defaults, graphics kept');
    const g = channelGains({ master: 0.5, engine: 0.8, tyres: 1, ambience: 1, music: 1, musicEnabled: false, muteAll: false });
    check('audio channel gains (master × channel, music switch)', Math.abs(g.engine - 0.4) < 1e-9 && g.music === 0 && channelGains({ ...defaultSettings().audio, muteAll: true }).engine === 0, JSON.stringify(g));
  }

  section('Camera keys (V cycle, C hold to look back)');
  {
    const camera = new THREE.PerspectiveCamera();
    const target: CameraTarget = { position: new THREE.Vector3(0, 0.5, 0), quaternion: new THREE.Quaternion(), forwardSpeed: 0, hoodOffset: new THREE.Vector3(0, 1.1, 0.4) };
    const rig = new CameraRig(camera, [new ChaseCamera('chase', CHASE_NORMAL), new ChaseCamera('close', CHASE_CLOSE), new HoodCamera()]);
    rig.reset(target);
    const keys = new FakeKeys();
    const controls = defaultSettings().controls;
    const frame = (dt = 1 / 60) => {
      updateCameraInput(keys, controls, rig, target, true);
      rig.update(dt, target);
      keys.pressed.clear();
    };
    const names: string[] = [rig.mode.name];
    for (let i = 0; i < 3; i++) {
      keys.pressed.add('KeyV');
      frame();
      names.push(rig.mode.name);
    }
    check('V cycles chase → close → hood → chase', names.join(',') === 'chase,close,hood,chase', names.join(' → '));
    const behind = camera.position.z;
    keys.down.add('KeyC');
    let t = 0;
    while (rig.lookBackAmount < 0.99 && t < 1) {
      frame();
      t += 1 / 60;
    }
    const look = new THREE.Vector3();
    camera.getWorldDirection(look);
    check('C held: looks back within ~0.25 s (camera in front, facing backwards)', rig.lookingBack && t < 0.3 && camera.position.z > 0 && look.z < -0.5 && behind < 0, `${t.toFixed(2)} s, camera z ${camera.position.z.toFixed(2)} (was ${behind.toFixed(2)}), view z ${look.z.toFixed(2)}`);
    check('C does not change the camera mode', rig.mode.name === 'chase', rig.mode.name);
    keys.down.delete('KeyC');
    t = 0;
    while (rig.lookBackAmount > 0.01 && t < 1) {
      frame();
      t += 1 / 60;
    }
    camera.getWorldDirection(look);
    check('C released: back to the chase view', !rig.lookingBack && t < 0.3 && camera.position.z < 0 && look.z > 0.5 && rig.mode.name === 'chase', `${t.toFixed(2)} s, camera z ${camera.position.z.toFixed(2)}`);
    keys.pressed.add('KeyV');
    keys.pressed.add('KeyV');
    frame();
    keys.pressed.add('KeyV');
    frame();
    keys.down.add('KeyC');
    for (let i = 0; i < 4; i++) frame();
    camera.getWorldDirection(look);
    const hoodBack = rig.mode.name === 'hood' && look.z < -0.9 && camera.position.z < 0;
    keys.down.delete('KeyC');
    for (let i = 0; i < 4; i++) frame();
    camera.getWorldDirection(look);
    check('hood: C gives a rear-facing view, release restores the hood view', hoodBack && look.z > 0.9 && rig.mode.name === 'hood', `mode ${rig.mode.name}`);
    keys.pressed.add('KeyV');
    keys.down.add('KeyC');
    const changed = updateCameraInput(keys, controls, rig, target, false);
    rig.update(1 / 60, target);
    check('menu / pause: V and C do nothing', changed === null && rig.mode.name === 'hood' && !rig.lookingBack, `mode ${rig.mode.name}, looking back ${rig.lookingBack}`);
    keys.pressed.clear();
    keys.down.clear();
    const rebound = { ...controls, camera: 'KeyB' };
    keys.pressed.add('KeyB');
    const after = updateCameraInput(keys, rebound, rig, target, true);
    check('rebinding applies (camera on B)', after === 'chase', `→ ${after}`);
  }

  section('Map selection');
  {
    const storage = new MemoryStorage();
    const p = new ProfileStore(rules, storage as unknown as Storage);
    check('default map is the test track', p.value.trackId === 'test', p.value.trackId);
    p.update({ trackId: 'nordschleife' });
    check('Nordschleife selection persists', new ProfileStore(rules, storage as unknown as Storage).value.trackId === 'nordschleife', 'reloaded');
    p.update({ trackId: 'monza' });
    check('unknown map id falls back', p.value.trackId === 'test', p.value.trackId);
    const ns = trackInfo('nordschleife');
    const ys = data.points.map((q) => q[1]);
    check('map card stats come from the track data', !!ns && ns.length === data.length && ns.elevation === Math.round(Math.max(...ys) - Math.min(...ys)) && ns.corners === data.corners.length, `${((ns?.length ?? 0) / 1000).toFixed(2)} km, ${ns?.elevation} m, ${ns?.corners} corners`);
    check('test track card', trackInfo('test')?.type.includes('Test') === true && TRACK_CATALOG.length === 2, `${TRACK_CATALOG.map((t) => t.name).join(', ')}`);
    for (const id of ['test', 'nordschleife'] as const) {
      const physics = await PhysicsWorld.create();
      const track = createTrack(id, physics.world);
      check(`loading "${id}" builds the right track`, id === 'test' ? track instanceof TestTrack : track instanceof NordschleifeTrack, track.constructor.name);
      track.dispose();
      physics.dispose();
    }
  }

  section('Garage / vehicle registry');
  {
    const errors = validateRegistry();
    check('registry is valid, 3 slots', errors.length === 0 && CAR_REGISTRY.length === 3, errors.join('; ') || CAR_REGISTRY.map((c) => c.id).join(', '));
    const broken: CarEntry[] = [
      { ...CAR_REGISTRY[1], id: 'x' },
      { ...CAR_REGISTRY[1], id: 'x', aliases: [], definition: { ...CAR_REGISTRY[1].definition, visual: { ...CAR_REGISTRY[1].definition.visual, model: { ...CAR_REGISTRY[1].definition.visual.model!, nodes: { ...CAR_REGISTRY[1].definition.visual.model!.nodes, wheelRR: '' } } } } },
    ];
    const brokenErrors = validateRegistry(broken);
    check('validation catches duplicate ids and missing wheel nodes', brokenErrors.some((e) => e.includes('duplicate')) && brokenErrors.some((e) => e.includes('wheelRR')), brokenErrors.join('; '));
    check('ids and old aliases resolve; unknown → default', findCar('car_02')?.id === 'car_02' && findCar('test-gltf')?.id === 'car_02' && findCar('placeholder')?.id === 'car_01' && getCar('nope').id === 'car_01', 'aliases ok');
    const storage = new MemoryStorage();
    const p = new ProfileStore(rules, storage as unknown as Storage);
    p.update({ carId: 'car_03' });
    check('selected car persists', new ProfileStore(rules, storage as unknown as Storage).value.carId === 'car_03', 'reloaded');
    const s = carSpecs(getCar('car_01').definition.physics);
    const r = carRatings(getCar('car_01'));
    const rSport = carRatings(getCar('car_01'), 'SPORT');
    check('specs and ratings derived from the config', s.powerKw === 250 && s.massKg === 1400 && s.drivetrain === 'RWD' && Math.abs(s.wheelbaseM - 2.65) < 1e-9 && rSport.acceleration > r.acceleration, `${s.powerPs} PS, ${s.torqueNm} Nm, ratings ${JSON.stringify(r)} / SPORT ${JSON.stringify(rSport)}`);
    const def = getCar('car_02').definition;
    const visual = new GltfCarVisual(def.physics, def.visual, () => Promise.reject(new Error('404 test')));
    const warn = console.warn;
    console.warn = () => {};
    const loaded = await visual.ready;
    console.warn = warn;
    check('missing GLB falls back to the placeholder', loaded === false && visual.root.children.length > 0, `ready ${loaded}, ${visual.root.children.length} children`);
    visual.dispose();
  }

  section('Weather and time');
  {
    const noon = computeAtmosphere('clear', PRESET_HOURS.noon);
    const night = computeAtmosphere('clear', PRESET_HOURS.night);
    const light = (a: typeof noon) => a.sunIntensity + a.hemiIntensity;
    check('noon matches the original lighting', noon.sky === 0x9fb8cf && Math.abs(noon.sunIntensity - 2.2) < 0.05 && noon.night === 0, `sun ${noon.sunIntensity.toFixed(2)}, hemi ${noon.hemiIntensity.toFixed(2)}`);
    check('night is dark but drivable', night.night === 1 && light(night) < light(noon) * 0.4 && night.hemiIntensity >= 0.5, `light ${light(night).toFixed(2)} vs ${light(noon).toFixed(2)}, hemi ${night.hemiIntensity.toFixed(2)}`);
    const rain = computeAtmosphere('rain', 13);
    const fog = computeAtmosphere('fog', 13);
    check('rain: wet road, particles, less sun; fog: short visibility', rain.wetness === 1 && rain.rain === 1 && rain.sunIntensity < noon.sunIntensity * 0.3 && fog.visibility < 0.3, `rain sun ${rain.sunIntensity.toFixed(2)}, fog visibility ${fog.visibility}`);
    check('wet grip hook exists but does not change handling', wetGripFactor(1) === 1, 'factor 1');
    const evening = computeAtmosphere('clear', PRESET_HOURS.evening);
    check('custom hour works (00:00-23:59)', computeAtmosphere('clear', 23.99).night === 1 && evening.sunDirection.y > 0 && computeAtmosphere('clear', 25).hour === 1, `evening sun y ${evening.sunDirection.y.toFixed(2)}`);
    const storage = new MemoryStorage();
    const p = new ProfileStore(rules, storage as unknown as Storage);
    check('default weather: clear + noon', p.value.weather === 'clear' && p.value.time === 'noon' && p.value.customHour === null, JSON.stringify(p.value));
    p.update({ weather: 'rain', time: 'night', customHour: 21.5 });
    const re = new ProfileStore(rules, storage as unknown as Storage).value;
    p.update({ customHour: 30 });
    check('weather / time persist; bad hour rejected', re.weather === 'rain' && re.time === 'night' && re.customHour === 21.5 && p.value.customHour === null, JSON.stringify(re));
    const physics = await PhysicsWorld.create();
    const ns = new NordschleifeTrack(physics.world);
    ns.setWetness(1);
    const visibleBefore = ns.group.children.filter((c) => c.visible).length;
    ns.update({ camera: ns.spawn.position, vegetationDistance: 300 });
    const visibleAfter = ns.group.children.filter((c) => c.visible).length;
    check('Nordschleife: wet look and vegetation distance work', visibleAfter < visibleBefore, `${visibleBefore} → ${visibleAfter} visible meshes at 300 m`);
    ns.dispose();
    physics.dispose();
  }

  section('Pause');
  {
    const s = await makeSim(false, 0, 0, 0, { track: 'test' });
    const sim = new DrivingSim(s.physics, s.track!, s.vehicle, s.driving);
    const speedKmh = () => s.vehicle.physics.forwardSpeed * 3.6;
    s.keys.add('KeyW');
    for (let i = 0; i < 120; i++) sim.advance(1 / 60, true);
    const speed = speedKmh();
    const pos = s.vehicle.physics.position.clone();
    sim.releaseInput();
    let steps = 0;
    for (let i = 0; i < 120; i++) steps += sim.advance(1 / 60, false);
    const moved = s.vehicle.physics.position.distanceTo(pos);
    check('paused: physics does not step, car frozen', steps === 0 && moved < 1e-6 && Math.abs(speedKmh() - speed) < 1e-6, `${speed.toFixed(1)} km/h held, moved ${moved.toFixed(6)} m in 2 s`);
    check('paused: held keys are not read (input cleared)', s.driving.controls.throttle === 0, `throttle ${s.driving.controls.throttle}`);
    for (let i = 0; i < 60; i++) sim.advance(1 / 60, true);
    check('resume restores control', speedKmh() > speed + 5, `${speed.toFixed(1)} → ${speedKmh().toFixed(1)} km/h after 1 s`);
    sim.dispose();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
