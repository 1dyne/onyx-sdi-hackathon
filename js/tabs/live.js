/* ─────────────────────────────────────────────────────────────
   LIVE tab — two feet, side by side.

   Single-foot operation is the primary case, not a degraded one: a
   foot that is not connected renders as an explicitly dimmed column
   and everything else (gauges, alerts, quality, session log) behaves
   exactly as it did before v2.0. Only the two comparison widgets,
   which are meaningless with one foot, switch off.

   All incoming samples are coalesced through requestAnimationFrame.
   Two units at 10 Hz would otherwise fire ~20 DOM update bursts per
   second; this caps repaints at one per frame regardless of how fast
   the units stream.
   ───────────────────────────────────────────────────────────── */
const liveTab = (() => {
  let panel = null;

  // Latest sample per foot, consumed by the rAF flush.
  const latest = {
    left:  { values: null, alerts: [], accuracy: null },
    right: { values: null, alerts: [], accuracy: null },
  };
  const dirty = { left: false, right: false };
  let rafId   = null;
  let mode    = 'idle';      // idle | ready | active | capture
  let currentDrill = null;

  /* ── SVG foot builder ───────────────────────────────────────
     The pressure-point coordinates in constants.js describe a LEFT
     foot in plantar view. The right foot is the same geometry
     mirrored about the viewBox centre, so P2 (엄지 뿌리) still lands
     on the medial side. Only the shapes are mirrored — the ID labels
     are drawn afterwards at mirrored coordinates so text stays
     readable instead of being flipped with the path. */
  function buildFootSVG(opts = {}) {
    const { configMode = false, small = false, foot = FOOT.LEFT } = opts;
    const mirror = foot === FOOT.RIGHT;
    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 200 400');
    svg.setAttribute('xmlns', ns);
    svg.classList.add('foot-svg');
    svg.dataset.foot = foot;
    if (small)      svg.classList.add('small');
    if (configMode) svg.classList.add('config-mode');

    // Everything geometric goes in here so one transform mirrors it all.
    const shapes = document.createElementNS(ns, 'g');
    if (mirror) shapes.setAttribute('transform', 'translate(200,0) scale(-1,1)');

    // ── Body path ─────────────────────────────────────────
    // Left foot, plantar view (sole facing viewer), toes up.
    // Inner (medial) side = right of screen, outer (lateral) = left.
    // Path runs clockwise: across toe-row base → outer border → heel → inner border → back.
    const body = document.createElementNS(ns, 'path');
    body.setAttribute('class', 'foot-body');
    body.setAttribute('d', [
      'M 68 68',                          // outer end of toe-row base (little-toe side)
      'C 54 82 48 104 48 128',            // outer ball / 5th metatarsal
      'C 48 152 44 178 44 206',           // outer arch — concave inward
      'C 44 234 46 262 52 290',           // outer mid to heel
      'C 56 314 62 336 74 356',           // outer heel
      'C 86 372 102 382 118 380',         // heel bottom curve
      'C 134 378 148 366 154 350',        // inner heel
      'C 160 332 162 310 162 286',        // inner mid
      'C 162 260 160 234 158 210',        // inner arch — nearly vertical (medial arch)
      'C 156 186 158 162 160 138',        // inner forefoot
      'C 162 116 160 96 156 80',          // inner ball / 1st metatarsal
      'C 153 70 152 66 152 66',           // inner end of toe-row base (big-toe side)
      'C 136 66 118 66 100 66',           // across toe-row base (inner → center)
      'C 84 66 76 66 68 68',             // across toe-row base (center → outer)
      'Z',
    ].join(' '));
    shapes.appendChild(body);

    // ── Toes (ellipses, protrude above y≈66) ─────────────
    const toes = [
      { cx:152, cy:46, rx:14, ry:22 }, // T1 big toe   → P1 tip at ~cy-ry = 24
      { cx:132, cy:38, rx:11, ry:17 }, // T2 2nd toe
      { cx:113, cy:36, rx:10, ry:15 }, // T3 3rd toe
      { cx:94,  cy:38, rx: 9, ry:13 }, // T4 4th toe
      { cx:76,  cy:48, rx: 8, ry:12 }, // T5 little toe → sits lower, at outer side
    ];
    toes.forEach(t => {
      const el = document.createElementNS(ns, 'ellipse');
      el.setAttribute('class', 'foot-toe');
      el.setAttribute('cx', t.cx);
      el.setAttribute('cy', t.cy);
      el.setAttribute('rx', t.rx);
      el.setAttribute('ry', t.ry);
      shapes.appendChild(el);
    });

    // ── Pressure point dots ──────────────────────────────
    // IDs are namespaced by foot: two silhouettes are on screen at
    // once, so a bare "P1" would be a duplicate element id.
    POINT_IDS.forEach(pid => {
      const pt  = PRESSURE_POINTS[pid];
      const dot = document.createElementNS(ns, 'circle');
      if (!configMode) dot.setAttribute('id', `${foot}-${pid}`);
      dot.setAttribute('class', 'pp-dot');
      dot.setAttribute('data-id', pid);
      dot.setAttribute('data-state', 'inactive');
      dot.setAttribute('cx', pt.svgX);
      dot.setAttribute('cy', pt.svgY);
      dot.setAttribute('r', configMode ? PP_DOT_R_CONFIG : PP_DOT_R);
      if (configMode) dot.setAttribute('data-selected', 'false');
      shapes.appendChild(dot);
    });

    /* Config mode gets an invisible, larger concentric target on top of
       every dot. The visible circle has to stay small enough that the
       three heel points do not run into each other, but a finger needs
       more than that — especially with both feet on one phone screen.
       Appended as a layer after all the dots so hit-testing order is
       uniform rather than depending on point order. */
    if (configMode) {
      POINT_IDS.forEach(pid => {
        const pt  = PRESSURE_POINTS[pid];
        const hit = document.createElementNS(ns, 'circle');
        hit.setAttribute('class', 'pp-hit');
        hit.setAttribute('data-id', pid);
        hit.setAttribute('cx', pt.svgX);
        hit.setAttribute('cy', pt.svgY);
        hit.setAttribute('r', PP_HIT_R);
        shapes.appendChild(hit);
      });
    }

    svg.appendChild(shapes);

    // ── Labels, drawn unmirrored on top ──────────────────
    const labels = document.createElementNS(ns, 'g');
    labels.setAttribute('class', 'pp-group');
    POINT_IDS.forEach(pid => {
      const pt  = PRESSURE_POINTS[pid];
      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('class', 'pp-id-text');
      txt.setAttribute('x', mirror ? 200 - pt.svgX : pt.svgX);
      txt.setAttribute('y', pt.svgY);
      txt.textContent = pid;
      labels.appendChild(txt);
    });
    svg.appendChild(labels);

    return svg;
  }

  /* ── Paired gauge builder ───────────────────────────────────
     One row per pressure point holding both feet, so left/right for
     the same point are read against each other without scrolling. */
  function buildPairedGauge(pt) {
    const row = document.createElement('div');
    row.className   = 'gauge-pair';
    row.dataset.pid = pt.id;

    const label = document.createElement('span');
    label.className   = 'gauge-label';
    label.textContent = pt.id;
    label.title       = `${pt.name} — ${pt.label}`;
    row.appendChild(label);

    const stack = document.createElement('div');
    stack.className = 'gauge-stack';

    FOOT_IDS.forEach(foot => {
      const line = document.createElement('div');
      line.className    = 'gauge-line';
      line.dataset.foot = foot;

      const side = document.createElement('span');
      side.className   = 'gauge-side';
      side.textContent = foot === FOOT.LEFT ? 'L' : 'R';

      const track = document.createElement('div');
      track.className = 'gauge-track';

      const fill = document.createElement('div');
      fill.className = 'gauge-fill';

      const thrMarker = document.createElement('div');   // white dashed: effective THR
      thrMarker.className = 'gauge-thr';
      thrMarker.style.left = '0%';

      const refMarker = document.createElement('div');   // amber dashed: reference
      refMarker.className = 'gauge-ref';
      refMarker.style.display = 'none';

      track.appendChild(fill);
      track.appendChild(thrMarker);
      track.appendChild(refMarker);

      const val = document.createElement('span');
      val.className   = 'gauge-val mono';
      val.textContent = '---';

      line.appendChild(side);
      line.appendChild(track);
      line.appendChild(val);
      stack.appendChild(line);
    });

    row.appendChild(stack);
    return row;
  }

  /* ── Connection card (idle + ready screens) ─────────────────
     The explicit 왼발/오른발 buttons. Naming the side on the button
     is the whole assignment mechanism — nothing inspects the device
     name, because firmware naming is not settled. */
  function buildConnectCard() {
    const card = document.createElement('div');
    card.className = 'card connect-card';
    card.id = 'connect-card';

    const hdr = document.createElement('div');
    hdr.className   = 'section-heading';
    hdr.textContent = '유닛 연결';
    card.appendChild(hdr);

    const grid = document.createElement('div');
    grid.className = 'connect-grid';

    FOOT_IDS.forEach(foot => {
      const btn = document.createElement('button');
      btn.className     = 'btn connect-btn';
      btn.dataset.foot  = foot;
      btn.onclick       = () => app.toggleFoot(foot);

      const side = document.createElement('span');
      side.className   = 'connect-side';
      side.textContent = FOOT_LABEL_KO[foot];

      const state = document.createElement('span');
      state.className = 'connect-state';

      btn.appendChild(side);
      btn.appendChild(state);
      grid.appendChild(btn);
    });

    card.appendChild(grid);

    const hint = document.createElement('div');
    hint.className = 'connect-hint';
    hint.id        = 'connect-hint';
    card.appendChild(hint);

    return card;
  }

  /* Repaints the connection card in place; safe to call any time. */
  function refreshConnectCard() {
    const card = document.getElementById('connect-card');
    if (!card) return;

    card.querySelectorAll('.connect-btn').forEach(btn => {
      const foot  = btn.dataset.foot;
      const link  = bluetooth.foot(foot);
      const state = btn.querySelector('.connect-state');

      const busy   = ['scanning', 'connecting', 'reconnecting'].includes(link.status);
      // A GATT link with no stream is not a connection as far as the
      // operator is concerned — never paint it green.
      const noData = link.status === 'no-data';
      btn.classList.toggle('connected', link.isConnected() && !noData);
      btn.classList.toggle('nodata',    noData);
      btn.classList.toggle('sim',       link.isSimulating());
      btn.classList.toggle('busy',      busy);

      if (noData)                    state.textContent = '데이터 없음';
      else if (link.isConnected())   state.textContent = link.deviceName || '연결됨';
      else if (link.isSimulating())  state.textContent = 'DEMO';
      else if (link.status === 'reconnecting') state.textContent = '재연결 중…';
      else if (link.status === 'scanning')     state.textContent = '검색 중…';
      else if (link.status === 'connecting')   state.textContent = '연결 중…';
      else if (link.status === 'unsupported')  state.textContent = 'BLE 미지원';
      else                                     state.textContent = '연결 안 됨';
    });

    const hint = document.getElementById('connect-hint');
    if (hint) {
      const n = bluetooth.liveFeet().length;
      hint.textContent = n === 0
        ? '한쪽만 연결해도 모든 기능이 동작합니다.'
        : n === 1
          ? `${FOOT_LABEL_KO[bluetooth.liveFeet()[0]]}만 연결됨 — 좌우 비교 위젯은 비활성화됩니다.`
          : '양발 연결됨 — 좌우 비교 위젯 사용 가능.';
      hint.className = 'connect-hint' + (n === 2 ? ' ok' : '');
    }
  }

  /* ── Render idle state ──────────────────────────────────── */
  function renderIdle() {
    mode = 'idle';
    currentDrill = null;
    panel.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const title = document.createElement('span');
    title.className   = 'session-title';
    title.textContent = '훈련을 선택하세요';
    hdr.appendChild(title);
    panel.appendChild(hdr);

    panel.appendChild(buildConnectCard());

    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = 'TRAINING 탭에서<br>동작을 선택해 시작하세요.';
    panel.appendChild(empty);

    // ── FREE CAPTURE section ───────────────────────────────
    const divider = document.createElement('div');
    divider.className = 'divider';
    panel.appendChild(divider);

    const capSection = document.createElement('div');
    capSection.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    const capHdr = document.createElement('div');
    capHdr.className   = 'section-heading';
    capHdr.textContent = 'FREE CAPTURE';
    capSection.appendChild(capHdr);

    const capHint = document.createElement('div');
    capHint.style.cssText = 'font-size:12px;color:var(--text-dim);line-height:1.5;';
    capHint.textContent = '동작을 먼저 수행하고 캡처하여 훈련으로 등록합니다.';
    capSection.appendChild(capHint);

    const btnCap = document.createElement('button');
    btnCap.className = 'btn btn-ghost';
    btnCap.style.cssText = 'width:100%;margin-top:var(--gap-xs);';
    btnCap.textContent = '📸  FREE CAPTURE 시작';
    btnCap.onclick = () => renderFreeCapture();
    capSection.appendChild(btnCap);

    /* 동작 캡처 — FREE CAPTURE가 한 순간을 집는다면 이쪽은 구간을
       통째로 남긴다. 기준이 아직 없을 때 재료부터 모으는 경로다. */
    const btnMotion = document.createElement('button');
    btnMotion.className   = 'btn btn-ghost';
    btnMotion.style.marginTop = 'var(--gap-xs)';
    btnMotion.textContent = '🎬  동작 캡처 (연속 기록)';
    btnMotion.onclick = () => { bindSessionCallbacks(); renderCapture(); };
    capSection.appendChild(btnMotion);

    panel.appendChild(capSection);
    refreshConnectCard();
  }

  /* ── Foot column (silhouette + per-foot status) ─────────── */
  function buildFootColumn(foot, activeIds) {
    const col = document.createElement('div');
    col.className   = 'foot-col';
    col.id          = `foot-col-${foot}`;
    col.dataset.foot = foot;

    const head = document.createElement('div');
    head.className = 'foot-col-head';

    const lbl = document.createElement('span');
    lbl.className   = 'foot-label';
    lbl.textContent = FOOT_LABEL[foot];

    const badge = document.createElement('span');
    badge.className = 'foot-conn-badge';
    badge.id        = `foot-badge-${foot}`;

    head.appendChild(lbl);
    head.appendChild(badge);
    col.appendChild(head);

    const svg = buildFootSVG({ foot });
    svg.id = `live-svg-${foot}`;
    if (activeIds) {
      svg.querySelectorAll('.pp-dot').forEach(dot => {
        dot.dataset.state = activeIds.has(dot.dataset.id) ? 'ok' : 'inactive';
      });
    }
    col.appendChild(svg);

    // Per-foot quality readout under the silhouette.
    const q = document.createElement('div');
    q.className = 'foot-quality';
    q.id        = `foot-quality-${foot}`;
    q.textContent = '—';
    col.appendChild(q);

    return col;
  }

  function refreshFootBadges() {
    FOOT_IDS.forEach(foot => {
      const col   = document.getElementById(`foot-col-${foot}`);
      const badge = document.getElementById(`foot-badge-${foot}`);
      if (!col || !badge) return;

      const link = bluetooth.foot(foot);
      const live = link.isLive();

      // The dimmed state is the explicit "this foot is not part of the
      // session" signal, so an unconnected unit is never mistaken for
      // a connected one reading zero.
      col.classList.toggle('inactive', !live);

      if (link.status === 'no-data')           { badge.textContent = '데이터 없음'; badge.className = 'foot-conn-badge warn'; }
      else if (link.isConnected())             { badge.textContent = '연결됨';   badge.className = 'foot-conn-badge ok'; }
      else if (link.isSimulating())            { badge.textContent = 'DEMO';    badge.className = 'foot-conn-badge sim'; }
      else if (link.status === 'reconnecting') { badge.textContent = '재연결…'; badge.className = 'foot-conn-badge warn'; }
      else                                     { badge.textContent = '미연결';   badge.className = 'foot-conn-badge off'; }
    });
  }

  /* ── Comparison widgets ─────────────────────────────────────
     Both require two live feet by definition. With one foot they show
     an explicit "양발 연결 필요" state rather than a number that would
     read as real data. */
  function buildComparisonCard() {
    const card = document.createElement('div');
    card.className = 'card compare-card';
    card.id = 'compare-card';

    const hdr = document.createElement('div');
    hdr.className   = 'section-heading';
    hdr.textContent = '좌우 비교';
    card.appendChild(hdr);

    // Weight distribution
    const balWrap = document.createElement('div');
    balWrap.className = 'compare-block';

    const balHead = document.createElement('div');
    balHead.className = 'compare-head';
    balHead.innerHTML = '<span>체중 배분</span><span class="compare-val" id="cmp-balance-val">—</span>';
    balWrap.appendChild(balHead);

    const balBar = document.createElement('div');
    balBar.className = 'balance-bar';
    balBar.id = 'cmp-balance-bar';
    const balL = document.createElement('div');
    balL.className = 'balance-left';
    balL.id = 'cmp-balance-left';
    const balMid = document.createElement('div');
    balMid.className = 'balance-mid';   // 50% reference tick
    balBar.appendChild(balL);
    balBar.appendChild(balMid);
    balWrap.appendChild(balBar);
    card.appendChild(balWrap);

    // Roll symmetry
    const rollWrap = document.createElement('div');
    rollWrap.className = 'compare-block';

    const rollHead = document.createElement('div');
    rollHead.className = 'compare-head';
    rollHead.innerHTML = '<span>발 기울기 대칭</span><span class="compare-val" id="cmp-roll-val">—</span>';
    rollWrap.appendChild(rollHead);

    const rollDetail = document.createElement('div');
    rollDetail.className = 'compare-detail';
    rollDetail.id = 'cmp-roll-detail';
    rollDetail.textContent = '—';
    rollWrap.appendChild(rollDetail);
    card.appendChild(rollWrap);

    const note = document.createElement('div');
    note.className = 'compare-note';
    note.id = 'cmp-note';
    card.appendChild(note);

    return card;
  }

  function updateComparison() {
    const card = document.getElementById('compare-card');
    if (!card) return;

    const bothLive = FOOT_IDS.every(f => bluetooth.foot(f).isLive() && latest[f].values);
    card.classList.toggle('disabled', !bothLive);

    const balVal   = document.getElementById('cmp-balance-val');
    const balLeft  = document.getElementById('cmp-balance-left');
    const rollVal  = document.getElementById('cmp-roll-val');
    const rollDet  = document.getElementById('cmp-roll-detail');
    const note     = document.getElementById('cmp-note');

    if (!bothLive) {
      if (balVal)  { balVal.textContent = '—'; balVal.className = 'compare-val'; }
      if (balLeft)   balLeft.style.width = '50%';
      if (rollVal) { rollVal.textContent = '—'; rollVal.className = 'compare-val'; }
      if (rollDet)   rollDet.textContent = '—';
      if (note)      note.textContent = '양발 연결 시 사용 가능합니다.';
      return;
    }
    if (note) note.textContent = '';

    // ── Weight distribution ──
    const drill = currentDrill;
    const lTot  = alertEngine.totalPressure(drill, latest.left.values);
    const rTot  = alertEngine.totalPressure(drill, latest.right.values);
    const bal   = alertEngine.balance(lTot, rTot);

    if (bal && balVal && balLeft) {
      balVal.textContent = `L ${bal.left}%  ·  R ${bal.right}%`;
      balVal.className   = 'compare-val' + (bal.even ? ' ok' : ' warn');
      balLeft.style.width = `${bal.left}%`;
    }

    // ── Roll symmetry ──
    const s = store.getSettings();
    const lHasImu = session.hasImu(FOOT.LEFT);
    const rHasImu = session.hasImu(FOOT.RIGHT);

    if (!lHasImu || !rHasImu) {
      if (rollVal) { rollVal.textContent = 'IMU 없음'; rollVal.className = 'compare-val'; }
      if (rollDet)   rollDet.textContent = 'IMU 데이터가 없는 유닛이 있습니다.';
    } else {
      const lRoll = (latest.left.values[4]  ?? 0) * (s.imuInvertRollLeft  ? -1 : 1);
      const rRoll = (latest.right.values[4] ?? 0) * (s.imuInvertRollRight ? -1 : 1);
      const sym   = alertEngine.rollSymmetry(lRoll, rRoll);
      if (sym && rollVal && rollDet) {
        rollVal.textContent = `${sym.asymmetry >= 0 ? '+' : ''}${sym.asymmetry}°`;
        rollVal.className   = 'compare-val' + (sym.symmetric ? ' ok' : ' warn');
        rollDet.textContent = `L ${sym.left >= 0 ? '+' : ''}${sym.left}°   R ${sym.right >= 0 ? '+' : ''}${sym.right}°`;
      }
    }
  }

  /* ── Per-foot IMU strip ─────────────────────────────────── */
  function buildImuStrip(drill) {
    const card = document.createElement('div');
    card.className = 'card imu-strip';
    card.id = 'imu-strip';

    FOOT_IDS.forEach(foot => {
      const row = document.createElement('div');
      row.className = 'imu-row';
      row.id        = `imu-row-${foot}`;

      const side = document.createElement('span');
      side.className   = 'imu-side';
      side.textContent = foot === FOOT.LEFT ? 'L' : 'R';

      const icon = document.createElement('span');
      icon.className = 'imu-icon';
      icon.id        = `imu-icon-${foot}`;
      icon.textContent = '🦶';

      const val = document.createElement('span');
      val.className = 'imu-val mono';
      val.id        = `imu-val-${foot}`;
      val.textContent = '—';

      const age = document.createElement('span');
      age.className = 'imu-age';
      age.id        = `imu-age-${foot}`;

      const btn = document.createElement('button');
      btn.className = 'btn btn-ghost imu-cal';
      btn.textContent = '⊕ CAL';
      btn.title = `${FOOT_LABEL_KO[foot]} 현재 방향을 기준 0°로 설정`;
      btn.onclick = () => {
        session.calibrateYaw(foot);
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '⊕ CAL'; }, 1200);
      };

      row.appendChild(side);
      row.appendChild(icon);
      row.appendChild(val);
      row.appendChild(age);
      row.appendChild(btn);
      card.appendChild(row);
    });

    const tol = document.createElement('div');
    tol.className   = 'imu-tol';
    tol.textContent = `YAW 허용 ±${drill?.yawTolerance ?? 10}°  ·  6축 IMU라 시간이 지나면 드리프트합니다`;
    card.appendChild(tol);

    return card;
  }

  function updateImu(foot) {
    const valEl = document.getElementById(`imu-val-${foot}`);
    const icon  = document.getElementById(`imu-icon-${foot}`);
    const ageEl = document.getElementById(`imu-age-${foot}`);
    const row   = document.getElementById(`imu-row-${foot}`);
    if (!valEl || !icon || !row) return;

    if (!bluetooth.foot(foot).isLive()) {
      row.classList.add('inactive');
      valEl.textContent = '—';
      if (ageEl) ageEl.textContent = '';
      return;
    }
    row.classList.remove('inactive');

    if (!session.hasImu(foot)) {
      valEl.textContent = 'IMU 없음';
      valEl.className   = 'imu-val mono dim';
      if (ageEl) ageEl.textContent = '';
      return;
    }

    const ref = session.yawRef(foot);
    if (ref === null) { valEl.textContent = '—'; return; }

    const imu = session.currentImu(foot);
    const { delta } = alertEngine.checkYaw(imu.yaw, ref, currentDrill?.yawTolerance ?? 10);
    const hasImuAlert = latest[foot].alerts.some(a => a.type === 'imu');

    icon.style.transform = `rotate(${delta}deg)`;
    valEl.textContent    = (delta >= 0 ? '+' : '') + delta + '°';
    valEl.className      = 'imu-val mono' + (hasImuAlert ? ' alert' : ' ok');

    // Drift hint: the longer since calibration, the less yaw means.
    if (ageEl) {
      const age = session.yawAge(foot);
      if (age === null) { ageEl.textContent = ''; }
      else {
        const m = Math.floor(age / 60);
        ageEl.textContent = m >= 1 ? `${m}분 경과` : `${age}초`;
        ageEl.className   = 'imu-age' + (age > 180 ? ' warn' : '');
      }
    }
  }

  /* ── Render active session ──────────────────────────────── */
  function renderActive(drill) {
    mode = 'active';
    currentDrill = drill;
    panel.innerHTML = '';
    latest.left  = { values: null, alerts: [], accuracy: null };
    latest.right = { values: null, alerts: [], accuracy: null };

    // ── Session header ───────────────────────────────────
    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const titleEl = document.createElement('span');
    titleEl.className   = 'session-title active';
    titleEl.id          = 'live-title';
    titleEl.textContent = drill.title;
    const badgeEl = document.createElement('span');
    badgeEl.className   = `badge badge-${drill.type}`;
    badgeEl.textContent = DRILL_TYPES[drill.type].label;
    hdr.appendChild(titleEl);
    hdr.appendChild(badgeEl);
    panel.appendChild(hdr);

    // ── Stats ────────────────────────────────────────────
    const stats = document.createElement('div');
    stats.className = 'live-stats';
    [
      ['TIME',   'live-timer',   '00:00'],
      ['ALERTS', 'live-alerts',  '0'],
      ['QUALITY','live-quality', '—'],
    ].forEach(([label, id, init]) => {
      const blk = document.createElement('div');
      blk.className = 'stat-block';
      const lbl = document.createElement('span');
      lbl.className   = 'stat-label';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className   = 'stat-value';
      val.id          = id;
      val.textContent = init;
      blk.appendChild(lbl);
      blk.appendChild(val);
      stats.appendChild(blk);
    });
    panel.appendChild(stats);

    // ── No-unit warning (only when NEITHER foot is live) ──
    const btWarn = document.createElement('div');
    btWarn.id        = 'bt-warn';
    btWarn.className = 'alert-banner visible negative';
    btWarn.textContent = '연결된 유닛이 없습니다 — 헤더의 L / R 버튼으로 연결하세요';
    panel.appendChild(btWarn);

    // ── Alert banner ─────────────────────────────────────
    const banner = document.createElement('div');
    banner.className = 'alert-banner';
    banner.id        = 'live-banner';
    panel.appendChild(banner);

    // ── Two foot columns ─────────────────────────────────
    const activeIds = new Set(drill.points.map(p => p.id));
    const feetRow = document.createElement('div');
    feetRow.className = 'feet-row';
    FOOT_IDS.forEach(foot => feetRow.appendChild(buildFootColumn(foot, activeIds)));
    panel.appendChild(feetRow);

    // ── Paired gauges ────────────────────────────────────
    const gauges = document.createElement('div');
    gauges.className = 'live-gauges paired';
    gauges.id        = 'live-gauges';
    drill.points.forEach(pt => gauges.appendChild(buildPairedGauge(PRESSURE_POINTS[pt.id])));
    panel.appendChild(gauges);

    // ── Comparison + IMU ─────────────────────────────────
    panel.appendChild(buildComparisonCard());
    panel.appendChild(buildImuStrip(drill));

    // ── Ref-saved info banner ────────────────────────────
    const refBanner = document.createElement('div');
    refBanner.id        = 'ref-banner';
    refBanner.className = 'ref-banner';
    panel.appendChild(refBanner);

    // ── Actions ──────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'live-actions';

    const btnEnd = document.createElement('button');
    btnEnd.className   = 'btn btn-primary';
    btnEnd.textContent = 'END SESSION';
    btnEnd.onclick = () => {
      const log = session.end();
      if (log) renderWrapUp(log);
    };

    const btnMemo = document.createElement('button');
    btnMemo.className   = 'btn btn-ghost';
    btnMemo.textContent = '+ MEMO';
    btnMemo.onclick = () => {
      const memo = prompt('메모 입력:');
      if (memo !== null) session.memo = memo;
    };

    const btnRef = document.createElement('button');
    btnRef.className   = 'btn btn-ref';
    btnRef.id          = 'btn-ref-save';
    btnRef.textContent = '◎ REF SAVE';
    btnRef.title       = '연결된 발의 현재 압점 값을 각각 기준값으로 저장';
    btnRef.onclick     = () => saveReference(drill);

    actions.appendChild(btnEnd);
    actions.appendChild(btnMemo);
    actions.appendChild(btnRef);
    panel.appendChild(actions);

    refreshFootBadges();
    updateComparison();
    updateConnectionDependentUI();
  }

  /* ══════════════════════════════════════════════════════════
     동작 캡처 — 판정 없이 원시 스트림만 담는다.

     세션과 나눈 이유는 목적이 다르기 때문이다. 세션은 정해둔 기준에
     맞췄는지 보는 것이고, 캡처는 아직 기준이 없을 때 재료를 모으는
     것이다. 걷는 내내 경고음이 울리면 후자를 할 수가 없다.

     길이는 수동 STOP이 기본이다 — 보행이나 반복 동작은 길이가
     제각각이라 고정 길이로 자르면 동작이 잘린다. 다만 넣어두고 잊는
     경우가 반드시 생기므로 10분에서 자동으로 멈춘다.
  ══════════════════════════════════════════════════════════ */
  function renderCapture() {
    mode = 'motioncap';
    currentDrill = null;
    panel.innerHTML = '';

    let recording  = false;
    let countInId  = null;
    let tickId     = null;
    let autoStopId = null;
    let label      = '';

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const titleEl = document.createElement('span');
    titleEl.className   = 'session-title';
    titleEl.textContent = '동작 캡처';
    const hintEl = document.createElement('span');
    hintEl.id = 'cap-hint';
    hintEl.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:.08em;';
    hintEl.textContent = '판정 없음 · 원시 기록';
    hdr.appendChild(titleEl);
    hdr.appendChild(hintEl);
    panel.appendChild(hdr);

    /* ── 라벨 ── */
    const labelCard = document.createElement('div');
    labelCard.className = 'card card-sm';
    labelCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);margin-top:var(--gap-sm);';

    const labelLbl = document.createElement('div');
    labelLbl.className = 'form-label';
    labelLbl.textContent = '동작 이름';
    labelCard.appendChild(labelLbl);

    const labelInput = document.createElement('input');
    labelInput.className = 'form-input';
    labelInput.placeholder = '보행, 스쿼트, 한발서기 …';
    labelInput.oninput = () => { label = labelInput.value.trim(); syncRecBtn(); };
    labelCard.appendChild(labelInput);

    // 최근 라벨 — 반복 촬영할 때 매번 타이핑하지 않도록.
    const recent = [...new Set(store.getCaptures().slice(-30).map(c => c.label))]
                     .filter(Boolean).reverse().slice(0, 6);
    if (recent.length) {
      const chips = document.createElement('div');
      chips.className = 'cap-chips';
      recent.forEach(l => {
        const b = document.createElement('button');
        b.className = 'coach-chip cap-chip-btn';
        b.textContent = l;
        b.onclick = () => { labelInput.value = l; label = l; syncRecBtn(); };
        chips.appendChild(b);
      });
      labelCard.appendChild(chips);
    }
    panel.appendChild(labelCard);

    /* ── 녹화 상태 ── */
    const meter = document.createElement('div');
    meter.className = 'cap-meter';
    meter.innerHTML =
      '<div class="cap-time" id="cap-time">00:00</div>' +
      '<div class="cap-counts" id="cap-counts">대기 중</div>';
    panel.appendChild(meter);

    // 센서가 실제로 반응하는지 눈으로 보면서 찍을 수 있어야 한다.
    const feetRow = document.createElement('div');
    feetRow.className = 'feet-row';
    FOOT_IDS.forEach(f => feetRow.appendChild(buildFootColumn(f, new Set(POINT_IDS.slice(0, 4)))));
    panel.appendChild(feetRow);

    /* ── 컨트롤 ── */
    const actions = document.createElement('div');
    actions.className = 'live-actions';

    const btnRec = document.createElement('button');
    btnRec.className = 'btn btn-primary cap-rec';
    btnRec.textContent = '● REC';

    const btnMark = document.createElement('button');
    btnMark.className = 'btn btn-ghost';
    btnMark.textContent = '구간 표시';
    btnMark.disabled = true;

    const btnBack = document.createElement('button');
    btnBack.className = 'btn btn-ghost';
    btnBack.textContent = '나가기';

    actions.appendChild(btnRec);
    actions.appendChild(btnMark);
    actions.appendChild(btnBack);
    panel.appendChild(actions);

    /* ── 저장된 테이크 ── */
    const takesHdr = document.createElement('div');
    takesHdr.className = 'section-heading';
    takesHdr.style.marginTop = 'var(--gap-md)';
    takesHdr.textContent = '저장된 캡처';
    panel.appendChild(takesHdr);

    const usage = document.createElement('div');
    usage.className = 'cap-usage';
    panel.appendChild(usage);

    const takes = document.createElement('div');
    takes.className = 'cap-takes';
    panel.appendChild(takes);

    function syncRecBtn() {
      btnRec.disabled = !recording && !label;
      btnRec.title = (!recording && !label) ? '동작 이름을 먼저 입력하세요' : '';
    }

    function fmtMs(ms) {
      const s = Math.floor(ms / 1000);
      return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
    }

    function renderTakes() {
      const list = store.getCaptures().slice().reverse();
      const u = store.storageUsage();
      usage.textContent = `캡처 ${list.length}건 · 저장소 사용 약 ${u.mb}MB` +
        (u.mb >= 3.5 ? '  ⚠ 한계에 가깝습니다 — LOG에서 내보낸 뒤 정리하세요' : '');
      usage.className = 'cap-usage' + (u.mb >= 3.5 ? ' warn' : '');

      takes.innerHTML = '';
      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'empty-state';
        e.style.padding = 'var(--gap-md)';
        e.textContent = '아직 캡처가 없습니다.';
        takes.appendChild(e);
        return;
      }
      list.forEach(c => {
        const row = document.createElement('div');
        row.className = 'card card-sm cap-take';

        const info = document.createElement('div');
        info.style.cssText = 'flex:1;min-width:0;';
        const t1 = document.createElement('div');
        t1.className = 'cap-take-title';
        t1.textContent = `${c.label}  #${c.take}`;
        const t2 = document.createElement('div');
        t2.className = 'cap-take-sub';
        const counts = (c.feet || []).map(f => `${FOOT_LABEL[f]} ${(c[f] || []).length}`).join(' · ');
        t2.textContent = `${c.duration}s · ${counts} 샘플` +
                         (c.markers?.length ? ` · 마커 ${c.markers.length}` : '') +
                         (c.truncated ? ' · ⚠10분 상한' : '') +
                         (c.trimmedFrom ? ' · 잘라낸 구간' : '');
        info.appendChild(t1); info.appendChild(t2);

        const del = document.createElement('button');
        del.className = 'btn-icon';
        del.style.color = 'var(--color-alert-p)';
        del.textContent = '✕';
        del.title = '삭제';
        del.onclick = (e) => {
          e.stopPropagation();
          if (!confirm(`"${c.label} #${c.take}" 캡처를 삭제할까요?`)) return;
          store.deleteCapture(c.captureId);
          renderTakes();
        };

        row.style.cursor = 'pointer';
        row.onclick = () => renderCaptureDetail(c, () => renderCapture());

        row.appendChild(info);
        row.appendChild(del);
        takes.appendChild(row);
      });
    }

    function paintLive() {
      const el = document.getElementById('cap-counts');
      if (!el) return;
      const parts = FOOT_IDS.map(f => `${FOOT_LABEL[f]} ${session.captureSampleCount(f)}`);
      el.textContent = parts.join('  ·  ') + '  샘플';
      const tEl = document.getElementById('cap-time');
      if (tEl) tEl.textContent = fmtMs(session.captureElapsedMs);
    }

    function beginRecording() {
      recording = true;
      session.startCapture();
      btnRec.textContent = '■ STOP';
      btnRec.classList.add('recording');
      btnMark.disabled = false;
      labelInput.disabled = true;
      hintEl.textContent = '● 녹화 중';
      tickId = setInterval(paintLive, 250);
      // 넣어두고 잊는 경우가 반드시 생긴다.
      autoStopId = setTimeout(() => {
        app.showToast('10분 상한에 도달해 캡처를 자동 종료했습니다.');
        stopRecording();
      }, CAPTURE_MAX_MS);
    }

    function stopRecording() {
      if (!recording) return;
      recording = false;
      clearInterval(tickId); tickId = null;
      clearTimeout(autoStopId); autoStopId = null;

      const data = session.stopCapture();
      btnRec.textContent = '● REC';
      btnRec.classList.remove('recording');
      btnMark.disabled = true;
      labelInput.disabled = false;
      hintEl.textContent = '판정 없음 · 원시 기록';
      document.getElementById('cap-time').textContent = '00:00';
      document.getElementById('cap-counts').textContent = '대기 중';

      if (!data || !data.feet.length) {
        app.showToast('수신된 샘플이 없어 저장하지 않았습니다 — 유닛 연결을 확인하세요.');
        return;
      }

      const cap = {
        captureId: store.newCaptureId(),
        schema:    1,
        label,
        take:      store.nextTake(label),
        date:      new Date().toISOString().slice(0, 10),
        ...data,
      };
      const r = store.saveCapture(cap);
      if (r.ok === false) {
        app.showToast('⚠ 저장 공간 부족 — 캡처를 저장하지 못했습니다. LOG에서 내보낸 뒤 정리하세요.');
        return;
      }
      app.showToast(`${cap.label} #${cap.take} 저장 · ${cap.duration}s`);
      renderTakes();
    }

    btnRec.onclick = () => {
      if (recording) { stopRecording(); return; }
      if (!label) { labelInput.focus(); return; }
      if (!bluetooth.isAnyLive()) {
        app.showToast('연결된 유닛이 없습니다 — 헤더의 L / R 버튼으로 연결하세요.');
        return;
      }
      // 카운트인 — 폰을 주머니에 넣거나 자세를 잡을 시간.
      let n = CAPTURE_COUNTIN_SEC;
      btnRec.disabled = true;
      hintEl.textContent = `${n}…`;
      countInId = setInterval(() => {
        n--;
        if (n > 0) { hintEl.textContent = `${n}…`; return; }
        clearInterval(countInId); countInId = null;
        btnRec.disabled = false;
        beginRecording();
      }, 1000);
    };

    btnMark.onclick = () => {
      const m = session.markCapture();
      if (m) app.showToast(`구간 표시 ${fmtMs(m.t)}`);
    };

    btnBack.onclick = () => {
      if (recording && !confirm('녹화 중입니다. 중단하고 나갈까요?\n지금까지 찍힌 구간은 저장됩니다.')) return;
      if (countInId) clearInterval(countInId);
      if (recording) stopRecording();
      renderIdle();
    };

    syncRecBtn();
    renderTakes();
    refreshFootBadges();
  }

  /* ══════════════════════════════════════════════════════════
     캡처 상세 — 파형을 보고 좋은 구간만 잘라낸다.

     이게 캡처의 목적이다. 10분을 통째로 찍어봐야 그 안에서 제대로
     된 몇 초를 골라내지 못하면 훈련 기준으로 쓸 수 없다.

     10Hz × 10분 = 6,000점을 폰 화면 350px에 그대로 그릴 수는 없어서
     구간별 min/max로 줄여 그린다. 봉우리와 골이 뭉개지지 않아야
     접지 시점을 눈으로 찾을 수 있다 — 평균으로 줄이면 그게 사라진다.
  ══════════════════════════════════════════════════════════ */

  const TRIM_W = 340, TRIM_H = 120, TRIM_PAD = 6;

  /* min/max 데시메이션. buckets 개로 줄이되 각 구간의 최소·최대를
     모두 남겨 파형의 진폭을 보존한다. */
  function decimate(samples, ch, buckets) {
    const n = samples.length;
    if (!n) return [];
    const per = Math.max(1, Math.ceil(n / buckets));
    const out = [];
    for (let i = 0; i < n; i += per) {
      let lo = Infinity, hi = -Infinity;
      for (let j = i; j < Math.min(i + per, n); j++) {
        const v = samples[j][ch];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      out.push({ i, lo, hi });
    }
    return out;
  }

  function renderCaptureDetail(cap, onBack) {
    mode = 'captrim';
    panel.innerHTML = '';

    const feet = (cap.feet || []).filter(f => Array.isArray(cap[f]) && cap[f].length);
    let viewFoot = feet[0] || FOOT.LEFT;
    const dur = () => {
      const arr = cap[viewFoot] || [];
      return arr.length ? arr[arr.length - 1][0] : 0;
    };
    // 선택 구간 (ms)
    let selA = 0, selB = dur();

    const back = document.createElement('button');
    back.className = 'detail-back';
    back.textContent = '← 캡처 목록';
    back.onclick = onBack;
    panel.appendChild(back);

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const ttl = document.createElement('span');
    ttl.className = 'session-title';
    ttl.textContent = `${cap.label}  #${cap.take}`;
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);';
    sub.textContent = `${cap.duration}s · ${cap.date}`;
    hdr.appendChild(ttl); hdr.appendChild(sub);
    panel.appendChild(hdr);

    // 발 전환
    if (feet.length > 1) {
      const ft = document.createElement('div');
      ft.className = 'dir-toggle trim-foot';
      feet.forEach(f => {
        const b = document.createElement('button');
        b.className = 'dir-btn' + (f === viewFoot ? ' selected-positive' : '');
        b.textContent = FOOT_LABEL[f];
        b.onclick = () => {
          viewFoot = f;
          ft.querySelectorAll('.dir-btn').forEach((el, i) =>
            el.classList.toggle('selected-positive', feet[i] === f));
          draw();
        };
        ft.appendChild(b);
      });
      panel.appendChild(ft);
    }

    const chartBox = document.createElement('div');
    chartBox.className = 'trim-box';
    panel.appendChild(chartBox);

    const readout = document.createElement('div');
    readout.className = 'trim-readout';
    panel.appendChild(readout);

    /* 범위 슬라이더 두 개. 폰에서 파형 위 드래그 핸들은 손가락에
       가려 정확히 못 맞춘다. 슬라이더는 보이면서 조절된다. */
    const ctrls = document.createElement('div');
    ctrls.className = 'trim-ctrls';

    const mkRange = (labelText, getV, setV) => {
      const wrap = document.createElement('div');
      wrap.className = 'trim-range';
      const l = document.createElement('span');
      l.className = 'trim-range-label';
      l.textContent = labelText;
      const r = document.createElement('input');
      r.type = 'range'; r.min = '0'; r.max = String(dur()); r.step = '100';
      r.value = String(getV());
      r.oninput = () => { setV(Number(r.value)); draw(); };
      wrap.appendChild(l); wrap.appendChild(r);
      return { wrap, input: r };
    };

    const ra = mkRange('시작', () => selA, v => { selA = Math.min(v, selB - 200); });
    const rb = mkRange('끝',   () => selB, v => { selB = Math.max(v, selA + 200); });
    ctrls.appendChild(ra.wrap);
    ctrls.appendChild(rb.wrap);
    panel.appendChild(ctrls);

    // 마커로 스냅 — 녹화 중 눌러둔 지점이 곧 좋은 구간의 단서다.
    if (cap.markers && cap.markers.length) {
      const mrow = document.createElement('div');
      mrow.className = 'trim-markers';
      const lbl = document.createElement('span');
      lbl.className = 'trim-range-label';
      lbl.textContent = '마커';
      mrow.appendChild(lbl);
      cap.markers.forEach((m, i) => {
        const b = document.createElement('button');
        b.className = 'coach-chip cap-chip-btn';
        b.textContent = `${(m.t/1000).toFixed(1)}s`;
        b.title = '이 지점을 시작으로 (길게 눌러 끝으로)';
        b.onclick = () => { selA = Math.min(m.t, selB - 200); sync(); draw(); };
        b.oncontextmenu = (e) => { e.preventDefault(); selB = Math.max(m.t, selA + 200); sync(); draw(); };
        mrow.appendChild(b);
      });
      panel.appendChild(mrow);
    }

    const actions = document.createElement('div');
    actions.className = 'live-actions';

    const btnAll = document.createElement('button');
    btnAll.className = 'btn btn-ghost';
    btnAll.textContent = '전체 선택';
    btnAll.onclick = () => { selA = 0; selB = dur(); sync(); draw(); };

    const btnSave = document.createElement('button');
    btnSave.className = 'btn btn-primary';
    btnSave.textContent = '선택 구간 저장';
    btnSave.onclick = () => saveTrim();

    const btnRef = document.createElement('button');
    btnRef.className = 'btn btn-ok';
    btnRef.textContent = '기준값으로 →';
    btnRef.title = '선택 구간의 값으로 새 동작(drill)을 만듭니다';
    btnRef.onclick = () => useAsReference();

    actions.appendChild(btnSave);
    actions.appendChild(btnRef);
    actions.appendChild(btnAll);
    panel.appendChild(actions);

    function sync() {
      ra.input.value = String(selA);
      rb.input.value = String(selB);
    }

    function sliceOf(f) {
      const arr = cap[f];
      if (!Array.isArray(arr)) return [];
      return arr.filter(s => s[0] >= selA && s[0] <= selB);
    }

    function draw() {
      const arr = cap[viewFoot] || [];
      const total = dur() || 1;
      const ns = 'http://www.w3.org/2000/svg';
      chartBox.innerHTML = '';

      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${TRIM_W} ${TRIM_H}`);
      svg.setAttribute('class', 'trim-chart');
      svg.setAttribute('preserveAspectRatio', 'none');

      const x = t => TRIM_PAD + (TRIM_W - TRIM_PAD * 2) * (t / total);
      const y = v => TRIM_H - TRIM_PAD - (TRIM_H - TRIM_PAD * 2) * (Math.max(0, Math.min(MAX_SENSOR_VAL, v)) / MAX_SENSOR_VAL);

      // 선택 밖은 어둡게 — 무엇이 잘려나갈지 즉시 보인다
      [[0, selA], [selB, total]].forEach(([a, b]) => {
        if (b <= a) return;
        const r = document.createElementNS(ns, 'rect');
        r.setAttribute('x', x(a)); r.setAttribute('y', 0);
        r.setAttribute('width', Math.max(0, x(b) - x(a)));
        r.setAttribute('height', TRIM_H);
        r.setAttribute('class', 'trim-mask');
        svg.appendChild(r);
      });

      // FSR 4채널
      const buckets = TRIM_W - TRIM_PAD * 2;
      for (let ch = 1; ch <= 4; ch++) {
        const dec = decimate(arr, ch, buckets);
        if (!dec.length) continue;
        let d = '';
        dec.forEach((b, k) => {
          const px = x(arr[b.i][0]);
          d += `${k ? 'L' : 'M'}${px.toFixed(1)},${y(b.hi).toFixed(1)}`;
        });
        for (let k = dec.length - 1; k >= 0; k--) {
          const b = dec[k];
          d += `L${x(arr[b.i][0]).toFixed(1)},${y(b.lo).toFixed(1)}`;
        }
        d += 'Z';
        const path = document.createElementNS(ns, 'path');
        path.setAttribute('d', d);
        path.setAttribute('class', `trim-ch ch${ch}`);
        svg.appendChild(path);
      }

      // 마커
      (cap.markers || []).forEach(m => {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', x(m.t)); line.setAttribute('x2', x(m.t));
        line.setAttribute('y1', 0); line.setAttribute('y2', TRIM_H);
        line.setAttribute('class', 'trim-marker');
        svg.appendChild(line);
      });

      // 선택 경계
      [selA, selB].forEach(t => {
        const line = document.createElementNS(ns, 'line');
        line.setAttribute('x1', x(t)); line.setAttribute('x2', x(t));
        line.setAttribute('y1', 0); line.setAttribute('y2', TRIM_H);
        line.setAttribute('class', 'trim-edge');
        svg.appendChild(line);
      });

      chartBox.appendChild(svg);

      const n = sliceOf(viewFoot).length;
      readout.textContent =
        `선택 ${(selA/1000).toFixed(1)}s – ${(selB/1000).toFixed(1)}s ` +
        `(${((selB - selA)/1000).toFixed(1)}s · ${n}샘플)` +
        `   |   P1 P2 P3 P4 = 채널 1-4`;
    }

    function saveTrim() {
      const out = { left: sliceOf('left'), right: sliceOf('right') };
      const keep = FOOT_IDS.filter(f => out[f].length);
      if (!keep.length) { app.showToast('선택 구간에 샘플이 없습니다.'); return; }

      const label = `${cap.label}-구간`;
      const trimmed = {
        captureId: store.newCaptureId(),
        schema: 1, label, take: store.nextTake(label),
        date: new Date().toISOString().slice(0, 10),
        hz: cap.hz, fields: cap.fields,
        startedAt: cap.startedAt + selA,
        duration: Math.round((selB - selA) / 100) / 10,
        feet: keep,
        // 잘라낸 구간은 t를 0부터 다시 센다. 그래야 여러 구간을
        // 같은 축에 올려 비교할 수 있다.
        markers: (cap.markers || []).filter(m => m.t >= selA && m.t <= selB)
                                    .map(m => ({ t: m.t - selA })),
        trimmedFrom: cap.captureId,
      };
      keep.forEach(f => { trimmed[f] = out[f].map(s => [s[0] - selA, ...s.slice(1)]); });

      const r = store.saveCapture(trimmed);
      if (r.ok === false) { app.showToast('⚠ 저장 공간 부족 — 저장하지 못했습니다.'); return; }
      app.showToast(`${label} #${trimmed.take} 저장 · ${trimmed.duration}s`);
    }

    /* 선택 구간 → drill 기준값. 기존 FREE CAPTURE 경로를 그대로
       재사용한다 — configTab.startFromCapture()가 { values, imu }를
       받으므로, 구간의 채널별 최대값을 대표값으로 넘긴다.
       접지 동작에서는 평균보다 봉우리가 기준으로 의미가 있다. */
    function useAsReference() {
      const snapshot = { left: null, right: null };
      let any = false;
      for (const f of FOOT_IDS) {
        const seg = sliceOf(f);
        if (!seg.length) continue;
        const peak = [0, 0, 0, 0];
        let rs = 0, ps = 0, ys = 0;
        seg.forEach(s => {
          for (let c = 0; c < 4; c++) if (s[c + 1] > peak[c]) peak[c] = s[c + 1];
          rs += s[5]; ps += s[6]; ys += s[7];
        });
        snapshot[f] = {
          values: [...peak, rs / seg.length, ps / seg.length, ys / seg.length],
          imu: { roll: rs / seg.length, pitch: ps / seg.length, yaw: ys / seg.length },
        };
        any = true;
      }
      if (!any) { app.showToast('선택 구간에 샘플이 없습니다.'); return; }
      configTab.startFromCapture(snapshot);
      app.switchTab('config');
      app.showToast('선택 구간의 채널별 최대값을 기준값으로 넘겼습니다.');
    }

    sync();
    draw();
  }

  /* -- Render wrap-up: record form -> AI coach report ---------
     The session is already saved by the time this renders, so every
     control here edits a stored log rather than live state. Nothing on
     this screen is required: a user who just wants to stop training can
     walk away and the session is still intact. */
  function renderWrapUp(log) {
    mode = 'wrapup';
    currentDrill = null;
    panel.innerHTML = '';

    let reportAbort = null;

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const titleEl = document.createElement('span');
    titleEl.className   = 'session-title';
    titleEl.textContent = '세션 종료';
    const subEl = document.createElement('span');
    subEl.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:.08em;';
    subEl.textContent = log.drillTitle + ' · ' + log.duration + 's · 정확도 ' + log.quality + '%';
    hdr.appendChild(titleEl);
    hdr.appendChild(subEl);
    panel.appendChild(hdr);

    /* -- record form -- */
    const form = document.createElement('div');
    form.className = 'card card-sm';
    form.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);margin-top:var(--gap-sm);';

    const formHdr = document.createElement('div');
    formHdr.className = 'form-label';
    formHdr.textContent = '세션 기록 (선택)';
    form.appendChild(formHdr);

    const enLbl = document.createElement('div');
    enLbl.style.cssText = 'font-size:11px;color:var(--text-dim);';
    enLbl.textContent = '에너지 상태';
    form.appendChild(enLbl);

    let energy = null;
    const enRow = document.createElement('div');
    enRow.className = 'energy-row';
    for (let i = 1; i <= 10; i++) {
      const b = document.createElement('button');
      b.className   = 'energy-dot';
      b.textContent = i;
      b.dataset.v   = i;
      b.onclick = () => {
        energy = (energy === i) ? null : i;          // tap again to clear
        enRow.querySelectorAll('.energy-dot').forEach((el, idx) => {
          el.classList.toggle('on', energy !== null && idx < energy);
        });
      };
      enRow.appendChild(b);
    }
    form.appendChild(enRow);

    const envLbl = document.createElement('div');
    envLbl.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';
    envLbl.textContent = '환경';
    form.appendChild(envLbl);

    let environment = null;
    const envRow = document.createElement('div');
    envRow.className = 'dir-toggle';
    [['indoor', '실내'], ['outdoor', '실외']].forEach(pair => {
      const b = document.createElement('button');
      b.className   = 'dir-btn';
      b.textContent = pair[1];
      b.dataset.env = pair[0];
      b.onclick = () => {
        environment = (environment === pair[0]) ? null : pair[0];
        // The app's selected-state class for .dir-btn is
        // selected-positive, not .active — .active has no rule at all.
        envRow.querySelectorAll('.dir-btn').forEach(el => {
          el.classList.toggle('selected-positive', environment === el.dataset.env);
        });
      };
      envRow.appendChild(b);
    });
    form.appendChild(envRow);

    const noteLbl = document.createElement('div');
    noteLbl.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';
    noteLbl.textContent = '특이사항';
    form.appendChild(noteLbl);

    const note = document.createElement('textarea');
    note.className   = 'form-input';
    note.rows        = 2;
    note.placeholder = '발목 뻐근함, 새 신발, 바닥이 미끄러웠음 …';
    note.style.cssText = 'resize:vertical;font-size:12px;';
    if (log.memo) note.value = log.memo;      // carry over an in-session memo
    form.appendChild(note);

    panel.appendChild(form);

    /* -- report area -- */
    const reportCard = document.createElement('div');
    reportCard.className = 'card card-sm coach-card';
    reportCard.id = 'coach-card';
    reportCard.style.display = 'none';
    panel.appendChild(reportCard);

    function paintReport(state, rep) {
      reportCard.style.display = '';
      reportCard.innerHTML = '';

      const head = document.createElement('div');
      head.className   = 'coach-head';
      head.textContent = '▶ SDI REPORT';
      reportCard.appendChild(head);

      if (state === 'loading') {
        const l = document.createElement('div');
        l.className   = 'coach-loading';
        l.textContent = '조교가 기록을 보는 중…';
        reportCard.appendChild(l);
        return;
      }

      const face = document.createElement('div');
      face.className   = 'coach-face';
      face.textContent = coach.renderFace(rep.face);
      face.title       = coach.FACES[rep.face] || '';
      reportCard.appendChild(face);

      const body = document.createElement('div');
      body.className   = 'coach-text';
      body.textContent = rep.text;
      reportCard.appendChild(body);

      const meta = document.createElement('div');
      meta.className = 'coach-meta';
      meta.textContent = rep.source === 'openai'
        ? String(rep.model)
        : rep.reason === 'no-key'
          ? '로컬 리포트 — CONFIG에서 API 키를 넣으면 AI 조교가 씁니다'
          : '로컬 리포트 — ' + (rep.error || 'API 호출 실패');
      reportCard.appendChild(meta);
    }

    /* -- actions -- */
    const actions = document.createElement('div');
    actions.className = 'live-actions';
    actions.style.marginTop = 'var(--gap-sm)';

    const btnReport = document.createElement('button');
    btnReport.className   = 'btn btn-primary';
    btnReport.textContent = '기록 저장 · 리포트 받기';

    const btnSkip = document.createElement('button');
    btnSkip.className   = 'btn btn-ghost';
    btnSkip.textContent = '건너뛰기';

    const btnLog = document.createElement('button');
    btnLog.className   = 'btn btn-ghost';
    btnLog.textContent = 'LOG 보기';
    btnLog.onclick = () => { if (reportAbort) reportAbort.abort(); renderIdle(); app.switchTab('log'); };

    function persist() {
      log.record = {
        energy,
        environment,
        note: note.value.trim() || null,
      };
      const r = store.saveSession(log);
      if (r && r.ok === false) app.showToast('⚠ 저장 실패 — 저장 공간이 부족합니다.');
    }

    btnReport.onclick = async () => {
      persist();
      btnReport.disabled = true;
      btnSkip.disabled   = true;
      paintReport('loading');

      reportAbort = new AbortController();
      try {
        const rep = await coach.report(log, { signal: reportAbort.signal });
        log.report = rep;
        store.saveSession(log);
        // Saving already happened; only skip the repaint if the user left.
        if (mode === 'wrapup') paintReport('done', rep);
      } catch (err) {
        if (err && err.name !== 'AbortError') {
          app.showToast('리포트 생성 실패 — ' + (err.message || err));
        }
      } finally {
        btnReport.disabled = false;
        btnSkip.disabled   = false;
        btnReport.textContent = '다시 받기';
      }
    };

    btnSkip.onclick = () => {
      persist();                    // an empty record is still a record
      renderIdle();
      app.switchTab('log');
    };

    actions.appendChild(btnReport);
    actions.appendChild(btnSkip);
    actions.appendChild(btnLog);
    panel.appendChild(actions);
  }

  /* ── Render free-capture state ──────────────────────────── */
  function renderFreeCapture() {
    mode = 'capture';
    currentDrill = null;
    panel.innerHTML = '';
    latest.left  = { values: null, alerts: [], accuracy: null };
    latest.right = { values: null, alerts: [], accuracy: null };

    // FSR-only points (P1-P4) for display
    const fsrPoints = POINT_IDS.slice(0, 4);

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const titleEl = document.createElement('span');
    titleEl.className   = 'session-title active';
    titleEl.textContent = 'FREE CAPTURE';
    const hintEl = document.createElement('span');
    hintEl.style.cssText = 'font-size:11px;color:var(--text-muted);font-family:var(--font-mono);letter-spacing:.08em;';
    hintEl.textContent = '실시간 측정 중';
    hdr.appendChild(titleEl);
    hdr.appendChild(hintEl);
    panel.appendChild(hdr);

    const stats = document.createElement('div');
    stats.className = 'live-stats';
    stats.style.gridTemplateColumns = 'max-content';
    const timerBlk = document.createElement('div');
    timerBlk.className = 'stat-block';
    const timerLbl = document.createElement('span');
    timerLbl.className = 'stat-label';
    timerLbl.textContent = 'TIME';
    const timerVal = document.createElement('span');
    timerVal.className = 'stat-value';
    timerVal.id = 'live-timer';
    timerVal.textContent = '00:00';
    timerBlk.appendChild(timerLbl);
    timerBlk.appendChild(timerVal);
    stats.appendChild(timerBlk);
    panel.appendChild(stats);

    const btWarn = document.createElement('div');
    btWarn.id        = 'bt-warn';
    btWarn.className = 'alert-banner visible negative';
    btWarn.textContent = '연결된 유닛이 없습니다 — 헤더의 L / R 버튼으로 연결하세요';
    panel.appendChild(btWarn);

    const activeIds = new Set(fsrPoints);
    const feetRow = document.createElement('div');
    feetRow.className = 'feet-row';
    FOOT_IDS.forEach(foot => feetRow.appendChild(buildFootColumn(foot, activeIds)));
    panel.appendChild(feetRow);

    const gauges = document.createElement('div');
    gauges.className = 'live-gauges paired';
    gauges.id        = 'live-gauges';
    fsrPoints.forEach(pid => gauges.appendChild(buildPairedGauge(PRESSURE_POINTS[pid])));
    panel.appendChild(gauges);

    const capHint = document.createElement('div');
    capHint.className = 'ready-banner';
    capHint.textContent = '원하는 자세를 취한 상태에서 캡처하세요. 연결된 발의 캡처 값이 각각 기준값이 됩니다.';
    panel.appendChild(capHint);

    const actions = document.createElement('div');
    actions.className = 'live-actions';
    actions.style.gridTemplateColumns = '1fr 1fr';

    const btnCancel = document.createElement('button');
    btnCancel.className   = 'btn btn-ghost';
    btnCancel.textContent = '← 취소';
    btnCancel.onclick = () => { session.stopFreeCapture(); renderIdle(); };

    const btnCapture = document.createElement('button');
    btnCapture.className   = 'btn btn-ok';
    btnCapture.textContent = '📸  캡처';
    btnCapture.onclick = () => {
      const snapshot = session.stopFreeCapture();
      if (!snapshot || (!snapshot.left && !snapshot.right)) {
        app.showToast('캡처할 데이터가 없습니다 — 유닛을 연결하세요');
        renderIdle();
        return;
      }
      configTab.startFromCapture(snapshot);
      app.switchTab('config');
    };

    actions.appendChild(btnCancel);
    actions.appendChild(btnCapture);
    panel.appendChild(actions);

    bindSessionCallbacks();
    session.startFreeCapture();
    refreshFootBadges();
    updateConnectionDependentUI();
  }

  /* ── Render ready (preparation) state ──────────────────── */
  function renderReady(drill) {
    mode = 'ready';
    currentDrill = drill;
    panel.innerHTML = '';

    const hdr = document.createElement('div');
    hdr.className = 'session-header';
    const titleEl = document.createElement('span');
    titleEl.className   = 'session-title';
    titleEl.textContent = drill.title;
    const badgeEl = document.createElement('span');
    badgeEl.className   = `badge badge-${drill.type}`;
    badgeEl.textContent = DRILL_TYPES[drill.type].label;
    hdr.appendChild(titleEl);
    hdr.appendChild(badgeEl);
    panel.appendChild(hdr);

    panel.appendChild(buildConnectCard());

    const readyBanner = document.createElement('div');
    readyBanner.className   = 'ready-banner';
    readyBanner.textContent = '센서를 배치하고 준비가 되면 훈련을 시작하세요';
    panel.appendChild(readyBanner);

    // Placement card: both silhouettes + point list
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    const secLbl = document.createElement('div');
    secLbl.className = 'section-heading';
    secLbl.style.borderBottom = 'none';
    secLbl.textContent = 'FSR 배치 위치';
    card.appendChild(secLbl);

    const activeIds = new Set(drill.points.map(p => p.id));
    const feetRow = document.createElement('div');
    feetRow.className = 'feet-row';
    FOOT_IDS.forEach(foot => {
      const col = document.createElement('div');
      col.className = 'foot-col';
      const lbl = document.createElement('span');
      lbl.className   = 'foot-label';
      lbl.textContent = FOOT_LABEL[foot];
      const svg = buildFootSVG({ foot });
      svg.querySelectorAll('.pp-dot').forEach(dot => {
        dot.dataset.state = activeIds.has(dot.dataset.id) ? 'ok' : 'inactive';
      });
      col.appendChild(lbl);
      col.appendChild(svg);
      feetRow.appendChild(col);
    });
    card.appendChild(feetRow);

    const ptList = document.createElement('div');
    ptList.className = 'modal-pt-list';
    drill.points.forEach(pt => {
      const pp  = PRESSURE_POINTS[pt.id];
      const row = document.createElement('div');
      row.className = 'modal-pt-row';
      const idBadge = document.createElement('span');
      idBadge.className   = 'modal-pt-id';
      idBadge.textContent = pt.id;
      const info = document.createElement('span');
      info.textContent = `${pp.name} — ${pp.label}`;
      const dir = document.createElement('span');
      dir.style.cssText = 'margin-left:auto;font-size:11px;font-family:var(--font-mono);';
      dir.style.color = pt.direction === 'positive' ? 'var(--color-ok)' : 'var(--color-alert-p)';
      dir.textContent = pt.direction === 'positive' ? '▲ THR' : '▼ THR';
      row.appendChild(idBadge);
      row.appendChild(info);
      row.appendChild(dir);
      ptList.appendChild(row);
    });
    card.appendChild(ptList);
    panel.appendChild(card);

    const actions = document.createElement('div');
    actions.className = 'live-actions';
    actions.style.gridTemplateColumns = '1fr 1fr';

    const btnCancel = document.createElement('button');
    btnCancel.className   = 'btn btn-ghost';
    btnCancel.textContent = '← 취소';
    btnCancel.onclick = () => renderIdle();

    const btnStart = document.createElement('button');
    btnStart.className   = 'btn btn-ok';
    btnStart.textContent = '▶ 훈련 시작';
    btnStart.onclick = () => {
      renderActive(drill);
      bindSessionCallbacks();
      session.start(drill);
    };

    actions.appendChild(btnCancel);
    actions.appendChild(btnStart);
    panel.appendChild(actions);

    refreshConnectCard();
  }

  /* ── SVG / gauge updates (per foot) ─────────────────────── */
  function updateSVG(foot, alerts) {
    const svg = document.getElementById(`live-svg-${foot}`);
    if (!svg) return;
    const alertMap = new Map(alerts.map(a => [a.pointId, a.type]));
    const points = currentDrill ? currentDrill.points.map(p => p.id) : POINT_IDS.slice(0, 4);
    points.forEach(pid => {
      const dot = svg.querySelector(`.pp-dot[data-id="${pid}"]`);
      if (!dot) return;
      const aType = alertMap.get(pid);
      dot.dataset.state = aType ? (aType === 'negative' ? 'alert-n' : 'alert-p') : 'ok';
    });
  }

  function updateGauges(foot, values, alerts) {
    const container = document.getElementById('live-gauges');
    if (!container) return;
    const alertMap = new Map(alerts.map(a => [a.pointId, a.type]));

    container.querySelectorAll('.gauge-pair').forEach(row => {
      const pid  = row.dataset.pid;
      const line = row.querySelector(`.gauge-line[data-foot="${foot}"]`);
      if (!line) return;

      // FREE CAPTURE has no drill and shows the raw P1-P4 channels,
      // which is exactly what channelOf(null, …) returns.
      const idx   = channelOf(currentDrill ? currentDrill.points : null, pid);
      const val   = idx >= 0 ? (values[idx] ?? 0) : 0;
      const pct   = Math.round((val / MAX_SENSOR_VAL) * 100);
      const aType = alertMap.get(pid);

      const fill      = line.querySelector('.gauge-fill');
      const thrMarker = line.querySelector('.gauge-thr');
      const refMarker = line.querySelector('.gauge-ref');
      const valEl     = line.querySelector('.gauge-val');

      fill.style.width = `${pct}%`;

      // Threshold + reference markers are per foot: percent-mode
      // thresholds derive from that foot's own calibration.
      const pt = currentDrill?.points.find(p => p.id === pid);
      if (pt) {
        const effThr = alertEngine.getEffectiveThr(pt, foot);
        thrMarker.style.left = `${Math.round((effThr / MAX_SENSOR_VAL) * 100)}%`;

        const ref = alertEngine.getReference(pt, foot);
        if (ref !== null) {
          refMarker.style.display = 'block';
          refMarker.style.left    = `${Math.round((ref / MAX_SENSOR_VAL) * 100)}%`;
        } else {
          refMarker.style.display = 'none';
        }
      } else {
        thrMarker.style.left = '0%';
        refMarker.style.display = 'none';
      }

      const cls = aType === 'positive' ? ' alert-p' : aType === 'negative' ? ' alert-n' : '';
      fill.className    = 'gauge-fill' + cls;
      valEl.className   = 'gauge-val mono' + cls;
      valEl.textContent = String(val).padStart(4, ' ');
    });
  }

  /* Blank a foot's gauges when it is not delivering data, so a stale
     reading cannot be mistaken for a live one. */
  function blankGauges(foot) {
    const container = document.getElementById('live-gauges');
    if (!container) return;
    container.querySelectorAll(`.gauge-line[data-foot="${foot}"]`).forEach(line => {
      const fill  = line.querySelector('.gauge-fill');
      const valEl = line.querySelector('.gauge-val');
      if (fill)  { fill.style.width = '0%'; fill.className = 'gauge-fill'; }
      if (valEl) { valEl.textContent = '---'; valEl.className = 'gauge-val mono dim'; }
      line.classList.add('inactive');
    });
  }

  function updateFootQuality(foot) {
    const el = document.getElementById(`foot-quality-${foot}`);
    if (!el) return;
    if (!bluetooth.foot(foot).isLive()) {
      el.textContent = '미연결';
      el.className   = 'foot-quality off';
      return;
    }
    const q = session.quality(foot);
    if (q === null) {
      el.textContent = '대기 중';
      el.className   = 'foot-quality off';
      return;
    }
    el.textContent = `${q}%`;
    el.className   = 'foot-quality ' + (q >= 80 ? 'ok' : q >= 50 ? 'warn' : 'danger');
  }

  /* ── Alert banner ───────────────────────────────────────────
     Messages from both feet are merged, each prefixed with its side.
     This is the visual counterpart to the stereo/pitch cue in audio. */
  let bannerTimer = null;
  function updateBanner() {
    const banner = document.getElementById('live-banner');
    if (!banner) return;

    const all = [];
    FOOT_IDS.forEach(foot => {
      if (!bluetooth.foot(foot).isLive()) return;
      latest[foot].alerts.forEach(a => all.push({ ...a, foot }));
    });

    if (!all.length) {
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        banner.classList.remove('visible', 'positive', 'negative');
      }, 1500);
      return;
    }
    clearTimeout(bannerTimer);

    const msgs = all.map(a => {
      const side = a.foot === FOOT.LEFT ? 'L' : 'R';
      if (a.type === 'gait') return `[${side}] 보행 순서 오류`;
      if (a.type === 'imu')  return `[${side}] 발 틀어짐 ${a.value > 0 ? '+' : ''}${a.value}° (허용 ±${a.thr}°)`;
      const pt = PRESSURE_POINTS[a.pointId];
      return a.type === 'positive'
        ? `[${side}] ${pt.label} 압력 부족 (${a.value})`
        : `[${side}] ${pt.label} 과압 감지 (${a.value})`;
    });

    banner.textContent = msgs.join(' · ');
    const severe = all.some(a => ['negative', 'gait', 'imu'].includes(a.type));
    banner.className = 'alert-banner visible ' + (severe ? 'negative' : 'positive');
  }

  /* ── rAF coalescing ─────────────────────────────────────────
     session.feed() fires per packet; painting happens at most once
     per frame no matter how many packets arrived in between. */
  function markDirty(foot) {
    dirty[foot] = true;
    if (rafId === null) rafId = requestAnimationFrame(flush);
  }

  function flush() {
    rafId = null;
    FOOT_IDS.forEach(foot => {
      if (!dirty[foot]) return;
      dirty[foot] = false;
      const { values, alerts } = latest[foot];
      if (!values) return;
      updateSVG(foot, alerts);
      updateGauges(foot, values, alerts);
      updateFootQuality(foot);
      updateImu(foot);
    });
    updateBanner();
    updateComparison();
    updateOverallQuality();
  }

  function updateOverallQuality() {
    const el = document.getElementById('live-quality');
    if (!el) return;
    const feet = session.joinedFeet();
    if (!feet.length) {
      el.textContent = bluetooth.isAnyLive() ? '대기 중' : '측정 불가';
      el.className   = 'stat-value warn';
      return;
    }
    // With both feet, show them separately — an averaged single number
    // hides the case where one foot is fine and the other is not.
    if (feet.length === 2) {
      const l = session.quality(FOOT.LEFT);
      const r = session.quality(FOOT.RIGHT);
      el.textContent = `${l}/${r}%`;
      el.className   = 'stat-value ' + (Math.min(l, r) >= 80 ? 'ok' : Math.min(l, r) >= 50 ? 'warn' : 'danger');
    } else {
      const q = session.quality(feet[0]);
      el.textContent = `${q}%`;
      el.className   = 'stat-value ' + (q >= 80 ? 'ok' : q >= 50 ? 'warn' : 'danger');
    }
  }

  /* Repaint everything that depends on which feet are live. */
  function updateConnectionDependentUI() {
    refreshConnectCard();
    refreshFootBadges();

    const warn = document.getElementById('bt-warn');
    if (warn) warn.style.display = bluetooth.isAnyLive() ? 'none' : '';

    FOOT_IDS.forEach(foot => {
      if (!bluetooth.foot(foot).isLive()) {
        blankGauges(foot);
        latest[foot] = { values: null, alerts: [], accuracy: null };
      } else {
        document.querySelectorAll(`.gauge-line[data-foot="${foot}"]`)
          .forEach(l => l.classList.remove('inactive'));
      }
      updateFootQuality(foot);
      updateImu(foot);
    });

    const btnRef = document.getElementById('btn-ref-save');
    if (btnRef) btnRef.disabled = !bluetooth.isAnyLive();

    updateBanner();
    updateComparison();
    updateOverallQuality();
  }

  /* ── REF SAVE ───────────────────────────────────────────────
     Saves a reference for each LIVE foot only. A foot that is not
     connected keeps whatever calibration it already had — pressing
     this with one unit attached must not wipe the other side. */
  function saveReference(drill) {
    if (!session.isActive) return;

    const saved = [];
    FOOT_IDS.forEach(foot => {
      if (!bluetooth.foot(foot).isLive() || !session.hasFoot(foot)) return;
      const values = session.currentValues(foot);
      drill.points.forEach(pt => {
        const idx = channelOf(drill.points, pt.id);
        if (!pt.reference || typeof pt.reference === 'number') {
          pt.reference = { left: null, right: null };
        }
        pt.reference[foot] = values[idx];
        store.updateDrillPointRef(drill.id, pt.id, values[idx], foot);
      });
      saved.push(FOOT_LABEL[foot]);
    });

    const banner = document.getElementById('ref-banner');
    if (banner) {
      if (!saved.length) {
        banner.textContent = '연결된 유닛이 없어 기준값을 저장하지 못했습니다';
      } else {
        const now = new Date();
        const hms = [now.getHours(), now.getMinutes(), now.getSeconds()]
          .map(n => String(n).padStart(2, '0')).join(':');
        banner.textContent = `REFERENCE SAVED [${saved.join(' + ')}] · ${hms}`;
      }
      banner.classList.add('visible');
      clearTimeout(banner._timer);
      banner._timer = setTimeout(() => banner.classList.remove('visible'), 2200);
    }
  }

  /* ── Session callback binding ───────────────────────────── */
  function bindSessionCallbacks() {
    session.onTick = () => {
      const timerEl  = document.getElementById('live-timer');
      const alertsEl = document.getElementById('live-alerts');
      if (timerEl)  timerEl.textContent  = session.fmtElapsed();
      if (alertsEl) alertsEl.textContent = session.alertCount;
      FOOT_IDS.forEach(updateImu);       // refresh the yaw drift age
      updateOverallQuality();
    };

    session.onValues = (foot, values, alerts, accuracy) => {
      latest[foot] = { values, alerts, accuracy };
      markDirty(foot);
    };

    session.onFreeTick = (foot, values) => {
      latest[foot] = { values, alerts: [], accuracy: null };
      markDirty(foot);
    };

    /* 캡처 중에는 판정 결과가 없으므로 실루엣만 살아 있으면 된다.
       센서가 반응하는지 눈으로 확인하면서 찍기 위한 것이다. */
    session.onCaptureTick = (foot, values) => {
      latest[foot] = { values, alerts: [], accuracy: null };
      markDirty(foot);
    };

    // A foot that starts streaming mid-session joins from that moment.
    session.onFootJoin = (foot) => {
      refreshFootBadges();
      app.showToast(`${FOOT_LABEL_KO[foot]} 합류 — 지금부터 집계됩니다`);
    };

    // end() is reachable from places other than the END button, so the
    // wrap-up screen is driven from the callback too rather than only
    // from the click handler.
    session.onEnd = (log) => {
      if (log && mode !== 'wrapup') renderWrapUp(log);
    };
  }

  /* ── Public API ─────────────────────────────────────────── */
  return {
    buildFootSVG,

    init(panelEl) {
      panel = panelEl;

      // requestAnimationFrame is paused while the page is hidden, so a
      // pending repaint sits queued for the whole time the phone is
      // locked or the app is backgrounded. Repaint immediately on
      // resume rather than showing one stale frame first.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') flush();
      });

      renderIdle();
    },

    /* Force an immediate repaint from the latest samples, bypassing
       the rAF queue. Used on resume and by diagnostics. */
    forceRefresh() { flush(); },

    /* Called by main.js whenever any foot's link changes state. */
    onConnectionChange(foot, status) {
      if (mode === 'idle' || mode === 'ready') {
        refreshConnectCard();
        return;
      }
      updateConnectionDependentUI();
    },

    startFreeCapture() { renderFreeCapture(); },
    startMotionCapture() { bindSessionCallbacks(); renderCapture(); },
    prepareSession(drill) { renderReady(drill); },

    startSession(drill) {
      renderActive(drill);
      bindSessionCallbacks();
      session.start(drill);
    },
  };
})();
