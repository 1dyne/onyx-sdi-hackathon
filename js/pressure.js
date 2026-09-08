/* Pressure processing shared by capture UI and post-capture analysis. */
const pressureEngine = (() => {
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));

  function median(values) {
    if (!values.length) return 0;
    const a = values.slice().sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function baselineFromSamples(samples) {
    return [0,1,2,3].map(ch => Math.round(median(samples.map(v => v[ch] ?? 0))));
  }

  function deltaValues(values, baseline) {
    return [0,1,2,3].map(ch => Math.max(0, (values?.[ch] ?? 0) - (baseline?.[ch] ?? 0)));
  }

  /* Fixed bands make the same pressure change the same colour over time.
     Zero remains neutral; blue means the sensor is actually active. */
  function heatLevel(delta) {
    if (delta <= 8) return 0;
    if (delta < 80) return 1;
    if (delta < 180) return 2;
    if (delta < 320) return 3;
    if (delta < 520) return 4;
    return 5;
  }

  function pointLoads(values, baseline, channels) {
    const delta = deltaValues(values, baseline);
    return (channels || DEFAULT_CAPTURE_CHANNELS).map((pid, ch) => ({
      pid, channel: ch, delta: delta[ch], point: PRESSURE_POINTS[pid],
    })).filter(x => x.point);
  }

  function balance(feet, channels) {
    const loads = {};
    FOOT_IDS.forEach(f => {
      const pts = pointLoads(feet[f]?.values, feet[f]?.baseline, channels);
      const total = pts.reduce((s, p) => s + p.delta, 0);
      const fore = pts.filter(p => p.point.svgY < 155).reduce((s,p) => s+p.delta, 0);
      const rear = pts.filter(p => p.point.svgY > 280).reduce((s,p) => s+p.delta, 0);
      const weighted = pts.reduce((a,p) => ({
        x: a.x + p.point.svgX * p.delta,
        y: a.y + p.point.svgY * p.delta,
      }), {x:0,y:0});
      loads[f] = {
        total, fore, rear,
        cop: total ? { x: weighted.x / total, y: weighted.y / total } : null,
      };
    });
    const sum = loads.left.total + loads.right.total;
    const leftPct = sum ? Math.round(loads.left.total / sum * 100) : 50;
    const frSum = loads.left.fore + loads.right.fore + loads.left.rear + loads.right.rear;
    const forePct = frSum ? Math.round((loads.left.fore + loads.right.fore) / frSum * 100) : 50;
    return { feet: loads, leftPct, rightPct:100-leftPct, forePct, rearPct:100-forePct };
  }

  function heelChannel(channels) {
    let best = -1, bestY = -Infinity;
    (channels || []).forEach((pid, ch) => {
      const y = PRESSURE_POINTS[pid]?.svgY ?? -Infinity;
      if (y > bestY) { bestY = y; best = ch; }
    });
    return best;
  }

  function detectSteps(samples, channels, baseline) {
    if (!Array.isArray(samples) || samples.length < 3) return [];
    const ch = heelChannel(channels);
    if (ch < 0) return [];
    const series = samples.map(s => Math.max(0, (s[ch + 1] ?? 0) - (baseline?.[ch] ?? 0)));
    const peak = Math.max(...series, 0);
    const high = Math.max(35, peak * 0.28);
    const low = high * 0.55;
    const strikes = [];
    let armed = true;
    for (let i = 0; i < samples.length; i++) {
      const v = series[i];
      if (armed && v >= high) {
        const t = samples[i][0];
        if (!strikes.length || t - strikes[strikes.length - 1].t >= 300) strikes.push({t, index:i});
        armed = false;
      } else if (!armed && v <= low) armed = true;
    }
    return strikes.slice(0, -1).map((s, i) => ({
      start:s.t, end:strikes[i+1].t, duration:strikes[i+1].t-s.t,
      startIndex:s.index, endIndex:strikes[i+1].index,
    }));
  }

  function normalizedOverlay(samples, steps, baseline, bins = 50) {
    return steps.map(step => {
      const seg = samples.slice(step.startIndex, step.endIndex + 1);
      return Array.from({length:bins}, (_, b) => {
        const i = Math.min(seg.length - 1, Math.round(b * (seg.length - 1) / (bins - 1)));
        return deltaValues(seg[i]?.slice(1,5), baseline).reduce((a,v) => a+v, 0);
      });
    });
  }

  function analyzeCapture(cap) {
    const channels = cap.channels || LEGACY_CAPTURE_CHANNELS;
    const out = { method:'heel-rising-edge-v1', feet:{} };
    (cap.feet || FOOT_IDS).forEach(f => {
      const samples = cap[f] || [];
      const base = cap.baseline?.[f] || [0,0,0,0];
      const steps = detectSteps(samples, channels, base);
      out.feet[f] = {
        steps,
        count:steps.length,
        cadence: cap.duration > 0 ? Math.round(steps.length / cap.duration * 60) : 0,
        overlay:normalizedOverlay(samples, steps, base),
      };
    });
    return out;
  }

  return { median, baselineFromSamples, deltaValues, heatLevel, pointLoads, balance, detectSteps, normalizedOverlay, analyzeCapture };
})();

if (typeof module !== 'undefined') module.exports = pressureEngine;
