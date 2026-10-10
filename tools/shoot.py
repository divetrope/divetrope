"""Screenshot the live page at given dive positions (headless Chrome via Playwright).

  python shoot.py <url> <t> [<t> ...] [--size 1600x900] [--motion]

Positions are in layers (0 = Earth). Without --motion the context forces
prefers-reduced-motion, which makes the engine jump straight to the target, so
each shot is deterministic. With --motion it scrolls with real wheel events and
also reports the position over time, which checks the smoothing and the wrap.
"""
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "qa"


def main():
    args = sys.argv[1:]
    url = args.pop(0)
    size, motion = (1600, 900), False
    ts = []
    while args:
        a = args.pop(0)
        if a == "--size":
            w, h = args.pop(0).split("x")
            size = (int(w), int(h))
        elif a == "--motion":
            motion = True
        else:
            ts.append(float(a))
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True, args=["--enable-gpu"])
        ctx = browser.new_context(viewport={"width": size[0], "height": size[1]},
                                  reduced_motion="no-preference" if motion else "reduce")
        page = ctx.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        page.wait_for_selector("#loading.done", timeout=60000)
        info = page.evaluate("({n: divetrope.layers, layerPx: divetrope.layerPx, loopPx: divetrope.loopPx})")
        print(f"layers={info['n']} layerPx={info['layerPx']:.0f}")
        if motion:
            page.mouse.move(size[0] / 2, size[1] / 2)
            t0 = time.time()
            samples = []
            for k in range(160):
                page.mouse.wheel(0, 120)
                time.sleep(0.03)
                if k % 10 == 0:
                    samples.append((round(time.time() - t0, 2), round(page.evaluate("divetrope.t"), 3),
                                    page.evaluate("scrollY")))
            for s in samples:
                print("  t=%5.2fs dive=%7.3f scrollY=%d" % s)
            page.screenshot(path=str(OUT / "site_motion.jpg"), type="jpeg", quality=85)
        for t in ts:
            y = info["loopPx"] + t * info["layerPx"]
            page.evaluate(f"window.scrollTo(0, {y})")
            page.wait_for_timeout(250)
            page.wait_for_function("divetrope.decoded.filter(Boolean).length >= 3", timeout=20000)
            page.wait_for_timeout(500)
            out = OUT / f"site_{size[0]}x{size[1]}_t{t:05.2f}.jpg"
            page.screenshot(path=str(out), type="jpeg", quality=85)
            print(f"  {out.name} dive={page.evaluate('divetrope.t'):.3f}")
        if errors:
            print("console:", *errors, sep="\n  ")
        browser.close()


if __name__ == "__main__":
    main()
