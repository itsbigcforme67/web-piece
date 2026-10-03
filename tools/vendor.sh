#!/usr/bin/env bash
# Copy the parts of piece-emu and lhasa this project uses into third_party/, at pinned versions.
# Only needed to update them: the copies are part of the repository.
#   bash tools/vendor.sh [folder to keep the checkouts in, default ../_upstream]
set -euo pipefail
cd "$(dirname "$0")/.."
UP="${1:-../_upstream}"
PIECE_EMU_COMMIT=08ec4b45176e8df0d6d6f67e56b87e847cd64a65     # https://github.com/autch/piece-emu (MIT)
LHASA_COMMIT=75ed83559f23e9538e0045c62f53f77ab03d03d6         # https://github.com/fragglet/lhasa (ISC)
mkdir -p "$UP"
[ -d "$UP/piece-emu/.git" ] || git clone https://github.com/autch/piece-emu "$UP/piece-emu"
[ -d "$UP/lhasa/.git" ] || git clone https://github.com/fragglet/lhasa "$UP/lhasa"
git -C "$UP/piece-emu" fetch -q origin "$PIECE_EMU_COMMIT" 2>/dev/null || true
git -C "$UP/lhasa" fetch -q origin "$LHASA_COMMIT" 2>/dev/null || true

# ---- piece-emu: the CPU, the chip's peripherals and the board devices (not its front ends, debugger or tools)
P=third_party/piece-emu
rm -rf "$P"; mkdir -p "$P"/{core,soc,board,system}
S="$UP/piece-emu"
git -C "$S" show "$PIECE_EMU_COMMIT:LICENSE" > "$P/LICENSE"
for f in $(git -C "$S" ls-tree --name-only "$PIECE_EMU_COMMIT" src/core/ src/soc/ src/board/ | grep -E '\.(cpp|hpp|h)$'); do
  git -C "$S" show "$PIECE_EMU_COMMIT:$f" > "$P/${f#src/}"
done
for f in src/system/piece_peripherals.cpp src/system/piece_peripherals.hpp src/pfi_format.h; do
  git -C "$S" show "$PIECE_EMU_COMMIT:$f" > "$P/${f#src/}"
done
# The one change: the WebAssembly toolchain has no C++ exceptions, so the handful of "throw" statements
# (all in load-time checks) call piece_fatal() instead, which reports the message and stops.
cat > "$P/piece_fatal.hpp" <<'H'
// Added by web-piece (not part of piece-emu): what a "throw" becomes in a build without C++ exceptions.
#pragma once
#include <string>
[[noreturn]] void piece_fatal(const std::string& message);
H
for f in $(grep -lE 'throw std::' "$P"/*/*.cpp); do
  sed -i -E 's/throw std::[a-z_]+\(/piece_fatal(/' "$f"
  sed -i '0,/^#include/s//#include "piece_fatal.hpp"\n#include/' "$f"
  echo "patched $(basename "$f")"
done
! grep -nE '\b(throw|try|catch)\b' "$P"/*/*.cpp "$P"/*/*.hpp | grep -vE '^\S+:[0-9]+:\s*//' | grep -E 'throw |try \{|catch \(' || { echo "exceptions are still used"; exit 1; }

# ---- lhasa: the library only (unpacks .lzh archives and self-extracting .exe files)
L=third_party/lhasa
rm -rf "$L"; mkdir -p "$L/lib/public"
S="$UP/lhasa"
git -C "$S" show "$LHASA_COMMIT:COPYING.md" > "$L/COPYING.md"
for f in $(git -C "$S" ls-tree -r --name-only "$LHASA_COMMIT" lib/ | grep -E '\.(c|h)$' | grep -v win32); do
  git -C "$S" show "$LHASA_COMMIT:$f" > "$L/$f"
done
cat > third_party/README.md <<M
# Other people's code used by web-piece

| Folder | What | Version | Licence |
|---|---|---|---|
| \`piece-emu/\` | The P/ECE emulator core by Autch.net: S1C33209 CPU, on-chip peripherals, LCD controller, flash. | [autch/piece-emu](https://github.com/autch/piece-emu) @ \`${PIECE_EMU_COMMIT:0:12}\` | MIT (\`piece-emu/LICENSE\`) |
| \`lhasa/\` | LHA archive reader by Simon Howard. | [fragglet/lhasa](https://github.com/fragglet/lhasa) @ \`${LHASA_COMMIT:0:12}\` | ISC (\`lhasa/COPYING.md\`) |

Both are copied unchanged by \`tools/vendor.sh\`, with one exception: in piece-emu, \`throw std::…(\` is replaced by
\`piece_fatal(\` (declared in the added \`piece-emu/piece_fatal.hpp\`) because the WebAssembly build has no C++ exceptions.
M
echo "vendored: $(find third_party -type f | wc -l) files"
