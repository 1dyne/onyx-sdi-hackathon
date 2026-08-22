/* ─────────────────────────────────────────────────────────────
   Audio alerts.

   Left/right is conveyed WITHOUT adding a second set of sounds. Ten
   distinct tones would be more than a user can learn and tell apart
   under time pressure, so the five existing meanings are kept and the
   foot is encoded two ways at once:

     - stereo position (left ear / right ear) via StereoPannerNode
     - a pitch offset on the right foot (x1.2)

   The pitch offset is what makes it still work on a phone's mono
   speaker, where panning collapses. Together they read as "same
   warning, other foot" rather than as a new warning.
   ───────────────────────────────────────────────────────────── */
const audio = (() => {
  let ctx = null;

  // Throttle per foot: a left-foot alert must never swallow a
  // simultaneous right-foot one.
  const lastPlayAt = { left: 0, right: 0 };
  const THROTTLE   = 500;   // ms — minimum gap between two sounds on ONE foot

  // Right foot sits a minor third up so the two are distinguishable
  // even when both channels collapse to one speaker.
  const PITCH = { left: 1.0, right: 1.2 };
  const PAN   = { left: -0.8, right: 0.8 };

  /* ── AudioContext: lazy init, resumed on first play ─────── */
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  /* Build gain → [panner] → destination for one sound. */
  function makeChain(c, foot) {
    const gain = c.createGain();
    const { audioStereo } = store.getSettings();

    if (audioStereo && foot && typeof c.createStereoPanner === 'function') {
      const panner = c.createStereoPanner();
      panner.pan.value = PAN[foot] ?? 0;
      gain.connect(panner);
      panner.connect(c.destination);
    } else {
      gain.connect(c.destination);
    }
    return gain;
  }

  /* ── Primitive: play a single oscillator tone ───────────── */
  function tone(freq, startOffset, duration, vol, foot, type = 'sine') {
    try {
      const c    = getCtx();
      const osc  = c.createOscillator();
      const gain = makeChain(c, foot);
      osc.connect(gain);
      osc.type            = type;
      osc.frequency.value = freq * (PITCH[foot] ?? 1);
      const t0 = c.currentTime + startOffset;
      gain.gain.setValueAtTime(vol, t0);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
      osc.start(t0);
      osc.stop(t0 + duration + 0.01);
    } catch (_) {}
  }

  /* ── Sound definitions ──────────────────────────────────── */
  const SOUNDS = {
    // 압력 부족 경고: 440Hz 단음 0.4 s
    positive(vol, foot) { tone(440, 0, 0.4, vol, foot); },

    // 과압 경고: 880Hz 단음 0.4 s
    negative(vol, foot) { tone(880, 0, 0.4, vol, foot); },

    // 보행 시퀀스 오류: 600Hz → 800Hz 이중음 0.6 s
    gait(vol, foot) {
      tone(600, 0,   0.28, vol, foot);
      tone(800, 0.3, 0.3,  vol, foot);
    },

    // 성공 피드백: 523Hz + 659Hz 화음 0.6 s (C5 + E5)
    success(vol, foot) {
      tone(523, 0, 0.6, vol * 0.7, foot);
      tone(659, 0, 0.6, vol * 0.7, foot);
    },

    // IMU 발 틀어짐 경고: 300→600Hz 스윕 0.5 s
    imu(vol, foot) {
      try {
        const c     = getCtx();
        const osc   = c.createOscillator();
        const gain  = makeChain(c, foot);
        const pitch = PITCH[foot] ?? 1;
        osc.connect(gain);
        osc.type = 'sine';
        const t0 = c.currentTime;
        osc.frequency.setValueAtTime(300 * pitch, t0);
        osc.frequency.linearRampToValueAtTime(600 * pitch, t0 + 0.45);
        gain.gain.setValueAtTime(vol, t0);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.5);
        osc.start(t0);
        osc.stop(t0 + 0.51);
      } catch (_) {}
    },
  };

  /* ── Public API ─────────────────────────────────────────── */
  return {
    /* Call once on user gesture (session start) to unlock AudioContext */
    init() {
      try { getCtx(); } catch (_) {}
    },

    /* Play a sound type for one foot, with a per-foot throttle.
       Success uses a relaxed gap; alerts use THROTTLE. */
    play(type, foot = FOOT.LEFT) {
      const now = Date.now();
      const gap = type === 'success' ? 1500 : THROTTLE;
      if (now - (lastPlayAt[foot] ?? 0) < gap) return;
      lastPlayAt[foot] = now;

      const vol = store.getSettings().audioVolume;
      const fn  = SOUNDS[type];
      if (fn) fn(vol, foot);
    },

    /* Play immediately (ignores throttle) — used for TEST buttons */
    test(type, foot = FOOT.LEFT) {
      const vol = store.getSettings().audioVolume;
      const fn  = SOUNDS[type];
      if (fn) { try { getCtx(); fn(vol, foot); } catch (_) {} }
    },
  };
})();
