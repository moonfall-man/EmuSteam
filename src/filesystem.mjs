// Two ways to choose a path, because a couch app needs both.
//
//   pickFolder / pickFile — a real OS dialog, for when you're at the keyboard.
//   listDirectory         — a gamepad-navigable browser rendered inside the app.
//
// The OS dialog is strictly a convenience; every flow works without it.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIALOG_TIMEOUT_MS = 120_000;

/** Whether a native picker is available on this OS. */
export function nativeDialogsAvailable() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return true;
  return !!which('zenity') || !!which('kdialog');
}

function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    const res = spawnSync(probe, [cmd], { encoding: 'utf8' });
    return res.status === 0 ? String(res.stdout).trim().split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}

/**
 * Run a WinForms dialog on an STA thread. The initial path travels via an env
 * var so no user-supplied string is ever pasted into the script text.
 */
function runPowerShellDialog(script, initial) {
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
    {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
      windowsHide: false,
      env: { ...process.env, EMUSTEAM_INITIAL: initial || '' },
    },
  );
  if (res.error || res.status !== 0) return null;
  const out = String(res.stdout || '').trim();
  return out || null;
}

/** @returns {string|null} chosen folder, or null if cancelled/unsupported */
export function pickFolder({ initial = '', title = 'Select a folder' } = {}) {
  if (process.platform === 'win32') {
    return runPowerShellDialog(
      `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = ${psQuote(title)}
$dlg.ShowNewFolderButton = $false
if ($env:EMUSTEAM_INITIAL -and (Test-Path -LiteralPath $env:EMUSTEAM_INITIAL)) {
  $dlg.SelectedPath = $env:EMUSTEAM_INITIAL
}
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.SelectedPath }
`.trim(),
      initial,
    );
  }

  if (process.platform === 'darwin') {
    const res = spawnSync('osascript', ['-e', `POSIX path of (choose folder with prompt ${asQuote(title)})`], {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
    });
    return res.status === 0 ? String(res.stdout).trim() || null : null;
  }

  if (which('zenity')) {
    const res = spawnSync('zenity', ['--file-selection', '--directory', `--title=${title}`], {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
    });
    return res.status === 0 ? String(res.stdout).trim() || null : null;
  }
  if (which('kdialog')) {
    const res = spawnSync('kdialog', ['--getexistingdirectory', initial || os.homedir()], {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
    });
    return res.status === 0 ? String(res.stdout).trim() || null : null;
  }
  return null;
}

/**
 * @param {{initial?:string, title?:string, kind?:'executable'|'image'|'any'}} opts
 * @returns {string|null}
 */
export function pickFile({ initial = '', title = 'Select a file', kind = 'any' } = {}) {
  const filters = {
    executable: 'Programs (*.exe)|*.exe|All files (*.*)|*.*',
    image: 'Images (*.png;*.jpg;*.jpeg;*.webp)|*.png;*.jpg;*.jpeg;*.webp|All files (*.*)|*.*',
    any: 'All files (*.*)|*.*',
  }[kind];

  if (process.platform === 'win32') {
    return runPowerShellDialog(
      `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = ${psQuote(title)}
$dlg.Filter = ${psQuote(filters)}
$dlg.Multiselect = $false
if ($env:EMUSTEAM_INITIAL -and (Test-Path -LiteralPath $env:EMUSTEAM_INITIAL)) {
  $dlg.InitialDirectory = $env:EMUSTEAM_INITIAL
}
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dlg.FileName }
`.trim(),
      initial,
    );
  }

  if (process.platform === 'darwin') {
    const res = spawnSync('osascript', ['-e', `POSIX path of (choose file with prompt ${asQuote(title)})`], {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
    });
    return res.status === 0 ? String(res.stdout).trim() || null : null;
  }

  if (which('zenity')) {
    const res = spawnSync('zenity', ['--file-selection', `--title=${title}`], {
      encoding: 'utf8',
      timeout: DIALOG_TIMEOUT_MS,
    });
    return res.status === 0 ? String(res.stdout).trim() || null : null;
  }
  return null;
}

/**
 * Pick several files at once, for importing a pile of ROMs.
 *
 * Separate from pickFile rather than a flag on it, because every platform needs a
 * different incantation for multi-select and the return type differs (a list, not
 * a string). One newline-delimited path per line comes back from all three.
 *
 * @returns {string[]} chosen files; empty if cancelled or unsupported
 */
export function pickFiles({ initial = '', title = 'Select files' } = {}) {
  const lines = (out) => String(out || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (process.platform === 'win32') {
    const out = runPowerShellDialog(
      `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.OpenFileDialog
$dlg.Title = ${psQuote(title)}
$dlg.Filter = 'All files (*.*)|*.*'
$dlg.Multiselect = $true
if ($env:EMUSTEAM_INITIAL -and (Test-Path -LiteralPath $env:EMUSTEAM_INITIAL)) {
  $dlg.InitialDirectory = $env:EMUSTEAM_INITIAL
}
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.FileNames | ForEach-Object { Write-Output $_ } }
`.trim(),
      initial,
    );
    return lines(out);
  }

  if (process.platform === 'darwin') {
    const res = spawnSync(
      'osascript',
      ['-e',
        'set out to ""\n'
        + `set picked to (choose file with prompt ${asQuote(title)} with multiple selections allowed)\n`
        + 'repeat with f in picked\n'
        + '  set out to out & POSIX path of f & linefeed\n'
        + 'end repeat\n'
        + 'return out'],
      { encoding: 'utf8', timeout: DIALOG_TIMEOUT_MS },
    );
    return res.status === 0 ? lines(res.stdout) : [];
  }

  if (which('zenity')) {
    const res = spawnSync(
      'zenity',
      ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`],
      { encoding: 'utf8', timeout: DIALOG_TIMEOUT_MS },
    );
    return res.status === 0 ? lines(res.stdout) : [];
  }
  return [];
}

/** PowerShell single-quoted literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
/** AppleScript double-quoted literal. */
function asQuote(s) {
  return `"${String(s).replace(/["\\]/g, '\\$&')}"`;
}

// ------------------------------------------------- in-app directory browser

/** Windows drive roots that currently exist. */
function driveRoots() {
  const out = [];
  for (let i = 65; i <= 90; i++) {
    const root = `${String.fromCharCode(i)}:\\`;
    try {
      fs.accessSync(root);
      out.push(root);
    } catch { /* drive letter unused */ }
  }
  return out;
}

/**
 * One directory level, shaped for the browser UI.
 * `dirPath` of '' or '/' on Windows lists drives instead of a real folder.
 */
export function listDirectory(dirPath, { filesFilter = null } = {}) {
  const isWindows = process.platform === 'win32';

  if (!dirPath || dirPath === '/' || dirPath === '\\') {
    if (isWindows) {
      return {
        path: '',
        display: 'This PC',
        parent: null,
        dirs: driveRoots().map((root) => ({ name: root, path: root })),
        files: [],
      };
    }
    dirPath = '/';
  }

  const abs = path.resolve(dirPath);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch (err) {
    return { path: abs, display: abs, parent: parentOf(abs), dirs: [], files: [], error: err.message };
  }

  const dirs = [];
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(abs, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDir = fs.statSync(full).isDirectory(); } catch { continue; }
    }
    if (isDir) {
      dirs.push({ name: entry.name, path: full });
    } else if (!filesFilter || filesFilter(entry.name)) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* cosmetic */ }
      files.push({ name: entry.name, path: full, size });
    }
  }

  const collate = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  dirs.sort(collate);
  files.sort(collate);

  return { path: abs, display: abs, parent: parentOf(abs), dirs, files };
}

function parentOf(abs) {
  const parent = path.dirname(abs);
  if (parent === abs) return process.platform === 'win32' ? '' : null;
  return parent;
}

/** Sensible starting folder for a browse dialog. */
export function defaultBrowseStart() {
  return os.homedir();
}
