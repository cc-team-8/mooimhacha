/// <reference types="jest" />
import { MeetingAbsencesService } from './meeting-absences.service';

// isLateByPresence는 주입 의존성(this.*Repo 등)을 쓰지 않고 인자만 사용하므로
// null 의존성으로 인스턴스화해 경계 동작만 검증한다.
describe('MeetingAbsencesService.isLateByPresence', () => {
  const service = new MeetingAbsencesService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );

  const meeting = { t0_timestamp: new Date('2026-01-01T00:00:00Z') };
  const isLate = (offsetMs: number, thresholdMin: number): boolean =>
    (
      service as unknown as {
        isLateByPresence: (
          m: unknown,
          p: unknown,
          u: number,
          t: number,
        ) => boolean;
      }
    ).isLateByPresence(
      meeting,
      [{ user_id: 1, event_type: 'join', timestamp_offset_ms: offsetMs }],
      1,
      thresholdMin,
    );

  it('기준 5분: 정확히 5:00(300초) 입장은 출석(지각 아님)', () => {
    expect(isLate(300_000, 5)).toBe(false);
  });

  it('기준 5분: 5:01(301초) 입장은 지각', () => {
    expect(isLate(301_000, 5)).toBe(true);
  });

  it('기준 10분: 7:00 입장은 출석 — 설정값이 실제로 반영된다', () => {
    expect(isLate(420_000, 10)).toBe(false);
  });

  it('입장 기록이 없으면 지각이 아니다', () => {
    expect(
      (
        service as unknown as {
          isLateByPresence: (
            m: unknown,
            p: unknown,
            u: number,
            t: number,
          ) => boolean;
        }
      ).isLateByPresence(meeting, [], 1, 5),
    ).toBe(false);
  });
});

describe('MeetingAbsencesService.exceedsMaxLate', () => {
  const service = new MeetingAbsencesService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  const meeting = { t0_timestamp: new Date('2026-01-01T00:00:00Z') };
  const exceeds = (offsetMs: number, maxMin: number): boolean =>
    (
      service as unknown as {
        exceedsMaxLate: (
          m: unknown,
          p: unknown,
          u: number,
          t: number,
        ) => boolean;
      }
    ).exceedsMaxLate(
      meeting,
      [{ user_id: 1, event_type: 'join', timestamp_offset_ms: offsetMs }],
      1,
      maxMin,
    );

  it('max 0이면 상한 없음 — 아무리 늦어도 false', () => {
    expect(exceeds(9_999_000, 0)).toBe(false);
  });
  it('max 30분: 정확히 30:00(1800초) 입장은 초과 아님', () => {
    expect(exceeds(1_800_000, 30)).toBe(false);
  });
  it('max 30분: 30:01(1801초) 입장은 초과', () => {
    expect(exceeds(1_801_000, 30)).toBe(true);
  });
  it('입장 기록이 없으면 초과 아님', () => {
    expect(
      (
        service as unknown as {
          exceedsMaxLate: (
            m: unknown,
            p: unknown,
            u: number,
            t: number,
          ) => boolean;
        }
      ).exceedsMaxLate(meeting, [], 1, 30),
    ).toBe(false);
  });
});

describe('MeetingAbsencesService.deriveStatus (max 초과)', () => {
  const service = new MeetingAbsencesService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  const derive = (
    hasJoined: boolean,
    lateByPresence: boolean,
    exceedsMaxLate: boolean,
    approved = false,
  ): string =>
    (
      service as unknown as {
        deriveStatus: (
          h: boolean,
          s: unknown,
          a: unknown,
          l: boolean,
          e: boolean,
        ) => string;
      }
    ).deriveStatus(
      hasJoined,
      undefined,
      approved ? { status: 'approved' } : undefined,
      lateByPresence,
      exceedsMaxLate,
    );

  it('입장했지만 max 초과 → absent', () => {
    expect(derive(true, true, true)).toBe('absent');
  });
  it('입장 + max 초과 + 결석 사유 승인 → excused', () => {
    expect(derive(true, true, true, true)).toBe('excused');
  });
  it('입장 + 지각이지만 max 이내 → late', () => {
    expect(derive(true, true, false)).toBe('late');
  });
  it('입장 + 정시 → present', () => {
    expect(derive(true, false, false)).toBe('present');
  });
});
