// Artwork lookup: mapping our systems onto libretro's naming, and turning a ROM
// filename into the names artwork is actually filed under.
//
// No network access happens in this file. It builds URLs and candidate names;
// tools/fetch-art.mjs is the only thing that fetches them, and only when you run
// it. Everything here is pure, so the matching logic is testable offline.
//
// Two archives, one naming convention:
//
//   Box art       thumbnails.libretro.com/<System>/Named_Boxarts/<No-Intro name>.png
//   Console icon  retroarch-assets .../xmb/monochrome/png/<System>.png   (CC BY 4.0)
//
// Box art is keyed on the *original* ROM filename, because that is how the
// archive is indexed — No-Intro and Redump names, parenthetical tags and all. So
// matching uses the filename on disk rather than the cleaned-up title we show.

const THUMB_BASE = 'https://thumbnails.libretro.com';
const ICON_BASE =
  'https://raw.githubusercontent.com/libretro/retroarch-assets/master/xmb/monochrome/png';

/**
 * Our platform id → libretro's canonical system name.
 *
 * These strings are load-bearing: they are literal path segments in both
 * archives, so a typo is a silent 404. All 39 were checked against the live icon
 * archive when this table was written (39/39 resolved); the candidate-name logic
 * below is covered offline by the test suite, which never touches the network.
 * If you add a system, verify its name resolves before trusting it.
 *
 * Systems the archives do not cover are simply absent.
 */
export const LIBRETRO_SYSTEMS = {
  nes: 'Nintendo - Nintendo Entertainment System',
  snes: 'Nintendo - Super Nintendo Entertainment System',
  n64: 'Nintendo - Nintendo 64',
  gb: 'Nintendo - Game Boy',
  gbc: 'Nintendo - Game Boy Color',
  gba: 'Nintendo - Game Boy Advance',
  nds: 'Nintendo - Nintendo DS',
  '3ds': 'Nintendo - Nintendo 3DS',
  gamecube: 'Nintendo - GameCube',
  wii: 'Nintendo - Wii',
  wiiu: 'Nintendo - Wii U',
  virtualboy: 'Nintendo - Virtual Boy',
  genesis: 'Sega - Mega Drive - Genesis',
  segacd: 'Sega - Mega-CD - Sega CD',
  sega32x: 'Sega - 32X',
  mastersystem: 'Sega - Master System - Mark III',
  gamegear: 'Sega - Game Gear',
  saturn: 'Sega - Saturn',
  dreamcast: 'Sega - Dreamcast',
  psx: 'Sony - PlayStation',
  ps2: 'Sony - PlayStation 2',
  ps3: 'Sony - PlayStation 3',
  psp: 'Sony - PlayStation Portable',
  vita: 'Sony - PlayStation Vita',
  pcengine: 'NEC - PC Engine - TurboGrafx 16',
  pcenginecd: 'NEC - PC Engine CD - TurboGrafx-CD',
  pcfx: 'NEC - PC-FX',
  ngp: 'SNK - Neo Geo Pocket Color',
  neogeo: 'SNK - Neo Geo',
  wonderswan: 'Bandai - WonderSwan Color',
  lynx: 'Atari - Lynx',
  atari2600: 'Atari - 2600',
  atari7800: 'Atari - 7800',
  jaguar: 'Atari - Jaguar',
  c64: 'Commodore - 64',
  amiga: 'Commodore - Amiga',
  msx: 'Microsoft - MSX',
  '3do': 'The 3DO Company - 3DO',
  arcade: 'MAME',
};

export const artSystemFor = (platform) => LIBRETRO_SYSTEMS[platform] || null;

/** Box art URL for one candidate name. */
export function boxartUrl(platform, candidate) {
  const system = artSystemFor(platform);
  if (!system) return null;
  return `${THUMB_BASE}/${encodeURIComponent(system)}/Named_Boxarts/${encodeURIComponent(candidate)}.png`;
}

/** Console icon URL for a system. */
export function systemIconUrl(platform) {
  const system = artSystemFor(platform);
  return system ? `${ICON_BASE}/${encodeURIComponent(system)}.png` : null;
}

/**
 * Names to try for a game's box art, most specific first.
 *
 * The exact filename is nearly always the hit, because that is the key the
 * archive is built on. The fallbacks exist for files someone has renamed: drop
 * the trailing tags one at a time, then the disc number, then try the cleaned
 * title. Ordering matters — a looser candidate matching first would fetch the
 * wrong region's cover.
 *
 * @param {{file?:string, title?:string, ext?:string}} game
 * @returns {string[]} unique candidates, in order of confidence
 */
export function artCandidates(game) {
  const out = [];
  const add = (value) => {
    const name = String(value || '').trim();
    if (name && !out.includes(name)) out.push(name);
  };

  const base = String(game.file || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() || '';
  // Strip the extension without touching dots inside the name itself.
  const stem = base.replace(/\.[^.]+$/, '');
  add(stem);

  // Peel trailing "(...)" groups off one at a time: "Game (USA) (Rev 1)" gives
  // "Game (USA)" and then "Game".
  let peeled = stem;
  while (/\s*\([^()]*\)\s*$/.test(peeled)) {
    peeled = peeled.replace(/\s*\([^()]*\)\s*$/, '');
    add(peeled);
  }

  // Multi-disc sets are filed under the disc name, but a single cover is better
  // than none, so try the set without the disc marker too.
  add(stem.replace(/\s*\((?:Disc|Disk|CD)\s*\d+[^)]*\)/i, '').replace(/\s{2,}/g, ' '));

  // Last resort: what we display. Our titles turn " - " into ": ", so undo that.
  add(String(game.title || '').replace(/:\s*/g, ' - '));

  return out;
}
