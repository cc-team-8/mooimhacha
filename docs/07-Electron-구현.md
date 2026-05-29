# 07. Electron 구현

> **⚠️ V2 보류 (2026-05-29 결정)**: MVP는 **웹(브라우저) 우선**으로 구현한다. STT를 브라우저 내장 Web Speech API로 채택하면서 Electron 의존이 사라졌고, 데스크탑 패키징은 **V2로 보류**한다. 아래 내용은 V2에서 데스크탑 앱(RealtimeSTT 로컬 추론·always-on-top 보조 창 등)을 재개할 때를 위한 참고용 계획이다. MVP STT는 [05](05-STT-음성-처리.md), 웹 우선 결정의 영향은 [01](01-아키텍처.md)·[08](08-우선순위-로드맵.md) 참조.

## 윈도우 관리

| 윈도우 | 모드 | 사용 시점 |
| --- | --- | --- |
| 메인 윈도우 | 풀 화면 (1280×800) | 대시보드, 회의 전·후 |
| 보조 창 | 폭 400px 고정, 높이 가변 | 회의 중에만 |
| 정리 화면 | 풀 화면 새 윈도우 | 회의 종료 시 |

## 사용 네이티브 API

| 기능 | API |
| --- | --- |
| 윈도우 생성 | `BrowserWindow` |
| Always-on-top | `setAlwaysOnTop(true)` |
| 시스템 알림 | `Notification` |
| 로컬 저장 (창 위치 등) | `electron-store` |
| 마이크 권한 | `session.setPermissionRequestHandler` |
| 자동 업데이트 | `electron-updater` (V2) |
| 트레이 아이콘 | `Tray` (선택) |

## STT 사이드카 (RealtimeSTT)

- RealtimeSTT(Python, faster-whisper)는 **PyInstaller 단일 실행파일로 번들해 앱에 동봉**한다 — 사용자에게 Python 설치를 요구하지 않는다.
- **faster-whisper 모델 가중치는 최초 실행 시 다운로드** (설치 파일 용량 절약). 다운로드 완료 전에는 회의 시작 불가 안내.
- Electron 메인 프로세스가 사이드카 실행파일을 `child_process.spawn`으로 띄우고 **stdin/stdout NDJSON**으로 통신, 비정상 종료 시 지수 백오프로 재시작.
- 사이드카는 별도 OS 프로세스이므로 메인 UI를 블로킹하지 않는다.
- 통신·재시작·손실 처리의 세부는 [05](05-STT-음성-처리.md) 참조.

## 빌드·배포

- 빌드 도구: `electron-builder`
- 타겟: Windows (.exe, .msi), macOS (.dmg, .pkg)
- 코드 사이닝: 발표 단계에서 결정
- 자동 업데이트 인프라: V2

## 데스크탑 채택으로 인한 결정

- Always-on-top 등 네이티브 경험 활용
- Discord/Zoom과 자연스럽게 병행 실행
- 로컬 STT 추론·모델 패키징을 데스크탑 환경에서 안정적으로 수행
- 트레이드오프: 사용자 설치 부담(웹 대비), macOS·Windows 양쪽 빌드 인프라 필요
