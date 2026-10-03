# Web P/ECE

The **Aquaplus P/ECE** (2001, Japan only) in a phone or desktop browser: a 128 × 88, four-grey handheld with a 32-bit processor that Aquaplus opened up to hobby developers, who wrote more than a hundred games for it. This app runs the real system software and real P/ECE programs. It installs as an app, works offline, and has touch buttons, sound, a keyboard and gamepad mapping, and flash memory that keeps what games save. A sibling of Web PocketStation, Web Pokémon mini, Web Brick and Web VMU.

**Neither the system software nor any game is included.** You add them once; they are stored in your browser and never uploaded anywhere.

The emulator itself is [piece-emu](https://github.com/autch/piece-emu) by Autch.net (MIT), compiled to WebAssembly. This project is the app around it.

## Try it

```bash
bash run.sh          # then open http://localhost:8769 (or the address it prints, from a phone on the same Wi-Fi)
```

1. **The system file.** Aquaplus still offers the P/ECE system update as a free download: get `update120.exe` from <https://aquaplus.jp/piece/dl/update120.html> and choose it in the app. It is unpacked in the browser; nothing needs to be run. (An `all.bin`, or a `.pfi` image from another P/ECE emulator, works too.)
2. **A game.** Choose the download as it came: a `.zip`, an `.lzh`, or one of Aquaplus's self-extracting `.exe` files. The app finds the P/ECE program (`.pex`) inside and takes the files next to it. A loose `.pex` (with its data files, selected together) works as well.
3. Tap the game. The P/ECE's own menu appears; press **A** to start it.

*Add to Home Screen* in the browser menu makes it full-screen like an app. To publish your own copy as a website: `bash publish.sh` (see *Publishing* below).

## How it is organised

A real P/ECE has 512 KB of flash holding the system and about 340 KB of files, so only a few games fit at once. Here **each game gets a P/ECE of its own**: a "unit" is the whole contents of one flash chip (the system, the launcher, the game and whatever it saves). The clock and gamepad-test programs are left off game units to make room; *New empty unit* gives a plain P/ECE with everything on it.

| | |
|---|---|
| Tap a game | Switches its unit on. The clock follows your device. |
| ‹ back | Switches it off. A P/ECE has no pause-and-resume; games save to flash themselves, and the flash is kept. |
| Hold START + SELECT | Leaves the game for the P/ECE's menu (a feature of the real system). |
| Unit ⋯ | Files on the unit (download or delete each), add files, **download the flash image** (`.pfi`), rename, delete. |
| Player ⋯ | Controls, the slow-LCD effect, reset. |
| Keyboard | Arrows, `X`/Space = A, `Z` = B (B sits left of A, as on the unit), Enter = START, Shift/Backspace = SELECT, Esc = switch off. A gamepad works too. |

A downloaded `.pfi` is the format the other P/ECE emulators use (piece-emu, P/EMU), and importing one creates a unit. That is also the hook for save syncing later, the same way memory cards are for the other consoles here.

Clearing the browser's site data erases everything, so download the flash images you care about.

## How it was tested

The files used are Aquaplus's `update120.exe` and their free download of *Odekake Multi* (`as_mult.exe`); neither is part of this repository.

* **Same result as the native emulator.** `tests/native_twin` is this project's glue code and piece-emu built for the PC. With the same flash image and the same scripted button presses, it and the WebAssembly build show identical screens at every one of 80 checkpoints over 40 seconds of play (`tests/run_game.mjs`).
* **The image built in the browser is right.** The flash made from the updater and the game archive by the JavaScript here opens in piece-emu's own tools (`pfar`), and is byte-identical to one made by its `mkpfi` and `pfar` when the files are added in the same order.
* **Browser.** `tests/e2e.py` drives the app in a phone-sized Chromium: first-run setup, the system taken from the updater, the game taken from its download, boot to the P/ECE menu, starting the game by touch and keyboard, sound, what the game saves surviving power-off, `.pfi` download and re-import (identical), the files list, reload, and the wide layout.
* **Speed.** In Node on a PC the game runs at about 4 times real speed, so a recent phone should manage; a slow one may not, and the app says so if it cannot keep up.

Not tested: a real phone, other games, the 2 MB flash modification, anything using USB, infra-red or the MMC add-on (piece-emu does not emulate those).

## ESP32

Not yet. What the first test showed:

* *Odekake Multi* keeps the P/ECE's 24 MHz processor busy about a quarter of the time: roughly 7 million instructions a second on average. That is in the range the PocketStation core already handles on a CoreS3.
* piece-emu itself is too heavy for a microcontroller (C++20, heap, built for checking compilers rather than speed). An ESP32 version needs a lean core written for the job, checked against piece-emu the way the VMU core was checked against its reference.
* It needs PSRAM: the P/ECE has 256 KB of RAM, plus the 512 KB flash image.

## Rebuilding the core

Only needed after changing `core/` or `third_party/`; the built `web/core/piece.wasm` is part of the repository.

```bash
# the WASI SDK (clang + a C++ library for WebAssembly), version 25 or newer, from
# https://github.com/WebAssembly/wasi-sdk/releases - unpack it anywhere
WASI_SDK=~/wasi-sdk-27.0-x86_64-linux bash build.sh
```

Tests:

```bash
node tests/run_game.mjs update120.exe as_mult.exe --script script.txt --seconds 40 --save-flash flash.bin
bash tests/build_twin.sh && ./tests/native_twin flash.bin script.txt 40      # prints the same "T ..." lines
bash run.sh &  python3 tests/e2e.py update120.exe as_mult.exe               # needs: pip install playwright
```

A script line is `<milliseconds> <buttons>`, for example `5000 a` then `5200 none`.

## Layout

| | |
|---|---|
| `web/` | the app: plain JavaScript, no build step |
| `web/core/piece.js` | the wrapper around the core, plus everything that works on a flash image: building one from `all.bin`, `.pfi`, the flash file system |
| `web/core/piece.wasm` | the built emulator |
| `core/piece_web.cpp` | the interface between piece-emu and the page (run for some time, screen, sound, buttons, flash), and the archive unpacker's entry points |
| `third_party/` | piece-emu (MIT) and lhasa (ISC), copied in by `tools/vendor.sh`; see `third_party/README.md` for versions and the one small change |
| `tests/` | everything under *How it was tested* |

## Publishing

`bash publish.sh` creates a public GitHub repo from this folder, pushes the code to `main`, pushes `web/` to a `gh-pages` branch and switches on GitHub Pages (needs `git` and the GitHub CLI `gh`, logged in). To publish a change later: `git add -A && git commit -m "what changed" && bash publish.sh`.

`.gitignore` and `publish.sh` keep the system software, games and flash images out of the repository. Aquaplus's download pages say their files are for personal use and not to be redistributed without permission, so the site asks each user to fetch them. Do not add them.

## Licence and credits

Web P/ECE is free software under the **GNU General Public License, version 3 or later** (see `LICENSE`). It comes with no warranty.

* The emulator core is **piece-emu** by Autch.net, MIT licence (`third_party/piece-emu/LICENSE`). All the hard work of emulating the P/ECE is theirs.
* Archives are unpacked with **lhasa** by Simon Howard, ISC licence (`third_party/lhasa/COPYING.md`).

This is an unofficial fan project. It is not affiliated with, endorsed by or sponsored by Aquaplus. "P/ECE" is their trademark and is used here only to say what the emulator is compatible with.
