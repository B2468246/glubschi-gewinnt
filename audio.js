/* Glubschi gewinnt: "Quizshow-Shuffle". Original game-show thinking music + SFX, pure Web Audio.
   108 bpm, swung eighths (swing 0.65), 16-bar loop in C major, about 36 s per pass.
   Chords, one per bar ("X Y" = two beats each):
     A | C6 | A7 | Dm7 | G7 | C6 | A7 | Dm7 G7 | C6 |              marimba/kalimba lead
     B | F6 | F#dim7 | C6 | A7 | D7 | G7 | C6 A7 | Dm7 G7 |        kazoo countermelody + marimba plinks
   Strong-beat check (melody note sounding on beats 1 / 3 against its chord):
     A: G,E/C6  C#,rest/A7  D,F/Dm7  B,D/G7  G,G/C6  E,A/A7  F/Dm7 B/G7  E,G/C6
     B: A,D/F6  Eb,A/F#dim7  G,E/C6  C#,E/A7  C,F#/D7  B,F/G7  E/C6 C#/A7  D/Dm7 B/G7
   Every third pass bars 1-4 drop the lead (bass, brushes and plinks only) so the loop breathes.
   Integrated build: shuffle engine plus judge fixes, chip's sad trombone and hold(), polka's alternating taunt.
   Intensity > 0.5 adds a tick-tock game-show clock and a shaker; tempo creeps up to +10%. */
function createGlubschiAudio() {
  'use strict';
  const BPM = 108, SW = 0.65, AHEAD = 0.12, MUSIC_VOL = 0.14, SFX_VOL = 0.35;
  let ctx = null, comp = null, duckBus = null, musicBus = null, sfxBus = null, noise = null;
  let musicOn = true, sfxOn = true, unlocked = false, paused = false, wasRunning = false, tauntFlip = false;
  let running = false, timer = null, stopTimer = null, gen = 0, resumeUntil = 0;
  let bar = 0, slot = 0, pass = 0, nextT = 0, beat = 60 / BPM, inten = 0, pendInten = 0;

  // chord = [bass root (midi), 3rd, 5th, 6th or 7th] as semitone offsets
  const CH = { C6: [48, 4, 7, 9], A7: [45, 4, 7, 10], Dm7: [50, 3, 7, 10], G7: [43, 4, 7, 10],
    F6: [41, 4, 7, 9], 'F#o7': [42, 3, 6, 9], D7: [50, 4, 7, 10] };
  const PROG = 'C6|A7|Dm7|G7|C6|A7|Dm7 G7|C6|F6|F#o7|C6|A7|D7|G7|C6 A7|Dm7 G7'
    .split('|').map((b) => b.split(' ').map((k) => CH[k]));
  // melodies per bar: [slot 0-7 (swung eighths), midi, length in eighths, ...]
  const LEAD = [
    [0, 67, 1, 1, 69, 1, 2, 72, 1, 3, 76, 2, 6, 74, 1, 7, 72, 1],
    [0, 73, 1, 1, 76, 1, 2, 79, 2, 5, 76, 1, 6, 73, 1, 7, 69, 1],
    [0, 74, 1, 1, 77, 1, 2, 81, 2, 4, 77, 1, 5, 76, 1, 6, 74, 1, 7, 72, 1],
    [0, 71, 1, 1, 74, 1, 2, 77, 1, 3, 76, 1, 4, 74, 2, 7, 67, 1],
    [0, 67, 1, 1, 69, 1, 2, 72, 1, 3, 79, 2, 6, 76, 1, 7, 75, 1],
    [0, 76, 1, 1, 73, 1, 2, 76, 1, 3, 81, 2, 6, 79, 1, 7, 76, 1],
    [0, 77, 1, 1, 76, 1, 2, 74, 1, 3, 72, 1, 4, 71, 1, 5, 74, 1, 6, 77, 1, 7, 74, 1],
    [0, 76, 1, 1, 72, 2, 4, 67, 1, 6, 72, 1]
  ];
  const KAZ = [
    [0, 69, 3, 3, 72, 1, 4, 74, 3, 7, 72, 1],
    [0, 75, 3, 3, 72, 1, 4, 69, 4],
    [0, 67, 2, 2, 69, 1, 3, 72, 1, 4, 76, 4],
    [0, 73, 3, 3, 74, 1, 4, 76, 2, 6, 74, 1, 7, 73, 1],
    [0, 72, 3, 3, 69, 1, 4, 66, 3, 7, 69, 1],
    [0, 71, 2, 2, 72, 1, 3, 74, 1, 4, 77, 4],
    [0, 76, 3, 3, 74, 1, 4, 73, 3, 7, 76, 1],
    [0, 74, 3, 3, 72, 1, 4, 71, 2, 6, 67, 2]
  ];

  // ---------- small helpers ----------
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const quiet = (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
  function gainNode(dest, v) { const g = ctx.createGain(); g.gain.value = v; g.connect(dest); return g; }
  function filt(type, f, q, dest) {
    const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; b.connect(dest); return b;
  }
  function osc(type, f, t, end, dest) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    o.connect(dest); o.start(t); o.stop(end); return o;
  }
  // when the source ends, unhook its little chain so nothing lingers
  function done(src, nodes) { src.onended = () => nodes.forEach((n) => { try { n.disconnect(); } catch (e) { /* gone */ } }); }
  // attack to v, optional hold, exponential release
  function env(g, t, v, a, d, hold) {
    const p = g.gain, h = hold || 0;
    p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + a);
    if (h) p.setValueAtTime(v, t + a + h);
    p.exponentialRampToValueAtTime(0.0001, t + a + h + d);
  }
  // freeze a param at its true current value (p.value is unreliable mid-automation on older Safari)
  function hold(p, t) {
    if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(t);
    else { p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); }
  }
  function glide(p, v, t, tc) { hold(p, t); p.setTargetAtTime(v, t, tc); }
  function duck(t, len, lvl) { glide(duckBus.gain, lvl, t, 0.04); duckBus.gain.setTargetAtTime(1, t + len, 0.3); }

  // ---------- instruments ----------
  function marimba(t, m, v, dest, decay) { // sine with fast decay + slightly detuned 4th partial
    const f = mtof(m), d = decay || 0.3, g = gainNode(dest || musicBus, 0), g2 = gainNode(g, 0);
    env(g, t, v, 0.004, d);
    g2.gain.setValueAtTime(0.4, t); g2.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    const o = osc('sine', f, t, t + d + 0.02, g), o2 = osc('sine', f * 4, t, t + 0.1, g2);
    o2.detune.setValueAtTime(9, t);
    done(o, [o, o2, g, g2]);
  }
  function bass(t, m, dur, v) { // upright-ish: triangle, closing lowpass, pluck envelope
    const g = gainNode(musicBus, 0), lp = filt('lowpass', 1300, 1.5, g), p = g.gain;
    p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + 0.008);
    p.exponentialRampToValueAtTime(v * 0.4, t + 0.1); p.exponentialRampToValueAtTime(0.0001, t + dur);
    lp.frequency.setValueAtTime(1300, t); lp.frequency.exponentialRampToValueAtTime(550, t + 0.12);
    const o = osc('triangle', mtof(m), t, t + dur + 0.02, lp);
    done(o, [o, lp, g]);
  }
  function hit(t, type, f, q, v, a, d, dest) { // filtered burst from the shared noise buffer
    const g = gainNode(dest || musicBus, 0), b = filt(type, f, q, g), s = ctx.createBufferSource();
    s.buffer = noise; s.connect(b); env(g, t, v, a, d);
    s.start(t, Math.random() * 1.2); s.stop(t + a + d + 0.02);
    done(s, [s, b, g]); return b;
  }
  function kick(t, v) {
    const g = gainNode(musicBus, 0); env(g, t, v, 0.003, 0.15);
    const o = osc('sine', 120, t, t + 0.18, g); o.frequency.exponentialRampToValueAtTime(50, t + 0.09);
    done(o, [o, g]);
  }
  function kazoo(t, m, dur, v) { // saw through a bandpass, scoop + delayed vibrato
    const f = mtof(m), g = gainNode(musicBus, 0), lp = filt('lowpass', 4000, 0.7, g),
      bp = filt('bandpass', Math.min(1600, Math.max(850, f * 2.5)), 1.3, lp), p = g.gain;
    p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + 0.04);
    p.linearRampToValueAtTime(v * 0.75, t + dur); p.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
    const o = osc('sawtooth', f * 0.96, t, t + dur + 0.1, bp);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.07);
    const vg = gainNode(o.frequency, 0), lfo = osc('sine', 5.5, t, t + dur + 0.1, vg);
    vg.gain.setValueAtTime(0, t + 0.12); vg.gain.linearRampToValueAtTime(f * 0.014, t + 0.3);
    done(o, [o, lfo, vg, bp, lp, g]);
  }
  function clock(t, f, v) { // woodblock-ish tick: noise click + falling sine
    const g = gainNode(musicBus, 0); env(g, t, v, 0.001, 0.05);
    const o = osc('sine', f, t, t + 0.07, g); o.frequency.exponentialRampToValueAtTime(f * 0.82, t + 0.04);
    done(o, [o, g]);
    hit(t, 'bandpass', f * 1.6, 4, v * 0.5, 0.001, 0.02);
  }
  function brass(t, m, len, v) { // fanfare voice: saw + square, filter swell, capped at 3.2 kHz
    const f = mtof(m), g = gainNode(sfxBus, 0), lp = filt('lowpass', 900, 1.2, g);
    env(g, t, v, 0.02, 0.15, len);
    lp.frequency.setValueAtTime(700, t); lp.frequency.exponentialRampToValueAtTime(3200, t + 0.05);
    lp.frequency.exponentialRampToValueAtTime(1600, t + len + 0.1);
    const o = osc('sawtooth', f, t, t + len + 0.2, lp), o2 = osc('square', f, t, t + len + 0.2, lp);
    o2.detune.setValueAtTime(7, t);
    done(o, [o, o2, lp, g]);
  }

  // ---------- the band ----------
  function bassNote(b) { // walking line: root, chord tones, chromatic approach to the next root
    const c1 = PROG[bar][0], c2 = PROG[bar][1];
    if (b === 3) { const nxt = PROG[(bar + 1) % 16][0][0]; return nxt + (bassNote(2) > nxt ? 1 : -1); }
    if (c2) return b === 2 ? c2[0] : c1[0] + (b ? c1[1] : 0);
    return c1[0] + (bar % 2 ? [0, c1[2], c1[3]] : [0, c1[1], c1[2]])[b];
  }
  function playSlot(t) {
    const chords = PROG[bar], ch = chords[slot >= 4 && chords[1] ? 1 : 0];
    const k = clamp01((inten - 0.5) * 2), isA = bar < 8, breakdown = isA && pass % 3 === 2 && bar < 4;
    // brushes: feathered kick + soft swish on 1 and 3, slap on 2 and 4, ride ticks "ding ding-a"
    if (slot % 4 === 0) { kick(t, 0.3); hit(t, 'bandpass', 3800, 0.5, 0.06, 0.12, 0.3); }
    if (slot === 2 || slot === 6) hit(t, 'bandpass', 2400, 0.7, 0.24, 0.004, 0.16);
    if (slot !== 1 && slot !== 5) hit(t, 'highpass', 7000, 0.7, slot % 2 ? 0.05 : 0.08, 0.002, 0.05);
    // tension: tick-tock clock on the beats, double-time near the end, shaker on every eighth
    if (k > 0) {
      if (slot % 2 === 0) clock(t, slot % 4 ? 1450 : 1900, 0.2 * k);
      else if (k > 0.7) clock(t, 1650, 0.08 * k);
      hit(t, 'highpass', 5200, 0.9, (slot % 2 ? 0.08 : 0.045) * k, 0.003, 0.05);
    }
    // walking bass on the beats, swung skip note on the "and" of 2 every fourth bar
    if (slot % 2 === 0) bass(t, bassNote(slot / 2), beat * 0.85, 0.55);
    else if (slot === 3 && bar % 4 === 3) bass(t, bassNote(1), beat * 0.3, 0.25);
    // lead: marimba in A, kazoo in B
    const line = isA ? LEAD[bar] : KAZ[bar - 8];
    for (let i = 0; i < line.length; i += 3) {
      if (line[i] !== slot) continue;
      if (!isA) kazoo(t, line[i + 1], line[i + 2] * beat * 0.47, 0.52);
      else if (!breakdown) marimba(t, line[i + 1], 0.55, musicBus, 0.2 + 0.12 * line[i + 2]);
    }
    // plinks (3rd + 6th/7th) on the swung off-beats of 2 and 4
    if ((!isA || breakdown) && (slot === 3 || slot === 7)) {
      const r = 60 + (ch[0] % 12);
      marimba(t, r + ch[1], 0.17); marimba(t + 0.012, r + ch[3], 0.14);
    }
  }

  // ---------- lookahead scheduler ----------
  function nextBar() { bar = (bar + 1) % 16; if (!bar) pass = (pass + 1) % 6; }
  function barLine() { // intensity and tempo only move on the bar line
    if (slot !== 0) return;
    inten = pendInten;
    beat = 60 / (BPM * (1 + 0.1 * clamp01((inten - 0.2) / 0.8)));
  }
  function advance() { nextT += beat * (slot % 2 ? 1 - SW : SW); if (++slot === 8) { slot = 0; nextBar(); } }
  function tick(id) {
    if (id !== gen || !running || !ctx) return;
    const now = ctx.currentTime;
    if (nextT < now - 0.5) { nextT = now + 0.05; if (slot) { slot = 0; nextBar(); } } // throttled: skip backlog
    // short stall: silently step over the missed slots so they don't all fire at once, groove stays on the grid
    let skip = 0;
    while (nextT < now - 0.03 && skip++ < 64) { barLine(); advance(); }
    let guard = 0;
    while (nextT < now + AHEAD && guard++ < 16) {
      barLine();
      try { playSlot(nextT); } catch (e) { /* never let audio break the game */ }
      advance();
    }
    timer = setTimeout(() => tick(id), 25);
  }
  function killTimer() { clearTimeout(timer); timer = null; gen++; }
  function startTimer() {
    if (paused || !running || !ctx) return;
    killTimer(); const id = gen; timer = setTimeout(() => tick(id), 0);
  }
  function startLoop() {
    clearTimeout(stopTimer); stopTimer = null;
    if (running) return;
    running = true; bar = 0; slot = 0; pass = 0; nextT = ctx.currentTime + 0.08; startTimer();
  }

  // ---------- sound effects ----------
  const SFX = {
    drop(t, o) { // falling whistle, deeper row = longer fall
      const row = Math.max(0, Math.min(5, Math.round(Number(o.row)) || 0)), d = 0.14 + row * 0.035;
      const g = gainNode(sfxBus, 0), x = osc('triangle', 1400, t, t + d + 0.1, g);
      env(g, t, 0.28, 0.005, 0.06, d - 0.03);
      x.frequency.exponentialRampToValueAtTime(1400 / (1.8 + row * 0.25), t + d);
      done(x, [x, g]);
    },
    land(t) { // squishy plop
      const g = gainNode(sfxBus, 0); env(g, t, 0.5, 0.004, 0.14);
      const o = osc('sine', 160, t, t + 0.2, g);
      o.frequency.exponentialRampToValueAtTime(520, t + 0.035); o.frequency.exponentialRampToValueAtTime(260, t + 0.13);
      done(o, [o, g]);
      hit(t, 'lowpass', 900, 1, 0.25, 0.003, 0.07, sfxBus);
    },
    win(t) { // quick arpeggio, cheeky wiggle, held C major chord with sparkle
      duck(t, 2, 0.2);
      [[0, 67, 0.06], [0.09, 72, 0.06], [0.18, 76, 0.06], [0.27, 79, 0.1], [0.42, 81, 0.05], [0.52, 79, 0.05]]
        .forEach((n) => brass(t + n[0], n[1], n[2], 0.13));
      [72, 76, 79, 84].forEach((m) => brass(t + 0.66, m, 1.0, 0.08));
      [84, 88, 91, 96].forEach((m, i) => marimba(t + 0.68 + i * 0.07, m, 0.28, sfxBus));
    },
    draw(t) { // sad "wah wah wah wahhh": four-step semitone fall, droopy wobble on the last
      duck(t, 1.7, 0.25);
      [[0, 62, 0.2], [0.27, 61, 0.2], [0.54, 60, 0.2], [0.81, 59, 0.6]].forEach((n, i) => {
        const tt = t + n[0], f = mtof(n[1]), l = n[2], g = gainNode(sfxBus, 0), lp = filt('lowpass', 400, 5, g);
        env(g, tt, 0.32, 0.03, 0.12, l);
        lp.frequency.setValueAtTime(320, tt); lp.frequency.exponentialRampToValueAtTime(1500, tt + 0.13);
        lp.frequency.exponentialRampToValueAtTime(380, tt + l + 0.1);
        const o = osc('sawtooth', f, tt, tt + l + 0.2, lp), nodes = [o, lp, g];
        if (i === 3) {
          o.frequency.exponentialRampToValueAtTime(f * 0.95, tt + l + 0.1);
          const vg = gainNode(o.frequency, 0), lfo = osc('sine', 6, tt, tt + l + 0.2, vg);
          vg.gain.setValueAtTime(0, tt + 0.1); vg.gain.linearRampToValueAtTime(f * 0.03, tt + 0.4);
          nodes.push(vg, lfo);
        }
        done(o, nodes);
      });
    },
    taunt(t) { // boing and slide whistle take turns
      tauntFlip = !tauntFlip;
      const g = gainNode(sfxBus, 0), boing = tauntFlip, o = osc(boing ? 'triangle' : 'sine', boing ? 140 : 700, t, t + 0.62, g);
      const vg = gainNode(o.frequency, 0), lfo = osc('sine', boing ? 13 : 7, t, t + 0.62, vg);
      if (boing) {
        env(g, t, 0.4, 0.005, 0.55);
        o.frequency.exponentialRampToValueAtTime(330, t + 0.06);
        vg.gain.setValueAtTime(90, t); vg.gain.exponentialRampToValueAtTime(1, t + 0.55);
      } else {
        env(g, t, 0.2, 0.03, 0.15, 0.38);
        o.frequency.exponentialRampToValueAtTime(1900, t + 0.3); o.frequency.exponentialRampToValueAtTime(1100, t + 0.52);
        vg.gain.setValueAtTime(25, t);
      }
      done(o, [o, lfo, vg, g]);
    },
    nope(t) { // two buzzy low blips going down
      [[0, 52], [0.13, 47]].forEach((n) => {
        const g = gainNode(sfxBus, 0), lp = filt('lowpass', 1500, 2, g);
        env(g, t + n[0], 0.2, 0.005, 0.05, 0.06);
        const o = osc('square', mtof(n[1]), t + n[0], t + n[0] + 0.14, lp);
        done(o, [o, lp, g]);
      });
    },
    seat(t) { marimba(t, 76, 0.5, sfxBus, 0.25); marimba(t + 0.09, 84, 0.5, sfxBus, 0.35); },
    flush(t) { // marimba tumbling down + noise whoosh
      [84, 81, 79, 76, 74, 72, 69, 67, 64, 62, 60].forEach((m, i) => marimba(t + i * 0.045, m, 0.3, sfxBus, 0.25));
      const b = hit(t, 'bandpass', 3500, 1.2, 0.2, 0.05, 0.5, sfxBus);
      b.frequency.setValueAtTime(3500, t); b.frequency.exponentialRampToValueAtTime(250, t + 0.55);
    }
  };

  // ---------- public API ----------
  function build(AC) {
    ctx = new AC();
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.2;
    comp.connect(ctx.destination);
    duckBus = gainNode(comp, 1); musicBus = gainNode(duckBus, 0); sfxBus = gainNode(comp, SFX_VOL);
    noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 2), ctx.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function blip() { // iOS unlock: play one silent sample inside the gesture
    const s = ctx.createBufferSource();
    s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate); s.connect(ctx.destination);
    s.start(ctx.currentTime); s.stop(ctx.currentTime + 0.05);
    done(s, [s]);
  }
  // iOS: Web Audio defaults to the 'ambient' session, which the ringer switch mutes. With music on, opt into
  // 'playback' (iOS 17+ Audio Session API) so it plays through silent mode; effects alone stay 'ambient'.
  function session() {
    try { if (typeof navigator !== 'undefined' && navigator.audioSession) navigator.audioSession.type = musicOn ? 'playback' : 'ambient'; } catch (e) { /* unsupported */ }
  }
  function live() { try { return !!ctx && ctx.state === 'running'; } catch (e) { return false; } }
  function wake() { // only called from a gesture (unlock, toggles); also reopens an iOS context left 'interrupted'
    if (!ctx || paused || !(musicOn || sfxOn) || live()) return;
    try { blip(); } catch (e) { /* ignore */ }
    resumeUntil = Date.now() + 800; // effects made right in this gesture may wait for the resume
    quiet(ctx.resume());
  }
  function idle() { // nothing to play: let the context sleep (saves battery, releases the iOS session)
    if (ctx && !paused && !musicOn && !sfxOn && !running && live()) quiet(ctx.suspend());
  }
  const api = {
    unlock() {
      try {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return;
        session();
        if (!ctx) { try { build(AC); } catch (e) { ctx = null; return; } }
        const wasPaused = paused;
        unlocked = true; paused = false;
        wake();
        if (musicOn) api.setMusic(true); else idle();
        if (wasPaused && running) startTimer(); // a tap while "paused" means the page is visible again
      } catch (e) { /* stay silent */ }
    },
    setMusic(on) {
      musicOn = !!on;
      if (!ctx) return;
      try {
        session();
        if (musicOn) wake();
        glide(musicBus.gain, musicOn ? MUSIC_VOL : 0, ctx.currentTime, 0.09); // ~0.3 s fade
        if (musicOn) startLoop();
        else {
          clearTimeout(stopTimer);
          stopTimer = setTimeout(() => { if (!musicOn) { running = false; killTimer(); idle(); } }, 400);
        }
      } catch (e) { /* ignore */ }
    },
    setSfx(on) {
      sfxOn = !!on;
      try { if (sfxOn) wake(); else idle(); } catch (e) { /* ignore */ }
    },
    isMusicOn: () => musicOn, isSfxOn: () => sfxOn, isUnlocked: () => unlocked && live(),
    setIntensity(x) { try { x = Number(x); pendInten = x > 0 ? Math.min(1, x) : 0; } catch (e) { pendInten = 0; } },
    sfx(name, opts) {
      if (!ctx || !unlocked || !sfxOn || paused || !Object.prototype.hasOwnProperty.call(SFX, name)) return;
      // a suspended context would queue the sound and fire it later in a pile; drop it unless a resume is underway
      if (!live() && Date.now() > resumeUntil) return;
      try { SFX[name](ctx.currentTime + 0.01, opts || {}); } catch (e) { /* ignore */ }
    },
    pause() {
      try {
        if (!ctx || paused) return;
        paused = true; wasRunning = live(); killTimer();
        if (wasRunning) quiet(ctx.suspend());
      } catch (e) { /* ignore */ }
    },
    resume() {
      try {
        if (!ctx || !paused) return;
        paused = false;
        if (wasRunning && (musicOn || sfxOn)) quiet(ctx.resume());
        if (running) startTimer();
      } catch (e) { /* ignore */ }
    }
  };
  return api;
}
