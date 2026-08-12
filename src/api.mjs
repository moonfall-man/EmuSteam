// The JSON API the frontend talks to.
//
// Every handler is synchronous-ish and returns a plain object; the server
// module owns serialisation, status codes and auth. Keeping it that way means
// the whole API surface is readable in one sitting.

import path from 'node:path';
import fs from 'node:fs';
import { PLATFORMS, platformMeta, getPlatform } from './platforms.mjs';
import { PRESETS, findPreset } from './presets.mjs';
import {
  loadConfig, updateConfig, loadLibrary, saveLibrary,
  statsFor, updateStats, newId,
} from './store.mjs';
import { scanLibrary, scanLibraryAsync, guessPlatform } from './scanner.mjs';
import {
  launchGame, stopGame, currentSession, launcherEvents, previewCommand, resolveCore,
} from './launcher.mjs';
import { assignArt, clearArt, manualArtFor, manualArtIndex, isImagePath } from './art.mjs';
import {
  listDirectory, pickFolder, pickFile, nativeDialogsAvailable, defaultBrowseStart,
} from './filesystem.mjs';
import { fromPortable, toPortable, commonRomLocations, appRoot, dataRoot } from './paths.mjs';
import { emulatorsForPlatform, emulatorExists, isPlatformPlayable } from './emulators.mjs';
import { installedCores, wasmInfoFor, wasmCatalogue } from './cores.mjs';
import { playableDiscFile } from './discs.mjs';
import { fetchArtwork } from './artfetch.mjs';
import {
  reconcileRomFolders, workspaceSummary, discoverEmulators, tidyWorkspace, planOrganize,
  romsRoot, emulatorsRoot, folderNameFor,
} from './workspace.mjs';

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new ApiError(400, msg);
const notFound = (msg) => new ApiError(404, msg);

/**
 * Settings whose value must come from a fixed set. Without this the generic
 * string coercion in POST /api/settings would store any old text and the
 * consumer would quietly fall back to a default — worse than a clear rejection.
 */
const SETTING_CHOICES = {
  fastForwardMode: ['tap-or-hold', 'toggle', 'hold'],
  sort: ['name', 'recent', 'played', 'size'],
};

// ------------------------------------------------------------- DTO builders

/**
 * Library record + play stats + manual art override, shaped for the UI.
 *
 * `artPath` is a path, not a URL: an <img> cannot send our auth header, so the
 * frontend builds `/art?p=…&t=…` itself where it has the token to hand.
 */
/**
 * @param {object} game
 * @param {number} [suspendedAt] pass it in when mapping the whole library, so the
 *   states folder is read once rather than once per game.
 */
function gameDto(game, suspendedAt, manualArt) {
  const stats = statsFor(game.id);
  const suspended = suspendedAt === undefined ? suspendedAtFor(game.id) : suspendedAt;
  const manual = manualArt === undefined ? manualArtFor(game.id) : manualArt;
  const art = manual || game.art || null;
  return {
    id: game.id,
    platform: game.platform,
    title: game.title,
    sortKey: game.sortKey,
    file: game.file,
    ext: game.ext,
    size: game.size,
    region: game.region,
    regionFlag: game.regionFlag,
    revision: game.revision,
    version: game.version,
    languages: game.languages || [],
    quality: game.quality || [],
    discs: game.discs || null,
    discCount: game.discCount || 1,
    artPath: art,
    hasArt: !!art,
    artIsManual: !!manual,
    favorite: !!stats.favorite,
    hidden: !!stats.hidden,
    playCount: stats.playCount || 0,
    playSeconds: stats.playSeconds || 0,
    lastPlayed: stats.lastPlayed || 0,
    // A session left mid-play, waiting to be picked back up.
    suspended: !!suspended,
    suspendedAt: suspended || 0,
    // Why this particular game cannot run in-app, even on a system that can.
    // The system-level check says "PS1 works here"; this says "not *this* disc".
    // Without it the core boots with no content and shows its own menu, which
    // reads as EmuSteam having launched the wrong program entirely.
    inAppBlocked: inAppBlockReason(game),
  };
}

/** @returns {string|null} null when the in-app player can load this game. */
function inAppBlockReason(game) {
  if (String(game.ext || '').toLowerCase() !== '.cue') return null;
  try {
    return playableDiscFile(fromPortable(game.file)).reason;
  } catch {
    return null;
  }
}

function platformDto(platform, games, config, artIndex) {
  const meta = platformMeta(platform);
  const list = games.filter((g) => g.platform === platform);
  const emus = emulatorsForPlatform(platform, config);
  return {
    id: meta.id,
    name: meta.name,
    short: meta.short,
    maker: meta.maker,
    year: meta.year,
    tint: meta.tint,
    gameCount: list.length,
    // "Playable" means we could launch it this second — the program has to be
    // there, not merely configured. Anything looser makes Play a broken promise.
    playable: isPlatformPlayable(platform, config),
    romFolder: folderNameFor(platform),
    // Console icon, if fetch-art has downloaded one. A path rather than a URL for
    // the same reason game art is: an <img> cannot send the auth header.
    artPath: artIndex ? artIndex.get(`system-${platform}`) || null : null,
    // Can this system run inside the UI, and if not, why not.
    wasm: wasmInfoFor(platform),
    emulators: emus.map((e) => ({ id: e.id, name: e.name, exists: emulatorExists(e) })),
    defaultEmulator: config.defaultEmulator?.[platform] || emus[0]?.id || null,
    core: config.cores?.[platform] || meta.cores?.[0] || null,
    suggestedCores: meta.cores || [],
    needsCore: emus.some((e) => e.libretro),
  };
}

function emulatorDto(emu) {
  const abs = fromPortable(emu.exe);
  return {
    id: emu.id,
    name: emu.name,
    exe: emu.exe,
    absExe: abs,
    exists: emulatorExists(emu),
    args: emu.args,
    platforms: emu.platforms,
    libretro: !!emu.libretro,
  };
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function sourceDto(source) {
  const abs = fromPortable(source.path);
  return {
    id: source.id,
    path: source.path,
    absPath: abs,
    exists: safeExists(abs),
    platform: source.platform,
    platformName: source.platform === 'auto' ? 'Auto-detect' : platformMeta(source.platform).name,
    recursive: source.recursive !== false,
    enabled: source.enabled !== false,
    // Managed sources are the roms/<System>/ folders EmuSteam created itself.
    // The UI presents them differently and does not offer to delete them.
    managed: !!source.managed,
  };
}

// ------------------------------------------------------------ in-app player

/**
 * Resolve a game id to a ROM path for the in-app player.
 *
 * The page sends an id, never a path, so this endpoint cannot be talked into
 * reading an arbitrary file — the id has to match something the scanner found.
 * @returns {{ok:true, path:string} | {ok:false, reason:string}}
 */
export function resolveRomRequest(gameId, discFile) {
  const game = loadLibrary().games.find((g) => g.id === String(gameId || ''));
  if (!game) return { ok: false, reason: 'No such game.' };

  let target = game.file;
  if (discFile) {
    const disc = (game.discs || []).find((d) => d.file === discFile);
    if (!disc) return { ok: false, reason: 'That disc is not part of this game.' };
    target = disc.file;
  }

  const abs = fromPortable(target);
  if (!safeExists(abs)) return { ok: false, reason: 'The ROM file is missing.' };

  // Only the in-app player uses this route, and it can hold one file. A cue sheet
  // has to be resolved to the track it names or the core boots into its own menu
  // with no content -- see playableDiscFile for why.
  const playable = playableDiscFile(abs);
  if (!playable.path) return { ok: false, reason: playable.reason };
  return { ok: true, path: playable.path };
}

/**
 * The reserved slot holding a suspended session — the one written when you leave
 * a game and read back when you return, so play resumes mid-frame. Named rather
 * than numbered so it can never collide with a slot the player picks.
 */
const SUSPEND_SLOT = 'suspend';

/** One folder per game, keyed by a filesystem-safe form of the game id. */
const stateKey = (gameId) => String(gameId).replace(/[^a-z0-9-]/gi, '');

/** Where a game's in-app save states live. One folder per game keeps it tidy. */
function saveStateDir(gameId) {
  return path.join(dataRoot, 'states', stateKey(gameId));
}

const slotName = (raw) => String(raw ?? '0').replace(/[^0-9a-z]/gi, '') || '0';

/**
 * When each game was suspended, keyed by state-folder name.
 *
 * Built from one readdir rather than a stat per game: only games you have
 * actually played have a folder, so the cost tracks how much you have played
 * instead of how many ROMs you own.
 */
function suspendedMap() {
  const root = path.join(dataRoot, 'states');
  const out = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // nothing has been saved yet
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const stat = fs.statSync(path.join(root, entry.name, `${SUSPEND_SLOT}.state`));
      out.set(entry.name, stat.mtimeMs);
    } catch { /* played, but not left suspended */ }
  }
  return out;
}

/**
 * Resolve a save-state file for the binary /savestate route.
 *
 * Save states get their own route rather than riding the JSON control API. A
 * Game Boy state is 60 KB, but an N64 or DS state is several megabytes — and
 * base64 inside a JSON body inflates it by another third, then has to be parsed
 * as one enormous string. The control API's 1 MB body cap is deliberate and
 * stays; states simply do not belong behind it.
 *
 * @throws {ApiError} 404 if the game is not in the library.
 */
export function resolveSaveState(gameIdRaw, slotRaw) {
  const id = String(gameIdRaw || '');
  const game = loadLibrary().games.find((g) => g.id === id);
  if (!game) throw notFound('No such game. Try rescanning your library.');
  const slot = slotName(slotRaw);
  const dir = saveStateDir(game.id);
  return { gameId: game.id, slot, dir, file: path.join(dir, `${slot}.state`) };
}

function suspendedAtFor(gameId) {
  try {
    return fs.statSync(path.join(saveStateDir(gameId), `${SUSPEND_SLOT}.state`)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Artwork downloads triggered from the UI.
 *
 * Guarded to one at a time: the button is easy to press twice, and two runs would
 * fight over the same temp files and double the load on someone else's archive.
 */
let artRun = null;

// -------------------------------------------------------------- SSE plumbing

const sseClients = new Set();

export function addEventClient(res) {
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
}

export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

launcherEvents.on('started', (session) => broadcast('session', { running: true, session }));
launcherEvents.on('stopped', (info) => broadcast('session', { running: false, last: info }));

// ------------------------------------------------------------------- handlers

/**
 * Route + handle one API call.
 * @param {string} method
 * @param {URL} url
 * @param {any} body already-parsed JSON body (or null)
 * @returns {Promise<any>|any} JSON-serialisable result
 */
export async function handleApi(method, url, body) {
  const route = `${method} ${url.pathname}`;
  const config = loadConfig();

  switch (route) {
    // ---- read models -----------------------------------------------------
    case 'GET /api/state': {
      const library = loadLibrary();
      // Both of these read a directory once instead of once per game — the
      // difference is unnoticeable on a small library and seconds on a large one.
      const suspended = suspendedMap();
      const art = manualArtIndex();
      const games = library.games.map(
        (g) => gameDto(g, suspended.get(stateKey(g.id)) || 0, art.get(g.id) || null),
      );
      const present = [...new Set(games.map((g) => g.platform))];
      const platformList = PLATFORMS.filter((p) => present.includes(p.id)).map((p) =>
        platformDto(p.id, games, config, art),
      );
      // Platforms only present in the library because a config referenced them.
      for (const id of present) {
        if (!platformList.some((p) => p.id === id)) platformList.push(platformDto(id, games, config, art));
      }

      return {
        games,
        platforms: platformList,
        allPlatforms: PLATFORMS.map((p) => ({
          id: p.id, name: p.name, short: p.short, maker: p.maker, year: p.year,
          tint: p.tint, exts: p.exts, suggestedCores: p.cores,
        })),
        emulators: (config.emulators || []).map(emulatorDto),
        sources: (config.sources || []).map(sourceDto),
        settings: config.settings,
        cores: config.cores || {},
        artDirs: config.artDirs || [],
        session: currentSession(),
        scannedAt: library.scannedAt,
        warnings: library.warnings || [],
        workspace: workspaceSummary(config),
        // The full in-app catalogue, independent of what is in the library.
        inApp: (() => {
          const cat = wasmCatalogue();
          const named = (row) => {
            const meta = platformMeta(row.platform);
            return { ...row, name: meta.name, short: meta.short, maker: meta.maker };
          };
          return {
            ...cat,
            supported: cat.supported.map(named).sort((x, y) => x.name.localeCompare(y.name)),
            unsupported: cat.unsupported.map(named).sort((x, y) => x.name.localeCompare(y.name)),
          };
        })(),
        capabilities: {
          nativeDialogs: nativeDialogsAvailable(),
          platform: process.platform,
          appRoot,
          dataRoot,
          romsRoot,
          emulatorsRoot,
          suggestedRomFolders: commonRomLocations(),
        },
      };
    }

    case 'GET /api/session':
      return { session: currentSession() };

    // ---- library ---------------------------------------------------------
    case 'POST /api/scan': {
      const started = Date.now();
      broadcast('scan', { phase: 'start' });

      // Tidy before looking. Organising and scanning are the same operation from
      // the user's side — "work out what I have" — so they share one code path
      // and a rescan can never leave a game filed somewhere it won't be seen.
      const organized = tidyWorkspace(loadConfig());

      // Async so the event stream can actually deliver the progress it reports:
      // the sync scan blocks Node, which means nothing gets sent until it is over.
      const library = await scanLibraryAsync(loadConfig(), {
        onProgress: (p) => broadcast('scan', p),
      });
      saveLibrary(library);
      broadcast('scan', {
        phase: 'done',
        count: library.games.length,
        ms: Date.now() - started,
        warnings: library.warnings,
      });
      return {
        count: library.games.length,
        ms: Date.now() - started,
        warnings: library.warnings,
        scannedAt: library.scannedAt,
        organized,
      };
    }

    // ---- playing ---------------------------------------------------------
    case 'POST /api/launch': {
      const game = findGame(body?.gameId);
      const emulator = pickEmulator(game, body?.emulatorId, config);
      const discFile = body?.discFile ? String(body.discFile) : null;

      if (discFile) {
        const known = (game.discs || []).some((d) => d.file === discFile);
        if (!known) throw bad('That disc is not part of this game.');
      }

      const result = launchGame(game, emulator, { config, discFile });
      if (!result.ok) throw bad(result.error);
      return result;
    }

    case 'POST /api/stop': {
      const result = stopGame();
      if (!result.ok) throw bad(result.error);
      return result;
    }

    // ---- in-app player ---------------------------------------------------
    case 'GET /api/cores':
      return installedCores();

    case 'POST /api/state/save': {
      // The in-app player hands us a save state as base64; keep it on disk next
      // to everything else so it survives a browser cache wipe.
      const game = findGame(body?.gameId);
      const slot = slotName(body?.slot);
      const data = String(body?.data || '');
      if (!data) throw bad('No state data.');

      let buf;
      try {
        buf = Buffer.from(data, 'base64');
      } catch {
        throw bad('State data was not valid base64.');
      }
      if (!buf.length) throw bad('State data was empty.');

      const dir = saveStateDir(game.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${slot}.state`), buf);
      return { ok: true, slot, bytes: buf.length };
    }

    case 'GET /api/state/load': {
      const game = findGame(url.searchParams.get('gameId'));
      const slot = slotName(url.searchParams.get('slot'));
      const file = path.join(saveStateDir(game.id), `${slot}.state`);
      if (!safeExists(file)) throw notFound('No save state in that slot.');
      return { data: fs.readFileSync(file).toString('base64'), slot };
    }

    case 'POST /api/art/fetch': {
      if (artRun) throw bad('An artwork download is already running.');
      const library = loadLibrary();
      if (!library.games.length) throw bad('Nothing to fetch art for yet — scan your library first.');

      const only = ['all', 'games', 'systems'].includes(body?.only) ? body.only : 'all';
      const force = body?.force === true;

      artRun = fetchArtwork(library, {
        only,
        force,
        onProgress: (p) => broadcast('art', p),
      })
        .catch((err) => {
          broadcast('art', { phase: 'error', message: err.message });
          return { downloaded: 0, bytes: 0, missed: [], error: err.message };
        })
        .finally(() => { artRun = null; });

      // Returns immediately: a big library takes minutes, and the UI follows the
      // 'art' events rather than holding a request open that long.
      return { started: true, games: library.games.length, only, force };
    }

    case 'POST /api/state/clear': {
      // Only ever reached from an explicit "start over", and only for one named
      // slot at a time — never a wipe of a game's whole state folder.
      const game = findGame(body?.gameId);
      const slot = slotName(body?.slot);
      const file = path.join(saveStateDir(game.id), `${slot}.state`);
      const existed = safeExists(file);
      if (existed) fs.rmSync(file, { force: true });
      return { ok: true, slot, existed };
    }

    case 'GET /api/state/list': {
      const game = findGame(url.searchParams.get('gameId'));
      const dir = saveStateDir(game.id);
      let files = [];
      try {
        files = fs.readdirSync(dir).filter((f) => f.endsWith('.state'));
      } catch { /* none yet */ }
      return {
        slots: files.map((f) => {
          const stat = fs.statSync(path.join(dir, f));
          return { slot: path.basename(f, '.state'), bytes: stat.size, savedAt: stat.mtimeMs };
        }).sort((a, b) => a.slot.localeCompare(b.slot)),
      };
    }

    case 'POST /api/session/inapp': {
      // The in-app player reports its own start/stop so play time and the
      // "Continue playing" rail work the same as for a launched emulator.
      const game = findGame(body?.gameId);
      const phase = String(body?.phase || '');

      if (phase === 'start') {
        updateStats(game.id, (s) => {
          s.playCount += 1;
          s.lastPlayed = Date.now();
        });
        broadcast('session', { running: true, inApp: true, session: { gameId: game.id, title: game.title } });
        return { ok: true };
      }
      if (phase === 'stop') {
        const seconds = Math.max(0, Math.round(Number(body?.seconds) || 0));
        if (seconds >= 10) updateStats(game.id, (s) => { s.playSeconds += seconds; });
        broadcast('session', { running: false, inApp: true, last: { gameId: game.id, title: game.title, seconds } });
        return { ok: true, seconds };
      }
      throw bad('phase must be start or stop');
    }

    case 'POST /api/preview': {
      const game = findGame(body?.gameId);
      const emulator = pickEmulator(game, body?.emulatorId, config);
      return { command: previewCommand(game, emulator, config) };
    }

    // ---- per-game state --------------------------------------------------
    case 'POST /api/game/flag': {
      const game = findGame(body?.gameId);
      const field = String(body?.field || '');
      if (field !== 'favorite' && field !== 'hidden') throw bad('field must be favorite or hidden');
      const value = !!body?.value;
      updateStats(game.id, (s) => {
        s[field] = value;
      });
      return { game: gameDto(game) };
    }

    case 'POST /api/game/art': {
      const game = findGame(body?.gameId);
      const source = String(body?.path || '');
      if (!source) throw bad('path is required');
      if (!isImagePath(source)) throw bad('Pick a PNG, JPG or WEBP file.');
      const result = assignArt(game.id, source);
      if (!result.ok) throw bad(result.error);
      return { game: gameDto(game) };
    }

    case 'POST /api/game/art/clear': {
      const game = findGame(body?.gameId);
      clearArt(game.id);
      return { game: gameDto(game) };
    }

    case 'POST /api/game/forget': {
      // Remove a game whose file is gone, without a full rescan.
      const game = findGame(body?.gameId);
      const library = loadLibrary();
      library.games = library.games.filter((g) => g.id !== game.id);
      saveLibrary(library);
      clearArt(game.id);
      return { removed: game.id };
    }

    // ---- ROM folders -----------------------------------------------------
    case 'POST /api/sources/add': {
      const raw = String(body?.path || '').trim();
      if (!raw) throw bad('path is required');
      const abs = fromPortable(raw);
      if (!safeExists(abs)) throw bad(`That folder does not exist: ${abs}`);
      try {
        if (!fs.statSync(abs).isDirectory()) throw bad('That path is a file, not a folder.');
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw bad(`Could not read that folder: ${err.message}`);
      }

      const stored = toPortable(abs);
      const existing = (config.sources || []).find(
        (s) => fromPortable(s.path).toLowerCase() === abs.toLowerCase(),
      );
      if (existing) throw bad('That folder is already a source.');

      let platform = String(body?.platform || '').trim();
      if (!platform) platform = guessPlatform(abs);
      if (platform !== 'auto' && !getPlatform(platform)) throw bad(`Unknown platform: ${platform}`);

      const source = {
        id: newId('src'),
        path: stored,
        platform,
        recursive: body?.recursive !== false,
        enabled: true,
      };
      const next = updateConfig((c) => {
        c.sources.push(source);
      });
      return { source: sourceDto(source), sources: next.sources.map(sourceDto) };
    }

    case 'POST /api/sources/update': {
      const id = String(body?.id || '');
      const next = updateConfig((c) => {
        const source = c.sources.find((s) => s.id === id);
        if (!source) throw notFound('No such source');
        if (body.platform !== undefined) {
          const platform = String(body.platform);
          if (platform !== 'auto' && !getPlatform(platform)) throw bad(`Unknown platform: ${platform}`);
          source.platform = platform;
        }
        if (body.recursive !== undefined) source.recursive = !!body.recursive;
        if (body.enabled !== undefined) source.enabled = !!body.enabled;
      });
      return { sources: next.sources.map(sourceDto) };
    }

    case 'POST /api/sources/remove': {
      const id = String(body?.id || '');
      const next = updateConfig((c) => {
        c.sources = c.sources.filter((s) => s.id !== id);
      });
      return { sources: next.sources.map(sourceDto) };
    }

    case 'POST /api/sources/guess': {
      const abs = fromPortable(String(body?.path || ''));
      if (!safeExists(abs)) throw bad('That folder does not exist.');
      return { platform: guessPlatform(abs) };
    }

    // ---- emulators -------------------------------------------------------
    case 'POST /api/emulators/detect': {
      const exe = String(body?.exe || '').trim();
      if (!exe) throw bad('exe is required');
      const abs = fromPortable(exe);
      const preset = findPreset(abs);
      return {
        exists: safeExists(abs),
        absExe: abs,
        portable: toPortable(abs),
        preset: preset
          ? {
              name: preset.name,
              args: preset.args,
              libretro: !!preset.libretro,
              platforms: preset.libretro
                ? PLATFORMS.filter((p) => p.cores.length).map((p) => p.id)
                : preset.platforms || [],
              notes: preset.notes || null,
            }
          : null,
        suggestedName: preset?.name || path.basename(abs, path.extname(abs)),
      };
    }

    case 'POST /api/emulators/add': {
      const exe = String(body?.exe || '').trim();
      if (!exe) throw bad('exe is required');
      const abs = fromPortable(exe);
      if (!safeExists(abs)) throw bad(`That program does not exist: ${abs}`);

      const preset = findPreset(abs);
      const libretro = body?.libretro !== undefined ? !!body.libretro : !!preset?.libretro;
      // A libretro frontend gets no default systems on purpose. RetroArch can
      // technically run ~40 of them, and claiming all 40 would spray 40 empty
      // folders into roms/. Picking your systems is one extra click and makes
      // the folder listing mean something.
      const platforms = Array.isArray(body?.platforms)
        ? body.platforms.filter((p) => !!getPlatform(p))
        : libretro
          ? []
          : preset?.platforms || [];

      const emulator = {
        id: newId('emu'),
        name: String(body?.name || preset?.name || path.basename(abs, path.extname(abs))),
        exe: toPortable(abs),
        args: String(body?.args || preset?.args || '"{rom}"'),
        platforms,
        libretro,
      };

      const next = updateConfig((c) => {
        c.emulators.push(emulator);
        // First emulator for a platform becomes its default — no extra step needed.
        for (const platform of emulator.platforms) {
          if (!c.defaultEmulator[platform]) c.defaultEmulator[platform] = emulator.id;
        }
      });

      // Newly playable systems get their roms/<System>/ folder right now, so the
      // next thing the user does is drop files in rather than configure more.
      const workspace = reconcileRomFolders(next);

      return {
        emulator: emulatorDto(emulator),
        emulators: next.emulators.map(emulatorDto),
        workspace: {
          created: workspace.created.map((id) => folderNameFor(id)),
          removed: workspace.removed.map((id) => folderNameFor(id)),
        },
      };
    }

    case 'POST /api/emulators/update': {
      const id = String(body?.id || '');
      const next = updateConfig((c) => {
        const emu = c.emulators.find((e) => e.id === id);
        if (!emu) throw notFound('No such emulator');
        if (body.name !== undefined) emu.name = String(body.name);
        if (body.args !== undefined) emu.args = String(body.args);
        if (body.libretro !== undefined) emu.libretro = !!body.libretro;
        if (body.exe !== undefined) {
          const abs = fromPortable(String(body.exe));
          if (!safeExists(abs)) throw bad(`That program does not exist: ${abs}`);
          emu.exe = toPortable(abs);
        }
        if (Array.isArray(body.platforms)) {
          emu.platforms = body.platforms.filter((p) => !!getPlatform(p));
        }
      });
      const changed = reconcileRomFolders(next);
      return {
        emulators: next.emulators.map(emulatorDto),
        workspace: {
          created: changed.created.map(folderNameFor),
          removed: changed.removed.map(folderNameFor),
        },
      };
    }

    case 'POST /api/emulators/remove': {
      const id = String(body?.id || '');
      const next = updateConfig((c) => {
        c.emulators = c.emulators.filter((e) => e.id !== id);
        // Drop default assignments that pointed at it, so nothing dangles.
        for (const key of Object.keys(c.defaultEmulator)) {
          if (c.defaultEmulator[key] === id) delete c.defaultEmulator[key];
        }
      });
      const changed = reconcileRomFolders(next);
      return {
        emulators: next.emulators.map(emulatorDto),
        workspace: {
          created: changed.created.map(folderNameFor),
          removed: changed.removed.map(folderNameFor),
        },
      };
    }

    case 'POST /api/workspace/organize': {
      // Explicitly asked for, so it runs even with auto-organise switched off.
      const result = tidyWorkspace(config, { force: true });
      return { ...result, workspace: workspaceSummary(loadConfig()) };
    }

    case 'GET /api/workspace/plan':
      return planOrganize(config);

    case 'POST /api/workspace/reconcile': {
      const changed = reconcileRomFolders(config);
      return {
        created: changed.created.map(folderNameFor),
        removed: changed.removed.map(folderNameFor),
        workspace: workspaceSummary(loadConfig()),
      };
    }

    case 'GET /api/emulators/discover':
      return { candidates: discoverEmulators(config), emulatorsRoot };

    case 'GET /api/emulators/presets':
      return {
        presets: PRESETS.map((p) => ({
          name: p.name,
          args: p.args,
          libretro: !!p.libretro,
          platforms: p.platforms || [],
          notes: p.notes || null,
        })),
      };

    // ---- platform wiring -------------------------------------------------
    case 'POST /api/platform/emulator': {
      const platform = String(body?.platform || '');
      if (!getPlatform(platform)) throw bad(`Unknown platform: ${platform}`);
      const emulatorId = body?.emulatorId ? String(body.emulatorId) : null;
      const next = updateConfig((c) => {
        if (!emulatorId) delete c.defaultEmulator[platform];
        else {
          if (!c.emulators.some((e) => e.id === emulatorId)) throw notFound('No such emulator');
          c.defaultEmulator[platform] = emulatorId;
        }
      });
      return { defaultEmulator: next.defaultEmulator };
    }

    case 'POST /api/platform/core': {
      const platform = String(body?.platform || '');
      if (!getPlatform(platform)) throw bad(`Unknown platform: ${platform}`);
      const core = String(body?.core || '').trim();
      const next = updateConfig((c) => {
        if (!core) delete c.cores[platform];
        else c.cores[platform] = core;
      });
      return { cores: next.cores };
    }

    case 'POST /api/platform/core/check': {
      const platform = String(body?.platform || '');
      const emulatorId = String(body?.emulatorId || '');
      const emulator = (config.emulators || []).find((e) => e.id === emulatorId);
      if (!emulator) throw notFound('No such emulator');
      return resolveCore(emulator, platform, config);
    }

    // ---- settings --------------------------------------------------------
    case 'POST /api/settings': {
      const patch = body && typeof body === 'object' ? body : {};
      const next = updateConfig((c) => {
        for (const [key, value] of Object.entries(patch)) {
          if (!(key in c.settings)) continue;

          // Coerce to the shape of the existing value. Settings feed straight
          // into the emulator (the fast-forward ratio is handed to the core), so
          // a string where a number belongs must not get through.
          const current = c.settings[key];
          if (typeof current === 'boolean') {
            c.settings[key] = !!value;
          } else if (typeof current === 'number') {
            const num = Number(value);
            if (!Number.isFinite(num) || num < 0) throw bad(`${key} must be a number ≥ 0.`);
            c.settings[key] = num;
          } else {
            const text = String(value);
            const allowed = SETTING_CHOICES[key];
            if (allowed && !allowed.includes(text)) {
              throw bad(`${key} must be one of: ${allowed.join(', ')}`);
            }
            c.settings[key] = text;
          }
        }
      });
      return { settings: next.settings };
    }

    case 'POST /api/artdirs/add': {
      const abs = fromPortable(String(body?.path || ''));
      if (!safeExists(abs)) throw bad('That folder does not exist.');
      const next = updateConfig((c) => {
        const stored = toPortable(abs);
        if (!c.artDirs.includes(stored)) c.artDirs.push(stored);
      });
      return { artDirs: next.artDirs };
    }

    case 'POST /api/artdirs/remove': {
      const target = String(body?.path || '');
      const next = updateConfig((c) => {
        c.artDirs = c.artDirs.filter((d) => d !== target);
      });
      return { artDirs: next.artDirs };
    }

    // ---- path pickers ----------------------------------------------------
    case 'POST /api/browse': {
      const kind = String(body?.kind || 'any');
      const filters = {
        executable: (name) => /\.(exe|app|appimage|sh|bat|cmd)$/i.test(name),
        image: (name) => isImagePath(name),
        folders: () => false,
        any: () => true,
      };
      const start = body?.path !== undefined ? String(body.path) : defaultBrowseStart();
      return listDirectory(start, { filesFilter: filters[kind] || filters.any });
    }

    case 'POST /api/dialog': {
      if (!nativeDialogsAvailable()) throw bad('No native file dialog on this system.');
      const kind = String(body?.kind || 'folder');
      const initial = body?.initial ? fromPortable(String(body.initial)) : '';
      const title = body?.title ? String(body.title) : undefined;
      const chosen =
        kind === 'folder'
          ? pickFolder({ initial, title })
          : pickFile({ initial, title, kind: kind === 'image' ? 'image' : 'executable' });
      return { path: chosen, cancelled: !chosen };
    }

    default:
      throw notFound(`No API route for ${route}`);
  }

  // ---- local helpers ---------------------------------------------------
  function findGame(id) {
    const game = loadLibrary().games.find((g) => g.id === String(id || ''));
    if (!game) throw notFound('No such game. Try rescanning your library.');
    return game;
  }

  function pickEmulator(game, requestedId, cfg) {
    if (requestedId) {
      const emu = (cfg.emulators || []).find((e) => e.id === String(requestedId));
      if (!emu) throw notFound('No such emulator');
      return emu;
    }
    const options = emulatorsForPlatform(game.platform, cfg);
    if (!options.length) {
      throw bad(
        `No emulator is set up for ${platformMeta(game.platform).name}. Add one in Settings → Emulators.`,
      );
    }
    const defaultId = cfg.defaultEmulator?.[game.platform];
    return options.find((e) => e.id === defaultId) || options[0];
  }
}

export { ApiError };
