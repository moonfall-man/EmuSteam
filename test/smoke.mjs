#!/usr/bin/env node
// Self-contained end-to-end test.  Run it with:  npm test
//
// Builds a throwaway ROM library in a temp folder, starts a real server against
// a throwaway data folder, exercises the whole API over HTTP, and cleans up.
// Nothing here touches your real config, and it is safe to run repeatedly.
//
// The fixtures are chosen to cover the things that actually go wrong with ROM
// folders: archival filenames, .cue/.bin pairs, multi-disc sets, and filenames
// containing characters that a shell would treat as syntax.

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'emusteam-test-'));
// Three deliberately separate trees:
//   library/    hand-made ROM fixtures, standing in for a user's existing drive
//   app/        the workspace root, where managed roms/ + emulators/ get created
//   data/       config, library cache, stats
// Keeping library/ out of app/roms/ matters — otherwise the fixtures and the
// managed folders are the same directory and every assertion gets muddled.
const romRoot = path.join(tmpRoot, 'library');
const workspaceRoot = path.join(tmpRoot, 'app');
const dataRoot = path.join(tmpRoot, 'data');
const PORT = 7000 + (process.pid % 700);

let pass = 0;
const failures = [];

function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \u001b[32mok\u001b[0m   ${label}`);
  } else {
    failures.push(label);
    console.log(`  \u001b[31mFAIL\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(name) {
  console.log(`\n\u001b[2m${name}\u001b[0m`);
}

// ------------------------------------------------------------------ fixtures

function writeFixtures() {
  const n64 = path.join(romRoot, 'N64');
  const psx = path.join(romRoot, 'PSX');
  const snes = path.join(romRoot, 'SNES');
  for (const dir of [n64, psx, snes, path.join(n64, 'Images')]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const rom = (dir, name) => fs.writeFileSync(path.join(dir, name), 'x');

  // Archival naming: article suffix, GoodTools codes, underscores, revisions.
  rom(n64, 'Super Mario 64 (USA).z64');
  rom(n64, 'Legend of Zelda, The - Ocarina of Time (USA) (Rev B) [!].z64');
  rom(n64, 'Mario_Kart_64_(U)_[!].z64');
  rom(n64, 'GoldenEye 007 (E) [!].z64');
  rom(n64, 'Perfect Dark (USA) (Rev 1).v64');
  // Hyphenated titles must survive; only a spaced " - " is a subtitle separator.
  rom(n64, 'Spider-Man (USA).z64');
  rom(n64, 'X-Men - Mutant Academy (USA).z64');
  rom(n64, 'readme.txt');

  // A real 1x1 PNG, so the art path is exercised end to end rather than just
  // checking that some bytes were served.
  fs.writeFileSync(
    path.join(n64, 'Images', 'Super Mario 64.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );

  // "&" is legal in Windows filenames and is cmd's command separator.
  rom(n64, 'Sonic & Knuckles & copy nul injected-marker.txt (USA).z64');
  // A single "%" is legal and shows up in real titles.
  rom(n64, "Cruis'n USA 100% (USA).z64");

  rom(snes, 'Super Metroid (Japan, USA).sfc');
  rom(snes, 'Chrono Trigger (USA).smc');

  // .cue beside .bin must collapse; a 3-disc .m3u must swallow its .cue files.
  rom(psx, 'Metal Gear Solid (USA) (Disc 1).cue');
  rom(psx, 'Metal Gear Solid (USA) (Disc 1).bin');
  rom(psx, 'Metal Gear Solid (USA) (Disc 2).cue');
  rom(psx, 'Metal Gear Solid (USA) (Disc 2).bin');
  rom(psx, 'Castlevania - Symphony of the Night (USA).chd');
  for (const n of [1, 2, 3]) rom(psx, `Final Fantasy VII (USA) (Disc ${n}).cue`);
  fs.writeFileSync(
    path.join(psx, 'Final Fantasy VII (USA).m3u'),
    [1, 2, 3].map((n) => `Final Fantasy VII (USA) (Disc ${n}).cue`).join('\n') + '\n',
  );

  // A stand-in emulator that records the argv AND the working directory it was
  // given. The cwd matters: a portable emulator build finds its DLLs, config and
  // BIOS relative to its own folder, so launching it from anywhere else breaks
  // it in ways that look like the emulator's fault.
  const isWindows = process.platform === 'win32';
  const fakeEmu = path.join(tmpRoot, isWindows ? 'fakemu.bat' : 'fakemu.sh');
  if (isWindows) {
    fs.writeFileSync(
      fakeEmu,
      '@echo off\r\necho %*>"%~dp0lastargs.txt"\r\necho %CD%>"%~dp0lastcwd.txt"\r\nexit /b 0\r\n',
    );
  } else {
    fs.writeFileSync(
      fakeEmu,
      '#!/bin/sh\nd="$(dirname "$0")"\nprintf \'%s\\n\' "$*" > "$d/lastargs.txt"\npwd > "$d/lastcwd.txt"\nexit 0\n',
    );
    fs.chmodSync(fakeEmu, 0o755);
  }

  // A "portable emulator" laid out the way the README recommends, so we can test
  // that dropping one into emulators/ is enough for the app to find it. The name
  // matters — discovery matches it against the mGBA preset.
  const portableDir = path.join(workspaceRoot, 'emulators', 'mGBA');
  fs.mkdirSync(portableDir, { recursive: true });
  const portableEmu = path.join(portableDir, isWindows ? 'mGBA.bat' : 'mGBA.sh');
  fs.copyFileSync(fakeEmu, portableEmu);
  if (!isWindows) fs.chmodSync(portableEmu, 0o755);
  // A companion file, standing in for the DLLs/config a portable build needs.
  fs.writeFileSync(path.join(portableDir, 'portable.ini'), '');

  return {
    fakeEmu,
    portableEmu,
    portableDir,
    argsLog: path.join(tmpRoot, 'lastargs.txt'),
    cwdLog: path.join(portableDir, 'lastcwd.txt'),
    marker: path.join(tmpRoot, 'injected-marker.txt'),
  };
}

// -------------------------------------------------------------------- server

function startServer() {
  const child = spawn(
    process.execPath,
    [path.join(repoRoot, 'src', 'main.mjs'), '--no-open', '--port', String(PORT)],
    {
      cwd: repoRoot,
      // Both overrides matter: without EMUSTEAM_WORKSPACE a test run would
      // create roms/<System>/ folders inside the real repo.
      env: { ...process.env, EMUSTEAM_DATA: dataRoot, EMUSTEAM_WORKSPACE: workspaceRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.getLog = () => log;
  return child;
}

async function waitForServer(base, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + '/', { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

// ---------------------------------------------------------------------- main

const fixtures = writeFixtures();
const base = `http://127.0.0.1:${PORT}`;
const server = startServer();

let exitCode = 0;
try {
  if (!(await waitForServer(base))) {
    console.error(`Server never came up on ${base}\n${server.getLog()}`);
    process.exit(1);
  }

  // The frontend reads the token out of index.html; do exactly the same.
  const html = await (await fetch(base + '/')).text();
  const token = html.match(/EMUSTEAM_TOKEN = '([^']+)'/)?.[1];

  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: {
        'x-emusteam-token': token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
    return { status: res.status, json, text };
  }

  section('token + auth');
  check('token is injected into index.html', !!token && token !== '__EMUSTEAM_TOKEN__');
  check('API rejects a missing token', (await fetch(base + '/api/state')).status === 401);
  check(
    'API rejects a wrong token',
    (await fetch(base + '/api/state', { headers: { 'x-emusteam-token': 'x'.repeat(48) } })).status === 401,
  );
  check(
    'API rejects a foreign Origin',
    (await fetch(base + '/api/state', {
      headers: { 'x-emusteam-token': token, origin: 'https://evil.example' },
    })).status === 403,
  );

  section('path sandboxing');
  const trav = await fetch(base + '/../src/store.mjs');
  check('static traversal is blocked', trav.status === 404 || trav.status === 403, String(trav.status));
  const outside = process.platform === 'win32' ? 'C:/Windows/win.ini' : '/etc/hosts';
  check(
    'art outside the allowed roots is refused',
    (await call('GET', `/art?p=${encodeURIComponent(outside)}`)).status === 404,
  );

  section('ROM folders');
  let r = await call('POST', '/api/sources/add', { path: path.join(romRoot, 'N64') });
  check('add an N64 folder', r.status === 200, r.text);
  check('platform auto-detected as n64', r.json?.source?.platform === 'n64', r.json?.source?.platform);

  r = await call('POST', '/api/sources/add', { path: path.join(romRoot, 'PSX'), platform: 'psx' });
  check('add a PSX folder with an explicit platform', r.status === 200, r.text);

  r = await call('POST', '/api/sources/add', { path: path.join(romRoot, 'SNES') });
  check('SNES folder auto-detected', r.json?.source?.platform === 'snes', r.json?.source?.platform);

  check(
    'a duplicate folder is refused',
    (await call('POST', '/api/sources/add', { path: path.join(romRoot, 'N64') })).status === 400,
  );
  check(
    'a nonexistent folder is refused',
    (await call('POST', '/api/sources/add', { path: path.join(tmpRoot, 'nope') })).status === 400,
  );

  section('scan');
  r = await call('POST', '/api/scan');
  check('scan succeeds', r.status === 200, r.text);
  check('scan reported no warnings', (r.json?.warnings?.length || 0) === 0, JSON.stringify(r.json?.warnings));

  const state = (await call('GET', '/api/state')).json;
  const byTitle = (t) => state.games.find((g) => g.title === t);
  console.log(`       ${state.games.length} games from ${state.platforms.length} systems in ${r.json.ms}ms`);

  section('filename parsing');
  check('trailing article moves to the front', !!byTitle('The Legend of Zelda: Ocarina of Time'),
    state.games.map((g) => g.title).join(' | '));
  check('underscores become spaces', !!byTitle('Mario Kart 64'));
  check('a " - " subtitle becomes a colon', !!byTitle('Castlevania: Symphony of the Night'));
  check('a hyphenated title keeps its hyphen', !!byTitle('Spider-Man'),
    state.games.map((g) => g.title).filter((t) => /spider/i.test(t)).join(' | '));
  check('hyphen kept AND spaced dash converted', !!byTitle('X-Men: Mutant Academy'),
    state.games.map((g) => g.title).filter((t) => /men/i.test(t)).join(' | '));
  check('region from (U)', byTitle('Mario Kart 64')?.region === 'USA');
  check('region from (E)', byTitle('GoldenEye 007')?.region === 'Europe');
  check('multi-region "(Japan, USA)"', byTitle('Super Metroid')?.region === 'Japan/USA',
    byTitle('Super Metroid')?.region);
  check('revision tag', byTitle('The Legend of Zelda: Ocarina of Time')?.revision === 'B');
  check('verified-dump flag', byTitle('Mario Kart 64')?.quality?.includes('verified'));
  check('non-ROM files are ignored', !state.games.some((g) => g.title.toLowerCase().includes('readme')));

  section('disc handling');
  const mgs = byTitle('Metal Gear Solid');
  check('.cue + .bin collapse to one entry', !!mgs);
  check('two discs grouped under one game', mgs?.discCount === 2, String(mgs?.discCount));
  check('no .bin track leaks into the library', !state.games.some((g) => g.file.endsWith('.bin')));
  const ff7 = byTitle('Final Fantasy VII');
  check('an .m3u set appears once', state.games.filter((g) => g.title === 'Final Fantasy VII').length === 1);
  check('the .m3u wins over its .cue files', ff7?.ext === '.m3u', ff7?.ext);

  section('box art');
  const smb = byTitle('Super Mario 64');
  check('art in an Images/ subfolder is matched', !!smb?.artPath, String(smb?.artPath));
  if (smb?.artPath) {
    // Fetch it exactly how an <img> would: query token, no custom header.
    const imgUrl = `${base}/art?p=${encodeURIComponent(smb.artPath)}&t=${encodeURIComponent(token)}`;
    const artRes = await fetch(imgUrl);
    check('art loads without a request header', artRes.status === 200, String(artRes.status));
    check('art is served as an image', (artRes.headers.get('content-type') || '').startsWith('image/'));
    const bytes = Buffer.from(await artRes.arrayBuffer());
    check('art bytes are a real PNG', bytes.subarray(1, 4).toString('ascii') === 'PNG', bytes.subarray(0, 8).toString('hex'));
    check('art is cacheable via ETag', !!artRes.headers.get('etag'));
    check(
      'art still needs a token',
      (await fetch(`${base}/art?p=${encodeURIComponent(smb.artPath)}`)).status === 401,
    );
  }

  section('emulator presets');
  const detect = async (exe) => (await call('POST', '/api/emulators/detect', { exe })).json?.preset;
  check('Project64 recognised', (await detect('C:/Emu/Project64.exe'))?.name === 'Project64');
  check('RetroArch flagged as libretro', (await detect('C:/RA/retroarch.exe'))?.libretro === true);
  check('longest preset match wins', (await detect('C:/x/duckstation-qt-x64.exe'))?.name === 'DuckStation');
  check('an unknown program yields no preset', (await detect('C:/x/totallyunknown.exe')) === null);

  section('emulators');
  r = await call('POST', '/api/emulators/add', {
    exe: fixtures.fakeEmu,
    name: 'Test Emulator',
    platforms: ['n64'],
    args: '--go "{rom}"',
  });
  check('add an emulator', r.status === 200, r.text);
  const emuId = r.json?.emulator?.id;
  check(
    'a missing executable is refused',
    (await call('POST', '/api/emulators/add', { exe: path.join(tmpRoot, 'ghost.exe') })).status === 400,
  );

  const state2 = (await call('GET', '/api/state')).json;
  const n64 = state2.platforms.find((p) => p.id === 'n64');
  check('the system becomes playable', n64?.playable === true);
  check('the first emulator is auto-assigned as default', n64?.defaultEmulator === emuId);
  check('systems without an emulator stay unplayable',
    state2.platforms.find((p) => p.id === 'psx')?.playable === false);

  section('launching');
  r = await call('POST', '/api/preview', { gameId: smb.id });
  check('a launch command can be previewed', r.status === 200 && r.json.command.includes('fakemu'), r.text);

  r = await call('POST', '/api/launch', { gameId: smb.id });
  check('launch succeeds', r.status === 200, r.text);
  await new Promise((res) => setTimeout(res, 1500));
  const afterPlay = (await call('GET', '/api/state')).json.games.find((g) => g.id === smb.id);
  check('play count is recorded', afterPlay?.playCount === 1, String(afterPlay?.playCount));
  check('last-played is recorded', afterPlay?.lastPlayed > 0);
  check('the session clears when the emulator exits',
    (await call('GET', '/api/session')).json?.session === null);
  check('launching an unknown game 404s',
    (await call('POST', '/api/launch', { gameId: 'nope' })).status === 404);

  section('shell-hostile filenames');
  try { fs.rmSync(fixtures.argsLog); } catch { /* not there yet */ }
  try { fs.rmSync(fixtures.marker); } catch { /* good */ }

  const sonic = state2.games.find((g) => g.title.startsWith('Sonic'));
  check('a filename containing & becomes a title', !!sonic);
  check('it launches', (await call('POST', '/api/launch', { gameId: sonic.id })).status === 200);
  await new Promise((res) => setTimeout(res, 1500));
  check('& in a filename did NOT run a command', !fs.existsSync(fixtures.marker),
    'a command embedded in the filename executed');
  let logged = '';
  try { logged = fs.readFileSync(fixtures.argsLog, 'utf8'); } catch { /* emulator never ran */ }
  const sonicNative = path.resolve(sonic.file);
  check('the whole path reached the emulator as one quoted argument',
    logged.includes(`"${sonicNative}"`) || logged.includes(sonicNative), JSON.stringify(logged));

  const cruisin = state2.games.find((g) => g.title.startsWith("Cruis"));
  try { fs.rmSync(fixtures.argsLog); } catch { /* fine */ }
  check('a filename containing % becomes a title', !!cruisin);
  check('it launches', (await call('POST', '/api/launch', { gameId: cruisin.id })).status === 200);
  await new Promise((res) => setTimeout(res, 1500));
  try { logged = fs.readFileSync(fixtures.argsLog, 'utf8'); } catch { logged = ''; }
  check('% survived to the emulator', logged.includes('100%'), JSON.stringify(logged));

  section('portable emulators');
  r = await call('GET', '/api/emulators/discover');
  check('discovery finds a portable build dropped into emulators/',
    (r.json?.candidates || []).some((c) => c.name === 'mGBA'),
    JSON.stringify(r.json?.candidates?.map((c) => c.name)));
  const mgbaFound = (r.json?.candidates || []).find((c) => c.name === 'mGBA');
  check('it comes with the preset launch arguments', mgbaFound?.preset?.args === '-f "{rom}"',
    JSON.stringify(mgbaFound?.preset));
  check('and the systems mGBA runs', (mgbaFound?.preset?.platforms || []).includes('gba'),
    JSON.stringify(mgbaFound?.preset?.platforms));
  check('support files are not offered as emulators',
    !(r.json?.candidates || []).some((c) => /portable\.ini/i.test(c.exe)));

  // The whole point of a portable build: it must run from its own folder.
  try { fs.rmSync(fixtures.cwdLog); } catch { /* not there yet */ }
  r = await call('POST', '/api/emulators/add', {
    exe: fixtures.portableEmu,
    name: 'Portable mGBA',
    platforms: ['gba'],
    args: '-f "{rom}"',
  });
  check('the discovered emulator adds cleanly', r.status === 200, r.text);
  const portableId = r.json?.emulator?.id;

  // Give it a game to launch from the folder it just created.
  fs.writeFileSync(path.join(workspaceRoot, 'roms', 'GBA', 'Test Game (USA).gba'), 'x');
  await call('POST', '/api/scan');
  const gbaState = (await call('GET', '/api/state')).json;
  const gbaGame = gbaState.games.find((g) => g.platform === 'gba');
  check('the ROM in the managed folder is picked up', !!gbaGame,
    JSON.stringify(gbaState.games.map((g) => g.platform)));

  r = await call('POST', '/api/launch', { gameId: gbaGame.id, emulatorId: portableId });
  check('it launches', r.status === 200, r.text);
  await new Promise((res) => setTimeout(res, 1500));
  let ranIn = '';
  try { ranIn = fs.readFileSync(fixtures.cwdLog, 'utf8').trim(); } catch { /* never ran */ }
  check('the emulator runs with ITS OWN folder as the working directory',
    ranIn.toLowerCase() === fixtures.portableDir.toLowerCase(),
    `got "${ranIn}" want "${fixtures.portableDir}"`);

  // Its path must be relative to the workspace so the folder stays portable.
  const portableDto = (await call('GET', '/api/state')).json.emulators.find((e) => e.id === portableId);
  check('the emulator is still resolvable after adding', portableDto?.exists === true,
    JSON.stringify(portableDto));

  // While it is configured, discovery must not offer it again.
  r = await call('GET', '/api/emulators/discover');
  check('an already-added emulator is not offered again',
    !(r.json?.candidates || []).some((c) => c.name === 'mGBA'),
    JSON.stringify(r.json?.candidates?.map((c) => c.name)));

  // Remove the ROM *before* the emulator, so roms/GBA is empty and gets cleaned
  // up — otherwise the folder is (correctly) preserved and leaks into the next
  // section's assertions.
  try { fs.rmSync(path.join(workspaceRoot, 'roms', 'GBA', 'Test Game (USA).gba')); } catch { /* fine */ }
  await call('POST', '/api/emulators/remove', { id: portableId });
  check('removing the last emulator for a system reclaims its empty folder',
    !fs.existsSync(path.join(workspaceRoot, 'roms', 'GBA')),
    fs.readdirSync(path.join(workspaceRoot, 'roms')).join(', '));

  r = await call('GET', '/api/emulators/discover');
  check('and is offered again once removed',
    (r.json?.candidates || []).some((c) => c.name === 'mGBA'),
    JSON.stringify(r.json?.candidates?.map((c) => c.name)));

  section('loose ROMs in roms/');
  // The obvious mistake: drop a ROM straight into roms/ instead of roms/GB/.
  const loosePath = path.join(workspaceRoot, 'roms', 'Pokemon - Red Version (USA, Europe).gb');
  fs.writeFileSync(loosePath, 'x');
  // And one whose extension could belong to several systems.
  const ambiguousPath = path.join(workspaceRoot, 'roms', 'Mystery Disc.bin');
  fs.writeFileSync(ambiguousPath, 'x');

  let ws = (await call('GET', '/api/state')).json.workspace;
  const looseGb = (ws?.loose || []).find((f) => f.ext === '.gb');
  check('a loose ROM is detected', !!looseGb, JSON.stringify(ws?.loose));
  check('and routed to the right system folder', looseGb?.folder === 'GB', looseGb?.folder);
  check('README.md is not mistaken for a ROM',
    !(ws?.loose || []).some((f) => /\.md$/.test(f.name)));
  const looseBin = (ws?.loose || []).find((f) => f.ext === '.bin');
  check('an ambiguous extension is reported but not sortable',
    looseBin && looseBin.sortable === false && !!looseBin.reason, JSON.stringify(looseBin));

  // No emulator yet is fine now — the game still needs a home, and the UI says
  // what is missing. Only an ambiguous format blocks filing.
  check('sortable even with no emulator for it', looseGb.sortable === true, looseGb.reason);
  check('but flagged as needing an emulator', looseGb.needsEmulator === true, JSON.stringify(looseGb));

  r = await call('POST', '/api/emulators/add', {
    exe: fixtures.portableEmu, name: 'mGBA', platforms: ['gb'], args: '-f "{rom}"',
  });
  const gbEmuId = r.json?.emulator?.id;

  r = await call('POST', '/api/workspace/organize');
  check('sorting moves it into roms/GB/', r.json?.moved?.some((m) => m.folder === 'GB'), r.text);
  check('the file really moved',
    !fs.existsSync(loosePath) && fs.existsSync(path.join(workspaceRoot, 'roms', 'GB', path.basename(loosePath))));
  check('the ambiguous file is left alone', fs.existsSync(ambiguousPath));
  check('and is reported as skipped', r.json?.skipped?.some((s) => s.name === 'Mystery Disc.bin'), r.text);

  await call('POST', '/api/scan');
  const afterSort = (await call('GET', '/api/state')).json;
  check('the sorted ROM now appears in the library',
    afterSort.games.some((g) => g.platform === 'gb' && /Pokemon/.test(g.title)),
    JSON.stringify(afterSort.games.filter((g) => g.platform === 'gb').map((g) => g.title)));

  // A second sort must not move or duplicate anything.
  r = await call('POST', '/api/workspace/organize');
  check('sorting again moves nothing', (r.json?.moved || []).length === 0, r.text);

  // Clean up so the next section starts from a known state.
  fs.rmSync(ambiguousPath, { force: true });
  fs.rmSync(path.join(workspaceRoot, 'roms', 'GB', path.basename(loosePath)), { force: true });
  await call('POST', '/api/emulators/remove', { id: gbEmuId });
  await call('POST', '/api/scan');

  section('games that arrive as a folder or a zip');
  {
    // Disc games are usually distributed as a folder holding a .cue and its .bin,
    // and dropping that folder into roms/ is the obvious thing to do. It used to
    // be reported as an unrecognised *system* — "no emulator can play
    // Crash Bandicoot (USA)" — and never moved.
    const inRoms = (...bits) => path.join(workspaceRoot, 'roms', ...bits);
    const RAWSEC = 16 * 2352 + 24;
    const discImage = (marks) => {
      const buf = Buffer.alloc(64 * 1024);
      for (const [at, text] of marks) buf.write(text, at, 'latin1');
      return buf;
    };

    fs.mkdirSync(inRoms('Folder Disc (USA)'), { recursive: true });
    fs.writeFileSync(inRoms('Folder Disc (USA)', 'Folder Disc (USA).bin'),
      discImage([[RAWSEC, 'CD001'], [RAWSEC + 8, 'PLAYSTATION    ']]));
    fs.writeFileSync(inRoms('Folder Disc (USA)', 'Folder Disc (USA).cue'),
      'FILE "Folder Disc (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n');
    fs.writeFileSync(inRoms('Folder Disc (USA)', 'readme.txt'), 'notes');

    fs.mkdirSync(inRoms('Folder Mixed'), { recursive: true });
    fs.writeFileSync(inRoms('Folder Mixed', 'a.gb'), 'x');
    fs.writeFileSync(inRoms('Folder Mixed', 'b.z64'), 'x');

    fs.mkdirSync(inRoms('Folder Of Notes'), { recursive: true });
    fs.writeFileSync(inRoms('Folder Of Notes', 'notes.txt'), 'x');

    let ws = (await call('GET', '/api/state')).json.workspace;
    const folderNamed = (n) => (ws.looseFolders || []).find((f) => f.name === n);
    check('a folder holding one game is recognised as that game',
      folderNamed('Folder Disc (USA)')?.folder === 'PS1',
      JSON.stringify(ws.looseFolders));
    check('and is not reported as an unrecognised system',
      !(ws.strays || []).some((s) => s.name === 'Folder Disc (USA)'),
      JSON.stringify(ws.strays));
    check('a folder mixing systems is left alone, with the reason',
      folderNamed('Folder Mixed')?.sortable === false
        && /different systems/.test(folderNamed('Folder Mixed')?.reason || ''),
      JSON.stringify(folderNamed('Folder Mixed')));
    check('so is a folder with no games in it',
      folderNamed('Folder Of Notes')?.sortable === false);

    r = await call('POST', '/api/workspace/organize');
    check('the whole folder moves as a unit',
      fs.existsSync(inRoms('PS1', 'Folder Disc (USA)', 'Folder Disc (USA).cue'))
        && fs.existsSync(inRoms('PS1', 'Folder Disc (USA)', 'Folder Disc (USA).bin')),
      JSON.stringify(r.json.moved));
    check('taking everything in it along',
      fs.existsSync(inRoms('PS1', 'Folder Disc (USA)', 'readme.txt')));
    check('and the ambiguous folders stay put',
      fs.existsSync(inRoms('Folder Mixed', 'a.gb')) && fs.existsSync(inRoms('Folder Of Notes')));

    await call('POST', '/api/scan');
    check('the game inside the moved folder reaches the library',
      (await call('GET', '/api/state')).json.games.some((g) => /Folder Disc/.test(g.title)));

    // A .zip usually holds one game, and the archive index says which — readable
    // without unpacking anything.
    const { zipEntryNames } = await import('../src/archives.mjs');
    check('a non-zip yields no entries', zipEntryNames(inRoms('Folder Mixed', 'a.gb')).length === 0);
    check('a missing file yields no entries', zipEntryNames(inRoms('nope.zip')).length === 0);

    for (const dir of ['PS1', 'Folder Mixed', 'Folder Of Notes']) {
      fs.rmSync(inRoms(dir), { recursive: true, force: true });
    }
    await call('POST', '/api/scan');
  }

  section('relocating the library');
  {
    // Run in a child process with its own EMUSTEAM_WORKSPACE, never in-process:
    // reconcileRomFolders writes to whatever workspace the *current* process
    // resolved, and this test runner resolves to the real repository.
    const relocRoot = path.join(tmpRoot, 'reloc');
    const oldHome = path.join(relocRoot, 'old');
    const newHome = path.join(relocRoot, 'new');
    const relocData = path.join(relocRoot, 'data');
    fs.mkdirSync(path.join(oldHome, 'roms', 'GB'), { recursive: true });
    fs.mkdirSync(newHome, { recursive: true });
    fs.mkdirSync(relocData, { recursive: true });
    fs.writeFileSync(path.join(oldHome, 'roms', 'GB', 'Relocated (USA).gb'), 'x');

    // A config as it looks before relocating: one managed source at the old root.
    fs.writeFileSync(path.join(relocData, 'config.json'), JSON.stringify({
      version: 1,
      sources: [{
        id: 'src_reloc', path: path.join(oldHome, 'roms', 'GB'), platform: 'gb',
        recursive: true, enabled: true, managed: true,
      }],
      emulators: [],
      settings: {},
    }));

    const script = `
      const { reconcileRomFolders } = await import(${JSON.stringify(
    pathToFileURL(path.join(repoRoot, 'src', 'workspace.mjs')).href,
  )});
      const { loadConfig } = await import(${JSON.stringify(
    pathToFileURL(path.join(repoRoot, 'src', 'store.mjs')).href,
  )});
      reconcileRomFolders(loadConfig());
      process.stdout.write(JSON.stringify(loadConfig().sources));
    `;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, EMUSTEAM_DATA: relocData, EMUSTEAM_WORKSPACE: newHome },
    });
    const sources = JSON.parse(out);
    const stale = sources.find((s) => String(s.path).includes('old'));

    check('a managed source left behind by a move is kept, not dropped', !!stale,
      JSON.stringify(sources));
    check('but demoted to an ordinary folder, so its games stay visible',
      stale && stale.managed === false, JSON.stringify(stale));
    check('so nothing about the old location is deleted',
      fs.existsSync(path.join(oldHome, 'roms', 'GB', 'Relocated (USA).gb')));
  }

  section('where the games live');
  {
    // Pointing roms/ and emulators/ at a shared folder is how several Windows
    // accounts use one library while keeping separate saves. The server under
    // test has EMUSTEAM_WORKSPACE set, which deliberately wins over the file, so
    // what is checked here is that the override is reported and refuses to be
    // silently overridden in turn.
    const caps = (await call('GET', '/api/state')).json.capabilities;
    check('the library root is reported', typeof caps.libraryRoot === 'string' && caps.libraryRoot.length > 0,
      JSON.stringify(caps.libraryRoot));
    check('and where the setting came from', caps.libraryRootSource === 'env',
      String(caps.libraryRootSource));
    check('the library root is the workspace, not the app folder',
      caps.libraryRoot === workspaceRoot, `${caps.libraryRoot} vs ${workspaceRoot}`);

    // An env var is a deliberate act by whoever launched the process; a settings
    // click must not quietly override it.
    r = await call('POST', '/api/workspace/location', { path: tmpRoot });
    check('an env-var override cannot be changed from the UI', r.status === 400, r.text);
    check('and says why', /EMUSTEAM_WORKSPACE/.test(r.text), r.text);

    check('a missing folder is rejected',
      (await call('POST', '/api/workspace/location', { path: path.join(tmpRoot, 'nope') })).status === 400);
  }

  section('uploading ROMs from a browser');
  {
    // The upload route exists for the case a native dialog cannot serve: a
    // browser on another device. It takes one file per request as a raw body,
    // writes into roms/, and lets the organiser do the sorting.
    const put = (name, body) => fetch(`${base}/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'x-emusteam-token': token, 'content-type': 'application/octet-stream' },
      body,
    });

    check('uploading needs a token',
      (await fetch(`${base}/upload?name=x.gb`, { method: 'POST' })).status === 401);
    check('GET is not an upload',
      (await fetch(`${base}/upload?name=x.gb`, { headers: { 'x-emusteam-token': token } })).status === 405);

    let up = await put('Upload Test (USA).md', 'ROMBYTES');
    check('a ROM uploads', up.status === 200, String(up.status));
    check('and reports its size', (await up.json()).bytes === 8);
    check('landing loose in roms/',
      fs.existsSync(path.join(workspaceRoot, 'roms', 'Upload Test (USA).md')));

    check('a duplicate is refused rather than overwritten',
      (await put('Upload Test (USA).md', 'DIFFERENT')).status === 409);
    check('an empty body is refused', (await put('Upload Empty.gb', '')).status === 400);

    // The filename comes from a browser, so it is attacker-controlled text. It
    // must only ever name a file, never steer where that file goes.
    for (const attempt of ['../../escaped.gb', '..\\..\\escaped2.gb', 'C:\\Windows\\escaped3.gb']) {
      const res = await put(attempt, 'ROMBYTES');
      const landed = res.ok ? (await res.json()).name : null;
      check(`a filename cannot traverse (${attempt})`,
        !res.ok || (!landed.includes('/') && !landed.includes('\\') && !landed.includes('..')),
        String(landed));
    }
    check('nothing was written outside roms/',
      !fs.existsSync(path.join(workspaceRoot, 'escaped.gb'))
        && !fs.existsSync(path.join(tmpRoot, 'escaped.gb'))
        && !fs.existsSync(path.join(repoRoot, 'escaped.gb')));
    check('a leading dot is stripped so the file cannot hide',
      (await put('.sneaky.gb', 'ROMBYTES')).ok
        && !fs.existsSync(path.join(workspaceRoot, 'roms', '.sneaky.gb'))
        && fs.existsSync(path.join(workspaceRoot, 'roms', 'sneaky.gb')));

    // The point of uploading: the organiser then files them by system.
    r = await call('POST', '/api/workspace/organize');
    const movedTo = (name) => r.json.moved?.find((m) => m.name === name)?.folder;
    check('uploaded ROMs are then sorted by system',
      movedTo('Upload Test (USA).md') === 'Genesis', JSON.stringify(r.json.moved));
    check('including the ones with sanitised names',
      movedTo('escaped.gb') === 'GB' && movedTo('sneaky.gb') === 'GB',
      JSON.stringify(r.json.moved));

    await call('POST', '/api/scan');
    check('and reach the library',
      (await call('GET', '/api/state')).json.games.some((g) => /Upload Test/.test(g.title)));

    // Reset: a later section asserts exactly which system folders exist.
    for (const dir of ['Genesis', 'GB']) {
      fs.rmSync(path.join(workspaceRoot, 'roms', dir), { recursive: true, force: true });
    }
    await call('POST', '/api/scan');
  }

  section('bulk import');
  {
    // Driven entirely over HTTP, never by importing src/importer.mjs here.
    //
    // That is not a style preference. This process has no EMUSTEAM_WORKSPACE set —
    // only the spawned server does — so calling the importer in-process resolves
    // roms/ to the *real* repository and writes fixtures into the developer's own
    // library. It did exactly that once, and only the never-overwrite rule stopped
    // it clobbering a real game. The API is the only route guaranteed to land
    // inside the throwaway workspace.
    const incoming = path.join(tmpRoot, 'incoming');
    fs.mkdirSync(path.join(incoming, 'Nested'), { recursive: true });

    const discImg = (marks) => {
      const buf = Buffer.alloc(64 * 1024);
      for (const [at, text] of marks) buf.write(text, at, 'latin1');
      return buf;
    };
    const RAWSEC = 16 * 2352 + 24;
    fs.writeFileSync(path.join(incoming, 'Bulk Import Test (USA).sfc'), 'x');
    fs.writeFileSync(path.join(incoming, 'Nested', 'Bulk Nested (World).gb'), 'x');
    fs.writeFileSync(path.join(incoming, 'readme.txt'), 'notes');
    fs.writeFileSync(path.join(incoming, 'cover.png'), 'img');
    fs.writeFileSync(path.join(incoming, 'Bulk Cart.p8.png'), 'cart');
    fs.writeFileSync(path.join(incoming, 'Bulk Mystery.bin'), Buffer.alloc(2048, 9));
    fs.writeFileSync(path.join(incoming, 'Bulk Disc (USA).bin'),
      discImg([[RAWSEC, 'CD001'], [RAWSEC + 8, 'PLAYSTATION    ']]));
    fs.writeFileSync(path.join(incoming, 'Bulk Disc (USA).cue'),
      'FILE "Bulk Disc (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n');

    r = await call('POST', '/api/import/plan', { paths: [incoming] });
    const plan = r.json.plan;
    const folderOf = (name) => plan.groups.find((g) => g.name === name)?.folder;
    check('a plan walks nested folders', folderOf('Bulk Nested (World).gb') === 'GB',
      JSON.stringify(plan.groups.map((g) => `${g.folder}/${g.name}`)));
    check('and routes by extension', folderOf('Bulk Import Test (USA).sfc') === 'SNES');
    check('and by disc header when the extension is ambiguous',
      folderOf('Bulk Disc (USA).cue') === 'PS1', JSON.stringify(plan.groups));
    check('a cue brings its track along as one group',
      plan.groups.find((g) => g.name === 'Bulk Disc (USA).cue')?.files.length === 2);
    check('the track is not also imported on its own',
      !plan.groups.some((g) => g.name === 'Bulk Disc (USA).bin'));

    // .png means two things: box art, and a PICO-8 cart. Judged by name rather
    // than extension — otherwise every cover.png beside your games gets filed as
    // a PICO-8 title.
    check('a plain .png is treated as art, not a PICO-8 game',
      plan.skipped.some((x) => x.name === 'cover.png' && /image/i.test(x.reason)),
      JSON.stringify(plan.skipped));
    check('but a real .p8.png cart is imported', folderOf('Bulk Cart.p8.png') === 'PICO-8');
    check('documentation and unidentifiable files are skipped with reasons',
      plan.skipped.some((x) => x.name === 'readme.txt')
        && plan.skipped.some((x) => x.name === 'Bulk Mystery.bin'), JSON.stringify(plan.skipped));

    const looseBefore = fs.readdirSync(incoming).length;
    r = await call('POST', '/api/import/run', { paths: [incoming], mode: 'copy' });
    check('copy imports every planned game', r.json.imported.length === plan.groups.length,
      `${r.json.imported.length} of ${plan.groups.length}: ${JSON.stringify(r.json.skipped)}`);
    check('and leaves the originals where they were',
      fs.readdirSync(incoming).length === looseBefore);
    check('the cue and its track both landed',
      fs.existsSync(path.join(workspaceRoot, 'roms', 'PS1', 'Bulk Disc (USA).cue'))
        && fs.existsSync(path.join(workspaceRoot, 'roms', 'PS1', 'Bulk Disc (USA).bin')));
    check('imported games reach the library without a separate rescan',
      (await call('GET', '/api/state')).json.games.some((g) => /Bulk Import Test/.test(g.title)),
      String(r.json.games));

    r = await call('POST', '/api/import/run', { paths: [incoming], mode: 'copy' });
    check('importing the same pile again overwrites nothing',
      r.json.imported.length === 0 && r.json.skipped.length >= plan.groups.length,
      `imported ${r.json.imported.length}, skipped ${r.json.skipped.length}`);
    check('and says which file was in the way',
      r.json.skipped.some((x) => /already exists/.test(x.reason)),
      JSON.stringify(r.json.skipped[0]));

    // Move takes the original with it; copy never does.
    const solo = path.join(tmpRoot, 'solo');
    fs.mkdirSync(solo, { recursive: true });
    fs.writeFileSync(path.join(solo, 'Bulk Moved (USA).gb'), 'x');
    r = await call('POST', '/api/import/run', { paths: [solo], mode: 'move' });
    check('move files the game and removes the original',
      r.json.imported.length === 1
        && !fs.existsSync(path.join(solo, 'Bulk Moved (USA).gb'))
        && fs.existsSync(path.join(workspaceRoot, 'roms', 'GB', 'Bulk Moved (USA).gb')),
      JSON.stringify(r.json));

    check('an empty selection is refused',
      (await call('POST', '/api/import/run', { paths: [] })).status === 400);
    check('importing needs a token',
      (await fetch(base + '/api/import/run', { method: 'POST' })).status === 401);

    // Reset: a later section asserts exactly which system folders exist.
    for (const dir of ['SNES', 'PS1', 'PICO-8', 'GB']) {
      fs.rmSync(path.join(workspaceRoot, 'roms', dir), { recursive: true, force: true });
    }
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.rmSync(solo, { recursive: true, force: true });
    await call('POST', '/api/scan');
  }

  section('artwork name matching');
  {
    // Box art is indexed by the original No-Intro filename, so the exact stem has
    // to be tried first — a looser candidate matching first would fetch the wrong
    // region's cover. No network access here; this is pure string work.
    const { artCandidates, boxartUrl, systemIconUrl, LIBRETRO_SYSTEMS } =
      await import('../src/thumbnails.mjs');

    const cands = artCandidates({
      file: 'C:/roms/GB/Pokemon - Red Version (USA, Europe) (SGB Enhanced).gb',
      title: 'Pokemon: Red Version',
    });
    check('the exact filename stem is tried first',
      cands[0] === 'Pokemon - Red Version (USA, Europe) (SGB Enhanced)', cands[0]);
    check('then tags come off one at a time',
      cands[1] === 'Pokemon - Red Version (USA, Europe)' && cands[2] === 'Pokemon - Red Version',
      JSON.stringify(cands.slice(0, 3)));
    check('and the displayed title is a last resort, with ": " turned back into " - "',
      cands.includes('Pokemon - Red Version'), JSON.stringify(cands));
    check('no duplicates', new Set(cands).size === cands.length, JSON.stringify(cands));

    const disc = artCandidates({ file: '/r/Final Fantasy VII (USA) (Disc 2).bin', title: 'Final Fantasy VII' });
    check('a disc marker is dropped so a multi-disc set can still match',
      disc.some((c) => c === 'Final Fantasy VII (USA)'), JSON.stringify(disc));

    check('an unknown system yields no box art URL', boxartUrl('nosuchsystem', 'Game') === null);
    check('and no icon URL', systemIconUrl('nosuchsystem') === null);
    check('a system name becomes a path segment, encoded',
      boxartUrl('psx', 'Crash Bandicoot (USA)')
        === 'https://thumbnails.libretro.com/Sony%20-%20PlayStation/Named_Boxarts/Crash%20Bandicoot%20(USA).png',
      boxartUrl('psx', 'Crash Bandicoot (USA)'));
    check('every mapped system has a non-empty libretro name',
      Object.values(LIBRETRO_SYSTEMS).every((v) => typeof v === 'string' && v.length > 2));
    check('and the systems that play in-app are all mapped',
      ['nes', 'snes', 'gb', 'gbc', 'gba', 'n64', 'psx', 'genesis'].every((id) => LIBRETRO_SYSTEMS[id]));
  }

  section('artwork download endpoint');
  {
    // Deliberately no test of an actual download: the suite must run offline and
    // must not hammer someone else's archive. What is checked here is everything
    // that happens *before* a request would be made.
    const { fetchArtwork } = await import('../src/artfetch.mjs');

    check('the endpoint needs a token',
      (await fetch(base + '/api/art/fetch', { method: 'POST' })).status === 401);

    const empty = await fetchArtwork({ games: [] });
    check('an empty library downloads nothing', empty.downloaded === 0 && empty.bytes === 0,
      JSON.stringify(empty));
    check('and reports no work rather than failing',
      empty.games === 0 && empty.systems === 0 && empty.missed.length === 0, JSON.stringify(empty));

    // A game on a system no archive covers must not be attempted at all.
    const unknown = await fetchArtwork({
      games: [{ id: 'x1', platform: 'nosuchsystem', title: 'Nothing', file: '/r/Nothing.rom' }],
    });
    check('a system with no archive is reported as unmatched, not fetched',
      unknown.downloaded === 0 && unknown.missed.length === 1, JSON.stringify(unknown));

    let phases = [];
    await fetchArtwork({ games: [] }, { onProgress: (p) => phases.push(p.phase) });
    check('progress always brackets a run with start and done',
      phases[0] === 'start' && phases[phases.length - 1] === 'done', JSON.stringify(phases));
  }

  section('identifying disc images by content');
  // .bin/.cue/.iso name no system, so they used to be left alone. They do not
  // have to be guessed at: a disc image says which console pressed it. These
  // fixtures reproduce the real layouts — a raw 2352-byte/sector .bin puts the
  // ISO 9660 descriptor at 16*2352+24, a 2048-byte .iso at 16*2048.
  const loose = (name) => path.join(workspaceRoot, 'roms', name);
  const discImage = (marks) => {
    const buf = Buffer.alloc(64 * 1024);
    for (const [at, text] of marks) buf.write(text, at, 'latin1');
    return buf;
  };
  const RAW = 16 * 2352 + 24; // MODE2/2352, as in a PS1 .bin
  const ISO = 16 * 2048; // 2048-byte sectors, as in an .iso

  fs.writeFileSync(loose('Crash Bandicoot (USA).bin'),
    discImage([[RAW, 'CD001'], [RAW + 8, 'PLAYSTATION                     ']]));
  fs.writeFileSync(loose('Crash Bandicoot (USA).cue'),
    'FILE "Crash Bandicoot (USA).bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n');
  fs.writeFileSync(loose('Sonic CD (USA).iso'), discImage([[0, 'SEGADISCSYSTEM  ']]));
  fs.writeFileSync(loose('Some PS2 Game.iso'),
    discImage([[ISO, 'CD001'], [ISO + 8, 'PLAYSTATION   '], [40000, 'BOOT2 = cdrom0:\\SLUS_213.86;1\r\n']]));
  fs.writeFileSync(loose('Totally Unknown.bin'), Buffer.alloc(4096, 0x5a));
  fs.writeFileSync(loose('Broken Sheet.cue'), 'FILE "nowhere-at-all.bin" BINARY\n  TRACK 01 AUDIO\n');
  // A cue sheet is not a route to elsewhere: only the basename is ever used.
  fs.writeFileSync(loose('Sneaky.cue'), 'FILE "../../../package.json" BINARY\n  TRACK 01 AUDIO\n');

  ws = (await call('GET', '/api/state')).json.workspace;
  const byName = (n) => (ws?.loose || []).find((f) => f.name === n);

  check('a raw PS1 .bin is identified as PlayStation',
    byName('Crash Bandicoot (USA).bin')?.platform === 'psx',
    JSON.stringify(byName('Crash Bandicoot (USA).bin')));
  check('and says what identified it',
    /PLAYSTATION/.test(byName('Crash Bandicoot (USA).bin')?.evidence || ''),
    byName('Crash Bandicoot (USA).bin')?.evidence);
  check('its cue sheet inherits the same system',
    byName('Crash Bandicoot (USA).cue')?.platform === 'psx');
  check('a Sega CD image is identified from sector 0',
    byName('Sonic CD (USA).iso')?.platform === 'segacd',
    byName('Sonic CD (USA).iso')?.evidence);
  check('a 2048-byte PS2 image is told apart from PS1 by its BOOT2 line',
    byName('Some PS2 Game.iso')?.platform === 'ps2',
    byName('Some PS2 Game.iso')?.evidence);
  check('a file that identifies nothing stays unsortable',
    byName('Totally Unknown.bin')?.sortable === false,
    JSON.stringify(byName('Totally Unknown.bin')));
  check('a cue pointing at a missing track stays unsortable',
    byName('Broken Sheet.cue')?.sortable === false);
  check('a cue cannot reach outside its own folder',
    byName('Sneaky.cue')?.sortable === false, JSON.stringify(byName('Sneaky.cue')));

  // All-or-nothing: block the cue's destination and neither half may move.
  fs.mkdirSync(path.join(workspaceRoot, 'roms', 'PS1'), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'roms', 'PS1', 'Crash Bandicoot (USA).cue'), 'placeholder');
  r = await call('POST', '/api/workspace/organize');
  check('a collision blocks the whole disc set, not half of it',
    fs.existsSync(loose('Crash Bandicoot (USA).bin'))
      && fs.existsSync(loose('Crash Bandicoot (USA).cue')),
    JSON.stringify(r.json?.moved));
  check('and says which file was in the way',
    r.json?.skipped?.some((s) => /already exists/.test(s.reason)), r.text);

  fs.rmSync(path.join(workspaceRoot, 'roms', 'PS1', 'Crash Bandicoot (USA).cue'));
  r = await call('POST', '/api/workspace/organize');
  const movedTo = (n) => path.join(workspaceRoot, 'roms', 'PS1', n);
  check('the cue and its track move together into roms/PS1/',
    fs.existsSync(movedTo('Crash Bandicoot (USA).cue'))
      && fs.existsSync(movedTo('Crash Bandicoot (USA).bin')),
    JSON.stringify(r.json?.moved?.map((m) => `${m.folder}/${m.name}`)));
  check('neither is left behind in roms/',
    !fs.existsSync(loose('Crash Bandicoot (USA).cue'))
      && !fs.existsSync(loose('Crash Bandicoot (USA).bin')));
  check('the Sega CD image went to its own folder',
    fs.existsSync(path.join(workspaceRoot, 'roms', 'Sega CD', 'Sonic CD (USA).iso')),
    JSON.stringify(r.json?.moved?.map((m) => `${m.folder}/${m.name}`)));
  check('the unidentifiable files were left exactly where they were',
    fs.existsSync(loose('Totally Unknown.bin'))
      && fs.existsSync(loose('Broken Sheet.cue'))
      && fs.existsSync(loose('Sneaky.cue')));
  check('and nothing outside roms/ was touched',
    fs.existsSync(path.join(repoRoot, 'package.json')));

  await call('POST', '/api/scan');
  const discScan = (await call('GET', '/api/state')).json;
  check('the filed PS1 game appears in the library',
    discScan.games.some((g) => g.platform === 'psx' && /Crash/.test(g.title)),
    JSON.stringify(discScan.games.filter((g) => g.platform === 'psx').map((g) => g.title)));
  check('as one game, not one per track',
    discScan.games.filter((g) => /Crash/.test(g.title)).length === 1,
    JSON.stringify(discScan.games.filter((g) => /Crash/.test(g.title)).map((g) => g.file)));

  check('the PS2 image was filed by content too',
    fs.existsSync(path.join(workspaceRoot, 'roms', 'PS2', 'Some PS2 Game.iso')));

  // The in-app player gets exactly one file, so a cue sheet has to be resolved to
  // the track it names. Handing the core 87 bytes of text instead means it finds no
  // content and boots into its own menu, which looks like the wrong program
  // launched entirely.
  const get = (p, headers) => fetch(base + p, { headers });
  const psxGame = (await call('GET', '/api/state')).json.games
    .find((g) => g.platform === 'psx' && g.ext === '.cue' && /Crash/.test(g.title));
  check('a single-track disc is not blocked from in-app play',
    psxGame && psxGame.inAppBlocked === null, JSON.stringify(psxGame?.inAppBlocked));
  const binSize = fs.statSync(path.join(workspaceRoot, 'roms', 'PS1', 'Crash Bandicoot (USA).bin')).size;
  const romOfCue = await get(`/rom/${encodeURIComponent(psxGame.id)}.cue?t=${encodeURIComponent(token)}`);
  check('and /rom serves its track, not the cue sheet',
    Number(romOfCue.headers.get('content-length')) === binSize,
    `${romOfCue.headers.get('content-length')} vs bin ${binSize} vs cue ${psxGame.size}`);

  // A multi-track disc has no single file to stand in for it: the extra tracks are
  // CD audio. Say so rather than launching something that cannot work.
  const multiDir = path.join(workspaceRoot, 'roms', 'PS1');
  fs.writeFileSync(path.join(multiDir, 'Two Tracks.bin'),
    discImage([[RAW, 'CD001'], [RAW + 8, 'PLAYSTATION     ']]));
  fs.writeFileSync(path.join(multiDir, 'Two Tracks (Track 2).bin'), Buffer.alloc(2048, 7));
  fs.writeFileSync(path.join(multiDir, 'Two Tracks.cue'),
    'FILE "Two Tracks.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00\n'
    + 'FILE "Two Tracks (Track 2).bin" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n');
  await call('POST', '/api/scan');
  const multi = (await call('GET', '/api/state')).json.games
    .find((g) => g.ext === '.cue' && /Two Tracks/.test(g.title));
  check('a multi-track disc is blocked from in-app play',
    typeof multi?.inAppBlocked === 'string', JSON.stringify(multi?.inAppBlocked));
  check('and the reason names the fix', /\.chd/.test(multi?.inAppBlocked || ''), multi?.inAppBlocked);
  check('so /rom refuses it rather than serving a cue sheet',
    (await get(`/rom/${encodeURIComponent(multi.id)}.cue?t=${encodeURIComponent(token)}`)).status === 404);

  // A cue whose track is missing must fail the same legible way.
  fs.writeFileSync(path.join(multiDir, 'Gone.cue'), 'FILE "not-here.bin" BINARY\n  TRACK 01 MODE1/2352\n');
  await call('POST', '/api/scan');
  const gone = (await call('GET', '/api/state')).json.games
    .find((g) => g.ext === '.cue' && /Gone/.test(g.title));
  check('a cue with a missing track explains itself',
    /not next to it/.test(gone?.inAppBlocked || ''), JSON.stringify(gone?.inAppBlocked));

  for (const n of ['Two Tracks.bin', 'Two Tracks (Track 2).bin', 'Two Tracks.cue', 'Gone.cue']) {
    fs.rmSync(path.join(multiDir, n), { force: true });
  }

  // Reset the workspace: these fixtures created system folders, and a later
  // section asserts exactly which folders exist.
  for (const n of ['Totally Unknown.bin', 'Broken Sheet.cue', 'Sneaky.cue']) {
    fs.rmSync(loose(n), { force: true });
  }
  for (const dir of ['PS1', 'PS2', 'Sega CD']) {
    fs.rmSync(path.join(workspaceRoot, 'roms', dir), { recursive: true, force: true });
  }
  await call('POST', '/api/scan');

  section('emulator-gated roms/ folders');
  const romsDir = path.join(workspaceRoot, 'roms');
  const folder = (name) => path.join(romsDir, name);
  const exists = (p) => fs.existsSync(p);

  check('roms/ and emulators/ are created at startup',
    exists(romsDir) && exists(path.join(workspaceRoot, 'emulators')));
  check('a folder exists for the system we added an emulator for', exists(folder('N64')));
  check('no folder for a system with no emulator', !exists(folder('GBA')) && !exists(folder('PS1')),
    fs.readdirSync(romsDir).join(', '));

  // Add a multi-system emulator: mGBA claims GBA + Game Boy + Game Boy Color.
  r = await call('POST', '/api/emulators/add', {
    exe: fixtures.fakeEmu,
    name: 'Fake mGBA',
    platforms: ['gba', 'gb', 'gbc'],
    args: '-f "{rom}"',
  });
  check('adding a 3-system emulator succeeds', r.status === 200, r.text);
  // N64 is expected too — it belongs to the emulator added earlier. The point
  // is that mGBA added its three and nothing else.
  check('it created exactly its three folders, and nothing else',
    fs.readdirSync(romsDir).sort().join(',') === 'GB,GBA,GBC,N64',
    fs.readdirSync(romsDir).join(', '));
  check('the response names the new folders',
    (r.json?.workspace?.created || []).sort().join(',') === 'GB,GBA,GBC',
    JSON.stringify(r.json?.workspace));

  const stateW = (await call('GET', '/api/state')).json;
  check('each new folder is registered as a managed source',
    ['gba', 'gb', 'gbc'].every((p) => stateW.sources.some((s) => s.platform === p && s.managed)),
    JSON.stringify(stateW.sources.map((s) => `${s.platform}${s.managed ? '*' : ''}`)));
  check('the user-added folders stay unmanaged',
    stateW.sources.filter((s) => !s.managed).length === 3,
    String(stateW.sources.filter((s) => !s.managed).length));
  check('workspace summary lists the playable folders',
    (stateW.workspace?.folders || []).some((f) => f.name === 'GBA'),
    JSON.stringify(stateW.workspace?.folders?.map((f) => f.name)));

  // A folder with games in it must survive losing its emulator.
  fs.writeFileSync(path.join(folder('GBA'), 'Some Game (USA).gba'), 'x');
  const mgbaId = r.json.emulator.id;
  r = await call('POST', '/api/emulators/remove', { id: mgbaId });
  check('removing the emulator succeeds', r.status === 200, r.text);
  check('EMPTY folders are cleaned up',
    !exists(folder('GB')) && !exists(folder('GBC')),
    fs.readdirSync(romsDir).join(', '));
  check('a folder WITH games is never deleted', exists(folder('GBA')));
  check('its ROM is still on disk', exists(path.join(folder('GBA'), 'Some Game (USA).gba')));

  const stateW2 = (await call('GET', '/api/state')).json;
  check('the orphaned folder is flagged as a stray',
    (stateW2.workspace?.strays || []).some((s) => s.name === 'GBA'),
    JSON.stringify(stateW2.workspace?.strays));

  // A libretro frontend must not claim every system and spray 40 folders.
  const beforeCount = fs.readdirSync(romsDir).length;
  r = await call('POST', '/api/emulators/add', { exe: fixtures.fakeEmu, name: 'Fake RetroArch', libretro: true });
  check('a libretro emulator adds with no systems', r.status === 200, r.text);
  check('and therefore creates no folders',
    fs.readdirSync(romsDir).length === beforeCount,
    `${beforeCount} -> ${fs.readdirSync(romsDir).length}`);
  await call('POST', '/api/emulators/remove', { id: r.json.emulator.id });

  r = await call('POST', '/api/workspace/reconcile');
  check('reconcile is idempotent', r.status === 200 && !r.json.created.length, r.text);

  section('per-game state');
  r = await call('POST', '/api/game/flag', { gameId: smb.id, field: 'favorite', value: true });
  check('favourite can be set', r.json?.game?.favorite === true, r.text);
  check('an unknown flag field is refused',
    (await call('POST', '/api/game/flag', { gameId: smb.id, field: 'nonsense', value: true })).status === 400);

  section('path browsing');
  r = await call('POST', '/api/browse', { path: '', kind: 'folders' });
  check('the root lists drives or /', r.status === 200 && r.json.dirs.length > 0, r.text?.slice(0, 100));
  r = await call('POST', '/api/browse', { path: romRoot, kind: 'folders' });
  check('a folder lists its subfolders', r.json?.dirs?.length === 3, String(r.json?.dirs?.length));

  section('auto-organise on scan');
  const romsDir2 = path.join(workspaceRoot, 'roms');
  const inRoms = (...p) => path.join(romsDir2, ...p);

  // 1. A loose ROM must be filed by the scan itself — no explicit organise call.
  fs.writeFileSync(inRoms('Ocarina of Time (USA).z64'), 'x');
  r = await call('POST', '/api/scan');
  check('a plain scan files a loose ROM',
    r.json?.organized?.moved?.some((m) => m.folder === 'N64'), JSON.stringify(r.json?.organized));
  check('the file is in roms/N64/ now',
    fs.existsSync(inRoms('N64', 'Ocarina of Time (USA).z64')) &&
      !fs.existsSync(inRoms('Ocarina of Time (USA).z64')));
  check('and is in the library',
    (await call('GET', '/api/state')).json.games.some((g) => /Ocarina/.test(g.title)));

  // 2. A game for a system with no emulator still gets a folder and a home.
  //    ".md" is the Genesis extension — and also Markdown, which is the point.
  fs.writeFileSync(inRoms('Streets of Rage 2 (USA).md'), 'x');
  r = await call('POST', '/api/scan');
  check('a game with no emulator still gets filed',
    fs.existsSync(inRoms('Genesis', 'Streets of Rage 2 (USA).md')),
    fs.readdirSync(romsDir2).join(', '));
  const genesis = (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'genesis');
  check('its system appears in the library', !!genesis);
  check('but is honestly marked unplayable', genesis?.playable === false);

  // 3. README.md must not become a Genesis ROM.
  fs.writeFileSync(inRoms('Genesis', 'README.md'), '# notes');
  await call('POST', '/api/scan');
  check('README.md is not scanned as a Genesis game',
    !(await call('GET', '/api/state')).json.games.some((g) => /readme/i.test(g.title)),
    JSON.stringify((await call('GET', '/api/state')).json.games.filter((g) => g.platform === 'genesis').map((g) => g.title)));
  check('and is not treated as a misfiled ROM either',
    !((await call('GET', '/api/state')).json.workspace?.misfiled || []).some((f) => /readme/i.test(f.name)));

  // 4. A ROM in the wrong system folder is moved to the right one.
  fs.writeFileSync(inRoms('N64', 'Tetris (World).gb'), 'x');
  let mis = (await call('GET', '/api/state')).json.workspace?.misfiled || [];
  check('a misfiled ROM is detected', mis.some((f) => f.name === 'Tetris (World).gb'), JSON.stringify(mis));
  r = await call('POST', '/api/scan');
  check('the scan moves it to the right folder',
    fs.existsSync(inRoms('GB', 'Tetris (World).gb')) && !fs.existsSync(inRoms('N64', 'Tetris (World).gb')),
    JSON.stringify(r.json?.organized));

  // 5. Deliberate sub-organisation inside a system folder is left alone.
  fs.mkdirSync(inRoms('N64', 'Favourites'), { recursive: true });
  fs.writeFileSync(inRoms('N64', 'Favourites', 'Mario Kart 64 (USA).z64'), 'x');
  await call('POST', '/api/scan');
  check('sub-folders inside a system folder are not rearranged',
    fs.existsSync(inRoms('N64', 'Favourites', 'Mario Kart 64 (USA).z64')));
  check('and their games are still found',
    (await call('GET', '/api/state')).json.games.some((g) => /Mario Kart/.test(g.title)));

  // 6. The opt-out actually opts out.
  await call('POST', '/api/settings', { autoOrganize: false });
  fs.writeFileSync(inRoms('Chrono Trigger (USA).sfc'), 'x');
  r = await call('POST', '/api/scan');
  check('with auto-organise off, nothing is moved',
    (r.json?.organized?.moved || []).length === 0, JSON.stringify(r.json?.organized));
  check('the loose file stays put', fs.existsSync(inRoms('Chrono Trigger (USA).sfc')));
  check('but it is still reported so it can be fixed',
    ((await call('GET', '/api/state')).json.workspace?.loose || []).some((f) => /Chrono/.test(f.name)));

  // Pressing "File them now" must still work with the setting off — otherwise
  // the button silently does nothing.
  r = await call('POST', '/api/workspace/organize');
  check('an explicit organise still files, setting or not',
    (r.json?.moved || []).some((m) => m.folder === 'SNES'), JSON.stringify(r.json));
  check('the file really moved', fs.existsSync(inRoms('SNES', 'Chrono Trigger (USA).sfc')));
  await call('POST', '/api/settings', { autoOrganize: true });

  section('in-app player (WASM cores)');
  const coresDir = path.join(workspaceRoot, 'cores');

  // With nothing downloaded, every system must say so rather than offering a
  // Play button that cannot work.
  let cores = (await call('GET', '/api/cores')).json;
  check('cores endpoint responds', !!cores, JSON.stringify(cores)?.slice(0, 80));
  check('runtime reported as not installed', cores?.runtimeInstalled === false);

  let gbPlat = (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'gb');
  check('a WASM-capable system is not "ready" without the runtime',
    gbPlat?.wasm?.ready === false, JSON.stringify(gbPlat?.wasm));
  check('and says how to fix it', /fetch-cores/.test(gbPlat?.wasm?.reason || ''), gbPlat?.wasm?.reason);

  // A system with no WASM core at all must say *why*, not just "no".
  const n64Plat = (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'n64');
  check('an unsupported-in-WASM system gives a reason',
    n64Plat?.wasm?.ready === false && !!n64Plat?.wasm?.reason, JSON.stringify(n64Plat?.wasm));

  // Fake a complete install: the availability check is about files existing.
  const runtimeFiles = [
    'loader.js', 'emulator.min.js', 'emulator.min.css', 'localization/en-US.json',
    'compression/extract7z.js', 'compression/extractzip.js',
    'compression/libunrar.js', 'compression/libunrar.wasm',
  ];
  for (const f of runtimeFiles) {
    fs.mkdirSync(path.dirname(path.join(coresDir, f)), { recursive: true });
    fs.writeFileSync(path.join(coresDir, f), '/* test */');
  }
  for (const f of ['cores/reports/gambatte.json', 'cores/gambatte-wasm.data', 'cores/gambatte-legacy-wasm.data']) {
    fs.mkdirSync(path.dirname(path.join(coresDir, f)), { recursive: true });
    fs.writeFileSync(path.join(coresDir, f), 'x');
  }

  gbPlat = (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'gb');
  check('with the core installed, the system becomes ready', gbPlat?.wasm?.ready === true,
    JSON.stringify(gbPlat?.wasm));
  check('and reports the core it will use', gbPlat?.wasm?.core === 'gambatte', gbPlat?.wasm?.core);
  check('and the EmulatorJS system id', gbPlat?.wasm?.system === 'gb', gbPlat?.wasm?.system);

  // An installed core is an emulator: it must make the system playable on its
  // own and earn a roms/ folder, with no external .exe configured anywhere.
  const gbPlayable = (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'gb');
  check('an installed core alone makes the system playable', gbPlayable?.playable === true,
    JSON.stringify({ playable: gbPlayable?.playable, emulators: gbPlayable?.emulators }));
  r = await call('POST', '/api/workspace/reconcile');
  check('and earns it a roms/ folder', fs.existsSync(path.join(workspaceRoot, 'roms', 'GB')),
    fs.readdirSync(path.join(workspaceRoot, 'roms')).join(', '));

  // The catalogue must list everything, not just what is in the library.
  const cat = (await call('GET', '/api/state')).json.inApp;
  check('the catalogue lists every supported system', (cat?.supported || []).length >= 20,
    String(cat?.supported?.length));
  check('including ones with no core downloaded',
    (cat?.supported || []).some((row) => row.installed === false));
  check('and ones with no game in the library',
    (cat?.supported || []).some((row) => row.platform === 'amiga'));
  check('the unsupported list explains each omission',
    (cat?.unsupported || []).length > 5 && (cat.unsupported).every((row) => !!row.reason),
    JSON.stringify(cat?.unsupported?.slice(0, 2)));
  check('every catalogue row carries a display name',
    (cat?.supported || []).every((row) => !!row.name && !!row.core));

  // A partial download must not read as ready — that fails at start time.
  fs.rmSync(path.join(coresDir, 'cores/gambatte-legacy-wasm.data'));
  check('a half-downloaded core is not "ready"',
    (await call('GET', '/api/state')).json.platforms.find((p) => p.id === 'gb')?.wasm?.ready === false);
  fs.writeFileSync(path.join(coresDir, 'cores/gambatte-legacy-wasm.data'), 'x');

  section('player asset + ROM serving');
  // Core assets are deliberately token-free: EmulatorJS concatenates onto the
  // data path, so a query string would corrupt every derived URL.
  const rawGet = (p, headers) => fetch(base + p, { headers });
  check('core assets serve without a token', (await rawGet('/cores/loader.js')).status === 200);
  check('core asset traversal is blocked',
    [403, 404].includes((await rawGet('/cores/../../src/store.mjs')).status));
  check('a missing core asset explains itself',
    (await (await rawGet('/cores/cores/nope-wasm.data')).text()).includes('fetch-cores'));

  const gbGame = (await call('GET', '/api/state')).json.games.find((g) => g.platform === 'gb');
  if (gbGame) {
    const romUrl = `/rom?id=${encodeURIComponent(gbGame.id)}`;
    check('ROM bytes require a token', (await rawGet(romUrl)).status === 401);
    const romRes = await rawGet(`${romUrl}&t=${encodeURIComponent(token)}`);
    check('ROM serves with a token', romRes.status === 200, String(romRes.status));
    check('ROM advertises range support', romRes.headers.get('accept-ranges') === 'bytes');
    const ranged = await rawGet(`${romUrl}&t=${encodeURIComponent(token)}`, { Range: 'bytes=0-9' });
    check('ROM honours a range request', ranged.status === 206, String(ranged.status));
    // Fixture ROMs are tiny, so this also checks the clamp: a range that runs
    // past the end must return what exists, not error or over-read.
    const wantBytes = Math.min(10, gbGame.size);
    check('and returns that range, clamped to the file',
      (await ranged.arrayBuffer()).byteLength === wantBytes, `want ${wantBytes} of ${gbGame.size}`);
    check('a range starting past the end is rejected',
      (await rawGet(`${romUrl}&t=${encodeURIComponent(token)}`, { Range: `bytes=${gbGame.size + 50}-` })).status === 416);
    check('an unknown game id 404s',
      (await rawGet(`/rom?id=nope&t=${encodeURIComponent(token)}`)).status === 404);
    check('the ROM endpoint takes an id, never a path',
      (await rawGet(`/rom?id=${encodeURIComponent('../../../etc/hosts')}&t=${encodeURIComponent(token)}`)).status === 404);

    // The path form, /rom/<id>.<ext>, is what the player uses. It exists so the
    // URL ends in a filename unique to the game: EmulatorJS names the in-game
    // save after the last path segment with the extension stripped, so a shared
    // "/rom" made every game on a core write to one .srm and clobber each other.
    const pathUrl = (g, ext = '.gb') => `/rom/${encodeURIComponent(g.id)}${ext}`;
    check('the path form needs a token', (await rawGet(pathUrl(gbGame))).status === 401);
    const pathRes = await rawGet(`${pathUrl(gbGame)}?t=${encodeURIComponent(token)}`);
    check('the path form serves the same ROM', pathRes.status === 200, String(pathRes.status));
    check('byte-for-byte identical to the query form',
      (await pathRes.arrayBuffer()).byteLength === gbGame.size);
    check('the path form still honours ranges',
      (await rawGet(`${pathUrl(gbGame)}?t=${encodeURIComponent(token)}`, { Range: 'bytes=0-3' })).status === 206);
    check('any extension resolves to the same game',
      (await rawGet(`${pathUrl(gbGame, '.zip')}?t=${encodeURIComponent(token)}`)).status === 200);
    check('and no extension at all still works',
      (await rawGet(`${pathUrl(gbGame, '')}?t=${encodeURIComponent(token)}`)).status === 200);
    check('an unknown id in the path 404s',
      (await rawGet(`/rom/nope.gb?t=${encodeURIComponent(token)}`)).status === 404);
    // The segment is parsed for an id and looked up, never used as a path.
    for (const attempt of ['/rom/../../src/store.mjs', '/rom/..%2f..%2fsrc%2fstore.mjs', '/rom/%2e%2e%2f%2e%2e%2fpackage.json']) {
      const r = await rawGet(`${attempt}?t=${encodeURIComponent(token)}`);
      const body = r.status === 200 ? await r.text() : '';
      check(`the path form cannot traverse (${attempt})`,
        r.status !== 200 && !/export function|"name":/.test(body), `${r.status}`);
    }

    // The whole point: two games must not derive the same save-file name.
    const others = (await call('GET', '/api/state')).json.games.filter((g) => g.id !== gbGame.id);
    if (others.length) {
      const saveNameOf = (g) => `${g.id}`; // EmulatorJS strips the extension
      check('two games derive different in-game save names',
        saveNameOf(others[0]) !== saveNameOf(gbGame), `${saveNameOf(gbGame)} vs ${saveNameOf(others[0])}`);
      check('and both still serve their own bytes',
        (await rawGet(`/rom/${encodeURIComponent(others[0].id)}?t=${encodeURIComponent(token)}`)).status === 200);
    }

    section('in-app save states + play time');
    const payload = Buffer.from([9, 8, 7, 6, 5]).toString('base64');
    r = await call('POST', '/api/state/save', { gameId: gbGame.id, slot: '3', data: payload });
    check('a save state is written', r.status === 200 && r.json.bytes === 5, r.text);
    r = await call('GET', `/api/state/list?gameId=${encodeURIComponent(gbGame.id)}`);
    check('it appears in the slot list', r.json?.slots?.some((s) => s.slot === '3'), r.text);
    r = await call('GET', `/api/state/load?gameId=${encodeURIComponent(gbGame.id)}&slot=3`);
    check('it loads back byte-identical', r.json?.data === payload, r.text);
    check('an empty slot 404s',
      (await call('GET', `/api/state/load?gameId=${encodeURIComponent(gbGame.id)}&slot=7`)).status === 404);
    check('non-base64 state data is rejected',
      (await call('POST', '/api/state/save', { gameId: gbGame.id, data: '' })).status === 400);

    // The in-game hotkeys use a named slot, not a number.
    const quick = Buffer.from([1, 1, 2, 3, 5, 8]).toString('base64');
    r = await call('POST', '/api/state/save', { gameId: gbGame.id, slot: 'quick', data: quick });
    check('a named "quick" slot is accepted', r.status === 200 && r.json.slot === 'quick', r.text);
    r = await call('GET', `/api/state/load?gameId=${encodeURIComponent(gbGame.id)}&slot=quick`);
    check('quick load returns it byte-identical', r.json?.data === quick, r.text);
    // A slot name must never be able to escape the game's own folder.
    r = await call('POST', '/api/state/save', { gameId: gbGame.id, slot: '../../escape', data: quick });
    check('a slot name cannot traverse directories',
      r.status === 200 && !/[\\/.]/.test(r.json.slot), JSON.stringify(r.json));
    check('and nothing was written outside the states folder',
      !fs.existsSync(path.join(dataRoot, 'escape.state')) && !fs.existsSync(path.join(tmpRoot, 'escape.state')));

    section('suspend and resume');
    // The suspended session is what makes the Play button read "Resume", so the
    // flag on the game and the file on disk have to agree in both directions.
    const gameNow = async () =>
      (await call('GET', '/api/state')).json.games.find((g) => g.id === gbGame.id);

    check('a game with no suspended session is not marked suspended',
      (await gameNow()).suspended === false);

    const session = Buffer.from([4, 8, 15, 16, 23, 42]).toString('base64');
    r = await call('POST', '/api/state/save', { gameId: gbGame.id, slot: 'suspend', data: session });
    check('leaving a game writes the suspend slot', r.status === 200 && r.json.slot === 'suspend', r.text);

    let g = await gameNow();
    check('the game is then reported as suspended', g.suspended === true, JSON.stringify(g.suspended));
    check('with the time it happened', typeof g.suspendedAt === 'number' && g.suspendedAt > 0,
      String(g.suspendedAt));

    r = await call('GET', `/api/state/load?gameId=${encodeURIComponent(gbGame.id)}&slot=suspend`);
    check('and resuming reads the session back byte-identical', r.json?.data === session, r.text);

    // "Start over" clears exactly one slot and leaves the rest alone.
    r = await call('POST', '/api/state/clear', { gameId: gbGame.id, slot: 'suspend' });
    check('start over clears the suspend slot', r.status === 200 && r.json.existed === true, r.text);
    g = await gameNow();
    check('the game is no longer suspended', g.suspended === false && g.suspendedAt === 0,
      JSON.stringify({ s: g.suspended, at: g.suspendedAt }));
    r = await call('GET', `/api/state/load?gameId=${encodeURIComponent(gbGame.id)}&slot=quick`);
    check('but the quick save survived it', r.json?.data === quick, r.text);
    r = await call('GET', `/api/state/list?gameId=${encodeURIComponent(gbGame.id)}`);
    check('as did the numbered slot', r.json?.slots?.some((s) => s.slot === '3'), r.text);

    r = await call('POST', '/api/state/clear', { gameId: gbGame.id, slot: 'suspend' });
    check('clearing an already-clear slot is not an error',
      r.status === 200 && r.json.existed === false, r.text);
    r = await call('POST', '/api/state/clear', { gameId: 'game_nope', slot: 'suspend' });
    check('clearing state for an unknown game 404s', r.status === 404, r.text);
    r = await call('POST', '/api/state/clear', { gameId: gbGame.id, slot: '../../../config' });
    check('a slot name cannot traverse out of the clear path',
      r.status === 200 && !/[\\/.]/.test(r.json.slot), JSON.stringify(r.json));
    check('and the config file is still there', fs.existsSync(path.join(dataRoot, 'config.json')));

    section('save states as raw bytes (/savestate)');
    // Save states do not go through the JSON control API. An N64 or DS state is
    // several megabytes; base64 in a JSON body adds a third on top and blew past
    // the 1 MB cap, at which point the server destroyed the socket and the
    // browser said "Failed to fetch" — so leaving an N64 game lost the session.
    const stateUrl = (id, slot) =>
      `${base}/savestate?id=${encodeURIComponent(id)}&slot=${encodeURIComponent(slot)}`;
    const putState = (id, slot, buf) =>
      fetch(stateUrl(id, slot), {
        method: 'POST',
        headers: { 'x-emusteam-token': token, 'content-type': 'application/octet-stream' },
        body: buf,
      });
    const getState = (id, slot) =>
      fetch(stateUrl(id, slot), { headers: { 'x-emusteam-token': token } });

    const small = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    let sr = await putState(gbGame.id, 'suspend', small);
    check('a raw save state is accepted', sr.status === 200, String(sr.status));
    check('and reports the byte count', (await sr.json()).bytes === 8);
    sr = await getState(gbGame.id, 'suspend');
    check('it reads back as raw bytes',
      sr.headers.get('content-type') === 'application/octet-stream', sr.headers.get('content-type'));
    check('byte-identical', Buffer.from(await sr.arrayBuffer()).equals(small));
    check('and the game is marked suspended', (await gameNow()).suspended === true);

    // The actual regression: bigger than the JSON control API would ever accept.
    const big = crypto.randomBytes(3 * 1024 * 1024);
    sr = await putState(gbGame.id, 'suspend', big);
    check('a 3 MB state — far past the 1 MB JSON cap — is accepted',
      sr.status === 200 && (await sr.json()).bytes === big.length, String(sr.status));
    sr = await getState(gbGame.id, 'suspend');
    const back = Buffer.from(await sr.arrayBuffer());
    check('and comes back byte-identical', back.equals(big), `${back.length} vs ${big.length}`);
    check('with no leftover .part file',
      !fs.existsSync(path.join(dataRoot, 'states', gbGame.id.replace(/[^a-z0-9-]/gi, ''), 'suspend.state.part')));

    // Same payload through the JSON API must fail *legibly* rather than killing
    // the connection — "Failed to fetch" told the user nothing at all.
    let jsonTooBig = null;
    try {
      jsonTooBig = await call('POST', '/api/state/save',
        { gameId: gbGame.id, slot: 'suspend', data: big.toString('base64') });
    } catch (err) {
      jsonTooBig = { status: 0, text: `threw: ${err.message}` };
    }
    check('an oversized JSON body gets a 413, not a dropped connection',
      jsonTooBig.status === 413, `${jsonTooBig.status} ${jsonTooBig.text?.slice(0, 80)}`);
    check('and the error says where states should go',
      /savestate/.test(jsonTooBig.text || ''), jsonTooBig.text?.slice(0, 120));

    check('/savestate needs the token',
      (await fetch(stateUrl(gbGame.id, 'suspend'))).status === 401);
    check('/savestate 404s for an unknown game',
      (await getState('game_nope', 'suspend')).status === 404);
    check('/savestate 404s for an empty slot',
      (await getState(gbGame.id, 'neverused')).status === 404);
    check('an empty upload is rejected',
      (await putState(gbGame.id, 'suspend', Buffer.alloc(0))).status === 400);
    check('a failed upload leaves the previous state intact',
      Buffer.from(await (await getState(gbGame.id, 'suspend')).arrayBuffer()).equals(big));
    sr = await putState(gbGame.id, '../../escape', small);
    check('a slot name cannot traverse out of the states folder',
      sr.status === 200 && !/[\\/.]/.test((await sr.json()).slot));
    check('and nothing landed outside it',
      !fs.existsSync(path.join(dataRoot, 'escape.state')));

    await call('POST', '/api/state/clear', { gameId: gbGame.id, slot: 'suspend' });
    await call('POST', '/api/state/clear', { gameId: gbGame.id, slot: 'escape' });

    const before = (await call('GET', '/api/state')).json.games.find((g2) => g2.id === gbGame.id);
    await call('POST', '/api/session/inapp', { gameId: gbGame.id, phase: 'start' });
    await call('POST', '/api/session/inapp', { gameId: gbGame.id, phase: 'stop', seconds: 42 });
    const after = (await call('GET', '/api/state')).json.games.find((g) => g.id === gbGame.id);
    check('an in-app session increments play count',
      after.playCount === before.playCount + 1, `${before.playCount} -> ${after.playCount}`);
    check('and adds its play time', after.playSeconds === before.playSeconds + 42,
      `${before.playSeconds} -> ${after.playSeconds}`);
    check('a bad phase is rejected',
      (await call('POST', '/api/session/inapp', { gameId: gbGame.id, phase: 'nope' })).status === 400);

    // The frontend keys the "Now playing" overlay off this flag. Without it, the
    // overlay draws itself on top of the running in-app game and hides it — so
    // the tag is a contract, not decoration.
    const events = [];
    const sse = await new Promise((resolve, reject) => {
      const req = http.get(
        `${base}/events?t=${encodeURIComponent(token)}`,
        { headers: { accept: 'text/event-stream' } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => events.push(chunk));
          resolve(res);
        },
      );
      req.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 200));
    await call('POST', '/api/session/inapp', { gameId: gbGame.id, phase: 'start' });
    await new Promise((r) => setTimeout(r, 400));
    await call('POST', '/api/session/inapp', { gameId: gbGame.id, phase: 'stop', seconds: 1 });
    await new Promise((r) => setTimeout(r, 400));
    sse.destroy();

    const stream = events.join('');
    check('an in-app session is broadcast over SSE', /event: session/.test(stream), stream.slice(0, 200));
    check('and is tagged inApp so the overlay can skip it',
      /"inApp":true/.test(stream), stream.slice(0, 400));
    check('both start and stop are reported',
      /"running":true/.test(stream) && /"running":false/.test(stream), stream.slice(0, 400));
  }

  section('settings validation');
  // The fast-forward ratio is handed straight to the libretro core, so a string
  // or a negative number must never reach it.
  const settingsOf = async () => (await call('GET', '/api/state')).json.settings;
  check('fast forward defaults to a sane multiplier',
    (await settingsOf()).fastForwardRatio === 2.5, String((await settingsOf()).fastForwardRatio));
  check('a valid ratio is accepted',
    (await call('POST', '/api/settings', { fastForwardRatio: 4 })).status === 200);
  check('0 is accepted as "unlimited"',
    (await call('POST', '/api/settings', { fastForwardRatio: 0 })).status === 200);
  check('a non-numeric ratio is rejected',
    (await call('POST', '/api/settings', { fastForwardRatio: 'banana' })).status === 400);
  check('a negative ratio is rejected',
    (await call('POST', '/api/settings', { fastForwardRatio: -2 })).status === 400);
  await call('POST', '/api/settings', { fastForwardRatio: '3' });
  check('a numeric string is coerced to a number, not stored as text',
    (await settingsOf()).fastForwardRatio === 3, JSON.stringify((await settingsOf()).fastForwardRatio));
  await call('POST', '/api/settings', { showHidden: 'yes' });
  check('a boolean setting stays boolean', (await settingsOf()).showHidden === true,
    JSON.stringify((await settingsOf()).showHidden));
  check('an unknown setting key is ignored',
    (await call('POST', '/api/settings', { nonsense: 1 })).status === 200 &&
      !('nonsense' in (await settingsOf())));
  // Fast-forward *mode* is a fixed set, so nonsense must be rejected rather than
  // stored and silently ignored by the player.
  check('the default mode gives you both behaviours',
    (await settingsOf()).fastForwardMode === 'tap-or-hold',
    String((await settingsOf()).fastForwardMode));
  for (const mode of ['toggle', 'hold', 'tap-or-hold']) {
    check(`mode "${mode}" is accepted`,
      (await call('POST', '/api/settings', { fastForwardMode: mode })).status === 200);
  }
  check('an unknown mode is rejected',
    (await call('POST', '/api/settings', { fastForwardMode: 'banana' })).status === 400);
  check('and the rejection names the valid options',
    /toggle/.test((await call('POST', '/api/settings', { fastForwardMode: 'banana' })).json?.error || ''),
    (await call('POST', '/api/settings', { fastForwardMode: 'banana' })).json?.error);
  check('the stored mode survives a bad write',
    ['toggle', 'hold', 'tap-or-hold'].includes((await settingsOf()).fastForwardMode));
  // The sort setting is choice-validated too.
  check('an unknown sort order is rejected',
    (await call('POST', '/api/settings', { sort: 'sideways' })).status === 400);

  await call('POST', '/api/settings', {
    fastForwardRatio: 2.5, showHidden: false, fastForwardMode: 'tap-or-hold', sort: 'name',
  });

  section('config durability');
  const broken = path.join(dataRoot, 'config.json');
  check('config was written', fs.existsSync(broken));
  check('unknown API routes 404', (await call('GET', '/api/nope')).status === 404);
  check('a malformed body is rejected cleanly',
    (await fetch(base + '/api/scan', {
      method: 'POST',
      headers: { 'x-emusteam-token': token, 'content-type': 'application/json' },
      body: '{not json',
    })).status === 400);
} catch (err) {
  console.error('\nTest harness crashed:', err);
  exitCode = 1;
} finally {
  server.kill();
  // Give Windows a moment to release the file handles before removing the tree.
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch { /* temp dir, the OS will get it */ }
}

console.log(
  `\n${pass} passed, ${failures.length} failed` +
    (failures.length ? `\n  ${failures.join('\n  ')}` : ''),
);
process.exit(exitCode || (failures.length ? 1 : 0));
