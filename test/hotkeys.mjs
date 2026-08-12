#!/usr/bin/env node
// In-game hotkey tests.  Run them with:  npm test
//
// These drive the *real* fast-forward state machine out of web/player.html — the
// source between the test:hotkeys markers is extracted verbatim and executed here
// with a fake gamepad, a fake keyboard and a fake clock.
//
// Why not test it in a browser: the gamepad path is polled from
// requestAnimationFrame, and a headless browser pane never runs rAF. A bug that
// only shows up on the *second and later* frames of a held button is therefore
// invisible to browser testing — which is exactly the bug that shipped. Frames
// have to be steppable, so the loop is driven by hand.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  [32mok[0m   ${label}`);
  } else {
    failures.push(label);
    console.log(`  [31mFAIL[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name) {
  console.log(`\n[2m${name}[0m`);
}

// ---------------------------------------------------------------- extraction

// Overridable so the test can be pointed at a deliberately-broken copy to prove
// it still fails — a green suite means nothing until you have watched it go red.
const playerPath = process.env.EMUSTEAM_PLAYER_HTML
  || path.join(repoRoot, 'web', 'player.html');
const html = fs.readFileSync(playerPath, 'utf8');
const begin = html.indexOf('test:hotkeys-begin');
const end = html.indexOf('test:hotkeys-end');
if (begin < 0 || end < 0 || end < begin) {
  console.error(
    'Could not find the test:hotkeys markers in web/player.html. If the hotkey\n'
    + 'block moved, move the markers with it — do not delete this test.',
  );
  process.exit(1);
}
// Start after the marker comment's own line so the extracted text is only code.
const source = html.slice(html.indexOf('\n', begin) + 1, end).replace(/\/\/[^\n]*$/, '');

// Fail loudly rather than mysteriously if the extraction ever comes up short —
// an empty or truncated slice would otherwise surface as "x is not defined" from
// inside a generated function, which is a miserable thing to debug.
for (const needed of ['fastForwardButton', 'HOLD_COMBOS', 'HOLD_KEYS', 'nudgeSpeed', 'pollHotkeys']) {
  if (!source.includes(needed)) {
    console.error(
      `Extracted ${source.length} chars from web/player.html but found no `
      + `${needed}. The test:hotkeys markers no longer span the hotkey block.`,
    );
    process.exit(1);
  }
}

const SELECT = 8;
const R1 = 5;
const L1 = 4;
const START = 9;

/**
 * Instantiate the extracted state machine.
 *
 * Everything the block reaches for from outside is passed in, so nothing here
 * depends on a DOM. The returned handle steps frames and time by hand.
 */
function bootPlayer({ mode = 'tap-or-hold', ff = '2.5' } = {}) {
  let clock = 1000;
  // What the *core* was actually told — the real thing under test. Tracking the
  // module's own booleans would hide a state machine that thinks it is off while
  // the core is still running fast.
  const core = { ff: false, ffRatio: 0, slow: false, running: true, ffCalls: 0 };
  // Suspend-and-exit lives outside the extracted region (it is state persistence,
  // not input handling), so it is stubbed — but how often the binding fires is
  // exactly the thing that broke for fast forward, so it gets counted.
  const calls = { exit: 0, quickSave: 0, quickLoad: 0 };
  const flashes = [];
  const pads = [
    { connected: true, buttons: Array.from({ length: 17 }, () => ({ pressed: false })) },
  ];
  let poll = null;
  const listeners = {};

  const manager = () => ({
    setFastForwardRatio: (r) => { core.ffRatio = r; },
    toggleFastForward: (n) => { core.ff = n === 1; core.ffCalls++; },
    setSlowMotionRatio: () => {},
    toggleSlowMotion: (n) => { core.slow = n === 1; },
    toggleMainLoop: (n) => { core.running = n === 1; },
    saveState: () => new Uint8Array([1]),
    loadState: () => {},
  });

  const scope = {
    params: new URLSearchParams({ ffmode: mode, ff }),
    manager,
    flash: (msg) => { flashes.push(String(msg)); },
    post: () => {},
    token: 'test-token',
    gameId: 'game_test',
    quickSave: () => { calls.quickSave++; },
    quickLoad: () => { calls.quickLoad++; },
    suspendAndExit: () => { calls.exit++; },
    showKeys: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    performance: { now: () => clock },
    navigator: { getGamepads: () => pads },
    requestAnimationFrame: (fn) => { poll = fn; },
    window: {
      addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    },
  };

  const keys = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    ...keys,
    `${source}\nreturn {
       get fastForwarding() { return fastForwarding },
       get ffLocked() { return ffLocked },
       get ratio() { return ratio },
       nudgeSpeed,
     };`,
  );
  const inner = factory(...keys.map((k) => scope[k]));

  const emit = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));

  return {
    core,
    calls,
    flashes,
    inner,
    lastFlash: () => flashes[flashes.length - 1] || '',
    /** Advance the fake clock without running a frame. */
    tick: (ms) => { clock += ms; },
    /** Hold or release a pad button. Takes effect on the next frame(). */
    hold: (button, down = true) => { pads[0].buttons[button].pressed = down; },
    /** Run one poll iteration, optionally advancing time first. */
    frame: (ms = 16) => { clock += ms; poll?.(); },
    key: (code, { up = false, repeat = false } = {}) =>
      emit(up ? 'keyup' : 'keydown', {
        code,
        repeat,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
      }),
    blur: () => emit('blur', {}),
  };
}

/** Press the Select+<button> chord and hold it for `frames` polled frames. */
function chordDown(p, button, frames = 1, msPerFrame = 16) {
  p.hold(SELECT, true);
  p.hold(button, true);
  for (let i = 0; i < frames; i++) p.frame(msPerFrame);
}
function chordUp(p, button, frames = 1) {
  p.hold(button, false);
  p.hold(SELECT, false);
  for (let i = 0; i < frames; i++) p.frame(16);
}

// ------------------------------------------------------------------- gamepad

section('fast forward — gamepad, tap-or-hold');
{
  // The regression. Select+R1 held for a while then released must return to
  // normal speed. Before the fix the poll loop called the button handler on
  // *every* frame, which restarted the tap timer 60 times a second, so a two
  // second hold measured as a 16ms tap and locked on instead of releasing.
  const p = bootPlayer({ mode: 'tap-or-hold' });
  chordDown(p, R1, 1);
  check('a held chord engages fast forward', p.core.ff === true);
  for (let i = 0; i < 40; i++) p.frame(16); // ~0.65s of holding, well past the tap window
  check('still fast while held', p.core.ff === true);
  chordUp(p, R1);
  check('releasing a long hold returns to normal speed', p.core.ff === false,
    `core.ff=${p.core.ff} locked=${p.inner.ffLocked}`);
}
{
  const p = bootPlayer({ mode: 'tap-or-hold' });
  chordDown(p, R1, 1);
  p.hold(R1, false);
  p.frame(100); // released 100ms in — inside the 550ms pad tap window
  check('a quick tap locks fast forward on', p.core.ff === true && p.inner.ffLocked === true);
  check('and says so', /lock/i.test(p.lastFlash()), p.lastFlash());

  // Pressing again must turn it off and *stay* off while the button is still
  // down. The original bug unlocked on frame 1 and re-locked on frame 2.
  p.hold(SELECT, true);
  p.hold(R1, true);
  p.frame(16);
  check('pressing again turns it off', p.core.ff === false, `core.ff=${p.core.ff}`);
  for (let i = 0; i < 30; i++) p.frame(16);
  check('and it stays off while the button is still held', p.core.ff === false,
    `core.ff=${p.core.ff} locked=${p.inner.ffLocked}`);
  chordUp(p, R1);
  check('and stays off after release', p.core.ff === false,
    `core.ff=${p.core.ff} locked=${p.inner.ffLocked}`);
}
{
  // The core must not be re-commanded on every frame either: that is a worker
  // round trip 60 times a second for a button nobody pressed.
  const p = bootPlayer({ mode: 'tap-or-hold' });
  chordDown(p, R1, 30);
  check('the core is told once per press, not once per frame', p.core.ffCalls === 1,
    `${p.core.ffCalls} calls`);
}

section('fast forward — gamepad, toggle');
{
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, R1, 20); // a long press, deliberately
  check('press engages', p.core.ff === true);
  chordUp(p, R1);
  check('release does not disengage', p.core.ff === true);
  for (let i = 0; i < 10; i++) p.frame(16);
  check('and it stays on with nothing held', p.core.ff === true);
  chordDown(p, R1, 20);
  check('a second press disengages', p.core.ff === false);
  check('and says so', /off/i.test(p.lastFlash()), p.lastFlash());
  chordUp(p, R1);
  check('still off after release', p.core.ff === false);
}
{
  // One press must count once however long it is held.
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, R1, 60);
  check('holding does not flip repeatedly', p.core.ff === true && p.core.ffCalls === 1,
    `ff=${p.core.ff} calls=${p.core.ffCalls}`);
  chordUp(p, R1);
}

section('fast forward — gamepad, hold');
{
  const p = bootPlayer({ mode: 'hold' });
  chordDown(p, R1, 1);
  check('engages on press', p.core.ff === true);
  for (let i = 0; i < 40; i++) p.frame(16);
  check('stays engaged while held', p.core.ff === true);
  chordUp(p, R1);
  check('disengages the moment it is released', p.core.ff === false);
  chordDown(p, R1, 1);
  chordUp(p, R1);
  check('and works a second time', p.core.ff === false && p.core.ffCalls === 4,
    `calls=${p.core.ffCalls}`);
}
{
  // Letting go of Select first is the natural way to end the chord.
  const p = bootPlayer({ mode: 'hold' });
  chordDown(p, R1, 5);
  p.hold(SELECT, false);
  p.frame(16);
  check('releasing Select first also disengages', p.core.ff === false);
}

// ------------------------------------------------------------------ keyboard

section('fast forward — keyboard');
{
  // Same bug, different door: keydown auto-repeat is "still held", not a new
  // press, and HOLD_KEYS was not filtering ev.repeat.
  const p = bootPlayer({ mode: 'tap-or-hold' });
  p.key('Tab');
  check('Tab engages fast forward', p.core.ff === true);
  p.tick(500);
  for (let i = 0; i < 20; i++) { p.key('Tab', { repeat: true }); p.tick(30); }
  check('still fast while held down', p.core.ff === true);
  p.key('Tab', { up: true });
  check('releasing a long hold returns to normal speed', p.core.ff === false,
    `core.ff=${p.core.ff} locked=${p.inner.ffLocked}`);
}
{
  const p = bootPlayer({ mode: 'tap-or-hold' });
  p.key('Tab');
  p.tick(80);
  p.key('Tab', { up: true });
  check('a quick tap locks on', p.core.ff === true && p.inner.ffLocked === true);
  p.key('Tab');
  check('tapping again turns it off', p.core.ff === false);
  p.key('Tab', { up: true });
  check('and stays off', p.core.ff === false, `locked=${p.inner.ffLocked}`);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  p.key('Tab');
  p.tick(400);
  for (let i = 0; i < 10; i++) { p.key('Tab', { repeat: true }); p.tick(30); }
  p.key('Tab', { up: true });
  check('toggle: one keypress, one flip, whatever the auto-repeat does',
    p.core.ff === true && p.core.ffCalls === 1, `ff=${p.core.ff} calls=${p.core.ffCalls}`);
}

section('losing focus mid-hold');
{
  const p = bootPlayer({ mode: 'tap-or-hold' });
  p.key('Tab');
  p.tick(900);
  p.blur();
  check('a momentary hold is cancelled by blur', p.core.ff === false);
}
{
  const p = bootPlayer({ mode: 'tap-or-hold' });
  p.key('Tab');
  p.tick(80);
  p.key('Tab', { up: true }); // locked
  p.blur();
  check('a deliberate lock survives blur', p.core.ff === true);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  p.key('Tab');
  p.blur();
  check('a toggle survives blur', p.core.ff === true);
}

// -------------------------------------------------------------- other combos

section('the rest of the chord map');
{
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, L1, 1);
  check('Select+L1 starts slow motion', p.core.slow === true);
  chordUp(p, L1);
  check('and ends it on release', p.core.slow === false);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  // Speed steps are 1.5 2 2.5 3 4 8 unlimited; 2.5 is the default.
  chordDown(p, 12, 1); // D-pad up — faster
  check('Select+D-pad up steps the speed up', p.inner.ratio === 3, `ratio=${p.inner.ratio}`);
  chordUp(p, 12);
  chordDown(p, 13, 1); // D-pad down — slower
  check('Select+D-pad down steps it back', p.inner.ratio === 2.5, `ratio=${p.inner.ratio}`);
  chordUp(p, 13);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, 12, 40);
  check('holding D-pad up steps once, not once per frame', p.inner.ratio === 3,
    `ratio=${p.inner.ratio}`);
  chordUp(p, 12);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, 2, 1); // X — pause
  check('Select+X pauses', p.core.running === false);
  chordUp(p, 2);
  chordDown(p, 2, 1);
  check('and resumes', p.core.running === true);
  chordUp(p, 2);
}
{
  // A bare button press without the modifier must never fire a hotkey — the
  // game needs Start, A and B for itself.
  const p = bootPlayer({ mode: 'toggle' });
  for (const button of [START, R1, L1, 0, 1, 2, 12, 13]) {
    p.hold(button, true);
    p.frame(16);
    p.hold(button, false);
    p.frame(16);
  }
  check('no hotkey fires without Select held',
    p.core.ff === false && p.core.slow === false && p.core.running === true
      && p.inner.ratio === 2.5 && p.calls.exit === 0,
    `ff=${p.core.ff} slow=${p.core.slow} running=${p.core.running} ratio=${p.inner.ratio} exits=${p.calls.exit}`);
}

section('leaving the game');
{
  // Exit now writes a save state, so firing it repeatedly would queue redundant
  // multi-megabyte writes — and on the old every-frame code a one-second hold
  // would have fired it 60 times.
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, START, 40);
  check('Select+Start leaves the game exactly once', p.calls.exit === 1,
    `${p.calls.exit} calls`);
  chordUp(p, START);
  check('and not again on release', p.calls.exit === 1, `${p.calls.exit} calls`);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  p.key('Escape');
  check('Escape leaves the game', p.calls.exit === 1, `${p.calls.exit} calls`);
  for (let i = 0; i < 10; i++) p.key('Escape', { repeat: true });
  check('and auto-repeat does not fire it again', p.calls.exit === 1, `${p.calls.exit} calls`);
}
{
  const p = bootPlayer({ mode: 'toggle' });
  chordDown(p, 0, 30);
  check('Select+A quick saves once per press', p.calls.quickSave === 1, `${p.calls.quickSave}`);
  chordUp(p, 0);
  chordDown(p, 1, 30);
  check('Select+B quick loads once per press', p.calls.quickLoad === 1, `${p.calls.quickLoad}`);
  chordUp(p, 1);
}

// ------------------------------------------------------------------- summary

console.log(
  failures.length
    ? `\n[31m${pass} passed, ${failures.length} failed[0m`
    : `\n[32m${pass} passed, 0 failed[0m`,
);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
