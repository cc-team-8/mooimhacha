import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { avatarBg } from "@/lib/avatarColor";
import { useToast } from "@/hooks/useToast";
import { getUser, clearSession } from "@/lib/auth";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import { useTourStore } from "@/stores/tourStore";
import { HOME_STEPS } from "@/components/tour/steps";
import Card from "@/components/Card";
import Modal from "@/components/Modal";
import ProfileEditModal from "@/components/ProfileEditModal";
import type {
  ActionItem,
  Meeting,
  TeamContribution,
  PendingConsent,
} from "@/lib/types";
import "@/styles/home.css";

interface Team {
  id: number;
  name: string;
  course_name: string;
  my_role: "leader" | "member";
  member_count: number;
  members: { name: string; nickname?: string | null; role: string }[];
}

// 내 태스크/예정 회의에 소속 그룹 이름을 같이 표기하기 위한 합성 타입
interface MyTask extends ActionItem {
  group: string;
}
interface UpcomingMeeting extends Meeting {
  group: string;
  groupCls: string;
}

interface TodoItem {
  type: "consent";
  team_id: number;
  team_name: string;
  label: string;
  created_at: string;
}

// 상대 시각 표기 (알림·활동)
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "어제";
  return `${day}일 전`;
}

// 마감 표기 (내 태스크)
function dueInfo(due: string | null): { text: string; cls: string } | null {
  if (!due) return null;
  const d = new Date(due);
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const dow = DAYS[d.getDay()];
  const h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 || 12;
  const dDay = diff < 0 ? `D+${Math.abs(diff)}` : `D-${diff}`;
  const cls =
    diff < 0
      ? "due-red"
      : diff <= 1
        ? "due-red"
        : diff <= 3
          ? "due-amber"
          : "due-soft";
  return { text: `${m}/${day}(${dow}) ${ampm} ${h12}:${min} ${dDay}`, cls };
}

export default function HomePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const startTour = useTourStore((s) => s.start);
  const user = getUser();
  const userName = user?.name ?? "사용자";
  const userInitial = userName[0];
  const [teams, setTeams] = useState<Team[]>([]);
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  // 그룹 카드의 '내 기여도' (team_id → 0~100 또는 null)
  const [myContrib, setMyContrib] = useState<Map<number, number | null>>(
    new Map(),
  );
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [joinCode, setJoinCode] = useState("");
  const [joinModalOpen, setJoinModalOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);

  const fetchTeams = () => {
    apiFetch<{ teams: Team[] }>("/api/teams", { headers: authHeader() })
      .then((data) => setTeams(data.teams))
      .catch(() => {});
  };

  useEffect(() => {
    fetchTeams();
  }, []);

  // 첫 로그인(이 브라우저에서 가이드를 처음 보는 경우) 자동 안내 — 1회만 실행.
  // 이후엔 '내 그룹' 우측의 "무임하차가 처음이신가요?" 버튼으로 다시 볼 수 있다.
  useEffect(() => {
    if (!localStorage.getItem("mh_tour_guided")) {
      localStorage.setItem("mh_tour_guided", "1");
      startTour(HOME_STEPS);
    }
  }, [startTour]);

  // 팀 목록이 잡히면 팀별 데이터(내 태스크·예정 회의·내 기여도)를 모아온다
  useEffect(() => {
    if (teams.length === 0 || !user) return;
    let alive = true;
    void Promise.allSettled(
      teams.map(async (t) => {
        const badgeCls = t.my_role === "leader" ? "b-green" : "b-blue";
        const [ts, ms, cs, consents] = await Promise.allSettled([
          apiGet<ActionItem[]>(
            `/action-items?team_id=${t.id}&assignee_id=${user.id}&confirmed=true`,
          ),
          apiGet<Meeting[]>(`/meetings?team_id=${t.id}`),
          apiGet<{ members: TeamContribution[] }>(
            `/teams/${t.id}/contributions`,
          ),
          apiGet<PendingConsent[]>(`/teams/${t.id}/pending-consents`),
        ]);
        return {
          team: t,
          tasks:
            ts.status === "fulfilled"
              ? ts.value
                  .filter(
                    (a) => a.status === "todo" || a.status === "in_progress",
                  )
                  .map((a) => ({ ...a, group: t.name }))
              : [],
          meetings:
            ms.status === "fulfilled"
              ? ms.value
                  .filter(
                    (m) => m.status === "scheduled" || m.status === "active",
                  )
                  .map((m) => ({ ...m, group: t.name, groupCls: badgeCls }))
              : [],
          contrib:
            cs.status === "fulfilled"
              ? (cs.value.members.find((c) => c.user_id === user.id)
                  ?.composite_score ?? null)
              : null,
          todos: [
            ...(consents.status === "fulfilled"
              ? consents.value.map((c) => ({
                  type: "consent" as const,
                  team_id: t.id,
                  team_name: t.name,
                  label: `${c.user_name} · ${c.meeting_topic}`,
                  created_at: c.created_at,
                }))
              : []),
          ],
        };
      }),
    ).then((results) => {
      if (!alive) return;
      const ok = results
        .filter(
          (
            r,
          ): r is PromiseFulfilledResult<{
            team: Team;
            tasks: MyTask[];
            meetings: UpcomingMeeting[];
            contrib: number | null;
            todos: TodoItem[];
          }> => r.status === "fulfilled",
        )
        .map((r) => r.value);
      setTasks(
        ok
          .flatMap((r) => r.tasks)
          .sort((a, b) => {
            if (!a.due_date) return 1;
            if (!b.due_date) return -1;
            return (
              new Date(a.due_date).getTime() - new Date(b.due_date).getTime()
            );
          }),
      );
      setMeetings(
        ok
          .flatMap((r) => r.meetings)
          .sort((a, b) => {
            // 진행 중 우선, 이후 가까운 일정 순
            if (a.status !== b.status) return a.status === "active" ? -1 : 1;
            return (
              new Date(a.scheduled_at).getTime() -
              new Date(b.scheduled_at).getTime()
            );
          })
          .slice(0, 6),
      );
      setTodos(
        ok
          .flatMap((r) => r.todos)
          .sort(
            (a, b) =>
              new Date(a.created_at).getTime() -
              new Date(b.created_at).getTime(),
          ),
      );
      setMyContrib(
        new Map(
          ok.map((r) => [
            r.team.id,
            r.contrib == null ? null : Math.round(r.contrib * 100),
          ]),
        ),
      );
    });
    return () => {
      alive = false;
    };
    // user는 토큰에서 파싱되는 고정값이라 의존성에서 제외
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (profileRef.current && !profileRef.current.contains(e.target as Node))
        setProfileOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function fmtCode(v: string) {
    setJoinCode(
      v
        .replace(/[^A-Za-z0-9]/g, "")
        .toUpperCase()
        .slice(0, 8),
    );
  }

  async function joinGroup() {
    if (joinCode.length !== 8) {
      showToast("초대코드 8자리를 입력해주세요");
      return;
    }
    try {
      const data = await apiFetch<{ name: string }>("/api/teams/join", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ invite_code: joinCode }),
      });
      showToast(`${data.name} 참가 완료`);
      setJoinCode("");
      setJoinModalOpen(false);
      fetchTeams();
    } catch (err) {
      showToast((err as Error).message || "참가 요청 실패");
    }
  }

  async function completeTask(task: MyTask) {
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    try {
      await apiPatch(`/action-items/${task.id}`, { status: "done" });
      showToast("태스크를 완료했습니다");
    } catch (err) {
      setTasks((prev) => [...prev, task]);
      showToast((err as Error).message, "error");
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 상단 네비 */}
      <div className="topnav">
        <div className="tn-logo">
          무임<em>하차</em>
        </div>
        <div className="tn-right">
          <button className="btn btn-sm" onClick={() => setJoinModalOpen(true)}>
            <i className="ti ti-key" /> 그룹 참가
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => navigate("/onboarding")}
          >
            <i className="ti ti-plus" /> 새 그룹
          </button>
          <div className="profile-wrap" ref={profileRef}>
            <div
              className="av a1 av-md"
              style={{ cursor: "pointer", overflow: "hidden" }}
              onClick={() => setProfileOpen((v) => !v)}
            >
              {user?.picture ? (
                <img
                  src={user.picture}
                  alt={userName}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    display: "block",
                  }}
                />
              ) : (
                userInitial
              )}
            </div>
            {profileOpen && (
              <div className="profile-dropdown">
                <div className="pd-header">
                  <div className="av a1 av-md" style={{ overflow: "hidden" }}>
                    {user?.picture ? (
                      <img
                        src={user.picture}
                        alt={userName}
                        style={{
                          width: "100%",
                          height: "100%",
                          objectFit: "cover",
                          display: "block",
                        }}
                      />
                    ) : (
                      userInitial
                    )}
                  </div>
                  <div className="pd-info">
                    <div className="pd-name">{userName}</div>
                    <div className="pd-email"></div>
                  </div>
                </div>
                <div className="pd-divider" />
                <div
                  className="pd-item"
                  onClick={() => {
                    setProfileOpen(false);
                    setProfileEditOpen(true);
                  }}
                >
                  <i className="ti ti-user" /> 프로필 편집
                </div>
                <div className="pd-divider" />
                <div
                  className="pd-item danger"
                  onClick={() => {
                    // 서버에 로그아웃 통지(향후 refresh token 폐기 대비) — 실패해도 로컬 세션은 정리
                    void apiPost("/auth/logout").catch(() => {});
                    clearSession();
                    navigate("/");
                  }}
                >
                  <i className="ti ti-logout" /> 로그아웃
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="home-body scroll">
        <div className="reveal" style={{ animationDelay: ".04s" }}>
          <div className="greet-title">안녕하세요, {userName}님</div>
          <div className="greet-sub">
            현재 {teams.length}개 그룹에 참여 중이에요.
          </div>
        </div>

        <div className="home-cols">
          {/* 내 그룹 */}
          <div className="reveal" style={{ animationDelay: ".1s" }}>
            <div className="sec-head">
              <div className="sec-title">
                <i className="ti ti-users-group" /> 내 그룹
              </div>
              <span className="sec-count">{teams.length}개 참여 중</span>
              {/* 가이드 투어 재시작 — 우측 정렬(margin-left:auto) */}
              <button
                className="tour-cta"
                onClick={() => startTour(HOME_STEPS)}
                aria-label="가이드 투어 다시 보기"
              >
                <i className="ti ti-help" /> 무임하차가 처음이신가요?
              </button>
            </div>
            <div className="groups-grid">
              {teams.map((team) => {
                const isLeader = team.my_role === "leader";
                const color = isLeader ? "var(--green)" : "var(--blue)";
                const badgeCls = isLeader ? "b-green" : "b-blue";
                return (
                  <div
                    key={team.id}
                    className="group-card"
                    onClick={() => navigate(`/dashboard/${team.id}`)}
                  >
                    <div className="gc-stripe" style={{ background: color }} />
                    <div className="gc-top">
                      <div className="gc-name">{team.name}</div>
                      <span className={`badge ${badgeCls}`}>
                        {team.course_name}
                      </span>
                    </div>
                    <div className="gc-avs">
                      {team.members.slice(0, 4).map((m, i) => (
                        <div
                          key={i}
                          className="av av-sm"
                          style={{ background: avatarBg(i) }}
                        >
                          {(m.nickname ?? m.name)[0]}
                        </div>
                      ))}
                      <span className="gc-more">{team.member_count}명</span>
                    </div>
                    <div className="gc-contrib-row">
                      <span className="lbl">내 기여도</span>
                      <span
                        className="val"
                        style={
                          myContrib.get(team.id) == null
                            ? { color: "var(--text-soft)" }
                            : undefined
                        }
                      >
                        {myContrib.get(team.id) == null
                          ? "-%"
                          : `${myContrib.get(team.id)}%`}
                      </span>
                    </div>
                    <div className="gc-bar">
                      <i
                        style={{
                          width: `${myContrib.get(team.id) ?? 0}%`,
                          background:
                            myContrib.get(team.id) == null
                              ? "var(--border-2)"
                              : color,
                        }}
                      />
                    </div>
                    <div className="gc-foot">
                      <span className={`badge ${badgeCls}`}>
                        {isLeader ? "팀장" : "팀원"}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div
                className="new-group"
                data-tour="new-group-card"
                onClick={() => navigate("/onboarding")}
              >
                <div className="ng-circle">
                  <i className="ti ti-plus" />
                </div>
                <div className="ng-txt">새 그룹 만들기</div>
              </div>
            </div>
          </div>

          {/* 내 현황 */}
          <div className="reveal" style={{ animationDelay: ".16s" }}>
            <div className="sec-head">
              <div className="sec-title">
                <i className="ti ti-layout-grid" /> 내 현황
              </div>
            </div>
            {todos.length > 0 && (
              <Card
                icon="ti ti-bell-ringing"
                title="처리할 일"
                extra={<span className="card-link">{todos.length}개</span>}
                style={{ marginBottom: 14 }}
              >
                <div style={{ padding: "2px 14px 12px" }}>
                  {todos.map((item, i) => (
                    <div
                      key={i}
                      className="activity-row"
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        navigate(`/dashboard/${item.team_id}/meeting`)
                      }
                    >
                      <div
                        className="act-dot"
                        style={{ background: "var(--blue)" }}
                      />
                      <div className="act-body" style={{ flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {item.label}
                        </div>
                        <div
                          style={{ fontSize: 11, color: "var(--text-soft)" }}
                        >
                          {item.team_name} · 결석 사유 동의
                        </div>
                      </div>
                      <div className="act-time">{relTime(item.created_at)}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <Card
              icon="ti ti-checklist"
              title="내 태스크"
              extra={<span className="card-link">{tasks.length}개</span>}
              style={{ marginBottom: 14 }}
            >
              <div style={{ padding: "2px 12px 12px" }}>
                {tasks.length === 0 ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 7,
                      padding: "22px 0",
                      color: "var(--text-soft)",
                    }}
                  >
                    <i
                      className="ti ti-circle-check"
                      style={{ fontSize: 28, color: "var(--green)" }}
                    />
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                      처리할 태스크가 없어요
                    </span>
                  </div>
                ) : (
                  tasks.map((t) => {
                    const due = dueInfo(t.due_date);
                    return (
                      <div key={t.id} className="task-row">
                        <div
                          className="t-check"
                          onClick={() => void completeTask(t)}
                        >
                          <i className="ti ti-check" />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="t-name">{t.description}</div>
                          {t.detail && (
                            <div className="t-detail">{t.detail}</div>
                          )}
                          <div className="t-meta">
                            <span className="t-group">{t.group}</span>
                            {due && (
                              <span className={`t-due ${due.cls}`}>
                                {due.text}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>

            <Card
              icon="ti ti-calendar-event"
              title="예정된 회의"
              extra={<span className="card-link">{meetings.length}개</span>}
              style={{ marginTop: 14 }}
            >
              <div className="meet-grid" style={{ padding: "6px 14px 14px" }}>
                {meetings.length === 0 && (
                  <div
                    style={{
                      padding: "16px 4px",
                      fontSize: 12.5,
                      color: "var(--text-soft)",
                    }}
                  >
                    예정된 회의가 없습니다. 그룹 대시보드에서 회의를 만들어
                    보세요.
                  </div>
                )}
                {meetings.map((m) => {
                  const live = m.status === "active";
                  const d = new Date(m.scheduled_at);
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);
                  const dday = Math.round(
                    (new Date(d).setHours(0, 0, 0, 0) - today.getTime()) /
                      86400000,
                  );
                  const label =
                    dday <= 0 ? "오늘" : dday === 1 ? "내일" : `${dday}일 후`;
                  const time = d.toLocaleTimeString("ko-KR", {
                    hour: "numeric",
                    minute: "2-digit",
                  });
                  return (
                    <div
                      key={m.id}
                      className={`meet ${live ? "live" : ""} ${!live && dday <= 2 ? "soon" : ""}`}
                      onClick={() =>
                        navigate(`/dashboard/${m.team_id}/meeting`)
                      }
                    >
                      <div className="meet-top">
                        {live ? (
                          <span className="badge b-coral">
                            <span className="live-dot" /> 진행 중
                          </span>
                        ) : (
                          <div className="date-chip">
                            <span className="d">{d.getDate()}</span>
                            <span className="m">{d.getMonth() + 1}월</span>
                          </div>
                        )}
                        <span className={`badge ${m.groupCls}`}>{m.group}</span>
                      </div>
                      <div className="meet-title">
                        {m.topic ?? "제목 없는 회의"}
                      </div>
                      <div className="meet-meta">
                        <span>
                          <i className="ti ti-clock" /> {time}
                        </span>
                        <span>
                          <i className="ti ti-hourglass" /> {m.total_minutes}분
                        </span>
                      </div>
                      <div className="meet-foot">
                        {live ? (
                          <button className="btn btn-danger btn-sm btn-full">
                            <i className="ti ti-arrow-right" /> 회의 참여
                          </button>
                        ) : (
                          <div
                            className="btn btn-sm btn-full"
                            style={{ cursor: "default" }}
                          >
                            <i className="ti ti-calendar-plus" /> {label}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </div>
      </div>
      {joinModalOpen && (
        <Modal
          title="초대코드로 참가"
          onClose={() => {
            setJoinModalOpen(false);
            setJoinCode("");
          }}
          actions={
            <>
              <button
                className="btn"
                onClick={() => {
                  setJoinModalOpen(false);
                  setJoinCode("");
                }}
              >
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void joinGroup()}
              >
                참가하기
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">초대코드</label>
            <input
              className="input"
              placeholder="ABCD1234"
              maxLength={8}
              value={joinCode}
              onChange={(e) => fmtCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing)
                  void joinGroup();
              }}
              autoFocus
            />
          </div>
        </Modal>
      )}
      {profileEditOpen && (
        <ProfileEditModal onClose={() => setProfileEditOpen(false)} />
      )}
    </div>
  );
}
