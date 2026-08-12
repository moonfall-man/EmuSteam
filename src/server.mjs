// The local HTTP server. Node stdlib only — no Express, no build step.
//
// Security posture: this process can spawn programs and read files, so it is
// bound to 127.0.0.1 and every /api call must carry a per-run token. The token
// is injected into index.html, which means only same-origin page scripts can
// read it — a random website you visit cannot, and it cannot set the custom
// header cross-origin without a preflight we never answer.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { webRoot } from './paths.mjs';
import { handleApi, ApiError, addEventClient, resolveRomRequest, resolveSaveState } from './api.mjs';
import { resolveArtRequest, mimeForImage } from './art.mjs';
import { coresRoot } from './cores.mjs';

const TOKEN_HEADER = 'x-emusteam-token';
const MAX_BODY_BYTES = 1 << 20; // 1 MB is generous for a JSON control API

const STATIC_MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
  ['.ico', 'image/x-icon'],
]);

export function createServer({ token = crypto.randomBytes(24).toString('hex') } = {}) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, token).catch((err) => {
      sendError(res, err);
    });
  });
  server.token = token;
  return server;
}

async function handleRequest(req, res, token) {
  const url = new URL(req.url, 'http://127.0.0.1');

  // Reject anything that looks like it came from another origin.
  const origin = req.headers.origin;
  if (origin && !isLocalOrigin(origin)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('Cross-origin requests are not allowed.');
    return;
  }

  if (url.pathname.startsWith('/api/')) return handleApiRequest(req, res, url, token);
  if (url.pathname === '/art') return handleArtRequest(req, res, url, token);
  if (url.pathname === '/events') return handleEventStream(req, res, url, token);
  // The in-app player needs two things the static handler cannot give it: the
  // EmulatorJS runtime (which lives outside web/) and the ROM bytes themselves.
  if (url.pathname.startsWith('/cores/')) return handleCoreAsset(req, res, url);
  if (url.pathname === '/rom' || url.pathname.startsWith('/rom/')) {
    return handleRomRequest(req, res, url, token);
  }
  if (url.pathname === '/savestate') return handleSaveStateRequest(req, res, url, token);
  return handleStaticRequest(req, res, url, token);
}

function isLocalOrigin(origin) {
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function tokenOf(req, url) {
  return req.headers[TOKEN_HEADER] || url.searchParams.get('t') || '';
}

function authorized(req, url, token) {
  const provided = String(tokenOf(req, url));
  if (provided.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}

// ------------------------------------------------------------------ API

async function handleApiRequest(req, res, url, token) {
  if (!authorized(req, url, token)) {
    return sendJson(res, 401, { error: 'Bad or missing token.' });
  }

  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendError(res, err);
    }
  }

  try {
    const result = await handleApi(req.method, url, body);
    return sendJson(res, 200, result ?? {});
  } catch (err) {
    return sendError(res, err);
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Answer properly instead of killing the socket. A destroyed connection
        // reaches the browser as "Failed to fetch", which is indistinguishable
        // from the server having died — the caller learns nothing. Keep draining
        // without buffering so the response can still be written and read.
        if (!tooBig) {
          tooBig = true;
          reject(new ApiError(413,
            'Request body too large for the control API (1 MB). Save states use /savestate.'));
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!chunks.length) return resolve(null);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ApiError(400, 'Request body was not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

// --------------------------------------------------------------- save states

// Far above any libretro core (the largest are tens of MB), so this is a guard
// against a runaway upload rather than a limit anyone should ever meet.
const MAX_STATE_BYTES = 128 << 20;

/**
 * Save states, as raw bytes in both directions.
 *
 * Streamed to and from disk so a 40 MB DS state never sits in memory twice, and
 * written via a temp file so an interrupted upload cannot leave a truncated
 * state where a good one used to be.
 */
function handleSaveStateRequest(req, res, url, token) {
  if (!authorized(req, url, token)) {
    return sendJson(res, 401, { error: 'Bad or missing token.' });
  }

  let target;
  try {
    target = resolveSaveState(url.searchParams.get('id'), url.searchParams.get('slot'));
  } catch (err) {
    return sendError(res, err);
  }

  if (req.method === 'GET') {
    if (!safeStat(target.file)) {
      return sendJson(res, 404, { error: 'No save state in that slot.' });
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(target.file).on('error', () => res.destroy()).pipe(res);
    return;
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Use GET to read a save state or POST to write one.' });
  }

  fs.mkdirSync(target.dir, { recursive: true });
  const tmp = `${target.file}.part`;
  const out = fs.createWriteStream(tmp);
  let total = 0;
  let done = false;

  const fail = (status, message) => {
    if (done) return;
    done = true;
    out.destroy();
    fs.rm(tmp, { force: true }, () => {});
    if (!res.headersSent) sendJson(res, status, { error: message });
    req.destroy();
  };

  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_STATE_BYTES) fail(413, 'That save state is implausibly large.');
  });
  req.on('error', () => fail(400, 'The upload did not finish.'));
  out.on('error', (err) => fail(500, `Could not write the save state: ${err.message}`));
  out.on('finish', () => {
    if (done) return;
    done = true;
    if (!total) {
      fs.rm(tmp, { force: true }, () => {});
      return sendJson(res, 400, { error: 'The save state was empty.' });
    }
    try {
      fs.renameSync(tmp, target.file);
    } catch (err) {
      fs.rm(tmp, { force: true }, () => {});
      return sendJson(res, 500, { error: `Could not store the save state: ${err.message}` });
    }
    return sendJson(res, 200, { ok: true, slot: target.slot, bytes: total });
  });

  req.pipe(out);
}

function safeStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ art

function handleArtRequest(req, res, url, token) {
  if (!authorized(req, url, token)) {
    res.writeHead(401).end();
    return;
  }
  const resolved = resolveArtRequest(url.searchParams.get('p'));
  if (!resolved.ok) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`Art unavailable: ${resolved.reason}`);
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved.path);
  } catch {
    res.writeHead(404).end();
    return;
  }

  // Art files rarely change; an mtime-based ETag saves a lot of re-reads while
  // scrolling a large grid.
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }

  res.writeHead(200, {
    'content-type': mimeForImage(resolved.path),
    'content-length': stat.size,
    'cache-control': 'private, max-age=60',
    etag,
  });
  fs.createReadStream(resolved.path).on('error', () => res.destroy()).pipe(res);
}

// ------------------------------------------------------ in-app player assets

/**
 * Serve the EmulatorJS runtime and WASM cores out of cores/.
 *
 * Deliberately the one route with no token check. EmulatorJS derives every asset
 * URL by string-concatenating onto `EJS_pathtodata`, so a `?t=` on the prefix
 * would corrupt each derived path — and the core `.data` files are fetched by the
 * runtime itself, out of our reach.
 *
 * That is an acceptable trade because these are byte-for-byte public CDN files
 * containing nothing about the user, and the handler is sandboxed to cores/, so
 * the worst it can offer a local process is a copy of something it could already
 * download. Everything that touches user data — /rom, /art, /api — still
 * requires the token.
 *
 * Cores are megabytes and never change, so they get a long cache lifetime;
 * re-fetching a core on every launch would undo the point of running in-app.
 */
function handleCoreAsset(req, res, url) {
  const relative = decodeURIComponent(url.pathname.replace(/^\/cores\//, ''));
  const target = path.join(coresRoot, relative);
  if (!target.startsWith(coresRoot + path.sep)) {
    res.writeHead(403).end();
    return;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
      .end('Core asset missing. Run: npm run fetch-cores');
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(403).end();
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const type =
    STATIC_MIME.get(ext) ||
    (ext === '.data' || ext === '.wasm' ? 'application/octet-stream' : 'application/octet-stream');

  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag }).end();
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'private, max-age=604800',
    etag,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

/**
 * Serve one ROM's bytes to the in-app player, by game id.
 *
 * Deliberately keyed on the game id rather than a path: the page never gets to
 * name a file on disk, so this cannot be turned into an arbitrary file read.
 * Range requests are supported because the player seeks within large images.
 */
function handleRomRequest(req, res, url, token) {
  if (!authorized(req, url, token)) {
    res.writeHead(401).end();
    return;
  }

  // The game id can arrive either in the path (/rom/<id>.gb) or the query
  // (/rom?id=<id>). The path form is the one the player uses, and it exists for
  // one reason: EmulatorJS names the game's in-game save file after the last path
  // segment of the ROM URL with the extension stripped. With a bare "/rom" that
  // segment was the literal string "rom" for every game, so every Game Boy title
  // shared one rom.srm, every SNES title shared another, and switching games
  // overwrote the previous game's battery save.
  //
  // The segment is only ever parsed for an id and looked up in the library — it
  // is never used as a filesystem path, so it cannot traverse anywhere.
  const fromPath = url.pathname.startsWith('/rom/')
    ? decodeURIComponent(url.pathname.slice('/rom/'.length)).replace(/\.[^.]*$/, '')
    : '';
  const resolved = resolveRomRequest(
    fromPath || url.searchParams.get('id'),
    url.searchParams.get('disc'),
  );
  if (!resolved.ok) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end(resolved.reason);
    return;
  }

  let stat;
  try {
    stat = fs.statSync(resolved.path);
  } catch {
    res.writeHead(404).end();
    return;
  }

  const headers = {
    'content-type': 'application/octet-stream',
    'cache-control': 'private, max-age=3600',
    'accept-ranges': 'bytes',
    // Let the player name the download sensibly if it ever offers one.
    'content-disposition': `inline; filename="${encodeURIComponent(path.basename(resolved.path))}"`,
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (Number.isNaN(start) || start > end || start >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(resolved.path, { start, end }).on('error', () => res.destroy()).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(resolved.path).on('error', () => res.destroy()).pipe(res);
}

// ------------------------------------------------------- server-sent events

function handleEventStream(req, res, url, token) {
  if (!authorized(req, url, token)) {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  addEventClient(res);

  // Keepalive comment: stops an idle proxy or the browser from closing the pipe.
  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25_000);
  res.on('close', () => clearInterval(ping));
}

// ---------------------------------------------------------------- static

function handleStaticRequest(req, res, url, token) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }

  let relative = decodeURIComponent(url.pathname);
  if (relative === '/' || relative === '') relative = '/index.html';

  const target = path.join(webRoot, relative);
  // path.join already normalises, so confirm we did not escape webRoot.
  if (!target.startsWith(webRoot + path.sep) && target !== webRoot) {
    res.writeHead(403).end();
    return;
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  if (stat.isDirectory()) {
    res.writeHead(403).end();
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const type = STATIC_MIME.get(ext) || 'application/octet-stream';

  // index.html is the one file we rewrite: it carries the API token.
  if (relative === '/index.html') {
    let html;
    try {
      html = fs.readFileSync(target, 'utf8');
    } catch {
      res.writeHead(500).end();
      return;
    }
    html = html.replace('__EMUSTEAM_TOKEN__', token);
    const buf = Buffer.from(html, 'utf8');
    res.writeHead(200, {
      'content-type': type,
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    res.end(buf);
    return;
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

// ---------------------------------------------------------------- errors

function sendJson(res, status, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

function sendError(res, err) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = err instanceof ApiError ? err.status : 500;
  if (status >= 500) console.error('[emusteam]', err);
  sendJson(res, status, { error: err.message || 'Internal error' });
}
