import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateMeetingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduled_at?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  total_minutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  // 팀장 수동 무효 처리 (누적·기여도 제외)
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_invalidated?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  meeting_type?: 'regular' | 'partial';
}
