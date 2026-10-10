"""Render a built site's Web Audio score offline to a WAV, following its autoplay timeline.

  python tools/render_score.py <site-url> <out.wav>

Opens the site, reads the autoplay plan and the manifest's score settings,
then builds a DivetropeScore on an OfflineAudioContext and uses suspend()
to change scenes at the same moments Play does (a scene changes when the
zoom crosses its midpoint).
"""
import base64
import sys

from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
JS = r"""
async () => {
  const plan = divetrope.plan, N = divetrope.layers;
  const manifest = await (await fetch(document.querySelector('divetrope-player').getAttribute('src'))).json();
  const loop = false;
  // Same section shape as the engine: sinusoid per section, quintic landing.
  const shape = (k, s) => {
    if (!loop && k === N - 1) { const m = plan.m; return s * (m + s * s * ((10 - 6 * m) + s * ((8 * m - 15) + s * (6 - 3 * m)))); }
    return s - plan.a[k] * Math.sin(2 * Math.PI * s) / (2 * Math.PI);
  };
  const timeAt = (p) => {
    const k = Math.min(N - 1, Math.floor(p)), u = p - k;
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (shape(k, mid) < u) lo = mid; else hi = mid; }
    return plan.start[k] + lo * plan.T[k];
  };
  const RAMP_HALF = 0.6;   // the start ramp delays the timeline by RAMP_S / 2
  const times = [];
  for (let k = 1; k <= N; k++) times.push([Math.round((timeAt(k - 0.5) + RAMP_HALF) * 10) / 10, k === N ? 'end' : k]);
  const SR = 44100, LEN = Math.ceil(plan.total + 6);
  const ctx = new OfflineAudioContext(2, SR * LEN, SR);
  const realResume = ctx.resume.bind(ctx);
  let rendering = false;
  ctx.resume = async () => { if (rendering) return realResume(); };
  window.AudioContext = function () { return ctx; };
  const score = new DivetropeScore(manifest.score, N);
  await score.start();
  score.scene(0);
  times.forEach(([t, s]) => ctx.suspend(t).then(() => { score.scene(s); realResume(); }));
  // Timers do not run on the offline clock, so drive the arpeggio scheduler by hand.
  const busy = new Set(times.map(([t]) => t.toFixed(1)));
  for (let t = 0.1; t < LEN - 0.2; t += 0.1) {
    if (busy.has(t.toFixed(1))) continue;
    ctx.suspend(Math.round(t * 10) / 10).then(() => { score.tick(); realResume(); });
  }
  rendering = true;
  const buf = await ctx.startRendering();
  const n = buf.length, ch = [buf.getChannelData(0), buf.getChannelData(1)];
  const bytes = new Uint8Array(44 + n * 4);
  const dv = new DataView(bytes.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, n * 4, true);
  let peak = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) {
    const v = Math.max(-1, Math.min(1, ch[c][i])); peak = Math.max(peak, Math.abs(v));
    dv.setInt16(44 + i * 4 + c * 2, v * 32767, true);
  }
  let s = ''; for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return { b64: btoa(s), peak };
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    page = b.new_page()
    page.goto(url)
    page.wait_for_function("window.divetrope && divetrope.plan", timeout=60000)
    res = page.evaluate(JS)
    open(out, "wb").write(base64.b64decode(res["b64"]))
    print("peak", round(res["peak"], 3), "->", out)
    b.close()
