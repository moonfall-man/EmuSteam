// The in-repo roms/ and emulators/ workspace, and the rules that keep it tidy.
//
// A roms/<System>/ folder exists for either of two reasons, and either alone is
// enough:
//
//   1. you have an emulator that can play that system — so you need somewhere
//      to put its games;
//   2. games for that system are already sitting there — so they need a home.
//
// Add mGBA and roms/GBA/, roms/GB/ and roms/GBC/ appear, registered as scan
// sources. Drop a .gb straight into roms/ and it gets filed into roms/GB/ on the
// next scan, creating the folder if rule 1 has not already. Between them there is
// no way to end up with a game the app cannot see, and no "add ROM folder" step
// for the common case.
//
// Folders are only ever reclaimed when they are both empty and unplayable, so
// nothing here can take a game away from you.
//
// Both folders live inside the app directory, so paths get stored relative and
// the whole thing stays zip-and-hand-it-over portable.

import fs from 'node:fs';
import path from 'node:path';
import { workspaceRoot, toPortable, fromPortable } from './paths.mjs';
import { PLATFORMS, platformMeta, UNAMBIGUOUS_EXTS } from './platforms.mjs';
import { identifyDiscImage, cueReferences } from './discs.mjs';
import { playablePlatformIds } from './emulators.mjs';
import { findPreset } from './presets.mjs';
import { isDocumentationFile } from './scanner.mjs';
import { updateConfig, newId } from './store.mjs';

export const romsRoot = path.join(workspaceRoot, 'roms');
export const emulatorsRoot = path.join(workspaceRoot, 'emulators');

const ILLEGAL = /[\\/:*?"<>|]+/g;

// Kept in step with the scanner's own list: these are art when they sit beside
// games, not games themselves.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp']);

/** PICO-8 carts are PNGs, and are always named "cart.p8.png". */
const PICO8_CART = /\.p8\.png$/i;

/**
 * Filesystem-safe folder name for a platform. Prefers an explicit `folder` in
 * the catalogue, else the short name — "GBA", "N64", "Genesis".
 */
export function folderNameFor(platformId) {
  const meta = platformMeta(platformId);
  const raw = meta.folder || meta.short || meta.id;
  return String(raw).replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim();
}

/** Reverse lookup: which platform owns this roms/ subfolder name? */
export function platformForFolderName(name) {
  const wanted = String(name).toLowerCase();
  return PLATFORMS.find((p) => folderNameFor(p.id).toLowerCase() === wanted)?.id || null;
}

export function ensureWorkspaceDirs() {
  fs.mkdirSync(romsRoot, { recursive: true });
  fs.mkdirSync(emulatorsRoot, { recursive: true });
}

function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

/** Recognised system folders that already exist under roms/. */
function existingSystemFolders() {
  let entries;
  try {
    entries = fs.readdirSync(romsRoot, { withFileTypes: true });
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const platform = platformForFolderName(entry.name);
    if (platform) out.set(platform, path.join(romsRoot, entry.name));
  }
  return out;
}

/**
 * Bring roms/ into line with reality.
 *
 * A folder is wanted for two independent reasons, and either is enough:
 *   - you have an emulator for that system, so you need somewhere to put games;
 *   - the folder already exists and holds games, so those games need a home.
 *
 * The second reason is what lets auto-filing create a folder for a system you
 * cannot play yet — better to have the game filed and the UI saying "no emulator"
 * than to have it sitting loose and invisible.
 *
 * Folders are only reclaimed when they are *both* empty and unplayable, so
 * uninstalling an emulator can never take games with it.
 *
 * @returns {{created:string[], removed:string[]}} platform ids, for reporting
 */
export function reconcileRomFolders(config) {
  ensureWorkspaceDirs();

  const playable = new Set(playablePlatformIds(config));
  const existing = existingSystemFolders();

  // Anything playable, plus any recognised folder already on disk that has
  // content — a folder holding games keeps its source regardless of emulators.
  const wanted = new Set(playable);
  for (const [platform, dir] of existing) {
    if (!isEmptyDir(dir)) wanted.add(platform);
  }

  const created = [];
  const removed = [];

  updateConfig((draft) => {
    // 0. Has the library been relocated out from under us?
    //
    // A managed source means "the roms/<System>/ folder EmuSteam looks after". If
    // the library root has moved, those paths describe the previous location and
    // nothing at the new one is registered — so a game imported after relocating
    // would be filed correctly and never appear.
    //
    // They become ordinary folders rather than being dropped, so the games in them
    // stay visible while you move them across at your own pace. Once the old
    // folder is empty you can remove it in Settings; nothing is deleted here.
    for (const source of draft.sources) {
      if (!source.managed) continue;
      const want = path.join(romsRoot, folderNameFor(source.platform));
      if (fromPortable(source.path).toLowerCase() !== want.toLowerCase()) {
        source.managed = false;
      }
    }

    const managed = draft.sources.filter((s) => s.managed);
    const managedByPlatform = new Map(managed.map((s) => [s.platform, s]));

    // 1. Every wanted system gets a folder and a source.
    for (const platformId of wanted) {
      const dir = path.join(romsRoot, folderNameFor(platformId));
      let existed = true;
      try {
        existed = fs.statSync(dir).isDirectory();
      } catch {
        existed = false;
      }
      if (!existed) {
        fs.mkdirSync(dir, { recursive: true });
        created.push(platformId);
      }

      if (!managedByPlatform.has(platformId)) {
        const stored = toPortable(dir);
        // Do not double-register if the user already pointed a source here.
        const clash = draft.sources.find(
          (s) => fromPortable(s.path).toLowerCase() === dir.toLowerCase(),
        );
        if (clash) {
          clash.managed = true;
          clash.platform = platformId;
        } else {
          draft.sources.push({
            id: newId('src'),
            path: stored,
            platform: platformId,
            recursive: true,
            enabled: true,
            managed: true,
          });
        }
      }
    }

    // 2. Systems that are neither playable nor holding games give the folder back.
    for (const source of managed) {
      if (wanted.has(source.platform)) continue;

      const dir = fromPortable(source.path);
      if (isEmptyDir(dir)) {
        try {
          fs.rmdirSync(dir);
        } catch { /* left behind is fine; the source goes either way */ }
        draft.sources = draft.sources.filter((s) => s.id !== source.id);
        removed.push(source.platform);
      }
      // Non-empty: keep folder and source. The system will simply show as
      // "No emulator" in the UI until one is added back.
    }
  });

  return { created, removed };
}

// Extensions that could plausibly be an emulator you launch.
const EXECUTABLE_EXTS = new Set(
  process.platform === 'win32'
    ? ['.exe', '.bat', '.cmd']
    : ['', '.sh', '.appimage', '.AppImage'],
);

// Support files that live beside a portable build and are never the thing you run.
const NOT_THE_EMULATOR = /^(unins|setup|install|vcredist|dxsetup|crashpad|updater|7z|ffmpeg|qt[a-z0-9]*)/i;

/**
 * Find emulators already sitting in emulators/.
 *
 * This is the same idea as ES-DE's es_find_rules.xml, which looks for e.g.
 * `%ESPATH%\Emulators\mGBA\mGBA.exe` before falling back to registry and PATH
 * lookups — scoped here to our own folder, which is the case that matters for a
 * portable setup. If you have dropped a portable build in, the app should notice
 * rather than making you go and find it.
 *
 * @param {object} config to skip emulators that are already configured
 * @returns {Array<{exe:string, portable:string, dir:string, name:string, preset:object|null}>}
 */
export function discoverEmulators(config) {
  const alreadyAdded = new Set(
    (config.emulators || []).map((emulator) => fromPortable(emulator.exe).toLowerCase()),
  );

  /** @type {Map<string, Array<{exe:string, stem:string, preset:object}>>} preset name -> matches */
  const byPreset = new Map();

  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!EXECUTABLE_EXTS.has(ext)) continue;
      if (NOT_THE_EMULATOR.test(entry.name)) continue;
      if (alreadyAdded.has(full.toLowerCase())) continue;

      const preset = findPreset(full);
      if (!preset) continue; // unknown program: leave it to a manual add

      const stem = path.basename(entry.name, path.extname(entry.name)).toLowerCase();
      if (!byPreset.has(preset.name)) byPreset.set(preset.name, []);
      byPreset.get(preset.name).push({ exe: full, stem, preset });
    }
  };

  walk(emulatorsRoot, 0);

  // A portable build usually ships more than one executable, and offering all of
  // them is noise. Pick the one whose name is closest to the emulator's own —
  // an mGBA release contains both mGBA.exe and mgba-sdl.exe, and the plain one
  // is the main Qt build people actually want. Sorting alphabetically would pick
  // "mgba-sdl" ('-' sorts before '.'), which is the wrong answer.
  const found = [];
  for (const [name, matches] of byPreset) {
    matches.sort((a, b) => a.stem.length - b.stem.length || a.stem.localeCompare(b.stem));
    const best = matches[0];
    found.push({
      exe: best.exe,
      portable: toPortable(best.exe),
      dir: path.dirname(best.exe),
      name,
      // Other executables in the same build, in case the primary is not wanted.
      alternates: matches.slice(1).map((m) => m.exe),
      preset: {
        name: best.preset.name,
        args: best.preset.args,
        libretro: !!best.preset.libretro,
        platforms: best.preset.libretro ? [] : best.preset.platforms || [],
        notes: best.preset.notes || null,
      },
    });
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/**
 * Which system does this file belong to, and how do we know?
 *
 * One place for the rule, used both by the loose-file organiser and by importing
 * from outside the workspace. An unambiguous extension names its own system; an
 * ambiguous one gets its header read; anything else is left alone.
 *
 * @param {string} absPath
 * @returns {{platform:string|null, evidence:string|null, reason:string|null}}
 */
export function classifyRomFile(absPath) {
  const name = path.basename(absPath);
  const ext = path.extname(name).toLowerCase();

  if (!ext || isDocumentationFile(name)) {
    return { platform: null, evidence: null, reason: 'Not a ROM.' };
  }

  // .png means two things. PICO-8 carts are PNGs — and are always named
  // "cart.p8.png" — while every other .png beside a ROM is box art. Without this,
  // a cover.png sitting next to your games gets filed as a PICO-8 game, which is
  // the same trap .md had (Markdown vs Genesis) and wants the same answer: judge
  // by the naming convention, not the extension alone.
  if (IMAGE_EXTS.has(ext) && !PICO8_CART.test(name)) {
    return { platform: null, evidence: null, reason: 'This is an image, not a game.' };
  }

  const byExt = UNAMBIGUOUS_EXTS.get(ext) || null;
  if (byExt) return { platform: byExt, evidence: null, reason: null };

  const found = identifyDiscImage(absPath);
  if (found) return { platform: found.platform, evidence: found.evidence, reason: null };

  return {
    platform: null,
    evidence: null,
    reason: `Nothing in this ${ext} identifies which system it is for.`,
  };
}

/**
 * ROMs dropped straight into roms/ instead of into a system subfolder.
 *
 * This is the obvious thing to do and the one thing that silently does not work:
 * only roms/<System>/ folders are scan sources, so a loose file is invisible.
 * Rather than let it look like the app lost the game, find them and offer to
 * file them away.
 *
 * An unambiguous extension names its own system. An ambiguous one — .bin, .iso,
 * .cue — gets opened and asked: disc images carry a signature identifying the
 * console that made them, so most of them can be filed with certainty rather than
 * guesswork. Anything that still says nothing about itself is reported without a
 * destination and left alone.
 */
export function looseRomFiles(config) {
  let entries;
  try {
    entries = fs.readdirSync(romsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const playable = new Set(playablePlatformIds(config));

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, ext: path.extname(entry.name).toLowerCase() }))
    // Not `ext !== '.md'`: .md is the Genesis ROM extension too, so exclude
    // documentation by name and let a real "Sonic.md" through.
    .filter((file) => file.ext && !isDocumentationFile(file.name))
    .map((file) => {
      const { platform, evidence } = classifyRomFile(path.join(romsRoot, file.name));
      return {
        name: file.name,
        ext: file.ext,
        platform,
        platformName: platform ? platformMeta(platform).name : null,
        folder: platform ? folderNameFor(platform) : null,
        // Set when the system was determined by reading the file rather than from
        // its extension, so the UI can show *why* it is about to be moved.
        evidence,
        // Knowing the system is the only requirement — the folder gets created
        // whether or not an emulator exists yet, so the game has a home either
        // way and the UI can tell you what is still missing.
        sortable: !!platform,
        needsEmulator: !!platform && !playable.has(platform),
        reason: platform
          ? null
          : `Nothing in this ${file.ext} identifies which system it is for, so it needs filing by hand.`,
      };
    });
}

/**
 * ROMs sitting in the wrong system folder — a .gb dropped into roms/GBA/, say.
 * The scanner filters by the folder's extension list, so a misfiled game is just
 * as invisible as a loose one.
 *
 * Only the top level of each system folder is considered. People deliberately
 * organise inside these folders (roms/GBA/Pokemon/…) and reaching into those
 * would be rearranging someone's filing rather than fixing a mistake.
 */
export function misfiledRomFiles() {
  const out = [];

  for (const [platform, dir] of existingSystemFolders()) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (isDocumentationFile(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const owner = UNAMBIGUOUS_EXTS.get(ext);
      // Only act when the extension belongs to exactly one *other* system.
      if (!owner || owner === platform) continue;

      out.push({
        name: entry.name,
        from: dir,
        fromFolder: folderNameFor(platform),
        platform: owner,
        folder: folderNameFor(owner),
        platformName: platformMeta(owner).name,
      });
    }
  }

  return out;
}

/**
 * Work out every move without performing any of them, so the same plan can be
 * previewed in the UI and executed at startup.
 * @returns {{moves:Array<object>, blocked:Array<{name:string, reason:string}>}}
 */
export function planOrganize(config) {
  const moves = [];
  const blocked = [];

  const loose = looseRomFiles(config);
  const looseNames = new Set(loose.map((f) => f.name));

  // A cue sheet references its tracks by bare filename, so the sheet and its
  // tracks have to land in the same folder or the game is broken. Claim them as
  // one unit here and move them together below.
  const claimed = new Set();
  const companionsOf = new Map();
  for (const file of loose) {
    if (file.ext !== '.cue' || !file.platform) continue;
    const tracks = cueReferences(path.join(romsRoot, file.name))
      .filter((name) => name !== file.name && looseNames.has(name) && !claimed.has(name));
    for (const name of tracks) claimed.add(name);
    companionsOf.set(file.name, tracks);
  }

  for (const file of loose) {
    if (claimed.has(file.name)) continue; // travelling with its cue sheet
    if (!file.platform) {
      blocked.push({ name: file.name, reason: file.reason });
      continue;
    }
    const companions = companionsOf.get(file.name) || [];
    moves.push({
      name: file.name,
      names: [file.name, ...companions],
      from: romsRoot,
      fromFolder: null,
      platform: file.platform,
      folder: file.folder,
      platformName: file.platformName,
      evidence: file.evidence,
    });
  }

  for (const file of misfiledRomFiles()) moves.push(file);

  return { moves, blocked };
}

/**
 * File ROMs into the right system folder, creating folders as needed.
 *
 * Never overwrites and never guesses: a name collision is reported and skipped,
 * and an extension that could belong to several systems is left exactly where it
 * is. Moving someone's games is not something to be clever about.
 *
 * @returns {{moved:Array<object>, skipped:Array<{name:string, reason:string}>, createdFolders:string[]}}
 */
export function organizeRoms(config) {
  ensureWorkspaceDirs();

  const { moves, blocked } = planOrganize(config);
  const moved = [];
  const skipped = [...blocked];
  const createdFolders = [];

  for (const move of moves) {
    // Usually one file; a cue sheet brings its track files with it.
    const names = move.names?.length ? move.names : [move.name];
    const targetDir = path.join(romsRoot, move.folder);

    // All or nothing. A cue sheet whose tracks stayed behind is a broken game, so
    // one collision blocks the whole set rather than splitting it across folders.
    const clash = names.find((name) => fs.existsSync(path.join(targetDir, name)));
    if (clash) {
      skipped.push({ name: move.name, reason: `roms/${move.folder}/${clash} already exists.` });
      continue;
    }

    const done = [];
    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
        createdFolders.push(move.folder);
      }
      for (const name of names) {
        fs.renameSync(path.join(move.from, name), path.join(targetDir, name));
        done.push(name);
      }
      for (const name of names) {
        moved.push({
          name,
          folder: move.folder,
          fromFolder: move.fromFolder,
          platform: move.platform,
          // Only the file that was identified carries the reason why.
          evidence: name === move.name ? move.evidence || null : null,
          withCue: name === move.name ? null : move.name,
        });
      }
    } catch (err) {
      // Put back whatever already moved, so a failure halfway through a disc set
      // cannot leave the sheet and its tracks in different folders.
      for (const name of done) {
        try {
          fs.renameSync(path.join(targetDir, name), path.join(move.from, name));
        } catch { /* best effort — the error below is what gets reported */ }
      }
      skipped.push({ name: move.name, reason: err.message });
    }
  }

  return { moved, skipped, createdFolders };
}

/**
 * Folders sitting in roms/ that we do not recognise, so the UI can say
 * "roms/Dreamcast has games but no emulator can play them".
 */
export function strayRomFolders() {
  let entries;
  try {
    entries = fs.readdirSync(romsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      platform: platformForFolderName(entry.name),
      empty: isEmptyDir(path.join(romsRoot, entry.name)),
    }))
    .filter((row) => row.platform === null || !row.empty);
}

/**
 * The full tidy pass: file stray games, then bring folders and scan sources into
 * line with the result. Run before every scan, including the one at startup.
 *
 * `autoOrganize` gates the *automatic* filing only. Pass `force` when the user
 * asked for it directly — pressing "File them now" and having nothing happen
 * because a setting is off would be its own bug.
 *
 * The folder reconcile always runs either way: it only creates empty folders or
 * reclaims already-empty ones, so there is nothing there to opt out of.
 *
 * @returns {{moved:Array<object>, skipped:Array<object>, created:string[], removed:string[]}}
 */
export function tidyWorkspace(config, { force = false } = {}) {
  const organized =
    !force && config.settings?.autoOrganize === false
      ? { moved: [], skipped: [], createdFolders: [] }
      : organizeRoms(config);

  // Re-read: organising may have created folders and moved files, which changes
  // what reconcile should consider wanted.
  const folders = reconcileRomFolders(config);

  return {
    moved: organized.moved,
    skipped: organized.skipped,
    created: folders.created.map(folderNameFor),
    removed: folders.removed.map(folderNameFor),
  };
}

/** Human-readable summary for the Settings panel. */
export function workspaceSummary(config) {
  const playable = playablePlatformIds(config);
  return {
    romsRoot,
    emulatorsRoot,
    folders: playable
      .map((id) => ({
        platform: id,
        name: folderNameFor(id),
        path: toPortable(path.join(romsRoot, folderNameFor(id))),
        empty: isEmptyDir(path.join(romsRoot, folderNameFor(id))),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    strays: strayRomFolders().filter((s) => !playable.includes(s.platform)),
    loose: looseRomFiles(config),
    misfiled: misfiledRomFiles(),
  };
}
