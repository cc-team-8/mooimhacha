import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateNicknameDto {
  @ApiPropertyOptional({ example: '홍길동', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string | null;
}
