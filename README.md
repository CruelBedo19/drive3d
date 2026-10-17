# Drive3D — Phase 3: game flow, garage, weather

TypeScript + Vite + Three.js + Rapier 3D.

```bash
npm install
PORT=$(freeport) && npm run dev -- --port $PORT   # http://localhost:$PORT
npm run build       # typecheck + production build
npm run test:sim    # headless tests: phase 1 driving, phase 2 physics, glTF/visuals, tracks
npm run test:track  # Nordschleife checks + a full autopilot lap (~2 min CPU)
npm run build:track # rebuild the Nordschleife centre line from the cached OSM / SRTM data (--refresh downloads again)
npm run bench       # physics cost per step
npm run make:test-model   # regenerate the unbranded test GLB
```

The game opens on the main menu: SÜR → map + weather → car confirm → loading → driving; GARAJ; AYARLAR.
Developer / old links still start driving directly (menus skipped, nothing saved):
`?track=test|nordschleife`, `?car=car_01|car_02|car_03` (old ids `placeholder`, `test-gltf` work), `?setup=STREET|SPORT|DRIFT`, `?admin`.

## Game flow

- `GameFlow` (`src/core/GameFlow.ts`) is the only place screens change: BOOT, MAIN_MENU, MAP_SELECT, CAR_CONFIRM,
  GARAGE, LOADING, DRIVING, PAUSED, SETTINGS, with a history for Esc / back (settings from pause return to pause).
- `App` (`src/app/App.ts`) owns the renderer, input, settings, profile, audio mixer, screens and the single animation
  loop. A driving session (`Game`: track, car, camera, HUD, weather, admin tools; simulation in `DrivingSim`) exists
  only in DRIVING / PAUSED; the garage showroom only behind the menus. Each is disposed when no longer shown.
- The car takes input and the simulation steps only in DRIVING. Pause = no physics step, held keys released.
- Esc: driving ⇄ pause menu (Devam et, Yeniden başlat, Ayarlar, Harita seç, Garaj, Ana menü); elsewhere one screen back.
- Garage: orbit (drag), zoom (wheel), ← → cars, "Bu aracı seç" (saved). Specs and rating bars come from the car config.
- Cars: `src/config/carRegistry.ts` (data-driven, 3 slots now, placeholders until real GLBs arrive).
- Weather / time: `src/world/weather/` (clear, cloudy, rain, fog × morning / noon / evening / night or an exact hour):
  sky, fog, sun / moon, ambient, exposure, rain streaks, wet-road look, headlight beam. Visual only; the wet-grip hook
  (`wetGripFactor`) returns 1.
- Saved in localStorage: `drive3d.settings` (versioned, v1 migrated), `drive3d.profile` (map, car, setup, weather, time).

## Super admin panel (F2)

Always on in `npm run dev`; in a production build only with `?admin` (a hidden switch, not access control).

- **Araç ayarları:** ~55 handling values (engine, gearbox, diff, tyres, steering, brakes, assists,
  suspension, centre of mass, aero) as sliders, applied live while driving. Changed values are highlighted
  and resettable; STREET / SPORT / DRIFT load a base; named presets, JSON export / import.
  The working tune is kept in this browser's localStorage and restored on reload (admin mode only).
- **Test ortamı:** teleports (420 m speed strip, skidpad, slalom, chicane, ramp, crash wall), slow motion
  (1× … 0.1×), pause `P` and single physics step `.`, automatic 0-100 / 0-200 / 100-0 / top speed /
  lateral g / drift-time measurements, live telemetry graph, debug panel and collider toggles.

## Physics

- Raycast suspension per wheel; each wheel has its own angular velocity (8 substeps per physics step).
- Combined-slip tyre: slip ratio and slip angle are normalised by their peaks and share one friction budget,
  so a spinning or locked wheel loses cornering grip (power oversteer, locked-wheel understeer).
- Engine → clutch → automatic gearbox → AWD split → axle differentials (OPEN / LSD with power, coast, preload).
- TC and ABS (0..1 in `assists`): feed-forward cap at the tyre's remaining grip plus slip feedback.
- Arcade helpers on top of the physics, per setup: counter-steer assist (front wheels follow the direction of
  travel while sliding) and a spin limiter. STREET / SPORT use a threshold (`assists.maxSlipDeg`: 20° / 14°);
  DRIFT uses a progressive curve (`assists.stabilityCurve`, drift angle -> strength) that stays almost silent
  in the 15-45° zone, eases in after 45° and backs off while the driver counter-steers
  (`countersteerRelief`). Set `stability` and `countersteerAssist` to 0 for pure physics.
- DRIFT keyboard helpers: steering ramp + expo (taps = small corrections), counter-steer cap (wheels at most
  10° beyond the direction of travel), wheelspin limiter (slip ratio 0.6 while steering, 0.08 with the wheel
  centred), and progressive slide recovery once the wheel is released (yaw damping towards what the steering
  asks for, sideways-speed bleed, traction control fading in). No teleporting.
- `npm run handling -- --detail` (cornering g, front/rear slip, drift angles), `-- --mistakes` (drift errors),
  `-- --sport '<json>'`; `npx tsx scripts/keyboard-scenarios.ts DRIFT|SPORT` prints keyboard timelines.
- Setups (`src/config/setups`) are data only; SPORT and DRIFT override the STREET base.
- `npm run handling` prints the tuning numbers per setup (0-100, lane change, power-on corner, handbrake,
  keyboard-only drift).

## HUD and settings

- Player HUD (only while driving): speedometer bottom right (digital speed, km/h or mph, gear, RPM arc with
  redline zone, TC / ABS lamps that light while they intervene, handbrake warning), minimap bottom left.
  The top of the screen is kept free for race information. Developer telemetry stays in the F3 overlay.
- Minimap: a 2D canvas fed by the generic `MapData` (`src/ui/map/MapData.ts`: paths + markers in world metres).
  Every `Track` provides one; a future city map can add roads, garages, events and a route the same way.
  Paths become `Path2D` once; each frame only sets a transform and strokes them (no 3D render, no DOM per feature).
  Modes: fixed (north up, arrow turns) or rotating (heading up, player drawn lower to show more road ahead).
- Settings (main menu or pause): Arayüz, Ses (volumes for the coming audio, `AudioManager` mixer), Grafik (shadow quality,
  resolution scale, view distance, vegetation distance, FPS cap; anti-aliasing applies after a reload), Kontroller
  (rebind by pressing a key, duplicate warning, reset). The schema in `src/settings/Settings.ts` drives defaults,
  validation and the screen.
- Sizes scale with the HUD scale setting, capped at 30% of the viewport height, with safe-area padding.

## Tracks

- `test` (default): the physics test ground (stadium circuit, skidpad, slalom, ramp, crash wall).
- `nordschleife`: the Nürburgring Nordschleife, 20.7 km, 289 m of elevation, from the T13 start.
  - The centre line comes from OpenStreetMap (route relation 38566, the corner names too) and SRTM elevation,
    turned into `src/world/tracks/nordschleife.json` by `scripts/build-nordschleife.ts`. Sources are cached in
    `scripts/data/`, so the build is offline and repeatable.
  - Everything else is generated in `src/world/nordschleife/`, sized by `NORDSCHLEIFE` in `src/config/tracks.ts`:
    10 m asphalt, edge and centre lines, kerbs on corners, grass shoulders, guard rails, verge, trees.
  - Physics is one fixed body: a ground trimesh split into columns across the track, plus box guard rails.
    The ground stops before it would reach another part of the lap (the two Karussell legs are 29 m apart).
  - Admin teleports: start and eight corners (Hatzenbach … Döttinger Höhe).

## Real car models (glTF)

Set `visual.kind: 'gltf'` and `visual.model` in the car's config:

```ts
model: {
  url: '/assets/vehicles/<car>/<car>.glb',
  nodes: { wheelFL: 'WheelFL', wheelFR: ..., wheelRL: ..., wheelRR: ...,      // required
           body, steeringWheel, headlights: ['L', 'R'], brakeLights, reverseLights }, // optional
  scale: 1, rotationYDeg: 0, offset: { x: 0, y: 0, z: 0 },
  wheelPlacement: 'model',            // or 'physics'
  steeringWheelAxis: 'z', steeringWheelMaxDeg: 270,
}
```

Names may be a list of candidates; matching falls back to case/punctuation-insensitive. If the file fails to
load or a wheel node is missing, the placeholder car is shown and a warning names the missing nodes.
See `src/config/vehicles/testGltfCar.ts`.
```

## Controls

| Key | Action |
| --- | --- |
| W / ↑ | throttle |
| S / ↓ | brake, reverse once stopped |
| A / D, ← / → | steer |
| Space | handbrake |
| R | put the car back on its wheels where it is (keys are rebindable in Ayarlar → Kontroller) |
| Shift+R | back to the start line |
| V | camera: chase → close → hood |
| C (hold) | look back |
| Esc | pause / back |
| F2 | super admin panel (dev, or `?admin`) |
| P / . | pause / single physics step (admin) |
| F3 / F4 | debug panel / collider wireframes (dev or admin) |

## Layout

```
src/
  app/       App shell (screens, loop, session / showroom lifecycle)
  core/      GameFlow + GameState, Game (driving session), DrivingSim (fixed 120 Hz steps), Renderer, PhysicsWorld
  garage/    GarageScene (showroom, orbit camera)
  audio/     AudioManager (mixer channels, no sounds yet)
  config/    vehicleTypes.ts (all tunables), vehicles/*.ts (one file per car), setups/ (STREET, later SPORT/DRIFT)
  vehicle/   Vehicle (driver logic), Steering
    physics/     VehiclePhysics (suspension, wheel spin, combined-slip tyres, TC/ABS, aero), WheelState
    powertrain/  Engine, Gearbox (auto R/N/1-6), Powertrain (clutch, rpm), Differential (OPEN/LSD)
    visual/      VehicleVisual interface, PlaceholderCarVisual, GltfCarVisual, VisualParts (wheel rig, lamps)
  camera/    CameraRig with chase / close / hood modes
  input/     InputManager (raw keys), DrivingInput (smoothed driver controls)
  world/     Track interface, TestTrack, nordschleife/ (centre line, strip meshes, colliders), tracks/*.json
  ui/        Hud (player HUD), hud/Speedometer, map/ (MapData, Minimap), screens/ (menus, settings), dev debug overlay
  settings/  Settings schema + store (versioned), Profile (last map / car / weather)
  admin/     super admin panel: tuning schema, live config, presets, measurements, telemetry graph
  utils/     math, FPS counter
public/assets/{vehicles,environment,audio}   (vehicles/test-car/test-car.glb: generated test model)
scripts/     sim-test.ts, vehicle-test.ts, visual-test.ts, admin-test.ts, keyboard-test.ts, track-test.ts, hud-test.ts, phase3-test.ts, lib/sim.ts,
             bench.ts, make-test-model.ts, build-nordschleife.ts (+ data/ source cache)
```

Vehicle frame: +Z forward, +Y up, +X left (glTF convention).

## Credits

See [CREDITS.md](CREDITS.md). In short: Nordschleife track data © OpenStreetMap contributors (ODbL 1.0),
elevation from SRTM; parts of the track geometry code adapted from Nordschleife Racer (MIT).
