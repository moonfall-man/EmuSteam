// Box-art serving.
//
// There is deliberately no art *downloader* here — EmuSteam never phones home.
// Art comes from three places, all local:
//   1. an image next to the ROM with a matching name
//   2. a folder you point at in Settings (a LaunchBox / ES-DE images dump works)
//   3. an image you assign to a game by hand, copied into data/art/
//
// Games with no art get a generated tile in the frontend, which is why this
// module can stay this small.

import fs from 'node:fs';
import path from 'node:path';
import { artRoot, dataRoot, fromPortable, isInside, toPortable } from './paths.mjs';
import { loadConfig } from './store.mjs';

const MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
]);

export function isImagePath(p) {
  return MIME.has(path.extname(String(p)).toLowerCase());
}

export function mimeForImage(p) {
  return MIME.get(path.extname(String(p)).toLowerCase()) || 'application/octet-stream';
}

/**
 * Roots that art may be served from. Anything outside these is refused, so a
 * crafted `/art?p=...` can't turn the local server into a file-read oracle.
 */
export function allowedArtRoots(config = loadConfig()) {
  const roots = [dataRoot];
  for (const source of config.sources || []) roots.push(fromPortable(source.path));
  for (const dir of config.artDirs || []) roots.push(fromPortable(dir));
  return roots;
}

/** @returns {{ok:true, path:string} | {ok:false, reason:string}} */
export function resolveArtRequest(requestedPath, config = loadConfig()) {
  if (!requestedPath) return { ok: false, reason: 'missing path' };

  let abs;
  try {
    abs = fromPortable(requestedPath);
  } catch {
    return { ok: false, reason: 'bad path' };
  }

  if (!isImagePath(abs)) return { ok: false, reason: 'not an image' };

  const roots = allowedArtRoots(config);
  if (!roots.some((root) => isInside(root, abs))) {
    return { ok: false, reason: 'outside allowed folders' };
  }

  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, reason: 'not a file' };
  } catch {
    return { ok: false, reason: 'not found' };
  }

  return { ok: true, path: abs };
}

/**
 * Copy a chosen image into data/art so the assignment survives the source
 * folder being moved or renamed.
 * @returns {{ok:true, art:string} | {ok:false, error:string}}
 */
export function assignArt(gameId, sourceImagePath) {
  const src = fromPortable(sourceImagePath);
  if (!isImagePath(src)) return { ok: false, error: 'That file is not a PNG/JPG/WEBP image.' };
  try {
    if (!fs.statSync(src).isFile()) return { ok: false, error: 'That path is not a file.' };
  } catch {
    return { ok: false, error: `Image not found: ${src}` };
  }

  fs.mkdirSync(artRoot, { recursive: true });

  // One art file per game id; clear any previous extension so we don't leave orphans.
  for (const ext of MIME.keys()) {
    const stale = path.join(artRoot, `${gameId}${ext}`);
    if (fs.existsSync(stale)) {
      try { fs.rmSync(stale); } catch { /* best effort */ }
    }
  }

  const dest = path.join(artRoot, `${gameId}${path.extname(src).toLowerCase()}`);
  try {
    fs.copyFileSync(src, dest);
  } catch (err) {
    return { ok: false, error: `Could not copy art: ${err.message}` };
  }
  return { ok: true, art: toPortable(dest) };
}

export function clearArt(gameId) {
  for (const ext of MIME.keys()) {
    const file = path.join(artRoot, `${gameId}${ext}`);
    if (fs.existsSync(file)) {
      try { fs.rmSync(file); } catch { /* best effort */ }
    }
  }
}

/** Art assigned by hand takes priority over anything the scanner found. */
export function manualArtFor(gameId) {
  for (const ext of MIME.keys()) {
    const file = path.join(artRoot, `${gameId}${ext}`);
    if (fs.existsSync(file)) return toPortable(file);
  }
  return null;
}

/**
 * Every assigned art file at once, keyed by game id.
 *
 * manualArtFor() costs one existsSync per supported extension — six per game.
 * Fine for one game, ruinous for a library: at 24,000 games that is ~150,000
 * syscalls on every /api/state, which measured at 5.8 seconds and made the UI
 * unusable on a big collection. One readdir gives the same answer, and the
 * directory only holds art that has actually been assigned or downloaded.
 *
 * @returns {Map<string, string>} game id → portable art path
 */
export function manualArtIndex() {
  const out = new Map();
  let names;
  try {
    names = fs.readdirSync(artRoot);
  } catch {
    return out; // nothing assigned yet
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!MIME.has(ext)) continue;
    const id = name.slice(0, -ext.length);
    // First extension wins, matching manualArtFor's order-independent behaviour
    // closely enough: assignArt only ever leaves one file per id.
    if (!out.has(id)) out.set(id, toPortable(path.join(artRoot, name)));
  }
  return out;
}
