import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateTeamSettingsDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 0.3 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(0.3)
  punctuality_grace_ratio?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_utterance_chars?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  presence_grace_seconds?: number;

  @ApiPropertyOptional({ enum: ['exclude', 'zero', 'attendance_only'] })
  @IsOptional()
  @IsEnum(['exclude', 'zero', 'attendance_only'])
  absent_meeting_handling?: 'exclude' | 'zero' | 'attendance_only';

  @ApiPropertyOptional({ enum: ['standard', 'lenient', 'strict'] })
  @IsOptional()
  @IsEnum(['standard', 'lenient', 'strict'])
  deadline_penalty_curve?: 'standard' | 'lenient' | 'strict';

  @ApiPropertyOptional({ enum: ['team', 'self', 'leader'] })
  @IsOptional()
  @IsEnum(['team', 'self', 'leader'])
  contribution_visibility?: 'team' | 'self' | 'leader';

  @ApiPropertyOptional({ minimum: 0, maximum: 240 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  min_meeting_minutes?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1.0,
    description: '종합에서 태스크 비중',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1.0)
  final_task_weight?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1.0,
    description: '회의 내 발언 가중치 (출석과 합 1.0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1.0)
  weight_speech_in_meeting?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1.0,
    description: '회의 내 출석 가중치 (발언과 합 1.0)',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1.0)
  weight_attend_in_meeting?: number;

  @ApiPropertyOptional({ maximum: 1.0 })
  @IsOptional()
  @IsNumber()
  @Max(1.0)
  leader_bonus_multiplier?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 240,
    description: '지각 기준(분)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  late_threshold_minutes?: number;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 240,
    description: '지각 최대 인정 시간(분) — 초과 입장 시 결석. 0이면 상한 없음',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  late_max_minutes?: number;

  @ApiPropertyOptional({ example: 'xoxb-...', description: 'Slack Bot Token' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  slack_bot_token?: string;

  @ApiPropertyOptional({ example: 'C0123456', description: 'Slack 채널 ID' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  slack_channel_id?: string;
}
