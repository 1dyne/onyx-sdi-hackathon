#pragma once
// NU40-DK Basic schematic, USB/Power sheet 3 (2026-04-24).
// REQUIRED BEFORE USE: move CH4 signal A0 -> A3; set IMU SA0/SDO high (0x6B).
#define ONYX_FSR_CH4_PIN A3
#define ONYX_IMU_ADDRESS 0x6B
#define ONYX_VBAT_PIN A0
#define ONYX_VBAT_DIVIDER 1.47f // R13=470k, R14=1M, SB14 closed
#define ONYX_VBAT_CALIBRATION 1.0f
#define ONYX_POWER_PERIOD_MS 5000UL
// No charger configuration is changed. Battery: user-confirmed 1S 3.7V LiPo.
