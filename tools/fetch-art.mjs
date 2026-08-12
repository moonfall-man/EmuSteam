#!/usr/bin/env node
// Download box art for your games and icons for your consoles.
//
//   npm run fetch-art              # everything missing
//   npm run fetch-art -- systems   # just the console icons (a few KB each)
//   npm run fetch-art -- games     # just the box art
//   npm run fetch-art -- --force   # re-fetch even what is already there
//
// The same job is available in the app: Settings → ROM folders → Download
// artwork. Both run src/artfetch.mjs, so they cannot behave differently.
//
// This and fetch-cores are the only parts of EmuSteam that reach the network, and
// neither runs unless you ask.

import { loadLibrary } from '../src/store.mjs';
import { fetchArtwork, artRoot } from '../src/artfetch.mjs';

const args = process.argv.slice(2).map((a) => a.toLowerCase());
const force = args.includes('--force') || args.includes('-f');
const only = args.find((a) => a === 'games' || a === 'systems') || 'all';

const bytes = (n) =>
  n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

async function main() {
  const library = loadLibrary();
  if (!library.games.length) {
    console.log('No games in the library yet. Start EmuSteam once so it can scan, then run this again.');
    return;
  }

  const platforms = new Set(library.games.map((g) => g.platform));
  console.log(`Artwork into ${artRoot}`);
  console.log(`Library: ${library.games.length} game(s) across ${platforms.size} system(s)`);
  if (force) console.log('Mode:    --force, re-fetching everything');
  console.log('');

  const result = await fetchArtwork(library, {
    force,
    only,
    onProgress: (p) => {
      if (p.phase === 'start') {
        console.log(`Looking up ${p.systems} console icon(s) and ${p.games} game(s)…`);
        return;
      }
      if (p.phase !== 'working') return;
      const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
      // One line rewritten in place: this can run over thousands of games, and a
      // wall of output is harder to read than a counter.
      process.stdout.write(
        `\r  ${String(pct).padStart(3)}%  ${p.done}/${p.total}  ${String(p.label).slice(0, 46).padEnd(46)}`,
      );
    },
  });
  process.stdout.write('\n');

  console.log(`\nDownloaded ${result.downloaded} image(s), ${bytes(result.bytes)}.`);
  if (result.skipped) console.log(`${result.skipped} game(s) already had art.`);
  if (result.missed.length) {
    console.log(`\n${result.missed.length} without a match:`);
    for (const name of result.missed.slice(0, 25)) console.log(`  - ${name}`);
    if (result.missed.length > 25) console.log(`  … and ${result.missed.length - 25} more`);
    console.log('\nThe archive is indexed by No-Intro filename, so a renamed ROM often misses.');
    console.log('You can also assign art by hand: game page → More → Set artwork.');
  }
  console.log('\nRestart EmuSteam (or press Rescan) to see it.\n');
}

main().catch((err) => {
  console.error(`\nfetch-art failed: ${err.message}`);
  process.exit(1);
});
