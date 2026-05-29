# 무임하차

대학생 팀플의 무임승차 문제를 **데이터로** 해결하는 팀플 협업 도구 — Electron 데스크탑 앱.

> 그룹·회의·태스크를 관리하는 풀 화면 앱과, 회의 중 옆에 띄워 발언량·안건 진행을 실시간으로 보여주는 폭 400px 보조 창으로 구성됩니다.

## 주요 기능

회의 중 띄우는 **보조 창**은 핵심 기능 하나일 뿐, 무임하차는 회의 전·중·후를 모두 다루는 팀플 협업 도구다. 전체 명세는 [docs/02-기능-명세.md](docs/02-기능-명세.md) 참고.

### 회의 외 — 풀 화면 협업 도구

| 영역 | 내용 |
| --- | --- |
| 그룹 관리 | 카카오 로그인 → 그룹 생성 → 초대 코드로 팀원 합류 |
| 홈 | 참여 중인 그룹·내 태스크·예정된 회의를 한눈에 |
| 그룹 대시보드 | 태스크 진행률·기여도 현황·무임승차 경보·진행 중 회의 요약 |
| 회의 관리 | 회의 목록(진행 중/예정/완료)과 회의별 상세 — 아젠다·발언 기록·결정 사항·회의 요약 탭 |
| 태스크 보드 | 칸반(대기/진행 중/완료)·리스트 뷰, 담당자·마감일 관리 |
| 기여도 리포트 | 회의·프로젝트별 멤버 기여도 집계, 교수 제출용 PDF 출력 |

### 회의 중 — 폭 400px 보조 창

회의 앱 옆에 띄우는 always-on-top 사이드 창. 곁눈질로 회의 상태를 파악한다.

- **안건 추적** — 아젠다 진행 상태(대기/진행 중/완료)와 시간 초과 시각화
- **실시간 기여도 바** — 회의 중에는 발언 비중을 막대로 표시 (WebSocket 브로드캐스트 1초 디바운스, Framer Motion). 역할 수행도 등 3축 종합은 회의 후 대시보드에서 확인
- **결정·액션 빠른 입력** — 단축키(Ctrl/Cmd+D · Ctrl/Cmd+A)로 결정사항·액션 아이템을 즉시 기록, 현재 진행 안건에 자동 연결
- **로컬 STT** — 음성은 각자 기기에서 텍스트로 변환, 서버에는 텍스트만 전송

## 주요 제약

| 제약 | 내용 |
| --- | --- |
| 운영 비용 0원 | STT는 클라이언트 로컬 추론(RealtimeSTT, faster-whisper)만 사용. 유료 STT API 금지 |
| 음성 원본 미저장 | 음성은 기기 밖으로 나가지 않음. 서버에는 텍스트만 전송·저장 |
| 방식 B (각자 녹음) | 각자 본인 마이크로 본인 발화만 수집 → 화자 분리 불필요 |
| 사이드 창 폭 | 회의 중 보조 창은 폭 400px 고정 |
| 팀 인원 상한 | 6명 (대학생 팀플 기준 하드 제한) |
| LLM 사용 | GPT-4o-mini. 회의 중 안건별 요약(안건당 1회) + 회의 후 종합 정리 1회 + 다음 회의 안건 생성 1회 |

## 기술 스택 요약

- **클라이언트**: Electron · React · TypeScript · TailwindCSS · shadcn/ui · Framer Motion
- **STT**: RealtimeSTT (Python, faster-whisper) — Electron 사이드카(PyInstaller 번들, `child_process` stdio NDJSON). 모델 크기(tiny/base/small)는 1주차 PoC 후 확정
- **백엔드**: NestJS · MySQL (TypeORM) · WebSocket (캐시는 NestJS 인메모리 — ElastiCache 미사용)
- **인프라**: AWS (Start AWS 학생 프로그램) — EC2 t3.small · RDS MySQL 프리티어 · 서울 리전
- **LLM**: OpenAI GPT-4o-mini (회의 중 안건당 1회 + 회의 후 2회)

자세한 내용은 [docs/01-아키텍처.md](docs/01-아키텍처.md), [docs/10-AWS-인프라-제약.md](docs/10-AWS-인프라-제약.md) 참고.

## 폴더 구조

배치·명명 규칙의 전체 설명은 [docs/11-프로젝트-구조.md](docs/11-프로젝트-구조.md) 참고.

```
.
├── .github/                     # GitHub 협업 자산
│   ├── ISSUE_TEMPLATE/          #   버그 리포트·기능 제안 템플릿
│   ├── pull_request_template.md #   PR 템플릿 (한국어 + 제약 체크리스트)
│   └── workflows/ci.yml         #   CI — server·client 빌드·테스트
├── docs/                        # 설계 문서 11개 (위 문서 표 참고)
├── design/                      # 디자인 시안 (HTML 목업 등)
├── server/                      # NestJS 백엔드 (TypeScript)
│   ├── src/
│   │   ├── main.ts              #   bootstrap — 포트 listen
│   │   ├── app.module.ts        #   루트 모듈
│   │   ├── app.controller.ts    #   헬스 체크 라우트
│   │   └── app.service.ts
│   ├── test/                    #   e2e 테스트
│   ├── .env.sample              #   환경 변수 템플릿 (키만, 값 없음)
│   ├── nest-cli.json
│   ├── eslint.config.mjs
│   ├── tsconfig.json
│   └── package.json
├── client/                      # Electron 클라이언트 (Vite + React + TS)
│   ├── electron/                #   메인 프로세스 (Node 컨텍스트)
│   │   ├── main/                #     BrowserWindow·IPC·자동 업데이트
│   │   │   └── stt-sidecar/     #       RealtimeSTT 사이드카 spawn·stdio·재시작
│   │   └── preload/             #     렌더러 ↔ 메인 브리지
│   ├── resources/
│   │   └── stt-sidecar/         #   PyInstaller로 번들된 RealtimeSTT 실행파일
│   ├── src/                     #   렌더러 (React 컨텍스트)
│   │   ├── main.tsx             #     ReactDOM 진입점
│   │   ├── App.tsx              #     루트 컴포넌트
│   │   ├── components/          #     공용 UI 컴포넌트
│   │   ├── assets/              #     이미지·아이콘
│   │   └── demos/               #     템플릿 데모 (구현 착수 시 제거)
│   ├── build/                   #   electron-builder 아이콘
│   ├── public/                  #   정적 자산 (Vite가 그대로 서빙)
│   ├── test/                    #   E2E 테스트 (Playwright)
│   ├── .env.sample              #   환경 변수 템플릿 (VITE_ 접두사 키만)
│   ├── electron-builder.json    #   패키징 설정
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   └── package.json
├── CLAUDE.md                    # AI 보조 작업 규칙
├── LICENSE                      # MIT
└── README.md                    # 이 문서
```

## 문서

| 문서 | 용도 |
| --- | --- |
| [01. 아키텍처 & 기술 스택](docs/01-아키텍처.md) | 데이터 흐름, 스택 |
| [02. 기능 명세](docs/02-기능-명세.md) | 회의 전/중/후/외 기능 |
| [03. 데이터 모델](docs/03-데이터-모델.md) | 엔티티·필드 정의 |
| [04. API 명세](docs/04-API-명세.md) | REST, WebSocket |
| [05. STT 음성 처리](docs/05-STT-음성-처리.md) | RealtimeSTT 사이드카, VAD, PoC |
| [06. 기여도 산정](docs/06-기여도-산정.md) | 3축 공식 (액션·발언·참석), 누적 점수 |
| [07. Electron 구현](docs/07-Electron-구현.md) | 윈도우 관리, 빌드 |
| [08. 우선순위 & 로드맵](docs/08-우선순위-로드맵.md) | P0/P1/V2, 8주 일정 |
| [09. 미결정 사항](docs/09-미결정-사항.md) | 착수 전 결정 필요 항목 |
| [10. AWS 인프라 & 제약](docs/10-AWS-인프라-제약.md) | Start AWS 제약 + 우리 적용 |
| [11. 프로젝트 구조](docs/11-프로젝트-구조.md) | 저장소 레이아웃·명명·코드 배치 규칙 |

## 협업 가이드

### 브랜치 전략 — GitHub Flow

- `main` — 항상 배포 가능한 상태 (직접 푸시 금지, PR 머지만)
- `feature/<짧은-설명>` — 기능 작업 브랜치 (예: `feature/stt-poc`, `feature/contribution-bar`)
- `fix/<짧은-설명>` — 버그 수정 브랜치

### 커밋 메시지 — Conventional Commits

```
<type>(<scope>): <subject>
```

| type | 용도 |
| --- | --- |
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `docs` | 문서 변경 |
| `refactor` | 리팩터링 (동작 변화 없음) |
| `test` | 테스트 추가/수정 |
| `chore` | 빌드·설정·잡일 |

예시: `feat(stt): RealtimeSTT 사이드카 통합 추가`

### PR

- 작업 브랜치에서 `main`으로 PR 생성
- PR 템플릿 체크리스트를 채우고, 최소 1명 리뷰 후 머지
- 머지 방식은 **Squash and merge** 권장

## 시작하기

### 백엔드 (server/)

```bash
cd server
npm install
npm run start:dev   # http://localhost:3000
```

자세한 내용·환경 변수·다음 단계는 [server/README.md](server/README.md).

### 클라이언트 (client/)

```bash
cd client
npm install
npm run dev         # Electron + Vite 개발 모드 (HMR)
```

자세한 내용·다음 단계는 [client/README.md](client/README.md).
