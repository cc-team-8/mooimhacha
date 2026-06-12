import { Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "@/pages/login/LoginPage";
import AuthCallback from "@/pages/login/AuthCallback";
import OnboardingPage from "@/pages/onboarding/OnboardingPage";
import HomePage from "@/pages/home/HomePage";
import DashboardPage from "@/pages/dashboard/DashboardPage";
import { useToast } from "@/hooks/useToast";

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const token = localStorage.getItem("access_token");
  const { showToast } = useToast();
  if (!token) {
    showToast("로그인이 필요합니다.");
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route
          path="/onboarding"
          element={
            <PrivateRoute>
              <OnboardingPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/home"
          element={
            <PrivateRoute>
              <HomePage />
            </PrivateRoute>
          }
        />
        <Route
          path="/dashboard/:teamId/*"
          element={
            <PrivateRoute>
              <DashboardPage />
            </PrivateRoute>
          }
        />
        {/* 정의되지 않은 경로는 로그인으로 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {/* useToast 훅이 DOM을 직접 조작하는 대상. React 상태 대신 DOM 조작 방식으로
          어느 컴포넌트에서든 호출 가능하고 리렌더 없이 즉시 표시됨. */}
      <div className="toast" id="toast">
        <i className="ti ti-circle-check" />
        <span />
      </div>
    </div>
  );
}
