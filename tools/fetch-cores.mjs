#!/usr/bin/env node
// Download the in-app player: the EmulatorJS runtime plus the WebAssembly cores
// for whichever systems you want to play without launching an emulator.
//
//   npm run fetch-cores              runtime + cores for the systems in your library
//   npm run fetch-cores -- gba snes  runtime + those systems specifically
//   npm run fetch-cores -- all       every core we know about (~30 MB)
//   npm run fetch-cores -- list      show what is available and what you have
//
// The app can do all of this from Settings → Play in the app, which is the
// friendlier route. This exists for setting a machine up before first launch, or
// scripting it. Both use the same downloader in src/coreinstall.mjs, so there is
// one implementation to trust rather than two that drift.

import {
  coresRoot, WASM_CORES, installedCores,
} from '../src/cores.mjs';
import { resolvePlatforms, installPlan, installCores } from '../src/coreinstall.mjs';
import { loadConfig, loadLibrary } from '../src/store.mjs';
import { platformMeta } from '../src/platforms.mjs';

const args = process.argv.slice(2).map((a) => a.toLowerCase());

function bytes(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
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

  const named = args.filter((a) => a !== 'all' && WASM_CORES[a]);
  const want = args.includes('all') ? 'all' : (named.length ? named : 'owned');
  const platforms = resolvePlatforms(want, loadConfig(), loadLibrary());

  if (want === 'owned' && !named.length) {
    const inLibrary = new Set(loadLibrary().games.map((g) => g.platform));
    if (!platforms.some((p) => inLibrary.has(p))) {
      console.log('No library yet — fetching the cores that work best in-app.\n');
    }
  }

  const plan = installPlan(platforms);
  console.log(`\nFetching the in-app player into ${coresRoot}`);
  console.log(`Systems: ${platforms.map((p) => platformMeta(p).short).join(', ')}`);
  console.log(`Cores:   ${plan.cores.join(', ')}\n`);

  if (!plan.files.length) {
    console.log('Everything is already there.\n');
    return;
  }

  const result = await installCores(platforms, {
    onProgress: (p) => {
      if (p.phase === 'file') process.stdout.write(`  ${p.label.padEnd(34)} `);
      if (p.phase === 'file-done') console.log(p.error ? `FAILED — ${p.error}` : bytes(p.bytes));
    },
  });

  console.log(
    `\nDownloaded ${bytes(result.bytes)}${result.failed.length ? `, ${result.failed.length} failed` : ''}.`,
  );
  if (!result.failed.length) {
    console.log('Restart EmuSteam and games for these systems get a "Play here" button.\n');
  }
  process.exit(result.failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nfetch-cores failed:', err.message);
  process.exit(1);
});
