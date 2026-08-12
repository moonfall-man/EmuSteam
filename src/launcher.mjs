// Emulator process launching + play-session tracking.
//
// One game at a time, on purpose: this is a couch app, and a single session
// means the UI can show a clean "Now playing" state and record playtime by
// watching one exit event.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fromPortable } from './paths.mjs';
import { loadConfig, updateStats } from './store.mjs';
import { coreExtension } from './presets.mjs';
import { getPlatform } from './platforms.mjs';

export const launcherEvents = new EventEmitter();

/** @type {{game:object, emulator:object, child:import('node:child_process').ChildProcess, startedAt:number}|null} */
let session = null;

export function currentSession() {
  if (!session) return null;
  return {
    gameId: session.game.id,
    title: session.game.title,
    platform: session.game.platform,
    emulator: session.emulator.name,
    startedAt: session.startedAt,
    elapsedSeconds: Math.round((Date.now() - session.startedAt) / 1000),
    pid: session.child.pid,
  };
}

/**
 * Split an argument template into argv entries, honouring double quotes so
 * `-L "cores/my core.dll"` stays two arguments.
 */
export function tokenizeArgs(template) {
  const out = [];
  let current = '';
  let inQuotes = false;
  let has = false;

  for (const ch of String(template || '')) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      has = true;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (has) out.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
    has = true;
  }
  if (has) out.push(current);
  return out;
}

/** Replace {rom}-style tokens inside a single argv entry. */
function substitute(token, vars) {
  return token.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

/**
 * Work out the libretro core path for a platform.
 * Accepts either a bare core name ("mupen64plus_next_libretro") or a full path.
 */
export function resolveCore(emulator, platform, config = loadConfig()) {
  // Explicit config wins; otherwise fall back to the platform's first suggested core.
  const coreName = config.cores?.[platform] || getPlatform(platform)?.cores?.[0] || null;
  if (!coreName) return { path: null, error: `No libretro core set for ${platform}.` };

  if (coreName.includes('/') || coreName.includes('\\')) {
    const abs = fromPortable(coreName);
    return fs.existsSync(abs)
      ? { path: abs, error: null }
      : { path: abs, error: `Core not found at ${abs}` };
  }

  const ext = coreExtension();
  const base = coreName.endsWith(ext) ? coreName : coreName + ext;
  const exeDir = path.dirname(fromPortable(emulator.exe));
  const candidates = [
    path.join(exeDir, 'cores', base),
    path.join(exeDir, base),
    path.join(exeDir, '..', 'cores', base),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { path: candidate, error: null };
  }
  return {
    path: candidates[0],
    error: `Core "${base}" not found in ${path.join(exeDir, 'cores')}`,
  };
}

/**
 * Build the exact command that would run, without running it.
 * The settings UI shows this so a mis-typed template is obvious before launch.
 */
export function buildCommand(game, emulator, config = loadConfig(), discFile = null) {
  const exe = fromPortable(emulator.exe);
  const romPath = fromPortable(discFile || game.file);

  const vars = {
    rom: romPath,
    romDir: path.dirname(romPath),
    romFile: path.basename(romPath),
    romName: path.basename(romPath, path.extname(romPath)),
    platform: game.platform,
    core: '',
  };

  let coreError = null;
  if (emulator.libretro) {
    const core = resolveCore(emulator, game.platform, config);
    vars.core = core.path || '';
    coreError = core.error;
  }

  const args = tokenizeArgs(emulator.args).map((token) => substitute(token, vars));
  return { exe, args, cwd: path.dirname(exe), coreError, romPath, spawn: spawnPlanFor(exe, args) };
}

/**
 * Turn a logical (file, args) pair into something spawn() will actually accept.
 *
 * Node refuses to spawn .bat/.cmd directly on Windows (the BatBadBut fix), but
 * batch wrappers are common in emulation setups — people use them to pin a
 * config or a core. So we run cmd.exe ourselves and build the command line by
 * hand rather than reaching for `shell: true`, which would hand the ROM path to
 * a shell parser.
 *
 * Every token is double-quoted. Inside double quotes cmd does not treat & ^ | (
 * ) as special, and Windows filenames cannot contain a double quote, so there
 * is no way out of the quoting. (A literal % in a filename can still be eaten
 * by cmd's variable expansion — that fails the launch, it does not run
 * anything.) The whole line gets one extra surrounding pair because `cmd /s /c`
 * strips the outermost quotes before parsing.
 */
function spawnPlanFor(exe, args) {
  const isBatch = process.platform === 'win32' && /\.(bat|cmd)$/i.test(exe);
  if (!isBatch) return { file: exe, args, verbatim: false };

  const quote = (value) => `"${String(value).replace(/"/g, '')}"`;
  const line = `"${[exe, ...args].map(quote).join(' ')}"`;
  return {
    file: process.env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', line],
    verbatim: true,
  };
}

/** Human-readable preview of a launch command. */
export function previewCommand(game, emulator, config) {
  const { exe, args } = buildCommand(game, emulator, config);
  const quote = (s) => (/\s/.test(s) ? `"${s}"` : s);
  return [quote(exe), ...args.map(quote)].join(' ');
}

/**
 * Launch a game.
 * @returns {{ok:true, session:object} | {ok:false, error:string}}
 */
export function launchGame(game, emulator, { config = loadConfig(), discFile = null } = {}) {
  if (session) {
    return { ok: false, error: `${session.game.title} is already running. Close it first.` };
  }

  const { exe, cwd, coreError, romPath, spawn: plan } = buildCommand(game, emulator, config, discFile);

  if (!fs.existsSync(exe)) return { ok: false, error: `Emulator not found: ${exe}` };
  if (!fs.existsSync(romPath)) return { ok: false, error: `ROM file is missing: ${romPath}` };
  if (coreError) return { ok: false, error: coreError };

  let child;
  try {
    child = spawn(plan.file, plan.args, {
      cwd,
      // Emulators own the screen; we neither need nor want their stdio.
      stdio: 'ignore',
      windowsHide: false,
      detached: false,
      windowsVerbatimArguments: plan.verbatim,
    });
  } catch (err) {
    return { ok: false, error: `Could not start ${emulator.name}: ${err.message}` };
  }

  const startedAt = Date.now();
  session = { game, emulator, child, startedAt };

  child.on('error', (err) => {
    finishSession({ error: `${emulator.name} failed: ${err.message}` });
  });
  child.on('exit', (code, signal) => {
    finishSession({ code, signal });
  });

  updateStats(game.id, (s) => {
    s.playCount += 1;
    s.lastPlayed = startedAt;
  });

  launcherEvents.emit('started', currentSession());
  return { ok: true, session: currentSession() };
}

function finishSession({ code = null, signal = null, error = null } = {}) {
  if (!session) return;
  const { game, emulator, startedAt } = session;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  session = null;

  // Sub-10-second sessions are almost always a failed launch, not play time.
  if (seconds >= 10) {
    updateStats(game.id, (s) => {
      s.playSeconds += seconds;
    });
  }

  launcherEvents.emit('stopped', {
    gameId: game.id,
    title: game.title,
    emulator: emulator.name,
    seconds,
    code,
    signal,
    error,
  });
}

/** Ask the running emulator to close. Used by the "Stop" button in the overlay. */
export function stopGame() {
  if (!session) return { ok: false, error: 'Nothing is running.' };
  const { child } = session;
  try {
    if (process.platform === 'win32') {
      // SIGTERM is a no-op for most Windows GUI apps; taskkill /T gets the tree.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return { ok: true };
}

/** Kill any running emulator so the server can exit cleanly. */
export function shutdown() {
  if (session) stopGame();
}
