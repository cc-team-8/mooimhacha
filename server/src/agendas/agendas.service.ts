import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Agenda, AgendaStatus } from '../entities/agenda.entity';
import { Meeting } from '../entities/meeting.entity';
import { Utterance } from '../entities/utterance.entity';
import { Decision } from '../entities/decision.entity';
import { ActionItem } from '../entities/action-item.entity';
import { TeamsService } from '../teams/teams.service';
import { LlmService, LLM_INPUT_CHAR_LIMIT } from '../llm/llm.service';
import { CreateAgendaDto } from './dto/create-agenda.dto';
import { UpdateAgendaDto } from './dto/update-agenda.dto';

// 환각 방어 — LLM이 생성하는 안건 개수 상한
const MAX_GENERATED_AGENDAS = 20;

@Injectable()
export class AgendasService {
  private readonly logger = new Logger(AgendasService.name);

  constructor(
    @InjectRepository(Agenda)
    private agendaRepo: Repository<Agenda>,
    @InjectRepository(Meeting)
    private meetingRepo: Repository<Meeting>,
    @InjectRepository(Utterance)
    private utteranceRepo: Repository<Utterance>,
    @InjectRepository(Decision)
    private decisionRepo: Repository<Decision>,
    @InjectRepository(ActionItem)
    private actionRepo: Repository<ActionItem>,
    private teamsService: TeamsService,
    private llmService: LlmService,
  ) {}

  async listForMeeting(userId: number, meetingId: number) {
    await this.requireMeetingAccess(userId, meetingId);
    return this.agendaRepo.find({
      where: { meeting_id: meetingId },
      order: { order_index: 'ASC' },
    });
  }

  async create(userId: number, meetingId: number, dto: CreateAgendaDto) {
    const meeting = await this.requireMeetingAccess(userId, meetingId);
    const max = await this.agendaRepo
      .createQueryBuilder('a')
      .select('MAX(a.order_index)', 'max')
      .where('a.meeting_id = :meetingId', { meetingId })
      .getRawOne<{ max: number | null }>();
    const agenda = this.agendaRepo.create({
      meeting_id: meetingId,
      title: dto.title,
      estimated_minutes: dto.estimated_minutes ?? 0,
      order_index: (max?.max ?? -1) + 1,
      // 회의 진행 중 추가는 즉석(ad_hoc), 그 외는 manual 기본
      source: dto.source ?? (meeting.status === 'active' ? 'ad_hoc' : 'manual'),
      status: 'pending',
    });
    return this.agendaRepo.save(agenda);
  }

  async update(userId: number, agendaId: number, dto: UpdateAgendaDto) {
    const { agenda } = await this.requireAgendaAccess(userId, agendaId);
    if (dto.title !== undefined) agenda.title = dto.title;
    if (dto.estimated_minutes !== undefined)
      agenda.estimated_minutes = dto.estimated_minutes;
    if (dto.order_index !== undefined) agenda.order_index = dto.order_index;
    if (dto.status !== undefined) {
      return this.setStatus(userId, agendaId, dto.status);
    }
    return this.agendaRepo.save(agenda);
  }

  async remove(userId: number, agendaId: number) {
    const { agenda } = await this.requireAgendaAccess(userId, agendaId);
    // 고아 방지 — 발화는 기여도 원천 데이터라 삭제하지 않고 미분류(null)로 편입,
    // 연결된 액션도 안건 연결만 해제한다
    await this.utteranceRepo.update(
      { agenda_id: agendaId },
      { agenda_id: null },
    );
    await this.actionRepo.update({ agenda_id: agendaId }, { agenda_id: null });
    await this.agendaRepo.remove(agenda);
    return { deleted: true };
  }

  // 안건 활성화 — 같은 회의의 다른 active 안건은 자동 완료(단일 진행 모델)
  async activate(userId: number, agendaId: number) {
    const { agenda, meeting } = await this.requireAgendaAccess(
      userId,
      agendaId,
    );
    const offset = this.offsetNow(meeting);

    const others = await this.agendaRepo.find({
      where: { meeting_id: agenda.meeting_id, status: 'active' },
    });
    for (const o of others) {
      if (o.id === agenda.id) continue;
      o.status = 'done';
      if (o.ended_at_offset_ms === null && offset !== null)
        o.ended_at_offset_ms = offset;
      this.fillActualMinutes(o);
    }
    if (others.length > 0) await this.agendaRepo.save(others);

    agenda.status = 'active';
    if (agenda.started_at_offset_ms === null && offset !== null)
      agenda.started_at_offset_ms = offset;
    return this.agendaRepo.save(agenda);
  }

  async setStatus(userId: number, agendaId: number, status: AgendaStatus) {
    const { agenda, meeting } = await this.requireAgendaAccess(
      userId,
      agendaId,
    );
    const offset = this.offsetNow(meeting);
    if (status === 'active' && agenda.started_at_offset_ms === null) {
      if (offset !== null) agenda.started_at_offset_ms = offset;
    }
    if (status === 'done') {
      if (agenda.ended_at_offset_ms === null && offset !== null)
        agenda.ended_at_offset_ms = offset;
      this.fillActualMinutes(agenda);
    }
    agenda.status = status;
    return this.agendaRepo.save(agenda);
  }

  // 안건 LLM 요약 (완료 시). 발화를 모아 GPT-4o-mini 호출 후 저장.
  async summarize(userId: number, agendaId: number) {
    const { agenda } = await this.requireAgendaAccess(userId, agendaId);
    if (agenda.status !== 'done') {
      throw new BadRequestException('완료된 안건만 요약할 수 있습니다.');
    }
    const utterances = await this.utteranceRepo.find({
      where: { agenda_id: agendaId },
      order: { started_at_offset_ms: 'ASC' },
    });
    // 발화 0건이면 요약할 내용이 없으므로 LLM 호출 스킵 (기존 요약도 보존)
    if (utterances.length === 0) {
      return { agenda_id: agendaId, summary: agenda.summary };
    }
    const summary = await this.llmService.summarizeAgenda(
      agenda.title,
      utterances.map((u) => u.text),
    );
    agenda.summary = summary;
    await this.agendaRepo.save(agenda);
    return { agenda_id: agendaId, summary };
  }

  // 다음 회의 아젠다 생성 (회의 후 2번째 LLM 호출).
  // 직전 회의 종합 결과(요약·결정) + 미해결 액션을 입력으로 :id 회의 안건을 생성한다.
  async generate(userId: number, meetingId: number) {
    const meeting = await this.requireMeetingAccess(userId, meetingId);

    // 같은 팀의 직전(종료된) 회의
    const prev = await this.meetingRepo.findOne({
      where: {
        team_id: meeting.team_id,
        status: 'ended',
        scheduled_at: LessThan(meeting.scheduled_at),
      },
      order: { scheduled_at: 'DESC' },
    });

    const prevDecisions = prev
      ? await this.decisionRepo.find({ where: { meeting_id: prev.id } })
      : [];
    // 미해결 액션 (팀 스코프, 완료/취소 아님)
    const openActions = await this.actionRepo.find({
      where: { team_id: meeting.team_id },
    });
    const unresolved = openActions.filter(
      (a) => a.status === 'todo' || a.status === 'in_progress',
    );

    // 직전 요약을 앞에 두고 전체 컨텍스트를 상한으로 절단 (입력 무한 증가 방지)
    let context = [
      `이번 회의 주제: ${meeting.topic ?? '(미정)'}`,
      '',
      '[직전 회의 요약]',
      prev?.summary ?? '(없음)',
      '',
      '[직전 회의 결정사항]',
      ...prevDecisions.map((d) => `- ${d.content}`),
      '',
      '[미해결 액션]',
      ...unresolved.map((a) => `- ${a.description}`),
    ].join('\n');
    if (context.length > LLM_INPUT_CHAR_LIMIT) {
      context =
        context.slice(0, LLM_INPUT_CHAR_LIMIT) + '\n(분량 초과로 이하 생략)';
    }

    const raw = await this.llmService.generateAgendas(context);
    if (!raw) {
      return { meeting_id: meetingId, generated: false, agendas: [] };
    }

    let parsed: unknown;
    try {
      const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return { meeting_id: meetingId, generated: false, agendas: [] };
    }
    // LLM 응답 구조 검증 — 배열이 아니면 실패 처리, 불량 항목은 걸러내고 개수 절단
    if (!Array.isArray(parsed)) {
      this.logger.warn(
        `아젠다 생성 응답이 배열이 아니라 버립니다 (meeting ${meetingId})`,
      );
      return { meeting_id: meetingId, generated: false, agendas: [] };
    }
    const items = parsed
      .filter(
        (p): p is Record<string, unknown> =>
          typeof p === 'object' && p !== null,
      )
      .filter((p) => typeof p.title === 'string' && p.title.trim() !== '')
      .slice(0, MAX_GENERATED_AGENDAS)
      .map((p) => ({
        title: (p.title as string).slice(0, 200),
        estimated_minutes:
          typeof p.estimated_minutes === 'number' &&
          Number.isFinite(p.estimated_minutes)
            ? Math.max(0, Math.round(p.estimated_minutes))
            : 10,
      }));

    const existing = await this.agendaRepo.count({
      where: { meeting_id: meetingId },
    });
    const created: Agenda[] = [];
    for (let i = 0; i < items.length; i++) {
      const a = await this.agendaRepo.save(
        this.agendaRepo.create({
          meeting_id: meetingId,
          title: items[i].title,
          estimated_minutes: items[i].estimated_minutes,
          order_index: existing + i,
          source: 'ai_recommended',
          status: 'pending',
        }),
      );
      created.push(a);
    }
    return { meeting_id: meetingId, generated: true, agendas: created };
  }

  // 게이트웨이가 발화 태깅에 사용 — 현재 진행 중 안건
  async getActiveAgendaId(meetingId: number): Promise<number | null> {
    const active = await this.agendaRepo.findOne({
      where: { meeting_id: meetingId, status: 'active' },
      order: { started_at_offset_ms: 'DESC' },
    });
    return active?.id ?? null;
  }

  private fillActualMinutes(a: Agenda) {
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

  private offsetNow(meeting: Meeting): number | null {
    if (!meeting.t0_timestamp) return null;
    return Date.now() - meeting.t0_timestamp.getTime();
  }

  private async requireMeetingAccess(userId: number, meetingId: number) {
    const meeting = await this.meetingRepo.findOne({
      where: { id: meetingId },
    });
    if (!meeting) throw new NotFoundException('회의를 찾을 수 없습니다.');
    await this.teamsService.requireMembership(userId, meeting.team_id);
    return meeting;
  }

  private async requireAgendaAccess(userId: number, agendaId: number) {
    const agenda = await this.agendaRepo.findOne({ where: { id: agendaId } });
    if (!agenda) throw new NotFoundException('안건을 찾을 수 없습니다.');
    const meeting = await this.requireMeetingAccess(userId, agenda.meeting_id);
    return { agenda, meeting };
  }
}
