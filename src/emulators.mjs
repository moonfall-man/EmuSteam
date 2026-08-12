// "Can this system actually be played right now?"
//
// One module owns that question because three separate things ask it: the UI
// (to grey out a system), the workspace (to decide whether roms/<System>/
// should exist), and the launcher (to pick what runs a game). Answering it
// differently in three places is how a system ends up looking playable while
// the Play button fails.

import fs from 'node:fs';
import { fromPortable } from './paths.mjs';
import { getPlatform } from './platforms.mjs';
import { wasmAvailable, WASM_CORES } from './cores.mjs';

/** Does the emulator's program still exist on disk? */
export function emulatorExists(emulator) {
  try {
    return fs.existsSync(fromPortable(emulator.exe));
  } catch {
    return false;
  }
}

/**
 * Every emulator configured for a platform, whether or not its exe is present.
 * The default emulator sorts first. The UI wants the full list so it can show a
 * "Not found" badge instead of silently hiding a broken entry.
 */
export function emulatorsForPlatform(platform, config) {
  const defaultId = config.defaultEmulator?.[platform] || null;
  const matches = (config.emulators || []).filter((emulator) => {
    if (!emulator.platforms.includes(platform)) return false;
    // A libretro frontend additionally needs a core available for this platform.
    if (emulator.libretro) {
      return !!config.cores?.[platform] || (getPlatform(platform)?.cores?.length || 0) > 0;
    }
    return true;
  });
  matches.sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : 0));
  return matches;
}

/**
 * Can this system be played right now, by any means?
 *
 * Two independent answers count, because there are two ways to play:
 *   - an installed WebAssembly core, which runs the game inside the app;
 *   - an external emulator whose program is actually on disk.
 *
 * The in-app core is the reason this is not just about .exe files any more.
 * Downloading a core *is* acquiring an emulator — so a system with a core needs
 * no configuration at all, and must not be reported as unplayable.
 */
export function isPlatformPlayable(platform, config) {
  if (wasmAvailable(platform)) return true;
  return emulatorsForPlatform(platform, config).some(emulatorExists);
}

/** Every platform that can be played right now, from either source. */
export function playablePlatformIds(config) {
  const seen = new Set();

  // In-app cores first: these need nothing set up beyond the download.
  for (const platform of Object.keys(WASM_CORES)) {
    if (wasmAvailable(platform)) seen.add(platform);
  }

  for (const emulator of config.emulators || []) {
    if (!emulatorExists(emulator)) continue;
    for (const platform of emulator.platforms) {
      if (getPlatform(platform)) seen.add(platform);
    }
  }

  return [...seen];
}

/** How a platform is playable, so the UI can be specific rather than vague. */
export function playabilityOf(platform, config) {
  const inApp = wasmAvailable(platform);
  const external = emulatorsForPlatform(platform, config).filter(emulatorExists);
  return {
    playable: inApp || external.length > 0,
    inApp,
    external: external.map((e) => ({ id: e.id, name: e.name })),
  };
}
