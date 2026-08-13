// Thin API client. Every call carries the per-run token that the server
// injected into index.html.

const TOKEN = window.EMUSTEAM_TOKEN;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        'x-emusteam-token': TOKEN,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    // The server going away is the common case here (window outlived it).
    throw new Error('Lost contact with EmuSteam. Is the server still running?');
  }

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Unexpected response from ${path}`);
    }
  }

  if (!res.ok) throw new Error(payload?.error || `${res.status} ${res.statusText}`);
  return payload ?? {};
}

export const api = {
  state: () => request('GET', '/api/state'),
  session: () => request('GET', '/api/session'),
  scan: () => request('POST', '/api/scan', {}),

  launch: (gameId, emulatorId, discFile) =>
    request('POST', '/api/launch', { gameId, emulatorId, discFile }),
  stop: () => request('POST', '/api/stop', {}),
  preview: (gameId, emulatorId) => request('POST', '/api/preview', { gameId, emulatorId }),

  setFlag: (gameId, field, value) => request('POST', '/api/game/flag', { gameId, field, value }),
  setArt: (gameId, path) => request('POST', '/api/game/art', { gameId, path }),
  clearArt: (gameId) => request('POST', '/api/game/art/clear', { gameId }),
  forgetGame: (gameId) => request('POST', '/api/game/forget', { gameId }),

  addSource: (path, platform, recursive) =>
    request('POST', '/api/sources/add', { path, platform, recursive }),
  updateSource: (patch) => request('POST', '/api/sources/update', patch),
  removeSource: (id) => request('POST', '/api/sources/remove', { id }),
  guessPlatform: (path) => request('POST', '/api/sources/guess', { path }),

  detectEmulator: (exe) => request('POST', '/api/emulators/detect', { exe }),
  addEmulator: (payload) => request('POST', '/api/emulators/add', payload),
  updateEmulator: (payload) => request('POST', '/api/emulators/update', payload),
  removeEmulator: (id) => request('POST', '/api/emulators/remove', { id }),
  presets: () => request('GET', '/api/emulators/presets'),
  discoverEmulators: () => request('GET', '/api/emulators/discover'),

  setPlatformEmulator: (platform, emulatorId) =>
    request('POST', '/api/platform/emulator', { platform, emulatorId }),
  setPlatformCore: (platform, core) => request('POST', '/api/platform/core', { platform, core }),
  checkCore: (platform, emulatorId) =>
    request('POST', '/api/platform/core/check', { platform, emulatorId }),

  saveSettings: (patch) => request('POST', '/api/settings', patch),
  addArtDir: (path) => request('POST', '/api/artdirs/add', { path }),
  removeArtDir: (path) => request('POST', '/api/artdirs/remove', { path }),

  cores: () => request('GET', '/api/cores'),
  reportInApp: (gameId, phase, seconds) =>
    request('POST', '/api/session/inapp', { gameId, phase, seconds }),
  saveGameState: (gameId, data, slot) => request('POST', '/api/state/save', { gameId, data, slot }),
  listGameStates: (gameId) => request('GET', `/api/state/list?gameId=${encodeURIComponent(gameId)}`),
  clearGameState: (gameId, slot) => request('POST', '/api/state/clear', { gameId, slot }),
  fetchArt: (opts = {}) => request('POST', '/api/art/fetch', opts),
  pickImport: (kind) => request('POST', '/api/import/pick', { kind }),
  planImport: (paths) => request('POST', '/api/import/plan', { paths }),
  runImport: (paths, mode) => request('POST', '/api/import/run', { paths, mode }),

  reconcileWorkspace: () => request('POST', '/api/workspace/reconcile', {}),
  organizeWorkspace: () => request('POST', '/api/workspace/organize', {}),
  // 'all', 'owned', or an array of platform ids.
  installCores: (platforms = 'owned') => request('POST', '/api/cores/install', { platforms }),

  setLibraryLocation: (path) => request('POST', '/api/workspace/location', { path }),
  bringEmulators: (from, to) => request('POST', '/api/workspace/bring-emulators', { from, to }),

  browse: (path, kind) => request('POST', '/api/browse', { path, kind }),
  dialog: (kind, initial, title) => request('POST', '/api/dialog', { kind, initial, title }),
};

/**
 * URL for a box-art file.
 *
 * The token rides in the query string because an <img> tag cannot set a request
 * header — same reason EventSource below does it. Both are same-origin only, so
 * the token is no more exposed than it already is inside the page.
 */
export function artUrl(artPath) {
  if (!artPath) return null;
  return `/art?p=${encodeURIComponent(artPath)}&t=${encodeURIComponent(TOKEN)}`;
}

/**
 * Subscribe to server events (session start/stop, scan progress).
 * @param {(event: string, data: any) => void} onEvent
 */
export function subscribeEvents(onEvent) {
  const source = new EventSource(`/events?t=${encodeURIComponent(TOKEN)}`);
  // EventSource only delivers named events you have asked for, so anything the
  // server broadcasts under a new name is silently dropped until it is listed here.
  for (const name of ['session', 'scan', 'library', 'art', 'import', 'cores']) {
    source.addEventListener(name, (ev) => {
      let data = {};
      try {
        data = JSON.parse(ev.data);
      } catch { /* keep the empty object */ }
      onEvent(name, data);
    });
  }
  return () => source.close();
}
