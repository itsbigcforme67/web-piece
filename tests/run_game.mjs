// web-piece tests - boot a system image with a game on it in the WebAssembly core, press buttons on a
// schedule, and print a hash of the screen every half second of P/ECE time (optionally saving the screens).
// Copyright (C) 2026 the web-piece authors. GPL-3.0-or-later; see LICENSE. No warranty.
//
//   node tests/run_game.mjs <update120.exe | all.bin | image.pfi> [game archive or .pex files ...] [--script file] [--seconds N] [--shots dir] [--save-flash file]
//
// Script lines:  <milliseconds> <buttons held from then on, e.g. "a", "right+b", "none">
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { Piece, compileCore, flashFromAllBin, flashFromPfi, isAllBin, isFlash, isLha, kernelVersion, pffs, BTN, LCD_W, LCD_H } from '../web/core/piece.js';

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(name); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const scriptPath = opt('--script', null), seconds = Number(opt('--seconds', 20)), shots = opt('--shots', null), saveFlash = opt('--save-flash', null);
const here = dirname(fileURLToPath(import.meta.url));
const piece = await Piece.create(await compileCore(readFileSync(join(here, '..', 'web', 'core', 'piece.wasm'))), { log: (l) => console.error('  core: ' + l) });
piece.setFixedTime(new Date(2026, 0, 2, 3, 4, 5));

const DOCS = /\.(txt|htm|html|doc|jpg|jpeg|gif|png|bmp|exe|dll|bat|lnk|ini|c|h|o|mak|pak)$/i;

// ---- the system
let flash;
const sys = new Uint8Array(readFileSync(args[0]));
if (isFlash(sys)) flash = sys.slice();
else if (flashFromPfi(sys)) flash = flashFromPfi(sys);
else if (isAllBin(sys)) flash = flashFromAllBin(sys);
else {
  const hit = piece.unpackLha(sys, (name) => /(^|\/)update\/all\.bin$/i.test(name));
  if (!hit.length) { console.error('no system image found in ' + args[0]); process.exit(1); }
  flash = flashFromAllBin(hit[0].data);
}
console.log(`system: kernel ${kernelVersion(flash)}, ${pffs.list(flash).map((f) => f.name).join(' ')}, ${pffs.free(flash) >> 10} KB free`);

// ---- the game files
for (const path of args.slice(1)) {
  const data = new Uint8Array(readFileSync(path));
  let files = [{ name: basename(path), data }];
  if (!/\.pex$/i.test(path) && isLha(data)) {
    const all = piece.unpackLha(data, (name, size) => size <= pffs.capacity(flash) && !DOCS.test(name));
    const dirs = new Set(all.filter((f) => /\.pex$/i.test(f.name)).map((f) => f.name.replace(/[^/]*$/, '')));
    files = all.filter((f) => dirs.has(f.name.replace(/[^/]*$/, '')));
  }
  for (const f of files) { const name = pffs.cleanName(f.name); if (!name) { console.log('skipped ' + f.name); continue; } pffs.add(flash, name, f.data); console.log(`added ${name} (${f.data.length} bytes)`); }
}
console.log(`files: ${pffs.list(flash).map((f) => `${f.name}:${f.size}`).join(' ')}; ${pffs.free(flash) >> 10} KB free`);
if (saveFlash) writeFileSync(saveFlash, flash);

// ---- run
const script = scriptPath ? readFileSync(scriptPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => { const [ms, b] = l.split(/\s+/); return [Number(ms), b.split('+').reduce((m, k) => m | (BTN[k] || 0), 0)]; }) : [];
if (shots) mkdirSync(shots, { recursive: true });
piece.load(flash);
const hash = () => { let h = 2166136261; for (const v of piece.lcd) h = Math.imul(h ^ v, 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
const t0 = performance.now();
let si = 0, saves = 0, samples = 0, loud = 0;
for (let ms = 0; ms < seconds * 1000; ms += 10) {
  while (si < script.length && script[si][0] <= ms) piece.buttons(script[si++][1]);
  if (!piece.run(10000)) { console.log(`CPU fault at ${ms} ms`); break; }
  const a = piece.readAudio(); samples += a.length; for (const v of a) if (v) loud++;
  if (piece.flashChanged()) { saves++; console.log(`flash written at ${(ms / 1000).toFixed(2)} s`); }
  if (ms % 500 === 490) {
    console.log(`T ${((ms + 10) / 1000).toFixed(1)} ${hash()}`);
    if (shots) { const px = piece.lcd, out = new Uint8Array(LCD_W * LCD_H); for (let i = 0; i < px.length; i++) out[i] = 255 - px[i] * 85; writeFileSync(join(shots, `t${String(ms + 10).padStart(6, '0')}.pgm`), Buffer.concat([Buffer.from(`P5\n${LCD_W} ${LCD_H}\n255\n`), out])); }
  }
}
const wall = performance.now() - t0;
console.log(`ran ${seconds} s of P/ECE time in ${(wall / 1000).toFixed(2)} s (${(seconds * 1000 / wall).toFixed(1)}x real time); ${piece.frames} screen updates, ${samples} sound samples (${loud} non-zero), flash written ${saves} time(s), CPU clock ${piece.cpuHz / 1e6} MHz`);
