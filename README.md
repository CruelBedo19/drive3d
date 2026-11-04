# Drive3D — game flow, garage, weather, Autobahn with traffic

> I was bored in class and wondered whether I could make something nicer than the usual browser racing games. This is what came out of trying.

**[▶ Play it in your browser](https://cruelbedo19.github.io/drive3d/)** (desktop, keyboard; first load downloads a few MB of models)

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
npm run test:city     # city: layout rules on 5 seeds + 2 km, then the game files: junctions, kerbs, 100 / 200 km/h, buildings, props (also in test:sim)
npm run test:city-traffic # city traffic and parked cars: lane graph, signals / stop signs kept, no gridlock, player, colliders (also in test:sim)
npm run build:track # rebuild the Nordschleife centre line from the cached OSM / SRTM data (--refresh downloads again)
npm run bench       # physics cost per step
npm run make:test-model   # regenerate the unbranded test GLB
```

The site first loads the physics engine and the one car shown behind the menu (progress bar, ~1–7 MB), then opens the main menu: SÜR → map + weather → car confirm → loading → driving; GARAJ (the thirteen real cars); AYARLAR.
Developer / old links still start driving directly (menus skipped, nothing saved):
`?track=test|nordschleife|autobahn|city`, `?seed=<n>` (Autobahn road seed, default 2026), `?car=<id>` (ids in `src/config/carRegistry.ts`, e.g. `bmw_m3_e92`, `ferrari_f40`), `?setup=STREET|SPORT|DRIFT`, `?admin`.

## Game flow

- `GameFlow` (`src/core/GameFlow.ts`) is the only place screens change: BOOT, MAIN_MENU, MAP_SELECT, CAR_CONFIRM,
  GARAGE, LOADING, DRIVING, PAUSED, SETTINGS, with a history for Esc / back (settings from pause return to pause).
- `App` (`src/app/App.ts`) owns the renderer, input, settings, profile, audio mixer, screens and the single animation
  loop. A driving session (`Game`: track, car, camera, HUD, weather, admin tools; simulation in `DrivingSim`) exists
  only in DRIVING / PAUSED; the garage showroom only behind the menus. Each is disposed when no longer shown.
- The car takes input and the simulation steps only in DRIVING. Pause = no physics step, held keys released.
- Esc: driving ⇄ pause menu (Devam et, Yeniden başlat, Ayarlar, Harita seç, Garaj, Ana menü); elsewhere one screen back.
- Garage: orbit (drag), zoom (wheel), ← → cars, "Bu aracı seç" (saved). Specs and rating bars come from the car config.
- Cars: `src/config/carRegistry.ts` (data-driven): the thirteen real cars plus the two test cars (headless tests only). The real cars use the test car's handling with their own
  dimensions (wheelbase, track, wheel size, body), see `src/config/vehicles/fittedCar.ts`.
- New car model: put the downloaded GLB in `assets-src/vehicles/`, add a recipe to `scripts/prepare-cars.ts`
  (nose direction, real wheelbase, optional head / tail lamp and steering-wheel names, `merge`, `simplify`) and run
  `npm run prepare:cars`: it writes `public/assets/vehicles/<id>/<id>.glb` (metres, nose +Z, ground y = 0, nodes
  Body / WheelFL..RR / HeadLights / TailLights / SteeringWheel, same-material meshes of a part merged, WebP textures,
  meshopt-compressed geometry) and the measurements to `carFits.json`. Then one registry entry.
- Car models load on demand through one shared cache (`VehicleAssetCache`): the menu car at startup, the garage's
  shown car and its neighbours, the drive's car on the loading screen. A model is parsed once and cloned for the
  garage, the drive and restarts; up to four unused models stay cached, older ones are disposed (textures too).
  Transmissive glass (KHR_materials_transmission, e.g. the M3's tail-light lenses) is replaced once per model by
  tinted, glossy, alpha-blended glass (`withoutTransmission`, also used for traffic models): three.js would
  otherwise draw every opaque object a second time each frame for it. Traffic models load in the background after
  the menu is up; a drive waits for them.
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
  (1× … 0.1×), automatic 0-100 / 0-200 / 100-0 / top speed /
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
  resolution scale, automatic resolution, view distance, vegetation distance, FPS cap; anti-aliasing applies after a
  reload), Kontroller
  (rebind by pressing a key, duplicate warning, reset). The schema in `src/settings/Settings.ts` drives defaults,
  validation and the screen.
- Sizes scale with the HUD scale setting, capped at 30% of the viewport height, with safe-area padding.
- Performance:
  - Physics steps the Rapier pipeline directly (`PhysicsWorld.step`): `World.step()` of rapier3d-compat 0.21 walks
    every collider and body through JS callbacks after each step (soft-body bookkeeping the game does not use).
  - Shaders are compiled behind the loading screen (`Game.warmUp`: `compileAsync` with hidden objects shown, then one
    frame with the sun's shadow over the whole scene for the depth shaders); nothing compiles while driving.
  - The player car casts its body shadow from one merged position-only mesh drawn in the shadow map only; empty
    instanced sets (traffic, parked cars, props, buildings) are hidden and upload only the instances in use.
  - Automatic resolution (`ResolutionGovernor`): when frames drop under ~50 FPS because of drawing (not CPU work)
    the view renders at fewer pixels in steps down to 55 %, and steps back up with time to spare (F3 shows the share).
  - Nordschleife guard-rail colliders exist only on the lap chunks within 250 m of the car.

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

- `city`: the town ("Şehir" in Map Select, `?track=city`; the old `?track=city_v2` links still work), procedural, on the
  Downtown City MegaKit (Quaternius, CC0). It replaced the first city (a CC BY-NC Sketchfab map), removed with its files.
  Code and files keep their `cityv2` / `city_v2` names.
  Streets, buildings, street props, AI traffic and parked cars.
  - Kit source: `assets-src/maps/downtown-city-megakit/` (not in git; the glTF export and its textures are used).
    `npm run prepare:city [-- --seed n --size m]` writes the 2 × 2 km town to `public/assets/city_v2/` (~9.8 MB) and
    `src/world/tracks/city-v2-info.json`; `--no-info` leaves the latter alone (fixtures), `-- --layout-only --out <dir>`
    draws a layout review picture, `-- --catalog` prints the kit report. `test:city` also builds a 1 × 1 km fixture
    of the same seed in the temp folder and runs the game-file checks on both.
  - Layout (`scripts/lib/cityV2/layout.ts`, `districts.ts`): seeded street graph on a 6 m grid: ring road, 2-3 main
    boulevards per km (300-500 m straights, few jogs), districts (downtown / commercial / residential / industrial) with
    their own block sizes and street patterns, blocks split by streets (crossroads, staggered T's, L bends), alleys,
    large parcels kept whole with a use (mall, park, car park, factory...), a plaza and a landmark at a boulevard T.
  - Road classes (`src/world/cityv2/roadProfiles.ts`, shared by generator, markings, lane points, minimap and
    runtime), kerb to kerb: 3+3 arterial 25 m with a 4 m median (the main boulevard nearest the centre on each axis,
    so one crosses downtown; only one below 1.5 km), 2+2 boulevard 17 m with a 3 m median, 2+2 avenue 13 m (larger
    downtown / commercial splits), 1+1 street 7 m, alley 5 m without sidewalks. Sidewalks per district: downtown 4 m,
    commercial 3.5 m, residential and industrial 2.5 m.
  - Ground (`scripts/lib/cityV2/ground.ts`): 0.5 m raster, one surface per cell (asphalt, sidewalk, lot, median, land), merged
    into rectangles per 250 m cell, so junctions join with no gaps or overlaps; kit-style rounded kerb corners; kit
    heights (sidewalks 15 cm above the asphalt) and kit textures (sidewalks use the concrete rows of the
    T_MetalConcrete trim sheet, as the kit's sidewalk pieces do; nothing metallic). Lane markings are opaque
    vertex-coloured quads 12 mm above the asphalt with polygon offset, drawn after it (the Autobahn approach; an
    alpha-tested atlas lost them at grazing angles). Colliders: asphalt as drawn; a ramp across every kerb line, 0.5 m
    out on the asphalt to 1.9 m into the block (15 cm over 2.4 m), so wheels roll on and off kerbs at town speeds.
  - Buildings (`scripts/lib/cityV2/buildings.ts`): every ordinary block is built on, along its streets and (commercial,
    residential, industrial) inside behind the street rows; malls, stadiums, hospitals, factories, warehouses and the
    landmark block get a complex in their middle (`parcelCore`), with the parking or yard round it; parks, car parks
    and the plaza stay open. Residential lots are lawn (`garden` ground). (`--sample-areas`: only the four A3 sample areas, one per district). Prototypes are assembled from the kit's facade
    modules (2 / 4 m wide, 1 / 3 m tall; interior walls, floors and glass dropped, the fake-interior card becomes the
    window), per style (loft, classic, red brick, modern, stone, houses with slate mansards, low works halls),
    frontage / depth / floors / window rhythm / shopfronts / entrance / corner pilasters / cornice, and per side a
    street facade, an exposed wall or a party wall. Placement walks each block's street sides (corners first, on the
    most important road), downtown as a street wall (5-8 floors, 7-10 on the 3+3 arterials, around the plaza and in
    the core within 200 m of it), commercial with gaps (3-7), residential with front yards and gaps (2-4), industrial
    low and far apart (1-3). Lots are laid out first; then each district gets a catalogue of prototypes (the fewest
    sizes and sides that fit every lot, a tall twin for shapes that also serve tall lots, then other styles of the
    busiest ones: ≤ 30 downtown, 20 commercial, 18 residential, 10 industrial, one per three lots at most; floors
    drawn from a shuffled bag so every height is used), and each lot the cheapest one that fits (stretched ≤ 20 %,
    narrowed ≤ 15 %, a street facade wherever needed; not the prototype or style of a building it touches, nor the
    prototype, height or outline of its neighbours further down the street). A building next to its own prototype
    gets another colour variant (second wall / trim colours, lit and dark windows swapped). One box collider per
    building. The minimap shows the footprints. `--no-buildings` prepares the same city without them.
  - Building rendering (`CityV2Buildings.ts`, `buildingKit.ts`): one material for every building surface (base
    colour and normal texture arrays, one layer per kit texture; a per-vertex slot gives layer, tint, roughness and
    sky-light share, so the kit's pale / dark / green variants are recoloured, not separate materials; no blending).
    Each module has four geometries: as modelled, a fine and a coarse relief (the front cut along its own edges
    into rectangles at their depths, with the window reveals; trims one colour; columns and cornices up to three
    stacked boxes), and a card. Prototypes are assembled in the browser (a few per frame while driving, coarser
    levels drawn meanwhile) and instanced per prototype and level: near (< 35 m) the ground floor as modelled,
    fine relief to 8 m, coarse above; street (< 110 m) coarse relief; mid: cards, each facade plane's walls merged
    into a few rectangles. Cells whose buildings are all 220 m away are drawn as one merged mesh of their cards
    (one draw call per cell, merged a few buildings per frame), beyond 450 m as boxes textured with the building's wall and shader-drawn window
    rows (one draw call for all).
  - Street props (`scripts/lib/cityV2/props.ts`, catalogue `src/world/cityv2/propKit.ts`, `--no-props` leaves them out):
    the kit's bollard, planters, manhole and drain; everything else (trees, bushes, lamps, signals, signs, benches,
    bins, hydrants, utility boxes, bus shelters, bike racks, barriers, fences, containers, stall lines, park paths)
    is built from primitives in `props/PropCatalog.ts` (the free kit has none of them). Placement checks every prop
    against the ground raster (sidewalk props on sidewalk cells...), keeps footprints apart, yard plants off the
    buildings and anything tall out of a junction's sight box. District rules: downtown dense and ordered (tree pits,
    benches, bins, bollards, planters, bike racks, bus stops), commercial sparser, residential green (verges, street
    trees, yard bushes), industrial functional (floodlights, fences, containers, barriers). Lamps by road class
    (the 3+3 arterials from the median), signals at main crossings (arterial / boulevard / avenue; mast arms over two
    or three lanes), stop / yield on minor approaches to bigger roads, 30 zones entering residential streets,
    crossing signs. Car parks, mall and yard parking get stall lines and `props.spots` (x, z, yaw, lot) for later
    parked cars; the park gets paths, groves, benches, lamps and bins; factories and warehouses a fence with a gate,
    container stacks, a loading zone, floodlights round their halls; `props.reserved` lists the built middles of
    malls, hospitals and the landmark. `props.junctions` lists each junction's control per approach (signal
    group, stop line) for later traffic AI. Runtime (`CityV2Props.ts`, `props/PropRenderer.ts`): instanced per
    prototype and level (one InstancedMesh per part, sized for the whole town), culled per 125 m chunk by distance
    (per prototype: ~110 m small things, ~200 m furniture, ~460 m trees / lamps / signals, a cheaper level for trees
    and lamps beyond 110-220 m) and by the view; the buffers are refilled only when a chunk changes. Lamp heads glow
    and a light pool shows under each lamp at night (no real light per lamp); signals run a fixed 30 s plan. Poles,
    planters, barriers, utility boxes, shelters, fences and containers have box colliders, streamed with their cell.
  - Runtime (`src/world/cityv2/`): CityData-style 250 m cells (streaming distance measured to each cell's geometry),
    colliders within 150 m, the land around town always solid with walls at its edge; minimap image drawn from the
    layout; Shift+R: nearest lane, facing the traffic direction. F2 → teleports to every junction type. Concrete gets a
    reduced share of the sky environment light (own envMap; three.js scales scene.environment only by the scene's
    environmentIntensity, so material envMapIntensity alone does nothing) and ground textures anisotropic filtering.

  - Traffic (A5, `src/traffic/city/`): `CityLaneGraph` builds the lanes at load from the road graph and the
    junction data of the props step (~0.2-0.4 s): lanes keep right and end at the stop line; connectors (cubic
    curves) join them through junctions and bends: right turns from the outermost lane, left turns from the
    innermost, straight on lane by lane or one lane over (there are no lane changes between junctions), turns
    into the near half of the new road's lanes; every pair of connectors at a node whose paths cross or merge is a
    conflict. `CityTrafficSystem` drives the same vehicles and models as the Autobahn (no long lorries in town except
    with the "heavy" variety) as kinematic agents along a planned route: IDM following (also behind the player when
    the player is in the path), speed limit by road class × the driver's share, slowing for turns. A driver enters a
    junction only when its signal is green (yellow only if it cannot stop; the plan drawn on the poles, 11 s green,
    3 s yellow, 1 s all red, one clock: `track.signalTime`), after a full stop at a stop sign, when no vehicle is on
    or committed to a conflicting connector (or has its tail still in one), when there is room on the exit lane for
    it and everyone heading there, when the player is not in its path, and after giving way: side roads to the main
    road, left turns to oncoming traffic, at equal junctions to the right (after 6 s waiting only the box must be
    clear). Two junctions joined by a lane too short to wait on are entered as one. A vehicle that turned off the same
    lane another way stays a leader until both have pulled clear, and nobody turns beside a bus or lorry turning on
    the next connector (their swept paths touch). 40 / 80 / 105 / 125 vehicles
    (density setting, key T) between 140 and 340 m from the player (60 m behind it), gone beyond 390 m; gridlocked
    ones (standing 60 s, out of sight) are removed. Near vehicles (< 80 m) get a pooled kinematic Rapier box that
    turns into a real mass on contact; a hit leaves a wreck with hazard lights. F2: counts, why vehicles wait, the
    selected vehicle; debug layer "Trafik şeritleri" draws the lane graph. Not yet: lane changes between junctions,
    pedestrians, buses stopping at stops, the swept path of long vehicles in tight turns.
  - Parked cars (`CityV2ParkedCars.ts`): a deterministic share of the stalls (car parks 62 %, malls 52 %, factories
    42 %, warehouses 38 %), eleven low-poly cars of the traffic pack, nose or tail in; instanced models up to 90 m, a
    painted low-poly stand-in up to 260 m, culled per 125 m chunk by distance and view, buffers refilled only on a
    change; one box collider each, streamed with its cell.

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
- Classes: built-in low-poly private cars (car, fast car, van, articulated truck; fallbacks and headless tests
  only) and one class per vehicle of the CC BY traffic car pack (43 cars, SUVs, pickups, vans, police cars,
  light trucks, trucks and a city bus, prepared by `npm run prepare:traffic`); a vehicle's kind sets its
  handling, lanes and drivers, and each variety setting mixes the kinds.
  Profiles slow (95-120), normal (115-150), fast (145-190), very fast (180-230), truck (82-95), bus (88-100 km/h). Rain slows drivers (~14 % in heavy rain) and lengthens gaps; fog limits speed to
  what can be seen. Headlights at night, in poor weather and in tunnels, brake lights, indicators, hazard lights on wrecks.
- Drawing (`TrafficVisuals`): instanced per class; beyond 110 m from the camera (±10 m, no flicker) a prepared model
  is drawn as a low-poly stand-in of its size and paint (body, glass, wheels, working lamps; two shared instanced
  sets for all classes, ~20× fewer triangles). The paint is measured from a render of each model
  (`node scripts/traffic-paint.mjs http://localhost:<port>/`, needs `playwright-core`), written to
  `src/config/trafficModels.json`.
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
  traffic/   lane network, traffic system (AI drivers, bodies), vehicle models / instanced visuals, debug view; city/ (city lane graph and traffic)
  ui/        Hud (player HUD), hud/Speedometer, map/ (MapData, Minimap), screens/ (menus, settings), dev debug overlay
  settings/  Settings schema + store (versioned), Profile (last map / car / weather)
  admin/     super admin panel: tuning schema, live config, presets, measurements, telemetry graph
  utils/     math, FPS counter
public/assets/{vehicles,environment,audio}   (vehicles/test-car/test-car.glb: generated test model)
scripts/     sim-test.ts, vehicle-test.ts, visual-test.ts, admin-test.ts, keyboard-test.ts, track-test.ts, hud-test.ts, phase3-test.ts, weather-test.ts, autobahn-test.ts, world-test.ts, traffic-test.ts, city-v2-test.ts, city-traffic-test.ts, autobahn-longrun.ts, lib/sim.ts, lib/trafficHarness.ts,
             bench.ts, make-test-model.ts, build-nordschleife.ts (+ data/ source cache)
```

Vehicle frame: +Z forward, +Y up, +X left (glTF convention).

## Credits

See [CREDITS.md](CREDITS.md). In short: Nordschleife track data © OpenStreetMap contributors (ODbL 1.0),
elevation from SRTM; parts of the track geometry code adapted from Nordschleife Racer (MIT).

## License

The code of this project is [MIT](LICENSE). Third-party material keeps its own license and is not covered by it:
car models (CC BY 4.0), the Downtown City MegaKit (CC0), OpenStreetMap-derived track data (ODbL), and the projects in
`third_party/` (each with its own `LICENSE`). Attribution and sources are in [CREDITS.md](CREDITS.md).
