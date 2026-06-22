import { MigrationInterface, QueryRunner } from 'typeorm';

// 지각 최대 인정 시간(분) — 회의 시작 후 이 시간 초과 입장 시 '결석' 처리.
// 0이면 상한 없음(비활성, 기존 동작 유지).
export class AddLateMaxMinutes1750800000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` ADD COLUMN \`late_max_minutes\` INT NOT NULL DEFAULT 0`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` DROP COLUMN \`late_max_minutes\``,
    );
  }
}
