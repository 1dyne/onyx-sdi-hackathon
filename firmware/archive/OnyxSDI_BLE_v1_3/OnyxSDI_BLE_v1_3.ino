/*
 * ╔══════════════════════════════════════════════════════╗
 * ║  OnyxSDI — BLE Firmware v1.2                        ║
 * ║  Board  : Arduino Nano ESP32 (ABX00092)              ║
 * ║  Library: ArduinoBLE                                 ║
 * ║  Date   : 2026-05-30                                 ║
 * ╚══════════════════════════════════════════════════════╝
 *
 * 회로 특성:
 *   안 눌림 → analogRead ≈ 1023
 *   눌림   → analogRead ≈ 0
 *   → 1023 - analogRead() 로 역전해서 전송
 *   → 대시보드: 높은 값 = 높은 압력 (MAX_SENSOR_VAL = 1023)
 *
 * 데이터 포맷 (10 Hz):
 *   "fsr1,fsr2,fsr3,fsr4,0,0,0\n"
 *
 * FSR 핀:  A0=FSR1  A1=FSR2  A2=FSR3  A3=FSR4
 *
 * BLE UART (Nordic NUS):
 *   Service  6e400001-b5a3-f393-e0a9-e50e24dcca9e
 *   Notify   6e400003-...  (ESP32 → 대시보드)
 *   Write    6e400002-...  (대시보드 → ESP32, 미사용)
 */

#include <ArduinoBLE.h>

// ── 핀 ─────────────────────────────────────────────────────────
const int FSR_PINS[4] = { A0, A1, A2, A3 };

// ── BLE ─────────────────────────────────────────────────────────
BLEService uartService("6e400001-b5a3-f393-e0a9-e50e24dcca9e");

BLEStringCharacteristic txChar(
  "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  BLERead | BLENotify, 64
);
BLEStringCharacteristic rxChar(
  "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
  BLEWrite | BLEWriteWithoutResponse, 64
);

// ── 타이밍 ──────────────────────────────────────────────────────
const unsigned long INTERVAL = 100;   // 10 Hz
unsigned long lastSend = 0;

// ── LED ─────────────────────────────────────────────────────────
void ledOff()   { digitalWrite(LEDR,HIGH); digitalWrite(LEDG,HIGH); digitalWrite(LEDB,HIGH); }
void ledBlue()  { digitalWrite(LEDR,HIGH); digitalWrite(LEDG,HIGH); digitalWrite(LEDB,LOW);  }
void ledGreen() { digitalWrite(LEDR,HIGH); digitalWrite(LEDG,LOW);  digitalWrite(LEDB,HIGH); }

// ════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(LEDR, OUTPUT);
  pinMode(LEDG, OUTPUT);
  pinMode(LEDB, OUTPUT);
  ledOff();

  analogReadResolution(10);   // 0 ~ 1023

  if (!BLE.begin()) {
    Serial.println("[ERR] BLE init failed");
    while (1);
  }

  BLE.setLocalName("OnyxSDI");
  BLE.setAdvertisedService(uartService);
  uartService.addCharacteristic(txChar);
  uartService.addCharacteristic(rxChar);
  BLE.addService(uartService);
  BLE.advertise();

  Serial.println("=== OnyxSDI BLE v1.2 ready ===");
  Serial.println("Waiting for BLE connection...");
  ledBlue();
}

// ════════════════════════════════════════════════════════════════
void loop() {
  BLEDevice central = BLE.central();
  if (!central) return;

  // ── 연결됨 ──────────────────────────────────────────────────
  ledGreen();
  Serial.print("[BT] Connected: ");
  Serial.println(central.address());

  while (central.connected()) {
    unsigned long now = millis();
    if (now - lastSend < INTERVAL) continue;
    lastSend = now;

    // ADC 읽기 + 역전 (안 눌림=0, 눌림=1023)
    int fsr[4];
    for (int i = 0; i < 4; i++) {
      fsr[i] = 1023 - analogRead(FSR_PINS[i]);
    }

    // 시리얼 디버그
    Serial.print("FSR1:"); Serial.print(fsr[0]);
    Serial.print("\tFSR2:"); Serial.print(fsr[1]);
    Serial.print("\tFSR3:"); Serial.print(fsr[2]);
    Serial.print("\tFSR4:"); Serial.println(fsr[3]);

    // BLE 전송
    String pkt = String(fsr[0]) + "," +
                 String(fsr[1]) + "," +
                 String(fsr[2]) + "," +
                 String(fsr[3]) + ",0,0,0\n";
    txChar.writeValue(pkt);
  }

  // ── 연결 해제 ─────────────────────────────────────────────
  ledOff();
  Serial.println("[BT] Disconnected");
  BLE.advertise();
  ledBlue();
}
