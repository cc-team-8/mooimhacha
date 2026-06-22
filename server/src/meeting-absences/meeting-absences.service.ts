import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ContributionScore } from '../entities/contribution-score.entity';
import { PresenceEvent } from '../entities/presence-event.entity';
import { Meeting } from '../entities/meeting.entity';
import { MeetingAbsence } from '../entities/meeting-absence.entity';
import { AbsenceConsent } from '../entities/absence-consent.entity';
import { User } from '../entities/user.entity';
import { Team } from '../entities/team.entity';
import { TeamSettings } from '../entities/team-settings.entity';
import { TeamsService } from '../teams/teams.service';
import { SlackService } from '../slack/slack.service';
import { CreateAbsenceDto } from './dto/create-absence.dto';

export type AttendanceStatus = 'present' | 'late' | 'absent' | 'excused';

@Injectable()
export class MeetingAbsencesService {
  constructor(
    @InjectRepository(Meeting)
    private meetingRepo: Repository<Meeting>,
    @InjectRepository(ContributionScore)
    private scoreRepo: Repository<ContributionScore>,
    @InjectRepository(PresenceEvent)
    private presenceRepo: Repository<PresenceEvent>,
    @InjectRepository(MeetingAbsence)
    private absenceRepo: Repository<MeetingAbsence>,
    @InjectRepository(AbsenceConsent)
    private consentRepo: Repository<AbsenceConsent>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(Team)
    private teamRepo: Repository<Team>,
    @InjectRepository(TeamSettings)
    private settingsRepo: Repository<TeamSettings>,
    private teamsService: TeamsService,
    private slackService: SlackService,
    private config: ConfigService,
  ) {}

  // 종료된 회의의 출결 현황 — presence(입장 기록) + 저장된 ContributionScore + 사유/동의 조합
  async getAttendance(userId: number, meetingId: number) {
    const meeting = await this.requireMeeting(meetingId);
    await this.teamsService.requireMembership(userId, meeting.team_id);

    const members = await this.teamsService.getMembers(meeting.team_id);
    const [scores, presence, absences] = await Promise.all([
      this.scoreRepo.find({ where: { meeting_id: meetingId } }),
      this.presenceRepo.find({ where: { meeting_id: meetingId } }),
      this.absenceRepo.find({ where: { meeting_id: meetingId } }),
    ]);
    const consents = absences.length
      ? await this.consentRepo.find({
          where: { absence_id: In(absences.map((a) => a.id)) },
        })
      : [];

    const lateThreshold = await this.lateThresholdMinutes(meeting.team_id);
    const lateMax = await this.lateMaxMinutes(meeting.team_id);
    const joined = this.joinedUserIds(presence);
    const scoreByUser = new Map(scores.map((s) => [Number(s.user_id), s]));
    const absenceByUser = new Map(absences.map((a) => [Number(a.user_id), a]));
    const consentCount = new Map<number, number>();
    const myConsent = new Set<number>();
    for (const c of consents) {
      const aid = Number(c.absence_id);
      consentCount.set(aid, (consentCount.get(aid) ?? 0) + 1);
      if (Number(c.voter_id) === userId) myConsent.add(aid);
    }

    // 동의 정족수: 그 결석 건 본인 1명을 제외한 나머지 활성 팀원의 절반 이상
    const consentRequired = Math.ceil((members.length - 1) / 2);

    return {
      meeting_id: meetingId,
      consent_required: consentRequired,
      members: members.map((m) => {
        const score = scoreByUser.get(m.user_id);
        const absence = absenceByUser.get(m.user_id);
        const lateByPresence = this.isLateByPresence(
          meeting,
          presence,
          m.user_id,
          lateThreshold,
        );
        const exceedsMax = this.exceedsMaxLate(
          meeting,
          presence,
          m.user_id,
          lateMax,
        );
        const status = this.deriveStatus(
          joined.has(m.user_id),
          score,
          absence,
          lateByPresence,
          exceedsMax,
        );
        const aid = absence ? Number(absence.id) : null;
        return {
          user_id: m.user_id,
          name: m.name,
          profile_image_url: m.profile_image_url,
          status,
          joined_at: this.joinedAt(meeting, presence, m.user_id),
          late_minutes:
            status === 'late'
              ? this.lateMinutes(meeting, presence, m.user_id)
              : null,
          absence: absence
            ? {
                id: Number(absence.id),
                reason: absence.reason,
                status: absence.status,
                consent_count: aid ? (consentCount.get(aid) ?? 0) : 0,
                my_consent: aid ? myConsent.has(aid) : false,
              }
            : null,
        };
      }),
    };
  }

  // 팀의 종료된 회의들에 대한 요약 — 회의 목록 사이드바용.
  // my_status(내 출결) + pending_count(내가 아직 동의 안 한 결석 사유 수, 본인 것 제외)
  async getTeamSummary(userId: number, teamId: number) {
    await this.teamsService.requireMembership(userId, teamId);
    const meetings = await this.meetingRepo.find({
      where: { team_id: teamId, status: 'ended' },
    });
    if (meetings.length === 0) return [];
    const lateThreshold = await this.lateThresholdMinutes(teamId);
    const lateMax = await this.lateMaxMinutes(teamId);
    const ids = meetings.map((m) => m.id);
    const [myScores, myPresence, allPresence, absences, myConsents] =
      await Promise.all([
        this.scoreRepo.find({
          where: { meeting_id: In(ids), user_id: userId },
        }),
        this.presenceRepo.find({
          where: { meeting_id: In(ids), user_id: userId },
        }),
        this.presenceRepo.find({ where: { meeting_id: In(ids) } }),
        this.absenceRepo.find({ where: { meeting_id: In(ids) } }),
        this.consentRepo.find({ where: { voter_id: userId } }),
      ]);
    const myScoreByMeeting = new Map(
      myScores.map((s) => [Number(s.meeting_id), s]),
    );
    const myJoined = new Set(
      myPresence
        .filter((p) => p.event_type === 'join' || p.event_type === 'reconnect')
        .map((p) => Number(p.meeting_id)),
    );
    const myConsentSet = new Set(myConsents.map((c) => Number(c.absence_id)));

    // 회의별 참가 인원 수 (join/reconnect 기록이 있는 고유 user 수)
    const attendedByMeeting = new Map<number, Set<number>>();
    for (const p of allPresence) {
      if (p.event_type === 'join' || p.event_type === 'reconnect') {
        const mid = Number(p.meeting_id);
        if (!attendedByMeeting.has(mid)) attendedByMeeting.set(mid, new Set());
        attendedByMeeting.get(mid)!.add(Number(p.user_id));
      }
    }

    return meetings.map((m) => {
      const mid = Number(m.id);
      const myAbsence = absences.find(
        (a) => Number(a.meeting_id) === mid && Number(a.user_id) === userId,
      );
      const myPresenceForMeeting = myPresence.filter(
        (p) => Number(p.meeting_id) === mid,
      );
      const lateByPresence = this.isLateByPresence(
        m,
        myPresenceForMeeting,
        userId,
        lateThreshold,
      );
      const exceedsMax = this.exceedsMaxLate(
        m,
        myPresenceForMeeting,
        userId,
        lateMax,
      );
      const status = this.deriveStatus(
        myJoined.has(mid),
        myScoreByMeeting.get(mid),
        myAbsence,
        lateByPresence,
        exceedsMax,
      );
      // 내가 처리(동의)해야 할 미처리 결석 사유 — pending · 본인 것 아님 · 아직 미동의
      const pendingCount = absences.filter(
        (a) =>
          Number(a.meeting_id) === mid &&
          a.status === 'pending' &&
          Number(a.user_id) !== userId &&
          !myConsentSet.has(Number(a.id)),
      ).length;
      return {
        meeting_id: mid,
        my_status: status,
        pending_count: pendingCount,
        attended_count: attendedByMeeting.get(mid)?.size ?? 0,
      };
    });
  }

  // 본인 결석 사유 입력 (종료·유효 회의, 본인이 실제 결석일 때만)
  async createAbsence(
    userId: number,
    meetingId: number,
    dto: CreateAbsenceDto,
  ) {
    const meeting = await this.requireMeeting(meetingId);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (meeting.status !== 'ended') {
      throw new BadRequestException(
        '종료된 회의에만 사유를 입력할 수 있습니다.',
      );
    }
    if (meeting.is_invalidated) {
      throw new BadRequestException('무효 처리된 회의입니다.');
    }
    const presenceEvents = await this.presenceRepo.find({
      where: [
        { meeting_id: meetingId, user_id: userId, event_type: 'join' },
        { meeting_id: meetingId, user_id: userId, event_type: 'reconnect' },
      ],
    });
    const hasJoined = presenceEvents.length > 0;
    const isLate = this.isLateByPresence(
      meeting,
      presenceEvents,
      userId,
      await this.lateThresholdMinutes(meeting.team_id),
    );
    if (hasJoined && !isLate) {
      throw new BadRequestException(
        '결석 또는 지각한 경우에만 사유를 입력할 수 있습니다.',
      );
    }

    const existing = await this.absenceRepo.findOne({
      where: { meeting_id: meetingId, user_id: userId },
    });
    let saved: MeetingAbsence;
    if (existing) {
      if (existing.status === 'approved') {
        throw new BadRequestException('이미 인정된 결석은 수정할 수 없습니다.');
      }
      existing.reason = dto.reason;
      saved = await this.absenceRepo.save(existing);
    } else {
      saved = await this.absenceRepo.save(
        this.absenceRepo.create({
          meeting_id: meetingId,
          user_id: userId,
          reason: dto.reason,
          status: 'pending',
        }),
      );
    }
    void this.notifyAbsenceCreated(meeting, saved, isLate);
    return saved;
  }

  // 동의 — 결석자 제외 팀원, 멱등. 정족수 도달 시 자동 승인.
  async consent(userId: number, absenceId: number) {
    const absence = await this.absenceRepo.findOne({
      where: { id: absenceId },
    });
    if (!absence) throw new NotFoundException('결석 사유를 찾을 수 없습니다.');
    const meeting = await this.requireMeeting(absence.meeting_id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (Number(absence.user_id) === userId) {
      throw new BadRequestException('본인 결석에는 동의할 수 없습니다.');
    }
    if (absence.status !== 'pending') {
      return { status: absence.status };
    }

    const dup = await this.consentRepo.findOne({
      where: { absence_id: absenceId, voter_id: userId },
    });
    if (!dup) {
      await this.consentRepo.save(
        this.consentRepo.create({ absence_id: absenceId, voter_id: userId }),
      );
    }

    const members = await this.teamsService.getMembers(meeting.team_id);
    const required = Math.ceil((members.length - 1) / 2);
    const count = await this.consentRepo.count({
      where: { absence_id: absenceId },
    });
    if (count >= required && required > 0) {
      absence.status = 'approved';
      await this.absenceRepo.save(absence);
      void this.notifyAbsenceApproved(meeting, absence);
    }
    return {
      status: absence.status,
      consent_count: count,
      consent_required: required,
    };
  }

  // 내가 아직 동의하지 않은 팀 결석 사유 목록 (홈 알림용)
  async getPendingConsents(userId: number, teamId: number) {
    await this.teamsService.requireMembership(userId, teamId);

    const meetings = await this.meetingRepo.find({
      where: { team_id: teamId, status: 'ended' },
    });
    if (meetings.length === 0) return [];

    const meetingIds = meetings.map((m) => m.id);
    const meetingById = new Map(meetings.map((m) => [Number(m.id), m]));

    const absences = await this.absenceRepo.find({
      where: { meeting_id: In(meetingIds), status: 'pending' },
    });
    const others = absences.filter((a) => Number(a.user_id) !== userId);
    if (others.length === 0) return [];

    const myConsents = await this.consentRepo.find({
      where: { absence_id: In(others.map((a) => a.id)), voter_id: userId },
    });
    const consented = new Set(myConsents.map((c) => Number(c.absence_id)));
    const pending = others.filter((a) => !consented.has(Number(a.id)));
    if (pending.length === 0) return [];

    const members = await this.teamsService.getMembers(teamId);
    const nameById = new Map(members.map((m) => [m.user_id, m.name]));

    return pending
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((a) => ({
        absence_id: Number(a.id),
        meeting_id: Number(a.meeting_id),
        meeting_topic:
          meetingById.get(Number(a.meeting_id))?.topic ?? '제목 없는 회의',
        user_name: nameById.get(Number(a.user_id)) ?? '알 수 없음',
        reason: a.reason,
        created_at: a.created_at.toISOString(),
      }));
  }

  // 동의 취소 — pending 상태일 때만 가능
  async cancelConsent(userId: number, absenceId: number) {
    const absence = await this.absenceRepo.findOne({
      where: { id: absenceId },
    });
    if (!absence) throw new NotFoundException('결석 사유를 찾을 수 없습니다.');
    const meeting = await this.requireMeeting(absence.meeting_id);
    await this.teamsService.requireMembership(userId, meeting.team_id);
    if (absence.status !== 'pending') {
      throw new BadRequestException('이미 승인된 동의는 취소할 수 없습니다.');
    }

    await this.consentRepo.delete({ absence_id: absenceId, voter_id: userId });

    const members = await this.teamsService.getMembers(meeting.team_id);
    const required = Math.ceil((members.length - 1) / 2);
    const count = await this.consentRepo.count({
      where: { absence_id: absenceId },
    });
    return {
      status: absence.status,
      consent_count: count,
      consent_required: required,
    };
  }

  // Slack 버튼 클릭으로 동의 — slack_user_id 기준으로 사용자를 찾아 동의 처리
  async consentBySlack(slackUserId: string, absenceId: number): Promise<void> {
    const user = await this.userRepo.findOne({
      where: { slack_user_id: slackUserId },
    });
    if (!user) return;
    try {
      await this.consent(user.id, absenceId);
    } catch {
      // 이미 동의했거나 승인된 경우 등 — 무시
    }
  }

  // --- Slack 알림 ---

  private async notifyAbsenceCreated(
    meeting: Meeting,
    absence: MeetingAbsence,
    isLate: boolean,
  ): Promise<void> {
    const [settings, user, team] = await Promise.all([
      this.settingsRepo.findOne({ where: { team_id: meeting.team_id } }),
      this.userRepo.findOne({ where: { id: absence.user_id } }),
      this.teamRepo.findOne({ where: { id: meeting.team_id } }),
    ]);
    if (!settings?.slack_bot_token) return;

    const label = isLate ? '지각' : '결석';
    const teamName = team?.name ?? '팀';
    const userName = user?.name ?? '팀원';
    const meetingTopic = meeting.topic ?? '회의';
    const clientUrl = this.config.get<string>('CLIENT_URL') ?? '';
    const attendanceUrl = `${clientUrl}/dashboard/${meeting.team_id}/meeting`;

    if (settings.slack_channel_id) {
      await this.slackService.sendChannelMessage(
        settings.slack_bot_token,
        settings.slack_channel_id,
        [
          `🔔 *출결 사유 등록* — ${teamName}`,
          `> *${userName}*님이 *${meetingTopic}* ${label} 사유를 입력했습니다`,
          `> 확인 후 동의해주세요`,
          `<${attendanceUrl}|출결 현황 보기 →>`,
        ].join('\n'),
      );
    }

    const members = await this.teamsService.getMembers(meeting.team_id);
    const otherIds = members
      .map((m) => m.user_id)
      .filter((id) => id !== Number(absence.user_id));
    if (otherIds.length === 0) return;

    const slackUsers = await this.userRepo.find({
      where: { id: In(otherIds) },
    });

    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            `🔔 *출결 사유 동의 요청* — ${teamName}`,
            `*${userName}*님이 *${meetingTopic}* ${label} 사유를 입력했습니다.`,
            ``,
            `> ${absence.reason}`,
          ].join('\n'),
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✅ 동의하기' },
            action_id: 'consent_absence',
            value: String(absence.id),
            style: 'primary',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '출결 현황 보기 →' },
            url: attendanceUrl,
            action_id: 'view_attendance',
          },
        ],
      },
    ];

    await Promise.all(
      slackUsers
        .filter((u) => u.slack_user_id)
        .map((u) =>
          this.slackService.sendDmWithBlocks(
            settings.slack_bot_token!,
            u.slack_user_id!,
            blocks,
            `${userName}님의 ${meetingTopic} ${label} 사유 동의 요청`,
          ),
        ),
    );
  }

  private async notifyAbsenceApproved(
    meeting: Meeting,
    absence: MeetingAbsence,
  ): Promise<void> {
    const [settings, user, team] = await Promise.all([
      this.settingsRepo.findOne({ where: { team_id: meeting.team_id } }),
      this.userRepo.findOne({ where: { id: absence.user_id } }),
      this.teamRepo.findOne({ where: { id: meeting.team_id } }),
    ]);
    if (!settings?.slack_bot_token) return;
    if (!user?.slack_user_id) return;
    const presenceEvents = await this.presenceRepo.find({
      where: [
        {
          meeting_id: meeting.id,
          user_id: absence.user_id,
          event_type: 'join',
        },
        {
          meeting_id: meeting.id,
          user_id: absence.user_id,
          event_type: 'reconnect',
        },
      ],
    });
    const isLate = this.isLateByPresence(
      meeting,
      presenceEvents,
      Number(absence.user_id),
      settings.late_threshold_minutes ?? 5,
    );
    const label = isLate ? '지각' : '결석';
    const clientUrl = this.config.get<string>('CLIENT_URL') ?? '';
    const attendanceUrl = `${clientUrl}/dashboard/${meeting.team_id}/meeting`;
    await this.slackService.sendDm(
      settings.slack_bot_token,
      user.slack_user_id,
      [
        `✅ *출결 사유 승인* — ${team?.name ?? '팀'}`,
        `> *${meeting.topic ?? '회의'}* ${label} 사유가 승인됐습니다`,
        `<${attendanceUrl}|출결 현황 보기 →>`,
      ].join('\n'),
    );
  }

  // --- 헬퍼 ---

  private deriveStatus(
    hasJoined: boolean,
    score: ContributionScore | undefined,
    absence: MeetingAbsence | undefined,
    lateByPresence = false,
    exceedsMaxLate = false,
  ): AttendanceStatus {
    if (!hasJoined || exceedsMaxLate) {
      return absence?.status === 'approved' ? 'excused' : 'absent';
    }
    if (lateByPresence) return 'late';
    return 'present';
  }

  // 실제 시작(t0) 기준 지각 기준(분) 초과 입장 여부를 presence 이벤트로 직접 판정
  private isLateByPresence(
    meeting: Meeting,
    presence: PresenceEvent[],
    userId: number,
    thresholdMinutes: number,
  ): boolean {
    if (!meeting.t0_timestamp) return false;
    const joins = presence
      .filter(
        (p) =>
          Number(p.user_id) === userId &&
          (p.event_type === 'join' || p.event_type === 'reconnect'),
      )
      .map((p) => p.timestamp_offset_ms);
    if (joins.length === 0) return false;
    const firstOffset = Math.min(...joins);
    return Math.max(0, firstOffset) / 1000 > thresholdMinutes * 60;
  }

  // 지각 최대 인정 시간(분) 초과 입장 여부 — maxLateMinutes가 0이면 상한 없음(항상 false)
  private exceedsMaxLate(
    meeting: Meeting,
    presence: PresenceEvent[],
    userId: number,
    maxLateMinutes: number,
  ): boolean {
    if (maxLateMinutes <= 0) return false;
    if (!meeting.t0_timestamp) return false;
    const joins = presence
      .filter(
        (p) =>
          Number(p.user_id) === userId &&
          (p.event_type === 'join' || p.event_type === 'reconnect'),
      )
      .map((p) => p.timestamp_offset_ms);
    if (joins.length === 0) return false;
    const firstOffset = Math.min(...joins);
    return Math.max(0, firstOffset) / 1000 > maxLateMinutes * 60;
  }

  // 팀의 지각 기준(분) — 설정이 없으면 기본 5분
  private async lateThresholdMinutes(teamId: number): Promise<number> {
    const settings = await this.settingsRepo.findOne({
      where: { team_id: teamId },
    });
    return settings?.late_threshold_minutes ?? 5;
  }

  // 팀의 지각 최대 인정 시간(분) — 설정이 없으면 0(상한 없음)
  private async lateMaxMinutes(teamId: number): Promise<number> {
    const settings = await this.settingsRepo.findOne({
      where: { team_id: teamId },
    });
    return settings?.late_max_minutes ?? 0;
  }

  // 그 회의에 입장(join/reconnect) 기록이 있는 user 집합
  private joinedUserIds(presence: PresenceEvent[]): Set<number> {
    const set = new Set<number>();
    for (const p of presence) {
      if (p.event_type === 'join' || p.event_type === 'reconnect') {
        set.add(Number(p.user_id));
      }
    }
    return set;
  }

  // 실제 입장 시각 (ISO string) — t0 + 첫 입장 오프셋
  private joinedAt(
    meeting: Meeting,
    presence: PresenceEvent[],
    userId: number,
  ): string | null {
    if (!meeting.t0_timestamp) return null;
    const joins = presence
      .filter(
        (p) =>
          Number(p.user_id) === userId &&
          (p.event_type === 'join' || p.event_type === 'reconnect'),
      )
      .map((p) => p.timestamp_offset_ms);
    if (joins.length === 0) return null;
    const firstOffset = Math.min(...joins);
    return new Date(meeting.t0_timestamp.getTime() + firstOffset).toISOString();
  }

  // 지각 분 — 실제 시작(t0) 기준 첫 입장까지 경과 분
  private lateMinutes(
    meeting: Meeting,
    presence: PresenceEvent[],
    userId: number,
  ): number | null {
    if (!meeting.t0_timestamp) return null;
    const joins = presence
      .filter(
        (p) =>
          Number(p.user_id) === userId &&
          (p.event_type === 'join' || p.event_type === 'reconnect'),
      )
      .map((p) => p.timestamp_offset_ms);
    if (joins.length === 0) return null;
    const firstOffset = Math.min(...joins);
    return Math.round(Math.max(0, firstOffset) / 60000);
  }

  private async requireMeeting(meetingId: number): Promise<Meeting> {
    const meeting = await this.meetingRepo.findOne({
      where: { id: meetingId },
    });
    if (!meeting) throw new NotFoundException('회의를 찾을 수 없습니다.');
    return meeting;
  }
}
