import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Team } from '../entities/team.entity';
import { TeamMembership } from '../entities/team-membership.entity';
import { TeamSettings } from '../entities/team-settings.entity';
import { User } from '../entities/user.entity';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { JoinTeamDto } from './dto/join-team.dto';
import { UpdateTeamSettingsDto } from './dto/update-team-settings.dto';

@Injectable()
export class TeamsService {
  constructor(
    @InjectRepository(Team)
    private teamRepo: Repository<Team>,
    @InjectRepository(TeamMembership)
    private membershipRepo: Repository<TeamMembership>,
    @InjectRepository(TeamSettings)
    private settingsRepo: Repository<TeamSettings>,
    @InjectRepository(User)
    private userRepo: Repository<User>,
    private dataSource: DataSource,
  ) {}

  // 다른 도메인 모듈(agendas/action-items/decisions/projects 등)이 공유하는
  // 멤버십/권한 검증 헬퍼 — feature/core-meeting-flow의 TeamsService와 동일 계약
  async getMembers(teamId: number, opts?: { includePast?: boolean }) {
    const memberships = await this.membershipRepo.find({
      where: { team_id: teamId },
      withDeleted: opts?.includePast ?? false,
    });
    if (memberships.length === 0) return [];
    const users = await this.userRepo.find({
      where: { id: In(memberships.map((m) => m.user_id)) },
    });
    const userById = new Map(users.map((u) => [u.id, u]));
    return memberships.map((m) => {
      const u = userById.get(m.user_id);
      return {
        user_id: m.user_id,
        name: u?.name ?? '알 수 없음',
        nickname: m.nickname,
        profile_image_url: u?.profile_image_url ?? null,
        role: m.role,
        joined_at: m.joined_at,
      };
    });
  }

  async requireMembership(userId: number, teamId: number) {
    const m = await this.membershipRepo.findOne({
      where: { team_id: teamId, user_id: userId },
    });
    if (!m) throw new ForbiddenException('팀 멤버가 아닙니다.');
    return m;
  }

  async requireLeader(userId: number, teamId: number) {
    const m = await this.requireMembership(userId, teamId);
    if (m.role !== 'leader') {
      throw new ForbiddenException('팀장만 수행할 수 있습니다.');
    }
    return m;
  }

  // 2-1. 내 팀 목록
  async getMyTeams(userId: number) {
    const myMemberships = await this.membershipRepo.find({
      where: { user_id: userId, deleted_at: IsNull() },
    });

    if (myMemberships.length === 0) return { teams: [] };

    const teamIds = myMemberships.map((m) => Number(m.team_id));

    const [teams, allMemberships] = await Promise.all([
      this.teamRepo.find({ where: { id: In(teamIds), deleted_at: IsNull() } }),
      this.membershipRepo.find({
        where: { team_id: In(teamIds), deleted_at: IsNull() },
      }),
    ]);

    const allUserIds = [
      ...new Set(allMemberships.map((m) => Number(m.user_id))),
    ];
    const users = await this.dataSource.getRepository(User).find({
      where: { id: In(allUserIds) },
      select: { id: true, name: true },
    });
    const userMap = new Map(users.map((u) => [Number(u.id), u.name]));

    const membersByTeam = new Map<
      number,
      { user_id: number; name: string; nickname: string | null; role: string }[]
    >();
    for (const m of allMemberships) {
      const tid = Number(m.team_id);
      if (!membersByTeam.has(tid)) membersByTeam.set(tid, []);
      membersByTeam.get(tid)!.push({
        user_id: Number(m.user_id),
        name: userMap.get(Number(m.user_id)) ?? '?',
        nickname: m.nickname,
        role: m.role,
      });
    }

    const counts: { team_id: string; count: string }[] =
      await this.membershipRepo
        .createQueryBuilder('m')
        .select('m.team_id', 'team_id')
        .addSelect('COUNT(*)', 'count')
        .where('m.team_id IN (:...ids)', { ids: teamIds })
        .andWhere('m.deleted_at IS NULL')
        .groupBy('m.team_id')
        .getRawMany();

    const countMap = new Map(
      counts.map((c) => [Number(c.team_id), Number(c.count)]),
    );

    return {
      teams: myMemberships.map((m) => {
        const team = teams.find((t) => Number(t.id) === Number(m.team_id))!;
        const teamId = Number(team.id);
        return {
          id: teamId,
          name: team.name,
          course_name: team.course_name,
          my_role: m.role,
          member_count: countMap.get(teamId) ?? 0,
          members: membersByTeam.get(teamId) ?? [],
        };
      }),
    };
  }

  // 2-2. 팀 생성
  async createTeam(userId: number, dto: CreateTeamDto) {
    return this.dataSource.transaction(async (manager) => {
      const team = manager.create(Team, {
        name: dto.name,
        course_name: dto.course_name,
        invite_code: this.generateInviteCode(),
        created_by: userId,
      });
      await manager.save(team);

      await manager.save(
        manager.create(TeamMembership, {
          team_id: Number(team.id),
          user_id: userId,
          role: 'leader',
          joined_at: new Date(),
        }),
      );

      await manager.save(
        manager.create(TeamSettings, { team_id: Number(team.id) }),
      );

      return {
        id: Number(team.id),
        name: team.name,
        course_name: team.course_name,
        invite_code: team.invite_code,
        created_by: Number(team.created_by),
      };
    });
  }

  // 2-3. 팀 상세
  async getTeam(teamId: number, userId: number) {
    await this.assertMember(teamId, userId);

    const team = await this.teamRepo.findOne({
      where: { id: teamId, deleted_at: IsNull() },
    });
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다.');

    const memberships = await this.membershipRepo.find({
      where: { team_id: teamId, deleted_at: IsNull() },
    });

    // 클라이언트(설정 페이지 멤버 관리)가 이름·아바타를 쓰므로 사용자 정보를 합쳐 반환
    const users = await this.dataSource.getRepository(User).find({
      where: { id: In(memberships.map((m) => Number(m.user_id))) },
      select: { id: true, name: true, profile_image_url: true },
    });
    const userById = new Map(users.map((u) => [Number(u.id), u]));

    return {
      id: Number(team.id),
      name: team.name,
      course_name: team.course_name,
      invite_code: team.invite_code,
      members: memberships.map((m) => {
        const u = userById.get(Number(m.user_id));
        return {
          user_id: Number(m.user_id),
          name: u?.name ?? '알 수 없음',
          nickname: m.nickname,
          profile_image_url: u?.profile_image_url ?? null,
          role: m.role,
        };
      }),
    };
  }

  // 2-4. 팀 수정
  async updateTeam(teamId: number, userId: number, dto: UpdateTeamDto) {
    await this.assertLeader(teamId, userId);

    const team = await this.teamRepo.findOne({
      where: { id: teamId, deleted_at: IsNull() },
    });
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다.');

    if (dto.name !== undefined) team.name = dto.name;
    if (dto.course_name !== undefined) team.course_name = dto.course_name;
    await this.teamRepo.save(team);

    return {
      id: Number(team.id),
      name: team.name,
      course_name: team.course_name,
      invite_code: team.invite_code,
    };
  }

  // 2-5. 초대 코드로 합류
  async joinTeam(userId: number, dto: JoinTeamDto) {
    const team = await this.teamRepo.findOne({
      where: { invite_code: dto.invite_code, deleted_at: IsNull() },
    });
    if (!team) throw new NotFoundException('유효하지 않은 초대 코드입니다.');

    const teamId = Number(team.id);

    const existing = await this.membershipRepo.findOne({
      where: { team_id: teamId, user_id: userId },
      withDeleted: true,
    });

    if (existing && !existing.deleted_at) {
      throw new ConflictException('이미 가입된 팀입니다.');
    }

    if (existing?.deleted_at) {
      existing.deleted_at = null;
      existing.role = 'member';
      existing.joined_at = new Date();
      await this.membershipRepo.save(existing);
    } else {
      await this.membershipRepo.save(
        this.membershipRepo.create({
          team_id: teamId,
          user_id: userId,
          role: 'member',
          joined_at: new Date(),
        }),
      );
    }

    return { team_id: teamId, name: team.name, role: 'member' };
  }

  // 2-6. 초대 코드 재발급
  async regenerateInviteCode(teamId: number, userId: number) {
    await this.assertLeader(teamId, userId);

    const team = await this.teamRepo.findOne({
      where: { id: teamId, deleted_at: IsNull() },
    });
    if (!team) throw new NotFoundException('팀을 찾을 수 없습니다.');

    team.invite_code = this.generateInviteCode();
    await this.teamRepo.save(team);

    return { invite_code: team.invite_code };
  }

  // 2-7. 탈퇴 / 추방
  async removeMember(
    teamId: number,
    targetUserId: number,
    requestingUserId: number,
  ) {
    if (targetUserId === requestingUserId) {
      const membership = await this.membershipRepo.findOne({
        where: {
          team_id: teamId,
          user_id: requestingUserId,
          deleted_at: IsNull(),
        },
      });
      if (!membership) throw new NotFoundException('팀 멤버십이 없습니다.');
      if (membership.role === 'leader') {
        throw new BadRequestException('팀장은 팀을 나갈 수 없습니다.');
      }
      await this.membershipRepo.softDelete({ id: membership.id });
    } else {
      await this.assertLeader(teamId, requestingUserId);
      const membership = await this.membershipRepo.findOne({
        where: { team_id: teamId, user_id: targetUserId, deleted_at: IsNull() },
      });
      if (!membership)
        throw new NotFoundException('해당 멤버를 찾을 수 없습니다.');
      await this.membershipRepo.softDelete({ id: membership.id });
    }
  }

  // 2-8. 팀 삭제 (팀장만)
  async deleteTeam(teamId: number, userId: number) {
    await this.assertLeader(teamId, userId);
    await this.dataSource.transaction(async (manager) => {
      await manager.softDelete(TeamMembership, { team_id: teamId });
      await manager.softDelete(Team, { id: teamId });
    });
  }

  // 3-1. 팀 설정 조회
  async getSettings(teamId: number, userId: number) {
    await this.assertMember(teamId, userId);

    const settings = await this.settingsRepo.findOne({
      where: { team_id: teamId },
    });
    if (!settings) throw new NotFoundException('팀 설정을 찾을 수 없습니다.');

    return this.formatSettings(settings);
  }

  // 3-2. 팀 설정 수정
  async updateSettings(
    teamId: number,
    userId: number,
    dto: UpdateTeamSettingsDto,
  ) {
    await this.assertLeader(teamId, userId);

    const settings = await this.settingsRepo.findOne({
      where: { team_id: teamId },
    });
    if (!settings) throw new NotFoundException('팀 설정을 찾을 수 없습니다.');

    Object.assign(settings, dto);
    if (
      settings.late_max_minutes !== 0 &&
      settings.late_max_minutes < settings.late_threshold_minutes
    ) {
      throw new BadRequestException(
        '지각 최대 인정 시간은 0(상한 없음) 또는 지각 기준 이상이어야 합니다.',
      );
    }
    await this.settingsRepo.save(settings);

    return this.formatSettings(settings);
  }

  private formatSettings(s: TeamSettings) {
    return {
      team_id: Number(s.team_id),
      punctuality_grace_ratio: Number(s.punctuality_grace_ratio),
      max_utterance_chars: s.max_utterance_chars,
      presence_grace_seconds: s.presence_grace_seconds,
      absent_meeting_handling: s.absent_meeting_handling,
      deadline_penalty_curve: s.deadline_penalty_curve,
      contribution_visibility: s.contribution_visibility,
      min_meeting_minutes: s.min_meeting_minutes,
      final_task_weight: Number(s.final_task_weight),
      weight_speech_in_meeting: Number(s.weight_speech_in_meeting),
      weight_attend_in_meeting: Number(s.weight_attend_in_meeting),
      leader_bonus_multiplier: Number(s.leader_bonus_multiplier),
      late_threshold_minutes: s.late_threshold_minutes,
      late_max_minutes: s.late_max_minutes,
      slack_bot_token: s.slack_bot_token,
      slack_channel_id: s.slack_channel_id,
    };
  }

  private async assertMember(teamId: number, userId: number) {
    const membership = await this.membershipRepo.findOne({
      where: { team_id: teamId, user_id: userId, deleted_at: IsNull() },
    });
    if (!membership) throw new ForbiddenException('팀 멤버가 아닙니다.');
    return membership;
  }

  private async assertLeader(teamId: number, userId: number) {
    const membership = await this.assertMember(teamId, userId);
    if (membership.role !== 'leader') {
      throw new ForbiddenException('팀장만 수행할 수 있습니다.');
    }
    return membership;
  }

  private generateInviteCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = randomBytes(8);
    return Array.from(bytes)
      .map((b) => chars[b % 36])
      .join('');
  }

  // 그룹 내 닉네임 설정 (본인만, null 저장 시 카카오 이름으로 복원)
  async updateNickname(
    userId: number,
    teamId: number,
    nickname: string | null,
  ) {
    const membership = await this.requireMembership(userId, teamId);
    membership.nickname = nickname?.trim() || null;
    await this.membershipRepo.save(membership);
    return { nickname: membership.nickname };
  }

  // 팀 탈퇴 (본인) — 팀장은 위임 후에만 가능, 마지막 1인이 나가면 팀도 정리
  async leave(userId: number, teamId: number) {
    const membership = await this.requireMembership(userId, teamId);
    const activeCount = await this.membershipRepo.count({
      where: { team_id: teamId, deleted_at: IsNull() },
    });
    if (membership.role === 'leader' && activeCount > 1) {
      throw new ConflictException('팀장을 넘긴 뒤 나갈 수 있어요.');
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.softRemove(membership);
      // 마지막 1인이 나가면 팀도 정리 (회의·기여도 데이터는 보존)
      if (activeCount === 1) {
        const team = await manager.findOne(Team, { where: { id: teamId } });
        if (team) await manager.softRemove(team);
      }
    });
    return { left: true };
  }

  // 팀장 위임 (팀장만)
  async transferLeader(userId: number, teamId: number, targetUserId: number) {
    const me = await this.requireLeader(userId, teamId);
    if (targetUserId === userId) {
      throw new BadRequestException('이미 팀장이에요.');
    }
    const target = await this.membershipRepo.findOne({
      where: {
        team_id: teamId,
        user_id: targetUserId,
        deleted_at: IsNull(),
      },
    });
    if (!target)
      throw new NotFoundException('해당 사용자는 팀 멤버가 아닙니다.');
    await this.dataSource.transaction(async (manager) => {
      await manager.update(TeamMembership, { id: me.id }, { role: 'member' });
      await manager.update(
        TeamMembership,
        { id: target.id },
        { role: 'leader' },
      );
    });
    return this.getTeam(teamId, userId);
  }
}
