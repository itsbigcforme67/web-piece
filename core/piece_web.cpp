// web-piece - the P/ECE emulator as a WebAssembly module.
// Copyright (C) 2026 the web-piece authors. GPL-3.0-or-later; see LICENSE. No warranty.
//
// The machine itself is piece-emu (third_party/piece-emu, MIT, by Autch.net). This file is the thin
// layer the web page talks to: load a flash image, run for some time, read the screen and the
// sound, press buttons, notice when the flash was written. The run loop follows piece-emu's own
// single-threaded front end (its libretro core).
#include "bus.hpp"
#include "cpu.hpp"
#include "piece_peripherals.hpp"
#include "flash_sst39vf.hpp"
#include "piece_fatal.hpp"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>

extern "C" {
#include "lhasa.h"
}

#ifdef __wasm__
#define EXPORT(name) __attribute__((export_name(#name))) name
#else
#define EXPORT(name) name          // native build, for tests/native_twin.cpp
#endif

namespace {

std::unique_ptr<Bus>              g_bus;
std::unique_ptr<Cpu>              g_cpu;
std::unique_ptr<PiecePeripherals> g_periph;
std::uint64_t g_total_cycles    = 0;
std::uint64_t g_next_timer_wake = 0;
std::uint64_t g_cycle_remainder = 0;      // microseconds * Hz not yet turned into whole cycles
std::uint32_t g_cpu_hz          = 24'000'000;
std::uint32_t g_frames          = 0;      // LCD transfers completed
bool          g_frame_pending   = false;
std::uint64_t g_tick_burst      = 4000;   // see piece-emu: how often timers and interrupts are serviced, in CPU cycles
std::uint8_t  g_lcd[88][128];
char          g_error[256];
std::int64_t  g_clock           = 0;      // seconds since 2000-01-01, set by the page

void do_tick() {
    g_periph->tick(g_total_cycles);
    g_periph->intc.set_current_il(g_cpu->state.psr.il());
    g_periph->intc.poll();
    const std::uint64_t w = g_periph->next_wake_cycle();
    const std::uint64_t earliest = g_total_cycles + g_tick_burst, latest = g_total_cycles + g_tick_burst * 4;
    g_next_timer_wake = (w == UINT64_MAX) ? latest : std::clamp(w, earliest, latest);
}

}  // namespace

[[noreturn]] void piece_fatal(const std::string& message) {
    std::snprintf(g_error, sizeof g_error, "%s", message.c_str());
    std::fprintf(stderr, "piece-emu: %s\n", g_error);
    __builtin_trap();
}

extern "C" {

void* EXPORT(pw_alloc)(std::uint32_t n) { return std::malloc(n ? n : 1); }
void  EXPORT(pw_free)(void* p) { std::free(p); }
const char* EXPORT(pw_error)() { return g_error; }

// Power on with this flash image (the raw contents of the flash chip: 512 KiB, or 2 MiB for a modified unit).
int EXPORT(pw_load)(const std::uint8_t* flash, std::uint32_t flash_size, std::uint32_t sram_size) {
    g_error[0] = 0;
    if (!flash || flash_size < 0x10000 || flash_size > 0x400000 || (flash_size & 0xFFF)) { std::snprintf(g_error, sizeof g_error, "not a P/ECE flash image"); return 0; }
    if (!sram_size) sram_size = 0x40000;
    g_periph.reset(); g_cpu.reset(); g_bus.reset();
    g_bus    = std::make_unique<Bus>(sram_size, flash_size);
    g_cpu    = std::make_unique<Cpu>(*g_bus);
    g_periph = std::make_unique<PiecePeripherals>();
    g_periph->attach(*g_bus, *g_cpu);
    g_periph->sound.attach(*g_bus, g_periph->hsdma, g_periph->intc, g_periph->clk, []() { return g_total_cycles; }, &g_periph->t16_ch[1]);
    g_periph->hsdma.on_ch0_complete = []() { g_frame_pending = true; g_frames++; };
    g_periph->clk.on_clock_change = [](std::uint32_t hz) { g_cpu_hz = hz; };
    g_bus->install_flash_device(std::make_unique<Sst39vf>(Sst39vf::for_min_bytes(flash_size)));
    if (g_bus->flash_device()->size() < flash_size) { std::snprintf(g_error, sizeof g_error, "flash image is larger than any P/ECE flash chip"); return 0; }
    g_periph->rtc.set_fixed_epoch(g_clock);
    g_bus->load_flash(0u, flash, flash_size);
    g_cpu->state.pc   = g_bus->read32(Bus::FLASH_BASE);
    g_cpu_hz          = g_periph->clk.cpu_clock_hz();
    g_total_cycles    = 0; g_next_timer_wake = 0; g_cycle_remainder = 0;
    g_frame_pending   = false; g_frames = 0;
    std::memset(g_lcd, 0, sizeof g_lcd);
    return 1;
}

// The reset button: cold = as if the battery had been taken out.
void EXPORT(pw_reset)(int cold) {
    if (!g_cpu) return;
    g_periph->reset(cold != 0);
    g_cpu->reset();
    g_cpu->state.pc = g_bus->read32(Bus::FLASH_BASE);
    g_cpu_hz = g_periph->clk.cpu_clock_hz();
    g_total_cycles = 0; g_next_timer_wake = 0; g_cycle_remainder = 0; g_frame_pending = false;
}

// bit 0 right, 1 left, 2 down, 3 up, 4 B, 5 A, 6 SELECT, 7 START (1 = held)
void EXPORT(pw_buttons)(std::uint32_t mask) {
    if (!g_periph) return;
    g_periph->portctrl.set_k6(static_cast<std::uint8_t>(~mask & 0x3F) | 0xC0);
    std::uint8_t k5 = 0xFF;
    if (mask & 0x40) k5 &= ~(1 << 3);
    if (mask & 0x80) k5 &= ~(1 << 4);
    g_periph->portctrl.set_k5(k5);
}

// The real-time clock follows the page: local time as seconds since 2000-01-01 00:00:00.
void EXPORT(pw_set_time)(double seconds_since_2000) {
    g_clock = static_cast<std::int64_t>(seconds_since_2000);
    if (g_periph) g_periph->rtc.set_fixed_epoch(g_clock);
}

void EXPORT(pw_set_tick_burst)(std::uint32_t cycles) { if (cycles >= 250) g_tick_burst = cycles; }

// Run the machine for this many microseconds of its own time. Returns 0 if the CPU has stopped on a fault.
int EXPORT(pw_run)(std::uint32_t us) {
    if (!g_cpu) return 0;
    if (us > 200000) us = 200000;
    const std::uint64_t n = g_cycle_remainder + static_cast<std::uint64_t>(us) * g_cpu_hz;
    const std::uint64_t target = g_total_cycles + n / 1000000u;
    g_cycle_remainder = n % 1000000u;

    while (g_total_cycles < target && !g_cpu->state.fault) {
        const std::uint64_t stop = std::min(g_next_timer_wake, target);
        while (!g_cpu->state.in_halt && !g_cpu->state.fault && g_total_cycles < stop) g_total_cycles += g_cpu->step();
        if (g_cpu->state.fault) break;
        if (g_total_cycles >= g_next_timer_wake) do_tick();
        if (g_cpu->state.in_halt) {
            // Nothing to execute until an interrupt: jump to the next event (at least one tick burst ahead).
            const bool sleep = g_cpu->state.halt_mode == CpuState::HaltMode::Slp;
            const std::uint64_t wake = sleep ? g_periph->sleep_wake_cycle() : g_periph->next_wake_cycle();
            const std::uint64_t raw = (wake == UINT64_MAX) ? target : wake;
            g_total_cycles = std::min(std::max(raw, g_total_cycles + g_tick_burst), target);
            do_tick();
        }
    }
    g_cpu_hz = g_periph->clk.cpu_clock_hz();
    if (g_frame_pending) { g_periph->lcd.to_pixels(g_lcd); g_frame_pending = false; }
    return g_cpu->state.fault ? 0 : 1;
}

// The screen: 88 rows of 128 bytes, 0 (white) to 3 (black). Valid until the next pw_run().
const std::uint8_t* EXPORT(pw_lcd)() { return &g_lcd[0][0]; }
std::uint32_t EXPORT(pw_frames)() { return g_frames; }
// Sound: signed 16-bit mono at 32000 Hz.
std::uint32_t EXPORT(pw_audio)(std::int16_t* out, std::uint32_t max) { return g_periph ? static_cast<std::uint32_t>(g_periph->sound.pop(out, max)) : 0; }

const std::uint8_t* EXPORT(pw_flash)() { return g_bus ? g_bus->flash_device()->mem_ptr() : nullptr; }
std::uint32_t EXPORT(pw_flash_size)() { return g_bus ? static_cast<std::uint32_t>(g_bus->flash_device()->size()) : 0; }
// True once after the running program has written to the flash (a save).
int EXPORT(pw_flash_changed)() {
    if (!g_bus) return 0;
    FlashDevice* fd = g_bus->flash_device();
    if (!fd->any_dirty()) return 0;
    fd->clear_dirty();
    return 1;
}

std::uint32_t EXPORT(pw_cpu_hz)() { return g_cpu_hz; }
std::uint32_t EXPORT(pw_pc)() { return g_cpu ? g_cpu->state.pc : 0; }
double EXPORT(pw_cycles)() { return static_cast<double>(g_total_cycles); }
// bit 0 = stopped on a fault, bit 1 = idle (HALT), bit 2 = asleep (SLEEP)
std::uint32_t EXPORT(pw_status)() {
    if (!g_cpu) return 0;
    return (g_cpu->state.fault ? 1u : 0) | (g_cpu->state.in_halt ? 2u : 0) | ((g_cpu->state.in_halt && g_cpu->state.halt_mode == CpuState::HaltMode::Slp) ? 4u : 0);
}

// ---- LHA archives (.lzh, and the self-extracting .exe files Aquaplus distributes) ----------------------
struct MemStream { const std::uint8_t* data; std::size_t len, pos; };
static MemStream      g_lha_mem;
static LHAInputStream* g_lha_stream = nullptr;
static LHAReader*      g_lha_reader = nullptr;
static LHAFileHeader*  g_lha_header = nullptr;
static char            g_lha_name[1024];

static int lha_mem_read(void* handle, void* buf, size_t n) {
    MemStream* m = static_cast<MemStream*>(handle);
    const std::size_t left = m->len - m->pos, take = n < left ? n : left;
    std::memcpy(buf, m->data + m->pos, take);
    m->pos += take;
    return static_cast<int>(take);
}
static const LHAInputStreamType kMemStreamType = { lha_mem_read, nullptr, nullptr };

void EXPORT(pw_lha_close)() {
    if (g_lha_reader) lha_reader_free(g_lha_reader);
    if (g_lha_stream) lha_input_stream_free(g_lha_stream);
    g_lha_reader = nullptr; g_lha_stream = nullptr; g_lha_header = nullptr;
}
// The data must stay where it is until pw_lha_close().
int EXPORT(pw_lha_open)(const std::uint8_t* data, std::uint32_t len) {
    pw_lha_close();
    g_lha_mem = MemStream{data, len, 0};
    g_lha_stream = lha_input_stream_new(&kMemStreamType, &g_lha_mem);
    if (!g_lha_stream) return 0;
    g_lha_reader = lha_reader_new(g_lha_stream);
    return g_lha_reader ? 1 : 0;
}
// Move to the next file. Returns its size, or -1 at the end. Its path (bytes as stored, usually Shift-JIS) is at pw_lha_name().
double EXPORT(pw_lha_next)() {
    if (!g_lha_reader) return -1;
    g_lha_header = lha_reader_next_file(g_lha_reader);
    if (!g_lha_header) return -1;
    std::snprintf(g_lha_name, sizeof g_lha_name, "%s%s", g_lha_header->path ? g_lha_header->path : "", g_lha_header->filename ? g_lha_header->filename : "");
    return static_cast<double>(g_lha_header->length);
}
const char* EXPORT(pw_lha_name)() { return g_lha_name; }
int EXPORT(pw_lha_is_dir)() { return g_lha_header && std::strcmp(g_lha_header->compress_method, "-lhd-") == 0; }
// Unpack the current file into `out`. Returns the number of bytes written.
std::uint32_t EXPORT(pw_lha_read)(std::uint8_t* out, std::uint32_t cap) {
    if (!g_lha_reader || !g_lha_header) return 0;
    std::uint32_t n = 0;
    while (n < cap) {
        const std::size_t got = lha_reader_read(g_lha_reader, out + n, cap - n);
        if (!got) break;
        n += static_cast<std::uint32_t>(got);
    }
    return n;
}

}  // extern "C"
