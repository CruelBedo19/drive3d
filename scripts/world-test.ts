/**
 * Infinite Autobahn world checks: seeded landscape (same seed → same terrain,
 * other seed → other terrain), biomes (deterministic, varied, gradual), tile
 * seams and LOD seams, full coverage around the camera, the road corridor kept
 * clear of terrain and plants, tile / LOD lifecycle while driving, and memory.
 */
import * as THREE from 'three';
import { AUTOBAHN as A } from '../src/config/tracks';
import { PhysicsWorld } from '../src/core/PhysicsWorld';
import { AutobahnAssets } from '../src/world/autobahn/AutobahnAssets';
import { AutobahnTrack } from '../src/world/autobahn/AutobahnTrack';
import { BIOME_COUNT } from '../src/world/autobahn/BiomeMap';
import { RoadGenerator, SECTION, rampLayout } from '../src/world/autobahn/RoadGenerator';
import { TerrainField } from '../src/world/autobahn/TerrainField';
import { TerrainTiles } from '../src/world/autobahn/TerrainTiles';
import { check, finish, section } from './lib/sim';

const W = A.world;

function tilesFor(seed: number): { gen: RoadGenerator; tiles: TerrainTiles; assets: AutobahnAssets } {
  const gen = new RoadGenerator(seed);
  gen.ensure(12000);
  const assets = new AutobahnAssets();
  return { gen, tiles: new TerrainTiles(new TerrainField(gen), assets), assets };
}

async function main(): Promise<void> {
  section('Seeded landscape');
  {
    const a = tilesFor(2026);
    const b = tilesFor(2026);
    const c = tilesFor(7);
    const f = a.gen.frame(3000);
    const ix = Math.floor(f.x / W.tile);
    const iz = Math.floor(f.z / W.tile);
    const same = [0, 2].every((lv) => {
      const k = 2 ** lv;
      const ha = a.tiles.tileHeights(lv, Math.floor(ix / k), Math.floor(iz / k));
      const hb = b.tiles.tileHeights(lv, Math.floor(ix / k), Math.floor(iz / k));
      return ha.every((h, i) => h === hb[i]);
    });
    const hc = c.tiles.tileHeights(0, ix + 3, iz);
    const ha = a.tiles.tileHeights(0, ix + 3, iz);
    let diff = 0;
    for (let i = 0; i < ha.length; i++) diff = Math.max(diff, Math.abs(ha[i] - hc[i]));
    check('same seed → same terrain (L0 and L2 tiles)', same, 'heights identical');
    check('different seed → different terrain', diff > 1, `max difference ${diff.toFixed(1)} m`);

    // Biomes: same per seed, many kinds over 100 km, and never a hard switch.
    const seq = (g: RoadGenerator) => {
      const out: string[] = [];
      for (let s = 0; s < 100000; s += 500) {
        g.ensure(s + 1000);
        out.push(g.biomeAt(s, 90));
      }
      return out;
    };
    const s1 = seq(a.gen);
    const s2 = seq(new RoadGenerator(2026));
    const s3 = seq(c.gen);
    const kinds = new Set(s1);
    check('biomes deterministic per seed', s1.join() === s2.join() && s1.join() !== s3.join(), `${kinds.size} biomes along 100 km: ${[...kinds].join(', ')}`);
    let maxJump = 0;
    const w0 = new Float32Array(BIOME_COUNT);
    const w1 = new Float32Array(BIOME_COUNT);
    for (let s = 0; s < 60000; s += 25) {
      const fr = a.gen.frame(s);
      const x = fr.x + Math.cos(fr.heading) * 90;
      const z = fr.z - Math.sin(fr.heading) * 90;
      a.gen.biome.weights(x, z, w0);
      const fr2 = a.gen.frame(s + 25);
      a.gen.biome.weights(fr2.x + Math.cos(fr2.heading) * 90, fr2.z - Math.sin(fr2.heading) * 90, w1);
      for (let i = 0; i < BIOME_COUNT; i++) maxJump = Math.max(maxJump, Math.abs(w1[i] - w0[i]));
    }
    check('region changes are gradual (≥ 5 biomes, weight change ≤ 0.1 per 25 m)', kinds.size >= 5 && maxJump <= 0.1, `max weight change ${maxJump.toFixed(3)} per 25 m`);
    for (const t of [a, b, c]) {
      t.tiles.dispose();
      t.assets.dispose();
    }
  }

  section('Tiles, seams, LOD, coverage');
  console.time('track');
  const physics = await PhysicsWorld.create();
  const track = new AutobahnTrack(physics.world);
  const tiles = track.landscape;
  const gen = track.gen;
  console.timeEnd('track');
  {
    // Same-level neighbours share their edge exactly.
    const cam = track.spawn.position;
    const ix = Math.floor(cam.x / W.tile);
    const iz = Math.floor(cam.z / W.tile);
    const segs = W.segments[0];
    const left = tiles.tileHeights(0, ix, iz);
    const right = tiles.tileHeights(0, ix + 1, iz);
    const down = tiles.tileHeights(0, ix, iz + 1);
    let seam = 0;
    for (let j = 0; j <= segs; j++) seam = Math.max(seam, Math.abs(left[j * (segs + 1) + segs] - right[j * (segs + 1)]));
    for (let i = 0; i <= segs; i++) seam = Math.max(seam, Math.abs(left[segs * (segs + 1) + i] - down[i]));
    check('neighbouring tiles share their edges (no cracks)', seam < 1e-3, `max edge mismatch ${seam.toFixed(5)} m`);

    // Across a level change the two surfaces differ by less than the finer tile's skirt.
    let lodGap = 0;
    for (const lv of [0, 1, 2]) {
      for (let k = 0; k < 400; k++) {
        const x = cam.x + (k % 20) * 157 - 1500;
        const z = cam.z + Math.floor(k / 20) * 157 - 1500;
        lodGap = Math.max(lodGap, Math.abs(tiles.surfaceAt(lv, x, z) - tiles.surfaceAt(lv + 1, x, z)));
      }
      check(`LOD ${lv} → ${lv + 1}: surfaces within the skirt`, lodGap < W.skirt[lv], `max difference ${lodGap.toFixed(2)} m (skirt ${W.skirt[lv]} m)`);
    }

    // Every point around the camera is covered by exactly one visible tile.
    const keys = tiles.visibleTiles.map((k) => k.split(':').map(Number));
    let holes = 0;
    let doubles = 0;
    for (let dx = -4000; dx <= 4000; dx += 97) {
      for (let dz = -4000; dz <= 4000; dz += 97) {
        const x = cam.x + dx;
        const z = cam.z + dz;
        let n = 0;
        for (const [lv, tx, tz] of keys) {
          const sz = TerrainTiles.size(lv);
          if (x >= tx * sz && x < (tx + 1) * sz && z >= tz * sz && z < (tz + 1) * sz) n++;
        }
        if (n === 0) holes++;
        if (n > 1) doubles++;
      }
    }
    const st = track.worldStats();
    check('no terrain gaps: ±4 km around the camera covered exactly once', holes === 0 && doubles === 0, `${keys.length} tiles (L0-L3 ${st.visible.join('/')}), holes ${holes}, overlaps ${doubles}`);
  }

  section('Road corridor');
  {
    const field = new TerrainField(gen);
    let worstUnder = -Infinity;
    let worstEdge = -Infinity;
    for (let s = 200; s < 20000; s += 37) {
      // Tunnel approaches have cut slopes on purpose (and the tile sink is checked there separately).
      const tunnel = gen.featuresIn(s - 260, s + 260).some((f) => f.kind === 'tunnel');
      const fr = gen.frame(s);
      for (const lane of [...SECTION.lanesA, ...SECTION.laneB]) {
        const x = fr.x + Math.cos(fr.heading) * lane;
        const z = fr.z - Math.sin(fr.heading) * lane;
        // Landscape tile surface (sunk inside the corridor) under the lanes.
        const h = field.height(x, z, s) - TerrainField.corridorSink(field.off);
        if (!tunnel) worstUnder = Math.max(worstUnder, h - gen.surfaceY(fr, lane));
      }
      if (tunnel) continue;
      for (const side of [1, -1]) {
        const edge = gen.surfaceY(fr, side * SECTION.edge);
        worstEdge = Math.max(worstEdge, gen.terrainHeight(s, side * (SECTION.edge + 4)) - edge);
      }
    }
    check('landscape stays under the road (20 km, all 6 lanes)', worstUnder < -1, `highest tile point ${worstUnder.toFixed(2)} m relative to the lane surface`);
    check('roadside terrain flat next to the road (no slope over the verge)', worstEdge < 0.5, `max ${worstEdge.toFixed(2)} m above the road edge, 4 m out`);

    // Over tunnels the landscape tiles stay above the tube (no triangle cuts its walls or roof).
    let tubeWorst = Infinity;
    for (const ft of gen.featuresIn(0, 20000)) {
      if (ft.kind !== 'tunnel') continue;
      // Portals excepted by one coarse grid step (the portal walls cover that).
      for (let s = ft.s0 + 24; s <= ft.s1 - 24; s += 9) {
        const fr = gen.frame(s);
        for (const off of [-17, -12, -6, 0, 6, 12, 17]) {
          const x = fr.x + Math.cos(fr.heading) * off;
          const z = fr.z - Math.sin(fr.heading) * off;
          for (const lv of [0, 1]) tubeWorst = Math.min(tubeWorst, tiles.surfaceAt(lv, x, z) - (fr.y + A.features.tunnel.height));
        }
      }
    }
    check('landscape tiles never cut into a tunnel tube (L0-L1: the levels around a car inside)', tubeWorst > 0, `lowest tile point ${tubeWorst.toFixed(2)} m above the tube roof`);

    // Plants: chunk trees / bushes and tile trees never on the road, shoulder, median, ramps, pads.
    let worst = Infinity;
    let onPads = 0;
    let count = 0;
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const field2 = new TerrainField(gen);
    const inspect = (mesh: THREE.InstancedMesh, origin: THREE.Vector3) => {
      const s0 = gen.nearestSGlobal(origin.x, origin.z);
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m);
        p.setFromMatrixPosition(m).add(origin);
        field2.project(p.x, p.z, s0);
        if (!field2.onRoad) continue;
        const s = field2.s;
        const off = field2.off;
        worst = Math.min(worst, Math.abs(off));
        count++;
        for (const ft of gen.featuresIn(s - 5, s + 5)) {
          const l = rampLayout(ft, s);
          if (l && off < 0 && Math.abs(off - l.centre) < l.half + 2) onPads++;
        }
      }
    };
    track.group.traverse((o) => {
      if (!(o instanceof THREE.InstancedMesh)) return;
      const mat = o.material as THREE.Material;
      const assets = (track as unknown as { assets: AutobahnAssets }).assets;
      if (mat !== assets.trunk && mat !== assets.shrub && mat !== assets.farTree) return;
      const origin = new THREE.Vector3();
      o.parent?.getWorldPosition(origin);
      inspect(o, origin);
    });
    check('no tree / bush on road, shoulder, median, ramps or rest areas', worst > SECTION.edge + 2 && onPads === 0, `${count} plants, closest ${worst.toFixed(1)} m from the centre line (road edge ${SECTION.edge} m), on ramps / pads ${onPads}`);
  }

  section('Lifecycle while driving');
  {
    const cam = new THREE.Vector3();
    let maxQueue = 0;
    let maxCached = 0;
    let maxGroup = 0;
    let levelsOk = true;
    let frames = 0;
    let worstFrameMs = 0;
    const heap0 = process.memoryUsage().heapUsed;
    let built0 = tiles.builtCount;
    // 30 km at 300 km/h, 60 frames per second, the game's per-frame budget.
    const v = 300 / 3.6;
    const sStart = track.progress;
    for (let s = sStart; s < sStart + 30000; s += v / 60) {
      const fr = gen.frame(s);
      cam.set(fr.x, fr.y + 2, fr.z);
      const t0 = performance.now();
      track.stream(cam);
      track.update({ camera: cam, vegetationDistance: 450, cameraFar: 3100 });
      worstFrameMs = Math.max(worstFrameMs, performance.now() - t0);
      const st = track.worldStats();
      maxQueue = Math.max(maxQueue, st.queued);
      maxCached = Math.max(maxCached, st.cached);
      maxGroup = Math.max(maxGroup, tiles.group.children.length);
      if (st.queued === 0 && st.visible.join() !== '36,27,27,27') levelsOk = false;
      frames++;
    }
    const builtTiles = tiles.builtCount - built0;
    built0 = tiles.builtCount;
    check('LOD rings stay complete (36 / 27 / 27 / 27) and the build queue drains', levelsOk && maxQueue < 60, `max queue ${maxQueue} tiles, ${builtTiles} tiles built over 30 km`);
    check('parked tiles bounded, nothing leaks into the scene', maxCached <= W.cache && maxGroup <= 117 + 1, `cache ≤ ${maxCached} (limit ${W.cache}), visible groups ≤ ${maxGroup}`);
    const heap1 = process.memoryUsage().heapUsed;
    check('memory stays flat over 30 km of landscape', heap1 - heap0 < 150e6, `heap ${(heap0 / 1e6).toFixed(0)} → ${(heap1 / 1e6).toFixed(0)} MB, worst frame ${worstFrameMs.toFixed(1)} ms (node, includes road chunks)`);
  }
  track.dispose();
  physics.dispose();
  finish();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
