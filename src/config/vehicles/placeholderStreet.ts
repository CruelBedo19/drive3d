import type { VehicleDefinition } from '../vehicleTypes';

/**
 * Placeholder test car: a balanced ~1400 kg rear-wheel-drive street car,
 * roughly hot-hatch / small sports sedan territory. Used to tune the base
 * driving feel; real cars get their own file in this folder.
 */
export const placeholderStreet: VehicleDefinition = {
  physics: {
    id: 'placeholder',
    name: 'Test Car',
    drivetrain: 'RWD',
    awdFrontSplit: 0.4,
    maxSpeedKmh: 250,
    maxReverseKmh: 35,

    chassis: {
      mass: 1400,
      halfExtents: { x: 0.86, y: 0.3, z: 2.2 },
      cabinHalfExtents: { x: 0.75, y: 0.22, z: 1.1 },
      cabinOffset: { x: 0, y: 0.5, z: -0.25 },
      centerOfMass: { x: 0, y: -0.12, z: 0.05 },
      inertiaScale: { x: 1.0, y: 1.0, z: 1.5 },
      linearDamping: 0.0,
      angularDamping: 0.4,
      dragCoefficient: 0.42,
      rollingResistance: 0.012,
      downforce: 0.35,
    },

    front: { z: 1.35, halfTrack: 0.82, hardpointY: 0.1, antiRoll: 16000, grip: 1.0 },
    rear: { z: -1.3, halfTrack: 0.82, hardpointY: 0.1, antiRoll: 11000, grip: 1.08 },

    suspension: {
      restLength: 0.35,
      stiffness: 36000,
      compressionDamping: 3000,
      reboundDamping: 3800,
      bumpStopStart: 0.85,
      bumpStopStiffness: 220000,
    },

    wheel: { radius: 0.34, width: 0.24, inertia: 1.2 },

    differential: {
      type: 'LSD',
      powerLock: 0.25,
      coastLock: 0.1,
      preload: 40,
    },

    tires: {
      friction: 1.05,
      longitudinalGrip: 1.12,
      peakSlipAngle: 0.15,
      peakSlipRatio: 0.11,
      curveShape: 1.3,
      rollInfluence: 0.3,
    },

    steering: {
      maxAngleDeg: 34,
      highSpeedAngleDeg: 6,
      highSpeedKmh: 170,
      steerSpeed: 3.0,
      returnSpeed: 4.0,
      highSpeedRateScale: 0.45,
      gripLimitFactor: 1.2,
      countersteerAssist: 0.5,
      keyboardRamp: 0,
      inputExpo: 1,
      counterSteerLimitDeg: 0,
    },

    brakes: {
      maxForce: 15000,
      frontBias: 0.66,
      handbrakeForce: 6000,
      handbrakeRearGrip: 0.88,
    },

    assists: {
      tractionControl: 0.8,
      abs: 1.0,
      stability: 0.55,
      maxSlipDeg: 20,
      countersteerRelief: 0,
      wheelspinLimit: 0,
      recovery: 0,
    },

    engine: {
      idleRpm: 900,
      redlineRpm: 7000,
      maxPowerKw: 250,
      peakTorqueNm: 400,
      torqueCurve: [
        [0, 0.55],
        [1000, 0.65],
        [2500, 0.92],
        [3500, 1.0],
        [5000, 0.97],
        [6500, 0.84],
        [7200, 0.7],
      ],
      engineBrakingNm: 70,
      inertia: 0.18,
      launchRpm: 1800,
      freeRevRate: 9000,
    },

    gearbox: {
      ratios: [3.5, 2.25, 1.6, 1.25, 1.05, 0.86],
      reverseRatio: 3.4,
      finalDrive: 3.7,
      efficiency: 0.85,
      shiftUpRpm: 6600,
      shiftDownRpm: 2600,
      shiftTime: 0.15,
    },
  },

  visual: {
    kind: 'placeholder',
    bodyColor: 0xd23c2f,
  },
};
