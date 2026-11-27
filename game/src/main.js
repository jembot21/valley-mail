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
import {
  UPGRADE_DEFINITIONS,
  loadProgression,
  saveProgression,
  purchaseUpgrade,
  isUpgradeEquipped,
  applyProgressionToPlane,
  unlockNextSortie,
} from './progression.js';
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
  const progression = loadProgression();
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
    const sortie = OPTIONS[index];
    if (sortie.id !== 'free' && !progression.unlockedSortieIds.includes(sortie.id)) {
      announce(`Sortie ${sortie.name} is locked. Complete earlier sorties first.`);
      return;
    }
    selection = index;
    world = createSortieWorld(sortie);
    if (plane) resetPlane(plane, world);
    else plane = createPlane(world);
    applyProgressionToPlane(plane, progression);
    run = createRun(sortie, world, world.rings ?? createRings(world), plane);
    plane.fuel = run.startingFuel;
    card = null;
    message = '';
    messageTTL = 0;
    lowFuelWarned = false;
    changeScreen('briefing');
  }

  function launchFlight() {
    announce(isFreeFlight() ? 'Free Flight · explore the valley. Esc returns to title.'
      : `${OPTIONS[selection].name} · follow the rings and bring the mail home.`);
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
    return Number(run?.ringsHit ?? run?.score?.ringsHit ?? run?.nextRing) || 0;
  }

  function parcelPhase() {
    const parcel = run?.parcel;
    if (!parcel) return 'ready';
    const phase = String(parcel.status ?? parcel.state ?? '').toLowerCase();
    if (parcel.hit || parcel.delivered || /^(hit|delivered|success)$/.test(phase)) return 'hit';
    if (parcel.missed || /^(missed|lost|failed)$/.test(phase)) return 'missed';
    if (parcel.dropped || parcel.inFlight || /^(dropped|falling|airborne)$/.test(phase)) return 'dropped';
    return 'ready';
  }

  function touchdownSeverity() {
    const grade = plane?.landingGrade;
    const label = String(plane?.landingLabel ?? grade ?? '').toLowerCase();
    if (/butter|perfect|excellent|smooth|^a\+?$/.test(label)) return 0.1;
    if (/good|soft|clean|^b$/.test(label)) return 0.3;
    if (/firm|^c$/.test(label)) return 0.55;
    if (/hard|rough|^d$/.test(label)) return 0.8;
    if (/crash|poor|^f$/.test(label)) return 1;
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
        // Safe fallback
      }
    }
    if (card.creditsEarned) {
      progression.credits += card.creditsEarned;
    }
    if (outcomeTitle() === 'MAIL DELIVERED') {
      unlockNextSortie(progression, OPTIONS[selection].id);
      audio.delivered();
    }
    saveProgression(progression);
    changeScreen('score');
  }

  function outcomeTitle() {
    const outcome = String(card?.outcome ?? '').trim().toUpperCase().replace(/[_-]/g, ' ');
    if (/DELIVERED|SUCCESS/.test(outcome)) return 'MAIL DELIVERED';
    if (/FUEL/.test(outcome)) return 'OUT OF FUEL';
    if (/HULL/.test(outcome)) return 'HULL LOST';
    if (/CRASH/.test(outcome)) return 'CRASHED';
    return outcome || 'SORTIE COMPLETE';
  }

  function totalScore() {
    const value = card?.totalScore ?? card?.total ?? card?.score?.total ?? card?.score
      ?? run?.score?.total ?? run?.score;
    return value == null ? NaN : Number(value);
  }

  function scoreRows() {
    const rows = [
      ['Mission outcome', card.reason || outcomeTitle()],
      ['Mail rings threaded', `${card.ringsHit ?? ringsHit()} / ${card.ringsTotal ?? run?.rings?.length ?? 5}`],
      ['Flight duration', `${timeLabel(card.timeSeconds ?? run?.elapsedSeconds)} (Par: ${timeLabel(OPTIONS[selection].parTimeSeconds)})`],
    ];
    if (!isFreeFlight()) {
      rows.push(
        ['Touchdown grade', card.landingLabel ?? card.landingGrade ?? plane?.landingLabel ?? '—'],
        ['Delivery combo streak', `Max ${card.maxStreak ?? 0} rings chained`],
        ['Airframe condition', card.damageTaken != null ? `${Math.round(Math.max(0, 100 - card.damageTaken))}% integrity` : '100% integrity'],
        ['Sortie reward', `+$${(card.creditsEarned ?? 0).toLocaleString()} credits`],
      );
    }
    rows.push(['Total score', scoreLabel(totalScore())]);
    return rows;
  }

  function hasNextSortie() {
    return !isFreeFlight() && selection < CAMPAIGN.length - 1;
  }

  function continueFromScore() {
    if (hasNextSortie()) chooseSortie(selection + 1);
    else returnToTitle();
  }

  function drawScoreCard() {
    const isCompact = CANVAS.height <= 520;
    panel(isCompact ? 60 : 150, isCompact ? 24 : 50, isCompact ? 1160 : 980, isCompact ? 432 : 620);

    text(outcomeTitle(), isCompact ? 90 : 190, isCompact ? 40 : 80, isCompact ? 36 : 44, colours.ink, 800);
    text(OPTIONS[selection].name, isCompact ? 90 : 190, isCompact ? 78 : 130, isCompact ? 20 : 24, colours.accent, 600);

    // Letter grade badge
    const gradeBadge = card.grade ?? 'A';
    const gradeCol = card.gradeColor ?? colours.accent;
    const badgeX = isCompact ? 1040 : 940;
    const badgeY = isCompact ? 36 : 68;
    panel(badgeX, badgeY, isCompact ? 140 : 150, isCompact ? 66 : 76, gradeCol);
    text(gradeBadge, badgeX + (isCompact ? 70 : 75), badgeY + (isCompact ? 24 : 28), isCompact ? 38 : 46, gradeCol, 800, 'center');
    text(card.gradeTitle ?? 'RANK A', badgeX + (isCompact ? 70 : 75), badgeY + (isCompact ? 50 : 58), isCompact ? 14 : 16, colours.ink, 600, 'center');

    const rows = scoreRows();
    const rowHeight = isCompact ? 28 : Math.min(42, 220 / rows.length);
    const startY = isCompact ? 114 : 180;
    rows.forEach(([label, value], index) => {
      const y = startY + index * rowHeight;
      text(label, isCompact ? 90 : 190, y, isCompact ? 17 : 21, colours.muted);
      text(value, isCompact ? 1180 : 1090, y, isCompact ? 18 : 22, colours.ink, 600, 'right');
    });

    const record = best[sortieKey(OPTIONS[selection])];
    if (Number.isFinite(record)) {
      text(`${newBest ? 'New record!' : 'Best score:'} ${scoreLabel(record)}   ·   Bank credits: $${progression.credits.toLocaleString()}`,
        isCompact ? 90 : 190, isCompact ? 360 : 510, isCompact ? 17 : 20, colours.accent, 600);
    }

    const btnY = isCompact ? 394 : 560;
    const btnH = isCompact ? 44 : 56;
    button(hasNextSortie() ? 'Next Sortie' : 'Return to Title', isCompact ? 90 : 190, btnY, isCompact ? 220 : 250, btnH, continueFromScore, true);
    button('Hangar Upgrades', isCompact ? 320 : 460, btnY, isCompact ? 220 : 250, btnH, () => changeScreen('hangar'));
    button('Retry', isCompact ? 550 : 730, btnY, isCompact ? 160 : 180, btnH, restartFlight);
    button('Title', isCompact ? 720 : 930, btnY, isCompact ? 160 : 180, btnH, returnToTitle);
  }

  function drawHangar() {
    const isCompact = CANVAS.height <= 520;
    panel(isCompact ? 40 : 80, isCompact ? 20 : 40, isCompact ? 1200 : 1120, isCompact ? 440 : 640);
    text('AIRCRAFT HANGAR & UPGRADES', isCompact ? 70 : 120, isCompact ? 36 : 65, isCompact ? 32 : 42, colours.ink, 800);
    text(`CREDITS: $${progression.credits.toLocaleString()}`, isCompact ? 1040 : 960, isCompact ? 38 : 70, isCompact ? 22 : 28, colours.accent, 700, 'right');

    const colW = isCompact ? 560 : 520;
    const rowH = isCompact ? 86 : 124;
    UPGRADE_DEFINITIONS.forEach((upgrade, idx) => {
      const col = idx % 2;
      const row = Math.floor(idx / 2);
      const x = isCompact ? 70 + col * (colW + 20) : 120 + col * (colW + 40);
      const y = isCompact ? 78 + row * (rowH + 6) : 125 + row * (rowH + 15);

      panel(x, y, colW, rowH);
      text(upgrade.name, x + 14, y + 10, isCompact ? 17 : 22, colours.ink, 700);
      text(`${upgrade.category} · $${upgrade.cost.toLocaleString()}`, x + colW - 14, y + 10, isCompact ? 15 : 18, colours.accent, 600, 'right');
      wrapped(upgrade.description, x + 14, y + (isCompact ? 32 : 40), colW - 140, isCompact ? 17 : 22, isCompact ? 13 : 15);

      const equipped = isUpgradeEquipped(progression, upgrade.id);
      const canAfford = progression.credits >= upgrade.cost;
      const btnW = isCompact ? 116 : 130;
      const btnH = isCompact ? 34 : 42;
      const btnX = x + colW - btnW - 12;
      const btnY = y + (rowH - btnH) / 2 + 8;

      if (equipped) {
        button('EQUIPPED', btnX, btnY, btnW, btnH, () => {}, false);
      } else if (canAfford) {
        button('BUY', btnX, btnY, btnW, btnH, () => {
          const res = purchaseUpgrade(progression, upgrade.id);
          if (res.success) {
            audio.upgradePurchased();
            announce(`${upgrade.name} equipped!`);
          }
        }, true);
      } else {
        button(`$${upgrade.cost}`, btnX, btnY, btnW, btnH, () => {
          announce(`Need $${upgrade.cost - progression.credits} more credits.`);
        }, false);
      }
    });

    const bottomY = isCompact ? 408 : 590;
    button('Enter / Space · Return to Sorties', isCompact ? 70 : 120, bottomY, isCompact ? 360 : 400, isCompact ? 38 : 50, returnToTitle, true);
    text('All equipped upgrades persist across all valley sorties.', isCompact ? 450 : 540, bottomY + (isCompact ? 10 : 15), isCompact ? 15 : 18, colours.muted);
  }

  function captureFlightSnapshot() {
    return {
      rings: ringsHit(),
      hull: plane?.hull ?? 100,
      gear: plane?.gearDown ?? true,
      stalled: plane?.stalled ?? false,
      parcel: parcelPhase(),
    };
  }

  function updateMessageTTL(dt) {
    messageTTL = Math.max(0, messageTTL - dt);
    if (!messageTTL) message = '';
  }

  function consumeTickInput(controls) {
    const tickInput = { ...controls, gear: pendingGear, drop: pendingDrop, pause: false, confirm: false };
    pendingGear = false;
    pendingDrop = false;
    return tickInput;
  }

  function processFlightEvents(previous) {
    if (plane.gearDown !== previous.gear) {
      audio.gearToggle(plane.gearDown);
      announce(`Landing gear ${plane.gearDown ? 'down' : 'up'}.`);
    }
    const threaded = ringsHit() - previous.rings;
    if (threaded > 0) {
      audio.comboChime(run.combo?.streak ?? 1);
      announce(`Ring threaded · Combo x${(run.combo?.multiplier ?? 1).toFixed(1)} [Streak ${run.combo?.streak ?? 1}]`);
    }
    if (plane.justTouchedDown) {
      audio.touchdown(touchdownSeverity());
      announce(`Touchdown · ${plane.landingLabel ?? plane.landingGrade ?? 'on runway'}`);
    }
    const hullLost = previous.hull - plane.hull;
    if (hullLost >= 5) audio.damage(Math.min(1, hullLost / 100));
    const parcel = parcelPhase();
    if (parcel !== previous.parcel) {
      if (parcel === 'dropped') announce('Parcel dropped · watch descent.');
      else if (parcel === 'hit') announce('Parcel on target · mail delivered!', 4);
      else if (parcel === 'missed') announce('Parcel missed target zone.', 4);
    }
    audio.stall(Boolean(plane.stalled));
    if (plane.stalled && !previous.stalled) announce('STALL WARNING · lower nose and accelerate.', 4);
    if (!lowFuelWarned && plane.fuel <= 20) {
      lowFuelWarned = true;
      announce('Low fuel caution · approach destination.', 4);
    }
  }

  function checkFlightCompletion() {
    if (!isFreeFlight() || plane.crashed || plane.fuel <= 0 || plane.hull <= 0) {
      const result = finishRun(run, plane);
      if (result) showScoreCard(result);
    }
  }

  function stepFlight(controls) {
    const previous = captureFlightSnapshot();
    updateMessageTTL(STEP);
    const tickInput = consumeTickInput(controls);
    stepPlane(plane, tickInput, world, STEP);
    stepRun(run, plane, tickInput, STEP);
    updateAudio(true);
    processFlightEvents(previous);
    checkFlightCompletion();
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

  function panel(x, y, width, height, outline = colours.accent, fill = colours.panel) {
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

  function button(label, x, y, width, height, action, selected = false, detail = '') {
    const hovered = mouse.inside && mouse.x >= x && mouse.x <= x + width
      && mouse.y >= y && mouse.y <= y + height;
    ctx.save();
    ctx.globalAlpha = selected || hovered ? 0.22 : 0.08;
    ctx.fillStyle = colours.accent;
    ctx.fillRect(x, y, width, height);
    ctx.restore();
    if (selected || hovered) {
      ctx.strokeStyle = colours.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, width, height);
    }
    text(label, x + 16, y + 10, 20, colours.ink, 600);
    if (detail) wrapped(detail, x + 16, y + 36, width - 32, 18, 15);
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
    demoPlane.position.x = demoOrigin.x + Math.sin(angle) * 90;
    demoPlane.position.z = demoOrigin.z + (Math.cos(angle) - 1) * 90;
    demoPlane.position.y = demoOrigin.y + 55 + Math.sin(angle * 0.7) * 4;
    demoPlane.heading = demoHeading + angle * 180 / Math.PI;
    demoPlane.onGround = false;
    draw(ctx, demoWorld, demoPlane, demoRun);
  }

  function drawTitle() {
    const isCompact = CANVAS.height <= 520;
    panel(isCompact ? 36 : 48, isCompact ? 16 : 30, isCompact ? 940 : 920, isCompact ? 448 : 660);

    text('VALLEY MAIL', isCompact ? 60 : 76, isCompact ? 30 : 48, isCompact ? 44 : 56, colours.ink, 800);
    text('Bush-pilot postal service down rugged river corridors.', isCompact ? 60 : 78, isCompact ? 80 : 112, isCompact ? 17 : 20);
    text('Controls: Pitch W/S · Bank A/D · Throttle Shift/Ctrl · Gear G · Drop Space',
      isCompact ? 60 : 78, isCompact ? 104 : 144, isCompact ? 14 : 17, colours.muted);

    text('SELECT SORTIE  [ENTER / SPACE · PLAY]', isCompact ? 60 : 78, isCompact ? 134 : 184, isCompact ? 16 : 18, colours.accent, 700);

    const btnH = isCompact ? 44 : 64;
    const spacing = isCompact ? 48 : 68;
    const listStartY = isCompact ? 158 : 214;

    OPTIONS.forEach((sortie, index) => {
      const unlocked = sortie.id === 'free' || progression.unlockedSortieIds.includes(sortie.id);
      const y = listStartY + index * spacing;
      const label = `${index + 1}  ${sortie.name} ${unlocked ? '' : '🔒'}`;
      const weatherTag = sortie.weather ? `[${sortie.weather.toUpperCase()}] ` : '';
      const detail = unlocked ? `${weatherTag}${sortie.briefing}` : 'Locked · Complete preceding sorties to unlock.';
      button(label, isCompact ? 58 : 76, y, isCompact ? 890 : 860, btnH,
        () => chooseSortie(index), selection === index, isCompact ? '' : detail);
    });

    const bottomY = isCompact ? listStartY + OPTIONS.length * spacing + 6 : 612;
    button('H · Hangar Upgrades', isCompact ? 58 : 76, bottomY, isCompact ? 260 : 280, isCompact ? 38 : 46, () => changeScreen('hangar'));
    button('Enter / Space · Play', isCompact ? 330 : 370, bottomY, isCompact ? 260 : 280, isCompact ? 38 : 46, () => chooseSortie(selection), true);

    const record = best[sortieKey(OPTIONS[selection])];
    if (Number.isFinite(record)) {
      text(`Best: ${scoreLabel(record)}`, isCompact ? 610 : 670, bottomY + 12, isCompact ? 15 : 18, colours.accent);
    }
  }

  function drawBriefing() {
    const isCompact = CANVAS.height <= 520;
    const sortie = OPTIONS[selection];
    panel(isCompact ? 80 : 142, isCompact ? 30 : 88, isCompact ? 1120 : 996, isCompact ? 420 : 544);

    text(isFreeFlight() ? 'FREE FLIGHT' : `SORTIE ${selection + 1}`, isCompact ? 120 : 180, isCompact ? 55 : 120, 18, colours.accent, 700);
    text(sortie.name, isCompact ? 120 : 180, isCompact ? 85 : 159, isCompact ? 34 : 43, colours.ink, 700);
    wrapped(sortie.briefing, isCompact ? 120 : 180, isCompact ? 135 : 225, isCompact ? 1040 : 916, isCompact ? 24 : 30, isCompact ? 18 : 22, colours.ink);

    const statsY = isCompact ? 210 : 340;
    text('RINGS', isCompact ? 120 : 180, statsY, 17, colours.accent, 700);
    text(String(run?.rings?.length ?? sortie.ringCount), isCompact ? 120 : 180, statsY + 30, 28);
    text('FUEL', isCompact ? 420 : 480, statsY, 17, colours.accent, 700);
    text(`${Math.round(run?.startingFuel ?? 100)}%`, isCompact ? 420 : 480, statsY + 30, 28);
    text('WEATHER', isCompact ? 720 : 780, statsY, 17, colours.accent, 700);
    text(sortie.weather?.toUpperCase() ?? 'CLEAR', isCompact ? 720 : 780, statsY + 30, 28);

    const btnY = isCompact ? 380 : 509;
    button('Enter / Space · Launch', isCompact ? 120 : 180, btnY, isCompact ? 460 : 565, isCompact ? 50 : 62, launchFlight, true);
    button('Back', isCompact ? 600 : 775, btnY, isCompact ? 260 : 320, isCompact ? 50 : 62, returnToTitle);
  }

  let mouse = { x: -1, y: -1, inside: false };

  function pollFrameInputs() {
    const up = input.consumePress('ArrowUp') || input.consumePress('KeyW');
    const down = input.consumePress('ArrowDown') || input.consumePress('KeyS');
    const escape = input.consumePress('Escape');
    const hangar = input.consumePress('KeyH');
    const number = OPTIONS.findIndex((_, i) => input.consumePress(`Digit${i + 1}`)
      || input.consumePress(`Numpad${i + 1}`));
    const controls = input.poll();
    const rawMouse = controls.mouse || { x: -1, y: -1, inside: false };
    const designPoint = point => ({ ...point, x: point.x / pixelRatio, y: point.y / pixelRatio });
    mouse = designPoint(rawMouse);
    const clicks = Array.isArray(rawMouse.clicks) && rawMouse.clicks.length
      ? rawMouse.clicks.map(designPoint) : mouse.clicked ? [mouse] : [];
    return { up, down, escape, hangar, number, controls, clicks };
  }

  function updateScreenState(inputs, dt) {
    const { up, down, escape, hangar, number, controls } = inputs;
    if (screen === 'title') {
      if (hangar) changeScreen('hangar');
      else if (up || down) selection = (selection + (down ? 1 : -1) + OPTIONS.length) % OPTIONS.length;
      else if (number >= 0) chooseSortie(number);
      else if (controls.confirm) chooseSortie(selection);
    } else if (screen === 'hangar') {
      if (escape || controls.confirm) returnToTitle();
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
      if (hangar) changeScreen('hangar');
      else if (escape) returnToTitle();
      else if (controls.confirm) continueFromScore();
    }
  }

  function renderActiveScreen(dt) {
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    buttons = [];
    if (screen === 'title' || screen === 'briefing' || screen === 'hangar') {
      drawDemo(dt);
      if (screen === 'title') drawTitle();
      else if (screen === 'hangar') drawHangar();
      else drawBriefing();
    } else {
      drawFlight();
      if (screen === 'paused') drawPause();
      else if (screen === 'score') drawScoreCard();
    }
  }

  function dispatchButtonClicks(clicks, screenAtFrameStart) {
    if (clicks.length && screen === screenAtFrameStart) {
      const hit = clicks.map(point => buttons.find(({ x, y, width, height }) => point.x >= x && point.x <= x + width
        && point.y >= y && point.y <= y + height)).find(Boolean);
      if (hit) hit.action();
    }
  }

  function frame(timestamp) {
    if (disposed) return;
    const dt = previousTime === null ? 0 : Math.min(MAX_FRAME, Math.max(0, (timestamp - previousTime) / 1000));
    previousTime = timestamp;

    const inputs = pollFrameInputs();
    const screenAtFrameStart = screen;
    updateScreenState(inputs, dt);
    renderActiveScreen(dt);
    dispatchButtonClicks(inputs.clicks, screenAtFrameStart);
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
