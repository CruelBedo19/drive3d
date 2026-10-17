import type { RAPIER } from '../core/PhysicsWorld';
import type { TrackId } from '../config/tracks';
import { AutobahnTrack } from './autobahn/AutobahnTrack';
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
  }
}
