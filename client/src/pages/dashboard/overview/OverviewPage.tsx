import { useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import Card from "@/components/Card";
import { apiGet } from "@/lib/api";
import type { ActionItem, Meeting, TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";

const MEMBER_COLORS = [
  "var(--green)",
  "var(--blue)",
  "var(--pink)",
  "var(--amber)",
  "var(--coral)",
  "var(--text-soft)",
];

// 마감일 표기: 오늘/내일은 강조, 그 외는 M/D
function dueLabel(due: string | null): { text: string; color: string } | null {
  if (!due) return null;
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: "지남", color: "var(--coral)" };
  if (diff === 0) return { text: "오늘", color: "var(--coral)" };
  if (diff === 1) return { text: "내일", color: "var(--coral)" };
  return {
    text: `${d.getMonth() + 1}/${d.getDate()}`,
    color: "var(--text-soft)",
  };
}

function meetingDateLabel(m: Meeting): string {
  const d = new Date(m.scheduled_at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay ? `오늘 ${time}` : `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const team = useOutletContext<TeamContext | null>();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [contrib, setContrib] = useState<TeamContribution[]>([]);
  const [tasks, setTasks] = useState<ActionItem[]>([]);

  useEffect(() => {
    if (!team) return;
    let alive = true;
    void Promise.allSettled([
      apiGet<Meeting[]>(`/meetings?team_id=${team.id}`),
      apiGet<{ members: TeamContribution[] }>(
        `/teams/${team.id}/contributions`,
      ),
      apiGet<ActionItem[]>(`/action-items?team_id=${team.id}`),
    ]).then(([ms, cs, ts]) => {
      if (!alive) return;
      if (ms.status === "fulfilled") setMeetings(ms.value);
      if (cs.status === "fulfilled")
        setContrib(
          [...cs.value.members].sort(
            (a, b) => (b.composite_score ?? -1) - (a.composite_score ?? -1),
          ),
        );
      if (ts.status === "fulfilled") setTasks(ts.value);
    });
    return () => {
      alive = false;
    };
  }, [team]);

  // 파생 값들 — 통계 카드·경보·목록이 공유
  const derived = useMemo(() => {
    const visible = tasks.filter((t) => t.status !== "cancelled");
    const done = visible.filter((t) => t.status === "done");
    const open = visible.filter((t) => t.status !== "done");
    const nextDue = open
      .filter((t) => t.due_date)
      .sort(
        (a, b) =>
          new Date(a.due_date as string).getTime() -
          new Date(b.due_date as string).getTime(),
      )[0];
    // 경보: 오늘/내일 마감인데 미시작(todo) 태스크 — 담당자별 묶음의 첫 항목
    const urgent = open.filter((t) => {
      const d = dueLabel(t.due_date);
      return (
        t.status === "todo" && d && (d.text === "오늘" || d.text === "내일")
      );
    });
    const nameById = new Map(contrib.map((c) => [c.user_id, c.name]));
    const active = meetings.find((m) => m.status === "active");
    const nextScheduled = [...meetings]
      .filter((m) => m.status === "scheduled")
      .sort(
        (a, b) =>
          new Date(a.scheduled_at).getTime() -
          new Date(b.scheduled_at).getTime(),
      )[0];
    const recent = [...meetings]
      .sort(
        (a, b) =>
          new Date(b.scheduled_at).getTime() -
          new Date(a.scheduled_at).getTime(),
      )
      .slice(0, 3);
    return {
      visible,
      done,
      open,
      nextDue,
      urgent,
      nameById,
      active,
      nextScheduled,
      recent,
    };
  }, [tasks, contrib, meetings]);

  // requestAnimationFrame으로 지연 적용: 마운트 직후 0% → data-w% 로 CSS transition 애니메이션.
  // 동기 적용하면 브라우저가 초기값과 최종값을 합쳐 렌더링해 transition이 발동하지 않음.
  useEffect(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".c-bar i[data-w]")
        .forEach((b) => {
          b.style.width = b.dataset.w + "%";
        });
      document
        .querySelectorAll<HTMLElement>(".prog-fill[data-w]")
        .forEach((b) => {
          b.style.width = b.dataset.w + "%";
        });
    });
  }, [contrib]);

  const taskPct = derived.visible.length
    ? Math.round((derived.done.length / derived.visible.length) * 100)
    : 0;
  const nextDueInfo = derived.nextDue
    ? dueLabel(derived.nextDue.due_date)
    : null;
  const focusMeeting = derived.active ?? derived.nextScheduled;

  return (
    <div>
      {derived.urgent.length > 0 ? (
        <div className="alert-bar">
          <i className="ti ti-alert-triangle" />{" "}
          {derived.nameById.get(derived.urgent[0].assignee_id ?? -1) ??
            "담당자 미지정"}
          님의 태스크 {derived.urgent.length}개가 곧 마감입니다. 아직 시작하지
          않았어요.
        </div>
      ) : null}

      {/* 통계 */}
      <div className="stats-grid">
        {[
          {
            lbl: "총 회의",
            val: String(meetings.length),
            sub: "이번 프로젝트",
          },
          {
            lbl: "태스크 진행률",
            val: `${taskPct}%`,
            sub: `${derived.done.length} / ${derived.visible.length} 완료`,
          },
          {
            lbl: "다음 마감 태스크",
            val: nextDueInfo?.text ?? "—",
            sub: derived.nextDue?.description ?? "예정된 마감 없음",
            valStyle: { fontSize: 20, paddingTop: 8 } as const,
          },
        ].map((s) => (
          <div key={s.lbl} className="stat-card">
            <div className="stat-lbl">{s.lbl}</div>
            <div className="stat-val" style={s.valStyle}>
              {s.val}
            </div>
            <div className="stat-sub">{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="dash-grid">
        {/* 기여도 현황 */}
        <Card
          icon="ti ti-chart-bar"
          title="기여도 현황"
          titleSuffix={
            <span className="live-dot" style={{ background: "var(--green)" }} />
          }
          extra={<span className="badge b-green">실시간</span>}
        >
          <div style={{ padding: "2px 18px 14px" }}>
            {contrib.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
                아직 산정된 기여도가 없습니다. 회의를 진행하면 집계돼요.
              </div>
            )}
            {contrib.map((c, i) => {
              const pct =
                c.composite_score == null
                  ? null
                  : Math.round(c.composite_score * 100);
              const myTasks = derived.visible.filter(
                (t) => t.assignee_id === c.user_id,
              );
              const myDone = myTasks.filter((t) => t.status === "done");
              return (
                <div key={c.user_id} className="contrib-row">
                  <span className="c-name">{c.name}</span>
                  <span className="c-bar">
                    <i
                      data-w={pct ?? 0}
                      style={{
                        width: 0,
                        background: MEMBER_COLORS[i % MEMBER_COLORS.length],
                      }}
                    />
                  </span>
                  <span
                    className="c-pct"
                    style={
                      pct == null ? { color: "var(--text-soft)" } : undefined
                    }
                  >
                    {pct == null ? "-%" : `${pct}%`}
                  </span>
                  <span
                    className="c-task"
                    style={{ color: "var(--text-soft)" }}
                  >
                    {myTasks.length
                      ? `태스크 ${myDone.length}/${myTasks.length}`
                      : "-"}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* 진행 중 회의: .mini-meeting 전용 레이아웃이라 Card 컴포넌트 미사용.
            card-head/card-title 클래스는 헤더 스타일만 재사용. */}
        <div className="mini-meeting">
          <div className="card-head" style={{ padding: "0 0 10px" }}>
            <span className="card-title">
              <i className="ti ti-clock" /> 진행 중 회의
            </span>
            {derived.active ? (
              <span className="spill spill-live">🔴 진행</span>
            ) : (
              <span className="badge">예정</span>
            )}
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>
            {focusMeeting?.topic ??
              (focusMeeting ? "제목 없는 회의" : "예정된 회의 없음")}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
            {focusMeeting
              ? `${meetingDateLabel(focusMeeting)} · ${focusMeeting.total_minutes}분 · ${team?.member_count ?? "-"}명`
              : "회의 관리에서 새 회의를 만들어 보세요."}
          </div>
          <div style={{ display: "flex", gap: 7, margin: "14px 0 4px" }}>
            {(team?.members ?? []).slice(0, 4).map((name, i) => (
              <div key={i} className={`av a${(i % 4) + 1} av-sm`}>
                {name[0]}
              </div>
            ))}
          </div>
          <button
            className="btn btn-primary btn-full"
            style={{ marginTop: 12 }}
            onClick={() => navigate(`/dashboard/${team?.id}/meeting`)}
          >
            <i className="ti ti-arrow-right" />{" "}
            {derived.active ? "회의 참여하기" : "회의 관리로 이동"}
          </button>
        </div>
      </div>

      <div className="dash-grid2">
        {/* 진행 중 태스크 */}
        <Card icon="ti ti-checklist" title="진행 중 태스크">
          <div style={{ padding: "2px 16px 14px" }}>
            {derived.visible.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
                등록된 태스크가 없습니다.
              </div>
            )}
            {[...derived.open, ...derived.done].slice(0, 4).map((t) => {
              const due = dueLabel(t.due_date);
              const done = t.status === "done";
              return (
                <div key={t.id} className="task-mini">
                  <div className={`chk-mini ${done ? "done" : ""}`}>
                    {done && <i className="ti ti-check" />}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      textDecoration: done ? "line-through" : undefined,
                      color: done ? "var(--text-soft)" : undefined,
                    }}
                  >
                    {t.description}
                  </div>
                  {!done && due && (
                    <span style={{ color: due.color, fontWeight: 700 }}>
                      {due.text}
                    </span>
                  )}
                  <span style={{ color: "var(--text-soft)" }}>
                    {derived.nameById.get(t.assignee_id ?? -1) ?? ""}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>

        {/* 최근 회의 */}
        <Card icon="ti ti-calendar" title="최근 회의">
          <div style={{ padding: "2px 16px 14px" }}>
            {derived.recent.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
                아직 회의 기록이 없습니다.
              </div>
            )}
            {derived.recent.map((m) => (
              <div key={m.id} className="meeting-mini">
                <div className="mm-top">
                  <span>{m.topic ?? "제목 없는 회의"}</span>
                  {m.status === "active" ? (
                    <span className="spill spill-live">진행 중</span>
                  ) : m.status === "ended" ? (
                    <span className="badge b-green">완료</span>
                  ) : (
                    <span className="badge">예정</span>
                  )}
                </div>
                <div className="mm-meta">
                  {meetingDateLabel(m)} · {m.total_minutes}분
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
