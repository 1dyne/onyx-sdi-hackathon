(() => {
  /* ── Tab routing ────────────────────────────────────────── */
  let activeTab = 'live';

  function switchTab(name) {
    if (name !== activeTab && liveTab.isCollecting?.()) {
      showToast('측정을 마치거나 취소한 뒤 화면을 이동하세요.'); return;
    }
    configTab.stopDiagnostics?.();
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    activeTab = name;

    if (name === 'training') trainingTab.render();
    if (name === 'config')   configTab.render();
    if (name === 'log')      logTab.render();
    if (name === 'developer') configTab.renderDeveloper(document.getElementById('tab-developer'));
  }

  /* ── Per-foot Bluetooth chips ───────────────────────────────
     Each foot has its own chip and its own status. Nothing here
     aggregates the two: a left-foot error must not repaint the
     right-foot chip. */
  const CHIP_STATE = {
    connected:    { dot: 'connected',    cls: 'active', title: '연결됨 — 탭하여 해제' },
    'no-data':    { dot: 'nodata',       cls: 'nodata', title: '연결됨 · 데이터 없음 — 탭하여 해제' },
    reconnecting: { dot: 'scanning',     cls: '',       title: '재연결 시도 중…' },
    scanning:     { dot: 'scanning',     cls: '',       title: '기기 검색 중…' },
    connecting:   { dot: 'scanning',     cls: '',       title: '연결 중…' },
    simulating:   { dot: 'scanning',     cls: 'sim',    title: 'DEMO (시뮬레이션)' },
    disconnected: { dot: 'disconnected', cls: '',       title: '연결 안 됨 — 탭하여 연결' },
    duplicate:    { dot: 'error',        cls: 'error',  title: '이미 반대쪽에 연결된 기기' },
    error:        { dot: 'error',        cls: 'error',  title: '연결 오류' },
    unsupported:  { dot: 'error',        cls: 'error',  title: '이 브라우저는 Web Bluetooth 미지원' },
  };

  function setFootChip(foot) {
    const link = bluetooth.foot(foot);
    const btn  = document.getElementById(`btn-bt-${foot}`);
    if (!btn) return;

    const s   = CHIP_STATE[link.status] || CHIP_STATE.disconnected;
    const dot = btn.querySelector('.foot-dot');

    btn.className = 'btn-foot' + (s.cls ? ' ' + s.cls : '');
    if (dot) dot.className = 'foot-dot ' + s.dot;

    const name = link.deviceName ? ` · ${link.deviceName}` : '';
    btn.title  = `${FOOT_LABEL_KO[foot]}: ${s.title}${name}`;
  }

  function refreshAllChips() {
    FOOT_IDS.forEach(setFootChip);
  }

  /* One place that everything interested in connection changes hangs
     off, so tabs never poll. */
  function handleStatus(status, foot, err) {
    setFootChip(foot);
    liveTab.onConnectionChange?.(foot, status, err);
    configTab.onConnectionChange?.(foot, status, err);

    if (status === 'duplicate' || status === 'error' || status === 'no-data') {
      const link = bluetooth.foot(foot);
      showToast(`${FOOT_LABEL_KO[foot]} — ${link.lastError || '연결 실패'}`);
    }
  }

  async function toggleFoot(foot) {
    const link = bluetooth.foot(foot);

    if (link.isLive()) {
      // Mid-session disconnects are almost always a mis-tap.
      if (session.isActive &&
          !confirm(`${FOOT_LABEL_KO[foot]} 연결을 해제할까요?\n세션은 계속 진행됩니다.`)) return;
      link.disconnect();
      return;
    }
    await link.connect();
  }

  /* ── Toast ──────────────────────────────────────────────── */
  let toastTimer = null;
  function showToast(msg) {
    let el = document.getElementById('app-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'app-toast';
      el.className = 'app-toast';
      document.getElementById('app')?.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('visible'), 3200);
  }

  /* ── Theme toggle ───────────────────────────────────────── */
  function initTheme() {
    const saved = localStorage.getItem('onyxSDI_theme') || 'light';
    document.documentElement.setAttribute('data-theme', saved);
    updateThemeBtn(saved);
  }

  function updateThemeBtn(theme) {
    const btn = document.getElementById('btn-theme');
    if (btn) btn.title = theme === 'dark' ? '라이트 모드' : '다크 모드';
  }

  function toggleTheme() {
    const cur  = document.documentElement.getAttribute('data-theme') || 'light';
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('onyxSDI_theme', next);
    updateThemeBtn(next);
  }

  /* ── Version stamp + update prompt ──────────────────────── */
  function renderVersionStamp() {
    const el = document.getElementById('app-version');
    if (!el) return;
    el.textContent = `v${BUILD_VERSION}${pwa.isDevMode ? ' · DEV' : ''}`;
    el.classList.toggle('dev', pwa.isDevMode);
    el.title = pwa.isDevMode
      ? '개발 모드 — Service Worker 우회 중 (⋮ → 🛠 개발 도구에서 해제)'
      : `빌드 ${BUILD_VERSION} (${BUILD_DATE})`;
  }

  /* Shown when a newer worker has installed behind the running page. */
  function showUpdateBanner() {
    if (document.getElementById('update-banner')) return;
    const bar = document.createElement('button');
    bar.id        = 'update-banner';
    bar.className = 'update-banner';
    bar.textContent = '새 버전이 준비되었습니다 · 탭하여 적용';
    bar.onclick   = () => pwa.applyUpdate();
    document.getElementById('app')?.prepend(bar);
  }

  /* ── Boot ───────────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    initTheme();

    // Service Worker registration (or teardown, in dev mode).
    pwa.onUpdate = showUpdateBanner;
    pwa.init().then(renderVersionStamp);
    renderVersionStamp();

    // Wire tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => switchTab(btn.dataset.tab);
    });

    // Init tab modules
    liveTab.init(document.getElementById('tab-live'));
    trainingTab.init(
      document.getElementById('tab-training'),
      (drill) => {
        switchTab('live');
        liveTab.prepareSession(drill);
      }
    );
    configTab.init(
      document.getElementById('tab-config'),
      () => {
        // After save → stay in CONFIG hub (drill list is visible there)
        // trainingTab will refresh on next visit
      }
    );
    logTab.init(document.getElementById('tab-log'));

    // Theme button
    document.getElementById('btn-theme').onclick = toggleTheme;
    document.getElementById('btn-developer').onclick = () => {
      document.querySelector('.app-menu').open=false; switchTab('developer');
    };
    validation.pending('get').then(pending => {
      if (pending) showToast('복구 가능한 캡처가 있습니다 · ⋮ → 🛠 개발 도구');
    }).catch(()=>showToast('임시저장 공간을 열 수 없습니다. 캡처 후 바로 내보내세요.'));

    // Per-foot connect chips
    FOOT_IDS.forEach(foot => {
      const btn = document.getElementById(`btn-bt-${foot}`);
      if (btn) btn.onclick = () => toggleFoot(foot);
    });
    refreshAllChips();

    // BT callbacks — the foot travels with every sample.
    bluetooth.onStatus = handleStatus;
    bluetooth.onData   = (values, foot) => { liveTab.observeSample?.(values,foot); session.feed(values, foot); };

    // Show initial tab
    switchTab('live');
  });

  // Exposed for tabs that need to trigger a connect or a toast.
  window.app = {
    toggleFoot,
    showToast,
    refreshAllChips,
    switchTab: (n) => switchTab(n),
  };
})();
