// What gets left behind when the library folder moves.
//
// Pointing the library somewhere else does not move any files — relocating
// gigabytes is the user's call, and doing it as a side effect of a settings
// change would be indefensible. But "nothing was moved" is only half the story,
// because after the move EmuSteam looks in the *new* folder for everything.
//
// ROMs surviving that is obvious: the games vanish from the library, you notice
// immediately, and the fix is to copy them over. Emulators are the quiet one.
// They are not stored in config — they are discovered by scanning emulators/ —
// so a relocated library finds an empty folder, discovers nothing, and the app
// simply reports no emulators as though you never had any. Nothing is broken on
// disk and nothing says what happened.
//
// So: look before the move, say plainly what is about to be orphaned, and offer
// to bring the small, silent one along.

import fs from 'node:fs';
import path from 'node:path';

/** Stop walking a huge ROM folder once the answer is "lots". */
const MAX_WALK = 20000;

/**
 * EmuSteam's own explainer, committed to the repo and recreated in every library
 * folder. It is scaffolding, not content: a roms/ holding nothing but this is an
 * empty folder wearing a hat, and moving it to a new library would delete a
 * tracked file from a git checkout.
 */
const SCAFFOLDING = new Set(['readme.md']);

const isScaffolding = (name) => SCAFFOLDING.has(name.toLowerCase());

/**
 * Count files and bytes under a folder, giving up politely on a giant one.
 *
 * @returns {{count: number, bytes: number, capped: boolean}}
 */
function measure(dir) {
  let count = 0;
  let bytes = 0;
  let capped = false;

  const walk = (at) => {
    if (count >= MAX_WALK) {
      capped = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return; // unreadable, which for a count is the same as empty
    }
    for (const entry of entries) {
      if (count >= MAX_WALK) {
        capped = true;
        return;
      }
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && !(at === dir && isScaffolding(entry.name))) {
        count++;
        try {
          bytes += fs.statSync(full).size;
        } catch { /* vanished mid-walk */ }
      }
    }
  };

  walk(dir);
  return { count, bytes, capped };
}

/**
 * What sits in a library root that a move would leave behind.
 *
 * @param {string} root
 * @returns {{roms: {count,bytes,capped}|null, emulators: {count,bytes,capped}|null}}
 */
export function strandedAt(root) {
  const look = (name) => {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) return null;
    } catch {
      return null;
    }
    const m = measure(dir);
    // A folder holding only its committed README is an empty folder wearing a hat.
    return m.count > 0 ? m : null;
  };
  return { roms: look('roms'), emulators: look('emulators') };
}

/**
 * Move what a folder *contains* into another folder, leaving the folder itself
 * and its README behind.
 *
 * Contents rather than the whole folder because emulators/ ships as a directory
 * with a committed README — moving it wholesale would delete a tracked file out
 * of a git checkout, and the new library grows its own README anyway.
 *
 * Each entry moves independently and verifies before anything is deleted:
 * rename() is the fast path and fails with EXDEV the moment the new library is
 * on another drive, which is the case this exists for. The fallback copies,
 * counts both sides, and only then removes the original — the order that cannot
 * lose files if the power goes out halfway.
 *
 * @returns {{moved: number, bytes: number, entries: string[]}}
 */
export function moveContents(from, to) {
  const entries = fs.readdirSync(from, { withFileTypes: true })
    .filter((e) => !isScaffolding(e.name));
  if (!entries.length) return { moved: 0, bytes: 0, entries: [] };

  fs.mkdirSync(to, { recursive: true });

  let moved = 0;
  let bytes = 0;
  const names = [];

  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (fs.existsSync(dest)) {
      throw new Error(`${dest} already exists. Nothing was moved.`);
    }

    const before = entry.isDirectory()
      ? measure(src)
      : { count: 1, bytes: fs.statSync(src).size, capped: false };

    let renamed = false;
    try {
      fs.renameSync(src, dest);
      renamed = true;
    } catch (err) {
      if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'ENOTEMPTY') throw err;
    }

    if (!renamed) {
      fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });

      const after = entry.isDirectory()
        ? measure(dest)
        : { count: 1, bytes: fs.statSync(dest).size, capped: false };
      if (after.count < before.count || after.bytes < before.bytes) {
        throw new Error(
          `Copying ${entry.name} came up short — ${after.count} of ${before.count} files arrived. `
          + 'Nothing was deleted; the originals are untouched.',
        );
      }

      fs.rmSync(src, { recursive: true, force: true });
    }

    moved += before.count;
    bytes += before.bytes;
    names.push(entry.name);
  }

  return { moved, bytes, entries: names };
}
