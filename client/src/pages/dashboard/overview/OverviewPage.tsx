import { useEffect, useMemo, useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import Card from "@/components/Card";
import { apiGet, apiPatch } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { ActionItem, Meeting, TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";
import { avatarBg, memberColor } from "@/lib/avatarColor";

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

function taskDueLabel(
  due: string | null,
): { text: string; color: string } | null {
  if (!due) return null;
  const d = new Date(due);
  const isPast = d < new Date();
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAYS[d.getDay()];
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 || 12;
  return {
    text: `${m}/${day}(${dow}) ${ampm} ${h12}:${min}`,
    color: isPast ? "var(--coral)" : "var(--text-soft)",
  };
}

function dDayText(due: string | null): { text: string; color: string } | null {
  if (!due) return null;
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: `D+${Math.abs(diff)}`, color: "var(--coral)" };
  if (diff === 0) return { text: "D-0", color: "var(--coral)" };
  return {
    text: `D-${diff}`,
    color: diff <= 3 ? "var(--coral)" : "var(--text-main)",
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
  return sameDay
    ? `오늘 ${time}`
    : `${d.getMonth() + 1}월 ${d.getDate()}일 ${time}`;
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const team = useOutletContext<TeamContext | null>();
  const currentUser = getUser();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [contrib, setContrib] = useState<TeamContribution[]>([]);
  const [tasks, setTasks] = useState<ActionItem[]>([]);

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
      apiGet<Meeting[]>(`/meetings?team_id=${team.id}`),
      apiGet<{ members: TeamContribution[] }>(
        `/teams/${team.id}/contributions`,
      ),
      apiGet<ActionItem[]>(`/action-items?team_id=${team.id}&confirmed=true`),
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
    const now = new Date();
    const overdue = open.filter(
      (t) => t.due_date && new Date(t.due_date) < now,
    );
    const nextDue = open
      .filter((t) => t.due_date && t.assignee_id === currentUser?.id)
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
    const nameById = new Map(
      contrib.map((c) => [c.user_id, nicknameMap.get(c.user_id) ?? c.name]),
    );
    const nextUnfinished = [...meetings]
      .filter((m) => m.status !== "ended")
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
      overdue,
      nextDue,
      urgent,
      nameById,
      nextUnfinished,
      recent,
    };
  }, [tasks, contrib, meetings, nicknameMap]);

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
    ? dDayText(derived.nextDue.due_date)
    : null;
  const focusMeeting = derived.nextUnfinished;

  async function toggleTask(t: ActionItem) {
    const next = t.status === "done" ? "todo" : "done";
    setTasks((prev) =>
      prev.map((x) => (x.id === t.id ? { ...x, status: next } : x)),
    );
    try {
      await apiPatch(`/action-items/${t.id}`, { status: next });
    } catch {
      setTasks((prev) =>
        prev.map((x) => (x.id === t.id ? { ...x, status: t.status } : x)),
      );
    }
  }

  return (
    <div>
      {derived.urgent.length > 0 ? (
        <div className="alert-bar" data-tour="ov-alert">
          <i className="ti ti-alert-triangle" />{" "}
          {(() => {
            const name = derived.nameById.get(
              derived.urgent[0].assignee_id ?? -1,
            );
            return name
              ? `${name}님의 태스크 ${derived.urgent.length}개가 곧 마감입니다. 아직 시작하지 않았어요.`
              : `곧 마감인 태스크가 ${derived.urgent.length}개 있습니다. 아직 시작하지 않았어요.`;
          })()}
        </div>
      ) : null}

      {/* 통계 */}
      <div className="stats-grid" data-tour="ov-stats">
        {[
          {
            lbl: "총 회의",
            val: String(meetings.length),
            sub: "이번 프로젝트",
          },
          {
            lbl: "총 태스크 진행률",
            val: `${taskPct}%`,
            sub: `${derived.done.length} / ${derived.visible.length} 완료`,
          },
          {
            lbl: "내 다음 마감 태스크",
            val: nextDueInfo?.text ?? "—",
            sub: derived.nextDue?.due_date
              ? `${new Date(derived.nextDue.due_date).getMonth() + 1}/${new Date(derived.nextDue.due_date).getDate()} · ${derived.nextDue.description ?? ""}`
              : "예정된 마감 없음",
            valStyle: {
              color: nextDueInfo?.color,
            },
          },
          {
            lbl: "기한 초과 태스크",
            val: `${derived.overdue.length}개`,
            sub: derived.overdue.length ? "즉시 확인 필요" : "기한 초과 없음",
            valStyle: {
              color: derived.overdue.length ? "var(--coral)" : "var(--green)",
            },
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
        {/* align-self:start — 그리드가 행 높이로 늘리면 강조 링이 카드보다 커지므로 콘텐츠 높이에 맞춘다 */}
        <div data-tour="ov-contrib" style={{ alignSelf: "start" }}>
          <Card
            icon="ti ti-chart-bar"
            title="기여도 현황"
            titleSuffix={
              <span
                className="live-dot"
                style={{ background: "var(--green)" }}
              />
            }
            extra={<span className="badge b-green">실시간</span>}
          >
            <div style={{ padding: "2px 18px 14px" }}>
              {contrib.length === 0 && (
                <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
                  아직 산정된 기여도가 없습니다. 회의를 진행하면 집계돼요.
                </div>
              )}
              {contrib.map((c) => {
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
                    <span
                      className="c-name"
                      data-tooltip={nicknameMap.get(c.user_id) ?? c.name}
                    >
                      <span>{nicknameMap.get(c.user_id) ?? c.name}</span>
                    </span>
                    <span className="c-bar">
                      <i
                        data-w={pct ?? 0}
                        style={{
                          width: 0,
                          background: memberColor(memberIdx(c.user_id)),
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
        </div>

        {/* 예정된 회의: .mini-meeting 전용 레이아웃이라 Card 컴포넌트 미사용.
            card-head/card-title 클래스는 헤더 스타일만 재사용. */}
        <div className="mini-meeting" data-tour="ov-meeting">
          <div className="card-head" style={{ padding: "0 0 10px" }}>
            <span className="card-title">
              <i className="ti ti-clock" /> 예정된 회의
            </span>
            {focusMeeting?.status === "active" ? (
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
              ? `${meetingDateLabel(focusMeeting)} · ${focusMeeting.total_minutes}분 · ${focusMeeting.meeting_type === "regular" ? "전체 회의" : "부분 회의"}`
              : "회의 관리에서 새 회의를 만들어 보세요."}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: "14px 0 4px",
            }}
          >
            <div style={{ display: "flex" }}>
              {(team?.members ?? []).slice(0, 5).map((m, i) => (
                <div
                  key={i}
                  className="av av-sm"
                  title={m.nickname ?? m.name}
                  style={{
                    background: avatarBg(i),
                    marginLeft: i === 0 ? 0 : -8,
                    boxShadow: "0 0 0 2px var(--surface)",
                  }}
                >
                  {(m.nickname ?? m.name)[0]}
                </div>
              ))}
            </div>
            <span
              style={{
                fontSize: 11.5,
                color: "var(--text-soft)",
                fontWeight: 600,
              }}
            >
              {team?.member_count ?? 0}명 참여
            </span>
          </div>
          <button
            className="btn btn-primary btn-full"
            style={{ marginTop: 12 }}
            onClick={() => navigate(`/dashboard/${team?.id}/meeting`)}
          >
            <i className="ti ti-arrow-right" />{" "}
            {focusMeeting?.status === "active"
              ? "회의 참여하기"
              : "회의 관리로 이동"}
          </button>
        </div>
      </div>

      {/* 미완료 태스크 */}
      <div data-tour="ov-tasks">
        <Card icon="ti ti-checklist" title="미완료 태스크">
          <div style={{ padding: "2px 16px 14px" }}>
            {derived.open.length === 0 && (
              <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
                미완료 태스크가 없습니다.
              </div>
            )}
            {derived.open.slice(0, 10).map((t) => {
              const due = taskDueLabel(t.due_date);
              const canCheck =
                t.assignee_id === null || t.assignee_id === currentUser?.id;
              return (
                <div key={t.id} className="task-mini">
                  <div
                    className="chk-mini"
                    style={{ cursor: canCheck ? "pointer" : "default" }}
                    onClick={canCheck ? () => void toggleTask(t) : undefined}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>{t.description}</div>
                    {t.detail && <div className="tm-detail">{t.detail}</div>}
                  </div>
                  <span
                    style={{
                      minWidth: 148,
                      textAlign: "right",
                      color: due ? due.color : "var(--text-soft)",
                      fontWeight: due ? 700 : undefined,
                    }}
                  >
                    {due ? due.text : "—"}
                  </span>
                  <span
                    style={{
                      minWidth: 56,
                      textAlign: "right",
                      color: "var(--text-soft)",
                    }}
                  >
                    {derived.nameById.get(t.assignee_id ?? -1) ?? "—"}
                  </span>
                </div>
              );
            })}
            {derived.open.length > 10 && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-soft)",
                  marginTop: 8,
                }}
              >
                +{derived.open.length - 10}개
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
