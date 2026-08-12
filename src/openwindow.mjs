// Opens the UI in a chromeless browser window.
//
// Every Windows machine already has Edge (and therefore a Chromium engine), so
// `--app=` gives us a real app window with no tabs, no address bar and no
// install step. That is the whole reason this project needs no Electron: we get
// a native-feeling window for 0 bytes of dependency.
//
// A dedicated --user-data-dir matters more than it looks: without it the URL
// opens as a tab inside the user's existing browser session and the window
// flags are ignored.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot } from './paths.mjs';

function candidateBrowsers() {
  const env = process.env;
  if (process.platform === 'win32') {
    const roots = [
      env['PROGRAMFILES'],
      env['PROGRAMFILES(X86)'],
      env['LOCALAPPDATA'],
    ].filter(Boolean);
    const relative = [
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
      ['Vivaldi', 'Application', 'vivaldi.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
    ];
    const out = [];
    for (const root of roots) {
      for (const parts of relative) out.push(path.join(root, ...parts));
    }
    return out;
  }

  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
    '/snap/bin/chromium',
  ];
}

function findBrowser() {
  for (const candidate of candidateBrowsers()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * How long a browser process has to live before its exit is believed to mean
 * "the user closed the window".
 *
 * A Chromium launched with a --user-data-dir that another instance already owns
 * does not open a window of its own: it hands the URL to the running process and
 * exits immediately. Treating that as "the window closed" made EmuSteam shut its
 * own server down within a second of starting, so the window that did open was
 * pointing at nothing.
 */
const WINDOW_GRACE_MS = 2500;

/**
 * Launch the app window.
 * @param {string} url
 * @param {{fullscreen?:boolean, onClose?:() => void, onDetached?:() => void}} opts
 *   onClose fires when the window is genuinely closed. onDetached fires instead
 *   when the browser exited too fast to have been a window at all.
 * @returns {{mode:'app'|'default'|'none', browser?:string}}
 */
export function openAppWindow(url, { fullscreen = true, onClose, onDetached } = {}) {
  const browser = findBrowser();

  if (browser) {
    const profileDir = path.join(dataRoot, 'window-profile');
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      // Let the UI play its own navigation blips without a click first.
      '--autoplay-policy=no-user-gesture-required',
      // --kiosk rather than --start-fullscreen: in plain fullscreen the browser
      // treats Escape as "leave fullscreen" and can consume it before the page
      // sees it, which breaks Escape-to-go-back. Kiosk mode hands every key to
      // the app. Alt+F4 (or Ctrl+C in the console) still closes it.
      fullscreen ? '--kiosk' : '--window-size=1600,960',
    ];

    try {
      const startedAt = Date.now();
      const child = spawn(browser, args, { stdio: 'ignore', detached: false });
      child.on('exit', () => {
        // Distinguish "you closed the window" from "this process never owned a
        // window". Closing one takes a person at least a moment; handing off to an
        // already-running Chromium takes milliseconds.
        if (Date.now() - startedAt < WINDOW_GRACE_MS) onDetached?.();
        else onClose?.();
      });
      child.on('error', () => onDetached?.());
      return { mode: 'app', browser };
    } catch {
      // fall through to the default-browser path
    }
  }

  // No Chromium engine found: open in whatever the default browser is. Works
  // fine, just with tabs and an address bar.
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
    return { mode: 'default' };
  } catch {
    return { mode: 'none' };
  }
}
