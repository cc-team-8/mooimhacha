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
  late_threshold_sec: number | null;
  late_max_sec: number | null;
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
  excused_late: boolean;
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

// 단일 회의 상세 점수 — attend_score는 출석비율+지각 페널티(사유 지각 면제 포함)가
// 반영된 값. attendance_ratio(순수 참여시간 비율)와 달리 지각 여부를 실제로 반영하므로
// 화면의 "출석" 표시는 이 값을 써야 한다.
export interface ExternalMeetingScoreResponse {
  name: string;
  meeting_id: string;
  meeting_total_sec: number;
  speech_score: number | null;
  attend_score: number | null;
  meeting_contribution: number;
  reliability: string;
  low_attend_flag: boolean;
  weights_used: Record<string, number>;
  is_official: boolean;
  excused_absence: boolean;
  absent: boolean;
}

export interface ExternalTaskScoreResponse {
  name: string;
  score: number | null;
  total_actions: number;
  completed_actions: number;
  completed_weight: number;
  volume_score: number | null;
}

export interface ExternalFinalScoreResponse {
  name: string;
  meeting_score: number;
  task_score: number | null;
  final: number;
  weights_used: Record<string, number>;
  leader_applied: boolean;
}

// /pipeline/score 응답 — meeting 은 보낸 회의들의 누적(②) 결과,
// meeting_scores 는 보낸 각 회의의 단일 회의 상세(① 수준 — attend_score 등)
export interface ExternalFullPipelineResponse {
  name: string;
  meeting: ExternalCumulativeScoreResponse;
  task: ExternalTaskScoreResponse;
  final: ExternalFinalScoreResponse;
  meeting_scores: ExternalMeetingScoreResponse[];
}

// --- 변환 함수 ---

// 우리 팀 설정 → 외부 설정. 발언/참석 가중치는 팀 설정값(기본 0.6/0.4)을 전달한다
// (외부 엔진 기본값 0.75/0.25 미사용 — 로컬 폴백 스코어러와 결과 일관성 유지).
export function mapTeamSettings(s: TeamSettingsPayload): ExternalTeamSettings {
  const curve = s.deadline_penalty_curve ?? 'standard';
  const lateThresholdMin = s.late_threshold_minutes ?? 5;
  const lateMaxMin = s.late_max_minutes ?? 0;
  return {
    weight_speech_in_meeting: s.weight_speech_in_meeting ?? 0.6,
    weight_attend_in_meeting: s.weight_attend_in_meeting ?? 0.4,
    weight_task_in_final: s.final_task_weight ?? 0.5,
    punctuality_grace_ratio: s.punctuality_grace_ratio ?? 0.1,
    // 지각 기준(분) → 초. 엔진의 신(新) 절대시간 기준 로직을 켠다.
    late_threshold_sec: lateThresholdMin * 60,
    // 지각 최대 인정 시간(분) → 초. 0(상한 없음)이면 null 전달 — 엔진이 점근적
    // 감쇠로 처리한다(0으로 즉시 떨어뜨리지 않고 계속 완만하게 감점).
    late_max_sec: lateMaxMin > 0 ? lateMaxMin * 60 : null,
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
// excusedLate: 이 회의에 대해 본인의 지각 사유가 팀원 과반 동의로 승인된 경우 true.
// 승인되면 엔진이 지각 감점(정시 점수)만 면제하고 출석 비율은 그대로 반영한다.
export function deriveMemberData(
  req: MeetingRawInput,
  userId: number,
  excusedLate = false,
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
      late_sec: firstJoin
        ? Math.max(0, firstJoin.timestamp_offset_ms) / 1000
        : 0,
      own_chars: ownChars,
      utterance_count: utterCount,
      total_chars_during: totalChars,
      team_size: req.participant_user_ids.length,
      audio_loss_pct: lossDenom > 0 ? (capLoss / lossDenom) * 100 : 0,
      speech_confidence: confCount > 0 ? confSum / confCount : 1.0,
      excused_absence: false, // 사유 결석은 absent_user_ids 보호로 처리 (출결 표시 전용 필드)
      excused_late: excusedLate,
      absent,
      is_official: req.meeting.meeting_type === 'regular',
    },
    rawSpeechRatio: totalChars > 0 ? ownChars / totalChars : null,
  };
}

// 무단결석(한 번도 입장 X · 승인된 사유결석 아님) 멤버 ID — docs/06: ① = 0, 누적(②)에 포함.
// 이 멤버들에게도 회의 행(absent 0행)을 생성해 엔진에 보내야 0점이 누적에 반영된다.
// 비정규·무효 회의는 엔진이 누적서 제외하므로 빈 배열로 둔다.
export function absentUnexcusedIds(input: {
  meetingType: string;
  isInvalidated: boolean;
  meetingAtMs: number;
  joinedIds: ReadonlySet<number>;
  excusedIds: ReadonlySet<number>;
  activeMemberships: {
    user_id: number;
    joinedAtMs: number;
    deletedAtMs: number | null;
  }[];
}): number[] {
  if (input.meetingType !== 'regular' || input.isInvalidated) return [];
  const out = new Set<number>();
  for (const m of input.activeMemberships) {
    if (m.joinedAtMs > input.meetingAtMs) continue; // 회의 후 합류
    if (m.deletedAtMs != null && m.deletedAtMs < input.meetingAtMs) continue; // 회의 전 탈퇴
    if (input.joinedIds.has(m.user_id)) continue; // 입장함 → 무단결석 아님
    if (input.excusedIds.has(m.user_id)) continue; // 승인된 사유결석 → 보호(제외)
    out.add(m.user_id);
  }
  return [...out];
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

// 완료한 액션의 난이도 가중 합 (= 한 사람의 절대 완료량). volume_score 계산의 기초값.
function completedWeight(actions: ExternalActionItem[]): number {
  return actions
    .filter((a) => a.completed)
    .reduce((sum, a) => sum + a.difficulty, 0);
}

// 팀 전체 멤버의 완료 난이도 가중 합 평균 — task_score 의 완료량(volume_score) 정규화 기준.
// 분모는 "태스크를 1개 이상 배정받은 인원 수"만 센다. 태스크를 전혀 안 받은 사람을
// 분모에 포함시키면 평균이 부당하게 낮아져, 정작 일을 받은 사람들 사이의 비교가
// 왜곡된다 — 실제로 일을 배정받은 사람들 사이에서의 상대 평가가 되도록 한다.
// 아무도 태스크를 안 받았거나, 받았지만 전원 완료량이 0이면 비교 의미가 없으므로
// null 을 반환해 엔진이 해당 축을 제외하고 completion_ratio·deadline_avg 두 축만으로
// 계산하게 한다(엔진 쪼 하위 호환 동작).
export function computeTeamAvgCompletedWeight(
  actionItems: TeamContributionRequest['action_items'],
  memberUserIds: number[],
  now: Date,
): number | null {
  const weights = memberUserIds
    .map((userId) => toTaskActions(actionItems, userId, now))
    .filter((actions) => actions.length > 0)
    .map((actions) => completedWeight(actions));
  if (weights.length === 0) return null;
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;
  return total / weights.length;
}
