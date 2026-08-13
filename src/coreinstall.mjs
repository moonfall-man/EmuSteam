// Downloading the in-app player, shared by the CLI and the app.
//
// This is the only code in EmuSteam that reaches the network, and it only runs
// when someone asks for it — `npm run fetch-cores`, or a Download button in the
// app. Both go through here so there is one implementation to trust rather than
// two that drift.
//
// Nothing about the URL comes from the caller. A platform id is checked against
// WASM_CORES and everything downloaded is built from constants in cores.mjs, so
// there is no path this can be talked into fetching something else.

import fs from 'node:fs';
import path from 'node:path';
import { coresRoot, CORE_CDN, RUNTIME_FILES, WASM_CORES, coreFilesFor } from './cores.mjs';

/**
 * A core that is present but truncated is worse than one that is absent: the
 * "is it installed" check is a file-exists test, so a half-written file makes a
 * system claim to be ready and then fail at load time with a bare network error.
 * Download to a sibling .part and rename only once the bytes are all there —
 * rename is atomic, so the real filename never exists in a partial state.
 */
async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('empty response');

  // A captive portal or a proxy answering 200 with an error page would otherwise
  // be written out as a core and fail much later, somewhere less obvious.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 0 && declared !== buf.length) {
    throw new Error(`truncated — got ${buf.length} of ${declared} bytes`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  fs.writeFileSync(part, buf);
  fs.renameSync(part, dest);
  return buf.length;
}

/**
 * Turn a request into a concrete list of platform ids.
 *
 * @param {'all'|'owned'|string[]} want
 * @param {{emulators?: Array<{platforms?: string[]}>}} config
 * @param {{games?: Array<{platform: string}>}} library
 */
export function resolvePlatforms(want, config = {}, library = {}) {
  if (want === 'all') return Object.keys(WASM_CORES);

  if (Array.isArray(want)) {
    // Unknown ids are dropped rather than throwing: the caller is a UI list, and
    // one stale entry should not fail the whole download.
    return [...new Set(want.map(String))].filter((p) => WASM_CORES[p]);
  }

  // 'owned' — whatever the library actually holds that can run in-app, plus the
  // systems any configured emulator covers.
  const inLibrary = (library.games || []).map((g) => g.platform);
  const fromEmulators = (config.emulators || []).flatMap((e) => e.platforms || []);
  const owned = [...new Set([...inLibrary, ...fromEmulators])].filter((p) => WASM_CORES[p]);
  if (owned.length) return owned;

  // Nothing scanned yet. A starter set beats downloading nothing and beats
  // downloading all 30 MB of it.
  return ['gb', 'gbc', 'gba', 'nes', 'snes', 'genesis'];
}

/**
 * What a download would actually fetch, without fetching it.
 *
 * @returns {{platforms: string[], cores: string[], files: Array<{rel:string,url:string,dest:string}>, present: number}}
 */
export function installPlan(platforms) {
  const valid = platforms.filter((p) => WASM_CORES[p]);
  // Several systems share one core — GB and GBC are both gambatte — so download
  // each core once rather than once per system.
  const cores = [...new Set(valid.map((p) => WASM_CORES[p].core))];

  const wanted = [...RUNTIME_FILES, ...cores.flatMap((core) => coreFilesFor(core))];

  const files = [];
  let present = 0;
  for (const rel of wanted) {
    const dest = path.join(coresRoot, rel);
    // Belt and braces: every rel here is a constant, and this proves it.
    if (!path.resolve(dest).startsWith(path.resolve(coresRoot) + path.sep)) continue;
    if (fs.existsSync(dest)) {
      present++;
      continue;
    }
    files.push({ rel, url: `${CORE_CDN}/${rel}`, dest });
  }

  return { platforms: valid, cores, files, present };
}

/**
 * Download the runtime and the cores for these systems.
 *
 * Individual failures are collected rather than thrown: one core failing should
 * not discard the nine that worked, and the caller needs to say which.
 *
 * @param {string[]} platforms
 * @param {{onProgress?: (p: object) => void}} opts
 */
export async function installCores(platforms, { onProgress = () => {} } = {}) {
  const plan = installPlan(platforms);
  const total = plan.files.length;

  onProgress({ phase: 'start', done: 0, total, platforms: plan.platforms, cores: plan.cores });

  let downloaded = 0;
  let bytes = 0;
  const failed = [];

  for (const [index, file] of plan.files.entries()) {
    const label = file.rel.replace(/^cores\//, '');
    onProgress({ phase: 'file', done: index, total, label });
    try {
      const size = await downloadFile(file.url, file.dest);
      bytes += size;
      downloaded++;
      onProgress({ phase: 'file-done', done: index + 1, total, label, bytes: size, error: null });
    } catch (err) {
      failed.push({ file: file.rel, message: err.message });
      onProgress({ phase: 'file-done', done: index + 1, total, label, bytes: 0, error: err.message });
    }
  }

  const result = { downloaded, bytes, failed, present: plan.present, total };
  onProgress({ phase: 'done', done: total, total, ...result });
  return result;
}
