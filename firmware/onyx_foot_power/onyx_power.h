#pragma once
#include <Arduino.h>
#include <Wire.h>
#include <bluefruit.h>
#include "power_config.h"
#include "power_logic.h"

static BLEService onyxPowerService("9c7e0001-7e71-4b8d-a491-3f886d9f51a0");
static BLECharacteristic onyxPowerState("9c7e0002-7e71-4b8d-a491-3f886d9f51a0");
static bool onyxPowerReady = false;
static uint32_t onyxPowerLast = 0;
static bool onyxPowerWasConnected = false;
static_assert(ONYX_VBAT_PIN == A0, "NU40-DK battery sense is P0.02/A0, not the BSP PIN_VBAT alias.");
static_assert(ONYX_FSR_CH4_PIN == A3, "Move CH4 physically to A3 before using this firmware.");
static_assert(ONYX_IMU_ADDRESS == 0x6B, "The onboard charger reserves I2C address 0x6A.");

static bool onyxReadChargerReg(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(0x6A);
  Wire.write(reg); // Register pointer only; never send a register data value.
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(uint8_t(0x6A), size_t(1)) != 1) return false;
  value = Wire.read();
  return true;
}

static void onyxPowerPublish(uint32_t now, bool imuReady) {
  // v1 / flags / mV(u16) / percent / charge / raw ADC(u16) / uptime(u32)
  // / STAT0 / STAT1 / ICHG_CTRL / MASK_ID. Total 16 bytes, fits MTU 23.
  uint8_t packet[16] = {1,0,255,255,255,0,255,255,0,0,0,0,255,255,255,255};
  if (!imuReady) packet[1] |= 0x40;
  // Use the shared ADC synchronously; restore the original FSR configuration.
  analogReadResolution(12);
  analogSampleTime(40);
  (void) analogRead(ONYX_VBAT_PIN);
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 16; ++i) sum += analogRead(ONYX_VBAT_PIN);
  analogSampleTime(10);   // setup()의 FSR 설정과 같은 값으로 되돌린다
  analogReadResolution(10);
  const uint16_t raw = (sum + 8) / 16;
  packet[6] = uint8_t(raw);
  packet[7] = uint8_t(raw >> 8);
  const float mvFloat = float(sum) / 16.0f * (3600.0f / 4096.0f)
                      * ONYX_VBAT_DIVIDER * ONYX_VBAT_CALIBRATION;
  uint16_t mv = 65535;
  // Range check does not detect an unplugged battery. See README.
  if (raw > 0 && raw < 4095 && mvFloat >= 2500 && mvFloat <= 4350) {
    mv = uint16_t(mvFloat + 0.5f);
    packet[1] |= 1;
    packet[2] = uint8_t(mv);
    packet[3] = uint8_t(mv >> 8);
  }

  // Only access 0x6A after the expected IMU has been verified at 0x6B.
  // This avoids interpreting the old IMU at 0x6A as a charger.
  uint8_t id, stat0, stat1, ichg;
  if (imuReady && onyxReadChargerReg(0x0C, id) && (id & 15) == 1 &&
      onyxReadChargerReg(0x00, stat0) && onyxReadChargerReg(0x01, stat1) &&
      onyxReadChargerReg(0x04, ichg)) {
    packet[1] |= 2;
    if (stat0 & 1) packet[1] |= 8; // Charger input power good (USB/external).
    packet[5] = onyxChargeState(stat0, stat1, ichg);
    if (packet[5] == 4) packet[1] |= 16;
    packet[12] = stat0;
    packet[13] = stat1;
    packet[14] = ichg;
    packet[15] = id;
    // A percentage here is a VOLTAGE-SCALE ESTIMATE, not measured capacity.
    // Suppress on invalid voltage, faults or incoherent charger state.
    if ((packet[1] & 1) && packet[5] != 0 && packet[5] != 4) {
      packet[4] = onyxVoltagePercent(mv);
      packet[1] |= 4 | 32;
    }
  }
  for (uint8_t i = 0; i < 4; ++i) packet[8+i] = uint8_t(now >> (8*i));
  onyxPowerState.write(packet, sizeof(packet));
  if (Bluefruit.connected()) onyxPowerState.notify(packet, sizeof(packet));
  if (Serial) Serial.printf("[POWER] flags=0x%02X mV=%u approx=%u charge=%u ADC=%u IMU=%s\n",
      packet[1], mv, packet[4], packet[5], raw, imuReady ? "OK" : "MISSING_0x6B");
}

static void onyxPowerBegin(bool imuReady) {
  if (onyxPowerService.begin() != ERROR_NONE) return;
  onyxPowerState.setProperties(CHR_PROPS_READ | CHR_PROPS_NOTIFY);
  onyxPowerState.setPermission(SECMODE_OPEN, SECMODE_NO_ACCESS);
  onyxPowerState.setFixedLen(16);
  if (onyxPowerState.begin() != ERROR_NONE) return;
  onyxPowerReady = true;
  onyxPowerLast = millis();
  onyxPowerPublish(onyxPowerLast, imuReady);
}

static void onyxPowerTick(uint32_t now, bool imuReady) {
  if (!onyxPowerReady) return;
  const bool connected = Bluefruit.connected();
  const bool justConnected = connected && !onyxPowerWasConnected;
  onyxPowerWasConnected = connected;
  if (!justConnected && uint32_t(now - onyxPowerLast) < ONYX_POWER_PERIOD_MS) return;
  onyxPowerLast = now;
  onyxPowerPublish(now, imuReady);
}
