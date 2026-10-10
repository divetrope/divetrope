"""Check the three embeds on a built site's demo.html (headless Chrome).

  python tools/embed_test.py <site-url> [--mobile] [--shots <dir>]

Player window: the wheel scrolls the page (never the player), Play moves it,
More opens the text while it keeps moving, a sideways drag scrubs. Scroll
section: page scroll drives it while pinned and hands back after the end.
Iframe: ?autoplay=1 starts muted once in view. Exits non-zero on a failure.
"""
import sys
import time

from playwright.sync_api import sync_playwright

args = sys.argv[1:]
site = args.pop(0).rstrip("/") + "/"
mobile = "--mobile" in args
shots = args[args.index("--shots") + 1] if "--shots" in args else None
API = "document.querySelectorAll('divetrope-player')[%d].dive"
bad = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        bad.append(what)


def shot(page, name):
    if shots:
        page.screenshot(path=f"{shots}/embed_{'phone' if mobile else 'desk'}_{name}.png")


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    ctx = b.new_context(**p.devices["iPhone 13"]) if mobile else b.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(site + "demo.html")
    page.wait_for_function("[...document.querySelectorAll('divetrope-player')].every((e) => e.dive && e.dive.plan)", timeout=60000)
    page.wait_for_function("[...document.querySelectorAll('divetrope-player')].every((e) => e.shadowRoot.getElementById('loading').classList.contains('done'))", timeout=60000)
    modes = page.evaluate("[...document.querySelectorAll('divetrope-player')].map((e) => e.dive.mode)")
    check(modes == ["player", "scroll"], f"two components on the page: {modes}")

    # ---- player window
    player = page.locator("divetrope-player.window")
    player.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = player.bounding_box()
    y0 = page.evaluate("scrollY")
    if not mobile:
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(400)
        check(page.evaluate("scrollY") > y0 + 100, "wheel over the player scrolls the page")
        check(abs(page.evaluate(API % 0 + ".t")) < 1e-6, "wheel does not move the player")
        player.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
    shot(page, "player_intro")
    player.locator("#play").click()
    page.wait_for_timeout(2500)
    t1 = page.evaluate(API % 0 + ".t")
    check(t1 > 0.03 and page.evaluate(API % 0 + ".playing"), f"Play moves the player (t={t1:.3f})")
    player.locator("#more").click()
    page.wait_for_timeout(800)
    st = page.evaluate("(() => { const r = document.querySelector('divetrope-player.window').shadowRoot;"
                       " return {exp: r.getElementById('stage').classList.contains('is-expanded'),"
                       " h: r.getElementById('details').getBoundingClientRect().height}; })()")
    check(st["exp"] and st["h"] > 20 and page.evaluate(API % 0 + ".playing"), f"More opens the text while playing ({st})")
    shot(page, "player_more")
    player.locator("#auto").click()
    page.wait_for_function(API % 0 + ".auto === null", timeout=15000)
    t_stop = page.evaluate(API % 0 + ".t")
    check(abs(t_stop - round(t_stop)) < 0.2, f"Pause eases to a scene (t={t_stop:.3f})")
    player.locator("#more").click()      # close the text so the picture is free to drag
    page.wait_for_timeout(500)
    box = player.bounding_box()
    cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.3
    page.mouse.move(cx, cy)
    page.mouse.down()
    for k in range(1, 13):
        page.mouse.move(cx - k * 25, cy)
        page.wait_for_timeout(16)
    page.mouse.up()
    page.wait_for_timeout(900)
    t_drag = page.evaluate(API % 0 + ".t")
    check(t_drag > t_stop + 0.2, f"dragging left scrubs forward ({t_stop:.2f} -> {t_drag:.2f})")
    shot(page, "player_drag")
    if not mobile:
        # Engaged now (it was pressed), so the wheel scrubs instead of scrolling...
        y1, t1 = page.evaluate("scrollY"), page.evaluate(API % 0 + ".t")
        page.mouse.move(cx, cy)
        for _ in range(4):
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(60)
        page.wait_for_timeout(900)
        t2, y2 = page.evaluate(API % 0 + ".t"), page.evaluate("scrollY")
        check(t2 > t1 + 0.4 and abs(y2 - y1) < 2, f"after a press, the wheel scrubs the player ({t1:.2f} -> {t2:.2f}, page moved {y2 - y1:.0f}px)")
        # ...until the story's end, where the page takes the wheel back.
        page.evaluate("document.querySelector('divetrope-player.window').seek(%d)" % page.evaluate(API % 0 + ".layers"))
        page.mouse.wheel(0, 300)
        page.wait_for_timeout(500)
        check(page.evaluate("scrollY") > y2 + 100, "at the end the wheel scrolls the page again")

    # ---- scroll section
    top, layer_px, n = page.evaluate("(() => { const e = document.querySelectorAll('divetrope-player')[1];"
                                     " return [e.getBoundingClientRect().top + scrollY, e.dive.layerPx, e.dive.layers]; })()")
    page.evaluate(f"window.scrollTo(0, {top - 400})")
    page.wait_for_timeout(500)
    check(page.evaluate(API % 1 + ".t") == 0, "section rests at its start before it reaches the top")
    page.evaluate(f"window.scrollTo(0, {top + 2 * layer_px})")
    page.wait_for_timeout(1500)
    t2 = page.evaluate(API % 1 + ".t")
    check(abs(t2 - 2) < 0.02, f"page scroll drives the pinned section (t={t2:.3f})")
    pinned = page.evaluate("document.querySelectorAll('divetrope-player')[1].shadowRoot.getElementById('stage').getBoundingClientRect().top")
    check(abs(pinned) < 2, f"section stage is pinned to the top ({pinned:.1f}px)")
    shot(page, "section")
    page.evaluate(f"window.scrollTo(0, {top + n * layer_px + 1200})")
    page.wait_for_timeout(1500)
    t3 = page.evaluate(API % 1 + ".t")
    check(abs(t3 - n) < 0.02, f"scrolling past the section ends it (t={t3:.3f})")

    # ---- iframe
    frame_el = page.locator(".frame iframe")
    frame_el.scroll_into_view_if_needed()
    frame = frame_el.element_handle().content_frame()
    frame.wait_for_function("window.divetrope && window.divetrope.plan", timeout=60000)
    page.wait_for_timeout(3500)
    tf = frame.evaluate("divetrope.t")
    check(tf > 0.03 and frame.evaluate("divetrope.playing"), f"iframe autoplays once in view (t={tf:.3f})")
    shot(page, "iframe")
    if not mobile:
        fbox = frame_el.bounding_box()
        fx, fy = fbox["x"] + fbox["width"] * 0.5, fbox["y"] + fbox["height"] * 0.3
        page.mouse.click(fx, fy)
        y1, t1 = page.evaluate("scrollY"), frame.evaluate("divetrope.t")
        for _ in range(4):
            page.mouse.wheel(0, 120)
            page.wait_for_timeout(60)
        page.wait_for_timeout(900)
        t2, y2 = frame.evaluate("divetrope.t"), page.evaluate("scrollY")
        check(t2 > t1 + 0.4 and abs(y2 - y1) < 2, f"iframe: after a click the wheel scrubs ({t1:.2f} -> {t2:.2f}, page moved {y2 - y1:.0f}px)")
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(2600)
    check(not frame.evaluate("divetrope.playing"), "iframe pauses when scrolled out of view")

    check(not errs, f"no page errors {errs[:3]}")
    b.close()

print("PASS" if not bad else f"FAIL: {len(bad)} check(s)")
sys.exit(1 if bad else 0)
