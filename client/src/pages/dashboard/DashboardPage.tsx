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
import { apiFetch, authHeader } from "@/lib/apiFetch";
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
  members: string[];
}

const NAV_ITEMS = [
  { key: "overview", icon: "ti-layout-dashboard", label: "대시보드" },
  {
    key: "meeting",
    icon: "ti-video",
    label: "회의 관리",
    badge: "LIVE",
    badgeLive: true,
  },
  { key: "tasks", icon: "ti-checklist", label: "태스크", badge: "7" },
  { key: "report", icon: "ti-chart-bar", label: "기여도 리포트" },
  { key: "settings", icon: "ti-settings", label: "팀 설정" },
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
  const [team, setTeam] = useState<TeamContext | null>(null);

  useEffect(() => {
    if (!teamId) return;
    apiFetch<{ teams: TeamContext[] }>("/api/teams", { headers: authHeader() })
      .then((data) => {
        const found = data.teams.find((t) => t.id === Number(teamId));
        if (found) setTeam(found);
      })
      .catch(() => {});
  }, [teamId]);

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* 사이드바 */}
      <aside className="sidebar">
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
        {NAV_ITEMS.map((n) => (
          <div
            key={n.key}
            className={`nav-item ${current === n.key ? "active" : ""}`}
            onClick={() => navigate(`/dashboard/${teamId}/${n.key}`)}
          >
            <i className={`ti ${n.icon}`} />
            {n.label}
            {n.badge && (
              <span className={`nbadge ${n.badgeLive ? "live" : ""}`}>
                {n.badge}
              </span>
            )}
          </div>
        ))}

        <div className="sb-members">
          <div className="sb-sec">팀원</div>
          {(team?.members ?? []).map((name, i) => (
            <div key={i} className="sb-mrow">
              <div className={`av a${(i % 4) + 1} av-sm`}>{name[0]}</div>
              {name}
              {name === currentUser?.name && <span className="me-tag">나</span>}
            </div>
          ))}
        </div>

        <div className="sb-spacer" />
        <div className="sb-user">
          <div className="av a1 av-md">{currentUser?.name[0] ?? "?"}</div>
          <div>
            <div className="sb-user-name">{currentUser?.name ?? ""}</div>
            <div className="sb-user-role">
              {team?.my_role === "leader" ? "팀장" : "팀원"}
            </div>
          </div>
        </div>
      </aside>

      {/* 메인 영역 */}
      <div className="main-area">
        <div className="main-top">
          <div className="main-title">{TITLE[current] ?? "대시보드"}</div>
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
