const PRESSURE_POINTS = {
  // Left foot, plantar view (sole up), toes top.
  // Inner (medial) = right of screen; outer (lateral) = left of screen.
  // SVG viewBox: 0 0 200 400. Coordinates matched to anatomical foot path.
  P1: { id:'P1', name:'Toe-1 Tip', label:'엄지 끝',    defaultDirection:'positive', svgX:152, svgY:26  }, // big-toe tip
  P2: { id:'P2', name:'Met-1',     label:'엄지 뿌리',  defaultDirection:'positive', svgX:150, svgY:108 }, // 1st metatarsal head (inner ball)
  P3: { id:'P3', name:'Met-5',     label:'소지 뿌리',  defaultDirection:'positive', svgX:62,  svgY:102 }, // 5th metatarsal head (outer ball)
  P4: { id:'P4', name:'Arch',      label:'아치',       defaultDirection:'negative', svgX:148, svgY:224 }, // medial arch (inner side, hollow)
  P5: { id:'P5', name:'Heel-L',    label:'뒷꿈치 내측', defaultDirection:'negative', svgX:132, svgY:326 }, // inner heel pad
  P6: { id:'P6', name:'Heel',      label:'뒷꿈치 중앙', defaultDirection:'positive', svgX:98,  svgY:352 }, // center heel pad
  P7: { id:'P7', name:'Heel-M',    label:'뒷꿈치 외측', defaultDirection:'positive', svgX:64,  svgY:326 }, // outer heel pad
};

const POINT_IDS = ['P1','P2','P3','P4','P5','P6','P7'];

/* ── Pressure-dot geometry (viewBox units, 0 0 200 400) ────
   The tightest pair on the silhouette is the heel row: P5→P6 and
   P6→P7 are both ~42.8 units apart, so anything past r=21 makes those
   three overlap. That is the hard ceiling on the touch target.

   Hence two concentric circles in CONFIG: the visible dot stays at 16
   so the heel row still reads as three separate points, and an
   invisible 21 sits on top of it so a finger gets ~3.4x the area of
   the old r=11 dot. CONFIG is used on a phone while someone is
   fitting an insole, so that difference is one tap versus four. */
const PP_DOT_R        = 9;   // LIVE — display only, never tapped
const PP_DOT_R_CONFIG = 16;  // CONFIG — visible selectable dot
const PP_HIT_R        = 21;  // CONFIG — invisible touch target

/* ── Point → FSR channel ───────────────────────────────────
   The units carry FOUR FSR channels; the silhouette offers SEVEN
   candidate positions. A drill names the four positions the sensors
   are actually mounted at, and those map to channels 1-4 in
   anatomical order (P1 before P2 before … P7).

   Before this existed the code indexed values[] as P{n} → values[n-1],
   which silently read roll/pitch/yaw as pressure for any drill using
   P5/P6/P7 — those channels do not exist on the hardware. For the
   ordinary P1-P4 drill the mapping below is the identity, so nothing
   about existing drills changes.

   The cache matters: this is called per point, per sample, per foot,
   which is 80 lookups a second with both units streaming. */
const _channelCache = new WeakMap();

function channelMap(points) {
  if (!points) return null;
  let m = _channelCache.get(points);
  if (m) return m;
  m = new Map();
  points.map(p => p.id).sort().forEach((id, i) => m.set(id, i));
  _channelCache.set(points, m);
  return m;
}

/* Channel index for one point id, or -1 if the drill does not use it.
   `points` is a drill's points array; pass null for the raw P1-P4
   layout used by FREE CAPTURE. */
function channelOf(points, pid) {
  if (!points) return parseInt(pid.slice(1)) - 1;
  const m = channelMap(points);
  return m.has(pid) ? m.get(pid) : -1;
}

const DRILL_TYPES = {
  static: { label:'Static', color:'#5588cc' },
  gait:   { label:'Gait',   color:'#cc8844' },
  custom: { label:'Custom', color:'#8855cc' },
};

// Gait phase sequence: each array is a group that must activate in order
const GAIT_SEQUENCE = [
  ['P5','P6','P7'],  // phase 0: Heel
  ['P2','P3'],       // phase 1: Met
  ['P1'],            // phase 2: Toe-1
];

const BLE_UART = {
  service: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  tx:      '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  rx:      '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
};

/* ── Feet ──────────────────────────────────────────────────
   Both units (NUCODE NU40 / nRF52840, LSM6DS3TR-C) expose the
   identical Nordic UART profile and the same 0-1023 payload, so the
   only thing that distinguishes them is which button the user pressed.
   Nothing in the app infers side from the device name.             */
const FOOT      = { LEFT: 'left', RIGHT: 'right' };
const FOOT_IDS  = ['left', 'right'];
const FOOT_LABEL = { left: 'LEFT', right: 'RIGHT' };
const FOOT_LABEL_KO = { left: '왼발', right: '오른발' };

/* Services offered to requestDevice(). Web Bluetooth blocks access to
   any service not declared up front, so a board with a non-Nordic
   serial profile could not be reached without listing it here. Both
   current units are Nordic UART; the rest is insurance, and CONFIG
   can append one more UUID at runtime without a code change.       */
const BLE_SERVICE_CANDIDATES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART — both units
  0xffe0,                                  // HM-10 / JDY family
  0xfff0,                                  // common vendor serial
];

/* Name prefixes shown in the device chooser. Used only to shorten the
   list — never to decide which foot a device belongs to. */
const BLE_NAME_PREFIXES = ['Onyx', 'ONYX', 'NU', 'ESP'];

const BLE_RECONNECT_TRIES  = 3;
const BLE_RECONNECT_DELAY  = 1200;  // ms, doubled each retry
const RAW_LOG_SIZE         = 40;    // lines kept per foot for the RAW monitor

/* ── GATT attach timing ────────────────────────────────────
   Chrome on Windows resolves gatt.connect() a beat before service
   discovery is actually usable on the link. Calling getPrimaryService()
   in that window fails with "GATT Server is disconnected", and the
   failure is transient — the same call succeeds a moment later. Hence a
   settle delay before discovery and a short retry loop around the whole
   attach, rather than surfacing the first race as a connection error. */
const BLE_ATTACH_TRIES     = 3;
const BLE_ATTACH_RETRY_MS  = 300;   // wait between attach attempts
const BLE_GATT_SETTLE_MS   = 200;   // wait after gatt.connect() before discovery

/* A GATT link can come up and then deliver nothing (wrong characteristic,
   firmware not streaming). Data is what matters, so the link only claims
   'connected' once a notification actually lands; until then it is
   'no-data' and the UI says so. */
const BLE_FIRST_DATA_MS    = 2000;

/* ── 원시 샘플 기록 ────────────────────────────────────────
   세션 로그는 집계값만 남긴다 — 평균·최대·이탈 횟수·경고 타임라인.
   그것만으로는 "언제 닿아서 언제 떨어졌는지"를 되짚을 수 없어서,
   연속 동작 인식이나 contact time 같은 걸 나중에 만들려면 측정을
   처음부터 다시 해야 한다. 그래서 10Hz 스트림을 그대로 남긴다.

   한 샘플은 [t, f1, f2, f3, f4, roll, pitch, yaw] 배열 하나다.
   객체로 두면 키 이름이 샘플마다 반복돼 용량이 세 배가 된다.

   10Hz × 양발 × 20분 = 24,000 샘플 ≈ 1MB. localStorage는 보통
   5MB 언저리이므로 상한을 두고, 넘으면 기록만 멈춘다 — 세션 자체는
   끝까지 정상으로 남아야 한다. */
const RAW_RECORD_MAX_SAMPLES = 12000;   // 발당. 10Hz 기준 20분
const RAW_SCHEMA             = 1;

const MAX_SENSOR_VAL  = 1023;
const GAIT_ACTIVE_THR = 80;   // raw value above which a point is considered "active" in gait check
const REQUIRED_POINTS = 4;    // drills always use exactly 4 active points
