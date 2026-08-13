// In-app emulation: libretro cores compiled to WebAssembly.
//
// This is the "play it right here" path. Instead of spawning an emulator and
// handing over the screen, the actual libretro core (mGBA, Snes9x, fceumm, …)
// runs inside the page as WebAssembly: core in a Web Worker, video to a canvas,
// audio through an AudioWorklet, input through the Gamepad API that the couch UI
// already speaks. No process launch, no window handoff, no two-second wait.
//
// The cores come from EmulatorJS, which packages the Emscripten builds. They are
// downloaded once by `npm run fetch-cores` and served from disk afterwards, so
// nothing reaches the network while you are actually using the app.
//
// Standalone emulators remain the better answer for the heavy systems — Dolphin,
// PCSX2, RPCS3, Cemu have no usable WASM story — so this sits alongside them
// rather than replacing them.

import fs from 'node:fs';
import path from 'node:path';
import { appRoot, dataRoot, workspaceRoot } from './paths.mjs';

/**
 * Where the assets come from, if you want to fetch them by hand.
 *
 * `EMUSTEAM_CORE_CDN` points it at a mirror — useful on a machine that cannot
 * reach the CDN, and what the test suite uses so a test run never depends on
 * the network or downloads anything real.
 */
export const CORE_CDN = process.env.EMUSTEAM_CORE_CDN || 'https://cdn.emulatorjs.org/stable/data';

/**
 * The EmulatorJS runtime.
 *
 * More than it looks, and every entry is load-bearing — the runtime fails with a
 * bare "Network Error" if any is missing:
 *
 *   loader.js / emulator.min.*   the player itself (the unminified src/*.js files
 *                                the loader falls back to are not published)
 *   compression/*                the `.data` cores are compressed archives, so
 *                                the decompressors are required to start at all
 *   localization/en-US.json      UI strings; absent, it errors rather than
 *                                falling back to the untranslated text
 */
export const RUNTIME_FILES = [
  'loader.js',
  'emulator.min.js',
  'emulator.min.css',
  'localization/en-US.json',
  'compression/extract7z.js',
  'compression/extractzip.js',
  'compression/libunrar.js',
  'compression/libunrar.wasm',
];

/**
 * Where the downloaded runtime lives.
 *
 * Under data/, not the library folder. These files are a download cache tied to
 * this install: fetched by `npm run fetch-cores`, re-fetchable at any time, and
 * matched to the app version rather than to anyone's game collection. Two
 * accounts sharing one ROM library still each want their own copy.
 *
 * They used to sit beside roms/ and emulators/, which meant pointing the library
 * at another drive silently moved the runtime with it and in-app play stopped
 * working — the cores were still on disk, just no longer where anything looked.
 * Installs from before the move keep working: a runtime found in either old spot
 * is used where it is rather than making anyone download 30 MB again.
 */
function resolveCoresRoot() {
  const preferred = path.join(dataRoot, 'cores');
  const complete = (root) => RUNTIME_FILES.every((f) => safeExists(path.join(root, f)));
  if (complete(preferred)) return preferred;

  // Only an install running on default paths inherits an older layout. Setting
  // EMUSTEAM_DATA or EMUSTEAM_WORKSPACE is a deliberate "put this install here",
  // and quietly reaching back into the app folder for someone else's runtime
  // would undo that — a test harness pointed at a temp folder would find the
  // real machine's cores and conclude the runtime is installed.
  if (process.env.EMUSTEAM_DATA || process.env.EMUSTEAM_WORKSPACE) return preferred;

  for (const legacy of [path.join(appRoot, 'cores'), path.join(workspaceRoot, 'cores')]) {
    if (legacy !== preferred && complete(legacy)) return legacy;
  }
  return preferred;
}

export const coresRoot = resolveCoresRoot();

/**
 * Per-core files. The runtime picks the variant at runtime:
 *
 *   `core + (threads ? "-thread" : "") + (webgl2 ? "" : "-legacy") + "-wasm.data"`
 *
 * so both the standard and `-legacy` builds are needed to cover machines without
 * WebGL2. `-thread` is skipped: threaded cores need SharedArrayBuffer, which
 * needs COOP/COEP headers we deliberately do not set.
 */
export const coreFilesFor = (core) => [
  `cores/reports/${core}.json`,
  `cores/${core}-wasm.data`,
  `cores/${core}-legacy-wasm.data`,
];

/**
 * platform id -> { system, core }
 *
 *   system  the value EmulatorJS wants in EJS_core
 *   core    the .data bundle that system loads, so we know what to download
 *
 * Only systems whose WASM core is genuinely usable are listed. Absence here
 * means "launch a real emulator for this one", which is the honest answer for
 * GameCube, Wii, PS2, Switch and friends.
 */
export const WASM_CORES = {
  nes:          { system: 'nes',    core: 'fceumm' },
  snes:         { system: 'snes',   core: 'snes9x' },
  gb:           { system: 'gb',     core: 'gambatte' },
  gbc:          { system: 'gb',     core: 'gambatte' },
  gba:          { system: 'gba',    core: 'mgba' },
  n64:          { system: 'n64',    core: 'mupen64plus_next' },
  nds:          { system: 'nds',    core: 'melonds' },
  genesis:      { system: 'segaMD', core: 'genesis_plus_gx' },
  segacd:       { system: 'segaCD', core: 'genesis_plus_gx' },
  sega32x:      { system: 'sega32x', core: 'picodrive' },
  mastersystem: { system: 'segaMS', core: 'genesis_plus_gx' },
  gamegear:     { system: 'segaGG', core: 'genesis_plus_gx' },
  psx:          { system: 'psx',    core: 'pcsx_rearmed' },
  pcengine:     { system: 'pce',    core: 'mednafen_pce' },
  pcenginecd:   { system: 'pce',    core: 'mednafen_pce' },
  ngp:          { system: 'ngp',    core: 'mednafen_ngp' },
  wonderswan:   { system: 'ws',     core: 'mednafen_wswan' },
  lynx:         { system: 'lynx',   core: 'handy' },
  arcade:       { system: 'arcade', core: 'fbneo' },
  neogeo:       { system: 'arcade', core: 'fbneo' },
  c64:          { system: 'c64',    core: 'vice_x64' },
  amiga:        { system: 'amiga',  core: 'puae' },
};

/** Systems that will never be worth running in WASM, with the reason. */
export const WASM_UNSUITABLE = {
  gamecube: 'Dolphin has no WASM build — use the standalone emulator.',
  wii: 'Dolphin has no WASM build — use the standalone emulator.',
  wiiu: 'Cemu is Windows-native only.',
  switch: 'No WASM emulator exists.',
  ps2: 'PCSX2 has no WASM build.',
  ps3: 'RPCS3 is native only.',
  psp: 'PPSSPP WASM is not packaged here.',
  psvita: 'Vita3K is native only.',
  '3ds': 'No usable WASM build.',
  saturn: 'No usable WASM build.',
  dreamcast: 'No usable WASM build here — Flycast WASM exists but is not packaged.',
};

export function coreForPlatform(platform) {
  return WASM_CORES[platform] || null;
}

/** Every per-core file present? A half-downloaded core fails at start time. */
function coreComplete(coreName) {
  return coreFilesFor(coreName).every((rel) => safeExists(path.join(coresRoot, rel)));
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Is the EmulatorJS runtime itself present? Without it nothing can run in-app. */
export function runtimeInstalled() {
  return RUNTIME_FILES.every((file) => safeExists(path.join(coresRoot, file)));
}

/** Is this platform playable in-app right now — runtime present and core downloaded? */
export function wasmAvailable(platform) {
  const entry = coreForPlatform(platform);
  if (!entry) return false;
  return runtimeInstalled() && coreComplete(entry.core);
}

/**
 * What the UI needs to start an in-app session for a platform.
 * @returns {{system:string, core:string, ready:boolean, reason:string|null}|null}
 */
export function wasmInfoFor(platform) {
  const entry = coreForPlatform(platform);
  if (!entry) {
    return {
      system: null,
      core: null,
      ready: false,
      reason: WASM_UNSUITABLE[platform] || 'No WebAssembly core for this system.',
    };
  }
  if (!runtimeInstalled()) {
    return { ...entry, ready: false, reason: 'The in-app player is not downloaded yet.' };
  }
  if (!coreComplete(entry.core)) {
    return { ...entry, ready: false, reason: `The ${entry.core} core is missing or incomplete.` };
  }
  return { ...entry, ready: true, reason: null };
}

/**
 * The complete in-app catalogue, always — every system we can run, whether or
 * not you own a game for it or have downloaded the core.
 *
 * Deliberately not filtered by your library: "what can this thing play?" is a
 * question you want answered *before* you go and find ROMs for something, and
 * a list that only shows what you already have cannot answer it.
 */
export function wasmCatalogue() {
  const supported = Object.entries(WASM_CORES).map(([platform, entry]) => ({
    platform,
    ...entry,
    installed: coreComplete(entry.core),
  }));

  return {
    runtimeInstalled: runtimeInstalled(),
    coresRoot,
    supported,
    // The honest other half: systems that need a real emulator, and why.
    unsupported: Object.entries(WASM_UNSUITABLE).map(([platform, reason]) => ({ platform, reason })),
  };
}

/** Everything installed, for the Settings panel. */
export function installedCores() {
  let files;
  try {
    files = fs.readdirSync(path.join(coresRoot, 'cores'));
  } catch {
    files = [];
  }
  const present = new Set(
    files.filter((f) => f.endsWith('-wasm.data')).map((f) => f.replace(/-wasm\.data$/, '')),
  );

  return {
    runtimeInstalled: runtimeInstalled(),
    coresRoot,
    cdn: CORE_CDN,
    installed: [...present].sort(),
    // Which of your systems could run in-app, and whether they can right now.
    platforms: Object.entries(WASM_CORES).map(([platform, entry]) => ({
      platform,
      ...entry,
      installed: present.has(entry.core),
    })),
  };
}
