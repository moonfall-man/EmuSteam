// ROM folder scanner.
//
// Walks each configured source, filters by the platform's extension list, then
// does the two bits of cleanup that make a raw ROM dump look like a library:
//
//   1. disc shadowing — a .cue/.gdi/.m3u beside its .bin tracks means one entry, not five
//   2. multi-disc grouping — "(Disc 1)" / "(Disc 2)" collapse into a single game
//
// Also picks up box art sitting next to the ROMs while it has the directory
// listing in hand, which is free compared to a second pass.

import fs from 'node:fs';
import path from 'node:path';
import { getPlatform, UNAMBIGUOUS_EXTS, CONTAINER_EXTS, platformMeta } from './platforms.mjs';
import { parseTitle, matchKey } from './titles.mjs';
import { gameId } from './store.mjs';
import { fromPortable, toPortable } from './paths.mjs';

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

// Folders that never contain games. Skipping them keeps scans fast on messy drives.
const SKIP_DIRS = new Set([
  '.git', '.svn', 'node_modules', '$recycle.bin', 'system volume information',
  '__macosx', '.ds_store', 'saves', 'savestates', 'save', 'states', 'sram',
  'screenshots', 'cheats', 'bios', 'firmware', 'shaders', 'overlays',
  'images', 'media', 'artwork', 'boxart', 'covers', 'snaps', 'titles', 'videos', 'manuals',
]);

// Same list, but these are where art lives — we look inside them for images only.
const ART_DIRS = new Set(['images', 'media', 'artwork', 'boxart', 'covers', 'snaps', 'titles']);

const MAX_DEPTH = 8;

// Documentation that must never be mistaken for a game. This exists because
// ".md" is both Markdown and the Sega Genesis ROM extension, so the extension
// alone cannot tell "README.md" from "Sonic.md". Matched on the stem, so a real
// game called "Notes" is still safe — the whole point is that only these exact
// names are excluded.
const DOC_STEMS = new Set([
  'readme', 'read me', 'license', 'licence', 'copying', 'changelog', 'changes',
  'notes', 'index', 'contributing', 'authors', 'credits', 'todo', 'install',
]);
const DOC_EXTS = new Set(['.md', '.txt', '.html', '.htm', '.pdf', '.nfo', '.url', '.ini', '.json']);

/** True for files that are documentation rather than a ROM. */
export function isDocumentationFile(name) {
  const ext = path.extname(name).toLowerCase();
  if (!DOC_EXTS.has(ext)) return false;
  // .txt/.html/etc are never a ROM format, so the extension alone settles it.
  if (ext !== '.md') return true;
  return DOC_STEMS.has(path.basename(name, path.extname(name)).toLowerCase());
}

/**
 * Scan every enabled source in the config.
 * @returns {{scannedAt:number, games:object[], warnings:string[], version:number}}
 */
/**
 * Walk every source and build the library, yielding progress as it goes.
 *
 * A generator rather than a plain function because the same walk has to serve two
 * callers with different needs: a synchronous one (tests, CLI) and the server,
 * which must not block. scanLibrary drains it in one go; scanLibraryAsync drains
 * it with breaks so HTTP and SSE keep working through a long scan. One
 * implementation, so the two can never drift.
 *
 * @param {object} config
 * @param {{library?:object}} out result lands here — generators cannot both yield
 *   progress and return a value usefully across drivers.
 */
function* scanSteps(config, out) {
  const warnings = [];
  /** @type {Map<string, object>} keyed by absolute path so two sources can overlap safely */
  const found = new Map();
  const artIndex = new Map(); // matchKey -> absolute image path

  const sources = (config.sources || []).filter((s) => s.enabled !== false);
  // Counts for the progress readout. There is no total to divide by — finding out
  // how many files there are means walking the tree, which is the work itself — so
  // the UI shows counts rather than a fake percentage.
  const counters = { folders: 0, files: 0, sources: sources.length, sourceIndex: 0 };

  for (const source of sources) {
    const root = fromPortable(source.path);
    let stat;
    try {
      stat = fs.statSync(root);
    } catch {
      warnings.push(`Source folder is missing: ${source.path}`);
      continue;
    }
    if (!stat.isDirectory()) {
      warnings.push(`Source is not a folder: ${source.path}`);
      continue;
    }

    yield { phase: 'scanning', source: source.path, folders: counters.folders, files: counters.files, games: found.size };
    yield* walk(root, source, 0, found, artIndex, warnings, counters);
  }

  // Extra art roots the user pointed us at (LaunchBox / EmulationStation dumps).
  for (const dir of config.artDirs || []) {
    const abs = fromPortable(dir);
    try {
      if (fs.statSync(abs).isDirectory()) indexArtTree(abs, 0, artIndex);
    } catch {
      warnings.push(`Art folder is missing: ${dir}`);
    }
  }

  const games = collapseDiscs([...found.values()]);

  for (const game of games) {
    const art = artIndex.get(game.matchKey);
    if (art) game.art = toPortable(art);
  }

  games.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.title.localeCompare(b.title));

  yield {
    phase: 'done', folders: counters.folders, files: counters.files, games: games.length,
  };
  out.library = { version: 1, scannedAt: Date.now(), games, warnings };
}

/** Scan to completion without yielding the event loop. */
export function scanLibrary(config, { onProgress } = {}) {
  const out = {};
  for (const step of scanSteps(config, out)) onProgress?.(step);
  return out.library;
}

/**
 * Same scan, but pausing often enough that the server stays responsive.
 *
 * Without this a first scan of a large library blocks Node outright: no HTTP, no
 * SSE, so the window has nothing to draw and a progress bar would sit frozen at
 * zero — which is worse than no progress bar at all.
 */
export async function scanLibraryAsync(config, { onProgress } = {}) {
  const out = {};
  let sinceBreath = 0;
  for (const step of scanSteps(config, out)) {
    onProgress?.(step);
    if (++sinceBreath >= 4) {
      sinceBreath = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  return out.library;
}

function* walk(dir, source, depth, found, artIndex, warnings, counters) {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push(`Could not read ${dir}: ${err.message}`);
    return;
  }

  const files = [];
  const subdirs = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // avoid loops on junctioned drives
    if (entry.isDirectory()) subdirs.push(entry.name);
    else if (entry.isFile()) files.push(entry.name);
  }

  // Art sitting beside the ROMs in this directory.
  for (const name of files) {
    if (IMAGE_EXTS.has(path.extname(name).toLowerCase())) {
      const key = matchKey(parseTitle(name).title);
      if (key && !artIndex.has(key)) artIndex.set(key, path.join(dir, name));
    }
  }

  const accepted = pickRoms(dir, files, source, warnings);
  for (const rom of accepted) {
    if (!found.has(rom.absPath.toLowerCase())) found.set(rom.absPath.toLowerCase(), rom);
  }

  counters.folders++;
  counters.files += files.length;
  // One update per directory: frequent enough to look alive on a big library,
  // rare enough not to flood the event stream with a message per file.
  yield {
    phase: 'scanning', folder: dir, folders: counters.folders, files: counters.files, games: found.size,
  };

  if (source.recursive === false) return;

  for (const name of subdirs) {
    const lower = name.toLowerCase();
    if (lower.startsWith('.')) continue;
    if (ART_DIRS.has(lower)) {
      indexArtTree(path.join(dir, name), 0, artIndex);
      continue;
    }
    if (SKIP_DIRS.has(lower)) continue;
    yield* walk(path.join(dir, name), source, depth + 1, found, artIndex, warnings, counters);
  }
}

/** Recursively collect images from a dedicated art folder. */
function indexArtTree(dir, depth, artIndex) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      indexArtTree(full, depth + 1, artIndex);
    } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      const key = matchKey(parseTitle(entry.name).title);
      if (key && !artIndex.has(key)) artIndex.set(key, full);
    }
  }
}

/**
 * Decide which files in one directory are real games.
 * Runs the shadowing rules, which are inherently per-directory.
 */
function pickRoms(dir, files, source, warnings) {
  const explicit = source.platform && source.platform !== 'auto' ? source.platform : null;
  const platformDef = explicit ? getPlatform(explicit) : null;
  if (explicit && !platformDef) {
    warnings.push(`Source ${source.path} points at unknown platform "${explicit}"`);
    return [];
  }

  const allowed = platformDef ? new Set(platformDef.exts) : null;

  // Pass 1: which files even qualify, and for which platform.
  const candidates = [];
  for (const name of files) {
    const ext = path.extname(name).toLowerCase();
    if (!ext) continue;
    // A README dropped in a Genesis folder is not a Genesis ROM.
    if (isDocumentationFile(name)) continue;

    let platform = explicit;
    if (!platform) {
      platform = UNAMBIGUOUS_EXTS.get(ext) || null;
      if (!platform) continue; // ambiguous extension in an auto folder — needs an explicit source
    } else if (!allowed.has(ext)) {
      continue;
    }
    candidates.push({ name, ext, platform });
  }
  if (!candidates.length) return [];

  // Pass 2: shadowing. A container file wins over its raw data tracks.
  const containersByStem = new Map();
  for (const c of candidates) {
    if (CONTAINER_EXTS.has(c.ext)) {
      const stem = path.basename(c.name, path.extname(c.name)).toLowerCase();
      if (!containersByStem.has(stem)) containersByStem.set(stem, []);
      containersByStem.get(stem).push(c.ext);
    }
  }

  // Files named inside an .m3u are discs of a set, not standalone entries.
  const inPlaylist = new Set();
  for (const c of candidates) {
    if (c.ext !== '.m3u') continue;
    for (const ref of readPlaylist(path.join(dir, c.name))) inPlaylist.add(ref.toLowerCase());
  }

  const out = [];
  for (const c of candidates) {
    const stem = path.basename(c.name, path.extname(c.name)).toLowerCase();
    const shadowExts = new Set((getPlatform(c.platform)?.shadow) || []);

    if (c.ext !== '.m3u' && inPlaylist.has(c.name.toLowerCase())) continue;

    if (shadowExts.has(c.ext) && !CONTAINER_EXTS.has(c.ext)) {
      // Hidden only when a real container sits beside it with the same stem.
      if (containersByStem.has(stem)) continue;
    }
    // An .m3u always beats a bare .cue for the same stem.
    if (c.ext === '.cue' && (containersByStem.get(stem) || []).includes('.m3u')) continue;
    if (c.ext === '.chd' && (containersByStem.get(stem) || []).includes('.m3u')) continue;

    const absPath = path.join(dir, c.name);
    let size = 0;
    try {
      size = fs.statSync(absPath).size;
    } catch { /* unreadable file: keep it, size is cosmetic */ }

    const meta = parseTitle(c.name);
    out.push({
      id: gameId(c.platform, absPath),
      platform: c.platform,
      title: meta.title,
      sortKey: meta.sortKey,
      matchKey: matchKey(meta.title),
      file: toPortable(absPath),
      absPath,
      ext: c.ext,
      size,
      region: meta.region,
      regionFlag: meta.regionFlag,
      revision: meta.revision,
      version: meta.version,
      disc: meta.disc,
      languages: meta.languages,
      quality: meta.quality,
      sourceId: source.id,
      art: null,
    });
  }

  return out;
}

/** Read the ROM filenames referenced by an .m3u playlist. */
function readPlaylist(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => path.basename(line));
  } catch {
    return [];
  }
}

/**
 * Fold "(Disc 2)" entries into their "(Disc 1)" sibling. The extra discs stay
 * reachable on the game page, they just stop cluttering the grid.
 */
function collapseDiscs(games) {
  const groups = new Map();
  const out = [];

  for (const game of games) {
    if (!game.disc) {
      out.push(game);
      continue;
    }
    const key = `${game.platform}|${game.matchKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(game);
  }

  for (const discs of groups.values()) {
    discs.sort((a, b) => String(a.disc.number).localeCompare(String(b.disc.number), undefined, { numeric: true }));
    const primary = discs[0];
    primary.discs = discs.map((d) => ({
      number: d.disc.number,
      file: d.file,
      absPath: d.absPath,
      id: d.id,
    }));
    primary.discCount = discs.length;
    out.push(primary);
  }

  // Strip the working field; the frontend only needs discs/discCount.
  for (const game of out) delete game.disc;
  return out;
}

/**
 * Guess the platform of a folder by sampling its extensions. Used by the
 * "add ROM folder" flow so the platform dropdown starts on the right answer.
 */
export function guessPlatform(dir) {
  const counts = new Map();
  const visit = (d, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!lower.startsWith('.') && !SKIP_DIRS.has(lower)) visit(path.join(d, entry.name), depth + 1);
        continue;
      }
      const owner = UNAMBIGUOUS_EXTS.get(path.extname(entry.name).toLowerCase());
      if (owner) counts.set(owner, (counts.get(owner) || 0) + 1);
    }
  };
  visit(dir, 0);

  if (!counts.size) {
    // Fall back to the folder name — "D:\Roms\N64" is a strong hint.
    const name = path.basename(dir).toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const p of [...UNAMBIGUOUS_EXTS.values()]) {
      const meta = platformMeta(p);
      if (name === p || name === meta.short.toLowerCase().replace(/[^a-z0-9]/g, '')) return p;
    }
    return 'auto';
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}
