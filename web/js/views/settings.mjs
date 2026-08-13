// Settings. Five tabs, all controller-navigable, no native <select> anywhere
// (a dropdown is unusable with a D-pad — every choice opens a modal list).

import { h, fmtRelative, SORTS } from './../util.mjs';
import { api } from './../api.mjs';
import { toast } from './../toast.mjs';
import { confirmModal, chooseModal, browseModal } from './../modal.mjs';
import { GALAXY_TINT } from './../art.mjs';
import { onAction, BUTTON_ACTIONS, BUTTON_NAMES } from './../input.mjs';
// The in-app catalogue outgrew this file and lives in its own module.
import { inAppPanel } from './inapp.mjs';
import { pickAndUpload } from './../upload.mjs';
import {
  addSourceFlow, addEmulatorFlow, editEmulatorFlow, importRomsFlow,
  pickPlatformModal, pickPlatformEmulatorFlow, pickCoreFlow, rescan,
  reportWorkspaceChanges, reportOrganized,
} from './../flows.mjs';

const TABS = [
  { id: 'library', label: 'ROM folders' },
  { id: 'emulators', label: 'Emulators' },
  { id: 'systems', label: 'Systems' },
  { id: 'inapp', label: 'Play in app' },
  { id: 'controller', label: 'Controller' },
  { id: 'look', label: 'Look & feel' },
  { id: 'about', label: 'About' },
];

/**
 * Kick off an artwork download. Progress shows in the card at the bottom of the
 * screen, driven by 'art' events — this only has to start it and surface a refusal
 * (nothing scanned yet, or a run already going).
 */
async function startArtFetch(opts) {
  try {
    const res = await api.fetchArt(opts);
    toast.good(`Looking up artwork for ${res.games} game${res.games === 1 ? '' : 's'}…`);
  } catch (err) {
    toast.error(err.message);
  }
}

export function render(ctx) {
  const { state, params, go } = ctx;
  const active = TABS.some((t) => t.id === params.tab) ? params.tab : 'library';

  const nav = h(
    'nav',
    { class: 'settings-nav' },
    ...TABS.map((tab) =>
      h('button', {
        class: ['settings-tab', tab.id === active && 'is-active'],
        nav: true,
        'data-nav-key': `tab-${tab.id}`,
        text: tab.label,
        onClick: () => go('settings', { tab: tab.id }, { replace: true }),
      }),
    ),
  );

  const panels = {
    library: () => libraryPanel(ctx),
    emulators: () => emulatorsPanel(ctx),
    systems: () => systemsPanel(ctx),
    inapp: () => inAppPanel(ctx),
    controller: () => controllerPanel(ctx),
    look: () => lookPanel(ctx),
    about: () => aboutPanel(ctx),
  };

  const body = panels[active]();

  // Land on the tab you are looking at, not on some button buried in the panel.
  // Arriving on the rail makes it obvious where you are and what else is here.
  const activeTab = nav.querySelector(`[data-nav-key="tab-${active}"]`);
  if (activeTab) activeTab.dataset.navInitial = '';

  return {
    node: h('div', { class: 'settings' }, nav, h('div', {}, body)),
    crumbs: [{ text: 'Settings' }],
    subtitle: TABS.find((t) => t.id === active).label,
    tint: GALAXY_TINT,
    tintSeed: 'settings',
    hints: [
      { glyph: 'a', label: 'Select' },
      { glyph: 'b', label: 'Back' },
    ],
  };
}

/**
 * A boolean setting, rendered as a switch. Shared by the ROM-folders and
 * Look & feel panels so a toggle behaves identically wherever it appears.
 */
function settingToggle(ctx, key, label, note) {
  const { state, refresh } = ctx;
  return h(
    'button',
    {
      class: 'toggle',
      nav: true,
      'data-nav-key': `set-${key}`,
      'aria-pressed': state.settings[key] ? 'true' : 'false',
      style: { marginTop: '18px' },
      onClick: async () => {
        try {
          await api.saveSettings({ [key]: !state.settings[key] });
          refresh({ keepFocus: true });
        } catch (err) {
          toast.error(err.message);
        }
      },
    },
    h(
      'div',
      {},
      h('div', { class: 'toggle-label', text: label }),
      h('div', { class: 'toggle-note', text: note }),
    ),
    h('div', { class: 'switch' }),
  );
}

// --------------------------------------------------------------- ROM folders

function libraryPanel(ctx) {
  const { state, refresh } = ctx;

  const sourceRow = (source) =>
    h(
      'div',
      { class: 'listrow' },
      h(
        'div',
        { class: 'listrow-main' },
        h(
          'div',
          { class: 'listrow-title' },
          h('span', { text: source.platformName }),
          source.managed ? h('span', { class: 'chip', text: 'auto' }) : null,
          source.exists ? null : h('span', { class: 'chip pill-bad', text: 'Folder missing' }),
          source.enabled ? null : h('span', { class: 'chip', text: 'Skipped' }),
        ),
        h('div', { class: 'listrow-sub', text: source.managed ? source.path : source.absPath }),
      ),
      h(
        'div',
        { class: 'listrow-actions' },
        // Managed rows have no controls: their system is fixed by which folder
        // they are, and removing one is the job of removing the emulator.
        source.managed
          ? h('span', { class: 'field-hint', text: 'Managed by your emulators' })
          : [
              h('button', {
                class: 'btn btn-sm btn-ghost',
                nav: true,
                'data-nav-key': `src-plat-${source.id}`,
                text: 'System',
                onClick: async () => {
                  const platform = await pickPlatformModal(state, {
                    title: 'Which system is this folder?',
                    selected: source.platform,
                    includeAuto: true,
                  });
                  if (!platform) return;
                  try {
                    await api.updateSource({ id: source.id, platform });
                    await rescan();
                    refresh();
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              }),
              h('button', {
                class: 'btn btn-sm btn-ghost',
                nav: true,
                'data-nav-key': `src-toggle-${source.id}`,
                text: source.enabled ? 'Disable' : 'Enable',
                onClick: async () => {
                  try {
                    await api.updateSource({ id: source.id, enabled: !source.enabled });
                    await rescan();
                    refresh();
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              }),
              h('button', {
                class: 'btn btn-sm btn-danger',
                nav: true,
                'data-nav-key': `src-del-${source.id}`,
                text: 'Remove',
                onClick: async () => {
                  const yes = await confirmModal({
                    title: 'Remove this ROM folder?',
                    note: `${source.absPath}\n\nNothing on disk is touched — its games just leave the library.`,
                    confirmLabel: 'Remove',
                    danger: true,
                  });
                  if (!yes) return;
                  try {
                    await api.removeSource(source.id);
                    await rescan();
                    refresh();
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              }),
            ],
      ),
    );

  const managed = state.sources.filter((s) => s.managed);
  const manual = state.sources.filter((s) => !s.managed);

  const sources = state.sources.length
    ? h('div', { class: 'rowlist' }, ...managed.map(sourceRow), ...manual.map(sourceRow))
    : h('div', {
        class: 'panel-note',
        text: 'No ROM folders yet. Add an emulator and a folder for each system it runs appears in roms/ automatically.',
      });

  const artDirs = state.artDirs.length
    ? h(
        'div',
        { class: 'rowlist' },
        ...state.artDirs.map((dir) =>
          h(
            'div',
            { class: 'listrow' },
            h('div', { class: 'listrow-main' }, h('div', { class: 'listrow-sub', text: dir })),
            h(
              'div',
              { class: 'listrow-actions' },
              h('button', {
                class: 'btn btn-sm btn-danger',
                nav: true,
                text: 'Remove',
                onClick: async () => {
                  try {
                    await api.removeArtDir(dir);
                    await rescan();
                    refresh();
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              }),
            ),
          ),
        ),
      )
    : null;

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'ROM folders' }),
      h('p', {
        class: 'panel-note',
        text: 'Everything here ends up sorted into roms/ by system. Importing from this PC is the one to use for a whole collection — it can move files instead of copying them. Dragging is quicker for a game or two. Or point at a library you keep elsewhere and leave it exactly where it is.',
      }),
      h('p', {
        class: 'field-hint',
        style: { marginTop: '-10px', marginBottom: '14px' },
        text: 'You can also drag ROMs — or whole folders of them — anywhere onto this window.',
      }),
      h(
        'div',
        { class: 'row-actions', style: { marginBottom: '18px' } },
        // Import leads because everyone runs this on the machine holding their
        // ROMs. A native dialog gives real paths, so it can move a 3 GB image
        // instantly; a browser only ever hands over bytes, which means copying.
        h('button', {
          class: 'btn btn-primary',
          nav: true,
          'data-nav-key': 'import-files',
          text: '↓  Import ROMs…',
          title: 'Native file dialog — can move files instead of copying them',
          onClick: async () => { if (await importRomsFlow('files')) refresh(); },
        }),
        h('button', {
          class: 'btn',
          nav: true,
          'data-nav-key': 'upload-files',
          text: 'Add a few files…',
          title: 'Browser file picker; copies the files in, same as dragging them',
          onClick: () => pickAndUpload({ onDone: () => refresh({ keepFocus: true }) }),
        }),
        h('button', {
          class: 'btn',
          nav: true,
          'data-nav-key': 'import-folder',
          text: 'Import a whole folder…',
          title: 'Walks the folder and imports every ROM it finds',
          onClick: async () => { if (await importRomsFlow('folder')) refresh(); },
        }),
      ),
      h('p', {
        class: 'panel-note',
        text: `A folder in roms/ appears for each system you have an emulator for — those are marked "auto" and manage themselves. You can also add folders anywhere else on disk. Each folder belongs to one system, which is how we know a .bin is a PS1 track and not a Genesis cart.`,
      }),
      state.workspace?.romsRoot
        ? h('div', { class: 'browser-path', text: state.workspace.romsRoot })
        : null,
      sources,
      looseWarning(ctx),
      strayWarning(state),
      h(
        'div',
        { style: { display: 'flex', gap: '10px', marginTop: '18px', flexWrap: 'wrap' } },
        h('button', {
          class: 'btn btn-primary',
          nav: true,
          text: '+  Add ROM folder',
          onClick: async () => {
            if (await addSourceFlow(state)) refresh();
          },
        }),
        h('button', {
          class: 'btn',
          nav: true,
          text: 'Rescan now',
          onClick: async () => {
            await rescan();
            refresh();
          },
        }),
        h('button', {
          class: 'btn btn-ghost',
          nav: true,
          text: 'Rebuild roms/ folders',
          onClick: async () => {
            try {
              const result = await api.reconcileWorkspace();
              reportWorkspaceChanges(result);
              if (!result.created.length && !result.removed.length) {
                toast.info('roms/ already matches your emulators.');
              }
              await rescan();
              refresh();
            } catch (err) {
              toast.error(err.message);
            }
          },
        }),
      ),
      settingToggle(ctx, 'autoOrganize', 'File stray ROMs automatically',
        'On every scan, a ROM sitting loose in roms/ is moved into its system folder, creating the folder if needed. Disc images are identified by reading their header, so a .bin or .cue gets filed too. Anything unidentifiable is left alone and listed above.'),
      h('p', {
        class: 'field-hint',
        style: { marginTop: '14px' },
        text: `${state.games.length} games · last scanned ${fmtRelative(state.scannedAt)}`,
      }),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Box art' }),
      h('p', {
        class: 'panel-note',
        text: 'Download covers for your games and icons for your consoles, or point at an image collection you already have (a LaunchBox or ES-DE images folder works) and art is matched by filename.',
      }),

      // The only button in the app that reaches the network, and only when pressed.
      h(
        'div',
        { class: 'row-actions', style: { marginBottom: '18px' } },
        h('button', {
          class: 'btn btn-primary',
          nav: true,
          'data-nav-key': 'fetch-art',
          text: '↓  Download artwork',
          title: 'Fetches covers for games that have none, plus a console icon per system',
          onClick: () => startArtFetch({}),
        }),
        h('button', {
          class: 'btn',
          nav: true,
          'data-nav-key': 'fetch-art-force',
          text: 'Re-download everything',
          title: 'Replaces art you already have, including hand-assigned covers',
          onClick: async () => {
            const ok = await confirmModal({
              title: 'Re-download all artwork?',
              note: 'This replaces every downloaded cover, including any you assigned by hand. Games with no match keep whatever they have.',
              confirmLabel: 'Re-download',
            });
            if (ok) startArtFetch({ force: true });
          },
        }),
      ),
      h('p', {
        class: 'field-hint',
        style: { marginTop: '-8px', marginBottom: '16px' },
        text: 'Covers come from the libretro thumbnail archive, matched on your ROM filenames; console icons from retroarch-assets (CC BY 4.0). This is the one thing in the app that uses the network, and only when you press it. The same job runs from a terminal as  npm run fetch-art',
      }),

      artDirs,
      h('button', {
        class: 'btn',
        nav: true,
        style: { marginTop: artDirs ? '14px' : '0' },
        text: '+  Add art folder',
        onClick: async () => {
          const folder = await browseModal({
            kind: 'folder',
            title: 'Add a box art folder',
            nativeDialogs: !!state.capabilities?.nativeDialogs,
          });
          if (!folder) return;
          try {
            await api.addArtDir(folder);
            await rescan();
            refresh();
          } catch (err) {
            toast.error(err.message);
          }
        },
      }),
    ),
    // Last, because it is a setup decision rather than a daily one.
    libraryLocationPanel(ctx),
  );
}

/**
 * ROMs dropped straight into roms/ rather than into a system folder. Dropping a
 * file there is the obvious thing to do and the one thing that silently fails,
 * so it gets a prominent row and a one-click fix.
 */
function looseWarning(ctx) {
  const { state, refresh } = ctx;
  const loose = state.workspace?.loose || [];
  const misfiled = state.workspace?.misfiled || [];
  if (!loose.length && !misfiled.length) return null;

  const sortable = [
    ...loose.filter((f) => f.sortable),
    ...misfiled.map((f) => ({ name: f.name, folder: f.folder, sortable: true })),
  ];

  return h(
    'div',
    { class: 'rowlist', style: { marginTop: '14px' } },
    h(
      'div',
      {
        class: 'listrow',
        style: { borderColor: 'color-mix(in oklab, var(--accent) 55%, transparent)' },
      },
      h(
        'div',
        { class: 'listrow-main' },
        h('div', { class: 'listrow-title' }, h('span', {
          text: sortable.length
            ? `${sortable.length} file${sortable.length === 1 ? '' : 's'} to file away`
            : `${loose.length} file${loose.length === 1 ? '' : 's'} that need filing by hand`,
        })),
        h('div', {
          class: 'field-hint',
          text: sortable.length
            ? state.settings.autoOrganize
              ? `Filed automatically on the next scan: ${sortable
                  .map((f) => `${f.name} → ${f.folder}/`)
                  .slice(0, 3)
                  .join(', ')}${sortable.length > 3 ? '…' : ''}`
              : `Auto-filing is off, so these are staying put: ${sortable
                  .map((f) => `${f.name} → ${f.folder}/`)
                  .slice(0, 3)
                  .join(', ')}${sortable.length > 3 ? '…' : ''}`
            : 'None of these can be placed automatically — see below.',
        }),
        ...loose
          .filter((f) => !f.sortable)
          .map((f) => h('div', { class: 'field-hint', text: `${f.name} — ${f.reason}` })),
      ),
      sortable.length
        ? h('button', {
            class: 'btn btn-sm btn-primary',
            nav: true,
            'data-nav-key': 'sort-loose',
            text: 'File them now',
            onClick: async () => {
              const yes = await confirmModal({
                title: 'File these into their system folders?',
                note: sortable.map((f) => `${f.name}  →  roms/${f.folder}/`).join('\n'),
                confirmLabel: 'Move them',
              });
              if (!yes) return;
              try {
                const result = await api.organizeWorkspace();
                reportOrganized(result);
                await rescan();
                refresh();
              } catch (err) {
                toast.error(err.message);
              }
            },
          })
        : h('div', {}),
    ),
  );
}

/**
 * Folders sitting in roms/ that nothing can play — either a name we don't
 * recognise, or a system whose emulator went away while games were still in it.
 * Worth surfacing, because from the user's side it just looks like their games
 * vanished.
 */
function strayWarning(state) {
  const strays = state.workspace?.strays || [];
  if (!strays.length) return null;

  return h(
    'div',
    { class: 'rowlist', style: { marginTop: '14px' } },
    ...strays.map((stray) =>
      h(
        'div',
        {
          class: 'listrow',
          style: { borderColor: 'color-mix(in oklab, var(--gold) 40%, transparent)' },
        },
        h(
          'div',
          { class: 'listrow-main' },
          h(
            'div',
            { class: 'listrow-title' },
            h('span', { style: { color: 'var(--gold)' }, text: '!' }),
            h('span', { text: `roms/${stray.name}` }),
          ),
          h('div', {
            class: 'field-hint',
            text: stray.platform
              ? 'Has files, but no emulator can play this system yet. Add one and they appear.'
              : "Not a system name EmuSteam knows, so it is not being scanned. Rename it to match a system, or add it as a ROM folder manually.",
          }),
        ),
        h('div', {}),
      ),
    ),
  );
}

// ----------------------------------------------------------------- emulators

function emulatorsPanel(ctx) {
  const { state, refresh } = ctx;

  const list = state.emulators.length
    ? h(
        'div',
        { class: 'rowlist' },
        ...state.emulators.map((emu) =>
          h(
            'div',
            { class: 'listrow' },
            h(
              'div',
              { class: 'listrow-main' },
              h(
                'div',
                { class: 'listrow-title' },
                h('span', { text: emu.name }),
                emu.exists ? null : h('span', { class: 'chip pill-bad', text: 'Not found' }),
                emu.libretro ? h('span', { class: 'chip', text: 'libretro' }) : null,
              ),
              h('div', { class: 'listrow-sub', text: emu.absExe }),
              h('div', {
                class: 'field-hint',
                style: { marginTop: '4px' },
                text: emu.platforms.length
                  ? emu.platforms
                      .map((id) => state.allPlatforms.find((p) => p.id === id)?.short || id)
                      .join(' · ')
                  : 'No systems assigned',
              }),
            ),
            h(
              'div',
              { class: 'listrow-actions' },
              h('button', {
                class: 'btn btn-sm',
                nav: true,
                'data-nav-key': `emu-edit-${emu.id}`,
                text: 'Edit',
                onClick: async () => {
                  if (await editEmulatorFlow(state, emu)) refresh();
                },
              }),
              h('button', {
                class: 'btn btn-sm btn-danger',
                nav: true,
                'data-nav-key': `emu-del-${emu.id}`,
                text: 'Remove',
                onClick: async () => {
                  const yes = await confirmModal({
                    title: `Remove ${emu.name}?`,
                    note: 'The program stays installed; EmuSteam just stops using it.',
                    confirmLabel: 'Remove',
                    danger: true,
                  });
                  if (!yes) return;
                  try {
                    await api.removeEmulator(emu.id);
                    refresh();
                  } catch (err) {
                    toast.error(err.message);
                  }
                },
              }),
            ),
          ),
        ),
      )
    : h('div', {
        class: 'panel-note',
        text: 'No emulators yet. Add one and common ones are recognised and configured automatically.',
      });

  return h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'panel-title', text: 'Emulators' }),
    h('p', {
      class: 'panel-note',
      text: 'Point at the .exe. Project64, RetroArch, Dolphin, DuckStation, PCSX2, mGBA, melonDS and ~30 others come with launch arguments pre-filled.',
    }),
    list,
    h('button', {
      class: 'btn btn-primary',
      nav: true,
      style: { marginTop: '18px' },
      text: '+  Add emulator',
      onClick: async () => {
        if (await addEmulatorFlow(state)) refresh();
      },
    }),
  );
}

// ------------------------------------------------------------------- systems

function systemsPanel(ctx) {
  const { state, refresh } = ctx;

  if (!state.platforms.length) {
    return h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Systems' }),
      h('p', { class: 'panel-note', text: 'Systems appear here once a scan finds games for them.' }),
    );
  }

  return h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'panel-title', text: 'Systems' }),
    h('p', {
      class: 'panel-note',
      text: 'Which emulator runs each system, and for RetroArch which core it loads.',
    }),
    h(
      'div',
      { class: 'rowlist' },
      ...state.platforms
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((platform) => {
          const emulator = state.emulators.find((e) => e.id === platform.defaultEmulator);
          return h(
            'div',
            { class: 'platform-wire' },
            h(
              'div',
              {},
              h('div', { class: 'platform-wire-name', text: platform.short }),
              h('div', { class: 'field-hint', text: `${platform.gameCount} games` }),
            ),
            h('button', {
              class: ['btn', 'btn-sm', emulator ? '' : 'btn-danger'],
              nav: true,
              'data-nav-key': `sys-emu-${platform.id}`,
              text: emulator ? emulator.name : 'Choose emulator',
              onClick: async () => {
                if (await pickPlatformEmulatorFlow(state, platform)) refresh();
              },
            }),
            platform.needsCore
              ? h('button', {
                  class: 'btn btn-sm btn-ghost',
                  nav: true,
                  'data-nav-key': `sys-core-${platform.id}`,
                  text: platform.core ? platform.core.replace(/_libretro$/, '') : 'Choose core',
                  onClick: async () => {
                    if (await pickCoreFlow(state, platform)) refresh();
                  },
                })
              : h('div', { class: 'field-hint', text: '—' }),
          );
        }),
    ),
  );
}


// --------------------------------------------------------------- controller

/**
 * Live controller test.
 *
 * Gamepad support is the one thing that can't be verified from the outside —
 * every pad reports itself differently, and a DirectInput pad numbers its
 * buttons differently from an XInput one. Rather than guess, this shows exactly
 * what the browser reports and which action each button is bound to, so a pad
 * that misbehaves can be diagnosed by looking at it.
 *
 * Reads the pads on a timer rather than piggybacking the main input loop, so it
 * keeps working even if that loop is starved.
 */
function controllerPanel() {
  const status = h('div', { class: 'panel-note' });
  const buttonList = h('div', { class: 'rowlist' });
  const axisList = h('div', { class: 'rowlist' });
  const lastAction = h('div', { class: 'chip chip-strong', text: 'waiting…' });

  const host = h(
    'div',
    {},
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Controller test' }),
      status,
      h(
        'div',
        { class: 'listrow', style: { marginBottom: '18px' } },
        h(
          'div',
          { class: 'listrow-main' },
          h('div', { class: 'listrow-title', text: 'Last action received' }),
          h('div', { class: 'field-hint', text: 'Press a button. If nothing appears here, the app is not seeing your pad.' }),
        ),
        lastAction,
      ),
      h('div', { class: 'fact-k', style: { marginBottom: '8px' }, text: 'Buttons' }),
      buttonList,
      h('div', { class: 'fact-k', style: { margin: '20px 0 8px' }, text: 'Sticks' }),
      axisList,
    ),
  );

  // Mirror the real input stream so the panel reports what the app acted on,
  // not merely what the hardware sent.
  const stop = onAction((action, meta) => {
    if (!host.isConnected) {
      stop();
      return;
    }
    lastAction.textContent = `${action}  ·  ${meta.source}${meta.repeat ? ' (repeat)' : ''}`;
  });

  const timer = setInterval(() => {
    if (!host.isConnected) {
      clearInterval(timer);
      stop();
      return;
    }

    const pads = [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
    if (!pads.length) {
      status.textContent =
        'No controller detected. Plug one in and press a button — browsers hide gamepads until they see input. Keyboard and mouse work regardless.';
      buttonList.replaceChildren();
      axisList.replaceChildren();
      return;
    }

    const pad = pads[0];
    status.textContent = `${pad.id} — ${pad.buttons.length} buttons, ${pad.axes.length} axes, mapping "${pad.mapping || 'non-standard'}".${
      pad.mapping === 'standard'
        ? ''
        : ' Non-standard mapping: the button numbers below may not match the labels, which is worth telling me about.'
    }`;

    buttonList.replaceChildren(
      ...pad.buttons.map((button, index) => {
        const pressed = button.pressed || button.value > 0.6;
        const action = BUTTON_ACTIONS[index];
        return h(
          'div',
          {
            class: 'listrow',
            style: pressed ? { borderColor: 'var(--accent)', background: 'var(--panel-3)' } : null,
          },
          h(
            'div',
            { class: 'listrow-main' },
            h(
              'div',
              { class: 'listrow-title' },
              h('span', { text: `${index}` }),
              h('span', { class: 'dim', text: BUTTON_NAMES[index] || 'unnamed' }),
            ),
            h('div', {
              class: 'field-hint',
              text: action ? `bound to "${action}"` : 'not bound to anything',
            }),
          ),
          h('div', { class: pressed ? 'chip chip-strong' : 'chip', text: pressed ? 'PRESSED' : '—' }),
        );
      }),
    );

    const axisNames = ['Left stick X', 'Left stick Y', 'Right stick X', 'Right stick Y'];
    axisList.replaceChildren(
      ...pad.axes.slice(0, 4).map((value, index) =>
        h(
          'div',
          { class: 'listrow' },
          h('div', { class: 'listrow-main' }, h('div', { class: 'listrow-title', text: axisNames[index] || `Axis ${index}` })),
          h('div', {
            class: Math.abs(value) > 0.55 ? 'chip chip-strong' : 'chip',
            text: value.toFixed(2),
          }),
        ),
      ),
    );
  }, 80);

  return host;
}

// -------------------------------------------------------------- look & feel

function lookPanel(ctx) {
  const { state, refresh } = ctx;

  const toggle = (key, label, note) => settingToggle(ctx, key, label, note);

  return h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'panel-title', text: 'Look & feel' }),
    h(
      'div',
      { class: 'rowlist' },
      h(
        'button',
        {
          class: 'toggle',
          nav: true,
          'data-nav-key': 'set-sort',
          onClick: async () => {
            const picked = await chooseModal({
              title: 'Default sort order',
              options: Object.entries(SORTS).map(([id, sort]) => ({
                id,
                title: sort.label,
                selected: id === state.settings.sort,
              })),
            });
            if (!picked) return;
            try {
              await api.saveSettings({ sort: picked });
              refresh({ keepFocus: true });
            } catch (err) {
              toast.error(err.message);
            }
          },
        },
        h(
          'div',
          {},
          h('div', { class: 'toggle-label', text: 'Sort games by' }),
          h('div', { class: 'toggle-note', text: 'Press X in any grid to cycle this quickly.' }),
        ),
        h('div', { class: 'chip chip-strong', text: SORTS[state.settings.sort]?.label || 'Name' }),
      ),
      toggle('showHidden', 'Show hidden games', 'Games you hid from the game page reappear in every grid.'),
      toggle('scanOnStart', 'Scan on startup', 'Picks up newly added ROMs without you asking.'),
      toggle('clock', 'Show the clock', 'Top right corner.'),
      toggle('reduceMotion', 'Reduce motion', 'Turns off card scaling and smooth scrolling.'),
    ),
  );
}

// --------------------------------------------------------------------- about

function aboutPanel(ctx) {
  const { state } = ctx;
  const caps = state.capabilities || {};

  const row = (key, value) =>
    h(
      'div',
      { class: 'fact' },
      h('div', { class: 'fact-k', text: key }),
      h('div', { class: 'fact-v small', text: value }),
    );

  const keyRow = (keys, action) =>
    h(
      'div',
      { class: 'listrow' },
      h('div', { class: 'listrow-main' }, h('div', { class: 'listrow-title', text: action })),
      h('div', { class: 'chip mono', text: keys }),
    );

  return h(
    'div',
    {},
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Controls' }),
      h('p', {
        class: 'panel-note',
        text: 'Gamepad, keyboard and mouse all work at once. If a controller button does nothing, the Controller tab shows exactly what the app is receiving from your pad.',
      }),
      h(
        'div',
        { class: 'rowlist' },
        keyRow('D-pad / stick / arrows / WASD', 'Move'),
        keyRow('A / Enter / Space', 'Select or play'),
        keyRow('B / Esc / Backspace', 'Back — always outward, never back into where you just were'),
        keyRow('Y / F', 'Favourite the highlighted game'),
        keyRow('X / E', 'More options, or cycle sort in a grid'),
        keyRow('Back button / /', 'Search'),
        keyRow('Start / ,', 'Settings'),
      ),
    ),
    h(
      'section',
      { class: 'panel' },
      h('h2', { class: 'panel-title', text: 'Sharing this setup' }),
      h('p', {
        class: 'panel-note',
        text: 'Paths inside the app folder are stored relative, so if you keep emulators and ROMs in subfolders you can zip the whole thing, hand it to someone, and it runs as-is. Everything mutable lives in data/.',
      }),
      h(
        'div',
        { class: 'factgrid' },
        row('App folder', caps.appRoot || '—'),
        row('Data folder', caps.dataRoot || '—'),
        row('Platform', caps.platform || '—'),
        row('System file dialogs', caps.nativeDialogs ? 'Available' : 'Using the built-in browser'),
        row('Games in library', String(state.games.length)),
        row('Last scan', fmtRelative(state.scannedAt)),
      ),
    ),
    state.warnings?.length
      ? h(
          'section',
          { class: 'panel' },
          h('h2', { class: 'panel-title', text: 'Last scan warnings' }),
          h(
            'div',
            { class: 'rowlist' },
            ...state.warnings.map((warning) =>
              h('div', { class: 'listrow' }, h('div', { class: 'listrow-main' }, h('div', { class: 'listrow-sub', text: warning }))),
            ),
          ),
        )
      : null,
  );
}

/**
 * Where roms/ and emulators/ live.
 *
 * Normally inside the app folder, which is what makes the whole thing portable.
 * Pointing it at a shared drive is how several Windows accounts use one library:
 * each keeps its own copy of the app and its own saves, favourites and play time,
 * while the games exist once.
 *
 * Changing it never moves anything. Relocating gigabytes is the user's decision,
 * and doing it as a side effect of a settings change would be indefensible.
 */
function libraryLocationPanel(ctx) {
  const { state, refresh } = ctx;
  const caps = state.capabilities || {};
  const root = caps.libraryRoot || caps.appRoot || '';
  const isDefault = caps.libraryIsDefault !== false;
  const fixedByEnv = caps.libraryRootSource === 'env';

  const setLocation = async (folder) => {
    try {
      const res = await api.setLibraryLocation(folder);
      await confirmModal({
        title: 'Restart EmuSteam to finish',
        note: `The library will be read from:\n\n${res.libraryRoot}\n\n`
          + 'Nothing was moved — your existing games are still where they were. Close and '
          + 'reopen EmuSteam for the change to take effect, then import or copy your games '
          + 'into the new location.',
        confirmLabel: 'Got it',
        cancelLabel: 'Close',
      });
      refresh({ keepFocus: true });
    } catch (err) {
      toast.error(err.message);
    }
  };

  return h(
    'section',
    { class: 'panel' },
    h('h2', { class: 'panel-title', text: 'Where the games live' }),
    h('p', {
      class: 'panel-note',
      text: isDefault
        ? 'Your games and emulators live inside the EmuSteam folder, which keeps the whole thing portable — zip it, hand it to someone, it still works. Point it somewhere else to share one library between several Windows accounts.'
        : 'Your games and emulators live outside the EmuSteam folder. Several installs can point at this same location and share it; each keeps its own saves, favourites and play time.',
    }),

    h(
      'div',
      { class: 'listrow' },
      h(
        'div',
        { class: 'listrow-main' },
        h(
          'div',
          { class: 'listrow-title' },
          h('span', { text: 'Library folder' }),
          isDefault
            ? h('span', { class: 'chip', text: 'in the app folder' })
            : h('span', { class: 'chip pill-good', text: 'shared' }),
          fixedByEnv ? h('span', { class: 'chip', text: 'set by EMUSTEAM_WORKSPACE' }) : null,
        ),
        // Show where games actually land, not just the root you picked. EmuSteam
        // creates roms/ and emulators/ *inside* it, and "why is there a roms
        // folder in my folder" is the first question that gets asked otherwise.
        h('div', { class: 'listrow-sub', text: root }),
        h('div', {
          class: 'field-hint',
          style: { marginTop: '6px' },
          text: `Games go in ${caps.romsRoot || `${root}\\roms`} — importing, dragging, and copying files there by hand all end up in the same place.`,
        }),
      ),
      fixedByEnv
        ? h('span', { class: 'field-hint', text: 'Unset the variable to change it here' })
        : h(
            'div',
            { class: 'listrow-actions' },
            h('button', {
              class: 'btn btn-sm',
              nav: true,
              'data-nav-key': 'lib-change',
              text: 'Change…',
              onClick: async () => {
                const folder = await browseModal({
                  kind: 'folder',
                  title: 'Where should the games live?',
                  nativeDialogs: !!state.capabilities?.nativeDialogs,
                });
                if (folder) await setLocation(folder);
              },
            }),
            isDefault
              ? null
              : h('button', {
                  class: 'btn btn-sm btn-ghost',
                  nav: true,
                  'data-nav-key': 'lib-reset',
                  text: 'Use the app folder',
                  onClick: () => setLocation(''),
                }),
          ),
    ),

    h('p', {
      class: 'field-hint',
      style: { marginTop: '14px' },
      text: 'Saves, save states, favourites and play time always stay in this install’s own data/ folder, never in the shared one — so two people sharing a library still have separate progress.',
    }),
  );
}
