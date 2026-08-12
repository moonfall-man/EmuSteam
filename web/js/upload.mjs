// Uploading ROMs from the browser: drag them onto the window, or pick them.
//
// This is the route that works from anywhere — including a phone or a laptop
// pointed at the machine running EmuSteam. The native file dialog in Settings is
// better when you are sitting at that machine, because it can move a file on disk
// instead of sending its bytes over HTTP; this one sends bytes, which is the only
// thing a browser can do.
//
// Files land in roms/ and are then sorted by the same organiser that handles
// anything you drop in that folder by hand. Uploading is just a way to get the
// file there without opening a file manager.

import { api } from './api.mjs';
import { toast } from './toast.mjs';

/** One request per file, so progress is real and one bad file fails alone. */
async function uploadOne(file, token) {
  const res = await fetch(`/upload?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'x-emusteam-token': token, 'content-type': 'application/octet-stream' },
    body: file,
    // A big ROM is a long request; let the browser stream it rather than buffer.
    duplex: 'half',
  });
  if (res.ok) return { ok: true, bytes: file.size };
  let why = `HTTP ${res.status}`;
  try {
    const payload = await res.json();
    if (payload?.error) why = payload.error;
  } catch { /* not JSON */ }
  return { ok: false, reason: why };
}

/**
 * Pull every file out of a drop, including whole folders.
 *
 * A dropped folder arrives as a directory entry rather than a file, so it has to
 * be walked. Without this, dragging in "My ROMs/" would silently do nothing,
 * which is exactly the thing someone would try first.
 */
async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items
    .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  // No directory support in this browser: take the flat file list.
  if (!entries.length) return [...(dataTransfer.files || [])];

  const out = [];
  const readEntry = (entry, depth) => new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        out.push(file);
        resolve();
      }, resolve);
      return;
    }
    if (!entry.isDirectory || depth > 6) return resolve();
    const reader = entry.createReader();
    const readBatch = () => {
      // readEntries returns at most 100 at a time and must be called until empty.
      reader.readEntries(async (batch) => {
        if (!batch.length) return resolve();
        for (const child of batch) await readEntry(child, depth + 1);
        readBatch();
      }, resolve);
    };
    readBatch();
  });

  for (const entry of entries) await readEntry(entry, 0);
  return out;
}

const fmtBytes = (n) => (n >= (1 << 30)
  ? `${(n / (1 << 30)).toFixed(1)} GB`
  : `${Math.max(1, Math.round(n / (1 << 20)))} MB`);

/**
 * Upload files, then let the organiser sort them.
 *
 * @param {File[]} files
 * @param {{onProgress?:(p:object)=>void}} opts
 */
export async function uploadRoms(files, opts = {}) {
  const { onProgress } = opts;
  const token = window.EMUSTEAM_TOKEN;
  const list = files.filter((f) => f && f.size > 0);
  if (!list.length) return { uploaded: 0, failed: [] };

  const totalBytes = list.reduce((sum, f) => sum + f.size, 0);
  let doneBytes = 0;
  let uploaded = 0;
  const failed = [];

  onProgress?.({ phase: 'start', total: list.length, bytes: totalBytes });

  for (let i = 0; i < list.length; i++) {
    const file = list[i];
    onProgress?.({
      phase: 'working',
      done: i,
      total: list.length,
      doneBytes,
      bytes: totalBytes,
      label: file.name,
    });
    // Sequential on purpose: parallel uploads of multi-gigabyte files compete for
    // the same disk and make every one of them look stalled.
    // eslint-disable-next-line no-await-in-loop
    const res = await uploadOne(file, token);
    if (res.ok) {
      uploaded++;
      doneBytes += file.size;
    } else {
      failed.push({ name: file.name, reason: res.reason });
    }
  }

  onProgress?.({
    phase: 'sorting', total: list.length, uploaded, bytes: doneBytes,
  });

  // Now the part the user actually cares about: put them where they belong.
  let organized = null;
  try {
    organized = await api.organizeWorkspace();
    await api.scan();
  } catch (err) {
    toast.error(`Uploaded, but sorting failed: ${err.message}`);
  }

  onProgress?.({
    phase: 'done', uploaded, failed, bytes: doneBytes, organized,
  });
  return { uploaded, failed, bytes: doneBytes, organized };
}

/**
 * Let ROMs be dragged anywhere onto the window.
 *
 * Window-wide rather than a small drop zone: the target someone aims at is "the
 * app", and a 40-pixel rectangle is a worse version of the same feature.
 */
export function installDropTarget({ onProgress, onDone }) {
  let depth = 0;
  const overlay = document.getElementById('dropzone');

  const show = (on) => overlay?.classList.toggle('show', on);

  window.addEventListener('dragover', (ev) => {
    // Only react to actual files; dragging text or a link is not an import.
    if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragenter', (ev) => {
    if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
    ev.preventDefault();
    depth++;
    show(true);
  });

  // dragleave fires for every child element the cursor crosses, so a depth count
  // is the only reliable way to know the pointer has really left the window.
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });

  window.addEventListener('drop', async (ev) => {
    if (![...(ev.dataTransfer?.types || [])].includes('Files')) return;
    ev.preventDefault();
    depth = 0;
    show(false);

    const files = await filesFromDrop(ev.dataTransfer);
    if (!files.length) {
      toast.error('Nothing to import from that drop.');
      return;
    }
    toast.good(`Uploading ${files.length} file${files.length === 1 ? '' : 's'} (${fmtBytes(files.reduce((s, f) => s + f.size, 0))})…`);
    const result = await uploadRoms(files, { onProgress });
    if (result.failed.length) {
      toast.error(`${result.failed.length} failed — ${result.failed[0].reason}`);
    }
    onDone?.(result);
  });
}

/** Open the browser's own file picker. Used by the button in Settings. */
export function pickAndUpload({ onProgress, onDone }) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const files = [...(input.files || [])];
    input.remove();
    if (!files.length) return;
    const result = await uploadRoms(files, { onProgress });
    if (result.failed.length) {
      toast.error(`${result.failed.length} failed — ${result.failed[0].reason}`);
    }
    onDone?.(result);
  });
  input.click();
}
