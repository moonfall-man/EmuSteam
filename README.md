# EmuSteam

A couch launcher for your emulators. Pick a system, pick a game, press A.

It looks and moves like a console dashboard: big art, gamepad navigation, one
green Play button. It is not an emulator — it launches the emulators you already
have, and gets out of the way.

**No dependencies. No build step. No install.** One `node` command and it runs.
Most retro systems play *inside* the app; the rest launch the emulator you point
it at.

```bash
npm start
```

---

## Two ways to play

**In the app.** For most retro systems, EmuSteam runs the game *inside itself* —
the real libretro core (mGBA, Snes9x, fceumm, gambatte, Genesis Plus GX …)
compiled to WebAssembly: core in a Web Worker, video to a canvas, audio through
an AudioWorklet, input through the same Gamepad API the couch UI already uses.
No process launch, no window handoff, no two-second wait. Press A and you're in
the game.

```bash
npm run fetch-cores          # once — grabs the cores for the systems you own
npm run fetch-cores -- list  # what's available, what you have
```

Cores are ~1–2 MB each and land in `cores/`. That command is the **only** part of
EmuSteam that touches the network, and it only runs when you ask; everything is
served from disk afterwards.

That claim is enforced, not just intended. EmulatorJS itself pings
`cdn.emulatorjs.org` for a version check on every game start and offers no way to
turn it off, so the player blocks any request leaving its own origin and logs what
it stopped. Without that, a machine with no internet would wait for a timeout
before every game.

**A downloaded core *is* an emulator.** Fetch one and that system becomes playable
immediately — it gets its `roms/` folder and a Play button with nothing else to
configure. You don't need the game first, and you don't need to install anything.

**Disc games need a single file.** The in-app player is handed one file, so a
`.cue` sheet is resolved to the track it names — a cue is a few lines of text
pointing at a `.bin`, and a core given the text finds no game and drops into its
own menu. A single-track disc therefore plays here directly. A multi-track one
cannot: its extra tracks are CD audio and no single file stands in for the set, so
the app says so instead of launching something that cannot work. Convert those to
`.chd`.

`.chd` is worth it either way. A 632 MB `.bin` takes about half a minute to load
and holds ~600 MB of memory while you play, because the whole image goes into the
core. A `.chd` is roughly a third of the size, and a standalone emulator is the
better answer for big discs regardless.

**22 systems run in the app:** NES, SNES, Game Boy, Game Boy Color, GBA, N64,
Nintendo DS, Genesis / Mega Drive, Sega CD, 32X, Master System, Game Gear, PS1,
TurboGrafx-16, TurboGrafx-CD, Neo Geo Pocket Color, WonderSwan, Atari Lynx,
Arcade, Neo Geo, C64 and Amiga.

Settings → **Play in app** lists all of them all the time — which have their core
downloaded, which are one command away, and which systems need a standalone
emulator instead, with the reason for each.

### It suspends like a console

**Leaving a game keeps your place.** Press **Esc** (or **Select + Start**) and
EmuSteam freezes the frame, writes a save state, and drops you back to the
library. The game's button then reads **Resume**, and pressing it puts you back
exactly where you were — same frame, same music, mid-battle if that's where you
stopped. No menus, no save slots, no thinking about it. It is the Switch's HOME
button.

This works because in-app play is *ours*: the core runs in a worker we own, so we
can snapshot it on the way out. A launched Dolphin or PCSX2 owns its own process
and exits how it likes, so suspend/resume applies to in-app systems only.

**Start over** sits next to Resume when a suspended session exists, and asks
before discarding it. It only ever clears the reserved suspend slot — your quick
saves and numbered save states are untouched.

Nothing here can trap you in a game. If the state cannot be written — a core that
does not support states, a full disk — the exit still happens and the app tells
you it could not suspend.

### In-game hotkeys

| Action | Keyboard | Gamepad |
|---|---|---|
| Exit, keeping your place | **Esc** | **Select + Start** |
| Quick save | **F2** | **Select + A** |
| Quick load | **F4** | **Select + B** |
| Fast forward | **Tab** | **Select + R1** |
| Fast-forward speed | **−** / **=** | **Select + D-pad ↓ ↑** |
| Slow motion (hold) | **`** | **Select + L1** |
| Pause / resume | **P** | **Select + X** |
| Show this list | hold **F1** | hold **Select** |

**Fast forward has three behaviours**, picked in Settings → **Play in app**:

| Mode | What the button does |
|---|---|
| **Toggle** | Press once to speed up, press again to stop. Most reliable on a controller. |
| **Hold** | Fast only while held. |
| **Tap or hold** (default) | A quick tap locks it on; a longer hold is momentary. Both from one button. |

The tap window is longer on a controller than on the keyboard, deliberately: a
keyboard tap is around 80 ms, but "tapping" Select + R1 means pressing *and
releasing two buttons*, which realistically takes 300–500 ms. With one shared
threshold, tap-to-lock was effectively impossible on a pad.

A momentary hold is cancelled if the window loses focus; a deliberate lock or
toggle survives.

Speed steps through 1.5× · 2× · 2.5× · 3× · 4× · 8× · unlimited, adjustable
mid-game and persisted, or set it in Settings → **Play in app**. "Unlimited" runs
as fast as your machine manages and may stutter the audio.

Each one flashes a brief confirmation ("Quick saved", "▶▶ 4× locked") and then
gets out of the way. **Nothing permanent sits over the picture while you play** —
no hint bar, no top bar, no status card. Hold **Select** (or **F1**) mid-game and
the list appears; let go and it's gone. It's also listed in
Settings → **Play in app**.

EmulatorJS's own menu (save/load slots, cheats, shaders, control remapping) is
still there if you want it.

### Where your saves live

Three different things get called "saves", and they are stored in three different
places. Worth knowing which is which before you go looking for one:

| | What it is | Where it goes |
|---|---|---|
| **In-game save** | Saving at a Pokémon Center — the cartridge's own battery/SRAM | The window profile's storage, under `data/window-profile/`. Written automatically, one file per game. |
| **Save states** | Whole-machine snapshots: quick save, numbered slots | `data/states/<game>/<slot>.state` — ordinary files |
| **Suspended session** | Where you were when you last left | `data/states/<game>/suspend.state` |

Everything lives under `data/`, so all of it travels with the folder and survives
a rescan. Two consequences worth knowing:

- **In-game saves are not `.sav` files,** so they are not shared with a standalone
  emulator. Play a game in the app and in mGBA and you have two separate saves.
- **They are tied to the ROM's location,** because a game's identity is a hash of
  its path — the same rule save states have always followed. Move a ROM to a
  different folder and the app treats it as a new game with fresh saves.

Each disc of a multi-disc game shares one in-game save, which is what you want for
a memory card.

`Select` is the modifier because that's the RetroArch and RetroPie convention.
Two caveats:

- The game still receives the individual button presses, since suppressing them
  would mean reaching into EmulatorJS's input path.
- **If Steam is running, check its controller bindings.** Steam Input binds
  `Select + Start` to open Steam by default on some configurations, so leaving a
  game also pops Steam in front of you. Rebind it on Steam's side, or change the
  chord here — it is not something the app can override.

**Launch a real emulator.** Still the right answer for the heavy systems —
GameCube, Wii, PS2, PS3, Switch, 3DS, Wii U, PSP, Vita have no usable WASM core,
and Dolphin/PCSX2/DuckStation beat their libretro versions anyway. Games on those
systems get a normal Play button that launches the emulator you configured. Where
both are possible, in-app is the primary button and the emulator is one press
away.

Settings → **Play in app** shows the whole picture: every system, whichever way it plays.

## Artwork

In the app: **Settings → ROM folders → Download artwork**. It reports progress with
a real percentage and tells you what it could not match. Or from a terminal:

```bash
npm run fetch-art                # box art for your games + icons for your consoles
npm run fetch-art -- systems     # just the console icons (a few KB each)
npm run fetch-art -- --force     # re-fetch what is already there
```

Both run the same code, so they cannot behave differently.

Box art comes from the libretro thumbnail archive, matched on the **original ROM
filename** — that is how the archive is indexed, so a `(USA)` file finds the USA
cover. If a ROM has been renamed the match is looser: tags come off one at a time
until something hits, most specific first, so a rename costs accuracy rather than
fetching the wrong region outright. Anything unmatched is listed at the end, and
you can always assign art by hand from the game page.

Console icons come from `retroarch-assets` (CC BY 4.0) — line art rather than
photographs, a few KB each, and they tint to each system's own colour so a rail of
mixed consoles still reads as one set. A system with no icon downloaded falls back
to its short name, as does one whose file goes missing.

Along with `fetch-cores`, this is the only part of EmuSteam that touches the
network, and it only runs when you ask — by pressing the button or typing the
command. Nothing fetches on a timer or at startup, and the in-app player actively
blocks outbound requests.

## Big libraries

Two things matter once a library gets past a few thousand games, and both are
handled rather than hoped about:

- **The window opens before the scan starts.** It used to scan first, which meant
  a large library showed nothing at all until it finished. Now the window comes up
  immediately and the scan reports into it: *"Scanning your library… 18,360 files ·
  103 folders · 18,360 games"*, then *"Found 24,480 games"*.
- **The scan does not block the server.** It yields often enough that the UI stays
  responsive throughout — measured at ~0.2s API responses during a 24,000-game
  scan. Without that, a progress bar would sit frozen at zero, which is worse than
  no progress bar at all.

It reports **counts, not a percentage**, on purpose: knowing the total means
walking the whole tree first, which *is* the scan, so a percentage would be either
a second full pass or a fabrication.

## Quick start

```bash
git clone <this repo>
cd EmuSteam
npm start
```

No `npm install` — there are no dependencies, so there is nothing to install. The
clone is about 600 KB. You need [Node.js](https://nodejs.org) 20.6 or newer and
nothing else; an older Node is told so plainly rather than failing with a stack
trace.

Nothing personal comes with the clone: `data/`, `cores/` and the contents of
`roms/` and `emulators/` are all ignored by git, so you get the app and none of
anyone's games, saves or settings. First run walks you through pointing it at ROMs
and either downloading cores or picking an emulator you already have.

| | |
|---|---|
| **Windows** | Double-click `EmuSteam.bat` |
| **macOS / Linux** | `./emusteam.sh` |
| **Anywhere** | `npm start` |

The UI opens in a chromeless, fullscreen window. On Windows that is Edge's app
mode, which is already installed — so you get a native-feeling window without
shipping a 150 MB browser runtime.

Then, in the app:

1. **Add an emulator** — unzip a portable build into `emulators/` and EmuSteam
   offers it to you directly; otherwise browse for the `.exe`. Around 35 common
   emulators are recognised by filename and get their launch arguments filled in.
2. **A folder appears in `roms/` for each system it runs.** Add mGBA and you get
   `roms/GBA/`, `roms/GB/` and `roms/GBC/`, already registered for scanning.
3. **Drop your ROMs in and play.**

That's the whole setup — there's no "add ROM folder" step for the common case,
and the first emulator you add for a system becomes its default.

### It organises itself

A `roms/<System>/` folder exists for either of two reasons, and either alone is
enough:

1. **you have an emulator for that system** — so you need somewhere to put games;
2. **games for that system are already there** — so they need a home.

Rule 1 means the folder listing tells you what you can play: no GBA emulator, no
`roms/GBA/`. Rule 2 means you can just dump ROMs in `roms/` and forget about it —
every launch files them into the right system folder, creating it if needed. A
game whose system you can't play yet still gets filed, and the UI says the
emulator is what's missing.

**Disc images get opened, not guessed at.** A `.bin`, `.iso` or `.cue` names no
system — a `.bin` could be PS1 or Genesis — but the file itself knows: every
disc-based console stamps a signature into its first sectors. So EmuSteam reads it.
A PS1 disc says `PLAYSTATION` in its ISO 9660 descriptor, a Sega CD says
`SEGADISCSYSTEM` in sector zero, and PS1 is told apart from PS2 by which boot line
its `SYSTEM.CNF` uses. The UI shows what identified each one before it moves.

A **cue sheet and its tracks always travel together** — a sheet references its
`.bin` by bare filename, so splitting them would break the game. One name
collision blocks the whole set rather than moving half of it, and a failure partway
through puts back what already moved.

Still never guessed at: a file whose contents identify nothing (including `.zip` —
we do not open archives) stays exactly where it is and says so, and **nothing is
ever overwritten**. Every move is printed to the console and shown in the app, so
files never move silently. Turn it off with **File stray ROMs automatically** in
Settings → ROM folders; loose files are still listed, with a button for when you
want them filed.

Removing an emulator reclaims its folders **only if they're empty** — uninstalling
an emulator can never take your games with it.

If your library already lives on a big data drive, point at it directly with
Settings → **Add ROM folder**. Both kinds work at once; the managed ones are
labelled "auto".

---

## Controls

Gamepad, keyboard and mouse all work at the same time — grab whichever is
closer. The hint bar at the bottom always shows what the buttons do right now,
and switches between controller glyphs and key names depending on what's
connected.

| Action | Gamepad | Keyboard |
|---|---|---|
| Move | D-pad / either stick | Arrows or WASD |
| Select · Play | **A** | Enter / Space |
| Back | **B** | Esc / Backspace |
| Favourite | **Y** | F |
| More options · cycle sort | **X** | E |
| Search | Back / Select | `/` |
| Settings | Start | `,` |
| Jump between systems | **LB** / **RB** | `[` / `]` |

Navigation is spatial, not tab-order: pressing → goes to whatever is actually to
the right on screen.

### How Back works

**B / Esc always moves outward, never inward.** It returns you to where you came
from — restoring that screen's scroll position and focused card — but it will
never take you back *down* into something you already climbed out of.

That distinction matters more than it sounds. Home → grid → game, then click the
breadcrumb back to the grid: a plain history "back" would now drop you into the
game you just left. Meanwhile pure "go up a level" would break the other case —
opening a game from the *Continue playing* rail and being dumped in a grid you
never visited. Walking back through history while skipping anything at the same
depth or deeper gets both right.

At the top level, B / Esc offers to close EmuSteam. There's also a **‹ Back**
button in the top bar for mouse users.

In fullscreen the window runs in kiosk mode so that Escape reaches the app
instead of being eaten by the browser as "leave fullscreen". Alt+F4 (or Ctrl+C in
the console) always closes it; `--no-fullscreen` gives an ordinary window.

### If your controller isn't working

**Settings → Controller** is a live test screen: it shows the pad the browser
reports, every button with its pressed state and what action it's bound to, live
stick values, and the last action the app actually acted on. If a button does
nothing, that screen says whether the app is seeing it at all.

Button numbering assumes the standard gamepad mapping (as XInput pads report). If
that screen says your pad is "non-standard", the numbers may not match the
labels — worth raising, since the bindings would need adjusting for it.

---

## Sharing it

This is built to be handed to someone else.

**Send the folder.** Zip it, copy it to a USB stick, `git clone` it. There is
nothing machine-specific in the repo — all state lives in `data/`, which is
gitignored.

**Portable mode is automatic.** Any path inside the app folder is stored
*relative*, which is exactly why `roms/` and `emulators/` live in here:

```
EmuSteam/
  emulators/mGBA/mGBA.exe              -> stored as ./emulators/mGBA/mGBA.exe
  roms/GBA/Metroid - Zero Mission.gba  -> stored as ./roms/GBA/...
  data/                                 <- config, art cache, play stats
```

Lay it out like that and the whole thing is self-contained: zip it, drop it on a
USB stick, and it runs from any drive letter on any machine with no
reconfiguration. Paths *outside* the app folder stay absolute, which is what you
want for a library on a big data drive.

The per-system folders under `roms/` are generated from whichever emulators *you*
have, so they're machine-specific and aren't committed — on a fresh clone `roms/`
and `emulators/` hold only their READMEs.

**Verify an install** with `npm test`. It builds a throwaway ROM library, starts
a real server, exercises the whole API, and cleans up — 65 checks, a few seconds,
and it never touches your real config.

---

## What it does

- **Systems rail** built from what you actually own — no empty shelves.
- **`roms/` folders that manage themselves**, one per system you can actually
  play, so the folder listing doubles as your setup status.
- **Readable titles.** `Legend of Zelda, The - Ocarina of Time (USA) (Rev B) [!].z64`
  becomes *The Legend of Zelda: Ocarina of Time*, with the region, revision and
  dump quality pulled out as separate metadata. Hyphenated names like
  *Spider-Man* are left alone.
- **Disc sets collapse.** A `.cue` next to its `.bin` tracks is one entry, not
  five. `(Disc 1)` / `(Disc 2)` become one game with a disc picker. An `.m3u`
  playlist wins over the files it references.
- **Box art, or a good-looking substitute.** Art is matched from images next to
  your ROMs, from an `Images/` subfolder, or from any folder you point at (an
  existing LaunchBox or ES-DE collection works). Games without art get a
  generated cover — the system's colours, hue-shifted deterministically per
  title — so the grid never looks broken. You can also assign art by hand.
- **Play time and history**, like a store page. Continue-playing rail, play
  counts, favourites, hidden games.
- **Nothing phones home.** No accounts, no telemetry, no art scraping, no
  network calls at all. It reads your disk and launches your programs.

## Supported systems

44 systems, from the Atari 2600 to the Switch: all the Nintendo and Sega
consoles and handhelds, PlayStation 1 through 3 plus PSP and Vita, Neo Geo,
TurboGrafx, 3DO, Jaguar, Lynx, WonderSwan, arcade (MAME/FBNeo), and the home
computers — C64, Amiga, MSX, ZX Spectrum, DOS, ScummVM.

Adding one is a single row in [`src/platforms.mjs`](src/platforms.mjs); the
scanner, UI and presets all pick it up automatically.

## Recognised emulators

RetroArch (with per-system core selection), Project64, Mupen64Plus, simple64,
ares, Snes9x, bsnes, Mesen, FCEUX, mGBA, VisualBoyAdvance-M, melonDS, DeSmuME,
Azahar/Citra, Dolphin, Cemu, Ryujinx, DuckStation, PCSX2, RPCS3, PPSSPP, Vita3K,
Flycast, Redream, Kega Fusion, Mednafen, SSF, MAME, FinalBurn Neo, Stella,
DOSBox, ScummVM, BizHawk, VICE, FS-UAE/WinUAE.

Anything else works too — you just type the launch arguments once. Available
tokens: `{rom}` `{romDir}` `{romFile}` `{romName}` `{core}` `{platform}`.

**RetroArch starts with no systems ticked**, deliberately: it can run about 40 of
them, and claiming all 40 would spray 40 empty folders into `roms/`. Pick the
systems you actually play, then set a core for each in Settings → Systems.

### Portable builds

Unzip the whole thing into `emulators/` and leave it intact — every emulator is
launched with **its own folder as the working directory**, so `portable.ini`,
`config.ini`, DLLs, shaders and BIOS are found exactly as if you'd double-clicked
the `.exe`. Release folder names are fine as-is (`mGBA-0.10.5-win64/`); matching
is on the executable name. A build shipping several executables resolves to the
primary one (`mGBA.exe`, not `mgba-sdl.exe`).

This is the same idea as ES-DE's `es_find_rules.xml`, which looks for
`%ESPATH%\Emulators\mGBA\mGBA.exe` before falling back to the Windows registry
and `PATH` — scoped here to our own folder, which is the case that matters when
the point is to keep the setup portable.

Batch-file wrappers (`.bat` / `.cmd`) are supported, which Node normally
refuses to spawn. ROM paths are quoted so a filename containing `&` can't
become a command.

---

## Command line

```bash
node src/main.mjs [options]
```

| Flag | Effect |
|---|---|
| `--no-fullscreen` | Open in a normal window — easier for first-time setup |
| `--no-open` | Server only; connect from another device on your LAN |
| `--scan-only` | Rescan the library, print a summary, exit |
| `--port <n>` | Pin the port (default: first free from 7710) |
| `--host <addr>` | Bind address. Defaults to `127.0.0.1` |

Set `EMUSTEAM_DATA` to move the data folder somewhere else.

## Where things live

```
src/          server: scanner, launcher, API, platform + emulator catalogues
tools/        fetch-cores.mjs — downloads the in-app player
cores/        EmulatorJS runtime + WASM cores (gitignored, fetched on demand)
web/          frontend: no framework, native ES modules, hand-written CSS
test/smoke.mjs  the whole test suite
roms/         your ROMs, one folder per playable system (managed)
emulators/    portable emulator builds, so their paths stay relative
data/         yours — config.json, library.json, stats.json, art/  (gitignored)
```

Set `EMUSTEAM_WORKSPACE` to put `roms/` and `emulators/` somewhere other than the
app folder (the test suite uses this so a test run can't touch your real ones).

`config.json` is hand-editable if you'd rather. `library.json` is a rebuildable
cache. `stats.json` holds play time and favourites — that's the one worth
backing up.

## Notes on safety

The server can start programs and read files, so it is locked down accordingly:

- Bound to `127.0.0.1` only.
- Every API call needs a token generated fresh each run and injected into the
  page, so only same-origin scripts can read it. Requests carrying a foreign
  `Origin` are refused.
- Box art can only be served from folders you configured — no arbitrary file
  reads. ROM bytes are served by game id, never by path, so the in-app player
  cannot be talked into reading something else.
- `/cores/` is the one route without a token, because EmulatorJS builds asset URLs
  by string concatenation and a query string would corrupt them. It is sandboxed
  to `cores/`, which holds only byte-for-byte public CDN files — nothing about you.
- Game titles come from filenames on disk, so the frontend never uses
  `innerHTML`; everything is built as text nodes.

If you change `--host` to expose it on your LAN, anyone on that network who can
reach the port can launch programs on your machine. Only do that on a network
you trust.

## Troubleshooting

**A game won't launch.** Open the game → **More** → *Show launch command*. That
prints exactly what gets run, which usually makes the problem obvious.

**A system says "No emulator".** Settings → Systems → pick one. If the emulator
is RetroArch you also need to choose a core for that system.

**A scan found nothing.** Check the system assigned to the folder in
Settings → ROM folders. Ambiguous extensions (`.bin`, `.iso`, `.cue`, `.zip`)
are only picked up when the folder has an explicit system, since a `.bin` could
be a PS1 track or a Genesis cart.

**The folder I want doesn't exist in `roms/`.** You don't have an emulator for
that system yet — add one and the folder appears. Settings → ROM folders →
*Rebuild roms/ folders* forces a re-check.

**I put games in `roms/Something/` and nothing happened.** If `Something` isn't a
system name EmuSteam knows, it isn't scanned; it'll be listed as a stray in
Settings → ROM folders. Rename it to match a system folder, or add it manually.

**Art isn't showing.** Filenames need to roughly match the ROM name; matching
ignores case, punctuation and the `(USA)`-style tags. Or assign it by hand from
the game page.

## Licence

MIT.
