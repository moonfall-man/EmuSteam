// The game page: art, facts, and one obvious green button.

import { h, fmtBytes, fmtPlaytime, fmtRelative } from './../util.mjs';
import { gameArt, heroArt } from './../art.mjs';
import { api } from './../api.mjs';
import { toast } from './../toast.mjs';
import { openModal, confirmModal, chooseModal } from './../modal.mjs';
import { assignArtFlow, pickPlatformEmulatorFlow } from './../flows.mjs';

export function render(ctx) {
  const { state, params, go, refresh } = ctx;
  const game = state.games.find((g) => g.id === params.id);

  if (!game) {
    return {
      node: h(
        'div',
        { class: 'empty' },
        h('div', { class: 'empty-mark', text: '?' }),
        h('h1', { class: 'empty-title', text: 'That game is gone' }),
        h('p', { class: 'empty-text', text: 'It was probably removed by the last scan.' }),
        h(
          'div',
          { class: 'empty-actions' },
          h('button', { class: 'btn btn-primary', nav: true, 'data-nav-initial': '', text: 'Back to home', onClick: () => go('home', {}) }),
        ),
      ),
      crumbs: [{ text: 'Missing game' }],
      hints: [{ glyph: 'b', label: 'Back' }],
    };
  }

  const platform = state.platforms.find((p) => p.id === game.platform);
  const emulators = platform?.emulators || [];
  const chosenEmulatorId = params.emulatorId || platform?.defaultEmulator || emulators[0]?.id || null;
  const chosenEmulator = state.emulators.find((e) => e.id === chosenEmulatorId);
  const canPlay = !!chosenEmulator && chosenEmulator.exists;

  const play = async (discFile = null) => {
    if (!canPlay) {
      if (await pickPlatformEmulatorFlow(state, platform || { id: game.platform, name: game.platform })) {
        refresh();
      }
      return;
    }
    try {
      await api.launch(game.id, chosenEmulatorId, discFile);
    } catch (err) {
      toast.error(err.message);
    }
  };

  const tags = [
    h('span', { class: 'chip chip-strong', text: platform?.name || game.platform }),
    game.region ? h('span', { class: 'chip', text: `${game.regionFlag ? game.regionFlag + ' ' : ''}${game.region}` }) : null,
    game.revision ? h('span', { class: 'chip', text: `Rev ${game.revision}` }) : null,
    game.version ? h('span', { class: 'chip', text: game.version }) : null,
    ...game.quality.map((q) => h('span', { class: 'chip', text: qualityLabel(q) })),
    game.discCount > 1 ? h('span', { class: 'chip', text: `${game.discCount} discs` }) : null,
  ].filter(Boolean);

  // In-app play is instant, so when it's available it becomes the primary
  // action and the external emulator moves to second place.
  const wasm = platform?.wasm || null;
  // A system can run in-app while one particular game cannot — a multi-track
  // disc image has no single file to hand the core.
  const canPlayHere = !!wasm?.ready && !game.inAppBlocked;
  // A session left mid-play. Only in-app play can do this — a launched emulator
  // owns its own process and we have no say in how it exits.
  const suspended = canPlayHere && !!game.suspended;

  const actions = h(
    'div',
    { class: 'gamepage-actions' },
    canPlayHere
      ? h('button', {
          class: 'btn btn-play btn-primary',
          nav: true,
          'data-nav-initial': '',
          'data-nav-key': 'play-here',
          text: suspended ? '▶  Resume' : '▶  Play',
          title: suspended
            ? `Picks up exactly where you left off ${fmtRelative(game.suspendedAt)}`
            : `Runs here instantly using the ${wasm.core} core`,
          onClick: () => go('player', { id: game.id }),
        })
      : null,
    suspended
      ? h('button', {
          class: 'btn',
          nav: true,
          'data-nav-key': 'restart',
          text: '↺  Start over',
          title: 'Boot from the beginning instead of resuming',
          onClick: async () => {
            const ok = await confirmModal({
              title: 'Start over?',
              note: `This throws away the suspended session from ${fmtRelative(game.suspendedAt)} and boots ${game.title} from the beginning. Quick saves and numbered save states are not touched.`,
              confirmLabel: 'Start over',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.clearGameState(game.id, 'suspend');
              // resume:'0' rather than relying on the cleared slot: this page is
              // still rendered from state fetched before the clear, so the game
              // here still looks suspended. Say what we mean instead.
              go('player', { id: game.id, resume: '0' });
            } catch (err) {
              toast.error(err.message);
            }
          },
        })
      : null,
    h('button', {
      class: [
        'btn',
        'btn-play',
        canPlayHere ? '' : canPlay ? 'btn-primary' : 'btn-ghost',
      ],
      nav: true,
      'data-nav-initial': canPlayHere ? null : '',
      'data-nav-key': 'play',
      // With in-app play available, the second button is only worth offering when
      // there is actually an external emulator behind it.
      text: canPlayHere
        ? (canPlay ? `Open in ${chosenEmulator.name}` : 'Add an emulator…')
        : canPlay
          ? '▶  Play'
          : 'Set up an emulator',
      onClick: () => play(),
    }),
    emulators.length > 1
      ? h('button', {
          class: 'btn',
          nav: true,
          'data-nav-key': 'emu',
          text: chosenEmulator ? chosenEmulator.name : 'Pick emulator',
          onClick: async () => {
            const picked = await chooseModal({
              title: 'Run with',
              note: 'Just for this launch. Change the default in Settings → Systems.',
              options: emulators.map((emu) => ({
                id: emu.id,
                title: emu.name,
                selected: emu.id === chosenEmulatorId,
              })),
            });
            if (picked) go('game', { ...params, emulatorId: picked }, { replace: true });
          },
        })
      : null,
    h('button', {
      class: 'btn',
      nav: true,
      'data-nav-key': 'fav',
      text: game.favorite ? '★  Favourited' : '☆  Favourite',
      onClick: () => toggleFlag(ctx, game, 'favorite'),
    }),
    h('button', {
      class: 'btn btn-ghost',
      nav: true,
      'data-nav-key': 'more',
      text: '···  More',
      onClick: () => openMore(ctx, game, platform, chosenEmulatorId),
    }),
  );

  const facts = h(
    'div',
    { class: 'factgrid' },
    fact('Play time', fmtPlaytime(game.playSeconds)),
    fact('Times played', game.playCount ? String(game.playCount) : '—'),
    suspended ? fact('Suspended', fmtRelative(game.suspendedAt)) : null,
    fact('Last played', fmtRelative(game.lastPlayed)),
    fact('Size', fmtBytes(game.size)),
    fact('Format', game.ext.replace('.', '').toUpperCase()),
    fact('Emulator', chosenEmulator ? chosenEmulator.name : 'None set'),
    fact('File', game.file, true),
  );

  const discs =
    game.discCount > 1 && game.discs
      ? h(
          'div',
          {},
          h('div', { class: 'fact-k', style: { marginTop: '22px' }, text: 'Discs' }),
          h(
            'div',
            { class: 'disclist' },
            ...game.discs.map((disc) =>
              h('button', {
                class: 'btn btn-sm',
                nav: true,
                'data-nav-key': `disc-${disc.number}`,
                text: `Disc ${disc.number}`,
                onClick: () => play(disc.file),
              }),
            ),
          ),
        )
      : null;

  return {
    node: h(
      'div',
      { class: 'gamepage' },
      heroArt(game, platform),
      h(
        'div',
        { class: 'gamepage-body' },
        h('div', { class: 'gamepage-cover' }, gameArt(game, platform, { eager: true })),
        h(
          'div',
          {},
          h('h1', { class: 'gamepage-title', text: game.title }),
          tags.length ? h('div', { class: 'gamepage-tags' }, ...tags) : null,
          actions,
          facts,
          discs,
        ),
      ),
    ),
    crumbs: [
      { text: platform?.name || game.platform, onClick: () => go('platform', { platform: game.platform }) },
      { text: game.title },
    ],
    tint: platform?.tint || null,
    tintSeed: game.title + game.platform,
    hints: [
      { glyph: 'a', label: 'Play' },
      { glyph: 'b', label: 'Back' },
      { glyph: 'y', label: game.favorite ? 'Unfavourite' : 'Favourite' },
      { glyph: 'x', label: 'More' },
    ],
    onAction: (action) => {
      if (action === 'alt') {
        openMore(ctx, game, platform, chosenEmulatorId);
        return true;
      }
      // The shell's global favourite handler keys off the focused *card*, and
      // there are no cards on this page — so claim the action for this game.
      if (action === 'favorite') {
        toggleFlag(ctx, game, 'favorite');
        return true;
      }
      return false;
    },
  };
}

function fact(key, value, small = false) {
  return h(
    'div',
    { class: 'fact' },
    h('div', { class: 'fact-k', text: key }),
    h('div', { class: ['fact-v', small && 'small'], text: value }),
  );
}

function qualityLabel(quality) {
  return {
    verified: 'Verified dump',
    beta: 'Beta',
    prototype: 'Prototype',
    demo: 'Demo',
    unlicensed: 'Unlicensed',
    homebrew: 'Homebrew',
    'bad-dump': 'Bad dump',
    overdump: 'Overdump',
    hack: 'Hack',
    trained: 'Trainer',
    fixed: 'Fixed',
    alternate: 'Alternate',
    pending: 'Unverified',
  }[quality] || quality;
}

async function toggleFlag(ctx, game, field) {
  try {
    await api.setFlag(game.id, field, !game[field]);
    ctx.refresh({ keepFocus: true });
  } catch (err) {
    toast.error(err.message);
  }
}

function openMore(ctx, game, platform, emulatorId) {
  const { state, refresh, go } = ctx;

  return openModal({
    title: game.title,
    width: '560px',
    body: (modal) =>
      h(
        'div',
        { class: 'choices' },
        h(
          'button',
          {
            class: 'choice',
            nav: true,
            'data-nav-initial': '',
            onClick: async () => {
              modal.close(null);
              if (await assignArtFlow(state, game)) refresh({ keepFocus: true });
            },
          },
          h(
            'div',
            {},
            h('div', { class: 'choice-title', text: 'Choose box art…' }),
            h('div', { class: 'choice-note', text: 'Pick a PNG or JPG from anywhere on disk.' }),
          ),
        ),
        game.artIsManual
          ? h(
              'button',
              {
                class: 'choice',
                nav: true,
                onClick: async () => {
                  modal.close(null);
                  try {
                    await api.clearArt(game.id);
                    refresh({ keepFocus: true });
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              },
              h('div', {}, h('div', { class: 'choice-title', text: 'Remove custom art' })),
            )
          : null,
        h(
          'button',
          {
            class: 'choice',
            nav: true,
            onClick: async () => {
              modal.close(null);
              await toggleFlag(ctx, game, 'hidden');
            },
          },
          h(
            'div',
            {},
            h('div', { class: 'choice-title', text: game.hidden ? 'Unhide from library' : 'Hide from library' }),
            h('div', { class: 'choice-note', text: 'Hidden games stay on disk. Show them again from Settings.' }),
          ),
        ),
        h(
          'button',
          {
            class: 'choice',
            nav: true,
            onClick: async () => {
              modal.close(null);
              try {
                const { command } = await api.preview(game.id, emulatorId);
                await openModal({
                  title: 'Launch command',
                  note: 'Exactly what EmuSteam will run. Handy when an emulator refuses a file.',
                  width: '760px',
                  body: () =>
                    h('div', {
                      class: 'mono',
                      style: {
                        userSelect: 'text',
                        wordBreak: 'break-all',
                        lineHeight: '1.6',
                        background: 'rgba(255,255,255,.04)',
                        padding: '14px',
                        borderRadius: '10px',
                      },
                      text: command,
                    }),
                  footer: (m) => [
                    h('button', { class: 'btn btn-primary', nav: true, 'data-nav-initial': '', text: 'Close', onClick: () => m.close(null) }),
                  ],
                });
              } catch (err) {
                toast.error(err.message);
              }
            },
          },
          h(
            'div',
            {},
            h('div', { class: 'choice-title', text: 'Show launch command' }),
            h('div', { class: 'choice-note', text: 'For debugging a stubborn emulator.' }),
          ),
        ),
        platform
          ? h(
              'button',
              {
                class: 'choice',
                nav: true,
                onClick: async () => {
                  modal.close(null);
                  if (await pickPlatformEmulatorFlow(state, platform)) refresh();
                },
              },
              h(
                'div',
                {},
                h('div', { class: 'choice-title', text: `Default emulator for ${platform.short}` }),
                h('div', { class: 'choice-note', text: 'Applies to every game on this system.' }),
              ),
            )
          : null,
        h(
          'button',
          {
            class: 'choice',
            nav: true,
            onClick: async () => {
              modal.close(null);
              const yes = await confirmModal({
                title: 'Remove from library?',
                note: 'This only forgets the entry in EmuSteam. The ROM file is not deleted. A rescan will find it again.',
                confirmLabel: 'Remove',
                danger: true,
              });
              if (!yes) return;
              try {
                await api.forgetGame(game.id);
                toast.info('Removed from the library.');
                go('platform', { platform: game.platform }, { replace: true });
                refresh();
              } catch (err) {
                toast.error(err.message);
              }
            },
          },
          h(
            'div',
            {},
            h('div', { class: 'choice-title', style: { color: 'var(--danger)' }, text: 'Remove from library' }),
            h('div', { class: 'choice-note', text: 'Does not delete the ROM file.' }),
          ),
        ),
      ),
    footer: (modal) => [
      h('button', { class: 'btn btn-ghost', nav: true, text: 'Close', onClick: () => modal.close(null) }),
    ],
  });
}
