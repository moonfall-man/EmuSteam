// Known-emulator presets. When you point EmuSteam at an .exe we match on the
// filename and pre-fill the launch arguments + supported platforms, so "import
// emulator" is usually two clicks instead of reading a man page.
//
// Argument templates support these tokens (substituted after tokenisation, so
// paths with spaces stay a single argv entry):
//
//   {rom}      full path to the ROM
//   {romDir}   directory containing the ROM
//   {romFile}  filename with extension
//   {romName}  filename without extension
//   {core}     resolved RetroArch core path (libretro emulators only)
//   {platform} platform id

export const PRESETS = [
  {
    match: ['retroarch'],
    name: 'RetroArch',
    args: '-L "{core}" -f "{rom}"',
    libretro: true,
    platforms: null, // libretro: derived from the core list of every platform
    notes: 'Uses the per-platform libretro core. Set the core in the platform row below.',
  },
  {
    match: ['project64'],
    name: 'Project64',
    args: '"{rom}"',
    platforms: ['n64'],
  },
  {
    match: ['mupen64plus-gui', 'mupen64plus'],
    name: 'Mupen64Plus',
    args: '--fullscreen "{rom}"',
    platforms: ['n64'],
  },
  {
    match: ['simple64-gui', 'simple64'],
    name: 'simple64',
    args: '--nogui "{rom}"',
    platforms: ['n64'],
  },
  {
    match: ['ares'],
    name: 'ares',
    args: '--fullscreen "{rom}"',
    platforms: ['n64', 'snes', 'nes', 'gb', 'gbc', 'gba', 'genesis', 'mastersystem', 'gamegear', 'pcengine', 'ngp', 'wonderswan', 'msx'],
  },
  {
    match: ['snes9x-x64', 'snes9x'],
    name: 'Snes9x',
    args: '-fullscreen "{rom}"',
    platforms: ['snes'],
  },
  {
    match: ['bsnes'],
    name: 'bsnes',
    args: '--fullscreen "{rom}"',
    platforms: ['snes'],
  },
  {
    match: ['mesen'],
    name: 'Mesen',
    args: '"{rom}"',
    platforms: ['nes', 'snes', 'gb', 'gbc', 'pcengine'],
  },
  {
    match: ['fceux'],
    name: 'FCEUX',
    args: '-fullscreen 1 "{rom}"',
    platforms: ['nes'],
  },
  {
    match: ['mgba'],
    name: 'mGBA',
    args: '-f "{rom}"',
    platforms: ['gba', 'gb', 'gbc'],
  },
  {
    match: ['visualboyadvance-m', 'visualboyadvance'],
    name: 'VisualBoyAdvance-M',
    args: '-f "{rom}"',
    platforms: ['gba', 'gb', 'gbc'],
  },
  {
    match: ['melonds'],
    name: 'melonDS',
    args: '-f "{rom}"',
    platforms: ['nds'],
  },
  {
    match: ['desmume'],
    name: 'DeSmuME',
    args: '"{rom}"',
    platforms: ['nds'],
  },
  {
    match: ['azahar', 'lime3ds', 'citra-qt', 'citra'],
    name: 'Azahar / Citra',
    args: '"{rom}"',
    platforms: ['3ds'],
  },
  {
    match: ['dolphin'],
    name: 'Dolphin',
    args: '-b -e "{rom}"',
    platforms: ['gamecube', 'wii'],
  },
  {
    match: ['cemu'],
    name: 'Cemu',
    args: '-f -g "{rom}"',
    platforms: ['wiiu'],
  },
  {
    match: ['ryujinx', 'sudachi', 'yuzu'],
    name: 'Switch emulator',
    args: '-f "{rom}"',
    platforms: ['switch'],
  },
  {
    match: ['duckstation-qt-x64', 'duckstation-nogui-x64', 'duckstation'],
    name: 'DuckStation',
    args: '-fullscreen -- "{rom}"',
    platforms: ['psx'],
  },
  {
    match: ['pcsx2-qt', 'pcsx2x64', 'pcsx2'],
    name: 'PCSX2',
    args: '-fullscreen -batch -- "{rom}"',
    platforms: ['ps2'],
  },
  {
    match: ['rpcs3'],
    name: 'RPCS3',
    args: '--no-gui "{rom}"',
    platforms: ['ps3'],
  },
  {
    match: ['ppssppwindows64', 'ppssppwindows', 'ppsspp'],
    name: 'PPSSPP',
    args: '--fullscreen "{rom}"',
    platforms: ['psp'],
  },
  {
    match: ['vita3k'],
    name: 'Vita3K',
    args: '-r "{romName}"',
    platforms: ['psvita'],
  },
  {
    match: ['flycast', 'redream'],
    name: 'Flycast / Redream',
    args: '"{rom}"',
    platforms: ['dreamcast'],
  },
  {
    match: ['kega', 'fusion'],
    name: 'Kega Fusion',
    args: '"{rom}" -fullscreen',
    platforms: ['genesis', 'segacd', 'sega32x', 'mastersystem', 'gamegear'],
  },
  {
    match: ['mednafen'],
    name: 'Mednafen',
    args: '"{rom}"',
    platforms: ['psx', 'saturn', 'pcengine', 'pcenginecd', 'virtualboy', 'ngp', 'wonderswan', 'lynx', 'nes', 'snes', 'gb', 'gbc', 'gba'],
  },
  {
    match: ['ssf'],
    name: 'SSF',
    args: '"{rom}"',
    platforms: ['saturn'],
  },
  {
    match: ['mame'],
    name: 'MAME',
    args: '-rompath "{romDir}" "{romName}"',
    platforms: ['arcade', 'neogeo'],
  },
  {
    match: ['fbneo', 'fbalpha'],
    name: 'FinalBurn Neo',
    args: '"{rom}"',
    platforms: ['arcade', 'neogeo'],
  },
  {
    match: ['stella'],
    name: 'Stella',
    args: '-fullscreen 1 "{rom}"',
    platforms: ['atari2600'],
  },
  {
    match: ['dosbox-x', 'dosbox-staging', 'dosbox'],
    name: 'DOSBox',
    args: '-fullscreen -conf "{rom}"',
    platforms: ['dos'],
  },
  {
    match: ['scummvm'],
    name: 'ScummVM',
    args: '-f -p "{romDir}" --auto-detect',
    platforms: ['scummvm'],
  },
  {
    match: ['bizhawk', 'emuhawk'],
    name: 'BizHawk',
    args: '"{rom}"',
    platforms: ['n64', 'snes', 'nes', 'gb', 'gbc', 'gba', 'genesis', 'segacd', 'sega32x', 'mastersystem', 'gamegear', 'psx', 'saturn', 'pcengine', 'atari2600', 'atari7800', 'lynx', 'ngp', 'wonderswan', 'virtualboy'],
  },
  {
    match: ['vice', 'x64sc', 'x64'],
    name: 'VICE',
    args: '-fullscreen "{rom}"',
    platforms: ['c64'],
  },
  {
    match: ['fs-uae', 'winuae'],
    name: 'FS-UAE / WinUAE',
    args: '"{rom}"',
    platforms: ['amiga'],
  },
];

/**
 * Best-effort preset lookup from an executable path.
 * Longest match wins so `duckstation-qt-x64` beats a bare `duckstation` entry.
 */
export function findPreset(exePath) {
  const base = String(exePath || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.(exe|app|appimage|sh|bat|cmd)$/i, '')
    .toLowerCase();
  if (!base) return null;

  let best = null;
  let bestLen = 0;
  for (const preset of PRESETS) {
    for (const needle of preset.match) {
      if (base.includes(needle) && needle.length > bestLen) {
        best = preset;
        bestLen = needle.length;
      }
    }
  }
  return best;
}

/** Shared-library suffix for RetroArch cores on the current OS. */
export function coreExtension() {
  if (process.platform === 'win32') return '.dll';
  if (process.platform === 'darwin') return '.dylib';
  return '.so';
}
