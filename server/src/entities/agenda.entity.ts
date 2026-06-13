import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type AgendaStatus = 'pending' | 'active' | 'done';
export type AgendaSource = 'ai_recommended' | 'manual' | 'ad_hoc';

// 핵심 차별화 기능(★) — 안건 추적
@Entity('agendas')
// getActiveAgendaId가 발화 1건마다 meeting_id+status로 조회 — 핫패스 인덱스
@Index(['meeting_id', 'status'])
export class Agenda {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  id!: number;

  @Column({ type: 'bigint', unsigned: true })
  meeting_id!: number;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'int', default: 0 })
  estimated_minutes!: number;

  @Column({ type: 'int', default: 0 })
  order_index!: number;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: AgendaStatus;

  @Column({ type: 'int', nullable: true })
  started_at_offset_ms!: number | null;

  @Column({ type: 'int', nullable: true })
  ended_at_offset_ms!: number | null;

  @Column({ type: 'int', nullable: true })
  actual_minutes!: number | null;

  @Column({ type: 'varchar', length: 16, default: 'manual' })
  source!: AgendaSource;

  // 완료 시 LLM 생성 요약
  @Column({ type: 'text', nullable: true })
  summary!: string | null;
}
