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
 * Where the user-facing roms/ and emulators/ folders live. Normally the app
 * folder, which is what makes their paths portable. The test suite overrides it
 * so a test run can never create folders in the real repo.
 */
export const workspaceRoot = process.env.EMUSTEAM_WORKSPACE
  ? path.resolve(process.env.EMUSTEAM_WORKSPACE)
  : appRoot;

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
