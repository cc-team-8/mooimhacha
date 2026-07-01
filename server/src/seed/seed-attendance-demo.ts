/**
 * 출결 데모 시나리오 시드 — 결석/사유결석/지각이 각각 다른 회의에 분산된
 * 회의 3개(전부 종료)와, 마감 상태가 다양한 태스크 묶음을 생성한다.
 *
 * 목적: 클라이언트 리포트 화면(REQUIRED_MEETINGS=3 잠금 해제)에서 출석 축
 * 점수가 결석/사유결석/지각별로 어떻게 갈리는지 바로 확인하기 위한 데모 데이터.
 * seed-test-scenario.ts(기존 종합 시나리오)와는 별개로 동작하며 서로 다른
 * 초대코드를 쓰므로 함께 실행해도 충돌하지 않는다.
 *
 * 실행:  npm run seed:attendance-demo            (가장 최근 카카오 로그인 사용자를 팀장으로)
 *        npm run seed:attendance-demo -- <userId> (특정 user_id를 팀장으로)
 *
 * 재실행하면 기존 시드 팀(invite_code=ATTDEMO1)을 지우고 다시 만든다.
 */
import { AppDataSource } from '../data-source';
import type { ConfigService } from '@nestjs/config';
import { ContributionClient } from '../contributions/contribution.client';
import type {
  MeetingScoreRequest,
  TeamSettingsPayload,
} from '../contributions/contribution.types';

const INVITE = 'ATTDEMO1';
const pad = (n: number) => String(n).padStart(2, '0');

// 실행 시점 기준 상대 날짜 → 'YYYY-MM-DD HH:mm:ss' (재실행해도 '과거/미래' 관계 유지)
function dt(offsetDays: number, hour = 14, min = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(hour)}:${pad(min)}:00`;
}

// 회의 1건의 결과를 산정 엔진에 보내 ①(contribution_scores)에 저장.
// presence/utterance를 그대로 받아 deriveMemberData가 absent/late_sec 등을
// 자동 파생하므로, 결석자는 presence row를 안 넣는 것만으로 absent=true가 된다.
async function scoreAndStoreMeeting(
  m: { query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T> },
  client: ContributionClient,
  args: {
    meetingId: number;
    totalMinutes: number;
    scheduledAt: string;
    t0: string;
    endedAt: string;
    participantIds: number[];
    presence: {
      user_id: number;
      offsetMs: number;
      eventType?: 'join' | 'leave' | 'disconnect' | 'reconnect';
    }[];
    utterances: { user_id: number; char_count: number; off: number }[];
    settings: TeamSettingsPayload;
    // 이 회의에 대해 사유 지각이 승인된 멤버 — ①(contribution_scores) 계산에도
    // 반영해야 지각 페널티 면제가 attendance_ratio에 실제로 나타난다. 빠뜨리면
    // ①은 일반 지각과 동일하게 감점된 값으로 저장되고, 화면(리포트)에는 그 ①값이
    // 그대로 노출되어 "승인됐는데 왜 점수가 그대로냐"는 불일치가 생긴다.
    excusedLateUserIds?: number[];
  },
): Promise<void> {
  const payload: MeetingScoreRequest = {
    meeting: {
      id: args.meetingId,
      total_minutes: args.totalMinutes,
      scheduled_at: args.scheduledAt,
      t0_timestamp: args.t0,
      ended_at: args.endedAt,
      meeting_type: 'regular',
    },
    team_settings: args.settings,
    participant_user_ids: args.participantIds,
    excused_late_user_ids: args.excusedLateUserIds ?? [],
    utterances: args.utterances.map((u) => ({
      user_id: u.user_id,
      char_count: u.char_count,
      agenda_id: null,
      confidence: 0.95,
    })),
    agendas: [],
    // event_type을 'join'으로 고정하면 leave/disconnect(자리비움) 이벤트를 ①점수
    // 계산 입력으로 전달할 방법이 없어, DB에 저장된 실제 presence_events(②계산이
    // 다시 읽는 원본)와 ①(contribution_scores) 계산 입력이 서로 달라지는 문제가
    // 있었다 — 조퇴해도 ①은 "끝까지 있었음"으로 계산되는 버그의 원인.
    presence_events: args.presence.map((p) => ({
      user_id: p.user_id,
      event_type: p.eventType ?? 'join',
      disconnect_classification: null,
      timestamp_offset_ms: p.offsetMs,
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
        args.meetingId,
        r.speech_ratio,
        r.speech_consistency,
        r.attendance_ratio,
        r.punctuality_score,
        r.meeting_score,
        r.confidence_level,
        r.excluded_indicators ? JSON.stringify(r.excluded_indicators) : null,
      ],
    );
  }
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
      : await ds.query(
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
      // 2) 기존 시드 정리 (재실행 대비)
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
          'DELETE FROM utterances WHERE meeting_id IN (SELECT id FROM meetings WHERE team_id = ?)',
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
      await m.query("DELETE FROM users WHERE kakao_id LIKE 'attdemo-member-%'");

      // 3) 더미 팀원 3명 — 각자 역할이 분명하도록 이름에 패턴을 담는다
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
      const dy = await mkUser('attdemo-member-1', '김도윤'); // 항상 정상 참석
      const sy = await mkUser('attdemo-member-2', '이서연'); // 결석/사유결석 담당
      const jh = await mkUser('attdemo-member-3', '박지훈'); // 지각 담당

      // 4) 팀 + 설정 + 멤버십
      const team = await insertId(
        'INSERT INTO teams (name, course_name, created_by, invite_code) VALUES (?, ?, ?, ?)',
        ['[데모] 출결 케이스 모음', '클라우드 컴퓨팅', leader, INVITE],
      );
      // 지각 기준 5분 / 최대 인정 15분 — 신규 절대시간 기준 로직이 또렷이 드러나는 값
      await m.query(
        `INSERT INTO team_settings
           (team_id, late_threshold_minutes, late_max_minutes,
            weight_speech_in_meeting, weight_attend_in_meeting, final_task_weight)
         VALUES (?, 5, 15, 0.5, 0.5, 0.5)`,
        [team],
      );
      await m.query(
        `INSERT INTO team_memberships (team_id, user_id, role, joined_at) VALUES
          (?, ?, 'leader', NOW()), (?, ?, 'member', NOW()),
          (?, ?, 'member', NOW()), (?, ?, 'member', NOW())`,
        [team, leader, team, dy, team, sy, team, jh],
      );

      const settings: TeamSettingsPayload = {
        punctuality_grace_ratio: 0.1,
        presence_grace_seconds: 30,
        max_utterance_chars: 500,
        deadline_penalty_curve: 'standard',
        absent_meeting_handling: 'exclude',
        min_meeting_minutes: 5,
        final_task_weight: 0.5,
        weight_speech_in_meeting: 0.5,
        weight_attend_in_meeting: 0.5,
        leader_bonus_multiplier: 1.0,
        late_threshold_minutes: 5,
        late_max_minutes: 15,
      };

      // ── 회의 1 (5일 전, 60분): 이서연 무단 결석 / 박지훈 사유 지각(승인) ──
      const mtg1 = await insertId(
        `INSERT INTO meetings (team_id, scheduled_at, total_minutes, topic, status, t0_timestamp, ended_at, meeting_type, is_invalidated)
         VALUES (?, ?, 60, '1차 정기 회의 - 요구사항 정의', 'ended', ?, ?, 'regular', 0)`,
        [team, dt(-5, 14), dt(-5, 14), dt(-5, 15)],
      );
      // 팀장·김도윤 정시 입장, 박지훈 12분 지각(720000ms), 이서연 입장 기록 없음(결석)
      await m.query(
        `INSERT INTO presence_events (user_id, meeting_id, event_type, timestamp_offset_ms) VALUES
           (?, ?, 'join', 0), (?, ?, 'join', 0), (?, ?, 'join', 720000)`,
        [leader, mtg1, dy, mtg1, jh, mtg1],
      );
      const utter1 = [
        { user_id: leader, char_count: 420, off: 60000 },
        { user_id: leader, char_count: 300, off: 1800000 },
        { user_id: dy, char_count: 380, off: 120000 },
        { user_id: dy, char_count: 260, off: 2400000 },
        { user_id: jh, char_count: 180, off: 1500000 }, // 지각해서 적은 발언량
      ];
      for (const u of utter1) {
        await m.query(
          `INSERT INTO utterances (meeting_id, user_id, text, char_count, confidence, started_at_offset_ms, ended_at_offset_ms)
           VALUES (?, ?, '데모 발화 내용입니다.', ?, 0.95, ?, ?)`,
          [mtg1, u.user_id, u.char_count, u.off, u.off + 30000],
        );
      }
      await scoreAndStoreMeeting(m, client, {
        meetingId: mtg1,
        totalMinutes: 60,
        scheduledAt: dt(-5, 14),
        t0: dt(-5, 14),
        endedAt: dt(-5, 15),
        participantIds: [leader, dy, sy, jh],
        presence: [
          { user_id: leader, offsetMs: 0 },
          { user_id: dy, offsetMs: 0 },
          { user_id: jh, offsetMs: 720000 },
        ],
        utterances: utter1,
        settings,
        // 박지훈의 사유 지각이 (아래에서) 승인될 예정이므로 ①계산에도 미리 반영한다.
        // 그래야 화면(리포트)의 attendance_ratio가 지각 페널티 면제된 값으로 저장된다.
        excusedLateUserIds: [jh],
      });
      // 박지훈의 지각 사유 → 팀장·김도윤 동의로 승인(사유 지각: 지각 감점만 면제)
      const absJh1 = await insertId(
        "INSERT INTO meeting_absences (meeting_id, user_id, reason, status) VALUES (?, ?, '직전 수업이 늦게 끝나 지각했습니다.', 'approved')",
        [mtg1, jh],
      );
      await m.query(
        'INSERT INTO absence_consents (absence_id, voter_id) VALUES (?, ?), (?, ?)',
        [absJh1, leader, absJh1, dy],
      );
      // 이서연은 결석 사유를 입력하지 않은 무단 결석 상태로 그대로 둔다(=비교 기준점)

      // ── 회의 2 (3일 전, 50분): 이서연 사유 결석(승인) / 박지훈 일반 지각(사유 없음) ──
      const mtg2 = await insertId(
        `INSERT INTO meetings (team_id, scheduled_at, total_minutes, topic, status, t0_timestamp, ended_at, meeting_type, is_invalidated)
         VALUES (?, ?, 50, '2차 정기 회의 - 화면 설계', 'ended', ?, ?, 'regular', 0)`,
        [team, dt(-3, 15), dt(-3, 15), dt(-3, 15, 50)],
      );
      // 팀장·김도윤 정시, 박지훈 8분 지각(480000ms), 이서연 입장 없음(사유 결석 대상)
      await m.query(
        `INSERT INTO presence_events (user_id, meeting_id, event_type, timestamp_offset_ms) VALUES
           (?, ?, 'join', 0), (?, ?, 'join', 0), (?, ?, 'join', 480000)`,
        [leader, mtg2, dy, mtg2, jh, mtg2],
      );
      const utter2 = [
        { user_id: leader, char_count: 350, off: 60000 },
        { user_id: dy, char_count: 340, off: 90000 },
        { user_id: dy, char_count: 200, off: 1500000 },
        { user_id: jh, char_count: 220, off: 1000000 },
      ];
      for (const u of utter2) {
        await m.query(
          `INSERT INTO utterances (meeting_id, user_id, text, char_count, confidence, started_at_offset_ms, ended_at_offset_ms)
           VALUES (?, ?, '데모 발화 내용입니다.', ?, 0.95, ?, ?)`,
          [mtg2, u.user_id, u.char_count, u.off, u.off + 30000],
        );
      }
      await scoreAndStoreMeeting(m, client, {
        meetingId: mtg2,
        totalMinutes: 50,
        scheduledAt: dt(-3, 15),
        t0: dt(-3, 15),
        endedAt: dt(-3, 15, 50),
        participantIds: [leader, dy, sy, jh],
        presence: [
          { user_id: leader, offsetMs: 0 },
          { user_id: dy, offsetMs: 0 },
          { user_id: jh, offsetMs: 480000 },
        ],
        utterances: utter2,
        settings,
      });
      // 이서연의 결석 사유 → 팀장·박지훈 동의로 승인(사유 결석: 누적에서 해당 회의 제외)
      const absSy2 = await insertId(
        "INSERT INTO meeting_absences (meeting_id, user_id, reason, status) VALUES (?, ?, '병원 진료 일정과 겹쳤습니다.', 'approved')",
        [mtg2, sy],
      );
      await m.query(
        'INSERT INTO absence_consents (absence_id, voter_id) VALUES (?, ?), (?, ?)',
        [absSy2, leader, absSy2, jh],
      );
      // 박지훈은 지각 사유를 입력하지 않은 일반(미승인) 지각으로 둔다 — 회의1의 승인된
      // 사유 지각과 바로 대조되도록, 똑같이 늦었어도 이번엔 정시 점수가 그대로 깎인다.

      // ── 회의 3 (오늘, 40분): 전원 참석. 가벼운 지각·자리비움으로 출석 축 다양성 추가 ──
      const mtg3 = await insertId(
        `INSERT INTO meetings (team_id, scheduled_at, total_minutes, topic, status, t0_timestamp, ended_at, meeting_type, is_invalidated)
         VALUES (?, ?, 40, '3차 정기 회의 - 중간 점검', 'ended', ?, ?, 'regular', 0)`,
        [team, dt(0, 10), dt(0, 10), dt(0, 10, 40)],
      );
      // 박지훈 2분 지각(120000ms, 지각 기준 5분 이내 → 무감점 케이스), 이서연은 정시
      // 입장했지만 자리비움(leave) 후 미복귀로 실제 참여시간이 줄어든 케이스
      await m.query(
        `INSERT INTO presence_events (user_id, meeting_id, event_type, timestamp_offset_ms) VALUES
           (?, ?, 'join', 0), (?, ?, 'join', 0), (?, ?, 'join', 0), (?, ?, 'leave', 1500000), (?, ?, 'join', 120000)`,
        [leader, mtg3, dy, mtg3, sy, mtg3, sy, mtg3, jh, mtg3],
      );
      const utter3 = [
        { user_id: leader, char_count: 300, off: 60000 },
        { user_id: dy, char_count: 280, off: 200000 },
        { user_id: sy, char_count: 260, off: 300000 }, // 퇴장 전 발언
        { user_id: jh, char_count: 190, off: 400000 },
      ];
      for (const u of utter3) {
        await m.query(
          `INSERT INTO utterances (meeting_id, user_id, text, char_count, confidence, started_at_offset_ms, ended_at_offset_ms)
           VALUES (?, ?, '데모 발화 내용입니다.', ?, 0.95, ?, ?)`,
          [mtg3, u.user_id, u.char_count, u.off, u.off + 30000],
        );
      }
      await scoreAndStoreMeeting(m, client, {
        meetingId: mtg3,
        totalMinutes: 40,
        scheduledAt: dt(0, 10),
        t0: dt(0, 10),
        endedAt: dt(0, 10, 40),
        participantIds: [leader, dy, sy, jh],
        presence: [
          { user_id: leader, offsetMs: 0 },
          { user_id: dy, offsetMs: 0 },
          { user_id: sy, offsetMs: 0 },
          { user_id: sy, offsetMs: 1500000, eventType: 'leave' },
          { user_id: jh, offsetMs: 120000 },
        ],
        utterances: utter3,
        settings,
      });

      // 5) 태스크 — 현재 날짜 기준 마감 상태를 다양하게: 기한초과 완료/미완료,
      //    오늘 마감, 진행중(미래 마감), 할 일(미래 마감)
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

      // 기한 내 정상 완료 (마감 4일 전, 완료는 마감 하루 전)
      await mkTask(
        leader,
        '요구사항 정의서 작성',
        dt(-4, 18),
        'done',
        2,
        dt(-5, 18),
      );
      // 기한 늦게 완료 (마감 지남 — deadline penalty 케이스)
      await mkTask(dy, '와이어프레임 초안', dt(-3, 18), 'done', 2, dt(-1, 12));
      // 기한 지났는데 아직 todo (방치된 태스크)
      await mkTask(sy, 'API 명세 문서 정리', dt(-2, 18), 'todo', 2);
      // 오늘 마감, 진행 중
      await mkTask(jh, '발표 자료 디자인', dt(0, 23, 59), 'in_progress', 3);
      // 진행 중, 마감은 며칠 뒤
      await mkTask(leader, '백엔드 API 연동', dt(4, 18), 'in_progress', 3);
      // 할 일, 아직 안 건드림(미래 마감)
      await mkTask(dy, '테스트 케이스 작성', dt(7, 18), 'todo', 1);

      console.log(
        `✓ 출결 데모 시드 완료 — 팀 id=${team} '[데모] 출결 케이스 모음' (팀장 user_id=${leader}, 초대코드 ${INVITE})`,
      );
      console.log(
        '  회의1(5일전): 이서연=무단결석, 박지훈=사유지각(승인,12분)',
      );
      console.log(
        '  회의2(3일전): 이서연=사유결석(승인), 박지훈=일반지각(미승인,8분)',
      );
      console.log(
        '  회의3(오늘) : 박지훈=경미한지각(2분,기준이내), 이서연=조퇴(자리비움)',
      );
      console.log(
        '  태스크 6건  : 완료/지연완료/방치/오늘마감/진행중/할일 각 1건',
      );

      // 검증용: 실제로 DB에 저장된 ①값(contribution_scores)을 다시 읽어 출력.
      // 화면에 뜨는 출석 평균(attendance_avg)이 예상과 다를 때, 어느 회의의
      // attendance_ratio가 어떻게 저장됐는지 바로 확인할 수 있게 한다.
      const names: Record<number, string> = {
        [leader]: '팀장',
        [dy]: '김도윤',
        [sy]: '이서연',
        [jh]: '박지훈',
      };
      const savedScores: {
        user_id: number;
        meeting_id: number;
        attendance_ratio: number | null;
      }[] = await m.query(
        `SELECT user_id, meeting_id, attendance_ratio FROM contribution_scores
         WHERE meeting_id IN (?, ?, ?) ORDER BY meeting_id, user_id`,
        [mtg1, mtg2, mtg3],
      );
      const meetingLabel: Record<number, string> = {
        [mtg1]: '회의1',
        [mtg2]: '회의2',
        [mtg3]: '회의3',
      };
      console.log(
        '  --- 저장된 ①(contribution_scores.attendance_ratio) 검증 ---',
      );
      for (const row of savedScores) {
        console.log(
          `  ${meetingLabel[row.meeting_id] ?? row.meeting_id} / ${names[row.user_id] ?? row.user_id}: attendance_ratio=${row.attendance_ratio}`,
        );
      }
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
