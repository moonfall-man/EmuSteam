#!/usr/bin/env node
// Download the in-app player: the EmulatorJS runtime plus the WebAssembly cores
// for whichever systems you want to play without launching an emulator.
//
//   npm run fetch-cores              runtime + cores for the systems in your library
//   npm run fetch-cores -- gba snes  runtime + those systems specifically
//   npm run fetch-cores -- all       every core we know about (~30 MB)
//   npm run fetch-cores -- list      show what is available and what you have
//
// This is the only part of EmuSteam that touches the network, and it only runs
// when you ask it to. Everything lands in cores/ and is served from disk
// afterwards.

import fs from 'node:fs';
import path from 'node:path';
import {
  coresRoot, CORE_CDN, RUNTIME_FILES, WASM_CORES, installedCores, coreFilesFor,
} from '../src/cores.mjs';
import { loadConfig, loadLibrary } from '../src/store.mjs';
import { platformMeta } from '../src/platforms.mjs';

const args = process.argv.slice(2).map((a) => a.toLowerCase());

function bytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/** Which platforms to fetch cores for, from the args or from what you own. */
function wantedPlatforms() {
  if (args.includes('all')) return Object.keys(WASM_CORES);

  const named = args.filter((a) => a !== 'all' && a !== 'list' && WASM_CORES[a]);
  if (named.length) return named;

  // Default: whatever the library actually contains that can run in-app.
  const inLibrary = [...new Set(loadLibrary().games.map((g) => g.platform))];
  const fromEmulators = [...new Set((loadConfig().emulators || []).flatMap((e) => e.platforms))];
  const owned = [...new Set([...inLibrary, ...fromEmulators])].filter((p) => WASM_CORES[p]);

  if (owned.length) return owned;

  // Nothing scanned yet: a sensible starter set of the systems that run best.
  console.log('No library yet — fetching the cores that work best in-app.\n');
  return ['gb', 'gbc', 'gba', 'nes', 'snes', 'genesis'];
}

function showList() {
  const state = installedCores();
  console.log(`\nIn-app player: ${state.runtimeInstalled ? 'installed' : 'NOT installed'}`);
  console.log(`Folder: ${state.coresRoot}\n`);
  console.log('  system            core                      installed');
  console.log('  ' + '-'.repeat(58));
  for (const row of state.platforms) {
    console.log(
      `  ${platformMeta(row.platform).short.padEnd(16)}  ${row.core.padEnd(24)}  ${row.installed ? 'yes' : 'no'}`,
    );
  }
  console.log('\nFetch some with:  npm run fetch-cores -- gba snes\n');
}

async function main() {
  if (args.includes('list')) {
    showList();
    return;
  }

  const platforms = wantedPlatforms();
  // Several systems share a core; download each one once.
  const cores = [...new Set(platforms.map((p) => WASM_CORES[p].core))];

  console.log(`\nFetching the in-app player into ${coresRoot}`);
  console.log(`Systems: ${platforms.map((p) => platformMeta(p).short).join(', ')}`);
  console.log(`Cores:   ${cores.join(', ')}\n`);

  let total = 0;
  let failed = 0;

  for (const file of RUNTIME_FILES) {
    const dest = path.join(coresRoot, file);
    process.stdout.write(`  ${file.padEnd(34)} `);
    if (fs.existsSync(dest)) {
      console.log('already there');
      continue;
    }
    try {
      const size = await download(`${CORE_CDN}/${file}`, dest);
      total += size;
      console.log(bytes(size));
    } catch (err) {
      failed++;
      console.log(`FAILED — ${err.message}`);
    }
  }

  for (const core of cores) {
    for (const rel of coreFilesFor(core)) {
      const dest = path.join(coresRoot, rel);
      process.stdout.write(`  ${rel.replace('cores/', '').padEnd(34)} `);
      if (fs.existsSync(dest)) {
        console.log('already there');
        continue;
      }
      try {
        const size = await download(`${CORE_CDN}/${rel}`, dest);
        total += size;
        console.log(bytes(size));
      } catch (err) {
        failed++;
        console.log(`FAILED — ${err.message}`);
      }
    }
  }

  console.log(`\nDownloaded ${bytes(total)}${failed ? `, ${failed} failed` : ''}.`);
  if (!failed) {
    console.log('Restart EmuSteam and games for these systems get a "Play here" button.\n');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\nfetch-cores failed:', err.message);
  process.exit(1);
});
