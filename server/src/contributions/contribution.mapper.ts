import {
  MeetingRawInput,
  TeamContributionRequest,
  TeamSettingsPayload,
} from './contribution.types';

// 외부 기여도 산정 API(cc-team-8/Contribution)와 주고받는 타입 + 순수 변환 함수.
// 기존 calculate(server/src/contribution)와 동일하게 /pipeline/score 단일 엔드포인트만 쓴다.
// 외부 API는 멤버 1명 단위 호출이며 식별자가 name(str)이라 user_id 를 문자열로 변환해 보낸다.
// 점수 스케일은 양쪽 모두 0~1.

// --- 외부 API 타입 (api/schemas.py 대응) ---

export interface ExternalTeamSettings {
  weight_speech_in_meeting: number;
  weight_attend_in_meeting: number;
  weight_task_in_final: number;
  punctuality_grace_ratio: number;
  absence_grace_sec: number;
  leader_bonus: number;
  action_chars_limit: number;
  deadline_mode: string;
  min_meeting_sec: number;
}

export interface ExternalMemberMeetingData {
  name: string;
  meeting_id: string;
  meeting_total_sec: number;
  actual_attend_sec: number;
  late_sec: number;
  own_chars: number;
  utterance_count: number;
  total_chars_during: number;
  team_size: number;
  audio_loss_pct: number;
  speech_confidence: number;
  excused_absence: boolean;
  absent: boolean;
  is_official: boolean;
  // ③ 테스크 입력 — pipeline 은 회의 행에 동봉된 액션을 모아(collect_actions) 계산한다
  actions?: ExternalActionItem[];
}

export interface ExternalActionItem {
  completed: boolean;
  days_late: number | null;
  difficulty: number;
}

export interface ExternalCumulativeScoreResponse {
  name: string;
  score: number;
  meeting_count: number;
  included_count: number;
  excluded_count: number;
}

export interface ExternalTaskScoreResponse {
  name: string;
  score: number | null;
  total_actions: number;
  completed_actions: number;
}

export interface ExternalFinalScoreResponse {
  name: string;
  meeting_score: number;
  task_score: number | null;
  final: number;
  weights_used: Record<string, number>;
  leader_applied: boolean;
}

// /pipeline/score 응답 — meeting 은 보낸 회의들의 누적(②) 결과
export interface ExternalFullPipelineResponse {
  name: string;
  meeting: ExternalCumulativeScoreResponse;
  task: ExternalTaskScoreResponse;
  final: ExternalFinalScoreResponse;
}

// --- 변환 함수 ---

// 우리 팀 설정 → 외부 설정. 발언/참석 가중치는 docs/06 기준 0.6/0.4 를 명시 전달한다
// (외부 엔진 기본값 0.75/0.25 미사용 — 로컬 폴백 스코어러와 결과 일관성 유지).
export function mapTeamSettings(s: TeamSettingsPayload): ExternalTeamSettings {
  const curve = s.deadline_penalty_curve ?? 'standard';
  return {
    weight_speech_in_meeting: 0.6,
    weight_attend_in_meeting: 0.4,
    weight_task_in_final: s.final_task_weight ?? 0.5,
    punctuality_grace_ratio: s.punctuality_grace_ratio ?? 0.1,
    absence_grace_sec: s.presence_grace_seconds ?? 30,
    // 우리는 배율(final×n), 외부는 가산(final×(1+n)) — 1 미만 배율은 표현 불가라 0 클램프
    leader_bonus: Math.max(0, (s.leader_bonus_multiplier ?? 1) - 1),
    action_chars_limit: s.max_utterance_chars ?? 500,
    deadline_mode: curve === 'standard' ? 'normal' : curve,
    min_meeting_sec: (s.min_meeting_minutes ?? 5) * 60,
  };
}

// 실측 진행시간(ms) — ended_at−t0, 없으면 total_minutes 환산 (scorer 와 동일 공식)
function meetingDurationMs(m: MeetingRawInput['meeting']): number {
  if (m.t0_timestamp && m.ended_at) {
    const d =
      new Date(m.ended_at).getTime() - new Date(m.t0_timestamp).getTime();
    if (d > 0) return d;
  }
  return Math.max(0, (m.total_minutes ?? 0) * 60000);
}

// 한 참여자의 원시 이벤트를 외부 MemberMeetingData(파생 지표)로 변환.
// rawSpeechRatio(own/total)는 UI 발언 비중 바 저장용 — 외부 speech_score 는 1/N 정규화 점수라 별개.
export function deriveMemberData(
  req: MeetingRawInput,
  userId: number,
): { data: ExternalMemberMeetingData; rawSpeechRatio: number | null } {
  const s = req.team_settings;
  const maxChars = s.max_utterance_chars ?? 500;
  const durationMs = meetingDurationMs(req.meeting);
  const truncate = (c: number) => Math.min(Math.max(c, 0), maxChars);

  let ownChars = 0;
  let utterCount = 0;
  let confSum = 0;
  let confCount = 0;
  let totalChars = 0;
  for (const u of req.utterances) {
    const c = truncate(u.char_count);
    totalChars += c;
    if (u.user_id === userId) {
      ownChars += c;
      utterCount += 1;
      if (u.confidence != null) {
        confSum += u.confidence;
        confCount += 1;
      }
    }
  }

  const mine = req.presence_events
    .filter((e) => e.user_id === userId)
    .sort((a, b) => a.timestamp_offset_ms - b.timestamp_offset_ms);
  const firstJoin = mine.find(
    (e) => e.event_type === 'join' || e.event_type === 'reconnect',
  );
  const absent = !firstJoin || durationMs <= 0;

  // 자발 자리비움(grace 이상)만 재석에서 차감.
  // 지각 구간은 late_sec(punctuality)에서만 감점하고, 비자발 끊김은 재석으로 인정
  // (docs/06 의 "비자발 끊김 분모 제외 = 불이익 없음" 취지를 외부 엔진 입력으로 번역).
  const graceMs = (s.presence_grace_seconds ?? 30) * 1000;
  const clamp = (t: number) => Math.min(Math.max(t, 0), durationMs);
  let voluntaryAwayMs = 0;
  let present = false;
  let lastTs = 0;
  let awayKind: 'voluntary' | 'involuntary' | null = null;
  for (const e of mine) {
    const ts = clamp(e.timestamp_offset_ms);
    if (e.event_type === 'join' || e.event_type === 'reconnect') {
      if (!present) {
        if (awayKind === 'voluntary' && ts - lastTs >= graceMs) {
          voluntaryAwayMs += ts - lastTs;
        }
        present = true;
        lastTs = ts;
        awayKind = null;
      }
    } else if (e.event_type === 'leave' || e.event_type === 'disconnect') {
      if (present) {
        present = false;
        lastTs = ts;
        awayKind =
          e.event_type === 'leave'
            ? 'voluntary'
            : e.disconnect_classification === 'involuntary'
              ? 'involuntary'
              : 'voluntary';
      }
    }
  }
  if (!present && awayKind === 'voluntary') {
    const away = durationMs - lastTs;
    if (away >= graceMs) voluntaryAwayMs += away;
  }

  let capLoss = 0;
  for (const a of req.anomaly_events) {
    if (a.user_id === userId && a.event_type === 'capture_loss') capLoss += 1;
  }
  const lossDenom = utterCount + capLoss;

  return {
    data: {
      name: String(userId),
      meeting_id: String(req.meeting.id),
      meeting_total_sec: durationMs / 1000,
      actual_attend_sec: absent
        ? 0
        : Math.max(0, durationMs - voluntaryAwayMs) / 1000,
      late_sec:
        firstJoin && req.meeting.t0_timestamp
          ? Math.max(
              0,
              new Date(req.meeting.t0_timestamp).getTime() -
                new Date(req.meeting.scheduled_at).getTime() +
                firstJoin.timestamp_offset_ms,
            ) / 1000
          : 0,
      own_chars: ownChars,
      utterance_count: utterCount,
      total_chars_during: totalChars,
      team_size: req.participant_user_ids.length,
      audio_loss_pct: lossDenom > 0 ? (capLoss / lossDenom) * 100 : 0,
      speech_confidence: confCount > 0 ? confSum / confCount : 1.0,
      excused_absence: false, // 사유 결석은 점수에 반영하지 않음 (출결 표시 전용)
      absent,
      is_official: req.meeting.meeting_type === 'regular',
    },
    rawSpeechRatio: totalChars > 0 ? ownChars / totalChars : null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 액션 아이템 → 외부 ActionItem(③ 테스크 입력). 분모 정책은 로컬 스코어러와 동일:
// done(완료)·cancelled(무단 취소)·기한 경과 미완료만 전달(분모 포함), 기한 전 미완료는 평가 보류로 제외.
export function toTaskActions(
  actions: TeamContributionRequest['action_items'],
  userId: number,
  now: Date,
): ExternalActionItem[] {
  const out: ExternalActionItem[] = [];
  for (const a of actions) {
    if (a.assignee_id !== userId || !a.confirmed) continue;
    const difficulty = a.difficulty > 0 ? a.difficulty : 1;
    const due = a.due_date ? new Date(a.due_date).getTime() : null;
    if (a.status === 'done') {
      let daysLate: number | null = null;
      if (due != null && a.completed_at) {
        const completed = new Date(a.completed_at).getTime();
        daysLate = completed <= due ? 0 : Math.ceil((completed - due) / DAY_MS);
      }
      out.push({ completed: true, days_late: daysLate, difficulty });
    } else if (a.status === 'cancelled') {
      out.push({ completed: false, days_late: null, difficulty });
    } else if (
      (a.status === 'todo' || a.status === 'in_progress') &&
      due != null &&
      now.getTime() > due
    ) {
      out.push({ completed: false, days_late: null, difficulty });
    }
  }
  return out;
}
