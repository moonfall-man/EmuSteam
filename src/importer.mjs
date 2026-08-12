// Bulk import: hand it files or folders from anywhere and it files them.
//
// This exists because the alternative is opening a file manager and dropping ROMs
// into roms/ by hand, which is the one part of setup that felt like homework.
//
// Paths come from a native file dialog, so we get *real* paths and can move or
// copy on the filesystem. Uploading bytes through the browser was the other
// option and it is strictly worse: a browser hands over file contents but not
// paths, so a 632 MB disc image would be pushed through an HTTP request and
// written a second time, when a same-volume move is instant and free.
//
// The rules match the loose-file organiser exactly, because they share
// classifyRomFile: extension when it is unambiguous, disc header when it is not,
// cue sheets travelling with their tracks, and nothing ever overwritten.

import fs from 'node:fs';
import path from 'node:path';
import { platformMeta } from './platforms.mjs';
import { cueReferences } from './discs.mjs';
import {
  romsRoot, folderNameFor, classifyRomFile, ensureWorkspaceDirs,
} from './workspace.mjs';

// Deep enough for "Roms/Nintendo/GBA/Pokemon/", shallow enough that pointing this
// at a whole drive by accident does not walk it forever.
const MAX_DEPTH = 6;

const SKIP_DIRS = new Set([
  '$recycle.bin', 'system volume information', 'node_modules', '.git', '.svn',
  'windows', 'program files', 'program files (x86)', 'appdata',
]);

/**
 * Expand the chosen paths into a flat list of candidate files.
 * @param {string[]} paths files and/or folders
 */
function collect(paths) {
  const files = [];
  const seen = new Set();

  const addFile = (abs) => {
    const key = abs.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    files.push(abs);
  };

  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // no loops on junctioned drives
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        walk(abs, depth + 1);
      } else if (entry.isFile()) {
        addFile(abs);
      }
    }
  };

  for (const raw of paths) {
    const abs = path.resolve(String(raw));
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(abs, 0);
    else if (stat.isFile()) addFile(abs);
  }
  return files;
}

/**
 * Work out what would happen, without touching anything.
 *
 * Worth having separately so the UI can say "42 games into 6 systems, 3 skipped"
 * and get a yes before moving someone's files around.
 *
 * @param {string[]} paths
 * @returns {{groups:Array<object>, skipped:Array<{name:string, reason:string}>,
 *            bytes:number, systems:string[]}}
 */
export function planImport(paths) {
  const files = collect(paths);
  const byPath = new Map(files.map((f) => [f.toLowerCase(), f]));
  const claimed = new Set();
  const groups = [];
  const skipped = [];
  let bytes = 0;

  const sizeOf = (abs) => {
    try {
      return fs.statSync(abs).size;
    } catch {
      return 0;
    }
  };

  // Cue sheets first, so their tracks are claimed before being considered alone.
  // A track imported without its sheet, or a sheet without its track, is a broken
  // game — they move as one unit or not at all.
  for (const abs of files) {
    if (path.extname(abs).toLowerCase() !== '.cue') continue;
    const { platform, evidence, reason } = classifyRomFile(abs);
    if (!platform) {
      skipped.push({ name: path.basename(abs), reason });
      claimed.add(abs.toLowerCase());
      continue;
    }
    const tracks = [];
    for (const name of cueReferences(abs)) {
      const sibling = path.join(path.dirname(abs), name);
      const known = byPath.get(sibling.toLowerCase());
      // Include the track even if the dialog did not select it: importing a cue
      // without its data is pointless, and it sits right there next to it.
      const track = known || (fs.existsSync(sibling) ? sibling : null);
      if (track && track.toLowerCase() !== abs.toLowerCase()) {
        tracks.push(track);
        claimed.add(track.toLowerCase());
      }
    }
    claimed.add(abs.toLowerCase());
    const members = [abs, ...tracks];
    const groupBytes = members.reduce((sum, m) => sum + sizeOf(m), 0);
    bytes += groupBytes;
    groups.push({
      platform,
      folder: folderNameFor(platform),
      platformName: platformMeta(platform).name,
      files: members,
      name: path.basename(abs),
      evidence,
      bytes: groupBytes,
    });
  }

  for (const abs of files) {
    if (claimed.has(abs.toLowerCase())) continue;
    const { platform, evidence, reason } = classifyRomFile(abs);
    if (!platform) {
      skipped.push({ name: path.basename(abs), reason });
      continue;
    }
    const size = sizeOf(abs);
    bytes += size;
    groups.push({
      platform,
      folder: folderNameFor(platform),
      platformName: platformMeta(platform).name,
      files: [abs],
      name: path.basename(abs),
      evidence,
      bytes: size,
    });
  }

  groups.sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name));
  return {
    groups,
    skipped,
    bytes,
    systems: [...new Set(groups.map((g) => g.platform))].sort(),
  };
}

/**
 * Copy a file, then verify the size matches before reporting success.
 *
 * A short copy that reports success is the worst outcome here — it looks like a
 * working import and plays as a corrupt ROM.
 */
function copyVerified(from, to) {
  fs.copyFileSync(from, to);
  const src = fs.statSync(from).size;
  const dst = fs.statSync(to).size;
  if (src !== dst) {
    try {
      fs.rmSync(to, { force: true });
    } catch { /* nothing better to do */ }
    throw new Error(`copy came out ${dst} bytes instead of ${src}`);
  }
}

/**
 * Move a file across volumes.
 *
 * rename() only works within one filesystem, and importing from a USB stick or a
 * second drive is exactly the case this feature is for, so fall back to
 * copy-then-delete. The delete only happens after the copy is verified.
 */
function moveFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    copyVerified(from, to);
    fs.rmSync(from, { force: true });
  }
}

/**
 * Do the import.
 *
 * @param {string[]} paths
 * @param {{mode?:'copy'|'move', onProgress?:(p:object)=>void}} opts
 *   mode defaults to 'copy' on purpose: these are files the user put somewhere
 *   deliberately, and taking them away is not a side effect anyone should get by
 *   accident. 'move' is available and reported, never assumed.
 */
export function importRoms(paths, opts = {}) {
  const { mode = 'copy', onProgress } = opts;
  ensureWorkspaceDirs();

  const plan = planImport(paths);
  const imported = [];
  const skipped = [...plan.skipped];
  const createdFolders = [];
  let bytesDone = 0;

  onProgress?.({
    phase: 'start',
    total: plan.groups.length,
    bytes: plan.bytes,
    systems: plan.systems.length,
    mode,
  });

  let done = 0;
  for (const group of plan.groups) {
    const targetDir = path.join(romsRoot, group.folder);

    // All or nothing per game, and never over the top of something already there.
    const clash = group.files.find((f) => fs.existsSync(path.join(targetDir, path.basename(f))));
    if (clash) {
      skipped.push({
        name: group.name,
        reason: `roms/${group.folder}/${path.basename(clash)} already exists.`,
      });
      done++;
      continue;
    }

    const placed = [];
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        createdFolders.push(group.folder);
      }
      for (const from of group.files) {
        const to = path.join(targetDir, path.basename(from));
        if (mode === 'move') moveFile(from, to);
        else copyVerified(from, to);
        placed.push({ from, to });
      }
      bytesDone += group.bytes;
      imported.push({
        name: group.name,
        folder: group.folder,
        platform: group.platform,
        platformName: group.platformName,
        files: group.files.length,
        bytes: group.bytes,
        evidence: group.evidence,
      });
    } catch (err) {
      // Undo this game's partial placement so a failure cannot leave half a disc
      // set in the library. Copies are deleted; moves are put back.
      for (const { from, to } of placed) {
        try {
          if (mode === 'move') fs.renameSync(to, from);
          else fs.rmSync(to, { force: true });
        } catch { /* best effort — the reported error is the real story */ }
      }
      skipped.push({ name: group.name, reason: err.message });
    }

    done++;
    onProgress?.({
      phase: 'working',
      done,
      total: plan.groups.length,
      bytesDone,
      bytes: plan.bytes,
      label: group.name,
      folder: group.folder,
    });
  }

  const result = {
    imported,
    skipped,
    createdFolders: [...new Set(createdFolders)],
    bytes: bytesDone,
    mode,
  };
  onProgress?.({ phase: 'done', ...result, count: imported.length });
  return result;
}
