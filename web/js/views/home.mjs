// Home: what you see when the app opens.
//
// Continue playing first (the thing you most likely want), then favourites,
// then the systems. When the library is empty this becomes a three-step
// onboarding screen instead, because a blank grid teaches nothing.

import { h } from './../util.mjs';
import { gameCard, platformCard, allGamesCard, actionCard, rail } from './../cards.mjs';
import { addSourceFlow, addEmulatorFlow, rescan } from './../flows.mjs';
import { GALAXY_TINT } from './../art.mjs';

const MAX_RAIL = 16;

export function render(ctx) {
  const { state, go, refresh, addGames } = ctx;

  if (!state.games.length) {
    return {
      node: onboarding(ctx),
      crumbs: [],
      tint: GALAXY_TINT,
      hints: [
        { glyph: 'a', label: 'Select' },
        { glyph: 'menu', label: 'Settings' },
      ],
    };
  }

  const platformOf = (id) => state.platforms.find((p) => p.id === id);
  const visible = state.games.filter((g) => state.settings.showHidden || !g.hidden);

  const recent = visible
    .filter((g) => g.lastPlayed > 0)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, MAX_RAIL);

  const favorites = visible.filter((g) => g.favorite).slice(0, MAX_RAIL);

  const openGame = (game) => go('game', { id: game.id });

  const rows = h(
    'div',
    { class: 'rows' },
    rail(
      'Continue playing',
      recent.length || null,
      recent.map((game, i) =>
        gameCard(game, platformOf(game.platform), {
          onOpen: openGame,
          eager: i < 8,
          keyPrefix: 'recent',
        }),
      ),
    ),
    rail(
      'Favourites',
      favorites.length || null,
      favorites.map((game) =>
        gameCard(game, platformOf(game.platform), { onOpen: openGame, keyPrefix: 'fav' }),
      ),
    ),
    rail('Systems', state.platforms.length, [
      ...state.platforms
        .slice()
        .sort((a, b) => b.gameCount - a.gameCount || a.name.localeCompare(b.name))
        .map((platform) =>
          platformCard(platform, { onOpen: (p) => go('platform', { platform: p.id }) }),
        ),
      allGamesCard(visible.length, { onOpen: () => go('platform', { platform: '*' }) }),
      // Same chooser as the topbar button, at the end of the rail where someone
      // scrolling their systems will run into it.
      actionCard('Add games', 'Import ROMs, or point at a library', () => addGames(), 'add-source'),
    ]),
  );

  // First card on the page is where focus lands when you arrive.
  const firstCard = rows.querySelector('[data-nav]');
  if (firstCard) firstCard.dataset.navInitial = '';

  const unplayable = state.platforms.filter((p) => !p.playable);

  return {
    node: h(
      'div',
      {},
      unplayable.length ? emulatorNudge(unplayable, ctx) : null,
      rows,
    ),
    crumbs: [],
    tint: null,
    hints: [
      { glyph: 'a', label: 'Select' },
      { glyph: 'y', label: 'Favourite' },
      { glyph: 'search', label: 'Search' },
      { glyph: 'menu', label: 'Settings' },
    ],
  };
}

/** A quiet banner when games exist but nothing can run them. */
function emulatorNudge(platforms, ctx) {
  const names = platforms.map((p) => p.short).join(', ');
  return h(
    'div',
    { style: { padding: '0 var(--gutter) 20px' } },
    h(
      'button',
      {
        class: 'listrow',
        nav: true,
        style: { borderColor: 'color-mix(in oklab, var(--gold) 40%, transparent)' },
        onClick: async () => {
          if (await addEmulatorFlow(ctx.state)) ctx.refresh();
        },
      },
      h(
        'div',
        { class: 'listrow-main' },
        h('div', { class: 'listrow-title' }, h('span', { style: { color: 'var(--gold)' }, text: '!' }), h('span', { text: `No emulator set up for ${names}` })),
        h('div', { class: 'listrow-sub', text: 'Games from these systems will not launch until you add one.' }),
      ),
      h('div', { class: 'chip chip-strong', text: 'Add emulator' }),
    ),
  );
}

function onboarding(ctx) {
  const { state, refresh, go } = ctx;
  const hasSources = state.sources.length > 0;
  // A downloaded core *is* an emulator, so step 2 is satisfied by either. Without
  // this, someone who ran fetch-cores and can already play is told they still need
  // to go and find an emulator — and the app's whole point is that they do not.
  const readyCores = (state.inApp?.supported || []).filter((row) => row.installed);
  const hasEmulators = state.emulators.length > 0 || readyCores.length > 0;
  const onlyCores = state.emulators.length === 0 && readyCores.length > 0;

  const step = (n, done, title, note, action) =>
    h(
      action ? 'button' : 'div',
      {
        class: ['step', done && 'is-done'],
        nav: action ? true : null,
        'data-nav-initial': action && !done ? '' : null,
        onClick: action || null,
      },
      h('div', { class: 'step-n', text: done ? '✓' : String(n) }),
      h(
        'div',
        {},
        h('div', { class: 'step-title', text: title }),
        h('div', { class: 'step-note', text: note }),
      ),
    );

  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-mark', text: '◈' }),
    h('h1', { class: 'empty-title', text: 'Set up your library' }),
    h('p', {
      class: 'empty-text',
      text: 'Point EmuSteam at a folder of ROMs. Most retro systems play right here with no emulator to install — or point it at one you already have.',
    }),
    h(
      'div',
      { class: 'steps' },
      step(
        1,
        hasSources,
        hasSources ? `${state.sources.length} ROM folder${state.sources.length === 1 ? '' : 's'} added` : 'Add a ROM folder',
        hasSources
          ? 'Add another, or move on to step 2.'
          : 'Point at a library you already keep — or use Import in Settings to copy a pile of ROMs in and have them sorted for you.',
        async () => {
          if (await addSourceFlow(state)) refresh();
        },
      ),
      step(
        2,
        hasEmulators,
        onlyCores
          ? `${readyCores.length} system${readyCores.length === 1 ? '' : 's'} play in the app`
          : hasEmulators
            ? `${state.emulators.length} emulator${state.emulators.length === 1 ? '' : 's'} added`
            : 'Get something to play them with',
        onlyCores
          ? 'Nothing else needed. Add a standalone emulator too if you want one.'
          : hasEmulators
            ? 'Add another, or scan your folders.'
            : 'Run  npm run fetch-cores  and 22 systems play right here — nothing to install. Or click to pick an emulator .exe you already have.',
        async () => {
          if (await addEmulatorFlow(state)) refresh();
        },
      ),
      step(
        3,
        false,
        'Scan for games',
        hasSources ? 'Read your folders and build the library.' : 'Available once a ROM folder is added.',
        hasSources
          ? async () => {
              await rescan();
              refresh();
            }
          : null,
      ),
    ),
    h(
      'div',
      { class: 'empty-actions' },
      h('button', {
        class: 'btn btn-ghost',
        nav: true,
        text: 'Open settings',
        onClick: () => go('settings', {}),
      }),
    ),
  );
}
