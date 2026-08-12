// Card artwork.
//
// Most ROM folders have no box art, and an empty grid of grey rectangles looks
// broken. So a game without an image gets a *generated* cover instead: the
// platform's gradient, hue-shifted deterministically by the title, with the
// platform abbreviation as a watermark and the title set across the bottom. It
// reads as a designed placeholder rather than a missing asset, and two games
// never look identical.

import { h, hashString } from './util.mjs';
import { artUrl } from './api.mjs';

/**
 * EmuSteam's own galaxy purple, used wherever a view has no platform whose
 * colours it can borrow — home, settings, "All games", and as the fallback for
 * a platform missing from the catalogue.
 */
export const GALAXY_TINT = ['#4a2f7d', '#170f2b'];

function hexToHsl(hex) {
  const clean = String(hex).replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  let hue = 0;
  let sat = 0;
  if (d !== 0) {
    sat = d / (1 - Math.abs(2 * l - 1));
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: sat * 100, l: l * 100 };
}

function hsl({ h: hue, s, l }) {
  return `hsl(${hue.toFixed(1)} ${Math.max(0, Math.min(100, s)).toFixed(1)}% ${Math.max(0, Math.min(100, l)).toFixed(1)}%)`;
}

/**
 * Per-game gradient: the platform's colours nudged by a hash of the title.
 * @returns {{a:string, b:string}} CSS colours
 */
export function tintFor(tint, seed) {
  const [fromHex, toHex] = tint && tint.length === 2 ? tint : GALAXY_TINT;
  const hash = hashString(String(seed || ''));

  const hueShift = (hash % 46) - 23;
  const lightShift = ((hash >> 6) % 13) - 5;

  const a = hexToHsl(fromHex);
  const b = hexToHsl(toHex);

  return {
    a: hsl({ h: (a.h + hueShift + 360) % 360, s: a.s, l: a.l + lightShift }),
    b: hsl({ h: (b.h + hueShift + 360) % 360, s: b.s, l: b.l + lightShift * 0.5 }),
  };
}

/**
 * Art element for a game.
 * @param {object} game game DTO
 * @param {object} platform platform DTO (for tint + short name)
 * @param {{eager?:boolean}} [opts]
 */
export function gameArt(game, platform, { eager = false } = {}) {
  if (game.artPath) {
    return h(
      'div',
      { class: 'card-art' },
      h('img', {
        src: artUrl(game.artPath),
        alt: '',
        loading: eager ? 'eager' : 'lazy',
        decoding: 'async',
        draggable: 'false',
        // A moved source folder or a corrupt image falls back to the generated
        // cover rather than showing a broken-image glyph. Resolve the card
        // *before* the swap — afterwards the wrapper is detached and
        // closest() would return null.
        onError: (ev) => {
          const wrapper = ev.target.closest('.card-art');
          if (!wrapper) return;
          const card = wrapper.closest('.card-game');
          wrapper.replaceWith(generatedArt(game, platform));
          card?.classList.remove('has-art');
        },
      }),
    );
  }
  return generatedArt(game, platform);
}

export function generatedArt(game, platform) {
  const { a, b } = tintFor(platform?.tint, game.title + game.platform);
  return h(
    'div',
    { class: 'art-generated', style: { '--art-a': a, '--art-b': b } },
    h('div', { class: 'art-glyph', text: platform?.short || game.platform }),
    h('div', { class: 'art-name', text: game.title }),
  );
}

/** Big blurred backdrop for the game page. */
export function heroArt(game, platform) {
  if (game.artPath) {
    return h(
      'div',
      { class: 'gamepage-hero' },
      h('img', { src: artUrl(game.artPath), alt: '', decoding: 'async', draggable: 'false' }),
    );
  }
  const { a, b } = tintFor(platform?.tint, game.title + game.platform);
  return h(
    'div',
    { class: 'gamepage-hero' },
    h('div', { class: 'gamepage-hero-fallback', style: { '--art-a': a, '--art-b': b } }),
  );
}

/** Set the page-level ambient tint. Called on every view change. */
export function setAmbient(tint, seed = 'emusteam') {
  const { a, b } = tintFor(tint, seed);
  document.documentElement.style.setProperty('--tint-a', a);
  document.documentElement.style.setProperty('--tint-b', b);
}
