import { Injectable, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { TeamSettings } from '../entities/team-settings.entity';
import { CalculateContributionDto } from './dto/calculate-contribution.dto';

@Injectable()
export class ContributionService {
  private readonly apiUrl: string;

  constructor(
    private readonly httpService: HttpService,
    @InjectRepository(TeamSettings)
    private readonly settingsRepo: Repository<TeamSettings>,
    private readonly config: ConfigService,
  ) {
    // 환경변수 CONTRIBUTION_API_URL 없으면 기본값 사용
    this.apiUrl = this.config.get<string>('CONTRIBUTION_API_URL') ?? 'http://localhost:8000';
  }

  async calculate(teamId: number, dto: CalculateContributionDto): Promise<unknown> {
    // 1. DB에서 팀 설정 조회
    const settings = await this.settingsRepo.findOne({ where: { team_id: teamId } });
    if (!settings) throw new NotFoundException('팀 설정을 찾을 수 없습니다.');

    // 2. TeamSettings DB 필드 → Python API 필드 매핑
    const cfg = this.mapSettings(settings);

    // 3. Python FastAPI /pipeline/score 호출
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.apiUrl}/pipeline/score`, {
          meetings:  dto.meetings,
          is_leader: dto.is_leader ?? false,
          cfg,
        }),
      );
      return response.data;
    } catch (err: unknown) {
      const error = err as { message?: string; response?: { data?: unknown } };
      console.error('FastAPI 호출 에러:', JSON.stringify(error.response?.data, null, 2));
      throw new InternalServerErrorException(
        '기여도 계산 서버 호출에 실패했습니다. 서버가 실행 중인지 확인해주세요.',
      );
    }
  }

  // TeamSettings DB 필드 → Python TeamSettings 필드 변환
  private mapSettings(s: TeamSettings): Record<string, unknown> {
    return {
      weight_task_in_final:     Number(s.final_task_weight),
      punctuality_grace_ratio:  Number(s.punctuality_grace_ratio),
      action_chars_limit:       s.max_utterance_chars,
      absence_grace_sec:        s.presence_grace_seconds,
      // 'standard' → 'normal' (Python API 용어 맞춤)
      deadline_mode:            s.deadline_penalty_curve === 'standard' ? 'normal' : s.deadline_penalty_curve,
      // 분 → 초 변환
      min_meeting_sec:          s.min_meeting_minutes * 60,
      // 'team' → 'all' (Python API 용어 맞춤)
      score_visibility:         s.contribution_visibility === 'team' ? 'all' : s.contribution_visibility,
      // multiplier(1.2) → bonus(0.2) 변환: bonus = multiplier - 1
      leader_bonus:             Number(s.leader_bonus_multiplier) - 1,
    };
  }
}
