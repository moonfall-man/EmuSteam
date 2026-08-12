// JSON-file persistence for config / library cache / play stats.
//
// Three files instead of one so a library rescan never risks the user's
// hand-entered emulator config, and so play stats survive both.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configFile, libraryFile, statsFile, ensureDataDirs } from './paths.mjs';

const CONFIG_VERSION = 1;

const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  sources: [],
  emulators: [],
  /** platformId -> emulatorId, the emulator used when you just press Play. */
  defaultEmulator: {},
  /** platformId -> libretro core basename, for RetroArch-style emulators. */
  cores: {},
  /** Extra folders searched for box art, e.g. an existing LaunchBox images dir. */
  artDirs: [],
  settings: {
    theme: 'midnight',
    sort: 'name',
    showHidden: false,
    scanOnStart: true,
    // File stray ROMs into their system folder automatically at every scan.
    autoOrganize: true,
    // In-app fast-forward multiplier. 0 means uncapped — the core runs as fast as
    // the machine allows, which the libretro API expresses as a ratio of 0.
    fastForwardRatio: 2.5,
    // How the fast-forward button behaves: 'toggle' (press on, press off),
    // 'hold' (only while held), or 'tap-or-hold' (tap locks, hold is momentary).
    fastForwardMode: 'tap-or-hold',
    confirmExit: true,
    clock: true,
    reduceMotion: false,
  },
};

const DEFAULT_LIBRARY = { version: 1, scannedAt: 0, games: [], warnings: [] };

export function newId(prefix = 'id') {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

/** Stable per-game id: same ROM path always yields the same id across rescans. */
export function gameId(platform, absPath) {
  const norm = path.resolve(absPath).replace(/\\/g, '/').toLowerCase();
  const hash = crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12);
  return `${platform}-${hash}`;
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(fallback);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[emusteam] ${path.basename(file)} was unreadable (${err.message}); starting from defaults.`);
      // Keep the broken file around instead of silently destroying user data.
      try {
        fs.renameSync(file, `${file}.broken-${Date.now()}`);
      } catch { /* nothing we can do */ }
    }
    return structuredClone(fallback);
  }
}

/** Write via temp file + rename so a crash mid-write can't truncate the real file. */
function writeJson(file, value) {
  ensureDataDirs();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- config

let configCache = null;

export function loadConfig() {
  if (configCache) return configCache;
  const raw = readJson(configFile, DEFAULT_CONFIG);
  configCache = migrateConfig(raw);
  return configCache;
}

export function saveConfig(next) {
  configCache = migrateConfig(next);
  writeJson(configFile, configCache);
  return configCache;
}

/** Mutate-and-persist helper: `updateConfig(c => { c.sources.push(...) })`. */
export function updateConfig(mutator) {
  const draft = structuredClone(loadConfig());
  mutator(draft);
  return saveConfig(draft);
}

function migrateConfig(raw) {
  const cfg = { ...structuredClone(DEFAULT_CONFIG), ...raw };
  cfg.version = CONFIG_VERSION;
  cfg.settings = { ...DEFAULT_CONFIG.settings, ...(raw.settings || {}) };
  cfg.sources = Array.isArray(cfg.sources) ? cfg.sources.filter((s) => s && s.path) : [];
  cfg.emulators = Array.isArray(cfg.emulators) ? cfg.emulators.filter((e) => e && e.exe) : [];
  cfg.artDirs = Array.isArray(cfg.artDirs) ? cfg.artDirs.filter(Boolean) : [];
  cfg.defaultEmulator = isPlainObject(cfg.defaultEmulator) ? cfg.defaultEmulator : {};
  cfg.cores = isPlainObject(cfg.cores) ? cfg.cores : {};

  for (const source of cfg.sources) {
    source.id ||= newId('src');
    source.platform ||= 'auto';
    source.recursive = source.recursive !== false;
    source.enabled = source.enabled !== false;
  }
  for (const emu of cfg.emulators) {
    emu.id ||= newId('emu');
    emu.name ||= path.basename(emu.exe);
    emu.args ||= '"{rom}"';
    emu.platforms = Array.isArray(emu.platforms) ? emu.platforms : [];
    emu.libretro = !!emu.libretro;
  }

  // Drop default-emulator assignments whose emulator no longer exists.
  const emuIds = new Set(cfg.emulators.map((e) => e.id));
  for (const key of Object.keys(cfg.defaultEmulator)) {
    if (!emuIds.has(cfg.defaultEmulator[key])) delete cfg.defaultEmulator[key];
  }

  return cfg;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// --------------------------------------------------------------- library

let libraryCache = null;

export function loadLibrary() {
  if (libraryCache) return libraryCache;
  const raw = readJson(libraryFile, DEFAULT_LIBRARY);
  libraryCache = {
    version: 1,
    scannedAt: Number(raw.scannedAt) || 0,
    games: Array.isArray(raw.games) ? raw.games : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
  return libraryCache;
}

export function saveLibrary(library) {
  libraryCache = library;
  writeJson(libraryFile, library);
  return library;
}

// ----------------------------------------------------------------- stats

let statsCache = null;

export function loadStats() {
  if (statsCache) return statsCache;
  statsCache = readJson(statsFile, {});
  return statsCache;
}

export function statsFor(id) {
  const stats = loadStats();
  return stats[id] || { playCount: 0, playSeconds: 0, lastPlayed: 0, favorite: false, hidden: false };
}

export function updateStats(id, mutator) {
  const stats = loadStats();
  const entry = { ...statsFor(id) };
  mutator(entry);
  stats[id] = entry;
  writeJson(statsFile, stats);
  return entry;
}
