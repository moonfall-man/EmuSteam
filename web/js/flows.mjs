// Multi-step setup flows, shared by the onboarding screen and Settings.
//
// Each flow is a small chain of modals that ends in an API call, and each one
// returns whether anything changed so the caller knows to refresh.

import { h } from './util.mjs';
import { api } from './api.mjs';
import { toast, stickyToast } from './toast.mjs';
import { openModal, browseModal, confirmModal, chooseModal } from './modal.mjs';

/** "312 files, 3.5 GB" — or "20,000+ files" once the walk gave up counting. */
function countLine({ count, bytes, capped }) {
  const files = `${count.toLocaleString()}${capped ? '+' : ''} file${count === 1 ? '' : 's'}`;
  // Down to KB: rounding everything small up to "1 MB" makes a config file and a
  // ROM look the same size, which is exactly the judgement being asked for here.
  const size = bytes >= (1 << 30) ? `${(bytes / (1 << 30)).toFixed(1)} GB`
    : bytes >= (1 << 20) ? `${(bytes / (1 << 20)).toFixed(bytes >= (10 << 20) ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return capped ? files : `${files}, ${size}`;
}

/**
 * Move the library folder: pick it, save it, then say what got left behind.
 *
 * The saying-what-got-left-behind is the important half. Relocating does not
 * move files, and reporting that as "nothing was moved" reads as reassurance
 * when it is really a warning — from the next launch EmuSteam looks in the new
 * folder for everything. Games going missing is at least loud. Emulators are
 * discovered by scanning emulators/ rather than stored in settings, so a
 * relocated library finds an empty folder and reports no emulators as though
 * you never had any.
 *
 * @param {object} state
 * @param {string|null} folder  pre-picked folder, or null to ask; '' means
 *                              "back to the app folder"
 * @returns {Promise<boolean>} whether anything changed
 */
export async function setLibraryLocationFlow(state, folder = null) {
  if (folder === null) {
    folder = await browseModal({
      kind: 'folder',
      title: 'Where should the games live?',
      nativeDialogs: !!state.capabilities?.nativeDialogs,
    });
    if (!folder) return false;
  }

  let res;
  try {
    res = await api.setLibraryLocation(folder);
  } catch (err) {
    toast.error(err.message);
    return false;
  }

  const left = res.stranded || {};
  const lines = [`The library will be read from:\n\n${res.libraryRoot}\n`];

  if (left.roms || left.emulators) {
    lines.push(`Still in the old folder, ${res.from}:`);
    if (left.roms) lines.push(`   •  Games — ${countLine(left.roms)}`);
    if (left.emulators) lines.push(`   •  Emulators — ${countLine(left.emulators)}`);
    lines.push('');
    lines.push(
      left.emulators
        ? 'Nothing has been moved yet. EmuSteam can carry the emulators across now — '
          + 'they are small, and left behind they go missing without saying so. Copy the '
          + 'games over yourself, or use Add games to import them.'
        : 'Nothing has been moved. Copy the games over yourself, or use Add games to import them.',
    );
  } else {
    lines.push('Nothing needed moving — the old folder was empty.');
  }
  lines.push('');
  lines.push('Either way, close and reopen EmuSteam for the change to take effect.');

  const move = await confirmModal({
    title: 'Restart EmuSteam to finish',
    note: lines.join('\n'),
    confirmLabel: left.emulators ? 'Move the emulators' : 'Got it',
    cancelLabel: left.emulators ? 'Leave them' : 'Close',
    // Leaving files alone is the safe default when a stray button press decides.
    focusCancel: !!left.emulators,
  });

  if (move && left.emulators) {
    try {
      const done = await api.bringEmulators(res.from, res.libraryRoot);
      toast.good(`Moved ${done.moved} file${done.moved === 1 ? '' : 's'} to ${done.to}`);
    } catch (err) {
      toast.error(err.message);
    }
  }
  return true;
}

/**
 * Download the in-app player.
 *
 * Kicks the download off and returns — the server streams 'cores' events and the
 * progress card in app.mjs follows them, the same as scanning and importing. The
 * caller gets told whether anything actually started so it can avoid a pointless
 * refresh.
 *
 * @param {'all'|'owned'|string[]} platforms
 * @param {string} what  how to describe it in the toast
 * @returns {Promise<boolean>} true when a download began
 */
export async function downloadCoresFlow(platforms = 'owned', what = 'the in-app player') {
  try {
    const res = await api.installCores(platforms);
    if (res.alreadyComplete) {
      toast.info('Already downloaded — nothing to fetch.');
      return false;
    }
    toast.info(`Downloading ${what} — ${res.files} file${res.files === 1 ? '' : 's'}.`);
    return true;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}

/**
 * Step 2 of setup: get something to play games with.
 *
 * Two genuinely different answers, so it asks rather than guessing. Downloading
 * cores is first because it needs nothing from the user — no file to find, no
 * emulator to have installed already — and covers most retro systems.
 */
export async function addPlayableFlow(state) {
  const runtimeReady = state.inApp?.runtimeInstalled;
  const missing = (state.inApp?.supported || []).filter((row) => !row.installed).length;

  const picked = await chooseModal({
    title: 'What should play your games?',
    note: 'Most retro systems can run inside EmuSteam. The heavier consoles need a real emulator.',
    options: [
      {
        id: 'cores',
        title: runtimeReady ? 'Download more systems' : 'Play them in the app',
        note: runtimeReady
          ? `${missing} system${missing === 1 ? '' : 's'} left to download, about 1–2 MB each.`
          : 'Downloads the player and the cores for your systems — about 1–2 MB each, nothing to install.',
        // focus, not selected: these are actions, and "Current" would read as a
        // setting that is already in force.
        focus: true,
        disabled: runtimeReady && missing === 0,
      },
      {
        id: 'emulator',
        title: 'Point at an emulator I already have',
        note: 'For PS2, GameCube, Wii and anything else that needs the real thing.',
      },
    ],
  });

  if (picked === null) return false;
  if (picked === 'emulator') return addEmulatorFlow(state);
  return downloadCoresFlow('owned');
}

/** Add a ROM folder: pick it, confirm the platform, save, rescan. */
export async function addSourceFlow(state) {
  const folder = await browseModal({
    kind: 'folder',
    title: 'Add a ROM folder',
    start: state.capabilities?.suggestedRomFolders?.[0] || undefined,
    nativeDialogs: !!state.capabilities?.nativeDialogs,
  });
  if (!folder) return false;

  let guessed = 'auto';
  try {
    guessed = (await api.guessPlatform(folder)).platform || 'auto';
  } catch { /* fall back to auto */ }

  const platform = await pickPlatformModal(state, {
    title: 'Which system is this?',
    note:
      guessed === 'auto'
        ? "We couldn't tell from the file types. Pick the system so scanning knows what to accept."
        : 'Guessed from the files in that folder. Change it if that is wrong.',
    selected: guessed,
    includeAuto: true,
  });
  if (!platform) return false;

  try {
    await api.addSource(folder, platform, true);
  } catch (err) {
    toast.error(err.message);
    return false;
  }

  await rescan();
  return true;
}

/** Add an emulator: offer what's already in emulators/, else browse for it. */
export async function addEmulatorFlow(state) {
  let exe = null;
  let presetFromDiscovery = null;

  // If a portable build is already sitting in emulators/, offer it rather than
  // making the user go and find a file they have already put in place.
  try {
    const { candidates } = await api.discoverEmulators();
    if (candidates.length) {
      const picked = await chooseModal({
        title: 'Found in your emulators folder',
        note: 'Pick one to set it up, or browse for a program somewhere else.',
        options: candidates.map((candidate) => ({
          id: candidate.exe,
          title: candidate.name,
          note: candidate.portable,
        })),
        allowNone: 'Browse for a program instead…',
      });
      if (picked === null) return false;
      if (picked !== '__none__') {
        exe = picked;
        presetFromDiscovery = candidates.find((c) => c.exe === picked)?.preset || null;
      }
    }
  } catch {
    // Discovery is a convenience; fall through to browsing if it fails.
  }

  if (!exe) {
    exe = await browseModal({
      kind: 'executable',
      // Start in emulators/ — if the program lives there, its path is stored
      // relative and the whole folder stays portable.
      start: state.capabilities?.emulatorsRoot || state.capabilities?.appRoot,
      title: 'Add an emulator',
      nativeDialogs: !!state.capabilities?.nativeDialogs,
    });
    if (!exe) return false;
  }

  let detected;
  try {
    detected = await api.detectEmulator(exe);
  } catch (err) {
    toast.error(err.message);
    return false;
  }

  const preset = detected.preset || presetFromDiscovery;
  const draft = {
    exe,
    name: detected.suggestedName,
    args: preset?.args || '"{rom}"',
    libretro: !!preset?.libretro,
    platforms: preset?.platforms || [],
  };

  const saved = await emulatorEditor(state, draft, {
    title: preset ? `Add ${preset.name}` : 'Add emulator',
    note:
      preset?.notes ||
      (preset
        ? `Recognised as ${preset.name} — the launch arguments are pre-filled.`
        : "We don't know this program, so check the launch arguments below."),
    confirmLabel: 'Add emulator',
  });
  if (!saved) return false;

  try {
    const result = await api.addEmulator(saved);
    toast.good(`${saved.name} added.`);
    reportWorkspaceChanges(result.workspace);
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  return true;
}

/**
 * Tell the user which roms/ folders just appeared. This is the payoff of the
 * whole managed-folder idea, so it should not happen silently.
 */
export function reportWorkspaceChanges(workspace) {
  if (!workspace) return;
  if (workspace.created?.length) {
    const list = workspace.created.map((n) => `roms/${n}`).join(', ');
    toast.good(
      workspace.created.length === 1
        ? `${list} is ready — drop your ROMs in there.`
        : `Ready for your ROMs: ${list}`,
    );
  }
  if (workspace.removed?.length) {
    toast.info(`Removed empty folder${workspace.removed.length === 1 ? '' : 's'}: ${workspace.removed.map((n) => `roms/${n}`).join(', ')}`);
  }
}

/** Edit an existing emulator. */
export async function editEmulatorFlow(state, emulator) {
  const saved = await emulatorEditor(
    state,
    {
      exe: emulator.exe,
      name: emulator.name,
      args: emulator.args,
      libretro: emulator.libretro,
      platforms: [...emulator.platforms],
    },
    { title: `Edit ${emulator.name}`, confirmLabel: 'Save' },
  );
  if (!saved) return false;

  try {
    const result = await api.updateEmulator({ id: emulator.id, ...saved });
    reportWorkspaceChanges(result.workspace);
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  return true;
}

/**
 * The shared emulator form: name, launch arguments, supported systems.
 * @returns {Promise<object|null>} the draft to save, or null if cancelled
 */
function emulatorEditor(state, draft, { title, note, confirmLabel }) {
  const working = { ...draft };

  return openModal({
    title,
    note,
    width: '720px',
    body: (ctx) => {
      const host = h('div', {});

      const nameInput = h('input', {
        class: 'input',
        nav: true,
        'data-nav-initial': '',
        value: working.name,
        placeholder: 'Project64',
        spellcheck: 'false',
        onInput: (ev) => {
          working.name = ev.target.value;
        },
      });

      const argsInput = h('input', {
        class: 'input mono',
        nav: true,
        value: working.args,
        placeholder: '"{rom}"',
        spellcheck: 'false',
        onInput: (ev) => {
          working.args = ev.target.value;
        },
      });

      const platformsLabel = h('div', { class: 'listrow-sub' });
      const updatePlatformsLabel = () => {
        platformsLabel.textContent = working.platforms.length
          ? working.platforms
              .map((id) => state.allPlatforms.find((p) => p.id === id)?.short || id)
              .join(', ')
          : 'None selected — this emulator will not appear for any game.';
      };
      updatePlatformsLabel();

      host.append(
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'field-label', text: 'Program' }),
          h('div', { class: 'listrow-sub', text: working.exe }),
        ),
        h('div', { class: 'field' }, h('div', { class: 'field-label', text: 'Name' }), nameInput),
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'field-label', text: 'Launch arguments' }),
          argsInput,
          h('div', {
            class: 'field-hint',
            text: '{rom} is the ROM path. Also available: {romDir} {romFile} {romName} {core} {platform}',
          }),
        ),
        h(
          'button',
          {
            class: 'listrow',
            nav: true,
            onClick: async () => {
              const picked = await pickPlatformsModal(state, working.platforms);
              if (picked) {
                working.platforms = picked;
                updatePlatformsLabel();
              }
            },
          },
          h(
            'div',
            { class: 'listrow-main' },
            h('div', { class: 'listrow-title', text: 'Systems this emulator runs' }),
            platformsLabel,
          ),
          h('div', { class: 'chip', text: 'Change' }),
        ),
        working.libretro
          ? h(
              'div',
              { class: 'field', style: { marginTop: '16px' } },
              h('div', { class: 'field-hint' }, 'RetroArch mode: {core} resolves to the core you pick per system in Settings → Systems.'),
            )
          : null,
      );

      return host;
    },
    footer: (ctx) => [
      h('button', { class: 'btn btn-ghost', nav: true, text: 'Cancel', onClick: () => ctx.close(null) }),
      h('button', {
        class: 'btn btn-primary',
        nav: true,
        text: confirmLabel,
        onClick: () => {
          if (!working.name.trim()) {
            toast.error('Give the emulator a name.');
            return;
          }
          if (!working.args.includes('{rom')) {
            toast.error('The launch arguments need a {rom} token so we can pass the ROM path.');
            return;
          }
          // Without a system there is no roms/ folder and nothing to launch, so
          // this is a hard requirement rather than a warning.
          if (!working.platforms.length) {
            toast.error('Pick at least one system this emulator runs.');
            return;
          }
          ctx.close({ ...working, name: working.name.trim(), args: working.args.trim() });
        },
      }),
    ],
  });
}

/** Single-platform picker. @returns {Promise<string|null>} */
export function pickPlatformModal(state, { title, note, selected, includeAuto = false }) {
  const options = [];
  if (includeAuto) {
    options.push({
      id: 'auto',
      title: 'Auto-detect',
      note: 'Only picks up file types that belong to exactly one system.',
      selected: selected === 'auto',
    });
  }
  for (const platform of state.allPlatforms) {
    options.push({
      id: platform.id,
      title: platform.name,
      note: `${platform.maker}${platform.year ? ` · ${platform.year}` : ''} · ${platform.exts.slice(0, 6).join(' ')}`,
      selected: platform.id === selected,
    });
  }
  return chooseModal({ title, note, options }).then((id) => (id === null ? null : id));
}

/** Multi-platform picker used by the emulator form. @returns {Promise<string[]|null>} */
export function pickPlatformsModal(state, selectedIds) {
  const chosen = new Set(selectedIds);

  return openModal({
    title: 'Systems this emulator runs',
    note: 'The emulator shows up as an option for every system you tick.',
    width: '680px',
    body: (ctx) => {
      const host = h('div', { class: 'choices' });

      for (const platform of state.allPlatforms) {
        const row = h(
          'button',
          {
            class: ['choice', chosen.has(platform.id) && 'is-selected'],
            nav: true,
            'data-nav-key': `plat-${platform.id}`,
            onClick: () => {
              if (chosen.has(platform.id)) chosen.delete(platform.id);
              else chosen.add(platform.id);
              row.classList.toggle('is-selected', chosen.has(platform.id));
              tick.textContent = chosen.has(platform.id) ? '✓' : '';
            },
          },
          h(
            'div',
            {},
            h('div', { class: 'choice-title', text: platform.name }),
            h('div', { class: 'choice-note', text: platform.exts.slice(0, 8).join(' ') }),
          ),
        );
        const tick = h('div', {
          class: 'chip chip-strong',
          text: chosen.has(platform.id) ? '✓' : '',
          style: { minWidth: '44px', justifyContent: 'center' },
        });
        row.append(tick);
        host.append(row);
      }
      return host;
    },
    footer: (ctx) => [
      h('button', { class: 'btn btn-ghost', nav: true, text: 'Cancel', onClick: () => ctx.close(null) }),
      h('button', {
        class: 'btn btn-primary',
        nav: true,
        text: 'Done',
        onClick: () => ctx.close([...chosen]),
      }),
    ],
  });
}

/** Choose which emulator a platform uses by default. */
export async function pickPlatformEmulatorFlow(state, platform) {
  const options = state.emulators
    .filter((emu) => emu.platforms.includes(platform.id))
    .map((emu) => ({
      id: emu.id,
      title: emu.name,
      note: emu.exists ? emu.exe : `Missing: ${emu.exe}`,
      selected: emu.id === platform.defaultEmulator,
      disabled: !emu.exists,
    }));

  if (!options.length) {
    const add = await confirmModal({
      title: `No emulator runs ${platform.name} yet`,
      note: 'Add one now and it will be wired up to this system automatically.',
      confirmLabel: 'Add emulator',
    });
    if (!add) return false;
    return addEmulatorFlow(state);
  }

  const chosen = await chooseModal({
    title: `Emulator for ${platform.name}`,
    note: 'Used when you press Play. You can still override it per game.',
    options,
  });
  if (!chosen) return false;

  try {
    await api.setPlatformEmulator(platform.id, chosen);
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  return true;
}

/** Set the libretro core for a platform. */
export async function pickCoreFlow(state, platform) {
  const suggestions = platform.suggestedCores || [];
  const options = suggestions.map((core) => ({
    id: core,
    title: core.replace(/_libretro$/, ''),
    note: `${core}${platform.core === core ? '' : ''}`,
    selected: platform.core === core,
  }));
  options.push({ id: '__custom__', title: 'Type a core name or path…', note: 'For a core not listed here.' });

  const chosen = await chooseModal({
    title: `libretro core for ${platform.name}`,
    note: 'RetroArch loads this core to run the game.',
    options,
  });
  if (!chosen) return false;

  let core = chosen;
  if (chosen === '__custom__') {
    const typed = await promptCore(platform);
    if (!typed) return false;
    core = typed;
  }

  try {
    await api.setPlatformCore(platform.id, core);
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  return true;
}

function promptCore(platform) {
  return openModal({
    title: `Core for ${platform.name}`,
    note: 'Enter the core file name without the extension, or a full path to the core file.',
    width: '620px',
    body: (ctx) => {
      const input = h('input', {
        class: 'input mono',
        nav: true,
        'data-nav-initial': '',
        value: platform.core || '',
        placeholder: 'mupen64plus_next_libretro',
        spellcheck: 'false',
        onKeydown: (ev) => {
          if (ev.key === 'Enter') {
            ev.stopPropagation();
            ctx.close(input.value.trim());
          }
        },
      });
      ctx.__input = input;
      return h('div', { class: 'field' }, input);
    },
    footer: (ctx) => [
      h('button', { class: 'btn btn-ghost', nav: true, text: 'Cancel', onClick: () => ctx.close(null) }),
      h('button', {
        class: 'btn btn-primary',
        nav: true,
        text: 'Save',
        onClick: () => ctx.close(ctx.__input.value.trim()),
      }),
    ],
  }).then((value) => value || null);
}

/** Assign box art to one game by hand. */
export async function assignArtFlow(state, game) {
  const image = await browseModal({
    kind: 'image',
    title: `Box art for ${game.title}`,
    nativeDialogs: !!state.capabilities?.nativeDialogs,
  });
  if (!image) return false;

  try {
    await api.setArt(game.id, image);
    toast.good('Art updated.');
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  return true;
}

/**
 * Report what the tidy pass moved. Files being moved on your behalf must always
 * be visible — a silent reorganise of someone's game folder is alarming even
 * when every individual move is correct.
 */
export function reportOrganized(organized) {
  if (!organized) return;

  for (const move of organized.moved || []) {
    const from = move.fromFolder ? `roms/${move.fromFolder}/` : 'roms/';
    toast.good(`Filed ${move.name} — ${from} → roms/${move.folder}/`);
  }
  for (const skip of organized.skipped || []) {
    toast.error(`${skip.name}: ${skip.reason}`);
  }
  for (const folder of organized.created || []) {
    toast.info(`roms/${folder} is ready.`);
  }
}

/** Rescan with a sticky "working" toast. Tidies first, server-side. */
export async function rescan() {
  const done = stickyToast('Scanning your ROM folders…');
  try {
    const result = await api.scan();
    done();
    reportOrganized(result.organized);
    if (result.count === 0) {
      toast.info('Scan finished, but no games matched. Check the system assigned to each folder.');
    } else {
      toast.good(`${result.count} games found in ${result.ms}ms.`);
    }
    for (const warning of result.warnings || []) toast.error(warning);
    return true;
  } catch (err) {
    done();
    toast.error(err.message);
    return false;
  }
}

/**
 * Import ROMs from anywhere on disk.
 *
 * Shows what it *would* do before it does anything, and asks whether to copy or
 * move. Copy is offered first on purpose: these are files someone put somewhere
 * deliberately, and taking them away should never be a side effect of clicking a
 * button labelled "import".
 *
 * @returns {Promise<boolean>} whether anything was imported
 */
export async function importRomsFlow(kind = 'files') {
  let picked;
  try {
    picked = await api.pickImport(kind);
  } catch (err) {
    toast.error(err.message);
    return false;
  }
  if (picked.cancelled) return false;

  const plan = picked.plan;
  if (!plan.groups.length) {
    const why = plan.skipped.length
      ? `Nothing there looked like a ROM. ${plan.skipped[0].reason}`
      : 'Nothing there looked like a ROM.';
    toast.error(why);
    return false;
  }

  const byFolder = new Map();
  for (const g of plan.groups) byFolder.set(g.folder, (byFolder.get(g.folder) || 0) + 1);
  const breakdown = [...byFolder.entries()]
    .map(([folder, n]) => `${folder} (${n})`)
    .join(', ');
  const size = plan.bytes >= (1 << 30)
    ? `${(plan.bytes / (1 << 30)).toFixed(1)} GB`
    : `${Math.round(plan.bytes / (1 << 20))} MB`;

  const mode = await chooseModal({
    title: `Import ${plan.groups.length} game${plan.groups.length === 1 ? '' : 's'}?`,
    note: `${size} into ${breakdown}.`
      + (plan.skipped.length ? ` ${plan.skipped.length} file(s) will be left alone.` : '')
      + ' Existing files are never overwritten.',
    options: [
      {
        id: 'copy',
        title: 'Copy them in',
        note: 'Your originals stay exactly where they are. Uses disc space twice.',
        selected: true,
      },
      {
        id: 'move',
        title: 'Move them in',
        note: 'Faster and uses no extra space, but the files leave their current folder.',
      },
    ],
  });
  if (!mode) return false;

  try {
    const result = await api.runImport(picked.paths, mode);
    if (result.skipped?.length) {
      toast.error(`${result.skipped.length} skipped — ${result.skipped[0].reason}`);
    }
    return result.imported.length > 0;
  } catch (err) {
    toast.error(err.message);
    return false;
  }
}
