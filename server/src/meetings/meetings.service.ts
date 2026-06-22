import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { Meeting } from '../entities/meeting.entity';
import { Team } from '../entities/team.entity';
import { Agenda } from '../entities/agenda.entity';
import { Utterance } from '../entities/utterance.entity';
import { Decision } from '../entities/decision.entity';
import { ActionItem } from '../entities/action-item.entity';
import { PresenceEvent } from '../entities/presence-event.entity';
import { AnomalyEvent } from '../entities/anomaly-event.entity';
import { ContributionScore } from '../entities/contribution-score.entity';
import { TeamMembership } from '../entities/team-membership.entity';
import { TeamSettings } from '../entities/team-settings.entity';
import { TeamsService } from '../teams/teams.service';
import { ContributionsService } from '../contributions/contributions.service';
import { LlmService, LLM_INPUT_CHAR_LIMIT } from '../llm/llm.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SlackService } from '../slack/slack.service';
import { MeetingEvents } from '../events/meeting-events';
import { CreateMeetingDto } from './dto/create-meeting.dto';
import { UpdateMeetingDto } from './dto/update-meeting.dto';
import { UpdateUtteranceDto } from './dto/update-utterance.dto';
import { BatchUpdateUtterancesDto } from './dto/batch-update-utterances.dto';

// 회의록 그루핑: 5초 이내 연속 발화는 하나로 묶음 (docs/02·09)
const GROUPING_GAP_MS = 5000;
// 짧은 발화 들여쓰기 기준
const SHORT_UTTERANCE_CHARS = 10;
// 발화 정정 시 텍스트 상한 (초과 시 거부 — 무음 절단은 회의록 원문 유실로 이어짐)
const MAX_UTTERANCE_TEXT_CHARS = 2000;

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    @InjectRepository(Meeting)
    private meetingRepo: Repository<Meeting>,
    @InjectRepository(Agenda)
    private agendaRepo: Repository<Agenda>,
    @InjectRepository(Utterance)
    private utteranceRepo: Repository<Utterance>,
    @InjectRepository(Decision)
    private decisionRepo: Repository<Decision>,
    @InjectRepository(ActionItem)
    private actionRepo: Repository<ActionItem>,
    @InjectRepository(TeamMembership)
    private membershipRepo: Repository<TeamMembership>,
    @InjectRepository(PresenceEvent)
    private presenceRepo: Repository<PresenceEvent>,
    @InjectRepository(TeamSettings)
    private settingsRepo: Repository<TeamSettings>,
    private teamsService: TeamsService,
    private contributionsService: ContributionsService,
    private llmService: LlmService,
    private notificationsService: NotificationsService,
    private slackService: SlackService,
    private meetingEvents: MeetingEvents,
    private dataSource: DataSource,
    private config: ConfigService,
  ) {}

  async create(userId: number, dto: CreateMeetingDto) {
    await this.teamsService.requireMembership(userId, dto.team_id);
    const meeting = this.meetingRepo.create({
      team_id: dto.team_id,
      scheduled_at: new Date(dto.scheduled_at),
      total_minutes: dto.total_minutes,
      topic: dto.topic ?? null,
      meeting_type: dto.meeting_type ?? 'regular',
      status: 'scheduled',
    });
    return this.meetingRepo.save(meeting);
  }

  async list(userId: number, teamId?: number) {
    let teamIds: number[];
    if (teamId) {
      await this.teamsService.requireMembership(userId, teamId);
      teamIds = [teamId];
    } else {
      const memberships = await this.membershipRepo.find({
        where: { user_id: userId },
      });
      teamIds = memberships.map((m) => m.team_id);
    }
    if (teamIds.length === 0) return [];
    return this.meetingRepo.find({
      where: { team_id: In(teamIds) },
      order: { scheduled_at: 'DESC' },
    });
  }

  async get(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    return meeting;
  }

  async update(userId: number, id: number, dto: UpdateMeetingDto) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);

    if (dto.scheduled_at !== undefined)
      meeting.scheduled_at = new Date(dto.scheduled_at);
    if (dto.total_minutes !== undefined)
      meeting.total_minutes = dto.total_minutes;
    if (dto.topic !== undefined) meeting.topic = dto.topic;
    if (dto.meeting_type !== undefined) meeting.meeting_type = dto.meeting_type;

    // 무효 처리는 팀장만
    if (dto.is_invalidated !== undefined) {
      await this.teamsService.requireLeader(userId, meeting.team_id);
      meeting.is_invalidated = dto.is_invalidated;
    }
    return this.meetingRepo.save(meeting);
  }

  // FK/cascade가 없는 스키마라 자식 레코드(발화 원문 포함)를 서비스 레벨에서 일괄 정리
  async remove(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireLeader(userId, meeting.team_id);
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Agenda, { meeting_id: id });
      await manager.delete(Utterance, { meeting_id: id });
      await manager.delete(Decision, { meeting_id: id });
      await manager.delete(PresenceEvent, { meeting_id: id });
      await manager.delete(AnomalyEvent, { meeting_id: id });
      await manager.delete(ContributionScore, { meeting_id: id });
      await manager.delete(ActionItem, { meeting_id: id });
      await manager.delete(Meeting, { id });
    });
    return { deleted: true };
  }

  // T0 발행 — 시각 동기화 기준점
  async start(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (meeting.status === 'ended') {
      throw new BadRequestException('이미 종료된 회의입니다.');
    }
    if (!meeting.t0_timestamp) {
      meeting.t0_timestamp = new Date();
    }
    meeting.status = 'active';
    await this.meetingRepo.save(meeting);
    // 이미 입장해 있는 클라이언트 전원에게 T0 broadcast (게이트웨이가 룸으로 중계)
    this.meetingEvents.emitT0({
      meeting_id: meeting.id,
      t0_timestamp: meeting.t0_timestamp,
      status: meeting.status,
    });
    void this.notifyMeetingStarted(meeting);
    return {
      meeting_id: meeting.id,
      t0_timestamp: meeting.t0_timestamp,
      status: meeting.status,
    };
  }

  private async notifyMeetingStarted(meeting: Meeting): Promise<void> {
    const [settings, team] = await Promise.all([
      this.settingsRepo.findOne({ where: { team_id: meeting.team_id } }),
      this.dataSource
        .getRepository(Team)
        .findOne({ where: { id: meeting.team_id } }),
    ]);
    if (!settings?.slack_bot_token || !settings.slack_channel_id) return;
    const clientUrl = this.config.get<string>('CLIENT_URL') ?? '';
    const meetingUrl = `${clientUrl}/dashboard/${meeting.team_id}/meeting`;
    await this.slackService.sendChannelMessage(
      settings.slack_bot_token,
      settings.slack_channel_id,
      [
        `🚀 *회의 시작* — ${team?.name ?? '팀'}`,
        `> *${meeting.topic ?? '회의'}*`,
        `> 지금 바로 참여해주세요!`,
        `<${meetingUrl}|출결 현황 보기 →>`,
      ].join('\n'),
    );
  }

  private async notifyMeetingEnded(meeting: Meeting): Promise<void> {
    const [settings, team, decisions, actions] = await Promise.all([
      this.settingsRepo.findOne({ where: { team_id: meeting.team_id } }),
      this.dataSource
        .getRepository(Team)
        .findOne({ where: { id: meeting.team_id } }),
      this.decisionRepo.find({ where: { meeting_id: meeting.id } }),
      this.actionRepo.find({ where: { meeting_id: meeting.id } }),
    ]);
    if (!settings?.slack_bot_token || !settings.slack_channel_id) return;

    const lines: string[] = [
      `🏁 *회의 종료* — ${team?.name ?? '팀'}`,
      `> *${meeting.topic ?? '회의'}*`,
    ];

    if (decisions.length > 0) {
      lines.push(`\n📋 *결정 사항* (${decisions.length}개)`);
      decisions.forEach((d) => lines.push(`> • ${d.content}`));
    }

    if (actions.length > 0) {
      lines.push(`\n✅ *액션 아이템* (${actions.length}개)`);
      actions.forEach((a) => {
        const due = a.due_date
          ? ` — ${new Date(a.due_date).toLocaleDateString('ko-KR')}`
          : '';
        lines.push(`> • ${a.description}${due}`);
      });
    }

    await this.slackService.sendChannelMessage(
      settings.slack_bot_token,
      settings.slack_channel_id,
      lines.join('\n'),
    );
  }

  // 회의 종료 — 안건 마감 처리 + 기여도(트랙1) 산정·저장 트리거
  async end(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);

    // 동시 종료 경쟁 방지 — 원자적 조건부 UPDATE로 한 요청만 통과시킨다.
    // scheduled(시작 전) 회의도 종료 가능해야 하므로 active만 걸지 않는다 —
    // affected=0은 곧 이미 ended 상태라는 뜻이라 에러 메시지도 정확하다.
    const endedAt = new Date();
    const updated = await this.meetingRepo.update(
      { id, status: In(['active', 'scheduled']) },
      { status: 'ended', ended_at: endedAt },
    );
    if (!updated.affected) {
      throw new BadRequestException('이미 종료된 회의입니다.');
    }

    // 종료 전파 — DB 저장 성공 후에만 발행 (게이트웨이가 룸 전체에 broadcast)
    this.meetingEvents.emitEnded({
      meeting_id: meeting.id,
      team_id: meeting.team_id,
    });
    void this.notifyMeetingEnded(meeting);

    try {
      await this.finalizeAgendas(meeting.id, endedAt, meeting.t0_timestamp);
    } catch (e) {
      this.logger.error(`안건 마감 실패 (meeting ${meeting.id})`, e as Error);
    }

    // 기여도 산정(외부/로컬)이 실패해도 회의 종료 자체는 항상 성공시킨다.
    // 실패 시 빈 배열 + scored=false 로 응답해 프론트가 구분 가능.
    let scores: Awaited<
      ReturnType<ContributionsService['computeAndStoreMeetingScores']>
    > = [];
    let scored = true;
    try {
      scores = await this.contributionsService.computeAndStoreMeetingScores(
        meeting.id,
      );
    } catch (e) {
      scored = false;
      this.logger.error(`기여도 산정 실패 (meeting ${meeting.id})`, e as Error);
    }

    return {
      meeting_id: meeting.id,
      ended_at: endedAt,
      contribution_scores: scores,
      scored,
    };
  }

  // 진행 중이던 안건을 완료 처리하고 actual_minutes 보정
  private async finalizeAgendas(
    meetingId: number,
    endedAt: Date,
    t0: Date | null,
  ) {
    const agendas = await this.agendaRepo.find({
      where: { meeting_id: meetingId },
    });
    const endOffset = t0 ? endedAt.getTime() - t0.getTime() : null;
    for (const a of agendas) {
      if (a.status === 'active') {
        if (endOffset !== null && a.ended_at_offset_ms === null) {
          a.ended_at_offset_ms = endOffset;
        }
        a.status = 'done';
      }
      if (
        a.started_at_offset_ms !== null &&
        a.ended_at_offset_ms !== null &&
        a.actual_minutes === null
      ) {
        a.actual_minutes = Math.round(
          (a.ended_at_offset_ms - a.started_at_offset_ms) / 60000,
        );
      }
    }
    if (agendas.length > 0) await this.agendaRepo.save(agendas);
  }

  // 회의록 그루핑 (시간순 → 5초 이내 연속 발화 병합 → 안건별 분류)
  async getTranscript(userId: number, id: number) {
    const meeting = await this.get(userId, id);
    const utterances = await this.utteranceRepo.find({
      where: { meeting_id: meeting.id },
      order: { started_at_offset_ms: 'ASC' },
    });

    type Group = {
      user_id: number;
      agenda_id: number | null;
      text: string;
      started_at_offset_ms: number;
      ended_at_offset_ms: number;
      is_short: boolean;
      // 본인 발화 정정/삭제 UI가 원본 발화를 특정할 수 있도록 노출
      utterance_ids: number[];
    };
    const groups: Group[] = [];
    for (const u of utterances) {
      const prev = groups[groups.length - 1];
      const mergeable =
        prev &&
        prev.user_id === u.user_id &&
        prev.agenda_id === u.agenda_id &&
        u.started_at_offset_ms - prev.ended_at_offset_ms <= GROUPING_GAP_MS;
      if (mergeable) {
        prev.text += ' ' + u.text;
        prev.ended_at_offset_ms = u.ended_at_offset_ms;
        prev.is_short = prev.text.length < SHORT_UTTERANCE_CHARS;
        prev.utterance_ids.push(Number(u.id));
      } else {
        groups.push({
          user_id: u.user_id,
          agenda_id: u.agenda_id,
          text: u.text,
          started_at_offset_ms: u.started_at_offset_ms,
          ended_at_offset_ms: u.ended_at_offset_ms,
          is_short: u.text.length < SHORT_UTTERANCE_CHARS,
          utterance_ids: [Number(u.id)],
        });
      }
    }

    // 안건별 분류 — 삭제된 안건(agenda_id가 더 이상 존재하지 않음)의 발화도
    // 조용히 증발하지 않도록 '미분류'로 편입한다
    const agendas = await this.agendaRepo.find({
      where: { meeting_id: meeting.id },
      order: { order_index: 'ASC' },
    });
    const agendaIds = new Set(agendas.map((a) => a.id));
    const byAgenda = new Map<number | 'none', Group[]>();
    for (const g of groups) {
      const key =
        g.agenda_id !== null && agendaIds.has(g.agenda_id)
          ? g.agenda_id
          : 'none';
      if (!byAgenda.has(key)) byAgenda.set(key, []);
      byAgenda.get(key)!.push(g);
    }

    const sections = agendas.map((a) => ({
      agenda_id: a.id,
      title: a.title,
      status: a.status,
      summary: a.summary,
      groups: byAgenda.get(a.id) ?? [],
    }));
    const unassigned = byAgenda.get('none') ?? [];
    if (unassigned.length > 0) {
      sections.push({
        agenda_id: 0,
        title: '미분류',
        status: 'done',
        summary: null,
        groups: unassigned,
      });
    }
    // 발화가 없는 섹션은 끝으로, 나머지는 첫 발화 시각 기준 오름차순
    sections.sort((a, b) => {
      const aStart = a.groups[0]?.started_at_offset_ms ?? Infinity;
      const bStart = b.groups[0]?.started_at_offset_ms ?? Infinity;
      return aStart - bStart;
    });
    return { meeting_id: meeting.id, sections };
  }

  private async requireMeeting(id: number) {
    const meeting = await this.meetingRepo.findOne({ where: { id } });
    if (!meeting) throw new NotFoundException('회의를 찾을 수 없습니다.');
    return meeting;
  }

  // 다른 모듈(게이트웨이 등)에서 회의 접근 권한 확인용
  async assertParticipant(userId: number, meetingId: number) {
    const meeting = await this.requireMeeting(meetingId);
    const m = await this.membershipRepo.findOne({
      where: { team_id: meeting.team_id, user_id: userId },
    });
    if (!m) throw new ForbiddenException('회의 참가 권한이 없습니다.');
    return meeting;
  }

  async attend(userId: number, meetingId: number) {
    const meeting = await this.assertParticipant(userId, meetingId);
    if (meeting.status !== 'active') {
      throw new BadRequestException('진행 중인 회의에만 참가할 수 있습니다.');
    }
    const existing = await this.presenceRepo.findOne({
      where: {
        meeting_id: meetingId,
        user_id: userId,
        event_type: In(['join', 'reconnect']) as unknown as 'join',
      },
    });
    if (existing) return { ok: true, alreadyJoined: true };
    const offset = meeting.t0_timestamp
      ? Date.now() - new Date(meeting.t0_timestamp).getTime()
      : 0;
    await this.presenceRepo.save(
      this.presenceRepo.create({
        meeting_id: meetingId,
        user_id: userId,
        event_type: 'join',
        disconnect_classification: null,
        timestamp_offset_ms: offset,
        reason: null,
      }),
    );
    return { ok: true, alreadyJoined: false };
  }

  async getJoinedCount(userId: number, meetingId: number) {
    await this.assertParticipant(userId, meetingId);
    const events = await this.presenceRepo.find({
      where: { meeting_id: meetingId },
    });
    const joined = new Set<number>();
    for (const e of events) {
      if (e.event_type === 'join' || e.event_type === 'reconnect') {
        joined.add(e.user_id);
      }
    }
    return { count: joined.size, hasJoined: joined.has(userId) };
  }

  // 기여도 재산정 — 회의 종료 시 산정 실패(scored=false)의 복구 경로.
  // computeAndStoreMeetingScores 는 (user_id, meeting_id) upsert 라 재실행이 멱등하다.
  async recomputeContributions(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (meeting.status !== 'ended') {
      throw new BadRequestException('종료된 회의만 재산정할 수 있습니다.');
    }
    const scores =
      await this.contributionsService.computeAndStoreMeetingScores(id);
    return { meeting_id: id, contribution_scores: scores, scored: true };
  }

  // 발화 정정 — 본인 발화만, 종료된 회의만 허용.
  // (active 중에는 라이브 인메모리 집계와 어긋나므로 금지 — 정책 결정 사항)
  async updateUtterance(
    userId: number,
    meetingId: number,
    utteranceId: number,
    dto: UpdateUtteranceDto,
  ) {
    const utterance = await this.requireOwnUtteranceEnded(
      userId,
      meetingId,
      utteranceId,
    );
    // 무음 절단 금지 — 병합 그룹 텍스트를 통째로 보내는 실수에서 원문을 지키려면 거부가 맞다
    if (dto.text.length > MAX_UTTERANCE_TEXT_CHARS) {
      throw new BadRequestException('발언은 2000자까지 수정할 수 있어요.');
    }
    const text = dto.text;
    utterance.text = text;
    utterance.char_count = text.length;
    await this.utteranceRepo.save(utterance);
    const recomputed = await this.tryRecomputeScores(meetingId);
    return {
      utterance_id: utterance.id,
      text: utterance.text,
      char_count: utterance.char_count,
      recomputed,
    };
  }

  // 병합 그룹 발화 일괄 정정 — 본인 발화만, 종료된 회의만 허용.
  // text가 null/빈 문자열(트림 후)이면 전체 삭제, 아니면 2000자 청크로 잘라
  // utterance_ids 순서대로 배정하고 청크가 안 가는 잔여 발화는 삭제.
  // 변경 전체를 한 트랜잭션으로 묶고, 기여도 재산정은 커밋 후 1회만 수행한다.
  async batchUpdateUtterances(
    userId: number,
    meetingId: number,
    dto: BatchUpdateUtterancesDto,
  ) {
    const meeting = await this.assertParticipant(userId, meetingId);
    if (meeting.status !== 'ended') {
      throw new BadRequestException(
        '종료된 회의의 발화만 수정·삭제할 수 있습니다.',
      );
    }
    const ids = dto.utterance_ids.map(Number);
    const found = await this.utteranceRepo.find({
      where: { id: In(ids), meeting_id: meetingId },
    });
    // 하나라도 회의 소속이 아니거나 본인 발화가 아니면 아무것도 변경하지 않는다
    if (found.length !== ids.length) {
      throw new NotFoundException('발화를 찾을 수 없습니다.');
    }
    if (found.some((u) => Number(u.user_id) !== Number(userId))) {
      throw new ForbiddenException('본인 발화만 수정·삭제할 수 있습니다.');
    }
    // 클라이언트가 보낸 id 순서(병합 그룹의 시간순)대로 청크를 배정한다
    const byId = new Map(found.map((u) => [Number(u.id), u]));
    const ordered = ids.map((i) => byId.get(i)!);

    const raw = dto.text ?? '';
    const chunks: string[] = [];
    if (raw.trim().length > 0) {
      for (let i = 0; i < raw.length; i += MAX_UTTERANCE_TEXT_CHARS) {
        chunks.push(raw.slice(i, i + MAX_UTTERANCE_TEXT_CHARS));
      }
    }
    // 청크가 발화 수를 넘으면(그룹 수용량 초과) 무음 유실 대신 거부 — 단건 정정과 동일 원칙
    if (chunks.length > ordered.length) {
      throw new BadRequestException(
        `발언은 ${ordered.length * MAX_UTTERANCE_TEXT_CHARS}자까지 수정할 수 있어요.`,
      );
    }

    let updated = 0;
    let deleted = 0;
    await this.dataSource.transaction(async (manager) => {
      for (let i = 0; i < ordered.length; i++) {
        const utterance = ordered[i];
        const chunk = chunks[i];
        if (chunk === undefined) {
          await manager.delete(Utterance, { id: utterance.id });
          deleted += 1;
        } else {
          utterance.text = chunk;
          utterance.char_count = chunk.length;
          await manager.save(utterance);
          updated += 1;
        }
      }
    });
    const recomputed = await this.tryRecomputeScores(meetingId);
    return { updated, deleted, recomputed };
  }

  // 발화 삭제 — 본인 발화만, 종료된 회의만 허용
  async removeUtterance(
    userId: number,
    meetingId: number,
    utteranceId: number,
  ) {
    const utterance = await this.requireOwnUtteranceEnded(
      userId,
      meetingId,
      utteranceId,
    );
    await this.utteranceRepo.remove(utterance);
    const recomputed = await this.tryRecomputeScores(meetingId);
    return { deleted: true, recomputed };
  }

  private async requireOwnUtteranceEnded(
    userId: number,
    meetingId: number,
    utteranceId: number,
  ) {
    const meeting = await this.assertParticipant(userId, meetingId);
    if (meeting.status !== 'ended') {
      throw new BadRequestException(
        '종료된 회의의 발화만 수정·삭제할 수 있습니다.',
      );
    }
    const utterance = await this.utteranceRepo.findOne({
      where: { id: utteranceId, meeting_id: meetingId },
    });
    if (!utterance) throw new NotFoundException('발화를 찾을 수 없습니다.');
    if (Number(utterance.user_id) !== Number(userId)) {
      throw new ForbiddenException('본인 발화만 수정·삭제할 수 있습니다.');
    }
    return utterance;
  }

  // 발화 변경 후 기여도 재산정 (upsert 기반 멱등). 실패해도 발화 변경 자체는 유지.
  private async tryRecomputeScores(meetingId: number) {
    try {
      await this.contributionsService.computeAndStoreMeetingScores(meetingId);
      return true;
    } catch (e) {
      this.logger.error(
        `기여도 재산정 실패 (meeting ${meetingId})`,
        e as Error,
      );
      return false;
    }
  }

  // 회의별 AI 정리 인플라이트 가드 — 동시 호출이 delete→insert를 겹쳐 타며
  // ai_extracted 행을 2벌 만들지 않도록, 진행 중이면 그 결과를 공유한다.
  private readonly summarizeInflight = new Map<
    number,
    ReturnType<MeetingsService['runSummarize']>
  >();

  // AI 회의 종합 정리 (회의 후 1번째 LLM 호출).
  // 입력: 안건별 요약 + 회의록 + 수동 입력 결정·액션 → 요약·누락 결정·정리된 태스크.
  // 재호출 시 이 회의의 미확정 AI 산출물만 교체(replace)해 중복 생성을 막는다.
  async summarize(userId: number, id: number) {
    // 권한·상태 검증은 호출자별로 수행 (인플라이트 공유 결과에 무임승차 방지)
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (meeting.status !== 'ended') {
      throw new BadRequestException('종료된 회의만 AI 정리를 할 수 있습니다.');
    }

    const inflight = this.summarizeInflight.get(id);
    if (inflight) return inflight;
    const run = this.runSummarize(userId, meeting).finally(() => {
      this.summarizeInflight.delete(id);
    });
    this.summarizeInflight.set(id, run);
    return run;
  }

  private async runSummarize(userId: number, meeting: Meeting) {
    const id = Number(meeting.id);
    const agendas = await this.agendaRepo.find({ where: { meeting_id: id } });
    const transcript = await this.getTranscript(userId, id);
    const decisions = await this.decisionRepo.find({
      where: { meeting_id: id },
    });
    // 미확정 AI 결정은 이번 호출에서 교체될 대상이므로 컨텍스트에서 제외
    // (LLM이 '이미 입력된 결정'으로 보고 재추출을 생략하면 교체 후 유실되기 때문)
    const keptDecisions = decisions.filter(
      (d) => !(d.source === 'ai_extracted' && !d.confirmed),
    );

    // 안건별 summary(회의 중 생성분)를 우선 쓰고, 발화 원문은 상한으로 절단
    let transcriptText = transcript.sections
      .flatMap((s) => [
        `# ${s.title}`,
        ...s.groups.map((g) => `(${g.user_id}) ${g.text}`),
      ])
      .join('\n');
    if (transcriptText.length > LLM_INPUT_CHAR_LIMIT) {
      transcriptText =
        transcriptText.slice(0, LLM_INPUT_CHAR_LIMIT) +
        '\n(분량 초과로 이하 생략)';
    }

    const context = [
      `회의 주제: ${meeting.topic ?? '(없음)'}`,
      '',
      '[안건별 요약]',
      ...agendas
        .filter((a) => a.summary)
        .map((a) => `- ${a.title}: ${a.summary}`),
      '',
      '[회의록]',
      transcriptText,
      '',
      '[수동 입력 결정]',
      ...keptDecisions.map((d) => `- ${d.content}`),
    ].join('\n');

    const result = await this.llmService.summarizeMeeting(context);
    if (!result) {
      // 키 미설정(재시도해도 영구 실패)과 일시 실패를 클라이언트가 구분하도록 reason 제공
      return {
        meeting_id: id,
        summarized: false,
        reason: this.llmService.enabled ? 'llm_failed' : 'llm_not_configured',
      };
    }

    meeting.one_liner = result.one_liner;
    meeting.summary = result.summary;
    await this.meetingRepo.save(meeting);

    // 멱등화(replace) — 이 회의 스코프의 미확정 AI 산출물만 삭제 후 재삽입.
    // confirmed=true 행은 24h 자동확정 cron과 경합하므로 절대 건드리지 않는다.
    // 삭제·삽입 전체를 한 트랜잭션으로 묶어(remove()와 동일 패턴) 삽입 중 실패 시
    // 직전 호출의 미확정 산출물이 유실되지 않게 한다.
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Decision, {
        meeting_id: id,
        source: 'ai_extracted',
        confirmed: false,
      });
      await manager.delete(ActionItem, {
        meeting_id: id,
        source: 'ai_extracted',
        confirmed: false,
      });

      // 누락된 결정 → ai_extracted 결정 (미확정)
      for (const md of result.missed_decisions) {
        await manager.save(
          this.decisionRepo.create({
            meeting_id: id,
            content: md.content,
            created_by: userId,
            source: 'ai_extracted',
            source_utterance_id: md.source_utterance_id ?? null,
            confirmed: false,
          }),
        );
      }
      // 정리된 태스크 → ai_extracted 액션 (미확정, 회의 스코프 연결)
      for (const t of result.tasks) {
        await manager.save(
          this.actionRepo.create({
            team_id: meeting.team_id,
            meeting_id: id,
            description: t.description,
            source: 'ai_extracted',
            source_utterance_id: t.source_utterance_id ?? null,
            confirmed: false,
            status: 'todo',
          }),
        );
      }
    });

    return { meeting_id: id, summarized: true, ...result };
  }

  // 회의 산출물 확정 (팀장). 결정·액션 confirmed=true, 액션 담당자에게 알림.
  async confirm(userId: number, id: number) {
    const meeting = await this.requireMeeting(id);
    await this.teamsService.requireLeader(userId, meeting.team_id);
    return this.confirmMeeting(meeting.id);
  }

  private async confirmMeeting(meetingId: number) {
    await this.decisionRepo.update(
      { meeting_id: meetingId, confirmed: false },
      { confirmed: true },
    );

    // 이 회의 안건에 연결된 액션 + AI 종합 정리가 만든 회의 스코프 액션 확정
    const agendas = await this.agendaRepo.find({
      where: { meeting_id: meetingId },
    });
    const agendaIds = agendas.map((a) => a.id);
    const actionWhere: FindOptionsWhere<ActionItem>[] = [
      { meeting_id: meetingId, confirmed: false },
    ];
    if (agendaIds.length > 0) {
      actionWhere.push({ agenda_id: In(agendaIds), confirmed: false });
    }
    const actions = await this.actionRepo.find({ where: actionWhere });
    for (const a of actions) {
      a.confirmed = true;
      await this.actionRepo.save(a);
      if (a.assignee_id) {
        await this.notificationsService.create(
          a.assignee_id,
          'action_assigned',
          '새 액션이 배정되었습니다',
          a.description,
          { meeting_id: meetingId, action_item_id: a.id },
        );
      }
    }
    return {
      meeting_id: meetingId,
      confirmed: true,
      confirmed_actions: actions.length,
    };
  }

  // 검토·확정 Fallback — 종료 24h 경과 미확정 회의 자동 확정.
  // 단일 EXISTS 쿼리로 '미확정 결정이 있는 회의 id'만 선별 (전체 로드·N+1 제거).
  // 결정 0건 회의가 미확정으로 남는 기존 동작은 그대로 유지한다.
  @Cron(CronExpression.EVERY_HOUR)
  async autoConfirmStaleMeetings() {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await this.meetingRepo
      .createQueryBuilder('m')
      .select('m.id', 'id')
      .where('m.status = :status', { status: 'ended' })
      .andWhere('m.ended_at < :cutoff', { cutoff })
      .andWhere(
        'EXISTS (SELECT 1 FROM decisions d WHERE d.meeting_id = m.id AND d.confirmed = false)',
      )
      .getRawMany<{ id: string | number }>();
    for (const row of stale) {
      await this.confirmMeeting(Number(row.id));
    }
  }
}
