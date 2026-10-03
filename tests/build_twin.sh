#!/usr/bin/env bash
# Build tests/native_twin: the web glue and the emulator compiled for this PC (needs g++ with C++20 and gcc).
set -euo pipefail
cd "$(dirname "$0")/.."
P=third_party/piece-emu; L=third_party/lhasa/lib
OUT="${TMPDIR:-/tmp}/web-piece-twin"; mkdir -p "$OUT"
objs=()
for f in crc16 ext_header lha_decoder lha_endian lha_file_header lha_input_stream lha_basic_reader lha_reader macbinary \
         null_decoder lh1_decoder lh5_decoder lh6_decoder lh7_decoder lhx_decoder lk7_decoder lz5_decoder lzs_decoder pm1_decoder pm2_decoder; do
  gcc -O2 -w -I"$L" -c "$L/$f.c" -o "$OUT/lha_$f.o"; objs+=("$OUT/lha_$f.o")
done
gcc -O2 -I"$L" -c core/lha_arch_web.c -o "$OUT/lha_arch_web.o"; objs+=("$OUT/lha_arch_web.o")
g++ -std=c++20 -O2 ${TWIN_FLAGS:-} -w -I$P -I$P/core -I$P/soc -I$P/board -I$P/system -I$L/public -I$L \
  -o tests/native_twin tests/native_twin.cpp core/piece_web.cpp $P/core/*.cpp $P/soc/*.cpp $P/board/*.cpp $P/system/*.cpp "${objs[@]}"
echo "built tests/native_twin"
