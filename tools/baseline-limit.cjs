#!/usr/bin/env node
/* BASELINE 흔들림 한계를 쌓인 시도 기록에서 뽑는다.

   사용법:
     node tools/baseline-limit.cjs onyx-baseline-trials.json

   BASELINE 화면의 "기록 내보내기"가 만든 파일이나 전체 백업 JSON을
   그대로 넣으면 된다.

   ── 왜 이 스크립트가 있는가 ─────────────────────────────────
   코드에 박혀 있던 한계 35는 맨발 기준으로 정해진 초기값이다. 신발을
   신으면 센서가 700~800까지 눌린 채로 시작하고, 같은 자세로 가만히
   있어도 폭이 그보다 훨씬 크게 나온다. 그 상태에서 35를 쓰면 정상적인
   측정이 전부 걸린다.

   맞는 숫자를 앉아서 정할 방법은 없다. 실제로 재고, 분포를 보고,
   거기서 고르는 것이 유일한 방법이다. 이 스크립트는 그 분포를 보여주고
   후보 한계마다 "지금까지의 측정 중 몇 퍼센트가 걸렸을 것인가"를
   같이 찍는다. 고르는 것은 사람이 한다.

   ── 무엇을 세는가 ──────────────────────────────────────────
   한 번의 측정이 발 하나당 기록 하나이고, 그 안에 채널이 넷이다.
   한계는 채널 단위로 걸리지만 치료사가 겪는 것은 측정 단위다("또
   걸렸다"). 그래서 채널 분포와 측정 단위 적중률을 둘 다 찍는다.

   시뮬레이션(simulated) 기록과 수신 자체가 부실했던 기록(blocked)은
   뺀다. 앞쪽은 실제 센서가 아니고, 뒤쪽은 그 baseline 자체를 믿을 수
   없어서 흔들림을 논할 값이 아니다. */

const fs = require('node:fs');

const file = process.argv[2];
if (!file) {
  console.error('사용법: node tools/baseline-limit.cjs <내보낸 JSON 파일>');
  process.exit(2);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`파일을 읽을 수 없습니다: ${err.message}`);
  process.exit(2);
}

const trials = data.trials || data.baselineTrials || (Array.isArray(data) ? data : null);
if (!Array.isArray(trials)) {
  console.error('시도 기록을 찾지 못했습니다. BASELINE 화면의 "기록 내보내기" 파일이나 전체 백업 JSON을 넣으세요.');
  process.exit(2);
}

const usable = trials.filter(t =>
  Array.isArray(t.spread) && t.spread.length && !t.simulated && t.outcome !== 'blocked');

const skipped = trials.length - usable.length;

/* 선형 보간 없는 단순 백분위. 표본이 수십 개인 상황에서 보간은
   정확도를 더하지 않고 숫자만 어렵게 만든다. */
function pct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

const FOOTWEAR = {
  none:  '맨발 · 미착용',
  shoes: '신발 착용',
};

function label(key) {
  return FOOTWEAR[key] || `미기록 (${key})`;
}

function report(key, group) {
  const channelSpreads = group.flatMap(t => t.spread.map(Number)).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`\n── ${label(key)} ─────────────────────────────`);
  console.log(`측정 ${group.length}건 · 채널 표본 ${channelSpreads.length}개`);

  if (!channelSpreads.length) { console.log('표본이 없습니다.'); return; }

  const dist = [
    ['최소', pct(channelSpreads, 0)],
    ['p50 ', pct(channelSpreads, 0.50)],
    ['p75 ', pct(channelSpreads, 0.75)],
    ['p90 ', pct(channelSpreads, 0.90)],
    ['p95 ', pct(channelSpreads, 0.95)],
    ['최대', channelSpreads[channelSpreads.length - 1]],
  ];
  console.log('\n채널 흔들림 분포 (P90-P10, ADC 카운트)');
  for (const [name, v] of dist) console.log(`  ${name}  ${v}`);

  // 채널별로 갈라 본다. 한 채널만 계속 나쁘면 한계값이 아니라 그
  // 채널의 장착을 고쳐야 한다.
  console.log('\n채널별 중앙값 — 한 채널만 크면 한계가 아니라 장착 문제입니다');
  for (let ch = 0; ch < 4; ch++) {
    const xs = group.map(t => Number(t.spread[ch])).filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) continue;
    console.log(`  CH${ch + 1}  중앙값 ${pct(xs, 0.5)}  최대 ${xs[xs.length - 1]}`);
  }

  // 후보 한계마다 측정 단위 적중률. 치료사가 겪는 단위가 이쪽이다.
  console.log('\n후보 한계별로 걸렸을 측정 비율');
  const candidates = [...new Set([35, pct(channelSpreads, 0.75), pct(channelSpreads, 0.90), pct(channelSpreads, 0.95)]
    .map(v => Math.ceil(v / 5) * 5))].sort((a, b) => a - b);
  for (const limit of candidates) {
    const flagged = group.filter(t => t.spread.some(v => Number(v) > limit)).length;
    const share = Math.round(flagged / group.length * 100);
    console.log(`  한계 ${String(limit).padStart(4)}  →  ${String(flagged).padStart(4)}/${group.length} 측정 (${share}%)에서 경고`);
  }

  const recommend = Math.ceil(pct(channelSpreads, 0.90) / 5) * 5;
  console.log(`\n권장 ${recommend}  (채널 p90을 5 단위로 올림)`);
  if (group.length < 10) {
    console.log('다만 측정이 10건 미만입니다. 이 숫자는 참고만 하고 더 모으세요.');
  }

  const applied = [...new Set(group.map(t => t.maxSpreadApplied).filter(Number.isFinite))];
  if (applied.length) console.log(`이 기록들이 판정될 때 적용된 한계: ${applied.join(', ')}`);

  const notes = group.map(t => t.note).filter(Boolean);
  if (notes.length) {
    console.log(`\n사유를 남기고 진행한 측정 ${notes.length}건`);
    for (const n of [...new Set(notes)].slice(0, 8)) console.log(`  · ${n}`);
  }
}

console.log(`총 ${trials.length}건 중 ${usable.length}건 분석 (시뮬레이션·수신 실패 ${skipped}건 제외)`);

const groups = new Map();
for (const t of usable) {
  const key = t.footwear || 'unknown';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
}

if (!groups.size) {
  console.log('\n분석할 기록이 없습니다.');
  process.exit(0);
}

for (const key of [...groups.keys()].sort()) report(key, groups.get(key));

console.log('\n고른 값은 CONFIG → 🛠 개발 도구 → BASELINE 흔들림 한계에 넣습니다.');
console.log('맨발과 신발 착용은 반드시 따로 넣으세요.');
