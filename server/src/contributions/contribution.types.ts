// 외부 기여도 산정 서버와 주고받는 HTTP 계약 (통합 seam).
// 산정 공식 자체는 외부 서버가 docs/06-기여도-산정.md 를 구현한다.
// 우리 서버는 입력 데이터를 모아 보내고, 결과(① 회의 점수)는 우리 DB에 저장한다.
//
// ⚠ 외부 서버의 확정 스펙을 받으면 이 파일의 형태/필드명을 그에 맞춰 조정한다.
//    엔드포인트·인증 헤더는 contribution.client.ts 에서 환경변수로 주입한다.

// --- 트랙1 (① 회의 기여도) 계산 요청/응답 ---

export interface MeetingScoreRequest {
  meeting: {
    id: number;
    total_minutes: number;
    scheduled_at: string;
    t0_timestamp: string | null;
    ended_at: string | null;
    meeting_type: string;
  };
  team_settings: TeamSettingsPayload;
  participant_user_ids: number[];
  utterances: {
    user_id: number;
    char_count: number;
    agenda_id: number | null;
    confidence: number | null;
  }[];
  agendas: { id: number; status: string }[];
  presence_events: {
    user_id: number;
    event_type: string;
    disconnect_classification: string | null;
    timestamp_offset_ms: number;
  }[];
  anomaly_events: {
    user_id: number;
    event_type: string;
    timestamp_offset_ms: number;
  }[];
}

export interface MeetingScoreResult {
  user_id: number;
  speech_ratio: number | null;
  speech_consistency: number | null;
  attendance_ratio: number | null;
  punctuality_score: number | null;
  meeting_score: number | null;
  confidence_level: string | null;
  excluded_indicators: string[] | null;
}

export interface MeetingScoreResponse {
  scores: MeetingScoreResult[];
}

// --- 트랙2·종합 (②③④) 동적 계산 요청/응답 ---

export interface TeamContributionRequest {
  team_id: number;
  team_settings: TeamSettingsPayload;
  members: { user_id: number; role: string }[];
  // 저장된 ① (트랙1) 누적 입력
  meeting_scores: {
    user_id: number;
    meeting_id: number;
    meeting_score: number | null;
    total_minutes: number; // 예상 시간(분) — 생성 시 입력값
    // 실측 진행시간(분) = (ended_at − t0_timestamp)/60000, 없으면 total_minutes 폴백.
    // ② 최소시간 필터·시간 가중 평균은 이 값을 쓴다. (additive — 외부 서버 하위호환)
    actual_minutes: number;
    meeting_type: string;
    is_invalidated: boolean;
  }[];
  // 트랙2 라이브 계산 입력
  action_items: {
    assignee_id: number | null;
    status: string;
    difficulty: number;
    due_date: string | null;
    completed_at: string | null;
    confirmed: boolean;
  }[];
}

// ②③④ 외부 산정 입력 — 기존 calculate 와 같은 /pipeline/score 계약은 저장된 ① 점수를
// 받지 못하므로(원시 데이터 → 최종 점수), 회의별 원시 이벤트를 다시 모아 보낸다.
// 로컬 폴백 스코어러는 저장된 ① 기반의 TeamContributionRequest 를 그대로 쓴다.
export type MeetingRawInput = Omit<MeetingScoreRequest, 'agendas'>;

export interface TeamPipelineRequest {
  team_id: number;
  team_settings: TeamSettingsPayload;
  members: { user_id: number; role: string }[];
  meetings: (MeetingRawInput & { is_invalidated: boolean })[];
  action_items: TeamContributionRequest['action_items'];
}

export interface TeamContributionResult {
  user_id: number;
  meeting_aggregate: number | null; // ② 회의 종합
  task_score: number | null; // ③ 테스크
  composite_score: number | null; // ④ 종합
}

export interface TeamContributionResponse {
  members: TeamContributionResult[];
}

export interface TeamSettingsPayload {
  punctuality_grace_ratio: number;
  presence_grace_seconds: number;
  max_utterance_chars: number;
  deadline_penalty_curve: string;
  absent_meeting_handling: string;
  min_meeting_minutes: number;
  final_task_weight: number;
  leader_bonus_multiplier: number;
}
