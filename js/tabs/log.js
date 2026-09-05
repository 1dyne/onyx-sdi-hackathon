const logTab = (() => {
  let panel     = null;
  let viewMode  = 'list';   // 'list' | 'detail' | 'coach'
  let detailId  = null;
  let cameFromCoach = false;   // detail was opened from the coach feed

  function fmt2(n) { return String(n).padStart(2, '0'); }
  function fmtDuration(s) {
    const m = Math.floor(s / 60);
    return `${fmt2(m)}:${fmt2(s % 60)}`;
  }
  function qualityClass(q) {
    return q >= 80 ? 'ok' : q >= 50 ? 'warn' : 'danger';
  }
  /* ── Foot helpers ────────────────────────────────────────────
     Sessions recorded before v2.0 have no `feet` field. They are shown
     without a side badge rather than being guessed at — a pre-v2 log
     genuinely does not know which foot it came from. */
  function sessionFeet(s) {
    if (Array.isArray(s.feet) && s.feet.length) return s.feet;
    return null;
  }

  function footTag(foot) {
    return foot === FOOT.LEFT ? 'L' : 'R';
  }

  function buildFootBadges(s) {
    const feet = sessionFeet(s);
    const wrap = document.createElement('span');
    wrap.className = 'log-feet';
    if (!feet) {
      const b = document.createElement('span');
      b.className = 'foot-tag legacy';
      b.textContent = '—';
      b.title = 'v2.0 이전 기록 (좌우 구분 없음)';
      wrap.appendChild(b);
      return wrap;
    }
    FOOT_IDS.forEach(f => {
      const on = feet.includes(f);
      const b = document.createElement('span');
      b.className = 'foot-tag' + (on ? ' on' : '');
      b.textContent = footTag(f);
      b.title = on
        ? `${FOOT_LABEL_KO[f]} 참여 · 품질 ${s.byFoot?.[f]?.quality ?? '--'}%`
        : `${FOOT_LABEL_KO[f]} 미참여`;
      wrap.appendChild(b);
    });
    return wrap;
  }

  function qualityColor(q) {
    return q >= 80 ? 'var(--color-ok)' : q >= 50 ? 'var(--color-alert-n)' : 'var(--color-alert-p)';
  }

  /* ── Cumulative stats banner ────────────────────────────── */
  function buildStatsPanel() {
    const stats   = store.cumulativeStats();
    const wrap    = document.createElement('div');
    wrap.className = 'log-stats-grid';

    const items = [
      { label: 'TOTAL SESSIONS', value: stats.totalSessions },
      { label: 'TOTAL TIME',     value: fmtDuration(stats.totalDuration) },
      { label: 'AVG QUALITY',    value: stats.avgQuality + '%' },
    ];

    items.forEach(item => {
      const blk = document.createElement('div');
      blk.className = 'stat-block';
      blk.innerHTML = `
        <span class="stat-label">${item.label}</span>
        <span class="stat-value mono">${item.value}</span>
      `;
      wrap.appendChild(blk);
    });

    return wrap;
  }

  /* ── Delete modal ───────────────────────────────────────── */
  function showDeleteModal(sessionId, title, date) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const titleEl = document.createElement('div');
    titleEl.className = 'modal-title';
    titleEl.textContent = '세션 삭제';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--text-dim);letter-spacing:.04em;margin-bottom:4px;';
    sub.textContent = `"${title}"  ·  ${date}`;

    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:11px;color:var(--color-alert-p);margin-top:4px;';
    warn.textContent = '삭제된 데이터는 복구할 수 없습니다.';

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-ghost';
    btnCancel.textContent = '취소';
    btnCancel.onclick = () => document.body.removeChild(overlay);

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'btn btn-danger';
    btnConfirm.textContent = '삭제';
    btnConfirm.onclick = () => {
      store.deleteSession(sessionId);
      document.body.removeChild(overlay);
      viewMode = 'list';
      renderList();
    };

    actions.appendChild(btnCancel);
    actions.appendChild(btnConfirm);
    modal.appendChild(titleEl);
    modal.appendChild(sub);
    modal.appendChild(warn);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /* ── Session list ───────────────────────────────────────── */
  /* ══════════════════════════════════════════════════════════
     조교 기록 — 리포트를 시간순으로 모아 보고, 그 옆에 그날의
     컨디션을 나란히 둔다. 리포트 한 건만 보면 "오늘 정확도 61%"가
     좋은 건지 나쁜 건지 알 수 없다. 에너지 3인 날의 61%와 에너지 9인
     날의 61%는 다른 이야기이고, 그 대비는 모아 놓아야만 보인다.
  ══════════════════════════════════════════════════════════ */

  function buildViewTabs(active) {
    const row = document.createElement('div');
    row.className = 'dir-toggle log-viewtabs';

    const mk = (label, mode) => {
      const b = document.createElement('button');
      b.className = 'dir-btn' + (active === mode ? ' selected-positive' : '');
      b.textContent = label;
      b.onclick = () => {
        if (active === mode) return;
        viewMode = mode;
        if (mode === 'coach') renderCoachLog(); else renderList();
      };
      return b;
    };

    row.appendChild(mk('세션', 'list'));
    row.appendChild(mk('조교 기록', 'coach'));
    return row;
  }

  /* 에너지와 정확도를 한 축에 겹쳐 그린다. 에너지는 1-10이라 10을
     곱해 정확도(%)와 같은 0-100 축에 올린다 — 절대값을 비교하려는
     게 아니라 두 곡선이 같이 움직이는지를 보려는 것이다. */
  function buildTrend(sessions) {
    const pts = sessions.slice(-14);
    if (pts.length < 2) return null;

    const STEP = 26, PAD = 10, H = 78, TOP = 8;
    const W = PAD * 2 + STEP * (pts.length - 1);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'coach-trend');
    svg.setAttribute('preserveAspectRatio', 'none');

    const y = v => TOP + (H - TOP - 14) * (1 - Math.max(0, Math.min(100, v)) / 100);
    const x = i => PAD + STEP * i;

    // baseline
    const base = document.createElementNS(ns, 'line');
    base.setAttribute('x1', 0); base.setAttribute('x2', W);
    base.setAttribute('y1', H - 13); base.setAttribute('y2', H - 13);
    base.setAttribute('class', 'trend-base');
    svg.appendChild(base);

    // quality bars
    pts.forEach((s, i) => {
      const q = s.quality ?? 0;
      const bar = document.createElementNS(ns, 'rect');
      bar.setAttribute('x', x(i) - 4);
      bar.setAttribute('y', y(q));
      bar.setAttribute('width', 8);
      bar.setAttribute('height', Math.max(1, (H - 13) - y(q)));
      bar.setAttribute('class', 'trend-bar ' + qualityClass(q));
      const t = document.createElementNS(ns, 'title');
      t.textContent = `${s.date} · 정확도 ${q}%`;
      bar.appendChild(t);
      svg.appendChild(bar);
    });

    // energy line + dots, only across sessions that recorded one
    const withEnergy = pts.map((s, i) => ({ i, e: s.record?.energy }))
                          .filter(o => typeof o.e === 'number');
    if (withEnergy.length >= 2) {
      const d = withEnergy.map((o, k) => `${k ? 'L' : 'M'}${x(o.i)},${y(o.e * 10)}`).join(' ');
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', 'trend-energy');
      svg.appendChild(path);
    }
    withEnergy.forEach(o => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', x(o.i));
      c.setAttribute('cy', y(o.e * 10));
      c.setAttribute('r', 2.6);
      c.setAttribute('class', 'trend-dot');
      const t = document.createElementNS(ns, 'title');
      t.textContent = `에너지 ${o.e}/10`;
      c.appendChild(t);
      svg.appendChild(c);
    });

    return svg;
  }

  function envLabel(env) {
    return env === 'indoor' ? '실내' : env === 'outdoor' ? '실외' : null;
  }

  function chip(text, cls) {
    const el = document.createElement('span');
    el.className = 'coach-chip' + (cls ? ' ' + cls : '');
    el.textContent = text;
    return el;
  }

  function renderCoachLog() {
    panel.innerHTML = '';
    panel.appendChild(buildViewTabs('coach'));

    const all = store.getSessions();
    // 리포트가 있는 세션만 피드에 올린다. 추이는 리포트 유무와
    // 무관하게 전체 세션으로 그린다 — 건너뛴 날도 흐름의 일부다.
    const withReport = all.filter(s => s.report && s.report.text).reverse();

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = '컨디션 · 정확도 추이';
    panel.appendChild(heading);

    const trend = buildTrend(all);
    if (trend) {
      const box = document.createElement('div');
      box.className = 'coach-trend-box';
      box.appendChild(trend);
      panel.appendChild(box);

      const legend = document.createElement('div');
      legend.className = 'coach-legend';
      legend.innerHTML =
        '<span class="lg-bar"></span> 정확도 &nbsp;&nbsp;' +
        '<span class="lg-dot"></span> 에너지 (10배 환산)';
      panel.appendChild(legend);
    } else {
      const note = document.createElement('div');
      note.className = 'empty-state';
      note.style.padding = 'var(--gap-md)';
      note.textContent = '세션이 2건 이상 쌓이면 추이가 표시됩니다.';
      panel.appendChild(note);
    }

    // 요약
    const energies = all.map(s => s.record?.energy).filter(e => typeof e === 'number');
    const avgE = energies.length
      ? Math.round(energies.reduce((a, b) => a + b, 0) / energies.length * 10) / 10 : null;
    const qs = all.map(s => s.quality ?? 0);
    const avgQ = qs.length ? Math.round(qs.reduce((a, b) => a + b, 0) / qs.length) : null;

    const summary = document.createElement('div');
    summary.className = 'coach-summary';
    summary.textContent =
      `리포트 ${withReport.length}건` +
      (avgE !== null ? `  ·  평균 에너지 ${avgE}/10` : '') +
      (avgQ !== null ? `  ·  평균 정확도 ${avgQ}%` : '');
    panel.appendChild(summary);

    const h2 = document.createElement('div');
    h2.className = 'section-heading';
    h2.textContent = '조교 피드백';
    panel.appendChild(h2);

    if (!withReport.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '아직 받은 리포트가 없습니다.<br>' +
        '<span style="font-size:11px;opacity:.6">세션 종료 후 &quot;리포트 받기&quot;를 누르면 여기에 쌓입니다.</span>';
      panel.appendChild(empty);
      return;
    }

    const feed = document.createElement('div');
    feed.className = 'coach-feed';

    withReport.forEach(s => {
      const card = document.createElement('div');
      card.className = 'card card-sm coach-entry';
      card.onclick = () => { cameFromCoach = true; detailId = s.sessionId; viewMode = 'detail'; renderDetail(s); };

      const head = document.createElement('div');
      head.className = 'coach-entry-head';

      const when = document.createElement('span');
      when.className = 'coach-entry-date';
      when.textContent = s.date;
      head.appendChild(when);

      const title = document.createElement('span');
      title.className = 'coach-entry-title';
      title.textContent = s.drillTitle;
      head.appendChild(title);

      const q = document.createElement('span');
      q.className = 'coach-entry-q ' + qualityClass(s.quality ?? 0);
      q.textContent = (s.quality ?? 0) + '%';
      head.appendChild(q);

      card.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'coach-chips';
      if (typeof s.record?.energy === 'number') chips.appendChild(chip('에너지 ' + s.record.energy + '/10'));
      const env = envLabel(s.record?.environment);
      if (env) chips.appendChild(chip(env));
      if (s.report.source !== 'openai') chips.appendChild(chip('로컬', 'dim'));
      if (chips.children.length) card.appendChild(chips);

      const row = document.createElement('div');
      row.className = 'coach-entry-body';

      const face = document.createElement('span');
      face.className = 'coach-face sm';
      face.textContent = coach.renderFace(s.report.face);
      face.title = coach.FACES[s.report.face] || '';
      row.appendChild(face);

      const text = document.createElement('span');
      text.className = 'coach-text';
      text.textContent = s.report.text;
      row.appendChild(text);

      card.appendChild(row);

      if (s.record?.note) {
        const n = document.createElement('div');
        n.className = 'coach-entry-note';
        n.textContent = '특이사항 — ' + s.record.note;
        card.appendChild(n);
      }

      feed.appendChild(card);
    });

    panel.appendChild(feed);
  }

  /* ── 백업 / 복원 ─────────────────────────────────────────
     기록이 이 브라우저의 localStorage에만 있다. 브라우저 데이터를
     지우거나 폰을 바꾸면 그대로 사라지므로, 파일 하나로 빼둘 수
     있어야 한다. 실측을 다시 하는 것보다 훨씬 싸다. */
  function buildBackupRow() {
    const row = document.createElement('div');
    row.className = 'log-backup-row';

    const btnExport = document.createElement('button');
    btnExport.className = 'btn btn-ghost';
    btnExport.textContent = '⭳ 내보내기';
    btnExport.onclick = () => {
      const data = store.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      a.download = `onyx-sdi_${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      app.showToast(`세션 ${data.sessions.length}건 · 동작 ${data.drills.length}개 내보냈습니다`);
    };

    const btnImport = document.createElement('button');
    btnImport.className = 'btn btn-ghost';
    btnImport.textContent = '⭱ 가져오기';
    const file = document.createElement('input');
    file.type = 'file';
    file.accept = 'application/json,.json';
    file.style.display = 'none';
    file.onchange = async () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      try {
        const parsed = JSON.parse(await f.text());
        // 덮어쓰지 않고 합친다. 같은 id는 건너뛰므로 두 번 넣어도 안전하다.
        const r = store.importAll(parsed);
        app.showToast(`세션 ${r.sessions}건 · 동작 ${r.drills}개 추가 (중복 ${r.skipped}건 건너뜀)`);
        renderList();
      } catch (err) {
        app.showToast('가져오기 실패 — ' + (err.message || err));
      }
    };
    btnImport.onclick = () => file.click();

    const note = document.createElement('span');
    note.className = 'log-backup-note';
    note.textContent = 'API 키는 백업에 포함되지 않습니다';

    row.appendChild(btnExport);
    row.appendChild(btnImport);
    row.appendChild(file);
    row.appendChild(note);
    return row;
  }

  function renderList() {
    panel.innerHTML = '';
    panel.appendChild(buildViewTabs('list'));

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = '누적 통계';
    panel.appendChild(heading);
    panel.appendChild(buildStatsPanel());
    panel.appendChild(buildBackupRow());

    const heading2 = document.createElement('div');
    heading2.className = 'section-heading';
    heading2.textContent = '세션 히스토리';
    panel.appendChild(heading2);

    const sessions = store.getSessions().slice().reverse();

    if (!sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = '아직 완료된 세션이 없습니다.<br>TRAINING 탭에서 훈련을 시작하세요.';
      panel.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'log-list';

    sessions.forEach(s => {
      const row = document.createElement('div');
      row.className = 'log-row';

      const titleEl = document.createElement('div');
      titleEl.className = 'log-row-title';
      titleEl.textContent = s.drillTitle || '(알 수 없음)';

      const dateEl = document.createElement('div');
      dateEl.className = 'log-row-date';
      dateEl.textContent = s.date;

      const subEl = document.createElement('div');
      subEl.className = 'log-row-sub';
      const typeLabel = DRILL_TYPES[s.drillType]?.label || s.drillType || '';
      subEl.textContent = `${typeLabel}  ·  ${fmtDuration(s.duration || 0)}  ·  경고 ${s.alertCount || 0}회`;
      subEl.appendChild(buildFootBadges(s));

      const qEl = document.createElement('div');
      qEl.className = 'log-quality mono';
      qEl.style.color = qualityColor(s.quality || 0);

      // Two-foot sessions show both figures: an average would hide a
      // session where one foot was clean and the other was not.
      const feet = sessionFeet(s);
      if (feet && feet.length === 2 && s.byFoot) {
        qEl.textContent = `${s.byFoot.left?.quality ?? '--'}/${s.byFoot.right?.quality ?? '--'}%`;
        qEl.style.fontSize = '13px';
      } else {
        qEl.textContent = (s.quality ?? '--') + '%';
      }

      row.appendChild(titleEl);
      row.appendChild(dateEl);
      row.appendChild(subEl);
      row.appendChild(qEl);

      row.onclick = () => {
        detailId = s.sessionId;
        cameFromCoach = false;
        viewMode = 'detail';
        renderDetail(s);
      };

      // Delete button (quick × on row)
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-row-delete';
      delBtn.textContent = '×';
      delBtn.title = '세션 삭제';
      delBtn.onclick = (e) => {
        e.stopPropagation();
        showDeleteModal(s.sessionId, s.drillTitle, s.date);
      };
      row.appendChild(delBtn);

      list.appendChild(row);
    });

    panel.appendChild(list);
  }

  /* ── Session detail ─────────────────────────────────────── */
  function renderDetail(s) {
    panel.innerHTML = '';

    // Back button
    const back = document.createElement('div');
    back.className = 'detail-back';
    back.innerHTML = '‹ 목록으로';
    // Return to whichever list the user came from.
    const cameFrom = viewMode === 'detail' && cameFromCoach ? 'coach' : 'list';
    back.onclick = () => {
      viewMode = cameFrom;
      if (cameFrom === 'coach') renderCoachLog(); else renderList();
    };
    panel.appendChild(back);

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'card card-sm';
    hdr.style.display = 'flex';
    hdr.style.flexDirection = 'column';
    hdr.style.gap = 'var(--gap-xs)';

    const titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex;align-items:center;gap:var(--gap-sm);';
    const titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-weight:700;font-size:16px;flex:1;';
    titleEl.textContent = s.drillTitle || '세션';
    const badge = document.createElement('span');
    badge.className = `badge badge-${s.drillType || 'custom'}`;
    badge.textContent = DRILL_TYPES[s.drillType]?.label || s.drillType || '';
    titleRow.appendChild(titleEl);
    titleRow.appendChild(badge);

    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-danger';
    btnDel.style.cssText = 'font-size:11px;padding:2px 8px;margin-left:auto;';
    btnDel.textContent = '삭제';
    btnDel.onclick = () => showDeleteModal(s.sessionId, s.drillTitle, s.date);
    titleRow.appendChild(btnDel);

    const metaEl = document.createElement('div');
    metaEl.style.cssText = 'font-size:11px;color:var(--text-dim);font-family:var(--font-mono);';
    metaEl.textContent = `${s.date}  ·  ${fmtDuration(s.duration || 0)}  ·  경고 ${s.alertCount || 0}회`;

    hdr.appendChild(titleRow);
    hdr.appendChild(metaEl);
    panel.appendChild(hdr);

    // Key stats
    const statsGrid = document.createElement('div');
    statsGrid.className = 'live-stats';
    [
      { label: 'DURATION', value: fmtDuration(s.duration || 0) },
      { label: 'ALERTS',   value: s.alertCount || 0 },
      { label: 'QUALITY',  value: (s.quality ?? '--') + '%' },
    ].forEach(item => {
      const blk = document.createElement('div');
      blk.className = 'stat-block';
      blk.innerHTML = `<span class="stat-label">${item.label}</span>
        <span class="stat-value mono ${item.label === 'QUALITY' ? qualityClass(s.quality) : ''}">${item.value}</span>`;
      statsGrid.appendChild(blk);
    });
    panel.appendChild(statsGrid);

    // ── Per-foot breakdown ───────────────────────────────────────
    const feet = sessionFeet(s);
    if (feet && s.byFoot) {
      const fHeading = document.createElement('div');
      fHeading.className = 'section-heading';
      fHeading.textContent = '좌우 구분';
      panel.appendChild(fHeading);

      const fList = document.createElement('div');
      fList.className = 'log-foot-list';

      FOOT_IDS.forEach(f => {
        const data = s.byFoot[f];
        const row  = document.createElement('div');
        row.className = 'log-foot-row' + (data ? '' : ' off');

        const tag = document.createElement('span');
        tag.className = 'foot-tag' + (data ? ' on' : '');
        tag.textContent = footTag(f);

        const name = document.createElement('span');
        name.className = 'log-foot-name';
        name.textContent = FOOT_LABEL_KO[f];

        const meta = document.createElement('span');
        meta.className = 'log-foot-meta';

        const q = document.createElement('span');
        q.className = 'log-foot-q mono';

        if (!data) {
          meta.textContent = '미참여';
          q.textContent = '—';
        } else {
          const joined = data.joinedAt ? `  ·  ${fmtDuration(data.joinedAt)} 합류` : '';
          meta.textContent = `경고 ${data.alertCount || 0}회  ·  ${data.samples || 0} 샘플${joined}`;
          q.textContent = (data.quality ?? '--') + '%';
          q.style.color = qualityColor(data.quality || 0);
        }

        row.appendChild(tag);
        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(q);
        fList.appendChild(row);
      });

      panel.appendChild(fList);

      // Per-point averages, side by side, for two-foot sessions.
      const bothFeet = feet.length === 2;
      if (bothFeet) {
        const pHeading = document.createElement('div');
        pHeading.className = 'section-heading';
        pHeading.textContent = '압점별 평균 (좌 / 우)';
        panel.appendChild(pHeading);

        const pList = document.createElement('div');
        pList.className = 'log-foot-list';

        const pids = new Set([
          ...Object.keys(s.byFoot.left?.pointStats || {}),
          ...Object.keys(s.byFoot.right?.pointStats || {}),
        ]);

        [...pids].sort().forEach(pid => {
          const l = s.byFoot.left?.pointStats?.[pid];
          const r = s.byFoot.right?.pointStats?.[pid];
          const row = document.createElement('div');
          row.className = 'log-foot-row';

          const idEl = document.createElement('span');
          idEl.className = 'log-pt-id mono';
          idEl.textContent = pid;

          const nameEl = document.createElement('span');
          nameEl.className = 'log-foot-name';
          nameEl.textContent = PRESSURE_POINTS[pid]?.label || pid;

          const valEl = document.createElement('span');
          valEl.className = 'log-foot-meta mono';
          valEl.textContent = `${l ? l.avg : '--'} / ${r ? r.avg : '--'}`;

          const alertEl = document.createElement('span');
          alertEl.className = 'log-foot-q mono';
          alertEl.style.color = 'var(--color-alert-p)';
          const la = l?.alertCount || 0;
          const ra = r?.alertCount || 0;
          alertEl.textContent = (la || ra) ? `⚠ ${la}/${ra}` : '';

          row.appendChild(idEl);
          row.appendChild(nameEl);
          row.appendChild(valEl);
          row.appendChild(alertEl);
          pList.appendChild(row);
        });

        panel.appendChild(pList);
      }
    }

    // Per-point stats (session-wide; the only view for pre-v2 logs)
    if (s.pointStats && Object.keys(s.pointStats).length && !(feet && feet.length === 2)) {
      const heading = document.createElement('div');
      heading.className = 'section-heading';
      heading.textContent = '압점별 평균';
      panel.appendChild(heading);

      const ptList = document.createElement('div');
      ptList.style.display = 'flex';
      ptList.style.flexDirection = 'column';
      ptList.style.gap = 'var(--gap-xs)';

      Object.entries(s.pointStats).forEach(([pid, stat]) => {
        const pp  = PRESSURE_POINTS[pid];
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:var(--gap-sm);padding:6px var(--gap-md);background:var(--bg-card);border:1px solid var(--border);';

        const idEl = document.createElement('span');
        idEl.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-muted);width:28px;';
        idEl.textContent = pid;

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-size:12px;color:var(--text-dim);flex:1;';
        nameEl.textContent = pp?.label || pid;

        const avgEl = document.createElement('span');
        avgEl.style.cssText = 'font-family:var(--font-mono);font-size:12px;';
        avgEl.textContent = `avg ${stat.avg}`;

        const alertEl = document.createElement('span');
        alertEl.style.cssText = 'font-size:11px;color:var(--color-alert-p);font-family:var(--font-mono);min-width:50px;text-align:right;';
        alertEl.textContent = stat.alertCount ? `⚠ ${stat.alertCount}` : '';

        row.appendChild(idEl);
        row.appendChild(nameEl);
        row.appendChild(avgEl);
        row.appendChild(alertEl);
        ptList.appendChild(row);
      });

      panel.appendChild(ptList);
    }

    // Alert timeline (simplified)
    if (s.alertTimeline?.length) {
      const heading = document.createElement('div');
      heading.className = 'section-heading';
      heading.textContent = `경고 타임라인 (${s.alertTimeline.length}건)`;
      panel.appendChild(heading);

      const tl = document.createElement('div');
      tl.style.cssText = 'display:flex;flex-direction:column;gap:2px;max-height:160px;overflow-y:auto;';

      // Group by second to reduce noise
      const grouped = {};
      s.alertTimeline.forEach(a => {
        const key = a.time;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(a);
      });

      Object.entries(grouped).slice(0, 50).forEach(([t, alerts]) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:var(--gap-sm);font-size:11px;font-family:var(--font-mono);color:var(--text-dim);';
        const time = document.createElement('span');
        time.style.color = 'var(--text-muted)';
        time.textContent = fmtDuration(parseInt(t));
        const pts = document.createElement('span');
        // Alerts carry their foot since v2.0; older entries have none.
        pts.textContent = alerts
          .map(a => (a.foot ? `[${footTag(a.foot)}]` : '') + a.pointId)
          .join(' ');
        const type = document.createElement('span');
        type.style.marginLeft = 'auto';
        const hasNeg = alerts.some(a => a.type === 'negative' || a.type === 'gait');
        type.style.color = hasNeg ? 'var(--color-alert-n)' : 'var(--color-alert-p)';
        type.textContent = hasNeg ? '▼' : '▲';
        row.appendChild(time);
        row.appendChild(pts);
        row.appendChild(type);
        tl.appendChild(row);
      });

      panel.appendChild(tl);
    }

    // Memo
    /* 원시 스트림이 이 세션에 남아 있는지. 실착 테스트 중에는 이게
       채워지는지 눈으로 확인할 수 있어야 한다 — 나중에 열어보고
       비어 있으면 측정을 다시 해야 하기 때문이다. */
    if (s.raw) {
      const rawRow = document.createElement('div');
      rawRow.className = 'log-raw-note';
      const counts = FOOT_IDS
        .filter(f => Array.isArray(s.raw[f]))
        .map(f => `${FOOT_LABEL[f]} ${s.raw[f].length.toLocaleString()}`)
        .join('  ·  ');
      const truncated = FOOT_IDS.some(f => s.byFoot?.[f]?.rawTruncated);
      rawRow.textContent = `원시 기록 ${counts} 샘플 @${s.raw.hz}Hz` +
                           (truncated ? '  ⚠ 상한 도달로 일부만 기록됨' : '');
      panel.appendChild(rawRow);
    }

    /* ── 세션 기록 + AI 조교 리포트 ─────────────────────────
       Both are optional and both are written after the session was
       already saved, so old logs simply render without this block. */
    if (s.record && (s.record.energy !== null || s.record.environment || s.record.note)) {
      const recHeading = document.createElement('div');
      recHeading.className = 'section-heading';
      recHeading.textContent = '세션 기록';
      panel.appendChild(recHeading);

      const recRow = document.createElement('div');
      recRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:var(--gap-sm);padding:var(--gap-sm) 0;font-size:12px;color:var(--text-dim);';

      if (s.record.energy !== null && s.record.energy !== undefined) {
        const e = document.createElement('span');
        e.style.fontFamily = 'var(--font-mono)';
        e.textContent = '에너지 ' + s.record.energy + '/10';
        recRow.appendChild(e);
      }
      if (s.record.environment) {
        const e = document.createElement('span');
        e.textContent = s.record.environment === 'indoor' ? '실내' : '실외';
        recRow.appendChild(e);
      }
      panel.appendChild(recRow);

      if (s.record.note) {
        const n = document.createElement('div');
        n.style.cssText = 'font-size:13px;color:var(--text-dim);line-height:1.7;padding-bottom:var(--gap-sm);';
        n.textContent = s.record.note;
        panel.appendChild(n);
      }
    }

    if (s.report && s.report.text) {
      const card = document.createElement('div');
      card.className = 'card card-sm coach-card';

      const head = document.createElement('div');
      head.className   = 'coach-head';
      head.textContent = '▶ SDI REPORT';
      card.appendChild(head);

      const face = document.createElement('div');
      face.className   = 'coach-face';
      face.textContent = coach.renderFace(s.report.face);
      face.title       = coach.FACES[s.report.face] || '';
      card.appendChild(face);

      const body = document.createElement('div');
      body.className   = 'coach-text';
      body.textContent = s.report.text;
      card.appendChild(body);

      const meta = document.createElement('div');
      meta.className   = 'coach-meta';
      meta.textContent = s.report.source === 'openai'
        ? String(s.report.model)
        : '로컬 리포트';
      card.appendChild(meta);

      panel.appendChild(card);
    }

    const memoHeading = document.createElement('div');
    memoHeading.className = 'section-heading';
    memoHeading.textContent = '메모';
    panel.appendChild(memoHeading);

    const memoEl = document.createElement('div');
    memoEl.style.cssText = 'font-size:13px;color:var(--text-dim);padding:var(--gap-sm) 0;min-height:32px;';
    memoEl.textContent = s.memo || '(메모 없음)';
    panel.appendChild(memoEl);
  }

  return {
    init(panelEl) { panel = panelEl; },

    render() {
      viewMode = 'list';
      renderList();
    },
  };
})();
