# 05. STT 음성 처리 (Web Speech API — MVP)

## 채택 결정

**MVP는 브라우저 내장 [Web Speech API](https://developer.mozilla.org/docs/Web/API/Web_Speech_API)(`SpeechRecognition`)를 사용한다.**

선정 이유:
- 운영 비용 0원 — 브라우저 내장, 별도 API 키·서버 불필요
- 통합 부담이 가장 작다 — VAD·발화 분할·스트리밍을 브라우저가 처리, 사이드카·번들 불필요
- 웹 우선 구현과 맞물림 — 데스크탑 패키징(Electron) 없이 즉시 배포 가능

> **데이터 주권 한계 (수용)**: Web Speech API는 음성을 **브라우저 외부(Google) 서버로 전송**해 텍스트로 변환한다. 우리 서버는 음성을 받지 않지만 음성이 기기를 완전히 떠나지 않는 것은 아니다. 이 한계는 **V2에서 로컬 추론(RealtimeSTT)으로 전환**해 해소할 계획이다([08](08-우선순위-로드맵.md)).

### 동작 환경·제약

- **보안 컨텍스트(HTTPS) 필수** — `getUserMedia`·`SpeechRecognition` 모두 HTTPS(또는 localhost)에서만 동작 ([10](10-AWS-인프라-제약.md)).
- **브라우저 지원** — Chrome / Edge 권장(`webkitSpeechRecognition`). 회의 시작 전 미지원 브라우저 안내.
- **네트워크 필요** — 오프라인 시 인식 불가.
- **약 60초 강제 종료** — 세션이 주기적으로 자동 종료되므로 `onend`에서 자동 재시작으로 끊김을 방어한다(아래 §끊김 다층 방어).

### V2 계획 — RealtimeSTT 로컬 추론

데이터 주권·공정성을 위해 V2에서 **[RealtimeSTT](https://github.com/KoljaB/RealtimeSTT)(Python, faster-whisper)** 로컬 추론으로 전환한다. 이때 음성이 기기 밖으로 나가지 않으며, 데스크탑(Electron) 사이드카로 구동한다. 상세 통합 계획은 [07](07-Electron-구현.md) 참조.

### 검토 후 탈락/보류한 대안

| 대안 | 처리 |
| --- | --- |
| RealtimeSTT (faster-whisper 로컬) | **V2 보류** — 데이터 주권 우위이나 데스크탑 패키징(PyInstaller·Electron 사이드카)이 필요해 MVP 범위 밖 |
| Moonshine `moonshine-tiny-ko` (ONNX) | VAD·스트리밍·끊김 방어를 자체 구현해야 함 |
| WhisperX, Naver Clova, Deepgram | 비용 |
| Whisper.js 로컬 (브라우저) | transformers.js 추론이 저사양 기기에서 지연이 커 공정성 우려 |
| Soniox, AssemblyAI | 한국어 미지원 또는 비용 |

## 처리 파이프라인

```
웹 브라우저 (렌더러)
  getUserMedia 오디오 캡처 (echoCancellation·noiseSuppression 활성화)
        ↓
  SpeechRecognition (lang=ko-KR, continuous=true, interimResults=true)
    (음성이 브라우저 외부 Google 서버로 전송 → 텍스트 변환)
        ↓
  onresult:
    - interim result → 화면 미리보기(선택)
    - final result   → 발화 단위 텍스트를 우리 서버에 WebSocket 전송 (utterance:new)
```

- 발화 단위 분할·스트리밍은 Web Speech API 내부에서 수행 → 별도 VAD 구현 불필요.
- 화면 미리보기(interim)가 필요하면 `interimResults`의 중간 결과를 활용.
- 서버 전송은 `isFinal === true`인 결과만 대상.

## 발화 메타데이터

각 utterance(final result)에 다음을 부여해 서버로 전송:
- `utterance_id`, `text`, `char_count`
- `started_at_offset_ms`, `ended_at_offset_ms` (서버 T0 기준 상대 시각)
- `confidence` — `SpeechRecognitionAlternative.confidence` 사용. 브라우저가 0/미제공으로 반환하는 경우가 있어, 보정·대체 산출식은 PoC에서 확정 ([09](09-미결정-사항.md))

## 마이크 공유 호환성

각자 본인 마이크로 본인 발화만 캡처하므로 다른 회의 도구와 마이크를 동시에 사용해야 함:
- **macOS**: 항상 공유 모드 — 문제 없음
- **Windows**: 기본 공유 모드, "독점 제어 허용" 옵션 존재 → 독점 모드 시 사용자 안내로 처리
- **Discord/Zoom/Teams**: 모두 공유 모드 — 본 앱(브라우저 탭)과 마이크 동시 사용 가능

## 노이즈·에코 대응

각자 본인 마이크로 본인 발화만 캡처하므로, 스피커로 출력된 **타인의 음성이 본인 마이크에 유입되면 글자수가 왜곡**되어 기여도 공정성을 해친다.

- **헤드폰·이어폰 사용 권장** — 스피커 출력이 마이크로 되돌아오는 것을 원천 차단. 회의 시작 전 안내.
- **에코 캔슬링·노이즈 억제** — `getUserMedia` 제약에 `echoCancellation`, `noiseSuppression`을 기본 활성화.
- 헤드폰 미사용·고소음 환경은 캡처 품질 저하로 이어지므로 인식 신뢰도 라벨([06](06-기여도-산정.md))에 반영될 수 있다.

## 끊김 다층 방어

Web Speech API는 세션이 **약 60초 후 자동 종료**되고, 무음·네트워크 오류로도 종료될 수 있다. 끊김의 원인은 **오디오 캡처 중단**, **인식 세션 종료**, **네트워크·인식 오류**로 나뉜다.

### 캡처 측 방어 (오디오 입력)

| 레이어 | 메커니즘 |
| --- | --- |
| 1 | `MediaStreamTrack`의 `ended`/`mute` 이벤트 감지 → `getUserMedia` 재획득 |
| 2 | `navigator.mediaDevices.ondevicechange` 감지 → 마이크 분리·전환 시 스트림 재연결 |
| 3 | 탭 백그라운드/절전 전환 시 `visibilitychange` 추적, 복귀 시 자동 재개 |

### 인식 세션 측 방어 (SpeechRecognition)

| 레이어 | 메커니즘 |
| --- | --- |
| 4 | `onend` 발생 시(60초 강제 종료 포함) 회의 중이면 즉시 `recognition.start()` 재시작 — 끊김 없는 연속 인식 |
| 5 | `onerror` 분기 처리 — `no-speech`/`aborted`는 재시작, `network`는 백오프 후 재시도, `not-allowed`는 권한 안내 |
| 6 | 재시작 과정의 짧은 공백 구간은 손실로 분류 가능 → 손실 처리로 반영 |
| 7 | 중복 재시작 가드 — `onend` 다중 호출·이중 `start()` 예외 방지 |

### 손실 처리

- 캡처·인식 실패로 누락된 구간은 `AnomalyEvent`로 기록한다.
- 누락 비율은 [06. 기여도 산정](06-기여도-산정.md)의 신뢰도 라벨(오디오 캡처 손실 5% 미만 = High 조건)에 반영된다.

## 1주차 PoC 검증 항목

| 항목 | 검증 내용 |
| --- | --- |
| 한국어 인식 정확도 | 회의 상황(전문 용어·구어체) 인식률 |
| 실시간 지연 | 발화-텍스트 도착 지연, interim/final 타이밍 |
| 60초 강제 종료 재시작 | `onend` 자동 재시작의 끊김·중복·손실 빈도 |
| 오류 복원력 | `network`/`no-speech`/`not-allowed` 시나리오별 복구 |
| confidence 신뢰성 | 브라우저별 `confidence` 제공 여부·값 분포 → 산출식 결정 |
| 브라우저 지원 | Chrome / Edge / Safari 동작 차이, 미지원 안내 |
| 마이크 동시 사용 | Discord / Zoom과 마이크 공유 (Windows / macOS) |
| HTTPS 보안 컨텍스트 | 도메인+TLS 환경에서 마이크·인식 권한 동작 |
| 시각 동기화 | T0 broadcast 100ms 이내 정확도 |
| 마이크 환경 | USB / 내장 / Bluetooth 헤드셋 |
