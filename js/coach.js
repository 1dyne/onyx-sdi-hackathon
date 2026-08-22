/* ─────────────────────────────────────────────────────────────
   AI 조교 — 세션 요약을 문장으로 바꾼다.

   두 갈래가 있고 둘 다 항상 살아 있다:
     1) OpenAI  — CONFIG에 키가 있으면 사용
     2) 로컬 규칙 — 키가 없거나, 오프라인이거나, 호출이 실패했을 때

   현장 wifi는 믿을 게 못 되므로 2번이 없으면 안 된다. 리포트가
   비어 있는 화면을 보여주느니 수치 기반 문장이라도 내는 편이 낫다.
   ───────────────────────────────────────────────────────────── */

const coach = (() => {

  /* ── 표정 ────────────────────────────────────────────────────
     AI가 이 목록에서 직접 고른다. 목록 밖의 것을 만들어내면
     점수 기반으로 대체한다 — 렌더링이 깨지는 일은 없어야 한다. */
  const FACES = {
    'ಠ益ಠ': '인내심 한계',
    'ಠ︵ಠ': '매우 못마땅함',
    'ಠ▃ಠ': '말문 막힘',
    'ಠ‿ಠ': '웃고 있는데 무서움',
    'ò益ó': '진심으로 화남',
    'ó_ò': '화났는데 약간 상처받음',
    'Ò益Ó': '즉시 수정 요구',
    'Ò皿Ó': '폭발 직전',
    '｀_´': '엄격',
    '´_｀': '깊은 한숨',
    '￢_￢': '의심',
    '≖_≖': '수상하게 봄',
    '◣_◢': '보스전 조교',
    '▼_▼': '조용한 압박',
    'ಠ_ó': '한쪽 눈만 더 화남',
    'ò_ಠ': '납득 안 됨',
    'o_o': '기본 — 보고 있음',
    '-_-': '또 그러시네요',
    '._.': '...왜 그렇게 했죠?',
    'o_O': '잠깐, 이게 뭐죠?',
    'O_O': '아니 잠깐만요',
    '>_>': '의심스럽게 로그 확인 중',
    '<_<': '옆에서 지켜보는 중',
    '-_o': '설명을 다시 들어보겠습니다',
    'o_-': '이해는 했는데 납득은 안 됨',
    '^_^': '잘했습니다',
    '^_~': '이번엔 넘어가 드리죠',
    ';_;': '왜 제 말을 안 들으셨어요...',
    'x_x': '학생 코드에 사망',
    '@_@': '디버깅 4시간째',
    '!_!': '잠깐. 멈추세요.',
  };

  const FACE_KEYS = Object.keys(FACES);

  /* 점수만으로 표정을 고르는 대체 경로. AI가 목록 밖의 것을
     내놓거나 API를 아예 못 쓸 때 쓴다. */
  function faceForQuality(q) {
    if (q >= 95) return '^_^';
    if (q >= 85) return '^_~';
    if (q >= 70) return 'o_o';
    if (q >= 55) return '￢_￢';
    if (q >= 40) return '-_-';
    if (q >= 25) return 'ಠ︵ಠ';
    return 'ಠ益ಠ';
  }

  function renderFace(face) { return `[| ${face} |]`; }

  /* ── 페이로드 ──────────────────────────────────────────────
     세션 로그에서 조교가 판단에 쓸 수치만 뽑는다. 원본 로그를
     통째로 보내면 토큰만 먹고 모델이 헤맨다. */
  function buildPayload(log) {
    const feet = log.feet || [];

    const byFoot = {};
    for (const f of feet) {
      const bf = log.byFoot?.[f];
      if (!bf) continue;

      const channels = {};
      for (const [pid, ps] of Object.entries(bf.pointStats || {})) {
        channels[pid] = {
          이름:     PRESSURE_POINTS[pid]?.label || pid,
          평균압력: ps.avg,
          최대압력: ps.max ?? null,
          이탈횟수: ps.alertCount,
        };
      }

      byFoot[FOOT_LABEL_KO[f]] = {
        정확도:      bf.quality,
        총이탈횟수:  bf.alertCount,
        샘플수:      bf.samples,
        채널:        channels,
        roll편차평균: bf.roll ? bf.roll.avgDev : null,
        roll편차최대: bf.roll ? bf.roll.maxDev : null,
      };
    }

    const rec = log.record || {};
    return {
      동작:        log.drillTitle,
      동작종류:    DRILL_TYPES[log.drillType]?.label || log.drillType,
      세션시간초:  log.duration,
      전체정확도:  log.quality,
      전체이탈횟수: log.alertCount,
      발:          byFoot,
      // 한쪽 발만 연결된 세션은 좌우 비교가 무의미하다는 걸 모델도 알아야 한다.
      측정한발:    feet.map(f => FOOT_LABEL_KO[f]),
      에너지상태:  rec.energy ?? null,
      환경:        rec.environment === 'indoor' ? '실내' : rec.environment === 'outdoor' ? '실외' : null,
      특이사항:    rec.note || null,
    };
  }

  /* ── 시스템 프롬프트 ───────────────────────────────────── */
  function systemPrompt() {
    const faceList = FACE_KEYS.map(k => `${k} = ${FACES[k]}`).join('\n');
    return `너는 ONYX SDI의 훈련 조교다.

원칙:
- 짧게 말한다. 3~4문장.
- 수치를 근거로 말한다. "잘했다"보다 "뒤꿈치 착지가 78%다".
- 나아진 지점을 반드시 하나 짚는다.
- 고칠 지점도 하나만 짚는다. 여러 개 나열하지 않는다.
- 의학적 진단이나 처방은 하지 않는다.
- 에너지 상태가 낮은 날은 그걸 감안해서 평가한다.

말투:
- 군대 조교처럼 간결하고 단호하다.
- 비꼬거나 깎아내리지 않는다.
  사용자는 부하가 아니라 훈련 대상이자 동료다.
- 마지막은 다음 훈련에 대한 한 줄 지시로 끝낸다.

표정:
아래 목록에서 이번 세션에 맞는 것을 정확히 하나 고른다.
목록에 없는 표정은 절대 만들지 않는다.
${faceList}

출력은 JSON 하나로만 한다:
{"face": "<목록의 표정 문자열 그대로>", "report": "<3~4문장 리포트>"}`;
  }

  /* ── OpenAI 호출 ───────────────────────────────────────────
     SDK 없이 fetch만 쓴다. 정적 호스팅이라 번들러가 없고,
     엔드포인트 하나에 SDK를 끌어올 이유가 없다. */
  async function callOpenAI(payload, { apiKey, model, signal }) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.7,
        max_tokens: 400,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user',   content: JSON.stringify(payload, null, 1) },
        ],
      }),
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      /* fetch() rejects with a bare TypeError for anything the browser
         refused to send — CORS, an offline radio, a captive portal, a
         corporate proxy. The raw message ("Failed to fetch") tells the
         user nothing, and the wrong guess here costs an hour. */
      throw new Error(
        '브라우저가 요청을 보내지 못했습니다 (CORS·네트워크·차단). ' +
        '키 문제가 아닙니다 — 키가 틀렸다면 401이 돌아옵니다.'
      );
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch (_) {}
      const hint = res.status === 401 ? ' (키가 틀렸거나 만료됨)'
                 : res.status === 429 ? ' (크레딧 소진 또는 요청 한도)'
                 : res.status === 404 ? ' (모델 이름을 확인하세요)'
                 : '';
      throw new Error(`OpenAI ${res.status}${hint}${detail ? ' — ' + detail : ''}`);
    }

    const data = await res.json();
    const raw  = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('빈 응답');

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (_) { throw new Error('JSON 파싱 실패'); }

    const text = String(parsed.report || '').trim();
    if (!text) throw new Error('리포트 본문 없음');

    // A face outside the list would render as garbage, so it is
    // replaced rather than trusted.
    const face = FACE_KEYS.includes(parsed.face)
      ? parsed.face
      : faceForQuality(payload.전체정확도 ?? 0);

    return { face, text, model: data.model || model, source: 'openai' };
  }

  /* 받침 유무에 따라 조사를 고른다. 압점 이름이 '아치'(받침 없음)와
     '뒷꿈치 외측'(받침 있음)처럼 섞여 있어서, 고정 조사를 쓰면
     "외측가 이탈했다" 같은 문장이 그대로 화면에 나간다. */
  function josa(word, withFinal, withoutFinal) {
    const ch = String(word).trim().slice(-1);
    const code = ch.charCodeAt(0);
    // 한글 음절 영역이 아니면(숫자·영문) 받침 없는 쪽을 쓴다.
    if (code < 0xAC00 || code > 0xD7A3) return withoutFinal;
    return ((code - 0xAC00) % 28) !== 0 ? withFinal : withoutFinal;
  }

  /* ── 로컬 대체 리포트 ──────────────────────────────────────
     같은 원칙을 그대로 따른다: 수치 근거, 나아진 점 하나,
     고칠 점 하나, 마지막은 다음 훈련 지시. */
  function localReport(payload) {
    const q     = payload.전체정확도 ?? 0;
    const feet  = Object.entries(payload.발);
    const lines = [];

    lines.push(`${payload.동작}, ${payload.세션시간초}초. 정확도 ${q}%다.`);

    // 가장 많이 이탈한 채널 하나 = 고칠 지점
    let worst = null;
    for (const [footName, fd] of feet) {
      for (const [pid, ch] of Object.entries(fd.채널 || {})) {
        if (!worst || ch.이탈횟수 > worst.ch.이탈횟수) worst = { footName, pid, ch };
      }
    }

    // 이탈이 가장 적은 채널 하나 = 나아진 지점
    let best = null;
    for (const [footName, fd] of feet) {
      for (const [pid, ch] of Object.entries(fd.채널 || {})) {
        if (!best || ch.이탈횟수 < best.ch.이탈횟수) best = { footName, pid, ch };
      }
    }

    if (best) {
      const j = josa(best.ch.이름, '은', '는');
      lines.push(`${best.footName} ${best.ch.이름}${j} 이탈 ${best.ch.이탈횟수}회로 안정적이다. 그건 유지해라.`);
    }
    if (worst && worst.ch.이탈횟수 > 0) {
      const j = josa(worst.ch.이름, '이', '가');
      lines.push(`${worst.footName} ${worst.ch.이름}${j} ${worst.ch.이탈횟수}회 이탈했다. 평균 ${worst.ch.평균압력}, 최대 ${worst.ch.최대압력}이다.`);
    }

    if (payload.에너지상태 !== null && payload.에너지상태 <= 4) {
      lines.push(`에너지 ${payload.에너지상태}/10인 날 기준으로는 나쁘지 않다. 다음엔 컨디션 올려서 같은 동작 한 번 더 간다.`);
    } else {
      const target = worst ? worst.ch.이름 : '전체';
      lines.push(`다음 훈련은 ${target}${josa(target, '', '')} 하나만 보고 간다.`);
    }

    return { face: faceForQuality(q), text: lines.join(' '), model: null, source: 'local' };
  }

  /* ── 공개 API ──────────────────────────────────────────── */
  return {
    FACES,
    renderFace,
    faceForQuality,
    buildPayload,

    /* 설정상 조교를 쓸 수 있는지 (키 유무와 무관 — 키가 없으면
       로컬 리포트로 내려간다). */
    isEnabled() { return store.getSettings().coachEnabled !== false; },
    hasApiKey() { return !!(store.getSettings().coachApiKey || '').trim(); },

    /* 항상 리포트를 돌려준다. 실패는 예외가 아니라 source:'local' +
       error 필드로 표현된다 — 호출부가 화면을 비울 일이 없어야 한다. */
    async report(log, { signal } = {}) {
      const payload  = buildPayload(log);
      const settings = store.getSettings();
      const apiKey   = (settings.coachApiKey || '').trim();
      const model    = (settings.coachModel || 'gpt-4o-mini').trim();

      if (!apiKey) {
        return { ...localReport(payload), at: Date.now(), reason: 'no-key' };
      }

      try {
        const r = await callOpenAI(payload, { apiKey, model, signal });
        return { ...r, at: Date.now() };
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        console.warn('[coach] OpenAI 실패 — 로컬 리포트로 대체:', err?.message || err);
        return { ...localReport(payload), at: Date.now(), error: err?.message || String(err) };
      }
    },
  };
})();
