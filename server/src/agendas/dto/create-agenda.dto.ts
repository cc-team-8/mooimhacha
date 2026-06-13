import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { AgendaSource } from '../../entities/agenda.entity';

export class CreateAgendaDto {
  @ApiProperty({ description: '안건 제목' })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ description: '예상 시간(분)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  estimated_minutes?: number;

  @ApiPropertyOptional({ enum: ['ai_recommended', 'manual', 'ad_hoc'] })
  @IsOptional()
  @IsIn(['ai_recommended', 'manual', 'ad_hoc'])
  source?: AgendaSource;
}
