/**
 * Draw Valley Mail's world, route markers and chase-view aircraft on a 2D canvas.
 * Exports: draw(ctx, world, plane, run). All helpers are private; no HUD or logic.
 * Drawing uses CANVAS design coordinates, preserving the caller's canvas transform.
 * Camera and effect time are derived from state; rendering never changes that state.
 */
import { CANVAS, WORLD, PALETTES } from './config.js';

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
  const x = plane.position.x - sin * 30;
  const z = plane.position.z - cos * 30;
  return {
    x, z, sin, cos,
    y: Math.max(plane.position.y + 11.5, world.groundHeight(x, z) + 6),
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

function drawSky(ctx, camera, palette, dusk) {
  const sky = ctx.createLinearGradient(0, 0, 0, HEIGHT * 0.76);
  sky.addColorStop(0, palette.sky.top);
  sky.addColorStop(0.62, palette.sky.horizon);
  sky.addColorStop(1, palette.sky.horizon);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // A fixed world bearing lets the sun travel out of frame when the pilot turns.
  const sun = project(camera, {
    x: camera.x - 18000, y: camera.y + (dusk ? 4000 : 6600), z: camera.z + 35000,
  });
  if (sun && sun.x > -120 && sun.x < WIDTH + 120 && sun.y > -120 && sun.y < HEIGHT) {
    const radius = dusk ? 24 : 19;
    const glow = ctx.createRadialGradient(sun.x, sun.y, radius, sun.x, sun.y, radius * 4.5);
    glow.addColorStop(0, palette.sky.horizon);
    glow.addColorStop(1, 'rgba(255,225,175,0)');
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = glow;
    ctx.fillRect(sun.x - 110, sun.y - 110, 220, 220);
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = mix(palette.ringCore, palette.sky.horizon, dusk ? 0.28 : 0.12);
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = mix(palette.fields[0], palette.sky.horizon, 0.48);
  ctx.fillRect(0, HORIZON, WIDTH, HEIGHT - HORIZON);
}

function drawTerrain(ctx, scene, world) {
  const step = WORLD.terrainSegmentLengthMeters;
  const from = Math.floor((scene.camera.z - WORLD.viewDistanceMeters) / step) * step;
  const to = scene.camera.z + WORLD.viewDistanceMeters;
  const half = WORLD.valleyWidthMeters / 2;
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
  paintItems(ctx, scene);
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
  const from = Math.floor((scene.camera.z - WORLD.viewDistanceMeters) / step) * step;
  const to = scene.camera.z + WORLD.viewDistanceMeters;
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

function addStrips(scene, strips) {
  for (const strip of strips) {
    const width = strip.width ?? WORLD.runwayWidthMeters;
    const length = strip.length ?? WORLD.runwayLengthMeters;
    for (let back = -length / 2; back < length / 2; back += 40) {
      const front = Math.min(back + 40, length / 2);
      addFace(scene, rectangle(strip, -width / 2 - 3, width / 2 + 3, back, front, 0.18), scene.palette.fields[1]);
      addFace(scene, rectangle(strip, -width / 2, width / 2, back, front, 0.2), scene.palette.runway);
    }
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
    for (let z = -length / 2 + 65; z < length / 2 - 35; z += 50) {
      addFace(scene, rectangle(strip, -0.65, 0.65, z, z + 15, 0.26), scene.palette.runwayMarkings);
    }
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
    const colour = mix(scene.palette.fields[0], scene.palette.ridges[2], 0.52);
    // Billboards remain upright in world space; the stable camera has no roll.
    scene.items.push({ depth: base.depth, paint(ctx) {
      ctx.fillStyle = scene.palette.aircraftTrim;
      ctx.fillRect(base.x - Math.max(0.5, base.scale * 0.4), base.y - height * base.scale * 0.35,
        Math.max(1, base.scale * 0.8), height * base.scale * 0.35);
      ctx.fillStyle = haze ? mix(scene.palette.ridges[2], scene.palette.sky.horizon, haze) : colour;
      tracePolygon(ctx, [{ x: base.x, y: top.y }, { x: base.x + size, y: base.y - height * base.scale * 0.18 },
        { x: base.x - size, y: base.y - height * base.scale * 0.18 }]);
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
    if (base.x < -w * base.scale * 2 || base.x > WIDTH + w * base.scale * 2
      || base.y < -40 || base.y - roof * base.scale > HEIGHT) continue;
    const p = (x, y, z) => localPoint(house, x, y, z);
    const wall = scene.palette.runwayMarkings;
    addFace(scene, [p(-w, 0, -l), p(w, 0, -l), p(w, h, -l), p(-w, h, -l)], wall);
    addFace(scene, [p(-w, 0, l), p(w, 0, l), p(w, h, l), p(-w, h, l)], wall);
    for (const side of [-1, 1]) {
      addFace(scene, [p(side * w, 0, -l), p(side * w, 0, l), p(side * w, h, l), p(side * w, h, -l)],
        mix(wall, scene.palette.ridges[2], side > 0 ? 0.25 : 0.12));
      addFace(scene, [p(-w, h, side * l), p(w, h, side * l), p(0, roof, side * l)], wall);
      addFace(scene, [p(side * w, h, -l), p(side * w, h, l), p(0, roof, l), p(0, roof, -l)],
        side > 0 ? scene.palette.aircraftTrim : mix(scene.palette.aircraftTrim, scene.palette.ridges[2], 0.18));
    }
    if (base.scale < 0.3) continue;
    const windowColour = dusk ? scene.palette.ringCore : scene.palette.ridges[2];
    const options = { glow: dusk ? 5 : 0 };
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
  if (altitude > 1000) return;
  const spread = 1 + Math.min(altitude / 200, 1.5) * 0.5;
  const halfWidth = 5.5 * spread * Math.max(0.4, Math.cos(plane.bank * RAD));
  const halfLength = 3.1 * spread;
  const reference = { position: { ...plane.position, y: ground }, heading: plane.heading };
  // Nested translucent ground polygons make a soft ellipse in perspective, and
  // keep the shadow attached to the actual surface as altitude changes.
  for (let layer = 8; layer >= 1; layer--) {
    const radius = 0.38 + layer * 0.095;
    const points = [];
    for (let i = 0; i < 32; i++) {
      const a = i / 32 * TAU;
      const point = localPoint(reference, Math.cos(a) * halfWidth * radius, 0,
        Math.sin(a) * halfLength * radius);
      point.y = world.groundHeight(point.x, point.z) + 0.28 + (8 - layer) * 0.005;
      points.push(point);
    }
    addFace(scene, points, mix(scene.palette.ridges[2], '#101a20', 0.65), {
      alpha: 0.025 * (1 - altitude / 1150), haze: false,
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

  // A tapered, faceted fuselage has actual volume from every bank and pitch,
  // rather than a flat aircraft icon rotated over the world.
  const sections = [
    [-4.35, 0.85, 0.1, 0.15], [-2.8, 1.15, 0.27, 0.35],
    [-1.25, 1.65, 0.5, 0.62], [0.25, 1.65, 0.67, 0.78],
    [1.5, 1.62, 0.64, 0.61], [2.65, 1.62, 0.49, 0.48], [3.15, 1.62, 0.42, 0.41],
  ];
  const sectionPoint = (section, angle) => [
    Math.cos(angle) * section[2], section[1] + Math.sin(angle) * section[3], section[0],
  ];
  for (let i = 1; i < sections.length; i++) {
    for (let side = 0; side < 10; side++) {
      const a = side / 10 * TAU;
      const b = (side + 1) / 10 * TAU;
      const shade = clamp(0.15 - Math.sin((a + b) / 2) * 0.12, 0.02, 0.29);
      face([sectionPoint(sections[i - 1], a), sectionPoint(sections[i], a),
        sectionPoint(sections[i], b), sectionPoint(sections[i - 1], b)],
      mix(palette.aircraft, palette.ridges[2], shade), { stroke: edge, lineWidth: 0.35 });
    }
  }
  face(Array.from({ length: 10 }, (_, i) => sectionPoint(sections[sections.length - 1], i / 10 * TAU)),
    mix(palette.aircraftTrim, palette.ridges[2], 0.24));

  const glass = mix(palette.sky.top, palette.ridges[2], 0.54);
  for (const side of [-1, 1]) {
    face([[side * 0.53, 1.95, -1.1], [side * 0.62, 1.94, 0.95],
      [side * 0.48, 2.48, 0.57], [side * 0.43, 2.45, -0.92]],
    glass, { stroke: metal, lineWidth: 0.85 });
    line([[side * 0.58, 1.98, -0.25], [side * 0.46, 2.44, -0.25]], metal, 0.045);
    line([[side * 0.28, 1.26, -2.75], [side * 0.5, 1.75, -1.18],
      [side * 0.66, 1.73, 1.55]], palette.aircraftTrim, 0.09);
  }
  face([[-0.43, 2.45, -0.94], [0.43, 2.45, -0.94], [0.4, 1.98, -1.22], [-0.4, 1.98, -1.22]],
    glass, { stroke: metal, lineWidth: 0.85 });
  face([[-0.48, 2.48, 0.57], [0.48, 2.48, 0.57], [0.55, 1.99, 1.27], [-0.55, 1.99, 1.27]],
    mix(glass, palette.riverHighlight, 0.2), { stroke: metal, lineWidth: 0.8 });

  prism([[-5.5, -0.68], [-5.5, 0.58], [-4.9, 1.02], [4.9, 1.02], [5.5, 0.58], [5.5, -0.68]],
    2.55, 2.7, palette.aircraft);
  for (const side of [-1, 1]) {
    face([[side * 4.34, 2.712, -0.67], [side * 4.78, 2.712, -0.67],
      [side * 4.78, 2.712, 1.01], [side * 4.34, 2.712, 1.01]], palette.aircraftTrim);
    line([[side * 1.15, 2.715, -0.45], [side * 5.15, 2.715, -0.45]], edge, 0.025, 0.5);
    line([[side * 0.52, 1.16, 0.25], [side * 3.7, 2.55, 0.2]], metal, 0.075);
    for (const x of [1.8, 3, 4.1]) {
      line([[side * x, 2.715, -0.66], [side * x, 2.715, 1]], edge, 0.02, 0.26);
    }
  }

  prism([[-2.05, -4.04], [-1.85, -3.1], [0, -2.8], [1.85, -3.1], [2.05, -4.04]],
    1.05, 1.17, palette.aircraftTrim);
  const fin = [[-4.3, 1.07], [-4.12, 2.38], [-3.64, 2.57], [-2.74, 1.08]];
  for (const side of [-1, 1]) {
    face(fin.map(([z, y]) => [side * 0.075, y, z]), palette.aircraftTrim,
      { stroke: edge, lineWidth: 0.8 });
    line([[side * 0.08, 1.21, -4.08], [side * 0.08, 2.33, -3.97]], palette.aircraft, 0.045);
  }

  if (plane.gearDown) {
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

  const powered = plane.fuel > 0 && !plane.crashed;
  const throttle = clamp(plane.throttle, 0, 1);
  const phase = powered ? seconds * (22 + throttle * 64) : 0.4;
  if (powered) {
    face(Array.from({ length: 48 }, (_, i) => {
      const a = i / 48 * TAU;
      return [Math.cos(a) * 1.2, 1.62 + Math.sin(a) * 1.2, 3.28];
    }), palette.runwayMarkings, { alpha: 0.08 + throttle * 0.08 });
  }
  for (let blade = 0; blade < 2; blade++) {
    const a = phase + blade * Math.PI;
    const bladePoint = (radius, offset) => [Math.cos(a + offset) * radius,
      1.62 + Math.sin(a + offset) * radius, 3.31];
    face([bladePoint(0.13, -0.25), bladePoint(1.17, -0.065),
      bladePoint(1.17, powered ? 0.32 : 0.065), bladePoint(0.13, 0.25)],
    metal, { alpha: powered ? 0.27 : 0.85 });
  }
  const hub = Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * TAU;
    return [Math.cos(a) * 0.18, 1.62 + Math.sin(a) * 0.18, 3.33];
  });
  for (let i = 0; i < hub.length; i++) {
    face([hub[i], hub[(i + 1) % hub.length], [0, 1.62, 3.62]], palette.aircraftTrim);
  }
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
    drawTerrain(ctx, scene, world);
    addFields(scene, features.fields ?? []);
    paintItems(ctx, scene);
    addRiver(scene, world);
    paintItems(ctx, scene);
    addStrips(scene, features.airstrips ?? world.airstrips ?? []);
    paintItems(ctx, scene);
    addAircraftShadow(scene, world, plane);
    paintItems(ctx, scene);
    drawSpeedStreaks(ctx, plane, palette, seconds);
    addTrees(scene, features);
    addHouses(scene, features, dusk);
    addWindsocks(scene, features.airstrips ?? world.airstrips ?? [], seconds);
    addRings(scene, run, seconds, dusk);
    addParcelTarget(scene, world, run, seconds);
    addFallingParcel(scene, world, run?.parcel, seconds);
    addAircraft(scene, plane, seconds);
    paintItems(ctx, scene);
    drawRingGuide(ctx, scene, run, seconds);
  } finally {
    ctx.restore();
  }
}
