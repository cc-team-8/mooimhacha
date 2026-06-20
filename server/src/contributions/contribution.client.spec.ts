import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContributionClient } from './contribution.client';
import {
  ExternalMemberMeetingData,
  ExternalTeamSettings,
} from './contribution.mapper';
import {
  MeetingScoreRequest,
  TeamPipelineRequest,
  TeamSettingsPayload,
} from './contribution.types';

// fetch mock 의 요청 본문(JSON.parse 결과) 타이핑용
type PipelineBody = {
  meetings: ExternalMemberMeetingData[];
  is_leader: boolean;
  cfg: ExternalTeamSettings;
};

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

const MEETING_REQ: MeetingScoreRequest = {
  meeting: {
    id: 7,
    total_minutes: 60,
    scheduled_at: '2026-06-01T00:00:00.000Z',
    t0_timestamp: '2026-06-01T00:00:00.000Z',
    ended_at: '2026-06-01T01:00:00.000Z',
    meeting_type: 'regular',
  },
  team_settings: SETTINGS,
  participant_user_ids: [1, 2],
  utterances: [
    { user_id: 1, char_count: 300, agenda_id: 10, confidence: 0.9 },
    { user_id: 2, char_count: 100, agenda_id: 10, confidence: 0.9 },
  ],
  agendas: [{ id: 10, status: 'done' }],
  presence_events: [
    {
      user_id: 1,
      event_type: 'join',
      disconnect_classification: null,
      timestamp_offset_ms: 0,
    },
    {
      user_id: 2,
      event_type: 'join',
      disconnect_classification: null,
      timestamp_offset_ms: 0,
    },
  ],
  anomaly_events: [],
};

// ②③④ 입력 — 회의별 원시 이벤트 (agendas 없음)
const RAW_MEETING: TeamPipelineRequest['meetings'][number] = {
  meeting: MEETING_REQ.meeting,
  is_invalidated: false,
  team_settings: SETTINGS,
  participant_user_ids: [1, 2],
  utterances: MEETING_REQ.utterances,
  presence_events: MEETING_REQ.presence_events,
  anomaly_events: [],
};

const TEAM_REQ: TeamPipelineRequest = {
  team_id: 1,
  team_settings: SETTINGS,
  members: [{ user_id: 1, role: 'leader' }],
  meetings: [RAW_MEETING],
  action_items: [
    {
      assignee_id: 1,
      status: 'done',
      difficulty: 2,
      due_date: '2026-06-01T00:00:00.000Z',
      completed_at: '2026-06-01T00:00:00.000Z',
      confirmed: true,
    },
  ],
};

function makeClient(url?: string): ContributionClient {
  const config = {
    get: (key: string) =>
      (
        ({ CONTRIBUTION_SERVICE_URL: url }) as Record<
          string,
          string | undefined
        >
      )[key],
  } as unknown as ConfigService;
  return new ContributionClient(config);
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

// /pipeline/score 응답 — meeting 은 보낸 회의들의 누적 결과
const pipelineResponse = (
  over: {
    meeting?: Partial<{
      score: number;
      meeting_count: number;
      included_count: number;
      excluded_count: number;
    }>;
    task?: Partial<{
      score: number | null;
      total_actions: number;
      completed_actions: number;
    }>;
    final?: Partial<{
      final: number;
      weights_used: Record<string, number>;
    }>;
  } = {},
) => ({
  name: '1',
  meeting: {
    name: '1',
    score: 0.8,
    meeting_count: 1,
    included_count: 1,
    excluded_count: 0,
    ...over.meeting,
  },
  task: {
    name: '1',
    score: 1.0,
    total_actions: 1,
    completed_actions: 1,
    ...over.task,
  },
  final: {
    name: '1',
    meeting_score: 0.8,
    task_score: 1.0,
    final: 0.9,
    weights_used: { meeting: 0.5, task: 0.5 },
    leader_applied: false,
    ...over.final,
  },
});

function mockPipeline(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch').mockResolvedValue(jsonResponse(body));
}

function callBody(fetchMock: jest.SpyInstance, n: number): PipelineBody {
  const [, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return JSON.parse(init.body as string) as PipelineBody;
}

describe('ContributionClient — 외부 기여도 API(/pipeline/score) 연동', () => {
  let fetchMock: jest.SpyInstance;

  afterEach(() => fetchMock?.mockRestore());

  it('URL 미설정 시 호출 없이 null 반환', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const client = makeClient(undefined);
    expect(client.configured).toBe(false);
    expect(await client.computeMeetingScores(MEETING_REQ)).toBeNull();
    expect(await client.computeTeamContributions(TEAM_REQ)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('① 참여자별 /pipeline/score(회의 1건) 호출 후 우리 응답 형태로 조립', async () => {
    fetchMock = mockPipeline(pipelineResponse({ meeting: { score: 0.94 } }));
    const client = makeClient('http://contrib.test');

    const res = await client.computeMeetingScores(MEETING_REQ);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://contrib.test/pipeline/score',
      expect.objectContaining({ method: 'POST' }),
    );
    // 요청 본문: 회의 1건의 파생 지표 + 0.6/0.4 가중치 설정
    const body = callBody(fetchMock, 0);
    expect(body.cfg.weight_speech_in_meeting).toBe(0.6);
    expect(body.is_leader).toBe(false);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0].meeting_total_sec).toBe(3600);

    expect(res!.scores).toHaveLength(2);
    const u1 = res!.scores.find((s) => s.user_id === 1)!;
    expect(u1.meeting_score).toBe(0.94); // 회의 1건 누적 = 그 회의 점수
    expect(u1.attendance_ratio).toBe(1.0); // 로컬 파생 (attend/total)
    expect(u1.confidence_level).toBeNull(); // pipeline 미제공
    expect(u1.speech_ratio).toBeCloseTo(0.75); // 300/400 원시 비율
  });

  it('①: 비정규 회의도 점수 산출을 위해 is_official=true 로 보낸다', async () => {
    fetchMock = mockPipeline(pipelineResponse());
    const client = makeClient('http://contrib.test');

    await client.computeMeetingScores({
      ...MEETING_REQ,
      meeting: { ...MEETING_REQ.meeting, meeting_type: 'adhoc' },
    });

    expect(callBody(fetchMock, 0).meetings[0].is_official).toBe(true);
  });

  it('①: included_count=0(최소시간 미만 등 측정 불가) → meeting_score null', async () => {
    fetchMock = mockPipeline(
      pipelineResponse({ meeting: { score: 0, included_count: 0 } }),
    );
    const client = makeClient('http://contrib.test');

    const res = await client.computeMeetingScores(MEETING_REQ);

    expect(res!.scores[0].meeting_score).toBeNull();
  });

  it('②③④ 멤버별 /pipeline/score 1회 — 원시 회의 행 + 액션 동봉, is_leader 전달', async () => {
    fetchMock = mockPipeline(pipelineResponse());
    const client = makeClient('http://contrib.test');

    const res = await client.computeTeamContributions(TEAM_REQ);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = callBody(fetchMock, 0);
    expect(body.is_leader).toBe(true);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0].actions).toHaveLength(1); // 액션은 첫 행에 동봉
    expect(res!.members).toEqual([
      {
        user_id: 1,
        meeting_aggregate: 0.8,
        task_score: 1.0,
        composite_score: 0.9,
      },
    ]);
  });

  it('②: 참여하지 않은 회의는 입력에서 제외, 무효 회의는 is_official=false 로 전송', async () => {
    fetchMock = mockPipeline(pipelineResponse());
    const client = makeClient('http://contrib.test');

    await client.computeTeamContributions({
      ...TEAM_REQ,
      meetings: [
        { ...RAW_MEETING, is_invalidated: true },
        {
          ...RAW_MEETING,
          meeting: { ...RAW_MEETING.meeting, id: 8 },
          participant_user_ids: [2], // user 1 미참여
        },
      ],
    });

    const body = callBody(fetchMock, 0);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0].is_official).toBe(false);
  });

  it('②: 회의 0건 + 액션 있음 → 누적 제외 운반 행으로 테스크만 산출', async () => {
    fetchMock = mockPipeline(
      pipelineResponse({
        meeting: { score: 0, meeting_count: 1, included_count: 0 },
        final: { weights_used: { task: 1 } },
      }),
    );
    const client = makeClient('http://contrib.test');

    const res = await client.computeTeamContributions({
      ...TEAM_REQ,
      meetings: [],
    });

    const body = callBody(fetchMock, 0);
    expect(body.meetings).toHaveLength(1);
    expect(body.meetings[0]).toMatchObject({
      absent: true,
      excused_absence: true,
      is_official: false,
    });
    expect(body.meetings[0].actions).toHaveLength(1);
    expect(res!.members[0].meeting_aggregate).toBeNull();
    expect(res!.members[0].task_score).toBe(1.0);
  });

  it('②: 회의 0건 + 액션 0건 → 호출 없이 전부 null', async () => {
    fetchMock = jest.spyOn(global, 'fetch');
    const client = makeClient('http://contrib.test');

    const res = await client.computeTeamContributions({
      ...TEAM_REQ,
      meetings: [],
      action_items: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res!.members[0]).toEqual({
      user_id: 1,
      meeting_aggregate: null,
      task_score: null,
      composite_score: null,
    });
  });

  it('②: included_count=0 → meeting_aggregate null, weights_used 빈 객체 → composite null', async () => {
    fetchMock = mockPipeline(
      pipelineResponse({
        meeting: { score: 0, included_count: 0 },
        task: { score: null, total_actions: 0, completed_actions: 0 },
        final: { final: 0, weights_used: {} },
      }),
    );
    const client = makeClient('http://contrib.test');

    const res = await client.computeTeamContributions(TEAM_REQ);

    expect(res!.members[0]).toEqual({
      user_id: 1,
      meeting_aggregate: null,
      task_score: null,
      composite_score: null,
    });
  });

  it('외부 서버 오류 응답 → ServiceUnavailableException', async () => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 500 } as Response);
    const client = makeClient('http://contrib.test');

    await expect(client.computeMeetingScores(MEETING_REQ)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('네트워크 실패 → ServiceUnavailableException', async () => {
    fetchMock = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient('http://contrib.test');

    await expect(client.computeTeamContributions(TEAM_REQ)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
