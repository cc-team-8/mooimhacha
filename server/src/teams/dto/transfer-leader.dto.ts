import { ApiProperty } from '@nestjs/swagger';
import { IsInt } from 'class-validator';

export class TransferLeaderDto {
  @ApiProperty({ description: '팀장을 넘길 멤버의 user_id' })
  @IsInt()
  user_id!: number;
}
