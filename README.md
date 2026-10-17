# Drive3D — game flow, garage, weather, Autobahn with traffic

TypeScript + Vite + Three.js + Rapier 3D.

```bash
npm install
PORT=$(freeport) && npm run dev -- --port $PORT   # http://localhost:$PORT
npm run build       # typecheck + production build
npm run test:sim    # headless tests: phase 1 driving, phase 2 physics, glTF/visuals, tracks
npm run test:track  # Nordschleife checks + a full autopilot lap (~2 min CPU)
npm run test:autobahn # Autobahn checks + long autopilot drives incl. 50 km at 300 km/h (~17 min CPU)
npm run test:world    # infinite landscape: seeds, biomes, tile seams / LOD, corridor, lifecycle (also in test:sim)
npm run test:traffic  # AI traffic: lanes, following, overtaking, 300 km/h player, weather, lights, collisions (also in test:sim)
npm run test:longrun  # 100 km with traffic + landscape at 130 / 200 / 300 km/h (~2 min CPU)
npm run build:track # rebuild the Nordschleife centre line from the cached OSM / SRTM data (--refresh downloads again)
npm run bench       # physics cost per step
npm run make:test-model   # regenerate the unbranded test GLB
```

The site first preloads every car and traffic model (progress bar, ~20 MB), then opens the main menu: SÜR → map + weather → car confirm → loading → driving; GARAJ (the four real cars); AYARLAR.
Developer / old links still start driving directly (menus skipped, nothing saved):
`?track=test|nordschleife|autobahn`, `?seed=<n>` (Autobahn road seed, default 2026), `?car=bmw_m3_e92|bmw_m4_f82|amg_c63s_w205|amg_one`, `?setup=STREET|SPORT|DRIFT`, `?admin`.

## Game flow

- `GameFlow` (`src/core/GameFlow.ts`) is the only place screens change: BOOT, MAIN_MENU, MAP_SELECT, CAR_CONFIRM,
  GARAGE, LOADING, DRIVING, PAUSED, SETTINGS, with a history for Esc / back (settings from pause return to pause).
- `App` (`src/app/App.ts`) owns the renderer, input, settings, profile, audio mixer, screens and the single animation
  loop. A driving session (`Game`: track, car, camera, HUD, weather, admin tools; simulation in `DrivingSim`) exists
  only in DRIVING / PAUSED; the garage showroom only behind the menus. Each is disposed when no longer shown.
- The car takes input and the simulation steps only in DRIVING. Pause = no physics step, held keys released.
- Esc: driving ⇄ pause menu (Devam et, Yeniden başlat, Ayarlar, Harita seç, Garaj, Ana menü); elsewhere one screen back.
- Garage: orbit (drag), zoom (wheel), ← → cars, "Bu aracı seç" (saved). Specs and rating bars come from the car config.
- Cars: `src/config/carRegistry.ts` (data-driven): BMW M3 E92, BMW M4 F82, Mercedes-AMG C 63 S Coupé,
  Mercedes-AMG ONE, plus the two test cars. The real cars use the test car's handling with their own
  dimensions (wheelbase, track, wheel size, body), see `src/config/vehicles/fittedCar.ts`.
- New car model: put the downloaded GLB in `assets-src/vehicles/`, add a recipe to `scripts/prepare-cars.ts`
  (nose direction, real wheelbase, optional lamp / steering-wheel names) and run `npm run prepare:cars`: it writes
  `public/assets/vehicles/<id>/<id>.glb` (metres, nose +Z, ground y = 0, nodes Body / WheelFL..RR / HeadLights /
  TailLights / SteeringWheel, WebP textures) and the measurements to `carFits.json`. Then one registry entry.
- Weather / time (`src/world/weather/`, one `WeatherManager` per session): clear, cloudy, rain, heavy rain, fog ×
  07:00 / 13:00 / 19:00 / 23:00 or any minute. `WeatherState` holds the numbers (preset transitions, real sun path at
  the Nürburgring latitude, wet → damp → dry road); the manager draws them: procedural sky with drifting clouds and
  stars (three.js `Sky` + weather / night / horizon-fog blend), matching fog, sun / moon light, a sky environment map
  (car paint, wet asphalt reflections), GPU rain around the camera slanted by speed. Headlights: `L`, manual or
  automatic (night, heavy rain, dark sky), lamp meshes glow where the model has them, one shadowless spot light plus a
  lit-air cone for every car. Graphics → "Hava efektleri" (low / medium / high). F2 → "Dünya / Hava" for live tuning
  (not saved). Visual only: the wet-grip hook (`wetGripFactor`) returns 1.
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
- `autobahn`: an endless, procedurally generated German motorway (Map Select: "Yüksek hız / Açık yol").
  - Road = pure function of distance along it and a seed (`AUTOBAHN.seed`, 2026; `?seed=` or F2 to change).
    Separate random streams plan curves (straights 0.9–3.2 km, sweepers R 1.5–4.5 km with clothoid-like ramps),
    grades (≤ 4 %, 350 m vertical curves) and features, so the same seed always gives the same road and landscape.
    The heading stays within ±78° of the start direction, so the road never loops back over itself. `src/world/autobahn/RoadGenerator.ts`, settings in `AUTOBAHN` (`src/config/tracks.ts`).
  - Cross-section: 3 + 3 lanes of 3.75 m, 3 m hard shoulders, a median with a concrete barrier, guard rails,
    crossfall and up to 2° banking in curves. Markings are separate decals lifted above the asphalt (no z-fighting).
  - Features: tunnels (lit tube, portals, no rain inside, tunnel ambient light), bridges over valleys, overpasses,
    Ausfahrt exits with gantry signs and gore arrows, Raststätte rest areas with a fuel station (orange fuel marker
    on the minimap), speed signs, reflector posts, emergency phones, noise walls.
  - Streaming: 200 m chunks, 3 behind / 10 ahead, 6 cached; each chunk is one fixed Rapier body (road trimesh,
    terrain band, barrier boxes) built within a per-frame time budget; geometry merged per material, props instanced.
    Trees follow the vegetation-distance setting.
  - Infinite landscape (`BiomeMap.ts`, `TerrainField.ts`, `TerrainTiles.ts`, `DistantScenery.ts`, settings in `AUTOBAHN.world`):
    - Biomes from slow climate noise fields, blended over hundreds of metres: dense / open forest, farmland (crop
      patchwork, barns), meadows, rolling hills, valleys, rocky hills, industrial outskirts (warehouses, concrete
      yards) and rest-area surroundings.
    - Terrain: road-corridor terrain within 500 m of the road (cuttings, embankments, tunnel hills, bridge valleys,
      ramp pads), blending into free biome hills and occasional mountain ranges by 1.4 km.
    - LOD tile rings around the camera: 256 / 512 / 1024 / 2048 m tiles (117 tiles, out to ≥ 4 km), skirts at level
      seams, built nearest-first within 2.5 ms per frame (road chunks get 4 ms), parked in a small cache, disposed.
      Inside the 140 m road corridor the tiles sink under the chunks' detailed ribbons; over tunnels they stay above the tube.
    - Vegetation: roadside trees and bushes per chunk (bushes to half the vegetation distance), instanced trees in
      the level-0 tiles and crown-only stand-ins in level-1 tiles (to 3 × the vegetation distance), never inside the
      corridor; further away forests read as canopy colour.
    - Distant scenery: two horizon silhouette rings (hills, mountains) tinted by fog / time of day, and a low-detail
      road strip beyond the loaded chunks (4.2 km ahead, 2.4 km behind). Clear-weather fog reaches 2.6 km.
  - AI traffic (`src/traffic/`, data in `src/config/traffic.ts`), see below.
  - Shift+R puts the car back in the middle lane of the carriageway it is on, facing the traffic direction;
    leaving the road by more than 260 m or falling respawns it the same way. Minimap follows the player.
  - F2 → Dünya: seed, chunk counts, curvature, grade, banking, biome, object / collider counts, landscape tiles per
    LOD level, vegetation instances, distant scenery, generation ms, regenerate; Trafik: counts per tier, spawns,
    lane use, speeds, lane changes, update cost, one selected vehicle, debug lines (lanes, nodes, targets, ranges).

### AI traffic (Autobahn)

- `TrafficLaneNetwork`: the 3 + 3 lanes straight from the road generator (position, travel heading, curvature,
  banking, grade, speed advice, neighbours, road section); right-hand traffic, lane 0 = right lane. Exits and
  rest areas are listed as future connections (the AI stays on the main lanes for now).
- `TrafficSystem`: light kinematic agents (no tyre / suspension model). Intelligent Driver Model following
  (gap = minimum + speed × headway, jerk-limited), overtaking only on the left when the car ahead is clearly slower,
  keeping right afterwards and moving over for faster cars, no undertaking. Before a lane change: nothing alongside,
  front gap, rear gap, closing speed and time-to-collision (9 s for a car over 200 km/h, looked for up to 600 m back),
  indicator first, 3-5 s quintic lane change, abort if something fast appears early. A vehicle moving into a lane
  counts as being in it, so two never take the same gap. Trucks stay out of the left lane.
- Classes: built-in low-poly private cars (car, fast car, van, articulated truck) and ten modelled civil vehicles
  (taxi, police, postal van, ambulance, city / school bus, garbage, road service, tow and fire trucks; from the
  CC BY pack, prepared by `npm run prepare:traffic`). Models beyond 220 m are drawn as their low-poly stand-in.
  Profiles slow (95-120), normal (115-150), fast (145-190), very fast (180-230), truck (82-95), bus (88-100 km/h). Rain slows drivers (~14 % in heavy rain) and lengthens gaps; fog limits speed to
  what can be seen. Headlights at night, in poor weather and in tunnels, brake lights, indicators, hazard lights on wrecks.
- A bubble 650 m behind / 2.1 km ahead of the player; vehicles appear at its edges (beyond 1.3 km ahead, or behind
  out of sight) and disappear there. Tiers: near (< 130 m: every step, collision body, wheels), medium (< 650 m:
  decisions at 30 Hz), far (10 Hz, no wheels).
- Collision: pooled kinematic boxes near the player; just before contact a box becomes a dynamic body with the
  vehicle's real mass (momentum is exchanged, no wall-like bounce) and the vehicle turns into a wreck the others avoid.
- Drawing: per class instanced bodies (paint per instance), lamps with per-instance colour, one wheel mesh, one point
  cloud of lamp glows, two pooled real spot lights for the nearest lit vehicles at night.
- Settings → Trafik: density (Kapalı / Düşük / Orta / Yüksek), variety, minimap dots.

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
| L | headlights on / off |
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
  world/     Track interface, TestTrack, nordschleife/ (centre line, strip meshes, colliders), autobahn/ (generator, chunks, biomes, landscape tiles, distant scenery), tracks/*.json
  traffic/   lane network, traffic system (AI drivers, bodies), vehicle models / instanced visuals, debug view
  ui/        Hud (player HUD), hud/Speedometer, map/ (MapData, Minimap), screens/ (menus, settings), dev debug overlay
  settings/  Settings schema + store (versioned), Profile (last map / car / weather)
  admin/     super admin panel: tuning schema, live config, presets, measurements, telemetry graph
  utils/     math, FPS counter
public/assets/{vehicles,environment,audio}   (vehicles/test-car/test-car.glb: generated test model)
scripts/     sim-test.ts, vehicle-test.ts, visual-test.ts, admin-test.ts, keyboard-test.ts, track-test.ts, hud-test.ts, phase3-test.ts, weather-test.ts, autobahn-test.ts, world-test.ts, traffic-test.ts, autobahn-longrun.ts, lib/sim.ts, lib/trafficHarness.ts,
             bench.ts, make-test-model.ts, build-nordschleife.ts (+ data/ source cache)
```

Vehicle frame: +Z forward, +Y up, +X left (glTF convention).

## Credits

See [CREDITS.md](CREDITS.md). In short: Nordschleife track data © OpenStreetMap contributors (ODbL 1.0),
elevation from SRTM; parts of the track geometry code adapted from Nordschleife Racer (MIT).
