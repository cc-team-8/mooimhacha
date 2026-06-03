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
    private dataSource: DataSource,
  ) {}

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

    const membersByTeam = new Map<number, string[]>();
    for (const m of allMemberships) {
      const tid = Number(m.team_id);
      if (!membersByTeam.has(tid)) membersByTeam.set(tid, []);
      membersByTeam.get(tid)!.push(userMap.get(Number(m.user_id)) ?? '?');
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

    return {
      id: Number(team.id),
      name: team.name,
      course_name: team.course_name,
      invite_code: team.invite_code,
      members: memberships.map((m) => ({
        user_id: Number(m.user_id),
        role: m.role,
      })),
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
      existing.deleted_at = null as unknown as Date;
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
      leader_bonus_multiplier: Number(s.leader_bonus_multiplier),
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
}
