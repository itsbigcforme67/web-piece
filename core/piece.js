// web-piece - Copyright (C) 2026 the web-piece authors.
// Free software under the GNU General Public License, version 3 or later; see LICENSE. No warranty.
// JavaScript side of core/piece.wasm (piece-emu compiled to WebAssembly; see ../../core and ../../third_party),
// plus everything that works directly on a P/ECE flash image: building one from the official system
// file, the .pfi container, and the flash file system (PFFS) that holds the games.
// No DOM use: works in browsers and in Node (tests/).

export const LCD_W = 128, LCD_H = 88, SAMPLE_RATE = 32000;
export const FLASH_SIZE = 0x80000;            // 512 KiB, the standard unit
export const BTN = { right: 1, left: 2, down: 4, up: 8, b: 16, a: 32, select: 64, start: 128 };

const FLASH_BASE = 0xC00000, PFFS_TOP = 0x28000, SECTOR = 4096, MAXDIR = 96, MAXFAT = 496;
const FAT_FREE = 0xFFFF, FAT_END = 0xEEEE;
const KERNEL_SIGNATURE = 'Piece Kernel Program';
const ascii = (bytes, at, n) => { let s = ''; for (let i = 0; i < n && bytes[at + i]; i++) s += String.fromCharCode(bytes[at + i]); return s; };
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const put16 = (b, o, v) => { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; };
const put32 = (b, o, v) => { put16(b, o, v & 0xFFFF); put16(b, o + 2, (v >>> 16) & 0xFFFF); };

/** Does this look like an LHA archive (.lzh), or a self-extracting .exe made from one? */
export function isLha(b) {
  for (let i = 2, end = Math.min(b.length - 5, 0x40000); i < end; i++) if (b[i] === 0x2D && b[i + 1] === 0x6C && (b[i + 2] === 0x68 || b[i + 2] === 0x7A) && b[i + 4] === 0x2D) return true;
  return false;
}

// ------------------------------------------------------------------ flash images
/** Is this the "all.bin" from Aquaplus's system updater (the kernel, launcher and system files)? */
export const isAllBin = (bytes) => bytes.length >= 0x26000 && bytes.length <= 0x200000 - 0x2000 && ascii(bytes, 8, 20) === KERNEL_SIGNATURE;
/** Is this the raw contents of a P/ECE flash chip? */
export const isFlash = (bytes) => (bytes.length === 0x80000 || bytes.length === 0x100000 || bytes.length === 0x200000) && ascii(bytes, 0x2008, 20) === KERNEL_SIGNATURE;

/** A factory-fresh flash from all.bin: boot vector, an empty sector, then the system image (what the updater writes). */
export function flashFromAllBin(allBin, size = FLASH_SIZE) {
  if (!isAllBin(allBin)) throw new Error('this is not a P/ECE system image (all.bin)');
  const flash = new Uint8Array(size).fill(0xFF);
  flash.set([0x04, 0x20, 0xC0, 0x00], 0);       // reset vector: 0x00C02004
  flash.set(allBin.subarray(0, size - 0x2000), 0x2000);
  return flash;
}
/** "ver1.20" and so on, from the kernel's banner. */
export function kernelVersion(flash) { const m = /ver([0-9.]+)/.exec(ascii(flash, 0x2008, 48)); return m ? m[1] : '?'; }

/** A .pfi file (the flash-image container the P/ECE emulators share) -> the flash inside it, or null. */
export function flashFromPfi(bytes) {
  if (bytes.length < 40 || bytes[3] !== 0x50 || bytes[2] !== 0x46 || bytes[1] !== 0x49) return null;      // 'PFI' + version byte, little-endian
  const offset = u32(bytes, 4);
  if (offset < 40 || u16(bytes, 8) !== 32 || offset >= bytes.length) return null;
  const size = Math.min(u32(bytes, 8 + 28) - FLASH_BASE, bytes.length - offset);
  const flash = bytes.slice(offset, offset + size);
  return isFlash(flash) ? flash : null;
}
/** The flash wrapped as a .pfi file, for piece-emu, P/EMU and friends. */
export function pfiFromFlash(flash) {
  const out = new Uint8Array(48 + flash.length).fill(0xFF);
  out.set([0x31, 0x49, 0x46, 0x50], 0);
  put32(out, 4, 48);
  // SYSTEMINFO of a standard unit: size, hardware 1.00, BIOS 1.29, BIOS date, 24 MHz, 3.3 V, SRAM 0x100000-0x140000, PFFS from 0xC28000
  put16(out, 8, 32); put16(out, 10, 0x0100); put16(out, 12, 0x011D); put16(out, 14, 0x0AA7); put32(out, 16, 24000000); put16(out, 20, 0x0CE4); put16(out, 22, 0);
  put32(out, 24, 0x100000); put32(out, 28, 0x140000); put32(out, 32, FLASH_BASE + PFFS_TOP); put32(out, 36, FLASH_BASE + flash.length);
  out.set(flash, 48);
  return out;
}

// ------------------------------------------------------------------ the flash file system (PFFS)
// One 4 KiB master block at 0x28000 (96 directory entries of 32 bytes, then one 16-bit chain entry per
// 4 KiB sector), followed by the sectors. File names are 8.3, lower case.
const DIR0 = PFFS_TOP + 32, FAT0 = DIR0 + MAXDIR * 32;
const maxFat = (flash) => Math.min(MAXFAT, (flash.length - PFFS_TOP) >> 12);
const dirUsed = (flash, i) => { const c = flash[DIR0 + i * 32]; return c !== 0 && c !== 0xFF; };
const findDir = (flash, name) => { for (let i = 0; i < MAXDIR; i++) if (dirUsed(flash, i) && ascii(flash, DIR0 + i * 32, 24) === name) return i; return -1; };

export const pffs = {
  /** A name the P/ECE accepts: up to 8 + 3 characters of a-z, 0-9 and _. Returns '' if it cannot be made valid. */
  cleanName(name) {
    const base = String(name).split(/[\\/]/).pop().toLowerCase();
    return /^[a-z0-9_]{1,8}(\.[a-z0-9_]{1,3})?$/.test(base) ? base : '';
  },
  isFormatted: (flash) => ascii(flash, PFFS_TOP + 8, 24) === 'PFFS Master Block',
  list(flash) {
    const out = [];
    for (let i = 0; i < MAXDIR; i++) if (dirUsed(flash, i)) out.push({ name: ascii(flash, DIR0 + i * 32, 24), size: u32(flash, DIR0 + i * 32 + 28), attr: flash[DIR0 + i * 32 + 24] });
    return out;
  },
  /** Free space in bytes (whole 4 KiB sectors). */
  free(flash) { let n = 0; for (let i = 0; i < maxFat(flash); i++) if (u16(flash, FAT0 + i * 2) === FAT_FREE) n++; return n * SECTOR; },
  capacity: (flash) => (maxFat(flash) - 1) * SECTOR,
  read(flash, name) {
    const d = findDir(flash, name);
    if (d < 0) return null;
    const size = u32(flash, DIR0 + d * 32 + 28), out = new Uint8Array(size);
    let s = u16(flash, DIR0 + d * 32 + 26);
    for (let done = 0; done < size && s < maxFat(flash); done += SECTOR, s = u16(flash, FAT0 + s * 2)) out.set(flash.subarray(PFFS_TOP + s * SECTOR, PFFS_TOP + s * SECTOR + Math.min(SECTOR, size - done)), done);
    return out;
  },
  remove(flash, name) {
    const d = findDir(flash, name);
    if (d < 0) return false;
    for (let s = u16(flash, DIR0 + d * 32 + 26), guard = 0; s < maxFat(flash) && guard < MAXFAT; guard++) { const next = u16(flash, FAT0 + s * 2); put16(flash, FAT0 + s * 2, FAT_FREE); s = next; }
    flash.fill(0xFF, DIR0 + d * 32, DIR0 + d * 32 + 32);
    return true;
  },
  /** Store a file (replacing one of the same name). Throws with a readable reason if it cannot. */
  add(flash, name, data) {
    if (!pffs.isFormatted(flash)) throw new Error('the flash has no file system');
    if (pffs.cleanName(name) !== name) throw new Error(`"${name}" is not a name the P/ECE accepts (8.3, lower case)`);
    const need = (data.length + SECTOR - 1) >> 12;
    const old = findDir(flash, name);
    const oldSectors = old < 0 ? 0 : (u32(flash, DIR0 + old * 32 + 28) + SECTOR - 1) >> 12;
    if (need * SECTOR > pffs.free(flash) + oldSectors * SECTOR) throw new Error(`not enough room: ${name} needs ${need * 4} KB and ${(pffs.free(flash) + oldSectors * SECTOR) >> 10} KB is free`);
    if (old >= 0) pffs.remove(flash, name);
    let d = -1;
    for (let i = 0; i < MAXDIR && d < 0; i++) if (flash[DIR0 + i * 32] === 0xFF) d = i;
    if (d < 0) throw new Error('the directory is full (96 files)');
    const e = DIR0 + d * 32;
    flash.fill(0, e, e + 32);
    for (let i = 0; i < name.length; i++) flash[e + i] = name.charCodeAt(i);
    put32(flash, e + 28, data.length);
    let link = e + 26, from = 0;                       // where the next sector number gets written
    put16(flash, link, FAT_END);
    for (let n = 0; n < need; n++) {
      let s = from;
      while (u16(flash, FAT0 + s * 2) !== FAT_FREE) s++;
      put16(flash, link, s);
      const at = PFFS_TOP + s * SECTOR, chunk = data.subarray(n * SECTOR, (n + 1) * SECTOR);
      flash.set(chunk, at);
      link = FAT0 + s * 2; from = s + 1;
      put16(flash, link, FAT_END);
    }
  },
};

// ------------------------------------------------------------------ the machine
let compiled;
/** Fetch and compile piece.wasm once. */
export function loadCore(url = new URL('./piece.wasm', import.meta.url)) {
  if (!compiled) compiled = fetch(url).then((r) => { if (!r.ok) throw new Error('piece.wasm: ' + r.status); return r.arrayBuffer(); }).then((b) => WebAssembly.compile(b));
  return compiled;
}
export const compileCore = (bytes) => WebAssembly.compile(bytes);

const secondsSince2000 = (d = new Date()) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 1000) - 946684800;   // local time, as the P/ECE's clock shows it

export class Piece {
  static async create(module, { log = null } = {}) {
    let x;
    const mem = () => new Uint8Array(x.memory.buffer);
    let line = '';
    // The module is built for WASI but only ever prints diagnostics; nothing else is provided.
    const wasi = {
      fd_write(fd, iov, n, written) {
        const m = mem(), dv = new DataView(x.memory.buffer);
        let total = 0;
        for (let i = 0; i < n; i++) { const p = dv.getUint32(iov + i * 8, true), len = dv.getUint32(iov + i * 8 + 4, true); for (let k = 0; k < len; k++) line += String.fromCharCode(m[p + k]); total += len; }
        dv.setUint32(written, total, true);
        let nl;
        while ((nl = line.indexOf('\n')) >= 0) { if (log) log(line.slice(0, nl)); line = line.slice(nl + 1); }
        return 0;
      },
      clock_time_get(id, precision, out) { new DataView(x.memory.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true); return 0; },
      environ_get: () => 0,
      environ_sizes_get(count, size) { const dv = new DataView(x.memory.buffer); dv.setUint32(count, 0, true); dv.setUint32(size, 0, true); return 0; },
      fd_close: () => 0, fd_seek: () => 70, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8,
      random_get(p, n) { mem().fill(0, p, p + n); return 0; },
      proc_exit(code) { throw new Error('the emulator stopped (' + code + ')'); },
    };
    const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
    x = inst.exports;
    x._initialize();
    return new Piece(x);
  }

  constructor(x) {
    this.x = x;
    this.audioPtr = x.pw_alloc(8192 * 2);
    this.fixedTime = null;
    this.loaded = false;
  }
  get mem() { return new Uint8Array(this.x.memory.buffer); }
  _put(bytes) { const p = this.x.pw_alloc(bytes.length); if (!p) throw new Error('out of memory'); this.mem.set(bytes, p); return p; }

  /** Power on with this flash image (a copy is made: read it back with getFlash()). */
  load(flash) {
    this._clock();
    const p = this._put(flash);
    const ok = this.x.pw_load(p, flash.length, 0);
    this.x.pw_free(p);
    if (!ok) throw new Error(ascii(this.mem, this.x.pw_error(), 255) || 'could not start');
    this.loaded = true;
  }
  /** For tests: pin the clock (a Date) instead of following the real one. */
  setFixedTime(date) { this.fixedTime = date; this._clock(); }
  _clock() { this.x.pw_set_time(secondsSince2000(this.fixedTime || new Date())); }
  reset(cold = true) { this.x.pw_reset(cold ? 1 : 0); }
  buttons(mask) { this.x.pw_buttons(mask); }
  /** Run the machine for this many microseconds of its own time. Returns false if the CPU stopped on a fault. */
  run(us) { this._clock(); return !!this.x.pw_run(us); }
  /** The screen: LCD_W * LCD_H bytes, 0 (white) to 3 (black). A view that is only valid until the next call into the core. */
  get lcd() { return new Uint8Array(this.x.memory.buffer, this.x.pw_lcd(), LCD_W * LCD_H); }
  get frames() { return this.x.pw_frames() >>> 0; }
  /** Sound since the last call: Int16Array view (32 kHz mono), valid until the next call. */
  readAudio() { const n = this.x.pw_audio(this.audioPtr, 8192); return new Int16Array(this.x.memory.buffer, this.audioPtr, n); }
  /** The flash as it is now (a copy). */
  getFlash() { const p = this.x.pw_flash(), n = this.x.pw_flash_size(); return this.mem.slice(p, p + n); }
  /** True once after the running program wrote to the flash. */
  flashChanged() { return !!this.x.pw_flash_changed(); }
  get cpuHz() { return this.x.pw_cpu_hz() >>> 0; }
  get cycles() { return this.x.pw_cycles(); }
  get status() { const s = this.x.pw_status(); return { fault: !!(s & 1), idle: !!(s & 2), asleep: !!(s & 4) }; }
  set tickBurst(cycles) { this.x.pw_set_tick_burst(cycles); }

  /** Files in an LHA archive (.lzh, or one of Aquaplus's self-extracting .exe files): [{ name, data }] for those `want(name, size)` accepts. */
  unpackLha(bytes, want = () => true) {
    const src = this._put(bytes), out = [];
    let sjis = null;
    try { sjis = new TextDecoder('shift_jis'); } catch { /* names stay as raw bytes */ }
    try {
      if (!this.x.pw_lha_open(src, bytes.length)) return out;
      for (;;) {
        const size = this.x.pw_lha_next();
        if (size < 0) break;
        if (this.x.pw_lha_is_dir()) continue;
        const np = this.x.pw_lha_name(), m = this.mem;
        let end = np; while (m[end]) end++;
        const raw = m.slice(np, end);
        const name = (sjis ? sjis.decode(raw) : String.fromCharCode(...raw)).replace(/\\/g, '/');
        if (size > 64 * 1024 * 1024 || !want(name, size)) continue;
        const p = this.x.pw_alloc(size);
        if (!p) throw new Error('out of memory unpacking ' + name);
        const got = this.x.pw_lha_read(p, size);
        if (got === size) out.push({ name, data: this.mem.slice(p, p + size) });
        this.x.pw_free(p);
      }
    } finally { this.x.pw_lha_close(); this.x.pw_free(src); }
    return out;
  }
}
