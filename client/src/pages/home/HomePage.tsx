import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { getUser, clearSession } from "@/lib/auth";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import Card from "@/components/Card";
import ProfileEditModal from "@/components/ProfileEditModal";
import type {
  ActionItem,
  Meeting,
  Notification,
  TeamContribution,
} from "@/lib/types";
import "@/styles/home.css";

interface Team {
  id: number;
  name: string;
  course_name: string;
  my_role: "leader" | "member";
  member_count: number;
  members: string[];
}

// 내 태스크/예정 회의에 소속 그룹 이름을 같이 표기하기 위한 합성 타입
interface MyTask extends ActionItem {
  group: string;
}
interface UpcomingMeeting extends Meeting {
  group: string;
  groupCls: string;
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return { text: "기한 초과", cls: "due-red" };
  if (diff === 0) return { text: "오늘 마감", cls: "due-red" };
  if (diff === 1) return { text: "내일 마감", cls: "due-red" };
  return {
    text: `${d.getMonth() + 1}월 ${d.getDate()}일`,
    cls: diff <= 3 ? "due-amber" : "due-soft",
  };
}

// 알림 종류 → 아이콘/색
const NOTI_STYLE: Record<string, { icon: string; color: string }> = {
  meeting_soon: { icon: "ti ti-clock", color: "var(--amber)" },
  action_assigned: { icon: "ti ti-checklist", color: "var(--blue)" },
  meeting_confirmed: { icon: "ti ti-video", color: "var(--green)" },
};

export default function HomePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const user = getUser();
  const userName = user?.name ?? "사용자";
  const userInitial = userName[0];
  const [teams, setTeams] = useState<Team[]>([]);
  const [tasks, setTasks] = useState<MyTask[]>([]);
  const [meetings, setMeetings] = useState<UpcomingMeeting[]>([]);
  const [notis, setNotis] = useState<Notification[]>([]);
  // 그룹 카드의 '내 기여도' (team_id → 0~100 또는 null)
  const [myContrib, setMyContrib] = useState<Map<number, number | null>>(
    new Map(),
  );
  const [joinCode, setJoinCode] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [notiOpen, setNotiOpen] = useState(false);
  const [profileEditOpen, setProfileEditOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const notiRef = useRef<HTMLDivElement>(null);

  const fetchTeams = () => {
    apiFetch<{ teams: Team[] }>("/api/teams", { headers: authHeader() })
      .then((data) => setTeams(data.teams))
      .catch(() => {});
  };

  useEffect(() => {
    fetchTeams();
    apiGet<Notification[]>("/notifications")
      .then(setNotis)
      .catch(() => {});
  }, []);

  // 팀 목록이 잡히면 팀별 데이터(내 태스크·예정 회의·내 기여도)를 모아온다
  useEffect(() => {
    if (teams.length === 0 || !user) return;
    let alive = true;
    void Promise.allSettled(
      teams.map(async (t) => {
        const badgeCls = t.my_role === "leader" ? "b-green" : "b-blue";
        const [ts, ms, cs] = await Promise.allSettled([
          apiGet<ActionItem[]>(
            `/action-items?team_id=${t.id}&assignee_id=${user.id}`,
          ),
          apiGet<Meeting[]>(`/meetings?team_id=${t.id}`),
          apiGet<{ members: TeamContribution[] }>(
            `/teams/${t.id}/contributions`,
          ),
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
      if (notiRef.current && !notiRef.current.contains(e.target as Node))
        setNotiOpen(false);
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

  async function readNotification(n: Notification) {
    if (n.read) return;
    setNotis((prev) =>
      prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)),
    );
    try {
      await apiPatch(`/notifications/${n.id}/read`);
    } catch {
      // 읽음 처리 실패는 치명적이지 않음 — 다음 로드에서 동기화
    }
  }

  const unreadCount = notis.filter((n) => !n.read).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* 상단 네비 */}
      <div className="topnav">
        <div className="tn-logo">
          무임<em>하차</em>
        </div>
        <div className="tn-right">
          <button
            className="btn btn-primary btn-sm"
            onClick={() => navigate("/onboarding")}
          >
            <i className="ti ti-plus" /> 새 그룹
          </button>
          <div className="noti-wrap" ref={notiRef}>
            <button className="tn-icon" onClick={() => setNotiOpen((v) => !v)}>
              {unreadCount > 0 && <span className="dot" />}
              <i className="ti ti-bell" />
            </button>
            {notiOpen && (
              <div className="noti-dropdown">
                <div className="nd-head">
                  알림
                  {unreadCount > 0 && (
                    <span className="nd-badge">{unreadCount}</span>
                  )}
                </div>
                <div className="nd-divider" />
                {notis.length === 0 && (
                  <div
                    style={{
                      padding: "16px 14px",
                      fontSize: 12.5,
                      color: "var(--text-soft)",
                    }}
                  >
                    새 알림이 없습니다.
                  </div>
                )}
                {notis.slice(0, 8).map((n) => {
                  const st = NOTI_STYLE[n.type] ?? {
                    icon: "ti ti-bell",
                    color: "var(--text-soft)",
                  };
                  return (
                    <div
                      key={n.id}
                      className={`nd-item ${!n.read ? "unread" : ""}`}
                      onClick={() => void readNotification(n)}
                      style={{ cursor: "pointer" }}
                    >
                      <div
                        className="nd-icon"
                        style={{ background: st.color + "22", color: st.color }}
                      >
                        <i className={st.icon} />
                      </div>
                      <div className="nd-body">
                        <div className="nd-text">{n.title}</div>
                        <div className="nd-time">{relTime(n.created_at)}</div>
                      </div>
                      {!n.read && <div className="nd-dot" />}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
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
                      {team.members.slice(0, 4).map((name, i) => (
                        <div key={i} className={`av a${(i % 4) + 1} av-sm`}>
                          {name[0]}
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
                onClick={() => navigate("/onboarding")}
              >
                <div className="ng-circle">
                  <i className="ti ti-plus" />
                </div>
                <div className="ng-txt">새 그룹 만들기</div>
              </div>
            </div>

            <div className="join-box">
              <div className="join-label">
                <i className="ti ti-key" /> 초대코드로 참가
              </div>
              <div className="join-row">
                <input
                  className="join-input"
                  placeholder="ABCD1234"
                  maxLength={8}
                  value={joinCode}
                  onChange={(e) => fmtCode(e.target.value)}
                />
                <button className="btn btn-primary" onClick={joinGroup}>
                  참가하기
                </button>
              </div>
            </div>
          </div>

          {/* 내 태스크 + 최근 활동 */}
          <div className="reveal" style={{ animationDelay: ".16s" }}>
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
                        <div style={{ flex: 1 }}>
                          <div className="t-name">{t.description}</div>
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

            <Card icon="ti ti-activity" title="최근 활동">
              <div style={{ padding: "2px 14px 12px" }}>
                {notis.length === 0 && (
                  <div
                    style={{
                      padding: "14px 0",
                      fontSize: 12.5,
                      color: "var(--text-soft)",
                    }}
                  >
                    아직 활동 기록이 없습니다.
                  </div>
                )}
                {notis.slice(0, 4).map((n) => {
                  const st = NOTI_STYLE[n.type] ?? {
                    icon: "ti ti-bell",
                    color: "var(--text-soft)",
                  };
                  return (
                    <div key={n.id} className="activity-row">
                      <div
                        className="act-dot"
                        style={{ background: st.color }}
                      />
                      <div className="act-body">{n.title}</div>
                      <div className="act-time">{relTime(n.created_at)}</div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* 예정된 회의 */}
            <div className="sec-head" style={{ marginTop: 18 }}>
              <div className="sec-title">
                <i className="ti ti-calendar-event" /> 예정된 회의
              </div>
              <span className="sec-count">{meetings.length}개</span>
            </div>
            <div className="meet-grid">
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
                    onClick={() => navigate(`/dashboard/${m.team_id}/meeting`)}
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
          </div>
        </div>
      </div>
      {profileEditOpen && (
        <ProfileEditModal onClose={() => setProfileEditOpen(false)} />
      )}
    </div>
  );
}
