#!/usr/bin/env python3
# web-piece tests - drive the real app in a phone-sized Chromium (needs: pip install playwright).
# Copyright (C) 2026 the web-piece authors. GPL-3.0-or-later; see LICENSE. No warranty.
#
#   python3 tests/e2e.py <update120.exe> <game archive or .pex> [url] [screenshot dir]
#
# Neither file is part of this project: the first is Aquaplus's system updater, the second any P/ECE game
# download (the checks were written with "Odekake Multi", as_mult.exe). Start the site first: bash run.sh
# Checks: first-run setup, system import, game import straight from the download, booting to the P/ECE's
# menu, starting the game with touch and keyboard, sound, flash saving, .pfi download and re-import,
# the files list, reload.
import sys, os, time, hashlib

def main():
    from playwright.sync_api import sync_playwright
    system, game = sys.argv[1], sys.argv[2]
    url = sys.argv[3] if len(sys.argv) > 3 else 'http://localhost:8769/'
    shots = sys.argv[4] if len(sys.argv) > 4 else None
    if shots: os.makedirs(shots, exist_ok=True)
    fails = []
    def check(name, ok, detail=''):
        print(('ok    ' if ok else 'FAIL  ') + name + (('  ' + str(detail)) if detail != '' else ''))
        if not ok: fails.append(name)
    def shot(pg, name):
        if shots: pg.screenshot(path=os.path.join(shots, name + '.png'))

    with sync_playwright() as p:
        b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
        pg = ctx.new_page()
        errors = []
        pg.on('pageerror', lambda e: errors.append(str(e)))
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        P = 'window.webPiece.player'
        status = lambda: pg.inner_text('#lib-status')
        screen = lambda: pg.evaluate("(() => { const px = %s.m.lcd; let h = 2166136261, ink = 0; for (const v of px) { h = Math.imul(h ^ v, 16777619); if (v) ink++; } return [h >>> 0, ink]; })()" % P)
        def wait_screen_change(before, seconds=8):
            end = time.time() + seconds
            while time.time() < end:
                now = screen()
                if now[0] != before[0]: return now
                time.sleep(0.1)
            return screen()

        pg.goto(url); pg.wait_for_function("document.querySelector('#lib-status').textContent.includes('system file')")
        check('first run asks for the system file', pg.locator('#system-banner:not(.hidden)').count() == 1 and pg.locator('#games-banner.hidden').count() == 1)
        shot(pg, '1-setup')

        # --- a game before the system: refused with a reason
        pg.set_input_files('#system-banner .import-input', [game]); pg.wait_for_selector('#sheet:not(.hidden)')
        check('a game without the system file is refused with a reason', 'system file first' in pg.inner_text('#sheet-body'), pg.inner_text('#sheet-body')[:80])
        pg.click('#sheet-actions .btn')

        # --- the system, straight from Aquaplus's updater
        pg.set_input_files('#system-banner .import-input', [system])
        pg.wait_for_function("document.querySelector('#lib-status').textContent.startsWith('System')", timeout=30000)
        check('the system is taken out of the updater', pg.evaluate('window.webPiece.system.version') not in ('', '?') and pg.locator('#games-banner:not(.hidden)').count() == 1, status())

        # --- the game, straight from its download
        pg.set_input_files('#games-banner .import-input', [game]); pg.wait_for_selector('.game', timeout=60000)
        title = pg.inner_text('.game .name')
        check('the game is found inside its download and gets a unit', status() == '1 game on 1 unit' and pg.locator('.game .thumb img').count() == 1, '%s | %s' % (title, pg.inner_text('.card .meta')))
        files = pg.evaluate('window.webPiece.units[0].files.map(f => f.name)')
        check('the unit holds the launcher and the game files only', 'startup.pex' in files and 'date.pex' not in files and any(f.endswith('.pex') and f != 'startup.pex' for f in files), ' '.join(files))
        shot(pg, '2-library')

        # --- switch on: the P/ECE's own menu appears
        digest = "window.webPiece.db.get('flash:' + window.webPiece.units[0].id).then(f => crypto.subtle.digest('SHA-1', f)).then(h => Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, '0')).join(''))"
        flash_before = pg.evaluate(digest)
        pg.click('.game .name'); pg.wait_for_function("%s.m && %s.raf" % (P, P))
        time.sleep(3.0)
        menu = screen()
        check('it boots to the P/ECE menu', menu[1] > 2000 and pg.evaluate('%s.m.frames' % P) > 100, '%d dark dots, %d screen updates' % (menu[1], pg.evaluate('%s.m.frames' % P)))
        shot(pg, '3-menu')

        # --- A (touch) starts the game
        a = pg.locator('.pbtn[data-btn="32"]').bounding_box()
        pg.touchscreen.tap(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2)
        started = wait_screen_change(menu); time.sleep(3.0)
        title_screen = screen()
        check('a tap on A starts the game', started[0] != menu[0] and title_screen[0] != menu[0], '%d dark dots' % title_screen[1])
        shot(pg, '4-title')

        # --- START (keyboard), then A a few times; the game makes sound and the picture keeps changing
        pg.keyboard.down('Enter'); time.sleep(0.15); pg.keyboard.up('Enter'); time.sleep(2.5)
        seen = {title_screen[0]}
        heard = 0
        for i in range(6):
            pg.keyboard.down('x'); time.sleep(0.15); pg.keyboard.up('x'); time.sleep(1.6)
            seen.add(screen()[0])
            heard = max(heard, pg.evaluate("(() => { const a = %s.audio; if (!a) return -1; let n = 0; for (const v of a.ring) if (v) n++; return n; })()" % P))
        check('START and A move the game along', len(seen) >= 3, '%d different screens' % len(seen))
        check('sound is produced', heard > 1000, '%d samples in the buffer' % heard)
        check('it keeps up with real time', pg.evaluate('%s.slow' % P) < 30 and not pg.evaluate('%s.fault' % P))
        shot(pg, '5-playing')

        # --- switch off: whatever the game wrote to flash is kept
        pg.click('#btn-back'); pg.wait_for_selector('#library.active'); time.sleep(0.3)
        saved = pg.evaluate("window.webPiece.db.get('flash:' + window.webPiece.units[0].id).then(f => f.length)")
        check('what the game saved to flash is kept after switching off', saved in (0x80000, 0x200000) and status() == '1 game on 1 unit' and pg.evaluate(digest) != flash_before, 'flash %d KB, changed by the game' % (saved // 1024))

        # --- download the flash image, import it again
        pg.click('.card .more'); pg.click("#sheet-actions .btn:has-text('Download the flash image')"); time.sleep(0.3)
        pfi = bytes(pg.evaluate("Array.from(window.webPiece.lastDownload.bytes)"))
        check('a unit downloads as a .pfi', pfi[:4] == b'1IFP' and len(pfi) == 48 + saved and pg.evaluate('window.webPiece.lastDownload.name') == title + '.pfi', pg.evaluate('window.webPiece.lastDownload.name'))
        if shots: open(os.path.join(shots, 'unit.pfi'), 'wb').write(pfi)
        pg.set_input_files('.import-row .import-input', [{'name': 'backup.pfi', 'mimeType': 'application/octet-stream', 'buffer': pfi}])
        pg.wait_for_function("document.querySelector('#lib-status').textContent.startsWith('2 games on 2')")
        check('a .pfi imports as a unit', True, pg.inner_text('#toast'))
        same = pg.evaluate("Promise.all(window.webPiece.units.map(u => window.webPiece.db.get('flash:' + u.id))).then(([a, b]) => a.length === b.length && a.every((v, i) => v === b[i]))")
        check('the re-imported unit is identical', same)
        pg.set_input_files('.import-row .import-input', [{'name': 'notes.bin', 'mimeType': 'application/octet-stream', 'buffer': b'\x01' * 4000}])
        time.sleep(0.6)
        check('an unrelated file is not taken for a game', status().startswith('2 games on 2'), pg.inner_text('#toast') if pg.locator('#sheet.hidden').count() else pg.inner_text('#sheet-body')[:90])
        if pg.locator('#sheet:not(.hidden)').count(): pg.click('#sheet-actions .btn')

        # --- files on a unit: add one, list, delete
        pg.locator('.card .more').first.click()
        with pg.expect_file_chooser() as fc: pg.click("#sheet-actions .btn:has-text('Add files')")
        fc.value.set_files([{'name': 'HELLO.DAT', 'mimeType': 'application/octet-stream', 'buffer': b'hello' * 1000}])
        pg.wait_for_function("document.querySelector('#toast').textContent.includes('1 file')")
        pg.locator('.card .more').first.click(); pg.click("#sheet-actions .btn:has-text('Files on this unit')"); pg.wait_for_selector('.files')
        listed = pg.inner_text('.files')
        check('a file can be added to a unit', 'hello.dat' in listed, 'hello.dat listed' if 'hello.dat' in listed else listed[:120])
        shot(pg, '6-files')
        n_rows = pg.locator('.files tr').count()
        pg.locator('.files tr', has_text='hello.dat').locator('[data-del]').click(); pg.wait_for_function("document.querySelectorAll('.files tr').length === %d" % (n_rows - 1))
        check('and deleted again', 'hello.dat' not in pg.inner_text('.files'))
        pg.click("#sheet-actions .btn:has-text('Close')")

        # --- everything survives a reload
        pg.reload(); pg.wait_for_function("document.querySelector('#lib-status').textContent.includes(' on ')")
        check('the library survives a reload', status().startswith('2 games on 2'), status())
        check('no errors in the browser console', not errors, errors[:3])

        # --- the real layout on a wide screen
        wide = b.new_context(viewport={'width': 1100, 'height': 620}, device_scale_factor=1)
        pw = wide.new_page(); pw.goto(url); pw.wait_for_function("document.querySelector('#lib-status').textContent.includes('system file')")
        pw.set_input_files('#system-banner .import-input', [system]); pw.wait_for_function("document.querySelector('#lib-status').textContent.startsWith('System')", timeout=30000)
        pw.click('#btn-plain'); pw.wait_for_function("%s.m && %s.raf" % (P, P)); time.sleep(3)
        lcd = pw.locator('#lcd').bounding_box(); pad = pw.locator('#dpad').bounding_box(); ab = pw.locator('.piece-ab').bounding_box()
        check('on a wide screen the pad is left of the screen and the buttons right of it', pad['x'] + pad['width'] < lcd['x'] and ab['x'] > lcd['x'] + lcd['width'], 'screen %dx%d' % (lcd['width'], lcd['height']))
        if shots: pw.screenshot(path=os.path.join(shots, '7-wide.png'))
        b.close()
    print('\n%s' % ('ALL CHECKS PASSED' if not fails else '%d CHECK(S) FAILED: %s' % (len(fails), ', '.join(fails))))
    sys.exit(1 if fails else 0)

if __name__ == '__main__': main()
