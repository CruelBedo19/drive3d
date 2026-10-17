import type { RAPIER } from '../core/PhysicsWorld';
import type { DriverProfile, DriverProfileId, TrafficClass, TrafficClassId } from '../config/traffic';
import type { Carriageway } from './TrafficLaneNetwork';

export type TrafficState = 'cruise' | 'indicate' | 'changing' | 'aborting' | 'probe' | 'crashed';
export type TrafficTier = 0 | 1 | 2;

/** Pose for drawing (interpolated between the last two simulation steps). */
export interface TrafficPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * One AI vehicle: lightweight kinematic state in road coordinates (distance
 * along the road, fractional lane position, speed), no tyre or suspension
 * model. A pooled kinematic Rapier body follows it while it is near the
 * player; after a collision that body turns dynamic and the vehicle becomes a
 * wreck the others drive around.
 */
export interface TrafficVehicle {
  id: number;
  classId: TrafficClassId;
  klass: TrafficClass;
  profileId: DriverProfileId;
  profile: DriverProfile;
  paint: number;
  carriageway: Carriageway;
  dir: 1 | -1;
  /** Road distance of the centre, m. */
  s: number;
  /** Fractional lane position: 0 = right lane centre … 2 = left lane centre. */
  lanePos: number;
  /** Lane it counts as being in (switches half-way through a lane change). */
  lane: number;
  /** Speed along the road, m/s, current / wanted acceleration, m/s². */
  v: number;
  a: number;
  aTarget: number;
  /** Personal wanted speed (fixed per driver), m/s. */
  desired: number;
  /** Bold driver: shorter indicating, quicker lane changes, accepts tight gaps (≥ 2.5 s to the car behind) and may cut in front of the player. */
  bold: boolean;
  state: TrafficState;
  tier: TrafficTier;
  /** Lane change: from / to lane index, progress 0..1, duration s, indicator time s. */
  fromLane: number;
  toLane: number;
  lcT: number;
  lcDuration: number;
  indicateT: number;
  /** +1 left, -1 right, 0 off (2 = hazard lights). */
  indicator: number;
  brake: boolean;
  headlights: boolean;
  /** Seconds since entering the current lane / until the next lane decision may start. */
  laneTime: number;
  cooldown: number;
  /** Steps until the next decision. */
  decisionIn: number;
  /** Debug: vehicle in front (id, -1 none; -2 = player), gap and wanted gap, m. */
  leadId: number;
  leadGap: number;
  desiredGap: number;
  /** Pooled collision body (near only) and the velocity it had when it turned dynamic. */
  body: RAPIER.RigidBody | null;
  probeT: number;
  probeVx: number;
  probeVz: number;
  crashT: number;
  /** Slot in its class's instanced meshes. */
  slot: number;
  prev: TrafficPose;
  pose: TrafficPose;
  wheelAngle: number;
  /** Seen this decision tick in a lane list (occupancy bookkeeping). */
  alive: boolean;
}
