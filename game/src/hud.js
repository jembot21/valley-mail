/**
 * Valley Mail instrument overlay: tapes, compass, attitude, status and notices.
 * Exports: drawHUD(ctx, plane, run, palette = PALETTES.day, message = null).
 * Pass the resolved world.palette; every colour comes from its hud set.
 * Draw after the world, with ctx already in CANVAS's 1280x720 design coordinates.
 * The caller owns scaling and message lifetime. The stall flash uses the supplied
 * run.elapsedSeconds; this module has no timers, retained state, DOM or game logic.
 */
import { CANVAS, UNITS, FLIGHT, FUEL, DAMAGE, PALETTES } from './config.js';

const INSET = 18;
const FONT = '"Courier New", monospace'; // Fixed-width digits keep readouts steady.
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

function tape(ctx, hud, spec) {
  const { x, width, title, unit, value, step, majorStep, pixelsPerUnit,
    min = -Infinity, max = Infinity, stallLimit, right = false,
    readoutColour = hud.accent } = spec;
  const y = 158;
  const height = 326;
  const top = y + 44;
  const bottom = y + height - 40;
  const centre = (top + bottom) / 2;
  const axis = right ? x + 18 : x + width - 18;
  const direction = right ? 1 : -1;
  const valueY = (number) => centre - (number - value) * pixelsPerUnit;

  panel(ctx, hud, x, y, width, height);
  text(ctx, title, x + width / 2, y + 23, 24, hud.text, 'center', width - 20);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 4, top, width - 8, bottom - top);
  ctx.clip();

  // A tape's red stall arc is a continuous band, clipped to the visible scale.
  if (stallLimit !== undefined) {
    const bandTop = clamp(valueY(stallLimit), top, bottom);
    const bandBottom = clamp(valueY(min), top, bottom);
    ctx.fillStyle = hud.warning;
    ctx.fillRect(axis + 4, bandTop, 9, Math.max(0, bandBottom - bandTop));
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
    ctx.lineWidth = major ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(axis, tickY);
    ctx.lineTo(axis + direction * (major ? 19 : 10), tickY);
    ctx.stroke();

    // Leave entire labels clear of the readout and the clipping edges.
    if (major && tickY >= top + 16 && tickY <= bottom - 16
      && Math.abs(tickY - centre) >= 48) {
      text(ctx, mark, axis + direction * 28, tickY, 28, hud.text,
        right ? 'left' : 'right');
    }
  }
  ctx.restore();

  const boxX = right ? x + 28 : x + 8;
  const boxWidth = width - 36;
  const boxTop = centre - 32;
  const boxBottom = centre + 32;
  ctx.beginPath();
  ctx.moveTo(boxX, boxTop);
  ctx.lineTo(boxX + boxWidth, boxTop);
  if (!right) {
    ctx.lineTo(boxX + boxWidth, centre - 10);
    ctx.lineTo(axis, centre);
    ctx.lineTo(boxX + boxWidth, centre + 10);
  }
  ctx.lineTo(boxX + boxWidth, boxBottom);
  ctx.lineTo(boxX, boxBottom);
  if (right) {
    ctx.lineTo(boxX, centre + 10);
    ctx.lineTo(axis, centre);
    ctx.lineTo(boxX, centre - 10);
  }
  ctx.closePath();
  ctx.fillStyle = hud.panel;
  ctx.fill();
  ctx.strokeStyle = readoutColour;
  ctx.lineWidth = 3;
  ctx.stroke();
  text(ctx, Math.round(value), boxX + boxWidth / 2, centre, 52,
    readoutColour, 'center', boxWidth - 16);

  text(ctx, unit, x + 12, y + height - 18, 24, hud.dim);
  if (stallLimit !== undefined) {
    text(ctx, `STALL ${stallLimit}`, x + width - 12, y + height - 18,
      20, hud.warning, 'right');
  }
}

function compass(ctx, hud, heading) {
  const width = 600;
  const x = (CANVAS.width - width) / 2;
  const y = INSET;
  const centre = CANVAS.width / 2;
  const pixelsPerDegree = 4;
  panel(ctx, hud, x, y, width, 124);

  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 8, y + 8, width - 16, 64);
  ctx.clip();
  // Iterate unwrapped marks so north scrolls continuously through 359 -> 0.
  const halfRange = (width - 16) / (2 * pixelsPerDegree);
  const first = Math.ceil((heading - halfRange) / 5) * 5;
  const last = heading + halfRange;
  for (let mark = first; mark <= last; mark += 5) {
    const tickX = centre + (mark - heading) * pixelsPerDegree;
    const degrees = wrapHeading(mark);
    const cardinal = degrees % 90 === 0;
    const major = degrees % 30 === 0;
    ctx.strokeStyle = cardinal ? hud.accent : hud.outline;
    ctx.lineWidth = major ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(tickX, y + 64);
    ctx.lineTo(tickX, y + (major ? 45 : 54));
    ctx.stroke();
    if (major) {
      const label = cardinal ? ['N', 'E', 'S', 'W'][degrees / 90] : degrees;
      // Reserve room for whole labels at either end of the scrolling strip.
      ctx.font = `bold ${cardinal ? 30 : 24}px ${FONT}`;
      const halfLabel = ctx.measureText(String(label)).width / 2;
      if (tickX - halfLabel >= x + 12 && tickX + halfLabel <= x + width - 12) {
        text(ctx, label, tickX, y + 26, cardinal ? 30 : 24,
          cardinal ? hud.accent : hud.text, 'center');
      }
    }
  }
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(centre - 9, y + 63);
  ctx.lineTo(centre + 9, y + 63);
  ctx.lineTo(centre, y + 72);
  ctx.closePath();
  ctx.fillStyle = hud.accent;
  ctx.fill();
  panel(ctx, hud, centre - 76, y + 76, 152, 42, hud.accent);
  const readout = String(wrapHeading(Math.round(heading))).padStart(3, '0');
  text(ctx, `${readout}°`, centre, y + 97, 38, hud.accent, 'center');
  text(ctx, 'HDG', x + 16, y + 97, 24, hud.dim);
}

function attitude(ctx, hud, plane) {
  const x = INSET;
  const y = CANVAS.height - INSET - 208;
  const centreX = x + 115;
  const centreY = y + 120;
  const radius = 76;
  const pitchOffset = finite(plane.pitch) * 2.4;
  const extent = radius * 4 + Math.abs(pitchOffset);

  panel(ctx, hud, x, y, 230, 208);
  text(ctx, 'ATTITUDE', centreX, y + 23, 24, hud.text, 'center');
  ctx.save();
  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(centreX, centreY);
  // The world rolls opposite the aircraft; nose-up moves the horizon down.
  ctx.rotate(-finite(plane.bank) * UNITS.degreesToRadians);
  ctx.translate(0, pitchOffset);

  // Use only HUD colours: a light sky and dark ground remain distinct at dusk.
  ctx.fillStyle = hud.dim;
  ctx.fillRect(-extent, -extent, extent * 2, extent);
  ctx.fillStyle = hud.panel;
  ctx.fillRect(-extent, 0, extent * 2, extent);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-extent, 0);
  ctx.lineTo(extent, 0);
  ctx.stroke();

  for (let angle = -30; angle <= 30; angle += 10) {
    if (angle === 0) continue;
    const ladderY = -angle * 2.4;
    const halfWidth = angle % 20 === 0 ? 30 : 20;
    ctx.strokeStyle = angle > 0 ? hud.panel : hud.text;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(angle < 0 ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(-halfWidth, ladderY);
    ctx.lineTo(halfWidth, ladderY);
    ctx.stroke();
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(centreX, centreY, radius, 0, Math.PI * 2);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 3;
  ctx.stroke();

  // This aircraft symbol stays fixed to the glass, independent of pitch/bank.
  ctx.beginPath();
  ctx.moveTo(centreX - 42, centreY);
  ctx.lineTo(centreX - 14, centreY);
  ctx.lineTo(centreX - 14, centreY + 8);
  ctx.moveTo(centreX + 14, centreY + 8);
  ctx.lineTo(centreX + 14, centreY);
  ctx.lineTo(centreX + 42, centreY);
  ctx.moveTo(centreX - 5, centreY);
  ctx.lineTo(centreX, centreY + 5);
  ctx.lineTo(centreX + 5, centreY);
  ctx.strokeStyle = hud.panel;
  ctx.lineWidth = 8;
  ctx.stroke();
  ctx.strokeStyle = hud.accent;
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(centreX - 7, centreY - radius + 7);
  ctx.lineTo(centreX + 7, centreY - radius + 7);
  ctx.lineTo(centreX, centreY - radius + 18);
  ctx.closePath();
  ctx.fillStyle = hud.accent;
  ctx.fill();
}

function bar(ctx, hud, x, y, label, value, capacity, low = false) {
  const fraction = clamp(finite(value) / capacity, 0, 1);
  const colour = low ? hud.warning : hud.accent;
  const barX = x + 132;
  const width = 178;
  const height = 16;
  text(ctx, low ? `${label} LOW` : label, x, y, 24, low ? hud.warning : hud.dim);

  ctx.save();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = hud.dim;
  ctx.fillRect(barX, y - height / 2, width, height);
  ctx.restore();
  ctx.fillStyle = colour;
  ctx.fillRect(barX, y - height / 2, width * fraction, height);
  ctx.strokeStyle = hud.outline;
  ctx.lineWidth = 2;
  ctx.strokeRect(barX, y - height / 2, width, height);
  text(ctx, `${Math.round(fraction * 100)}%`, x + 390, y, 24, colour, 'right');
}

function status(ctx, hud, plane, run) {
  const width = 426;
  const height = 208;
  const x = CANVAS.width - INSET - width;
  const y = CANVAS.height - INSET - height;
  panel(ctx, hud, x, y, width, height);
  text(ctx, run.sortie?.name ?? 'Valley Mail', x + 18, y + 25,
    28, hud.text, 'left', width - 36);
  ctx.strokeStyle = hud.dim;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x + 18, y + 43);
  ctx.lineTo(x + width - 18, y + 43);
  ctx.stroke();

  bar(ctx, hud, x + 18, y + 61, 'THROTTLE', plane.throttle, 1);
  bar(ctx, hud, x + 18, y + 92, 'FUEL', plane.fuel, FUEL.capacity,
    plane.fuel < FUEL.lowWarning);
  bar(ctx, hud, x + 18, y + 123, 'HULL', plane.hull, DAMAGE.maxHull,
    plane.hull < DAMAGE.lowHullWarning);

  text(ctx, plane.gearDown ? 'GEAR DOWN' : 'GEAR UP', x + 18, y + 157,
    26, plane.gearDown ? hud.accent : hud.dim);
  const remaining = Math.max(0, Math.round(finite(run.ringsRemaining)));
  text(ctx, `RINGS LEFT ${remaining}`, x + width - 18, y + 157,
    26, hud.text, 'right', 210);
  const score = Math.round(finite(run.score)).toLocaleString('en-US');
  text(ctx, `SCORE ${score}`, x + 18, y + 190, 32, hud.accent, 'left', width - 36);
}

function notices(ctx, hud, plane, run, message) {
  const centre = CANVAS.width / 2;
  if (plane.stalled) {
    // A one-Hz inversion flashes while leaving STALL readable on every frame.
    const bright = Math.floor(finite(run.elapsedSeconds) * 2) % 2 === 0;
    panel(ctx, hud, centre - 114, 158, 228, 66, hud.warning,
      bright ? hud.warning : hud.panel);
    text(ctx, 'STALL', centre, 191, 46, bright ? hud.panel : hud.warning, 'center');
  }

  if (message !== null && message !== undefined && message !== '') {
    const value = String(message);
    ctx.font = `bold 36px ${FONT}`;
    // Keep even a long caller-supplied notice within the lane between the tapes.
    const maxWidth = CANVAS.width - 2 * (INSET + 202 + 24);
    const width = clamp(ctx.measureText(value).width + 48, 240, maxWidth);
    // Leave an 8px gap below the compass, including the panel's half-height.
    const y = Math.max(CANVAS.height * 0.2, INSET + 124 + 28 + 8);
    panel(ctx, hud, centre - width / 2, y - 28, width, 56, hud.accent);
    text(ctx, value, centre, y, 36, hud.accent, 'center', width - 36);
  }
}

/** Stateless overlay; leaves the caller's canvas drawing state intact. */
export function drawHUD(ctx, plane, run, palette = PALETTES.day, message = null) {
  const hud = palette.hud;
  ctx.save();
  try {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.shadowColor = hud.panel;
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);

    tape(ctx, hud, {
      x: INSET, width: 174, title: 'AIRSPEED', unit: 'KT',
      value: Math.max(0, finite(plane.airspeedKnots)),
      step: 5, majorStep: 10, pixelsPerUnit: 3.3,
      min: 0, max: FLIGHT.maxSpeedKnots, stallLimit: FLIGHT.stallSpeedKnots,
      readoutColour: plane.stalled ? hud.warning : hud.accent,
    });
    tape(ctx, hud, {
      x: CANVAS.width - INSET - 202, width: 202, title: 'ALTITUDE', unit: 'FT',
      value: finite(plane.altitude) * UNITS.metersToFeet,
      step: 50, majorStep: 100, pixelsPerUnit: 0.32, min: 0, right: true,
    });
    compass(ctx, hud, wrapHeading(finite(plane.heading)));
    attitude(ctx, hud, plane);
    status(ctx, hud, plane, run);
    notices(ctx, hud, plane, run, message);
  } finally {
    ctx.restore();
  }
}
