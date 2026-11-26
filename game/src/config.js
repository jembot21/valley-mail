/**
 * Shared, immutable tuning data for Valley Mail; no simulation or rendering here.
 * Exports: CONFIG plus CANVAS, UNITS, FLIGHT, FUEL, DAMAGE, SCORING, WORLD,
 * PALETTES, CONTROLS, AUDIO, SHOT_NAMES, and readShotName(search?).
 * World lengths use metres, airspeed uses knots, angles use degrees, time uses
 * seconds, throttle uses 0..1, and fuel/hull use 0..100 unless a name says otherwise.
 * CONFIG.shot is parsed at module startup; it does not freeze or compose a scene.
 */

function freezeData(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freezeData(child);
  }
  return Object.freeze(value);
}

export const CANVAS = freezeData({ width: 1280, height: 720 });
export const UNITS = freezeData({
  knotsToMetersPerSecond: 0.514444,
  metersToFeet: 3.28084,
  degreesToRadians: Math.PI / 180,
});

export const FLIGHT = freezeData({
  stallSpeedKnots: 45,
  takeoffSpeedKnots: 52,
  cruiseSpeedKnots: 90,
  maxSpeedKnots: 135,
  initialThrottle: 0.35,
  throttleResponsePerSecond: 0.32,
  accelerationKnotsPerSecond: 24,
  dragKnotsPerSecond: 8,
  gearDragKnotsPerSecond: 5,
  climbSpeedLossKnotsPerMeter: 0.45,
  pitchRateDegreesPerSecond: 36,
  maxPitchUpDegrees: 18,
  maxPitchDownDegrees: 22,
  bankRateDegreesPerSecond: 65,
  maxBankDegrees: 50,
  bankReturnRatePerSecond: 1.8,
  turnRateDegreesPerSecond: 32, // At reference bank and cruise speed.
  turnReferenceBankDegrees: 45,
  maxClimbMetersPerSecond: 9,
  maxDescentMetersPerSecond: 14,
  stallNoseDropDegreesPerSecond: 18,
  stallSinkMetersPerSecond: 7,
  groundBrakeKnotsPerSecond: 12,
  wingspanMeters: 11,
});

export const FUEL = freezeData({
  capacity: 100,
  idleBurnPerSecond: 0.09,
  fullThrottleBurnPerSecond: 0.5,
  throttleBurnExponent: 2,
  lowWarning: 20,
  empty: 0,
});

export const DAMAGE = freezeData({
  maxHull: 100,
  lowHullWarning: 25,
  terrainScrapePerSecond: 18,
  terrainImpactPerKnot: 0.65,
  safeLandingSinkMetersPerSecond: 1.8,
  hardLandingDamagePerExcessMeterPerSecond: 12,
  maxLandingSpeedKnots: 75,
  landingOverspeedDamagePerKnot: 1.2,
  gearUpLandingDamage: 45,
  unsafeLandingBankDegrees: 20,
  unsafeLandingBankDamagePerDegree: 2,
  crashSinkMetersPerSecond: 12,
});

export const SCORING = freezeData({
  ringBonus: 100,
  cargoDeliveryBonus: 500,
  mailDeliveryBonus: 1000,
  damagePenaltyPerPoint: 10,
  timeBonusPerSecondRemaining: 5,
  // Evaluate in order; both sink and absolute bank must be within a grade.
  landingGrades: [
    { id: 'butter', label: 'BUTTER SMOOTH', maxSinkMetersPerSecond: 1.2, maxBankDegrees: 5, bonus: 1000 },
    { id: 'clean', label: 'CLEAN LANDING', maxSinkMetersPerSecond: 2.4, maxBankDegrees: 10, bonus: 600 },
    { id: 'hard', label: 'HARD LANDING', maxSinkMetersPerSecond: 4.8, maxBankDegrees: 18, bonus: 150 },
    { id: 'rough', label: 'ROUGH LANDING', maxSinkMetersPerSecond: 12, maxBankDegrees: 50, bonus: 0 },
  ],
});

export const WORLD = freezeData({
  seed: 261126,
  valleyWidthMeters: 760,
  riverWidthMeters: 90,
  riverWindingAmplitudeMeters: 240,
  riverWindingLengthMeters: 1800,
  ringRadiusMeters: 32,
  ringSpacingMeters: 360,
  ringHeightMeters: 100,
  runwayWidthMeters: 42,
  runwayLengthMeters: 560,
  terrainSegmentLengthMeters: 80,
  viewDistanceMeters: 6000,
  ridgeHeightMeters: 420,
  fieldPatchLengthMeters: 160,
});

export const PALETTES = freezeData({
  day: {
    sky: { top: '#438bc1', horizon: '#d8edf0' },
    ridges: ['#9fbac0', '#6e919a', '#426b73'],
    fields: ['#6f9850', '#91ad62', '#b4b66c', '#d0bd80'],
    river: '#4aa7bd',
    riverHighlight: '#b3e2df',
    runway: '#72874a',
    runwayMarkings: '#fff5d6',
    ringGlow: '#ffd76c',
    ringCore: '#fff7ca',
    aircraft: '#e5c56e',
    aircraftTrim: '#9a4235',
    hud: { text: '#fff5df', dim: '#bfdbd9', panel: '#102330', outline: '#eff5e4', accent: '#ffd76c', warning: '#ff735b' },
  },
  dusk: {
    sky: { top: '#24294c', horizon: '#de997b' },
    ridges: ['#807b96', '#525776', '#303c59'],
    fields: ['#4c614d', '#60714f', '#827954', '#948260'],
    river: '#527e9c',
    riverHighlight: '#c4a9a0',
    runway: '#556245',
    runwayMarkings: '#ffe9a2',
    ringGlow: '#ffc15b',
    ringCore: '#fff0b8',
    aircraft: '#d7b56e',
    aircraftTrim: '#844e46',
    hud: { text: '#fff0ce', dim: '#bcc5de', panel: '#171c32', outline: '#e8d8bb', accent: '#ffc15b', warning: '#ff8066' },
  },
});

export const CONTROLS = freezeData({
  pitchUp: ['ArrowUp', 'KeyW'],
  pitchDown: ['ArrowDown', 'KeyS'],
  bankLeft: ['ArrowLeft', 'KeyA'],
  bankRight: ['ArrowRight', 'KeyD'],
  throttleUp: ['ShiftLeft', 'ShiftRight', 'KeyR'],
  throttleDown: ['ControlLeft', 'ControlRight', 'KeyF'],
  gear: ['KeyG'],
  drop: ['Space'],
  pause: ['KeyP'],
  mute: ['KeyM'],
  confirm: ['Enter', 'NumpadEnter', 'Space'],
});

// Procedural audio tuning belongs here too, so later balancing has one source.
export const AUDIO = freezeData({
  masterVolume: 0.7,
  smoothingSeconds: 0.06,
  muteFadeSeconds: 0.025,
  envelopeFloor: 0.0001,
  maxEffectVoices: 24,
  noiseSeconds: 4.1,
  noiseSeed: 90210,
  compressor: { thresholdDb: -10, kneeDb: 10, ratio: 12, attackSeconds: 0.003, releaseSeconds: 0.2 },
  clipCeiling: 0.75,
  clipCurveSamples: 1025,
  engine: { idleHz: 48, throttleHz: 95, speedHz: 16, idleGain: 0.035, throttleGain: 0.085, speedGain: 0.015, harmonicRatio: 2, harmonicGain: 0.24 },
  wind: { highpassHz: 160, idleLowpassHz: 450, speedLowpassHz: 2100, maxGain: 0.085 },
  stall: { frequencyHz: 620, warbleHz: 4.5, warbleDepthHz: 85, gain: 0.045 },
  ring: {
    attackSeconds: 0.012, gain: 0.12,
    notes: [{ hz: 659.25, at: 0, duration: 0.23 }, { hz: 987.77, at: 0.09, duration: 0.3 }],
  },
  touchdown: { hz: 78, endHz: 42, duration: 0.22, attackSeconds: 0.008, gain: 0.17, noiseHz: 360, noiseGain: 0.11 },
  damage: { hz: 105, endHz: 38, duration: 0.28, attackSeconds: 0.005, gain: 0.11, noiseHz: 1700, noiseGain: 0.19 },
  delivered: {
    attackSeconds: 0.016, gain: 0.12,
    notes: [
      { hz: 523.25, at: 0, duration: 0.25 },
      { hz: 659.25, at: 0.18, duration: 0.25 },
      { hz: 783.99, at: 0.36, duration: 0.3 },
      { hz: 1046.5, at: 0.58, duration: 0.5 },
    ],
  },
});

export const SHOT_NAMES = freezeData(['cover', 'ring', 'approach', 'dusk']);

/** Read location.search by default; pass a query string for tools/tests. Unknown shots return null. */
export function readShotName(search = globalThis.location?.search ?? '') {
  const name = new URLSearchParams(search).get('shot');
  return SHOT_NAMES.includes(name) ? name : null;
}

export const CONFIG = freezeData({
  canvas: CANVAS,
  units: UNITS,
  flight: FLIGHT,
  fuel: FUEL,
  damage: DAMAGE,
  scoring: SCORING,
  world: WORLD,
  palettes: PALETTES,
  controls: CONTROLS,
  audio: AUDIO,
  shot: readShotName(),
});
