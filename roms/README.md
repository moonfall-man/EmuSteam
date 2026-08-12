# roms/

**Put your ROMs in this folder. Any of them, all mixed together. EmuSteam sorts
them into per-system folders for you.**

That's the whole thing. You don't need to create folders, and you don't need to
know which subfolder a file belongs in.

## Three ways to get games in

Pick whichever suits you — they all end up in the same place.

| | |
|---|---|
| **Settings → Import ROMs…** | Best for a whole collection. Pick files or a folder; it asks whether to **copy or move**. Moving is instant and costs no extra space. |
| **Drag them onto the window** | Files or whole folders, dropped anywhere. Quickest for one or two games. Always copies. |
| **Copy them into this folder yourself** | Straight into `roms/`, not a subfolder. Sorted on the next launch. |

Dragging can only ever copy, because a browser gives a web page file *contents* but
never file paths — there is nothing for it to move. The import dialog is native, so
it gets real paths and can rename the file into place instead. A drop over about
half a gigabyte says so before it starts, rather than quietly using the space twice.

If your library already lives somewhere else and you'd rather leave it there, use
Settings → **Add ROM folder** and point at it instead. Nothing gets moved.

## How the sorting works

A `.gb` goes to `GB/`, a `.z64` to `N64/`, and so on by file extension.

For formats where the extension doesn't say — `.bin`, `.iso`, `.cue`, `.img` could
each be one of half a dozen systems — **the file is opened and asked**. Disc images
carry a signature identifying the console that made them: a PS1 disc says
`PLAYSTATION` in its ISO 9660 descriptor, a Sega CD says `SEGADISCSYSTEM` in sector
zero. The app tells you what identified each one before it moves it.

A **cue sheet and its tracks always move together**, since separating them breaks
the game. One name collision blocks the whole set rather than moving half of it.

Two things it will not do:

- **Nothing is ever overwritten.** A file that already exists is skipped and named.
- **Nothing is guessed.** A file whose contents identify nothing — including `.zip`,
  since archives aren't opened — stays exactly where it is and is listed in
  Settings → ROM folders with the reason.

Everything that moves is printed to the console and shown in the app. If you'd
rather do your own filing, turn off **File stray ROMs automatically** in
Settings → ROM folders; loose files are still listed, with a **File them now**
button for when you want it.

## Things worth knowing

- **Subfolders inside a system folder are yours.** `GBA/Pokemon/Emerald.gba` works
  and is never rearranged — they're scanned recursively, so organise however you like.
- **Multi-disc games:** name them `(Disc 1)` / `(Disc 2)`, or drop in an `.m3u`.
  Either way they collapse into one entry.
- **Box art** can sit next to a ROM with a matching name, or in an `Images/`
  subfolder. Or just run **Download artwork** in Settings and skip the whole
  question. Anything without art gets a generated cover.
- **A system folder appears** when you have something that can play it — an
  emulator *or* a downloaded core — or when games for it turn up here. An empty
  folder means "I can play this, I just don't have games yet".
- **Removing an emulator** removes its folder only if that folder is empty. Your
  games are never deleted to follow an uninstall.

## Why it's empty in a fresh clone

These folders are generated from what *you* have, so only this README is
committed — no ROMs, no personal library. You'll see nothing here until you add
your first game.
