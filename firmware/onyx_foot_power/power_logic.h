#pragma once
#include <stdint.h>
// BQ25186 STAT0, STAT1 and ICHG_CTRL per TI SLUSF69A, tables 6-10/11/14.
// State: 0 unknown, 1 not charging, 2 charging, 3 charge done, 4 fault.
constexpr uint8_t onyxChargeState(uint8_t s0, uint8_t s1, uint8_t ichg) {
  return ((s0 & 0x80) || (s1 & 0xC4) || ((s1 & 0x18) == 8)) ? 4
       : !(s0 & 1) ? ((s0 & 0x60) == 0x20 || (s0 & 0x60) == 0x40 ? 0 : 1)
       : (ichg & 0x80) || !(s0 & 0x60) ? 1
       : (s0 & 0x60) == 0x60 ? 3 : 2;
}
// Simple 3.0-4.2V scale. This is not a calibrated LiPo capacity curve.
constexpr uint8_t onyxVoltagePercent(uint16_t mv) {
  return mv <= 3000 ? 0 : mv >= 4200 ? 100 : uint8_t((mv - 3000 + 6) / 12);
}

// Golden register cases: disabled charging must never appear as full.
static_assert(onyxChargeState(0x21,0,0x05) == 2, "Constant-current charging");
static_assert(onyxChargeState(0x41,0,0x05) == 2, "Constant-voltage charging");
static_assert(onyxChargeState(0x61,0,0x05) == 3, "Charge termination");
static_assert(onyxChargeState(0x61,0,0x85) == 1, "Disabled is not full");
static_assert(onyxChargeState(0x00,0,0x05) == 1, "No input power");
static_assert(onyxChargeState(0x20,0,0x05) == 0, "Incoherent status");
static_assert(onyxChargeState(0x21,0x08,0x05) == 4, "Thermistor suspension");
static_assert(onyxChargeState(0x61,0x04,0x05) == 4, "Timer fault overrides done");
static_assert(onyxChargeState(0x21,0x40,0x05) == 4, "Battery undervoltage");
static_assert(onyxChargeState(0xA1,0,0x05) == 4, "TS open");
static_assert(onyxVoltagePercent(2500)==0 && onyxVoltagePercent(3600)==50 &&
              onyxVoltagePercent(4200)==100, "Voltage scale endpoints");
