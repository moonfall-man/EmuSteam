// The three card shapes the whole UI is built from.

import { h } from './util.mjs';
import { gameArt, tintFor, GALAXY_TINT } from './art.mjs';
import { artUrl } from './api.mjs';

/**
 * Portrait game capsule.
 * @param {object} game game DTO
 * @param {object} platform platform DTO
 * @param {{onOpen:(game:object)=>void, eager?:boolean, keyPrefix?:string}} opts
 */
export function gameCard(game, platform, { onOpen, eager = false, keyPrefix = 'g' }) {
  const badges = [];
  if (game.favorite) badges.push(h('span', { class: 'badge badge-fav', text: '★' }));
  if (game.discCount > 1) {
    badges.push(h('span', { class: 'badge badge-discs', text: `${game.discCount} discs` }));
  }
  if (game.regionFlag) badges.push(h('span', { class: 'badge badge-region', text: game.regionFlag }));

  return h(
    'button',
    {
      class: ['card', 'card-game', game.hasArt && 'has-art'],
      nav: true,
      'data-nav-key': `${keyPrefix}-${game.id}`,
      'data-game-id': game.id,
      title: game.title,
      'aria-label': `${game.title}, ${platform?.name || game.platform}`,
      onClick: () => onOpen(game),
    },
    gameArt(game, platform, { eager }),
    badges.length ? h('div', { class: 'card-badges' }, ...badges) : null,
    h('div', { class: 'card-caption', text: game.title }),
    game.playSeconds > 0 ? h('div', { class: 'card-played' }) : null,
  );
}

/**
 * Landscape platform tile.
 * @param {object} platform platform DTO
 * @param {{onOpen:(platform:object)=>void}} opts
 */
export function platformCard(platform, { onOpen }) {
  const { a, b } = tintFor(platform.tint, platform.id);
  return h(
    'button',
    {
      class: ['card', 'card-platform'],
      nav: true,
      'data-nav-key': `p-${platform.id}`,
      style: { '--art-a': a, '--art-b': b },
      'aria-label': `${platform.name}, ${platform.gameCount} games`,
      onClick: () => onOpen(platform),
    },
    // A console icon when one has been downloaded, the short name when not. The
    // name is not kept alongside the picture: the icon *is* the identification,
    // and doubling it up made the card look like a placeholder.
    platform.artPath
      ? h('img', {
          class: 'platform-icon',
          src: artUrl(platform.artPath),
          alt: platform.name,
          // eager, matching game art: every card in a couch UI is on screen at
          // once, and these are 2-5 KB each. Lazy loading them saves nothing and
          // leaves cards blank until something triggers a paint.
          loading: 'eager',
          // Fall back to the short name if the file goes missing under us.
          onError: (ev) => {
            ev.target.replaceWith(h('div', { class: 'platform-short', text: platform.short }));
          },
        })
      : h('div', { class: 'platform-short', text: platform.short }),
    h(
      'div',
      { class: 'platform-meta' },
      h('span', { text: `${platform.gameCount} ${platform.gameCount === 1 ? 'game' : 'games'}` }),
      platform.playable
        ? null
        : h('span', { class: 'platform-warn' }, h('span', { text: '!' }), h('span', { text: 'No emulator' })),
    ),
  );
}

/** "All games" pseudo-platform tile. */
export function allGamesCard(count, { onOpen }) {
  const { a, b } = tintFor(GALAXY_TINT, 'all-games');
  return h(
    'button',
    {
      class: ['card', 'card-platform'],
      nav: true,
      'data-nav-key': 'p-all',
      style: { '--art-a': a, '--art-b': b },
      onClick: onOpen,
    },
    h('div', { class: 'platform-short', text: 'All Games' }),
    h('div', { class: 'platform-meta' }, h('span', { text: `${count} across every system` })),
  );
}

/** Dashed "do a thing" tile used at the end of a rail. */
export function actionCard(label, note, onClick, key) {
  return h(
    'button',
    {
      class: ['card', 'card-action'],
      nav: true,
      'data-nav-key': key,
      onClick,
    },
    h('div', { class: 'plus', text: '+' }),
    h('div', { style: { fontWeight: '650' }, text: label }),
    note ? h('div', { class: 'muted', style: { fontSize: '13px' }, text: note }) : null,
  );
}

/** A labelled horizontal rail. Returns null when there is nothing to show. */
export function rail(title, count, children) {
  const items = children.filter(Boolean);
  if (!items.length) return null;
  return h(
    'section',
    {},
    h(
      'div',
      { class: 'row-head' },
      h('h2', { class: 'row-title', text: title }),
      count !== null && count !== undefined ? h('span', { class: 'row-count', text: String(count) }) : null,
    ),
    h('div', { class: 'rail' }, ...items),
  );
}
