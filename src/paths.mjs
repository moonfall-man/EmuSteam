// Path plumbing. Everything mutable lives under dataRoot; everything shipped
// lives under appRoot. Keeping those separate is what makes the folder portable.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const webRoot = path.join(appRoot, 'web');

export const dataRoot = process.env.EMUSTEAM_DATA
  ? path.resolve(process.env.EMUSTEAM_DATA)
  : path.join(appRoot, 'data');

/**
 * A one-line file holding an absolute path to the game library.
 *
 * Read here rather than from config.json because config.json lives under
 * dataRoot and the store imports this module — a plain text file keeps the
 * dependency pointing one way.
 */
export const libraryLocationFile = path.join(dataRoot, 'library-location.txt');

/** @returns {string|null} the configured library root, or null when unset. */
function configuredWorkspace() {
  try {
    const raw = fs.readFileSync(libraryLocationFile, 'utf8').trim();
    return raw ? path.resolve(raw) : null;
  } catch {
    return null; // not configured, which is the normal case
  }
}

/**
 * Where the user-facing roms/, emulators/ and cores/ folders live.
 *
 * Normally the app folder, which is what makes their paths portable — zip the
 * whole thing, hand it over, and it still works.
 *
 * Pointing it somewhere else is how several Windows accounts share one library:
 * each profile keeps its own app copy and its own data/ (saves, play time,
 * favourites), while roms/ and emulators/ live once on a shared drive. Copying
 * the app folder per profile would otherwise duplicate every ROM.
 *
 * The env var wins so a test run can never touch the real library.
 */
export const workspaceRoot = process.env.EMUSTEAM_WORKSPACE
  ? path.resolve(process.env.EMUSTEAM_WORKSPACE)
  : configuredWorkspace() || appRoot;

/** Where the library root came from, for the UI to explain itself. */
export const workspaceSource = process.env.EMUSTEAM_WORKSPACE
  ? 'env'
  : (configuredWorkspace() ? 'file' : 'default');

export const artRoot = path.join(dataRoot, 'art');
export const configFile = path.join(dataRoot, 'config.json');
export const libraryFile = path.join(dataRoot, 'library.json');
export const statsFile = path.join(dataRoot, 'stats.json');

export function ensureDataDirs() {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(artRoot, { recursive: true });
}

/**
 * Collapse a path into a portable form when it sits inside the app folder.
 * `C:\EmuSteam\emulators\p64\Project64.exe` becomes `./emulators/p64/Project64.exe`,
 * so zipping the whole folder and moving it to another machine still works.
 */
export function toPortable(abs) {
  if (!abs) return abs;
  const resolved = path.resolve(abs);
  const rel = path.relative(appRoot, resolved);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return './' + rel.split(path.sep).join('/');
  }
  return resolved;
}

/** Inverse of toPortable. Absolute paths pass through untouched. */
export function fromPortable(stored) {
  if (!stored) return stored;
  if (stored.startsWith('./') || stored.startsWith('../')) {
    return path.resolve(appRoot, stored);
  }
  return path.resolve(stored);
}

/** True when `child` is inside `parent` (used to sandbox art file serving). */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Best-effort list of places worth suggesting when the user browses for ROMs. */
export function commonRomLocations() {
  const home = os.homedir();
  const candidates = [
    path.join(appRoot, 'roms'),
    path.join(home, 'ROMs'),
    path.join(home, 'Roms'),
    path.join(home, 'Documents', 'ROMs'),
    path.join(home, 'Downloads'),
  ];
  if (process.platform === 'win32') {
    for (const letter of ['D', 'E', 'F', 'G']) {
      candidates.push(`${letter}:\\ROMs`, `${letter}:\\Games\\ROMs`, `${letter}:\\Emulation`);
    }
  }
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}
