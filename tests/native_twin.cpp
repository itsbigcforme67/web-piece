// web-piece tests - the same glue as the web page uses (core/piece_web.cpp), built for the PC, running the
// same schedule as tests/run_game.mjs and printing the same "T <seconds> <screen hash>" lines.
// If the two outputs match, the WebAssembly build behaves exactly like the native one.
// Copyright (C) 2026 the web-piece authors. GPL-3.0-or-later; see LICENSE. No warranty.
//
//   bash tests/build_twin.sh && ./tests/native_twin flash.bin script.txt 40
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <string>

extern "C" {
int pw_load(const std::uint8_t*, std::uint32_t, std::uint32_t);
void pw_set_time(double);
void pw_buttons(std::uint32_t);
int pw_run(std::uint32_t);
const std::uint8_t* pw_lcd();
std::uint32_t pw_audio(std::int16_t*, std::uint32_t);
int pw_flash_changed();
std::uint32_t pw_frames();
}

int main(int argc, char** argv) {
  if (argc < 4) { std::fprintf(stderr, "usage: native_twin <flash.bin> <script> <seconds>\n"); return 2; }
  std::vector<std::uint8_t> flash;
  if (FILE* f = std::fopen(argv[1], "rb")) { std::uint8_t b[4096]; size_t n; while ((n = std::fread(b, 1, sizeof b, f)) > 0) flash.insert(flash.end(), b, b + n); std::fclose(f); }
  struct Ev { long ms; unsigned mask; };
  std::vector<Ev> script;
  if (FILE* f = std::fopen(argv[2], "r")) {
    char line[256];
    while (std::fgets(line, sizeof line, f)) {
      long ms; char names[128];
      if (line[0] == '#' || std::sscanf(line, "%ld %127s", &ms, names) != 2) continue;
      unsigned mask = 0;
      static const struct { const char* n; unsigned bit; } B[] = {{"right", 1}, {"left", 2}, {"down", 4}, {"up", 8}, {"b", 16}, {"a", 32}, {"select", 64}, {"start", 128}};
      for (char* t = std::strtok(names, "+"); t; t = std::strtok(nullptr, "+")) for (auto& b : B) if (!std::strcmp(t, b.n)) mask |= b.bit;
      script.push_back({ms, mask});
    }
    std::fclose(f);
  }
  const int seconds = std::atoi(argv[3]);
  // 2026-01-02 03:04:05 as seconds since 2000-01-01, the fixed clock run_game.mjs uses
  pw_set_time(820551845.0);
  if (!pw_load(flash.data(), (std::uint32_t)flash.size(), 0)) { std::fprintf(stderr, "could not load the flash image\n"); return 1; }
  static std::int16_t audio[8192];
  size_t si = 0;
  for (long ms = 0; ms < seconds * 1000L; ms += 10) {
    while (si < script.size() && script[si].ms <= ms) pw_buttons(script[si++].mask);
    pw_set_time(820551845.0);
    if (!pw_run(10000)) { std::printf("CPU fault at %ld ms\n", ms); break; }
    pw_audio(audio, 8192);
    pw_flash_changed();
    if (ms % 500 == 490) {
      std::uint32_t h = 2166136261u;
      const std::uint8_t* px = pw_lcd();
      for (int i = 0; i < 128 * 88; i++) h = (h ^ px[i]) * 16777619u;
      std::printf("T %.1f %08x\n", (ms + 10) / 1000.0, h);
    }
  }
  return 0;
}
