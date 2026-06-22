import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Repository } from 'typeorm';
import * as nodemailer from 'nodemailer';
import {
  Notification,
  NotificationType,
} from '../entities/notification.entity';
import { Meeting } from '../entities/meeting.entity';
import { Team } from '../entities/team.entity';
import { TeamMembership } from '../entities/team-membership.entity';
import { User } from '../entities/user.entity';
import { ActionItem } from '../entities/action-item.entity';
import { TeamSettings } from '../entities/team-settings.entity';
import { SlackService } from '../slack/slack.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(
    @InjectRepository(Notification)
    private notiRepo: Repository<Notification>,
    @InjectRepository(Meeting)
    private meetingRepo: Repository<Meeting>,
    @InjectRepository(Team)
    private teamRepo: Repository<Team>,
    @InjectRepository(TeamMembership)
    private membershipRepo: Repository<TeamMembership>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    @InjectRepository(ActionItem)
    private actionRepo: Repository<ActionItem>,
    @InjectRepository(TeamSettings)
    private settingsRepo: Repository<TeamSettings>,
    private config: ConfigService,
    private slackService: SlackService,
  ) {
    const host = this.config.get<string>('SMTP_HOST');
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(this.config.get<string>('SMTP_PORT') ?? 587),
        secure: this.config.get<string>('SMTP_SECURE') === 'true',
        auth: {
          user: this.config.get<string>('SMTP_USER'),
          pass: this.config.get<string>('SMTP_PASS'),
        },
      });
    }
  }

  async create(
    userId: number,
    type: NotificationType,
    title: string,
    body?: string,
    refs?: { meeting_id?: number; action_item_id?: number },
  ) {
    const noti = await this.notiRepo.save(
      this.notiRepo.create({
        user_id: userId,
        type,
        title,
        body: body ?? null,
        meeting_id: refs?.meeting_id ?? null,
        action_item_id: refs?.action_item_id ?? null,
      }),
    );
    void this.sendEmail(userId, title, body);
    return noti;
  }

  async listForUser(userId: number, unreadOnly = false) {
    return this.notiRepo.find({
      where: unreadOnly
        ? { user_id: userId, read: false }
        : { user_id: userId },
      order: { created_at: 'DESC' },
      take: 50,
    });
  }

  async markRead(userId: number, id: number) {
    const noti = await this.notiRepo.findOne({ where: { id } });
    if (!noti || noti.user_id !== userId) {
      throw new NotFoundException('알림을 찾을 수 없습니다.');
    }
    noti.read = true;
    return this.notiRepo.save(noti);
  }

  async markAllRead(userId: number) {
    await this.notiRepo.update(
      { user_id: userId, read: false },
      { read: true },
    );
    return { ok: true };
  }

  // 회의 5분 전 알림 (매분 점검)
  @Cron(CronExpression.EVERY_MINUTE)
  async checkUpcomingMeetings() {
    const now = new Date();
    const in5 = new Date(now.getTime() + 5 * 60 * 1000);
    const upcoming = await this.meetingRepo.find({
      where: { status: 'scheduled', scheduled_at: Between(now, in5) },
    });
    for (const m of upcoming) {
      const members = await this.membershipRepo.find({
        where: { team_id: m.team_id },
      });
      for (const member of members) {
        const exists = await this.notiRepo.findOne({
          where: {
            user_id: member.user_id,
            meeting_id: m.id,
            type: 'meeting_soon',
          },
        });
        if (exists) continue;
        await this.create(
          member.user_id,
          'meeting_soon',
          '회의가 곧 시작됩니다',
          `${m.topic ?? '회의'} — ${new Date(m.scheduled_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
          { meeting_id: m.id },
        );
      }
    }
  }

  // 매일 KST 09:00 (UTC 00:00) — 마감 하루 전 태스크 담당자 DM
  @Cron('0 0 0 * * *')
  async checkDueTomorrow() {
    const now = new Date();
    const tomorrowStart = new Date(now);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    tomorrowStart.setUTCHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setUTCHours(23, 59, 59, 999);

    const tasks = await this.actionRepo.find({
      where: {
        due_date: Between(tomorrowStart, tomorrowEnd),
        status: In(['todo', 'in_progress']),
      },
    });

    for (const task of tasks) {
      if (!task.assignee_id) continue;

      const exists = await this.notiRepo.findOne({
        where: { action_item_id: task.id, type: 'task_due_soon' },
      });
      if (exists) continue;

      await this.create(
        Number(task.assignee_id),
        'task_due_soon',
        '태스크 마감이 내일입니다',
        task.description,
        { action_item_id: task.id },
      );

      const [user, settings, team] = await Promise.all([
        this.userRepo.findOne({ where: { id: task.assignee_id } }),
        this.settingsRepo.findOne({ where: { team_id: task.team_id } }),
        this.teamRepo.findOne({ where: { id: task.team_id } }),
      ]);
      if (user?.slack_user_id && settings?.slack_bot_token) {
        const clientUrl = this.config.get<string>('CLIENT_URL') ?? '';
        const taskUrl = `${clientUrl}/dashboard/${task.team_id}/tasks`;
        await this.slackService.sendDm(
          settings.slack_bot_token,
          user.slack_user_id,
          [
            `⏰ *태스크 마감 D-1* — ${team?.name ?? '팀'}`,
            `> ${task.description}`,
            `> 내일까지 완료해주세요`,
            `<${taskUrl}|태스크 목록 보기 →>`,
          ].join('\n'),
        );
      }
    }
  }

  // 매분 — 회의 30분 전 팀 채널 알림
  @Cron(CronExpression.EVERY_MINUTE)
  async checkMeetingIn30Min() {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 60 * 1000);
    const windowEnd = new Date(in30.getTime() + 60 * 1000);

    const upcoming = await this.meetingRepo.find({
      where: { status: 'scheduled', scheduled_at: Between(in30, windowEnd) },
    });

    for (const m of upcoming) {
      const exists = await this.notiRepo.findOne({
        where: { meeting_id: m.id, type: 'meeting_30m' },
      });
      if (exists) continue;

      const leader = await this.membershipRepo.findOne({
        where: { team_id: m.team_id, role: 'leader' },
      });
      if (leader) {
        await this.create(
          leader.user_id,
          'meeting_30m',
          '회의가 30분 후 시작됩니다',
          m.topic ?? '회의',
          { meeting_id: m.id },
        );
      }

      const [settings, team] = await Promise.all([
        this.settingsRepo.findOne({ where: { team_id: m.team_id } }),
        this.teamRepo.findOne({ where: { id: m.team_id } }),
      ]);
      if (settings?.slack_bot_token && settings.slack_channel_id) {
        const clientUrl = this.config.get<string>('CLIENT_URL') ?? '';
        const meetingUrl = `${clientUrl}/dashboard/${m.team_id}/meeting`;
        await this.slackService.sendChannelMessage(
          settings.slack_bot_token,
          settings.slack_channel_id,
          [
            `📢 *회의 30분 전* — ${team?.name ?? '팀'}`,
            `> *${m.topic ?? '회의'}*`,
            `> 잠시 후 시작됩니다. 준비해주세요!`,
            `<${meetingUrl}|출결 현황 보기 →>`,
          ].join('\n'),
        );
      }
    }
  }

  private async sendEmail(userId: number, subject: string, text?: string) {
    if (!this.transporter) return;
    try {
      const user = await this.userRepo.findOne({ where: { id: userId } });
      if (!user?.kakao_email) return;
      if (user.email_opt_out) return;
      await this.transporter.sendMail({
        from: this.config.get<string>('MAIL_FROM') ?? 'no-reply@mooimhacha',
        to: user.kakao_email,
        subject: `[무임하차] ${subject}`,
        text: text ?? subject,
      });
    } catch (e) {
      this.logger.error('이메일 전송 실패', e as Error);
    }
  }
}
