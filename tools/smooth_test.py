"""Play the whole commercial and measure how smooth the autoplay motion is.

Records the dive position on every animation frame, then reports speed
(layers/s), the largest frame-to-frame speed change, stalls, and where the
copy changed. Exits non-zero if the motion reverses, stalls, or jumps.

  python tools/smooth_test.py <url> [--mobile]
"""
import sys

from playwright.sync_api import sync_playwright

url = sys.argv[1]
mobile = "--mobile" in sys.argv
REC = """() => { window.__rec = []; const tick = (now) => {
  window.__rec.push([now, divetrope.t, divetrope.scene, !!divetrope.auto]);
  if (window.__rec.length < 20000) requestAnimationFrame(tick); }; requestAnimationFrame(tick); }"""

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--autoplay-policy=no-user-gesture-required"])
    if mobile:
        ctx = b.new_context(**p.devices["iPhone 13"])
    else:
        ctx = b.new_context(viewport={"width": 1280, "height": 800})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(url)
    page.wait_for_selector("#loading.done", timeout=60000)
    plan = page.evaluate("divetrope.plan")
    print("sections (s):", [round(t, 2) for t in plan["T"]], "total", round(plan["total"], 1))
    page.evaluate(REC)
    page.tap("#play") if mobile else page.click("#play")
    page.wait_for_function("!divetrope.auto && document.querySelector('divetrope-player').shadowRoot.getElementById('stage').classList.contains('is-end')",
                           timeout=int(plan["total"] * 1000 + 15000), polling=250)
    page.wait_for_timeout(500)
    rec = page.evaluate("window.__rec")
    b.close()

rec = [r for r in rec]
start = next(i for i, r in enumerate(rec) if r[3])
end = max(i for i, r in enumerate(rec) if r[3])
run = rec[start:end + 2]
dur = (run[-1][0] - run[0][0]) / 1000
v = []
for (t0, p0, *_), (t1, p1, *_) in zip(run, run[1:]):
    if t1 > t0:
        v.append(((t0 + t1) / 2000, (p1 - p0) / ((t1 - t0) / 1000)))
back = [x for x in v if x[1] < -1e-6]
cruise = [x for x in v if x[0] - v[0][0] > 1.5 and v[-1][0] - x[0] > 3]
dv = [abs(b[1] - a[1]) for a, b in zip(v, v[1:])]
fr = sorted(t1 - t0 for (t0, *_), (t1, *_) in zip(run, run[1:]))
scenes = []
for (tm, pos, sc, _a) in run:
    if not scenes or scenes[-1][1] != sc:
        scenes.append(((tm - run[0][0]) / 1000, sc, pos))
print(f"played {dur:.1f}s, final t={run[-1][1]:.3f}, frames {len(run)}, median frame {fr[len(fr) // 2]:.1f}ms")
print(f"speed layers/s: min {min(x[1] for x in cruise):.3f}  max {max(x[1] for x in v):.3f}  (cruise min/max ratio "
      f"{max(x[1] for x in v) / max(1e-9, min(x[1] for x in cruise)):.2f})")
print(f"largest frame-to-frame speed change: {max(dv):.4f} layers/s; 99th pct {sorted(dv)[int(len(dv) * .99)]:.4f}")
print("scene changes:", ", ".join(f"{s:.1f}s→{k}" for s, k, _ in scenes))
for sec in range(0, int(dur) + 1, 4):
    near = min(v, key=lambda x: abs(x[0] - v[0][0] - sec))
    print(f"  {sec:3d}s  speed {near[1]:.3f}")
bad = []
if back: bad.append(f"{len(back)} backward frames")
if min(x[1] for x in cruise) < 0.02: bad.append("stall during cruise")
if max(dv) > 0.06: bad.append("speed jump")
if errs: bad.append(f"page errors: {errs[:3]}")
print("FAIL: " + "; ".join(bad) if bad else "PASS")
sys.exit(1 if bad else 0)
