// The platform catalogue. This is deliberately data, not code: adding a system
// means adding a row here, and the whole UI (rails, tiles, scanner, presets)
// picks it up automatically.
//
//   id       stable key used in config + library records — never rename
//   short    what fits on a tile ("N64")
//   folder   roms/ subfolder name, when `short` would be cryptic as a directory
//   exts     extensions the scanner accepts for a folder assigned to this platform
//   shadow   secondary disc files to hide when a container file (.cue/.m3u/.gdi) sits beside them
//   cores    RetroArch core basenames, best-first — used by the emulator presets
//   tint     [from, to] gradient used for generated art and platform tiles

export const PLATFORMS = [
  {
    id: 'n64', name: 'Nintendo 64', short: 'N64', maker: 'Nintendo', year: 1996,
    exts: ['.z64', '.n64', '.v64', '.rom', '.ndd', '.zip', '.7z'],
    cores: ['mupen64plus_next_libretro', 'parallel_n64_libretro'],
    tint: ['#3b2f7a', '#7a2f5c'],
  },
  {
    id: 'snes', name: 'Super Nintendo', short: 'SNES', maker: 'Nintendo', year: 1990,
    exts: ['.sfc', '.smc', '.swc', '.fig', '.bs', '.st', '.zip', '.7z'],
    cores: ['snes9x_libretro', 'bsnes_libretro', 'mesen-s_libretro'],
    tint: ['#4b3f8f', '#8f3f6a'],
  },
  {
    id: 'nes', name: 'Nintendo Entertainment System', short: 'NES', maker: 'Nintendo', year: 1983,
    exts: ['.nes', '.fds', '.unf', '.unif', '.nsf', '.zip', '.7z'],
    cores: ['mesen_libretro', 'nestopia_libretro', 'fceumm_libretro'],
    tint: ['#8f2f2f', '#4a2020'],
  },
  {
    id: 'gb', name: 'Game Boy', short: 'GB', maker: 'Nintendo', year: 1989,
    exts: ['.gb', '.zip', '.7z'],
    cores: ['gambatte_libretro', 'mgba_libretro', 'sameboy_libretro'],
    tint: ['#5d7a3b', '#2f3b20'],
  },
  {
    id: 'gbc', name: 'Game Boy Color', short: 'GBC', maker: 'Nintendo', year: 1998,
    exts: ['.gbc', '.cgb', '.zip', '.7z'],
    cores: ['gambatte_libretro', 'mgba_libretro', 'sameboy_libretro'],
    tint: ['#8f4a2f', '#3b2f6a'],
  },
  {
    id: 'gba', name: 'Game Boy Advance', short: 'GBA', maker: 'Nintendo', year: 2001,
    exts: ['.gba', '.agb', '.zip', '.7z'],
    cores: ['mgba_libretro', 'vba_next_libretro'],
    tint: ['#4b3fa0', '#7a2f8f'],
  },
  {
    id: 'nds', name: 'Nintendo DS', short: 'DS', maker: 'Nintendo', year: 2004,
    exts: ['.nds', '.dsi', '.ids', '.zip', '.7z'],
    cores: ['melonds_libretro', 'desmume_libretro'],
    tint: ['#2f6a8f', '#1f2f4a'],
  },
  {
    id: '3ds', name: 'Nintendo 3DS', short: '3DS', maker: 'Nintendo', year: 2011,
    exts: ['.3ds', '.cci', '.cxi', '.cia', '.app'],
    cores: ['citra_libretro'],
    tint: ['#8f2f4a', '#2f2f5c'],
  },
  {
    id: 'gamecube', name: 'Nintendo GameCube', short: 'GameCube', maker: 'Nintendo', year: 2001,
    exts: ['.rvz', '.gcm', '.gcz', '.iso', '.ciso', '.dol', '.elf'],
    discBased: true,
    cores: ['dolphin_libretro'],
    tint: ['#4a3f8f', '#2a2360'],
  },
  {
    id: 'wii', name: 'Nintendo Wii', short: 'Wii', maker: 'Nintendo', year: 2006,
    exts: ['.rvz', '.wbfs', '.wad', '.iso', '.ciso', '.wia'],
    discBased: true,
    cores: ['dolphin_libretro'],
    tint: ['#3f7a9f', '#1f3a52'],
  },
  {
    id: 'wiiu', name: 'Nintendo Wii U', short: 'Wii U', maker: 'Nintendo', year: 2012,
    exts: ['.wud', '.wux', '.wua', '.rpx', '.iso'],
    discBased: true,
    cores: [],
    tint: ['#2f7a8f', '#1a3f4a'],
  },
  {
    id: 'switch', name: 'Nintendo Switch', short: 'Switch', maker: 'Nintendo', year: 2017,
    exts: ['.nsp', '.xci', '.nca', '.nro'],
    cores: [],
    tint: ['#8f2f2f', '#2f5c8f'],
  },
  {
    id: 'virtualboy', name: 'Virtual Boy', short: 'Virtual Boy', maker: 'Nintendo', year: 1995,
    exts: ['.vb', '.vboy', '.zip'],
    cores: ['mednafen_vb_libretro'],
    tint: ['#8f1f1f', '#2a0a0a'],
  },
  {
    id: 'psx', name: 'Sony PlayStation', short: 'PS1', maker: 'Sony', year: 1994,
    exts: ['.m3u', '.chd', '.cue', '.pbp', '.ecm', '.iso', '.bin', '.img'],
    shadow: ['.bin', '.img', '.iso', '.raw', '.sub', '.ccd'],
    discBased: true,
    cores: ['swanstation_libretro', 'mednafen_psx_hw_libretro', 'pcsx_rearmed_libretro'],
    tint: ['#3a3a4f', '#16161f'],
  },
  {
    id: 'ps2', name: 'Sony PlayStation 2', short: 'PS2', maker: 'Sony', year: 2000,
    exts: ['.m3u', '.chd', '.iso', '.cso', '.zso', '.gz', '.bin', '.cue'],
    shadow: ['.bin', '.img'],
    discBased: true,
    cores: ['pcsx2_libretro'],
    tint: ['#1f2f6a', '#0d1230'],
  },
  {
    id: 'ps3', name: 'Sony PlayStation 3', short: 'PS3', maker: 'Sony', year: 2006,
    exts: ['.self', '.elf', '.bin', '.pkg'],
    cores: [],
    tint: ['#23283f', '#0a0c14'],
  },
  {
    id: 'psp', name: 'Sony PlayStation Portable', short: 'PSP', maker: 'Sony', year: 2004,
    exts: ['.iso', '.cso', '.chd', '.pbp', '.elf'],
    discBased: true,
    cores: ['ppsspp_libretro'],
    tint: ['#2a2a3f', '#4a2f6a'],
  },
  {
    id: 'psvita', name: 'PlayStation Vita', short: 'Vita', maker: 'Sony', year: 2011,
    exts: ['.vpk', '.zip'],
    cores: [],
    tint: ['#1f3a5c', '#0d1626'],
  },
  {
    id: 'genesis', name: 'Sega Genesis / Mega Drive', short: 'Genesis', maker: 'Sega', year: 1988,
    exts: ['.md', '.gen', '.smd', '.68k', '.bin', '.zip', '.7z'],
    cores: ['genesis_plus_gx_libretro', 'picodrive_libretro'],
    tint: ['#1f5c8f', '#0d2440'],
  },
  {
    id: 'segacd', name: 'Sega CD / Mega CD', short: 'Sega CD', maker: 'Sega', year: 1991,
    exts: ['.m3u', '.chd', '.cue', '.iso'],
    shadow: ['.bin', '.img'],
    discBased: true,
    cores: ['genesis_plus_gx_libretro', 'picodrive_libretro'],
    tint: ['#2f4a8f', '#12203f'],
  },
  {
    id: 'sega32x', name: 'Sega 32X', short: '32X', maker: 'Sega', year: 1994,
    exts: ['.32x', '.bin', '.zip'],
    cores: ['picodrive_libretro'],
    tint: ['#5c2f8f', '#20123f'],
  },
  {
    id: 'saturn', name: 'Sega Saturn', short: 'Saturn', maker: 'Sega', year: 1994,
    exts: ['.m3u', '.chd', '.cue', '.ccd', '.mds', '.iso'],
    shadow: ['.bin', '.img', '.sub', '.mdf'],
    discBased: true,
    cores: ['mednafen_saturn_libretro', 'yabause_libretro'],
    tint: ['#2f2f4a', '#101018'],
  },
  {
    id: 'dreamcast', name: 'Sega Dreamcast', short: 'Dreamcast', maker: 'Sega', year: 1998,
    exts: ['.m3u', '.gdi', '.cdi', '.chd', '.cue', '.elf'],
    shadow: ['.bin', '.raw', '.iso'],
    discBased: true,
    cores: ['flycast_libretro'],
    tint: ['#c25a1f', '#3f1a08'],
  },
  {
    id: 'mastersystem', name: 'Sega Master System', short: 'Master System', maker: 'Sega', year: 1985,
    exts: ['.sms', '.zip', '.7z'],
    cores: ['genesis_plus_gx_libretro', 'smsplus_libretro'],
    tint: ['#3f3f5c', '#141420'],
  },
  {
    id: 'gamegear', name: 'Sega Game Gear', short: 'Game Gear', maker: 'Sega', year: 1990,
    exts: ['.gg', '.zip', '.7z'],
    cores: ['genesis_plus_gx_libretro'],
    tint: ['#2f4a3f', '#0f1a15'],
  },
  {
    id: 'pcengine', name: 'TurboGrafx-16 / PC Engine', short: 'TG16', maker: 'NEC', year: 1987,
    exts: ['.pce', '.sgx', '.zip', '.7z'],
    cores: ['mednafen_pce_libretro', 'mednafen_supergrafx_libretro'],
    tint: ['#8f6a1f', '#3f2c08'],
  },
  {
    id: 'pcenginecd', name: 'PC Engine CD / TurboGrafx-CD', short: 'TG-CD', maker: 'NEC', year: 1988,
    exts: ['.m3u', '.chd', '.cue', '.ccd', '.iso'],
    shadow: ['.bin', '.img'],
    discBased: true,
    cores: ['mednafen_pce_libretro'],
    tint: ['#8f5c2f', '#3f2410'],
  },
  {
    id: 'neogeo', name: 'Neo Geo', short: 'Neo Geo', maker: 'SNK', year: 1990,
    exts: ['.zip', '.7z'],
    cores: ['fbneo_libretro', 'mame2003_plus_libretro'],
    tint: ['#8f1f4a', '#2f0a18'],
  },
  {
    id: 'ngp', name: 'Neo Geo Pocket Color', short: 'NGPC', maker: 'SNK', year: 1998,
    exts: ['.ngp', '.ngc', '.npc', '.zip'],
    cores: ['mednafen_ngp_libretro'],
    tint: ['#1f5c5c', '#0a2020'],
  },
  {
    id: 'wonderswan', name: 'WonderSwan Color', short: 'WonderSwan', maker: 'Bandai', year: 1999,
    exts: ['.ws', '.wsc', '.pc2', '.zip'],
    cores: ['mednafen_wswan_libretro'],
    tint: ['#5c5c2f', '#20200f'],
  },
  {
    id: 'arcade', name: 'Arcade (MAME / FinalBurn)', short: 'Arcade', maker: 'Various', year: 1979,
    exts: ['.zip', '.7z', '.chd'],
    cores: ['fbneo_libretro', 'mame_libretro', 'mame2010_libretro'],
    tint: ['#8f2f6a', '#2f0a20'],
  },
  {
    id: 'atari2600', name: 'Atari 2600', short: '2600', folder: 'Atari 2600',
    maker: 'Atari', year: 1977,
    exts: ['.a26', '.bin', '.zip'],
    cores: ['stella_libretro'],
    tint: ['#8f5c1f', '#2f1c08'],
  },
  {
    id: 'atari7800', name: 'Atari 7800', short: '7800', folder: 'Atari 7800',
    maker: 'Atari', year: 1986,
    exts: ['.a78', '.bin', '.zip'],
    cores: ['prosystem_libretro'],
    tint: ['#6a4a1f', '#241808'],
  },
  {
    id: 'lynx', name: 'Atari Lynx', short: 'Lynx', maker: 'Atari', year: 1989,
    exts: ['.lnx', '.o', '.zip'],
    cores: ['mednafen_lynx_libretro', 'handy_libretro'],
    tint: ['#4a4a4a', '#141414'],
  },
  {
    id: 'jaguar', name: 'Atari Jaguar', short: 'Jaguar', maker: 'Atari', year: 1993,
    exts: ['.j64', '.jag', '.rom', '.abs', '.cof', '.zip'],
    cores: ['virtualjaguar_libretro'],
    tint: ['#1f1f1f', '#8f1f1f'],
  },
  {
    id: '3do', name: 'Panasonic 3DO', short: '3DO', maker: 'Panasonic', year: 1993,
    exts: ['.m3u', '.chd', '.cue', '.iso'],
    shadow: ['.bin', '.img'],
    discBased: true,
    cores: ['opera_libretro'],
    tint: ['#3f3f2f', '#15150f'],
  },
  {
    id: 'msx', name: 'MSX', short: 'MSX', maker: 'Microsoft / ASCII', year: 1983,
    exts: ['.rom', '.mx1', '.mx2', '.dsk', '.cas', '.zip'],
    cores: ['bluemsx_libretro', 'fmsx_libretro'],
    tint: ['#2f4a5c', '#0f1a20'],
  },
  {
    id: 'c64', name: 'Commodore 64', short: 'C64', maker: 'Commodore', year: 1982,
    exts: ['.d64', '.t64', '.prg', '.crt', '.tap', '.g64', '.zip'],
    cores: ['vice_x64sc_libretro', 'vice_x64_libretro'],
    tint: ['#5c5c8f', '#1c1c30'],
  },
  {
    id: 'amiga', name: 'Commodore Amiga', short: 'Amiga', maker: 'Commodore', year: 1985,
    exts: ['.adf', '.adz', '.ipf', '.dms', '.hdf', '.lha', '.uae', '.zip'],
    cores: ['puae_libretro'],
    tint: ['#8f4a1f', '#2f1808'],
  },
  {
    id: 'zxspectrum', name: 'ZX Spectrum', short: 'Spectrum', maker: 'Sinclair', year: 1982,
    exts: ['.tzx', '.tap', '.z80', '.sna', '.szx', '.dsk', '.zip'],
    cores: ['fuse_libretro'],
    tint: ['#8f1f5c', '#2f0a1c'],
  },
  {
    id: 'dos', name: 'MS-DOS', short: 'DOS', maker: 'Microsoft', year: 1981,
    exts: ['.exe', '.com', '.bat', '.conf', '.dosz', '.zip'],
    cores: ['dosbox_pure_libretro', 'dosbox_core_libretro'],
    tint: ['#2f2f2f', '#0a0a0a'],
  },
  {
    id: 'scummvm', name: 'ScummVM', short: 'ScummVM', maker: 'Various', year: 1987,
    exts: ['.scummvm', '.svm'],
    cores: ['scummvm_libretro'],
    tint: ['#5c3f1f', '#20150a'],
  },
  {
    id: 'pico8', name: 'PICO-8', short: 'PICO-8', maker: 'Lexaloffle', year: 2015,
    exts: ['.p8', '.png'],
    cores: [],
    tint: ['#8f2f5c', '#1f2f5c'],
  },
];

const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

export function getPlatform(id) {
  return byId.get(id) || null;
}

/** Display info for a platform id, tolerating ids that vanished from the catalogue. */
export function platformMeta(id) {
  return (
    byId.get(id) || {
      id,
      name: id,
      short: id.toUpperCase(),
      maker: 'Unknown',
      year: null,
      exts: [],
      cores: [],
      tint: ['#4a2f7d', '#170f2b'],
    }
  );
}

/** Extensions that can only belong to one platform — used by folder auto-detect. */
export const UNAMBIGUOUS_EXTS = (() => {
  const owners = new Map();
  for (const p of PLATFORMS) {
    for (const ext of p.exts) {
      if (!owners.has(ext)) owners.set(ext, new Set());
      owners.get(ext).add(p.id);
    }
  }
  const out = new Map();
  for (const [ext, ids] of owners) {
    if (ids.size === 1) out.set(ext, [...ids][0]);
  }
  return out;
})();

/** Container formats that shadow their sibling data tracks during a scan. */
export const CONTAINER_EXTS = new Set(['.m3u', '.cue', '.gdi', '.ccd', '.mds', '.chd', '.pbp']);
