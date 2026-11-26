/**
 * Stage Valley Mail's four deterministic screenshot scenes using the game renderer.
 * Exports: stageShot(canvas, ctx?) -> boolean. Call before starting the game loop;
 * ctx is an optional 2D context belonging to canvas. Recognised shots reset the
 * canvas to CANVAS's 1280x720 design size, draw once, then set window.__shotReady.
 * Unknown/missing ?shot= values return false without touching canvas or readiness.
 * Positions come from seeded sortie geometry and fixed offsets; no flight steps,
 * random choices, clocks or timers are used here.
 */
import { CANVAS, SHOT_NAMES, readShotName } from './config.js';
import { createPlane } from './plane.js';
import { SORTIES, createSortieWorld, createRun } from './missions.js';
import { draw } from './render.js';
import { drawHUD } from './hud.js';

/** Heading clockwise from +z, with a small offset for a visible turn into a ring. */
function headingTo(position, target, offset = 0) {
  const degrees = Math.atan2(target.x - position.x, target.z - position.z) * 180 / Math.PI;
  return ((degrees + offset) % 360 + 360) % 360;
}

function setFlight(plane, world, state) {
  Object.assign(plane, {
    onGround: false,
    groundStripId: null,
    stalled: false,
    landed: false,
    crashed: false,
    justTookOff: false,
    justTouchedDown: false,
    gearDown: false,
    hull: 100,
    verticalSpeed: 0,
    ...state,
  });
  // These readouts normally come from stepPlane; a still scene must set them too.
  plane.altitude = plane.position.y;
  plane.agl = world.clearance(plane.position);
}

function composeCover(world, plane) {
  const target = world.rings[3];
  const z = target.position.z - 320;
  const position = {
    x: world.riverCenter(z),
    y: target.position.y + 20,
    z,
  };
  setFlight(plane, world, {
    position,
    heading: headingTo(position, target.position, 18),
    pitch: 2,
    bank: -8,
    airspeedKnots: 90,
    throttle: 0.72,
    fuel: 78,
  });
  return { passedRings: 3, elapsedSeconds: 58, message: null };
}

function composeRing(world, plane) {
  const ring = world.rings[0];
  setFlight(plane, world, {
    // The upper half of the opening keeps the crossed hoop in the chase view.
    position: { ...ring.position, y: ring.position.y + 12 },
    heading: ring.heading,
    pitch: 1,
    bank: 4,
    airspeedKnots: 92,
    throttle: 0.74,
    fuel: 84,
  });
  return { passedRings: 1, elapsedSeconds: 24, message: 'RING +100' };
}

function composeApproach(world, plane) {
  const strip = world.destination;
  const x = strip.position.x;
  const z = strip.bounds.minZ - 8;
  setFlight(plane, world, {
    // Close to the threshold, the runway widens across the lower chase view.
    position: { x, y: world.groundHeight(x, z) + 8, z },
    heading: strip.heading,
    pitch: 2,
    bank: 0,
    airspeedKnots: 49,
    verticalSpeed: -1.2,
    throttle: 0.28,
    gearDown: true,
    fuel: 56,
  });
  return { passedRings: world.rings.length, elapsedSeconds: 96, message: 'GEAR DOWN' };
}

function composeDusk(world, plane) {
  const target = world.rings[4];
  const z = target.position.z - 280;
  const position = {
    x: world.riverCenter(z),
    y: target.position.y + 16,
    z,
  };
  setFlight(plane, world, {
    position,
    heading: headingTo(position, target.position, -4),
    pitch: 1,
    bank: 6,
    airspeedKnots: 86,
    throttle: 0.68,
    fuel: 48,
  });
  return { passedRings: 4, elapsedSeconds: 82, message: null };
}

const SCENES = {
  cover: { sortie: SORTIES[0], compose: composeCover },
  ring: { sortie: SORTIES[0], compose: composeRing },
  approach: { sortie: SORTIES[0], compose: composeApproach },
  dusk: { sortie: SORTIES[2], compose: composeDusk },
};

export function stageShot(canvas, ctx) {
  const name = readShotName();
  if (!SHOT_NAMES.includes(name)) return false;
  const scene = SCENES[name];
  if (!scene) return false;

  const world = createSortieWorld(scene.sortie);
  const plane = createPlane(world);
  const { passedRings, elapsedSeconds, message } = scene.compose(world, plane);

  // Mark crossings before createRun so counts, score, nextRing and its position
  // snapshot all describe this moment rather than the departure state.
  world.rings.forEach((ring, index) => { ring.passed = index < passedRings; });
  const run = createRun(scene.sortie, world, world.rings, plane);
  run.elapsedSeconds = elapsedSeconds;

  // Resetting the backing store also removes any transform or old drawing state.
  canvas.width = CANVAS.width;
  canvas.height = CANVAS.height;
  const context = ctx ?? canvas.getContext('2d');
  if (!context) throw new Error('Valley Mail screenshots require a 2D canvas context.');
  draw(context, world, plane, run);
  drawHUD(context, plane, run, world.palette, message);
  window.__shotReady = true;
  return true;
}
