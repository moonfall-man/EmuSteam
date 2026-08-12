// Filename -> presentable title.
//
// ROM sets are named for archival, not for a TV ten feet away. This turns
//   "Legend of Zelda, The - Ocarina of Time (USA) (Rev B) [!].z64"
// into
//   "The Legend of Zelda: Ocarina of Time"  + region USA + rev B + verified dump
// so the grid reads like a store page instead of a directory listing.

import path from 'node:path';

const REGION_ALIASES = new Map([
  ['usa', 'USA'], ['us', 'USA'], ['u', 'USA'], ['na', 'USA'],
  ['europe', 'Europe'], ['eur', 'Europe'], ['e', 'Europe'], ['pal', 'Europe'],
  ['japan', 'Japan'], ['jpn', 'Japan'], ['jp', 'Japan'], ['j', 'Japan'], ['ntsc-j', 'Japan'],
  ['world', 'World'], ['w', 'World'],
  ['australia', 'Australia'], ['aus', 'Australia'], ['a', 'Australia'],
  ['germany', 'Germany'], ['g', 'Germany'], ['ger', 'Germany'],
  ['france', 'France'], ['f', 'France'], ['fra', 'France'],
  ['spain', 'Spain'], ['s', 'Spain'], ['spa', 'Spain'],
  ['italy', 'Italy'], ['i', 'Italy'], ['ita', 'Italy'],
  ['korea', 'Korea'], ['k', 'Korea'], ['kor', 'Korea'],
  ['china', 'China'], ['chn', 'China'],
  ['brazil', 'Brazil'], ['bra', 'Brazil'],
  ['canada', 'Canada'],
  ['netherlands', 'Netherlands'],
  ['sweden', 'Sweden'],
  ['taiwan', 'Taiwan'],
  ['asia', 'Asia'],
  ['japan, usa', 'Japan/USA'], ['ju', 'Japan/USA'],
  ['usa, europe', 'USA/Europe'], ['ue', 'USA/Europe'],
  ['japan, europe', 'Japan/Europe'],
]);

const REGION_FLAGS = new Map([
  ['USA', '\u{1F1FA}\u{1F1F8}'],
  ['Europe', '\u{1F1EA}\u{1F1FA}'],
  ['Japan', '\u{1F1EF}\u{1F1F5}'],
  ['World', '\u{1F30D}'],
  ['Australia', '\u{1F1E6}\u{1F1FA}'],
  ['Germany', '\u{1F1E9}\u{1F1EA}'],
  ['France', '\u{1F1EB}\u{1F1F7}'],
  ['Spain', '\u{1F1EA}\u{1F1F8}'],
  ['Italy', '\u{1F1EE}\u{1F1F9}'],
  ['Korea', '\u{1F1F0}\u{1F1F7}'],
  ['China', '\u{1F1E8}\u{1F1F3}'],
  ['Brazil', '\u{1F1E7}\u{1F1F7}'],
  ['Canada', '\u{1F1E8}\u{1F1E6}'],
  ['Netherlands', '\u{1F1F3}\u{1F1F1}'],
  ['Sweden', '\u{1F1F8}\u{1F1EA}'],
  ['Taiwan', '\u{1F1F9}\u{1F1FC}'],
  ['Asia', '\u{1F30F}'],
]);

// Tag contents that describe the dump rather than the game.
const QUALITY_TAGS = new Map([
  ['!', 'verified'],
  ['beta', 'beta'],
  ['proto', 'prototype'],
  ['prototype', 'prototype'],
  ['demo', 'demo'],
  ['sample', 'demo'],
  ['kiosk', 'demo'],
  ['unl', 'unlicensed'],
  ['unlicensed', 'unlicensed'],
  ['pirate', 'unlicensed'],
  ['aftermarket', 'unlicensed'],
  ['homebrew', 'homebrew'],
  ['b', 'bad-dump'],
  ['o', 'overdump'],
  ['h', 'hack'],
  ['hack', 'hack'],
  ['t', 'trained'],
  ['f', 'fixed'],
  ['p', 'pending'],
  ['a', 'alternate'],
  ['alt', 'alternate'],
]);

const ARTICLES = ['The', 'A', 'An', 'Le', 'La', 'Les', 'Der', 'Die', 'Das', 'El', 'Los', 'Il'];

/**
 * Parse a ROM filename into display metadata.
 * @param {string} filePath absolute or relative path to the ROM
 */
export function parseTitle(filePath) {
  const base = path.basename(filePath, path.extname(filePath));

  const tags = [];
  // Pull out every (...) and [...] group, left to right.
  let stem = base.replace(/[([]([^()[\]]*)[)\]]/g, (_, inner) => {
    const value = String(inner).trim();
    if (value) tags.push(value);
    return ' ';
  });

  stem = normalizeSeparators(stem);

  let region = null;
  let revision = null;
  let disc = null;
  let version = null;
  const quality = new Set();
  const languages = [];
  const extra = [];

  for (const tag of tags) {
    const lower = tag.toLowerCase();

    if (!region && REGION_ALIASES.has(lower)) {
      region = REGION_ALIASES.get(lower);
      continue;
    }
    // Multi-region tags like "USA, Europe"
    if (!region && lower.includes(',')) {
      const parts = lower.split(',').map((s) => s.trim());
      const mapped = parts.map((p) => REGION_ALIASES.get(p)).filter(Boolean);
      if (mapped.length === parts.length && mapped.length > 1) {
        region = mapped.join('/');
        continue;
      }
    }

    let m;
    if ((m = /^rev\s*([0-9a-z.]+)$/i.exec(lower))) { revision = m[1].toUpperCase(); continue; }
    if ((m = /^v([0-9][0-9a-z.]*)$/i.exec(lower))) { version = 'v' + m[1]; continue; }
    if ((m = /^(?:disc|disk|cd|side)\s*([0-9a-z]+)(?:\s*of\s*([0-9]+))?$/i.exec(lower))) {
      disc = { number: m[1].toUpperCase(), of: m[2] ? Number(m[2]) : null };
      continue;
    }
    if (/^[a-z]{2}(,[a-z]{2})+$/i.test(lower)) { languages.push(...tag.split(',').map((s) => s.trim().toUpperCase())); continue; }

    if (QUALITY_TAGS.has(lower)) { quality.add(QUALITY_TAGS.get(lower)); continue; }
    // GoodTools stacks single-letter codes: [!b], [a1]
    if (/^[!aboftphm][0-9]*$/i.test(lower)) {
      const key = lower[0];
      if (QUALITY_TAGS.has(key)) { quality.add(QUALITY_TAGS.get(key)); continue; }
    }

    extra.push(tag);
  }

  const title = prettifyTitle(stem);

  return {
    title,
    sortKey: sortKeyFor(title),
    region,
    regionFlag: region ? REGION_FLAGS.get(region.split('/')[0]) || null : null,
    revision,
    version,
    disc,
    languages,
    quality: [...quality],
    extra,
  };
}

/** Underscores/dots as word separators, collapsed whitespace. */
function normalizeSeparators(stem) {
  let out = stem;
  // "Super_Mario_64" or "Super.Mario.64" — only if the name has no real spaces.
  if (!/\s/.test(out.trim())) out = out.replace(/[_.]+/g, ' ');
  else out = out.replace(/_+/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/** " - " subtitle separators become colons; trailing article moves to the front. */
function prettifyTitle(stem) {
  // Only a *spaced* dash is a subtitle separator. Matching bare hyphens would
  // wreck every hyphenated title there is — "Spider-Man", "X-Men", "Wave Race".
  let out = stem.replace(/\s+-+\s+/g, ': ').replace(/:\s*:/g, ':');

  // "Legend of Zelda, The: Ocarina of Time" -> "The Legend of Zelda: Ocarina of Time"
  for (const article of ARTICLES) {
    const re = new RegExp(`^(.+?),\\s*${article}(\\b.*)$`, 'i');
    const m = re.exec(out);
    if (m) {
      out = `${article} ${m[1]}${m[2]}`;
      break;
    }
  }

  out = out.replace(/\s*:\s*/g, ': ').replace(/\s+/g, ' ').trim();
  out = out.replace(/[:\s]+$/, '');
  return out || stem || 'Untitled';
}

/** Case-insensitive sort key with the leading article dropped. */
function sortKeyFor(title) {
  let key = title.toLowerCase();
  for (const article of ARTICLES) {
    const prefix = article.toLowerCase() + ' ';
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
      break;
    }
  }
  return key.replace(/^[^a-z0-9]+/, '');
}

/**
 * Loose key for matching a game against art files and against other discs of
 * the same game: lowercase alphanumerics only.
 */
export function matchKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}
