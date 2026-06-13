import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import type { AgendaStatus } from '../../entities/agenda.entity';

export class UpdateAgendaDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  estimated_minutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  order_index?: number;

  @ApiPropertyOptional({ enum: ['pending', 'active', 'done'] })
  @IsOptional()
  @IsIn(['pending', 'active', 'done'])
  status?: AgendaStatus;
}
