// One input stream from three devices.
//
// Gamepad, keyboard and mouse all funnel into the same named actions, so every
// view only ever handles `confirm` / `back` / `up` and never asks which device
// the user is holding. Directions auto-repeat when held; buttons do not.

const REPEAT_DELAY_MS = 360;
const REPEAT_RATE_MS = 105;
const AXIS_DEADZONE = 0.55;

/** Standard-mapping button index -> action. Exported so Settings can show it. */
export const BUTTON_ACTIONS = {
  0: 'confirm',
  1: 'back',
  2: 'alt',
  3: 'favorite',
  4: 'pageLeft',
  5: 'pageRight',
  8: 'search',
  9: 'menu',
  12: 'up',
  13: 'down',
  14: 'left',
  15: 'right',
};

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

/**
 * Human names for the standard-mapping button indices, so the controller test
 * screen can say "button 1 (B)" instead of just "button 1".
 */
export const BUTTON_NAMES = {
  0: 'A / Cross', 1: 'B / Circle', 2: 'X / Square', 3: 'Y / Triangle',
  4: 'LB / L1', 5: 'RB / R1', 6: 'LT / L2', 7: 'RT / R2',
  8: 'Back / Select', 9: 'Start / Options', 10: 'Left stick click', 11: 'Right stick click',
  12: 'D-pad up', 13: 'D-pad down', 14: 'D-pad left', 15: 'D-pad right',
  16: 'Guide / PS',
};

const KEY_ACTIONS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
  Enter: 'confirm', NumpadEnter: 'confirm', Space: 'confirm',
  Escape: 'back', Backspace: 'back',
  KeyF: 'favorite',
  KeyE: 'alt',
  Slash: 'search',
  Comma: 'menu',
  BracketLeft: 'pageLeft', BracketRight: 'pageRight',
  PageUp: 'pageLeft', PageDown: 'pageRight',
  Home: 'home',
};

const listeners = new Set();
// Suspended while the in-app player owns the screen, so the shell behind it does
// not also react to every button press.
let enabled = true;
let padConnected = false;
const padListeners = new Set();

/** @param {(action:string, meta:{source:string, repeat:boolean}) => void} fn */
export function onAction(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notified when a controller appears or disappears, for the UI hint bar. */
export function onPadChange(fn) {
  padListeners.add(fn);
  fn(padConnected);
  return () => padListeners.delete(fn);
}

export function isPadConnected() {
  return padConnected;
}

/** Stop/resume delivering actions to the shell. */
export function setInputEnabled(value) {
  enabled = !!value;
}

function emit(action, source, repeat = false) {
  if (!enabled || !action) return;
  for (const fn of [...listeners]) {
    try {
      fn(action, { source, repeat });
    } catch (err) {
      console.error('[emusteam] input handler failed', err);
    }
  }
}

// ------------------------------------------------------------- keyboard

/** True when the user is typing and arrow keys / letters must reach the field. */
function isTextTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

window.addEventListener(
  'keydown',
  (ev) => {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;

    const action = KEY_ACTIONS[ev.code];
    if (!action) return;

    if (isTextTarget(ev.target)) {
      // In a field, only Escape and Enter are ours; the rest belongs to the field.
      if (action !== 'back' && action !== 'confirm') return;
      // Backspace must still delete characters.
      if (ev.code === 'Backspace') return;
    }

    // Space scrolls the page by default; Enter re-fires clicks on buttons.
    ev.preventDefault();
    emit(action, 'keyboard', ev.repeat);
  },
  { capture: true },
);

// ------------------------------------------------------------- gamepad

/** @type {Map<number, {buttons: Map<string, number>, axes: Map<string, number>}>} */
const padState = new Map();
let pollHandle = null;

function setPadConnected(value) {
  if (padConnected === value) return;
  padConnected = value;
  for (const fn of padListeners) {
    try {
      fn(padConnected);
    } catch { /* ignore */ }
  }
}

/**
 * Track one action's held state and decide whether this frame should fire.
 * Returns 'press' | 'repeat' | null.
 */
function stepHold(map, action, isDown, now) {
  const nextAt = map.get(action);

  if (!isDown) {
    if (nextAt !== undefined) map.delete(action);
    return null;
  }
  if (nextAt === undefined) {
    map.set(action, now + REPEAT_DELAY_MS);
    return 'press';
  }
  if (DIRECTIONS.has(action) && now >= nextAt) {
    map.set(action, now + REPEAT_RATE_MS);
    return 'repeat';
  }
  return null;
}

function pollGamepads() {
  pollHandle = requestAnimationFrame(pollGamepads);

  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const now = performance.now();
  let anyConnected = false;

  for (const pad of pads) {
    if (!pad || !pad.connected) continue;
    anyConnected = true;

    if (!padState.has(pad.index)) {
      padState.set(pad.index, { buttons: new Map(), axes: new Map() });
    }
    const state = padState.get(pad.index);

    // Buttons (includes the D-pad on standard mapping).
    for (const [indexStr, action] of Object.entries(BUTTON_ACTIONS)) {
      const button = pad.buttons[Number(indexStr)];
      const isDown = !!button && (button.pressed || button.value > 0.6);
      const fired = stepHold(state.buttons, action, isDown, now);
      if (fired) emit(action, 'gamepad', fired === 'repeat');
    }

    // Left stick, and the right stick as a bonus (same directions).
    const axisPairs = [
      [pad.axes[0], pad.axes[1]],
      [pad.axes[2], pad.axes[3]],
    ];
    for (let pair = 0; pair < axisPairs.length; pair++) {
      const [x, y] = axisPairs[pair];
      if (typeof x !== 'number' || typeof y !== 'number') continue;

      const checks = [
        [`${pair}:left`, 'left', x <= -AXIS_DEADZONE],
        [`${pair}:right`, 'right', x >= AXIS_DEADZONE],
        [`${pair}:up`, 'up', y <= -AXIS_DEADZONE],
        [`${pair}:down`, 'down', y >= AXIS_DEADZONE],
      ];
      for (const [key, action, isDown] of checks) {
        const fired = stepHold(state.axes, key, isDown, now);
        if (fired) emit(action, 'gamepad', fired === 'repeat');
      }
    }
  }

  setPadConnected(anyConnected);
}

window.addEventListener('gamepadconnected', () => {
  if (pollHandle === null) pollGamepads();
});
window.addEventListener('gamepaddisconnected', (ev) => {
  padState.delete(ev.gamepad.index);
});

/** Start polling. Safe to call more than once. */
export function startInput() {
  if (pollHandle === null) pollGamepads();
}
