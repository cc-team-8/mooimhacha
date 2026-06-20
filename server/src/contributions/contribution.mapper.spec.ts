import {
  deriveMemberData,
  mapTeamSettings,
  toTaskActions,
} from './contribution.mapper';
import { MeetingScoreRequest, TeamSettingsPayload } from './contribution.types';

const SETTINGS: TeamSettingsPayload = {
  punctuality_grace_ratio: 0.1,
  presence_grace_seconds: 30,
  max_utterance_chars: 500,
  deadline_penalty_curve: 'standard',
  absent_meeting_handling: 'exclude',
  min_meeting_minutes: 5,
  final_task_weight: 0.5,
  weight_speech_in_meeting: 0.6,
  weight_attend_in_meeting: 0.4,
  leader_bonus_multiplier: 1.0,
};

describe('mapTeamSettings — 우리 설정 → 외부 TeamSettingsSchema', () => {
  it('기본 설정을 외부 필드명·단위로 변환한다 (가중치 0.6/0.4 명시, standard→normal, 분→초)', () => {
    expect(mapTeamSettings(SETTINGS)).toEqual({
      weight_speech_in_meeting: 0.6,
      weight_attend_in_meeting: 0.4,
      weight_task_in_final: 0.5,
      punctuality_grace_ratio: 0.1,
      absence_grace_sec: 30,
      leader_bonus: 0,
      action_chars_limit: 500,
      deadline_mode: 'normal',
      min_meeting_sec: 300,
    });
  });

  it('leader_bonus_multiplier(배율) → leader_bonus(가산)로 변환한다', () => {
    expect(
      mapTeamSettings({ ...SETTINGS, leader_bonus_multiplier: 1.2 })
        .leader_bonus,
    ).toBeCloseTo(0.2);
    // 1 미만 배율은 0으로 클램프 (외부 엔진은 가산 보너스만 지원)
    expect(
      mapTeamSettings({ ...SETTINGS, leader_bonus_multiplier: 0.8 })
        .leader_bonus,
    ).toBe(0);
  });

  it('lenient/strict 마감 모드는 그대로 전달한다', () => {
    expect(
      mapTeamSettings({ ...SETTINGS, deadline_penalty_curve: 'lenient' })
        .deadline_mode,
    ).toBe('lenient');
    expect(
      mapTeamSettings({ ...SETTINGS, deadline_penalty_curve: 'strict' })
        .deadline_mode,
    ).toBe('strict');
  });
});

// t0=0, ended=60분 회의 (3600초)
const T0 = '2026-06-01T00:00:00.000Z';
const ENDED = '2026-06-01T01:00:00.000Z';

function baseMeetingReq(
  partial: Partial<MeetingScoreRequest>,
): MeetingScoreRequest {
  return {
    meeting: {
      id: 7,
      total_minutes: 60,
      scheduled_at: T0,
      t0_timestamp: T0,
      ended_at: ENDED,
      meeting_type: 'regular',
    },
    team_settings: SETTINGS,
    participant_user_ids: [1, 2],
    utterances: [],
    agendas: [],
    presence_events: [],
    anomaly_events: [],
    ...partial,
  };
}

const join = (user_id: number, ms: number) => ({
  user_id,
  event_type: 'join',
  disconnect_classification: null,
  timestamp_offset_ms: ms,
});
const leave = (user_id: number, ms: number) => ({
  user_id,
  event_type: 'leave',
  disconnect_classification: null,
  timestamp_offset_ms: ms,
});

describe('deriveMemberData — 원시 이벤트 → 외부 MemberMeetingData', () => {
  it('정시 입장·완전 참석: attend=3600초, late=0, 글자수·식별자 매핑', () => {
    const req = baseMeetingReq({
      utterances: [
        { user_id: 1, char_count: 600, agenda_id: 10, confidence: 0.9 }, // 500 절단
        { user_id: 1, char_count: 400, agenda_id: 10, confidence: 0.7 },
        { user_id: 2, char_count: 100, agenda_id: 10, confidence: 0.9 },
      ],
      presence_events: [join(1, 0), join(2, 0)],
    });
    const { data, rawSpeechRatio } = deriveMemberData(req, 1);
    expect(data.name).toBe('1');
    expect(data.meeting_id).toBe('7');
    expect(data.meeting_total_sec).toBe(3600);
    expect(data.actual_attend_sec).toBe(3600);
    expect(data.late_sec).toBe(0);
    expect(data.own_chars).toBe(900); // 500(절단) + 400
    expect(data.utterance_count).toBe(2);
    expect(data.total_chars_during).toBe(1000); // 500 + 400 + 100
    expect(data.team_size).toBe(2);
    expect(data.speech_confidence).toBeCloseTo(0.8); // (0.9+0.7)/2
    expect(data.absent).toBe(false);
    expect(data.is_official).toBe(true);
    expect(rawSpeechRatio).toBeCloseTo(0.9); // 900/1000
  });

  it('지각: late_sec만 잡히고 출석 시간은 차감하지 않는다 (punctuality에서만 감점)', () => {
    const req = baseMeetingReq({
      presence_events: [join(1, 300_000)], // 5분 지각
    });
    const { data } = deriveMemberData(req, 1);
    expect(data.late_sec).toBe(300);
    expect(data.actual_attend_sec).toBe(3600);
  });

  it('자발 자리비움(grace 이상)은 차감, 비자발 끊김은 재석 인정', () => {
    const req = baseMeetingReq({
      presence_events: [
        // user 1: 10분에 leave, 20분에 복귀 → 600초 차감
        join(1, 0),
        leave(1, 600_000),
        join(1, 1_200_000),
        // user 2: 비자발 끊김 10분 → 차감 없음
        join(2, 0),
        {
          user_id: 2,
          event_type: 'disconnect',
          disconnect_classification: 'involuntary',
          timestamp_offset_ms: 600_000,
        },
        join(2, 1_200_000),
      ],
    });
    expect(deriveMemberData(req, 1).data.actual_attend_sec).toBe(3000);
    expect(deriveMemberData(req, 2).data.actual_attend_sec).toBe(3600);
  });

  it('회의 끝까지 복귀하지 않은 leave도 자리비움으로 차감한다', () => {
    const req = baseMeetingReq({
      presence_events: [join(1, 0), leave(1, 3_000_000)], // 50분에 퇴장
    });
    expect(deriveMemberData(req, 1).data.actual_attend_sec).toBe(3000);
  });

  it('join 기록이 없으면 absent=true, attend=0', () => {
    const req = baseMeetingReq({ presence_events: [join(2, 0)] });
    const { data, rawSpeechRatio } = deriveMemberData(req, 1);
    expect(data.absent).toBe(true);
    expect(data.actual_attend_sec).toBe(0);
    expect(rawSpeechRatio).toBeNull(); // 전체 발언 0
  });

  it('capture_loss 비율 → audio_loss_pct(%)', () => {
    const req = baseMeetingReq({
      utterances: [
        { user_id: 1, char_count: 100, agenda_id: null, confidence: null },
        { user_id: 1, char_count: 100, agenda_id: null, confidence: null },
      ],
      presence_events: [join(1, 0)],
      anomaly_events: [
        { user_id: 1, event_type: 'capture_loss', timestamp_offset_ms: 1000 },
      ],
    });
    // 1 / (2 발언 + 1 손실) × 100
    expect(deriveMemberData(req, 1).data.audio_loss_pct).toBeCloseTo(33.333, 2);
    // confidence 전부 null → 기본 1.0
    expect(deriveMemberData(req, 1).data.speech_confidence).toBe(1.0);
  });

  it('비정규 회의는 is_official=false', () => {
    const req = baseMeetingReq({
      meeting: {
        id: 7,
        total_minutes: 60,
        scheduled_at: T0,
        t0_timestamp: T0,
        ended_at: ENDED,
        meeting_type: 'adhoc',
      },
      presence_events: [join(1, 0)],
    });
    expect(deriveMemberData(req, 1).data.is_official).toBe(false);
  });
});

describe('toTaskActions — 액션 아이템 → 외부 ActionItem', () => {
  const NOW = new Date('2026-06-10T00:00:00.000Z');
  const base = {
    assignee_id: 1,
    status: 'done',
    difficulty: 2,
    due_date: '2026-06-01T00:00:00.000Z',
    completed_at: '2026-06-01T00:00:00.000Z',
    confirmed: true,
  };

  it('done: 마감 내 완료 days_late=0, 늦은 완료는 일수 올림', () => {
    expect(toTaskActions([base], 1, NOW)).toEqual([
      { completed: true, days_late: 0, difficulty: 2 },
    ]);
    expect(
      toTaskActions(
        [{ ...base, completed_at: '2026-06-02T12:00:00.000Z' }],
        1,
        NOW,
      ),
    ).toEqual([{ completed: true, days_late: 2, difficulty: 2 }]);
  });

  it('마감 없는 done은 days_late=null (감점 없음)', () => {
    expect(
      toTaskActions([{ ...base, due_date: null }], 1, NOW)[0].days_late,
    ).toBeNull();
  });

  it('cancelled·기한 경과 미완료 → completed=false (0점 분모 포함)', () => {
    expect(toTaskActions([{ ...base, status: 'cancelled' }], 1, NOW)).toEqual([
      { completed: false, days_late: null, difficulty: 2 },
    ]);
    expect(
      toTaskActions(
        [{ ...base, status: 'in_progress', completed_at: null }],
        1,
        NOW,
      ),
    ).toEqual([{ completed: false, days_late: null, difficulty: 2 }]);
  });

  it('기한 전 미완료·미확정·타인 액션은 전달하지 않는다', () => {
    expect(
      toTaskActions(
        [
          {
            ...base,
            status: 'todo',
            completed_at: null,
            due_date: '2026-07-01T00:00:00.000Z',
          },
          { ...base, confirmed: false },
          { ...base, assignee_id: 2 },
        ],
        1,
        NOW,
      ),
    ).toEqual([]);
  });

  it('difficulty 0 이하는 1로 보정', () => {
    expect(
      toTaskActions([{ ...base, difficulty: 0 }], 1, NOW)[0].difficulty,
    ).toBe(1);
  });
});
