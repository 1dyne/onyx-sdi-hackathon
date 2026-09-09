const trainingTab = (() => {
  let panel    = null;
  let onStart  = null;  // callback (drill) → void

  /* ── Placement alert modal ──────────────────────────────── */
  function showPlacementModal(drill, onConfirm) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'FSR 배치 확인';

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:12px;color:var(--text-dim);letter-spacing:.04em;';
    sub.textContent = '다음 위치에 센서를 배치했는지 확인하세요.';

    const list = document.createElement('div');
    list.className = 'modal-pt-list';

    drill.points.forEach(pt => {
      const pp = PRESSURE_POINTS[pt.id];
      const row = document.createElement('div');
      row.className = 'modal-pt-row';

      const idBadge = document.createElement('span');
      idBadge.className = 'modal-pt-id';
      idBadge.textContent = pt.id;

      const info = document.createElement('span');
      info.textContent = `${pp.name} — ${pp.label}`;

      const dir = document.createElement('span');
      dir.style.cssText = 'margin-left:auto;font-size:11px;font-family:var(--font-mono);';
      dir.style.color = pt.direction === 'positive'
        ? 'var(--color-ok)'
        : 'var(--color-alert-n)';
      dir.textContent = pt.direction === 'positive' ? '▲ THR' : '▼ THR';

      row.appendChild(idBadge);
      row.appendChild(info);
      row.appendChild(dir);
      list.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-ghost';
    btnCancel.textContent = '취소';
    btnCancel.onclick = () => document.body.removeChild(overlay);

    const btnStart = document.createElement('button');
    btnStart.className = 'btn btn-ok';
    btnStart.textContent = '훈련 시작';
    btnStart.onclick = () => {
      document.body.removeChild(overlay);
      onConfirm();
    };

    actions.appendChild(btnCancel);
    actions.appendChild(btnStart);

    modal.appendChild(title);
    modal.appendChild(sub);
    modal.appendChild(list);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /* ── Drill card ─────────────────────────────────────────── */
  function buildDrillCard(drill) {
    const card = document.createElement('div');
    card.className = 'drill-card';

    const info = document.createElement('div');
    info.className = 'drill-card-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'drill-card-title';
    titleEl.textContent = drill.title;

    const sub = document.createElement('div');
    sub.className = 'drill-card-sub';
    const typeLabel = DRILL_TYPES[drill.type]?.label || drill.type;
    const ptNames   = drill.points.map(p => p.id).join(' · ');
    sub.textContent = `${typeLabel}  ·  ${ptNames}`;
    if(drill.referenceReviewRequired)sub.textContent+=' · 등록 완료 / 훈련 목표 설정 대기';

    const badge = document.createElement('span');
    badge.className = `badge badge-${drill.type}`;
    badge.style.marginLeft = 'auto';
    badge.style.flexShrink = '0';
    badge.textContent = typeLabel;

    const arrow = document.createElement('span');
    arrow.className = 'drill-card-arrow';
    arrow.textContent = '›';

    info.appendChild(titleEl);
    info.appendChild(sub);
    card.appendChild(info);
    card.appendChild(badge);
    card.appendChild(arrow);

    card.onclick = () => {
      if(drill.referenceReviewRequired){app.showToast('등록 데이터는 보존되었습니다. 동작 단계별 훈련 목표를 설정한 뒤 훈련에 사용합니다.');return;}
      if (session.isActive) {
        alert('진행 중인 세션을 먼저 종료해주세요.');
        return;
      }
      onStart?.(drill);
    };

    return card;
  }

  /* ── Render ─────────────────────────────────────────────── */
  function render() {
    panel.innerHTML = '';

    // Header row
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.style.borderBottom = 'none';
    heading.textContent = '등록된 동작';

    const btnNew = document.createElement('button');
    btnNew.className = 'btn btn-ghost';
    btnNew.style.fontSize = '11px';
    btnNew.textContent = '+ 새 동작';
    btnNew.onclick = () => document.querySelector('.tab-btn[data-tab="config"]')?.click();

    hdr.appendChild(heading);
    hdr.appendChild(btnNew);
    panel.appendChild(hdr);

    const drills = store.getDrills();

    if (!drills.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML = 'CONFIG 탭에서<br>새 훈련 동작을 등록하세요.';
      panel.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.className = 'drill-list';
    drills.forEach(d => list.appendChild(buildDrillCard(d)));
    panel.appendChild(list);
  }

  return {
    init(panelEl, startCallback) {
      panel   = panelEl;
      onStart = startCallback;
    },

    render,
  };
})();
