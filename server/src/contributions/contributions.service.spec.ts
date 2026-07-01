import { ContributionsService } from './contributions.service';

// getTeamContributions()의 attendance_avg 계산이 승인된 사유결석을 평균에서
// 제외하는지 검증한다. composite_score(②)와 동일한 규칙을 써야 하므로,
// 이 동작이 깨지면 "사유결석 승인됐는데 출석 표시가 그대로 0%로 남는" 회귀가
// 재발한다.
describe('ContributionsService.getTeamContributions — attendance_avg 사유결석 제외', () => {
  const TEAM_ID = 1;
  const USER_ID = 10; // 조회 요청자(팀장)
  const SY = 30; // 사유결석 대상 멤버
  const MTG1 = 101;
  const MTG2 = 102;

  function makeService(overrides: {
    scores: Record<string, unknown>[];
    absences: Record<string, unknown>[];
    presence?: Record<string, unknown>[];
  }) {
    const meetings = [
      {
        id: MTG1,
        team_id: TEAM_ID,
        is_invalidated: false,
        meeting_type: 'regular',
        total_minutes: 60,
        t0_timestamp: null,
        ended_at: null,
        scheduled_at: new Date('2026-06-01'),
      },
      {
        id: MTG2,
        team_id: TEAM_ID,
        is_invalidated: false,
        meeting_type: 'regular',
        total_minutes: 50,
        t0_timestamp: null,
        ended_at: null,
        scheduled_at: new Date('2026-06-02'),
      },
    ];
    const memberships = [
      {
        team_id: TEAM_ID,
        user_id: USER_ID,
        role: 'leader',
        deleted_at: null,
        joined_at: new Date('2026-01-01'),
      },
      {
        team_id: TEAM_ID,
        user_id: SY,
        role: 'member',
        deleted_at: null,
        joined_at: new Date('2026-01-01'),
      },
    ];

    const scoreRepo = { find: jest.fn().mockResolvedValue(overrides.scores) };
    const meetingRepo = { find: jest.fn().mockResolvedValue(meetings) };
    const agendaRepo = { find: jest.fn().mockResolvedValue([]) };
    const utteranceRepo = { find: jest.fn().mockResolvedValue([]) };
    const presenceRepo = {
      find: jest.fn().mockResolvedValue(overrides.presence ?? []),
    };
    const anomalyRepo = { find: jest.fn().mockResolvedValue([]) };
    const actionRepo = { find: jest.fn().mockResolvedValue([]) };
    const membershipRepo = { find: jest.fn().mockResolvedValue(memberships) };
    const absenceRepo = {
      find: jest.fn().mockResolvedValue(overrides.absences),
    };
    const settingsRepo = {
      findOne: jest.fn().mockResolvedValue({
        team_id: TEAM_ID,
        contribution_visibility: 'team',
      }),
    };
    const userRepo = {
      find: jest.fn().mockResolvedValue([
        { id: USER_ID, name: '팀장' },
        { id: SY, name: '이서연' },
      ]),
    };
    const teamsService = {
      requireMembership: jest.fn().mockResolvedValue({
        team_id: TEAM_ID,
        user_id: USER_ID,
        role: 'leader',
      }),
    };
    const client = {
      computeTeamContributions: jest.fn().mockResolvedValue({
        members: [
          {
            user_id: USER_ID,
            meeting_aggregate: 1,
            task_score: null,
            composite_score: 1,
          },
          {
            user_id: SY,
            meeting_aggregate: 0.5,
            task_score: null,
            composite_score: 0.5,
          },
        ],
      }),
    };

    const service = new ContributionsService(
      scoreRepo as never,
      meetingRepo as never,
      agendaRepo as never,
      utteranceRepo as never,
      presenceRepo as never,
      anomalyRepo as never,
      actionRepo as never,
      membershipRepo as never,
      absenceRepo as never,
      settingsRepo as never,
      userRepo as never,
      teamsService as never,
      client as never,
    );
    return service;
  }

  it('승인된 사유결석 회의는 attendance_avg 평균에서 제외된다', async () => {
    // 회의1: attendance_ratio=0(결석), 승인된 사유결석 있음 → 제외
    // 회의2: attendance_ratio=0.8 → 포함
    // 제외하면 평균은 0.8(회의2만), 제외 안 하면 (0+0.8)/2=0.4
    const service = makeService({
      scores: [
        {
          user_id: SY,
          meeting_id: MTG1,
          attendance_ratio: 0,
          speech_ratio: null,
        },
        {
          user_id: SY,
          meeting_id: MTG2,
          attendance_ratio: 0.8,
          speech_ratio: null,
        },
      ],
      absences: [{ meeting_id: MTG1, user_id: SY }],
    });

    const result = await service.getTeamContributions(USER_ID, TEAM_ID);
    const sy = result.members.find((m) => m.user_id === SY)!;
    expect(sy.attendance_avg).toBeCloseTo(0.8);
  });

  it('사유결석이 승인되지 않았으면(미조회) 0점 회의도 평균에 그대로 포함된다', async () => {
    const service = makeService({
      scores: [
        {
          user_id: SY,
          meeting_id: MTG1,
          attendance_ratio: 0,
          speech_ratio: null,
        },
        {
          user_id: SY,
          meeting_id: MTG2,
          attendance_ratio: 0.8,
          speech_ratio: null,
        },
      ],
      absences: [], // 승인된 사유 없음 — 무단결석 그대로
    });

    const result = await service.getTeamContributions(USER_ID, TEAM_ID);
    const sy = result.members.find((m) => m.user_id === SY)!;
    expect(sy.attendance_avg).toBeCloseTo(0.4);
  });

  it('승인된 사유가 "지각"(입장 기록 있음)이면 회의를 제외하지 않고 attend_score 그대로 평균에 포함한다', async () => {
    // 결석(absence)과 지각(late)은 meeting_absences 테이블에 같은 형태로 저장되므로
    // presence_events의 입장 기록으로 구분해야 한다. 입장 기록이 있으면(=늦게라도
    // 참석) 그 회의는 빼면 안 된다 — 사유 지각의 효과는 "지각 페널티 면제"뿐이고
    // attend_score(0.65)에 이미 그 면제가 반영돼 있으므로, 그 값 그대로 평균에
    // 들어가야 한다. 회의 자체를 빼버리면 데이터가 1건 줄어 평균이 왜곡된다.
    const service = makeService({
      scores: [
        {
          user_id: SY,
          meeting_id: MTG1,
          attendance_ratio: 0.65, // 사유 지각 승인 — 페널티 면제된 값
          speech_ratio: null,
        },
        {
          user_id: SY,
          meeting_id: MTG2,
          attendance_ratio: 0.85,
          speech_ratio: null,
        },
      ],
      absences: [{ meeting_id: MTG1, user_id: SY }], // status=approved
      presence: [{ meeting_id: MTG1, user_id: SY, event_type: 'join' }], // 입장 기록 있음 = 지각
    });

    const result = await service.getTeamContributions(USER_ID, TEAM_ID);
    const sy = result.members.find((m) => m.user_id === SY)!;
    // 제외 안 됐으면 (0.65+0.85)/2=0.75. 잘못 제외됐다면 0.85만 남는다.
    expect(sy.attendance_avg).toBeCloseTo(0.75);
  });

  it('승인된 사유가 "결석"(입장 기록 없음)이면 여전히 회의를 제외한다 (회귀 방지)', async () => {
    const service = makeService({
      scores: [
        {
          user_id: SY,
          meeting_id: MTG1,
          attendance_ratio: 0,
          speech_ratio: null,
        },
        {
          user_id: SY,
          meeting_id: MTG2,
          attendance_ratio: 0.85,
          speech_ratio: null,
        },
      ],
      absences: [{ meeting_id: MTG1, user_id: SY }],
      presence: [], // 입장 기록 없음 = 결석
    });

    const result = await service.getTeamContributions(USER_ID, TEAM_ID);
    const sy = result.members.find((m) => m.user_id === SY)!;
    expect(sy.attendance_avg).toBeCloseTo(0.85);
  });
});
