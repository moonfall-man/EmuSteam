// Identify a disc image by what is inside it, rather than by its name.
//
// `.bin`, `.iso`, `.img` and `.cue` each belong to half a dozen systems, so the
// organiser used to leave them exactly where they were rather than guess. It does
// not have to guess. Every disc-based console stamps a signature into the first
// sectors of its media, and reading that is cheap and certain — which is a
// different thing from a heuristic. "Never guess" stays the rule; this is the
// difference between guessing and knowing.
//
// A file that says nothing identifiable about itself still stays put.

import fs from 'node:fs';
import path from 'node:path';

// Enough to cover the ISO9660 primary volume descriptor in either sector layout:
// a 2048-byte/sector `.iso` puts it at 16 × 2048 = 32768, and a raw
// 2352-byte/sector `.bin` puts it at 16 × 2352 + 24 = 37656, past the sync header
// and subheader. Rather than work out the mode first, read past both and search.
const HEADER_BYTES = 64 * 1024;

// How far to look for the *contents* of SYSTEM.CNF when separating PS1 from PS2.
// Its directory entry is in the header, but the file body sits wherever the
// filesystem put it.
const REFINE_BYTES = 16 * 1024 * 1024;

// A cue sheet is a short text file. Anything this big is not one, and reading it
// as text would be a waste.
const MAX_CUE_BYTES = 1 << 20;

/**
 * On-disc magic, in the order it is tested.
 *
 * The Sony marker was verified here against a real PS1 image (a MODE2/2352 `.bin`
 * carrying `CD001` at 37657 and `PLAYSTATION` at 37664). The Sega and PC Engine
 * markers are the documented signatures those systems write to sector 0; the
 * matching is covered by tests using synthetic headers.
 */
const SIGNATURES = [
  ['SEGADISCSYSTEM', 'segacd'],
  ['SEGA SEGASATURN', 'saturn'],
  ['SEGA SEGAKATANA', 'dreamcast'],
  ['PC Engine CD-ROM SYSTEM', 'pcenginecd'],
  ['PLAYSTATION', 'psx'], // refined to psx vs ps2 below
];

// Identification is pure for a given file, and looseRomFiles() runs on every
// state request, so the answer is memoised against size+mtime. Without this, a
// couple of loose disc images would mean re-reading megabytes every time the UI
// asked what was lying around.
const cache = new Map();

function cacheKey(file) {
  try {
    const stat = fs.statSync(file);
    return `${file}|${stat.size}|${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

function readHead(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    if (!len) return null;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch { /* already gone */ }
    }
  }
}

/**
 * Which files a cue sheet points at, as bare filenames.
 *
 * Only the basename is kept: a track reference is a file sitting beside the cue,
 * never a route to somewhere else, so a sheet containing `../../../secrets` can
 * only ever name `secrets`.
 */
export function cueReferences(cuePath) {
  let text;
  try {
    if (fs.statSync(cuePath).size > MAX_CUE_BYTES) return [];
    text = fs.readFileSync(cuePath, 'latin1');
  } catch {
    return [];
  }

  const names = [];
  for (const match of text.matchAll(/^[ \t]*FILE[ \t]+(?:"([^"]+)"|(\S+))/gim)) {
    const raw = match[1] || match[2];
    if (!raw) continue;
    const name = path.basename(raw.replace(/\\/g, '/'));
    if (name && name !== '.' && name !== '..' && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * What the in-app player should actually be handed for a disc image.
 *
 * The player gets exactly one file over HTTP, so a cue sheet is useless to it: a
 * cue is 87 bytes of text naming a `.bin` the core cannot go and fetch. Handed one
 * anyway, the core finds no content and drops into its own menu — which looks like
 * EmuSteam launched the wrong thing.
 *
 * A single-track cue is equivalent to its track, so serve the track. A multi-track
 * cue is not: its extra tracks are CD audio, and there is no single file to stand
 * in for the set.
 *
 * @param {string} absPath the file the library recorded for the game
 * @returns {{path:string, reason:null}|{path:null, reason:string}}
 */
export function playableDiscFile(absPath) {
  if (path.extname(absPath).toLowerCase() !== '.cue') return { path: absPath, reason: null };

  const names = cueReferences(absPath);
  const present = names
    .map((name) => path.join(path.dirname(absPath), name))
    .filter((file) => fs.existsSync(file));

  if (!present.length) {
    return {
      path: null,
      reason: names.length
        ? `This cue sheet points at ${names[0]}, which is not next to it.`
        : 'This cue sheet does not name any track files.',
    };
  }
  if (present.length > 1) {
    return {
      path: null,
      reason: `This game is split across ${present.length} track files, which cannot be handed to the in-app player as one file. Convert it to a single .chd and it will play here.`,
    };
  }
  return { path: present[0], reason: null };
}

/**
 * What system does this disc image belong to?
 *
 * @param {string} absPath
 * @returns {{platform:string, evidence:string}|null} null when the file says
 *   nothing identifiable, in which case it stays where it is.
 */
export function identifyDiscImage(absPath) {
  const key = cacheKey(absPath);
  if (key && cache.has(key)) return cache.get(key);

  const answer = identify(absPath);
  if (key) cache.set(key, answer);
  return answer;
}

function identify(absPath) {
  if (path.extname(absPath).toLowerCase() === '.cue') return identifyFromCue(absPath);

  const head = readHead(absPath, HEADER_BYTES);
  if (!head) return null;
  const text = head.toString('latin1');

  for (const [marker, platform] of SIGNATURES) {
    if (!text.includes(marker)) continue;
    if (platform === 'psx') return refineSony(absPath);
    return { platform, evidence: `“${marker}” in the disc header` };
  }
  return null;
}

/**
 * A cue sheet is a playlist, so it inherits the answer from the track it names.
 * That also means the cue and its tracks always agree, which is what lets the
 * organiser move the whole set together.
 */
function identifyFromCue(cuePath) {
  for (const name of cueReferences(cuePath)) {
    const sibling = path.join(path.dirname(cuePath), name);
    const found = identifyDiscImage(sibling);
    if (found) return { platform: found.platform, evidence: `${name} — ${found.evidence}` };
  }
  return null;
}

/**
 * PS1 and PS2 discs both name themselves PLAYSTATION in the volume descriptor.
 * What separates them is how they boot: PS1 uses `BOOT=` in SYSTEM.CNF, PS2 uses
 * `BOOT2=`.
 *
 * The search is capped, so a PS2 disc whose SYSTEM.CNF happens to sit past the
 * cap is filed as PS1. That is a game in the wrong folder, not a lost one —
 * nothing here overwrites anything, and every move is reported.
 */
function refineSony(absPath) {
  const window = readHead(absPath, REFINE_BYTES);
  const text = window ? window.toString('latin1') : '';
  return /BOOT2\s*=/i.test(text)
    ? { platform: 'ps2', evidence: '“PLAYSTATION” plus a BOOT2 line, so PlayStation 2' }
    : { platform: 'psx', evidence: '“PLAYSTATION” in the ISO 9660 descriptor' };
}
