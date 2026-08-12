// Settings → "Play in app": the complete in-app catalogue.
//
// Deliberately not filtered by your library. "What can this thing play?" is a
// question you want answered *before* going to find ROMs for something, and a
// list that only shows what you already own cannot answer it. So every supported
// system is listed whether or not you have a game or the core, and the systems
// that genuinely need a standalone emulator are listed too, with the reason.

import { h } from './../util.mjs';
import { api } from './../api.mjs';
import { toast } from './../toast.mjs';
import { chooseModal } from './../modal.mjs';

const SPEED_STEPS = [1.5, 2, 2.5, 3, 4, 8, 0];
const speedLabel = (r) => (Number(r) === 0 ? 'Unlimited' : `${r}×`);

/**
 * How the fast-forward button behaves.
 *
 * "Toggle" is called out as the pad-friendly option because it genuinely is:
 * tap-to-lock needs a press *and release* inside a short window, and doing that
 * with a two-button chord is awkward however generous the window.
 */
const FF_MODES = [
  {
    id: 'toggle',
    title: 'Toggle',
    note: 'Press once to speed up, press again to stop. Most reliable on a controller.',
    chip: 'Toggle',
  },
  {
    id: 'hold',
    title: 'Hold',
    note: 'Fast only while the button is held down.',
    chip: 'Hold',
  },
  {
    id: 'tap-or-hold',
    title: 'Tap or hold',
    note: 'A quick tap locks it on; a longer hold is momentary. Both from one button.',
    chip: 'Tap or hold',
  },
];

const ffRowLabel = (mode) => ({
  toggle: 'Fast forward — press on, press off',
  hold: 'Fast forward — only while held',
  'tap-or-hold': 'Fast forward — tap to lock, hold for a burst',
}[mode] || 'Fast forward');

const HOTKEYS = [
  ['Exit — suspends, so Resume picks up here', 'Esc', 'Select + Start'],
  ['Quick save', 'F2', 'Select + A'],
  ['Quick load', 'F4', 'Select + B'],
  [null, 'Tab', 'Select + R1'],
  ['Fast-forward speed', '−  =', 'Select + D-pad'],
  ['Slow motion (hold)', '`', 'Select + L1'],
  ['Pause / resume', 'P', 'Select + X'],
  ['Show hotkeys on screen', 'hold F1', 'hold Select'],
];

export function inAppPanel(ctx) {
  const { state, refresh } = ctx;
  const inApp = state.inApp || { supported: [], unsupported: [], runtimeInstalled: false };
  // Which systems you actually own games for, so the list can point that out
  // without being reduced to only those.
  const owned = new Set(state.platforms.map((p) => p.id));

  const ready = inApp.supported.filter((row) => row.installed);
  const available = inApp.supported.filter((row) => !row.installed);

  const systemRow = (row, installed) =>
    h(
      'div',
      { class: 'listrow' },
      h(
        'div',
        { class: 'listrow-main' },
        h(
          'div',
          { class: 'listrow-title' },
          h('span', { text: row.name }),
          installed ? h('span', { class: 'chip pill-good', text: 'ready' }) : null,
          owned.has(row.platform) ? h('span', { class: 'chip', text: 'in your library' }) : null,
        ),
        h('div', { class: 'field-hint', text: `core: ${row.core}` }),
      ),
      h('span', {
        class: 'chip mono',
        text: installed ? row.system : `fetch-cores -- ${row.platform}`,
      }),
    );

  return h(
    'div',
    {},

    // ---- what can run in the app ------------------------------------------
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Play in the app' }),
      h('p', {
        class: 'panel-note',
        text: 'These run inside EmuSteam using a WebAssembly build of the real libretro core — no emulator to install, no process launch, no window handoff. Downloading a core is all it takes; you do not need the game first.',
      }),

      inApp.runtimeInstalled
        ? null
        : h(
            'div',
            {
              class: 'listrow',
              style: {
                borderColor: 'color-mix(in oklab, var(--gold) 45%, transparent)',
                marginBottom: '16px',
              },
            },
            h(
              'div',
              { class: 'listrow-main' },
              h('div', { class: 'listrow-title', text: 'The in-app player is not installed yet' }),
              h('div', { class: 'field-hint', text: 'Run  npm run fetch-cores  once to download it.' }),
            ),
            h('div', {}),
          ),

      h('div', {
        class: 'fact-k',
        style: { margin: '4px 0 8px' },
        text: `Ready to play here — ${ready.length} system${ready.length === 1 ? '' : 's'}`,
      }),
      ready.length
        ? h('div', { class: 'rowlist' }, ...ready.map((row) => systemRow(row, true)))
        : h('div', {
            class: 'field-hint',
            text: 'None downloaded yet. Run  npm run fetch-cores  to get some.',
          }),

      h('div', {
        class: 'fact-k',
        style: { margin: '24px 0 8px' },
        text: `Available to download — ${available.length} more`,
      }),
      available.length
        ? h(
            'div',
            {},
            h('p', {
              class: 'field-hint',
              style: { marginBottom: '10px' },
              text: 'About 1–2 MB each, downloaded once and then served from disk.',
            }),
            h('div', { class: 'rowlist' }, ...available.map((row) => systemRow(row, false))),
          )
        : h('div', { class: 'field-hint', text: 'Every supported system is already downloaded.' }),

      h('div', {
        class: 'browser-path',
        style: { marginTop: '18px' },
        text: 'npm run fetch-cores -- all      # every core, roughly 30 MB',
      }),
    ),

    // ---- what needs a real emulator ---------------------------------------
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Needs a real emulator' }),
      h('p', {
        class: 'panel-note',
        text: 'No usable WebAssembly build exists for these — and for most of them the standalone emulator is better anyway. Add one under Emulators and their games get a normal Play button.',
      }),
      h(
        'div',
        { class: 'rowlist' },
        ...inApp.unsupported.map((row) =>
          h(
            'div',
            { class: 'listrow' },
            h(
              'div',
              { class: 'listrow-main' },
              h(
                'div',
                { class: 'listrow-title' },
                h('span', { text: row.name }),
                owned.has(row.platform)
                  ? h('span', { class: 'chip', text: 'in your library' })
                  : null,
              ),
              h('div', { class: 'field-hint', text: row.reason }),
            ),
            h('div', {}),
          ),
        ),
      ),
    ),

    // ---- speed + hotkeys ---------------------------------------------------
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Fast forward' }),

      // --- how the button behaves -------------------------------------------
      h(
        'button',
        {
          class: 'toggle',
          nav: true,
          'data-nav-key': 'ff-mode',
          style: { marginTop: '0' },
          onClick: async () => {
            const current = state.settings.fastForwardMode ?? 'tap-or-hold';
            const picked = await chooseModal({
              title: 'Fast-forward button',
              note: 'How the fast-forward button behaves in game — Tab on the keyboard, Select + R1 on a controller.',
              options: FF_MODES.map((m) => ({
                id: m.id,
                title: m.title,
                note: m.note,
                selected: current === m.id,
              })),
            });
            if (picked === null) return;
            try {
              await api.saveSettings({ fastForwardMode: picked });
              refresh({ keepFocus: true });
            } catch (err) {
              toast.error(err.message);
            }
          },
        },
        h(
          'div',
          {},
          h('div', { class: 'toggle-label', text: 'Button behaviour' }),
          h('div', {
            class: 'toggle-note',
            text:
              FF_MODES.find((m) => m.id === (state.settings.fastForwardMode ?? 'tap-or-hold'))?.note
              || '',
          }),
        ),
        h('div', {
          class: 'chip chip-strong',
          text:
            FF_MODES.find((m) => m.id === (state.settings.fastForwardMode ?? 'tap-or-hold'))?.chip
            || 'Tap or hold',
        }),
      ),

      // --- how fast ----------------------------------------------------------
      h(
        'button',
        {
          class: 'toggle',
          nav: true,
          'data-nav-key': 'ff-speed',
          onClick: async () => {
            const current = Number(state.settings.fastForwardRatio ?? 2.5);
            const picked = await chooseModal({
              title: 'Fast-forward speed',
              note: 'Applies while fast forward is engaged. Also adjustable mid-game with − / = or Select + D-pad.',
              options: SPEED_STEPS.map((ratio) => ({
                id: String(ratio),
                title: ratio === 0 ? 'Unlimited' : `${ratio}× speed`,
                note: ratio === 0 ? 'As fast as your machine manages — may stutter audio.' : null,
                selected: current === ratio,
              })),
            });
            if (picked === null) return;
            try {
              await api.saveSettings({ fastForwardRatio: Number(picked) });
              refresh({ keepFocus: true });
            } catch (err) {
              toast.error(err.message);
            }
          },
        },
        h(
          'div',
          {},
          h('div', { class: 'toggle-label', text: 'Speed' }),
          // Describes the multiplier only — how the *button* works is the
          // setting above, and repeating it here goes stale the moment it changes.
          h('div', {
            class: 'toggle-note',
            text: 'How much faster than normal. Also adjustable mid-game with − / = or Select + D-pad.',
          }),
        ),
        h('div', {
          class: 'chip chip-strong',
          text: speedLabel(state.settings.fastForwardRatio ?? 2.5),
        }),
      ),

      h('div', { class: 'fact-k', style: { margin: '24px 0 8px' }, text: 'In-game hotkeys' }),
      h('p', {
        class: 'field-hint',
        style: { marginBottom: '12px' },
        text: 'Nothing sits over the picture while you play — hold Select (or F1) during a game to see this list on screen.',
      }),
      h(
        'div',
        { class: 'rowlist' },
        ...HOTKEYS.map(([what, keyboard, pad]) =>
          h(
            'div',
            { class: 'listrow' },
            h('div', { class: 'listrow-main' }, h('div', {
              class: 'listrow-title',
              text: what ?? ffRowLabel(state.settings.fastForwardMode ?? 'tap-or-hold'),
            })),
            h(
              'div',
              { class: 'listrow-actions' },
              h('span', { class: 'chip mono', text: keyboard }),
              h('span', { class: 'chip mono', text: pad }),
            ),
          ),
        ),
      ),
    ),
  );
}
