import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MeetingScoreRequest,
  MeetingScoreResponse,
  TeamContributionResponse,
  TeamPipelineRequest,
} from './contribution.types';
import {
  ExternalFullPipelineResponse,
  ExternalMemberMeetingData,
  ExternalTeamSettings,
  computeTeamAvgCompletedWeight,
  deriveMemberData,
  mapTeamSettings,
  toTaskActions,
} from './contribution.mapper';

// 외부 기여도 산정 서버(cc-team-8/Contribution, FastAPI) HTTP 클라이언트.
// 기존 calculate(server/src/contribution)와 동일한 /pipeline/score 단일 엔드포인트만 사용한다.
// pipeline 은 멤버 1명 단위(원시 데이터 → 누적·테스크·최종)라 멤버별 fan-out 후
// 기존 응답 계약으로 조립한다.
// CONTRIBUTION_SERVICE_URL 미설정 시 호출을 건너뛰고 null 을 반환해
// (개발/데모 환경에서) 회의 종료·조회 흐름이 끊기지 않도록 한다.
@Injectable()
export class ContributionClient {
  private readonly logger = new Logger(ContributionClient.name);

  constructor(private config: ConfigService) {}

  private get baseUrl(): string | undefined {
    return this.config.get<string>('CONTRIBUTION_SERVICE_URL');
  }

  get configured(): boolean {
    return !!this.baseUrl;
  }

  // ① 회의 기여도 — 참여자별 /pipeline/score(회의 1건) 호출.
  // pipeline 응답은 누적(②) 형태뿐이라 회의 1건의 누적 = 그 회의 점수로 읽는다.
  // 출석률은 보낸 파생값으로 로컬 보존하고, 외부 상세(신뢰도 등급 등)는 pipeline 미제공 → null.
  async computeMeetingScores(
    payload: MeetingScoreRequest,
  ): Promise<MeetingScoreResponse | null> {
    if (!this.baseUrl) {
      this.warnUnconfigured();
      return null;
    }
    this.logger.log(
      `[회의 산정] meeting_id=${payload.meeting.id} 참여자=${payload.participant_user_ids.length}명`,
    );
    const cfg = mapTeamSettings(payload.team_settings);
    // ① 표시용 punctuality_score 의 "지각" 기준을 실제 점수 산정에 쓰이는
    // late_threshold_sec(팀 설정의 지각 기준)과 일치시킨다. 과거엔 5분(300초)을
    // 하드코딩해서, 팀이 지각 기준을 다르게 설정해도 화면 표시는 항상 5분 기준으로
    // 나와 실제 점수와 어긋나는 문제가 있었다.
    const lateThresholdSec = cfg.late_threshold_sec ?? 300;
    const scores = await Promise.all(
      payload.participant_user_ids.map(async (uid) => {
        const excusedLate =
          payload.excused_late_user_ids?.includes(uid) ?? false;
        const { data, rawSpeechRatio } = deriveMemberData(
          payload,
          uid,
          excusedLate,
        );
        // 비정규 회의도 ① 점수는 산출해야 하므로 official 로 보낸다
        // (officialness 는 누적(②) 포함 여부에만 쓰이고, ②는 별도 호출에서 반영).
        const ext = await this.pipeline(
          [{ ...data, is_official: true }],
          false,
          cfg,
        );
        // attendance_ratio는 "참여 시간 비율"이 아니라 엔진이 계산한 attend_score
        // (출석비율 + 지각 페널티, 사유 지각 면제 포함)를 저장한다. actual_attend_sec은
        // 자발적 자리비움만 차감하고 지각 시간은 차감하지 않아, 그 값을 그대로 쓰면
        // 지각해도 "참석 100%"로 표시되는 문제가 있었다 — 화면(회의 상세·리포트)에
        // 노출되는 이름이 "참석/출석"이므로 실제로 지각이 반영된 값을 보여줘야 한다.
        const meetingScore = ext.meeting_scores[0];
        const attendanceRatio = data.absent
          ? 0
          : (meetingScore?.attend_score ?? null);
        return {
          user_id: uid,
          speech_ratio: rawSpeechRatio,
          speech_consistency: null,
          attendance_ratio: attendanceRatio,
          punctuality_score: data.absent
            ? null
            : data.late_sec > lateThresholdSec
              ? 0.0
              : 1.0,
          // 포함 0건(최소시간 미만 등) = 측정 불가 → null.
          // 무단 결석은 엔진이 0점으로 포함시키므로 0 이 저장된다.
          meeting_score:
            ext.meeting.included_count > 0 ? ext.meeting.score : null,
          confidence_level: null,
          excluded_indicators: null,
        };
      }),
    );
    return { scores };
  }

  // ②③④ — 멤버별 /pipeline/score 1회 (참여한 회의들의 원시 파생 데이터 + 액션 동봉)
  async computeTeamContributions(
    payload: TeamPipelineRequest,
  ): Promise<TeamContributionResponse | null> {
    if (!this.baseUrl) {
      this.warnUnconfigured();
      return null;
    }
    this.logger.log(
      `[팀 산정] team_id=${payload.team_id} 멤버=${payload.members.length}명 회의=${payload.meetings.length}건`,
    );
    const cfg = mapTeamSettings(payload.team_settings);
    const now = new Date();
    // 태스크 완료량(volume_score) 정규화 기준 — 멤버별 호출 전에 팀 전체를 한 번만 계산.
    // 멤버 1명씩 fan-out 되는 /pipeline/score 호출 안에서는 다른 멤버의 완료량을 알 수
    // 없으므로, 비교 기준값을 미리 구해서 매 호출에 동봉해야 한다.
    const teamAvgCompletedWeight = computeTeamAvgCompletedWeight(
      payload.action_items,
      payload.members.map((m) => m.user_id),
      now,
    );
    const members = await Promise.all(
      payload.members.map(async (m) => {
        const actions = toTaskActions(payload.action_items, m.user_id, now);
        // 참여한 회의 + 무단결석 회의를 누적 입력에 포함.
        // 무단결석(absent_user_ids)도 보내야 docs/06 대로 ① = 0 이 누적(②)에 반영된다.
        const rows: ExternalMemberMeetingData[] = payload.meetings
          .filter(
            (mt) =>
              mt.participant_user_ids.includes(m.user_id) ||
              mt.absent_user_ids.includes(m.user_id),
          )
          .map((mt) => {
            const excusedLate = mt.excused_late_user_ids.includes(m.user_id);
            const { data } = deriveMemberData(mt, m.user_id, excusedLate);
            // 무효 처리된 회의는 비정규로 보내 누적에서 제외시킨다
            return mt.is_invalidated ? { ...data, is_official: false } : data;
          });
        if (rows.length === 0 && actions.length === 0) {
          return {
            user_id: m.user_id,
            meeting_aggregate: null,
            task_score: null,
            composite_score: null,
          };
        }
        // pipeline 은 meetings 가 비면 거부 — 회의 0건인 멤버의 테스크 점수용 운반 행
        // (사유 결석 + 비정규라 누적(②)에서는 제외된다)
        if (rows.length === 0) rows.push(taskCarrierRow(m.user_id));
        rows[0] = { ...rows[0], actions };
        const ext = await this.pipeline(
          rows,
          m.role === 'leader',
          cfg,
          teamAvgCompletedWeight,
        );
        return {
          user_id: m.user_id,
          // 포함 회의 0건이면 엔진은 0.0 을 주지만 "측정 불가"는 null 로 구분 (로컬 스코어러와 동일)
          meeting_aggregate:
            ext.meeting.included_count > 0 ? ext.meeting.score : null,
          task_score: ext.task.score,
          // 측정 축이 하나도 없으면 weights_used 가 빈 객체 → 종합 점수 없음
          composite_score:
            Object.keys(ext.final.weights_used).length > 0
              ? ext.final.final
              : null,
        };
      }),
    );
    return { members };
  }

  private async pipeline(
    meetings: ExternalMemberMeetingData[],
    isLeader: boolean,
    cfg: ExternalTeamSettings,
    teamAvgCompletedWeight: number | null = null,
  ): Promise<ExternalFullPipelineResponse> {
    return this.post<ExternalFullPipelineResponse>('/pipeline/score', {
      meetings,
      is_leader: isLeader,
      cfg,
      team_avg_completed_weight: teamAvgCompletedWeight,
    });
  }

  private warnUnconfigured() {
    this.logger.warn(
      'CONTRIBUTION_SERVICE_URL 미설정 — 기여도 산정(/pipeline/score)을 건너뜁니다.',
    );
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const apiKey = this.config.get<string>('CONTRIBUTION_SERVICE_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const t0 = Date.now();
    this.logger.log(`→ POST ${this.baseUrl}${path}`);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'x-api-key': apiKey } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.logger.error(`← ${res.status} ${path} (${Date.now() - t0}ms)`);
        throw new ServiceUnavailableException('기여도 산정 서버 오류');
      }
      const data = (await res.json()) as T;
      this.logger.log(`← 200 OK ${path} (${Date.now() - t0}ms)`);
      return data;
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e;
      const err = e as Error & { cause?: Error & { code?: string } };
      const cause = err.cause
        ? ` | cause: ${err.cause.code ?? ''} ${err.cause.message ?? ''} ${String(err.cause)}`.trim()
        : '';
      this.logger.error(
        `← 연결 실패 ${path} (${Date.now() - t0}ms): ${err.message}${cause}`,
      );
      throw new ServiceUnavailableException(
        '기여도 산정 서버에 연결할 수 없습니다.',
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

// 회의 데이터 없이 액션만 보낼 때 쓰는 자리표시 행 — 엔진 누적 계산에서 제외되는 조합
function taskCarrierRow(userId: number): ExternalMemberMeetingData {
  return {
    name: String(userId),
    meeting_id: 'none',
    meeting_total_sec: 0,
    actual_attend_sec: 0,
    late_sec: 0,
    own_chars: 0,
    utterance_count: 0,
    total_chars_during: 0,
    team_size: 1,
    audio_loss_pct: 0,
    speech_confidence: 1,
    excused_absence: true,
    excused_late: false,
    absent: true,
    is_official: false,
  };
}
