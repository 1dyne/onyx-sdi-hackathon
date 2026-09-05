const store = (() => {
  const K = {
    drills:   'onyxSDI_drills',
    sessions: 'onyxSDI_sessions',
    captures: 'onyxSDI_captures',
    settings: 'onyxSDI_settings',
  };

  const SETTINGS_DEFAULTS = {
    audioVolume:         0.5,
    alertSoundEnabled:   true,   // 경고음 (positive / negative / gait) 활성화
    successSoundEnabled: true,   // 성공음 활성화
    successThreshold:    90,     // 성공 판정 기준 정확도 (%)

    /* ── Two-foot additions ───────────────────────────────────
       Both units ship 10-bit values, so adcMax* stays at 1023.
       It is exposed only so a unit that turns up with a 12-bit
       ADC can be corrected on site without a firmware reflash. */
    adcMaxLeft:          MAX_SENSOR_VAL,
    adcMaxRight:         MAX_SENSOR_VAL,

    // Stereo panning is how left/right is told apart by ear without
    // doubling the number of alert sounds.
    audioStereo:         true,

    // Escape hatches for the device chooser (see bluetooth.js).
    bleAcceptAll:        false,
    bleCustomService:    '',

    // Per-foot roll sign, in case the two IMUs end up mounted
    // mirrored. Only affects the symmetry widget, never alerts.
    imuInvertRollLeft:   false,
    imuInvertRollRight:  false,

    /* ── AI 조교 ─────────────────────────────────────────────
       The key lives only in this browser's localStorage. It is never
       committed and never leaves the device except in the request to
       OpenAI itself. Empty key simply means the local rule-based
       report is used instead — the feature degrades, it never blocks. */
    // 10Hz 원시 스트림 기록. 끄면 집계값만 남는다.
    recordRaw:           true,

    coachEnabled:        true,
    coachApiKey:         '',
    coachModel:          'gpt-4o-mini',
  };

  /* Fill in any missing fields on a point object (migration-safe).

     v0.2 introduced reference/thrMode/thrPercent.
     v2.0 splits `reference` from a single number into { left, right }.
     A drill saved before v2.0 holds one calibration taken with one
     unit; it is kept as the LEFT reference rather than discarded, so
     existing drills stay usable and the user only has to re-calibrate
     the foot that has none. */
  function migratePoint(pt) {
    const base = Object.assign(
      { reference: null, thrMode: 'absolute', thrPercent: 80 },
      pt,
    );
    base.reference = normaliseReference(base.reference);
    return base;
  }

  function normaliseReference(ref) {
    if (ref === null || ref === undefined)  return { left: null, right: null };
    if (typeof ref === 'number')            return { left: ref, right: null };
    return { left: ref.left ?? null, right: ref.right ?? null };
  }

  function load(key)       { return JSON.parse(localStorage.getItem(key) || '[]'); }

  /* 브라우저마다 이름이 다르다. 이름 대신 코드/문구로도 본다. */
  function isQuotaError(err) {
    return err && (
      err.name === 'QuotaExceededError' ||
      err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      err.code === 22 || err.code === 1014 ||
      /quota/i.test(err.message || '')
    );
  }
  function save(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

  return {
    /* ── Drills ─────────────────────────────────────────── */
    /* ── Settings (global audio/success prefs) ──────────── */
    getSettings() {
      const saved = JSON.parse(localStorage.getItem(K.settings) || '{}');
      return Object.assign({}, SETTINGS_DEFAULTS, saved);
    },
    saveSettings(patch) {
      const merged = Object.assign(this.getSettings(), patch);
      localStorage.setItem(K.settings, JSON.stringify(merged));
    },

    /* ── Drills ─────────────────────────────────────────── */
    getDrills() {
      return load(K.drills).map(d => ({
        ...d,
        points: (d.points || []).map(migratePoint),
      }));
    },

    getDrill(id) { return this.getDrills().find(d => d.id === id) || null; },

    saveDrill(drill) {
      const list = this.getDrills();
      const idx  = list.findIndex(d => d.id === drill.id);
      if (idx >= 0) list[idx] = drill; else list.push(drill);
      save(K.drills, list);
    },

    deleteDrill(id) {
      save(K.drills, this.getDrills().filter(d => d.id !== id));
    },

    /* Save one point's reference for ONE foot, leaving the other
       foot's calibration untouched. Calibrating the left unit must
       never invalidate a right-foot reference taken earlier. */
    updateDrillPointRef(drillId, pid, refValue, foot = FOOT.LEFT) {
      const drills = load(K.drills).map(d => ({
        ...d,
        points: (d.points || []).map(migratePoint),
      }));
      const drill = drills.find(d => d.id === drillId);
      if (!drill) return;
      const pt = drill.points.find(p => p.id === pid);
      if (pt) {
        pt.reference = normaliseReference(pt.reference);
        pt.reference[foot] = refValue;
      }
      save(K.drills, drills);
    },

    /* Clear one foot's references across a whole drill. */
    clearDrillRefs(drillId, foot) {
      const drills = load(K.drills).map(d => ({
        ...d,
        points: (d.points || []).map(migratePoint),
      }));
      const drill = drills.find(d => d.id === drillId);
      if (!drill) return;
      drill.points.forEach(pt => {
        pt.reference = normaliseReference(pt.reference);
        pt.reference[foot] = null;
      });
      save(K.drills, drills);
    },

    newDrillId() { return 'drill_' + Date.now(); },

    /* ── Sessions ───────────────────────────────────────── */
    getSessions()          { return load(K.sessions); },
    getSession(id)         { return this.getSessions().find(s => s.sessionId === id) || null; },
    getSessionsByDrill(id) { return this.getSessions().filter(s => s.drillId === id); },

    /* 원시 스트림은 세션 하나로 1MB 가까이 나갈 수 있고 localStorage는
       5MB 언저리다. 용량 때문에 저장이 거부되면 세션 전체를 잃는 게
       아니라 원시 블록만 떼고 다시 시도한다 — 집계값과 리포트는
       무슨 일이 있어도 남아야 한다. 그래도 안 되면 오래된 세션의
       원시 블록부터 버린다. */
    saveSession(s) {
      const list = this.getSessions();
      const idx  = list.findIndex(x => x.sessionId === s.sessionId);
      if (idx >= 0) list[idx] = s; else list.push(s);

      try {
        save(K.sessions, list);
        return { ok: true };
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        console.warn('[store] 저장 공간 부족 — 오래된 원시 기록부터 정리합니다.');
      }

      // 1) 오래된 세션의 원시 블록을 앞에서부터 버린다.
      for (const old of list) {
        if (old.sessionId === s.sessionId || !old.raw) continue;
        delete old.raw;
        try { save(K.sessions, list); return { ok: true, droppedOldRaw: true }; }
        catch (err) { if (!isQuotaError(err)) throw err; }
      }

      // 2) 그래도 안 되면 이번 세션의 원시 블록을 포기한다.
      if (s.raw) {
        delete s.raw;
        try { save(K.sessions, list); return { ok: true, droppedThisRaw: true }; }
        catch (err) { if (!isQuotaError(err)) throw err; }
      }

      // 3) 최후 — 세션 자체가 안 들어간다. 호출부가 알아야 한다.
      return { ok: false, reason: 'quota' };
    },

    /* ── 백업 / 복원 ─────────────────────────────────────────
       기록이 이 브라우저의 localStorage에만 있다. 데이터를 지우거나
       폰을 바꾸면 그대로 사라지므로, 파일 하나로 빼고 되넣을 수
       있어야 한다. */
    exportAll() {
      return {
        format:   'onyx-sdi-backup',
        version:  typeof BUILD_VERSION === 'string' ? BUILD_VERSION : null,
        exportedAt: new Date().toISOString(),
        drills:   this.getDrills(),
        sessions: this.getSessions(),
        captures: this.getCaptures(),
        settings: (() => {
          // 키는 백업에 넣지 않는다. 파일이 카톡·메일로 돌아다닌다.
          const { coachApiKey, ...rest } = this.getSettings();
          return rest;
        })(),
      };
    },

    /* 기존 기록을 지우지 않고 합친다. 같은 id는 건너뛴다 —
       실수로 두 번 넣어도 중복이 생기지 않는다. */
    importAll(data, { replace = false } = {}) {
      if (!data || data.format !== 'onyx-sdi-backup') {
        throw new Error('Onyx SDI 백업 파일이 아닙니다.');
      }
      const out = { drills: 0, sessions: 0, captures: 0, skipped: 0 };

      if (replace) {
        save(K.drills, []);
        save(K.sessions, []);
        save(K.captures, []);
      }

      const drills = this.getDrills();
      for (const d of (data.drills || [])) {
        if (drills.some(x => x.id === d.id)) { out.skipped++; continue; }
        drills.push(d); out.drills++;
      }
      save(K.drills, drills);

      const sessions = this.getSessions();
      for (const s of (data.sessions || [])) {
        if (sessions.some(x => x.sessionId === s.sessionId)) { out.skipped++; continue; }
        sessions.push(s); out.sessions++;
      }
      sessions.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      try { save(K.sessions, sessions); }
      catch (err) {
        if (!isQuotaError(err)) throw err;
        throw new Error('저장 공간이 부족합니다. 기존 기록을 내보낸 뒤 정리하고 다시 시도하세요.');
      }

      const captures = this.getCaptures();
      for (const c of (data.captures || [])) {
        if (captures.some(x => x.captureId === c.captureId)) { out.skipped++; continue; }
        captures.push(c); out.captures++;
      }
      try { save(K.captures, captures); }
      catch (err) {
        if (!isQuotaError(err)) throw err;
        throw new Error('저장 공간이 부족합니다. 기존 캡처를 내보낸 뒤 정리하고 다시 시도하세요.');
      }

      if (data.settings) {
        const { coachApiKey, ...rest } = data.settings;
        this.saveSettings(rest);
      }
      return out;
    },

    deleteSession(id) {
      save(K.sessions, this.getSessions().filter(s => s.sessionId !== id));
    },

    /* ── 동작 캡처 ───────────────────────────────────────────
       세션과 따로 둔다. 캡처는 drill도 정확도도 리포트도 없어서
       세션 배열에 섞으면 LOG의 누적 통계와 조교 피드가 오염된다. */
    getCaptures()      { return load(K.captures); },
    getCapture(id)     { return this.getCaptures().find(c => c.captureId === id) || null; },

    /* 같은 라벨의 다음 테이크 번호. */
    nextTake(label) {
      const n = this.getCaptures().filter(c => c.label === label).length;
      return n + 1;
    },

    saveCapture(c) {
      const list = this.getCaptures();
      const idx  = list.findIndex(x => x.captureId === c.captureId);
      if (idx >= 0) list[idx] = c; else list.push(c);
      try {
        save(K.captures, list);
        return { ok: true };
      } catch (err) {
        if (!isQuotaError(err)) throw err;
        return { ok: false, reason: 'quota' };
      }
    },

    deleteCapture(id) {
      save(K.captures, this.getCaptures().filter(c => c.captureId !== id));
    },

    newCaptureId() {
      const d  = new Date();
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      return `c_${ds}_${Date.now().toString().slice(-5)}`;
    },

    /* 대략적인 사용량. localStorage에 정확한 잔량 API가 없어서
       저장된 문자열 길이로 어림한다 — 현장에서 "얼마나 남았나"를
       판단하는 용도로는 충분하다. */
    storageUsage() {
      let bytes = 0;
      for (const k of Object.values(K)) {
        bytes += (localStorage.getItem(k) || '').length;
      }
      return { bytes, kb: Math.round(bytes / 1024), mb: Math.round(bytes / 1024 / 102.4) / 10 };
    },

    newSessionId() {
      const d  = new Date();
      const ds = d.toISOString().slice(0, 10).replace(/-/g, '');
      return `s_${ds}_${Date.now().toString().slice(-5)}`;
    },

    /* ── Cumulative stats ───────────────────────────────── */
    cumulativeStats() {
      const sessions = this.getSessions();
      if (!sessions.length) return { totalSessions: 0, totalDuration: 0, avgQuality: 0 };
      const totalDuration = sessions.reduce((a, s) => a + (s.duration || 0), 0);
      const avgQuality    = Math.round(sessions.reduce((a, s) => a + (s.quality || 0), 0) / sessions.length);
      return { totalSessions: sessions.length, totalDuration, avgQuality };
    },
  };
})();
