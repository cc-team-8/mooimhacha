import { useEffect } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import Card from "@/components/Card";
import type { TeamContext } from "../DashboardPage";

const MEMBER_COLORS = [
  "var(--green)",
  "var(--blue)",
  "var(--pink)",
  "var(--amber)",
  "var(--coral)",
  "var(--text-soft)",
];

export default function OverviewPage() {
  const navigate = useNavigate();
  const team = useOutletContext<TeamContext | null>();

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
  }, []);

  return (
    <div>
      <div className="alert-bar">
        <i className="ti ti-alert-triangle" /> 박지호님의 태스크 2개가 내일
        마감입니다. 아직 시작하지 않았어요.
      </div>

      {/* 통계 */}
      <div className="stats-grid">
        {[
          { lbl: "총 회의", val: "3", sub: "이번 프로젝트" },
          { lbl: "태스크 진행률", val: "64%", sub: "7 / 11 완료" },
          {
            lbl: "다음 마감",
            val: "내일",
            sub: "발표 슬라이드 초안",
            valStyle: { fontSize: 20, paddingTop: 8 },
          },
          {
            lbl: "무임승차 경보",
            val: "1명",
            sub: "박지호 · 기여도 8%",
            valStyle: { color: "var(--coral)" },
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
            {(team?.members ?? []).map((name, i) => (
              <div key={i} className="contrib-row">
                <span className="c-name">{name}</span>
                <span className="c-bar">
                  <i
                    style={{
                      width: 0,
                      background: MEMBER_COLORS[i % MEMBER_COLORS.length],
                    }}
                  />
                </span>
                <span className="c-pct" style={{ color: "var(--text-soft)" }}>
                  -%
                </span>
                <span className="c-task" style={{ color: "var(--text-soft)" }}>
                  -
                </span>
              </div>
            ))}
          </div>
        </Card>

        {/* 진행 중 회의: .mini-meeting 전용 레이아웃이라 Card 컴포넌트 미사용.
            card-head/card-title 클래스는 헤더 스타일만 재사용. */}
        <div className="mini-meeting">
          <div className="card-head" style={{ padding: "0 0 10px" }}>
            <span className="card-title">
              <i className="ti ti-clock" /> 진행 중 회의
            </span>
            <span className="spill spill-live">🔴 진행</span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 3 }}>
            발표 준비 회의
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-soft)" }}>
            오늘 오후 3:00 · 아젠다 3개 · 4명 참석
          </div>
          <div style={{ display: "flex", gap: 7, margin: "14px 0 4px" }}>
            {["a1", "a2", "a3", "a4"].map((cls, i) => (
              <div key={i} className={`av ${cls} av-sm`}>
                {["김", "이", "박", "최"][i]}
              </div>
            ))}
          </div>
          <button
            className="btn btn-primary btn-full"
            style={{ marginTop: 12 }}
            onClick={() => navigate("/dashboard/meeting")}
          >
            <i className="ti ti-arrow-right" /> 회의 참여하기
          </button>
        </div>
      </div>

      <div className="dash-grid2">
        {/* 진행 중 태스크 */}
        <Card icon="ti ti-checklist" title="진행 중 태스크">
          <div style={{ padding: "2px 16px 14px" }}>
            {[
              {
                done: true,
                name: "시장 조사 보고서",
                who: "민준",
                due: undefined,
              },
              {
                done: false,
                name: "UI 와이어프레임",
                who: "",
                due: "내일",
                dueColor: "var(--coral)",
              },
              {
                done: false,
                name: "발표 슬라이드 초안",
                who: "",
                due: "내일",
                dueColor: "var(--coral)",
              },
              {
                done: false,
                name: "기술 스택 문서화",
                who: "",
                due: "5/12",
                dueColor: "var(--text-soft)",
              },
            ].map((t, i) => (
              <div key={i} className="task-mini">
                <div className={`chk-mini ${t.done ? "done" : ""}`}>
                  {t.done && <i className="ti ti-check" />}
                </div>
                <div
                  style={{
                    flex: 1,
                    textDecoration: t.done ? "line-through" : undefined,
                    color: t.done ? "var(--text-soft)" : undefined,
                  }}
                >
                  {t.name}
                </div>
                {t.due && (
                  <span style={{ color: t.dueColor, fontWeight: 700 }}>
                    {t.due}
                  </span>
                )}
                {t.who && (
                  <span style={{ color: "var(--text-soft)" }}>{t.who}</span>
                )}
              </div>
            ))}
          </div>
        </Card>

        {/* 최근 회의 */}
        <Card icon="ti ti-calendar" title="최근 회의">
          <div style={{ padding: "2px 16px 14px" }}>
            {[
              {
                name: "킥오프 회의",
                badge: "b-green",
                status: "완료",
                meta: "5월 1일 · 38분",
              },
              {
                name: "중간 점검",
                badge: "b-green",
                status: "완료",
                meta: "5월 5일 · 52분",
              },
              {
                name: "발표 준비 회의",
                badge: undefined,
                status: "진행 중",
                meta: "오늘 오후 3시",
                spill: true,
              },
            ].map((m) => (
              <div key={m.name} className="meeting-mini">
                <div className="mm-top">
                  <span>{m.name}</span>
                  {m.spill ? (
                    <span className="spill spill-live">{m.status}</span>
                  ) : (
                    <span className={`badge ${m.badge}`}>{m.status}</span>
                  )}
                </div>
                <div className="mm-meta">{m.meta}</div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
