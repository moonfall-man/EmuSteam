// One system's games, or every game when params.platform is '*'.

import { h, SORTS, matchesQuery } from './../util.mjs';
import { gameCard } from './../cards.mjs';
import { api } from './../api.mjs';
import { toast } from './../toast.mjs';
import { pickPlatformEmulatorFlow, rescan } from './../flows.mjs';

export function render(ctx) {
  const { state, params, go, refresh } = ctx;
  const isAll = params.platform === '*';
  const platform = isAll ? null : state.platforms.find((p) => p.id === params.platform);

  if (!isAll && !platform) {
    return {
      node: h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-mark', text: '?' }),
        h('h1', { class: 'empty-title', text: 'That system is not in your library' }),
        h('p', { class: 'empty-text', text: 'It may have been removed by a rescan.' }),
        h(
          'div',
          { class: 'empty-actions' },
          h('button', { class: 'btn btn-primary', nav: true, 'data-nav-initial': '', text: 'Back to home', onClick: () => go('home', {}) }),
        ),
      ),
      crumbs: [{ text: 'Unknown system' }],
      hints: [{ glyph: 'b', label: 'Back' }],
    };
  }

  const sortKey = SORTS[state.settings.sort] ? state.settings.sort : 'name';
  const games = state.games
    .filter((g) => (isAll ? true : g.platform === params.platform))
    .filter((g) => state.settings.showHidden || !g.hidden)
    .filter((g) => matchesQuery(g, state.query))
    .sort(SORTS[sortKey].compare);

  const platformOf = (id) => state.platforms.find((p) => p.id === id);

  const head = h(
    'div',
    { class: 'grid-head' },
    h('h1', { class: 'grid-title', text: isAll ? 'All games' : platform.name }),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'chip',
      nav: true,
      'data-nav-key': 'sort',
      text: `Sort: ${SORTS[sortKey].label}`,
      onClick: () => cycleSort(ctx, sortKey),
    }),
    !isAll ? emulatorChip(ctx, platform) : null,
  );

  const body = games.length
    ? h(
        'div',
        { class: 'grid' },
        ...games.map((game, i) =>
          gameCard(game, platformOf(game.platform), {
            onOpen: (g) => go('game', { id: g.id }),
            eager: i < 24,
            keyPrefix: 'grid',
          }),
        ),
      )
    : emptyGrid(ctx, isAll, platform);

  const first = body.querySelector?.('[data-nav]');
  if (first) first.dataset.navInitial = '';

  return {
    node: h('div', {}, head, body),
    crumbs: [{ text: isAll ? 'All games' : platform.name }],
    subtitle: `${games.length} ${games.length === 1 ? 'game' : 'games'}${state.query ? ` matching “${state.query}”` : ''}`,
    tint: platform?.tint || null,
    tintSeed: platform?.id,
    hints: [
      { glyph: 'a', label: 'Play' },
      { glyph: 'b', label: 'Back' },
      { glyph: 'y', label: 'Favourite' },
      { glyph: 'x', label: 'Sort' },
      { glyph: 'search', label: 'Search' },
    ],
    onAction: (action) => {
      if (action === 'alt') {
        cycleSort(ctx, sortKey);
        return true;
      }
      return false;
    },
  };
}

function emulatorChip(ctx, platform) {
  const emulator = ctx.state.emulators.find((e) => e.id === platform.defaultEmulator);
  return h('button', {
    class: ['chip', emulator ? 'chip-strong' : 'pill-bad'],
    nav: true,
    'data-nav-key': 'emu',
    text: emulator ? `Runs with ${emulator.name}` : 'No emulator — set one',
    onClick: async () => {
      if (await pickPlatformEmulatorFlow(ctx.state, platform)) ctx.refresh();
    },
  });
}

async function cycleSort(ctx, currentSort) {
  const keys = Object.keys(SORTS);
  const next = keys[(keys.indexOf(currentSort) + 1) % keys.length];
  try {
    await api.saveSettings({ sort: next });
    ctx.refresh({ keepFocus: true });
  } catch (err) {
    toast.error(err.message);
  }
}

function emptyGrid(ctx, isAll, platform) {
  const { state, refresh, go } = ctx;

  if (state.query) {
    return h(
      'div',
      { class: 'empty' },
      h('div', { class: 'empty-mark', text: '⌕' }),
      h('h1', { class: 'empty-title', text: 'Nothing matches that' }),
      h('p', { class: 'empty-text', text: `No games here match “${state.query}”.` }),
      h(
        'div',
        { class: 'empty-actions' },
        h('button', {
          class: 'btn btn-primary',
          nav: true,
          'data-nav-initial': '',
          text: 'Clear search',
          onClick: () => ctx.setQuery(''),
        }),
      ),
    );
  }

  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-mark', text: '◌' }),
    h('h1', { class: 'empty-title', text: isAll ? 'No games yet' : `No ${platform.short} games` }),
    h('p', {
      class: 'empty-text',
      text: 'Everything here may be hidden, or the folder for this system has not been scanned yet.',
    }),
    h(
      'div',
      { class: 'empty-actions' },
      h('button', {
        class: 'btn btn-primary',
        nav: true,
        'data-nav-initial': '',
        text: 'Rescan library',
        onClick: async () => {
          await rescan();
          refresh();
        },
      }),
      h('button', { class: 'btn btn-ghost', nav: true, text: 'Settings', onClick: () => go('settings', {}) }),
    ),
  );
}
