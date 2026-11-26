/**
 * Keyboard and canvas-menu mouse state. Exports createInput(canvas, { onGesture? }?).
 * The returned API has poll(), isHeld(code), consumePress(code), reset(), dispose().
 * poll() consumes edges once: { pitch, bank, throttle, gear, drop, pause, confirm,
 * mute, mouse: { x, y, inside, down, clicked, clicks } }. Axes are -1..1:
 * +pitch climbs, +bank turns right, +throttle increases power. Mouse coordinates
 * are in canvas backing pixels; clicks is a queue of { x, y } for that frame.
 * Space sets BOTH drop and confirm; the current screen decides which to use.
 * onGesture runs synchronously in the handler, suitable for audio.unlock().
 */
import { CONTROLS } from './config.js';

const GAME_KEYS = new Set(Object.values(CONTROLS).flat());

function isEditing(target) {
  return target?.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName);
}

/** Tracks raw keyboard state: active holds and single-tick edge presses. */
function createKeyStateTracker(gameKeys, { onGesture = () => {} } = {}) {
  const held = new Set();
  const presses = new Set();

  function onKeyDown(event) {
    if (!gameKeys.has(event.code) || isEditing(event.target) || event.isComposing) return;
    event.preventDefault();
    // A repeat arriving after focus loss must not resurrect a held key.
    if (event.repeat) return;
    if (!held.has(event.code)) {
      held.add(event.code);
      presses.add(event.code);
      onGesture(event);
    }
  }

  function onKeyUp(event) {
    if (gameKeys.has(event.code) && !isEditing(event.target)) event.preventDefault();
    held.delete(event.code);
  }

  function isHeld(code) {
    return held.has(code);
  }

  function consume(code) {
    return presses.delete(code);
  }

  function hasPress(code) {
    return presses.has(code);
  }

  function clearPresses() {
    presses.clear();
  }

  function reset() {
    held.clear();
    presses.clear();
  }

  return {
    onKeyDown,
    onKeyUp,
    isHeld,
    consume,
    hasPress,
    clearPresses,
    reset,
  };
}

/** Maps raw key state and edge presses into high-level flight/menu actions. */
function createActionMapper(controls, keyTracker) {
  function evaluateAxis(positive, negative) {
    return Number(positive.some((code) => keyTracker.isHeld(code))) -
      Number(negative.some((code) => keyTracker.isHeld(code)));
  }

  function evaluateAction(name) {
    // Check every binding; short-circuiting would leave a second binding queued.
    let pressed = false;
    for (const code of controls[name]) {
      if (keyTracker.hasPress(code)) pressed = true;
    }
    return pressed;
  }

  function pollFrame(mouseState, frameClicks) {
    const frame = {
      pitch: evaluateAxis(controls.pitchUp, controls.pitchDown),
      bank: evaluateAxis(controls.bankRight, controls.bankLeft),
      throttle: evaluateAxis(controls.throttleUp, controls.throttleDown),
      gear: evaluateAction('gear'),
      drop: evaluateAction('drop'),
      pause: evaluateAction('pause'),
      confirm: evaluateAction('confirm'),
      mute: evaluateAction('mute'),
      mouse: { ...mouseState, clicked: frameClicks.length > 0, clicks: frameClicks },
    };
    keyTracker.clearPresses();
    return frame;
  }

  return {
    evaluateAxis,
    evaluateAction,
    pollFrame,
  };
}

export function createInput(canvas, { onGesture = () => {} } = {}) {
  const view = canvas.ownerDocument.defaultView;
  const document = canvas.ownerDocument;
  const keys = createKeyStateTracker(GAME_KEYS, { onGesture });
  const mapper = createActionMapper(CONTROLS, keys);
  const clicks = [];
  const mouse = { x: 0, y: 0, inside: false, down: false };
  let disposed = false;

  function updateMouse(event) {
    const bounds = canvas.getBoundingClientRect();
    const width = bounds.width;
    const height = bounds.height;
    if (!width || !height) {
      mouse.inside = false;
      return;
    }
    mouse.x = (event.clientX - bounds.left) * canvas.width / width;
    mouse.y = (event.clientY - bounds.top) * canvas.height / height;
    mouse.inside = mouse.x >= 0 && mouse.x < canvas.width &&
      mouse.y >= 0 && mouse.y < canvas.height;
  }

  function keyDown(event) {
    keys.onKeyDown(event);
  }

  function keyUp(event) {
    keys.onKeyUp(event);
  }

  function mouseDown(event) {
    if (event.button !== 0) return;
    updateMouse(event);
    if (!mouse.inside) return;
    mouse.down = true;
    onGesture(event);
  }

  function mouseUp(event) {
    if (event.button !== 0) return;
    updateMouse(event);
    mouse.down = false;
  }

  function click(event) {
    if (event.button !== 0) return;
    updateMouse(event);
    if (mouse.inside) clicks.push({ x: mouse.x, y: mouse.y });
  }

  function reset() {
    keys.reset();
    clicks.length = 0;
    mouse.down = false;
    mouse.inside = false;
  }

  function visibilityChange() {
    if (document.hidden) reset();
  }

  function poll() {
    const frameClicks = clicks.splice(0);
    return mapper.pollFrame(mouse, frameClicks);
  }

  view.addEventListener('keydown', keyDown);
  view.addEventListener('keyup', keyUp);
  view.addEventListener('mousemove', updateMouse);
  view.addEventListener('mouseup', mouseUp);
  view.addEventListener('blur', reset);
  canvas.addEventListener('mousedown', mouseDown);
  canvas.addEventListener('click', click);
  document.addEventListener('visibilitychange', visibilityChange);

  function dispose() {
    if (disposed) return;
    disposed = true;
    view.removeEventListener('keydown', keyDown);
    view.removeEventListener('keyup', keyUp);
    view.removeEventListener('mousemove', updateMouse);
    view.removeEventListener('mouseup', mouseUp);
    view.removeEventListener('blur', reset);
    canvas.removeEventListener('mousedown', mouseDown);
    canvas.removeEventListener('click', click);
    document.removeEventListener('visibilitychange', visibilityChange);
    reset();
  }

  return Object.freeze({
    poll,
    isHeld: (code) => keys.isHeld(code),
    consumePress: (code) => keys.consume(code),
    reset,
    dispose,
  });
}
