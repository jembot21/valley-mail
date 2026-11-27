/**
 * Stage Valley Mail's four deterministic screenshot scenes using the game renderer.
 * Exports: stageShot(canvas, ctx?) -> boolean.
 *
 * Staged scenes for contact sheet:
 *   1. 'cover' / 'title' — Title menu with game name, "PRESS ENTER TO FLY", and sortie list.
 *   2. 'ring' / 'gorge' — Alpine gorge daytime flight with glowing ring, suspension bridge, and HUD.
 *   3. 'dusk' — Twilight dusk river flight with amber horizon, runway lights, and approach HUD.
 *   4. 'upgrade' / 'results' — Aircraft hangar with upgrades catalog, bank balance, and equipped parts.
 *
 * Canvas size: 1280x480 widescreen format conforming to competition constraints (<= 1280x480, <= 256 KiB).
 */
import { SHOT_NAMES, readShotName, PALETTES } from './config.js';
import { createPlane } from './plane.js';
import { SORTIES, createSortieWorld, createRun } from './missions.js';
import { UPGRADE_DEFINITIONS, createProgressionState } from './progression.js';
import { draw } from './render.js';
import { drawHUD } from './hud.js';

const SHOT_WIDTH = 1280;
const SHOT_HEIGHT = 480;

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
  plane.altitude = plane.position.y;
  plane.agl = world.clearance(plane.position);
}

function drawPanel(ctx, x, y, width, height, outline = '#ffd76c', fill = '#102330') {
  ctx.save();
  ctx.globalAlpha = 0.94;
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

function drawText(ctx, value, x, y, size, colour = '#fff5df', weight = 700, align = 'left') {
  ctx.font = `${weight} ${size}px "Courier New", monospace`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';
  ctx.fillText(String(value), x, y);
}

function stageTitleScene(ctx) {
  const world = createSortieWorld(SORTIES[0]);
  const plane = createPlane(world);
  setFlight(plane, world, {
    position: { x: world.riverCenter(1450) + 40, y: 72, z: 1450 },
    heading: 182,
    pitch: 2.0,
    bank: -4,
    airspeedKnots: 86,
    throttle: 0.70,
  });
  const run = createRun(SORTIES[0], world, world.rings, plane);
  draw(ctx, world, plane, run);

  // Title menu card
  drawPanel(ctx, 40, 20, 940, 440, '#ffd76c', '#102330');
  drawText(ctx, 'VALLEY MAIL', 65, 36, 44, '#fff5df', 900);
  drawText(ctx, 'Bush-pilot mail delivery down rugged mountain river corridors.', 68, 86, 17, '#bfdbd9', 400);
  drawText(ctx, 'Controls: Pitch W/S · Bank A/D · Throttle Shift/Ctrl · Gear G · Drop Space', 68, 110, 14, '#9fbac0', 400);

  drawText(ctx, 'CAMPAIGN SORTIES', 68, 140, 16, '#ffd76c', 700);

  const sortieY = 166;
  const list = [
    { num: 1, name: 'First Post', detail: 'Valley training run · 5 mail rings · Clear skies', best: '9,450', active: true },
    { num: 2, name: 'Cargo Drop', detail: 'Riverton drop zone · Church square target · 6 rings', best: '8,200', active: false },
    { num: 3, name: 'Gorge Navigation', detail: 'Alpine gorge & suspension bridge · 7 rings', best: '—', active: false },
    { num: 4, name: 'Storm Pass', detail: 'Squall winds & radio mast hazard · 8 rings', best: '—', active: false },
    { num: 5, name: 'Dusk Run', detail: 'Twilight runway lights · tight fuel tank · 8 rings', best: '—', active: false },
  ];

  list.forEach((item, i) => {
    const y = sortieY + i * 44;
    ctx.save();
    ctx.fillStyle = item.active ? 'rgba(255, 215, 108, 0.18)' : 'rgba(255, 215, 108, 0.05)';
    ctx.fillRect(68, y, 884, 38);
    if (item.active) {
      ctx.strokeStyle = '#ffd76c';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(68, y, 884, 38);
    }
    ctx.restore();

    drawText(ctx, `${item.num}  ${item.name}`, 82, y + 8, 18, item.active ? '#ffd76c' : '#fff5df', 700);
    drawText(ctx, item.detail, 270, y + 10, 14, '#bfdbd9', 400);
    if (item.best !== '—') drawText(ctx, `Best: ${item.best}`, 930, y + 10, 14, '#ffd76c', 600, 'right');
  });

  // Action buttons
  ctx.save();
  ctx.fillStyle = '#ffd76c';
  ctx.fillRect(68, 396, 340, 48);
  drawText(ctx, 'ENTER / SPACE · PLAY', 238, 410, 20, '#102330', 800, 'center');

  ctx.fillStyle = 'rgba(255, 215, 108, 0.15)';
  ctx.fillRect(430, 396, 280, 48);
  ctx.strokeStyle = '#ffd76c';
  ctx.strokeRect(430, 396, 280, 48);
  drawText(ctx, 'H · HANGAR UPGRADES', 570, 411, 18, '#ffd76c', 700, 'center');
  ctx.restore();
}

function stageGorgeFlightScene(ctx) {
  const sortie = SORTIES[2] ?? SORTIES[0];
  const world = createSortieWorld(sortie);
  const target = world.rings[2];
  const nextTarget = world.rings[3];
  const plane = createPlane(world);
  const position = { x: target.position.x - 6, y: target.position.y + 4, z: target.position.z - 8 };

  setFlight(plane, world, {
    position,
    heading: headingTo(position, nextTarget.position, -3),
    pitch: 1.8,
    bank: -12,
    airspeedKnots: 94,
    throttle: 0.78,
    fuel: 82,
    hull: 100,
  });

  world.rings.forEach((ring, index) => { ring.passed = index < 2; });
  const run = createRun(sortie, world, world.rings, plane);
  run.elapsedSeconds = 48;
  run.combo.streak = 3;
  run.combo.multiplier = 2.0;
  run.combo.timerSeconds = 12.0;
  run.ringsHit = 3;
  run.score = 4250;

  draw(ctx, world, plane, run);
  drawHUD(ctx, plane, run, world.palette, 'RING THREADED · COMBO x2.0');
}

function stageDuskFlightScene(ctx) {
  const sortie = SORTIES[4] ?? SORTIES[SORTIES.length - 2];
  const world = createSortieWorld(sortie);
  const strip = world.destination;
  const plane = createPlane(world);
  const z = strip.bounds.minZ - 210;
  const x = strip.position.x + 8;
  const position = { x, y: world.groundHeight(x, z) + 32, z };

  setFlight(plane, world, {
    position,
    heading: strip.heading,
    pitch: 2.2,
    bank: 2,
    airspeedKnots: 56,
    verticalSpeed: -1.4,
    throttle: 0.35,
    gearDown: true,
    fuel: 38,
    hull: 94,
  });

  world.rings.forEach((ring, index) => { ring.passed = index < 7; });
  const run = createRun(sortie, world, world.rings, plane);
  run.elapsedSeconds = 112;
  run.ringsHit = 7;
  run.score = 8800;

  draw(ctx, world, plane, run);
  drawHUD(ctx, plane, run, world.palette, 'GEAR DOWN · FINAL APPROACH');
}

function stageUpgradeHangarScene(ctx) {
  const world = createSortieWorld(SORTIES[0]);
  const plane = createPlane(world);
  setFlight(plane, world, {
    position: { x: world.riverCenter(1200), y: 65, z: 1200 },
    heading: 180,
    pitch: 1.0,
    bank: 0,
    airspeedKnots: 80,
  });
  const run = createRun(SORTIES[0], world, world.rings, plane);
  draw(ctx, world, plane, run);

  // Hangar overlay
  drawPanel(ctx, 40, 20, 1200, 440, '#ffd76c', '#102330');
  drawText(ctx, 'AIRCRAFT HANGAR & UPGRADES', 70, 36, 32, '#fff5df', 800);
  drawText(ctx, 'BANK CREDITS: $2,850', 1040, 38, 22, '#ffd76c', 700, 'right');

  const colW = 560;
  const rowH = 88;
  const equippedIds = ['engine_tune', 'stol_flaps', 'extended_tank'];

  UPGRADE_DEFINITIONS.forEach((upgrade, idx) => {
    const col = idx % 2;
    const row = Math.floor(idx / 2);
    const x = 70 + col * (colW + 20);
    const y = 78 + row * (rowH + 6);

    drawPanel(ctx, x, y, colW, rowH, '#8bb4bd', '#152538');
    drawText(ctx, upgrade.name, x + 14, y + 10, 17, '#fff5df', 700);
    drawText(ctx, `${upgrade.category} · $${upgrade.cost.toLocaleString()}`, x + colW - 14, y + 10, 15, '#ffd76c', 600, 'right');

    ctx.font = '14px "Courier New", monospace';
    ctx.fillStyle = '#bfdbd9';
    ctx.fillText(upgrade.description.slice(0, 52) + '…', x + 14, y + 36);

    const isEquipped = equippedIds.includes(upgrade.id);
    const btnW = 116;
    const btnH = 34;
    const btnX = x + colW - btnW - 12;
    const btnY = y + 42;

    ctx.save();
    ctx.fillStyle = isEquipped ? '#ffd76c' : 'rgba(255, 215, 108, 0.2)';
    ctx.fillRect(btnX, btnY, btnW, btnH);
    if (!isEquipped) {
      ctx.strokeStyle = '#ffd76c';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(btnX, btnY, btnW, btnH);
    }
    ctx.restore();
    drawText(ctx, isEquipped ? 'EQUIPPED' : 'BUY', btnX + btnW / 2, btnY + 8, 15, isEquipped ? '#102330' : '#ffd76c', 800, 'center');
  });

  // Bottom action bar
  ctx.save();
  ctx.fillStyle = '#ffd76c';
  ctx.fillRect(70, 396, 360, 44);
  drawText(ctx, 'ENTER · RETURN TO SORTIES', 250, 408, 17, '#102330', 800, 'center');
  ctx.restore();
  drawText(ctx, 'Upgrades persist across all flights · S-Rank Ace rewards available', 460, 410, 16, '#bfdbd9', 500);
}

export function stageShot(canvas, ctx) {
  const name = readShotName();
  if (!SHOT_NAMES.includes(name)) return false;

  canvas.width = SHOT_WIDTH;
  canvas.height = SHOT_HEIGHT;
  const context = ctx ?? canvas.getContext('2d');
  if (!context) throw new Error('Valley Mail screenshots require a 2D canvas context.');

  if (name === 'cover' || name === 'title') {
    stageTitleScene(context);
  } else if (name === 'ring' || name === 'gorge') {
    stageGorgeFlightScene(context);
  } else if (name === 'dusk' || name === 'approach') {
    stageDuskFlightScene(context);
  } else if (name === 'upgrade') {
    stageUpgradeHangarScene(context);
  } else {
    return false;
  }

  window.__shotReady = true;
  return true;
}
