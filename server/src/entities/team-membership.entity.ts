import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('team_memberships')
@Unique(['team_id', 'user_id'])
export class TeamMembership {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: number;

  @Column({ type: 'bigint' })
  team_id!: number;

  @Column({ type: 'bigint' })
  user_id!: number;

  @Column({ type: 'enum', enum: ['leader', 'member'], default: 'member' })
  role!: 'leader' | 'member';

  @Column({ type: 'varchar', length: 50, nullable: true, default: null })
  nickname!: string | null;

  @Column({ type: 'datetime' })
  joined_at!: Date;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;

  @DeleteDateColumn()
  deleted_at!: Date | null;
}
