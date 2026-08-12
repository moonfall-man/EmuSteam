# emulators/

**Unzip portable emulator builds in here** — one folder each — then
Settings → Emulators → **Add emulator**. Anything recognisable already sitting in
here is offered to you directly, so there's usually nothing to browse for.

```
emulators/
  mGBA-0.10.5-win64/mGBA.exe      <- release folder names are fine as-is
  Project64/Project64.exe
  RetroArch/retroarch.exe
```

**Keep the whole extracted folder together.** A portable build needs the files
that ship beside it — `portable.ini`, `config.ini`, DLLs, `shaders/`, BIOS. Every
emulator is launched with **its own folder as the working directory**, so those
are found exactly as if you'd double-clicked the .exe yourself. Don't flatten a
build into `emulators/` root.

**The folder name doesn't matter** — matching is on the executable name, so
`mGBA-0.10.5-win64/mGBA.exe` is recognised as mGBA without renaming anything.

**Builds that ship several executables** (mGBA has both `mGBA.exe` and
`mgba-sdl.exe`) resolve to the primary one. If you want one of the alternates,
browse for it manually.

## Why here rather than Program Files

Anything inside the app folder gets its path stored **relative** — so
`emulators/mGBA/mGBA.exe` is saved as `./emulators/mGBA/mGBA.exe`, not
`C:\Users\you\...`.

That's what makes the whole setup portable. Keep your emulators here (and your
ROMs in `roms/`), and you can zip the EmuSteam folder, hand it to a friend or
drop it on a USB stick, and it runs on any drive letter on any machine with no
reconfiguration.

Emulators installed elsewhere work exactly the same, they just get stored as
absolute paths — which is fine if the setup isn't going to move.

## What happens when you add one

EmuSteam matches the filename against ~35 known emulators and pre-fills the
launch arguments and the systems it runs. Then a folder appears in `roms/` for
each of those systems.

If it's an emulator we don't recognise, you type the launch arguments once.
Available tokens: `{rom}` `{romDir}` `{romFile}` `{romName}` `{core}`
`{platform}`.

**RetroArch** is a special case: it starts with *no* systems selected, because it
can technically run about 40 of them and claiming all 40 would spray 40 empty
folders into `roms/`. Tick the systems you actually play, and set a core for each
in Settings → Systems.

`.bat` / `.cmd` wrapper scripts are supported, if you use one to pin a config.

## Why it's empty in the repo

Emulators aren't ours to redistribute — download them yourself. Only this README
is committed; whatever you put here stays out of git.
