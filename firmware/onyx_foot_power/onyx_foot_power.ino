// POWER UPDATE: read README before upload. CH4 A0 -> A3; IMU address 0x6A -> 0x6B.
/* ─────────────────────────────────────────────────────────────
   Onyx SDI 유닛 — FSR 4채널 + LSM6DS3TR-C IMU, Nordic UART 10Hz 송신
   NU40 / nRF52840 (Adafruit nRF52 보드 패키지)

   ★ 양발 공용 스케치다. 아래 FOOT_NAME 한 줄만 바꿔서 각각 굽는다.
     왼발  → "Onyx-L"
     오른발 → "Onyx-R"
   이름이 겹치면 기기 선택창에서 어느 쪽인지 구분할 수 없다.

   전송 규약 (대시보드와 고정, 건드리지 말 것):
     fsr1,fsr2,fsr3,fsr4,roll,pitch,yaw\n
   FSR 0–1023(10-bit), 각도 degree, 10Hz, 줄 끝에 반드시 \n
   ───────────────────────────────────────────────────────────── */

#define FOOT_NAME "Onyx-L"     // ←←← 여기만 바꾼다 (오른발은 "Onyx-R")

#include <Adafruit_TinyUSB.h>
#include <bluefruit.h>
#include <Wire.h>
#include <Adafruit_LSM6DS3TRC.h>
#include <MadgwickAHRS.h>
#include "onyx_power.h"

BLEUart bleuart;
Adafruit_LSM6DS3TRC imu;
Madgwick filter;

/* ★ 핀 순서 = 채널 순서다. 대시보드는 채널 1~4를 양발에서 같은
   해부학적 위치로 취급한다. 왼발의 A4에 엄지쪽 FSR이 붙어 있는데
   오른발은 A4가 뒤꿈치라면, 좌우 비교 위젯이 통째로 거짓말이 된다.
   앱에서는 고칠 수 없다 — 배선 순서를 반드시 양발 동일하게 맞출 것.
   확인 방법은 아래 "굽고 나서" 참고. */
const int FSR_PINS[4] = {A4, A2, A1, ONYX_FSR_CH4_PIN};  // 빨강, 노랑, 초록, 파랑

/* ── FSR 읽기 ──────────────────────────────────────────────
   채널당 한 번만 읽던 것을 5회 읽어 중앙값을 보낸다.

   대시보드의 baseline 검사는 3초 동안 받은 값의 P90에서 P10을 뺀
   폭을 본다. 신발을 신으면 센서가 이미 눌린 채로 시작해서 그 폭이
   수십 카운트까지 벌어지는데, 그중 상당 부분은 발이 실제로 움직인
   것이 아니라 SAADC 단발 측정의 흔들림이다. 중앙값은 그 흔들림과
   튀는 한 점을 같이 눌러준다. 평균이 아니라 중앙값인 이유가 그
   튀는 한 점이다 — 평균은 끌려가고 중앙값은 버린다.

   비용은 100ms 주기 안에서 20회 변환, 1ms가 채 안 된다. 전송 규약과
   10Hz 주기는 그대로다 — 대시보드가 보는 것은 여전히 0~1023 한 줄이고,
   달라지는 것은 그 한 줄이 얼마나 안정된 값이냐뿐이다. */
#define FSR_SAMPLES 5

static int readFsr(int pin) {
  int a[FSR_SAMPLES];
  for (int i = 0; i < FSR_SAMPLES; i++) {
    int v = analogRead(pin);
    int j = i;
    while (j > 0 && a[j - 1] > v) { a[j] = a[j - 1]; j--; }   // 삽입 정렬
    a[j] = v;
  }
  return a[FSR_SAMPLES / 2];
}

const unsigned long PERIOD = 100;          // 10Hz
unsigned long lastSend = 0;
bool imuOk = false;

// 중앙(폰)이 CCCD를 써서 notify를 켰는지. false인 동안
// bleuart.write()는 0을 반환하고 아무것도 나가지 않는다.
bool lastNotify = false;

/* Serial이 열려 있지 않을 때 USB CDC로 밀어넣지 않는다.
   배터리 구동(호스트 없음)에서 루프가 끌려가는 것을 막는다. */
#define LOG(...) do { if (Serial) Serial.printf(__VA_ARGS__); } while (0)

void connect_callback(uint16_t conn_handle) {
  BLEConnection* conn = Bluefruit.Connection(conn_handle);
  char name[32] = { 0 };
  conn->getPeerName(name, sizeof(name));
  LOG("[BLE] connected: %s  mtu=%u\n", name, (unsigned)conn->getMtu());
}

void disconnect_callback(uint16_t conn_handle, uint8_t reason) {
  (void) conn_handle;
  lastNotify = false;
  // 0x13=원격이 끊음, 0x08=연결 타임아웃, 0x22=LMP 타임아웃
  LOG("[BLE] disconnected, reason=0x%02X\n", reason);
}

void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  /* 코어 기본 획득 시간은 3µs이고, nRF52840에서 그 값이 감당하는
     소스 임피던스는 10kΩ까지다. FSR 분압은 10kΩ 풀업이라 강하게
     눌린 동안은 여유가 있지만, 약하게 눌린 구간에서는 FSR 저항이
     커지면서 그 한계에 붙는다. 덜 충전된 샘플 커패시터가 곧 흔들리는
     값이므로 10µs를 준다. 20회를 읽어도 200µs다. */
  analogSampleTime(10);

  Wire.begin();
  Wire.setClock(400000);
  imuOk = imu.begin_I2C(ONYX_IMU_ADDRESS); // Requires IMU SA0 high; never fall back to charger address 0x6A.

  filter.begin(10);

  /* config***() 계열은 SoftDevice의 RAM 배치와 ATT MTU를 정하므로
     반드시 begin() '앞'에서 호출해야 한다. begin() 뒤에 부르면
     조용히 무시되고 MTU가 기본 20바이트에 머문다 — 그러면 38바이트
     한 줄이 두 패킷으로 쪼개지고 줄바꿈이 유실될 수 있다. */
  Bluefruit.configPrphBandwidth(BANDWIDTH_MAX);

  Bluefruit.begin();
  Bluefruit.setTxPower(4);
  Bluefruit.setName(FOOT_NAME);

  Bluefruit.Periph.setConnectCallback(connect_callback);
  Bluefruit.Periph.setDisconnectCallback(disconnect_callback);

  bleuart.begin();
  // Separate service: the existing seven-field UART payload stays unchanged.
  onyxPowerBegin(imuOk);

  Bluefruit.Advertising.addFlags(BLE_GAP_ADV_FLAGS_LE_ONLY_GENERAL_DISC_MODE);
  Bluefruit.Advertising.addTxPower();
  Bluefruit.Advertising.addService(bleuart);
  Bluefruit.ScanResponse.addName();
  Bluefruit.Advertising.restartOnDisconnect(true);
  Bluefruit.Advertising.setInterval(32, 244);
  Bluefruit.Advertising.setFastTimeout(30);
  Bluefruit.Advertising.start(0);

  LOG("%s ready / IMU=%s\n", FOOT_NAME, imuOk ? "OK" : "FAIL");
}

void loop() {
  /* notify 구독 상태가 바뀌는 순간을 찍는다. 대시보드가 "연결됨"인데
     여기가 계속 notify=NO면 CCCD 쓰기가 폰 쪽에서 실패한 것이고,
     그건 펌웨어가 아니라 안드로이드 GATT 캐시 문제다. */
  bool nowNotify = bleuart.notifyEnabled();
  if (nowNotify != lastNotify) {
    lastNotify = nowNotify;
    LOG("[BLE] notify %s\n", nowNotify ? "ENABLED  ← 폰이 구독함" : "disabled");
  }

  unsigned long now = millis();
  if (now - lastSend < PERIOD) return;
  lastSend = now;

  int v[4];
  for (int i = 0; i < 4; i++) v[i] = 1023 - readFsr(FSR_PINS[i]);

  float roll = 0, pitch = 0, yaw = 0;
  if (imuOk) {
    sensors_event_t a, g, t;
    imu.getEvent(&a, &g, &t);
    filter.updateIMU(
      g.gyro.x * SENSORS_RADS_TO_DPS,
      g.gyro.y * SENSORS_RADS_TO_DPS,
      g.gyro.z * SENSORS_RADS_TO_DPS,
      a.acceleration.x, a.acceleration.y, a.acceleration.z
    );
    roll  = filter.getRoll();
    pitch = filter.getPitch();
    yaw   = filter.getYaw();
  }

  char buf[80];
  int len = snprintf(buf, sizeof(buf), "%d,%d,%d,%d,%.1f,%.1f,%.1f\n",
                     v[0], v[1], v[2], v[3], roll, pitch, yaw);
  if (len < 0 || len >= (int)sizeof(buf)) return;   // 잘렸으면 보내지 않는다

  /* BLEUart::write()가 MTU에 맞춰 알아서 쪼갠다. 수동 분할과 delay()는
     10Hz 주기에 지터만 더하고 줄바꿈 유실 위험을 만든다. */
  size_t sent = 0;
  if (nowNotify) {
    sent = bleuart.write((uint8_t*)buf, (size_t)len);
  }

  /* sent는 write()의 '반환값'이다. strlen이 아니다.
     conn=1인데 sent=0이면 나간 게 없다는 뜻이고, 그게 진짜 신호다. */
  LOG("[%s sent=%u/%d conn=%d notify=%d] %s",
      FOOT_NAME, (unsigned)sent, len, Bluefruit.connected(), nowNotify ? 1 : 0, buf);
  onyxPowerTick(now, imuOk);
}

