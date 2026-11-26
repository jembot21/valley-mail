/**
 * Valley Mail's seeded valley data and pure geometry; no canvas, DOM or I/O.
 * Exports: createWorld({ seed?, ringCount?, palette? }?) and
 * createRings(world, count = world.ringCount), which returns fresh, unpassed rings.
 *
 * Coordinates are metres: +x right, +y up, +z down the valley. Headings are
 * degrees clockwise from +z; positions are { x, y, z }. z measures longitudinal
 * progress, not river arc length. Dimensions/colours come from config.js;
 * layout fractions below divide those dimensions into banks, plots and houses.
 *
 * World data: seed, paletteName, palette, ringCount, route, sceneryExtent,
 * departure, destination, airstrips, village, villages, fields, treeClusters,
 * trees, houses and rings. All features have id, type, position and horizontal
 * bounds { minX, maxX, minZ, maxZ }. Static data is frozen. Only ring.passed
 * is writable; query results retain the same ring references as world.rings.
 *
 * Queries: riverCenter(z) -> x; riverHeading(z) -> degrees;
 * distanceToRiver(x, z) -> absolute lateral distance at that z (not arc distance);
 * groundHeight(x, z) -> surface altitude; clearance({ x, y, z }) -> signed AGL;
 * airstripAt(x, z) -> strip or null; featuresInWindow(fromZ, toZ) and
 * featuresAhead(z, distance = WORLD.viewDistanceMeters) -> grouped feature arrays.
 * Window endpoints are inclusive and test feature bounds, including passed rings.
 * River/terrain queries work at every finite position. Scenery covers the route
 * plus one configured view distance at each end; windows outside it may be empty.
 * Ground includes the river's water surface at y=0; trees/houses are separate
 * geometry, not hidden additions to groundHeight or clearance.
 */
import { WORLD, PALETTES, FLIGHT, UNITS } from './config.js';

const TAU = Math.PI * 2;
const HALF_RIVER = WORLD.riverWidthMeters / 2;
const HALF_VALLEY = WORLD.valleyWidthMeters / 2;
const CRUISE_METERS_PER_SECOND = FLIGHT.cruiseSpeedKnots * UNITS.knotsToMetersPerSecond;
// Leave at least the distance needed to climb/descend at the configured rates.
const LAUNCH_DISTANCE = Math.max(WORLD.runwayLengthMeters,
  WORLD.ringHeightMeters / FLIGHT.maxClimbMetersPerSecond * CRUISE_METERS_PER_SECOND);
const APPROACH_DISTANCE = Math.max(WORLD.runwayLengthMeters * 2,
  WORLD.ringHeightMeters / FLIGHT.maxDescentMetersPerSecond * CRUISE_METERS_PER_SECOND);
const FIRST_RING_Z = WORLD.runwayLengthMeters + LAUNCH_DISTANCE;
const DEFAULT_RING_COUNT = Math.max(1, 1 + Math.floor(
  (WORLD.viewDistanceMeters - FIRST_RING_Z - APPROACH_DISTANCE - WORLD.runwayLengthMeters) /
  WORLD.ringSpacingMeters));

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const smoothstep = (value) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

function requireFinite(value, name) {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite.`);
}

function requireCount(count) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError('ringCount must be a non-negative safe integer.');
  }
}

// Mulberry32: the uint32 wrap and mixing constants are PRNG mechanics, not tuning.
// A zero seed is valid; separate streams keep colour choices out of river geometry.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function freezeData(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

function rectangleBounds(x, z, width, length) {
  return { minX: x - width / 2, maxX: x + width / 2,
    minZ: z - length / 2, maxZ: z + length / 2 };
}

function intersects(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

function corners(bounds, groundHeight) {
  return [[bounds.minX, bounds.minZ], [bounds.maxX, bounds.minZ],
    [bounds.maxX, bounds.maxZ], [bounds.minX, bounds.maxZ]].map(([x, z]) =>
    ({ x, y: groundHeight(x, z), z }));
}

// Exact extrema of one sine over an interval. Summing each wave's bounds is
// conservative: an entire rectangular plot stays on its bank, not just its corners.
function sineRange(from, to) {
  if (to - from >= TAU) return [-1, 1];
  let low = Math.min(Math.sin(from), Math.sin(to));
  let high = Math.max(Math.sin(from), Math.sin(to));
  if (Math.ceil((from - Math.PI / 2) / TAU) <= Math.floor((to - Math.PI / 2) / TAU)) high = 1;
  if (Math.ceil((from + Math.PI / 2) / TAU) <= Math.floor((to + Math.PI / 2) / TAU)) low = -1;
  return [low, high];
}

/**
 * Build an independent sortie. seed is an integer normalised to uint32; palette
 * is a PALETTES key (default 'day'). ringCount defaults to a route fitting roughly
 * one view distance, and may be zero. Increasing it extends the flight corridor
 * by WORLD.ringSpacingMeters per extra ring, keeping takeoff/approach space.
 */
export function createWorld({ seed = WORLD.seed, ringCount = DEFAULT_RING_COUNT, palette = 'day' } = {}) {
  if (!Number.isSafeInteger(seed)) throw new TypeError('seed must be a safe integer.');
  requireCount(ringCount);
  if (!Object.hasOwn(PALETTES, palette)) throw new RangeError(`Unknown palette: ${palette}`);
  seed >>>= 0;
  const colours = PALETTES[palette];
  const random = seededRandom(seed);
  const waves = [
    { phase: random() * TAU, frequency: TAU / WORLD.riverWindingLengthMeters,
      amplitude: WORLD.riverWindingAmplitudeMeters * 2 / 3 },
    { phase: random() * TAU, frequency: TAU / (WORLD.riverWindingLengthMeters * 2),
      amplitude: WORLD.riverWindingAmplitudeMeters / 3 },
  ];
  const rawRiver = (z) => waves.reduce((x, wave) =>
    x + Math.sin(z * wave.frequency + wave.phase) * wave.amplitude, 0);
  const lastRingZ = FIRST_RING_Z + Math.max(0, ringCount - 1) * WORLD.ringSpacingMeters;
  const destinationStartZ = lastRingZ + APPROACH_DISTANCE;
  const route = freezeData({ startZ: 0, firstRingZ: FIRST_RING_Z, lastRingZ,
    approachStartZ: lastRingZ, endZ: destinationStartZ + WORLD.runwayLengthMeters });
  const stripZones = [WORLD.runwayLengthMeters / 2,
    destinationStartZ + WORLD.runwayLengthMeters / 2].map((z) =>
    ({ z, x: rawRiver(z), halfLength: WORLD.runwayLengthMeters / 2 }));

  function riverCenter(z) {
    requireFinite(z, 'z');
    const raw = rawRiver(z);
    // A straight river beside each strip guarantees flat, dry runway corners.
    // Smoothstep also makes the join's first derivative continuous.
    for (const zone of stripZones) {
      const beyondStrip = Math.abs(z - zone.z) - zone.halfLength;
      if (beyondStrip < WORLD.runwayLengthMeters) {
        return zone.x + (raw - zone.x) * smoothstep(beyondStrip / WORLD.runwayLengthMeters);
      }
    }
    return raw;
  }

  function riverRange(fromZ, toZ) {
    let low = 0;
    let high = 0;
    for (const wave of waves) {
      const range = sineRange(fromZ * wave.frequency + wave.phase, toZ * wave.frequency + wave.phase);
      low += range[0] * wave.amplitude;
      high += range[1] * wave.amplitude;
    }
    for (const zone of stripZones) {
      if (fromZ >= zone.z - zone.halfLength && toZ <= zone.z + zone.halfLength) {
        return [zone.x, zone.x];
      }
      const reach = zone.halfLength + WORLD.runwayLengthMeters;
      if (fromZ <= zone.z + reach && toZ >= zone.z - reach) {
        low = Math.min(low, zone.x);
        high = Math.max(high, zone.x);
      }
    }
    return [low, high];
  }

  function riverHeading(z) {
    const step = WORLD.terrainSegmentLengthMeters / 2;
    requireFinite(z, 'z');
    return Math.atan2(riverCenter(z + step) - riverCenter(z - step), step * 2) /
      UNITS.degreesToRadians;
  }

  function distanceToRiver(x, z) {
    requireFinite(x, 'x');
    return Math.abs(x - riverCenter(z));
  }

  function groundHeight(x, z) {
    const rise = (distanceToRiver(x, z) - HALF_VALLEY) / HALF_VALLEY;
    return WORLD.ridgeHeightMeters * smoothstep(rise);
  }

  function clearance({ x, y, z }) {
    requireFinite(y, 'y');
    return y - groundHeight(x, z);
  }

  function bankInterval(fromZ, toZ, bank) {
    const [low, high] = riverRange(fromZ, toZ);
    return bank < 0 ? [high - HALF_VALLEY, low - HALF_RIVER] :
      [high + HALF_RIVER, low + HALF_VALLEY];
  }

  const airstrips = stripZones.map((zone, index) => {
    const bank = index === 0 ? -1 : 1;
    const position = { x: zone.x + bank * (HALF_RIVER + HALF_VALLEY) / 2, y: 0, z: zone.z };
    const bounds = rectangleBounds(position.x, position.z,
      WORLD.runwayWidthMeters, WORLD.runwayLengthMeters);
    return freezeData({ id: index === 0 ? 'departure' : 'destination', type: 'airstrip', bank,
      position, heading: 0, length: WORLD.runwayLengthMeters, width: WORLD.runwayWidthMeters,
      start: { ...position, z: bounds.minZ }, end: { ...position, z: bounds.maxZ },
      bounds, corners: corners(bounds, groundHeight), colour: colours.runway,
      markingsColour: colours.runwayMarkings });
  });
  // Reserve a wingspan beside the strip, and a runway length at either end.
  // Dressing cannot obstruct the initial roll or the final low approach.
  const clearings = airstrips.map(({ bounds }) => ({
    minX: bounds.minX - FLIGHT.wingspanMeters, maxX: bounds.maxX + FLIGHT.wingspanMeters,
    minZ: bounds.minZ - WORLD.runwayLengthMeters, maxZ: bounds.maxZ + WORLD.runwayLengthMeters,
  }));
  const overlapsClearing = (bounds) => clearings.some((clearing) => intersects(bounds, clearing));

  function airstripAt(x, z) {
    requireFinite(x, 'x');
    requireFinite(z, 'z');
    return airstrips.find(({ bounds }) => x >= bounds.minX && x <= bounds.maxX &&
      z >= bounds.minZ && z <= bounds.maxZ) ?? null;
  }

  const fields = [];
  const trees = [];
  const treeClusters = [];
  const houses = [];
  const villages = [];
  const villageRandom = seededRandom(seed ^ 0xa511e9b3);
  const villageZ = Math.max(FIRST_RING_Z + WORLD.fieldPatchLengthMeters,
    (FIRST_RING_Z + lastRingZ) / 2);
  const villageLength = WORLD.fieldPatchLengthMeters;
  const villageBank = villageRandom() < 1 / 2 ? -1 : 1;
  const [villageLeft, villageRight] = bankInterval(villageZ - villageLength / 2,
    villageZ + villageLength / 2, villageBank);
  const villageWidth = Math.min(WORLD.fieldPatchLengthMeters, villageRight - villageLeft);
  const villageX = (villageLeft + villageRight) / 2;
  const villageBounds = rectangleBounds(villageX, villageZ, villageWidth, villageLength);
  const houseColumns = Math.max(1, Math.floor(villageWidth / (FLIGHT.wingspanMeters * 3)));
  const houseRows = Math.max(1, Math.floor(villageLength / (FLIGHT.wingspanMeters * 3)));
  for (let row = 0; row < houseRows; row++) {
    for (let column = 0; column < houseColumns; column++) {
      const x = villageBounds.minX + (column + 1 / 2) * villageWidth / houseColumns;
      const z = villageBounds.minZ + (row + 1 / 2) * villageLength / houseRows;
      const width = FLIGHT.wingspanMeters * (3 / 4 + villageRandom() / 2);
      const length = FLIGHT.wingspanMeters * (1 + villageRandom() / 2);
      const bounds = rectangleBounds(x, z, width, length);
      if (overlapsClearing(bounds)) continue;
      houses.push(freezeData({ id: `village-house-${row}-${column}`, type: 'house', villageId: 'village',
        position: { x, y: groundHeight(x, z), z }, heading: 0, width, length,
        height: FLIGHT.wingspanMeters * (1 / 2 + villageRandom() / 4),
        roofHeight: FLIGHT.wingspanMeters / 4, bounds, corners: corners(bounds, groundHeight),
        wallColour: colours.runwayMarkings, roofColour: colours.aircraftTrim }));
    }
  }
  villages.push(freezeData({ id: 'village', type: 'village', bank: villageBank,
    position: { x: villageX, y: groundHeight(villageX, villageZ), z: villageZ },
    width: villageWidth, length: villageLength, bounds: villageBounds, houses: [...houses] }));

  const patchLength = WORLD.fieldPatchLengthMeters;
  const firstRow = Math.floor((route.startZ - WORLD.viewDistanceMeters) / patchLength);
  const lastRow = Math.ceil((route.endZ + WORLD.viewDistanceMeters) / patchLength);
  const sceneryExtent = freezeData({ minZ: firstRow * patchLength, maxZ: lastRow * patchLength });
  for (let row = firstRow; row < lastRow; row++) {
    // Row-local streams make generation independent of visibility/query order.
    const fieldRandom = seededRandom(seed ^ Math.imul(row, 0x9e3779b9));
    const treeRandom = seededRandom(seed ^ Math.imul(row, 0x85ebca6b) ^ 0xc2b2ae35);
    const fromZ = row * patchLength;
    const toZ = fromZ + patchLength;
    for (const bank of [-1, 1]) {
      const [left, right] = bankInterval(fromZ, toZ, bank);
      if (right <= left) continue;
      const columns = Math.ceil((right - left) / patchLength);
      // Random weights make unequal rectangular plots without overlaps or gaps.
      const weights = Array.from({ length: columns }, () => 1 + fieldRandom());
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let edge = left;
      for (let column = 0; column < columns; column++) {
        const width = (right - left) * weights[column] / total;
        const x = edge + width / 2;
        const z = (fromZ + toZ) / 2;
        const bounds = rectangleBounds(x, z, width, patchLength);
        const colourIndex = Math.floor(fieldRandom() * colours.fields.length);
        const id = `field-${row}-${bank}-${column}`;
        edge += width;
        if (overlapsClearing(bounds) || intersects(bounds, villageBounds)) continue;
        fields.push(freezeData({ id, type: 'field', bank, position: { x, y: groundHeight(x, z), z },
          heading: 0, width, length: patchLength, bounds, corners: corners(bounds, groundHeight),
          colourIndex, colour: colours.fields[colourIndex] }));
        if (treeRandom() >= 1 / 2) continue;
        const radius = Math.min(width, patchLength) / 4;
        const clusterX = bank < 0 ? bounds.minX + radius : bounds.maxX - radius;
        const clusterZ = fromZ + radius + treeRandom() * (patchLength - radius * 2);
        const clusterTrees = [];
        const count = 3 + Math.floor(treeRandom() * colours.fields.length);
        for (let index = 0; index < count; index++) {
          const crownRadius = Math.min(FLIGHT.wingspanMeters / 3, radius / 2);
          const angle = treeRandom() * TAU;
          // sqrt distributes trunks uniformly by area; crowns stay inside the plot.
          const offset = Math.sqrt(treeRandom()) * (radius - crownRadius);
          const treeX = clusterX + Math.cos(angle) * offset;
          const treeZ = clusterZ + Math.sin(angle) * offset;
          const tree = freezeData({ id: `${id}-tree-${index}`, type: 'tree', clusterId: `${id}-trees`,
            position: { x: treeX, y: groundHeight(treeX, treeZ), z: treeZ },
            height: FLIGHT.wingspanMeters * (1 + treeRandom()), crownRadius,
            bounds: rectangleBounds(treeX, treeZ, crownRadius * 2, crownRadius * 2),
            colour: colours.fields[0] });
          clusterTrees.push(tree);
          trees.push(tree);
        }
        treeClusters.push(freezeData({ id: `${id}-trees`, type: 'treeCluster', bank,
          position: { x: clusterX, y: groundHeight(clusterX, clusterZ), z: clusterZ }, radius,
          bounds: rectangleBounds(clusterX, clusterZ, radius * 2, radius * 2), trees: clusterTrees }));
      }
    }
  }

  const world = { seed, paletteName: palette, palette: colours, ringCount, route, sceneryExtent,
    departure: airstrips[0], destination: airstrips[1], airstrips,
    village: villages[0], villages, fields, trees, treeClusters, houses, rings: [],
    riverCenter, riverHeading, distanceToRiver, groundHeight, clearance, airstripAt,
    featuresInWindow, featuresAhead };
  world.rings = Object.freeze(createRings(world));
  for (const list of [airstrips, villages, fields, trees, treeClusters, houses]) {
    list.sort((a, b) => a.bounds.minZ - b.bounds.minZ || a.bounds.minX - b.bounds.minX);
    Object.freeze(list);
  }

  function featuresInWindow(fromZ, toZ) {
    requireFinite(fromZ, 'fromZ');
    requireFinite(toZ, 'toZ');
    if (toZ < fromZ) throw new RangeError('toZ must be at least fromZ.');
    const visible = (list) => list.filter(({ bounds }) => bounds.minZ <= toZ && bounds.maxZ >= fromZ);
    return { fields: visible(fields), trees: visible(trees), treeClusters: visible(treeClusters),
      houses: visible(houses), villages: visible(villages), airstrips: visible(airstrips),
      rings: visible(world.rings) };
  }

  function featuresAhead(z, distance = WORLD.viewDistanceMeters) {
    requireFinite(distance, 'distance');
    if (distance < 0) throw new RangeError('distance must be non-negative.');
    return featuresInWindow(z, z + distance);
  }

  return Object.freeze(world);
}

/**
 * Place count rings evenly within world.route's ring corridor. The world's own
 * count uses configured spacing; other counts reuse its endpoints (one ring uses
 * the midpoint, zero returns []). Each ring faces the river's local heading.
 * position.y is groundHeight + WORLD.ringHeightMeters; radius is configured.
 * normal is a unit { x, y, z } pointing downstream, for swept crossing tests.
 * This never changes world.rings or an existing ring's passed flag.
 */
export function createRings(world, count = world.ringCount) {
  requireCount(count);
  return Array.from({ length: count }, (_, index) => {
    const t = count === 1 ? 1 / 2 : index / (count - 1);
    const z = world.route.firstRingZ + (world.route.lastRingZ - world.route.firstRingZ) * t;
    const x = world.riverCenter(z);
    const heading = world.riverHeading(z);
    const angle = heading * UNITS.degreesToRadians;
    const radius = WORLD.ringRadiusMeters;
    const position = freezeData({ x, y: world.groundHeight(x, z) + WORLD.ringHeightMeters, z });
    const normal = freezeData({ x: Math.sin(angle), y: 0, z: Math.cos(angle) });
    const bounds = freezeData(rectangleBounds(x, z,
      radius * 2 * Math.abs(Math.cos(angle)), radius * 2 * Math.abs(Math.sin(angle))));
    const ring = {};
    for (const [key, value] of Object.entries({ id: `ring-${index}`, type: 'ring', index,
      position, radius, heading, normal, bounds })) {
      Object.defineProperty(ring, key, { value, enumerable: true });
    }
    Object.defineProperty(ring, 'passed', { value: false, writable: true, enumerable: true });
    return Object.preventExtensions(ring);
  });
}
