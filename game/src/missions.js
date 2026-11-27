/**
 * Valley Mail sortie definitions and deterministic mission/run bookkeeping.
 * Pure logic: no canvas, DOM, timers, random numbers or I/O.
 *
 * Exports:
 *   SORTIES — frozen menu data: five campaign sorties followed by Free Flight.
 *   FREE_FLIGHT — the endless entry in SORTIES.
 *   createSortieWorld(sortieOrId) — apply a sortie's seed, palette, weather, obstacles and rings.
 *   createRun(sortieOrId, world, rings = world.rings, plane?) — fresh run state.
 *   stepRun(run, plane, input, dt) — update flight progress, combos, and weather.
 *   finishRun(run, plane) — evaluate a terminal plane; return scoreCard or null.
 */
import { SCORING, WORLD, PALETTES, FUEL } from './config.js';
import { createWorld, createRings } from './world.js';
import { createPlane } from './plane.js';
import {
  createComboTracker,
  registerRingHit,
  stepComboTracker,
  calculateComboBonus,
  evaluateRunGrade,
} from './scoring.js';
import { createWeatherSystem, stepWeather } from './weather.js';
import { generateRouteObstacles, checkObstacleCollisions } from './obstacles.js';
import { calculateSortieEarnings } from './progression.js';

/** Constructs an immutable, normalized sortie definition record. */
function buildSortieDefinition({
  id,
  name,
  briefing,
  palette = 'day',
  routeType = 'valley',
  weather = 'clear',
  ringCount,
  fuelLoad = 1,
  requiresParcelDrop = false,
  parTimeSeconds = 0,
  seedOffset = 0,
  endless = false,
}) {
  return Object.freeze({
    id,
    name,
    briefing,
    palette,
    routeType,
    weather,
    ringCount,
    fuelLoad,
    requiresParcelDrop,
    parTimeSeconds,
    seedOffset,
    endless,
  });
}

/** Canonical sortie table declaring campaign sorties and endless flight. */
const SORTIE_DEFINITIONS = [
  {
    id: 1,
    name: 'First Post',
    briefing: 'Follow five rings through the valley and land the mail at the far airstrip.',
    palette: 'day',
    routeType: 'valley',
    weather: 'clear',
    ringCount: 5,
    fuelLoad: 0.9,
    requiresParcelDrop: false,
    parTimeSeconds: 180,
    seedOffset: 0,
    endless: false,
  },
  {
    id: 2,
    name: 'Cargo Drop',
    briefing: 'Drop the parcel over the village target, then land the mail at the far airstrip.',
    palette: 'day',
    routeType: 'valley',
    weather: 'breeze',
    ringCount: 6,
    fuelLoad: 1,
    requiresParcelDrop: true,
    parTimeSeconds: 225,
    seedOffset: 1103,
    endless: false,
  },
  {
    id: 3,
    name: 'Gorge Navigation',
    briefing: 'Navigate the narrow alpine gorge beneath the suspension bridge and rock arch.',
    palette: 'day',
    routeType: 'gorge',
    weather: 'breeze',
    ringCount: 7,
    fuelLoad: 0.85,
    requiresParcelDrop: false,
    parTimeSeconds: 250,
    seedOffset: 1749,
    endless: false,
  },
  {
    id: 4,
    name: 'Storm Pass',
    briefing: 'Fly through heavy mountain squall and crosswinds; watch for the radio mast hazard.',
    palette: 'day',
    routeType: 'storm',
    weather: 'storm',
    ringCount: 8,
    fuelLoad: 0.8,
    requiresParcelDrop: false,
    parTimeSeconds: 270,
    seedOffset: 2841,
    endless: false,
  },
  {
    id: 5,
    name: 'Dusk Run',
    briefing: 'Chase eight rings into twilight and bring the mail home on a tight fuel reserve.',
    palette: 'dusk',
    routeType: 'valley',
    weather: 'dusk_mist',
    ringCount: 8,
    fuelLoad: 0.6,
    requiresParcelDrop: false,
    parTimeSeconds: 260,
    seedOffset: 3412,
    endless: false,
  },
  {
    id: 'free',
    name: 'Free Flight',
    briefing: 'Explore at your own pace; fresh rings and terrain keep appearing down the valley.',
    palette: 'day',
    routeType: 'valley',
    weather: 'clear',
    ringCount: 6,
    fuelLoad: 1,
    requiresParcelDrop: false,
    parTimeSeconds: 0,
    seedOffset: 4107,
    endless: true,
  },
];

export const SORTIES = Object.freeze(SORTIE_DEFINITIONS.map(buildSortieDefinition));

export const FREE_FLIGHT = SORTIES[SORTIES.length - 1];

function resolveSortie(sortieOrId) {
  const sortie = typeof sortieOrId === 'object' && sortieOrId !== null
    ? sortieOrId : SORTIES.find((entry) => entry.id === sortieOrId);
  if (!sortie || !Object.hasOwn(PALETTES, sortie.palette)) {
    throw new RangeError('Choose a Valley Mail sortie with a known palette.');
  }
  return sortie;
}

/** Build a deterministic valley with weather and route obstacles. */
export function createSortieWorld(sortieOrId) {
  const sortie = resolveSortie(sortieOrId);
  const baseWorld = createWorld({
    seed: WORLD.seed + sortie.seedOffset,
    ringCount: sortie.ringCount,
    palette: sortie.palette,
  });
  const weather = createWeatherSystem(sortie.weather, baseWorld.seed);
  const obstacles = generateRouteObstacles(baseWorld, sortie.routeType, baseWorld.seed);
  return Object.freeze({
    ...baseWorld,
    weather,
    obstacles,
    routeType: sortie.routeType,
  });
}

/** Own the active ring array, retaining its ring references and passed flags. */
export function createRun(sortieOrId, world, rings = world.rings, plane = createPlane(world)) {
  const sortie = resolveSortie(sortieOrId);
  const activeRings = [...rings].sort((a, b) => a.position.z - b.position.z);
  const ringsHit = activeRings.filter((ring) => ring.passed).length;
  const unpassed = activeRings.filter((ring) => !ring.passed);
  const combo = createComboTracker();

  return {
    sortie,
    world,
    weather: world.weather ?? createWeatherSystem(sortie.weather, world.seed),
    obstacles: world.obstacles ?? generateRouteObstacles(world, sortie.routeType, world.seed),
    combo,
    startingFuel: FUEL.capacity * sortie.fuelLoad,
    rings: activeRings,
    ringsHit,
    ringsTotal: activeRings.length,
    ringsRemaining: unpassed.length,
    nextRing: unpassed.find((ring) => ring.position.z >= plane.position.z)
      ?? unpassed[0] ?? null,
    parcel: {
      status: sortie.requiresParcelDrop ? 'carried' : 'none',
      position: sortie.requiresParcelDrop ? { ...plane.position } : null,
      velocity: null,
      target: sortie.requiresParcelDrop ? (world.village.dropZone ?? world.village) : null,
    },
    elapsedSeconds: 0,
    damageTaken: 0,
    score: ringsHit * SCORING.ringBonus,
    finished: false,
    scoreCard: null,
    _previousPosition: { ...plane.position },
    _startingHull: plane.hull,
    _ringBatch: 0,
  };
}

const GRAVITY_METERS_PER_SECOND_SQUARED = 9.81;
const PARCEL_STEP_SECONDS = 1 / 60;
const KNOTS_TO_METERS_PER_SECOND = 1852 / 3600;

function threadRings(run, from, to) {
  const dz = to.z - from.z;
  if (dz === 0) return 0;
  let newlyPassed = 0;
  for (const ring of run.rings) {
    if (ring.passed) continue;
    const t = (ring.position.z - from.z) / dz;
    if (t <= 0 || t > 1) continue;
    const dx = from.x + (to.x - from.x) * t - ring.position.x;
    const dy = from.y + (to.y - from.y) * t - ring.position.y;
    if (dx * dx + dy * dy <= ring.radius * ring.radius) {
      ring.passed = true;
      run.ringsHit += 1;
      newlyPassed += 1;
      registerRingHit(run.combo);
      run.score += calculateComboBonus(run.combo, SCORING.ringBonus);
    }
  }
  return newlyPassed;
}

function updateRingTargets(run, position) {
  const remaining = run.rings.filter((ring) => !ring.passed);
  run.ringsRemaining = remaining.length;
  run.nextRing = remaining.find((ring) => ring.position.z >= position.z)
    ?? remaining[0] ?? null;
}

function respawnRings(run, position) {
  if (!run.sortie.endless
    || !run.rings.every((ring) => ring.passed || ring.position.z < position.z)) return;
  const templates = [...createRings(run.world, run.sortie.ringCount)]
    .sort((a, b) => a.position.z - b.position.z);
  if (templates.length === 0) return;
  const lastZ = run.rings.reduce((z, ring) => Math.max(z, ring.position.z), position.z);
  const firstZ = lastZ + WORLD.ringSpacingMeters;
  const originZ = templates[0].position.z;
  run._ringBatch += 1;

  run.rings = templates.map((ring, index) => {
    const z = firstZ + ring.position.z - originZ;
    const x = run.world.riverCenter(z)
      + ring.position.x - run.world.riverCenter(ring.position.z);
    const y = run.world.groundHeight(x, z)
      + ring.position.y - run.world.groundHeight(ring.position.x, ring.position.z);
    const dx = x - ring.position.x;
    const dz = z - ring.position.z;
    const replacement = {
      ...ring,
      id: (ring.id ?? 'ring-' + index) + '-batch-' + run._ringBatch,
      position: { x, y, z },
      passed: false,
    };
    if (ring.bounds) {
      replacement.bounds = {
        ...ring.bounds,
        minX: ring.bounds.minX + dx,
        maxX: ring.bounds.maxX + dx,
        minZ: ring.bounds.minZ + dz,
        maxZ: ring.bounds.maxZ + dz,
      };
    }
    return replacement;
  });
  run.ringsTotal += run.rings.length;
}

function insideDropZone(position, zone) {
  const center = zone?.position ?? zone?.center ?? zone;
  const radius = zone?.radius ?? zone?.radiusMeters;
  if (Number.isFinite(radius) && radius >= 0
    && Number.isFinite(center?.x) && Number.isFinite(center?.z)) {
    return (position.x - center.x) ** 2 + (position.z - center.z) ** 2 <= radius ** 2;
  }
  const bounds = zone?.bounds ?? zone;
  return Boolean(bounds && position.x >= bounds.minX && position.x <= bounds.maxX
    && position.z >= bounds.minZ && position.z <= bounds.maxZ);
}

function settleParcel(run) {
  const parcel = run.parcel;
  parcel.position.y = run.world.groundHeight(parcel.position.x, parcel.position.z);
  parcel.status = insideDropZone(parcel.position, parcel.target) ? 'hit' : 'missed';
  parcel.velocity = { x: 0, y: 0, z: 0 };
}

function releaseParcel(run, plane) {
  const heading = plane.heading * Math.PI / 180;
  const speed = plane.airspeedKnots * KNOTS_TO_METERS_PER_SECOND
    * Math.cos(plane.pitch * Math.PI / 180);
  run.parcel.status = 'falling';
  run.parcel.position = { ...plane.position };
  run.parcel.velocity = {
    x: Math.sin(heading) * speed,
    y: plane.verticalSpeed,
    z: Math.cos(heading) * speed,
  };
  if (run.world.clearance(run.parcel.position) <= 0) settleParcel(run);
}

function advanceParcel(run, dt) {
  const parcel = run.parcel;
  const steps = Math.ceil(dt / PARCEL_STEP_SECONDS);
  const stepDt = dt / steps;
  for (let i = 0; i < steps && parcel.status === 'falling'; i += 1) {
    const start = { ...parcel.position };
    const vy = parcel.velocity.y;
    const at = (seconds) => ({
      x: start.x + parcel.velocity.x * seconds,
      y: start.y + vy * seconds
        - 0.5 * GRAVITY_METERS_PER_SECOND_SQUARED * seconds ** 2,
      z: start.z + parcel.velocity.z * seconds,
    });
    Object.assign(parcel.position, at(stepDt));
    parcel.velocity.y = vy - GRAVITY_METERS_PER_SECOND_SQUARED * stepDt;
    if (run.world.clearance(parcel.position) > 0) continue;

    let low = 0;
    let high = stepDt;
    for (let search = 0; search < 20; search += 1) {
      const middle = (low + high) / 2;
      if (run.world.clearance(at(middle)) > 0) low = middle;
      else high = middle;
    }
    Object.assign(parcel.position, at(high));
    settleParcel(run);
  }
}

function updateSubtotal(run, plane) {
  run.damageTaken = Math.max(run.damageTaken, run._startingHull - plane.hull, 0);
  const cargoBonus = run.parcel.status === 'hit'
    ? Math.round(SCORING.cargoDeliveryBonus * (plane._cargoDropBonusMult ?? 1))
    : 0;
  run.score = Math.max(run.score, run.ringsHit * SCORING.ringBonus + cargoBonus);
}

/** Track simulation movement and update weather, obstacles, and combos. */
export function stepRun(run, plane, input, dt) {
  if (run.finished || !Number.isFinite(dt) || dt <= 0) return run;
  run.elapsedSeconds += dt;

  stepWeather(run.weather, plane, dt);
  stepComboTracker(run.combo, dt);

  // Check obstacle collisions
  const hazard = checkObstacleCollisions(plane, run.obstacles);
  if (hazard && hazard.hit) {
    plane.hull = Math.max(0, plane.hull - 35);
    plane.crashReason = hazard.message;
    if (plane.hull <= 0) {
      plane.crashed = true;
    }
  }

  threadRings(run, run._previousPosition, plane.position);

  if (run.parcel.status === 'falling') {
    advanceParcel(run, dt);
  } else if (run.parcel.status === 'carried') {
    Object.assign(run.parcel.position, plane.position);
    if (input?.drop) releaseParcel(run, plane);
  }
  run._previousPosition = { ...plane.position };
  updateSubtotal(run, plane);
  updateRingTargets(run, plane.position);
  if (!finishRun(run, plane)) {
    respawnRings(run, plane.position);
    updateRingTargets(run, plane.position);
  }
  return run;
}

function determineRunOutcome(run, plane) {
  const destroyed = plane.hull <= 0;
  const empty = plane.fuel <= FUEL.empty;
  const cargoReady = !run.sortie.requiresParcelDrop || run.parcel.status === 'hit';
  const atDestination = plane.groundStripId === run.world.destination.id;

  if (destroyed) {
    return { outcome: 'hull destroyed', reason: plane.crashReason || 'No hull integrity remains.' };
  }
  if (plane.crashed) {
    return {
      outcome: empty ? 'out of fuel' : 'crashed',
      reason: plane.crashReason || (empty ? 'The fuel tank is empty.' : 'The aircraft crashed.'),
    };
  }
  if (run.sortie.endless) {
    if (!empty) return null;
    return { outcome: 'out of fuel', reason: 'Free flight ended with an empty tank.' };
  }
  if (atDestination && cargoReady) {
    return {
      outcome: 'delivered',
      reason: run.sortie.requiresParcelDrop ? 'Mail and parcel delivered.' : 'Mail delivered.',
    };
  }
  if (empty) {
    return { outcome: 'out of fuel', reason: 'Fuel exhausted before the delivery was complete.' };
  }
  return {
    outcome: 'crashed',
    reason: !atDestination
      ? 'Mail was not delivered: land at the destination airstrip.'
      : run.parcel.status === 'missed'
        ? 'The parcel missed the village drop zone.'
        : 'The parcel had not reached the village drop zone before landing.',
  };
}

function buildScoreCard(run, plane, { outcome, reason }) {
  updateSubtotal(run, plane);
  const destroyed = plane.hull <= 0;
  const safeLanding = plane.landed && !plane.crashed && !destroyed;
  const grade = safeLanding
    ? SCORING.landingGrades.find((entry) => entry.id === plane.landingGrade) : null;
  const landingBonus = safeLanding ? (grade?.bonus ?? plane.landingBonus ?? 0) : 0;
  const timeBonus = Math.max(0, run.sortie.parTimeSeconds - run.elapsedSeconds)
    * SCORING.timeBonusPerSecondRemaining;
  const mailBonus = outcome === 'delivered' ? SCORING.mailDeliveryBonus : 0;
  const damagePenalty = run.damageTaken * SCORING.damagePenaltyPerPoint;
  const totalScore = Math.max(0, run.score + mailBonus + landingBonus + timeBonus - damagePenalty);

  const partialCard = {
    outcome,
    reason,
    ringsHit: run.ringsHit,
    ringsTotal: run.ringsTotal,
    timeSeconds: run.elapsedSeconds,
    landingGrade: safeLanding ? plane.landingGrade : null,
    landingLabel: safeLanding ? (plane.landingLabel ?? grade?.label ?? null) : null,
    damageTaken: run.damageTaken,
    score: totalScore,
    totalScore,
    maxStreak: run.combo.maxStreak,
  };

  const rankReview = evaluateRunGrade(run, plane, partialCard);
  const earnings = calculateSortieEarnings(partialCard, run.sortie, run.combo.maxStreak);

  return Object.freeze({
    ...partialCard,
    grade: rankReview.grade,
    gradeTitle: rankReview.title,
    gradeColor: rankReview.color,
    gradeSummary: rankReview.summary,
    creditsEarned: earnings,
  });
}

export function finishRun(run, plane) {
  if (run.finished) return run.scoreCard;
  if (!plane.landed && !plane.crashed && plane.hull > 0) return null;

  const terminal = determineRunOutcome(run, plane);
  if (!terminal) return null;

  run.scoreCard = buildScoreCard(run, plane, terminal);
  run.finished = true;
  return run.scoreCard;
}
