const store = (() => {
  const K = {
    drills:   'onyxSDI_drills',
    sessions: 'onyxSDI_sessions',
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

    saveSession(s) {
      const list = this.getSessions();
      const idx  = list.findIndex(x => x.sessionId === s.sessionId);
      if (idx >= 0) list[idx] = s; else list.push(s);
      save(K.sessions, list);
    },

    deleteSession(id) {
      save(K.sessions, this.getSessions().filter(s => s.sessionId !== id));
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
