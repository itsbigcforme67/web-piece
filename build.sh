#!/usr/bin/env bash
# Compile the emulator (third_party/piece-emu + core/piece_web.cpp) to web/core/piece.wasm.
# Only needed after changing something in core/ or third_party/: the built file is part of the repository.
#
# Needs the WASI SDK (a clang with a C++ library for WebAssembly), version 25 or newer:
#   https://github.com/WebAssembly/wasi-sdk/releases  - unpack it anywhere and point WASI_SDK at it:
#   WASI_SDK=~/wasi-sdk-27.0-x86_64-linux bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
: "${WASI_SDK:?set WASI_SDK to the folder of an unpacked WASI SDK (see the top of this file)}"
CXX="$WASI_SDK/bin/clang++"; CC="$WASI_SDK/bin/clang"
P=third_party/piece-emu; L=third_party/lhasa/lib
OUT="${TMPDIR:-/tmp}/web-piece-build"; mkdir -p "$OUT"
COMMON="--target=wasm32-wasip1 -O3 -flto -DNDEBUG"
INC="-I$P -I$P/core -I$P/soc -I$P/board -I$P/system -I$L/public -I$L"
objs=()
# (bit_stream_reader.c, lh_new_decoder.c, pma_common.c and tree_decode.c are included by the decoders, not compiled alone)
for f in crc16 ext_header lha_decoder lha_endian lha_file_header lha_input_stream lha_basic_reader lha_reader macbinary \
         null_decoder lh1_decoder lh5_decoder lh6_decoder lh7_decoder lhx_decoder lk7_decoder lz5_decoder lzs_decoder pm1_decoder pm2_decoder; do
  o="$OUT/lha_$f.o"; "$CC" $COMMON -w -I"$L" -c "$L/$f.c" -o "$o"; objs+=("$o")
done
"$CC" $COMMON -Wall -I"$L" -c core/lha_arch_web.c -o "$OUT/lha_arch_web.o"; objs+=("$OUT/lha_arch_web.o")   # instead of lhasa's lha_arch_unix.c
for f in $P/core/*.cpp $P/soc/*.cpp $P/board/*.cpp $P/system/*.cpp; do
  o="$OUT/$(echo "$f" | tr / _).o"; "$CXX" $COMMON -std=c++20 -fno-exceptions -fno-rtti -w $INC -c "$f" -o "$o"; objs+=("$o")
done
"$CXX" $COMMON -std=c++20 -fno-exceptions -fno-rtti -Wall -Wextra $INC -c core/piece_web.cpp -o "$OUT/piece_web.o"; objs+=("$OUT/piece_web.o")
"$CXX" $COMMON -fno-exceptions -mexec-model=reactor -Wl,--strip-all -Wl,--export=__heap_base -o web/core/piece.wasm "${objs[@]}"
chmod 644 web/core/piece.wasm
ls -l web/core/piece.wasm
