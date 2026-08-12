# Third-party notices

EmuSteam bundles no third-party code. It ships as ~50 files of plain JavaScript
with no dependencies, so there is nothing vendored into this repository.

Two optional commands download assets when you run them. Neither runs on its own.

## `npm run fetch-cores`

Downloads the [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) runtime and
libretro cores into `cores/`.

- EmulatorJS is licensed **GPL-3.0**.
- Each libretro core carries its own upstream licence — see the core's own
  project for terms.

These files are downloaded to your machine and are not redistributed here.

## `npm run fetch-art` (also Settings → ROM folders → Download artwork)

- **Box art** from the [libretro thumbnail archive](https://github.com/libretro-thumbnails).
  Community-contributed scans, used as-is.
- **Console icons** from [libretro/retroarch-assets](https://github.com/libretro/retroarch-assets),
  licensed **CC BY 4.0**.

  > RetroArch assets by the libretro team, licensed CC BY 4.0.

## Not included

ROMs and emulator builds are not part of this repository and are not ours to
distribute. `roms/` and `emulators/` ship as empty folders for you to fill.
