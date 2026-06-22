import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TeamsService } from './teams.service';
import { CreateTeamDto } from './dto/create-team.dto';
import { UpdateTeamDto } from './dto/update-team.dto';
import { JoinTeamDto } from './dto/join-team.dto';
import { UpdateTeamSettingsDto } from './dto/update-team-settings.dto';
import { TransferLeaderDto } from './dto/transfer-leader.dto';
import { UpdateNicknameDto } from './dto/update-nickname.dto';

@ApiTags('팀')
@Controller('teams')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class TeamsController {
  constructor(private teamsService: TeamsService) {}

  @Get()
  @ApiOperation({ summary: '내 팀 목록' })
  getMyTeams(@Request() req: { user: { id: number } }) {
    return this.teamsService.getMyTeams(req.user.id);
  }

  @Post()
  @ApiOperation({ summary: '팀 생성' })
  createTeam(
    @Request() req: { user: { id: number } },
    @Body() dto: CreateTeamDto,
  ) {
    return this.teamsService.createTeam(req.user.id, dto);
  }

  // /join은 /:id보다 먼저 선언해야 올바르게 라우팅된다
  @Post('join')
  @ApiOperation({ summary: '초대 코드로 팀 합류' })
  joinTeam(@Request() req: { user: { id: number } }, @Body() dto: JoinTeamDto) {
    return this.teamsService.joinTeam(req.user.id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: '팀 상세' })
  getTeam(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.getTeam(id, req.user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: '팀 수정 (팀장만)' })
  updateTeam(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teamsService.updateTeam(id, req.user.id, dto);
  }

  @Post(':id/invite-code')
  @ApiOperation({ summary: '초대 코드 재발급 (팀장만)' })
  regenerateInviteCode(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.regenerateInviteCode(id, req.user.id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: '팀 삭제 (팀장만)' })
  deleteTeam(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.deleteTeam(id, req.user.id);
  }

  @Patch(':id/leader')
  @ApiOperation({ summary: '팀장 위임 (팀장만)' })
  transferLeader(
    @Param('id', ParseIntPipe) teamId: number,
    @Request() req: { user: { id: number } },
    @Body() dto: TransferLeaderDto,
  ) {
    return this.teamsService.transferLeader(req.user.id, teamId, dto.user_id);
  }

  // 주의: ':id/members/:userId'보다 먼저 선언해야 'me'가 숫자 파라미터로 매칭되지 않음
  @Patch(':id/members/me/nickname')
  @ApiOperation({
    summary: '그룹 내 닉네임 설정 (본인), null이면 카카오 이름으로 복원',
  })
  updateNickname(
    @Param('id', ParseIntPipe) teamId: number,
    @Request() req: { user: { id: number } },
    @Body() dto: UpdateNicknameDto,
  ) {
    return this.teamsService.updateNickname(
      req.user.id,
      teamId,
      dto.nickname ?? null,
    );
  }

  @Delete(':id/members/me')
  @ApiOperation({ summary: '팀 탈퇴 (본인) — 팀장은 위임 후 가능' })
  leave(
    @Param('id', ParseIntPipe) teamId: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.leave(req.user.id, teamId);
  }

  @Delete(':id/members/:userId')
  @HttpCode(204)
  @ApiOperation({ summary: '멤버 탈퇴 / 추방' })
  removeMember(
    @Param('id', ParseIntPipe) teamId: number,
    @Param('userId', ParseIntPipe) targetUserId: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.removeMember(teamId, targetUserId, req.user.id);
  }

  @Get(':id/settings')
  @ApiOperation({ summary: '팀 설정 조회 (팀 멤버)' })
  getSettings(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
  ) {
    return this.teamsService.getSettings(id, req.user.id);
  }

  @Patch(':id/settings')
  @ApiOperation({ summary: '팀 설정 수정 (팀장만)' })
  updateSettings(
    @Param('id', ParseIntPipe) id: number,
    @Request() req: { user: { id: number } },
    @Body() dto: UpdateTeamSettingsDto,
  ) {
    return this.teamsService.updateSettings(id, req.user.id, dto);
  }
}
