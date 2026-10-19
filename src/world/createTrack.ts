import type { RAPIER } from '../core/PhysicsWorld';
import type { TrackId } from '../config/tracks';
import { AutobahnTrack } from './autobahn/AutobahnTrack';
import { cityAssets } from './city/CityAssets';
import { CityTrack } from './city/CityTrack';
import { NordschleifeTrack } from './nordschleife/NordschleifeTrack';
import { TestTrack } from './TestTrack';
import type { Track } from './Track';

export function createTrack(id: TrackId, world: RAPIER.World, seed?: number): Track {
  switch (id) {
    case 'nordschleife':
      return new NordschleifeTrack(world);
    case 'test':
      return new TestTrack(world);
    case 'autobahn':
      return new AutobahnTrack(world, seed);
    case 'city': {
      // Loaded beforehand by the loading screen (loadCity()), and kept for later sessions.
      const assets = cityAssets();
      if (!assets) throw new Error('City assets are not loaded');
      return new CityTrack(world, assets);
    }
  }
}
