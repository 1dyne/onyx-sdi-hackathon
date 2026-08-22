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
   Both units (ESP32 left, NUCODE NU40/nRF52840 right) expose the
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

const MAX_SENSOR_VAL  = 1023;
const GAIT_ACTIVE_THR = 80;   // raw value above which a point is considered "active" in gait check
const REQUIRED_POINTS = 4;    // drills always use exactly 4 active points
