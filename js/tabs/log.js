const logTab = (() => {
  let panel     = null;
  let viewMode  = 'list';   // 'list' | 'detail'
  let detailId  = null;

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
  function renderList() {
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = '누적 통계';
    panel.appendChild(heading);
    panel.appendChild(buildStatsPanel());

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
    back.onclick = () => { viewMode = 'list'; renderList(); };
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
