/**
 * Weather system without a browser: presets and transitions, clock and sun,
 * wet / dry road, fog, rain, sky, headlights, quality levels, persistence,
 * tracks, pause. Part of `npm run test:sim`.
 */
import * as THREE from 'three';
import { getCar } from '../src/config/carRegistry';
import { SETUP_IDS } from '../src/config/setups';
import { TRACK_IDS } from '../src/config/tracks';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { ProfileStore, profileHour, type ProfileRules } from '../src/settings/Profile';
import { SettingsStore, defaultSettings, findKeyConflicts } from '../src/settings/Settings';
import { NordschleifeTrack } from '../src/world/nordschleife/NordschleifeTrack';
import { TestTrack } from '../src/world/TestTrack';
import { HeadlightController, HeadlightRig } from '../src/world/weather/Headlights';
import { Rain } from '../src/world/weather/Rain';
import { SkyDome } from '../src/world/weather/SkyDome';
import { WEATHER_QUALITY } from '../src/world/weather/WeatherManager';
import { PRESET_HOURS, WEATHER_PRESETS, WeatherState, sunPosition, wetGripFactor } from '../src/world/weather/WeatherState';
import { CAR_REGISTRY } from '../src/config/carRegistry';
import { check, finish, section } from './lib/sim';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

const rules: ProfileRules = { trackIds: TRACK_IDS, carIds: CAR_REGISTRY.map((c) => c.id), setups: SETUP_IDS, defaults: { trackId: 'test', carId: 'bmw_m3_e92', setup: 'STREET' } };
const run = (w: WeatherState, seconds: number, step = 0.1) => {
  for (let t = 0; t < seconds; t += step) w.update(step);
};

async function main(): Promise<void> {
  section('Presets and transitions');
  {
    const w = new WeatherState('clear', 13);
    w.setWeather('heavyRain');
    w.update(0.1);
    const early = { ...w.params };
    run(w, 15);
    check('switching rolls in smoothly (no cut)', early.rain > 0 && early.rain < 0.2 && w.params.rain > 0.95, `rain after 0.1 s ${early.rain.toFixed(3)}, after 15 s ${w.params.rain.toFixed(2)}`);
    w.setWeather('clear', true);
    check('instant switch snaps everything (and dries the road)', w.params.rain === 0 && w.wetness === 0 && w.weather === 'clear', `rain ${w.params.rain}, wet ${w.wetness}`);
    const vis = (['clear', 'cloudy', 'rain', 'heavyRain', 'fog'] as const).map((k) => new WeatherState(k, 13).snapshot().visibility);
    check('fog: visibility clear > cloudy > rain > heavy rain > fog', vis.every((v, i) => i === 0 || v < vis[i - 1]), vis.map((v) => v.toFixed(2)).join(' > '));
    const rain = (['clear', 'cloudy', 'rain', 'heavyRain', 'fog'] as const).map((k) => new WeatherState(k, 13).snapshot().rain);
    check('rain only in rain presets, heavier in heavy rain', rain[0] === 0 && rain[1] === 0 && rain[4] === 0 && rain[3] > rain[2] && rain[2] > 0, rain.join(' / '));
    const clouds = (['clear', 'cloudy', 'rain', 'heavyRain'] as const).map((k) => WEATHER_PRESETS[k].clouds);
    check('clouds: few → many → very many', clouds.every((v, i) => i === 0 || v > clouds[i - 1]), clouds.join(' < '));
    check('wet grip hook stays neutral (handling frozen)', wetGripFactor(1) === 1 && new WeatherState('heavyRain', 13).snapshot().wetness === 1, 'factor 1');
  }

  section('Clock and sun');
  {
    const alt = (h: number) => (sunPosition(h).altitude * 180) / Math.PI;
    const az = (h: number) => (sunPosition(h).azimuth * 180) / Math.PI;
    check('07:00 rising in the east, low', alt(7) > 0 && alt(7) < 12 && az(7) > 30 && az(7) < 150, `alt ${alt(7).toFixed(1)}°, azimuth ${az(7).toFixed(0)}°`);
    check('13:00 highest, roughly south', alt(13) > 40 && Math.abs(Math.abs(az(13)) - 180) < 20, `alt ${alt(13).toFixed(1)}°, azimuth ${az(13).toFixed(0)}°`);
    check('19:00 setting in the west, low', alt(19) > 0 && alt(19) < 12 && az(19) < -30, `alt ${alt(19).toFixed(1)}°, azimuth ${az(19).toFixed(0)}°`);
    check('23:00 below the horizon', alt(23) < -10, `alt ${alt(23).toFixed(1)}°`);
    let maxJump = 0;
    for (let h = 0; h < 24; h += 1 / 60) maxJump = Math.max(maxJump, Math.abs(alt(h + 1 / 60) - alt(h)));
    check('sun moves smoothly (no jumps)', maxJump < 0.3, `largest step per minute ${maxJump.toFixed(3)}°`);
    const w = new WeatherState('clear', 7);
    const dark = new WeatherState('clear', 23).snapshot();
    const day = new WeatherState('clear', 13).snapshot();
    check('presets: 07 / 13 / 19 / 23', PRESET_HOURS.morning === 7 && PRESET_HOURS.noon === 13 && PRESET_HOURS.evening === 19 && PRESET_HOURS.night === 23, JSON.stringify(PRESET_HOURS));
    check('night: dark, stars, moonlight from above; day: no stars', dark.night === 1 && dark.stars > 0.5 && dark.light.y > 0.3 && day.stars === 0 && day.lightIntensity > dark.lightIntensity * 4, `night light ${dark.lightIntensity.toFixed(2)}, day ${day.lightIntensity.toFixed(2)}`);
    w.timeRate = 1;
    run(w, 2, 0.5);
    w.setHour(25.5);
    check('clock runs and wraps 00:00-23:59', w.hour === 1.5, `hour ${w.hour}`);
    const evening = new WeatherState('clear', 19).snapshot();
    check('evening light is warm (golden)', evening.golden > 0.3 && (evening.lightColor >> 16) > ((evening.lightColor >> 8) & 0xff), `golden ${evening.golden.toFixed(2)}, light #${evening.lightColor.toString(16)}`);
  }

  section('Wet road');
  {
    const w = new WeatherState('clear', 13);
    w.setWeather('heavyRain');
    const states: string[] = [];
    let tDamp = -1;
    let tWet = -1;
    for (let t = 0; t < 60; t += 0.1) {
      w.update(0.1);
      const s = w.snapshot().road;
      if (states.at(-1) !== s) states.push(s);
      if (s === 'damp' && tDamp < 0) tDamp = t;
      if (s === 'wet' && tWet < 0) tWet = t;
    }
    check('rain soaks the road gradually: dry → damp → wet', states.join('>') === 'dry>damp>wet' && tDamp > 1 && tWet > tDamp + 3, `${states.join(' → ')}, damp at ${tDamp.toFixed(1)} s, wet at ${tWet.toFixed(1)} s`);
    w.setWeather('clear');
    const dry: string[] = [];
    let tDry = -1;
    for (let t = 0; t < 300; t += 0.25) {
      w.update(0.25);
      const s = w.snapshot().road;
      if (dry.at(-1) !== s) dry.push(s);
      if (s === 'dry' && tDry < 0) tDry = t;
    }
    check('drying is slower: wet → damp → dry', dry.join('>') === 'wet>damp>dry' && tDry > tWet * 2, `${dry.join(' → ')}, dry after ${tDry.toFixed(0)} s (wetting took ${tWet.toFixed(0)} s)`);
    const light = new WeatherState('rain', 13);
    check('light rain leaves it wet but less soaked than a downpour', light.wetness < 1 && light.wetness > 0.6, `rain preset wetness ${light.wetness.toFixed(2)}`);
    const tuned = new WeatherState('clear', 13);
    tuned.tuning.wetness = 0.5;
    tuned.update(0.1);
    tuned.tuning.wetness = null;
    tuned.tuning.dryingRate = 1;
    tuned.update(0.6);
    check('admin overrides: wetness and drying speed', tuned.wetness === 0, `after override + fast drying: ${tuned.wetness}`);
  }

  section('Pause / resume');
  {
    const w = new WeatherState('clear', 13);
    w.setWeather('heavyRain');
    run(w, 5);
    const before = { wet: w.wetness, rain: w.params.rain, hour: w.hour };
    w.timeRate = 1;
    for (let i = 0; i < 100; i++) w.update(0);
    check('paused (dt 0): nothing rains in, dries or ticks', w.wetness === before.wet && w.params.rain === before.rain && w.hour === before.hour, `wetness ${w.wetness.toFixed(3)} kept`);
    w.timeRate = 0;
    run(w, 2);
    check('resume continues the transition', w.wetness > before.wet, `${before.wet.toFixed(3)} → ${w.wetness.toFixed(3)}`);
  }

  section('Sky, clouds, rain particles, quality');
  {
    const sky = new SkyDome();
    const cam = new THREE.Vector3(1000, 50, -2000);
    sky.update(1, cam, new WeatherState('cloudy', 13).snapshot());
    const u = (sky.sky.material as THREE.ShaderMaterial).uniforms;
    const cloudy = u.cloudCoverage.value;
    sky.setCloudsEnabled(false);
    sky.update(1, cam, new WeatherState('cloudy', 13).snapshot());
    check('sky follows the camera; clouds from the weather, off at low quality', sky.sky.position.equals(cam) && cloudy > 0.5 && u.cloudCoverage.value === 0, `coverage ${cloudy} → ${u.cloudCoverage.value}`);
    sky.update(1, cam, new WeatherState('clear', 23).snapshot());
    const night = sky.stars.visible;
    sky.update(1, cam, new WeatherState('heavyRain', 23).snapshot());
    check('stars on clear nights only', night && !sky.stars.visible, `clear night ${night}, rainy night ${sky.stars.visible}`);
    sky.dispose();

    const q = (['low', 'medium', 'high'] as const).map((k) => WEATHER_QUALITY[k].drops);
    check('quality levels: more rain and clouds at higher levels', q[0] < q[1] && q[1] < q[2] && !WEATHER_QUALITY.low.clouds && WEATHER_QUALITY.high.clouds && q[2] <= 15000, `drops ${q.join(' / ')}`);
    const rain = new Rain(WEATHER_QUALITY.medium);
    const geo = rain.object.geometry;
    rain.update(0.016, cam, 0.5, new THREE.Vector3(30, 0, 0), 1);
    const half = geo.drawRange.count;
    rain.update(0.016, cam, 1, new THREE.Vector3(), 1);
    const full = geo.drawRange.count;
    rain.update(0.016, cam, 0, new THREE.Vector3(), 1);
    check('rain: draws per intensity, off when dry (static buffer, no per-frame allocation)', half === WEATHER_QUALITY.medium.drops && full === half * 2 && !rain.object.visible, `0.5 → ${half / 2} drops, 1 → ${full / 2}, 0 → hidden`);
    const before = geo.attributes.position;
    rain.setQuality(WEATHER_QUALITY.high);
    check('quality change rebuilds the drop buffer once', geo.attributes.position !== before && geo.attributes.position.count === WEATHER_QUALITY.high.drops * 2, `${geo.attributes.position.count / 2} drops`);
    rain.dispose();
  }

  section('Headlights');
  {
    const m = new HeadlightController('manual');
    m.update(true);
    const offByDefault = !m.on;
    m.toggle();
    m.update(false);
    const on = m.on;
    m.toggle();
    m.update(true);
    check('manual: L toggles, conditions are ignored', offByDefault && on && !m.on, `start off, L → on, L → off`);
    const a = new HeadlightController('auto');
    const noon = HeadlightController.wanted(new WeatherState('clear', 13).snapshot());
    const night = HeadlightController.wanted(new WeatherState('clear', 23).snapshot());
    const heavy = HeadlightController.wanted(new WeatherState('heavyRain', 13).snapshot());
    check('auto wants lights at night and in heavy rain, not at a clear noon', !noon && night && heavy, `noon ${noon}, night ${night}, heavy rain ${heavy}`);
    a.update(true);
    const autoOn = a.on;
    a.toggle();
    a.update(true);
    const overridden = !a.on;
    a.update(false);
    a.update(true);
    check('auto: L overrides until the conditions change, then auto takes over', autoOn && overridden && a.on, `auto on → L off (held) → conditions flip → auto again`);
    const one = getCar('amg_one');
    const rig = new HeadlightRig(one.definition.physics.chassis.halfExtents.z, 0.05);
    rig.update(true, 1, 1);
    const spot = rig.group.children.find((c): c is THREE.SpotLight => c instanceof THREE.SpotLight);
    check('car without head lamp meshes (ONE, 911 RSR) still lights the road (generic spot, no shadows)', !one.definition.visual.model?.nodes.headlights && !getCar('porsche_911_gt3_rsr').definition.visual.model?.nodes.headlights && !!spot && spot.intensity > 0 && !spot.castShadow, `spot ${spot?.intensity}, shadow ${spot?.castShadow}`);
    rig.update(false, 1, 1);
    check('off: zero intensity (no shader recompile from toggling the light)', spot?.intensity === 0, 'intensity 0');
    rig.dispose();
    const s = new SettingsStore(new MemoryStorage() as unknown as Storage);
    check('L bound by default, no key conflicts', s.value.controls.headlights === 'KeyL' && findKeyConflicts(defaultSettings().controls).length === 0 && s.value.ui.headlightMode === 'auto', `headlights ${s.value.controls.headlights}, mode ${s.value.ui.headlightMode}`);
  }

  section('Settings and save');
  {
    const storage = new MemoryStorage();
    const st = new SettingsStore(storage as unknown as Storage);
    st.set('graphics', 'weatherQuality', 'high');
    st.set('ui', 'headlightMode', 'manual');
    st.set('graphics', 'weatherQuality', 'ultra');
    const re = new SettingsStore(storage as unknown as Storage).value;
    check('weather quality / headlight mode persist; invalid ignored', re.graphics.weatherQuality === 'high' && re.ui.headlightMode === 'manual', JSON.stringify({ q: re.graphics.weatherQuality, mode: re.ui.headlightMode }));
    const ps = new MemoryStorage();
    const p = new ProfileStore(rules, ps as unknown as Storage);
    p.update({ weather: 'heavyRain', time: 'custom', customHour: 5.25 });
    const back = new ProfileStore(rules, ps as unknown as Storage).value;
    check('weather + custom time saved and restored', back.weather === 'heavyRain' && back.time === 'custom' && profileHour(back, PRESET_HOURS) === 5.25, JSON.stringify(back));
    ps.setItem('drive3d.profile', JSON.stringify({ version: 1, weather: 'storm', time: 'custom', customHour: null }));
    const bad = new ProfileStore(rules, ps as unknown as Storage).value;
    check('invalid saved weather / time fall back to clear / noon', bad.weather === 'clear' && bad.time === 'noon' && profileHour(bad, PRESET_HOURS) === 13, JSON.stringify(bad));
    ps.setItem('drive3d.profile', JSON.stringify({ version: 1, weather: 'fog', time: 'night', customHour: 21 }));
    const old = new ProfileStore(rules, ps as unknown as Storage).value;
    check('older saves (preset + hour) read as custom time', old.time === 'custom' && old.customHour === 21, JSON.stringify(old));
  }

  section('Tracks');
  {
    const physics = await PhysicsWorld.create();
    const test = new TestTrack(physics.world);
    test.setWetness(1);
    test.setWetness(0);
    const ns = new NordschleifeTrack(physics.world);
    // Asphalt: the roughness 0.93 / metalness 0.02 material (textures don't exist headless).
    const asphalt = ns.group.children.find((c): c is THREE.Mesh => c instanceof THREE.Mesh && (c.material as THREE.MeshStandardMaterial).roughness === 0.93 && (c.material as THREE.MeshStandardMaterial).metalness === 0.02);
    const mat = asphalt?.material as THREE.MeshStandardMaterial | undefined;
    const dry = mat ? { r: mat.roughness, c: mat.color.r } : null;
    ns.setWetness(1);
    const wet = mat ? { r: mat.roughness, c: mat.color.r, env: mat.envMapIntensity } : null;
    ns.setWetness(0);
    check('Nordschleife asphalt: wet = darker, smoother, more reflective; dries back exactly', !!dry && !!wet && wet.r < dry.r && wet.r >= 0.38 && wet.c < dry.c && wet.env > 1 && mat!.roughness === dry.r, `roughness ${dry?.r} → ${wet?.r}, env ${wet?.env}`);
    check('TestTrack has the same wet hook', typeof test.setWetness === 'function', 'ok');
    ns.dispose();
    test.dispose();
    physics.dispose();
  }
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
