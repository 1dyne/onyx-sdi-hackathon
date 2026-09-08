const configTab = (() => {
  let panel   = null;
  let onSaved = null;  // callback () → void

  // Wizard state
  let draft = {};
  let step  = 0;       // 0 = hub, 1-3 = wizard steps

  function resetDraft() {
    draft = {
      id:                 null,
      title:              '',
      type:               'static',
      points:             [],
      channels:           [],
      showPlacementAlert: true,
      // FREE CAPTURE snapshot, per foot: { left: {values, imu}|null, right: ... }
      captured:           null,
      baseline:           null,
    };
  }

  /* ── Reference helpers ─────────────────────────────────────
     `reference` is { left, right } since v2.0. A drill only needs a
     reference on ONE foot for percent mode to be usable — the other
     foot falls back to its absolute threshold (see alert.js). */
  function anyReference(pt) {
    return FOOT_IDS.some(f => alertEngine.getReference(pt, f) !== null);
  }

  function referenceLabel(pt) {
    const parts = FOOT_IDS
      .map(f => {
        const v = alertEngine.getReference(pt, f);
        return v === null ? null : `${f === FOOT.LEFT ? 'L' : 'R'} ${v}`;
      })
      .filter(Boolean);
    return parts.length ? parts.join(' · ') : '없음';
  }

  /* The foot a capture-derived threshold should be based on. */
  function primaryCapturedFoot() {
    if (!draft.captured) return null;
    return FOOT_IDS.find(f => draft.captured[f]) || null;
  }

  function makeDefaultPoint(pid) {
    return {
      id:         pid,
      thr:        PRESSURE_POINTS[pid].defaultDirection === 'positive' ? 300 : 150,
      direction:  PRESSURE_POINTS[pid].defaultDirection,
      reference:  { left: null, right: null },
      thrMode:    'absolute',
      thrPercent: 80,
    };
  }

  /* Creates a point pre-filled from a FREE CAPTURE snapshot. Each foot
     that was connected during the capture contributes its own
     reference; the absolute threshold is derived from whichever foot
     was captured first so a one-foot capture still yields a usable
     drill. */
  function makeCapturedPoint(pid) {
    const idx       = draft.channels.indexOf(pid);
    const reference = { left: null, right: null };

    for (const f of FOOT_IDS) {
      const snap = draft.captured?.[f];
      if (!snap) continue;
      const v = Math.round(Math.max(0, (snap.values[idx] ?? 0) - (draft.baseline?.[f]?.[idx] ?? 0)));
      if (v > 0) reference[f] = v;
    }

    const primary = primaryCapturedFoot();
    const baseVal = primary ? (reference[primary] ?? 0) : 0;
    const hasRef  = reference.left !== null || reference.right !== null;

    return {
      id:         pid,
      thr:        Math.round(baseVal * 0.8),
      direction:  PRESSURE_POINTS[pid].defaultDirection,
      reference,
      thrMode:    hasRef ? 'percent' : 'absolute',
      thrPercent: 80,
    };
  }

  /* ── Step indicator (3 steps) ───────────────────────────── */
  function buildStepDots(current) {
    const wrap = document.createElement('div');
    wrap.className = 'wizard-steps';
    for (let i = 1; i <= 3; i++) {
      const d = document.createElement('div');
      d.className = 'wizard-step-dot ' + (i < current ? 'done' : i === current ? 'active' : '');
      wrap.appendChild(d);
    }
    return wrap;
  }

  /* ══════════════════════════════════════════════════════════
     HUB VIEW — 저장된 동작 목록 + 오디오 설정
  ══════════════════════════════════════════════════════════ */
  function renderHub() {
    step = 0;
    panel.innerHTML = '';

    /* ── DRILLS 섹션 ───────────────────────────────────────── */
    const drillsHdr = document.createElement('div');
    drillsHdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--gap-sm);';

    const drillsTitle = document.createElement('div');
    drillsTitle.className = 'section-heading';
    drillsTitle.style.borderBottom = 'none';
    drillsTitle.textContent = 'DRILLS';

    const btnNew = document.createElement('button');
    btnNew.className = 'btn btn-primary';
    btnNew.style.fontSize = '11px';
    btnNew.style.padding  = '6px 12px';
    btnNew.textContent = '+ 새 동작';
    btnNew.onclick = () => {
      resetDraft();
      step = 1;
      renderStep1();
    };

    drillsHdr.appendChild(drillsTitle);
    drillsHdr.appendChild(btnNew);
    panel.appendChild(drillsHdr);

    const drills = store.getDrills();

    if (!drills.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.style.padding = 'var(--gap-lg) var(--gap-md)';
      empty.innerHTML = '등록된 동작이 없습니다.<br><span style="font-size:11px;opacity:.6">+ 새 동작 버튼으로 추가하세요.</span>';
      panel.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      list.style.gap = 'var(--gap-sm)';

      drills.forEach(drill => {
        const row = document.createElement('div');
        row.className = 'card card-sm';
        row.style.cssText = 'display:flex;align-items:center;gap:var(--gap-sm);';

        const info = document.createElement('div');
        info.style.flex = '1';
        info.style.minWidth = '0';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        titleEl.textContent = drill.title;

        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:10px;color:var(--text-muted);font-family:var(--font-mono);margin-top:2px;letter-spacing:.06em;';
        sub.textContent = `${DRILL_TYPES[drill.type]?.label || drill.type}  ·  ${drill.points.map(p => p.id).join(' ')}`;

        info.appendChild(titleEl);
        info.appendChild(sub);

        const badge = document.createElement('span');
        badge.className = `badge badge-${drill.type}`;
        badge.style.flexShrink = '0';
        badge.textContent = DRILL_TYPES[drill.type]?.label || drill.type;

        // ✏️ Edit
        const btnEdit = document.createElement('button');
        btnEdit.className = 'btn-icon';
        btnEdit.title = '수정';
        btnEdit.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
        btnEdit.onclick = (e) => {
          e.stopPropagation();
          editDrill(drill);
        };

        // 🗑️ Delete
        const btnDel = document.createElement('button');
        btnDel.className = 'btn-icon';
        btnDel.style.color = 'var(--color-alert-p)';
        btnDel.style.borderColor = 'transparent';
        btnDel.title = '삭제';
        btnDel.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
        btnDel.onclick = (e) => {
          e.stopPropagation();
          if (!confirm(`"${drill.title}" 동작을 삭제할까요?`)) return;
          store.deleteDrill(drill.id);
          renderHub();
        };

        row.appendChild(info);
        row.appendChild(badge);
        row.appendChild(btnEdit);
        row.appendChild(btnDel);
        list.appendChild(row);
      });

      panel.appendChild(list);
    }

    /* ── AUDIO 설정 섹션 ────────────────────────────────────── */
    const audioDiv = document.createElement('div');
    audioDiv.style.marginTop = 'var(--gap-lg)';

    const audioHdr = document.createElement('div');
    audioHdr.className = 'section-heading';
    audioHdr.style.marginBottom = 'var(--gap-sm)';
    audioHdr.textContent = 'AUDIO';
    audioDiv.appendChild(audioHdr);

    const cfg = store.getSettings();

    /* 경고음 card */
    const alertCard = document.createElement('div');
    alertCard.className = 'card card-sm';
    alertCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);margin-bottom:var(--gap-sm);';

    // 경고음 활성화 토글
    const alertToggleRow = buildToggleRow(
      '경고음 사용',
      cfg.alertSoundEnabled !== false,
      (checked) => store.saveSettings({ alertSoundEnabled: checked }),
    );
    alertCard.appendChild(alertToggleRow);

    // 볼륨 슬라이더 + TEST 버튼
    const volLbl = document.createElement('div');
    volLbl.className = 'form-label';
    volLbl.textContent = '음량';
    alertCard.appendChild(volLbl);

    const volRow = document.createElement('div');
    volRow.className = 'slider-row';
    const volSlider = document.createElement('input');
    volSlider.type  = 'range';
    volSlider.min   = 0;
    volSlider.max   = 100;
    volSlider.value = Math.round((cfg.audioVolume ?? 0.5) * 100);
    const volVal = document.createElement('span');
    volVal.className = 'slider-val';
    volVal.textContent = volSlider.value;
    volSlider.addEventListener('input', () => {
      volVal.textContent = volSlider.value;
      store.saveSettings({ audioVolume: parseInt(volSlider.value) / 100 });
    });
    // Separate L / R test buttons: the only way to confirm the stereo
    // cue actually lands on the correct side on this device.
    const btnTestL = document.createElement('button');
    btnTestL.className = 'btn btn-ghost';
    btnTestL.style.cssText = 'font-size:11px;padding:4px 8px;white-space:nowrap;flex-shrink:0;';
    btnTestL.textContent = '▶ L';
    btnTestL.title = '왼발 경고음 테스트';
    btnTestL.onclick = () => audio.test('positive', FOOT.LEFT);

    const btnTestR = document.createElement('button');
    btnTestR.className = 'btn btn-ghost';
    btnTestR.style.cssText = 'font-size:11px;padding:4px 8px;white-space:nowrap;flex-shrink:0;';
    btnTestR.textContent = '▶ R';
    btnTestR.title = '오른발 경고음 테스트';
    btnTestR.onclick = () => audio.test('positive', FOOT.RIGHT);

    volRow.appendChild(volSlider);
    volRow.appendChild(volVal);
    volRow.appendChild(btnTestL);
    volRow.appendChild(btnTestR);
    alertCard.appendChild(volRow);

    // 좌우 스테레오 구분
    alertCard.appendChild(buildToggleRow(
      '좌우 스테레오 구분',
      cfg.audioStereo !== false,
      (checked) => store.saveSettings({ audioStereo: checked }),
    ));

    const stereoHint = document.createElement('div');
    stereoHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    stereoHint.textContent =
      '경고음 종류는 5종 그대로이고, 왼발은 좌측 채널·오른발은 우측 채널로 재생됩니다. ' +
      '스피커(모노)에서도 구분되도록 오른발은 음이 약간 높습니다.';
    alertCard.appendChild(stereoHint);

    audioDiv.appendChild(alertCard);

    /* 성공음 card */
    const sucCard = document.createElement('div');
    sucCard.className = 'card card-sm';
    sucCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    // 성공음 토글
    const sucToggleRow = buildToggleRow(
      '성공음 사용',
      cfg.successSoundEnabled !== false,
      (checked) => {
        store.saveSettings({ successSoundEnabled: checked });
        sucThrSlider.disabled = !checked;
      },
    );
    sucCard.appendChild(sucToggleRow);

    const sucLbl = document.createElement('div');
    sucLbl.className = 'form-label';
    sucLbl.textContent = '성공 기준 (정확도 %)';
    sucCard.appendChild(sucLbl);

    const sucThrRow = document.createElement('div');
    sucThrRow.className = 'slider-row';
    const sucThrSlider = document.createElement('input');
    sucThrSlider.type     = 'range';
    sucThrSlider.min      = 70;
    sucThrSlider.max      = 100;
    sucThrSlider.value    = cfg.successThreshold ?? 90;
    sucThrSlider.disabled = !(cfg.successSoundEnabled !== false);
    const sucThrVal = document.createElement('span');
    sucThrVal.className   = 'slider-val';
    sucThrVal.textContent = sucThrSlider.value + '%';
    sucThrSlider.addEventListener('input', () => {
      sucThrVal.textContent = sucThrSlider.value + '%';
      store.saveSettings({ successThreshold: parseInt(sucThrSlider.value) });
    });
    const btnTestSuc = document.createElement('button');
    btnTestSuc.className = 'btn btn-ghost';
    btnTestSuc.style.cssText = 'font-size:11px;padding:4px 10px;white-space:nowrap;flex-shrink:0;';
    btnTestSuc.textContent = '▶ TEST';
    btnTestSuc.onclick = () => audio.test('success');
    sucThrRow.appendChild(sucThrSlider);
    sucThrRow.appendChild(sucThrVal);
    sucThrRow.appendChild(btnTestSuc);
    sucCard.appendChild(sucThrRow);

    audioDiv.appendChild(sucCard);
    panel.appendChild(audioDiv);

    /* ── 진단 / 개발 ───────────────────────────────────────── */
    panel.appendChild(buildDiagnosticsSection());
    panel.appendChild(buildDevSection());

    /* ── REF SAVE 안내 ─────────────────────────────────────── */
    const refNote = document.createElement('div');
    refNote.style.cssText = `
      margin-top: var(--gap-lg);
      padding: var(--gap-sm) var(--gap-md);
      border-left: 2px solid var(--border-hi);
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: .06em;
      color: var(--text-muted);
      line-height: 1.6;
    `;
    refNote.innerHTML =
      '<span style="color:var(--color-accent-text);">◎ REF SAVE</span> — ' +
      'LIVE 세션 진행 중 나타나는 버튼.<br>' +
      '현재 압력값을 기준값으로 저장합니다.<br>' +
      '기준값이 저장된 후 동작 설정(Step 3)에서<br>' +
      '<em>기준값의 %</em> 모드를 사용할 수 있습니다.';
    panel.appendChild(refNote);
  }

  /* ── Helper: 토글 행 생성 ────────────────────────────────── */
  function buildToggleRow(labelText, initialChecked, onChange) {
    const row = document.createElement('div');
    row.className = 'toggle-row';

    const lbl = document.createElement('label');
    lbl.className = 'toggle-label';
    lbl.textContent = labelText;

    const sw = document.createElement('label');
    sw.className = 'toggle-switch';
    const chk = document.createElement('input');
    chk.type    = 'checkbox';
    chk.checked = initialChecked;
    chk.onchange = () => onChange(chk.checked);
    const sliderEl = document.createElement('span');
    sliderEl.className = 'toggle-slider';
    sw.appendChild(chk);
    sw.appendChild(sliderEl);

    row.appendChild(lbl);
    row.appendChild(sw);
    return row;
  }

  /* ══════════════════════════════════════════════════════════
     DIAGNOSTICS — RAW 모니터 + 유닛 보정
     On-site debugging surface. When a unit misbehaves the answer is
     almost always visible in one line of its raw output: wrong field
     count, wrong scale, wrong rate, or nothing arriving at all.
  ══════════════════════════════════════════════════════════ */
  let rawTimer = null;

  function stopRawMonitor() {
    if (rawTimer) { clearInterval(rawTimer); rawTimer = null; }
  }

  /* Polled rather than driven by the BLE callback: two units at 10 Hz
     would repaint this list 20x a second for no benefit. 4 Hz is well
     past what anyone can read. */
  function startRawMonitor() {
    stopRawMonitor();
    rawTimer = setInterval(renderRawLog, 250);
    renderRawLog();
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const RAW_STATE_KO = {
    connected:    '연결됨',
    'no-data':    '데이터 없음',
    connecting:   '연결 중',
    reconnecting: '재연결 중',
    scanning:     '검색 중',
    duplicate:    '중복 기기',
    error:        '오류',
    unsupported:  'BLE 미지원',
    disconnected: '미연결',
    simulating:   'DEMO',
  };

  function renderRawLog() {
    const host = document.getElementById('raw-monitor-body');
    if (!host) { stopRawMonitor(); return; }

    FOOT_IDS.forEach(foot => {
      const link   = bluetooth.foot(foot);
      const headEl = document.getElementById('raw-head-' + foot);
      const listEl = document.getElementById('raw-list-' + foot);
      if (!headEl || !listEl) return;

      const hz    = link.sampleRate();
      const name  = link.deviceName ? ' · ' + link.deviceName : '';
      // Report the link's actual status rather than deriving a label
      // from isConnected(). A GATT link that is up but reconnecting, or
      // up but silent, both used to read "연결됨" — which is the single
      // most misleading thing this panel can say while debugging.
      const state = link.isSimulating() ? 'DEMO' : (RAW_STATE_KO[link.status] || link.status);
      headEl.textContent = `${FOOT_LABEL[foot]}  ${state}${name}  ·  ${hz.toFixed(1)} Hz`;
      headEl.className   = 'raw-head' + (link.isLive() ? ' live' : '');

      const entries = link.rawLog().slice(-12).reverse();
      if (!entries.length) {
        // Nothing has arrived. The single most useful fact at this point
        // is which characteristic we are actually listening to — a
        // connected-but-silent link is usually subscribed to the wrong
        // one, and this has to be readable on the phone, not just in a
        // laptop console.
        const rx = link.rxInfo?.();
        let note = '';
        if (rx) {
          const right = rx.characteristic === BLE_UART.rx;
          note = '<div class="raw-range' + (right ? '' : ' warn') + '">구독 중 ' +
                 escapeHtml(rx.characteristic) + (rx.viaFallback ? ' (fallback)' : '') + '<br>' +
                 (right
                   ? 'Nordic UART RX가 맞습니다 — 유닛이 전송을 시작하지 않은 상태입니다.'
                   : '⚠ Nordic UART RX(…0003)가 아닙니다 — 이 특성은 데이터를 보내지 않습니다.') +
                 '</div>';
        } else if (link.isConnected()) {
          note = '<div class="raw-range warn">구독된 특성 없음 — 연결은 됐지만 notify 구독이 성립하지 않았습니다.</div>';
        }

        // The decisive fork: did any notification fire at all? rawLog
        // only fills once a whole line is assembled, so without this
        // "no notifications" and "notifications but no newline" are
        // indistinguishable — and they need opposite fixes.
        const st = link.rxStats?.();
        if (st) {
          if (st.notifications === 0) {
            note += '<div class="raw-range warn">notify 0회 — 구독은 됐지만 유닛이 한 번도 보내지 않았습니다. ' +
                    '펌웨어의 bleuart.write() 반환값을 확인하세요.</div>';
          } else {
            const secs = st.lastAt ? ((Date.now() - st.lastAt) / 1000).toFixed(1) : '?';
            note += '<div class="raw-range warn">notify ' + st.notifications + '회 · ' + st.bytes +
                    ' B 수신 · 마지막 ' + secs + '초 전<br>조립 대기 ' + st.bufferLen +
                    ' B — 줄바꿈 문자(LF)가 오지 않아 한 줄도 완성되지 않았습니다.<br>' +
                    '마지막 청크: "' + escapeHtml(st.bufferPreview || st.lastChunk) + '"</div>';
          }
        }

        listEl.innerHTML = note + '<div class="raw-line empty">수신 데이터 없음</div>';
        return;
      }

      // Range across the visible window makes a 12-bit unit obvious:
      // values above 1023 mean the ADC resolution is wrong.
      let min = Infinity, max = -Infinity;
      entries.forEach(e => {
        if (!e.ok) return;
        e.line.split(',').slice(0, 4).forEach(v => {
          const n = Number(v);
          if (!Number.isNaN(n)) { min = Math.min(min, n); max = Math.max(max, n); }
        });
      });

      const overRange = max > MAX_SENSOR_VAL;
      const rangeNote = Number.isFinite(min)
        ? '<div class="raw-range' + (overRange ? ' warn' : '') + '">FSR 범위 ' + min + ' – ' + max +
          (overRange ? '  ⚠ 1023 초과 — ADC 최대값을 4095로 설정하세요' : '') + '</div>'
        : '';

      listEl.innerHTML = rangeNote + entries.map(e => {
        const t   = new Date(e.t);
        const hms = [t.getHours(), t.getMinutes(), t.getSeconds()]
          .map(n => String(n).padStart(2, '0')).join(':');
        const cls  = e.ok ? 'raw-line' : 'raw-line bad';
        const tail = e.ok ? '' : '  ← ' + e.reason;
        return '<div class="' + cls + '"><span class="raw-t">' + hms + '</span>' +
               escapeHtml(e.line) + escapeHtml(tail) + '</div>';
      }).join('');
    });
  }

  function buildDiagnosticsSection() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = 'var(--gap-lg)';

    const hdr = document.createElement('div');
    hdr.className = 'section-heading';
    hdr.style.marginBottom = 'var(--gap-sm)';
    hdr.textContent = '진단';
    wrap.appendChild(hdr);

    const cfg = store.getSettings();

    /* ── RAW 모니터 ─────────────────────────────────────── */
    const rawCard = document.createElement('div');
    rawCard.className = 'card card-sm';
    rawCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);margin-bottom:var(--gap-sm);';

    const rawTop = document.createElement('div');
    rawTop.style.cssText = 'display:flex;align-items:center;gap:var(--gap-sm);';

    const rawLbl = document.createElement('span');
    rawLbl.style.cssText = 'font-size:12px;color:var(--text);flex:1;';
    rawLbl.textContent = 'RAW 모니터';

    const btnRaw = document.createElement('button');
    btnRaw.className = 'btn btn-ghost';
    btnRaw.style.cssText = 'font-size:11px;padding:4px 10px;';
    btnRaw.textContent = '열기';

    const btnClear = document.createElement('button');
    btnClear.className = 'btn btn-ghost';
    btnClear.style.cssText = 'font-size:11px;padding:4px 10px;display:none;';
    btnClear.textContent = '지우기';
    btnClear.onclick = () => { bluetooth.each(l => l.clearRawLog()); renderRawLog(); };

    rawTop.appendChild(rawLbl);
    rawTop.appendChild(btnClear);
    rawTop.appendChild(btnRaw);
    rawCard.appendChild(rawTop);

    const rawHint = document.createElement('div');
    rawHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    rawHint.textContent = '수신 원문·측정 주기·FSR 값 범위를 그대로 보여줍니다. 파싱 실패 시 어느 필드가 깨졌는지 표시됩니다.';
    rawCard.appendChild(rawHint);

    const rawBody = document.createElement('div');
    rawBody.id = 'raw-monitor-body';
    rawBody.style.display = 'none';
    FOOT_IDS.forEach(foot => {
      const block = document.createElement('div');
      block.className = 'raw-block';
      const head = document.createElement('div');
      head.className = 'raw-head';
      head.id = 'raw-head-' + foot;
      head.textContent = FOOT_LABEL[foot];
      const list = document.createElement('div');
      list.className = 'raw-list';
      list.id = 'raw-list-' + foot;
      block.appendChild(head);
      block.appendChild(list);
      rawBody.appendChild(block);
    });
    rawCard.appendChild(rawBody);

    btnRaw.onclick = () => {
      const open = rawBody.style.display === 'none';
      rawBody.style.display  = open ? 'block' : 'none';
      btnClear.style.display = open ? '' : 'none';
      btnRaw.textContent     = open ? '닫기' : '열기';
      if (open) startRawMonitor(); else stopRawMonitor();
    };

    wrap.appendChild(rawCard);

    /* ── 유닛 보정 ──────────────────────────────────────── */
    const calCard = document.createElement('div');
    calCard.className = 'card card-sm';
    calCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);margin-bottom:var(--gap-sm);';

    const adcLbl = document.createElement('div');
    adcLbl.className = 'form-label';
    adcLbl.textContent = 'ADC 최대값 (펌웨어 출력 범위)';
    calCard.appendChild(adcLbl);

    const adcRow = document.createElement('div');
    adcRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:var(--gap-sm);';

    FOOT_IDS.forEach(foot => {
      const cell = document.createElement('label');
      cell.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim);';
      const tag = document.createElement('span');
      tag.textContent = FOOT_LABEL[foot];
      const sel = document.createElement('select');
      sel.className = 'form-input';
      sel.style.cssText = 'flex:1;font-family:var(--font-mono);font-size:11px;padding:4px;';
      [[MAX_SENSOR_VAL, '1023 (10-bit)'], [4095, '4095 (12-bit)']].forEach(pair => {
        const o = document.createElement('option');
        o.value = pair[0];
        o.textContent = pair[1];
        sel.appendChild(o);
      });
      const key = foot === FOOT.LEFT ? 'adcMaxLeft' : 'adcMaxRight';
      sel.value = cfg[key] ?? MAX_SENSOR_VAL;
      sel.onchange = () => store.saveSettings({ [key]: parseInt(sel.value) });
      cell.appendChild(tag);
      cell.appendChild(sel);
      adcRow.appendChild(cell);
    });
    calCard.appendChild(adcRow);

    const adcHint = document.createElement('div');
    adcHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    adcHint.textContent =
      '양쪽 유닛 모두 10-bit(0–1023) 출력이면 기본값 그대로 두세요. ' +
      '한쪽이 12-bit로 들어오면 값이 4배로 보이고 좌우 비교가 무의미해집니다 — 그때만 4095로 바꾸면 자동 환산됩니다.';
    calCard.appendChild(adcHint);

    // Roll sign per foot — only affects the symmetry widget.
    const rollLbl = document.createElement('div');
    rollLbl.className = 'form-label';
    rollLbl.style.marginTop = 'var(--gap-xs)';
    rollLbl.textContent = 'ROLL 부호 반전 (IMU 장착 방향 보정)';
    calCard.appendChild(rollLbl);

    FOOT_IDS.forEach(foot => {
      const key = foot === FOOT.LEFT ? 'imuInvertRollLeft' : 'imuInvertRollRight';
      calCard.appendChild(buildToggleRow(
        FOOT_LABEL_KO[foot] + ' roll 반전',
        cfg[key] === true,
        (checked) => store.saveSettings({ [key]: checked }),
      ));
    });

    wrap.appendChild(calCard);

    /* ── BLE 옵션 ───────────────────────────────────────── */
    const bleCard = document.createElement('div');
    bleCard.className = 'card card-sm';
    bleCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    bleCard.appendChild(buildToggleRow(
      '모든 BLE 기기 표시(호환 모드)',
      cfg.bleAcceptAll === true,
      (checked) => store.saveSettings({ bleAcceptAll: checked }),
    ));

    const bleHint = document.createElement('div');
    bleHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    bleHint.textContent =
      '평소에는 꺼두세요. 유닛이 기기 선택창에 안 뜰 때만 켜면 주변 모든 BLE 기기가 나열됩니다.';
    bleCard.appendChild(bleHint);

    const uuidLbl = document.createElement('div');
    uuidLbl.className = 'form-label';
    uuidLbl.textContent = '커스텀 서비스 UUID (선택)';
    bleCard.appendChild(uuidLbl);

    const uuidInput = document.createElement('input');
    uuidInput.className = 'form-input';
    uuidInput.style.cssText = 'font-family:var(--font-mono);font-size:11px;';
    uuidInput.placeholder = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
    uuidInput.value = cfg.bleCustomService || '';
    uuidInput.onchange = () => store.saveSettings({ bleCustomService: uuidInput.value.trim() });
    bleCard.appendChild(uuidInput);

    const uuidHint = document.createElement('div');
    uuidHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    uuidHint.textContent =
      '두 유닛 모두 Nordic UART를 쓰므로 비워두면 됩니다. 펌웨어가 다른 프로필로 바뀌면 nRF Connect로 확인한 UUID를 여기에 넣으세요 — 코드 수정 없이 연결됩니다.';
    bleCard.appendChild(uuidHint);

    wrap.appendChild(bleCard);

    /* ── AI 조교 ─────────────────────────────────────────
       The key is held only in this browser. It is never committed and
       never sent anywhere except OpenAI itself. With no key the app
       still produces a report, just a rule-based one, so the venue
       wifi failing is never the difference between a report and a
       blank screen. */
    /* ── 기록 ────────────────────────────────────────────── */
    const recCard = document.createElement('div');
    recCard.className = 'card card-sm';
    recCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    const recHdr = document.createElement('div');
    recHdr.className = 'form-label';
    recHdr.textContent = '기록';
    recCard.appendChild(recHdr);

    recCard.appendChild(buildToggleRow(
      '원시 샘플 기록 (10Hz 전체)',
      cfg.recordRaw !== false,
      (checked) => store.saveSettings({ recordRaw: checked }),
    ));

    const recHint = document.createElement('div');
    recHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    recHint.textContent =
      '켜두세요. 세션 로그는 평균·최대·이탈 횟수만 남기기 때문에, 이걸 끄면 "언제 닿아서 언제 떨어졌는지"가 ' +
      '사라져 나중에 보행 분석을 만들 수 없습니다. 세션당 발마다 최대 ' +
      RAW_RECORD_MAX_SAMPLES.toLocaleString() + '샘플(10Hz 기준 20분)까지 기록하고, ' +
      '저장 공간이 부족하면 오래된 원시 기록부터 자동으로 정리합니다. LOG에서 내보내기로 파일로 빼두세요.';
    recCard.appendChild(recHint);

    wrap.appendChild(recCard);

    const aiCard = document.createElement('div');
    aiCard.className = 'card card-sm';
    aiCard.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    const aiHdr = document.createElement('div');
    aiHdr.className = 'form-label';
    aiHdr.textContent = 'AI 조교';
    aiCard.appendChild(aiHdr);

    aiCard.appendChild(buildToggleRow(
      '세션 종료 후 리포트',
      cfg.coachEnabled !== false,
      (checked) => store.saveSettings({ coachEnabled: checked }),
    ));

    const keyLbl = document.createElement('div');
    keyLbl.className = 'form-label';
    keyLbl.textContent = 'OpenAI API 키';
    aiCard.appendChild(keyLbl);

    const keyInput = document.createElement('input');
    keyInput.className = 'form-input';
    keyInput.type = 'password';
    keyInput.autocomplete = 'off';
    keyInput.spellcheck = false;
    keyInput.style.cssText = 'font-family:var(--font-mono);font-size:11px;';
    keyInput.placeholder = 'sk-…';
    keyInput.value = cfg.coachApiKey || '';
    keyInput.onchange = () => store.saveSettings({ coachApiKey: keyInput.value.trim() });
    aiCard.appendChild(keyInput);

    const keyRow = document.createElement('div');
    keyRow.style.cssText = 'display:flex;gap:var(--gap-sm);align-items:center;';

    const keyState = document.createElement('span');
    keyState.style.cssText = 'font-size:10px;font-family:var(--font-mono);flex:1;';
    function paintKeyState() {
      const has = !!(store.getSettings().coachApiKey || '').trim();
      keyState.textContent = has ? '키 등록됨 — AI 조교 사용' : '키 없음 — 로컬 리포트 사용';
      keyState.style.color = has ? 'var(--color-ok)' : 'var(--text-muted)';
    }
    paintKeyState();
    keyInput.addEventListener('change', paintKeyState);

    const btnClearKey = document.createElement('button');
    btnClearKey.className = 'btn btn-ghost';
    btnClearKey.style.cssText = 'font-size:11px;padding:5px 10px;';
    btnClearKey.textContent = '키 삭제';
    btnClearKey.onclick = () => {
      keyInput.value = '';
      store.saveSettings({ coachApiKey: '' });
      paintKeyState();
    };

    keyRow.appendChild(keyState);
    keyRow.appendChild(btnClearKey);
    aiCard.appendChild(keyRow);

    const modelLbl = document.createElement('div');
    modelLbl.className = 'form-label';
    modelLbl.textContent = '모델';
    aiCard.appendChild(modelLbl);

    const modelInput = document.createElement('input');
    modelInput.className = 'form-input';
    modelInput.style.cssText = 'font-family:var(--font-mono);font-size:11px;';
    modelInput.placeholder = 'gpt-4o-mini';
    modelInput.value = cfg.coachModel || 'gpt-4o-mini';
    modelInput.onchange = () => store.saveSettings({ coachModel: modelInput.value.trim() || 'gpt-4o-mini' });
    aiCard.appendChild(modelInput);

    const aiHint = document.createElement('div');
    aiHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    aiHint.textContent =
      '키는 이 기기에만 저장되고 OpenAI 외 어디로도 전송되지 않습니다. 다만 브라우저에서 직접 호출하므로 ' +
      '개발자도구 네트워크 탭에는 보입니다 — 공용 기기에서 쓰셨다면 데모 후 키를 폐기(rotate)하세요. ' +
      '키가 없거나 호출이 실패하면 수치 기반 로컬 리포트로 자동 대체되므로 리포트가 비는 일은 없습니다.';
    aiCard.appendChild(aiHint);

    wrap.appendChild(aiCard);
    return wrap;
  }

  /* ══════════════════════════════════════════════════════════
     DEV MODE — Service Worker bypass
  ══════════════════════════════════════════════════════════ */
  function buildDevSection() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = 'var(--gap-lg)';

    const hdr = document.createElement('div');
    hdr.className = 'section-heading';
    hdr.style.marginBottom = 'var(--gap-sm)';
    hdr.textContent = '앱 / 캐시';
    wrap.appendChild(hdr);

    const card = document.createElement('div');
    card.className = 'card card-sm';
    card.style.cssText = 'display:flex;flex-direction:column;gap:var(--gap-sm);';

    const verRow = document.createElement('div');
    verRow.style.cssText = 'font-family:var(--font-mono);font-size:11px;color:var(--text-dim);letter-spacing:.06em;';
    verRow.textContent = '빌드 ' + BUILD_VERSION + ' · ' + BUILD_DATE + (pwa.isDevMode ? '  ·  DEV MODE' : '');
    card.appendChild(verRow);

    card.appendChild(buildToggleRow(
      '개발 모드 (Service Worker 우회)',
      pwa.isDevMode,
      async (checked) => {
        await pwa.setDevMode(checked);
        location.reload();
      },
    ));

    const devHint = document.createElement('div');
    devHint.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;';
    devHint.textContent =
      '켜면 Service Worker를 등록하지 않고 캐시를 모두 삭제합니다. 코드를 급히 고칠 때 구버전이 뜨는 것을 확실히 막습니다. ' +
      'URL에 ?nosw=1 을 붙여도 같습니다 (?nosw=0 으로 해제).';
    card.appendChild(devHint);

    const btnHard = document.createElement('button');
    btnHard.className = 'btn btn-ghost';
    btnHard.style.cssText = 'font-size:11px;padding:6px 10px;';
    btnHard.textContent = '캐시 삭제 후 새로고침';
    btnHard.onclick = async () => {
      if (!confirm('앱 캐시를 모두 삭제하고 새로고침할까요?\n저장된 동작·세션 기록은 유지됩니다.')) return;
      await pwa.hardRefresh();
    };
    card.appendChild(btnHard);

    wrap.appendChild(card);
    return wrap;
  }

  /* ══════════════════════════════════════════════════════════
     WIZARD — Step 1: 제목 + 타입
  ══════════════════════════════════════════════════════════ */
  function renderStep1() {
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = draft.id ? 'CONFIG — 동작 수정' : 'CONFIG — 새 동작';
    panel.appendChild(heading);
    panel.appendChild(buildStepDots(1));

    // Capture origin banner — one line per captured foot, so a
    // single-foot capture is obvious rather than silently partial.
    if (draft.captured) {
      const capBanner = document.createElement('div');
      capBanner.className = 'ready-banner';

      const lines = FOOT_IDS.map(f => {
        const snap = draft.captured[f];
        if (!snap) return `<span style="opacity:.5;">${FOOT_LABEL[f]} — 미연결</span>`;
        const fsr = draft.channels
          .map((pid, ch) => `CH${ch + 1} ${pid}:${Math.round(snap.values[ch] ?? 0)}`)
          .join('  ');
        return `${FOOT_LABEL[f]}  ${fsr}  YAW:${(snap.imu?.yaw ?? 0).toFixed(1)}°`;
      });

      capBanner.innerHTML =
        '<span style="color:var(--color-accent-text);">📸 FREE CAPTURE</span> — ' +
        '캡처된 발의 값이 각각 기준값으로 설정됩니다.<br>' +
        `<span style="font-family:var(--font-mono);font-size:10px;opacity:.7;line-height:1.6;">${lines.join('<br>')}</span>`;
      panel.appendChild(capBanner);
    }

    const lbl1 = document.createElement('div');
    lbl1.className = 'form-label';
    lbl1.style.marginBottom = 'var(--gap-xs)';
    lbl1.textContent = '동작 제목';
    panel.appendChild(lbl1);

    const input = document.createElement('input');
    input.className   = 'form-input';
    input.type        = 'text';
    input.placeholder = '예: 정적 하중 유지';
    input.value       = draft.title;
    input.maxLength   = 40;
    panel.appendChild(input);

    const lbl2 = document.createElement('div');
    lbl2.className = 'form-label';
    lbl2.style.margin = 'var(--gap-md) 0 var(--gap-xs)';
    lbl2.textContent = '경고 조건 타입';
    panel.appendChild(lbl2);

    const typeSelector = document.createElement('div');
    typeSelector.className = 'type-selector';

    const refreshTypes = (selected) => {
      typeSelector.querySelectorAll('.type-btn').forEach((b, i) => {
        const k = Object.keys(DRILL_TYPES)[i];
        b.className = 'type-btn' + (k === selected ? ` selected-${k}` : '');
      });
    };

    Object.entries(DRILL_TYPES).forEach(([key, dt]) => {
      const btn = document.createElement('button');
      btn.className = 'type-btn' + (draft.type === key ? ` selected-${key}` : '');
      btn.textContent = dt.label;
      btn.onclick = () => { draft.type = key; refreshTypes(key); };
      typeSelector.appendChild(btn);
    });
    panel.appendChild(typeSelector);

    if (draft.type === 'gait') {
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:var(--gap-xs);';
      hint.textContent = 'Gait 모드: Heel → Met → Toe-1 순서를 자동으로 체크합니다.';
      panel.appendChild(hint);
    }

    const nav = document.createElement('div');
    nav.className = 'wizard-nav';

    const btnBack = document.createElement('button');
    btnBack.className = 'btn btn-ghost';
    btnBack.textContent = '← 취소';
    btnBack.onclick = () => renderHub();

    const btnNext = document.createElement('button');
    btnNext.className = 'btn btn-primary';
    btnNext.textContent = '다음 — 압점 선택';
    btnNext.onclick = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      draft.title = v;
      step = 2;
      renderStep2();
    };

    nav.appendChild(btnBack);
    nav.appendChild(btnNext);
    panel.appendChild(nav);
  }

  /* ══════════════════════════════════════════════════════════
     WIZARD — Step 2: 압점 선택
  ══════════════════════════════════════════════════════════ */
  function renderStep2() {
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'CONFIG — 압점 선택 (4개)';
    panel.appendChild(heading);
    panel.appendChild(buildStepDots(2));

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:var(--text-dim);';
    hint.textContent = '양발 실루엣에서 활성화할 압점을 정확히 4개 선택하세요.';
    panel.appendChild(hint);

    const hint2 = document.createElement('div');
    hint2.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;margin-top:2px;';
    hint2.textContent =
      '양발 같은 자리에 FSR을 붙였다고 보고 좌우가 함께 선택됩니다 — 어느 쪽을 탭해도 됩니다. ' +
      '실루엣 위치는 실제 부착 지점의 근사치입니다.';
    panel.appendChild(hint2);

    /* Both feet, side by side. The drill carries one set of four point
       IDs and every downstream consumer (paired gauges, session
       judging, log) reads it for both feet, so the two silhouettes are
       two views of one selection rather than two independent ones —
       tapping either mirrors to the other. */
    const selected = [...(draft.channels.length ? draft.channels : draft.points.map(p => p.id))];
    const grid = document.createElement('div');
    grid.className = 'foot-pick-grid';

    const svgs = FOOT_IDS.map(foot => {
      const wrap = document.createElement('div');
      wrap.className = 'foot-wrap';

      const lbl = document.createElement('span');
      lbl.className = 'foot-label';
      lbl.textContent = FOOT_LABEL[foot];
      wrap.appendChild(lbl);

      const svg = liveTab.buildFootSVG({ configMode: true, foot });
      svg.dataset.pickFoot = foot;
      wrap.appendChild(svg);
      grid.appendChild(wrap);
      return svg;
    });

    function paint() {
      svgs.forEach(svg => {
        svg.querySelectorAll('.pp-dot').forEach(dot => {
          const ch = selected.indexOf(dot.dataset.id);
          const on = ch >= 0;
          dot.dataset.selected = on ? 'true' : 'false';
          dot.dataset.state    = on ? 'ok' : 'inactive';
          dot.dataset.channel  = on ? String(ch + 1) : '';
        });
      });
      countEl.innerHTML = `<span class="num ${selected.length === REQUIRED_POINTS ? 'full' : ''}">${selected.length}</span> / ${REQUIRED_POINTS} 선택됨` +
        (selected.length ? `<br>${selected.map((pid, i) => `CH${i + 1} → ${pid} ${PRESSURE_POINTS[pid].label}`).join(' · ')}` : '');
      countEl.style.color = '';
    }

    function toggle(pid) {
      const i = selected.indexOf(pid);
      if (i >= 0) selected.splice(i, 1);
      else if (selected.length < REQUIRED_POINTS) selected.push(pid);
      else return;
      paint();
    }

    // The invisible .pp-hit circle is the touch target and sits above
    // the dot, so the listener goes there.
    svgs.forEach(svg => {
      svg.querySelectorAll('.pp-hit').forEach(hit => {
        hit.addEventListener('click', () => toggle(hit.dataset.id));
      });
    });

    panel.appendChild(grid);

    const countEl = document.createElement('div');
    countEl.className = 'pp-select-count';
    panel.appendChild(countEl);

    // First paint seeds both silhouettes from the draft; it has to run
    // after countEl exists because paint() writes the counter too.
    paint();

    const nav = document.createElement('div');
    nav.className = 'wizard-nav';

    const btnBack = document.createElement('button');
    btnBack.className = 'btn btn-ghost';
    btnBack.textContent = '← 뒤로';
    btnBack.onclick = () => { step = 1; renderStep1(); };

    const btnNext = document.createElement('button');
    btnNext.className = 'btn btn-primary';
    btnNext.textContent = '다음 — 압점 설정';
    btnNext.onclick = () => {
      if (selected.length !== REQUIRED_POINTS) {
        countEl.style.color = 'var(--color-alert-p)';
        return;
      }
      const prev = new Map(draft.points.map(p => [p.id, p]));
      draft.channels = [...selected];
      draft.points = selected.map((pid, channel) => {
        if (prev.has(pid)) return prev.get(pid);
        if (draft.captured) return makeCapturedPoint(pid);
        return { ...makeDefaultPoint(pid), channel };
      });
      draft.points.forEach((pt, channel) => { pt.channel = channel; });
      step = 3;
      renderStep3();
    };

    nav.appendChild(btnBack);
    nav.appendChild(btnNext);
    panel.appendChild(nav);
  }

  /* ══════════════════════════════════════════════════════════
     WIZARD — Step 3: 압점별 설정 + 배치 알림 + 저장
  ══════════════════════════════════════════════════════════ */
  function renderStep3() {
    panel.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    heading.textContent = 'CONFIG — 압점 설정';
    panel.appendChild(heading);
    panel.appendChild(buildStepDots(3));

    draft.points.forEach(pt => {
      const pp   = PRESSURE_POINTS[pt.id];
      const card = document.createElement('div');
      card.className = 'point-cfg';

      // 헤더
      const hdr = document.createElement('div');
      hdr.className = 'point-cfg-header';
      const idBadge = document.createElement('span');
      idBadge.className = 'point-id-badge';
      idBadge.textContent = pt.id;
      const name = document.createElement('span');
      name.style.cssText = 'font-size:13px;font-weight:600;';
      name.textContent = `${pp.name} · ${pp.label}`;
      hdr.appendChild(idBadge);
      hdr.appendChild(name);
      card.appendChild(hdr);

      // ── THR 설정 방식 ──────────────────────────────────────
      const thrModeLbl = document.createElement('div');
      thrModeLbl.className = 'form-label';
      thrModeLbl.textContent = 'THR 설정 방식';
      card.appendChild(thrModeLbl);

      const thrModeRow = document.createElement('div');
      thrModeRow.className = 'dir-toggle';
      thrModeRow.style.marginBottom = 'var(--gap-sm)';

      const btnAbs = document.createElement('button');
      btnAbs.className = 'dir-btn' + (pt.thrMode !== 'percent' ? ' selected-positive' : '');
      btnAbs.textContent = '절대값';

      const btnPct = document.createElement('button');
      btnPct.className = 'dir-btn' + (pt.thrMode === 'percent' ? ' selected-positive' : '');
      btnPct.textContent = '기준값의 %';
      if (!anyReference(pt)) {
        btnPct.disabled = true;
        btnPct.style.opacity = '0.4';
        btnPct.title = 'LIVE 세션에서 ◎ REF SAVE 후 사용 가능';
      }

      // ── 절대값 슬라이더 ────────────────────────────────────
      const absSection = document.createElement('div');
      absSection.style.display = pt.thrMode === 'percent' ? 'none' : 'block';

      const absLbl = document.createElement('div');
      absLbl.className = 'form-label';
      absLbl.textContent = 'THR 임계값 (0 – 1023)';
      absSection.appendChild(absLbl);

      const absRow = document.createElement('div');
      absRow.className = 'slider-row';
      const absSlider = document.createElement('input');
      absSlider.type  = 'range';
      absSlider.min   = 0;
      absSlider.max   = MAX_SENSOR_VAL;
      absSlider.value = pt.thr;
      const absVal = document.createElement('span');
      absVal.className = 'slider-val';
      absVal.textContent = pt.thr;
      absSlider.addEventListener('input', () => {
        pt.thr = parseInt(absSlider.value);
        absVal.textContent = pt.thr;
      });
      absRow.appendChild(absSlider);
      absRow.appendChild(absVal);
      absSection.appendChild(absRow);

      // ── 기준값 % 슬라이더 ──────────────────────────────────
      const pctSection = document.createElement('div');
      pctSection.style.display = pt.thrMode === 'percent' ? 'block' : 'none';

      if (!anyReference(pt)) {
        const pctHint = document.createElement('div');
        pctHint.style.cssText = 'font-size:11px;color:var(--color-alert-n);';
        pctHint.textContent = 'LIVE 세션 → ◎ REF SAVE 먼저 진행하세요.';
        pctSection.appendChild(pctHint);
      } else {
        const pctLbl = document.createElement('div');
        pctLbl.className = 'form-label';
        pctLbl.textContent = `기준값(${referenceLabel(pt)})의 %`;
        pctSection.appendChild(pctLbl);

        // A foot with no reference of its own uses its absolute THR.
        const missing = FOOT_IDS.filter(f => alertEngine.getReference(pt, f) === null);
        if (missing.length) {
          const warn = document.createElement('div');
          warn.style.cssText = 'font-size:10px;color:var(--text-muted);line-height:1.5;margin-bottom:4px;';
          warn.textContent =
            `${missing.map(f => FOOT_LABEL_KO[f]).join(' / ')}는 기준값이 없어 절대값 THR로 판정합니다.`;
          pctSection.appendChild(warn);
        }

        const pctRow = document.createElement('div');
        pctRow.className = 'slider-row';
        const pctSlider = document.createElement('input');
        pctSlider.type  = 'range';
        pctSlider.min   = 50;
        pctSlider.max   = 100;
        pctSlider.value = pt.thrPercent ?? 80;
        const pctVal = document.createElement('span');
        pctVal.className = 'slider-val';
        pctVal.textContent = (pt.thrPercent ?? 80) + '%';
        pctSlider.addEventListener('input', () => {
          pt.thrPercent = parseInt(pctSlider.value);
          pctVal.textContent = pt.thrPercent + '%';
          pctVal.title = FOOT_IDS
            .map(f => {
              const r = alertEngine.getReference(pt, f);
              return r === null ? null : `${FOOT_LABEL[f]} THR ≈ ${Math.round(r * pt.thrPercent / 100)}`;
            })
            .filter(Boolean).join('  |  ');
        });
        pctRow.appendChild(pctSlider);
        pctRow.appendChild(pctVal);
        pctSection.appendChild(pctRow);
      }

      // Mode toggle handlers
      btnAbs.onclick = () => {
        pt.thrMode = 'absolute';
        btnAbs.className = 'dir-btn selected-positive';
        btnPct.className = 'dir-btn';
        absSection.style.display = 'block';
        pctSection.style.display = 'none';
      };
      btnPct.onclick = () => {
        if (!anyReference(pt)) return;
        pt.thrMode = 'percent';
        btnAbs.className = 'dir-btn';
        btnPct.className = 'dir-btn selected-positive';
        absSection.style.display = 'none';
        pctSection.style.display = 'block';
      };

      thrModeRow.appendChild(btnAbs);
      thrModeRow.appendChild(btnPct);
      card.appendChild(thrModeRow);
      card.appendChild(absSection);
      card.appendChild(pctSection);

      // ── 경고 방향 ──────────────────────────────────────────
      const dirLbl = document.createElement('div');
      dirLbl.className = 'form-label';
      dirLbl.textContent = '경고 방향';
      card.appendChild(dirLbl);

      const dirToggle = document.createElement('div');
      dirToggle.className = 'dir-toggle';

      const btnPos = document.createElement('button');
      btnPos.className = 'dir-btn' + (pt.direction === 'positive' ? ' selected-positive' : '');
      btnPos.textContent = '▲ POSITIVE';

      const btnNeg = document.createElement('button');
      btnNeg.className = 'dir-btn' + (pt.direction === 'negative' ? ' selected-negative' : '');
      btnNeg.textContent = '▼ NEGATIVE';

      btnPos.onclick = () => {
        pt.direction = 'positive';
        btnPos.className = 'dir-btn selected-positive';
        btnNeg.className = 'dir-btn';
      };
      btnNeg.onclick = () => {
        pt.direction = 'negative';
        btnPos.className = 'dir-btn';
        btnNeg.className = 'dir-btn selected-negative';
      };

      dirToggle.appendChild(btnPos);
      dirToggle.appendChild(btnNeg);
      card.appendChild(dirToggle);

      panel.appendChild(card);
    });

    // ── 배치 알림 토글 ─────────────────────────────────────
    const placementRow = buildToggleRow(
      '훈련 시작 전 FSR 배치 알림 표시',
      draft.showPlacementAlert !== false,
      (checked) => { draft.showPlacementAlert = checked; },
    );
    placementRow.className += ' card card-sm';
    placementRow.style.marginTop = 'var(--gap-sm)';
    panel.appendChild(placementRow);

    // ── Nav ────────────────────────────────────────────────
    const nav = document.createElement('div');
    nav.className = 'wizard-nav';

    const btnBack = document.createElement('button');
    btnBack.className = 'btn btn-ghost';
    btnBack.textContent = '← 뒤로';
    btnBack.onclick = () => { step = 2; renderStep2(); };

    const btnSave = document.createElement('button');
    btnSave.className = 'btn btn-ok';
    btnSave.textContent = '저장';
    btnSave.onclick = () => {
      if (!draft.id) draft.id = store.newDrillId();
      store.saveDrill({ ...draft });
      resetDraft();
      step = 0;
      onSaved?.();
      renderHub();
    };

    nav.appendChild(btnBack);
    nav.appendChild(btnSave);
    panel.appendChild(nav);
  }

  /* ── Edit entry point ───────────────────────────────────── */
  function editDrill(drill) {
    draft = {
      id:                 drill.id,
      title:              drill.title,
      type:               drill.type,
      points:             drill.points.map(p => ({ ...makeDefaultPoint(p.id), ...p })),
      channels:           [...(drill.channels || drill.points.slice().sort((a,b) => Number(a.id.slice(1))-Number(b.id.slice(1))).map(p => p.id))],
      showPlacementAlert: drill.showPlacementAlert !== false,
    };
    step = 1;
    renderStep1();
  }

  /* ── Public API ─────────────────────────────────────────── */
  return {
    init(panelEl, savedCallback) {
      panel   = panelEl;
      onSaved = savedCallback;
      resetDraft();
    },

    render() {
      // If wizard is in progress (step > 0), don't reset to hub
      if (step === 0) renderHub();
    },

    editDrill,

    // Entry point from FREE CAPTURE: pre-fill draft with captured values
    /* snapshot: { left: {values, imu}|null, right: {values, imu}|null }
       Either foot alone is a valid capture. */
    startFromCapture(snapshot) {
      resetDraft();
      draft.captured = {
        left:  snapshot?.left  ? { values: [...snapshot.left.values],  imu: { ...snapshot.left.imu } }  : null,
        right: snapshot?.right ? { values: [...snapshot.right.values], imu: { ...snapshot.right.imu } } : null,
      };
      draft.channels = [...(snapshot?.channels || DEFAULT_CAPTURE_CHANNELS)];
      draft.baseline = snapshot?.baseline || null;
      draft.points = draft.channels.map((pid, channel) => ({ ...makeCapturedPoint(pid), channel }));
      step = 1;
      renderStep1();
    },
  };
})();
