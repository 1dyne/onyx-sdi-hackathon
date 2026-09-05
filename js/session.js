/* ─────────────────────────────────────────────────────────────
   Session state — one session, two independent feet.

   Everything that used to be a single flat state object now lives in
   a per-foot record produced by createFootState(). Judgement runs
   once per incoming sample against that foot's record only, so:

     - one foot connected behaves exactly like the old single-device
       app (the other record simply never receives a sample),
     - a foot that joins late is folded in from that moment, and
     - a foot that drops keeps the statistics it accumulated.

   The drill definition and its thresholds are shared; only the
   calibration reference is per foot.
   ───────────────────────────────────────────────────────────── */
const session = (() => {

  /* ── Per-foot record ──────────────────────────────────────── */
  function createFootState() {
    return {
      joined:        false,      // has this foot delivered a sample yet
      joinedAt:      null,       // elapsed seconds when it first did
      totalSamples:  0,
      goodSamples:   0,
      alertCount:    0,
      currentValues: [0, 0, 0, 0, 0, 0, 0],
      activeAlerts:  [],
      alertTimeline: [],         // { time, pointId, type, foot }
      pointStats:    {},         // pid → { sum, max, count, alertCount }
      // Roll is accumulated against the foot's own first reading, the
      // same way yaw is: the IMU sits at whatever angle the strap put
      // it at, so only the deviation from that baseline is meaningful.
      // 원시 샘플. 상한에 닿으면 기록만 멈추고 세션은 계속된다.
      raw:           [],
      rawTruncated:  false,

      rollRef:       null,
      rollDevSum:    0,
      rollDevMax:    0,
      rollSamples:   0,
      gaitChecker:   null,
      yawRef:        null,       // per-foot calibration (gyro drifts)
      yawCalibratedAt: null,     // ms timestamp, for the drift hint
      currentImu:    { yaw: 0, pitch: 0, roll: 0 },
      lastAccuracy:  null,
      hasImu:        false,      // flips true on the first non-zero angle
      zeroImuStreak: 0,
    };
  }

  const state = {
    active:        false,
    freeCapture:   false,
    recordRaw:     true,
    drill:         null,
    sessionId:     null,
    startTime:     null,
    elapsed:       0,
    memo:          '',
    timerInterval: null,
    feet:          { left: createFootState(), right: createFootState() },
  };

  // Callbacks
  let onTick     = null;   // (elapsed, qualityByFoot, totalAlerts)
  let onValues   = null;   // (foot, values, alerts, accuracy)
  let onEnd      = null;   // (sessionLog)
  let onFreeTick = null;   // (foot, values, imu) — free-capture only
  let onFootJoin = null;   // (foot) — a foot started streaming mid-session

  function fmt2(n) { return String(n).padStart(2, '0'); }

  function footState(foot) {
    return state.feet[foot] || state.feet.left;
  }

  /* Quality for one foot. A foot that never joined reports null so the
     UI can distinguish "not connected" from "connected but scoring 0". */
  function computeQuality(foot) {
    const fs = footState(foot);
    if (!fs.joined) return null;
    if (!fs.totalSamples) return 100;
    return Math.round((fs.goodSamples / fs.totalSamples) * 100);
  }

  /* Feet that actually contributed to this session. */
  function joinedFeet() {
    return FOOT_IDS.filter(f => state.feet[f].joined);
  }

  function qualityByFoot() {
    const out = {};
    for (const f of FOOT_IDS) out[f] = computeQuality(f);
    return out;
  }

  /* Session-level quality is the mean over participating feet, so a
     single-foot session scores exactly as it did before v2.0. */
  function overallQuality() {
    const qs = joinedFeet().map(computeQuality).filter(q => q !== null);
    if (!qs.length) return 100;
    return Math.round(qs.reduce((a, b) => a + b, 0) / qs.length);
  }

  function totalAlertCount() {
    return FOOT_IDS.reduce((a, f) => a + state.feet[f].alertCount, 0);
  }

  function resetFeet(drill) {
    for (const f of FOOT_IDS) {
      const fs = createFootState();
      if (drill) {
        for (const pt of drill.points) {
          fs.pointStats[pt.id] = { sum: 0, max: 0, count: 0, alertCount: 0 };
        }
        fs.gaitChecker = drill.type === 'gait' ? alertEngine.createGaitChecker(drill.points) : null;
      }
      state.feet[f] = fs;
    }
  }

  /* ── Audio selection ───────────────────────────────────────────
     One sound per sample at most, picked by severity, and panned to
     the foot it came from. Keeping the five existing sounds and
     adding stereo position was chosen over ten separate sounds —
     see audio.js. */
  function playAlertSound(alerts, foot) {
    const { alertSoundEnabled } = store.getSettings();
    if (!alertSoundEnabled) return;
    const types = alerts.map(a => a.type);
    if      (types.includes('imu'))      audio.play('imu', foot);
    else if (types.includes('gait'))     audio.play('gait', foot);
    else if (types.includes('negative')) audio.play('negative', foot);
    else                                 audio.play('positive', foot);
  }

  return {
    /* ── Session-level getters ──────────────────────────────── */
    get isActive()    { return state.active; },
    get isFreeCapture() { return state.freeCapture; },
    get drill()       { return state.drill; },
    get elapsed()     { return state.elapsed; },
    get memo()        { return state.memo; },
    set memo(v)       { state.memo = v; },
    get alertCount()  { return totalAlertCount(); },
    get sessionId()   { return state.sessionId; },

    /* ── Per-foot access ────────────────────────────────────── */
    foot(f)           { return footState(f); },
    joinedFeet,
    quality(f)        { return f ? computeQuality(f) : overallQuality(); },
    qualityByFoot,
    hasFoot(f)        { return state.feet[f].joined; },
    currentValues(f)  { return footState(f).currentValues; },
    activeAlerts(f)   { return footState(f).activeAlerts; },
    currentImu(f)     { return footState(f).currentImu; },
    yawRef(f)         { return footState(f).yawRef; },
    hasImu(f)         { return footState(f).hasImu; },

    /* Seconds since this foot's yaw was calibrated. The 6-axis IMUs
       have no magnetometer, so this is the user's cue that yaw has
       been integrating error for a while. */
    yawAge(f) {
      const t = footState(f).yawCalibratedAt;
      return t === null ? null : Math.round((Date.now() - t) / 1000);
    },

    calibrateYaw(f) {
      const fs = footState(f);
      fs.yawRef = fs.currentImu.yaw;
      fs.yawCalibratedAt = Date.now();
      return fs.yawRef;
    },

    calibrateYawAll() {
      FOOT_IDS.forEach(f => { if (state.feet[f].joined) this.calibrateYaw(f); });
    },

    set onTick(fn)     { onTick     = fn; },
    set onValues(fn)   { onValues   = fn; },
    set onEnd(fn)      { onEnd      = fn; },
    set onFreeTick(fn) { onFreeTick = fn; },
    set onFootJoin(fn) { onFootJoin = fn; },

    fmtElapsed() {
      const m = Math.floor(state.elapsed / 60);
      const s = state.elapsed % 60;
      return `${fmt2(m)}:${fmt2(s)}`;
    },

    /* ── Lifecycle ──────────────────────────────────────────── */
    start(drill) {
      // Unlock AudioContext on this user gesture (session start tap)
      audio.init();

      Object.assign(state, {
        active:      true,
        freeCapture: false,
        recordRaw:   store.getSettings().recordRaw !== false,
        drill,
        sessionId:   store.newSessionId(),
        startTime:   Date.now(),
        elapsed:     0,
        memo:        '',
      });
      resetFeet(drill);

      state.timerInterval = setInterval(() => {
        state.elapsed++;
        onTick?.(state.elapsed, qualityByFoot(), totalAlertCount());
      }, 1000);
    },

    startFreeCapture() {
      audio.init();
      Object.assign(state, {
        active:      true,
        freeCapture: true,
        drill:       null,
        sessionId:   null,
        startTime:   Date.now(),
        elapsed:     0,
        memo:        '',
      });
      resetFeet(null);

      state.timerInterval = setInterval(() => {
        state.elapsed++;
        onTick?.(state.elapsed, qualityByFoot(), 0);
      }, 1000);
    },

    /* Snapshot both feet. Feet that never joined return null so the
       config wizard can register a one-foot capture cleanly. */
    stopFreeCapture() {
      if (!state.active || !state.freeCapture) return null;
      state.active      = false;
      state.freeCapture = false;
      clearInterval(state.timerInterval);

      const out = { left: null, right: null };
      for (const f of FOOT_IDS) {
        const fs = state.feet[f];
        if (!fs.joined) continue;
        out[f] = { values: [...fs.currentValues], imu: { ...fs.currentImu } };
      }
      return out;
    },

    /* ── Sample ingestion ───────────────────────────────────────
       Called once per packet with the foot it arrived on. */
    feed(values, foot = FOOT.LEFT) {
      if (!state.active) return;
      const fs = footState(foot);

      // First sample from this foot — it may be joining mid-session.
      if (!fs.joined) {
        fs.joined   = true;
        fs.joinedAt = state.elapsed;
        onFootJoin?.(foot);
      }

      fs.currentValues = values;

      /* 원시 기록. 판정보다 먼저 담는다 — 판정 로직이 나중에 바뀌어도
         원본은 그대로여야 다시 계산할 수 있다. 시각은 세션 시작
         기준 ms 오프셋이라 두 발을 같은 축에 놓고 볼 수 있다. */
      if (state.recordRaw && !state.freeCapture) {
        if (fs.raw.length < RAW_RECORD_MAX_SAMPLES) {
          const t = Date.now() - state.startTime;
          fs.raw.push([t, values[0], values[1], values[2], values[3],
                       Math.round((values[4] ?? 0) * 10) / 10,
                       Math.round((values[5] ?? 0) * 10) / 10,
                       Math.round((values[6] ?? 0) * 10) / 10]);
        } else if (!fs.rawTruncated) {
          fs.rawTruncated = true;
          console.warn(`[session] ${foot} 원시 기록 상한(${RAW_RECORD_MAX_SAMPLES}) 도달 — 이후 샘플은 기록하지 않습니다.`);
        }
      }

      // IMU (indices 4,5,6 = roll, pitch, yaw — matches firmware format)
      const roll  = values[4] ?? 0;
      const pitch = values[5] ?? 0;
      const yaw   = values[6] ?? 0;
      fs.currentImu = { yaw, pitch, roll };

      // A unit with no IMU sends the 4-field form, which bluetooth.js
      // pads with zeros. Treat a long run of exact zeros as "no IMU"
      // so the symmetry widget can opt out instead of reading 0°.
      if (roll === 0 && pitch === 0 && yaw === 0) {
        fs.zeroImuStreak++;
      } else {
        fs.zeroImuStreak = 0;
        fs.hasImu = true;
      }

      // Free-capture mode: broadcast only, no judgement.
      if (state.freeCapture) {
        onFreeTick?.(foot, values, fs.currentImu);
        return;
      }

      // Auto-calibrate this foot's yaw on its first valid sample.
      if (fs.yawRef === null) {
        fs.yawRef = yaw;
        fs.yawCalibratedAt = Date.now();
      }

      fs.totalSamples++;

      // FSR alert check (only indices 0-3), judged against this foot.
      const fsrValues = [...values.slice(0, 4), 0, 0, 0];
      const { alerts, accuracy } = alertEngine.check(state.drill, fsrValues, foot);

      // Gait check — this foot's own checker instance.
      if (fs.gaitChecker) {
        const { gaitError } = fs.gaitChecker.check(values);
        if (gaitError) alerts.push({ pointId: 'GAIT', type: 'gait', value: 0, thr: 0, foot });
      }

      // Yaw deviation, against this foot's own reference.
      if (fs.hasImu) {
        const tolerance = state.drill.yawTolerance ?? 10;
        const { delta, exceeded } = alertEngine.checkYaw(yaw, fs.yawRef, tolerance);
        if (exceeded) {
          alerts.push({ pointId: 'IMU', type: 'imu', value: delta, thr: tolerance, foot });
        }
      }

      // Per-point stats. Max matters as much as the mean here: a channel
      // can average fine and still spike past the threshold.
      for (const pt of state.drill.points) {
        const idx  = channelOf(state.drill.points, pt.id);
        const stat = fs.pointStats[pt.id];
        if (stat) {
          stat.sum += values[idx];
          if (values[idx] > stat.max) stat.max = values[idx];
          stat.count++;
        }
      }

      // Roll deviation from this foot's own baseline.
      if (fs.hasImu) {
        if (fs.rollRef === null) fs.rollRef = roll;
        const dev = Math.abs(roll - fs.rollRef);
        fs.rollDevSum += dev;
        if (dev > fs.rollDevMax) fs.rollDevMax = dev;
        fs.rollSamples++;
      }

      if (!alerts.length) {
        fs.goodSamples++;
        const { successSoundEnabled, successThreshold } = store.getSettings();
        if (successSoundEnabled && accuracy !== null && accuracy >= successThreshold) {
          audio.play('success', foot);   // audio.js handles its own throttle
        }
      } else {
        fs.alertCount++;
        for (const a of alerts) {
          if (a.pointId !== 'GAIT' && fs.pointStats[a.pointId]) {
            fs.pointStats[a.pointId].alertCount++;
          }
          fs.alertTimeline.push({ time: state.elapsed, ...a });
        }
        playAlertSound(alerts, foot);
      }

      fs.activeAlerts = alerts;
      fs.lastAccuracy = accuracy;
      onValues?.(foot, values, alerts, accuracy);
    },

    /* ── End + log ──────────────────────────────────────────────
       Schema 2 keeps the v1 top-level fields (quality, alertCount,
       pointStats, alertTimeline) populated with session-wide values
       so the existing LOG list and cumulative stats keep working
       unchanged, and adds byFoot for the per-side breakdown. */
    end() {
      if (!state.active) return null;

      if (state.freeCapture) {
        state.active      = false;
        state.freeCapture = false;
        clearInterval(state.timerInterval);
        return null;
      }

      state.active = false;
      clearInterval(state.timerInterval);
      bluetooth.stopAllSimulation?.();

      const feet   = joinedFeet();
      const byFoot = {};
      const mergedPointStats = {};
      const mergedTimeline   = [];

      for (const f of feet) {
        const fs = state.feet[f];
        const pointStats = {};
        for (const [pid, s] of Object.entries(fs.pointStats)) {
          pointStats[pid] = {
            avg:        s.count ? Math.round(s.sum / s.count) : 0,
            max:        s.max,
            alertCount: s.alertCount,
          };
        }
        byFoot[f] = {
          quality:      computeQuality(f),
          alertCount:   fs.alertCount,
          samples:      fs.totalSamples,
          joinedAt:     fs.joinedAt,
          hasImu:       fs.hasImu,
          pointStats,
          alertTimeline: fs.alertTimeline,
          rawCount:     fs.raw.length,
          rawTruncated: fs.rawTruncated,
          roll: fs.rollSamples
            ? { avgDev: Math.round(fs.rollDevSum / fs.rollSamples * 10) / 10,
                maxDev: Math.round(fs.rollDevMax * 10) / 10,
                ref:    Math.round(fs.rollRef * 10) / 10 }
            : null,
        };
        mergedTimeline.push(...fs.alertTimeline);

        // Legacy mirror: average the per-point figures across feet.
        for (const [pid, ps] of Object.entries(pointStats)) {
          if (!mergedPointStats[pid]) mergedPointStats[pid] = { avg: 0, max: 0, alertCount: 0, _n: 0 };
          mergedPointStats[pid].avg        += ps.avg;
          mergedPointStats[pid].max         = Math.max(mergedPointStats[pid].max, ps.max);
          mergedPointStats[pid].alertCount += ps.alertCount;
          mergedPointStats[pid]._n++;
        }
      }

      for (const ps of Object.values(mergedPointStats)) {
        ps.avg = ps._n ? Math.round(ps.avg / ps._n) : 0;
        delete ps._n;
      }
      mergedTimeline.sort((a, b) => a.time - b.time);

      const log = {
        schema:        3,
        sessionId:     state.sessionId,
        drillId:       state.drill.id,
        drillTitle:    state.drill.title,
        drillType:     state.drill.type,
        date:          new Date().toISOString().slice(0, 10),
        duration:      state.elapsed,
        memo:          state.memo,

        // Session-wide aggregates (v1-compatible)
        alertCount:    totalAlertCount(),
        quality:       overallQuality(),
        pointStats:    mergedPointStats,
        alertTimeline: mergedTimeline,

        // v2 per-foot breakdown
        feet,
        byFoot,

        // v3: optional post-session record + AI coach report, both
        // filled in after end() returns (the form is shown then).
        record: null,   // { energy, environment, note }
        report: null,   // { face, text, model, at, source }
      };

      /* v3.1: 원시 스트림. 집계값과 분리해서 담는다 — 용량 때문에
         저장이 거부되면 store가 이 블록만 떼고 세션은 살린다. */
      if (state.recordRaw) {
        const raw = { schema: RAW_SCHEMA, hz: 10, startedAt: state.startTime,
                      fields: ['t','fsr1','fsr2','fsr3','fsr4','roll','pitch','yaw'] };
        for (const f of feet) {
          const fs = state.feet[f];
          if (fs.raw.length) raw[f] = fs.raw;
        }
        if (feet.some(f => state.feet[f].raw.length)) log.raw = raw;
      }

      /* 저장이 거부되면 조용히 넘어가면 안 된다 — 실측 중에 세션이
         사라진 걸 나중에 알면 측정을 다시 해야 한다. */
      const saved = store.saveSession(log);
      if (saved && saved.ok === false) {
        log.saveFailed = true;
        console.error('[session] 세션 저장 실패 —', saved.reason);
        window.app?.showToast('⚠ 저장 공간 부족 — 세션이 저장되지 않았습니다. LOG에서 기존 기록을 내보낸 뒤 정리하세요.');
      } else if (saved && saved.droppedThisRaw) {
        window.app?.showToast('저장 공간이 부족해 원시 기록은 빼고 저장했습니다.');
      }
      onEnd?.(log);
      return log;
    },
  };
})();
