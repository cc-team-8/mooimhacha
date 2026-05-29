# 04. API 명세

## REST 엔드포인트

### 인증·팀
```
GET    /api/auth/kakao            # 카카오 로그인 시작 (인가 코드 요청)
GET    /api/auth/kakao/callback   # 카카오 인가 콜백 → 세션/JWT 발급
POST   /api/auth/logout
GET    /api/teams
POST   /api/teams
PATCH  /api/teams/:id
POST   /api/teams/:id/invitations
```

### 회의
```
GET    /api/meetings
POST   /api/meetings
PATCH  /api/meetings/:id
DELETE /api/meetings/:id
POST   /api/meetings/:id/start    # T0 발행
POST   /api/meetings/:id/end      # 회의록 그루핑 트리거
```

### 아젠다
```
GET    /api/meetings/:id/agendas
POST   /api/meetings/:id/agendas
PATCH  /api/agendas/:id
DELETE /api/agendas/:id
POST   /api/meetings/:id/agendas/generate   # LLM 아젠다 생성 (직전 회의 종합 결과 기반)
POST   /api/agendas/:id/activate
POST   /api/agendas/:id/summarize           # LLM 안건 요약 (안건 완료 시)
```

### 발화·기여도
```
GET    /api/meetings/:id/contributions   # ① 회의 기여도 — 해당 회의 참여자별 meeting_score (저장값)
GET    /api/teams/:id/contributions      # ②③④ 팀 멤버별 회의 종합·테스크·종합 기여도 (동적 계산)
```

기여도 4종 ([06](06-기여도-산정.md)):

| # | 이름 | 범위 | 산출 | 엔드포인트 |
| --- | --- | --- | --- | --- |
| ① | 회의 기여도 | user×meeting | 발언×0.6 + 참석×0.4 (저장값) | `GET /api/meetings/:id/contributions` |
| ② | 회의 종합 기여도 | user×team | Σ(meeting_score×회의시간)/Σ(회의시간) | `GET /api/teams/:id/contributions` |
| ③ | 테스크 기여도 | user×team | (완료율+마감준수)/2 — `action_items`에서 라이브 | `GET /api/teams/:id/contributions` |
| ④ | 종합 기여도 | user×team | ③×0.5 + ②×0.5 | `GET /api/teams/:id/contributions` |

- `GET /api/meetings/:id/contributions` → 참여자별 `①`(+ 산정 근거: speech_ratio·attendance_ratio 등).
- `GET /api/teams/:id/contributions` → 멤버별 `②③④` 묶음. `②③④`는 저장 없이 조회 시점 계산.

> 발화 전송은 WebSocket `utterance:new` 전용. REST 엔드포인트는 두지 않는다.

### 결정·액션
```
GET    /api/decisions
POST   /api/decisions
PATCH  /api/decisions/:id
DELETE /api/decisions/:id
GET    /api/action-items
POST   /api/action-items
PATCH  /api/action-items/:id
DELETE /api/action-items/:id
POST   /api/action-items/:id/attachments   # 자료 첨부 (업로드 방식 미정 — [09](09-미결정-사항.md))
GET    /api/action-items/:id/attachments
DELETE /api/attachments/:id
POST   /api/meetings/:id/summarize            # LLM 회의 종합 정리 (요약·누락 결정·태스크)
POST   /api/meetings/:id/confirm              # 회의 산출물 확정
```

## WebSocket 이벤트

| 이벤트 | 방향 | 용도 |
| --- | --- | --- |
| `meeting:join` / `meeting:leave` | client → server | 회의 룸 입·퇴장 |
| `meeting:t0` | server → client | 시각 동기화 기준점 broadcast |
| `utterance:new` | client → server | 확정 발화(텍스트) 전송 |
| `contribution:update` | server → client | 기여도 갱신 (1초 디바운스) |
| `agenda:status-change` | 양방향 | 안건 상태 변경 broadcast |
| `agenda:summary` | server → client | 완료 안건의 LLM 요약 도착 broadcast |
| `decision:new` / `action:new` | 양방향 | 결정·액션 추가 broadcast |
| `user:speaking-start` / `speaking-end` | 양방향 | 발화 중 🎤 표시 |

## 발화 전송 페이로드 (`utterance:new`)

- `utterance_id`, `text`, `char_count`
- `started_at_offset_ms`, `ended_at_offset_ms`
- `confidence` — Moonshine 추론 신뢰도 (산출 방식 검증 필요, [09](09-미결정-사항.md))
- 전송 시점: VAD가 발화 종료를 감지하고 Moonshine 추론이 완료된 직후 (발화 단위, 디바운스 없음)
- 전송 내용은 텍스트와 메타데이터뿐 — 오디오는 전송하지 않음
