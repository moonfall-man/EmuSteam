#!/usr/bin/env node
// EmuSteam entry point.
//
//   node src/main.mjs                 start + open the couch UI fullscreen
//   node src/main.mjs --no-fullscreen open in a normal window (nicer for setup)
//   node src/main.mjs --no-open       server only, connect from another device
//   node src/main.mjs --scan-only     rescan the library and exit
//   node src/main.mjs --port 7710     pin the port

import process from 'node:process';

// Say so plainly on an old Node. `engines` in package.json is advice that `node`
// itself ignores, so without this someone on an old runtime gets an error from
// deep inside a module, which reads as "this project is broken" rather than
// "update Node".
//
// Static imports are evaluated before this runs, so it catches a runtime that is
// merely too old rather than one that cannot parse the source at all. That covers
// the case people actually hit — a working but outdated Node.
const MIN_NODE = '20.6.0';
{
  const [maj, min, patch] = process.versions.node.split('.').map(Number);
  const [wantMaj, wantMin, wantPatch] = MIN_NODE.split('.').map(Number);
  const tooOld = maj < wantMaj
    || (maj === wantMaj && (min < wantMin || (min === wantMin && patch < wantPatch)));
  if (tooOld) {
    console.error(`EmuSteam needs Node ${MIN_NODE} or newer — this is ${process.versions.node}.`);
    console.error('Get it from https://nodejs.org, then run the same command again.');
    process.exit(1);
  }
}

import { ensureDataDirs, dataRoot, appRoot } from './paths.mjs';
import { ensureWorkspaceDirs, tidyWorkspace, romsRoot } from './workspace.mjs';
import { loadConfig, loadLibrary, saveLibrary } from './store.mjs';
import { scanLibrary, scanLibraryAsync } from './scanner.mjs';
import { createServer } from './server.mjs';
import { openAppWindow } from './openwindow.mjs';
import { broadcast } from './api.mjs';
import { currentSession, launcherEvents, shutdown as shutdownLauncher } from './launcher.mjs';

const PREFERRED_PORTS = [7710, 7711, 7712, 7713, 7714, 0];

function parseArgs(argv) {
  const opts = {
    open: true,
    fullscreen: true,
    scanOnly: false,
    host: '127.0.0.1',
    port: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--no-open': opts.open = false; break;
      case '--no-fullscreen': case '--windowed': opts.fullscreen = false; break;
      case '--scan-only': opts.scanOnly = true; opts.open = false; break;
      case '--port': opts.port = Number(argv[++i]); break;
      case '--host': opts.host = String(argv[++i]); break;
      case '-h': case '--help': opts.help = true; break;
      default:
        if (arg.startsWith('--port=')) opts.port = Number(arg.slice(7));
        else if (arg.startsWith('--host=')) opts.host = arg.slice(7);
        else console.warn(`[emusteam] ignoring unknown option: ${arg}`);
    }
  }
  return opts;
}

const HELP = `
EmuSteam — a couch launcher for your emulators

  node src/main.mjs [options]

  --no-fullscreen   open in a normal window instead of fullscreen
  --no-open         start the server without opening a window
  --scan-only       rescan the ROM library, print a summary, exit
  --port <n>        pin the HTTP port (default: first free from 7710)
  --host <addr>     bind address (default 127.0.0.1 — change only on a trusted LAN)
  -h, --help        this text
`;

/**
 * Say out loud what the tidy pass did. Moving someone's files silently is not
 * on, even when the move is the obviously right one.
 */
function reportTidy(tidied) {
  for (const move of tidied.moved) {
    const from = move.fromFolder ? `roms/${move.fromFolder}/` : 'roms/';
    console.log(`[emusteam] Filed "${move.name}"  ${from} -> roms/${move.folder}/`);
  }
  for (const skip of tidied.skipped) {
    console.log(`[emusteam] Left "${skip.name}" where it is — ${skip.reason}`);
  }
  for (const name of tidied.created) console.log(`[emusteam] Created roms/${name}`);
  for (const name of tidied.removed) console.log(`[emusteam] Reclaimed empty roms/${name}`);
}

function runScan(label = 'Scanning') {
  const config = loadConfig();
  if (!config.sources.length) return null;
  const started = Date.now();
  process.stdout.write(`[emusteam] ${label} ${config.sources.length} ROM folder(s)... `);
  const library = scanLibrary(config);
  saveLibrary(library);
  console.log(`${library.games.length} games in ${Date.now() - started}ms`);
  for (const warning of library.warnings) console.warn(`  ! ${warning}`);
  return library;
}

async function listenOnFirstFreePort(server, host, requestedPort) {
  const ports = requestedPort != null && !Number.isNaN(requestedPort) ? [requestedPort] : PREFERRED_PORTS;
  let lastError = null;

  for (const port of ports) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return server.address().port;
    } catch (err) {
      lastError = err;
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw lastError || new Error('Could not bind a port');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  ensureDataDirs();
  ensureWorkspaceDirs();

  // Tidy before anything reads the library. Anything you dropped loose into
  // roms/ gets filed, folders appear for systems that need one, and empty
  // folders for systems you can no longer play are reclaimed — so by the time
  // the window opens the layout already matches reality.
  reportTidy(tidyWorkspace(loadConfig()));

  const config = loadConfig();

  if (opts.scanOnly) {
    const library = runScan('Scanning');
    if (!library) {
      console.log('[emusteam] No ROM folders configured yet. Start the app and add one in Settings.');
    }
    return;
  }

  // A cold start used to scan *before* opening the window, so a large library
  // meant staring at nothing with no way to tell whether anything was happening.
  // The window now opens first and the scan reports progress into it — see
  // startColdScan below.
  const library = loadLibrary();
  const coldStart = library.games.length === 0 && config.sources.length > 0;

  const server = createServer();
  const port = await listenOnFirstFreePort(server, opts.host, opts.port);
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${port}/`;

  console.log('');
  console.log('  ███  EmuSteam');
  console.log(`       ${url}`);
  console.log(`       roms:  ${romsRoot}`);
  console.log(`       data:  ${dataRoot}`);
  console.log(`       app:   ${appRoot}`);
  console.log('');

  let closing = false;
  const quit = (code = 0) => {
    if (closing) return;
    closing = true;

    const finish = () => {
      server.close(() => process.exit(code));
      // Don't hang forever on a stuck keepalive connection.
      setTimeout(() => process.exit(code), 1500).unref();
    };

    // If a game is still running, stay alive long enough to record the session.
    if (currentSession()) {
      console.log('[emusteam] Window closed while a game is running — waiting for it to exit.');
      launcherEvents.once('stopped', finish);
      return;
    }
    finish();
  };

  if (opts.open) {
    const result = openAppWindow(url, {
      fullscreen: opts.fullscreen,
      onClose: () => quit(0),
      // The browser exited too quickly to have been a window — almost always
      // because another Chromium already owns this profile and took the URL. Keep
      // serving: shutting down here would kill the app behind a window that just
      // opened, which looks exactly like EmuSteam crashing on launch.
      onDetached: () => {
        console.log('[emusteam] The browser handed the page to an existing window.');
        console.log(`[emusteam] Still serving ${url} — press Ctrl+C to stop.`);
      },
    });
    if (result.mode === 'app') {
      console.log(`[emusteam] Window open via ${result.browser}`);
    } else if (result.mode === 'default') {
      console.log('[emusteam] No Chromium-based browser found — opened in your default browser.');
    } else {
      console.log(`[emusteam] Could not open a window. Browse to ${url} yourself.`);
    }
  } else {
    console.log('[emusteam] Server-only mode. Press Ctrl+C to stop.');
  }

  // Scan after the window is up, never before it.
  //
  // A cold start with thousands of ROMs takes real time, and the old order —
  // scan, then open — meant the user stared at nothing with no way to tell
  // whether anything was happening. Now the window opens immediately and the
  // scan streams its progress into it, which is also why it uses the async
  // driver: the synchronous one blocks Node, so nothing would be delivered
  // until it had already finished.
  if (config.settings.scanOnStart && config.sources.length) {
    setTimeout(async () => {
      const label = coldStart ? 'First scan of' : 'Background rescan of';
      const started = Date.now();
      const cfg = loadConfig();
      process.stdout.write(`[emusteam] ${label} ${cfg.sources.length} ROM folder(s)... `);
      broadcast('scan', { phase: 'start', cold: coldStart });

      reportTidy(tidyWorkspace(loadConfig()));
      const rescanned = await scanLibraryAsync(loadConfig(), {
        onProgress: (p) => broadcast('scan', p),
      });
      saveLibrary(rescanned);

      console.log(`${rescanned.games.length} games in ${Date.now() - started}ms`);
      for (const warning of rescanned.warnings) console.warn(`  ! ${warning}`);
      broadcast('scan', {
        phase: 'done',
        count: rescanned.games.length,
        ms: Date.now() - started,
        warnings: rescanned.warnings,
      });
      broadcast('library', { scannedAt: rescanned.scannedAt, count: rescanned.games.length });
    }, coldStart ? 120 : 800).unref();
  }

  process.on('SIGINT', () => {
    console.log('\n[emusteam] Shutting down.');
    shutdownLauncher();
    quit(0);
  });
  process.on('SIGTERM', () => quit(0));
}

main().catch((err) => {
  console.error('[emusteam] Fatal:', err);
  process.exit(1);
});
