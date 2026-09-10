# v2.8.0 — capture and registration readiness

## Field workflow

1. On the device that holds experimental records: header `⋮ → 🛠 개발 도구` → export JSON, verify the downloaded file, then reset experimental records. This resets drills, sessions, and captures in this browser only. Settings and pending recovery captures are separate. LOG can import the backup.
2. Start Motion Capture or Free Capture. Select the actual four positions in CH1–CH4 order. The current mapping is shared between feet; mount corresponding channels at corresponding positions and document mounting details.
3. Record the task and essential conditions: indoor/outdoor, footwear, therapist assistance, opposite-foot contact, baseline posture and an optional purpose. Purpose starts blank. Each completed baseline gets a condition ID; captures retain a snapshot rather than a mutable global profile.
4. In the selected supported/unloaded baseline posture, remain still for three seconds. The app measures incoming packets, displays the result, and requires confirmation before capture. If footwear or mounting changes, remeasure.
5. Start REC; use typed markers to identify repetitions, stable periods, completed sitting/standing, support changes, turns or sensor problems. STOP saves original normalized ADC samples and phone receive timestamps, not the color-amplified values.
6. Open the saved capture, add a review note, trim the desired interval, then select `동작 등록 → 참고 동작 등록 완료`. The registration preserves conditions, baseline and selected raw samples plus the source ID/range. The representative vector is an observed instant per foot near median total signal, not independent channel maxima. These per-foot instants need not be simultaneous.
7. Registrations are marked `훈련 목표 설정 대기`. Dynamic phase judgement, tutorial and clinical target prescription are intentionally deferred. Existing legacy training behaviour is unchanged. Do not interpret a registration as an approved exercise target.
8. Export the capture or full backup after recording. Raw records remain local to this browser; deployment does not synchronize or reset another device.

## Signal checks and limitations

- Baseline engineering checks: at least 10 received packets, at least 2 seconds of coverage in the 3-second window, no gap over 600 ms including window ends and channel P90–P10 spread at most 35 ADC counts. A channel fixed at 1023 is rejected because it cannot show change; a near-limit channel that still varies is accepted with a warning so shoe-compressed measurements remain possible. Heat display starts at a 3-count change. These are initial data-quality thresholds, not clinically validated accuracy limits. Baseline samples, check limits and headroom are retained.
- Baseline verification rejects missing/stalled data and connection changes. Both intended feet must be streaming before baseline; introducing a new foot later requires another baseline.
- Capture quality reports observed receive rate, maximum receive gap and the fraction of channel samples at or above 1000. Timestamps are phone receive times, not hardware-synchronized acquisition times.
- Heat gain (1, 1.5, 2, 3) is fixed per capture and shared between feet. It affects color only; it cannot restore saturated sensor information. A footwear/environment choice does not silently change gain.
- L/R is the ratio of summed positive ADC changes. It is not calibrated body-weight distribution. Four-point COP is an estimate. No-data and zero-load states do not display a false 50:50 result.
- Walking summaries count detected same-foot cycles; they are not a validated step-count/cadence measurement. Nonwalking tasks do not show walking analysis.
- Keep the screen on. A screen wake lock is requested where supported, but background suspension remains platform-dependent. IndexedDB checkpoints run every five seconds while execution is active. An interrupted take may lose data after the last successful checkpoint. Recovery never overwrites an already saved longer take with a shorter checkpoint.
- Storage failure offers a direct JSON rescue download. Recovery lives in `⋮ → 🛠 개발 도구`; resolve any pending capture before starting another.

## Verification

`node tests/pressure.test.js` and `node tests/validation.test.js` cover pressure processing, stable/noisy/stale/saturated baseline checks, actual-sample selection, receive-gap metrics, metadata backup round-trip and reset scope. Local DOM integration checks cover Motion/Free Capture through registration and IndexedDB recovery. Hardware accuracy and actual phone background behaviour still require the wearing validation.
