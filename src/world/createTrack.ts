import type { RAPIER } from '../core/PhysicsWorld';
import type { TrackId } from '../config/tracks';
import { AutobahnTrack } from './autobahn/AutobahnTrack';
import { cityV2Assets } from './cityv2/CityV2Assets';
import { CityV2Track } from './cityv2/CityV2Track';
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
      // Loaded beforehand by the loading screen (loadCityV2()), and kept for later sessions.
      const assets = cityV2Assets();
      if (!assets) throw new Error('City assets are not loaded');
      return new CityV2Track(world, assets);
    }
  }
}
