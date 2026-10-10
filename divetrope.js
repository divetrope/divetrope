// Divetrope 0.1.0: an endless zoom through nested scenes, as a
// <divetrope-player> web component. MIT license.
// https://github.com/divetrope/divetrope
//
//   <script src="divetrope.js" defer></script>
//   <divetrope-player src="manifest.json" mode="player"></divetrope-player>
//
// Layer i holds layer i+1 in its centre at 1/S size and the last layer holds
// the first, so at t = N the screen shows layer 0 again. Modes:
//   page    the element is the whole page; the window scroll drives it, and
//           page.loop in the manifest wraps it forever.
//   scroll  a section inside a page: it pins while the reader scrolls past.
//   player  (default) a window with its own Play/Pause, dots and drag to
//           scrub. It never takes over the page scroll.
// Other attributes: chrome="full|minimal" (brand bar; full by default only in
// page mode), autoplay (player: plays muted while at least half in view).
// Events: dt-ready, dt-scene {scene}, dt-play, dt-pause, dt-end.
(() => {
  'use strict';
  if (window.customElements.get('divetrope-player')) return;

  const LAYER_VH = 1.35;     // scroll distance per scene, in viewport heights
  const LOOPS = 4;           // page loop mode: track length in loops
  const LINGER = 0.45;       // autoplay: how much the zoom slows at each scene (0 = constant speed)
  const TRAVEL_S = 2.8;      // autoplay: seconds added to each scene's hold for the zoom itself
  const LAND_S = 1;          // autoplay: extra seconds to settle onto the end card
  const RAMP_S = 1.2;        // autoplay: seconds to reach cruising speed after Play
  const STOP_S = 1.6;        // autoplay: seconds to ease to a stop on Pause
  const DRAG_LAYERS = 2;     // player: layers per full-width drag
  const WHEEL_PX = 900;      // player: wheel distance per layer
  const SPRING = 7;          // hand scrolling: follower stiffness (rad/s; higher = snappier)
  const KEEP_BEHIND = 2;
  const KEEP_AHEAD = 6;      // enough nesting depth to reach sub-pixel size at S = 4
  const POP_PX = 24;         // innermost layers fade in up to this width (device px)
  const REST = 0.035;
  const REST_MS = 350;
  const TAU = 2 * Math.PI;

  const UI = {
    play: 'Play', pause: 'Pause', more: 'More', less: 'Less', replay: 'Watch again',
    start: 'Play', soundOn: 'Turn sound on', soundOff: 'Turn sound off',
    fullscreen: 'Full screen', exitFullscreen: 'Exit full screen', end: 'The end',
    dragHint: 'or drag sideways to explore',
    loading: 'Loading', error: 'Could not load the story. Reload to try again.',
  };

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smoothstep = (a, b, v) => {
    const x = clamp((v - a) / (b - a), 0, 1);
    return x * x * (3 - 2 * x);
  };
  const brakeCurve = (x) => x - x * x * x + x * x * x * x / 2;   // ∫(1 - smoothstep), 1/2 at x = 1

  const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;
  const ICON = {
    soundOn: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>', 'class="on"'),
    soundOff: svg('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/>', 'class="off"'),
    fullscreen: svg('<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    chevron: svg('<path d="m6 9 6 6 6-6"/>', 'stroke-width="2.4"'),
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  };

  // ---------------------------------------------------------------- score

  // Adaptive score synthesized live with Web Audio (no audio files): a warm
  // pad changes chord with each scene, a soft bell motif starts one step
  // higher every scene, a plucked arpeggio thickens as the story goes on, and
  // the end card resolves home. manifest.score can set chords, home, sparkle
  // (the scene that gets a shower of bells), bpm and level.
  const SCORE = {
    chords: [
      [48, 55, 60, 64, 67, 71], // Cmaj7
      [45, 52, 57, 60, 64, 67], // Am7
      [41, 48, 53, 57, 60, 64], // Fmaj7
      [43, 50, 55, 59, 62, 69], // G6/9
      [40, 47, 52, 55, 59, 62], // Em7
      [41, 48, 53, 57, 64, 69], // Fmaj9
      [43, 50, 55, 60, 62, 67], // Gsus4
    ],
    home: [36, 48, 55, 60, 64, 67, 74], // Cadd9, the ending
    penta: [60, 62, 64, 67, 69, 72, 74, 76, 79, 81, 84, 86, 88, 91],
    sparkle: null,
    bpm: 84,
    level: 1.3,
  };
  const ARP_PATTERN = [2, 3, 4, 5, 4, 3];  // indices into the current chord, an octave up
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  class Score {
    constructor(cfg, scenes) {
      this.cfg = { ...SCORE, ...(cfg || {}) };
      this.scenes = scenes || this.cfg.chords.length;
      this.ac = null;
      this.muted = false;
      this.last = null;
      this.pad = null;
      this.chord = this.cfg.chords[0];
      this.arpStep = 0;
      this.arpNext = 0;
      this.arpTimer = null;
    }

    get started() { return !!this.ac; }

    impulse(seconds, decay) {
      const ac = this.ac, rate = ac.sampleRate, len = Math.floor(rate * seconds);
      const buf = ac.createBuffer(2, len, rate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return buf;
    }

    build() {
      const ac = this.ac = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ac.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      this.master = ac.createGain();
      this.master.gain.value = 0;
      this.master.connect(comp).connect(ac.destination);

      const verb = ac.createConvolver();
      verb.buffer = this.impulse(3.4, 2.6);
      const wet = ac.createGain();
      wet.gain.value = 0.55;
      verb.connect(wet).connect(this.master);

      this.padBus = ac.createGain();
      this.padBus.gain.value = 0.16;
      this.padBus.connect(this.master);
      this.padBus.connect(verb);

      this.bellBus = ac.createGain();
      this.bellBus.gain.value = 0.11;
      this.bellBus.connect(this.master);
      this.bellBus.connect(verb);

      this.arpBus = ac.createGain();
      this.arpBus.gain.value = 0;
      const arpTone = ac.createBiquadFilter();
      arpTone.type = 'lowpass';
      arpTone.frequency.value = 2400;
      this.arpBus.connect(arpTone);
      arpTone.connect(this.master);
      arpTone.connect(verb);

      // Room tone: very soft filtered noise so silence never sounds dead.
      const n = ac.createBufferSource();
      const nb = ac.createBuffer(1, ac.sampleRate * 4, ac.sampleRate);
      const nd = nb.getChannelData(0);
      let b = 0;
      for (let i = 0; i < nd.length; i++) { b = 0.985 * b + 0.015 * (Math.random() * 2 - 1); nd[i] = b; }
      n.buffer = nb;
      n.loop = true;
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700;
      const ng = ac.createGain();
      ng.gain.value = 0.35;
      n.connect(lp).connect(ng).connect(this.master);
      n.start();
    }

    padChord(notes) {
      const ac = this.ac, t = ac.currentTime;
      if (this.pad) {
        const old = this.pad;
        old.gain.gain.cancelScheduledValues(t);
        old.gain.gain.setValueAtTime(old.gain.gain.value, t);
        old.gain.gain.linearRampToValueAtTime(0, t + 3.2);
        old.voices.forEach((o) => o.stop(t + 3.4));
      }
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(1, t + 2.4);
      const filt = ac.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 1150;
      filt.Q.value = 0.6;
      const lfo = ac.createOscillator();
      const lfoAmt = ac.createGain();
      lfo.frequency.value = 0.07;
      lfoAmt.gain.value = 260;
      lfo.connect(lfoAmt).connect(filt.frequency);
      filt.connect(g).connect(this.padBus);
      const voices = [lfo];
      notes.forEach((m, k) => {
        [-7, 7].forEach((cents) => {
          const o = ac.createOscillator();
          o.type = k < 2 ? 'sine' : 'triangle';
          o.frequency.value = hz(m);
          o.detune.value = cents;
          const vg = ac.createGain();
          vg.gain.value = (k < 2 ? 0.5 : 0.28) / notes.length;
          o.connect(vg).connect(filt);
          o.start(t);
          voices.push(o);
        });
      });
      lfo.start(t);
      this.pad = { gain: g, voices };
    }

    bell(m, when, level = 1, pan = 0) {
      const ac = this.ac, t = ac.currentTime + when;
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.9 * level, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
      const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
      if (p) { p.pan.value = pan; g.connect(p).connect(this.bellBus); } else g.connect(this.bellBus);
      [[1, 1], [2.01, 0.28], [3.98, 0.08]].forEach(([ratio, amp]) => {
        const o = ac.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz(m) * ratio;
        const og = ac.createGain();
        og.gain.value = amp;
        o.connect(og).connect(g);
        o.start(t);
        o.stop(t + 2.8);
      });
    }

    pluck(m, t, level) {
      const ac = this.ac;
      const o = ac.createOscillator();
      o.type = 'triangle';
      o.frequency.value = hz(m);
      const g = ac.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.55);
      o.connect(g).connect(this.arpBus);
      o.start(t);
      o.stop(t + 0.6);
    }

    // Look-ahead scheduler on the audio clock (timers only decide when to look).
    tick() {
      if (!this.ac) return;
      const ac = this.ac, step = 60 / this.cfg.bpm / 2;
      const horizon = ac.currentTime + 0.15;
      if (this.arpNext < ac.currentTime) this.arpNext = ac.currentTime + 0.05;
      while (this.arpNext < horizon) {
        const idx = ARP_PATTERN[this.arpStep % ARP_PATTERN.length] % this.chord.length;
        this.pluck(this.chord[idx] + 12, this.arpNext, this.arpStep % 2 ? 0.55 : 0.8);
        this.arpStep++;
        this.arpNext += step;
      }
    }

    arpLevel(scene) {
      const end = scene === 'end';
      const v = end ? 0 : clamp((scene - 1) / Math.max(1, this.scenes - 2), 0, 1) * 0.07;
      const t = this.ac.currentTime, g = this.arpBus.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(v, t + (end ? 2.5 : 4));
    }

    motif(scene) {
      const P = this.cfg.penta;
      const base = Math.min(scene, P.length - 5);
      [0, 1, 2, 4].forEach((step, k) => this.bell(P[base + step], 0.18 + k * 0.24, 1 - k * 0.12, -0.3 + k * 0.2));
      if (scene === this.cfg.sparkle) {
        for (let k = 0; k < 7; k++) this.bell(P[Math.min(6 + k, P.length - 1)], 1.2 + k * 0.07, 0.35, 0.5 - k * 0.15);
      }
    }

    homecoming() {
      [60, 64, 67, 72, 76, 79, 84].forEach((m, k) => this.bell(m, 0.2 + k * 0.16, 0.9 - k * 0.07, -0.4 + k * 0.13));
    }

    async start() {
      if (!this.ac) this.build();
      if (this.ac.state !== 'running') await this.ac.resume();
      if (!this.arpTimer) this.arpTimer = setInterval(() => this.tick(), 40);
      this.ramp(this.muted ? 0 : this.cfg.level, 1.5);
    }

    ramp(v, seconds) {
      const t = this.ac.currentTime, g = this.master.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(v, t + seconds);
    }

    setMuted(on) {
      this.muted = on;
      if (this.ac) this.ramp(on ? 0 : this.cfg.level, 0.4);
    }

    // scene: 0..N-1, or 'end' for the closing card.
    scene(s) {
      if (!this.ac || s === this.last || s === null) return;
      this.last = s;
      this.arpLevel(s);
      if (s === 'end') {
        this.chord = this.cfg.home;
        this.padChord(this.cfg.home);
        this.homecoming();
        return;
      }
      this.chord = this.cfg.chords[s % this.cfg.chords.length];
      this.padChord(this.chord);
      this.motif(s);
    }

    stop() {
      if (this.arpTimer) clearInterval(this.arpTimer);
      this.arpTimer = null;
      if (this.ac) this.ac.close().catch(() => {});
      this.ac = null;
    }
  }

  // iOS routes Web Audio through the ringer channel, so the silent switch mutes
  // it. Asking for the playback session (and holding a silent media element)
  // moves it to the media channel. Must run inside the tap.
  let unlocked = false;
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    const n = 8000, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    const a = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
    a.loop = true;
    a.setAttribute('playsinline', '');
    a.play().catch(() => {});
  }

  // ------------------------------------------------------------------ view

  const CSS = `
:host {
  --dt-ink: #0b1020;
  --dt-primary: #4c6fff;
  --dt-primary-deep: #3651d9;
  --dt-accent: #ffb547;
  --dt-chip-1: #e4e9ff;
  --dt-chip-2: #ffeccb;
  --dt-chip-3: #ecdfff;
  --dt-on-dark: #f6f7f4;
  --dt-on-dark-dim: rgba(246, 247, 244, 0.8);
  --dt-font-display: system-ui, sans-serif;
  --dt-font-text: system-ui, sans-serif;
  --dt-top: 0px;
  display: block;
  position: relative;
  color-scheme: dark;
  color: var(--dt-on-dark);
  font-family: var(--dt-font-text);
  -webkit-font-smoothing: antialiased;
}
:host([hidden]) { display: none; }
:host([data-dt-mode="player"]) {
  aspect-ratio: var(--dt-aspect, 16 / 9);
  overflow: hidden;
  border-radius: var(--dt-radius, 0);
  background: var(--dt-ink);
  isolation: isolate;
}
:host([data-dt-mode="player"]:fullscreen) { aspect-ratio: auto; width: 100vw; height: 100vh; border-radius: 0; }
:host(:focus-visible) { outline: 3px solid var(--dt-accent); outline-offset: 3px; }
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }

.stage {
  --dt-bottom: 0px;
  position: sticky;
  top: var(--dt-top);
  height: calc(100vh - var(--dt-top));
  height: calc(100lvh - var(--dt-top));
  overflow: hidden;
  container: fd / size;
  background: var(--dt-ink);
}
@supports (height: 100dvh) {
  /* bottom-anchored controls follow the visible viewport while mobile toolbars slide */
  :host(:not([data-dt-mode="player"])) .stage { --dt-bottom: calc(100lvh - 100dvh); }
}
:host([data-dt-mode="player"]) .stage { position: absolute; inset: 0; height: auto; touch-action: pan-y; }
.dive { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

/* ---------------------------------------------------------------- top bar */
.bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: linear-gradient(color-mix(in srgb, var(--dt-ink) 60%, transparent), color-mix(in srgb, var(--dt-ink) 0%, transparent));
  pointer-events: none;
  z-index: 4;
}
:host([data-dt-mode="page"]) .bar { padding: max(14px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 14px max(16px, env(safe-area-inset-left)); }
.bar > * { pointer-events: auto; }
.stage:not(.chrome-full) .brand, .stage:not(.chrome-full) #bar-cta { display: none; }
.stage:not(.chrome-full) .bar { background: none; justify-content: flex-end; }
.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--dt-on-dark);
  text-decoration: none;
  font-weight: 600;
  font-size: 1.05rem;
}
.logo { width: 34px; height: 34px; border-radius: 30%; display: block; flex: none; }
.badge {
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--dt-ink);
  background: var(--dt-accent);
  border-radius: 999px;
  padding: 3px 8px;
}
.bar-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.icon-btn {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border-radius: 12px;
  border: 1px solid rgba(246, 247, 244, 0.35);
  background: color-mix(in srgb, var(--dt-ink) 35%, transparent);
  color: var(--dt-on-dark);
  cursor: pointer;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
.icon-btn svg { width: 20px; height: 20px; }
.icon-btn .on { display: none; }
.icon-btn[aria-pressed="true"] .on { display: block; }
.icon-btn[aria-pressed="true"] .off { display: none; }
.icon-btn[aria-pressed="true"] { border-color: var(--dt-accent); color: var(--dt-accent); }

/* ---------------------------------------------------------------- buttons */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 44px;
  padding: 0 18px;
  border-radius: 12px;
  border: 0;
  font: 600 0.95rem/1 var(--dt-font-text);
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
  transition: transform 0.15s ease, background-color 0.15s ease;
}
.btn:active { transform: translateY(1px); }
.btn-primary { background: var(--dt-primary); color: #fff; }
.btn-primary:hover { background: var(--dt-primary-deep); }
.btn-ghost { color: var(--dt-on-dark); border: 1px solid rgba(246, 247, 244, 0.5); background: color-mix(in srgb, var(--dt-ink) 25%, transparent); }
.btn-ghost:hover { background: color-mix(in srgb, var(--dt-ink) 50%, transparent); }
.btn-lg { min-height: 52px; padding: 0 24px; font-size: 1rem; }
.btn:focus-visible, .icon-btn:focus-visible, .link-btn:focus-visible, .more-btn:focus-visible,
#rail button:focus-visible, #auto:focus-visible { outline: 3px solid var(--dt-accent); outline-offset: 3px; }
.link-btn {
  margin-top: 14px;
  padding: 8px 0;
  border: 0;
  background: none;
  color: var(--dt-on-dark-dim);
  font: 500 0.92rem/1 var(--dt-font-text);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
}
.link-btn:hover { color: var(--dt-on-dark); }

/* ----------------------------------------------------------------- intro */
#intro {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 96px 16px 64px;
  text-align: center;
  background: radial-gradient(ellipse at center, color-mix(in srgb, var(--dt-ink) 55%, transparent), color-mix(in srgb, var(--dt-ink) 82%, transparent));
  z-index: 3;
  transition: opacity 0.7s ease, visibility 0.7s;
}
.stage:not(.is-intro) #intro { opacity: 0; visibility: hidden; pointer-events: none; }
.intro-inner { max-width: 48rem; }
.eyebrow {
  margin-top: 0;
  margin-bottom: 0.7rem;
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  text-wrap: balance;
  text-shadow: 0 1px 10px color-mix(in srgb, var(--dt-ink) 70%, transparent);
  color: var(--dt-accent);
}
#intro h1 {
  margin: 0.4rem 0 0;
  font-family: var(--dt-font-display);
  font-weight: 600;
  font-size: clamp(2rem, 9cqi, 5.6rem);
  line-height: 1;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
.intro-sub { margin: 1rem 0 2rem; font-size: clamp(0.95rem, 2.4cqi, 1.2rem); color: var(--dt-on-dark-dim); }
.btn-play {
  min-height: 60px;
  padding: 0 30px 0 24px;
  border-radius: 999px;
  background: var(--dt-primary);
  color: #fff;
  font-size: 1.08rem;
  box-shadow: 0 10px 40px rgba(15, 139, 141, 0.45);
}
.btn-play:hover { background: var(--dt-primary-deep); }
.btn-play svg { width: 22px; height: 22px; }
.intro-alt { margin: 1rem 0 0; font-size: 0.85rem; letter-spacing: 0.04em; color: var(--dt-on-dark-dim); }

/* ------------------------------------------------------------- scene copy */
#headline {
  position: absolute;
  left: 0;
  right: 0;
  bottom: var(--dt-bottom);
  padding: 140px 16px 34px;
  background: linear-gradient(color-mix(in srgb, var(--dt-ink) 0%, transparent), color-mix(in srgb, var(--dt-ink) 60%, transparent) 35%, color-mix(in srgb, var(--dt-ink) 86%, transparent) 80%);
  text-align: center;
  pointer-events: none;
  z-index: 2;
}
:host([data-dt-mode="page"]) #headline { padding-bottom: max(34px, calc(env(safe-area-inset-bottom) + 24px)); }
.stage.is-intro #headline { visibility: hidden; }
/* centred above the bottom edge, clear of the Play pill in the right corner */
#headline > * { max-width: min(38rem, calc(100cqi - 280px)); margin-left: auto; margin-right: auto; }
#headline h2 {
  margin-top: 0;
  margin-bottom: 0;
  font-family: var(--dt-font-display);
  font-weight: 600;
  font-size: clamp(1.5rem, 4.8cqi, 3.5rem);
  line-height: 1.05;
  letter-spacing: -0.01em;
  text-wrap: balance;
  text-shadow: 0 2px 18px color-mix(in srgb, var(--dt-ink) 55%, transparent);
}
#headline .body {
  margin-top: 0.9rem;
  margin-bottom: 0;
  font-size: clamp(0.95rem, 1.9cqi, 1.16rem);
  line-height: 1.55;
  color: var(--dt-on-dark-dim);
  text-wrap: pretty;
  text-shadow: 0 1px 12px color-mix(in srgb, var(--dt-ink) 60%, transparent);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-top: 1rem;
  margin-bottom: 0;
  padding: 0;
  list-style: none;
}
.chips li {
  padding: 7px 12px;
  border-radius: 999px;
  font-size: 0.84rem;
  font-weight: 500;
  color: var(--dt-ink);
  background: var(--dt-chip-1);
}
.chips li:nth-child(3n + 2) { background: var(--dt-chip-2); }
.chips li:nth-child(3n + 3) { background: var(--dt-chip-3); }

/* While the story plays only the headline and More show; More opens the
   details without stopping it, Pause eases to a stop and opens them. Paused,
   the eyebrow returns too. */
.stage.is-playing #headline .eyebrow { display: none; }
.more-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  margin-top: 1rem;
  padding: 0 14px 0 18px;
  border: 1px solid rgba(246, 247, 244, 0.4);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dt-ink) 50%, transparent);
  color: var(--dt-on-dark);
  font: 600 0.88rem/1 var(--dt-font-text);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  pointer-events: auto;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
.more-btn:hover { border-color: var(--dt-accent); }
.more-btn svg { width: 16px; height: 16px; transition: transform 0.3s ease; }
.stage.is-expanded .more-btn svg { transform: rotate(180deg); }
#headline.is-faded .more-btn, #headline.is-faded #cta { pointer-events: none; }
#details {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  transition: grid-template-rows 0.4s cubic-bezier(0.2, 0.7, 0.2, 1), opacity 0.3s ease;
}
.details-inner { min-height: 0; overflow: hidden; }
.stage.is-expanded #details, .stage.is-end #details { grid-template-rows: 1fr; opacity: 1; }
#cta { margin-top: 1.4rem; pointer-events: auto; }
#cta .actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.stage.is-end #headline h2 { font-size: clamp(2rem, 6.4cqi, 4.6rem); }

/* staggered reveal each time a scene arrives */
#headline.reveal > :not(#details) { animation: rise 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) both; }
#headline.reveal > :nth-child(2) { animation-delay: 0.08s; }
#headline.reveal > :nth-child(3) { animation-delay: 0.2s; }
#headline.reveal > :nth-child(4) { animation-delay: 0.32s; }
#headline.reveal > :nth-child(5) { animation-delay: 0.42s; }
@keyframes rise {
  from { opacity: 0; transform: translateY(14px); }
  to { opacity: 1; transform: none; }
}

/* ------------------------------------------------------- rail, play, bar */
#rail {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dt-ink) 38%, transparent);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  z-index: 3;
}
#rail button {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  display: grid;
  place-items: center;
}
#rail button::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(246, 247, 244, 0.5);
  transition: transform 0.2s ease, background-color 0.2s ease;
}
#rail button[aria-current="true"]::after { background: var(--dt-accent); transform: scale(1.5); }
#rail .end::after { background: var(--dt-primary); }
.stage.is-intro #rail { opacity: 0; pointer-events: none; }
#auto {
  position: absolute;
  right: 16px;
  bottom: calc(var(--dt-bottom) + 22px);
  min-height: 44px;
  padding: 0 18px;
  border-radius: 999px;
  border: 1px solid rgba(246, 247, 244, 0.45);
  background: color-mix(in srgb, var(--dt-ink) 45%, transparent);
  color: var(--dt-on-dark);
  font: 600 0.85rem/1 var(--dt-font-text);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  cursor: pointer;
  z-index: 3;
}
:host([data-dt-mode="page"]) #auto { bottom: calc(var(--dt-bottom) + max(22px, calc(env(safe-area-inset-bottom) + 12px))); }
#auto[aria-pressed="true"] { border-color: var(--dt-accent); color: var(--dt-accent); }
.stage.is-intro #auto, .stage.is-end #auto { opacity: 0; pointer-events: none; }
#progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: var(--dt-bottom);
  height: 3px;
  background: rgba(246, 247, 244, 0.12);
  z-index: 3;
}
:host([data-dt-mode="player"]) #progress { height: 14px; background: none; cursor: pointer; }
:host([data-dt-mode="player"]) #progress::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(246, 247, 244, 0.12); }
#progress span {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: linear-gradient(90deg, var(--dt-primary), var(--dt-accent));
  transform-origin: left;
  transform: scaleX(0);
}

/* --------------------------------------------------------------- loading */
#loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 18px;
  background: var(--dt-ink);
  transition: opacity 0.8s ease;
  z-index: 6;
}
#loading .logo { width: 56px; height: 56px; }
#loading p { margin: 0; font-size: 0.8rem; letter-spacing: 0.22em; text-transform: uppercase; color: var(--dt-on-dark-dim); }
#loading .bar-track { width: min(220px, 60cqi); height: 2px; background: rgba(246, 247, 244, 0.18); border-radius: 2px; overflow: hidden; }
#loading .bar-track span { display: block; height: 100%; width: 0; background: var(--dt-primary); transition: width 0.3s ease; }
#loading.done { opacity: 0; pointer-events: none; }

@container fd (max-width: 640px) {
  .bar .btn { min-height: 40px; padding: 0 14px; font-size: 0.9rem; }
  .icon-btn { width: 40px; height: 40px; }
  .badge { display: none; }
  #headline { padding-top: 110px; padding-bottom: 84px; }
  #headline > * { max-width: none; margin-left: 30px; margin-right: 30px; }
  #auto { left: 16px; right: auto; }
  #cta .btn-lg { flex: 1 1 100%; }
}
@container fd (max-width: 640px) {
  :host([data-dt-mode="page"]) #headline { padding-bottom: max(84px, calc(env(safe-area-inset-bottom) + 76px)); }
}
/* small embedded windows: tighter type, compact controls */
@container fd (max-height: 520px) {
  #headline { padding-top: 70px; padding-bottom: 26px; }
  #headline .body { font-size: 0.92rem; line-height: 1.45; }
  .chips { margin-top: 0.6rem; }
  .chips li { padding: 5px 10px; font-size: 0.78rem; }
  .more-btn { min-height: 34px; margin-top: 0.7rem; }
  #intro { padding: 56px 16px 40px; }
  .intro-sub { margin: 0.6rem 0 1.2rem; }
  .btn-play { min-height: 50px; }
  #rail button { width: 22px; height: 22px; }
  #auto { min-height: 38px; bottom: calc(var(--dt-bottom) + 14px); }
}
@container fd (max-width: 640px) and (max-height: 520px) {
  #headline { padding-bottom: 64px; }
}
/* phone-sized windows: every control moves to one row along the top, open
   text scrolls inside the window over a full scrim, and the dots give way to
   the progress bar */
@container fd (max-height: 420px) {
  #rail { display: none; }
  .bar { padding: 10px 12px; }
  .icon-btn { width: 36px; height: 36px; border-radius: 10px; }
  .icon-btn svg { width: 18px; height: 18px; }
  #auto { top: 10px; bottom: auto; left: 12px; right: auto; min-height: 36px; padding: 0 14px; }
  #headline { max-height: 100%; padding: 58px 16px 20px; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
  #headline::-webkit-scrollbar { display: none; }
  .stage.is-expanded #headline, .stage.is-end #headline { pointer-events: auto; background: color-mix(in srgb, var(--dt-ink) 80%, transparent); }
  #headline > * { margin-left: 16px; margin-right: 16px; }
  #headline .eyebrow { margin-bottom: 0.4rem; }
  .stage.is-end #headline h2 { font-size: clamp(1.6rem, 6.4cqi, 3rem); }
  #cta { margin-top: 0.9rem; }
  #cta .btn-lg { min-height: 44px; }
  .link-btn { margin-top: 6px; }
}
@container fd (max-height: 300px) {
  .stage.is-end #headline .eyebrow, .stage.is-end #details { display: none; }
  #cta .btn-lg { flex: 0 1 auto; min-height: 40px; padding: 0 16px; font-size: 0.9rem; }
  #intro { padding: 16px; }
  #intro .eyebrow, .intro-sub, .intro-alt { display: none; }
  #intro h1 { margin-bottom: 0.8rem; font-size: clamp(1.6rem, 8cqi, 2.6rem); }
  .btn-play { min-height: 46px; font-size: 1rem; }
}

@media (prefers-reduced-motion: reduce) {
  #headline.reveal > *, .chips li { animation: none; }
  #details, .more-btn svg { transition: none; }
  #intro, #loading, #loading .bar-track span, #rail button::after, .btn { transition: none; }
}
`;

  const HTML = `
<div class="stage is-intro" id="stage" part="stage">
  <canvas class="dive" id="dive" aria-hidden="true"></canvas>
  <header class="bar">
    <a class="brand" id="brand"><img class="logo" alt="" hidden><span class="name"></span><span class="badge" hidden></span></a>
    <div class="bar-actions">
      <button id="sound" class="icon-btn" type="button" aria-pressed="false" aria-label="${UI.soundOn}">${ICON.soundOn}${ICON.soundOff}</button>
      <button id="fullscreen" class="icon-btn" type="button" aria-label="${UI.fullscreen}" hidden>${ICON.fullscreen}</button>
      <a class="btn btn-primary" id="bar-cta" hidden></a>
    </div>
  </header>
  <section id="intro">
    <div class="intro-inner">
      <p class="eyebrow" id="intro-eyebrow"></p>
      <h1 id="intro-title"></h1>
      <p class="intro-sub" id="intro-sub"></p>
      <button id="play" class="btn btn-play" type="button">${ICON.play}<span></span></button>
      <p class="intro-alt" id="intro-alt"></p>
    </div>
  </section>
  <section id="headline" aria-live="polite">
    <p class="eyebrow"></p>
    <h2></h2>
    <div id="details">
      <div class="details-inner">
        <p class="body"></p>
        <ul class="chips"></ul>
      </div>
    </div>
    <button id="more" class="more-btn" type="button" aria-expanded="false" aria-controls="details"><span></span>${ICON.chevron}</button>
    <div id="cta" hidden>
      <div class="actions">
        <a class="btn btn-primary btn-lg" id="cta-primary"></a>
        <a class="btn btn-ghost btn-lg" id="cta-secondary"></a>
      </div>
      <button id="replay" class="link-btn" type="button"></button>
    </div>
  </section>
  <nav id="rail" aria-label="Jump to a scene"></nav>
  <button id="auto" type="button" aria-pressed="false"></button>
  <div id="progress" aria-hidden="true"><span></span></div>
  <div id="loading" role="status">
    <img class="logo" alt="" hidden>
    <div class="bar-track"><span></span></div>
    <p></p>
  </div>
</div>`;

  const fontsLoaded = new Set();
  function loadFonts(href) {
    if (!href || fontsLoaded.has(href)) return;
    fontsLoaded.add(href);
    const esc = window.CSS && window.CSS.escape ? window.CSS.escape(href) : href;
    if (document.querySelector(`link[rel="stylesheet"][href="${esc}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }

  // ---------------------------------------------------------------- engine

  function mount(host) {
    const root = host.shadowRoot;
    root.innerHTML = `<style>${CSS}</style><style id="theme"></style>${HTML}`;
    const $ = (id) => root.getElementById(id);
    const q = (sel) => root.querySelector(sel);

    const modeAttr = host.getAttribute('mode');
    const mode = ['page', 'scroll', 'player'].includes(modeAttr) ? modeAttr : 'player';
    const scrolly = mode !== 'player';
    host.dataset.dtMode = mode;
    if (mode === 'player' && !host.hasAttribute('tabindex')) host.tabIndex = 0;

    const stage = $('stage');
    const canvas = $('dive');
    const ctx = canvas.getContext('2d', { alpha: false });
    const headEl = $('headline');
    const eyebrowEl = headEl.querySelector('.eyebrow');
    const headText = headEl.querySelector('h2');
    const bodyText = headEl.querySelector('.body');
    const chipsEl = headEl.querySelector('.chips');
    const moreBtn = $('more');
    const ctaEl = $('cta');
    const railEl = $('rail');
    const autoBtn = $('auto');
    const playBtn = $('play');
    const soundBtn = $('sound');
    const fsBtn = $('fullscreen');
    const replayBtn = $('replay');
    const progressWrap = $('progress');
    const progressEl = progressWrap.querySelector('span');
    const loadingEl = $('loading');
    const barEl = loadingEl.querySelector('.bar-track span');
    const loadingText = loadingEl.querySelector('p');
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

    const chromeAttr = host.getAttribute('chrome');
    if ((chromeAttr || (mode === 'page' ? 'full' : 'minimal')) === 'full') stage.classList.add('chrome-full');

    let S, N, aspect, layers, sizes, page, loop, brand, ui, score;
    let baseUrl = document.baseURI;
    let blobs = [], bitmaps = [], decoding = [];
    let layerPx = 1, loopPx = 0, trackWidth = 0;
    let target = 0, current = 0, drawn = NaN, vel = 0;
    let dirty = true;
    let auto = null;             // {from: timeline seconds, since: performance.now(), stop}
    let plan = null;             // autoplay timeline, see buildPlan()
    let wide = 0;                // 0..1: widens the copy's fade window while autoplay runs
    let lastTime = performance.now();
    let shown = null;            // scene key on screen: index or 'end'
    let restSince = 0, restLayer = -1;
    let introOpen = true;
    let raf = 0, alive = true, hiddenAt = 0, touched = false;
    const videos = new Map();
    const offs = [];
    const on = (el, type, fn, opts) => { el.addEventListener(type, fn, opts); offs.push(() => el.removeEventListener(type, fn, opts)); };
    const emit = (type, detail) => host.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    const url = (p) => new URL(p, baseUrl).href;

    const base = () => (loop ? N : 0);
    const sceneKey = (t) => {
      const r = Math.round(t);
      return !loop && r >= N ? 'end' : mod(r, N);
    };

    function pickSize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = stage.clientWidth || innerWidth, h = stage.clientHeight || innerHeight;
      const cover = Math.max(w, h * aspect) * dpr;
      const lowMemory = (navigator.deviceMemory && navigator.deviceMemory <= 4) || matchMedia('(pointer: coarse)').matches;
      const want = lowMemory ? Math.min(cover * 1.2, 2400) : cover * 1.6;
      const fit = sizes.filter((s) => s >= want);
      return String(fit.length ? Math.min(...fit) : Math.max(...sizes));
    }

    // ---- layout and scroll -------------------------------------------------

    function sizeCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w;
        canvas.height = h;
        ctx.imageSmoothingQuality = 'high';
        dirty = true;
      }
    }

    const hostTop = () => host.getBoundingClientRect().top + window.scrollY;
    const pinned = () => {
      const r = host.getBoundingClientRect();
      return r.top <= 1 && r.bottom >= innerHeight - 1;
    };

    // The scroll length is only re-measured when the width changes, because
    // mobile browsers resize the height whenever the address bar slides.
    function layoutTrack(force) {
      if (!scrolly) return;
      if (!force && innerWidth === trackWidth) return;
      trackWidth = innerWidth;
      layerPx = Math.max(420, innerHeight * LAYER_VH);
      if (loop) {
        const t = mod(current, N);
        loopPx = layerPx * N;
        host.style.height = `${loopPx * LOOPS + innerHeight}px`;
        const y = loopPx + t * layerPx;
        window.scrollTo(0, hostTop() + y);
        target = current = y / layerPx;
      } else {
        host.style.height = `${N * layerPx + innerHeight}px`;
        if (mode === 'page' || pinned()) {
          const t = clamp(current, 0, N);
          window.scrollTo(0, hostTop() + t * layerPx);
          target = current = t;
        } else {
          target = current = clamp(-host.getBoundingClientRect().top / layerPx, 0, N);
        }
      }
    }

    function onScroll() {
      if (!scrolly || !N) return;
      let y = -host.getBoundingClientRect().top;
      if (loop && (y >= 3 * loopPx || y < loopPx)) {
        const shift = y >= 3 * loopPx ? -loopPx : loopPx;
        window.scrollTo(0, window.scrollY + shift);
        y += shift;
        current += shift / layerPx;
      }
      if (auto) {
        // Autoplay owns the position and re-syncs the scroll when it stops,
        // unless the reader has scrolled the section away some other way.
        if (mode === 'scroll' && !pinned()) stopAuto(false);
        else return;
      }
      target = loop ? y / layerPx : clamp(y / layerPx, 0, N);
      if (introOpen && Math.abs(target - base()) > 0.04) closeIntro();
    }

    // Point the page scroll (and the target) at current + coast. In loop mode
    // the position is first shifted by whole loops into [N, 2N), the band the
    // scroll track maps to, so the target never lands a loop away.
    function syncScroll(coast = 0) {
      let t = current + coast;
      if (loop) {
        const shift = Math.floor(t / N) * N - N;
        current -= shift;
        t -= shift;
      } else {
        t = clamp(t, 0, N);
      }
      if (scrolly) window.scrollTo(0, hostTop() + (loop ? loopPx + (t - N) * layerPx : t * layerPx));
      target = t;
    }

    function goTo(i) {
      stopAuto();
      closeIntro();
      if (!scrolly) {
        target = loop ? i : clamp(i, 0, N);
        return;
      }
      let dest = i;
      if (loop) {
        dest = Math.floor(target) - mod(Math.floor(target), N) + i;
        if (dest <= target + 0.01) dest += N;
      }
      window.scrollTo({ top: hostTop() + dest * layerPx, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }

    // ---- images ------------------------------------------------------------

    function decode(i) {
      if (bitmaps[i] || decoding[i] || !blobs[i]) return decoding[i];
      decoding[i] = (async () => {
        try {
          if ('createImageBitmap' in window) {
            bitmaps[i] = await createImageBitmap(blobs[i]);
          } else {
            const img = new Image();
            img.src = URL.createObjectURL(blobs[i]);
            await img.decode();
            bitmaps[i] = img;
          }
          dirty = true;
        } catch (err) {
          console.warn('divetrope-player: could not decode layer', i, err);
        } finally {
          decoding[i] = null;
        }
      })();
      return decoding[i];
    }

    function keepWindow() {
      const b0 = Math.floor(current);
      const wanted = new Set();
      for (let k = -KEEP_BEHIND; k <= KEEP_AHEAD; k++) wanted.add(mod(b0 + k, N));
      for (let k = -1; k <= KEEP_AHEAD; k++) decode(mod(b0 + k, N));
      for (let i = 0; i < N; i++) {
        if (bitmaps[i] && !wanted.has(i)) {
          if (bitmaps[i].close) bitmaps[i].close();
          else if (bitmaps[i].src) URL.revokeObjectURL(bitmaps[i].src);
          bitmaps[i] = null;
        }
      }
    }

    async function loadAll(size) {
      const order = [0, 1, N - 1, 2, 3];
      for (let i = 4; i < N - 1; i++) order.push(i);
      const queue = [...new Set(order)].filter((i) => i >= 0 && i < N);
      let done = 0;
      const worker = async () => {
        while (queue.length && alive) {
          const i = queue.shift();
          const src = url(layers[i].src[size]);
          const res = await fetch(src);
          if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
          blobs[i] = await res.blob();
          keepWindow();   // decode it now if it is already in view, not at the next scene
          done++;
          barEl.style.width = `${(done / N) * 100}%`;
          dirty = true;
        }
      };
      return Promise.all([worker(), worker(), worker()]);
    }

    // ---- video at rest -----------------------------------------------------

    function videoFor(i) {
      if (!layers[i].video || reduceMotion.matches) return null;
      let v = videos.get(i);
      if (!v) {
        const el = document.createElement('video');
        el.muted = true;
        el.loop = true;
        el.playsInline = true;
        el.preload = 'auto';
        el.crossOrigin = 'anonymous';
        el.src = url(layers[i].video);
        v = { el, ready: false, alpha: 0 };
        el.addEventListener('canplay', () => { v.ready = true; }, { once: true });
        el.addEventListener('error', () => { videos.set(i, { el: null, ready: false, alpha: 0, failed: true }); });
        videos.set(i, v);
      }
      return v.failed ? null : v;
    }

    function updateVideos(now, dt) {
      const n = mod(Math.round(current), N);
      const off = Math.abs(current - Math.round(current));
      const resting = auto ? off < 0.15 : off < REST && Math.abs(target - current) < 1e-3;
      if (resting) {
        if (restLayer !== n) { restLayer = n; restSince = now; }
      } else {
        restLayer = -1;
      }
      if (off < 0.5) videoFor(n);
      let active = false;
      videos.forEach((v, i) => {
        if (!v.el) return;
        const want = i === restLayer && now - restSince > REST_MS && v.ready ? 1 : 0;
        const rate = want ? dt / 0.5 : dt / 0.18;
        v.alpha = want ? Math.min(1, v.alpha + rate) : Math.max(0, v.alpha - rate);
        if (v.alpha > 0) {
          active = true;
          if (v.el.paused) v.el.play().catch(() => {});
        } else if (!v.el.paused) {
          v.el.pause();
          v.el.currentTime = 0;
        }
      });
      if (active) dirty = true;
    }

    // ---- drawing -----------------------------------------------------------

    function drawSource(src, sw0, sh0, dx, dy, dw, dh, W, H) {
      const x0 = Math.max(0, dx), y0 = Math.max(0, dy);
      const x1 = Math.min(W, dx + dw), y1 = Math.min(H, dy + dh);
      if (x1 <= x0 || y1 <= y0) return;
      ctx.drawImage(src,
        ((x0 - dx) / dw) * sw0, ((y0 - dy) / dh) * sh0, ((x1 - x0) / dw) * sw0, ((y1 - y0) / dh) * sh0,
        x0, y0, x1 - x0, y1 - y0);
    }

    let inkColor = '#0b1020';
    function draw() {
      const W = canvas.width, H = canvas.height;
      const fi = Math.floor(current);
      const z = Math.pow(S, current - fi);
      const baseW = Math.max(W, H * aspect), baseH = baseW / aspect;
      ctx.fillStyle = inkColor;
      ctx.fillRect(0, 0, W, H);
      // Draw every nesting level down to under a pixel, so no layer ever pops
      // in at a visible size when the zoom passes a scene boundary; the
      // smallest ones fade in with their size.
      for (let k = -1; k <= KEEP_AHEAD; k++) {
        const s = z / Math.pow(S, k);
        const dw = baseW * s, dh = baseH * s;
        if (dw < 1) break;
        const idx = mod(fi + k, N);
        const bmp = bitmaps[idx];
        if (!bmp) continue;
        const dx = (W - dw) / 2, dy = (H - dh) / 2;
        const fade = k > 0 ? smoothstep(1, POP_PX, dw) : 1;
        if (fade < 1) ctx.globalAlpha = fade;
        drawSource(bmp, bmp.width, bmp.height, dx, dy, dw, dh, W, H);
        if (fade < 1) ctx.globalAlpha = 1;
        const v = videos.get(idx);
        if (v && v.el && v.alpha > 0 && v.el.readyState >= 2) {
          ctx.globalAlpha = v.alpha;
          drawSource(v.el, v.el.videoWidth, v.el.videoHeight, dx, dy, dw, dh, W, H);
          ctx.globalAlpha = 1;
        }
      }
      drawn = current;
      dirty = false;
    }

    // ---- copy --------------------------------------------------------------

    function showScene(key) {
      shown = key;
      const end = key === 'end';
      const L = (end ? page.end : layers[key]) || {};
      const text = L.body || L.sub || '';
      eyebrowEl.textContent = L.eyebrow || '';
      eyebrowEl.hidden = !L.eyebrow;
      headText.textContent = L.headline || '';
      bodyText.textContent = text;
      bodyText.hidden = !text;
      chipsEl.replaceChildren(...(L.chips || []).map((c) => {
        const li = document.createElement('li');
        li.textContent = c;
        return li;
      }));
      chipsEl.hidden = !(L.chips && L.chips.length);
      moreBtn.hidden = end || (!text && chipsEl.hidden);
      ctaEl.hidden = !end;
      stage.classList.toggle('is-end', end);
      headEl.hidden = !L.headline && !L.eyebrow && !text && !end;
      headEl.scrollTop = 0;
      headEl.classList.remove('reveal');
      void headEl.offsetWidth;   // restart the reveal animation
      headEl.classList.add('reveal');
      railEl.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-current', String(end ? i === N : i === key)));
      if (score) score.scene(key);
      emit('dt-scene', { scene: key });
    }

    function updateOverlay() {
      const key = sceneKey(current);
      if (key !== shown) showScene(key);
      const off = Math.abs(current - Math.round(current));
      const fade = smoothstep(0.14 + 0.12 * wide, 0.34 + 0.12 * wide, off);
      headEl.style.opacity = (1 - fade).toFixed(3);
      headEl.classList.toggle('is-faded', fade > 0.5);
      progressEl.style.transform = `scaleX(${loop ? mod(current, N) / N : clamp(current / N, 0, 1)})`;
    }

    // ---- autoplay (the commercial) -----------------------------------------

    // Autoplay is one continuous timeline, never stop-and-go. Section k (scene k
    // to k+1) runs k + s - a·sin(2πs)/2π for s in 0..1: slowest while a scene
    // fills the screen, fastest between scenes. Every section meets the next at
    // the same speed with zero acceleration, so there are no seams in the
    // motion; without page.loop the last section lands on the end card at zero
    // speed. It drives `current` directly and (in scroll modes) syncs the page
    // scroll only when it stops, so the browser's own scrolling can never
    // fight it.
    function buildPlan() {
      const hold = (i) => layers[loop ? mod(i, N) : Math.min(i, N - 1)].hold || 5.5;
      const T = [];
      for (let k = 0; k < N; k++) T.push((hold(k) + hold(k + 1)) / 2 + TRAVEL_S);
      if (!loop) T[N - 1] += LAND_S;
      const vmin = (1 - LINGER) * N / T.reduce((x, y) => x + y, 0);   // layers/s as a scene arrives
      const start = [];
      let total = 0;
      T.forEach((t) => { start.push(total); total += t; });
      plan = { T, start, total, a: T.map((t) => clamp(1 - vmin * t, 0, 0.9)), m: vmin * T[N - 1] };
    }

    // Position inside section k at s in 0..1.
    function shape(k, s) {
      if (!loop && k === N - 1) {
        // Quintic from speed m (matching the sections before) to rest, with zero
        // acceleration at both ends.
        const m = plan.m;
        return s * (m + s * s * ((10 - 6 * m) + s * ((8 * m - 15) + s * (6 - 3 * m))));
      }
      return s - plan.a[k] * Math.sin(TAU * s) / TAU;
    }

    function posAt(time) {
      if (loop) time = mod(time, plan.total);
      else if (time >= plan.total) return N;
      let k = N - 1;
      while (k > 0 && plan.start[k] > time) k--;
      return k + shape(k, clamp((time - plan.start[k]) / plan.T[k], 0, 1));
    }

    function timeAt(p) {
      const k = clamp(Math.floor(p), 0, N - 1);
      const u = p - k;
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (shape(k, mid) < u) lo = mid; else hi = mid;
      }
      return plan.start[k] + lo * plan.T[k];
    }

    // Timeline seconds played after `wall` seconds of autoplay: the speed eases
    // in along a smoothstep over RAMP_S, then runs at 1x.
    function eased(wall) {
      if (wall >= RAMP_S) return wall - RAMP_S / 2;
      const x = wall / RAMP_S;
      return RAMP_S * x * x * x * (1 - x / 2);
    }

    // Timeline seconds at `now`. After Pause the timeline keeps its speed
    // (cruising on to the next scene if the copy is mid-fade), then the speed
    // eases from `rate` to zero over STOP_S: never a jump, never a rewind.
    function autoTime(now) {
      const w = (now - auto.since) / 1000;
      const st = auto.stop;
      if (!st) return auto.from + eased(w);
      if (w < st.brakeAt) return st.t0 + (w - st.w0) * st.rate;
      return st.tb + st.rate * STOP_S * brakeCurve(Math.min(1, (w - st.brakeAt) / STOP_S));
    }

    const playing = () => !!auto && !auto.stop;

    function brake() {
      if (!playing()) return;
      const now = performance.now();
      const w0 = (now - auto.since) / 1000;
      const t0 = autoTime(now);
      const x0 = Math.min(1, w0 / RAMP_S);
      const rate = x0 * x0 * (3 - 2 * x0);
      const p0 = posAt(t0);
      const u = p0 - Math.floor(p0);
      let cruise = 0;        // timeline seconds at full speed before braking
      if (u > 0.12 && u < 0.88 && rate === 1) {
        const t0m = loop ? mod(t0, plan.total) : t0;
        cruise = Math.max(0, timeAt(Math.floor(p0) + 1) - STOP_S / 2 - t0m);
      }
      auto.stop = { w0, t0, rate, tb: t0 + cruise * rate, brakeAt: w0 + cruise, end: w0 + cruise + STOP_S };
      setPlayingUI(false);
      emit('dt-pause', {});
    }

    function startAuto(fromStart) {
      if (!N) return;
      closeIntro();
      touched = true;
      let t = fromStart ? 0 : (loop ? mod(current, N) : current);
      if (!loop && t >= N - 1e-3) t = 0;
      current = target = base() + t;
      // In a section, bring it into view (pinned) before it plays.
      if (mode === 'scroll' && !pinned()) syncScroll();
      // Resume from wherever the reader paused, easing up to speed, with only
      // the headline on screen: reading more is for when it's paused.
      auto = { from: timeAt(t), since: performance.now(), stop: null };
      setExpanded(false);
      setPlayingUI(true);
      emit('dt-play', {});
    }

    function setPlayingUI(isOn) {
      autoBtn.setAttribute('aria-pressed', String(isOn));
      autoBtn.textContent = isOn ? ui.pause : ui.play;
      stage.classList.toggle('is-playing', isOn);
    }

    function stopAuto(sync = true) {
      if (!auto && !stage.classList.contains('is-playing')) return;
      const wasPlaying = playing();
      auto = null;
      // Coast to rest at the speed it was moving: with the target vel/SPRING
      // ahead, the spring's speed just decays, with no bounce back.
      const coast = reduceMotion.matches ? 0 : vel / SPRING;
      if (sync) syncScroll(coast);
      else target = current + coast;
      setPlayingUI(false);
      if (wasPlaying) emit('dt-pause', {});
    }

    function setExpanded(isOn) {
      stage.classList.toggle('is-expanded', isOn);
      moreBtn.setAttribute('aria-expanded', String(isOn));
      moreBtn.querySelector('span').textContent = isOn ? ui.less : ui.more;
    }

    function stepAuto(now) {
      const p = posAt(autoTime(now));
      current = target = base() + p;
      if (!loop && p >= N) { stopAuto(); emit('dt-end', {}); }
      else if (auto.stop && (now - auto.since) / 1000 >= auto.stop.end) stopAuto();
    }

    // Pausing opens the details. More opens them too, without stopping the story.
    const pause = () => { brake(); setExpanded(true); };

    // ---- intro and sound ---------------------------------------------------

    function closeIntro() {
      if (!introOpen) return;
      introOpen = false;
      stage.classList.remove('is-intro');
    }

    function setSoundUI(isOn) {
      soundBtn.setAttribute('aria-pressed', String(isOn));
      soundBtn.setAttribute('aria-label', isOn ? ui.soundOff : ui.soundOn);
    }

    async function soundOn() {
      unlockAudio();
      try {
        await score.start();
        score.setMuted(false);
        score.scene(shown);
        setSoundUI(true);
      } catch (err) {
        console.warn('divetrope-player: sound unavailable', err);
      }
    }

    // ---- input -------------------------------------------------------------

    function bindInput() {
      on(soundBtn, 'click', () => {
        if (!score.started || score.muted) soundOn();
        else { score.setMuted(true); setSoundUI(false); }
      });
      on(playBtn, 'click', () => { if (page.sound !== false) soundOn(); startAuto(true); });
      on(replayBtn, 'click', () => startAuto(true));
      on(autoBtn, 'click', () => (playing() ? pause() : startAuto(false)));
      on(moreBtn, 'click', () => setExpanded(!stage.classList.contains('is-expanded')));

      // Only a real gesture takes over from autoplay: a wheel turn, a drag, or a
      // navigation key. A tap (e.g. on Play itself) never does.
      const userInput = () => { if (auto) stopAuto(); };
      const keys = (e) => {
        const origin = e.composedPath()[0];
        if (origin && origin.closest && origin.closest('button,a,input,textarea,select,[contenteditable]')) return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); playing() ? pause() : startAuto(false); return; }
        if (scrolly) {
          if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(e.key)) userInput();
          return;
        }
        const r = Math.round(target);
        const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
        if (step) { e.preventDefault(); goTo(r + step); }
        else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
        else if (e.key === 'End') { e.preventDefault(); goTo(loop ? N - 1 : N); }
      };

      if (scrolly) {
        on(window, 'scroll', onScroll, { passive: true });
        on(window, 'wheel', userInput, { passive: true });
        let touchY = null;
        on(window, 'touchstart', (e) => { touchY = e.touches[0].clientY; }, { passive: true });
        on(window, 'touchmove', (e) => {
          if (touchY !== null && Math.abs(e.touches[0].clientY - touchY) > 12) { touchY = null; userInput(); }
        }, { passive: true });
        on(mode === 'page' ? window : host, 'keydown', keys);
      } else {
        on(host, 'keydown', keys);
        // Drag sideways to scrub; vertical swipes stay with the page.
        let drag = null;
        on(stage, 'pointerdown', (e) => {
          if (e.button || !e.isPrimary) return;
          if (e.composedPath()[0].closest('button,a,#progress')) return;
          drag = { x: e.clientX, t: target, id: e.pointerId, moved: false };
        });
        on(window, 'pointermove', (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          const dx = e.clientX - drag.x;
          if (!drag.moved) {
            if (Math.abs(dx) < 8) return;
            drag.moved = true;
            stopAuto();
            closeIntro();
            drag.t = target;
            drag.x = e.clientX;
            return;
          }
          const t = drag.t - (dx / Math.max(1, stage.clientWidth)) * DRAG_LAYERS;
          target = loop ? t : clamp(t, 0, N);
        });
        const release = (e) => {
          if (!drag || e.pointerId !== drag.id) return;
          if (drag.moved) {
            const r = Math.round(target);
            if (Math.abs(target - r) < 0.25) target = loop ? r : clamp(r, 0, N);
          }
          drag = null;
        };
        on(window, 'pointerup', release);
        on(window, 'pointercancel', release);
        // Seek by clicking the progress bar.
        on(progressWrap, 'click', (e) => {
          const r = progressWrap.getBoundingClientRect();
          const f = clamp((e.clientX - r.left) / r.width, 0, 1);
          stopAuto();
          closeIntro();
          target = loop ? Math.floor(target / N) * N + f * N : f * N;
        });
        // The wheel (or a two-finger swipe) scrubs once the reader has engaged
        // with the player by pressing or dragging in it, and until it leaves
        // the screen. Before that, and at either end of the story, it scrolls
        // the page as usual, so a reader passing by never gets stuck.
        let engaged = false;
        on(stage, 'pointerdown', () => { engaged = true; });
        on(host, 'wheel', (e) => {
          if (!engaged && document.fullscreenElement !== host) return;
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
          const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit / WHEEL_PX;
          if (!d || (!loop && ((d < 0 && target <= 0) || (d > 0 && target >= N)))) return;
          e.preventDefault();
          stopAuto();
          closeIntro();
          const t = target + d;
          target = loop ? t : clamp(t, 0, N);
        }, { passive: false });
        if ('IntersectionObserver' in window) {
          const away = new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) engaged = false; });
          away.observe(host);
          offs.push(() => away.disconnect());
        }
        if (document.fullscreenEnabled && host.requestFullscreen) {
          fsBtn.hidden = false;
          on(fsBtn, 'click', () => {
            if (document.fullscreenElement === host) document.exitFullscreen();
            else host.requestFullscreen().catch(() => {});
          });
          on(document, 'fullscreenchange', () => {
            fsBtn.setAttribute('aria-label', document.fullscreenElement === host ? ui.exitFullscreen : ui.fullscreen);
          });
        }
        // autoplay: play muted while at least half in view, until the reader takes over.
        if (host.hasAttribute('autoplay') && 'IntersectionObserver' in window) {
          const io = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting && !auto && !touched) { startAuto(false); touched = false; }
            else if (!entry.isIntersecting && playing()) brake();
          }, { threshold: 0.5 });
          io.observe(host);
          offs.push(() => io.disconnect());
          on(stage, 'pointerdown', () => { touched = true; });
        }
      }

      // Hidden tabs freeze the clock rather than jumping ahead on return.
      on(document, 'visibilitychange', () => {
        if (document.hidden) hiddenAt = performance.now();
        else if (auto && hiddenAt) auto.since += performance.now() - hiddenAt;
      });
      on(window, 'resize', () => { sizeCanvas(); layoutTrack(false); });
      if ('ResizeObserver' in window) {
        const ro = new ResizeObserver(() => sizeCanvas());
        ro.observe(stage);
        offs.push(() => ro.disconnect());
      }
    }

    function buildRail() {
      const entries = layers.map((L) => L.label || L.id);
      if (!loop) entries.push((page.end && page.end.rail) || (brand && brand.cta) || ui.end);
      entries.forEach((label, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', `Go to: ${label}`);
        if (i === N) b.className = 'end';
        b.addEventListener('click', () => goTo(i));
        railEl.appendChild(b);
      });
    }

    function frame(now) {
      if (!alive) return;
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      wide += ((auto ? 1 : 0) - wide) * (1 - Math.exp(-dt * 4));
      if (auto) {
        const before = current;
        stepAuto(now);
        if (dt > 0) vel = (current - before) / dt;   // hand-off speed if the reader takes over
      } else if (reduceMotion.matches) {
        current = target;
        vel = 0;
      } else {
        // Critically damped spring toward the target, solved exactly per frame:
        // speed changes smoothly however the target jumps (wheel notches,
        // drags), it never overshoots, and it is stable at any frame rate.
        const e = current - target, c = vel + SPRING * e, f = Math.exp(-SPRING * dt);
        current = target + (e + c * dt) * f;
        vel = (vel - SPRING * c * dt) * f;
        if (!loop) {
          const lim = clamp(current, 0, N);
          if (lim !== current) { current = lim; vel = 0; }
        }
        if (Math.abs(target - current) < 1e-4 && Math.abs(vel) < 1e-3) { current = target; vel = 0; }
      }
      if (Math.floor(current) !== Math.floor(drawn) || Number.isNaN(drawn)) keepWindow();
      updateVideos(now, dt);
      if (dirty || current !== drawn) {
        draw();
        updateOverlay();
      }
      raf = requestAnimationFrame(frame);
    }

    // ---- boot --------------------------------------------------------------

    function applyTheme(theme) {
      const map = {
        ink: '--dt-ink', primary: '--dt-primary', primaryDeep: '--dt-primary-deep', accent: '--dt-accent',
        onDark: '--dt-on-dark', onDarkDim: '--dt-on-dark-dim', fontDisplay: '--dt-font-display', fontText: '--dt-font-text',
      };
      const rules = [`--dt-aspect: ${aspect};`];
      Object.entries(map).forEach(([k, v]) => { if (theme[k]) rules.push(`${v}: ${theme[k]};`); });
      (theme.chips || []).slice(0, 3).forEach((c, i) => rules.push(`--dt-chip-${i + 1}: ${c};`));
      $('theme').textContent = `:host { ${rules.join(' ')} }`;
      if (theme.ink) inkColor = theme.ink;
      loadFonts(theme.fontsHref);
    }

    function fillChrome() {
      const intro = page.intro || {};
      $('intro-eyebrow').textContent = intro.eyebrow || (brand && brand.name) || '';
      $('intro-title').textContent = intro.title || '';
      $('intro-sub').textContent = intro.sub || '';
      playBtn.querySelector('span').textContent = intro.play || ui.start;
      $('intro-alt').textContent = scrolly ? intro.alt || '' : intro.altPlayer || ui.dragHint;
      autoBtn.textContent = ui.play;
      replayBtn.textContent = ui.replay;
      setExpanded(false);
      if (brand) {
        const a = $('brand');
        if (brand.url) a.href = brand.url;
        a.querySelector('.name').textContent = brand.name || '';
        if (brand.badge) { const b = a.querySelector('.badge'); b.textContent = brand.badge; b.hidden = false; }
        if (brand.logo) {
          root.querySelectorAll('.logo').forEach((img) => { img.src = url(brand.logo); img.hidden = false; });
        }
        if (brand.cta && brand.url) {
          const c = $('bar-cta');
          c.textContent = brand.cta;
          c.href = brand.ctaHref || brand.url;
          c.hidden = false;
        }
      }
      if (page.end) {
        const p1 = $('cta-primary'), p2 = $('cta-secondary');
        if (page.end.primary) { p1.textContent = page.end.primary.label; p1.href = page.end.primary.href; } else p1.hidden = true;
        if (page.end.secondary) { p2.textContent = page.end.secondary.label; p2.href = page.end.secondary.href; } else p2.hidden = true;
      } else {
        ctaEl.querySelector('.actions').hidden = true;
      }
      loadingText.textContent = (page.loading) || ui.loading;
    }

    async function boot() {
      const src = host.getAttribute('src') || 'manifest.json';
      const manifestUrl = new URL(src, document.baseURI).href;
      baseUrl = manifestUrl;
      if (mode === 'page' && 'scrollRestoration' in history) history.scrollRestoration = 'manual';
      const res = await fetch(manifestUrl);
      if (!res.ok) throw new Error(`${manifestUrl}: HTTP ${res.status}`);
      const manifest = await res.json();
      S = manifest.scale;
      N = manifest.layers.length;
      aspect = manifest.width / manifest.height;
      layers = manifest.layers;
      page = manifest.page || {};
      brand = manifest.brand || null;
      ui = { ...UI, ...(page.ui || {}) };
      // A loop only makes sense when the dive owns the whole page.
      loop = mode === 'page' && page.loop !== false;
      sizes = Object.keys(layers[0].src).map(Number);
      blobs = new Array(N).fill(null);
      bitmaps = new Array(N).fill(null);
      decoding = new Array(N).fill(null);
      score = new Score(manifest.score, N);
      applyTheme(manifest.theme || {});
      fillChrome();
      buildRail();
      buildPlan();
      bindInput();
      if (page.intro === false) closeIntro();

      sizeCanvas();
      if (loop) current = N;
      layoutTrack(true);
      if (!window.divetrope) window.divetrope = api;

      const loaded = loadAll(pickSize());
      raf = requestAnimationFrame(frame);

      const firstScreen = async () => {
        for (;;) {
          const need = [...new Set([N - 1, 0, 1, 2].filter((i) => i < N))];
          if (need.every((i) => blobs[i])) {
            await Promise.all(need.map((i) => decode(i)));
            if (need.every((i) => bitmaps[i])) return;
          }
          if (!alive) return;
          await new Promise((r) => setTimeout(r, 60));
        }
      };
      await Promise.race([firstScreen(), loaded.then(firstScreen)]);
      loadingEl.classList.add('done');
      emit('dt-ready', { layers: N });
      await loaded;
    }

    const api = {
      get t() { return current; },
      get layerPx() { return layerPx; },
      get loopPx() { return loop ? loopPx : 0; },
      get decoded() { return bitmaps.map(Boolean); },
      get scene() { return shown; },
      get auto() { return auto && { phase: auto.stop ? 'braking' : 'play', time: autoTime(performance.now()) }; },
      get plan() { return plan; },
      get layers() { return N; },
      get mode() { return mode; },
      get playing() { return playing(); },
      play() { startAuto(false); },
      pause() { if (playing()) pause(); },
      restart() { startAuto(true); },
      goTo(i) { goTo(i); },
      seek(t) { stopAuto(); closeIntro(); target = t; current = t; if (scrolly) syncScroll(); },
      sound(isOn) { if (isOn) soundOn(); else if (score) { score.setMuted(true); setSoundUI(false); } },
      destroy() {
        alive = false;
        cancelAnimationFrame(raf);
        offs.splice(0).forEach((f) => f());
        if (score) score.stop();
        bitmaps.forEach((b) => b && b.close && b.close());
        if (window.divetrope === api) delete window.divetrope;
      },
    };

    boot().catch((err) => {
      console.error(err);
      loadingText.textContent = (ui && ui.error) || UI.error;
    });
    return api;
  }

  class DivetropePlayer extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._api = null;
    }

    connectedCallback() {
      if (!this._api) this._api = mount(this);
    }

    disconnectedCallback() {
      // Moving the element in the DOM fires disconnect then connect; only tear
      // down if it is really gone.
      queueMicrotask(() => {
        if (!this.isConnected && this._api) { this._api.destroy(); this._api = null; }
      });
    }

    get dive() { return this._api; }
    play() { if (this._api) this._api.play(); }
    pause() { if (this._api) this._api.pause(); }
    restart() { if (this._api) this._api.restart(); }
    goTo(i) { if (this._api) this._api.goTo(i); }
    seek(t) { if (this._api) this._api.seek(t); }
  }

  window.DivetropeScore = Score;
  window.customElements.define('divetrope-player', DivetropePlayer);
})();
