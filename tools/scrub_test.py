"""Measure how smooth hand scrolling is: mouse-wheel notches over the page, the
player window, or the scroll section (headless Chrome).

  python tools/scrub_test.py <site-url> [page|player|section]

Sends 12 wheel notches 90 ms apart, records the dive position every frame,
and reports the largest frame-to-frame change in speed (layers/s). A
follower that jumps to a new speed on each notch shows up as large values.
"""
import sys

from playwright.sync_api import sync_playwright

site = sys.argv[1].rstrip("/") + "/"
where = sys.argv[2] if len(sys.argv) > 2 else "page"
REC = """(i) => { window.__rec = []; const el = document.querySelectorAll('divetrope-player')[i];
  const tick = (now) => { window.__rec.push([now, el.dive.t]); if (window.__rec.length < 4000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick); }"""

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1280, "height": 800})
    page.goto(site + ("demo.html" if where != "page" else ""))
    page.wait_for_function("[...document.querySelectorAll('divetrope-player')].every((e) => e.dive && e.dive.plan)", timeout=60000)
    page.wait_for_function("[...document.querySelectorAll('divetrope-player')].every((e) => e.shadowRoot.getElementById('loading').classList.contains('done'))", timeout=60000)
    idx = {"page": 0, "player": 0, "section": 1}[where]
    if where == "player":
        el = page.locator("divetrope-player.window")
        el.scroll_into_view_if_needed()
        box = el.bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] * 0.3)   # engage
        page.wait_for_timeout(800)
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] * 0.3)
    elif where == "section":
        top = page.evaluate("document.querySelectorAll('divetrope-player')[1].getBoundingClientRect().top + scrollY")
        page.evaluate(f"window.scrollTo(0, {top})")
        page.wait_for_timeout(800)
        page.mouse.move(640, 400)
    else:
        page.mouse.move(640, 400)
    page.evaluate(REC, idx)
    for _ in range(12):
        page.mouse.wheel(0, 100)
        page.wait_for_timeout(90)
    page.wait_for_timeout(1500)
    rec = page.evaluate("window.__rec")
    b.close()

v = [((b[0] + a[0]) / 2, (b[1] - a[1]) / ((b[0] - a[0]) / 1000)) for a, b in zip(rec, rec[1:]) if b[0] > a[0]]
dv = [abs(y[1] - x[1]) for x, y in zip(v, v[1:])]
moved = rec[-1][1] - rec[0][1]
print(f"{where}: moved {moved:.2f} layers over {len(rec)} frames; peak speed {max(abs(x[1]) for x in v):.2f} layers/s")
print(f"  largest frame-to-frame speed change {max(dv):.3f}; 95th pct {sorted(dv)[int(len(dv) * .95)]:.3f}")
