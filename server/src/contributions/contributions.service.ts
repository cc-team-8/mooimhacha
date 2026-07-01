import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ContributionScore } from '../entities/contribution-score.entity';
import { Meeting } from '../entities/meeting.entity';
import { Agenda } from '../entities/agenda.entity';
import { Utterance } from '../entities/utterance.entity';
import { PresenceEvent } from '../entities/presence-event.entity';
import { AnomalyEvent } from '../entities/anomaly-event.entity';
import { ActionItem } from '../entities/action-item.entity';
import { TeamMembership } from '../entities/team-membership.entity';
import { MeetingAbsence } from '../entities/meeting-absence.entity';
import {
  ContributionVisibility,
  TeamSettings,
} from '../entities/team-settings.entity';
import { User } from '../entities/user.entity';
import { TeamsService } from '../teams/teams.service';
import { ContributionClient } from './contribution.client';
import { absentUnexcusedIds } from './contribution.mapper';
import { TeamPipelineRequest, TeamSettingsPayload } from './contribution.types';

@Injectable()
export class ContributionsService {
  constructor(
    @InjectRepository(ContributionScore)
    private scoreRepo: Repository<ContributionScore>,
    @InjectRepository(Meeting)
    private meetingRepo: Repository<Meeting>,
    @InjectRepository(Agenda)
    private agendaRepo: Repository<Agenda>,
    @InjectRepository(Utterance)
    private utteranceRepo: Repository<Utterance>,
    @InjectRepository(PresenceEvent)
    private presenceRepo: Repository<PresenceEvent>,
    @InjectRepository(AnomalyEvent)
    private anomalyRepo: Repository<AnomalyEvent>,
    @InjectRepository(ActionItem)
    private actionRepo: Repository<ActionItem>,
    @InjectRepository(TeamMembership)
    private membershipRepo: Repository<TeamMembership>,
    @InjectRepository(MeetingAbsence)
    private absenceRepo: Repository<MeetingAbsence>,
    @InjectRepository(TeamSettings)
    private settingsRepo: Repository<TeamSettings>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private teamsService: TeamsService,
    private client: ContributionClient,
  ) {}

  // 회의 종료 시 호출 — 외부 서버에서 트랙1(①) 계산 후 우리 DB에 저장
  async computeAndStoreMeetingScores(
    meetingId: number,
  ): Promise<ContributionScore[]> {
    const meeting = await this.meetingRepo.findOne({
      where: { id: meetingId },
    });
    if (!meeting) return [];

    const settings = await this.requireSettingsPayload(meeting.team_id);
    const [utterances, agendas, presence, anomalies, members] =
      await Promise.all([
        // 산정에 쓰는 컬럼만 로드 (text TEXT 컬럼 제외 — 응답 크기·메모리 절약)
        this.utteranceRepo.find({
          where: { meeting_id: meetingId },
          select: {
            user_id: true,
            char_count: true,
            agenda_id: true,
            confidence: true,
          },
        }),
        this.agendaRepo.find({ where: { meeting_id: meetingId } }),
        this.presenceRepo.find({ where: { meeting_id: meetingId } }),
        this.anomalyRepo.find({ where: { meeting_id: meetingId } }),
        this.membershipRepo.find({ where: { team_id: meeting.team_id } }),
      ]);

    const participantIds = members.map((m) => m.user_id);

    const payload = {
      meeting: {
        id: meeting.id,
        total_minutes: meeting.total_minutes,
        scheduled_at: meeting.scheduled_at.toISOString(),
        t0_timestamp: meeting.t0_timestamp?.toISOString() ?? null,
        ended_at: meeting.ended_at?.toISOString() ?? null,
        meeting_type: meeting.meeting_type,
      },
      team_settings: settings,
      participant_user_ids: participantIds,
      utterances: utterances.map((u) => ({
        user_id: u.user_id,
        char_count: u.char_count,
        agenda_id: u.agenda_id,
        confidence: u.confidence,
      })),
      agendas: agendas.map((a) => ({ id: a.id, status: a.status })),
      presence_events: presence.map((p) => ({
        user_id: p.user_id,
        event_type: p.event_type,
        disconnect_classification: p.disconnect_classification,
        timestamp_offset_ms: p.timestamp_offset_ms,
      })),
      anomaly_events: anomalies.map((a) => ({
        user_id: a.user_id,
        event_type: a.event_type,
        timestamp_offset_ms: a.timestamp_offset_ms,
      })),
    };

    // 외부 산정 엔진(cc-team-8/Contribution)에 위임 — CONTRIBUTION_SERVICE_URL 필수
    const response = await this.client.computeMeetingScores(payload);

    if (!response) return []; // 엔진 미설정·무응답 — 저장 건너뜀

    const saved: ContributionScore[] = [];
    for (const r of response.scores) {
      const existing = await this.scoreRepo.findOne({
        where: { user_id: r.user_id, meeting_id: meetingId },
      });
      const row =
        existing ??
        this.scoreRepo.create({ user_id: r.user_id, meeting_id: meetingId });
      row.speech_ratio = r.speech_ratio;
      row.speech_consistency = r.speech_consistency;
      row.attendance_ratio = r.attendance_ratio;
      row.punctuality_score = r.punctuality_score;
      row.meeting_score = r.meeting_score;
      row.confidence_level = r.confidence_level;
      row.excluded_indicators = r.excluded_indicators;
      saved.push(await this.scoreRepo.save(row));
    }
    return saved;
  }

  // ① 회의 기여도 — 저장값 조회 (참여자별)
  async getMeetingContributions(userId: number, meetingId: number) {
    const meeting = await this.meetingRepo.findOne({
      where: { id: meetingId },
    });
    if (!meeting) return { meeting_id: meetingId, scores: [] };
    const membership = await this.teamsService.requireMembership(
      userId,
      meeting.team_id,
    );

    const allScores = await this.scoreRepo.find({
      where: { meeting_id: meetingId },
    });
    // 공개범위: '전체 공개(team)'가 아니면 타인 상세는 가리고 본인 행만 반환
    const scores = (await this.canViewAll(meeting.team_id, membership.role))
      ? allScores
      : allScores.filter((s) => s.user_id === userId);
    const names = await this.userNames(scores.map((s) => s.user_id));
    return {
      meeting_id: meetingId,
      scores: scores.map((s) => ({
        user_id: s.user_id,
        name: names.get(s.user_id) ?? '알 수 없음',
        speech_ratio: s.speech_ratio,
        speech_consistency: s.speech_consistency,
        attendance_ratio: s.attendance_ratio,
        punctuality_score: s.punctuality_score,
        meeting_score: s.meeting_score,
        confidence_level: s.confidence_level,
        excluded_indicators: s.excluded_indicators,
      })),
    };
  }

  // ②③④ 회의 종합·테스크·종합 기여도 — 외부 서버 동적 계산
  async getTeamContributions(userId: number, teamId: number) {
    const myMembership = await this.teamsService.requireMembership(
      userId,
      teamId,
    );
    const settings = await this.requireSettingsPayload(teamId);
    // withDeleted: 탈퇴/강퇴(soft delete)한 과거 참여자도 포함해 조회
    const memberships = await this.membershipRepo.find({
      where: { team_id: teamId },
      withDeleted: true,
    });

    // 저장된 ① + 회의 메타
    const meetings = await this.meetingRepo.find({
      where: { team_id: teamId },
    });
    const meetingById = new Map(meetings.map((m) => [m.id, m]));
    const scores =
      meetings.length > 0
        ? await this.scoreRepo.find({
            where: { meeting_id: In(meetings.map((m) => m.id)) },
          })
        : [];
    const actions = await this.actionRepo.find({ where: { team_id: teamId } });

    // 표시 대상: 현재 멤버 ∪ 점수가 남아 있는 과거 참여자 — 탈퇴 후에도 과거 회의 기여도 유지
    const scoredIds = new Set(scores.map((s) => s.user_id));
    const members = memberships.filter(
      (m) => !m.deleted_at || scoredIds.has(m.user_id),
    );
    const memberIds = [...new Set(members.map((m) => m.user_id))];

    const teamPayload = {
      team_id: teamId,
      team_settings: settings,
      members: members.map((m) => ({ user_id: m.user_id, role: m.role })),
      meeting_scores: scores.map((s) => {
        const m = meetingById.get(s.meeting_id);
        return {
          user_id: s.user_id,
          meeting_id: s.meeting_id,
          meeting_score: s.meeting_score,
          total_minutes: m?.total_minutes ?? 0,
          actual_minutes: this.actualMinutes(m),
          meeting_type: m?.meeting_type ?? 'regular',
          is_invalidated: m?.is_invalidated ?? false,
        };
      }),
      action_items: actions.map((a) => ({
        assignee_id: a.assignee_id,
        status: a.status,
        difficulty: a.difficulty,
        due_date: a.due_date?.toISOString() ?? null,
        completed_at: a.completed_at?.toISOString() ?? null,
        confirmed: a.confirmed,
      })),
    };

    // 외부 산정 엔진의 /pipeline/score 에 위임 — pipeline 은 저장된 ① 점수를 받지 못하므로
    // 회의별 원시 이벤트를 다시 모아 보낸다. (CONTRIBUTION_SERVICE_URL 필수)
    const response = await this.client.computeTeamContributions(
      await this.buildPipelinePayload(
        teamId,
        settings,
        teamPayload,
        meetings,
        memberships.filter((m) => !m.deleted_at).map((m) => m.user_id),
        memberships,
      ),
    );

    const names = await this.userNames(memberIds);
    const roleById = new Map(members.map((m) => [m.user_id, m.role]));
    const resultById = new Map(
      (response?.members ?? []).map((r) => [r.user_id, r]),
    );
    // 승인된 사유 중 "결석"만 추려서 composite_score(②)와 동일한 규칙으로
    // "출석" 표시(attendance_avg)에서도 해당 회의를 평균 계산 자체에서 뺀다.
    // meeting_absences 테이블엔 결석/지각 구분 필드가 없어, presence_events에
    // 입장(join/reconnect) 기록이 있는지로 구분한다 — 입장 기록이 없으면 결석,
    // 있으면 늦게라도 참석한 지각이다.
    // ⚠ 사유 지각 승인은 여기서 제외하면 안 된다: 사유 지각은 "지각 페널티만
    // 면제"이고 출석 자체는 했으므로, 그 회의의 attend_score(이미 페널티가
    // 면제된 값)가 평균에 그대로 들어가야 한다. 결석과 지각을 구분 안 하고
    // 둘 다 빼면, 지각해서 참석한 회의까지 사라져 출석 평균이 실제보다
    // 부풀려진다(데이터 1건이 통째로 빠지면서 남은 값들의 영향력이 커짐).
    let approvedAbsenceKeys = new Set<string>();
    if (meetings.length > 0) {
      const meetingIds = meetings.map((m) => m.id);
      const [approvedAbsences, allPresence] = await Promise.all([
        this.absenceRepo.find({
          where: { meeting_id: In(meetingIds), status: 'approved' },
          select: { meeting_id: true, user_id: true },
        }),
        this.presenceRepo.find({
          where: { meeting_id: In(meetingIds) },
          select: { meeting_id: true, user_id: true, event_type: true },
        }),
      ]);
      const joinedKeys = new Set(
        allPresence
          .filter(
            (p) => p.event_type === 'join' || p.event_type === 'reconnect',
          )
          .map((p) => `${p.meeting_id}:${p.user_id}`),
      );
      approvedAbsenceKeys = new Set(
        approvedAbsences
          .filter((a) => !joinedKeys.has(`${a.meeting_id}:${a.user_id}`))
          .map((a) => `${a.meeting_id}:${a.user_id}`),
      );
    }
    // 레이더(출석·참여도 축) 표시용 — 누적 집계와 같은 제외 규칙
    // (무효 처리·비정규 회의·승인된 사유결석 제외)으로 저장된 ① 비율을 평균한다.
    const ratiosById = new Map<number, { att: number[]; sp: number[] }>();
    for (const s of scores) {
      const m = meetingById.get(s.meeting_id);
      if (!m || m.is_invalidated || m.meeting_type !== 'regular') continue;
      if (approvedAbsenceKeys.has(`${s.meeting_id}:${s.user_id}`)) continue;
      const slot = ratiosById.get(s.user_id) ?? { att: [], sp: [] };
      if (s.attendance_ratio != null) slot.att.push(Number(s.attendance_ratio));
      if (s.speech_ratio != null) slot.sp.push(Number(s.speech_ratio));
      ratiosById.set(s.user_id, slot);
    }
    const avgOf = (arr: number[]) =>
      arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    // 공개범위: '전체 공개(team)'가 아니면 명단은 유지하되 타인 점수 상세는 가린다
    const canViewAll = await this.canViewAll(teamId, myMembership.role);
    return {
      team_id: teamId,
      computed: !!response,
      // 클라이언트가 '비공개 마스킹'과 '미산정'을 구분해 안내할 수 있게 노출
      visibility_restricted: !canViewAll,
      members: memberIds.map((uid) => {
        const masked = !(canViewAll || uid === userId);
        const r = masked ? undefined : resultById.get(uid);
        return {
          user_id: uid,
          name: names.get(uid) ?? '알 수 없음',
          role: roleById.get(uid),
          meeting_aggregate: r?.meeting_aggregate ?? null,
          task_score: r?.task_score ?? null,
          composite_score: r?.composite_score ?? null,
          attendance_avg: masked ? null : avgOf(ratiosById.get(uid)?.att ?? []),
          speech_avg: masked ? null : avgOf(ratiosById.get(uid)?.sp ?? []),
        };
      }),
    };
  }

  // 외부 /pipeline/score 입력 — 팀 전체 회의의 원시 이벤트를 회의별로 묶어 구성한다.
  // 외부 미설정 환경에서는 호출되지 않으므로 원시 로딩 비용은 외부 경로에서만 든다.
  private async buildPipelinePayload(
    teamId: number,
    settings: TeamSettingsPayload,
    teamPayload: {
      members: TeamPipelineRequest['members'];
      action_items: TeamPipelineRequest['action_items'];
    },
    meetings: Meeting[],
    currentMemberIds: number[],
    memberships: TeamMembership[],
  ): Promise<TeamPipelineRequest> {
    const ids = meetings.map((m) => m.id);
    const [utterances, presence, anomalies] =
      ids.length > 0
        ? await Promise.all([
            // ① 산정 때와 동일하게 text 컬럼은 제외하고 로드
            this.utteranceRepo.find({
              where: { meeting_id: In(ids) },
              select: {
                meeting_id: true,
                user_id: true,
                char_count: true,
                agenda_id: true,
                confidence: true,
              },
            }),
            this.presenceRepo.find({ where: { meeting_id: In(ids) } }),
            this.anomalyRepo.find({ where: { meeting_id: In(ids) } }),
          ])
        : [[], [], []];
    // 승인된 사유결석 — 무단결석 판정서 제외(보호)하기 위해 로드
    const approvedAbsences =
      ids.length > 0
        ? await this.absenceRepo.find({
            where: { meeting_id: In(ids), status: 'approved' },
            select: { meeting_id: true, user_id: true },
          })
        : [];
    const activeMemberships = memberships.map((mb) => ({
      user_id: mb.user_id,
      joinedAtMs: mb.joined_at.getTime(),
      deletedAtMs: mb.deleted_at ? mb.deleted_at.getTime() : null,
    }));

    const groupByMeeting = <T extends { meeting_id: number }>(rows: T[]) => {
      const map = new Map<number, T[]>();
      for (const r of rows) {
        const slot = map.get(r.meeting_id) ?? [];
        slot.push(r);
        map.set(r.meeting_id, slot);
      }
      return map;
    };
    const uttByMeeting = groupByMeeting(utterances);
    const presByMeeting = groupByMeeting(presence);
    const anomByMeeting = groupByMeeting(anomalies);
    const excusedByMeeting = groupByMeeting(approvedAbsences);

    return {
      team_id: teamId,
      team_settings: settings,
      members: teamPayload.members,
      action_items: teamPayload.action_items,
      meetings: meetings.map((m) => {
        const pres = presByMeeting.get(m.id) ?? [];
        // 참석자 규칙은 ① 저장 때와 동일: join 기록자, 없으면 현재 팀 멤버 전원
        const joined = new Set(
          pres.filter((p) => p.event_type === 'join').map((p) => p.user_id),
        );
        // 무단결석(입장 X·승인 사유결석 아님) — 누적(②)에 0점으로 포함시킬 멤버
        const excusedIds = new Set(
          (excusedByMeeting.get(m.id) ?? []).map((a) => a.user_id),
        );
        const absent_user_ids = absentUnexcusedIds({
          meetingType: m.meeting_type,
          isInvalidated: m.is_invalidated,
          meetingAtMs: m.scheduled_at.getTime(),
          joinedIds: joined,
          excusedIds,
          activeMemberships,
        });
        // 사유 지각(승인됨 + 실제 입장함=joined) — 입장 자체를 안 한 사람은
        // absentUnexcusedIds() 가 따로 보호하므로 여기서는 "늦게라도 들어온" 케이스만 해당.
        const excused_late_user_ids = [...excusedIds].filter((uid) =>
          joined.has(uid),
        );
        return {
          meeting: {
            id: m.id,
            total_minutes: m.total_minutes,
            scheduled_at: m.scheduled_at.toISOString(),
            t0_timestamp: m.t0_timestamp?.toISOString() ?? null,
            ended_at: m.ended_at?.toISOString() ?? null,
            meeting_type: m.meeting_type,
          },
          is_invalidated: m.is_invalidated,
          team_settings: settings,
          participant_user_ids:
            joined.size > 0 ? [...joined] : currentMemberIds,
          absent_user_ids,
          excused_late_user_ids,
          utterances: (uttByMeeting.get(m.id) ?? []).map((u) => ({
            user_id: u.user_id,
            char_count: u.char_count,
            agenda_id: u.agenda_id,
            confidence: u.confidence,
          })),
          presence_events: pres.map((p) => ({
            user_id: p.user_id,
            event_type: p.event_type,
            disconnect_classification: p.disconnect_classification,
            timestamp_offset_ms: p.timestamp_offset_ms,
          })),
          anomaly_events: (anomByMeeting.get(m.id) ?? []).map((a) => ({
            user_id: a.user_id,
            event_type: a.event_type,
            timestamp_offset_ms: a.timestamp_offset_ms,
          })),
        };
      }),
    };
  }

  // 실측 진행시간(분) — ended_at·t0 둘 다 있으면 실측, 아니면 예상(total_minutes) 폴백
  private actualMinutes(m?: Meeting): number {
    if (m?.t0_timestamp && m.ended_at) {
      const ms = m.ended_at.getTime() - m.t0_timestamp.getTime();
      if (ms > 0) return ms / 60000;
    }
    return m?.total_minutes ?? 0;
  }

  // 기여도 공개범위 — 'team'(전체 공개)이거나 'leader' 설정에서 요청자가 팀장이면 전체 열람
  // (requireSettingsPayload는 산정 서버로 그대로 전달되는 계약이라 별도 조회로 처리)
  private async canViewAll(teamId: number, role: string): Promise<boolean> {
    const s = await this.settingsRepo.findOne({ where: { team_id: teamId } });
    const visibility: ContributionVisibility =
      s?.contribution_visibility ?? 'team';
    if (visibility === 'team') return true;
    return visibility === 'leader' && role === 'leader';
  }

  private async requireSettingsPayload(
    teamId: number,
  ): Promise<TeamSettingsPayload> {
    const s = await this.settingsRepo.findOne({ where: { team_id: teamId } });
    // 설정이 없으면 문서 06 기본값으로 구성
    return {
      punctuality_grace_ratio: s?.punctuality_grace_ratio ?? 0.1,
      presence_grace_seconds: s?.presence_grace_seconds ?? 30,
      max_utterance_chars: s?.max_utterance_chars ?? 500,
      deadline_penalty_curve: s?.deadline_penalty_curve ?? 'standard',
      absent_meeting_handling: s?.absent_meeting_handling ?? 'exclude',
      min_meeting_minutes: s?.min_meeting_minutes ?? 5,
      final_task_weight: s?.final_task_weight ?? 0.5,
      weight_speech_in_meeting: s?.weight_speech_in_meeting ?? 0.6,
      weight_attend_in_meeting: s?.weight_attend_in_meeting ?? 0.4,
      leader_bonus_multiplier: s?.leader_bonus_multiplier ?? 1.0,
      late_threshold_minutes: s?.late_threshold_minutes ?? 5,
      late_max_minutes: s?.late_max_minutes ?? 0,
    };
  }

  private async userNames(ids: number[]): Promise<Map<number, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.userRepo.find({ where: { id: In(ids) } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
