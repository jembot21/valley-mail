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
  const villageZ = Math.max(FIRST_RING_Z + WORLD.fieldPatchLengthMeters,
    Math.round(((FIRST_RING_Z + lastRingZ) / 2) / WORLD.fieldPatchLengthMeters) * WORLD.fieldPatchLengthMeters);
  const villageBank = 1;
  const villageLength = 240;
  const villageWidth = 120;
  const villageX = -40;
  const villageBounds = rectangleBounds(villageX, villageZ, villageWidth, villageLength);

  // Village layout: 14 houses along main street, 1 church near riverbank, 1 water tower.
  const wallColours = ['#f5f0db', '#faf9f5', '#f6ecc2', '#fdfbf2', '#f5edd0', '#f9f6e8', '#f6ebc4'];
  const roofColours = ['#c25a3f', '#556270', '#9a4235', '#b64d32', '#4b5563', '#883025', '#be543a'];

  // Church near the riverbank on the west side of the village
  const churchX = -68;
  const churchZ = villageZ - 40;
  const churchNaveBounds = rectangleBounds(churchX, churchZ + 6, 10, 18);
  houses.push(freezeData({
    id: 'village-church', type: 'church', villageId: 'village',
    position: { x: churchX, y: groundHeight(churchX, churchZ + 6), z: churchZ + 6 },
    heading: 0, width: 10, length: 18, height: 8.5, roofHeight: 4.5,
    towerWidth: 6, towerLength: 6, towerHeight: 22, spireHeight: 10,
    bounds: rectangleBounds(churchX, churchZ, 12, 26),
    corners: corners(churchNaveBounds, groundHeight),
    wallColour: '#fdfefe', roofColour: '#4a5563', spireColour: '#282e38',
  }));

  // Small water tower on village edge
  const wtX = -18;
  const wtZ = villageZ + 95;
  const wtBounds = rectangleBounds(wtX, wtZ, 6, 6);
  houses.push(freezeData({
    id: 'village-water-tower', type: 'waterTower', villageId: 'village',
    position: { x: wtX, y: groundHeight(wtX, wtZ), z: wtZ },
    heading: 0, width: 5.5, length: 5.5, height: 12.5, roofHeight: 2.5,
    tankRadius: 2.5, tankHeight: 4, stiltsHeight: 8,
    bounds: wtBounds, corners: corners(wtBounds, groundHeight),
    wallColour: '#746252', roofColour: '#505a63',
  }));

  // Fourteen houses: 7 west of main street (facing east), 7 east of main street (facing west)
  const westHouseZ = [-88, -66, -12, 12, 36, 60, 84];
  const eastHouseZ = [-86, -62, -36, -8, 18, 44, 72];
  for (let i = 0; i < 7; i++) {
    const x = -58;
    const z = villageZ + westHouseZ[i];
    const width = 9.5 + (i % 3) * 0.8;
    const length = 13 + ((i * 2) % 3) * 1.1;
    const height = 6.2 + (i % 2) * 0.8;
    const roofHeight = 2.8 + (i % 3) * 0.3;
    const bounds = rectangleBounds(x, z, width, length);
    houses.push(freezeData({
      id: `village-house-w-${i}`, type: 'house', villageId: 'village',
      position: { x, y: groundHeight(x, z), z }, heading: 90, width, length,
      height, roofHeight, bounds, corners: corners(bounds, groundHeight),
      wallColour: wallColours[i % wallColours.length],
      roofColour: roofColours[i % roofColours.length],
    }));
  }
  for (let i = 0; i < 7; i++) {
    const x = -22;
    const z = villageZ + eastHouseZ[i];
    const width = 9.8 + ((i + 1) % 3) * 0.7;
    const length = 13.2 + ((i + 2) % 3) * 0.9;
    const height = 6.4 + ((i + 1) % 2) * 0.7;
    const roofHeight = 2.9 + ((i + 1) % 3) * 0.3;
    const bounds = rectangleBounds(x, z, width, length);
    houses.push(freezeData({
      id: `village-house-e-${i}`, type: 'house', villageId: 'village',
      position: { x, y: groundHeight(x, z), z }, heading: -90, width, length,
      height, roofHeight, bounds, corners: corners(bounds, groundHeight),
      wallColour: wallColours[(i + 3) % wallColours.length],
      roofColour: roofColours[(i + 2) % roofColours.length],
    }));
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

  // Denser nature: two-tone pine clusters along riverbanks
  const pineRandom = seededRandom(seed ^ 0x48a5e12d);
  for (let z = route.startZ - 200; z <= route.endZ + 200; z += 140) {
    for (const bank of [-1, 1]) {
      const offsetX = bank * (HALF_RIVER + 8 + (pineRandom() * 12));
      const treeX = riverCenter(z) + offsetX;
      const bounds = rectangleBounds(treeX, z, 10, 10);
      if (overlapsClearing(bounds) || intersects(bounds, villageBounds)) continue;
      const count = 2 + Math.floor(pineRandom() * 3);
      const clusterTrees = [];
      for (let i = 0; i < count; i++) {
        const angle = pineRandom() * TAU;
        const dist = pineRandom() * 6;
        const tx = treeX + Math.cos(angle) * dist;
        const tz = z + Math.sin(angle) * dist;
        const crownRadius = 3.2 + pineRandom() * 1.6;
        const height = 12 + pineRandom() * 6;
        const tree = freezeData({
          id: `river-pine-${z}-${bank}-${i}`, type: 'tree', clusterId: `river-pines-${z}-${bank}`,
          position: { x: tx, y: groundHeight(tx, tz), z: tz },
          height, crownRadius, pine: true, twoTone: true,
          bounds: rectangleBounds(tx, tz, crownRadius * 2, crownRadius * 2),
          colour: '#355c45',
        });
        clusterTrees.push(tree);
        trees.push(tree);
      }
      treeClusters.push(freezeData({
        id: `river-pines-${z}-${bank}`, type: 'treeCluster', bank,
        position: { x: treeX, y: groundHeight(treeX, z), z }, radius: 10,
        bounds: rectangleBounds(treeX, z, 20, 20), trees: clusterTrees,
      }));
    }
  }

  // Lower slope pine clusters
  for (let z = route.startZ; z <= route.endZ; z += 180) {
    for (const bank of [-1, 1]) {
      const slopeDist = HALF_VALLEY + 35 + pineRandom() * 75;
      const slopeX = riverCenter(z) + bank * slopeDist;
      const bounds = rectangleBounds(slopeX, z, 14, 14);
      if (overlapsClearing(bounds)) continue;
      const count = 3 + Math.floor(pineRandom() * 3);
      const clusterTrees = [];
      for (let i = 0; i < count; i++) {
        const tx = slopeX + (pineRandom() - 0.5) * 12;
        const tz = z + (pineRandom() - 0.5) * 12;
        const crownRadius = 3.5 + pineRandom() * 1.5;
        const height = 13 + pineRandom() * 5;
        const tree = freezeData({
          id: `slope-pine-${z}-${bank}-${i}`, type: 'tree', clusterId: `slope-pines-${z}-${bank}`,
          position: { x: tx, y: groundHeight(tx, tz), z: tz },
          height, crownRadius, pine: true, twoTone: true,
          bounds: rectangleBounds(tx, tz, crownRadius * 2, crownRadius * 2),
          colour: '#2f523d',
        });
        clusterTrees.push(tree);
        trees.push(tree);
      }
      treeClusters.push(freezeData({
        id: `slope-pines-${z}-${bank}`, type: 'treeCluster', bank,
        position: { x: slopeX, y: groundHeight(slopeX, z), z }, radius: 14,
        bounds: rectangleBounds(slopeX, z, 28, 28), trees: clusterTrees,
      }));
    }
  }

  // Small still pond off the river in western valley floor
  const pondZ = 1760;
  const pondX = 55;
  const ponds = [freezeData({
    id: 'valley-pond', type: 'pond',
    position: { x: pondX, y: 0.08, z: pondZ },
    radiusX: 22, radiusZ: 36,
    bounds: rectangleBounds(pondX, pondZ, 50, 78),
  })];

  // Round gold hay bales in two fields
  const hayBales = [];
  const hayField1Z = 2240;
  const hayField1X = riverCenter(hayField1Z) - 130;
  const hay1Offsets = [
    [-14, -18, 0.4], [8, -12, 1.2], [-6, 2, -0.6], [16, 10, 0.1],
    [-18, 16, 1.8], [6, 22, -1.1],
  ];
  hay1Offsets.forEach(([dx, dz, rot], idx) => {
    const x = hayField1X + dx;
    const z = hayField1Z + dz;
    hayBales.push(freezeData({
      id: `hay-bale-1-${idx}`, type: 'hayBale',
      position: { x, y: groundHeight(x, z) + 0.9, z },
      heading: rot * 57.3, radius: 0.9, length: 1.8,
      bounds: rectangleBounds(x, z, 3, 3),
      colour: '#e0b542', shadeColour: '#b38a29',
    }));
  });
  const hayField2Z = 2760;
  const hayField2X = riverCenter(hayField2Z) + 125;
  const hay2Offsets = [
    [-12, -16, 0.2], [10, -10, -0.9], [-4, 4, 1.4], [14, 12, -0.3],
    [-15, 18, 0.8], [8, 24, 2.1],
  ];
  hay2Offsets.forEach(([dx, dz, rot], idx) => {
    const x = hayField2X + dx;
    const z = hayField2Z + dz;
    hayBales.push(freezeData({
      id: `hay-bale-2-${idx}`, type: 'hayBale',
      position: { x, y: groundHeight(x, z) + 0.9, z },
      heading: rot * 57.3, radius: 0.9, length: 1.8,
      bounds: rectangleBounds(x, z, 3, 3),
      colour: '#dfb240', shadeColour: '#b08726',
    }));
  });

  // Windmill on eastern ridge shoulder above the village
  const windmillZ = villageZ - 20;
  const windmillX = 295;
  const windmillY = groundHeight(windmillX, windmillZ);
  const landmarks = [freezeData({
    id: 'ridge-windmill', type: 'windmill',
    position: { x: windmillX, y: windmillY, z: windmillZ },
    heading: -75, towerRadius: 4.5, towerHeight: 14, capHeight: 3.5,
    bladeLength: 10.5, bounds: rectangleBounds(windmillX, windmillZ, 26, 26),
  })];

  // Stone arch bridge across the river at the village
  const bridgeZ = villageZ - 40;
  const bridgeRiverX = riverCenter(bridgeZ);
  const bridgeWestX = bridgeRiverX - HALF_RIVER - 4;
  const bridgeEastX = bridgeRiverX + HALF_RIVER + 4;
  const bridges = [freezeData({
    id: 'village-bridge', type: 'bridge',
    position: { x: bridgeRiverX, y: 0, z: bridgeZ },
    westX: bridgeWestX, eastX: bridgeEastX, z: bridgeZ,
    deckWidth: 6, deckHeight: 2.8,
    bounds: rectangleBounds(bridgeRiverX, bridgeZ, WORLD.riverWidthMeters + 20, 16),
  })];

  // Dirt road waypoints & segments
  const roads = [];
  const roadWaypoints = [];
  roadWaypoints.push({ x: -290, z: 320 });
  for (let z = 400; z <= bridgeZ - 40; z += 80) {
    roadWaypoints.push({ x: riverCenter(z) - HALF_RIVER - 26, z });
  }
  roadWaypoints.push({ x: bridgeWestX, z: bridgeZ });
  roadWaypoints.push({ x: bridgeEastX, z: bridgeZ });
  roadWaypoints.push({ x: villageX, z: bridgeZ });
  roadWaypoints.push({ x: villageX, z: villageZ - 90 });
  roadWaypoints.push({ x: villageX, z: villageZ + 90 });
  for (let z = villageZ + 140; z <= route.endZ + 200; z += 80) {
    roadWaypoints.push({ x: riverCenter(z) + HALF_RIVER + 26, z });
  }
  for (let i = 0; i < roadWaypoints.length - 1; i++) {
    const a = roadWaypoints[i];
    const b = roadWaypoints[i + 1];
    const minX = Math.min(a.x, b.x) - 4;
    const maxX = Math.max(a.x, b.x) + 4;
    const minZ = Math.min(a.z, b.z) - 2;
    const maxZ = Math.max(a.z, b.z) + 2;
    roads.push(freezeData({
      id: `road-segment-${i}`, type: 'road',
      from: { x: a.x, y: groundHeight(a.x, a.z) + 0.12, z: a.z },
      to: { x: b.x, y: groundHeight(b.x, b.z) + 0.12, z: b.z },
      width: 5.5, bounds: { minX, maxX, minZ, maxZ },
    }));
  }

  // Simple post-and-rail fence lines along fields beside the road
  const fences = [];
  for (let z = 1200; z <= 2240; z += 120) {
    const fromX = riverCenter(z) - HALF_RIVER - 31;
    const toX = riverCenter(z + 120) - HALF_RIVER - 31;
    fences.push(freezeData({
      id: `fence-w-${z}`, type: 'fence',
      from: { x: fromX, y: groundHeight(fromX, z), z },
      to: { x: toX, y: groundHeight(toX, z + 120), z: z + 120 },
      bounds: { minX: Math.min(fromX, toX) - 2, maxX: Math.max(fromX, toX) + 2, minZ: z, maxZ: z + 120 },
    }));
  }
  for (let z = 2720; z <= 3680; z += 120) {
    const fromX = riverCenter(z) + HALF_RIVER + 31;
    const toX = riverCenter(z + 120) + HALF_RIVER + 31;
    fences.push(freezeData({
      id: `fence-e-${z}`, type: 'fence',
      from: { x: fromX, y: groundHeight(fromX, z), z },
      to: { x: toX, y: groundHeight(toX, z + 120), z: z + 120 },
      bounds: { minX: Math.min(fromX, toX) - 2, maxX: Math.max(fromX, toX) + 2, minZ: z, maxZ: z + 120 },
    }));
  }

  // 4 soft flat drifting clouds
  const clouds = freezeData([
    { id: 'cloud-0', baseZ: 1200, xOffset: -60, width: 280, length: 180, altitude: 620, speed: 6 },
    { id: 'cloud-1', baseZ: 2450, xOffset: 80, width: 330, length: 210, altitude: 670, speed: 7 },
    { id: 'cloud-2', baseZ: 3750, xOffset: -40, width: 300, length: 190, altitude: 640, speed: 6.5 },
    { id: 'cloud-3', baseZ: 5050, xOffset: 70, width: 270, length: 170, altitude: 610, speed: 7.2 },
  ]);

  const world = { seed, paletteName: palette, palette: colours, ringCount, route, sceneryExtent,
    departure: airstrips[0], destination: airstrips[1], airstrips,
    village: villages[0], villages, fields, trees, treeClusters, houses, rings: [],
    ponds, hayBales, landmarks, bridges, roads, fences, clouds,
    riverCenter, riverHeading, distanceToRiver, groundHeight, clearance, airstripAt,
    featuresInWindow, featuresAhead };
  world.rings = Object.freeze(createRings(world));
  for (const list of [airstrips, villages, fields, trees, treeClusters, houses, ponds, hayBales, landmarks, bridges, roads, fences]) {
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
      rings: visible(world.rings), ponds: visible(ponds), hayBales: visible(hayBales),
      landmarks: visible(landmarks), bridges: visible(bridges), roads: visible(roads),
      fences: visible(fences), clouds };
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
