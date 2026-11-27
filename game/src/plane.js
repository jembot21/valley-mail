/**
 * Valley Mail aircraft state and deterministic flight/ground-roll simulation.
 * No rendering, DOM, timers or I/O. Imports tuning only from config.js.
 * Exports: createPlane(world), resetPlane(plane, world), and
 * stepPlane(plane, input, world, dt). Reset/step mutate and return the same plane;
 * reset also preserves its position object. Each created plane owns its state.
 *
 * position is { x, y, z } in metres; altitude mirrors position.y and agl is
 * signed terrain clearance. heading/pitch/bank use degrees, heading clockwise
 * from +z. airspeedKnots uses knots; verticalSpeed uses metres/second (+up).
 * throttle is 0..1, gearDown is boolean, fuel/hull use the configured capacities.
 * Position represents the wheel contact height when onGround, not mesh origin.
 *
 * justTookOff/justTouchedDown pulse for one positive-dt step. touchdown retains
 * the latest contact snapshot (stripId is null for terrain); landingGrade is
 * a SCORING grade id or null, with landingLabel and landingBonus alongside it.
 * groundStripId identifies the current strip; landed means stopped on a strip
 * after touchdown. crashed is terminal even if some hull remains; crashReason
 * explains it. Reset clears every result. Input axes follow input.poll(); gear
 * toggles once per step. Low power/negative throttle input applies ground brakes.
 * The caller handles pause, confirm, drop, mute and mouse, and supplies dt in
 * seconds only while playing. Nonpositive/nonfinite dt is a no-op.
 * CHASE_CAMERA defines the close, solid chase-view framing parameters.
 */
import { UNITS, FLIGHT, FUEL, DAMAGE, SCORING, WORLD } from './config.js';

/** Chase camera framing parameters for the enlarged aircraft presence. */
export const CHASE_CAMERA = Object.freeze({
  distanceMeters: 21.0,
  elevationMeters: 8.0,
  groundClearanceMeters: 4.8,
});

/** Create a fresh aircraft near the departure strip's -z end, ready to taxi. */
export function createPlane(world) {
  return resetPlane({ position: { x: 0, y: 0, z: 0 } }, world);
}

/** Restore the departure state in place; world and its frozen data stay intact. */
export function resetPlane(plane, world) {
  const strip = world.departure;
  const length = strip.bounds.maxZ - strip.bounds.minZ;
  const inset = Math.min(length * 0.1, FLIGHT.wingspanMeters * 2);
  const position = plane.position ?? { x: 0, y: 0, z: 0 };
  position.x = strip.position.x;
  position.z = strip.bounds.minZ + inset;
  position.y = world.groundHeight(position.x, position.z);

  // Bounds describe a strip along +z. A supplied strip heading can override it.
  const heading = Number.isFinite(strip.heading) ? strip.heading : 0;
  Object.assign(plane, {
    position,
    heading: ((heading % 360) + 360) % 360,
    altitude: position.y,
    agl: world.clearance(position),
    airspeedKnots: 0,
    verticalSpeed: 0,
    pitch: 0,
    bank: 0,
    throttle: FLIGHT.initialThrottle,
    gearDown: true,
    fuel: FUEL.capacity,
    hull: DAMAGE.maxHull,
    stalled: false,
    onGround: true,
    groundStripId: strip.id,
    landed: false,
    crashed: false,
    crashReason: null,
    justTookOff: false,
    justTouchedDown: false,
    touchdown: null,
    landingGrade: null,
    landingLabel: null,
    landingBonus: 0,
  });
  return plane;
}

const MAX_STEP_SECONDS = 1 / 60;
const STOP_SPEED_KNOTS = 0.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function axis(value) {
  return Number.isFinite(value) ? clamp(value, -1, 1) : 0;
}

/** The cushion fades within one wingspan vertically and just outside a strip. */
function groundEffect(world, position) {
  const height = clamp(1 - world.clearance(position) / FLIGHT.wingspanMeters, 0, 1);
  if (height === 0) return 0;
  const margin = Math.min(FLIGHT.wingspanMeters, WORLD.runwayWidthMeters / 4);
  let proximity = 0;
  for (const { bounds } of world.airstrips) {
    const dx = Math.max(bounds.minX - position.x, 0, position.x - bounds.maxX);
    const dz = Math.max(bounds.minZ - position.z, 0, position.z - bounds.maxZ);
    proximity = Math.max(proximity, clamp(1 - Math.hypot(dx, dz) / margin, 0, 1));
  }
  return height * proximity;
}

function crashPlane(plane, reason) {
  plane.crashed = true;
  plane.crashReason = reason;
  plane.landed = false;
  plane.stalled = false;
  plane.throttle = 0;
  plane.airspeedKnots = 0;
  plane.verticalSpeed = 0;
}

/** Capture impact values before the ground roll flattens the aircraft. */
function touchDown(plane, strip) {
  const maxHull = plane._maxHull ?? DAMAGE.maxHull;
  const sink = Math.max(0, -plane.verticalSpeed);
  const bank = Math.abs(plane.bank);
  const overspeed = Math.max(0, plane.airspeedKnots - DAMAGE.maxLandingSpeedKnots);
  const damage = Math.max(0, sink - DAMAGE.safeLandingSinkMetersPerSecond)
    * DAMAGE.hardLandingDamagePerExcessMeterPerSecond
    + overspeed * DAMAGE.landingOverspeedDamagePerKnot
    + Math.max(0, bank - DAMAGE.unsafeLandingBankDegrees)
    * DAMAGE.unsafeLandingBankDamagePerDegree
    + (plane.gearDown ? 0 : DAMAGE.gearUpLandingDamage)
    + (strip ? 0 : plane.airspeedKnots * DAMAGE.terrainImpactPerKnot);

  plane.touchdown = {
    stripId: strip?.id ?? null,
    position: { ...plane.position },
    heading: plane.heading,
    pitch: plane.pitch,
    bank: plane.bank,
    airspeedKnots: plane.airspeedKnots,
    verticalSpeed: plane.verticalSpeed,
    sinkMetersPerSecond: sink,
    gearDown: plane.gearDown,
    damage,
  };
  plane.justTouchedDown = true;
  plane.onGround = true;
  plane.groundStripId = strip?.id ?? null;
  plane.hull = clamp(plane.hull - damage, 0, maxHull);
  plane.landingGrade = null;
  plane.landingLabel = null;
  plane.landingBonus = 0;

  if (!strip) {
    crashPlane(plane, 'terrain impact');
  } else if (sink >= DAMAGE.crashSinkMetersPerSecond) {
    crashPlane(plane, 'excessive landing sink');
  } else if (plane.hull === 0) {
    crashPlane(plane, 'landing damage');
  } else {
    // A smooth belly landing or overspeed arrival must not earn a butter bonus.
    const grade = plane.gearDown && overspeed === 0
      ? SCORING.landingGrades.find((entry) => sink <= entry.maxSinkMetersPerSecond
        && bank <= entry.maxBankDegrees)
      : SCORING.landingGrades.find((entry) => entry.id === 'rough');
    plane.landingGrade = grade?.id ?? null;
    plane.landingLabel = grade?.label ?? null;
    plane.landingBonus = grade?.bonus ?? 0;
    plane.landed = plane.airspeedKnots <= STOP_SPEED_KNOTS;
    plane.verticalSpeed = 0;
    plane.pitch = 0;
    plane.bank = 0;
    plane.stalled = false;
  }
}

function advancePlane(plane, controls, world, dt) {
  const strip = world.airstripAt(plane.position.x, plane.position.z);
  const fuelCapacity = plane._fuelCapacity ?? FUEL.capacity;
  const maxHull = plane._maxHull ?? DAMAGE.maxHull;
  const stallSpeed = plane._stallSpeedKnots ?? FLIGHT.stallSpeedKnots;
  const maxSpeed = plane._maxSpeedKnots ?? FLIGHT.maxSpeedKnots;
  const acceleration = plane._accelerationKnots ?? FLIGHT.accelerationKnotsPerSecond;
  const maxClimb = plane._maxClimbRate ?? FLIGHT.maxClimbMetersPerSecond;

  plane.throttle = plane.fuel > FUEL.empty
    ? clamp(plane.throttle + controls.throttle * FLIGHT.throttleResponsePerSecond * dt, 0, 1)
    : 0;
  const burn = FUEL.idleBurnPerSecond
    + (FUEL.fullThrottleBurnPerSecond - FUEL.idleBurnPerSecond)
    * plane.throttle ** FUEL.throttleBurnExponent;
  plane.fuel = clamp(plane.fuel - burn * dt, FUEL.empty, fuelCapacity);
  if (plane.fuel === FUEL.empty) plane.throttle = 0;

  plane.pitch = clamp(plane.pitch + controls.pitch * FLIGHT.pitchRateDegreesPerSecond * dt,
    -FLIGHT.maxPitchDownDegrees, FLIGHT.maxPitchUpDegrees);
  if (plane.onGround) {
    plane.bank = 0;
  } else if (controls.bank !== 0) {
    plane.bank = clamp(plane.bank + controls.bank * FLIGHT.bankRateDegreesPerSecond * dt,
      -FLIGHT.maxBankDegrees, FLIGHT.maxBankDegrees);
  } else {
    plane.bank *= Math.exp(-FLIGHT.bankReturnRatePerSecond * dt);
  }

  const speedRatio = plane.airspeedKnots / FLIGHT.cruiseSpeedKnots;
  const bankRatio = plane.bank / FLIGHT.turnReferenceBankDegrees;
  const drag = (FLIGHT.dragKnotsPerSecond
    + (plane.gearDown ? FLIGHT.gearDragKnotsPerSecond : 0)) * speedRatio ** 2;
  const turnDrag = FLIGHT.dragKnotsPerSecond * bankRatio ** 2 * speedRatio ** 2;
  const climbDrag = plane.onGround ? 0
    : Math.max(0, plane.verticalSpeed) * FLIGHT.climbSpeedLossKnotsPerMeter;
  const braking = plane.onGround
    && (controls.throttle < 0 || plane.throttle < FLIGHT.initialThrottle / 2);
  // Pulling power back also brakes; suppress thrust so it reliably slows a roll.
  const thrust = plane.onGround && controls.throttle < 0 ? 0
    : plane.throttle * acceleration;
  plane.airspeedKnots = clamp(plane.airspeedKnots
    + (thrust - drag - turnDrag - climbDrag
      - (braking ? FLIGHT.groundBrakeKnotsPerSecond : 0)) * dt,
  0, maxSpeed);

  const bankRadians = plane.bank * UNITS.degreesToRadians;
  // Coordinated turns tighten at low speed; the stall threshold bounds the rate.
  const turnRate = plane.onGround
    ? controls.bank * FLIGHT.turnRateDegreesPerSecond * Math.min(1, speedRatio)
    : FLIGHT.turnRateDegreesPerSecond * Math.tan(bankRadians)
      / Math.tan(FLIGHT.turnReferenceBankDegrees * UNITS.degreesToRadians)
      * FLIGHT.cruiseSpeedKnots / Math.max(plane.airspeedKnots, stallSpeed);
  plane.heading = ((plane.heading + turnRate * dt) % 360 + 360) % 360;

  plane.stalled = !plane.onGround && plane.airspeedKnots < stallSpeed;
  if (plane.stalled) {
    plane.pitch = clamp(plane.pitch - FLIGHT.stallNoseDropDegreesPerSecond * dt,
      -FLIGHT.maxPitchDownDegrees, FLIGHT.maxPitchUpDegrees);
  }
  const metersPerSecond = plane.airspeedKnots * UNITS.knotsToMetersPerSecond;
  let targetClimb = clamp(metersPerSecond * Math.sin(plane.pitch * UNITS.degreesToRadians)
    * Math.cos(bankRadians), -FLIGHT.maxDescentMetersPerSecond, maxClimb);
  if (plane.stalled) {
    const severity = 1 - plane.airspeedKnots / stallSpeed;
    targetClimb = Math.min(targetClimb, -FLIGHT.stallSinkMetersPerSecond * (0.25 + 0.75 * severity));
  }
  if (targetClimb < 0) targetClimb *= 1 - 0.15 * groundEffect(world, plane.position);

  if (plane.onGround && strip && plane.airspeedKnots >= FLIGHT.takeoffSpeedKnots
    && plane.pitch > 0 && targetClimb > 0) {
    plane.onGround = false;
    plane.groundStripId = null;
    plane.landed = false;
    plane.justTookOff = true;
  }
  // Smooth vertical acceleration gives stalls growing sink and lets a flare work.
  plane.verticalSpeed = plane.onGround ? 0
    : plane.verticalSpeed + (targetClimb - plane.verticalSpeed) * (1 - Math.exp(-4 * dt));

  const headingRadians = plane.heading * UNITS.degreesToRadians;
  const distance = metersPerSecond * dt
    * (plane.onGround ? 1 : Math.cos(plane.pitch * UNITS.degreesToRadians));
  plane.position.x += Math.sin(headingRadians) * distance;
  plane.position.z += Math.cos(headingRadians) * distance;
  plane.position.y += plane.verticalSpeed * dt;

  const ground = world.groundHeight(plane.position.x, plane.position.z);
  const groundStrip = world.airstripAt(plane.position.x, plane.position.z);
  if (plane.onGround) {
    plane.position.y = ground;
    plane.groundStripId = groundStrip?.id ?? null;
    plane.landed = Boolean(groundStrip && plane.touchdown?.stripId === groundStrip.id
      && plane.airspeedKnots <= STOP_SPEED_KNOTS);
    if (!groundStrip && plane.airspeedKnots >= FLIGHT.takeoffSpeedKnots) {
      plane.hull = clamp(plane.hull - plane.airspeedKnots * DAMAGE.terrainImpactPerKnot,
        0, maxHull);
      crashPlane(plane, 'terrain impact');
    }
  } else if (world.clearance(plane.position) <= 0) {
    plane.position.y = ground;
    touchDown(plane, groundStrip);
  }

  plane.altitude = plane.position.y;
  plane.agl = world.clearance(plane.position);
  // The low wing/contact envelope scrapes terrain, but strips are safe to roll on.
  const scrapeHeight = FLIGHT.wingspanMeters / 10;
  if (!plane.crashed && !groundStrip && plane.agl < scrapeHeight) {
    const scrapeMult = plane._scrapeDamageMult ?? 1.0;
    plane.hull = clamp(plane.hull - DAMAGE.terrainScrapePerSecond * dt
      * clamp(1 - plane.agl / scrapeHeight, 0, 1) * scrapeMult, 0, maxHull);
    if (plane.hull === 0) crashPlane(plane, 'terrain scrape');
  }
}

/** Advance flight in seconds; edge inputs and event pulses belong to this call. */
export function stepPlane(plane, input, world, dt) {
  if (!Number.isFinite(dt) || dt <= 0) return plane;
  plane.justTookOff = false;
  plane.justTouchedDown = false;
  if (plane.crashed) return plane;

  const controls = {
    pitch: axis(input?.pitch),
    bank: axis(input?.bank),
    throttle: axis(input?.throttle),
  };
  if (input?.gear) plane.gearDown = !plane.gearDown;

  // Consume the whole dt without skipping strip edges or fast terrain contacts.
  const steps = Math.ceil(dt / MAX_STEP_SECONDS);
  const stepDt = dt / steps;
  for (let i = 0; i < steps && !plane.crashed; i += 1) {
    advancePlane(plane, controls, world, stepDt);
  }
  return plane;
}
