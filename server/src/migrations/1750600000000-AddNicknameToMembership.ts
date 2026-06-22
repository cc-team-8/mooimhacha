import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNicknameToMembership1750600000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`team_memberships\`
      ADD COLUMN \`nickname\` VARCHAR(50) NULL DEFAULT NULL AFTER \`role\`
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE \`team_memberships\`
      DROP COLUMN \`nickname\`
    `);
  }
}
