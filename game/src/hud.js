/**
 * Valley Mail instrument overlay: tapes, compass, attitude, status, delivery streaks, and notices.
 * Exports: drawHUD(ctx, plane, run, palette = PALETTES.day, message = null).
 * Pass the resolved world.palette; every colour comes from its hud set.
 * Supports both standard (1280x720) and compact (1280x480) viewports cleanly.
 */
import { CANVAS, UNITS, FLIGHT, FUEL, DAMAGE, PALETTES } from './config.js';

const INSET = 16;
const FONT = '"Courier New", monospace';
const finite = (value) => Number.isFinite(value) ? value : 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapHeading = (degrees) => ((degrees % 360) + 360) % 360;

function text(ctx, value, x, y, size, colour, align = 'left', maxWidth) {
  ctx.font = `bold ${size}px ${FONT}`;
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (maxWidth === undefined) ctx.fillText(String(value), x, y);
  else ctx.fillText(String(value), x, y, maxWidth);
}

function panel(ctx, hud, x, y, width, height, outline = hud.outline, fill = hud.panel) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);
}

function tape(ctx, hud, spec, isCompact) {
  const { x, width, title, unit, value, step, majorStep, pixelsPerUnit,
    min = -Infinity, max = Infinity, stallLimit, right = false,
    readoutColour = hud.accent } = spec;
  const y = isCompact ? 90 : 158;
  const height = isCompact ? 220 : 326;
  const top = y + (isCompact ? 32 : 44);
  const bottom = y + height - (isCompact ? 28 : 40);
  const centre = (top + bottom) / 2;
  const axis = right ? x + 16 : x + width - 16;
  const direction = right ? 1 : -1;
  const valueY = (number) => centre - (number - value) * pixelsPerUnit;

  panel(ctx, hud, x, y, width, height);
  text(ctx, title, x + width / 2, y + (isCompact ? 16 : 23), isCompact ? 18 : 24, hud.text, 'center', width - 16);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 4, top, width - 8, bottom - top);
  ctx.clip();

  if (stallLimit !== undefined) {
    const bandTop = clamp(valueY(stallLimit), top, bottom);
    const bandBottom = clamp(valueY(min), top, bottom);
    ctx.fillStyle = hud.warning;
    ctx.fillRect(axis + 3, bandTop, 7, Math.max(0, bandBottom - bandTop));
  }

  ctx.strokeStyle = hud.dim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(axis, top);
  ctx.lineTo(axis, bottom);
  ctx.stroke();

  const halfRange = (bottom - top) / (2 * pixelsPerUnit);
  const first = Math.ceil(Math.max(min, value - halfRange) / step) * step;
  const last = Math.min(max, value + halfRange);
  for (let mark = first; mark <= last; mark += step) {
    const tickY = valueY(mark);
    const major = mark % majorStep === 0 || mark === min || mark === max;
    ctx.strokeStyle = stallLimit !== undefined && mark < stallLimit
      ? hud.warning : hud.outline;
    ctx.lineWidth = major ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(axis, tickY);
    ctx.lineTo(axis + direction * (major ? 14 : 8), tickY);
    ctx.stroke();

    if (major && tickY >= top + 14 && tickY <= bottom - 14 && Math.abs(tickY - centre) >= (isCompact ? 32 : 44)) {
      text(ctx, mark, axis + direction * (isCompact ? 22 : 26), tickY, isCompact ? 20 : 26, hud.text,
        right ? 'left' : 'right');
    }
  }
  ctx.restore();

  const boxX = right ? x + 24 : x + 6;
  const boxWidth = width - 30;
  const boxTop = centre - (isCompact ? 24 : 32);
  const boxBottom = centre + (isCompact ? 24 : 32);
  ctx.beginPath();
  ctx.moveTo(boxX, boxTop);
  ctx.lineTo(boxX + boxWidth, boxTop);
  if (!right) {
    ctx.lineTo(boxX + boxWidth, centre - 8);
    ctx.lineTo(axis, centre);
    ctx.lineTo(boxX + boxWidth, centre + 8);
  }
  ctx.lineTo(boxX + boxWidth, boxBottom);
  ctx.lineTo(boxX, boxBottom);
  if (right) {
    ctx.lineTo(boxX, centre + 8);
    ctx.lineTo(axis, centre);
    ctx.lineTo(boxX, centre - 8);
  }
  ctx.closePath();
  ctx.fillStyle = hud.panel;
  ctx.fill();
  ctx.strokeStyle = readoutColour;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  text(ctx, Math.round(value), boxX + boxWidth / 2, centre, isCompact ? 38 : 50,
    readoutColour, 'center', boxWidth - 12);

  text(ctx, unit, x + 10, y + height - (isCompact ? 12 : 16), isCompact ? 16 : 22, hud.dim);
  if (stallLimit !== undefined) {
    text(ctx, `STALL ${stallLimit}`, x + width - 10, y + height - (isCompact ? 12 : 16),
      isCompact ? 15 : 19, hud.warning, 'right');
  }
}

function compass(ctx, hud, heading, isCompact) {
  const width = isCompact ? 520 : 600;
  const x = (CANVAS.width - width) / 2;
  const y = isCompact ? 8 : INSET;
  const centre = CANVAS.width / 2;
  const pixelsPerDegree = 3.6;
  const height = isCompact ? 76 : 124;
  panel(ctx, hud, x, y, width, height);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 6, y + 6, width - 12, isCompact ? 36 : 64);
  ctx.clip();

  const halfRange = (width - 12) / (2 * pixelsPerDegree);
  const first = Math.ceil((heading - halfRange) / 5) * 5;
  const last = heading + halfRange;
  for (let mark = first; mark <= last; mark += 5) {
    const tickX = centre + (mark - heading) * pixelsPerDegree;
    const degrees = wrapHeading(mark);
    const cardinal = degrees % 90 === 0;
    const major = degrees % 30 === 0;
    ctx.strokeStyle = cardinal ? hud.accent : hud.outline;
    ctx.lineWidth = major ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(tickX, y + (isCompact ? 36 : 64));
    ctx.lineTo(tickX, y + (isCompact ? (major ? 22 : 28) : (major ? 45 : 54)));
    ctx.stroke();
    if (major) {
      const label = cardinal ? ['N', 'E', 'S', 'W'][degrees / 90] : degrees;
      text(ctx, label, tickX, y + (isCompact ? 14 : 26), cardinal ? (isCompact ? 22 : 30) : (isCompact ? 18 : 24),
        cardinal ? hud.accent : hud.text, 'center');
    }
  }
  ctx.restore();

  const arrowY = y + (isCompact ? 38 : 63);
  ctx.beginPath();
  ctx.moveTo(centre - 7, arrowY);
  ctx.lineTo(centre + 7, arrowY);
  ctx.lineTo(centre, arrowY + 8);
  ctx.closePath();
  ctx.fillStyle = hud.accent;
  ctx.fill();

  panel(ctx, hud, centre - 55, y + (isCompact ? 46 : 76), 110, isCompact ? 26 : 42, hud.accent);
  const readout = String(wrapHeading(Math.round(heading))).padStart(3, '0');
  text(ctx, `${readout}°`, centre, y + (isCompact ? 59 : 97), isCompact ? 24 : 38, hud.accent, 'center');
  text(ctx, 'HDG', x + 14, y + (isCompact ? 59 : 97), isCompact ? 16 : 24, hud.dim);
}

function attitude(ctx, hud, plane, isCompact) {
  const x = INSET;
  const height = isCompact ? 150 : 208;
  const y = CANVAS.height - INSET - height;
  const centreX = x + (isCompact ? 85 : 115);
  const centreY = y + (isCompact ? 82 : 120);
  const radius = isCompact ? 52 : 76;
  const pitchOffset = finite(plane.pitch) * (isCompact ? 1.7 : 2.4);
  const extent = radius * 4 + Math.abs(pitchOffset);

  panel(ctx, hud, x, y, isCompact ? 170 : 230, height);
  text(ctx, 'ATTITUDE', centreX, y + (isCompact ? 16 : 23), isCompact ? 17 : 24, hud.text, 'center');
  ctx.save();
  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(centreX, centreY);
  ctx.rotate(-finite(plane.bank) * UNITS.degreesToRadians);
  ctx.translate(0, pitchOffset);

  ctx.fillStyle = hud.dim;
  ctx.fillRect(-extent, -extent, extent * 2, extent);
  ctx.fillStyle = hud.panel;
  ctx.fillRect(-extent, 0, extent * 2, extent);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(-extent, 0);
  ctx.lineTo(extent, 0);
  ctx.stroke();

  for (let angle = -30; angle <= 30; angle += 10) {
    if (angle === 0) continue;
    const ladderY = -angle * (isCompact ? 1.7 : 2.4);
    const halfWidth = angle % 20 === 0 ? (isCompact ? 20 : 30) : (isCompact ? 14 : 20);
    ctx.strokeStyle = angle > 0 ? hud.panel : hud.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-halfWidth, ladderY);
    ctx.lineTo(halfWidth, ladderY);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Fixed aircraft symbol
  ctx.beginPath();
  const wingSpan = isCompact ? 28 : 42;
  ctx.moveTo(centreX - wingSpan, centreY);
  ctx.lineTo(centreX - 10, centreY);
  ctx.lineTo(centreX - 10, centreY + 6);
  ctx.moveTo(centreX + 10, centreY + 6);
  ctx.lineTo(centreX + 10, centreY);
  ctx.lineTo(centreX + wingSpan, centreY);
  ctx.strokeStyle = hud.accent;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function bar(ctx, hud, x, y, label, value, capacity, low = false, isCompact = false) {
  const fraction = clamp(finite(value) / capacity, 0, 1);
  const colour = low ? hud.warning : hud.accent;
  const labelWidth = isCompact ? 95 : 125;
  const barX = x + labelWidth;
  const width = isCompact ? 150 : 178;
  const height = isCompact ? 11 : 16;
  text(ctx, low ? `${label} !` : label, x, y, isCompact ? 17 : 22, low ? hud.warning : hud.dim);

  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = hud.dim;
  ctx.fillRect(barX, y - height / 2, width, height);
  ctx.restore();
  ctx.fillStyle = colour;
  ctx.fillRect(barX, y - height / 2, width * fraction, height);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(barX, y - height / 2, width, height);
  text(ctx, `${Math.round(fraction * 100)}%`, barX + width + 38, y, isCompact ? 17 : 22, colour, 'right');
}

function status(ctx, hud, plane, run, isCompact) {
  const width = isCompact ? 410 : 426;
  const height = isCompact ? 150 : 208;
  const x = CANVAS.width - INSET - width;
  const y = CANVAS.height - INSET - height;
  panel(ctx, hud, x, y, width, height);

  const sortieTitle = run.sortie?.name ?? 'Valley Mail';
  const weatherLabel = run.weather?.preset?.name ?? 'Fair Skies';
  text(ctx, `${sortieTitle} · ${weatherLabel}`, x + 14, y + (isCompact ? 15 : 23),
    isCompact ? 19 : 26, hud.text, 'left', width - 28);
  ctx.strokeStyle = hud.dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 14, y + (isCompact ? 28 : 42));
  ctx.lineTo(x + width - 14, y + (isCompact ? 28 : 42));
  ctx.stroke();

  const rowSpacing = isCompact ? 22 : 31;
  const startY = y + (isCompact ? 42 : 61);
  bar(ctx, hud, x + 14, startY, 'THROTTLE', plane.throttle, 1, false, isCompact);
  bar(ctx, hud, x + 14, startY + rowSpacing, 'FUEL', plane.fuel, FUEL.capacity,
    plane.fuel < FUEL.lowWarning, isCompact);
  bar(ctx, hud, x + 14, startY + rowSpacing * 2, 'HULL', plane.hull, DAMAGE.maxHull,
    plane.hull < DAMAGE.lowHullWarning, isCompact);

  const bottomY = startY + rowSpacing * 3 + (isCompact ? 4 : 8);
  text(ctx, plane.gearDown ? 'GEAR DN' : 'GEAR UP', x + 14, bottomY,
    isCompact ? 18 : 24, plane.gearDown ? hud.accent : hud.dim);

  // Mail & parcel delivery count
  const mailPassed = run.ringsHit ?? 0;
  const mailTotal = run.ringsTotal ?? run.rings?.length ?? 5;
  const mailLabel = run.parcel?.status === 'carried'
    ? `MAIL ${mailPassed}/${mailTotal} [CARGO]`
    : `MAIL ${mailPassed}/${mailTotal}`;
  text(ctx, mailLabel, x + width / 2 + 10, bottomY, isCompact ? 18 : 24, hud.accent, 'center');

  const score = Math.round(finite(run.score)).toLocaleString('en-US');
  text(ctx, `SCORE ${score}`, x + width - 14, bottomY, isCompact ? 19 : 28, hud.text, 'right');
}

function comboBadge(ctx, hud, combo, isCompact) {
  if (!combo || combo.streak < 1) return;
  const centre = CANVAS.width / 2;
  const y = isCompact ? 94 : 156;
  const mult = combo.multiplier.toFixed(1);
  const label = `COMBO x${mult} · STREAK ${combo.streak}`;
  const width = isCompact ? 280 : 340;
  const height = isCompact ? 34 : 44;

  panel(ctx, hud, centre - width / 2, y, width, height, hud.accent);
  text(ctx, label, centre, y + height / 2 - 2, isCompact ? 18 : 24, hud.accent, 'center');

  // Combo timer bar
  if (combo.timerSeconds > 0 && combo.windowSeconds > 0) {
    const fraction = clamp(combo.timerSeconds / combo.windowSeconds, 0, 1);
    ctx.fillStyle = hud.accent;
    ctx.fillRect(centre - width / 2 + 4, y + height - 5, (width - 8) * fraction, 3);
  }
}

function notices(ctx, hud, plane, run, message, isCompact) {
  const centre = CANVAS.width / 2;
  if (plane.stalled) {
    const bright = Math.floor(finite(run.elapsedSeconds) * 2) % 2 === 0;
    const y = isCompact ? 134 : 206;
    panel(ctx, hud, centre - 100, y, 200, isCompact ? 46 : 60, hud.warning,
      bright ? hud.warning : hud.panel);
    text(ctx, 'STALL', centre, y + (isCompact ? 23 : 30), isCompact ? 34 : 44,
      bright ? hud.panel : hud.warning, 'center');
  }

  if (message !== null && message !== undefined && message !== '') {
    const value = String(message);
    ctx.font = `bold ${isCompact ? 24 : 32}px ${FONT}`;
    const textWidth = ctx.measureText(value).width;
    const width = clamp(textWidth + 36, 220, 720);
    const y = isCompact ? (run.combo?.streak > 1 ? 138 : 102) : (run.combo?.streak > 1 ? 212 : 168);
    panel(ctx, hud, centre - width / 2, y, width, isCompact ? 38 : 50, hud.accent);
    text(ctx, value, centre, y + (isCompact ? 19 : 25), isCompact ? 22 : 30, hud.accent, 'center', width - 20);
  }
}

/** Stateless overlay; leaves caller canvas state intact. */
export function drawHUD(ctx, plane, run, palette = PALETTES.day, message = null) {
  const hud = palette.hud;
  const isCompact = CANVAS.height <= 520 || ctx.canvas.height <= 520;
  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    tape(ctx, hud, {
      x: INSET, width: isCompact ? 154 : 174, title: 'AIRSPEED', unit: 'KT',
      value: Math.max(0, finite(plane.airspeedKnots)),
      step: 5, majorStep: 10, pixelsPerUnit: isCompact ? 2.3 : 3.3,
      min: 0, max: plane._maxSpeedKnots ?? FLIGHT.maxSpeedKnots,
      stallLimit: plane._stallSpeedKnots ?? FLIGHT.stallSpeedKnots,
      readoutColour: plane.stalled ? hud.warning : hud.accent,
    }, isCompact);

    tape(ctx, hud, {
      x: CANVAS.width - INSET - (isCompact ? 174 : 202),
      width: isCompact ? 174 : 202, title: 'ALTITUDE', unit: 'FT',
      value: finite(plane.altitude) * UNITS.metersToFeet,
      step: 50, majorStep: 100, pixelsPerUnit: isCompact ? 0.22 : 0.32,
      min: 0, right: true,
    }, isCompact);

    compass(ctx, hud, wrapHeading(finite(plane.heading)), isCompact);
    attitude(ctx, hud, plane, isCompact);
    status(ctx, hud, plane, run, isCompact);
    comboBadge(ctx, hud, run?.combo, isCompact);
    notices(ctx, hud, plane, run, message, isCompact);
  } finally {
    ctx.restore();
  }
}
