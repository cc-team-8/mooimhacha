import { Body, Controller, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ContributionService } from './contribution.service';
import { CalculateContributionDto } from './dto/calculate-contribution.dto';

@Controller('teams/:teamId/contribution')
@UseGuards(JwtAuthGuard)
export class ContributionController {
  constructor(private readonly contributionService: ContributionService) {}

  /**
   * POST /teams/:teamId/contribution/calculate
   * 팀원의 기여도를 계산한다.
   * 요청 바디: CalculateContributionDto (meetings 배열 + is_leader)
   */
  @Post('calculate')
  async calculate(
    @Param('teamId', ParseIntPipe) teamId: number,
    @Body() dto: CalculateContributionDto,
  ): Promise<unknown> {
    return this.contributionService.calculate(teamId, dto);
  }
}
