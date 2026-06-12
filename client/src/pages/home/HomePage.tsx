import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { getUser, clearSession } from "@/lib/auth";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import Card from "@/components/Card";
import "@/styles/home.css";

interface Team {
  id: number;
  name: string;
  course_name: string;
  my_role: "leader" | "member";
  member_count: number;
  members: string[];
}

const TASKS = [
  {
    name: "최종 슬라이드 디자인",
    group: "캡스톤 팀 A",
    due: "내일 마감",
    dueCls: "due-red",
  },
  {
    name: "발표 스크립트 작성",
    group: "캡스톤 팀 A",
    due: "5월 11일",
    dueCls: "due-amber",
  },
  {
    name: "4주차 알고리즘 풀이",
    group: "알고리즘 스터디",
    due: "5월 13일",
    dueCls: "due-amber",
  },
];

const ACTIVITY = [
  {
    color: "var(--coral)",
    text: (
      <>
        <b>박지호</b>님 태스크 2개 기한 초과
      </>
    ),
    time: "10분 전",
  },
  {
    color: "var(--green)",
    text: (
      <>
        <b>캡스톤 팀 A</b> 회의 진행 중
      </>
    ),
    time: "1시간 전",
  },
  {
    color: "var(--amber)",
    text: (
      <>
        <b>이서연</b>님이 액션아이템 완료
      </>
    ),
    time: "어제",
  },
  {
    color: "var(--text-soft)",
    text: (
      <>
        <b>알고리즘 스터디</b>에 강민재님 합류
      </>
    ),
    time: "2일 전",
  },
];

const MEETINGS = [
  {
    live: true,
    title: "발표 준비 회의",
    date: "오늘",
    time: "오후 3:00",
    members: 4,
    group: "캡스톤 팀 A",
    groupCls: "b-green",
  },
  {
    soon: true,
    d: "11",
    m: "5월",
    title: "최종 발표 리허설",
    time: "오후 2:00",
    members: 4,
    agenda: 2,
    group: "캡스톤 팀 A",
    groupCls: "b-green",
    label: "2일 후",
  },
  {
    d: "13",
    m: "5월",
    title: "4주차 알고리즘 풀이",
    time: "오후 8:00",
    members: 5,
    agenda: 1,
    group: "알고리즘 스터디",
    groupCls: "b-gray",
    label: "4일 후",
  },
];

export default function HomePage() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const user = getUser();
  const userName = user?.name ?? "사용자";
  const userInitial = userName[0];
  const [teams, setTeams] = useState<Team[]>([]);
  const [tasks, setTasks] = useState(TASKS);
  const [joinCode, setJoinCode] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [notiOpen, setNotiOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement>(null);
  const notiRef = useRef<HTMLDivElement>(null);

  const fetchTeams = () => {
    apiFetch<{ teams: Team[] }>("/api/teams", { headers: authHeader() })
      .then((data) => setTeams(data.teams))
      .catch(() => {});
  };

  useEffect(() => {
    fetchTeams();
  }, []);

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

  function completeTask(idx: number) {
    setTasks((prev) => prev.filter((_, i) => i !== idx));
  }

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
              <span className="dot" />
              <i className="ti ti-bell" />
            </button>
            {notiOpen && (
              <div className="noti-dropdown">
                <div className="nd-head">
                  알림
                  <span className="nd-badge">5</span>
                </div>
                <div className="nd-divider" />
                {[
                  {
                    icon: "ti ti-clock",
                    color: "var(--coral)",
                    text: "박지호님 태스크 2개 기한 초과",
                    time: "10분 전",
                    unread: true,
                  },
                  {
                    icon: "ti ti-video",
                    color: "var(--green)",
                    text: "캡스톤 팀 A 회의가 시작됐어요",
                    time: "1시간 전",
                    unread: true,
                  },
                  {
                    icon: "ti ti-circle-check",
                    color: "var(--blue)",
                    text: "이서연님이 액션아이템 완료",
                    time: "어제",
                    unread: false,
                  },
                  {
                    icon: "ti ti-user-plus",
                    color: "var(--amber)",
                    text: "강민재님이 알고리즘 스터디 합류",
                    time: "2일 전",
                    unread: false,
                  },
                  {
                    icon: "ti ti-message",
                    color: "var(--text-soft)",
                    text: "마케팅원론 조별과제 새 댓글",
                    time: "3일 전",
                    unread: false,
                  },
                ].map((n, i) => (
                  <div
                    key={i}
                    className={`nd-item ${n.unread ? "unread" : ""}`}
                  >
                    <div
                      className="nd-icon"
                      style={{ background: n.color + "22", color: n.color }}
                    >
                      <i className={n.icon} />
                    </div>
                    <div className="nd-body">
                      <div className="nd-text">{n.text}</div>
                      <div className="nd-time">{n.time}</div>
                    </div>
                    {n.unread && <div className="nd-dot" />}
                  </div>
                ))}
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
                <div className="pd-item">
                  <i className="ti ti-user" /> 프로필 편집
                </div>
                <div className="pd-item">
                  <i className="ti ti-settings" /> 설정
                </div>
                <div className="pd-divider" />
                <div
                  className="pd-item danger"
                  onClick={() => {
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
                        style={{ color: "var(--text-soft)" }}
                      >
                        -%
                      </span>
                    </div>
                    <div className="gc-bar">
                      <i
                        style={{ width: "0%", background: "var(--border-2)" }}
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
                  tasks.map((t, i) => (
                    <div key={i} className="task-row">
                      <div className="t-check" onClick={() => completeTask(i)}>
                        <i className="ti ti-check" />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="t-name">{t.name}</div>
                        <div className="t-meta">
                          <span className="t-group">{t.group}</span>
                          <span className={`t-due ${t.dueCls}`}>{t.due}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </Card>

            <Card icon="ti ti-activity" title="최근 활동">
              <div style={{ padding: "2px 14px 12px" }}>
                {ACTIVITY.map((a, i) => (
                  <div key={i} className="activity-row">
                    <div className="act-dot" style={{ background: a.color }} />
                    <div className="act-body">{a.text}</div>
                    <div className="act-time">{a.time}</div>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>

        {/* 예정된 회의 */}
        <div
          className="reveal"
          style={{ animationDelay: ".22s", marginTop: 18 }}
        >
          <div className="sec-head">
            <div className="sec-title">
              <i className="ti ti-calendar-event" /> 예정된 회의
            </div>
            <span className="sec-count">3개</span>
          </div>
          <div className="meet-grid">
            {MEETINGS.map((m, i) => (
              <div
                key={i}
                className={`meet ${m.live ? "live" : ""} ${m.soon ? "soon" : ""}`}
                onClick={() => navigate("/dashboard")}
              >
                <div className="meet-top">
                  {m.live ? (
                    <span className="badge b-coral">
                      <span className="live-dot" /> 진행 중
                    </span>
                  ) : (
                    <div className="date-chip">
                      <span className="d">{m.d}</span>
                      <span className="m">{m.m}</span>
                    </div>
                  )}
                  <span className={`badge ${m.groupCls}`}>{m.group}</span>
                </div>
                <div className="meet-title">{m.title}</div>
                <div className="meet-meta">
                  {m.date && (
                    <span>
                      <i className="ti ti-calendar" /> {m.date}
                    </span>
                  )}
                  <span>
                    <i className="ti ti-clock" /> {m.time}
                  </span>
                  <span>
                    <i className="ti ti-users" /> {m.members}명
                  </span>
                  {m.agenda && (
                    <span>
                      <i className="ti ti-list" /> 아젠다 {m.agenda}
                    </span>
                  )}
                </div>
                <div className="meet-foot">
                  {m.live ? (
                    <button className="btn btn-danger btn-sm btn-full">
                      <i className="ti ti-arrow-right" /> 회의 참여
                    </button>
                  ) : (
                    <div
                      className="btn btn-sm btn-full"
                      style={{ cursor: "default" }}
                    >
                      <i className="ti ti-calendar-plus" /> {m.label}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
