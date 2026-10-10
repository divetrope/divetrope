"""Click Play on the commercial and sample the timeline (headless Chrome).

  python tools/play_test.py <url> [seconds]
"""
import sys
import time

from playwright.sync_api import sync_playwright

url = sys.argv[1]
secs = float(sys.argv[2]) if len(sys.argv) > 2 else 20
mobile = "--mobile" in sys.argv
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    if mobile:
        ctx = b.new_context(**p.devices["iPhone 13"])
        page = ctx.new_page()
    else:
        page = b.new_page(viewport={"width": 1280, "height": 800})
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(url)
    page.wait_for_selector("#loading.done", timeout=60000)
    if mobile:
        page.tap("#play")
    else:
        page.click("#play")
    t0 = time.time()
    last = None
    while time.time() - t0 < secs:
        st = page.evaluate("({t: divetrope.t, scene: divetrope.scene, auto: divetrope.auto, sound: document.querySelector('divetrope-player').shadowRoot.getElementById('sound').getAttribute('aria-pressed'), intro: document.querySelector('divetrope-player').shadowRoot.getElementById('stage').classList.contains('is-intro'), end: document.querySelector('divetrope-player').shadowRoot.getElementById('stage').classList.contains('is-end')})")
        key = (st["scene"], st["auto"]["phase"] if st["auto"] else None)
        if key != last:
            print(f"{time.time() - t0:6.2f}s t={st['t']:.3f} scene={st['scene']} auto={st['auto'] and st['auto']['phase']} sound={st['sound']} intro={st['intro']} end={st['end']}")
            last = key
        time.sleep(0.25)
    print("errors:", errs or "none")
    b.close()
