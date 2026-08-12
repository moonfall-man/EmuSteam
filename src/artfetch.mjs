// Downloading artwork. One implementation, two front doors.
//
// `npm run fetch-art` and the "Download artwork" button in Settings run exactly
// this code, so the two can never drift — the same lesson as the scanner having
// one walk with two drivers.
//
// This is the one place the *app* reaches the network, and only while you are
// holding the button down, so to speak: it starts when asked and reports what it
// did. Nothing here runs on a timer or at startup.

import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './paths.mjs';
import { platformMeta } from './platforms.mjs';
import { artCandidates, boxartUrl, systemIconUrl, artSystemFor } from './thumbnails.mjs';

export const artRoot = path.join(dataRoot, 'art');

// Six at a time: enough to saturate a home connection, few enough to stay a
// polite guest on someone else's free archive.
const CONCURRENCY = 6;

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/** Does this game already have art on disk? */
export function existingArt(gameId) {
  for (const ext of IMAGE_EXTS) {
    const file = path.join(artRoot, `${gameId}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** @returns {Promise<number|null>} bytes written, or null when the URL had nothing. */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) return null;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Temp file + rename, so an interrupted run cannot leave a truncated image that
  // then looks like a successful download on the next pass.
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

/** Run `worker` over `items` with a fixed number of concurrent runners. */
async function pool(items, worker) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (index < items.length) await worker(items[index++]);
    }),
  );
}

/**
 * Fetch console icons and box art for a library.
 *
 * @param {{games:Array<object>}} library
 * @param {{force?:boolean, only?:'all'|'games'|'systems', onProgress?:(p:object)=>void,
 *          signal?:{aborted:boolean}}} opts
 * @returns {Promise<{downloaded:number, bytes:number, skipped:number, missed:string[],
 *                    games:number, systems:number, aborted:boolean}>}
 */
export async function fetchArtwork(library, opts = {}) {
  const { force = false, only = 'all', onProgress, signal } = opts;
  const games = library.games || [];
  const platforms = [...new Set(games.map((g) => g.platform))].sort();

  const systemJobs = only === 'games' ? [] : platforms.filter((id) => artSystemFor(id));
  const gameJobs = only === 'systems'
    ? []
    : (force ? games : games.filter((g) => !existingArt(g.id)));

  const result = {
    downloaded: 0,
    bytes: 0,
    skipped: games.length - gameJobs.length,
    missed: [],
    games: gameJobs.length,
    systems: systemJobs.length,
    aborted: false,
  };

  const total = systemJobs.length + gameJobs.length;
  let done = 0;
  const report = (label) => {
    done++;
    onProgress?.({
      phase: 'working', done, total, label,
      downloaded: result.downloaded, bytes: result.bytes,
    });
  };

  onProgress?.({ phase: 'start', total, systems: systemJobs.length, games: gameJobs.length });

  await pool(systemJobs, async (id) => {
    if (signal?.aborted) return;
    const dest = path.join(artRoot, `system-${id}.png`);
    const short = platformMeta(id).short;
    if (!force && fs.existsSync(dest)) return report(`${short} icon — already there`);
    try {
      const size = await download(systemIconUrl(id), dest);
      if (size) {
        result.downloaded++;
        result.bytes += size;
        report(`${short} icon`);
      } else {
        result.missed.push(`${platformMeta(id).name} (console icon)`);
        report(`${short} icon — not found`);
      }
    } catch (err) {
      result.missed.push(`${platformMeta(id).name} (console icon: ${err.message})`);
      report(`${short} icon — failed`);
    }
  });

  await pool(gameJobs, async (game) => {
    if (signal?.aborted) return;
    const dest = path.join(artRoot, `${game.id}.png`);
    // Candidates are ordered most-specific first: a looser name matching first
    // would fetch the wrong region's cover.
    for (const candidate of artCandidates(game)) {
      const url = boxartUrl(game.platform, candidate);
      if (!url) break; // no archive covers this system
      try {
        const size = await download(url, dest);
        if (size) {
          result.downloaded++;
          result.bytes += size;
          report(game.title);
          return;
        }
      } catch {
        // A hiccup on one spelling; try the next.
      }
    }
    result.missed.push(`${platformMeta(game.platform).short}: ${game.title}`);
    report(`${game.title} — no match`);
  });

  result.aborted = !!signal?.aborted;
  onProgress?.({ phase: 'done', ...result });
  return result;
}
