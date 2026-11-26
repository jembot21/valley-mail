/**
 * Valley Mail sortie definitions and deterministic mission/run bookkeeping.
 * Pure logic: no canvas, DOM, timers, random numbers or I/O.
 *
 * Exports:
 *   SORTIES — frozen menu data: three campaign sorties followed by Free Flight.
 *   FREE_FLIGHT — the endless entry in SORTIES.
 *   createSortieWorld(sortieOrId) — apply a sortie's seed, palette and ring count.
 *   createRun(sortieOrId, world, rings = world.rings, plane?) — fresh run state.
 *   stepRun(run, plane, input, dt) — update after stepPlane using the same dt.
 *   finishRun(run, plane) — evaluate a terminal plane; return scoreCard or null.
 *
 * Sortie fuelLoad is a fraction of FUEL.capacity; parTimeSeconds is in seconds.
 * Create the plane, pass it to createRun, then set plane.fuel = run.startingFuel.
 * The optional plane snapshots the actual starting position/hull; without it,
 * createRun uses createPlane(world)'s departure state. Pass fresh rings on retry.
 * input.drop is a one-step press. dt is seconds of active play, excluding pause.
 *
 * Public run state: sortie, world, startingFuel, rings, ringsHit, ringsTotal,
 * ringsRemaining, nextRing, parcel, elapsedSeconds, damageTaken, score, finished
 * and scoreCard. parcel has status (none/carried/falling/hit/missed), position,
 * velocity and target. Its target uses the village dropZone, or village bounds.
 * score is the live ring/cargo subtotal; scoreCard.score is the final total.
 * Underscore fields are bookkeeping. Updates mutate and return the same run.
 *
 * Render/HUD code must read run.rings: endless batches replace that array without
 * changing frozen world data. ringsTotal counts all rings offered over the run;
 * ringsRemaining counts unpassed rings in the active batch. nextRing prefers an
 * unpassed ring ahead, falling back to a missed ring the pilot can return to.
 */
import { SCORING, WORLD, PALETTES, FUEL } from './config.js';
import { createWorld, createRings } from './world.js';
import { createPlane } from './plane.js';

export const SORTIES = Object.freeze([
  {
    id: 1,
    name: 'First Post',
    briefing: 'Follow five rings through the valley and land the mail at the far airstrip.',
    palette: 'day',
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
    ringCount: 6,
    fuelLoad: 1,
    requiresParcelDrop: true,
    parTimeSeconds: 225,
    seedOffset: 1103,
    endless: false,
  },
  {
    id: 3,
    name: 'Dusk Run',
    briefing: 'Chase seven rings in the fading light and bring the mail home on a tighter tank.',
    palette: 'dusk',
    ringCount: 7,
    fuelLoad: 0.6,
    requiresParcelDrop: false,
    parTimeSeconds: 240,
    seedOffset: 2207,
    endless: false,
  },
  {
    id: 'free',
    name: 'Free Flight',
    briefing: 'Explore at your own pace; fresh rings keep appearing down the valley.',
    palette: 'day',
    ringCount: 6,
    fuelLoad: 1,
    requiresParcelDrop: false,
    parTimeSeconds: 0,
    seedOffset: 3301,
    endless: true,
  },
].map((sortie) => Object.freeze(sortie)));

export const FREE_FLIGHT = SORTIES[SORTIES.length - 1];

function resolveSortie(sortieOrId) {
  const sortie = typeof sortieOrId === 'object' && sortieOrId !== null
    ? sortieOrId : SORTIES.find((entry) => entry.id === sortieOrId);
  if (!sortie || !Object.hasOwn(PALETTES, sortie.palette)) {
    throw new RangeError('Choose a Valley Mail sortie with a known palette.');
  }
  return sortie;
}

/** Build a deterministic valley; callers may instead supply their own world. */
export function createSortieWorld(sortieOrId) {
  const sortie = resolveSortie(sortieOrId);
  return createWorld({
    seed: WORLD.seed + sortie.seedOffset,
    ringCount: sortie.ringCount,
    palette: sortie.palette,
  });
}

/** Own the active ring array, retaining its ring references and passed flags. */
export function createRun(sortieOrId, world, rings = world.rings, plane = createPlane(world)) {
  const sortie = resolveSortie(sortieOrId);
  const activeRings = [...rings].sort((a, b) => a.position.z - b.position.z);
  const ringsHit = activeRings.filter((ring) => ring.passed).length;
  const unpassed = activeRings.filter((ring) => !ring.passed);
  return {
    sortie,
    world,
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
  if (dz === 0) return;
  for (const ring of run.rings) {
    if (ring.passed) continue;
    const t = (ring.position.z - from.z) / dz;
    // Exclude the starting plane: arriving exactly on a ring counted last step.
    // Both travel directions count, but a ring can award its bonus only once.
    if (t <= 0 || t > 1) continue;
    const dx = from.x + (to.x - from.x) * t - ring.position.x;
    const dy = from.y + (to.y - from.y) * t - ring.position.y;
    if (dx * dx + dy * dy <= ring.radius * ring.radius) {
      ring.passed = true;
      run.ringsHit += 1;
    }
  }
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

  // createRings describes the original route. Translate fresh copies ahead,
  // following the river and retaining each ring's original terrain clearance.
  // Never rewrite a frozen world ring, its position, or its feature bounds.
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
  // The documented village feature has horizontal bounds. An explicit zone
  // may supply either those bounds directly or a position/radius circle.
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

    // Find the first ground contact within this small step, so a target-edge
    // hit is judged at impact rather than after the parcel has overshot it.
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
  run.score = run.ringsHit * SCORING.ringBonus
    + (run.parcel.status === 'hit' ? SCORING.cargoDeliveryBonus : 0);
}

/**
 * Track the movement made by stepPlane. Invalid/nonpositive dt and finished
 * runs are no-ops. A reported drop releases at the current (post-flight) position;
 * its fall begins on the next update, avoiding a fictitious full dt of travel.
 */
export function stepRun(run, plane, input, dt) {
  if (run.finished || !Number.isFinite(dt) || dt <= 0) return run;
  run.elapsedSeconds += dt;
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

/**
 * Freeze one score card on landing/crash (or zero hull), otherwise return null.
 * Rings are optional bonuses. Delivery requires the destination and, for sortie
 * 2, a parcel hit. Incomplete campaign landings use the failure outcome 'crashed'
 * with an explanatory reason; no extra outcome is needed by the result screen.
 * Fuel exhaustion alone does not end an airborne run: a glide can still deliver.
 * Endless flight can stop and take off again while fuel remains, without a win.
 * Scores retain full precision; screens may round them for display.
 */
export function finishRun(run, plane) {
  if (run.finished) return run.scoreCard;
  if (!plane.landed && !plane.crashed && plane.hull > 0) return null;

  const destroyed = plane.hull <= 0;
  const empty = plane.fuel <= FUEL.empty;
  const cargoReady = !run.sortie.requiresParcelDrop || run.parcel.status === 'hit';
  const atDestination = plane.groundStripId === run.world.destination.id;
  let outcome;
  let reason;
  if (destroyed) {
    outcome = 'hull destroyed';
    reason = plane.crashReason || 'No hull integrity remains.';
  } else if (plane.crashed) {
    outcome = empty ? 'out of fuel' : 'crashed';
    reason = plane.crashReason || (empty ? 'The fuel tank is empty.' : 'The aircraft crashed.');
  } else if (run.sortie.endless) {
    if (!empty) return null;
    outcome = 'out of fuel';
    reason = 'Free flight ended with an empty tank.';
  } else if (atDestination && cargoReady) {
    outcome = 'delivered';
    reason = run.sortie.requiresParcelDrop ? 'Mail and parcel delivered.' : 'Mail delivered.';
  } else if (empty) {
    outcome = 'out of fuel';
    reason = 'Fuel exhausted before the delivery was complete.';
  } else {
    outcome = 'crashed';
    reason = !atDestination
      ? 'Mail was not delivered: land at the destination airstrip.'
      : run.parcel.status === 'missed'
        ? 'The parcel missed the village drop zone.'
        : 'The parcel had not reached the village drop zone before landing.';
  }

  updateSubtotal(run, plane);
  const safeLanding = plane.landed && !plane.crashed && !destroyed;
  // Use the grade recorded at touchdown, not the now-level plane on the runway.
  const grade = safeLanding
    ? SCORING.landingGrades.find((entry) => entry.id === plane.landingGrade) : null;
  const landingBonus = safeLanding ? (grade?.bonus ?? plane.landingBonus ?? 0) : 0;
  const timeBonus = Math.max(0, run.sortie.parTimeSeconds - run.elapsedSeconds)
    * SCORING.timeBonusPerSecondRemaining;
  run.scoreCard = Object.freeze({
    outcome,
    reason,
    ringsHit: run.ringsHit,
    ringsTotal: run.ringsTotal,
    timeSeconds: run.elapsedSeconds,
    landingGrade: safeLanding ? plane.landingGrade : null,
    landingLabel: safeLanding ? (plane.landingLabel ?? grade?.label ?? null) : null,
    damageTaken: run.damageTaken,
    score: run.score + (outcome === 'delivered' ? SCORING.mailDeliveryBonus : 0)
      + landingBonus + timeBonus - run.damageTaken * SCORING.damagePenaltyPerPoint,
  });
  run.finished = true;
  return run.scoreCard;
}
