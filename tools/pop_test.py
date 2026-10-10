"""Check that no layer pops in as the zoom crosses a scene boundary.

  python tools/pop_test.py <site-url>

For each boundary k it compares the screen centre a hair before and after k,
and the same-sized step in mid-scene as a noise floor. A layer popping in at
the boundary shows up as a boundary change well above that floor. Exits
non-zero if any boundary is more than twice its scene's floor.
"""
import io
import sys

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

url = sys.argv[1]
STEP = 0.001
bad = []
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page(viewport={"width": 1280, "height": 800})
    page.goto(url)
    page.wait_for_selector("#loading.done", timeout=60000)
    page.evaluate("document.querySelector('divetrope-player').seek(0.5)")   # let the intro fade out first
    page.wait_for_timeout(2000)
    n = page.evaluate("divetrope.layers")

    def grab(t):
        page.evaluate(f"document.querySelector('divetrope-player').seek({t})")
        page.wait_for_timeout(600)
        png = page.screenshot(clip={"x": 580, "y": 340, "width": 120, "height": 120})
        return np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).astype(np.float32)

    def change(t0, t1):
        return float(np.abs(grab(t0) - grab(t1)).mean(axis=2).max())

    for k in range(1, n):
        edge = change(k - STEP / 2, k + STEP / 2)
        floor = change(k - 0.4 - STEP / 2, k - 0.4 + STEP / 2)
        ok = edge <= 2 * max(floor, 8)
        print(f"{'ok  ' if ok else 'POP '} boundary {k}: max change {edge:5.1f} (mid-scene floor {floor:5.1f})")
        if not ok:
            bad.append(k)
    b.close()
print("PASS" if not bad else f"FAIL: pops at {bad}")
sys.exit(1 if bad else 0)
