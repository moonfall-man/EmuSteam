# roms/

**Drop your ROMs into the folder for their system. That's it.**

The folders in here are managed by EmuSteam, and the rule is simple:

> A folder appears here if and only if you have an emulator that can play
> that system.

So add mGBA, and `GBA/`, `Game Boy/` and `Game Boy Color/` show up — already
registered for scanning. Put files in them, and they're in your library on the
next scan (which happens automatically at startup).

An empty folder here means "I can play this system, I just don't have any games
for it yet". A folder that *isn't* here means you don't have an emulator for it —
add one in Settings → Emulators.

### Just drop ROMs in here and they sort themselves

You don't have to find the right subfolder. Drop a `.gb` straight into `roms/`
and on the next scan — which happens at every launch — it's moved into `roms/GB/`,
creating that folder if it doesn't exist yet. Same for a game that ended up in the
wrong system folder.

Two things are never guessed at:

- **Ambiguous formats stay put.** A `.bin` could be a PS1 track or a Genesis
  cart, so `.bin`, `.iso`, `.cue` and `.zip` are reported in
  Settings → ROM folders and left exactly where they are for you to file.
- **Nothing is ever overwritten.** A name collision is reported and skipped.

Everything that moves is printed to the console and shown in the app, so files
never move silently. If you'd rather do your own filing, turn off
**File stray ROMs automatically** in Settings → ROM folders; loose files are then
still listed, with a **File them now** button when you want it.

Sub-folders you make *inside* a system folder (`GBA/Pokemon/…`) are your business
and are never rearranged — they're scanned recursively, so organise however you
like.

### Things worth knowing

- **Sub-folders are fine.** `GBA/Pokemon/Emerald.gba` works. Organise however
  you like.
- **Disc games:** keep the `.cue` next to its `.bin` tracks. EmuSteam shows one
  entry, not five. For multi-disc games, either name them `(Disc 1)` /
  `(Disc 2)` or drop in an `.m3u` — either way they collapse into one game.
- **Box art** can live next to a ROM with a matching name, or in an `Images/`
  subfolder. Anything without art gets a generated cover, so nothing looks
  broken.
- **Removing an emulator** removes its folder here *only if the folder is
  empty*. Your games are never deleted to follow an uninstall.
- **A folder here with games but no emulator** gets flagged in
  Settings → ROM folders rather than silently ignored.

### You don't have to use this folder

It exists because it makes the setup portable and easy to hand to someone else.
If your library already lives on a big data drive, add it via
Settings → **Add ROM folder** and point at it. Both kinds of folder work at once;
the ones in here are just labelled "auto".

### Why it's empty in the repo

These folders are generated per-machine from the emulators *you* have, so only
this README is committed. On a fresh clone you'll see nothing here until you add
your first emulator.
