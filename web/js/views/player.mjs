// The in-app player view.
//
// Hosts player.html in an iframe and mediates between it and the shell: reports
// play time, persists save states to disk, and owns the way out. The emulator
// itself lives entirely inside that iframe — see player.html for why.

import { h } from './../util.mjs';
import { api, artUrl } from './../api.mjs';
import { toast } from './../toast.mjs';
import { setInputEnabled } from './../input.mjs';

export function render(ctx) {
  const { state, params, go, refresh } = ctx;
  const game = state.games.find((g) => g.id === params.id);
  const platform = game ? state.platforms.find((p) => p.id === game.platform) : null;

  if (!game || !platform?.wasm?.ready || game.inAppBlocked) {
    return {
      node: h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-mark', text: '!' }),
        h('h1', { class: 'empty-title', text: 'Cannot play that here' }),
        h('p', {
          class: 'empty-text',
          text: !game
            ? 'That game is no longer in the library.'
            : game.inAppBlocked
              || platform?.wasm?.reason
              || 'No WebAssembly core for this system.',
        }),
        h(
          'div',
          { class: 'empty-actions' },
          h('button', {
            class: 'btn btn-primary',
            nav: true,
            'data-nav-initial': '',
            text: 'Back',
            onClick: () => go('game', { id: params.id }, { replace: true }),
          }),
        ),
      ),
      crumbs: [{ text: 'Player' }],
      hints: [{ glyph: 'b', label: 'Back' }],
    };
  }

  // ---- the frame ----------------------------------------------------------
  const query = new URLSearchParams({
    id: game.id,
    system: platform.wasm.system,
    t: window.EMUSTEAM_TOKEN,
    title: game.title,
    // The player applies this immediately and can step it in-game.
    ff: String(state.settings.fastForwardRatio ?? 2.5),
    ffmode: String(state.settings.fastForwardMode ?? 'tap-or-hold'),
    // Goes on the end of the ROM URL. EmulatorJS decides how to open the file
    // from its extension, and names the in-game save after it.
    ext: String(game.ext || ''),
  });
  // Resume by default whenever a suspended session exists, so arriving here from
  // anywhere — the game page, the Continue rail, a search result — picks up where
  // you left off. "Start over" clears the slot first, so there is nothing to
  // resume by the time it launches.
  if (game.suspended && params.resume !== '0') query.set('resume', '1');
  if (params.disc) query.set('disc', params.disc);
  if (game.artPath) query.set('art', artUrl(game.artPath));

  const frame = h('iframe', {
    class: 'player-frame',
    src: `/player.html?${query.toString()}`,
    title: `${game.title} — in-app player`,
    // The player needs the gamepad and fullscreen; it needs nothing else.
    allow: 'gamepad *; fullscreen *; autoplay *',
  });

  // Held separately so progress updates can change the wording without taking
  // the hotkey list with them.
  const statusLabel = h('div', { text: `Loading ${game.title}…` });

  const status = h(
    'div',
    { class: 'player-status' },
    h('div', { class: 'spinner' }),
    statusLabel,
    // The one place hotkeys can be listed without covering the game.
    h('div', { class: 'player-hotkeys' },
      ...[
        ['Esc  /  Select+Start', 'Exit — keeps your place'],
        ['F2  /  Select+A', 'Quick save'],
        ['F4  /  Select+B', 'Quick load'],
        ['Tab  /  Select+R1', {
          toggle: 'Fast forward — press on, press off',
          hold: 'Fast forward — only while held',
          'tap-or-hold': 'Fast forward — tap to lock, hold for a burst',
        }[state.settings.fastForwardMode ?? 'tap-or-hold']],
        ['−  =  /  Select+D-pad', 'Fast-forward speed'],
        ['`  /  Select+L1', 'Slow motion (hold)'],
        ['P  /  Select+X', 'Pause'],
        ['F1  /  hold Select', 'Show hotkeys in game'],
      ].map(([keys, what]) =>
        h('div', { class: 'player-hotkey' },
          h('span', { class: 'player-hotkey-keys', text: keys }),
          h('span', { text: what }),
        ),
      ),
    ),
  );

  const shell = h('div', { class: 'player' }, frame, status);

  // ---- shell <-> frame ----------------------------------------------------
  let startedAt = 0;
  let leaving = false;

  const leave = ({ suspended = false, reason = '' } = {}) => {
    if (leaving) return;
    leaving = true;

    let seconds = 0;
    if (startedAt) {
      seconds = Math.round((Date.now() - startedAt) / 1000);
      // Fire and forget: the view is going away regardless.
      api.reportInApp(game.id, 'stop', seconds).catch(() => {});
    }
    // Removing the iframe is the teardown: worker, audio and WASM all go with it.
    //
    // Two things were measured here while chasing a report of another app coming
    // to the front on exit, and both came back negative — recorded so nobody
    // adds them back on a hunch:
    //
    //   - There is no Fullscreen API state to leave. The app is fullscreen via
    //     --kiosk, a window state; document.fullscreenElement is null in both
    //     this document and the player's throughout a game. An exitFullscreen()
    //     call here would be a window-state change for no reason at all.
    //   - Nothing needs its focus restored. Navigation is class-based
    //     (.is-focused) with key handling on window, so activeElement dropping to
    //     BODY when the iframe goes is normal and harmless — the pad and arrows
    //     keep working, verified after teardown.
    frame.remove();
    setInputEnabled(true);
    go('game', { id: game.id }, { replace: true });

    // One message for one action, rather than stacking a play-time toast on top
    // of a suspend toast for a single press of Escape.
    const played = seconds >= 10 ? ` after ${formatSpan(seconds)}` : '';
    if (suspended) {
      toast.good(`Suspended${played} — Resume picks up exactly where you left off.`);
    } else if (reason) {
      toast.error(`Left the game, but could not suspend it: ${reason}`);
    } else if (seconds >= 10) {
      toast.good(`Played ${game.title} for ${formatSpan(seconds)}`);
    }

    // Whether a suspended session now exists decides whether the button on the
    // game page reads Play or Resume, so the page needs fresh state.
    refresh?.({ keepFocus: true });
  };

  const onMessage = (ev) => {
    if (ev.origin !== window.location.origin) return;
    if (ev.data?.source !== 'emusteam-player') return;

    switch (ev.data.type) {
      case 'ready':
        // Only the wording changes — the hotkey list stays up until the game
        // actually starts, which is the whole window you have to read it in.
        statusLabel.textContent = 'Starting…';
        break;

      case 'started':
        status.remove();
        startedAt = Date.now();
        api.reportInApp(game.id, 'start').catch(() => {});
        break;

      case 'savestate':
        api
          .saveGameState(game.id, ev.data.data)
          .then(() => toast.good('Save state written to disk.'))
          .catch((err) => toast.error(err.message));
        break;

      case 'exit':
        leave(ev.data);
        break;

      case 'error':
        status.remove();
        toast.error(ev.data.message || 'The player failed to start.');
        leave();
        break;

      default:
        break;
    }
  };

  window.addEventListener('message', onMessage);

  // While the emulator has the screen, the shell must not react to the pad —
  // otherwise every button press also moves focus on the page behind it.
  setInputEnabled(false);

  // The view can also be torn down by something other than `leave` (a refresh,
  // a session event). Watch for the node leaving the document and clean up.
  const observer = new MutationObserver(() => {
    if (!shell.isConnected) {
      observer.disconnect();
      window.removeEventListener('message', onMessage);
      setInputEnabled(true);
    }
  });
  observer.observe(document.getElementById('stage'), { childList: true, subtree: false });

  return {
    node: shell,
    crumbs: [{ text: game.title }],
    tint: platform.tint,
    tintSeed: game.title,
    // Deliberately empty: the hint bar is hidden while playing, and the player
    // flashes its own hotkey reminder on start instead.
    hints: [],
    chromeless: true,
    onAction: (action) => {
      // Belt and braces: if focus is on the shell rather than the frame, Escape
      // should still get you out.
      if (action === 'back') {
        // Focus is on the shell, not the frame, so the player never saw the key and
        // cannot suspend for us. Leaving without a state beats being stuck.
        leave();
        return true;
      }
      return true; // swallow everything else; the game is playing
    },
  };
}

function formatSpan(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}
