/* 판정 엔진 — 단위와 좌우 분리.

   여기서 지키려는 것은 두 가지다.
   1) 임계값과 비교되는 값은 언제나 baseline을 뺀 delta다. 신발을 신으면
      센서가 700~800에서 시작하므로, 원시값을 비교하면 positive는 절대
      도달하지 못하고 negative는 항상 넘는다.
   2) 좌우 절대 임계값은 따로다. 두 유닛은 서로 다른 신발에 들어간
      별개 기구라 장착 압력이 다르다. */
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const context = {};
vm.createContext(context);
for (const f of ['../js/constants.js', '../js/alert.js']) {
  vm.runInContext(fs.readFileSync(require.resolve(f), 'utf8'), context);
}
vm.runInContext('globalThis.t = { alertEngine, GAIT_ACTIVE_THR, GAIT_SEQUENCE };', context);
const { alertEngine } = context.t;

/* `channel`은 store.getDrills()가 저장된 드릴에 채워 넣는 값이다.
   판정 엔진은 그 인덱스로 values를 읽으므로 테스트에서도 명시한다. */
const point = (id, channel, direction, thr, extra = {}) => ({
  id, channel, direction, thr, thrMode: 'absolute', thrPercent: 80,
  reference: { left: null, right: null }, ...extra,
});

/* ── 좌우 절대 임계값 ─────────────────────────────────────── */
const drill = {
  channels: ['P6', 'P3', 'P2', 'P1'],
  points: [
    point('P6', 0, 'positive', { left: 100, right: 140 }),
    point('P3', 1, 'negative', { left: 200, right: 200 }),
  ],
};

/* alertEngine은 vm 컨텍스트 안에서 돌아서 배열의 프로토타입이 다르다.
   Array.from으로 이쪽 realm의 배열로 옮겨야 deepEqual이 통한다. */
const ids = alerts => Array.from(alerts, a => a.pointId).sort();

assert.deepEqual(ids(alertEngine.check(drill, [130, 50, 0, 0], 'left').alerts), [],
  'left THR 100 — delta 130 is above it');
assert.deepEqual(ids(alertEngine.check(drill, [130, 50, 0, 0], 'right').alerts), ['P6'],
  'right THR 140 — the same delta must fail on the other foot');

/* 마이그레이션 전 드릴은 숫자 하나를 들고 있다. 양발에 같이 쓰는
   것이 그 드릴의 기존 동작이므로 그대로 읽는다. */
const legacy = { channels: ['P6'], points: [point('P6', 0, 'positive', 120)] };
assert.equal(alertEngine.getThr(legacy.points[0], 'left'), 120);
assert.equal(alertEngine.getThr(legacy.points[0], 'right'), 120);

/* ── 단위 ─────────────────────────────────────────────────
   영점을 뺀 뒤 아무 것도 안 밟은 상태는 delta 0이다. 이때
   positive는 걸리고 negative는 걸리지 않아야 한다. 예전처럼 원시값
   780이 들어오면 정확히 반대가 된다. */
const idle = alertEngine.check(drill, [0, 0, 0, 0], 'left').alerts;
assert.deepEqual(ids(idle), ['P6'], 'unloaded foot fails the positive point only');

const preload = alertEngine.check(drill, [780, 780, 0, 0], 'left').alerts;
assert.deepEqual(ids(preload), ['P3'],
  'raw shoe pre-load would breach the negative point — the regression this guards');

/* ── 정확도 ──────────────────────────────────────────────── */
const calibrated = {
  channels: ['P6'],
  points: [point('P6', 0, 'positive', { left: 100, right: 100 },
    { reference: { left: 200, right: 400 } })],
};
assert.equal(alertEngine.calcAccuracy(calibrated.points, [200], 'left'), 100);
assert.equal(alertEngine.calcAccuracy(calibrated.points, [200], 'right'), 50,
  'each foot scores against its own reference');
assert.equal(alertEngine.getEffectiveThr(calibrated.points[0], 'left'), 100,
  'absolute mode ignores the reference');

const percent = { ...calibrated.points[0], thrMode: 'percent', thrPercent: 80 };
assert.equal(alertEngine.getEffectiveThr(percent, 'left'), 160);
assert.equal(alertEngine.getEffectiveThr(percent, 'right'), 320);

/* ── 보행 순서 ────────────────────────────────────────────
   GAIT_ACTIVE_THR도 delta 기준이다. 영점을 뺀 값이 0이면 어떤 구간도
   활성이 아니어야 한다. 원시값으로 재던 시절에는 신발만 신어도 모든
   구간이 항상 활성이라 매 샘플 순서 오류가 났다. */
const gaitPoints = [
  { id: 'P6', channel: 0 }, { id: 'P3', channel: 1 },
  { id: 'P2', channel: 2 }, { id: 'P1', channel: 3 },
];
const checker = alertEngine.createGaitChecker(gaitPoints);
let now = 0;
const step = (values) => checker.check(values, (now += 100)).gaitError;

assert.equal(step([0, 0, 0, 0]), false, 'a zeroed foot is not mid-stance');
assert.equal(step([200, 0, 0, 0]), false, 'heel first');
assert.equal(step([0, 200, 0, 0]), false, 'then the met heads');
assert.equal(step([0, 0, 0, 200]), false, 'then the hallux');

const wrong = alertEngine.createGaitChecker(gaitPoints);
let t2 = 0;
assert.equal(wrong.check([200, 0, 0, 200], (t2 += 100)).gaitError, true,
  'heel and toe together is out of sequence');

console.log('alert tests: ok');
