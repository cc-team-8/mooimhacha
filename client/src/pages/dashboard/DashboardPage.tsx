// 대시보드 셸: 사이드바 + 중첩 라우터. 서브페이지(overview/meeting/tasks/report)를 담는 레이아웃.
// dashboard.css 하나가 모든 서브페이지 스타일을 커버하므로 서브페이지에서 별도 import 불필요.
import {
  Routes,
  Route,
  Navigate,
  Outlet,
  useNavigate,
  useLocation,
  useParams,
} from "react-router-dom";
import { useState, useEffect } from "react";
import { getUser } from "@/lib/auth";
import { avatarBg } from "@/lib/avatarColor";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import { apiGet } from "@/lib/api";
import { createCompanionChannel } from "@/lib/companion";
import { useTourStore } from "@/stores/tourStore";
import { makeDashboardSteps } from "@/components/tour/steps";
import type {
  ActionItem,
  Meeting,
  AttendanceSummary,
} from "@/lib/types";
import OverviewPage from "./overview/OverviewPage";
import MeetingPage from "./meeting/MeetingPage";
import TasksPage from "./tasks/TasksPage";
import ReportPage from "./report/ReportPage";
import SettingsPage from "./settings/SettingsPage";
import "@/styles/dashboard.css";

export interface TeamContext {
  id: number;
  name: string;
  course_name: string;
  my_role: "leader" | "member";
  member_count: number;
  members: {
    user_id: number;
    name: string;
    nickname: string | null;
    role: string;
  }[];
}

const NAV_ITEMS = [
  { key: "overview", icon: "ti-layout-dashboard", label: "대시보드" },
  { key: "meeting", icon: "ti-video", label: "회의 관리" },
  { key: "tasks", icon: "ti-checklist", label: "태스크" },
  { key: "report", icon: "ti-chart-bar", label: "기여도 리포트" },
];

// NAV의 label과 별도로 관리: 헤더 타이틀은 아이콘·badge 없이 문자열만 필요하기 때문
const TITLE: Record<string, string> = {
  overview: "대시보드",
  meeting: "회의 관리",
  tasks: "태스크",
  report: "기여도 리포트",
  settings: "팀 설정",
};

export default function DashboardPage() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { teamId } = useParams<{ teamId: string }>();
  const current = pathname.split("/")[3] || "overview";
  const currentUser = getUser();
  const startTour = useTourStore((s) => s.start);
  const tourActive = useTourStore((s) => s.active);
  const [team, setTeam] = useState<TeamContext | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // 사이드바 배지: 진행 중 회의가 있을 때만 LIVE, 미완료 태스크 수
  const [hasLive, setHasLive] = useState(false);
  const [openTaskCount, setOpenTaskCount] = useState(0);
  // 처리할 일 알림(!): 회의=결석 동의 미처리, 태스크=팀장 연장 요청 대기
  const [hasAbsenceTodo, setHasAbsenceTodo] = useState(false);
  // 닉네임 인라인 편집
  const [editingNickname, setEditingNickname] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");

  useEffect(() => {
    if (!teamId) return;
    apiFetch<{ teams: TeamContext[] }>("/api/teams", { headers: authHeader() })
      .then((data) => {
        const found = data.teams.find((t) => t.id === Number(teamId));
        if (found) setTeam(found);
      })
      .catch(() => {});
    void Promise.allSettled([
      apiGet<Meeting[]>(`/meetings?team_id=${teamId}`),
      apiGet<ActionItem[]>(`/action-items?team_id=${teamId}&confirmed=true`),
      apiGet<AttendanceSummary[]>(`/teams/${teamId}/attendance-summary`),
    ]).then(([ms, ts, att]) => {
      if (ms.status === "fulfilled")
        setHasLive(ms.value.some((m) => m.status === "active"));
      if (ts.status === "fulfilled")
        setOpenTaskCount(
          ts.value.filter(
            (t) => t.status === "todo" || t.status === "in_progress",
          ).length,
        );
      if (att.status === "fulfilled")
        setHasAbsenceTodo(att.value.some((s) => s.pending_count > 0));
    });
  }, [teamId]);

  useEffect(() => {
    const ch = createCompanionChannel();
    ch.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string };
      if (msg.type === "meeting:ended") setHasLive(false);
    };
    return () => ch.close();
  }, []);

  // 대시보드 첫 방문 시 자동 안내(1회). 다른 투어(홈 가이드 등)가 진행 중이면
  // 끝난 뒤 자동으로 시작되게 active 를 의존성에 둔다.
  useEffect(() => {
    if (tourActive || !teamId) return;
    if (localStorage.getItem("mh_dash_tour_guided")) return;
    localStorage.setItem("mh_dash_tour_guided", "1");
    startTour(makeDashboardSteps(teamId));
  }, [tourActive, teamId, startTour]);

  const badgeFor = (key: string): { text: string; live: boolean } | null => {
    if (key === "meeting" && hasLive) return { text: "LIVE", live: true };
    if (key === "tasks" && openTaskCount > 0)
      return { text: String(openTaskCount), live: false };
    return null;
  };

  // 처리할 일 알림(!) 표시 여부
  const alertFor = (key: string): boolean => {
    if (key === "meeting") return hasAbsenceTodo;
    return false;
  };

  const myMember = team?.members.find((m) => m.user_id === currentUser?.id);
  const myIdx =
    team?.members.findIndex((m) => m.user_id === currentUser?.id) ?? 0;
  const displayName = myMember?.nickname ?? currentUser?.name ?? "";

  const handleSaveNickname = async () => {
    if (!teamId) return;
    const trimmed = nicknameInput.trim() || null;
    try {
      await apiFetch(`/api/teams/${teamId}/members/me/nickname`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ nickname: trimmed }),
      });
      setTeam((prev) =>
        prev
          ? {
              ...prev,
              members: prev.members.map((m) =>
                m.user_id === currentUser?.id ? { ...m, nickname: trimmed } : m,
              ),
            }
          : prev,
      );
      setEditingNickname(false);
    } catch {
      // 저장 실패 시 편집 상태 유지
    }
  };

  return (
    <div className="dash-shell" style={{ display: "flex", height: "100vh" }}>
      {/* 사이드바 */}
      <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
        <button className="sb-back" onClick={() => navigate("/home")}>
          <i className="ti ti-arrow-left" /> 내 그룹으로
        </button>

        <div className="sb-team">
          <div className="sb-team-badge">{team?.name[0] ?? "?"}</div>
          <div>
            <div className="sb-team-name">{team?.name ?? "팀 선택 안됨"}</div>
            <div className="sb-team-sub">
              팀원 {team?.member_count ?? "-"}명
            </div>
          </div>
        </div>

        <div className="sb-sec">메뉴</div>
        {NAV_ITEMS.map((n) => {
          const badge = badgeFor(n.key);
          const alert = alertFor(n.key);
          return (
            <div
              key={n.key}
              className={`nav-item ${current === n.key ? "active" : ""}`}
              onClick={() => navigate(`/dashboard/${teamId}/${n.key}`)}
            >
              <i className={`ti ${n.icon}`} />
              {n.label}
              {alert && (
                <span className="nav-alert" title="처리할 일이 있어요">
                  !
                </span>
              )}
              {badge && (
                <span className={`nbadge ${badge.live ? "live" : ""}`}>
                  {badge.text}
                </span>
              )}
            </div>
          );
        })}

        <div className="sb-members">
          <div className="sb-sec">팀원</div>
          {(team?.members ?? []).map((m, i) => (
            <div key={i} className="sb-mrow">
              <div className="av av-sm" style={{ background: avatarBg(i) }}>
                {(m.nickname ?? m.name)[0]}
              </div>
              <span className="sb-mname" data-tooltip={m.nickname ?? m.name}>
                <span>{m.nickname ?? m.name}</span>
              </span>
              {m.role === "leader" && <span className="leader-tag">팀장</span>}
              {m.user_id === currentUser?.id && (
                <span className="me-tag">나</span>
              )}
            </div>
          ))}
        </div>

        <div className="sb-spacer" />
        <div
          className={`nav-item ${current === "settings" ? "active" : ""}`}
          onClick={() => navigate(`/dashboard/${teamId}/settings`)}
        >
          <i className="ti ti-settings" />
          팀 설정
        </div>
        <div className="sb-user">
          <div className="av av-md" style={{ background: avatarBg(myIdx) }}>
            {displayName[0] ?? "?"}
          </div>
          {editingNickname ? (
            <div className="sb-nick-edit">
              <input
                className="sb-nick-input"
                value={nicknameInput}
                onChange={(e) => setNicknameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveNickname();
                  if (e.key === "Escape") setEditingNickname(false);
                }}
                maxLength={50}
                autoFocus
                placeholder={currentUser?.name ?? ""}
              />
              <div className="sb-nick-actions">
                <button
                  className="sb-nick-btn"
                  onClick={() => void handleSaveNickname()}
                  title="저장"
                >
                  <i className="ti ti-check" />
                </button>
                <button
                  className="sb-nick-btn"
                  onClick={() => setEditingNickname(false)}
                  title="취소"
                >
                  <i className="ti ti-x" />
                </button>
              </div>
            </div>
          ) : (
            <>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="sb-user-name">{displayName}</div>
                <div className="sb-user-role">
                  {team?.my_role === "leader" ? "팀장" : "팀원"}
                </div>
              </div>
              <button
                className="sb-nick-edit-btn"
                onClick={() => {
                  setNicknameInput(myMember?.nickname ?? "");
                  setEditingNickname(true);
                }}
                title="닉네임 편집"
              >
                <i className="ti ti-pencil" />
              </button>
            </>
          )}
        </div>
      </aside>

      {/* 메인 영역 */}
      <div className="main-area">
        <div className="main-top">
          <button
            className="sb-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <i
              className={`ti ${sidebarOpen ? "ti-layout-sidebar-left-collapse" : "ti-layout-sidebar-left-expand"}`}
            />
          </button>
          <div className="main-title">{TITLE[current] ?? "대시보드"}</div>
          {/* 대시보드 가이드 재시작 — 우측 정렬 */}
          <button
            className="dash-guide-btn"
            onClick={() => teamId && startTour(makeDashboardSteps(teamId))}
            aria-label="대시보드 가이드 다시 보기"
          >
            <i className="ti ti-help" /> 가이드
          </button>
        </div>
        <div className="main-content scroll">
          <Routes>
            <Route element={<Outlet context={team} />}>
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<OverviewPage />} />
              <Route path="meeting" element={<MeetingPage />} />
              <Route path="tasks" element={<TasksPage />} />
              <Route path="report" element={<ReportPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Routes>
        </div>
      </div>
    </div>
  );
}
