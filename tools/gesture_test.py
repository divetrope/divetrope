"""Phone-emulated check that Play moves at once, a tap keeps it playing, a swipe pauses it.

  python tools/gesture_test.py <url>
"""
import sys
import time

from playwright.sync_api import sync_playwright

url = sys.argv[1]
STATE = "({t: divetrope.t, auto: divetrope.auto && divetrope.auto.phase, playing: document.querySelector('divetrope-player').shadowRoot.getElementById('stage').classList.contains('is-playing'), sound: document.querySelector('divetrope-player').shadowRoot.getElementById('sound').getAttribute('aria-pressed')})"
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    ctx = b.new_context(**p.devices["iPhone 13"])
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto(url)
    page.wait_for_selector("#loading.done", timeout=60000)
    page.tap("#play")
    for k in range(4):
        time.sleep(0.5)
        print(f"after play +{0.5 * (k + 1):.1f}s", page.evaluate(STATE))
    page.touchscreen.tap(200, 300)          # a tap on the picture
    time.sleep(0.8)
    print("after tap on picture   ", page.evaluate(STATE))
    time.sleep(4)
    print("4 s later              ", page.evaluate(STATE))
    # A real swipe: CDP touch events moving 200 px up.
    cdp = ctx.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": 200, "y": 600}]})
    for y in range(600, 380, -20):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": 200, "y": y}]})
        time.sleep(0.016)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    time.sleep(0.8)
    print("after swipe            ", page.evaluate(STATE))
    page.tap("#auto")
    time.sleep(1.0)
    print("after Play pill +1s    ", page.evaluate(STATE))
    print("errors:", errs or "none")
    b.close()
