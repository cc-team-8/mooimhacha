import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DeadlinePenaltyCurve = 'standard' | 'lenient' | 'strict';
export type AbsentMeetingHandling = 'exclude' | 'zero' | 'attendance_only';
export type ContributionVisibility = 'team' | 'leader' | 'self';

@Entity('team_settings')
export class TeamSettings {
  @PrimaryColumn({ type: 'bigint' })
  team_id!: number;

  @Column({ type: 'decimal', precision: 4, scale: 3, default: 0.1 })
  punctuality_grace_ratio!: number;

  @Column({ type: 'int', default: 500 })
  max_utterance_chars!: number;

  @Column({ type: 'int', default: 30 })
  presence_grace_seconds!: number;

  @Column({
    type: 'enum',
    enum: ['exclude', 'zero', 'attendance_only'],
    default: 'exclude',
  })
  absent_meeting_handling!: AbsentMeetingHandling;

  @Column({
    type: 'enum',
    enum: ['standard', 'lenient', 'strict'],
    default: 'standard',
  })
  deadline_penalty_curve!: DeadlinePenaltyCurve;

  @Column({
    type: 'enum',
    enum: ['team', 'self', 'leader'],
    default: 'team',
  })
  contribution_visibility!: ContributionVisibility;

  @Column({ type: 'int', default: 5 })
  min_meeting_minutes!: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.5 })
  final_task_weight!: number;

  // 회의 내 발언:출석 가중치 (합 1.0). 종합 기여 = 발언×(1-task)×ws + 출석×(1-task)×wa + 태스크×task
  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.6 })
  weight_speech_in_meeting!: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 0.4 })
  weight_attend_in_meeting!: number;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 1.0 })
  leader_bonus_multiplier!: number;

  // 지각 기준(분) — 회의 시작 후 이 시간 초과 입장 시 '지각' (출결 표시용, 산정 엔진과 별개)
  @Column({ type: 'int', default: 5 })
  late_threshold_minutes!: number;

  // 지각 최대 인정 시간(분) — 회의 시작 후 이 시간 초과 입장 시 '결석'(0이면 상한 없음, 표시용)
  @Column({ type: 'int', default: 0 })
  late_max_minutes!: number;

  @Column({ type: 'varchar', length: 200, nullable: true })
  slack_bot_token!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  slack_channel_id!: string | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
