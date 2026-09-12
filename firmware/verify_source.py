"""펌웨어가 지켜야 할 성질을 검사한다.

    python firmware/verify_source.py

── 왜 비교가 아니라 검사인가 ──────────────────────────────────
예전에는 데스크톱에 있던 "손대지 않은 원본" 스케치와 현재 펌웨어를 줄 단위로
비교했다. 그 방식은 버렸다. 2026-09-12에 그 원본 파일이 현재 펌웨어 내용으로
덮여 있는 것을 확인했기 때문이다. 비교 대상이 덮이면 비교는 조용히 통과한다.
리포 밖의 파일 하나에 검증 근거를 두면 언제든 다시 일어날 수 있는 일이다.

그래서 지켜야 할 성질을 여기에 직접 적었다. 대상은 현재 펌웨어 하나뿐이고,
무엇을 왜 지키는지가 코드에 남는다. 근거가 되는 이전 판은 archive/에 있다.
"""
from pathlib import Path
import re
import sys

# 윈도우 콘솔 기본 코드페이지가 cp949라 주석과 메시지의 한글·기호에서
# 인코딩 오류로 죽는다. 실패를 보고해야 할 자리에서 죽으면 곤란하다.
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except (AttributeError, OSError):
    pass

FW = Path(__file__).resolve().parent
ino = (FW / 'onyx_foot_power/onyx_foot_power.ino').read_text(encoding='utf-8-sig')
power_h = (FW / 'onyx_foot_power/onyx_power.h').read_text(encoding='utf-8-sig')
legacy = (FW / 'archive/OnyxSDI_BLE_v1_3/OnyxSDI_BLE_v1_3.ino').read_text(encoding='utf-8-sig')

failures = []


def check(label, condition):
    if condition:
        print(f'PASS: {label}')
    else:
        print(f'FAIL: {label}')
        failures.append(label)


# ── 대시보드와 고정된 규약 ──────────────────────────────────────
# 이 셋이 바뀌면 대시보드는 조용히 틀린 숫자를 그린다. 파싱이 깨지는
# 것이 아니라 값의 의미가 달라지기 때문에 화면만 보고는 알 수 없다.
check('10Hz cadence (PERIOD = 100)',
      re.search(r'const unsigned long PERIOD = 100;', ino))

check('seven-field CSV payload ending in a newline',
      re.search(r'snprintf\(buf, sizeof\(buf\),\s*"%d,%d,%d,%d,%\.1f,%\.1f,%\.1f\\n"', ino))

# 안 눌림 0, 눌림 1023. v1.3부터 이어진 방향이고 대시보드의 모든 임계값이
# 이 방향을 전제한다. 뒤집히면 판정이 통째로 반대가 된다.
check('FSR inversion kept (1023 - reading), as in the v1.3 sketch',
      re.search(r'v\[i\] = 1023 - readFsr\(FSR_PINS\[i\]\);', ino)
      and re.search(r'1023 - analogRead\(FSR_PINS\[i\]\)', legacy))

check('IMU angles still come from the Madgwick filter',
      re.search(r'filter\.updateIMU\(', ino) and re.search(r'SENSORS_RADS_TO_DPS', ino))

# ── v2.9에서 의도적으로 바꾼 것 ────────────────────────────────
# 되돌아가도 대시보드는 멀쩡히 동작한다. 값이 조금 더 흔들릴 뿐이라
# 화면으로는 알아챌 수 없어서, 여기서 잡는다.
check('FSR reads go through readFsr(), not a bare analogRead',
      re.search(r'v\[i\] = 1023 - readFsr\(', ino)
      and not re.search(r'v\[i\] = 1023 - analogRead\(', ino))

check('the median window is five samples',
      re.search(r'#define FSR_SAMPLES 5', ino))

check('readFsr returns the median, not a mean',
      re.search(r'return a\[FSR_SAMPLES / 2\];', ino)
      and not re.search(r'sum\s*/\s*FSR_SAMPLES', ino))

# 획득 시간은 두 곳에서 정해진다. 배터리 측정이 12비트/40µs로 잠깐 바꿔
# 쓰고 되돌리는데, 되돌리는 값이 setup()과 어긋나면 첫 배터리 보고 뒤부터
# FSR만 조용히 짧은 획득 시간으로 떨어진다.
setup_acq = re.search(r'analogSampleTime\((\d+)\);', ino)
restore_acq = re.findall(r'analogSampleTime\((\d+)\);', power_h)
check('FSR acquisition time is 10us in setup()',
      setup_acq and setup_acq.group(1) == '10')
check('onyx_power.h restores the same acquisition time after a battery read',
      restore_acq and restore_acq[-1] == '10')

# ── 배선 전제 ──────────────────────────────────────────────────
check('IMU is not initialised at the charger address 0x6A',
      'imu.begin_I2C(0x6A)' not in ino)
check('CH4 uses the relocated pin constant',
      'ONYX_FSR_CH4_PIN' in ino)

if failures:
    print(f'\n{len(failures)}건 실패 — 업로드하기 전에 확인하세요.')
    sys.exit(1)
print('\n전부 통과.')
