# 04. API 명세

## REST 엔드포인트

### 인증 (Auth)

| 메서드 | 경로                       | 설명                                          |
| ------ | -------------------------- | --------------------------------------------- |
| GET    | `/api/auth/kakao/url`      | 카카오 인가 URL 발급 (클라이언트가 이동)      |
| GET    | `/api/auth/kakao/callback` | 인가 콜백 — 토큰 발급 후 클라이언트 리다이렉트 |
| POST   | `/api/auth/kakao`          | 카카오 인가 코드로 로그인/회원가입            |
| PATCH  | `/api/auth/profile`        | 신규 가입자 대학교·학과 등록                  |
| GET    | `/api/auth/me`             | 현재 로그인 사용자 정보                       |
| POST   | `/api/auth/refresh`        | refresh_token으로 access_token 재발급         |
| POST   | `/api/auth/logout`         | 로그아웃 (204)                                |
| DELETE | `/api/auth/me`             | 회원 탈퇴 — 익명화 + 전 팀 탈퇴               |

카카오 콜백 (`GET /api/auth/kakao/callback`):

- 토큰은 URL fragment(`#access_token=...&refresh_token=...&is_new_user=...`)로 전달 — 서버 로그·리퍼러에 남지 않음. 실패 시 `/?login_error=1`로 리다이렉트.

`GET /api/auth/me` 응답: `id`, `name`, `kakao_email`, `university`, `department`, `profile_image_url`, `email_opt_out`

회원 탈퇴 (`DELETE /api/auth/me`):

- 행 내 익명화 방식 — `is_deleted=true`, 이름은 '탈퇴한 사용자'로, 카카오 식별자·이메일·프로필·학교 정보는 제거. soft delete(`deleted_at`)를 쓰지 않는 이유는 과거 리포트의 사용자 조인 보존 ([03](03-데이터-모델.md)).
- 전 팀 멤버십 soft delete. 본인이 마지막 멤버였던 팀은 팀도 soft delete (회의·기여도 데이터는 보존).
- 본인이 팀장인 팀에 다른 활성 멤버가 있으면 `409 Conflict` — 팀장 위임 후 탈퇴 가능.
- 탈퇴한 계정의 잔여 토큰은 401 처리 (JWT 검증 시 `is_deleted` 확인).
- 카카오 연결끊기는 `KAKAO_ADMIN_KEY` 설정 시에만 수행 (미설정이면 건너뛰고 탈퇴는 진행).
- 응답: `{ "deleted": true }`

### 팀 / 멤버십 (Teams)

| 메서드 | 경로                             | 설명                         |
| ------ | -------------------------------- | ---------------------------- |
| GET    | `/api/teams`                     | 내가 속한 팀 목록            |
| POST   | `/api/teams`                     | 팀 생성 (생성자 자동 leader) |
| GET    | `/api/teams/:id`                 | 팀 상세 + 멤버 목록          |
| PATCH  | `/api/teams/:id`                 | 팀명·과목명 수정 (팀장만)    |
| POST   | `/api/teams/join`                | 초대 코드로 합류             |
| POST   | `/api/teams/:id/invite-code`     | 초대 코드 재발급 (팀장만)    |
| DELETE | `/api/teams/:id`                 | 팀 삭제 (팀장만, 204)        |
| PATCH  | `/api/teams/:id/leader`          | 팀장 위임 (팀장만)           |
| DELETE | `/api/teams/:id/members/me`      | 팀 탈퇴 (본인)               |
| DELETE | `/api/teams/:id/members/:userId` | 탈퇴 또는 추방 (204)         |

팀장 위임 (`PATCH /api/teams/:id/leader`):

- body: `{ "user_id": <팀장을 넘길 멤버의 user_id> }`
- 본인에게 위임 시 400, 대상이 활성 멤버가 아니면 404. 성공 시 갱신된 팀 상세 반환.

팀 탈퇴 (`DELETE /api/teams/:id/members/me`):

- 팀장은 다른 활성 멤버가 있으면 `409 Conflict` — 위임 후 탈퇴 가능.
- 마지막 1인이 나가면 팀도 soft delete (회의·기여도 데이터는 보존).
- 응답: `{ "left": true }`

### 팀 설정 (Team Settings)

| 메서드 | 경로                      | 설명                  |
| ------ | ------------------------- | --------------------- |
| GET    | `/api/teams/:id/settings` | 기여도 산정 설정 조회 |
| PATCH  | `/api/teams/:id/settings` | 설정 수정 (팀장만)    |

### 회의 (Meetings)

| 메서드 | 경로                                        | 설명                                          |
| ------ | ------------------------------------------- | --------------------------------------------- |
| GET    | `/api/meetings`                             | 내 회의 목록 (`?team_id`로 필터)              |
| POST   | `/api/meetings`                             | 회의 생성                                     |
| GET    | `/api/meetings/:id`                         | 회의 상세                                     |
| PATCH  | `/api/meetings/:id`                         | 회의 수정                                     |
| DELETE | `/api/meetings/:id`                         | 회의 삭제 (팀장)                              |
| POST   | `/api/meetings/:id/start`                   | 회의 시작 — T0 발행, status → active          |
| POST   | `/api/meetings/:id/end`                     | 종료 — 발화 그루핑 + 기여도(①) 산정 트리거    |
| GET    | `/api/meetings/:id/transcript`              | 회의록 (안건별 그루핑)                        |
| POST   | `/api/meetings/:id/summarize`               | AI 회의 종합 정리 (요약·누락 결정·태스크) ⏱   |
| POST   | `/api/meetings/:id/confirm`                 | 회의 산출물 확정 (팀장)                       |
| POST   | `/api/meetings/:id/contributions/recompute` | 기여도 재산정 (종료된 회의 — 산정 실패 복구용) |

⏱ LLM 호출 라우트는 비용 방어용 스로틀 적용 (분당 3회).

### 안건 (Agendas)

| 메서드 | 경로                                 | 설명                                          |
| ------ | ------------------------------------ | --------------------------------------------- |
| GET    | `/api/meetings/:id/agendas`          | 안건 목록                                     |
| POST   | `/api/meetings/:id/agendas`          | 안건 추가 (회의 중 즉석 추가 포함)            |
| PATCH  | `/api/agendas/:id`                   | 안건 수정 (상태 변경 포함)                    |
| DELETE | `/api/agendas/:id`                   | 안건 삭제                                     |
| POST   | `/api/agendas/:id/activate`          | 안건 활성화 (기존 active는 pending으로)       |
| POST   | `/api/agendas/:id/summarize`         | 안건 LLM 요약 (완료 시) ⏱                     |
| POST   | `/api/meetings/:id/agendas/generate` | 다음 회의 안건 LLM 생성 (직전 회의 결과 기반) ⏱ |

### 발화 (Utterances)

발화 **생성은 REST가 아닌 WebSocket**(`utterance:new`)으로만 한다 (아래 WebSocket 이벤트 참조).
조회는 회의록(`GET /api/meetings/:id/transcript`)에 안건별로 그루핑되어 포함된다.

| 메서드 | 경로                                          | 설명                                         |
| ------ | --------------------------------------------- | -------------------------------------------- |
| PATCH  | `/api/meetings/:id/utterances/batch`          | 병합 그룹 발화 일괄 정정 (트랜잭션 + 재산정 1회) |
| PATCH  | `/api/meetings/:id/utterances/:utteranceId`   | 발화 정정 (본인 발화, 종료된 회의만)         |
| DELETE | `/api/meetings/:id/utterances/:utteranceId`   | 발화 삭제 (본인 발화, 종료된 회의만)         |

### 결정사항 (Decisions)

| 메서드 | 경로                 | 설명                              |
| ------ | -------------------- | --------------------------------- |
| GET    | `/api/decisions`     | 결정 목록 (`?meeting_id` 필수)    |
| POST   | `/api/decisions`     | 결정 추가                         |
| PATCH  | `/api/decisions/:id` | 내용 수정 또는 확정 처리          |
| DELETE | `/api/decisions/:id` | 결정 삭제                         |

회의 중 추가는 WebSocket `decision:new`로도 가능 (broadcast 포함).

### 액션 아이템 (Action Items) — 팀 단위 스코프

| 메서드 | 경로                    | 설명                                          |
| ------ | ----------------------- | --------------------------------------------- |
| GET    | `/api/action-items`     | 액션 목록 (`?team_id` 필수, `?assignee_id` 선택) |
| POST   | `/api/action-items`     | 액션 추가 (team_id 필수)                      |
| PATCH  | `/api/action-items/:id` | 내용·상태·완료·확정 수정                      |
| DELETE | `/api/action-items/:id` | 액션 삭제                                     |

회의 중 추가는 WebSocket `action:new`로도 가능 (broadcast 포함).

### 기여도 (Contributions)

기여도 4종 ([06](06-기여도-산정.md)):

| #   | 이름             | 범위         | 산출                                            | 엔드포인트                            |
| --- | ---------------- | ------------ | ----------------------------------------------- | ------------------------------------- |
| ①   | 회의 기여도      | user×meeting | 발언×0.6 + 참석×0.4 (저장값)                    | `GET /api/meetings/:id/contributions` |
| ②   | 회의 종합 기여도 | user×team    | Σ(meeting_score×회의시간)/Σ(회의시간)           | `GET /api/teams/:id/contributions`    |
| ③   | 테스크 기여도    | user×team    | (완료율+마감준수)/2 — `action_items`에서 라이브 | `GET /api/teams/:id/contributions`    |
| ④   | 종합 기여도      | user×team    | min(1.0, (③×w + ②×(1−w)) × (1+n))               | `GET /api/teams/:id/contributions`    |

| 메서드 | 경로                                        | 설명                                       |
| ------ | ------------------------------------------- | ------------------------------------------ |
| GET    | `/api/meetings/:id/contributions`           | ① 회의 참여자별 meeting_score (저장값)     |
| GET    | `/api/teams/:id/contributions`              | ②③④ 팀 멤버별 종합 기여도 (동적 계산)      |
| POST   | `/api/meetings/:id/contributions/recompute` | 기여도(①) 재산정 (종료된 회의, 실패 복구용) |
| POST   | `/api/teams/:teamId/contribution/calculate` | 외부 엔진 직접 호출 — body로 회의 데이터 전달 |

`GET /api/teams/:id/contributions` 응답의 `members[]`에 레이더 차트(출석·참여도 축)용 필드 포함:

- `attendance_avg`, `speech_avg` (0~1 또는 null) — 산정에 포함된 회의(무효 처리·비정규 제외)의 ① 비율 단순 평균
- 공개범위 제한으로 타인 점수가 마스킹되면 함께 null

**산정 위치** — 산정 공식([06](06-기여도-산정.md))의 실행 주체는 둘 중 하나:

- `CONTRIBUTION_SERVICE_URL` 설정 시: 외부 기여도 엔진(cc-team-8/Contribution, FastAPI)의 **`/pipeline/score` 단일 엔드포인트**로 위임. ①은 회의 종료 시 참여자별 호출, ②③④는 조회 시 회의별 원시 이벤트를 다시 모아 멤버별 1회 호출. pipeline이 제공하지 않는 상세 필드(`speech_consistency`·`punctuality_score`·`confidence_level` 등)는 null, 출석률은 서버 파생값으로 저장.
- 미설정 시(개발/데모): 서버 내 로컬 스코어러가 같은 공식으로 계산 — 회의 종료·조회 흐름이 끊기지 않음.

### 알림 (Notifications)

| 메서드 | 경로                          | 설명                              |
| ------ | ----------------------------- | --------------------------------- |
| GET    | `/api/notifications`          | 내 알림 목록 (`?unread=true`로 미읽음만) |
| PATCH  | `/api/notifications/:id/read` | 알림 읽음 처리                    |
| POST   | `/api/notifications/read-all` | 전체 읽음 처리                    |

알림 종류는 [03](03-데이터-모델.md) Notification 참조 (회의 5분 전 / 액션 확정 / 산출물 확정).

### 리포트 (Reports)

| 메서드 | 경로                        | 설명                                |
| ------ | --------------------------- | ----------------------------------- |
| GET    | `/api/meetings/:id/report`  | 교수 제출용 회의 리포트 (인쇄용 HTML) |

### 헬스체크

| 메서드 | 경로          | 설명                          |
| ------ | ------------- | ----------------------------- |
| GET    | `/api/health` | 배포 헬스체크 (인증 불필요)   |

### 사유 결석 (Meeting Absences) — P1, 미구현

| 메서드 | 경로                         | 설명             |
| ------ | ---------------------------- | ---------------- |
| GET    | `/api/meetings/:id/absences` | 사유 결석 목록   |
| POST   | `/api/meetings/:id/absences` | 결석 신청 (본인) |
| PATCH  | `/api/absences/:id/approve`  | 승인 (팀장만)    |
| DELETE | `/api/absences/:id`          | 삭제/거절        |

## WebSocket 이벤트

| 이벤트                                 | 방향            | 용도                                          |
| -------------------------------------- | --------------- | --------------------------------------------- |
| `meeting:join` / `meeting:leave`       | client → server | 회의 룸 입·퇴장                               |
| `meeting:t0`                           | server → client | 시각 동기화 기준점 (join 직후 + start 시 broadcast) |
| `meeting:ended`                        | server → client | 회의 종료 broadcast                           |
| `presence:update`                      | server → client | 참석자 입·퇴장 상태 broadcast                 |
| `utterance:new`                        | client → server | 확정 발화(텍스트) 전송 — ack로 `utterance_id`·`agenda_id` 반환 |
| `contribution:update`                  | server → client | 기여도 갱신 (1초 디바운스)                    |
| `agenda:status-change`                 | 양방향          | 안건 상태 변경 broadcast                      |
| `agenda:summary`                       | server → client | 완료 안건의 LLM 요약 도착 broadcast           |
| `decision:new` / `action:new`          | 양방향          | 결정·액션 추가 broadcast                      |
| `user:speaking-start` / `speaking-end` | 양방향          | 발화 중 🎤 표시                               |
| `anomaly:report`                       | client → server | 캡처 유실·STT 실패 등 이상 이벤트 기록        |
| `error`                                | server → client | 인증 실패 등 오류 통지                        |

## 발화 전송 페이로드 (`utterance:new`)

- `meeting_id`, `text`
- `started_at_offset_ms`, `ended_at_offset_ms`
- `confidence` — STT 엔진 신뢰도 (0~1, 선택)
- 서버는 클라이언트 값을 신뢰하지 않는다 — `char_count`는 서버가 text 길이로 강제 산출(조작 방지), 과대 텍스트는 2,000자 절단(발화 유실 방지), 오프셋·confidence는 클램프
- 발화 시점의 진행 중(active) 안건에 자동 매칭되어 저장 — ack로 `{ utterance_id, agenda_id }` 반환
- 전송 시점: STT가 발화 종료를 확정한 직후 (발화 단위, 디바운스 없음)
- 전송 내용은 텍스트와 메타데이터뿐 — 오디오는 전송하지 않음
