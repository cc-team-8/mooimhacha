import { MigrationInterface, QueryRunner } from 'typeorm';

// 기여도 종합 가중치(회의 내 발언:출석)를 팀 설정에서 조정 가능하게.
// 기존엔 mapper.ts 에 0.6/0.4 하드코딩이었음 — 같은 기본값으로 컬럼화.
export class AddContributionWeights1750500000000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` ADD COLUMN \`weight_speech_in_meeting\` DECIMAL(3,2) NOT NULL DEFAULT 0.60`,
    );
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` ADD COLUMN \`weight_attend_in_meeting\` DECIMAL(3,2) NOT NULL DEFAULT 0.40`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` DROP COLUMN \`weight_attend_in_meeting\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`team_settings\` DROP COLUMN \`weight_speech_in_meeting\``,
    );
  }
}
