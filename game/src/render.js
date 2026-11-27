/**
 * Draw Valley Mail's world, route markers and chase-view aircraft on a 2D canvas.
 * Exports: draw(ctx, world, plane, run). All helpers are private; no HUD or logic.
 * Drawing uses CANVAS design coordinates, preserving the caller's canvas transform.
 * Camera and effect time are derived from state; rendering never changes that state.
 */
import { CANVAS, WORLD, PALETTES } from './config.js';
import { CHASE_CAMERA } from './plane.js';
import { drawWeatherLayer } from './weather.js';
import { drawObstacles } from './obstacles.js';

const { width: WIDTH, height: HEIGHT } = CANVAS;
const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const NEAR = 1.5;
const FOCAL = 820;
const DOWN = 0.055;
const COS_DOWN = Math.cos(DOWN);
const SIN_DOWN = Math.sin(DOWN);
const CENTER_Y = HEIGHT * 0.43;
const HORIZON = CENTER_Y - FOCAL * Math.tan(DOWN);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const lerp = (a, b, t) => a + (b - a) * t;

function mix(a, b, amount) {
  const t = clamp(amount, 0, 1);
  const channel = (colour, shift) => (parseInt(colour.slice(1), 16) >> shift) & 255;
  const channels = [16, 8, 0].map(shift => Math.round(lerp(channel(a, shift), channel(b, shift), t)));
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

function createCamera(world, plane) {
  const heading = plane.heading * RAD;
  const sin = Math.sin(heading);
  const cos = Math.cos(heading);
  const dist = CHASE_CAMERA.distanceMeters ?? 21.0;
  const elev = CHASE_CAMERA.elevationMeters ?? 8.0;
  const clearance = CHASE_CAMERA.groundClearanceMeters ?? 4.8;
  const x = plane.position.x - sin * dist;
  const z = plane.position.z - cos * dist;
  return {
    x, z, sin, cos,
    y: Math.max(plane.position.y + elev, world.groundHeight(x, z) + clearance),
  };
}

function toView(camera, point) {
  const dx = point.x - camera.x;
  const dy = point.y - camera.y;
  const dz = point.z - camera.z;
  const forward = dx * camera.sin + dz * camera.cos;
  return {
    x: dx * camera.cos - dz * camera.sin,
    y: dy * COS_DOWN + forward * SIN_DOWN,
    z: forward * COS_DOWN - dy * SIN_DOWN,
  };
}

function projectView(point) {
  const scale = FOCAL / point.z;
  return { x: WIDTH / 2 + point.x * scale, y: CENTER_Y - point.y * scale, scale };
}

function project(camera, point) {
  const view = toView(camera, point);
  return view.z >= NEAR ? { ...projectView(view), depth: view.z } : null;
}

function interpolatePoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}

// Clip in camera space before dividing by depth, including when a strip crosses
// underneath the camera. Dropping an entire polygon here would make holes pop.
function clipDepth(points, boundary, keepGreater) {
  const output = [];
  let previous = points[points.length - 1];
  let wasInside = keepGreater ? previous.z >= boundary : previous.z <= boundary;
  for (const point of points) {
    const inside = keepGreater ? point.z >= boundary : point.z <= boundary;
    if (inside !== wasInside) {
      output.push(interpolatePoint(previous, point, (boundary - previous.z) / (point.z - previous.z)));
    }
    if (inside) output.push(point);
    previous = point;
    wasInside = inside;
  }
  return output;
}

function tracePolygon(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
}

function addFace(scene, vertices, colour, options = {}) {
  let view = clipDepth(vertices.map(point => toView(scene.camera, point)), NEAR, true);
  if (view.length < 3) return;
  view = clipDepth(view, WORLD.viewDistanceMeters, false);
  if (view.length < 3) return;
  const points = view.map(projectView);
  if (points.every(p => p.x < -4) || points.every(p => p.x > WIDTH + 4)
    || points.every(p => p.y < -4) || points.every(p => p.y > HEIGHT + 4)) return;
  const depth = view.reduce((sum, point) => sum + point.z, 0) / view.length;
  scene.items.push({
    depth,
    paint(ctx) {
      ctx.save();
      ctx.globalAlpha *= options.alpha ?? 1;
      const haze = options.haze === false ? 0 : clamp((depth - 1400) / WORLD.viewDistanceMeters, 0, 0.64);
      ctx.fillStyle = haze > 0 ? mix(colour, scene.palette.sky.horizon, haze) : colour;
      if (options.glow) {
        ctx.shadowColor = colour;
        ctx.shadowBlur = options.glow;
      }
      tracePolygon(ctx, points);
      ctx.fill();
      if (options.stroke) {
        ctx.strokeStyle = options.stroke;
        ctx.lineWidth = options.lineWidth ?? 0.7;
        ctx.stroke();
      }
      ctx.restore();
    },
  });
}

function paintItems(ctx, scene) {
  scene.items.sort((a, b) => b.depth - a.depth);
  for (const item of scene.items) item.paint(ctx);
  scene.items.length = 0;
}

function localPoint(feature, x, y, z) {
  const heading = (feature.heading ?? 0) * RAD;
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  return {
    x: feature.position.x + x * cos + z * sin,
    y: feature.position.y + y,
    z: feature.position.z - x * sin + z * cos,
  };
}

function rectangle(feature, left, right, back, front, lift = 0) {
  return [
    localPoint(feature, left, lift, back), localPoint(feature, right, lift, back),
    localPoint(feature, right, lift, front), localPoint(feature, left, lift, front),
  ];
}

function drawSkyGradient(ctx, palette) {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.76);
  sky.addColorStop(0, palette.sky.top);
  sky.addColorStop(0.62, palette.sky.horizon);
  sky.addColorStop(1, palette.sky.horizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawSkyGlow(ctx, palette, dusk) {
  // A warm atmospheric sun glow in the upper-right sky
  const glowX = WIDTH * 0.82;
  const glowY = HEIGHT * 0.16;
  const glowRadius = dusk ? 380 : 340;
  const glow = ctx.createRadialGradient(glowX, glowY, 15, glowX, glowY, glowRadius);
  if (dusk) {
    glow.addColorStop(0, 'rgba(255, 195, 120, 0.50)');
    glow.addColorStop(0.35, 'rgba(240, 140, 95, 0.28)');
    glow.addColorStop(0.7, 'rgba(180, 80, 85, 0.12)');
    glow.addColorStop(1, 'rgba(180, 80, 85, 0)');
  } else {
    glow.addColorStop(0, 'rgba(255, 248, 220, 0.62)');
    glow.addColorStop(0.25, 'rgba(255, 230, 165, 0.40)');
    glow.addColorStop(0.55, 'rgba(255, 215, 130, 0.20)');
    glow.addColorStop(0.85, 'rgba(245, 205, 130, 0.06)');
    glow.addColorStop(1, 'rgba(245, 205, 130, 0)');
  }
  ctx.save();
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT * 0.75);
  ctx.restore();
}

function drawSun(ctx, camera, palette, dusk) {
  // A fixed world bearing placing the warm sun in the upper-right sky
  const sun = project(camera, {
    x: camera.x + 18000, y: camera.y + (dusk ? 3800 : 7000), z: camera.z + 28000,
  });
  if (!sun || sun.x <= -120 || sun.x >= WIDTH + 120 || sun.y <= -120 || sun.y >= HEIGHT) return;

  const radius = dusk ? 24 : 19;
  const glow = ctx.createRadialGradient(sun.x, sun.y, radius, sun.x, sun.y, radius * 4.5);
  glow.addColorStop(0, palette.sky.horizon);
  glow.addColorStop(1, 'rgba(255,225,175,0)');
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = glow;
  ctx.fillRect(sun.x - 110, sun.y - 110, 220, 220);
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = mix(palette.ringCore, palette.sky.horizon, dusk ? 0.28 : 0.12);
  ctx.beginPath();
  ctx.arc(sun.x, sun.y, radius, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawHorizon(ctx, palette) {
  ctx.fillStyle = mix(palette.fields[0], palette.sky.horizon, 0.48);
  ctx.fillRect(0, HORIZON, WIDTH, HEIGHT - HORIZON);
}

function drawRidgeHazeBands(ctx, palette, dusk) {
  // One or two thin pale atmospheric haze bands across the far ridges
  ctx.save();
  const hazeY1 = HORIZON - 18;
  const bandHeight1 = 14;
  const grad1 = ctx.createLinearGradient(0, hazeY1, 0, hazeY1 + bandHeight1);
  const hazeColor1 = dusk ? 'rgba(215, 175, 195,' : 'rgba(235, 245, 250,';
  grad1.addColorStop(0, hazeColor1 + '0)');
  grad1.addColorStop(0.5, hazeColor1 + (dusk ? '0.28)' : '0.35)'));
  grad1.addColorStop(1, hazeColor1 + '0)');
  ctx.fillStyle = grad1;
  ctx.fillRect(0, hazeY1, WIDTH, bandHeight1);

  const hazeY2 = HORIZON + 12;
  const bandHeight2 = 18;
  const grad2 = ctx.createLinearGradient(0, hazeY2, 0, hazeY2 + bandHeight2);
  const hazeColor2 = dusk ? 'rgba(195, 155, 175,' : 'rgba(220, 238, 242,';
  grad2.addColorStop(0, hazeColor2 + '0)');
  grad2.addColorStop(0.5, hazeColor2 + (dusk ? '0.22)' : '0.28)'));
  grad2.addColorStop(1, hazeColor2 + '0)');
  ctx.fillStyle = grad2;
  ctx.fillRect(0, hazeY2, WIDTH, bandHeight2);
  ctx.restore();
}

function drawSky(ctx, camera, palette, dusk) {
  drawSkyGradient(ctx, palette);
  drawSkyGlow(ctx, palette, dusk);
  drawSun(ctx, camera, palette, dusk);
  drawHorizon(ctx, palette);
}

/** Align a view-distance Z window to regular terrain segment steps. */
function segmentRange(cameraZ, distance, step) {
  const from = Math.floor((cameraZ - distance) / step) * step;
  const to = cameraZ + distance;
  return { from, to };
}

function addValleyFloor(scene, world, from, to, step, half) {
  const offsets = [-6000, -2000, -1100, -760, -half, 0, half, 760, 1100, 2000, 6000];
  const row = z => offsets.map(offset => {
    const x = world.riverCenter(z) + offset;
    return { x, y: world.groundHeight(x, z), z };
  });
  let previous = row(from);
  for (let z = from + step; z <= to + step; z += step) {
    const current = row(z);
    for (let i = 0; i < offsets.length - 1; i++) {
      const wall = i < 4 || i > 5;
      const colour = wall ? scene.palette.ridges[2] : scene.palette.fields[0];
      addFace(scene, [previous[i], previous[i + 1], current[i + 1], current[i]], colour);
    }
    previous = current;
  }
}

function addRidgeRibbons(scene, world, from, to, step, half) {
  // Far ridge line behind the current mountains carrying snow-capped peaks
  for (const side of [-1, 1]) {
    const farPoint = z => {
      const center = world.riverCenter(z);
      const wave = Math.sin(z / 520 + side * 1.5) + 0.35 * Math.sin(z / 190 + side * 2.2);
      const peakY = WORLD.ridgeHeightMeters * (1.8 + wave * 0.22);
      return {
        foot: { x: center + side * (half + 1360), y: 0, z },
        peak: { x: center + side * (half + 1840), y: peakY, z },
      };
    };
    let a = farPoint(from);
    for (let z = from + step; z <= to + step; z += step) {
      const b = farPoint(z);
      const ridgeColour = mix(scene.palette.ridges[0], scene.palette.sky.horizon, 0.32);
      addFace(scene, [a.foot, b.foot, b.peak, a.peak], ridgeColour);
      // White snow caps on the highest points
      if (a.peak.y > 670 || b.peak.y > 670) {
        const aSnow = interpolatePoint(a.foot, a.peak, 0.73);
        const bSnow = interpolatePoint(b.foot, b.peak, 0.73);
        const snowColour = side > 0
          ? mix(scene.palette.ringCore, '#ffffff', 0.65)
          : mix(scene.palette.ridges[0], '#ffffff', 0.72);
        addFace(scene, [aSnow, bSnow, b.peak, a.peak], snowColour);
      }
      a = b;
    }
  }

  // Six world-anchored ribbons, rather than a screen-space mountain wallpaper:
  // separate lateral distances produce parallax during both travel and turns.
  for (let layer = 0; layer < 3; layer++) {
    for (const side of [-1, 1]) {
      const ridgePoint = z => {
        const center = world.riverCenter(z);
        const wave = Math.sin(z / (370 + layer * 90) + side * 1.8 + layer)
          + 0.38 * Math.sin(z / 137 + layer * 2 + side);
        return {
          foot: { x: center + side * (half + (2 - layer) * 340), y: 0, z },
          peak: {
            x: center + side * (half + (3 - layer) * 340),
            y: WORLD.ridgeHeightMeters * (1.05 + (2 - layer) * 0.2 + wave * 0.16), z,
          },
        };
      };
      let a = ridgePoint(from);
      for (let z = from + step; z <= to + step; z += step) {
        const b = ridgePoint(z);
        addFace(scene, [a.foot, b.foot, b.peak, a.peak], scene.palette.ridges[layer]);
        a = b;
      }
    }
  }
}

function drawTerrain(ctx, scene, world, dusk) {
  const step = WORLD.terrainSegmentLengthMeters;
  const { from, to } = segmentRange(scene.camera.z, WORLD.viewDistanceMeters, step);
  const half = WORLD.valleyWidthMeters / 2;
  addValleyFloor(scene, world, from, to, step, half);
  addRidgeRibbons(scene, world, from, to, step, half);
  paintItems(ctx, scene);
  drawRidgeHazeBands(ctx, scene.palette, dusk);
}

function addPonds(scene, ponds) {
  for (const pond of ponds) {
    const projected = project(scene.camera, pond.position);
    if (!projected || projected.depth > WORLD.viewDistanceMeters) continue;
    const rx = pond.radiusX ?? 22;
    const rz = pond.radiusZ ?? 36;
    const rimPoints = [];
    const waterPoints = [];
    const sheenPoints = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      rimPoints.push({ x: pond.position.x + cos * (rx + 3), y: pond.position.y - 0.01, z: pond.position.z + sin * (rz + 3) });
      waterPoints.push({ x: pond.position.x + cos * rx, y: pond.position.y, z: pond.position.z + sin * rz });
      if (i < 12) {
        sheenPoints.push({ x: pond.position.x + cos * rx * 0.45, y: pond.position.y + 0.01, z: pond.position.z + sin * rz * 0.45 });
      }
    }
    // Grass and reed bank rim
    addFace(scene, rimPoints, scene.palette.fields[3]);
    // Still calm water surface
    addFace(scene, waterPoints, scene.palette.river);
    // Subtle surface highlight
    addFace(scene, sheenPoints, scene.palette.riverHighlight, { alpha: 0.28 });
  }
}

function addRoads(scene, roads) {
  const roadColour = '#cbb996';
  const rutColour = '#a89572';
  for (const segment of roads) {
    const from = segment.from;
    const to = segment.to;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.1) continue;
    const nx = (-dz / len) * (segment.width / 2);
    const nz = (dx / len) * (segment.width / 2);
    // Main pale tan road bed
    addFace(scene, [
      { x: from.x - nx, y: from.y, z: from.z - nz },
      { x: from.x + nx, y: from.y, z: from.z + nz },
      { x: to.x + nx, y: to.y, z: to.z + nz },
      { x: to.x - nx, y: to.y, z: to.z - nz },
    ], roadColour);
    // Slightly darker wheel ruts
    const rutOffset = 1.3;
    const rutHalf = 0.35;
    for (const sign of [-1, 1]) {
      const rx1 = (-dz / len) * (sign * rutOffset - rutHalf);
      const rz1 = (dx / len) * (sign * rutOffset - rutHalf);
      const rx2 = (-dz / len) * (sign * rutOffset + rutHalf);
      const rz2 = (dx / len) * (sign * rutOffset + rutHalf);
      addFace(scene, [
        { x: from.x + rx1, y: from.y + 0.01, z: from.z + rz1 },
        { x: from.x + rx2, y: from.y + 0.01, z: from.z + rz2 },
        { x: to.x + rx2, y: to.y + 0.01, z: to.z + rz2 },
        { x: to.x + rx1, y: to.y + 0.01, z: to.z + rz1 },
      ], rutColour);
    }
  }
}

function addBridge(scene, bridges) {
  const stone = '#969ca1';
  const stoneShade = '#788086';
  const stoneDark = '#60676d';
  for (const bridge of bridges) {
    const proj = project(scene.camera, bridge.position);
    if (!proj || proj.depth > WORLD.viewDistanceMeters) continue;
    const { westX, eastX, z, deckWidth, deckHeight } = bridge;
    const halfW = deckWidth / 2;
    const y = deckHeight;

    // Roadway deck surface
    addFace(scene, [
      { x: westX, y, z: z - halfW },
      { x: eastX, y, z: z - halfW },
      { x: eastX, y, z: z + halfW },
      { x: westX, y, z: z + halfW },
    ], '#b8a98b');

    // Stone parapets on north and south sides
    const parapetHeight = 1.0;
    addFace(scene, [
      { x: westX, y, z: z - halfW },
      { x: eastX, y, z: z - halfW },
      { x: eastX, y: y + parapetHeight, z: z - halfW },
      { x: westX, y: y + parapetHeight, z: z - halfW },
    ], stone);
    addFace(scene, [
      { x: westX, y, z: z + halfW },
      { x: eastX, y, z: z + halfW },
      { x: eastX, y: y + parapetHeight, z: z + halfW },
      { x: westX, y: y + parapetHeight, z: z + halfW },
    ], stoneShade);

    // Stone piers in the river (two piers)
    const pierX = [bridge.position.x - 18, bridge.position.x + 18];
    for (const px of pierX) {
      const pw = 4;
      const pl = halfW + 1.2;
      addFace(scene, [
        { x: px - pw, y: 0, z: z - pl }, { x: px + pw, y: 0, z: z - pl },
        { x: px + pw, y, z: z - pl }, { x: px - pw, y, z: z - pl },
      ], stone);
      addFace(scene, [
        { x: px - pw, y: 0, z: z + pl }, { x: px + pw, y: 0, z: z + pl },
        { x: px + pw, y, z: z + pl }, { x: px - pw, y, z: z + pl },
      ], stoneShade);
      for (const side of [-1, 1]) {
        addFace(scene, [
          { x: px + side * pw, y: 0, z: z - pl }, { x: px + side * pw, y: 0, z: z + pl },
          { x: px + side * pw, y, z: z + pl }, { x: px + side * pw, y, z: z - pl },
        ], side > 0 ? stone : stoneDark);
      }
    }

    // Arch spandrels between abutments and piers
    const archIntervals = [
      [westX, pierX[0] - 4],
      [pierX[0] + 4, pierX[1] - 4],
      [pierX[1] + 4, eastX],
    ];
    for (const [ax1, ax2] of archIntervals) {
      addFace(scene, [
        { x: ax1, y: y * 0.75, z: z - halfW }, { x: ax2, y: y * 0.75, z: z - halfW },
        { x: ax2, y, z: z - halfW }, { x: ax1, y, z: z - halfW },
      ], stone);
      addFace(scene, [
        { x: ax1, y: y * 0.75, z: z + halfW }, { x: ax2, y: y * 0.75, z: z + halfW },
        { x: ax2, y, z: z + halfW }, { x: ax1, y, z: z + halfW },
      ], stoneShade);
    }
  }
}

function addHayBales(scene, hayBales) {
  for (const bale of hayBales) {
    const proj = project(scene.camera, bale.position);
    if (!proj || proj.depth > WORLD.viewDistanceMeters) continue;
    const r = bale.radius ?? 0.9;
    const l = (bale.length ?? 1.8) / 2;
    const p = (x, y, z) => localPoint(bale, x, y, z);
    const colour = bale.colour ?? '#dfb240';
    const shade = bale.shadeColour ?? '#b08726';

    const sides = 8;
    const endA = [];
    const endB = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      endA.push(p(-l, Math.cos(a) * r, Math.sin(a) * r));
      endB.push(p(l, Math.cos(a) * r, Math.sin(a) * r));
    }
    addFace(scene, endA, colour);
    addFace(scene, endB, shade);
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      const c = i < 4 ? colour : shade;
      addFace(scene, [endA[i], endB[i], endB[next], endA[next]], c);
    }
  }
}

function addFences(scene, fences) {
  for (const fence of fences) {
    const { from, to } = fence;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1) continue;
    for (const rh of [0.45, 0.95]) {
      addWorldLine(scene, [
        { x: from.x, y: from.y + rh, z: from.z },
        { x: to.x, y: to.y + rh, z: to.z },
      ], '#72624d', 1.4, 0.85);
    }
    const posts = Math.max(2, Math.round(dist / 12));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      const px = from.x + dx * t;
      const pz = from.z + dz * t;
      const py = from.y + (to.y - from.y) * t;
      addWorldLine(scene, [
        { x: px, y: py, z: pz },
        { x: px, y: py + 1.15, z: pz },
      ], '#5e503f', 1.8, 0.9);
    }
  }
}

function addWindmill(scene, landmarks, seconds) {
  for (const landmark of landmarks) {
    if (landmark.type !== 'windmill') continue;
    const proj = project(scene.camera, landmark.position);
    if (!proj || proj.depth > WORLD.viewDistanceMeters) continue;
    const p = (x, y, z) => localPoint(landmark, x, y, z);
    const baseR = landmark.towerRadius ?? 4.5;
    const topR = baseR * 0.72;
    const th = landmark.towerHeight ?? 14;
    const ch = landmark.capHeight ?? 3.5;
    const sides = 8;

    const baseRing = [];
    const topRing = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * TAU;
      baseRing.push(p(Math.cos(a) * baseR, 0, Math.sin(a) * baseR));
      topRing.push(p(Math.cos(a) * topR, th, Math.sin(a) * topR));
    }
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      const facet = i < 4 ? '#baa68d' : '#96836c';
      addFace(scene, [baseRing[i], topRing[i], topRing[next], baseRing[next]], facet);
    }

    const apex = p(0, th + ch, 0);
    const capColour = '#455260';
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      const capFacet = i < 4 ? capColour : mix(capColour, scene.palette.ridges[2], 0.2);
      addFace(scene, [topRing[i], apex, topRing[next]], capFacet);
    }

    const hubY = th + ch * 0.45;
    const hubZ = topR + 0.6;

    const bladeSpeed = 0.75;
    const phase = seconds * bladeSpeed;
    const bladeLen = landmark.bladeLength ?? 10.5;
    const bladeWidth = 1.6;
    for (let b = 0; b < 4; b++) {
      const a = phase + (b * Math.PI) / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const tipX = cos * bladeLen;
      const tipY = hubY + sin * bladeLen;
      const rootX = cos * 1.2;
      const rootY = hubY + sin * 1.2;
      const px = -sin * bladeWidth;
      const py = cos * bladeWidth;
      addFace(scene, [
        p(rootX, rootY, hubZ),
        p(rootX + px, rootY + py, hubZ),
        p(tipX + px, tipY + py, hubZ),
        p(tipX, tipY, hubZ),
      ], '#f4f0e6');
      addWorldLine(scene, [p(rootX, rootY, hubZ + 0.1), p(tipX, tipY, hubZ + 0.1)], '#6e543b', 2.5);
    }
  }
}

function addCloudShadows(scene, world, clouds, seconds) {
  for (const cloud of clouds) {
    const loopSpan = WORLD.viewDistanceMeters * 1.5;
    const driftZ = ((cloud.baseZ + seconds * cloud.speed) % loopSpan);
    const driftX = world.riverCenter(driftZ) + cloud.xOffset;
    const halfW = cloud.width * 0.45;
    const halfL = cloud.length * 0.45;
    const shadowPoints = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      const px = driftX + Math.cos(a) * halfW;
      const pz = driftZ + Math.sin(a) * halfL;
      shadowPoints.push({ x: px, y: world.groundHeight(px, pz) + 0.16, z: pz });
    }
    const shadowColour = mix(scene.palette.ridges[2], '#0a151c', 0.65);
    addFace(scene, shadowPoints, shadowColour, { alpha: 0.13, haze: false });
  }
}

function addClouds(scene, world, clouds, seconds, dusk) {
  const topColour = dusk ? '#f4ddd2' : '#ffffff';
  const underColour = dusk ? '#b89ca4' : '#d2dde6';
  for (const cloud of clouds) {
    const loopSpan = WORLD.viewDistanceMeters * 1.5;
    const driftZ = ((cloud.baseZ + seconds * cloud.speed) % loopSpan);
    const driftX = world.riverCenter(driftZ) + cloud.xOffset;
    const y = cloud.altitude ?? 640;
    const hw = cloud.width / 2;
    const hl = cloud.length / 2;
    const cloudPoints = [];
    const lobes = 12;
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * TAU;
      const puff = 1 + 0.18 * Math.sin(a * 4 + 1.2);
      cloudPoints.push({
        x: driftX + Math.cos(a) * hw * puff,
        y,
        z: driftZ + Math.sin(a) * hl * puff,
      });
    }
    addFace(scene, cloudPoints, topColour, { alpha: 0.88, haze: false });
    const underPoints = cloudPoints.map(pt => ({ ...pt, y: pt.y - 12 }));
    for (let i = 0; i < lobes; i++) {
      const next = (i + 1) % lobes;
      addFace(scene, [cloudPoints[i], cloudPoints[next], underPoints[next], underPoints[i]], underColour, {
        alpha: 0.55, haze: false,
      });
    }
  }
}

function addFields(scene, fields) {
  for (const field of fields) {
    const width = field.width ?? field.bounds.maxX - field.bounds.minX;
    const length = field.length ?? field.bounds.maxZ - field.bounds.minZ;
    const colour = scene.palette.fields[(field.colourIndex ?? 0) % scene.palette.fields.length];
    // Short sections keep a long plot's painter depth near the terrain it covers.
    for (let back = -length / 2; back < length / 2; back += 80) {
      addFace(scene, rectangle(field, -width / 2 + 1, width / 2 - 1, back + 1,
        Math.min(back + 80, length / 2) - 1, 0.06), colour);
    }
  }
}

function addRiver(scene, world) {
  const step = WORLD.terrainSegmentLengthMeters / 2;
  const { from, to } = segmentRange(scene.camera.z, WORLD.viewDistanceMeters, step);
  const half = WORLD.riverWidthMeters / 2;
  for (let z = from; z < to; z += step) {
    const a = world.riverCenter(z);
    const b = world.riverCenter(z + step);
    const ribbon = (left, right, y) => [
      { x: a + left, y, z }, { x: a + right, y, z },
      { x: b + right, y, z: z + step }, { x: b + left, y, z: z + step },
    ];
    addFace(scene, ribbon(-half - 3, half + 3, 0.07), scene.palette.fields[3]);
    addFace(scene, ribbon(-half, half, 0.1), scene.palette.river);
    // Broad, low-contrast reflections survive distance without shimmering lines.
    addFace(scene, ribbon(-half * 0.1, half * 0.23, 0.13), scene.palette.riverHighlight, { alpha: 0.22 });
  }
}

function addRunwayBed(scene, strip, width, length) {
  for (let back = -length / 2; back < length / 2; back += 40) {
    const front = Math.min(back + 40, length / 2);
    addFace(scene, rectangle(strip, -width / 2 - 3, width / 2 + 3, back, front, 0.18), scene.palette.fields[1]);
    addFace(scene, rectangle(strip, -width / 2, width / 2, back, front, 0.2), scene.palette.runway);
  }
}

function addRunwayThresholds(scene, strip, width, length) {
  for (const end of [-1, 1]) {
    const z = end * (length / 2 - 22);
    for (const fraction of [-0.33, -0.16, 0.16, 0.33]) {
      const x = fraction * width;
      addFace(scene, rectangle(strip, x - 1.1, x + 1.1, z - 7, z + 7, 0.24), scene.palette.runwayMarkings);
    }
    addFace(scene, rectangle(strip, -width * 0.43, width * 0.43,
      end * (length / 2 - 10) - 1, end * (length / 2 - 10) + 1, 0.25), scene.palette.runwayMarkings);
    for (const side of [-1, 1]) {
      const tip = localPoint(strip, side * width * 0.6, 1.8, end * length / 2);
      addFace(scene, [localPoint(strip, side * width * 0.6 - 1, 0.2, end * length / 2),
        localPoint(strip, side * width * 0.6 + 1, 0.2, end * length / 2), tip], scene.palette.aircraftTrim);
    }
  }
}

function addRunwayCenterline(scene, strip, length) {
  for (let z = -length / 2 + 65; z < length / 2 - 35; z += 50) {
    addFace(scene, rectangle(strip, -0.65, 0.65, z, z + 15, 0.26), scene.palette.runwayMarkings);
  }
}

function addApproachLights(scene, strip, width, length, dusk) {
  // A row of small approach lights beside and leading to the strip threshold
  const bulbColor = dusk ? '#ffe88a' : '#fff5d6';
  const postColor = '#3a424a';
  const lightOpts = { glow: dusk ? 8 : 4 };
  const halfW = width / 2;
  const halfL = length / 2;

  // Centerline approach light row leading up to threshold at -halfL
  for (let d = 20; d <= 140; d += 24) {
    const z = -halfL - d;
    const basePt = localPoint(strip, 0, 0, z);
    const topPt = localPoint(strip, 0, 0.75, z);
    const proj = project(scene.camera, topPt);
    if (!proj || proj.depth > WORLD.viewDistanceMeters) continue;

    scene.items.push({
      depth: proj.depth,
      paint(ctx) {
        strokeWorldLine(ctx, scene.camera, [basePt, topPt], postColor, 1.2);
      },
    });
    addFace(scene, [
      localPoint(strip, -0.4, 0.65, z - 0.4), localPoint(strip, 0.4, 0.65, z - 0.4),
      localPoint(strip, 0.4, 0.85, z + 0.4), localPoint(strip, -0.4, 0.85, z + 0.4),
    ], bulbColor, lightOpts);
  }

  // Crossbar / flanking lights beside the approach threshold at -halfL - 25
  const barZ = -halfL - 25;
  for (const side of [-1, 1]) {
    for (const offset of [0.35, 0.65, 0.95]) {
      const x = side * halfW * offset;
      addFace(scene, [
        localPoint(strip, x - 0.35, 0.55, barZ - 0.35), localPoint(strip, x + 0.35, 0.55, barZ - 0.35),
        localPoint(strip, x + 0.35, 0.75, barZ + 0.35), localPoint(strip, x - 0.35, 0.75, barZ + 0.35),
      ], bulbColor, lightOpts);
    }
  }
}

function addStripEdgeLights(scene, strip, width, length) {
  // Elevated runway edge lights active in dusk
  const lampColor = '#ffe37a';
  const lampOpts = { glow: 7 };
  const halfW = width / 2;
  const halfL = length / 2;

  // Along runway edges
  for (let z = -halfL; z <= halfL; z += 35) {
    for (const side of [-1, 1]) {
      const x = side * halfW;
      addFace(scene, [
        localPoint(strip, x - 0.35, 0.25, z - 0.35), localPoint(strip, x + 0.35, 0.25, z - 0.35),
        localPoint(strip, x + 0.35, 0.55, z + 0.35), localPoint(strip, x - 0.35, 0.55, z + 0.35),
      ], lampColor, lampOpts);
    }
  }
  // Green threshold lights at approach end
  for (const fraction of [-0.4, -0.25, -0.1, 0.1, 0.25, 0.4]) {
    const x = fraction * width;
    addFace(scene, [
      localPoint(strip, x - 0.4, 0.25, -halfL - 0.3), localPoint(strip, x + 0.4, 0.25, -halfL - 0.3),
      localPoint(strip, x + 0.4, 0.55, -halfL + 0.3), localPoint(strip, x - 0.4, 0.55, -halfL + 0.3),
    ], '#55efc4', { glow: 8 });
  }
}

function addStrips(scene, strips, dusk) {
  for (const strip of strips) {
    const width = strip.width ?? WORLD.runwayWidthMeters;
    const length = strip.length ?? WORLD.runwayLengthMeters;
    addRunwayBed(scene, strip, width, length);
    addRunwayThresholds(scene, strip, width, length);
    addRunwayCenterline(scene, strip, length);
    addApproachLights(scene, strip, width, length, dusk);
    if (dusk) addStripEdgeLights(scene, strip, width, length);
  }
}

function addWindsocks(scene, strips, seconds) {
  for (const strip of strips) {
    const point = (x, y, z) => localPoint(strip, (strip.width ?? WORLD.runwayWidthMeters) * 0.85 + x,
      y, -(strip.length ?? WORLD.runwayLengthMeters) * 0.3 + z);
    const base = point(0, 0, 0);
    const top = point(0, 6, 0);
    const projected = project(scene.camera, top);
    if (!projected || projected.depth > WORLD.viewDistanceMeters || projected.scale < 0.25) continue;
    const flutter = Math.sin(seconds * 3.5 + strip.position.z) * 0.18;
    scene.items.push({ depth: projected.depth, paint(ctx) {
      strokeWorldLine(ctx, scene.camera, [base, top], scene.palette.runwayMarkings, 1.2);
    } });
    for (let i = 0; i < 4; i++) {
      const x = i * 0.95;
      const y = 5.9 - i * 0.2 + flutter * (i / 4);
      const radius = 0.65 - i * 0.1;
      addFace(scene, [point(x, y - radius, i * 0.1), point(x, y + radius, i * 0.1),
        point(x + 0.95, y + radius - 0.3, (i + 1) * 0.1),
        point(x + 0.95, y - radius + 0.1, (i + 1) * 0.1)],
      i % 2 ? scene.palette.runwayMarkings : scene.palette.aircraftTrim);
    }
  }
}

function addTrees(scene, features) {
  const trees = new Map();
  for (const cluster of features.treeClusters ?? []) {
    for (const tree of cluster.trees ?? []) trees.set(tree.id, tree);
  }
  for (const tree of features.trees ?? []) trees.set(tree.id, tree);
  for (const tree of trees.values()) {
    const base = project(scene.camera, tree.position);
    const height = tree.height ?? 13;
    const radius = tree.crownRadius ?? 4;
    if (!base || base.depth > WORLD.viewDistanceMeters) continue;
    const top = project(scene.camera, { ...tree.position, y: tree.position.y + height });
    if (!top || top.y > HEIGHT + 10 || base.y < -10) continue;
    const size = radius * base.scale;
    if (base.x + size < 0 || base.x - size > WIDTH || base.y - top.y < 0.7) continue;
    const haze = clamp((base.depth - 1400) / WORLD.viewDistanceMeters, 0, 0.64);
    const baseColour = tree.colour
      ? mix(tree.colour, scene.palette.fields[0], 0.3)
      : mix(scene.palette.fields[0], scene.palette.ridges[2], 0.52);
    const colourLight = mix(baseColour, scene.palette.fields[1], 0.32);
    const colourDark = mix(baseColour, scene.palette.ridges[2], 0.52);
    // Billboards remain upright in world space; the stable camera has no roll.
    scene.items.push({ depth: base.depth, paint(ctx) {
      ctx.fillStyle = scene.palette.aircraftTrim;
      ctx.fillRect(base.x - Math.max(0.5, base.scale * 0.4), base.y - height * base.scale * 0.35,
        Math.max(1, base.scale * 0.8), height * base.scale * 0.35);
      const foliageBottom = base.y - height * base.scale * 0.18;
      // Two-tone crown: left face (lit), right face (shaded)
      ctx.fillStyle = haze ? mix(colourLight, scene.palette.sky.horizon, haze) : colourLight;
      tracePolygon(ctx, [{ x: base.x, y: top.y }, { x: base.x, y: foliageBottom }, { x: base.x - size, y: foliageBottom }]);
      ctx.fill();
      ctx.fillStyle = haze ? mix(colourDark, scene.palette.sky.horizon, haze) : colourDark;
      tracePolygon(ctx, [{ x: base.x, y: top.y }, { x: base.x + size, y: foliageBottom }, { x: base.x, y: foliageBottom }]);
      ctx.fill();
    } });
  }
}

function addHouses(scene, features, dusk) {
  const houses = new Map();
  for (const village of features.villages ?? []) {
    for (const house of village.houses ?? village.buildings ?? []) houses.set(house.id, house);
  }
  for (const house of features.houses ?? []) houses.set(house.id, house);
  for (const house of houses.values()) {
    const base = project(scene.camera, house.position);
    if (!base || base.depth > WORLD.viewDistanceMeters) continue;
    const w = (house.width ?? 11) / 2;
    const l = (house.length ?? 14) / 2;
    const h = house.height ?? 7;
    const roof = h + (house.roofHeight ?? 2.75);
    const maxHeight = house.type === 'church' ? (house.towerHeight ?? 22) + (house.spireHeight ?? 10) : roof;
    if (base.x < -w * base.scale * 3 || base.x > WIDTH + w * base.scale * 3
      || base.y < -40 || base.y - maxHeight * base.scale > HEIGHT) continue;
    const p = (x, y, z) => localPoint(house, x, y, z);
    const wall = house.wallColour ?? scene.palette.runwayMarkings;
    const roofColour = house.roofColour ?? scene.palette.aircraftTrim;

    if (house.type === 'church') {
      // Church nave
      addFace(scene, [p(-w, 0, -l), p(w, 0, -l), p(w, h, -l), p(-w, h, -l)], wall);
      addFace(scene, [p(-w, 0, l), p(w, 0, l), p(w, h, l), p(-w, h, l)], wall);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * w, 0, -l), p(side * w, 0, l), p(side * w, h, l), p(side * w, h, -l)],
          mix(wall, scene.palette.ridges[2], side > 0 ? 0.22 : 0.1));
        addFace(scene, [p(-w, h, side * l), p(w, h, side * l), p(0, roof, side * l)], wall);
        addFace(scene, [p(side * w, h, -l), p(side * w, h, l), p(0, roof, l), p(0, roof, -l)],
          side > 0 ? roofColour : mix(roofColour, scene.palette.ridges[2], 0.18));
      }
      // Tall white church tower at the front
      const tw = (house.towerWidth ?? 6) / 2;
      const tl = (house.towerLength ?? 6) / 2;
      const th = house.towerHeight ?? 22;
      const tz = -l + tl;
      addFace(scene, [p(-tw, 0, tz - tl), p(tw, 0, tz - tl), p(tw, th, tz - tl), p(-tw, th, tz - tl)], wall);
      addFace(scene, [p(-tw, 0, tz + tl), p(tw, 0, tz + tl), p(tw, th, tz + tl), p(-tw, th, tz + tl)], wall);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * tw, 0, tz - tl), p(side * tw, 0, tz + tl), p(side * tw, th, tz + tl), p(side * tw, th, tz - tl)],
          mix(wall, scene.palette.ridges[2], side > 0 ? 0.24 : 0.12));
      }
      // Dark spire atop tower
      const sh = house.spireHeight ?? 10;
      const spireApex = p(0, th + sh, tz);
      const spireColour = house.spireColour ?? '#282e38';
      addFace(scene, [p(-tw, th, tz - tl), p(tw, th, tz - tl), spireApex], spireColour);
      addFace(scene, [p(-tw, th, tz + tl), p(tw, th, tz + tl), spireApex], spireColour);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * tw, th, tz - tl), p(side * tw, th, tz + tl), spireApex],
          mix(spireColour, scene.palette.ridges[2], side > 0 ? 0.25 : 0.1));
      }
      // Glowing amber windows for church at dusk
      if (dusk) {
        const churchWin = '#ffb042';
        const winGlow = { glow: 8 };
        for (const side of [-1, 1]) {
          const x = side * (w + 0.05);
          for (const zOff of [-l * 0.45, 0, l * 0.45]) {
            addFace(scene, [p(x, h * 0.35, zOff - 0.7), p(x, h * 0.35, zOff + 0.7),
              p(x, h * 0.72, zOff + 0.7), p(x, h * 0.72, zOff - 0.7)], churchWin, winGlow);
          }
        }
      }
    } else if (house.type === 'waterTower') {
      // 4 wooden/metal stilts
      const sw = w * 0.8;
      const sl = l * 0.8;
      const sh = house.stiltsHeight ?? 8;
      const stiltColour = mix(wall, '#2a2015', 0.45);
      for (const sx of [-sw, sw]) {
        for (const sz of [-sl, sl]) {
          addFace(scene, [p(sx - 0.25, 0, sz - 0.25), p(sx + 0.25, 0, sz - 0.25),
            p(sx + 0.25, sh, sz - 0.25), p(sx - 0.25, sh, sz - 0.25)], stiltColour);
        }
      }
      // Elevated water tank
      const th = h;
      addFace(scene, [p(-w, sh, -l), p(w, sh, -l), p(w, th, -l), p(-w, th, -l)], wall);
      addFace(scene, [p(-w, sh, l), p(w, sh, l), p(w, th, l), p(-w, th, l)], wall);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * w, sh, -l), p(side * w, sh, l), p(side * w, th, l), p(side * w, sh, -l)],
          mix(wall, scene.palette.ridges[2], side > 0 ? 0.25 : 0.12));
      }
      // Roof of water tower
      const apex = p(0, th + (house.roofHeight ?? 2.5), 0);
      addFace(scene, [p(-w, th, -l), p(w, th, -l), apex], roofColour);
      addFace(scene, [p(-w, th, l), p(w, th, l), apex], roofColour);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * w, th, -l), p(side * w, th, l), apex],
          mix(roofColour, scene.palette.ridges[2], side > 0 ? 0.22 : 0.1));
      }
    } else {
      // Pitched roof house with cream, white, or pale-yellow walls and terracotta, slate grey, or rust red roof
      addFace(scene, [p(-w, 0, -l), p(w, 0, -l), p(w, h, -l), p(-w, h, -l)], wall);
      addFace(scene, [p(-w, 0, l), p(w, 0, l), p(w, h, l), p(-w, h, l)], wall);
      for (const side of [-1, 1]) {
        addFace(scene, [p(side * w, 0, -l), p(side * w, 0, l), p(side * w, h, l), p(side * w, h, -l)],
          mix(wall, scene.palette.ridges[2], side > 0 ? 0.24 : 0.12));
        addFace(scene, [p(-w, h, side * l), p(w, h, side * l), p(0, roof, side * l)], wall);
        addFace(scene, [p(side * w, h, -l), p(side * w, h, l), p(0, roof, l), p(0, roof, -l)],
          side > 0 ? roofColour : mix(roofColour, scene.palette.ridges[2], 0.18));
      }
      if (base.scale >= 0.1 || dusk) {
        const windowColour = dusk ? '#ffaa33' : scene.palette.ridges[2];
        const options = { glow: dusk ? 9 : 0 };
        for (const side of [-1, 1]) {
          const z = side * (l + 0.04);
          for (const x of [-w * 0.45, w * 0.45]) {
            addFace(scene, [p(x - 0.8, h * 0.4, z), p(x + 0.8, h * 0.4, z),
              p(x + 0.8, h * 0.66, z), p(x - 0.8, h * 0.66, z)], windowColour, options);
          }
          for (const zCenter of [-l * 0.45, l * 0.45]) {
            const x = side * (w + 0.04);
            addFace(scene, [p(x, h * 0.4, zCenter - 0.8), p(x, h * 0.4, zCenter + 0.8),
              p(x, h * 0.66, zCenter + 0.8), p(x, h * 0.66, zCenter - 0.8)], windowColour, options);
          }
        }
      }
    }
  }
}

function strokeWorldLine(ctx, camera, vertices, colour, width) {
  ctx.beginPath();
  for (let i = 1; i < vertices.length; i++) {
    let a = toView(camera, vertices[i - 1]);
    let b = toView(camera, vertices[i]);
    if (a.z < NEAR && b.z < NEAR) continue;
    if (a.z < NEAR) a = interpolatePoint(a, b, (NEAR - a.z) / (b.z - a.z));
    if (b.z < NEAR) b = interpolatePoint(a, b, (NEAR - a.z) / (b.z - a.z));
    const pa = projectView(a);
    const pb = projectView(b);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.stroke();
}

function hoopPoints(ring, radiusScale = 1) {
  const heading = (ring.heading ?? 0) * RAD;
  const radius = (ring.radius ?? WORLD.ringRadiusMeters) * radiusScale;
  const points = [];
  for (let i = 0; i <= 64; i++) {
    const a = i / 64 * TAU;
    const lateral = Math.cos(a) * radius;
    points.push({ x: ring.position.x + lateral * Math.cos(heading),
      y: ring.position.y + Math.sin(a) * radius,
      z: ring.position.z - lateral * Math.sin(heading) });
  }
  return points;
}

function addBirds(scene, world, camera, seconds, dusk) {
  if (dusk) return;
  // Simple two-stroke gulls gliding slowly in the mid-distance of daytime scenes
  const flock = [
    { dz: 540, dx: 95, dy: 145, speed: 4.2, span: 2.2, phase: 0.0 },
    { dz: 610, dx: 130, dy: 158, speed: 4.0, span: 1.9, phase: 1.4 },
    { dz: 680, dx: 75, dy: 152, speed: 4.5, span: 2.4, phase: 2.7 },
    { dz: 750, dx: 160, dy: 165, speed: 3.8, span: 2.0, phase: 4.1 },
  ];
  for (const b of flock) {
    const flightZ = camera.z + b.dz + ((seconds * b.speed) % 360) - 180;
    const riverX = world.riverCenter(flightZ);
    const flightX = riverX + b.dx + Math.sin(seconds * 0.35 + b.phase) * 20;
    const flightY = b.dy + Math.sin(seconds * 0.5 + b.phase) * 3;
    const proj = project(scene.camera, { x: flightX, y: flightY, z: flightZ });
    if (!proj || proj.depth < NEAR || proj.depth > 3000) continue;
    if (proj.x < -20 || proj.x > WIDTH + 20 || proj.y < -20 || proj.y > HEIGHT + 20) continue;

    const spanPx = clamp(b.span * proj.scale, 3.5, 10);
    const dip = spanPx * 0.35;
    scene.items.push({
      depth: proj.depth,
      paint(ctx) {
        ctx.save();
        ctx.strokeStyle = mix(scene.palette.ridges[2], '#111820', 0.82);
        ctx.lineWidth = clamp(proj.scale * 0.16, 1.1, 1.8);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.globalAlpha = clamp(1 - proj.depth / 2800, 0.45, 0.85);
        ctx.beginPath();
        ctx.moveTo(proj.x - spanPx, proj.y - dip);
        ctx.quadraticCurveTo(proj.x - spanPx * 0.45, proj.y - dip * 0.15, proj.x, proj.y);
        ctx.quadraticCurveTo(proj.x + spanPx * 0.45, proj.y - dip * 0.15, proj.x + spanPx, proj.y - dip);
        ctx.stroke();
        ctx.restore();
      },
    });
  }
}

function addRings(scene, run, seconds, dusk) {
  // Endless mode replaces this array. world.rings is deliberately never read.
  for (const ring of run?.rings ?? []) {
    const view = toView(scene.camera, ring.position);
    const radius = ring.radius ?? WORLD.ringRadiusMeters;
    if (view.z + radius < NEAR || view.z - radius > WORLD.viewDistanceMeters) continue;
    const center = view.z >= NEAR ? projectView(view) : null;
    const screenRadius = radius * FOCAL / Math.max(NEAR, view.z - radius);
    if (center && (center.x + screenRadius < 0 || center.x - screenRadius > WIDTH
      || center.y + screenRadius < 0 || center.y - screenRadius > HEIGHT)) continue;
    const next = !ring.passed && (ring === run.nextRing || ring.id === run.nextRing?.id);
    const points = hoopPoints(ring);
    const width = clamp(FOCAL / Math.max(NEAR, view.z) * 0.65, 1.2, 7);

    // Chevron pointing along course direction inside the ring
    const angle = (ring.heading ?? 0) * RAD;
    const fx = Math.sin(angle);
    const fz = Math.cos(angle);
    const rx = Math.cos(angle);
    const rz = -Math.sin(angle);
    const tip = { x: ring.position.x + fx * 7.5, y: ring.position.y, z: ring.position.z + fz * 7.5 };
    const leftBarb = { x: ring.position.x - rx * 9.5 - fx * 3.5, y: ring.position.y, z: ring.position.z - rz * 9.5 - fz * 3.5 };
    const rightBarb = { x: ring.position.x + rx * 9.5 - fx * 3.5, y: ring.position.y, z: ring.position.z - rz * 9.5 - fz * 3.5 };

    scene.items.push({ depth: Math.max(NEAR, view.z), paint(ctx) {
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.globalAlpha = ring.passed ? 0.2 : next ? 1 : 0.76;
      if (ring.passed) ctx.setLineDash([5, 5]);
      if (!ring.passed) {
        ctx.shadowColor = scene.palette.ringGlow;
        ctx.shadowBlur = dusk ? 19 : 9;
        strokeWorldLine(ctx, scene.camera, points, scene.palette.ringGlow, width * 2.8);
      }
      ctx.shadowBlur = 0;
      strokeWorldLine(ctx, scene.camera, points, ring.passed ? scene.palette.ringGlow : scene.palette.ringCore, width);

      // Small bright chevron inside each ring pointing along the course direction
      const chevronAlpha = ring.passed ? 0.22 : next ? 1.0 : 0.85;
      ctx.globalAlpha = chevronAlpha;
      if (!ring.passed) {
        ctx.shadowColor = scene.palette.ringGlow;
        ctx.shadowBlur = dusk ? 16 : 8;
      }
      const chevronWidth = clamp(width * 1.35, 2.2, 8.5);
      strokeWorldLine(ctx, scene.camera, [leftBarb, tip, rightBarb],
        ring.passed ? scene.palette.ringGlow : scene.palette.ringCore, chevronWidth);

      if (next) {
        const pulse = 0.5 + 0.5 * Math.sin(seconds * 3.4);
        ctx.globalAlpha = 0.36 + pulse * 0.35;
        strokeWorldLine(ctx, scene.camera, hoopPoints(ring, 1.1 + pulse * 0.035), scene.palette.ringGlow,
          Math.max(1.3, width * 0.48));
      }
      ctx.restore();
    } });
  }
}

function drawRingGuide(ctx, scene, run, seconds) {
  const ring = run?.nextRing;
  if (!ring || ring.passed) return;
  const view = toView(scene.camera, ring.position);
  const point = view.z >= NEAR ? projectView(view) : null;
  const margin = 34;
  if (point && point.x >= margin && point.x <= WIDTH - margin
    && point.y >= margin && point.y <= HEIGHT - margin) return;
  const dx = point ? point.x - WIDTH / 2 : view.x;
  // A target directly astern points down instead of being mirrored by projection.
  const dy = point ? point.y - HEIGHT / 2 : Math.abs(view.z) * 0.65 - view.y;
  const magnitude = Math.hypot(dx, dy) || 1;
  const nx = magnitude === 1 && dx === 0 && dy === 0 ? 0 : dx / magnitude;
  const ny = dx === 0 && dy === 0 ? 1 : dy / magnitude;
  const distance = Math.min((WIDTH / 2 - margin) / Math.max(0.0001, Math.abs(nx)),
    (HEIGHT / 2 - margin) / Math.max(0.0001, Math.abs(ny)));
  ctx.save();
  ctx.translate(WIDTH / 2 + nx * distance, HEIGHT / 2 + ny * distance);
  ctx.rotate(Math.atan2(ny, nx));
  ctx.globalAlpha = 0.8 + 0.2 * Math.sin(seconds * 3.4);
  ctx.shadowColor = scene.palette.ringGlow;
  ctx.shadowBlur = 9;
  ctx.fillStyle = scene.palette.ringCore;
  ctx.strokeStyle = scene.palette.ringGlow;
  ctx.lineWidth = 2;
  tracePolygon(ctx, [{ x: 11, y: 0 }, { x: -8, y: -8 }, { x: -4, y: 0 }, { x: -8, y: 8 }]);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}


function addWorldLine(scene, vertices, colour, width, alpha = 1) {
  const depths = vertices.map(point => toView(scene.camera, point).z);
  if (Math.max(...depths) < NEAR || Math.min(...depths) > WORLD.viewDistanceMeters) return;
  scene.items.push({
    depth: depths.reduce((sum, depth) => sum + depth, 0) / depths.length,
    paint(ctx) {
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.lineCap = 'round';
      strokeWorldLine(ctx, scene.camera, vertices, colour, width);
      ctx.restore();
    },
  });
}

function addAircraftShadow(scene, world, plane) {
  const ground = world.groundHeight(plane.position.x, plane.position.z);
  const altitude = Math.max(0, plane.position.y - ground);
  if (altitude > 350) return;
  // Shrink as altitude grows
  const shrink = clamp(1 - altitude / 450, 0.22, 1.0);
  // Fade as altitude grows
  const fade = clamp(1 - altitude / 300, 0, 1) ** 1.6;
  if (fade <= 0.005) return;

  const halfWidth = 5.6 * shrink * Math.max(0.4, Math.cos(plane.bank * RAD));
  const halfLength = 3.6 * shrink;
  const reference = { position: { ...plane.position, y: ground }, heading: plane.heading };
  const shadowColour = mix(scene.palette.ridges[2], '#0a1016', 0.8);

  for (let layer = 6; layer >= 1; layer--) {
    const r = layer / 6;
    const points = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * TAU;
      const pt = localPoint(reference, Math.cos(a) * halfWidth * r, 0, Math.sin(a) * halfLength * r);
      pt.y = world.groundHeight(pt.x, pt.z) + 0.16 + (6 - layer) * 0.008;
      points.push(pt);
    }
    addFace(scene, points, shadowColour, {
      alpha: 0.055 * fade, haze: false,
    });
  }
}

function aircraftPoint(plane, x, y, z) {
  // Positive bank lowers the right wing; positive pitch raises the nose.
  // The model's wheel contact is y=0, matching the simulation's position datum.
  const bank = plane.bank * RAD;
  const pitch = plane.pitch * RAD;
  const bx = x * Math.cos(bank) + (y - 1.6) * Math.sin(bank);
  const by = (y - 1.6) * Math.cos(bank) - x * Math.sin(bank);
  const py = by * Math.cos(pitch) + z * Math.sin(pitch);
  const pz = z * Math.cos(pitch) - by * Math.sin(pitch);
  return localPoint(plane, bx, py + 1.6, pz);
}

function addAircraftFuselage(palette, edge, face) {
  // A tapered, faceted fuselage has actual volume with soft longitudinal and circumferential gradients
  const sections = [
    [-4.35, 0.85, 0.1, 0.15],
    [-3.3, 1.08, 0.22, 0.28],
    [-2.2, 1.35, 0.38, 0.48],
    [-1.0, 1.65, 0.54, 0.66],
    [0.35, 1.65, 0.68, 0.78],
    [1.55, 1.62, 0.64, 0.62],
    [2.65, 1.62, 0.50, 0.49],
    [3.15, 1.62, 0.42, 0.41],
  ];
  const sectionPoint = (section, angle) => [
    Math.cos(angle) * section[2], section[1] + Math.sin(angle) * section[3], section[0],
  ];
  const facets = 12;
  const noseZ = sections[sections.length - 1][0];
  const tailZ = sections[0][0];
  const totalLength = noseZ - tailZ;

  for (let i = 1; i < sections.length; i++) {
    const secZ = (sections[i][0] + sections[i - 1][0]) / 2;
    // Longitudinal gradient from warm forward cowl to gently shaded tail
    const longT = clamp((secZ - tailZ) / totalLength, 0, 1);
    const longColour = mix(mix(palette.aircraft, palette.ridges[2], 0.16),
      mix(palette.aircraft, '#fff4cc', 0.18), longT);

    for (let side = 0; side < facets; side++) {
      const a = (side / facets) * TAU;
      const b = ((side + 1) / facets) * TAU;
      const midA = (a + b) / 2;
      // Directional top-down and sunlit-right shading
      const topFactor = Math.sin(midA);
      const sunFactor = Math.cos(midA);
      const sunShade = 0.18 - topFactor * 0.18 - sunFactor * 0.08;
      const facetShade = clamp(sunShade, -0.15, 0.42);

      let colour;
      if (facetShade < 0) {
        colour = mix(longColour, '#fffcee', -facetShade * 0.8);
      } else {
        colour = mix(longColour, palette.ridges[2], facetShade);
      }
      face([sectionPoint(sections[i - 1], a), sectionPoint(sections[i], a),
        sectionPoint(sections[i], b), sectionPoint(sections[i - 1], b)],
      colour, { stroke: edge, lineWidth: 0.3 });
    }
  }
  // Nose front face
  face(Array.from({ length: facets }, (_, i) => sectionPoint(sections[sections.length - 1], (i / facets) * TAU)),
    mix(palette.aircraftTrim, palette.ridges[2], 0.2));
}

function addAircraftCanopy(palette, metal, face, line) {
  const glass = mix(palette.sky.top, palette.ridges[2], 0.42);
  const glint = mix(palette.sky.horizon, '#ffffff', 0.88);
  for (const side of [-1, 1]) {
    // Side window glass
    face([[side * 0.53, 1.95, -1.1], [side * 0.62, 1.94, 0.95],
      [side * 0.48, 2.48, 0.57], [side * 0.43, 2.45, -0.92]],
    glass, { stroke: metal, lineWidth: 0.85 });
    // Pale glint streak on side canopy
    face([[side * 0.51, 2.12, -0.75], [side * 0.57, 2.14, 0.45],
      [side * 0.53, 2.26, 0.35], [side * 0.47, 2.24, -0.85]],
    glint, { alpha: side > 0 ? 0.65 : 0.4 });
    // Window frames
    line([[side * 0.58, 1.98, -0.25], [side * 0.46, 2.44, -0.25]], metal, 0.045);
    line([[side * 0.28, 1.26, -2.75], [side * 0.5, 1.75, -1.18],
      [side * 0.66, 1.73, 1.55]], palette.aircraftTrim, 0.09);
  }
  // Windscreen (front glass)
  face([[-0.43, 2.45, -0.94], [0.43, 2.45, -0.94], [0.4, 1.98, -1.22], [-0.4, 1.98, -1.22]],
    glass, { stroke: metal, lineWidth: 0.85 });
  // Windscreen pale glint reflection
  face([[-0.24, 2.44, -0.94], [0.22, 2.44, -0.94], [0.12, 2.12, -1.15], [-0.34, 2.12, -1.15]],
    glint, { alpha: 0.75 });
  // Rear canopy glass
  face([[-0.48, 2.48, 0.57], [0.48, 2.48, 0.57], [0.55, 1.99, 1.27], [-0.55, 1.99, 1.27]],
    mix(glass, palette.riverHighlight, 0.25), { stroke: metal, lineWidth: 0.8 });
}

function addAircraftWingsAndFin(palette, edge, metal, prism, face, line) {
  // Main high wing
  prism([[-5.5, -0.68], [-5.5, 0.58], [-4.9, 1.02], [4.9, 1.02], [5.5, 0.58], [5.5, -0.68]],
    2.55, 2.7, palette.aircraft);

  // Red wingtips
  for (const side of [-1, 1]) {
    face([[side * 4.34, 2.712, -0.67], [side * 4.78, 2.712, -0.67],
      [side * 4.78, 2.712, 1.01], [side * 4.34, 2.712, 1.01]], palette.aircraftTrim);
    line([[side * 1.15, 2.715, -0.45], [side * 5.15, 2.715, -0.45]], edge, 0.025, 0.5);
    for (const x of [1.8, 3, 4.1]) {
      line([[side * x, 2.715, -0.66], [side * x, 2.715, 1]], edge, 0.02, 0.26);
    }
  }

  // Dark registration marking on upper starboard wing: "VM-42"
  const regColor = mix(palette.ridges[2], '#0e151b', 0.92);
  // 'V'
  line([[1.65, 2.716, 0.38], [1.95, 2.716, -0.32]], regColor, 0.075);
  line([[1.95, 2.716, -0.32], [2.25, 2.716, 0.38]], regColor, 0.075);
  // 'M'
  line([[2.45, 2.716, -0.32], [2.45, 2.716, 0.38]], regColor, 0.075);
  line([[2.45, 2.716, 0.38], [2.70, 2.716, -0.05]], regColor, 0.075);
  line([[2.70, 2.716, -0.05], [2.95, 2.716, 0.38]], regColor, 0.075);
  line([[2.95, 2.716, 0.38], [2.95, 2.716, -0.32]], regColor, 0.075);
  // '-'
  line([[3.18, 2.716, 0.05], [3.48, 2.716, 0.05]], regColor, 0.075);
  // '4'
  line([[3.95, 2.716, 0.38], [3.68, 2.716, -0.05]], regColor, 0.075);
  line([[3.68, 2.716, -0.05], [4.15, 2.716, -0.05]], regColor, 0.075);
  line([[3.95, 2.716, 0.38], [3.95, 2.716, -0.32]], regColor, 0.075);
  // '2'
  line([[4.32, 2.716, 0.32], [4.65, 2.716, 0.38]], regColor, 0.075);
  line([[4.65, 2.716, 0.38], [4.65, 2.716, 0.08]], regColor, 0.075);
  line([[4.65, 2.716, 0.08], [4.32, 2.716, -0.32]], regColor, 0.075);
  line([[4.32, 2.716, -0.32], [4.68, 2.716, -0.32]], regColor, 0.075);

  // Visible high-wing dual V-struts and jury struts on each side
  for (const side of [-1, 1]) {
    // Front wing strut
    line([[side * 0.58, 1.25, 0.28], [side * 3.45, 2.54, 0.24]], palette.aircraft, 0.11);
    line([[side * 0.58, 1.25, 0.28], [side * 3.45, 2.54, 0.24]], metal, 0.06);
    // Rear wing strut
    line([[side * 0.58, 1.25, -0.16], [side * 3.45, 2.54, -0.22]], metal, 0.09);
    // Jury vertical strut
    line([[side * 2.02, 1.88, 0.04], [side * 2.02, 2.56, 0.04]], metal, 0.07);
    // Jury horizontal cross-brace
    line([[side * 2.02, 1.88, 0.26], [side * 2.02, 1.88, -0.18]], metal, 0.06);
  }

  // Horizontal tailplane
  prism([[-2.05, -4.04], [-1.85, -3.1], [0, -2.8], [1.85, -3.1], [2.05, -4.04]],
    1.05, 1.17, palette.aircraftTrim);

  // Vertical fin & rudder with red tail stripes
  const fin = [[-4.3, 1.07], [-4.12, 2.38], [-3.64, 2.57], [-2.74, 1.08]];
  for (const side of [-1, 1]) {
    face(fin.map(([z, y]) => [side * 0.075, y, z]), palette.aircraftTrim,
      { stroke: edge, lineWidth: 0.8 });
    // Distinct red tail stripes alternating with cream on the rudder
    line([[side * 0.08, 1.45, -4.02], [side * 0.08, 1.45, -3.35]], palette.runwayMarkings, 0.06);
    line([[side * 0.08, 1.75, -4.05], [side * 0.08, 1.75, -3.42]], palette.aircraftTrim, 0.08);
    line([[side * 0.08, 2.05, -4.08], [side * 0.08, 2.05, -3.52]], palette.runwayMarkings, 0.06);
    line([[side * 0.08, 2.32, -4.10], [side * 0.08, 2.32, -3.62]], palette.aircraftTrim, 0.07);
    line([[side * 0.08, 1.21, -4.08], [side * 0.08, 2.33, -3.97]], palette.aircraft, 0.045);
  }
}

function addAircraftLandingGear(palette, edge, metal, tyre, face, line) {
  const wheel = (x, y, z, radius, thickness) => {
    const circumference = (offset, r) => Array.from({ length: 12 }, (_, i) => {
      const a = i / 12 * TAU;
      return [x + offset, y + Math.cos(a) * r, z + Math.sin(a) * r];
    });
    for (const side of [-1, 1]) {
      face(circumference(side * thickness / 2, radius), tyre, { stroke: edge, lineWidth: 0.4 });
      face(circumference(side * (thickness / 2 + 0.01), radius * 0.3), metal);
    }
    const a = circumference(-thickness / 2, radius);
    const b = circumference(thickness / 2, radius);
    for (let i = 0; i < 12; i++) {
      const next = (i + 1) % 12;
      face([a[i], b[i], b[next], a[next]], tyre);
    }
  };
  for (const side of [-1, 1]) {
    line([[side * 0.5, 1.23, 0.35], [side * 1.17, 0.43, 0.28]], palette.aircraftTrim, 0.12);
    line([[side * 0.45, 1.2, -0.65], [side * 1.17, 0.43, 0.28]], metal, 0.07);
    wheel(side * 1.2, 0.43, 0.28, 0.43, 0.25);
  }
  line([[0, 0.75, -4.05], [0, 0.22, -4.15]], metal, 0.08);
  wheel(0, 0.22, -4.15, 0.22, 0.14);
}

function addAircraftPropeller(palette, metal, face, plane, seconds) {
  const powered = plane.fuel > 0 && !plane.crashed;
  const throttle = clamp(plane.throttle, 0, 1);
  const phase = powered ? seconds * (22 + throttle * 64) : 0.4;
  const discZ = 3.32;
  const discRadius = 1.25;

  if (powered) {
    // Soft translucent blur disc
    const discSegments = 36;
    const discPoints = Array.from({ length: discSegments }, (_, i) => {
      const a = (i / discSegments) * TAU;
      return [Math.cos(a) * discRadius, 1.62 + Math.sin(a) * discRadius, discZ];
    });
    // Main translucent blur disc
    face(discPoints, palette.runwayMarkings, { alpha: 0.22 + throttle * 0.12 });

    // Outer tip blur ring (golden amber propeller tip ring)
    const tipOuter = discPoints;
    const tipInner = Array.from({ length: discSegments }, (_, i) => {
      const a = (i / discSegments) * TAU;
      return [Math.cos(a) * (discRadius * 0.88), 1.62 + Math.sin(a) * (discRadius * 0.88), discZ];
    });
    for (let i = 0; i < discSegments; i++) {
      const next = (i + 1) % discSegments;
      face([tipOuter[i], tipOuter[next], tipInner[next], tipInner[i]], palette.ringGlow, {
        alpha: 0.18 + throttle * 0.10,
      });
    }

    // Subtle motion blur blade sweeps trailing with rotation phase
    for (let blade = 0; blade < 2; blade++) {
      const a = phase + blade * Math.PI;
      const arcPoints = [
        [0, 1.62, discZ],
        [Math.cos(a - 0.35) * discRadius, 1.62 + Math.sin(a - 0.35) * discRadius, discZ],
        [Math.cos(a) * discRadius, 1.62 + Math.sin(a) * discRadius, discZ],
      ];
      face(arcPoints, metal, { alpha: 0.20 + throttle * 0.08 });
    }
  } else {
    // Stopped/idle propeller blades
    for (let blade = 0; blade < 2; blade++) {
      const a = phase + blade * Math.PI;
      const bladePoint = (radius, offset) => [Math.cos(a + offset) * radius,
        1.62 + Math.sin(a + offset) * radius, discZ];
      face([bladePoint(0.14, -0.25), bladePoint(1.20, -0.065),
        bladePoint(1.20, 0.065), bladePoint(0.14, 0.25)],
      metal, { alpha: 0.85 });
    }
  }

  // Bright polished spinner (bullet cone) at the hub
  const spinnerSegments = 12;
  const hubRadius = 0.22;
  const hubZ = discZ;
  const tipZ = discZ + 0.38;
  const hubRing = Array.from({ length: spinnerSegments }, (_, i) => {
    const a = (i / spinnerSegments) * TAU;
    return [Math.cos(a) * hubRadius, 1.62 + Math.sin(a) * hubRadius, hubZ];
  });
  const apex = [0, 1.62, tipZ];

  for (let i = 0; i < spinnerSegments; i++) {
    const next = (i + 1) % spinnerSegments;
    const a = (i / spinnerSegments) * TAU;
    const midAngle = a + Math.PI / spinnerSegments;
    // Upper and right facets catch bright sun glint (polished chrome)
    const glintFactor = Math.sin(midAngle) * 0.5 + Math.cos(midAngle) * 0.35;
    let spinnerColor;
    if (glintFactor > 0.1) {
      spinnerColor = mix('#ffffff', '#e2ebf5', 1 - glintFactor);
    } else {
      spinnerColor = mix('#c0cbd8', '#8695a5', -glintFactor);
    }
    face([hubRing[i], hubRing[next], apex], spinnerColor);
  }
  // Sharp specular glint point on the spinner tip
  face([
    [-0.03, 1.63, tipZ], [0.03, 1.63, tipZ],
    [0.02, 1.60, tipZ], [-0.02, 1.60, tipZ],
  ], '#ffffff');
}

function addAircraft(scene, plane, seconds) {
  const palette = scene.palette;
  const edge = mix(palette.aircraftTrim, palette.ridges[2], 0.42);
  const metal = mix(palette.runwayMarkings, palette.ridges[2], 0.4);
  const tyre = mix(palette.ridges[2], '#11151b', 0.9);
  const point = (x, y, z) => aircraftPoint(plane, x, y, z);
  const face = (vertices, colour, options = {}) => addFace(scene,
    vertices.map(vertex => point(...vertex)), colour, { haze: false, ...options });
  const line = (vertices, colour, metres = 0.055, alpha = 1) => {
    const points = vertices.map(vertex => point(...vertex));
    const depth = toView(scene.camera, points[0]).z;
    addWorldLine(scene, points, colour, clamp(metres * FOCAL / Math.max(NEAR, depth), 0.55, 4), alpha);
  };
  const prism = (outline, bottom, top, colour) => {
    face(outline.map(([x, z]) => [x, top, z]), colour, { stroke: edge, lineWidth: 0.65 });
    face(outline.map(([x, z]) => [x, bottom, z]), mix(colour, palette.ridges[2], 0.23));
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      face([[a[0], bottom, a[1]], [b[0], bottom, b[1]], [b[0], top, b[1]], [a[0], top, a[1]]],
        mix(colour, palette.ridges[2], 0.16), { stroke: edge, lineWidth: 0.5 });
    }
  };

  addAircraftFuselage(palette, edge, face);
  addAircraftCanopy(palette, metal, face, line);
  addAircraftWingsAndFin(palette, edge, metal, prism, face, line);
  if (plane.gearDown) {
    addAircraftLandingGear(palette, edge, metal, tyre, face, line);
  }
  addAircraftPropeller(palette, metal, face, plane, seconds);
}

function addParcelTarget(scene, world, run, seconds) {
  if (!(run?.sortie?.requiresParcelDrop || run?.sortie?.id === 2)) return;
  const target = run.parcel?.target ?? world.village;
  if (!target) return;
  const bounds = target.bounds ?? target;
  const position = target.position ?? {
    x: (bounds.minX + bounds.maxX) / 2, z: (bounds.minZ + bounds.maxZ) / 2,
  };
  if (!Number.isFinite(position.x) || !Number.isFinite(position.z)) return;
  const y = world.groundHeight(position.x, position.z);
  const center = { x: position.x, y: y + 30, z: position.z };
  const screen = project(scene.camera, center);
  if (!screen || screen.depth > WORLD.viewDistanceMeters) return;
  const radius = clamp(Math.min(bounds.maxX - bounds.minX || 80,
    bounds.maxZ - bounds.minZ || 80) * 0.24, 18, 40);
  const circle = Array.from({ length: 49 }, (_, i) => {
    const a = i / 48 * TAU;
    return { x: position.x + Math.cos(a) * radius, y: y + 0.35,
      z: position.z + Math.sin(a) * radius };
  });
  scene.items.push({ depth: screen.depth, paint(ctx) {
    ctx.save();
    const resolved = run.parcel?.status === 'hit' || run.parcel?.status === 'missed';
    ctx.globalAlpha = resolved ? 0.32 : 0.72 + 0.16 * Math.sin(seconds * 2.8);
    ctx.shadowColor = scene.palette.ringGlow;
    ctx.shadowBlur = 8;
    ctx.setLineDash([8, 6]);
    strokeWorldLine(ctx, scene.camera, circle, scene.palette.ringGlow,
      clamp(screen.scale * 0.7, 1.3, 4));
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;
    strokeWorldLine(ctx, scene.camera, [{ ...center, y: y + 2 }, center], scene.palette.ringGlow, 1.2);
    if (screen.x > -30 && screen.x < WIDTH + 30 && screen.y > -30 && screen.y < HEIGHT + 30) {
      const size = clamp(screen.scale * 5, 6, 19);
      ctx.translate(screen.x, screen.y);
      tracePolygon(ctx, [{ x: 0, y: -size }, { x: size, y: 0 },
        { x: 0, y: size }, { x: -size, y: 0 }]);
      ctx.fillStyle = scene.palette.ringGlow;
      ctx.globalAlpha *= 0.22;
      ctx.fill();
      ctx.globalAlpha /= 0.22;
      ctx.strokeStyle = scene.palette.ringCore;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-size * 0.4, 0);
      ctx.lineTo(0, size * 0.4);
      ctx.lineTo(size * 0.4, 0);
      ctx.stroke();
    }
    ctx.restore();
  } });
}

function addFallingParcel(scene, world, parcel, seconds) {
  if (parcel?.status !== 'falling' || !parcel.position) return;
  const projected = project(scene.camera, parcel.position);
  if (!projected || projected.depth > WORLD.viewDistanceMeters) return;
  const reference = { position: parcel.position, heading: seconds * 47 % 360 };
  const p = (x, y, z) => localPoint(reference, x, y, z);
  const half = 1.2;
  const colour = scene.palette.fields[3];
  const band = scene.palette.runwayMarkings;
  const face = (points, fill) => addFace(scene, points, fill, { stroke: scene.palette.aircraftTrim, lineWidth: 0.6 });
  face(rectangle(reference, -half, half, -half, half, half), colour);
  face(rectangle(reference, -half, half, -half, half, -half), colour);
  for (const side of [-1, 1]) {
    const edge = side * half;
    face([p(edge, -half, -half), p(edge, half, -half), p(edge, half, half), p(edge, -half, half)],
      mix(colour, scene.palette.ridges[2], 0.2));
    face([p(-half, -half, edge), p(half, -half, edge), p(half, half, edge), p(-half, half, edge)], colour);
    addFace(scene, [p(-0.15, -half, edge * 1.01), p(0.15, -half, edge * 1.01),
      p(0.15, half, edge * 1.01), p(-0.15, half, edge * 1.01)], band);
  }
  addFace(scene, rectangle(reference, -0.15, 0.15, -half, half, half + 0.02), band);
  addFace(scene, rectangle(reference, -half, half, -0.15, 0.15, half + 0.03), band);
  if (parcel.velocity) {
    addWorldLine(scene, [parcel.position, {
      x: parcel.position.x - parcel.velocity.x * 0.12,
      y: parcel.position.y - parcel.velocity.y * 0.12,
      z: parcel.position.z - parcel.velocity.z * 0.12,
    }], scene.palette.riverHighlight, 1.1, 0.3);
  }
  const ground = world.groundHeight(parcel.position.x, parcel.position.z);
  const shadow = Array.from({ length: 20 }, (_, i) => {
    const a = i / 20 * TAU;
    return { x: parcel.position.x + Math.cos(a) * 1.8, y: ground + 0.3,
      z: parcel.position.z + Math.sin(a) * 1.1 };
  });
  addFace(scene, shadow, scene.palette.ridges[2], { alpha: 0.18 });
}

function drawSpeedStreaks(ctx, plane, palette, seconds) {
  const strength = clamp((plane.airspeedKnots - 105) / 30, 0, 1);
  if (strength <= 0) return;
  ctx.save();
  ctx.strokeStyle = palette.riverHighlight;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const angle = i * 2.399963;
    const progress = (seconds * (0.45 + strength * 0.2) + i * 0.618034) % 1;
    const radius = 0.45 + progress * 0.85;
    const dx = Math.cos(angle) * WIDTH * 0.75;
    const dy = Math.sin(angle) * HEIGHT;
    const x = WIDTH / 2 + dx * radius;
    const y = HORIZON + dy * radius;
    if (x > WIDTH * 0.23 && x < WIDTH * 0.77 && y < HEIGHT * 0.87) continue;
    const length = 0.012 + strength * 0.025;
    ctx.globalAlpha = strength * 0.13 * Math.sin(progress * Math.PI);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + dx * length, y + dy * length);
    ctx.stroke();
  }
  ctx.restore();
}

/** Paint one complete frame in 1280 × 720 design coordinates. */
export function draw(ctx, world, plane, run) {
  const paletteKey = run?.sortie?.palette ?? world.paletteName ?? 'day';
  const palette = PALETTES[paletteKey] ?? world.palette ?? PALETTES.day;
  const dusk = paletteKey === 'dusk';
  const seconds = Number.isFinite(run?.elapsedSeconds) ? run.elapsedSeconds : 0;
  const camera = createCamera(world, plane);
  const scene = { camera, palette, items: [] };
  const features = world.featuresInWindow(camera.z - WORLD.viewDistanceMeters,
    camera.z + WORLD.viewDistanceMeters);
  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.rect(0, 0, WIDTH, HEIGHT);
    ctx.clip();
    drawSky(ctx, camera, palette, dusk);
    drawTerrain(ctx, scene, world, dusk);
    addFields(scene, features.fields ?? []);
    addPonds(scene, features.ponds ?? world.ponds ?? []);
    addRoads(scene, features.roads ?? world.roads ?? []);
    addFences(scene, features.fences ?? world.fences ?? []);
    addHayBales(scene, features.hayBales ?? world.hayBales ?? []);
    paintItems(ctx, scene);
    addRiver(scene, world);
    paintItems(ctx, scene);
    addBridge(scene, features.bridges ?? world.bridges ?? []);
    addStrips(scene, features.airstrips ?? world.airstrips ?? [], dusk);
    paintItems(ctx, scene);
    addCloudShadows(scene, world, features.clouds ?? world.clouds ?? [], seconds);
    addAircraftShadow(scene, world, plane);
    paintItems(ctx, scene);
    drawSpeedStreaks(ctx, plane, palette, seconds);
    addClouds(scene, world, features.clouds ?? world.clouds ?? [], seconds, dusk);
    addBirds(scene, world, camera, seconds, dusk);
    addTrees(scene, features);
    addHouses(scene, features, dusk);
    addWindmill(scene, features.landmarks ?? world.landmarks ?? [], seconds);
    addWindsocks(scene, features.airstrips ?? world.airstrips ?? [], seconds);
    addRings(scene, run, seconds, dusk);
    addParcelTarget(scene, world, run, seconds);
    addFallingParcel(scene, world, run?.parcel, seconds);
    drawObstacles(ctx, world.obstacles ?? run?.obstacles, (pt) => project(camera, pt), palette, seconds);
    addAircraft(scene, plane, seconds);
    paintItems(ctx, scene);
    drawRingGuide(ctx, scene, run, seconds);
    drawWeatherLayer(ctx, run?.weather ?? world.weather, camera, palette);
  } finally {
    ctx.restore();
  }
}
