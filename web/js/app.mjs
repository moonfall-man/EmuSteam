// App shell: state, routing, the top bar, the hint bar, and the one place that
// decides what a button press means.
//
// Views are pure-ish: render(ctx) returns a node plus the chrome it wants
// (breadcrumbs, tint, hints, an optional action handler). The shell owns
// everything else, so no view has to think about focus, history or the pad.

import { h, clear, fmtClock, fmtTimer, debounce } from './util.mjs';
import { api, subscribeEvents } from './api.mjs';
import * as nav from './nav.mjs';
import { onAction, onPadChange, startInput, isPadConnected } from './input.mjs';
import { isModalOpen, handleModalAction, confirmModal } from './modal.mjs';
import { toast } from './toast.mjs';
import { setAmbient, GALAXY_TINT } from './art.mjs';
import * as homeView from './views/home.mjs';
import * as platformView from './views/platform.mjs';
import * as gameView from './views/game.mjs';
import * as settingsView from './views/settings.mjs';
import * as playerView from './views/player.mjs';

const VIEWS = {
  home: homeView,
  platform: platformView,
  game: gameView,
  settings: settingsView,
  player: playerView,
};

const state = {
  ready: false,
  games: [],
  platforms: [],
  allPlatforms: [],
  emulators: [],
  sources: [],
  settings: { sort: 'name', showHidden: false, scanOnStart: true, clock: true, reduceMotion: false },
  cores: {},
  artDirs: [],
  capabilities: {},
  warnings: [],
  scannedAt: 0,
  session: null,
  query: '',
};

/** @type {Array<{name:string, params:object, scrollTop:number, focusKey:string|null}>} */
let history = [{ name: 'home', params: {}, scrollTop: 0, focusKey: null }];
let activeView = null;

const els = {
  topbar: document.getElementById('topbar'),
  stage: document.getElementById('stage'),
  hints: document.getElementById('hints'),
  boot: document.getElementById('boot'),
  overlay: document.getElementById('overlay-root'),
};

let searchInput = null;

// ------------------------------------------------------------------ routing

function currentEntry() {
  return history[history.length - 1];
}

function rememberPosition() {
  const entry = currentEntry();
  entry.scrollTop = els.stage.scrollTop;
  entry.focusKey = nav.currentKey();
}

function go(name, params = {}, { replace = false } = {}) {
  if (!VIEWS[name]) {
    console.warn('[emusteam] unknown view', name);
    return;
  }
  rememberPosition();
  const entry = { name, params, scrollTop: 0, focusKey: null };
  if (replace) history[history.length - 1] = entry;
  else history.push(entry);
  renderView({ restore: false });
}

/**
 * How deep each view sits. Back uses this to guarantee it only ever moves
 * *outward*, which is the property that makes B feel right.
 *
 * A plain history pop replays wherever you came from, so home -> grid -> game
 * -> breadcrumb back to grid, then B, drops you back *into* the game you just
 * climbed out of. Pure hierarchy fixes that but overcorrects: open a game from
 * Home's "Continue playing" rail and B would dump you in a grid you never
 * visited. Walking history while skipping anything same-or-deeper gets both —
 * you return where you came from, but never downward.
 */
const VIEW_DEPTH = { home: 0, platform: 1, settings: 1, game: 2, player: 3 };

function depthOf(entry) {
  return VIEW_DEPTH[entry.name] ?? 1;
}

function canGoBack() {
  return depthOf(currentEntry()) > 0;
}

/**
 * The hierarchical parent, used only as a fallback when history holds nothing
 * shallower than where we are.
 * @returns {{name:string, params:object}|null} null when already at the top
 */
function parentOf(entry) {
  switch (entry.name) {
    case 'home':
      return null;

    case 'platform':
      return { name: 'home', params: {} };

    case 'game': {
      // Up from a game is its own system's grid — not whichever rail or search
      // result you happened to open it from.
      const game = state.games.find((g) => g.id === entry.params.id);
      return game
        ? { name: 'platform', params: { platform: game.platform } }
        : { name: 'home', params: {} };
    }

    case 'settings':
      return { name: 'home', params: {} };

    case 'player':
      return { name: 'game', params: { id: entry.params.id } };

    default:
      return { name: 'home', params: {} };
  }
}

/**
 * Go outward one level. Returns false only at the very top, so the caller can
 * offer to exit instead.
 */
function back() {
  const current = currentEntry();
  const currentDepth = depthOf(current);
  if (currentDepth === 0) return false;

  rememberPosition();

  // Most recent entry that is genuinely shallower than here. Unwinding to a real
  // history entry also restores its scroll position and focused card.
  for (let i = history.length - 2; i >= 0; i--) {
    if (depthOf(history[i]) < currentDepth) {
      history.length = i + 1;
      afterBack(history[i]);
      renderView({ restore: true });
      return true;
    }
  }

  // Nothing shallower in history: fall back to the hierarchical parent, and
  // replace rather than push so repeated presses keep climbing.
  const parent = parentOf(current);
  if (!parent) return false;
  history[history.length - 1] = { name: parent.name, params: parent.params, scrollTop: 0, focusKey: null };
  afterBack(parent);
  renderView({ restore: false });
  return true;
}

/** Landing back on home is the moment a search has clearly been left behind. */
function afterBack(parent) {
  if (parent.name === 'home' && state.query) {
    state.query = '';
  }
}

/** Reload server state, then re-render in place. */
async function refresh({ keepFocus = false } = {}) {
  try {
    await loadState();
  } catch (err) {
    toast.error(err.message);
    return;
  }
  renderView({ restore: true, keepFocus });
}

async function loadState() {
  const next = await api.state();
  Object.assign(state, next);
  state.ready = true;
  applySettings();
}

function applySettings() {
  document.documentElement.dataset.motion = state.settings.reduceMotion ? 'reduce' : 'full';
}

// ---------------------------------------------------------------- rendering

function renderView({ restore = false, keepFocus = false } = {}) {
  const entry = currentEntry();
  const previousKey = keepFocus ? nav.currentKey() : entry.focusKey;

  const ctx = { state, params: entry.params, go, back, refresh, setQuery };
  const view = VIEWS[entry.name].render(ctx);
  activeView = view;

  clear(els.stage).append(view.node);
  nav.setScope(els.stage);

  // A view can ask for the chrome to get out of the way (the in-app player).
  document.body.dataset.chromeless = view.chromeless ? 'true' : 'false';

  renderTopbar(view);
  renderHints(view);
  setAmbient(view.tint || GALAXY_TINT, view.tintSeed || entry.name);

  els.stage.scrollTop = restore ? entry.scrollTop || 0 : 0;

  if (!(previousKey && nav.focusKey(previousKey))) nav.focusInitial();
  renderNowPlaying();
}

function renderTopbar(view) {
  const bar = clear(els.topbar);

  const crumbs = view.crumbs || [];

  bar.append(
    h(
      'button',
      {
        class: 'mark',
        nav: true,
        'data-nav-key': 'logo',
        style: { background: 'none', border: 'none', padding: '0' },
        onClick: () => {
          if (currentEntry().name !== 'home') go('home', {});
        },
      },
      h('span', { class: 'mark-dot' }),
      h('span', { text: 'EmuSteam' }),
    ),
  );

  // A real Back button, not just breadcrumbs: mouse users had no way up, and it
  // gives the B button something visible to correspond to.
  if (canGoBack()) {
    bar.append(
      h('button', {
        class: 'btn btn-icon',
        nav: true,
        'data-nav-key': 'back',
        title: 'Back',
        'aria-label': 'Back',
        text: '‹',
        onClick: () => back(),
      }),
    );
  }

  if (crumbs.length) {
    const trail = h('div', { class: 'topbar-crumb' });
    crumbs.forEach((crumb, index) => {
      trail.append(h('span', { class: 'topbar-crumb-sep', text: '/' }));
      trail.append(
        crumb.onClick
          ? h('button', {
              class: 'chip',
              nav: true,
              'data-nav-key': `crumb-${index}`,
              text: crumb.text,
              onClick: crumb.onClick,
            })
          : h('span', { class: 'topbar-crumb-title truncate', text: crumb.text }),
      );
    });
    bar.append(trail);
  }

  if (view.subtitle) bar.append(h('span', { class: 'dim nowrap', text: view.subtitle }));

  bar.append(h('div', { class: 'spacer' }));

  // The search box keeps its value across re-renders because we rebuild it
  // from state.query every time.
  searchInput = h('input', {
    type: 'search',
    placeholder: 'Search games',
    value: state.query,
    spellcheck: 'false',
    autocomplete: 'off',
    'aria-label': 'Search games',
    onInput: debounce((ev) => setQuery(ev.target.value), 180),
    onKeydown: (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        if (state.query) setQuery('');
        else searchInput.blur();
      }
    },
  });

  bar.append(
    h(
      'label',
      { class: 'searchbox', nav: true, 'data-nav-key': 'search' },
      h('span', { class: 'searchbox-icon', text: '⌕' }),
      searchInput,
    ),
  );

  if (state.settings.clock) {
    bar.append(h('span', { class: 'topbar-clock', id: 'clock', text: fmtClock() }));
  }

  bar.append(
    h('button', {
      class: 'btn btn-icon',
      nav: true,
      'data-nav-key': 'settings',
      title: 'Settings',
      'aria-label': 'Settings',
      text: '⚙',
      onClick: () => {
        if (currentEntry().name !== 'settings') go('settings', {});
      },
    }),
  );
}

const GLYPHS = {
  a: { pad: ['glyph glyph-a', 'A'], key: 'Enter' },
  b: { pad: ['glyph glyph-b', 'B'], key: 'Esc' },
  x: { pad: ['glyph glyph-x', 'X'], key: 'E' },
  y: { pad: ['glyph glyph-y', 'Y'], key: 'F' },
  menu: { pad: ['glyph glyph-wide', '☰'], key: ',' },
  search: { pad: ['glyph glyph-wide', 'Back'], key: '/' },
};

function renderHints(view) {
  const bar = clear(els.hints);
  const pad = isPadConnected();

  for (const hint of view.hints || []) {
    const glyph = GLYPHS[hint.glyph];
    if (!glyph) continue;
    const [cls, padLabel] = glyph.pad;
    bar.append(
      h(
        'span',
        { class: 'hint' },
        h('span', { class: pad ? cls : 'glyph glyph-wide', text: pad ? padLabel : glyph.key }),
        h('span', { text: hint.label }),
      ),
    );
  }

  bar.append(h('div', { class: 'spacer' }));
  bar.append(
    h('span', {
      class: 'dim nowrap',
      text: pad ? 'Controller connected' : `${state.games.length} games`,
    }),
  );
}

// ------------------------------------------------------------------- search

function setQuery(value) {
  const next = String(value ?? '');
  if (state.query === next) return;
  state.query = next;

  // Searching from anywhere that is not a grid takes you to a searchable grid.
  if (next && currentEntry().name !== 'platform') {
    go('platform', { platform: '*' });
    // Remember that *we* navigated here, so emptying the box can undo it. If the
    // user browsed to All Games themselves, clearing the box leaves them there.
    currentEntry().fromSearch = true;
    refocusSearch();
    return;
  }

  if (!next && currentEntry().fromSearch) {
    back();
    return;
  }

  renderView({ restore: true, keepFocus: true });
  refocusSearch();
}

/** Re-rendering rebuilds the top bar, so put the caret back where it was. */
function refocusSearch() {
  if (!searchInput || document.activeElement === searchInput) return;
  searchInput.focus();
  searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
}

// -------------------------------------------------------------- now playing

let nowPlayingEl = null;
let timerHandle = null;

function renderNowPlaying() {
  // Never overlay the in-app player: it owns the screen already, and covering it
  // would hide the running game behind a status card.
  const session = currentEntry().name === 'player' ? null : state.session;

  if (!session) {
    if (nowPlayingEl) {
      nowPlayingEl.remove();
      nowPlayingEl = null;
    }
    if (timerHandle) {
      clearInterval(timerHandle);
      timerHandle = null;
    }
    return;
  }

  if (nowPlayingEl) return; // already showing

  const timer = h('div', { class: 'nowplaying-timer', text: fmtTimer(session.elapsedSeconds || 0) });

  nowPlayingEl = h(
    'div',
    { class: 'nowplaying' },
    h('div', { class: 'nowplaying-label', text: 'Now playing' }),
    h('div', { class: 'nowplaying-title', text: session.title || 'Game' }),
    // Only claim an emulator when we actually know which one — "via undefined"
    // is worse than saying nothing.
    session.emulator ? h('div', { class: 'nowplaying-sub', text: `via ${session.emulator}` }) : null,
    timer,
    h(
      'div',
      { class: 'nowplaying-actions' },
      h('button', {
        class: 'btn btn-danger',
        nav: true,
        'data-nav-initial': '',
        text: 'Close the game',
        onClick: async () => {
          try {
            await api.stop();
          } catch (err) {
            toast.error(err.message);
          }
        },
      }),
    ),
    h('div', {
      class: 'dim',
      style: { fontSize: '14px', marginTop: '4px' },
      text: 'The emulator has focus. This screen returns to your library when the game exits.',
    }),
  );

  els.overlay.append(nowPlayingEl);
  nav.setScope(nowPlayingEl);
  nav.focusInitial();

  // Fall back to now if the payload had no start time, so the clock still
  // counts up instead of sitting frozen at 00:00.
  const startedAt = Number(session.startedAt) || Date.now();
  timerHandle = setInterval(() => {
    timer.textContent = fmtTimer((Date.now() - startedAt) / 1000);
  }, 1000);
}

// ------------------------------------------------------------ input routing

function handleAction(action) {
  // Modals first, then the now-playing overlay, then the view.
  if (isModalOpen()) {
    handleModalAction(action);
    return;
  }

  if (state.session) {
    if (action === 'confirm') nav.activate();
    else if (['up', 'down', 'left', 'right'].includes(action)) nav.move(action);
    // Back does not dismiss: the game is still running and this screen is the
    // only way to stop it.
    return;
  }

  if (activeView?.onAction && activeView.onAction(action) === true) return;

  switch (action) {
    case 'up': case 'down': case 'left': case 'right':
      nav.move(action);
      return;

    case 'confirm':
      nav.activate();
      return;

    case 'back':
      if (searchInput && document.activeElement === searchInput && state.query) {
        setQuery('');
        return;
      }
      if (!back()) offerExit();
      return;

    case 'favorite':
      toggleFocusedFavorite();
      return;

    case 'menu':
      if (currentEntry().name === 'settings') back();
      else go('settings', {});
      return;

    case 'search':
      if (searchInput) {
        nav.focusKey('search');
        searchInput.focus();
        searchInput.select();
      }
      return;

    case 'home':
      if (currentEntry().name !== 'home') go('home', {});
      return;

    case 'pageLeft':
    case 'pageRight':
      pageThroughPlatforms(action === 'pageRight' ? 1 : -1);
      return;

    default:
      return;
  }
}

async function toggleFocusedFavorite() {
  const gameId = nav.getCurrent()?.dataset.gameId;
  if (!gameId) return;
  const game = state.games.find((g) => g.id === gameId);
  if (!game) return;
  try {
    await api.setFlag(game.id, 'favorite', !game.favorite);
    toast.info(game.favorite ? `Removed ${game.title} from favourites` : `${game.title} favourited`);
    await refresh({ keepFocus: true });
  } catch (err) {
    toast.error(err.message);
  }
}

/** Shoulder buttons hop between systems without going back to home. */
function pageThroughPlatforms(delta) {
  const entry = currentEntry();
  if (entry.name !== 'platform' || !state.platforms.length) return;

  const ids = ['*', ...state.platforms.map((p) => p.id)];
  const index = ids.indexOf(entry.params.platform);
  if (index < 0) return;
  const next = ids[(index + delta + ids.length) % ids.length];
  go('platform', { platform: next }, { replace: true });
}

async function offerExit() {
  const yes = await confirmModal({
    title: 'Close EmuSteam?',
    note: 'Your library and play time are already saved.',
    confirmLabel: 'Close',
    danger: true,
  });
  if (!yes) return;
  window.close();
  // close() is a no-op for windows the page did not open, and kiosk mode may
  // refuse it outright — so say how to get out rather than leaving the user
  // staring at an unchanged screen.
  setTimeout(() => toast.info('Press Alt+F4 to close the window, or Ctrl+C in the console.'), 400);
}

// -------------------------------------------------------------------- boot

async function boot() {
  startInput();
  onAction(handleAction);
  onPadChange(() => {
    if (activeView) renderHints(activeView);
  });

  try {
    await loadState();
  } catch (err) {
    els.boot.querySelector('.boot-sub').textContent = err.message;
    return;
  }

  renderView({ restore: false });
  els.boot.classList.add('is-done');

  subscribeEvents((event, data) => {
    if (event === 'scan') {
      onScanEvent(data);
      return;
    }
    if (event === 'art') {
      onArtEvent(data);
      return;
    }
    if (event === 'session') {
      // In-app sessions never get the "Now playing" overlay. That screen exists
      // to explain that an external program has taken the display — when the game
      // is running inside this page, the player view *is* the now-playing UI, and
      // an overlay on top of it just hides the game.
      if (data.inApp) {
        if (!data.running) {
          // Play time and last-played changed; the player view already went away.
          refresh({ keepFocus: true });
        }
        return;
      }

      state.session = data.running ? data.session : null;
      renderNowPlaying();

      if (!data.running) {
        // Playtime and last-played changed; pull fresh numbers.
        refresh({ keepFocus: true });
        if (data.last?.error) toast.error(data.last.error);
        else if (data.last?.seconds >= 10) {
          toast.good(`Played ${data.last.title} for ${fmtTimer(data.last.seconds)}`);
        }
      }
    } else if (event === 'library') {
      refresh({ keepFocus: true });
    }
  });

  // Clock ticks on its own so a re-render is never needed just for the time.
  setInterval(() => {
    const clock = document.getElementById('clock');
    if (clock) clock.textContent = fmtClock();
  }, 20_000);

  // A gamepad already held at startup is only reported after the first input
  // event, so nudge the poller once the page is interactive.
  window.addEventListener('pointerdown', startInput, { once: true });
  window.addEventListener('keydown', startInput, { once: true });
}

boot();

// ---------------------------------------------------------- scan progress

let scanHideTimer = null;

/**
 * Report scan progress from the server's SSE stream.
 *
 * Deliberately counts rather than a percentage. Knowing the total means walking
 * the whole tree first, which *is* the scan — so a percentage would either be a
 * second full pass or a fabrication. "412 files in 31 folders, 380 games" is both
 * honest and more useful.
 */
function onScanEvent(data) {
  const bar = document.getElementById('scanbar');
  const title = document.getElementById('scanbar-title');
  const sub = document.getElementById('scanbar-sub');
  const bootSub = document.getElementById('boot-sub');
  if (!bar || !title || !sub) return;

  clearTimeout(scanHideTimer);

  if (data.phase === 'done') {
    const n = data.count ?? 0;
    title.textContent = `Found ${n} game${n === 1 ? '' : 's'}`;
    sub.textContent = data.ms != null ? `Scanned in ${fmtDuration(data.ms)}` : '';
    bar.classList.add('show', 'is-done');
    if (bootSub) bootSub.textContent = `${n} game${n === 1 ? '' : 's'} — nearly there…`;
    // Leave the result up briefly: vanishing the instant it finishes reads as
    // though nothing happened.
    scanHideTimer = setTimeout(() => bar.classList.remove('show', 'is-done'), 2600);
    refresh({ keepFocus: true });
    return;
  }

  bar.classList.remove('is-done');
  bar.classList.add('show');
  title.textContent = 'Scanning your library…';
  sub.textContent = scanDetail(data);
  if (bootSub) bootSub.textContent = scanDetail(data) || 'Reading your library…';
}

function scanDetail(data) {
  const bits = [];
  if (data.files != null) bits.push(`${data.files.toLocaleString()} file${data.files === 1 ? '' : 's'}`);
  if (data.folders != null) bits.push(`${data.folders.toLocaleString()} folder${data.folders === 1 ? '' : 's'}`);
  if (data.games != null) bits.push(`${data.games.toLocaleString()} game${data.games === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * Artwork download progress, shown in the same card as scanning.
 *
 * This one *can* show a percentage, unlike the scan: the number of images to fetch
 * is known before it starts.
 */
function onArtEvent(data) {
  const bar = document.getElementById('scanbar');
  const title = document.getElementById('scanbar-title');
  const sub = document.getElementById('scanbar-sub');
  if (!bar || !title || !sub) return;

  clearTimeout(scanHideTimer);

  if (data.phase === 'error') {
    bar.classList.remove('show', 'is-done');
    toast.error(`Artwork download failed: ${data.message}`);
    return;
  }

  if (data.phase === 'done') {
    const got = data.downloaded || 0;
    title.textContent = got ? `Downloaded ${got} image${got === 1 ? '' : 's'}` : 'No new artwork found';
    const parts = [];
    if (data.bytes) parts.push(fmtBytes(data.bytes));
    if (data.missed?.length) parts.push(`${data.missed.length} without a match`);
    if (data.skipped) parts.push(`${data.skipped} already had art`);
    sub.textContent = parts.join(' · ');
    bar.classList.add('show', 'is-done');
    scanHideTimer = setTimeout(() => bar.classList.remove('show', 'is-done'), 4000);
    refresh({ keepFocus: true });
    return;
  }

  bar.classList.remove('is-done');
  bar.classList.add('show');
  if (data.phase === 'start') {
    title.textContent = 'Downloading artwork…';
    sub.textContent = `${data.total} image${data.total === 1 ? '' : 's'} to look up`;
    return;
  }
  const pct = data.total ? Math.round((data.done / data.total) * 100) : 0;
  title.textContent = `Downloading artwork… ${pct}%`;
  sub.textContent = `${data.done} of ${data.total} — ${data.label || ''}`;
}

function fmtBytes(n) {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
