/* ─────────────────────────────────────────────────────────────
   Judgement logic — pure functions only.

   Nothing in here reads global state or touches the DOM. Every entry
   point takes the foot it is judging as an argument, so the same code
   runs twice per sample (once per foot) with no cross-talk. The gait
   checker is the one stateful piece and it is handed out as an
   instance, one per foot, created by session.js.
   ───────────────────────────────────────────────────────────── */
const alertEngine = (() => {

  /* ── Reference lookup ────────────────────────────────────────
     `reference` is { left, right } as of v2.0. Older drills are
     migrated by store.js, but tolerate a bare number here too so a
     stale in-memory drill object cannot throw mid-session.       */
  function getReference(point, foot) {
    const ref = point.reference;
    if (ref === null || ref === undefined) return null;
    if (typeof ref === 'number') return foot === FOOT.LEFT ? ref : null;
    return ref[foot] ?? null;
  }

  function hasReference(point, foot) {
    return getReference(point, foot) !== null;
  }

  /* ── Effective THR: 절대값 vs 기준값% ───────────────────────
     Percent mode needs a reference for THIS foot. When only one foot
     has been calibrated the other silently falls back to its absolute
     threshold instead of going unmonitored. */
  function getEffectiveThr(point, foot) {
    if (point.thrMode === 'percent') {
      const ref = getReference(point, foot);
      if (ref !== null) return Math.round(ref * (point.thrPercent / 100));
    }
    return point.thr;
  }

  /* ── Accuracy vs reference (null if this foot has no reference) ── */
  function calcAccuracy(points, currentValues, foot) {
    const refPoints = points.filter(p => hasReference(p, foot));
    if (!refPoints.length) return null;
    const avg = refPoints.reduce((sum, p) => {
      const idx = parseInt(p.id.slice(1)) - 1;
      const ref = getReference(p, foot);
      return sum + (currentValues[idx] / ref) * 100;
    }, 0) / refPoints.length;
    return Math.round(avg);
  }

  /* ── Main check: returns { alerts, accuracy } ───────────────
     Audio is orchestrated by session.js which has full context
     (gait errors + alerts + accuracy all in one place).          */
  function check(drill, values, foot) {
    const alerts = [];
    for (const pt of drill.points) {
      const idx = parseInt(pt.id.slice(1)) - 1;
      const val = values[idx];
      const thr = getEffectiveThr(pt, foot);
      if (pt.direction === 'positive' && val < thr) {
        alerts.push({ pointId: pt.id, type: 'positive', value: val, thr, foot });
      } else if (pt.direction === 'negative' && val > thr) {
        alerts.push({ pointId: pt.id, type: 'negative', value: val, thr, foot });
      }
    }
    const accuracy = calcAccuracy(drill.points, values, foot);
    return { alerts, accuracy };
  }

  /* ── Yaw deviation ─────────────────────────────────────────────
     Split out of session.js so it is testable and identical for both
     feet. Returns the normalised delta plus whether it breaches.

     Note both units run a 6-axis IMU (LSM6DS3TR-C) with no
     magnetometer, so yaw is gyro-integrated and drifts. The delta is
     always measured against a per-foot calibration captured by the
     user, never against an absolute heading. */
  function checkYaw(yaw, yawRef, tolerance) {
    if (yawRef === null || yawRef === undefined) return { delta: 0, exceeded: false };
    let delta = yaw - yawRef;
    if (delta > 180)  delta -= 360;
    if (delta < -180) delta += 360;
    delta = Math.round(delta * 10) / 10;
    return { delta, exceeded: Math.abs(delta) > tolerance };
  }

  /* ── Gait sequence checker factory ─────────────────────────────
     Stateful — call once per foot. Timing is wall-clock, so a foot
     streaming at a different rate is judged identically. */
  function createGaitChecker() {
    let phase           = 0;
    let phaseActiveTime = 0;
    const TIMEOUT       = 3000;

    return {
      check(values, now = Date.now()) {
        const isGroupActive = (group) =>
          group.some(pid => values[parseInt(pid.slice(1)) - 1] > GAIT_ACTIVE_THR);

        if (phase > 0 && (now - phaseActiveTime) > TIMEOUT) phase = 0;

        const currentGroup = GAIT_SEQUENCE[phase];
        if (isGroupActive(currentGroup)) {
          const futureActive = GAIT_SEQUENCE.slice(phase + 1).some(isGroupActive);
          if (futureActive) {
            phase = 0;
            return { gaitError: true };
          }
          if (phase < GAIT_SEQUENCE.length - 1) {
            phase++;
            phaseActiveTime = now;
          } else {
            phase = 0;
          }
        }
        return { gaitError: false };
      },
      reset() { phase = 0; },
    };
  }

  /* ── Left/right comparison ─────────────────────────────────────
     Pure helpers for the two comparison widgets. Both return null
     when a foot is missing, which is what the UI keys off to show
     the "양발 연결 필요" state rather than a misleading number. */

  /* Summed pressure across the drill's active points. */
  function totalPressure(drill, values) {
    if (!drill || !values) return 0;
    return drill.points.reduce((sum, pt) => {
      const idx = parseInt(pt.id.slice(1)) - 1;
      return sum + (values[idx] || 0);
    }, 0);
  }

  /* Weight distribution. Returns percentages that always sum to 100. */
  function balance(leftTotal, rightTotal) {
    if (leftTotal === null || rightTotal === null) return null;
    const sum = leftTotal + rightTotal;
    if (sum <= 0) return { left: 50, right: 50, sum: 0, even: true };
    const left = Math.round((leftTotal / sum) * 1000) / 10;
    return {
      left,
      right: Math.round((100 - left) * 10) / 10,
      sum,
      // Within 5 points of even is the band we call balanced.
      even: Math.abs(left - 50) <= 5,
    };
  }

  /* Roll symmetry. A symmetric stance gives mirrored roll, so the
     meaningful figure is left + right (≈0), not the difference. */
  function rollSymmetry(leftRoll, rightRoll) {
    if (leftRoll === null || rightRoll === null) return null;
    const sum = Math.round((leftRoll + rightRoll) * 10) / 10;
    return {
      left:  Math.round(leftRoll * 10) / 10,
      right: Math.round(rightRoll * 10) / 10,
      asymmetry: sum,
      symmetric: Math.abs(sum) <= 3,
    };
  }

  return {
    check,
    checkYaw,
    getEffectiveThr,
    getReference,
    hasReference,
    calcAccuracy,
    createGaitChecker,
    totalPressure,
    balance,
    rollSymmetry,
  };
})();
