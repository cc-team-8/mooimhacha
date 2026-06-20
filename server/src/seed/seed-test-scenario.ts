/**
 * 테스트 시나리오 시드 — 출결/사유결석/태스크 연장의 모든 경우를 담은 팀 1개 생성.
 *
 * 실행:  npm run seed:scenario            (가장 최근 카카오 로그인 사용자를 팀장으로)
 *        npm run seed:scenario -- <userId> (특정 user_id를 팀장으로)
 *
 * 카카오 로그인이라 팀원마다 계정이 다르므로, 팀장은 "실행 시점에 DB에 있는 실제
 * 카카오 사용자"로 동적으로 잡는다. 팀원은 (1) 카카오 로그인 1회 → (2) 이 명령 실행.
 * 재실행하면 기존 시드 팀(invite_code=TESTSC01)을 지우고 다시 만든다.
 */
import { AppDataSource } from '../data-source';
import type { ConfigService } from '@nestjs/config';
import { ContributionClient } from '../contributions/contribution.client';
import type {
  MeetingScoreRequest,
  TeamSettingsPayload,
} from '../contributions/contribution.types';

const INVITE = 'TESTSC01';
const pad = (n: number) => String(n).padStart(2, '0');

// 실행 시점 기준 상대 날짜 → 'YYYY-MM-DD HH:mm:ss' (재실행해도 '과거/미래' 관계 유지)
function dt(offsetDays: number, hour = 14, min = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:${pad(min)}:00`;
}

async function seed() {
  await AppDataSource.initialize();
  const ds = AppDataSource;
  try {
    // 1) 팀장 결정 — 인자 우선, 없으면 가장 최근 실제 카카오 사용자
    const argId = process.argv[2] ? Number(process.argv[2]) : null;
    const leaderRow: { id: number }[] = argId
      ? await ds.query('SELECT id FROM users WHERE id = ? AND is_deleted = 0', [
          argId,
        ])
      : // 카카오 user id는 숫자 — 더미(seed-/qa-test- 등)를 거르려 숫자 kakao_id만 실제 사용자로 본다
        await ds.query(
          "SELECT id FROM users WHERE is_deleted = 0 AND kakao_id REGEXP '^[0-9]+$' ORDER BY id DESC LIMIT 1",
        );
    const leader = leaderRow[0]?.id;
    if (!leader) {
      throw new Error(
        '팀장으로 쓸 사용자가 없습니다. 카카오 로그인을 1회 한 뒤 다시 실행하거나, user_id를 인자로 넘기세요.',
      );
    }

    // 외부 산정 엔진 클라이언트 — .env 의 CONTRIBUTION_SERVICE_URL 로 /pipeline/score 호출
    const client = new ContributionClient({
      get: (k: string) => process.env[k],
    } as unknown as ConfigService);
    if (!client.configured) {
      throw new Error(
        'CONTRIBUTION_SERVICE_URL 미설정 — server/.env 에 추가하고 엔진(예: http://localhost:8000)을 띄운 뒤 다시 실행하세요.',
      );
    }

    await ds.transaction(async (m) => {
      // 2) 기존 시드 정리 (재실행 대비) — FK 느슨하지만 안전하게 역순 삭제
      const old: { id: number }[] = await m.query(
        'SELECT id FROM teams WHERE invite_code = ? LIMIT 1',
        [INVITE],
      );
      const oldId = old[0]?.id;
      if (oldId) {
        await m.query(
          'DELETE FROM task_extension_requests WHERE action_item_id IN (SELECT id FROM action_items WHERE team_id = ?)',
          [oldId],
        );
        await m.query('DELETE FROM action_items WHERE team_id = ?', [oldId]);
        await m.query(
          'DELETE FROM absence_consents WHERE absence_id IN (SELECT id FROM meeting_absences WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?))',
          [oldId],
        );
        await m.query(
          'DELETE FROM meeting_absences WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?)',
          [oldId],
        );
        await m.query(
          'DELETE FROM contribution_scores WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?)',
          [oldId],
        );
        await m.query(
          'DELETE FROM presence_events WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?)',
          [oldId],
        );
        await m.query('DELETE FROM meetings WHERE team_id = ?', [oldId]);
        await m.query('DELETE FROM team_memberships WHERE team_id = ?', [
          oldId,
        ]);
        await m.query('DELETE FROM team_settings WHERE team_id = ?', [oldId]);
        await m.query('DELETE FROM teams WHERE id = ?', [oldId]);
      }
      await m.query("DELETE FROM users WHERE kakao_id LIKE 'seed-member-%'");

      // 3) 더미 팀원 3명
      const insertId = async (
        sql: string,
        params: unknown[],
      ): Promise<number> => {
        const r = await m.query<{ insertId: number }>(sql, params);
        return r.insertId;
      };
      const mkUser = (kakao: string, name: string): Promise<number> =>
        insertId(
          'INSERT INTO users (kakao_id, name, is_deleted) VALUES (?, ?, 0)',
          [kakao, name],
        );
      const m1 = await mkUser('seed-member-1', '팀원1');
      const m2 = await mkUser('seed-member-2', '팀원2');
      const m3 = await mkUser('seed-member-3', '팀원3');

      // 4) 팀 + 설정 + 멤버십
      const team = await insertId(
        'INSERT INTO teams (name, course_name, created_by, invite_code) VALUES (?, ?, ?, ?)',
        ['[테스트] 전체 시나리오', '테스트 과목', leader, INVITE],
      );
      await m.query('INSERT INTO team_settings (team_id) VALUES (?)', [team]);
      await m.query(
        `INSERT INTO team_memberships (team_id, user_id, role, joined_at) VALUES
          (?, ?, 'leader', NOW()), (?, ?, 'member', NOW()),
          (?, ?, 'member', NOW()), (?, ?, 'member', NOW())`,
        [team, leader, team, m1, team, m2, team, m3],
      );

      // 5) 완료 회의(출결) + 예정 회의(회의 시작 버튼 확인용)
      const mtg = await insertId(
        `INSERT INTO meetings (team_id, scheduled_at, total_minutes, topic, status, t0_timestamp, ended_at, meeting_type, is_invalidated)
         VALUES (?, ?, 60, '1차 정기 회의', 'ended', ?, ?, 'regular', 0)`,
        [team, dt(-4, 14), dt(-4, 14), dt(-4, 15)],
      );
      await m.query(
        `INSERT INTO meetings (team_id, scheduled_at, total_minutes, topic, status, meeting_type)
         VALUES (?, ?, 30, '2차 정기 회의', 'scheduled', 'regular')`,
        [team, dt(6, 14)],
      );

      // 6) 출결 원시 데이터: 팀장=정시 입장·발화 많음, 팀원1=10분 지각·발화 적음,
      //    팀원2·3=결석(presence 없음). 점수는 직접 박지 않고 실제 산정 로직으로 계산한다.
      const presence = [
        { user_id: leader, offset: 0 },
        { user_id: m1, offset: 600000 }, // 10분 지각
      ];
      const utter = [
        {
          user_id: leader,
          char_count: 400,
          text: '발표 자료 방향을 논의했습니다.',
          off: 60000,
        },
        {
          user_id: leader,
          char_count: 350,
          text: '진행 일정을 공유했습니다.',
          off: 200000,
        },
        {
          user_id: m1,
          char_count: 250,
          text: '문서 정리 관련 의견입니다.',
          off: 700000,
        },
      ];
      await m.query(
        `INSERT INTO presence_events (user_id, meeting_id, event_type, timestamp_offset_ms) VALUES (?, ?, 'join', ?), (?, ?, 'join', ?)`,
        [leader, mtg, presence[0].offset, m1, mtg, presence[1].offset],
      );
      for (const u of utter) {
        await m.query(
          `INSERT INTO utterances (meeting_id, user_id, text, char_count, confidence, started_at_offset_ms, ended_at_offset_ms)
           VALUES (?, ?, ?, ?, 0.95, ?, ?)`,
          [mtg, u.user_id, u.text, u.char_count, u.off, u.off + 30000],
        );
      }
      // 실제 산정 로직(내장 스코어러 = 외부 API 미설정 시 동작과 동일 공식)으로 ① 회의 점수 계산
      const settings: TeamSettingsPayload = {
        punctuality_grace_ratio: 0.1,
        presence_grace_seconds: 30,
        max_utterance_chars: 500,
        deadline_penalty_curve: 'standard',
        absent_meeting_handling: 'exclude',
        min_meeting_minutes: 5,
        final_task_weight: 0.5,
        weight_speech_in_meeting: 0.6,
        weight_attend_in_meeting: 0.4,
        leader_bonus_multiplier: 1.0,
      };
      const payload: MeetingScoreRequest = {
        meeting: {
          id: mtg,
          total_minutes: 60,
          scheduled_at: dt(-4, 14),
          t0_timestamp: dt(-4, 14),
          ended_at: dt(-4, 15),
          meeting_type: 'regular',
        },
        team_settings: settings,
        participant_user_ids: [leader, m1],
        utterances: utter.map((u) => ({
          user_id: u.user_id,
          char_count: u.char_count,
          agenda_id: null,
          confidence: 0.95,
        })),
        agendas: [],
        presence_events: presence.map((p) => ({
          user_id: p.user_id,
          event_type: 'join',
          disconnect_classification: null,
          timestamp_offset_ms: p.offset,
        })),
        anomaly_events: [],
      };
      const res = await client.computeMeetingScores(payload);
      if (!res) {
        throw new Error(
          '엔진 산정에 실패했습니다. 엔진 서버가 떠 있는지 확인하세요.',
        );
      }
      for (const r of res.scores) {
        await m.query(
          `INSERT INTO contribution_scores (user_id, meeting_id, speech_ratio, speech_consistency, attendance_ratio, punctuality_score, meeting_score, confidence_level, excluded_indicators)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            r.user_id,
            mtg,
            r.speech_ratio,
            r.speech_consistency,
            r.attendance_ratio,
            r.punctuality_score,
            r.meeting_score,
            r.confidence_level,
            r.excluded_indicators
              ? JSON.stringify(r.excluded_indicators)
              : null,
          ],
        );
      }
      // 결석 사유: 팀원2 pending(팀장에게 미처리 !), 팀원3 approved(과반 동의 → 출석 인정)
      await m.query(
        "INSERT INTO meeting_absences (meeting_id, user_id, reason, status) VALUES (?, ?, '병원 진료가 있었습니다.', 'pending')",
        [mtg, m2],
      );
      const abs3 = await insertId(
        "INSERT INTO meeting_absences (meeting_id, user_id, reason, status) VALUES (?, ?, '가족 경조사 참석', 'approved')",
        [mtg, m3],
      );
      await m.query(
        'INSERT INTO absence_consents (absence_id, voter_id) VALUES (?, ?), (?, ?)',
        [abs3, leader, abs3, m1],
      );

      // 7) 태스크 + 연장 요청
      const mkTask = (
        assignee: number,
        desc: string,
        due: string,
        status: string,
        difficulty: number,
        completedAt: string | null = null,
      ): Promise<number> =>
        insertId(
          `INSERT INTO action_items (team_id, assignee_id, description, due_date, completed_at, status, difficulty, confirmed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          [team, assignee, desc, due, completedAt, status, difficulty],
        );
      // 팀장 본인: 기한 지남·요청 없음 → "연장 요청" 버튼
      await mkTask(leader, '발표 자료 초안 작성', dt(-2, 18), 'in_progress', 2);
      // 팀원1: 기한 지남·pending → 팀장에게 수락/거절 + 태스크 메뉴 !
      const t2 = await mkTask(m1, 'API 문서 정리', dt(-2, 18), 'todo', 2);
      // 팀원2: approved(기한 미래로 연장됨) → 정상 표시
      const t3 = await mkTask(
        m2,
        '디자인 시안 검토',
        dt(11, 18),
        'in_progress',
        3,
      );
      // 팀장 본인: 기한 지남·rejected → "연장 거절됨 · 재요청" 버튼
      const t4 = await mkTask(
        leader,
        '테스트 케이스 작성',
        dt(-2, 18),
        'in_progress',
        1,
      );
      // 완료 태스크(대시보드 통계용)
      await mkTask(leader, '회의록 정리', dt(-5, 18), 'done', 1, dt(-5, 17));

      await m.query(
        `INSERT INTO task_extension_requests (action_item_id, requester_id, requested_due_date, reason, status) VALUES
          (?, ?, ?, '자료 조사가 더 필요합니다.', 'pending'),
          (?, ?, ?, '시안 피드백 반영에 시간이 필요합니다.', 'approved'),
          (?, ?, ?, '개인 사정으로 연기 요청합니다.', 'rejected')`,
        [t2, m1, dt(6, 18), t3, m2, dt(11, 18), t4, leader, dt(6, 18)],
      );

      console.log(
        `✓ 시드 완료 — 팀 id=${team} '[테스트] 전체 시나리오' (팀장 user_id=${leader}, 초대코드 ${INVITE})`,
      );
    });
  } finally {
    await ds.destroy();
  }
}

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('시드 실패:', e);
    process.exit(1);
  });
