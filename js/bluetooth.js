/* ─────────────────────────────────────────────────────────────
   BLE transport — one independent link per foot.

   Every piece of connection state (device, characteristic, receive
   buffer, status, simulation timer) lives inside a link instance.
   That isolation is what makes the two units independent: a dropped
   left foot cannot corrupt the right foot's partial line, and
   disconnecting one never touches the other.

   The receive buffer in particular MUST NOT be shared — notifications
   arrive in ~20 byte chunks, so a single 38-character sample line is
   split across several events. Two devices writing into one buffer
   would interleave mid-line and destroy both streams.
   ───────────────────────────────────────────────────────────── */

const bleSleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ── One link = one foot ─────────────────────────────────────── */
function createBleLink(foot) {
  let device   = null;
  let rxChar   = null;
  let buffer   = '';
  let simTimer = null;

  let _onData   = null;
  let _onStatus = null;
  let _onRaw    = null;

  let intentionalDisconnect = false;
  let reconnectAttempt      = 0;
  let reconnectTimer        = null;
  let firstDataTimer        = null;
  // What we actually ended up subscribed to. Surfaced in the RAW
  // monitor: "connected but silent" is nearly always the wrong
  // characteristic, and that has to be visible on the phone.
  let rxSource              = null;

  // Rolling window of arrival times, used to report the real sample rate.
  const arrivals = [];
  // Ring buffer of received lines for the RAW monitor.
  const rawLog   = [];

  const link = {
    foot,
    status:     'disconnected',
    deviceName: null,
    deviceId:   null,
    lastError:  null,

    set onData(fn)   { _onData   = fn; },
    set onStatus(fn) { _onStatus = fn; },
    set onRaw(fn)    { _onRaw    = fn; },
  };

  function setStatus(s, err) {
    link.status    = s;
    link.lastError = err || null;
    _onStatus?.(s, foot, err || null);
  }

  /* ── RAW monitor plumbing ──────────────────────────────────── */
  function pushRaw(entry) {
    rawLog.push(entry);
    if (rawLog.length > RAW_LOG_SIZE) rawLog.shift();
    _onRaw?.(entry, foot);
  }

  function noteArrival(now) {
    arrivals.push(now);
    // 3-second window is enough to read a stable Hz at 10 Hz nominal.
    while (arrivals.length && now - arrivals[0] > 3000) arrivals.shift();
  }

  /* ── ADC normalisation ─────────────────────────────────────────
     Both units are configured for 10-bit output, so this is a no-op
     in normal operation. It exists so that a unit which slipped
     through with 12-bit ADC can be corrected from CONFIG on site
     instead of needing a firmware reflash mid-event.              */
  function adcMax() {
    const s = store.getSettings();
    const v = foot === FOOT.LEFT ? s.adcMaxLeft : s.adcMaxRight;
    return Number(v) > 0 ? Number(v) : MAX_SENSOR_VAL;
  }

  function normaliseFsr(v) {
    const max = adcMax();
    if (max === MAX_SENSOR_VAL) return v;
    const scaled = Math.round(v * (MAX_SENSOR_VAL / max));
    return Math.max(0, Math.min(MAX_SENSOR_VAL, scaled));
  }

  /* ── Line parsing ──────────────────────────────────────────────
     Accepts the 7-field format and the 4-field FSR-only legacy form.
     Returns a describing object either way so the RAW monitor can
     show exactly which field failed rather than just "parse error". */
  function parseLine(line) {
    const clean = line.trim();
    if (!clean) return { ok: false, reason: 'empty' };

    const rawParts = clean.split(',');
    const parts    = rawParts.map(Number);

    const badIdx = parts.findIndex(v => Number.isNaN(v));
    if (badIdx >= 0) {
      return {
        ok: false,
        reason: `필드 ${badIdx + 1} 숫자 아님: "${rawParts[badIdx]}"`,
        fieldIndex: badIdx,
      };
    }

    if (parts.length === 7) return { ok: true, values: parts };
    if (parts.length === 4) return { ok: true, values: [...parts, 0, 0, 0] };

    return { ok: false, reason: `필드 개수 ${parts.length} (7 또는 4 필요)` };
  }

  function dispatch(line) {
    const now    = Date.now();
    const result = parseLine(line);

    pushRaw({
      t:      now,
      line:   line.replace(/\r/g, '\\r'),
      ok:     result.ok,
      reason: result.reason || null,
    });

    if (!result.ok) return;

    noteArrival(now);

    // Scale the four FSR channels; IMU angles pass through untouched.
    const v = result.values.slice();
    for (let i = 0; i < 4; i++) v[i] = normaliseFsr(v[i]);

    _onData?.(v, foot);
  }

  function onRx(event) {
    buffer += new TextDecoder().decode(event.target.value);
    const lines = buffer.split('\n');
    buffer = lines.pop();          // keep the trailing partial line
    lines.forEach(dispatch);
  }

  /* ── First-notification watchdog ───────────────────────────────
     Deliberately a second listener on the same characteristic rather
     than a hook inside onRx: the receive path is verified and stays
     untouched. This one fires once and then unsubscribes itself. */
  function onFirstRx() {
    clearFirstDataTimer();
    rxChar?.removeEventListener('characteristicvaluechanged', onFirstRx);
    if (link.status !== 'connected') setStatus('connected');
  }

  function clearFirstDataTimer() {
    if (firstDataTimer) { clearTimeout(firstDataTimer); firstDataTimer = null; }
  }

  /* A live GATT link is not proof of a live data stream. The link only
     claims 'connected' once a notification has actually arrived; until
     then it sits at 'no-data', so a badge can never read "연결됨" over
     a silent unit. */
  function armFirstDataWatchdog() {
    clearFirstDataTimer();
    firstDataTimer = setTimeout(() => {
      firstDataTimer = null;
      if (link.status !== 'connected') {
        setStatus('no-data', '연결됐지만 데이터가 오지 않습니다');
      }
    }, BLE_FIRST_DATA_MS);
  }

  function detachCharacteristic() {
    if (!rxChar) return;
    try {
      rxChar.removeEventListener('characteristicvaluechanged', onRx);
      rxChar.removeEventListener('characteristicvaluechanged', onFirstRx);
    } catch (_) { /* characteristic already invalidated */ }
    rxChar   = null;
    rxSource = null;
  }

  /* ── GATT link ─────────────────────────────────────────────────
     Returns a server that is actually connected, reconnecting if the
     link dropped. The settle delay after a fresh connect is what makes
     discovery reliable on Windows — see BLE_GATT_SETTLE_MS.        */
  async function ensureConnected(dev) {
    if (dev.gatt.connected) return dev.gatt;
    const server = await dev.gatt.connect();
    await bleSleep(BLE_GATT_SETTLE_MS);
    return server;
  }

  /* ── Characteristic discovery ───────────────────────
     Nordic UART is what both units ship, so it is tried twice before
     anything else. The first failure is usually the Windows discovery
     race, not a real absence — and demoting to the fallback on that
     transient error is exactly how a unit ends up subscribed to some
     unrelated notifiable characteristic (a battery level, say) that
     never fires. The link then looks perfectly healthy while no data
     ever arrives, which is far harder to diagnose than a clean failure.

     The fallback keeps preferring Nordic UART if it is present at all,
     and only takes a foreign characteristic as a last resort — loudly,
     because that choice is almost always wrong. */
  async function tryNordicUart(dev) {
    const live = await ensureConnected(dev);
    const svc  = await live.getPrimaryService(BLE_UART.service);
    return await svc.getCharacteristic(BLE_UART.rx);
  }

  async function findNotifyCharacteristic(server, dev) {
    const errs = [];

    for (let i = 1; i <= 2; i++) {
      try {
        const c = await tryNordicUart(dev);
        rxSource = { service: BLE_UART.service, characteristic: BLE_UART.rx, viaFallback: false };
        return c;
      } catch (err) {
        errs.push(`NUS ${i}/2: ${err?.message || err}`);
        console.warn(`[BT:${foot}] Nordic UART 탐색 실패 (${i}/2):`, err?.message || err);
        if (i < 2) await bleSleep(BLE_ATTACH_RETRY_MS);
      }
    }

    try {
      const live     = await ensureConnected(dev);
      const services = await live.getPrimaryServices();

      // Nordic UART found by walking, even though the direct lookup failed.
      const nus = services.find(s => s.uuid === BLE_UART.service);
      if (nus) {
        const chars = await nus.getCharacteristics();
        const rx = chars.find(c => c.uuid === BLE_UART.rx)
                || chars.find(c => c.properties.notify || c.properties.indicate);
        if (rx) {
          rxSource = { service: nus.uuid, characteristic: rx.uuid, viaFallback: true };
          console.info(`[BT:${foot}] fallback → Nordic UART`, nus.uuid, rx.uuid);
          return rx;
        }
      }

      for (const svc of services) {
        const chars = await svc.getCharacteristics();
        const notif = chars.find(c => c.properties.notify || c.properties.indicate);
        if (notif) {
          rxSource = { service: svc.uuid, characteristic: notif.uuid, viaFallback: true };
          console.warn(
            `[BT:${foot}] ⚠ Nordic UART 없음 — 임의의 notify 특성을 구독합니다.`,
            `이 특성이 실제로 데이터를 보내지 않으면 연결만 되고 수신은 없습니다.`,
            svc.uuid, notif.uuid,
          );
          return notif;
        }
      }
    } catch (err) {
      errs.push(`전체 탐색: ${err?.message || err}`);
      throw new Error(errs.join('  |  '));
    }

    errs.push('notify 가능한 캐릭터리스틱을 찾지 못했습니다');
    throw new Error(errs.join('  |  '));
  }

  /* One attempt: connect if needed, discover, subscribe. */
  async function attachOnce(dev) {
    const server = await ensureConnected(dev);
    if (!server.connected) throw new Error('GATT 연결이 곧바로 끊겼습니다');

    const char = await findNotifyCharacteristic(server, dev);
    await char.startNotifications();

    // Drop whatever a previous attempt left subscribed before adopting
    // the new characteristic, so a retry cannot double-feed the buffer.
    detachCharacteristic();
    rxChar = char;
    rxChar.addEventListener('characteristicvaluechanged', onRx);
    rxChar.addEventListener('characteristicvaluechanged', onFirstRx);
    buffer = '';
  }

  /* Windows Chrome loses the GATT link on the first discovery call
     often enough that a single failure means nothing. Retry the whole
     attach — reconnect included — before calling the unit unreachable. */
  async function attach(dev) {
    let lastErr = null;

    for (let i = 1; i <= BLE_ATTACH_TRIES; i++) {
      try {
        await attachOnce(dev);
        reconnectAttempt = 0;
        armFirstDataWatchdog();
        return;
      } catch (err) {
        lastErr = err;
        console.warn(
          `[BT:${foot}] attach 시도 ${i}/${BLE_ATTACH_TRIES} 실패:`,
          err?.name ? `${err.name}: ${err.message}` : err,
        );
        detachCharacteristic();
        if (i < BLE_ATTACH_TRIES) await bleSleep(BLE_ATTACH_RETRY_MS);
      }
    }

    throw lastErr || new Error('attach 실패');
  }

  /* ── Auto-reconnect ────────────────────────────────────────────
     Only for drops the user did not ask for. Keeping one foot alive
     through a brief RF dropout matters more than a clean state
     machine here — the other foot is never involved.              */
  function cancelReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  async function tryReconnect() {
    if (intentionalDisconnect || !device) return;
    if (reconnectAttempt >= BLE_RECONNECT_TRIES) {
      setStatus('disconnected');
      return;
    }
    reconnectAttempt++;
    setStatus('reconnecting');
    const delay = BLE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt - 1);

    // One timer at a time. Overlapping chains would run concurrent
    // gatt.connect() calls against the same device, which is exactly
    // what makes Windows Chrome drop the link.
    cancelReconnect();
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (intentionalDisconnect || !device) return;
      try {
        await attach(device);
      } catch (err) {
        console.warn(`[BT:${foot}] reconnect ${reconnectAttempt} failed`, err);
        tryReconnect();
      }
    }, delay);
  }

  /* A stable reference, so reconnecting the same device cannot stack up
     duplicate handlers — several firing at once would launch parallel
     reconnect chains against one link. */
  function onGattDisconnected() {
    detachCharacteristic();
    clearFirstDataTimer();
    if (intentionalDisconnect) setStatus('disconnected');
    else tryReconnect();
  }

  /* Release the current device without touching link status. Called
     before binding a new one, so a reconnect still armed from the
     previous attempt cannot fire into the new connection. */
  function releaseDevice() {
    cancelReconnect();
    clearFirstDataTimer();
    detachCharacteristic();
    if (device) {
      device.removeEventListener('gattserverdisconnected', onGattDisconnected);
      if (device.gatt?.connected) {
        try { device.gatt.disconnect(); } catch (_) { /* already gone */ }
      }
    }
    device          = null;
    buffer          = '';
    link.deviceName = null;
    link.deviceId   = null;
  }

  /* ── Public link API ───────────────────────────────────────── */

  link.connect = async function connect(opts = {}) {
    if (!navigator.bluetooth) {
      setStatus('unsupported');
      return false;
    }

    const settings = store.getSettings();
    const services = [...BLE_SERVICE_CANDIDATES];
    if (settings.bleCustomService) services.push(settings.bleCustomService.trim().toLowerCase());

    // acceptAllDevices is the escape hatch for a unit whose advertised
    // service or name does not match anything we filter on.
    const acceptAll = opts.acceptAll ?? settings.bleAcceptAll ?? false;

    const request = acceptAll
      ? { acceptAllDevices: true, optionalServices: services }
      : {
          filters: [
            { services: [BLE_UART.service] },
            ...BLE_NAME_PREFIXES.map(namePrefix => ({ namePrefix })),
          ],
          optionalServices: services,
        };

    try {
      // Repeated taps on the connect chip must not leave the previous
      // attempt's device bound with a reconnect chain still armed.
      intentionalDisconnect = true;
      releaseDevice();
      intentionalDisconnect = false;
      reconnectAttempt      = 0;
      setStatus('scanning');

      const dev = await navigator.bluetooth.requestDevice(request);

      // Refuse a device already bound to the other foot — otherwise one
      // unit silently feeds both silhouettes and the comparison widgets
      // read a perfect 50:50 that means nothing.
      const otherFoot = foot === FOOT.LEFT ? FOOT.RIGHT : FOOT.LEFT;
      if (bluetooth[otherFoot].deviceId && bluetooth[otherFoot].deviceId === dev.id) {
        setStatus('duplicate', `이미 ${FOOT_LABEL_KO[otherFoot]}에 연결된 기기입니다`);
        return false;
      }

      device           = dev;
      link.deviceName  = dev.name || '(이름 없음)';
      link.deviceId    = dev.id;

      device.addEventListener('gattserverdisconnected', onGattDisconnected);

      setStatus('connecting');
      await attach(device);
      return true;
    } catch (err) {
      // A cancelled chooser is a normal outcome, not an error state.
      if (err && err.name === 'NotFoundError') {
        setStatus('disconnected');
      } else {
        console.error(`[BT:${foot}]`, err);
        setStatus('error', err?.message || String(err));
      }
      return false;
    }
  };

  link.disconnect = function disconnect() {
    intentionalDisconnect = true;
    link.stopSimulation();
    releaseDevice();
    link.deviceName = null;
    link.deviceId   = null;
    arrivals.length = 0;
    setStatus('disconnected');
  };

  link.isConnected  = () => device?.gatt?.connected ?? false;
  link.isSimulating = () => simTimer !== null;
  link.isLive       = () => link.isConnected() || link.isSimulating();

  /* Measured sample rate — the RAW monitor uses this to prove a unit
     is actually streaming at 10 Hz and not stalled or flooding. */
  link.sampleRate = function sampleRate() {
    if (arrivals.length < 2) return 0;
    const span = (arrivals[arrivals.length - 1] - arrivals[0]) / 1000;
    return span > 0 ? Math.round((arrivals.length - 1) / span * 10) / 10 : 0;
  };

  /* Which service/characteristic this link is subscribed to, or null.
     The RAW monitor shows it whenever no data has arrived. */
  link.rxInfo = () => (rxSource ? { ...rxSource } : null);

  link.rawLog = () => rawLog.slice();
  link.clearRawLog = () => { rawLog.length = 0; };

  /* ── Simulation ────────────────────────────────────────────────
     Per-foot so the whole two-foot UI can be exercised with no
     hardware present. The two feet are given slightly different
     baselines so left/right comparison widgets show a believable
     asymmetry rather than a flat 50:50.                          */
  link.startSimulation = function startSimulation(drill) {
    link.stopSimulation();

    const bias    = foot === FOOT.LEFT ? 1.0 : 0.88;   // right foot slightly lighter
    const fsrBase = [200, 300, 280, 100].map(v => Math.round(v * bias));
    let simYaw    = foot === FOOT.LEFT ? 2 : -3;

    simTimer = setInterval(() => {
      const fsr = fsrBase.map((base, i) => {
        const pid = `P${i + 1}`;
        const pt  = drill?.points?.find(p => p.id === pid);
        if (!pt) return Math.max(0, base + Math.round((Math.random() - 0.5) * 40));
        const noise = Math.round((Math.random() - 0.5) * 80);
        const spike = Math.random() < 0.08 ? (pt.direction === 'positive' ? -80 : 80) : 0;
        return Math.max(0, Math.min(MAX_SENSOR_VAL, Math.round(pt.thr * bias) + noise + spike));
      });

      simYaw += (Math.random() - 0.48) * 0.5;
      const yawSpike = Math.random() < 0.05 ? (Math.random() < 0.5 ? 12 : -12) : 0;
      const roll  = Math.round(((Math.random() - 0.5) * 1 + (foot === FOOT.LEFT ? 0.6 : -0.4)) * 10) / 10;
      const pitch = Math.round((Math.random() - 0.5) * 2 * 10) / 10;
      const yaw   = Math.round((simYaw + yawSpike) * 10) / 10;

      // Emit a real line through the real receive path. DEMO mode then
      // exercises parsing, ADC normalisation, rate measurement and the
      // RAW monitor exactly as hardware does — which is the whole point
      // of having it when the units are not ready yet.
      dispatch([...fsr, roll, pitch, yaw].join(','));
    }, 100);

    // Announce only once simTimer is assigned: isSimulating() — and
    // therefore isLive() — reads that variable, and every listener
    // reacts to this event by querying link state.
    setStatus('simulating');
  };

  link.stopSimulation = function stopSimulation() {
    if (simTimer) { clearInterval(simTimer); simTimer = null; }
    if (link.status === 'simulating') setStatus('disconnected');
  };

  return link;
}

/* ── Manager: owns both links ────────────────────────────────── */
const bluetooth = (() => {
  const left  = createBleLink(FOOT.LEFT);
  const right = createBleLink(FOOT.RIGHT);

  let _onData   = null;
  let _onStatus = null;
  let _onRaw    = null;

  // Fan the two links into single app-level callbacks that carry the
  // foot along, so consumers never have to subscribe twice.
  for (const l of [left, right]) {
    l.onData   = (values, foot)      => _onData?.(values, foot);
    l.onStatus = (status, foot, err) => _onStatus?.(status, foot, err);
    l.onRaw    = (entry, foot)       => _onRaw?.(entry, foot);
  }

  return {
    left,
    right,

    set onData(fn)   { _onData   = fn; },
    set onStatus(fn) { _onStatus = fn; },
    set onRaw(fn)    { _onRaw    = fn; },

    foot(f) { return f === FOOT.RIGHT ? right : left; },
    each(fn) { fn(left, FOOT.LEFT); fn(right, FOOT.RIGHT); },

    /* Feet currently delivering data (real or simulated). */
    liveFeet()      { return FOOT_IDS.filter(f => this.foot(f).isLive()); },
    isAnyLive()     { return this.liveFeet().length > 0; },
    isBothLive()    { return this.liveFeet().length === 2; },

    disconnectAll() { left.disconnect(); right.disconnect(); },
    stopAllSimulation() { left.stopSimulation(); right.stopSimulation(); },

    /* ── Legacy single-device surface ─────────────────────────────
       Kept so existing call sites (session.js, live tab, config tab)
       keep working unchanged. "Connected" now means *any* foot is
       live, which is what those checks always actually meant: is
       there data coming in at all.                               */
    get status() {
      if (left.status === 'connected' || right.status === 'connected') return 'connected';
      if (left.isSimulating() || right.isSimulating())                 return 'simulating';
      if (left.status === 'no-data' || right.status === 'no-data')     return 'no-data';
      if (left.status === 'reconnecting' || right.status === 'reconnecting') return 'reconnecting';
      if (left.status === 'scanning' || right.status === 'scanning')   return 'scanning';
      if (left.status === 'connecting' || right.status === 'connecting') return 'connecting';
      if (left.status === 'unsupported')                               return 'unsupported';
      if (left.status === 'error' || right.status === 'error')         return 'error';
      return 'disconnected';
    },

    isConnected()  { return left.isConnected() || right.isConnected(); },
    isSimulating() { return left.isSimulating() || right.isSimulating(); },
    disconnect()   { this.disconnectAll(); },
    stopSimulation() { this.stopAllSimulation(); },
  };
})();
