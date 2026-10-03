// web-piece - Copyright (C) 2026 the web-piece authors.
// Free software under the GNU General Public License, version 3 or later; see LICENSE. No warranty.
// Phone/desktop UI: the system file, importing games, P/ECE units (flash images), the P/ECE on screen, sound.
// The machine itself is core/piece.wasm (piece-emu by Autch.net; see ../third_party).
import { loadCore, Piece, BTN, LCD_W, LCD_H, SAMPLE_RATE, pffs, isAllBin, isFlash, isLha, flashFromAllBin, flashFromPfi, pfiFromFlash, kernelVersion } from './core/piece.js';
import { isZip, unzip } from './zip.js';

const $ = (s) => document.querySelector(s);

// ------------------------------------------------------------------ storage (IndexedDB)
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('web-piece', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: () => tx('readonly', (s) => s.getAllKeys()),
  };
})();

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('wpc.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wpc.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

async function sha1(bytes) {
  if (!(globalThis.crypto && crypto.subtle)) return '';      // plain http on a LAN address: no hashing available
  const h = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------------ UI helpers
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}
function sheet(title, bodyHTML, actions, onOpen) {
  return new Promise((resolve) => {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = bodyHTML || '';
    const box = $('#sheet-actions');
    box.innerHTML = '';
    const s = $('#sheet');
    const close = (v) => { s.classList.add('hidden'); s.onclick = null; resolve(v); };
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.onclick = () => close(typeof a.value === 'function' ? a.value() : a.value);
      box.appendChild(b);
    }
    s.onclick = (e) => { if (e.target === s) close(null); };
    s.classList.remove('hidden');
    if (onOpen) onOpen($('#sheet-body'), close);
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.documentElement.classList.toggle('in-player', id === 'player');
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}
function download(name, bytes) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  window.webPiece.lastDownload = { name, bytes };
}
const baseName = (n) => n.split(/[\\/]/).pop();
const dirName = (n) => n.replace(/[^/]*$/, '');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (n) => `${Math.round(n / 1024)} KB`;

// ------------------------------------------------------------------ what is stored
//   system      -> { flash: Uint8Array, version, added }   a factory-fresh flash: kernel, launcher, system files
//   flash:<id>  -> Uint8Array   one P/ECE unit: the whole contents of its flash chip (system + games + their saves)
//   meta:<id>   -> { id, name, created, modified, sha1, free, files: [{ name, size }], apps: [{ file, title, icon }] }
// A unit's flash is exactly what a real P/ECE holds, and downloads as a .pfi that other emulators open.
let units = [];
let system = null;         // { version } once the system file has been added
let tool = null;           // a spare machine: used only for unpacking archives
async function getTool() { return tool || (tool = await Piece.create(await loadCore())); }

const SYSTEM_FILES = new Set(['startup.pex', 'date.pex', 'gamepad.pex']);
let sjis = null;
try { sjis = new TextDecoder('shift_jis'); } catch { /* titles fall back to file names */ }

/** Title and icon of a .pex program, from its header: { title, icon (PNG data URL) } */
function pexInfo(pex) {
  if (pex.length < 0x30 || pex[0] !== 0x58) return { title: '', icon: '' };
  const ofsData = pex[2] | (pex[3] << 8), ofsName = pex[4] | (pex[5] << 8), ofsIcon = pex[6] | (pex[7] << 8);
  let title = '';
  if (ofsName && ofsName < pex.length) {
    let end = ofsName; while (end < pex.length && end < ofsName + 32 && pex[end]) end++;
    const raw = pex.subarray(ofsName, end);
    title = (sjis ? sjis.decode(raw) : String.fromCharCode(...raw)).trim();
  }
  let icon = '';
  if (ofsIcon && ofsIcon + 256 <= pex.length && ofsData >= ofsIcon + 256 && typeof document !== 'undefined') {
    // 32 x 32 dots, two bits each, four to a byte
    const shade = [[0xD9, 0xDF, 0xD2], [0x9E, 0xA6, 0x96], [0x5B, 0x62, 0x57], [0x16, 0x1B, 0x15]];
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d'), img = g.createImageData(32, 32);
    for (let i = 0; i < 256; i++) for (let k = 0; k < 4; k++) { const v = (pex[ofsIcon + i] >> (6 - 2 * k)) & 3; img.data.set([...shade[v], 255], (i * 4 + k) * 4); }
    g.putImageData(img, 0, 0);
    icon = c.toDataURL();
  }
  return { title, icon };
}

function describe(flash) {
  const files = pffs.list(flash);
  const apps = files.filter((f) => f.name.endsWith('.pex') && !SYSTEM_FILES.has(f.name)).map((f) => { const i = pexInfo(pffs.read(flash, f.name)); return { file: f.name, title: i.title || f.name, icon: i.icon }; });
  return { free: pffs.free(flash), size: flash.length, files: files.map((f) => ({ name: f.name, size: f.size })), apps, kernel: kernelVersion(flash) };
}
async function putUnit(meta, flash) {
  Object.assign(meta, describe(flash), { modified: Date.now(), sha1: await sha1(flash) });
  await db.set('flash:' + meta.id, flash);
  await db.set('meta:' + meta.id, meta);
  return meta;
}
const newMeta = (name) => ({ id: Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join(''), name, created: Date.now() });
function freeName(want) {
  const taken = new Set(units.map((c) => c.name.toLowerCase()));
  let name = want.trim() || 'P/ECE';
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${want} (${n})`;
  return name;
}
async function newUnit(name, flash) {
  const meta = await putUnit(newMeta(freeName(name)), flash);
  units.push(meta);
  return meta;
}
async function deleteUnit(meta) {
  await db.del('flash:' + meta.id); await db.del('meta:' + meta.id);
  units = units.filter((c) => c !== meta);
}
async function refreshStore() {
  const keys = (await db.keys()).filter((k) => typeof k === 'string');
  units = [];
  for (const k of keys) if (k.startsWith('meta:')) { const m = await db.get(k); if (m) units.push(m); }
  const s = keys.includes('system') ? await db.get('system') : null;
  system = s ? { version: s.version, added: s.added } : null;
}
async function setSystem(flash) {
  await db.set('system', { flash, version: kernelVersion(flash), added: Date.now() });
  system = { version: kernelVersion(flash), added: Date.now() };
}
/** A fresh flash for a game: the system with only the launcher on it (the clock and gamepad-test programs make way for the game). */
async function freshFlash(bare) {
  const s = await db.get('system');
  if (!s) throw new Error('the system file has not been added yet');
  const flash = s.flash.slice();
  if (bare) for (const f of pffs.list(flash)) if (f.name !== 'startup.pex') pffs.remove(flash, f.name);
  return flash;
}

// ------------------------------------------------------------------ importing
// Things that come in the same download as a game but do not go on the P/ECE.
const NOT_FOR_DEVICE = /\.(txt|htm|html|doc|pdf|jpg|jpeg|gif|png|bmp|ico|exe|dll|bat|lnk|ini|url|c|h|o|s|mak|def|prj|srf|sym|map|par|cm|cmd|pak|wav|mid|mp3|zip|lzh)$|(^|\/)(readme|makefile)[^/]*$/i;

/** Open up whatever was chosen: zips and LHA archives become their contents (one level deep is enough for real downloads). */
async function expand(fileList) {
  const t = await getTool();
  const out = [];
  for (const f of fileList) {
    const data = f.data || new Uint8Array(await f.arrayBuffer());
    const top = baseName(f.name);
    if (isAllBin(data) || isFlash(data) || flashFromPfi(data) || /\.pex$/i.test(top)) { out.push({ name: top, data }); continue; }
    try {
      if (isZip(data)) { for (const e of await unzip(data, (n) => !NOT_FOR_DEVICE.test(n) || /all\.bin$/i.test(n))) out.push({ name: top + '/' + e.name, data: e.data }); continue; }
      if (isLha(data)) {
        let inner = t.unpackLha(data, (n, size) => size <= 0x200000 && (!NOT_FOR_DEVICE.test(n) || /all\.bin$/i.test(n)));
        // the system updater also carries tools for a real unit: only its system image is wanted
        if (inner.some((e) => isAllBin(e.data))) inner = inner.filter((e) => isAllBin(e.data));
        if (inner.length) { for (const e of inner) out.push({ name: top + '/' + e.name, data: e.data }); continue; }
      }
    } catch (e) { toast(`${top}: ${e.message}`); continue; }
    out.push({ name: top, data });
  }
  return out;
}

/** Take whatever the user chose: the system file, flash images, games (loose files or the download as it came). `target` = add to this unit. */
async function importFiles(fileList, target) {
  const files = await expand(fileList);
  const done = { system: false, units: 0, games: 0, added: 0 }, problems = [];
  const loose = [];

  for (const f of files) {
    const fromPfi = flashFromPfi(f.data);
    if (isAllBin(f.data)) {
      // (the updater also carries a 2 MB variant for modified units; the standard one comes first and is the one kept)
      if (!done.system && !/\/2mb\//i.test(f.name)) { await setSystem(flashFromAllBin(f.data)); done.system = true; }
    } else if (fromPfi || isFlash(f.data)) {
      const flash = fromPfi || f.data;
      if (target) { problems.push(`${baseName(f.name)} is a whole P/ECE: import it from the library screen`); continue; }
      const meta = await newUnit(baseName(f.name).replace(/\.[^.]*$/, ''), flash);
      if (meta.apps.length === 1) { meta.name = ''; meta.name = freeName(meta.apps[0].title); await db.set('meta:' + meta.id, meta); }
      done.units++;
      if (!system) {            // a unit's own flash also serves as the system: the same thing with the extra files taken off
        const sys = flash.slice();
        for (const x of pffs.list(sys)) if (!SYSTEM_FILES.has(x.name)) pffs.remove(sys, x.name);
        await setSystem(sys);
      }
    } else if (!NOT_FOR_DEVICE.test(f.name)) loose.push(f);
  }

  // What is left are files for the P/ECE. Those in one folder (or chosen together) belong together.
  const groups = new Map();
  for (const f of loose) { const d = dirName(f.name); if (!groups.has(d)) groups.set(d, []); groups.get(d).push(f); }
  for (const [, group] of groups) {
    const named = group.map((f) => ({ ...f, pname: pffs.cleanName(f.name) }));
    for (const f of named) if (!f.pname) problems.push(`${baseName(f.name)}: the P/ECE cannot hold a file with that name`);
    const good = named.filter((f) => f.pname);
    const pex = good.filter((f) => f.pname.endsWith('.pex'));
    if (!good.length) continue;
    try {
      if (target) {
        const flash = await db.get('flash:' + target.id);
        for (const f of good) pffs.add(flash, f.pname, f.data);
        await putUnit(target, flash);
        done.added += good.length;
      } else if (pex.length) {
        if (!system) { problems.push(`${pex.map((f) => f.pname).join(', ')}: add the system file first`); continue; }
        const flash = await freshFlash(true);
        for (const f of good) pffs.add(flash, f.pname, f.data);
        const info = pexInfo(pex[0].data);
        await newUnit(info.title || pex[0].pname.replace(/\.pex$/, ''), flash);
        done.games += pex.length;
      } else if (!done.system && !done.units) problems.push(`${good.map((f) => f.pname).join(', ')}: no P/ECE program (.pex) came with ${good.length === 1 ? 'this file' : 'these files'}; to put ${good.length === 1 ? 'it' : 'them'} on a unit, use "Add files" in that unit's menu`);
    } catch (e) { problems.push(e.message); }
  }

  await refreshStore(); renderLibrary();
  const parts = [];
  if (done.system) parts.push(`the system (kernel ${system.version})`);
  if (done.units) parts.push(plural(done.units, 'P/ECE unit'));
  if (done.games) parts.push(plural(done.games, 'game'));
  if (done.added) parts.push(plural(done.added, 'file'));
  if (problems.length) sheet(parts.length ? `Added ${parts.join(', ')}` : 'Nothing was added', `<p>${problems.map(esc).join('</p><p>')}</p>`, [{ label: 'OK', value: null }]);
  else toast(parts.length ? `Added ${parts.join(', ')}` : 'Nothing for a P/ECE was found in that selection', 3200);
  return done;
}

// ------------------------------------------------------------------ library
function renderLibrary() {
  units.sort((a, b) => a.name.localeCompare(b.name));
  const grid = $('#game-grid');
  grid.innerHTML = '';
  let games = 0;
  for (const u of units) for (const app of u.apps) {
    games++;
    const el = document.createElement('div');
    el.className = 'game';
    el.setAttribute('role', 'button'); el.tabIndex = 0;
    el.innerHTML = `<div class="thumb">${app.icon ? `<img src="${app.icon}" alt="">` : `<div class="noicon">${esc((app.title || '?').trim().charAt(0).toUpperCase())}</div>`}</div>
      <div class="name">${esc(app.title)}</div>
      <div class="meta"><span>${esc(app.file)}${u.name !== app.title ? ' · ' + esc(u.name) : ''}</span></div>
      <button class="more" aria-label="Options for ${esc(app.title)}">⋯</button>`;
    el.onclick = (e) => { if (e.target.closest('.more')) unitMenu(u); else openUnit(u); };
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
    grid.appendChild(el);
  }
  $('#no-games').classList.toggle('hidden', games > 0 || units.length === 0);
  const list = $('#unit-list');
  list.innerHTML = '';
  for (const u of units) {
    const el = document.createElement('div');
    el.className = 'card';
    el.setAttribute('role', 'button'); el.tabIndex = 0;
    el.innerHTML = `<span class="chip" aria-hidden="true"></span>
      <div class="info"><div class="name">${esc(u.name)}</div><div class="meta">${plural(u.files.length, 'file')} · ${kb(u.free)} free · kernel ${esc(u.kernel || '?')}</div></div>
      <button class="more" aria-label="Options for ${esc(u.name)}">⋯</button>`;
    el.onclick = () => unitMenu(u);
    el.onkeydown = (e) => { if (e.key === 'Enter') el.click(); };
    list.appendChild(el);
  }
  $('#lib-status').textContent = !system && !units.length ? 'Needs the P/ECE system file' : units.length ? `${plural(games, 'game')} on ${plural(units.length, 'unit')}` : `System ${system.version} ready`;
  $('#system-banner').classList.toggle('hidden', !!system || units.length > 0);
  $('#games-banner').classList.toggle('hidden', !system || units.length > 0);
  document.querySelectorAll('#lib-content .section-title, #unit-list, .import-row').forEach((e) => e.classList.toggle('hidden', units.length === 0));
}

async function unitMenu(u) {
  const acts = [{ label: 'Switch on', value: 'play', cls: 'primary' }, { label: 'Files on this unit…', value: 'files' }, { label: 'Add files to this unit…', value: 'add' },
    { label: 'Download the flash image (.pfi)', value: 'save' }, { label: 'Rename…', value: 'rename' }, { label: 'Delete this unit', value: 'delete', cls: 'danger' }, { label: 'Close', value: null }];
  const v = await sheet(u.name, `<p>${plural(u.files.length, 'file')}, ${kb(u.free)} free of ${kb(pffsCapacity(u))}. Changed ${esc(ago(u.modified))}.</p>`, acts);
  if (v === 'play') openUnit(u);
  if (v === 'files') filesSheet(u);
  if (v === 'add') { const inp = $('#add-input'); inp.value = ''; inp.onchange = async () => { const f = [...inp.files]; if (f.length) await importFiles(f, u); }; inp.click(); }
  if (v === 'save') download(u.name.replace(/[\\/:*?"<>|]+/g, '_') + '.pfi', pfiFromFlash(await db.get('flash:' + u.id)));
  if (v === 'rename') {
    const name = await sheet('Rename unit', `<input type="text" id="rename" maxlength="40" value="${esc(u.name)}">`, [{ label: 'Save', value: () => $('#rename').value, cls: 'primary' }, { label: 'Cancel', value: null }]);
    if (name && name.trim() && name.trim() !== u.name) { u.name = ''; u.name = freeName(name.trim()); await db.set('meta:' + u.id, u); renderLibrary(); }
  }
  if (v === 'delete') {
    const ok = await sheet(`Delete ${u.name}?`, '<p>The unit and everything saved on it are removed from this device. Download its flash image first if you want a copy.</p>', [{ label: 'Delete', value: true, cls: 'danger' }, { label: 'Cancel', value: false }]);
    if (ok) { await deleteUnit(u); renderLibrary(); }
  }
}
const pffsCapacity = (u) => ((u.size || 0x80000) - 0x28000 - 4096);

async function filesSheet(u) {
  const flash = await db.get('flash:' + u.id);
  const files = pffs.list(flash);
  const rows = files.map((f, i) => {
    const info = f.name.endsWith('.pex') ? pexInfo(pffs.read(flash, f.name)) : { title: '', icon: '' };
    return `<tr><td>${info.icon ? `<img src="${info.icon}" alt="">` : ''}</td><td><div style="color:var(--text);font-size:14px">${esc(info.title || f.name)}</div>${esc(f.name)} · ${kb(f.size) === '0 KB' ? f.size + ' bytes' : kb(f.size)}${f.name === 'startup.pex' ? ' · the menu' : ''}</td>
      <td><button class="mini" data-get="${i}">Download</button>${f.name === 'startup.pex' ? '' : ` <button class="mini danger" data-del="${i}">Delete</button>`}</td></tr>`;
  }).join('');
  const again = await sheet(u.name, `<table class="files">${rows}</table><p>${kb(pffs.free(flash))} free.</p>`, [{ label: 'Close', value: false }], (el, close) => {
    el.querySelectorAll('[data-get]').forEach((b) => { b.onclick = () => { const f = files[+b.dataset.get]; download(f.name, pffs.read(flash, f.name)); }; });
    el.querySelectorAll('[data-del]').forEach((b) => { b.onclick = async () => { pffs.remove(flash, files[+b.dataset.del].name); await putUnit(u, flash); renderLibrary(); close(true); }; });
  });
  if (again) filesSheet(u);
}

// ------------------------------------------------------------------ player
const player = { meta: null, m: null, raf: 0, last: 0, audio: null, muted: prefs.get('muted', false), pad: {}, opening: false, mask: 0, held: {}, saveTimer: 0, saving: null, dirty: false,
  shown: new Float32Array(LCD_W * LCD_H), slow: 0, fault: false };

async function openUnit(u) {
  if (player.opening) return;
  player.opening = true;
  try {
    $('#game-title').textContent = u.apps.length === 1 ? u.apps[0].title : u.name;
    $('#game-sub').textContent = u.apps.length === 1 && u.name !== u.apps[0].title ? u.name : `kernel ${u.kernel || '?'}`;
    showView('player');
    setupAudio();
    const [module, flash] = await Promise.all([loadCore(), db.get('flash:' + u.id)]);
    if (!flash) throw new Error('the unit is missing from this device');
    const m = await Piece.create(module);
    m.load(flash);
    Object.assign(player, { meta: u, m, last: performance.now(), pad: {}, dirty: false, slow: 0, fault: false });
    player.shown.fill(0);
    note(u.apps.length ? 'Choose the game in the P/ECE\'s menu and press A.' : '');
    applySound();
    cancelAnimationFrame(player.raf);
    player.raf = requestAnimationFrame(frame);
  } catch (e) {
    console.error(e);
    toast('Could not start: ' + e.message, 4000);
    showView('library');
  } finally { player.opening = false; }
}

function note(text) { const n = $('#player-note'); n.textContent = text; n.classList.toggle('hidden', !text); }

// ---- the screen: 128 x 88 dots in four shades
const lcd = $('#lcd'), lcdCtx = lcd.getContext('2d');
const lcdImage = lcdCtx.createImageData(LCD_W, LCD_H);
let shades = null;
function readShades() {
  const cs = getComputedStyle(document.documentElement);
  shades = [0, 1, 2, 3].map((i) => { const v = (cs.getPropertyValue('--lcd-' + i) || '#888888').trim(); return [1, 3, 5].map((k) => parseInt(v.slice(k, k + 2), 16)); });
}
function drawLcd() {
  if (!shades) readShades();
  const px = player.m.lcd, shown = player.shown, out = lcdImage.data;
  const k = prefs.get('lcdSlow', true) ? 0.55 : 1;         // the real panel is slow: dots fade towards their new shade
  for (let i = 0; i < LCD_W * LCD_H; i++) {
    let v = shown[i];
    const target = px[i];
    if (v !== target) { v += k * (target - v); if (Math.abs(v - target) < 0.04) v = target; shown[i] = v; }
    const lo = v | 0, f = v - lo, a = shades[lo], b = shades[lo < 3 ? lo + 1 : 3], o = i * 4;
    out[o] = a[0] + (b[0] - a[0]) * f; out[o + 1] = a[1] + (b[1] - a[1]) * f; out[o + 2] = a[2] + (b[2] - a[2]) * f; out[o + 3] = 255;
  }
  lcdCtx.putImageData(lcdImage, 0, 0);
}

function frame(now) {
  const dt = Math.min(Math.max(now - player.last, 0), 100);   // after a pause (tab hidden) do not try to catch up
  player.last = now;
  const m = player.m;
  pollGamepad();
  m.buttons(player.mask);
  const t0 = performance.now();
  const ok = m.run(Math.round(dt * 1000));
  const cost = performance.now() - t0;
  pumpAudio();
  drawLcd();
  if (m.flashChanged()) { player.dirty = true; clearTimeout(player.saveTimer); player.saveTimer = setTimeout(saveNow, 1500); }
  // too slow to keep up for a while? say so once, rather than leaving the user to wonder about the sound
  player.slow = cost > dt * 0.95 && dt > 0 ? player.slow + 1 : Math.max(0, player.slow - 2);
  if (player.slow === 180) note('This device is struggling to run the P/ECE at full speed.');
  if (!ok && !player.fault) { player.fault = true; note('The P/ECE\'s processor has stopped (a crash in the program). Use Reset in the menu, or go back.'); }
  player.raf = requestAnimationFrame(frame);
}

function saveNow() {
  clearTimeout(player.saveTimer);
  if (!player.dirty || !player.m || !player.meta) return player.saving || Promise.resolve();
  player.dirty = false;
  const meta = player.meta, flash = player.m.getFlash();
  player.saving = (player.saving || Promise.resolve()).then(() => putUnit(meta, flash)).catch((e) => console.error(e));
  return player.saving;
}

async function closePlayer() {
  cancelAnimationFrame(player.raf); player.raf = 0;
  releaseEverything();
  if (player.m && player.m.flashChanged()) player.dirty = true;
  await saveNow();
  player.m = null; player.meta = null;
  if (player.audio) player.audio.w = player.audio.r = 0;
  await refreshStore();
  renderLibrary();
  showView('library');
}

// ---- buttons: a button can be held by a finger, a key and a gamepad at once; it is released when the last one lets go.
// A very quick tap is stretched to MIN_HOLD_MS so a program that reads the pad once a frame cannot miss it.
const MIN_HOLD_MS = 70;
function setButton(bit, down, source) {
  const h = player.held[bit] || (player.held[bit] = { by: new Set(), on: false, since: 0, timer: 0 });
  if (down) h.by.add(source); else h.by.delete(source);
  const want = h.by.size > 0;
  if (want === h.on) return;
  const push = () => { if (player.m) player.m.buttons(player.mask); };
  const off = () => { h.timer = 0; if (h.by.size || !h.on) return; h.on = false; player.mask &= ~bit; push(); show(bit, false); };
  if (want) { h.on = true; h.since = performance.now(); player.mask |= bit; push(); show(bit, true); if (player.meta && player.meta.apps.length) note(''); }
  else if (!h.timer) { const wait = MIN_HOLD_MS - (performance.now() - h.since); if (wait > 0) h.timer = setTimeout(off, wait); else off(); }
}
const DIR_CLASS = { [BTN.up]: 'up', [BTN.down]: 'down', [BTN.left]: 'left', [BTN.right]: 'right' };
function show(bit, on) {
  if (DIR_CLASS[bit]) $('#dpad').classList.toggle(DIR_CLASS[bit], on);
  else { const b = document.querySelector(`.pbtn[data-btn="${bit}"]`); if (b) b.classList.toggle('pressed', on); }
}
function releaseEverything() {
  for (const [bit, h] of Object.entries(player.held)) { h.by.clear(); clearTimeout(h.timer); h.timer = 0; if (h.on) { h.on = false; show(+bit, false); } }
  player.mask = 0;
  if (player.m) player.m.buttons(0);
}

for (const b of document.querySelectorAll('.pbtn')) {
  const bit = +b.dataset.btn;
  const down = (e) => { e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch { /* old browser */ } setButton(bit, true, 'touch' + e.pointerId); resumeAudio(); };
  const up = (e) => { e.preventDefault(); setButton(bit, false, 'touch' + e.pointerId); };
  b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}
// the direction pad is one piece, so a thumb can roll from one direction to the next (and press diagonals)
{
  const pad = $('#dpad');
  const dirs = (e) => {
    const r = pad.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    if (Math.hypot(x, y) < 0.1) return 0;
    let bits = 0;
    if (Math.abs(x) > Math.abs(y) * 0.45) bits |= x > 0 ? BTN.right : BTN.left;
    if (Math.abs(y) > Math.abs(x) * 0.45) bits |= y > 0 ? BTN.down : BTN.up;
    return bits;
  };
  const apply = (e, bits) => { for (const bit of [BTN.up, BTN.down, BTN.left, BTN.right]) setButton(bit, !!(bits & bit), 'pad' + e.pointerId); };
  pad.addEventListener('pointerdown', (e) => { e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch { /* old browser */ } apply(e, dirs(e)); resumeAudio(); });
  pad.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType === 'touch') apply(e, dirs(e)); });
  pad.addEventListener('pointerup', (e) => { e.preventDefault(); apply(e, 0); });
  pad.addEventListener('pointercancel', (e) => apply(e, 0));
  pad.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---- sound: the P/ECE mixes at 32 kHz; ask the browser for the same rate, and resample if it will not give it
function setupAudio() {
  if (player.audio) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  let ctx;
  try { ctx = new AC({ sampleRate: SAMPLE_RATE }); } catch { ctx = new AC(); }
  const ring = new Float32Array(16384);
  const a = { ctx, ring, r: 0, w: 0, step: SAMPLE_RATE / ctx.sampleRate, frac: 0, prev: 0 };
  const node = ctx.createScriptProcessor(1024, 0, 1);
  node.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    const avail = (a.w - a.r + ring.length) % ring.length;
    for (let i = 0; i < out.length; i++) {
      if (i < avail) { out[i] = ring[a.r]; a.r = (a.r + 1) % ring.length; } else out[i] = 0;
    }
    const left = (a.w - a.r + ring.length) % ring.length;
    if (left > 6000) a.r = (a.w - 2048 + ring.length) % ring.length;   // keep latency bounded
  };
  const gain = ctx.createGain(); gain.gain.value = 0.5;
  node.connect(gain); gain.connect(ctx.destination);
  player.audio = a;
}
function resumeAudio() { if (player.audio && !player.muted && player.audio.ctx.state !== 'running') player.audio.ctx.resume().catch(() => {}); }
function applySound() {
  $('#btn-sound').textContent = player.muted ? '🔇' : '🔈';
  if (player.audio) { if (player.muted) player.audio.w = player.audio.r = 0; else resumeAudio(); }
}
function pumpAudio() {
  const a = player.audio;
  for (let guard = 0; guard < 4; guard++) {
    const s = player.m.readAudio();
    if (!s.length) break;
    if (a && !player.muted) {
      if (a.step === 1) for (let i = 0; i < s.length; i++) { a.ring[a.w] = s[i] / 32768; a.w = (a.w + 1) % a.ring.length; }
      else for (let i = 0; i < s.length; i++) {            // linear interpolation to the browser's rate
        const cur = s[i] / 32768;
        while (a.frac < 1) { a.ring[a.w] = a.prev + (cur - a.prev) * a.frac; a.w = (a.w + 1) % a.ring.length; a.frac += a.step; }
        a.frac -= 1; a.prev = cur;
      }
    }
    if (s.length < 8192) break;
  }
}

// ---- keyboard and gamepad (Z and X sit like the real B and A: B on the left)
const KEYS = { ArrowUp: BTN.up, ArrowDown: BTN.down, ArrowLeft: BTN.left, ArrowRight: BTN.right, x: BTN.a, ' ': BTN.a, z: BTN.b, Enter: BTN.start, Backspace: BTN.select, Shift: BTN.select };
function onKey(e, down) {
  if (!player.m || !$('#sheet').classList.contains('hidden')) return;
  if (e.key === 'Escape') { if (down) closePlayer(); return; }
  const bit = KEYS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (!bit) return;
  e.preventDefault();
  if (e.repeat) return;
  setButton(bit, down, 'key' + e.key.toLowerCase());
  resumeAudio();
}
const PAD_BUTTONS = [[BTN.a, [0]], [BTN.b, [1, 2]], [BTN.select, [8]], [BTN.start, [9]], [BTN.up, [12]], [BTN.down, [13]], [BTN.left, [14]], [BTN.right, [15]]];
function pollGamepad() {
  if (!navigator.getGamepads) return;
  const now = {};
  for (const gp of navigator.getGamepads()) {
    if (!gp || !gp.connected) continue;
    for (const [bit, idxs] of PAD_BUTTONS) if (idxs.some((i) => gp.buttons[i] && gp.buttons[i].pressed)) now[bit] = true;
    if (gp.axes[0] < -0.5) now[BTN.left] = true; if (gp.axes[0] > 0.5) now[BTN.right] = true;
    if (gp.axes[1] < -0.5) now[BTN.up] = true; if (gp.axes[1] > 0.5) now[BTN.down] = true;
  }
  for (const [bit] of PAD_BUTTONS) if (!!now[bit] !== !!player.pad[bit]) { setButton(bit, !!now[bit], 'gamepad'); if (now[bit]) resumeAudio(); }
  player.pad = now;
}

async function playerMenu() {
  const rows = [['Direction pad', '<kbd>←</kbd> <kbd>↑</kbd> <kbd>→</kbd> <kbd>↓</kbd> · pad d-pad or stick'], ['A', '<kbd>X</kbd> <kbd>Space</kbd> · pad A'], ['B', '<kbd>Z</kbd> · pad B'],
    ['START', '<kbd>Enter</kbd> · pad Start'], ['SELECT', '<kbd>Shift</kbd> <kbd>Backspace</kbd> · pad Select'], ['Back to the P/ECE\'s menu', 'hold START + SELECT'], ['Switch off', '<kbd>Esc</kbd>']]
    .map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  const body = `<table class="keys">${rows}</table>
    <p style="margin-top:12px">A P/ECE has no pause-and-resume: games save to its memory themselves, and that memory is kept here. Going back switches it off.</p>
    <label class="field"><input type="checkbox" id="fx-slow" ${prefs.get('lcdSlow', true) ? 'checked' : ''}><span>Slow liquid crystal (dots fade, as on the real screen)</span></label>`;
  const v = await sheet(player.meta.name, body, [{ label: 'Reset the P/ECE', value: 'reset', cls: 'danger' }, { label: 'Close', value: null }], (el) => {
    el.querySelector('#fx-slow').onchange = (e) => prefs.set('lcdSlow', e.target.checked);
  });
  if (v === 'reset' && player.m) { releaseEverything(); player.m.reset(true); player.fault = false; note(''); toast('Reset'); }
  player.last = performance.now();
}

// ------------------------------------------------------------------ settings
function siteLinks() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return { source: m && repo ? `https://github.com/${m[1]}/${repo}` : '', home: prefs.get('home', '') };
}
// Arrived from a console-picker page on the same site? Remember it so Settings can link back.
(function rememberHome() {
  try {
    const r = document.referrer && new URL(document.referrer);
    const here = new URL('.', location.href).pathname;
    if (r && r.origin === location.origin && !r.pathname.startsWith(here)) prefs.set('home', r.origin + r.pathname);
  } catch { /* no referrer */ }
})();

async function settingsMenu() {
  const { source, home } = siteLinks();
  const body = `<p>The Aquaplus P/ECE in your browser. It runs the real system software and real P/ECE programs; neither is included. The system file, your units and their saves are kept in this browser's storage on this device; clearing the browser's site data erases them, so download the flash images you care about.</p>
    <p>${system ? `System file: kernel ${esc(system.version)}.` : 'No system file yet.'}</p>
    <p class="about">The emulator is <a href="https://github.com/autch/piece-emu" target="_blank" rel="noopener">piece-emu</a> by Autch.net (MIT), compiled to WebAssembly; archives are unpacked with <a href="https://github.com/fragglet/lhasa" target="_blank" rel="noopener">lhasa</a> (ISC).${
      source ? ` This app is free software (GPL-3.0): <a href="${esc(source)}" target="_blank" rel="noopener">source code</a>.` : ''} Unofficial; not affiliated with Aquaplus.</p>`;
  const acts = [{ label: system ? 'Import a game or flash image…' : 'Choose the system file…', value: 'import', cls: 'primary' }];
  if (system) acts.push({ label: 'New empty unit (system only)', value: 'new' }, { label: 'Replace the system file…', value: 'import' });
  if (home) acts.push({ label: '‹ All consoles', value: 'home' });
  acts.push({ label: 'Erase everything on this device', value: 'wipe', cls: 'danger' }, { label: 'Close', value: null });
  const v = await sheet('Settings', body, acts);
  if (v === 'import') document.querySelector('.import-input').click();
  if (v === 'new') { await newUnit('P/ECE', await freshFlash(false)); renderLibrary(); }
  if (v === 'home') location.href = home;
  if (v === 'wipe') {
    const ok = await sheet('Erase all local data?', '<p>Removes the system file and every unit, with everything saved on them, from this browser.</p>', [{ label: 'Erase', value: true, cls: 'danger' }, { label: 'Cancel', value: false }]);
    if (ok) { for (const k of await db.keys()) await db.del(k); location.reload(); }
  }
}

// ------------------------------------------------------------------ start
async function boot() {
  try { await loadCore(); } catch (e) { $('#lib-status').textContent = 'Could not load the emulator (' + e.message + ')'; return; }
  await refreshStore();
  renderLibrary();
}

$('#btn-menu').onclick = settingsMenu;
$('#btn-plain').onclick = async () => { const u = await newUnit('P/ECE', await freshFlash(false)); renderLibrary(); openUnit(u); };
$('#btn-new-unit').onclick = async () => { if (!system) { toast('Add the system file first'); return; } await newUnit('P/ECE', await freshFlash(false)); renderLibrary(); };
document.querySelectorAll('.import-input').forEach((inp) => { inp.onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) await importFiles(f); }; });
$('#btn-back').onclick = closePlayer;
$('#btn-pmenu').onclick = playerMenu;
$('#btn-sound').onclick = () => { player.muted = !player.muted; prefs.set('muted', player.muted); applySound(); };
window.addEventListener('keydown', (e) => onKey(e, true));
window.addEventListener('keyup', (e) => onKey(e, false));
window.addEventListener('blur', releaseEverything);
document.addEventListener('visibilitychange', () => { if (document.hidden) { if (player.m && player.m.flashChanged()) player.dirty = true; saveNow(); } else player.last = performance.now(); });
window.addEventListener('pagehide', () => { if (player.m && player.m.flashChanged()) player.dirty = true; saveNow(); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); if (!player.m && e.dataTransfer && e.dataTransfer.files.length) importFiles([...e.dataTransfer.files]); });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.webPiece = { player, prefs, db, get units() { return units; }, get system() { return system; }, importFiles };   // for tests and the browser console
boot();
