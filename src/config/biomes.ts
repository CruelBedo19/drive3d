/**
 * Autobahn landscape regions. Each biome is a set of numbers the terrain,
 * colour and vegetation code blend by weight, so a region change is a smooth
 * mix over kilometres, never a switch. Heights in metres.
 */
export const BIOME_IDS = ['denseForest', 'openForest', 'farmland', 'grassland', 'rollingHills', 'valley', 'rocky', 'industrial', 'service'] as const;
export type BiomeId = (typeof BIOME_IDS)[number];

export interface BiomeProfile {
  /** Name for the F2 panel. */
  label: string;
  /** Hills beside the road (relative to the road edge). */
  nearAmp: number;
  /** Small bumps (tens of metres). */
  detail: number;
  /** Ridged crests (rocky ground). */
  ridge: number;
  /** Ground falling away from the road (valleys: negative). */
  sink: number;
  /** Far landscape (beyond ~1 km): base level and hill amplitude. */
  farBase: number;
  farAmp: number;
  /** Trees per suitable spot 0..1, share of conifers, bushes 0..1. */
  trees: number;
  conifer: number;
  shrubs: number;
  /** Ground colour (linear-ish RGB 0..1) and the colour a forest reads as from far away. */
  ground: readonly [number, number, number];
  canopy: readonly [number, number, number];
  /** Patchwork of crop fields. */
  fields: boolean;
  /** Buildings (sheds, warehouses) per suitable spot 0..1. */
  buildings: number;
}

export const BIOMES: Record<BiomeId, BiomeProfile> = {
  denseForest: { label: 'Dense forest', nearAmp: 16, detail: 3, ridge: 0, sink: 0, farBase: 10, farAmp: 45, trees: 0.92, conifer: 0.75, shrubs: 0.4, ground: [0.17, 0.27, 0.12], canopy: [0.12, 0.22, 0.1], fields: false, buildings: 0 },
  openForest: { label: 'Seyrek orman', nearAmp: 12, detail: 3, ridge: 0, sink: 0, farBase: 5, farAmp: 35, trees: 0.42, conifer: 0.5, shrubs: 0.5, ground: [0.27, 0.37, 0.17], canopy: [0.2, 0.31, 0.14], fields: false, buildings: 0.02 },
  farmland: { label: 'Farmland', nearAmp: 5, detail: 1.5, ridge: 0, sink: 0, farBase: 0, farAmp: 18, trees: 0.035, conifer: 0.2, shrubs: 0.15, ground: [0.5, 0.52, 0.26], canopy: [0.45, 0.48, 0.24], fields: true, buildings: 0.12 },
  grassland: { label: 'Open grassland', nearAmp: 6, detail: 2, ridge: 0, sink: 0, farBase: 0, farAmp: 22, trees: 0.06, conifer: 0.3, shrubs: 0.35, ground: [0.4, 0.52, 0.24], canopy: [0.36, 0.48, 0.22], fields: false, buildings: 0.02 },
  rollingHills: { label: 'Rolling hills', nearAmp: 30, detail: 4, ridge: 0, sink: 0, farBase: 25, farAmp: 85, trees: 0.25, conifer: 0.4, shrubs: 0.3, ground: [0.38, 0.48, 0.22], canopy: [0.26, 0.37, 0.17], fields: false, buildings: 0.03 },
  valley: { label: 'Vadi', nearAmp: 10, detail: 2, ridge: 0, sink: -38, farBase: -45, farAmp: 30, trees: 0.3, conifer: 0.5, shrubs: 0.3, ground: [0.34, 0.47, 0.2], canopy: [0.21, 0.33, 0.14], fields: false, buildings: 0.02 },
  rocky: { label: 'Rocky / hilly', nearAmp: 42, detail: 6, ridge: 30, sink: 0, farBase: 60, farAmp: 190, trees: 0.2, conifer: 0.9, shrubs: 0.2, ground: [0.45, 0.43, 0.38], canopy: [0.3, 0.33, 0.25], fields: false, buildings: 0 },
  industrial: { label: 'Industrial area', nearAmp: 3, detail: 1, ridge: 0, sink: 0, farBase: 0, farAmp: 10, trees: 0.05, conifer: 0.3, shrubs: 0.1, ground: [0.42, 0.43, 0.36], canopy: [0.42, 0.43, 0.36], fields: false, buildings: 0.6 },
  service: { label: 'Rest-area surroundings', nearAmp: 3, detail: 1, ridge: 0, sink: 0, farBase: 0, farAmp: 10, trees: 0.12, conifer: 0.3, shrubs: 0.25, ground: [0.36, 0.5, 0.24], canopy: [0.3, 0.42, 0.2], fields: false, buildings: 0 },
};

/** Crop colours for the farmland patchwork (wheat, grass, soil, young crop, rapeseed). */
export const FIELD_COLOURS: readonly (readonly [number, number, number])[] = [
  [0.72, 0.62, 0.32],
  [0.36, 0.5, 0.2],
  [0.42, 0.33, 0.22],
  [0.5, 0.6, 0.28],
  [0.8, 0.74, 0.24],
];
