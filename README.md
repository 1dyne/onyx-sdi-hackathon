# Onyx SDI — Smart Drill Indicator

족저압(FSR 4채널) + IMU 데이터를 양발 동시에 받아 실시간으로 보여주는 웨어러블 대시보드입니다.
설치가 필요 없는 PWA로, 브라우저에서 바로 BLE 유닛에 연결합니다.

**라이브 데모 → https://1dyne.github.io/onyx-sdi-hackathon/**

> Web Bluetooth가 필요합니다. 데스크톱/안드로이드 Chrome·Edge에서 동작하며, iOS Safari는 지원하지 않습니다.
> 하드웨어가 없어도 CONFIG → DEMO 모드로 전체 UI를 시연할 수 있습니다.

---

## 무엇을 하는 물건인가

훈련 동작(drill)을 미리 정의해두고, 착용자가 그 동작을 수행하는 동안 발바닥 4개 지점의 압력과
발의 기울기(roll/pitch/yaw)를 10Hz로 읽어 실시간 판정합니다.

- **LIVE** — 좌우 실루엣에 압력 분포를 그리고, 동작 품질을 즉시 판정
- **TRAINING** — 정의된 drill 실행, 세션 기록
- **CONFIG** — drill 편집, ADC/IMU 보정, BLE 옵션
- **LOG** — 세션 히스토리와 RAW 모니터

### 설계에서 중요한 부분

**양발이 완전히 독립적입니다.** 연결 상태·수신 버퍼·재연결 타이머가 발마다 따로 존재해서,
한쪽이 끊겨도 다른 쪽 스트림이 오염되지 않습니다. 한쪽만 연결해도 좌우 비교 위젯을 제외한
모든 기능이 정상 동작합니다.

수신 버퍼를 공유하지 않는 것이 핵심입니다 — BLE notification은 약 20바이트씩 쪼개져 도착하므로
38자짜리 샘플 한 줄이 여러 이벤트에 걸칩니다. 두 기기가 한 버퍼에 쓰면 줄 중간에서 섞여 양쪽 다 깨집니다.

---

## 오늘 작업 범위 (해커톤)

이 리포는 진행 중이던 프로젝트의 오늘자 스냅샷이며, 오늘 한 작업은 **BLE 연결 실패 수정**입니다.

증상은 대시보드에서만 연결이 실패하는 것이었습니다. 같은 노트북·같은 브라우저·같은 보드에서
콘솔로 직접 `getPrimaryService()`를 호출하면 10Hz로 완벽하게 수신되는데,
앱을 통하면 `NetworkError: GATT Server is disconnected`가 났습니다.
즉 UUID·펌웨어·브라우저는 모두 정상이고 연결 절차에만 문제가 있었습니다.

원인과 수정:

| # | 문제 | 수정 |
|---|---|---|
| 1 | Windows Chrome에서 `gatt.connect()` 직후 즉시 서비스를 탐색하면 실패하는 레이스 컨디션 | 연결 후 200ms settle, attach 전체를 3회 재시도(간격 300ms)로 감쌈 |
| 2 | 1차 탐색 실패 후 fallback이 이미 끊긴 GATT를 그대로 탐색해 2차 에러가 원인을 덮음 | fallback 진입 전 재연결, 실패 시 1·2차 에러를 함께 보존 |
| 3 | `gattserverdisconnected` 핸들러가 연결할 때마다 중복 등록 | 안정 참조로 교체 — 병렬 재연결 체인이 원천 차단 |
| 4 | 죽은 시도의 재연결 타이머가 새 연결에 끼어듦 | `releaseDevice()`로 타이머·리스너·기기를 먼저 회수 |
| 5 | 데이터가 한 줄도 안 오는데 배지가 "연결됨"으로 표시 | GATT 연결과 데이터 수신을 분리 — 2초 내 첫 notify가 없으면 `no-data` |

3번과 4번은 증상 리포트에 없던 것으로, 원인 추적 중에 발견해 같이 고쳤습니다.
반복 클릭할수록 상황이 나빠지던 이유였습니다.

수신 경로(`parseLine` / `onRx` / `dispatch`)는 검증이 끝난 코드라 한 줄도 건드리지 않았습니다.
첫 notify 감지는 같은 characteristic에 리스너를 하나 더 붙여서 처리하고, 첫 발화 후 스스로 해제합니다.

---

## 데이터 규약

Nordic UART Service (NUS) 고정:

| | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX (notify) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

페이로드는 개행으로 끝나는 CSV 한 줄, 10Hz:

```
fsr1,fsr2,fsr3,fsr4,roll,pitch,yaw\n
```

예: `88,90,120,95,0.00,0.00,0.00`

FSR은 0–1023(10-bit), 각도는 도(degree)입니다. 4필드(FSR only) 레거시 형식도 받습니다.
12-bit로 출력하는 유닛은 CONFIG에서 ADC 최대값만 4095로 바꾸면 자동 환산되므로 펌웨어를 다시 굽지 않아도 됩니다.

두 유닛(ESP32 / nRF52840)이 동일한 프로필과 페이로드를 쓰기 때문에, 좌우 구분은
**사용자가 어느 버튼을 눌렀는지**로만 결정됩니다. 기기 이름으로 추론하지 않습니다.

---

## 로컬 실행

빌드 과정이 없습니다. 정적 파일을 그대로 서빙하면 됩니다.

```bash
python -m http.server 8123
```

`http://localhost:8123` 접속. Web Bluetooth는 보안 컨텍스트를 요구하므로 `localhost` 또는 HTTPS여야 합니다.

캐시가 말썽이면 URL에 `?nosw=1`을 붙이세요 — Service Worker를 등록하지 않고 캐시를 전부 지웁니다.
자세한 운영 절차는 [DEPLOY.md](DEPLOY.md)에 있습니다.

## 구조

```
index.html          단일 페이지, 탭 4개
js/
  bluetooth.js      BLE 전송 계층 — 발마다 독립된 link 인스턴스
  session.js        세션 상태와 판정
  store.js          localStorage 영속화
  pwa.js / sw.js    Service Worker 등록과 캐시 무효화
  tabs/             live · training · config · log
css/                토큰 기반 테마 (다크/라이트)
```

버전을 올릴 때는 `python bump-version.py <버전>`을 쓰세요.
`js/version.js`와 `index.html`의 모든 `?v=`를 동시에 갱신해서 캐시를 확실히 무효화합니다.
