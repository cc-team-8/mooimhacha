import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import Card from "@/components/Card";
import { apiGet } from "@/lib/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { ActionItem, Meeting, TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";
import { avatarBg, memberColor } from "@/lib/avatarColor";

// 기여도 리포트 열람 최소 종료 회의 수 (정확 측정 전제)
const REQUIRED_MEETINGS = 3;

// 종합 기여 가중치 기본값 (팀 설정 미로드 시 폴백). 실제 값은 팀 설정에서 동적으로.
const DEFAULT_TASK_W = 0.5;
const DEFAULT_SPEECH_W = 0.6; // 회의 내 발언:출석
const DEFAULT_ATTEND_W = 0.4;
const SEG_COLOR = {
  speech: "var(--blue)",
  attend: "var(--amber)",
  task: "var(--green)",
};

const pct = (v: number | null | undefined): number | null =>
  v == null ? null : Math.round(v * 100);

// 발언 점수 = 발언 점유율(own/total)을 1인 기대치(1/N) 대비로 환산, 100점 상한.
// speech_avg 는 점유율 평균이라 4명 균등 시 0.25 → ×N 으로 "기준 대비 점수"가 된다.
const speechScore = (
  speechAvg: number | null | undefined,
  n: number,
): number | null =>
  speechAvg == null ? null : Math.min(100, Math.round(speechAvg * n * 100));

// SVG를 innerHTML로 직접 생성. 외부 차트 라이브러리 없이 의존성 최소화를 위한 선택.
// 멤버 행에 작게 인라인으로 들어가므로 축 라벨은 생략(카드 상단 안내로 대체)하고,
// color = 해당 멤버 색. 회색 폴리곤 = 팀 평균 기준선.
function drawRadar(
  svgEl: SVGSVGElement,
  me: number[],
  avg: number[],
  color: string,
) {
  const cx = 120,
    cy = 120,
    R = 66, // 꼭짓점 라벨 공간을 남기려 차트 반경을 줄임
    axes = 3;
  const labels = ["출석", "참여도", "태스크"];
  const css = getComputedStyle(document.documentElement);
  const ang = (i: number) => (Math.PI * 2 * i) / axes - Math.PI / 2;
  const pt = (i: number, v: number): [number, number] => [
    cx + (Math.cos(ang(i)) * R * v) / 100,
    cy + (Math.sin(ang(i)) * R * v) / 100,
  ];
  let h = "";
  [33, 66, 100].forEach((v) => {
    let p = "";
    for (let i = 0; i < axes; i++) {
      const [x, y] = pt(i, v);
      p += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }
    h += `<path d="${p}Z" fill="none" stroke="${css.getPropertyValue("--border")}" stroke-width="1"/>`;
  });
  for (let i = 0; i < axes; i++) {
    const [x, y] = pt(i, 100);
    h += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${css.getPropertyValue("--border")}" stroke-width="1"/>`;
    // 꼭짓점 바깥(반경 150%)에 항목명 라벨 — 연한 색으로
    const [lx, ly] = pt(i, 150);
    h += `<text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" text-anchor="middle" font-size="16" font-weight="700" fill="${css.getPropertyValue("--text-soft")}">${labels[i]}</text>`;
  }
  const poly = (data: number[], stroke: string, fill: string) => {
    let p = "";
    for (let i = 0; i < axes; i++) {
      const [x, y] = pt(i, data[i] ?? 0);
      p += (i ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    }
    return `<path d="${p}Z" fill="${fill}" stroke="${stroke}" stroke-width="2.4" stroke-linejoin="round"/>`;
  };
  h += poly(avg, css.getPropertyValue("--text-soft"), "rgba(150,160,150,.16)");
  h += poly(me, color, color + "30");
  for (let i = 0; i < axes; i++) {
    const [x, y] = pt(i, me[i] ?? 0);
    h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4" fill="${color}"/>`;
  }
  svgEl.innerHTML = h;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

interface Chip {
  stars: number; // 1=하 / 2=중 / 3=상
  done: number;
  total: number;
}

// 담당 태스크를 난이도(★)별 완료/전체로 집계
function diffChipsOf(tasks: ActionItem[], userId: number | null): Chip[] {
  const b: Record<number, { done: number; total: number }> = {
    3: { done: 0, total: 0 },
    2: { done: 0, total: 0 },
    1: { done: 0, total: 0 },
  };
  for (const t of tasks) {
    if (t.assignee_id !== userId) continue;
    const d = t.difficulty >= 3 ? 3 : t.difficulty === 2 ? 2 : 1;
    b[d].total++;
    if (t.status === "done") b[d].done++;
  }
  // ★★★/★★/★ 3단계를 항상 노출 (해당 난이도 태스크가 없으면 0/0 회색 칩)
  return [3, 2, 1].map((d) => ({
    stars: d,
    done: b[d].done,
    total: b[d].total,
  }));
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: 3,
        background: color,
        marginRight: 4,
        verticalAlign: "middle",
      }}
    />
  );
}

// 난이도별 칩 — 완료(초록)·부분(주황)·미완(빨강)·해당 난이도 없음(회색)
function DiffChip({ c }: { c: Chip }) {
  const empty = c.total === 0;
  const full = !empty && c.done === c.total;
  const none = !empty && c.done === 0;
  const color = empty
    ? "var(--text-soft)"
    : none
      ? "var(--coral)"
      : full
        ? "var(--green)"
        : "var(--amber)";
  const bg = empty
    ? "rgba(150,160,150,.12)"
    : none
      ? "rgba(220,38,38,.10)"
      : full
        ? "rgba(29,158,117,.12)"
        : "rgba(230,160,30,.16)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 6,
        fontSize: 11,
        fontWeight: 700,
        whiteSpace: "nowrap",
        background: bg,
        color,
      }}
    >
      {"★".repeat(c.stars)} {c.done}/{c.total}
    </span>
  );
}

export default function ReportPage() {
  const team = useOutletContext<TeamContext | null>();
  const me = useCurrentUser();
  const [members, setMembers] = useState<TeamContribution[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [tasks, setTasks] = useState<ActionItem[]>([]);
  const [weights, setWeights] = useState<{
    final_task_weight: number;
    weight_speech_in_meeting: number;
    weight_attend_in_meeting: number;
  } | null>(null);

  const nicknameMap = useMemo(
    () =>
      new Map(
        (team?.members ?? []).map((m) => [m.user_id, m.nickname ?? m.name]),
      ),
    [team],
  );
  const memberIdx = (userId: number) => {
    const i = (team?.members ?? []).findIndex((m) => m.user_id === userId);
    return i < 0 ? userId % 32 : i;
  };

  useEffect(() => {
    if (!team) return;
    let alive = true;
    void Promise.allSettled([
      apiGet<{ members: TeamContribution[] }>(
        `/teams/${team.id}/contributions`,
      ),
      apiGet<Meeting[]>(`/meetings?team_id=${team.id}`),
      apiGet<ActionItem[]>(`/action-items?team_id=${team.id}`),
      apiGet<{
        final_task_weight: number;
        weight_speech_in_meeting: number;
        weight_attend_in_meeting: number;
      }>(`/teams/${team.id}/settings`),
    ]).then(([cs, ms, ts, ws]) => {
      if (!alive) return;
      if (cs.status === "fulfilled")
        setMembers(
          [...cs.value.members].sort(
            (a, b) => (b.composite_score ?? -1) - (a.composite_score ?? -1),
          ),
        );
      if (ms.status === "fulfilled") setMeetings(ms.value);
      if (ts.status === "fulfilled")
        setTasks(ts.value.filter((t) => t.status !== "cancelled"));
      if (ws.status === "fulfilled") setWeights(ws.value);
    });
    return () => {
      alive = false;
    };
  }, [team]);

  // 발언 점수 환산에 쓰는 인원 수(산정 대상)
  const n = members.length || 1;

  // 종합 가중치 — 팀 설정 기반. 종합 = 발언×wSpeech + 출석×wAttend + 태스크×wTask (합 1).
  const wTask = weights?.final_task_weight ?? DEFAULT_TASK_W;
  const wSpeech =
    (1 - wTask) * (weights?.weight_speech_in_meeting ?? DEFAULT_SPEECH_W);
  const wAttend =
    (1 - wTask) * (weights?.weight_attend_in_meeting ?? DEFAULT_ATTEND_W);

  // 종합 점수 = 발언×wSpeech + 출석×wAttend + 태스크×wTask (모든 축 0~100). 전부 미측정이면 null.
  const scoreOf = (m: TeamContribution): number | null => {
    const sp = speechScore(m.speech_avg, n);
    const at = pct(m.attendance_avg);
    const ts = pct(m.task_score);
    if (sp == null && at == null && ts == null) return null;
    return Math.round(
      (sp ?? 0) * wSpeech + (at ?? 0) * wAttend + (ts ?? 0) * wTask,
    );
  };

  // 종합 달성률 = 멤버별 종합 점수 평균
  const overall = useMemo(() => {
    const vals = members.map(scoreOf).filter((v): v is number => v != null);
    return vals.length
      ? Math.round(vals.reduce((a, v) => a + v, 0) / vals.length)
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, wSpeech, wAttend, wTask]);

  // 레이더 축값(출석·참여도(발언 점수)·태스크) — 멤버별 / 팀 평균
  const memberTriple = (m: TeamContribution): number[] => [
    pct(m.attendance_avg) ?? 0,
    speechScore(m.speech_avg, n) ?? 0,
    pct(m.task_score) ?? 0,
  ];

  // 팀 평균 = 각 축의 멤버 평균 (각 행 레이더의 회색 기준선)
  const teamAvg = useMemo(() => {
    const avgOf = (vals: (number | null)[]) => {
      const v = vals.filter((x): x is number => x != null);
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0;
    };
    return [
      avgOf(members.map((m) => pct(m.attendance_avg))),
      avgOf(members.map((m) => speechScore(m.speech_avg, n))),
      avgOf(members.map((m) => pct(m.task_score))),
    ];
  }, [members, n]);

  // 멤버 행마다 인라인 레이더를 그린다 (id=radar-<user_id>)
  useEffect(() => {
    members.forEach((m, i) => {
      const el = document.getElementById(
        `radar-${m.user_id}`,
      ) as SVGSVGElement | null;
      if (el)
        drawRadar(
          el,
          memberTriple(m),
          teamAvg,
          memberColor(memberIdx(m.user_id)),
        );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, teamAvg, n]);

  const ended = meetings.filter((m) => m.status === "ended");
  const period = meetings.length
    ? `${shortDate(
        [...meetings].sort(
          (a, b) =>
            new Date(a.scheduled_at).getTime() -
            new Date(b.scheduled_at).getTime(),
        )[0].scheduled_at,
      )} ~ ${shortDate(
        [...meetings].sort(
          (a, b) =>
            new Date(b.scheduled_at).getTime() -
            new Date(a.scheduled_at).getTime(),
        )[0].scheduled_at,
      )}`
    : "기간 없음";

  const sessions = [...meetings]
    .filter((m) => m.status !== "scheduled")
    .sort(
      (a, b) =>
        new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
    );

  // 내가 완료한 태스크 (완료일 최신순)
  const myDoneTasks = me
    ? tasks
        .filter((t) => t.assignee_id === me.id && t.status === "done")
        .sort(
          (a, b) =>
            (b.completed_at ? new Date(b.completed_at).getTime() : 0) -
            (a.completed_at ? new Date(a.completed_at).getTime() : 0),
        )
    : [];

  const now = new Date();
  const yearMonth = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;

  // 정확한 측정을 위해 종료된 회의가 최소 수 미만이면 리포트 잠금
  if (ended.length < REQUIRED_MEETINGS) {
    const progress = Math.min(100, (ended.length / REQUIRED_MEETINGS) * 100);
    return (
      <div className="report-wrap">
        <div className="report-lock" data-tour="rp-lock">
          <i className="ti ti-lock report-lock-ic" />
          <div className="report-lock-title">기여도 리포트 준비 중</div>
          <div className="report-lock-desc">
            정확한 기여도 측정을 위해 최소 {REQUIRED_MEETINGS}회의 회의가
            필요해요. 회의를 더 진행하면 리포트가 자동으로 열려요.
          </div>
          <div className="report-lock-bar">
            <i style={{ width: `${progress}%` }} />
          </div>
          <div className="report-lock-count">
            진행한 회의 <b>{ended.length}</b> / {REQUIRED_MEETINGS}회
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="report-wrap">
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginBottom: 12,
        }}
      >
        <button
          data-tour="rp-pdf"
          className="btn btn-primary btn-sm"
          onClick={() => window.print()}
          title="이 리포트 화면을 인쇄하거나 PDF로 저장해요"
        >
          <i className="ti ti-file-export" /> PDF 저장 (제출용)
        </button>
      </div>

      {/* 배너 */}
      <div data-tour="rp-banner" className="report-banner">
        <div>
          <div className="rb-title">팀플 기여도 최종 리포트</div>
          <div className="rb-sub">
            {team?.name ?? "팀"}
            {team?.course_name ? ` · ${team.course_name}` : ""} · {yearMonth}
          </div>
          <div className="rb-meta">
            총 회의 {ended.length}회 · 태스크 {tasks.length}개 · {period}
          </div>
        </div>
        <div>
          <div className="rb-score-lbl">종합 달성률</div>
          <div className="rb-score">
            {overall == null ? "—" : `${overall}%`}
          </div>
        </div>
      </div>

      {/* 팀원별 기여도 (행별 레이더 + 막대) */}
      <Card icon="ti ti-chart-bar" title="팀원별 기여도">
        {/* 게이지 범례 */}
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
            padding: "0 18px 4px",
            fontSize: 11.5,
            color: "var(--text-soft)",
          }}
        >
          <span>
            <Swatch color={SEG_COLOR.speech} />
            발언 (×{wSpeech.toFixed(2)})
          </span>
          <span>
            <Swatch color={SEG_COLOR.attend} />
            출석 (×{wAttend.toFixed(2)})
          </span>
          <span>
            <Swatch color={SEG_COLOR.task} />
            태스크 (×{wTask.toFixed(2)})
          </span>
          <span style={{ marginLeft: "auto" }}>막대 = 종합 기여 합산</span>
        </div>
        <div
          style={{
            padding: "0 18px 8px",
            fontSize: 11,
            color: "var(--text-soft)",
          }}
        >
          발언 점수 = 발언 점유율 ÷ 1인 기대치(1/{n}) (100점 상한), 태스크 =
          난이도(★) 가중 완료율 · 행별 레이더 회색 = 팀 평균
        </div>

        <div data-tour="rp-contrib" style={{ padding: "0 18px 14px" }}>
          {members.length === 0 && (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-soft)",
                padding: "10px 0",
              }}
            >
              아직 산정된 기여도가 없습니다. 회의를 진행하면 집계돼요.
            </div>
          )}
          {members.map((m, i) => {
            // 미산정(null)은 0으로 표기 — 리포트는 정확 측정을 전제(최소 회의 게이트)
            const sScore = speechScore(m.speech_avg, n) ?? 0;
            const attend = pct(m.attendance_avg) ?? 0;
            const taskPct = pct(m.task_score) ?? 0;
            const score = scoreOf(m) ?? 0;
            const scoreCls = score >= 50 ? "hi" : score >= 25 ? "md" : "lo";
            const low = score < 10;
            const segS = sScore * wSpeech;
            const segA = attend * wAttend;
            const segT = taskPct * wTask;
            const chips = diffChipsOf(tasks, m.user_id);
            return (
              <div key={m.user_id} className="mrc">
                {/* 왼쪽: 행별 레이더 (1) */}
                <div
                  className="mrc-radar"
                  {...(i === 0 ? { "data-tour": "rp-radar" } : {})}
                >
                  <svg id={`radar-${m.user_id}`} viewBox="0 0 240 240" />
                </div>
                {/* 오른쪽: 기여도 막대 + 세부 (3) */}
                <div className="mrc-main">
                  {/* 헤더: 아바타 · 이름 · 세그먼트 게이지 · 점수 */}
                  <div
                    className="mrc-head"
                    style={{ display: "flex", alignItems: "center", gap: 12 }}
                  >
                    <div
                      className="av av-lg"
                      style={{ background: avatarBg(memberIdx(m.user_id)) }}
                    >
                      {(nicknameMap.get(m.user_id) ?? m.name)[0]}
                    </div>
                    {/* 이름 줄: [이름][기여도 바][점수] 한 행, 역할(팀원)은 아래로 */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                        }}
                      >
                        <div
                          className="mrc-name"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            width: 70,
                            flex: "0 0 auto",
                          }}
                        >
                          {nicknameMap.get(m.user_id) ?? m.name}
                          {low && (
                            <span
                              className="nav-alert"
                              title="무임승차 의심"
                              style={{ marginLeft: 5 }}
                            >
                              !
                            </span>
                          )}
                          {me?.id === m.user_id && (
                            <span
                              style={{
                                fontSize: 10,
                                color: "var(--text-soft)",
                                fontWeight: 400,
                                marginLeft: 4,
                              }}
                            >
                              나
                            </span>
                          )}
                        </div>
                        {/* 세그먼트 게이지 — 이름과 같은 줄, 높이 11px, maxWidth로 길이 고정 */}
                        <div
                          style={{
                            flex: 1,
                            maxWidth: 260,
                            height: 11,
                            borderRadius: 6,
                            background: "var(--track)",
                            overflow: "hidden",
                            display: "flex",
                          }}
                          title={`발언 ${segS.toFixed(1)} + 출석 ${segA.toFixed(1)} + 태스크 ${segT.toFixed(1)}`}
                        >
                          <span
                            style={{
                              width: `${segS}%`,
                              background: SEG_COLOR.speech,
                            }}
                          />
                          <span
                            style={{
                              width: `${segA}%`,
                              background: SEG_COLOR.attend,
                            }}
                          />
                          <span
                            style={{
                              width: `${segT}%`,
                              background: SEG_COLOR.task,
                            }}
                          />
                        </div>
                        {/* 점수는 바 오른쪽에 바로 (margin-left:auto 무력화) */}
                        <div
                          className={`mrc-score ${scoreCls}`}
                          style={{ flex: "0 0 auto", marginLeft: 0 }}
                        >
                          {`${score}점`}
                        </div>
                      </div>
                      <div className="mrc-role">
                        {m.role === "leader" ? "팀장" : "팀원"}
                      </div>
                    </div>
                  </div>

                  {/* 세부: 발언 · 출석 · 태스크 — 고정폭 열로 값 길이와 무관하게 위치 고정 */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "84px 84px max-content",
                      columnGap: 16,
                      alignItems: "center",
                      justifyContent: "start",
                      whiteSpace: "nowrap",
                      marginTop: 9,
                      fontSize: 12,
                      color: "var(--text-soft)",
                    }}
                  >
                    <span>
                      발언{" "}
                      <b
                        style={{
                          color:
                            sScore < 50 ? "var(--coral)" : "var(--text-main)",
                        }}
                      >
                        {`${sScore}점`}
                      </b>
                    </span>
                    <span>
                      출석{" "}
                      <b
                        style={{ color: "var(--text-main)" }}
                      >{`${attend}%`}</b>
                    </span>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "nowrap",
                      }}
                    >
                      태스크
                      {chips.map((c, ci) => (
                        <DiffChip key={ci} c={c} />
                      ))}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 회의별 요약 */}
      <Card icon="ti ti-calendar" title="회의별 요약">
        <div style={{ padding: "0 18px 14px" }}>
          {sessions.length === 0 && (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-soft)",
                padding: "10px 0",
              }}
            >
              진행한 회의가 없습니다.
            </div>
          )}
          {sessions.map((m, i) => {
            const mins =
              m.t0_timestamp && m.ended_at
                ? Math.max(
                    1,
                    Math.round(
                      (new Date(m.ended_at).getTime() -
                        new Date(m.t0_timestamp).getTime()) /
                        60000,
                    ),
                  )
                : m.total_minutes;
            return (
              <div key={m.id} className="ms-row">
                <div className="ms-num">{i + 1}</div>
                <div>
                  <div className="ms-title">
                    {m.topic ?? "제목 없는 회의"}{" "}
                    <span>
                      {shortDate(m.scheduled_at)} ·{" "}
                      {m.status === "active" ? "진행 중" : `${mins}분`}
                    </span>
                  </div>
                  <div className="ms-body">
                    {m.one_liner ?? "요약이 아직 없습니다."}
                  </div>
                  <div className="ms-meta">
                    {m.status === "active"
                      ? "진행 중"
                      : m.meeting_type === "regular"
                        ? "정규 회의 · 기여도 반영"
                        : "기여도 누적 미반영"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* 내가 완료한 태스크 */}
      <Card
        icon="ti ti-circle-check"
        title="내가 완료한 태스크"
        extra={
          <span className="card-link" style={{ cursor: "default" }}>
            {myDoneTasks.length}개
          </span>
        }
      >
        <div style={{ padding: "0 18px 14px" }}>
          {myDoneTasks.length === 0 ? (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--text-soft)",
                padding: "10px 0",
              }}
            >
              완료한 태스크가 없습니다.
            </div>
          ) : (
            <>
              <div className="mdt-row mdt-head">
                <span>난이도</span>
                <span>이름</span>
                <span>세부사항</span>
                <span>기한</span>
              </div>
              {myDoneTasks.map((t) => {
                const d = t.difficulty >= 3 ? 3 : t.difficulty === 2 ? 2 : 1;
                return (
                  <div key={t.id} className="mdt-row">
                    <span className="mdt-stars">{"★".repeat(d)}</span>
                    <span className="mdt-desc">{t.description}</span>
                    <span className="mdt-detail">{t.detail || ""}</span>
                    <span className="mdt-date">
                      {t.completed_at ? shortDate(t.completed_at) : ""}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
