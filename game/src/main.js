/**
 * Valley Mail entry point: boot, screen flow, simulation clock and module wiring.
 * Exports: none. Physics, scenery, scoring and the flight view live in their modules.
 */
import { CONFIG, readShotName, CANVAS, PALETTES } from './config.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { createWorld, createRings } from './world.js';
import { createPlane, resetPlane, stepPlane } from './plane.js';
import {
  SORTIES, FREE_FLIGHT, createSortieWorld, createRun, stepRun, finishRun,
} from './missions.js';
import { draw } from './render.js';
import { drawHUD } from './hud.js';
import { stageShot } from './shots.js';

const WIDTH = CANVAS.width || 1280;
const HEIGHT = CANVAS.height || 720;
const STEP = 1 / 60;
const MAX_STEPS = 6;
const MAX_FRAME = STEP * MAX_STEPS;
const CAMPAIGN = SORTIES.filter(sortie => sortie !== FREE_FLIGHT);
const OPTIONS = [...CAMPAIGN, FREE_FLIGHT];
const BEST_KEY = 'valley-mail.best.v1';

boot();

function boot() {
  const canvas = document.getElementById('game');
  const loading = document.getElementById('loading');
  const ctx = canvas?.getContext('2d');
  if (!ctx) {
    if (loading) loading.textContent = 'Valley Mail needs a browser with Canvas support.';
    return;
  }

  let pixelRatio = 1;
  function resize() {
    pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
    canvas.width = Math.round(WIDTH * pixelRatio);
    canvas.height = Math.round(HEIGHT * pixelRatio);
    // CSS fills the viewport; input maps its displayed bounds to design coordinates.
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  }
  resize();

  const audio = createAudio({ eventTarget: window, bindKeys: true });
  const input = createInput(canvas, { onGesture: () => audio.unlock() });
  const shotRequested = new URLSearchParams(globalThis.location?.search ?? '').has('shot');
  if (shotRequested || readShotName() || CONFIG.shot) {
    const ready = stageShot(canvas, ctx);
    if (loading) {
      loading.hidden = ready;
      if (!ready) loading.textContent = 'Unknown Valley Mail screenshot scene.';
    }
    return;
  }

  const palette = PALETTES[CONFIG.palette] || PALETTES.day || Object.values(PALETTES)[0];
  const colours = {
    ink: palette.ink || palette.text || '#fff5df',
    panel: palette.panel || palette.dark || '#102330',
    accent: palette.accent || palette.sun || '#f1c76b',
    muted: palette.muted || palette.fog || '#bdd0ce',
  };
  const demoWorld = createWorld();
  const demoPlane = createPlane(demoWorld);
  const demoRun = createRun(FREE_FLIGHT, demoWorld, undefined, demoPlane);
  const demoOrigin = { ...demoPlane.position };
  const demoHeading = demoPlane.heading;
  let demoSeconds = 0;
  let best = readBests();
  let screen = 'title';
  let selection = 0;
  let pauseSelection = 0;
  let world = null;
  let plane = null;
  let run = null;
  let card = null;
  let message = '';
  let messageTTL = 0;
  let accumulator = 0;
  let previousTime = null;
  let frameID = 0;
  let disposed = false;
  let buttons = [];
  let pendingGear = false;
  let pendingDrop = false;
  let lowFuelWarned = false;
  let newBest = false;

  function readBests() {
    try {
      const saved = JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  }

  function sortieKey(sortie) {
    return String(sortie.id ?? sortie.name ?? OPTIONS.indexOf(sortie));
  }

  function isFreeFlight() {
    return run?.sortie === FREE_FLIGHT || selection === CAMPAIGN.length;
  }

  function changeScreen(next) {
    screen = next;
    accumulator = 0;
    previousTime = null;
    pendingGear = false;
    pendingDrop = false;
    input.reset();
    if (next !== 'flying') {
      updateAudio(false);
      audio.stall(false);
    }
  }

  function chooseSortie(index) {
    selection = index;
    const sortie = OPTIONS[index];
    world = createSortieWorld(sortie);
    if (plane) resetPlane(plane, world);
    else plane = createPlane(world);
    run = createRun(sortie, world, world.rings ?? createRings(world), plane);
    plane.fuel = run.startingFuel;
    card = null;
    message = '';
    messageTTL = 0;
    lowFuelWarned = false;
    changeScreen('briefing');
  }

  function launchFlight() {
    announce(isFreeFlight() ? 'Free Flight · explore the valley. Esc returns to the title.'
      : 'Follow the rings. Bring the mail home.');
    changeScreen('flying');
  }

  function returnToTitle() {
    changeScreen('title');
  }

  function announce(value, seconds = 3) {
    message = value;
    messageTTL = seconds;
  }

  function updateAudio(active) {
    audio.update({
      throttle: plane?.throttle ?? 0,
      airspeedKnots: plane?.airspeedKnots ?? 0,
      stalled: active && Boolean(plane?.stalled),
      active,
    });
  }

  function pauseFlight() {
    if (screen !== 'flying') return;
    pauseSelection = 0;
    changeScreen('paused');
  }

  function resumeFlight() {
    changeScreen('flying');
  }

  function restartFlight() {
    chooseSortie(selection);
    launchFlight();
  }

  function ringsHit() {
    return Number(run.ringsHit ?? run.score?.ringsHit ?? run.nextRing) || 0;
  }

  function parcelPhase() {
    const parcel = run.parcel;
    if (!parcel) return 'ready';
    const phase = String(parcel.status ?? parcel.state ?? '').toLowerCase();
    if (parcel.hit || parcel.delivered || /^(hit|delivered|success)$/.test(phase)) return 'hit';
    if (parcel.missed || /^(missed|lost|failed)$/.test(phase)) return 'missed';
    if (parcel.dropped || parcel.inFlight || /^(dropped|falling|airborne)$/.test(phase)) return 'dropped';
    return 'ready';
  }

  function touchdownSeverity() {
    const grade = plane.landingGrade;
    const label = String(plane.landingLabel ?? grade ?? '').toLowerCase();
    if (/butter|perfect|excellent|smooth|^a\+?$/.test(label)) return 0.1;
    if (/good|soft|clean|^b$/.test(label)) return 0.3;
    if (/firm|^c$/.test(label)) return 0.55;
    if (/hard|rough|^d$/.test(label)) return 0.8;
    if (/crash|poor|^f$/.test(label)) return 1;
    if (typeof grade === 'number' && Number.isFinite(grade)) {
      return Math.max(0, Math.min(1, 1 - grade / (grade <= 1 ? 1 : 100)));
    }
    return 0.5;
  }

  function showScoreCard(result) {
    card = result;
    const score = totalScore();
    const key = sortieKey(OPTIONS[selection]);
    newBest = Number.isFinite(score) && (!Number.isFinite(best[key]) || score > best[key]);
    if (newBest) {
      best[key] = score;
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify(best));
      } catch {
        // Private browsing or full storage must never interrupt the results screen.
      }
    }
    changeScreen('score');
    if (outcomeTitle() === 'MAIL DELIVERED') audio.delivered();
  }

  function outcomeTitle() {
    const outcome = String(card.outcome ?? '').trim().toUpperCase().replace(/[_-]/g, ' ');
    if (/DELIVERED|SUCCESS/.test(outcome)) return 'MAIL DELIVERED';
    if (/FUEL/.test(outcome)) return 'OUT OF FUEL';
    if (/HULL/.test(outcome)) return 'HULL LOST';
    if (/CRASH/.test(outcome)) return 'CRASHED';
    return outcome || 'SORTIE COMPLETE';
  }

  function totalScore() {
    const value = card.totalScore ?? card.total ?? card.score?.total ?? card.score
      ?? run.score?.total ?? run.score;
    return value == null ? NaN : Number(value);
  }

  function scoreRows() {
    const fallback = [
      ['Rings', `${card.ringsHit ?? ringsHit()} / ${card.ringsTotal ?? card.ringCount ?? card.totalRings ?? run.rings.length}`],
      ['Time', timeLabel(card.elapsedSeconds ?? card.timeSeconds ?? run.elapsedSeconds)],
    ];
    if (!isFreeFlight()) fallback.push(
      ['Landing grade', card.landingLabel ?? card.landingGrade ?? plane.landingLabel ?? plane.landingGrade ?? '—'],
      ['Damage', card.damageTaken != null ? `${Math.round(card.damageTaken)}%`
        : card.damagePenalty ?? card.damage ?? `${Math.round(Math.max(0, 100 - plane.hull))}%`],
    );
    fallback.push(['Total score', scoreLabel(totalScore())]);
    if (isFreeFlight() || !card.lines) return fallback;

    // A scoring module may supply presentation lines; keep its labels and values.
    const lines = Array.isArray(card.lines) ? card.lines : Object.entries(card.lines);
    if (!lines.length) return fallback;
    return lines.map(line => {
      if (Array.isArray(line)) return [line[0], line[1] ?? ''];
      if (line && typeof line === 'object') {
        return [line.label ?? line.name ?? line.text ?? '', line.value ?? line.score ?? ''];
      }
      return [String(line), ''];
    });
  }

  function hasNextSortie() {
    return !isFreeFlight() && selection < CAMPAIGN.length - 1;
  }

  function continueFromScore() {
    if (hasNextSortie()) chooseSortie(selection + 1);
    else returnToTitle();
  }

  function drawScoreCard() {
    panel(150, 60, 980, 600);
    text(outcomeTitle(), 190, 92, 46, colours.ink, 800);
    text(OPTIONS[selection].name, 190, 157, 24, colours.accent, 600);
    const rows = scoreRows();
    const rowHeight = Math.min(44, 220 / rows.length);
    rows.forEach(([label, value], index) => {
      const y = 218 + index * rowHeight;
      text(label, 190, y, 22, colours.muted);
      text(value, 1090, y, 23, colours.ink, 600, 'right');
    });
    if (!isFreeFlight() && selection === CAMPAIGN.length - 1) {
      text('Campaign complete · all three sorties flown.', 190, 463, 22, colours.accent, 600);
    } else if (isFreeFlight()) {
      text('The valley will be here for your next flight.', 190, 463, 21, colours.muted);
    }
    const record = best[sortieKey(OPTIONS[selection])];
    if (Number.isFinite(record)) {
      text(`${newBest ? 'New best' : 'Best score'} · ${scoreLabel(record)}`, 190, 505, 21, colours.accent, 600);
    }
    button(hasNextSortie() ? 'Enter · Next sortie' : 'Enter · Return to title',
      190, 550, 420, 62, continueFromScore, true);
    button('Retry', 630, 550, 200, 62, restartFlight);
    if (hasNextSortie()) button('Title', 850, 550, 240, 62, returnToTitle);
  }

  function stepFlight(controls) {
    const previous = {
      rings: ringsHit(),
      hull: plane.hull,
      gear: plane.gearDown,
      stalled: plane.stalled,
      parcel: parcelPhase(),
    };
    messageTTL = Math.max(0, messageTTL - STEP);
    if (!messageTTL) message = '';

    // A press survives a render without a simulation step, then fires on one tick.
    const tickInput = { ...controls, gear: pendingGear, drop: pendingDrop, pause: false, confirm: false };
    pendingGear = false;
    pendingDrop = false;
    stepPlane(plane, tickInput, world, STEP);
    stepRun(run, plane, tickInput, STEP);
    updateAudio(true);

    if (plane.gearDown !== previous.gear) announce(`Landing gear ${plane.gearDown ? 'down' : 'up'}.`);
    const threaded = ringsHit() - previous.rings;
    if (threaded > 0) {
      for (let i = 0; i < threaded; i += 1) audio.ring();
      announce(`Ring threaded · ${ringsHit()} / ${run.rings.length}`);
    }
    if (plane.justTouchedDown) {
      audio.touchdown(touchdownSeverity());
      announce(`Touchdown · ${plane.landingLabel ?? plane.landingGrade ?? 'on the ground'}`);
    }
    const hullLost = previous.hull - plane.hull;
    if (hullLost >= 5) audio.damage(Math.min(1, hullLost / 100));
    const parcel = parcelPhase();
    if (parcel !== previous.parcel) {
      if (parcel === 'dropped') announce('Parcel dropped · watch the landing.');
      else if (parcel === 'hit') announce('Parcel hit · mail on target!', 4);
      else if (parcel === 'missed') announce('Parcel missed the delivery zone.', 4);
    }
    audio.stall(Boolean(plane.stalled));
    if (plane.stalled && !previous.stalled) announce('STALL · lower the nose and build airspeed.', 4);
    if (!lowFuelWarned && plane.fuel <= 20) {
      lowFuelWarned = true;
      announce('Low fuel · find a safe landing.', 4);
    }

    // Free Flight landings are practice; only a terminal failure ends the run.
    if (!isFreeFlight() || plane.crashed || plane.fuel <= 0 || plane.hull <= 0) {
      const result = finishRun(run, plane);
      if (result) showScoreCard(result);
    }
  }

  function advanceFlight(dt, controls) {
    pendingGear ||= Boolean(controls.gear);
    pendingDrop ||= Boolean(controls.drop);
    accumulator = Math.min(accumulator + dt, MAX_FRAME);
    let steps = 0;
    while (accumulator + 1e-9 >= STEP && steps < MAX_STEPS && screen === 'flying') {
      accumulator = Math.max(0, accumulator - STEP);
      stepFlight(controls);
      steps += 1;
    }
  }

  function drawFlight() {
    draw(ctx, world, plane, run);
    drawHUD(ctx, plane, run, palette, message);
  }

  function drawPause() {
    panel(355, 145, 570, 430);
    text('PAUSED', 397, 178, 43, colours.ink, 700);
    text('P / Esc resumes. ↑ / ↓ + Enter chooses.', 397, 246, 18, colours.muted);
    [
      ['Resume', resumeFlight],
      ['Restart sortie', restartFlight],
      ['Return to title', returnToTitle],
    ].forEach(([label, action], index) => {
      button(label, 397, 292 + index * 78, 486, 62, action, pauseSelection === index);
    });
  }

  function text(value, x, y, size = 20, colour = colours.ink, weight = 400, align = 'left') {
    ctx.font = `${weight} ${size}px system-ui, sans-serif`;
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(String(value), x, y);
  }

  function wrapped(value, x, y, width, lineHeight = 25, size = 18, colour = colours.muted) {
    ctx.font = `400 ${size}px system-ui, sans-serif`;
    let line = '';
    let row = y;
    for (const word of String(value || '').split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > width) {
        text(line, x, row, size, colour);
        row += lineHeight;
        line = word;
      } else line = candidate;
    }
    if (line) text(line, x, row, size, colour);
    return row + lineHeight;
  }

  function panel(x, y, width, height) {
    ctx.save();
    ctx.globalAlpha = 0.94;
    ctx.fillStyle = colours.panel;
    ctx.fillRect(x, y, width, height);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colours.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
  }

  function button(label, x, y, width, height, action, selected = false, detail = '') {
    const hovered = mouse.inside && mouse.x >= x && mouse.x <= x + width
      && mouse.y >= y && mouse.y <= y + height;
    ctx.save();
    ctx.globalAlpha = selected || hovered ? 0.22 : 0.07;
    ctx.fillStyle = colours.accent;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
    if (selected || hovered) {
      ctx.strokeStyle = colours.accent;
      ctx.strokeRect(x, y, width, height);
    }
    text(label, x + 16, y + 12, 21, colours.ink, 600);
    if (detail) wrapped(detail, x + 16, y + 38, width - 32, 19, 16);
    buttons.push({ x, y, width, height, action });
  }

  function timeLabel(seconds) {
    if (!Number.isFinite(Number(seconds))) return '—';
    const whole = Math.max(0, Math.round(Number(seconds)));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  function scoreLabel(score) {
    return Number.isFinite(score) ? Math.round(score).toLocaleString() : '—';
  }

  function drawDemo(dt) {
    demoSeconds += dt;
    const angle = demoSeconds * 0.035;
    // Only this decorative camera moves; no flight or mission clock runs here.
    demoPlane.position.x = demoOrigin.x + Math.sin(angle) * 90;
    demoPlane.position.z = demoOrigin.z + (Math.cos(angle) - 1) * 90;
    demoPlane.position.y = demoOrigin.y + 55 + Math.sin(angle * 0.7) * 4;
    demoPlane.heading = demoHeading + angle * 180 / Math.PI;
    demoPlane.onGround = false;
    draw(ctx, demoWorld, demoPlane, demoRun);
  }

  function drawTitle() {
    panel(48, 32, 900, 656);
    text('VALLEY MAIL', 76, 52, 58, colours.ink, 800);
    text('A little plane. A wild valley. Mail that has to get through.', 78, 124, 21);
    text('Pitch W/S or ↑/↓ · Bank A/D or ←/→ · Throttle Shift / Ctrl', 78, 166, 18, colours.muted);
    text('G  landing gear     Space  drop / confirm     P  pause     M  sound', 78, 194, 18, colours.muted);
    text('CHOOSE YOUR SORTIE', 78, 240, 17, colours.accent, 700);
    OPTIONS.forEach((sortie, index) => {
      button(`${index + 1}   ${sortie.name}`, 76, 274 + index * 85, 844, 77,
        () => chooseSortie(index), selection === index, sortie.briefing);
    });
    text('↑ / ↓ + Enter · number keys · click a sortie', 78, 642, 18, colours.muted);
    const record = best[sortieKey(OPTIONS[selection])];
    if (Number.isFinite(record)) text(`Best: ${scoreLabel(record)}`, 690, 642, 18, colours.accent);
  }

  function drawBriefing() {
    const sortie = OPTIONS[selection];
    panel(142, 88, 996, 544);
    text(isFreeFlight() ? 'FREE FLIGHT' : `SORTIE ${selection + 1}`, 180, 120, 18, colours.accent, 700);
    text(sortie.name, 180, 159, 43, colours.ink, 700);
    wrapped(sortie.briefing, 180, 225, 916, 30, 22, colours.ink);
    text('RINGS', 180, 340, 17, colours.accent, 700);
    text(String(run.rings.length), 180, 373, 31);
    text('FUEL', 480, 340, 17, colours.accent, 700);
    text(`${Math.round(run.startingFuel)}%`, 480, 373, 31);
    text('PAR', 780, 340, 17, colours.accent, 700);
    text(isFreeFlight() ? 'No time limit' : timeLabel(
      sortie.parSeconds ?? sortie.parTimeSeconds ?? sortie.parTime ?? sortie.par,
    ), 780, 373, 31);
    text(isFreeFlight() ? 'Explore at your own pace. Esc returns to the title.'
      : 'Thread the rings, deliver the parcel, and bring your plane home.', 180, 443, 20, colours.muted);
    button('Enter / Space · Launch', 180, 509, 565, 62, launchFlight, true);
    button('Back', 775, 509, 320, 62, returnToTitle);
  }

  let mouse = { x: -1, y: -1, inside: false };

  function frame(timestamp) {
    if (disposed) return;
    const dt = previousTime === null ? 0 : Math.min(MAX_FRAME, Math.max(0, (timestamp - previousTime) / 1000));
    previousTime = timestamp;
    const up = input.consumePress('ArrowUp');
    const down = input.consumePress('ArrowDown');
    const escape = input.consumePress('Escape');
    const number = OPTIONS.findIndex((_, i) => input.consumePress(`Digit${i + 1}`)
      || input.consumePress(`Numpad${i + 1}`));
    const controls = input.poll();
    const rawMouse = controls.mouse || { x: -1, y: -1, inside: false };
    const designPoint = point => ({ ...point, x: point.x / pixelRatio, y: point.y / pixelRatio });
    mouse = designPoint(rawMouse);
    const clicks = Array.isArray(rawMouse.clicks) && rawMouse.clicks.length
      ? rawMouse.clicks.map(designPoint) : mouse.clicked ? [mouse] : [];
    const screenAtFrameStart = screen;

    if (screen === 'title') {
      if (up || down) selection = (selection + (down ? 1 : -1) + OPTIONS.length) % OPTIONS.length;
      if (number >= 0) chooseSortie(number);
      else if (controls.confirm) chooseSortie(selection);
    } else if (screen === 'briefing') {
      if (escape) returnToTitle();
      else if (controls.confirm) launchFlight();
    } else if (screen === 'flying') {
      if (escape && isFreeFlight()) returnToTitle();
      else if (escape || controls.pause) pauseFlight();
      else advanceFlight(dt, controls);
    } else if (screen === 'paused') {
      if (up || down) pauseSelection = (pauseSelection + (down ? 1 : -1) + 3) % 3;
      if (escape || controls.pause) resumeFlight();
      else if (controls.confirm) [resumeFlight, restartFlight, returnToTitle][pauseSelection]();
    } else if (screen === 'score') {
      if (escape) returnToTitle();
      else if (controls.confirm) continueFromScore();
    }

    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    buttons = [];
    if (screen === 'title' || screen === 'briefing') {
      drawDemo(dt);
      if (screen === 'title') drawTitle();
      else drawBriefing();
    } else {
      drawFlight();
      if (screen === 'paused') drawPause();
      else if (screen === 'score') drawScoreCard();
    }
    // A keyboard transition cannot also click through into the newly drawn screen.
    if (clicks.length && screen === screenAtFrameStart) {
      const hit = clicks.map(point => buttons.find(({ x, y, width, height }) => point.x >= x && point.x <= x + width
        && point.y >= y && point.y <= y + height)).find(Boolean);
      if (hit) hit.action();
    }
    frameID = requestAnimationFrame(frame);
  }

  function dispose() {
    disposed = true;
    cancelAnimationFrame(frameID);
    input.dispose();
    audio.dispose();
    window.removeEventListener('resize', resize);
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('blur', pauseWhenAway);
    document.removeEventListener('visibilitychange', pauseWhenAway);
  }

  function pauseWhenAway(event) {
    if (event.type === 'blur' || document.hidden) {
      pauseFlight();
      input.reset();
      accumulator = 0;
      previousTime = null;
    }
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pagehide', dispose, { once: true });
  window.addEventListener('blur', pauseWhenAway);
  document.addEventListener('visibilitychange', pauseWhenAway);
  if (loading) loading.hidden = true;
  frameID = requestAnimationFrame(frame);
}
