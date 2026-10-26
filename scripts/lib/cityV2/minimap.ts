/**
 * Top-down pictures of a City V2 layout, drawn as SVG and rasterised by sharp:
 *
 *  - the game minimap (`debug: false`): ground, sidewalks, asphalt (boulevards a
 *    shade lighter), blocks, building footprints, large parcels by use; same
 *    palette as the first city's map.
 *  - the review picture (`debug: true`): blocks tinted by district, large parcels
 *    outlined and labelled with their use, centre lines by rank (arterials bold),
 *    junction types, the landmark, a legend and the layout numbers.
 *
 * Image rows follow +z (north up = -z), like scripts/prepare-city.ts.
 */
import sharp from 'sharp';
import { DISTRICTS, type District, type ParcelUse } from './districts';
import { ROAD_CLASSES, kerbOffset, type RoadClass } from '../../../src/world/cityv2/roadProfiles';
import { centroid, layoutStats, type CityLayout, type NodeKind } from './layout';
import { medianRects } from './ground';

const C = {
  background: '#14181d',
  ground: '#343a32',
  sidewalk: '#6e737b',
  asphalt: '#585c64',
  /** Asphalt by road class: the bigger the road, the lighter, so the hierarchy reads on the map. */
  road: { arterial3: '#7e828a', boulevard: '#70747c', avenue: '#666a72', street: '#585c64', alley: '#50545b' } satisfies Record<RoadClass, string>,
  median: '#3f5a36',
  block: '#282a30',
  building: '#4a4d55',
  /** Footprints on the review picture: a lighter shade of their district. */
  buildingBy: { downtown: '#c46a78', commercial: '#6f93c9', residential: '#6fb184', industrial: '#b39a63' } satisfies Record<District, string>,
  plaza: '#7a705c',
  use: { park: '#2f4a2f', parking: '#464a50', mall: '#3a3550', stadium: '#3d4a36', hospital: '#4a3438', factory: '#45392c', warehouse: '#3f3a30', landmark: '#4a4230' } satisfies Record<ParcelUse, string>,
  district: { downtown: '#5a2e36', commercial: '#2c3e5c', residential: '#2c4a36', industrial: '#4f4128' } satisfies Record<District, string>,
  line: { arterial3: '#ff5a1f', boulevard: '#ffd34d', avenue: '#9be15d', street: '#e8e8e8', alley: '#7ec8ff' } satisfies Record<RoadClass, string>,
  node: { cross: '#ff4d4d', tee: '#ff9f2a', bend: '#2affd0', pass: '#888888' } satisfies Record<NodeKind, string>,
};

const USE_LABEL: Record<ParcelUse, string> = {
  park: 'PARK',
  parking: 'OTOPARK',
  mall: 'AVM',
  stadium: 'STADYUM',
  hospital: 'HASTANE',
  factory: 'FABRİKA',
  warehouse: 'DEPO',
  landmark: 'LANDMARK',
};

const DISTRICT_LABEL: Record<District, string> = { downtown: 'downtown', commercial: 'commercial', residential: 'residential', industrial: 'industrial' };

export interface MapImage {
  png: Buffer;
  width: number;
  height: number;
  /** World rectangle the image covers, m. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

const poly = (pts: [number, number][], fill: string, extra = '') => `<polygon points="${pts.map(([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`).join(' ')}" fill="${fill}" ${extra}/>`;

/** A building's footprint, world [minX, minZ, maxX, maxZ]. */
export interface Footprint {
  rect: [number, number, number, number];
  /** District name (BuildingProto.district). */
  district: string;
}

export interface MapOptions {
  metresPerPixel: number;
  margin: number;
  debug: boolean;
  footprints?: Footprint[];
}

export function layoutSvg(l: CityLayout, opts: MapOptions): { svg: string; width: number; height: number; minX: number; minZ: number; maxX: number; maxZ: number } {
  const minX = l.bounds.minX - opts.margin;
  const minZ = l.bounds.minZ - opts.margin;
  const maxX = l.bounds.maxX + opts.margin;
  const maxZ = l.bounds.maxZ + opts.margin + (opts.debug ? 150 : 0);
  const width = Math.ceil((maxX - minX) / opts.metresPerPixel);
  const height = Math.ceil((maxZ - minZ) / opts.metresPerPixel);
  const px = opts.metresPerPixel;
  const s: string[] = [];
  s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minZ} ${maxX - minX} ${maxZ - minZ}">`);
  s.push(`<rect x="${minX}" y="${minZ}" width="${maxX - minX}" height="${maxZ - minZ}" fill="${C.background}"/>`);
  // Outside the ring: plain ground up to the margin.
  s.push(`<rect x="${minX}" y="${minZ}" width="${maxX - minX}" height="${l.bounds.maxZ + opts.margin - minZ}" fill="${C.ground}"/>`);
  // Ring road: outer sidewalk, then asphalt; blocks are drawn over the inside.
  s.push(poly(l.outline.edge, C.sidewalk));
  s.push(poly(l.outline.kerb, C.asphalt));
  // Asphalt by class, narrowest first so wider roads win at junctions; blocks then cover everything off the road.
  for (const cls of [...ROAD_CLASSES].reverse()) {
    for (const e of l.edges) {
      if (e.cls !== cls) continue;
      const a = l.nodes[e.a];
      const b = l.nodes[e.b];
      s.push(`<line x1="${a.x}" y1="${a.z}" x2="${b.x}" y2="${b.z}" stroke="${C.road[cls]}" stroke-width="${2 * kerbOffset(cls)}" stroke-linecap="square"/>`);
    }
  }
  for (const b of l.blocks) s.push(poly(b.kerb, C.sidewalk));
  for (const b of l.blocks) {
    const fill = b.kind === 'plaza' ? C.plaza : b.kind === 'large' && b.use ? C.use[b.use] : opts.debug ? C.district[b.district] : C.block;
    s.push(poly(b.lot, fill));
  }
  for (const m of medianRects(l)) s.push(poly(m.poly, C.median));
  for (const f of opts.footprints ?? []) {
    const [x0, z0, x1, z1] = f.rect;
    s.push(`<rect x="${x0.toFixed(2)}" y="${z0.toFixed(2)}" width="${(x1 - x0).toFixed(2)}" height="${(z1 - z0).toFixed(2)}" fill="${opts.debug ? C.buildingBy[f.district as District] : C.building}"/>`);
  }
  if (opts.debug) {
    for (const b of l.blocks) {
      if (b.kind === 'large') s.push(poly(b.lot, 'none', `stroke="#ffffff" stroke-width="${2.5 * px}" stroke-dasharray="${8 * px} ${5 * px}"`));
      if (b.landmark) s.push(poly(b.lot, 'none', `stroke="#ff4dff" stroke-width="${3 * px}"`));
    }
    for (const e of l.edges) {
      const a = l.nodes[e.a];
      const b = l.nodes[e.b];
      const col = C.line[e.cls];
      const w = e.cls === 'arterial3' ? 4 : e.cls === 'boulevard' ? 3 : e.cls === 'avenue' ? 2 : 1;
      s.push(`<line x1="${a.x}" y1="${a.z}" x2="${b.x}" y2="${b.z}" stroke="${col}" stroke-width="${w * px}"/>`);
    }
    for (const n of l.nodes) s.push(`<circle cx="${n.x}" cy="${n.z}" r="${(n.kind === 'pass' ? 1.5 : 2.6) * px}" fill="${C.node[n.kind]}"/>`);
    for (const v of l.vistas) s.push(`<circle cx="${l.nodes[v].x}" cy="${l.nodes[v].z}" r="${7 * px}" fill="none" stroke="#ff4dff" stroke-width="${2 * px}"/>`);
    const font = 'font-family="FreeSans, DejaVu Sans, sans-serif"';
    // Large parcel labels.
    for (const b of l.blocks) {
      const label = b.kind === 'plaza' ? 'MEYDAN' : b.kind === 'large' && b.use ? USE_LABEL[b.use] : b.landmark ? 'LANDMARK' : '';
      if (!label) continue;
      const [cx, cz] = centroid(b.lot);
      s.push(`<text x="${cx}" y="${cz}" ${font} font-size="${11 * px}" font-weight="bold" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${label}</text>`);
    }
    // District centres.
    for (const c of l.districts) s.push(`<text x="${c.x}" y="${c.z}" ${font} font-size="${13 * px}" font-style="italic" fill="#ffffffaa" text-anchor="middle">${DISTRICT_LABEL[c.kind]}</text>`);
    // Numbers and legend under the map.
    const st = layoutStats(l);
    const km = (m: number) => (m / 1000).toFixed(2);
    const uses = Object.entries(st.uses).map(([u, n]) => `${USE_LABEL[u as ParcelUse].toLowerCase()} ${n}`).join(', ');
    const lines = [
      `seed ${l.params.seed} · ${l.params.size} m · ${l.blocks.length} blocks · ${l.nodes.length} nodes · ${st.arterials} main arterials`,
      `junctions: ${st.nodes.cross} cross, ${st.nodes.tee} T, ${st.nodes.bend} bends · roads: 3+3 ${km(st.length.arterial3)} km, 2+2 boulevard ${km(st.length.boulevard)} km, 2+2 avenue ${km(st.length.avenue)} km, street ${km(st.length.street)} km, alley ${km(st.length.alley)} km`,
      `longest straight: arterial ${st.maxArterialStraight} m (shortest arterial piece ${st.minArterialPiece} m), ring ${st.maxRingStraight} m, street ${st.maxStraight} m · narrowest block ${st.minBlockSide} m`,
      `districts (blocks / mean m²): ${DISTRICTS.map((d) => `${d} ${st.districts[d].blocks} / ${st.districts[d].meanArea}`).join(' · ')}`,
      `large parcels ${st.blocks.large}: ${uses} · plaza ${st.blocks.plaza} · landmark ${st.landmarks}`,
    ];
    const y0 = l.bounds.maxZ + opts.margin;
    s.push(`<g ${font} font-size="${12 * px}" fill="#ffffff">`);
    lines.forEach((t, i) => s.push(`<text x="${minX + 8 * px}" y="${y0 + (16 + i * 16) * px}">${t}</text>`));
    const legend: [string, string][] = [
      [C.line.arterial3, '3+3 arterial'],
      [C.line.boulevard, '2+2 boulevard (ring)'],
      [C.line.avenue, '2+2 avenue'],
      [C.line.street, '1+1 street'],
      [C.line.alley, 'alley'],
      [C.median, 'median'],
      [C.node.cross, 'crossroads'],
      [C.node.tee, 'T'],
      [C.node.bend, '90° bend'],
      [C.district.downtown, 'downtown'],
      [C.district.commercial, 'commercial'],
      [C.district.residential, 'residential'],
      [C.district.industrial, 'industrial'],
      ['#ffffff', 'large parcel (dashed)'],
      ['#ff4dff', 'landmark'],
    ];
    let x = minX + 8 * px;
    const ly = y0 + (16 + lines.length * 16 + 10) * px;
    for (const [col, t] of legend) {
      s.push(`<rect x="${x}" y="${ly - 9 * px}" width="${11 * px}" height="${9 * px}" fill="${col}"/>`);
      s.push(`<text x="${x + 15 * px}" y="${ly}">${t}</text>`);
      x += (t.length * 6.4 + 30) * px;
    }
    s.push('</g>');
  }
  s.push('</svg>');
  return { svg: s.join('\n'), width, height, minX, minZ, maxX, maxZ };
}

export async function renderLayout(l: CityLayout, opts: MapOptions): Promise<MapImage> {
  const { svg, width, height, minX, minZ, maxX, maxZ } = layoutSvg(l, opts);
  const img = sharp(Buffer.from(svg), { density: 72 }).resize(width, height);
  const png = await (opts.debug ? img.png({ compressionLevel: 9 }) : img.png({ compressionLevel: 9, palette: true })).toBuffer();
  return { png, width, height, minX, minZ, maxX, maxZ };
}
