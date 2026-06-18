import { useEffect, useRef, useState } from "react";
import type { TeamMember } from "@/lib/types";
import { todayStr } from "@/lib/dateUtils";

// 결정 사항·액션 빠른 입력. 단축키 Ctrl/Cmd+D(결정)·Ctrl/Cmd+A(액션).
// 입력된 항목은 현재 진행 중 아젠다에 서버가 자동 연결.
// 저장 실패(false 반환) 시 비웠던 입력을 복원한다 — 사용자 입력 무음 증발 방지.
interface Props {
  members: TeamMember[];
  onDecision: (content: string) => Promise<boolean>;
  onAction: (payload: {
    description: string;
    assignee_id?: number;
    due_date?: string;
    is_for_next_meeting?: boolean;
  }) => Promise<boolean>;
}

export default function QuickInput({ members, onDecision, onAction }: Props) {
  const [collapsed, setCollapsed] = useState(true);
  const [decision, setDecision] = useState("");
  const [actionDesc, setActionDesc] = useState("");
  const [assignee, setAssignee] = useState<string>("");
  const [due, setDue] = useState(todayStr());
  const [forNext, setForNext] = useState(false);

  const decisionRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        decisionRef.current?.focus();
      } else if (e.key.toLowerCase() === "a") {
        e.preventDefault();
        actionRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submitDecision = () => {
    const c = decision.trim();
    if (!c) return;
    // 낙관적으로 즉시 비우고, 저장 실패 시 복원 (그 사이 새로 입력했다면 덮어쓰지 않음)
    setDecision("");
    void onDecision(c).then((ok) => {
      if (!ok) setDecision((cur) => (cur === "" ? c : cur));
    });
  };

  const submitAction = () => {
    const d = actionDesc.trim();
    if (!d) return;
    const prevDue = due;
    const prevForNext = forNext;
    setActionDesc("");
    setDue("");
    setForNext(false);
    void onAction({
      description: d,
      assignee_id: assignee ? Number(assignee) : undefined,
      due_date: prevDue ? new Date(prevDue).toISOString() : undefined,
      is_for_next_meeting: prevForNext,
    }).then((ok) => {
      if (!ok) {
        // 실패 시 복원 — 그 사이 새 입력이 있으면 우선
        setActionDesc((cur) => (cur === "" ? d : cur));
        setDue((cur) => (cur === "" ? prevDue : cur));
        setForNext((cur) => cur || prevForNext);
      }
    });
  };

  return (
    <section className="cmp-section cmp-quick">
      <header
        className="cmp-section__head cmp-section__head--toggle"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "펼치기" : "접기"}
      >
        <h2>결정 · 액션</h2>
        <span className="cmp-toggle-btn">
          <i className={`ti ti-chevron-${collapsed ? "down" : "up"}`} />
        </span>
      </header>
      {!collapsed && (
        <>
          <div className="cmp-quick-block">
            <label>
              결정 <kbd>⌘D</kbd>
            </label>
            <input
              ref={decisionRef}
              value={decision}
              placeholder="결정 사항 한 줄 + Enter"
              onChange={(e) => setDecision(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitDecision()}
            />
          </div>
          <div className="cmp-quick-block">
            <label>
              액션 <kbd>⌘A</kbd>
            </label>
            <input
              ref={actionRef}
              value={actionDesc}
              placeholder="할 일 한 줄 + Enter"
              onChange={(e) => setActionDesc(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAction()}
            />
            <div className="cmp-quick-action-meta">
              <select
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
              >
                <option value="">담당자</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <input
                type="date"
                min={todayStr()}
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
              <label className="cmp-quick-next" title="다음 회의 전까지">
                <input
                  type="checkbox"
                  checked={forNext}
                  onChange={(e) => setForNext(e.target.checked)}
                />
                다음 회의 전
              </label>
              <button onClick={submitAction}>추가</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
