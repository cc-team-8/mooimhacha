import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import { apiGet, apiPatch, apiPost } from "@/lib/api";
import type { ActionItem, TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";

type Status = "할 일" | "진행 중" | "완료";

// 화면 표기(한글) ↔ 서버 상태값 매핑
const STATUS_TO_API: Record<Status, ActionItem["status"]> = {
  "할 일": "todo",
  "진행 중": "in_progress",
  완료: "done",
};
const API_TO_STATUS: Record<string, Status> = {
  todo: "할 일",
  in_progress: "진행 중",
  done: "완료",
};

const STATUS_COLS: Status[] = ["할 일", "진행 중", "완료"];
// status → 스타일 매핑 테이블. 컴포넌트 외부에 선언해 렌더마다 재생성하지 않음.
const COL_COLOR = {
  "할 일": "var(--text-soft)",
  "진행 중": "var(--blue)",
  완료: "var(--green)",
};
const COL_BADGE = { "할 일": "", "진행 중": "b-blue", 완료: "b-green" };
const STATUS_CLS = { "할 일": "s-todo", "진행 중": "s-inprog", 완료: "s-done" };

// 마감 임박 판정: danger = 지남·오늘·내일, warn = 3일 이내
function dueState(due: string | null): {
  danger: boolean;
  warn: boolean;
  label: string;
} {
  if (!due) return { danger: false, warn: false, label: "" };
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  const label =
    diff < 0
      ? "지남"
      : diff === 0
        ? "오늘"
        : diff === 1
          ? "내일"
          : `${d.getMonth() + 1}/${d.getDate()}`;
  return { danger: diff <= 1, warn: diff > 1 && diff <= 3, label };
}

export default function TasksPage() {
  const { showToast } = useToast();
  const team = useOutletContext<TeamContext | null>();
  const [view, setView] = useState<"board" | "list">("board");
  const [tasks, setTasks] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamContribution[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // 추가 모달 입력값
  const [newDesc, setNewDesc] = useState("");
  const [newAssignee, setNewAssignee] = useState<string>("");
  const [newDue, setNewDue] = useState("");
  const [newStatus, setNewStatus] = useState<Status>("할 일");

  const load = useCallback(async () => {
    if (!team) return;
    try {
      const [ts, cs] = await Promise.all([
        apiGet<ActionItem[]>(`/action-items?team_id=${team.id}`),
        apiGet<{ members: TeamContribution[] }>(
          `/teams/${team.id}/contributions`,
        ),
      ]);
      setTasks(ts.filter((t) => t.status !== "cancelled"));
      setMembers(cs.members);
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }, [team, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (id: number | null) =>
    members.find((m) => m.user_id === id)?.name ?? "미지정";
  const avOf = (id: number | null) => {
    const i = members.findIndex((m) => m.user_id === id);
    return `a${((i < 0 ? 0 : i) % 4) + 1}`;
  };
  // 담당자 식별용 색 — 아바타(a1~a4)와 같은 순서의 단색 팔레트. 미지정이면 null.
  // (--av1~4는 그라데이션이라 border 색으로 쓸 수 없음)
  const MEMBER_STRIPE = [
    "var(--green)",
    "var(--blue)",
    "var(--pink)",
    "var(--amber)",
  ];
  const colorOf = (id: number | null) => {
    const i = members.findIndex((m) => m.user_id === id);
    return i < 0 ? null : MEMBER_STRIPE[i % 4];
  };
  // 기존 danger/warn(마감 임박)의 빨강/노랑 줄이 우선, 그 외에는 담당자 색 줄
  const stripeStyle = (
    assigneeId: number | null,
    danger: boolean,
    warn: boolean,
  ) => {
    if (danger || warn) return undefined;
    const c = colorOf(assigneeId);
    return c ? { borderLeft: `3px solid ${c}` } : undefined;
  };

  const done = tasks.filter((t) => t.status === "done").length;
  const total = tasks.length;

  // OverviewPage와 동일한 rAF 패턴: 진행률 바 초기 애니메이션
  useEffect(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".prog-fill[data-w]")
        .forEach((b) => {
          b.style.width = b.dataset.w + "%";
        });
    });
  }, [total]);

  async function changeStatus(task: ActionItem, status: Status) {
    const prev = tasks;
    // 낙관적 갱신 — 실패 시 원복
    setTasks((ts) =>
      ts.map((t) =>
        t.id === task.id ? { ...t, status: STATUS_TO_API[status] } : t,
      ),
    );
    try {
      await apiPatch(`/action-items/${task.id}`, {
        status: STATUS_TO_API[status],
      });
    } catch (e) {
      setTasks(prev);
      showToast((e as Error).message, "error");
    }
  }

  function toggleList(task: ActionItem) {
    void changeStatus(task, task.status === "done" ? "할 일" : "완료");
  }

  async function addTask() {
    if (!team || saving) return;
    if (!newDesc.trim()) {
      showToast("태스크 이름을 입력해 주세요", "error");
      return;
    }
    setSaving(true);
    try {
      await apiPost("/action-items", {
        team_id: team.id,
        description: newDesc.trim(),
        assignee_id: newAssignee ? Number(newAssignee) : undefined,
        due_date: newDue || undefined,
        status: STATUS_TO_API[newStatus],
      });
      setModalOpen(false);
      setNewDesc("");
      setNewAssignee("");
      setNewDue("");
      setNewStatus("할 일");
      showToast("태스크가 추가되었습니다");
      await load();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="task-top">
        <div className="view-toggle">
          <button
            className={`vt ${view === "board" ? "active" : ""}`}
            onClick={() => setView("board")}
          >
            <i className="ti ti-layout-columns" /> 보드
          </button>
          <button
            className={`vt ${view === "list" ? "active" : ""}`}
            onClick={() => setView("list")}
          >
            <i className="ti ti-list" /> 목록
          </button>
        </div>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setModalOpen(true)}
        >
          <i className="ti ti-plus" /> 태스크 추가
        </button>
      </div>

      <div className="prog-strip">
        <span className="lbl">전체 진행률</span>
        <div className="prog-bg">
          <div
            className="prog-fill"
            data-w={total ? Math.round((done / total) * 100) : 0}
          />
        </div>
        <span className="num">
          {done} / {total} 완료
        </span>
      </div>

      {/* 보드 뷰 */}
      {view === "board" && (
        <div className="board">
          {STATUS_COLS.map((col) => {
            const colTasks = tasks.filter(
              (t) => API_TO_STATUS[t.status] === col,
            );
            return (
              <div key={col} className="board-col">
                <div className="col-head">
                  <span
                    className="col-dot"
                    style={{ background: COL_COLOR[col] }}
                  />
                  <span className="col-title">{col}</span>
                  <span
                    className="col-cnt"
                    style={
                      col !== "할 일"
                        ? {
                            background: `var(--${col === "진행 중" ? "blue" : "green"}-soft)`,
                            color: COL_COLOR[col],
                          }
                        : undefined
                    }
                  >
                    {colTasks.length}
                  </span>
                </div>
                {colTasks.map((t) => {
                  const status = API_TO_STATUS[t.status];
                  const dd = dueState(t.due_date);
                  const danger = status !== "완료" && dd.danger;
                  const warn = status !== "완료" && dd.warn;
                  const who = nameOf(t.assignee_id);
                  return (
                    <div
                      key={t.id}
                      className={`tcard ${danger ? "danger" : ""} ${warn ? "warn" : ""} ${status === "완료" ? "done-card" : ""}`}
                      style={stripeStyle(t.assignee_id, danger, warn)}
                    >
                      <div className="tc-head">
                        <div
                          className={`tc-title ${status === "완료" ? "done" : ""}`}
                        >
                          {t.description}
                        </div>
                        {dd.label && (
                          <div
                            className="tc-due"
                            style={{
                              color: danger
                                ? "var(--coral)"
                                : warn
                                  ? "var(--amber)"
                                  : "var(--text-soft)",
                            }}
                          >
                            <i className="ti ti-calendar" />
                            {dd.label}
                          </div>
                        )}
                      </div>
                      <div className="tc-foot">
                        <span className="tc-who">
                          <span
                            className={`av ${avOf(t.assignee_id)} av-sm`}
                            style={{ width: 20, height: 20, fontSize: 9 }}
                          >
                            {who[0]}
                          </span>
                          {who}
                        </span>
                        <select
                          className={`tc-status ${STATUS_CLS[status]}`}
                          value={status}
                          onChange={(e) =>
                            void changeStatus(t, e.target.value as Status)
                          }
                        >
                          <option>할 일</option>
                          <option>진행 중</option>
                          <option>완료</option>
                        </select>
                      </div>
                    </div>
                  );
                })}
                <button className="add-col" onClick={() => setModalOpen(true)}>
                  <i className="ti ti-plus" /> 추가
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 목록 뷰 */}
      {view === "list" && (
        <div>
          {tasks.map((t) => {
            const status = API_TO_STATUS[t.status];
            const dd = dueState(t.due_date);
            const danger = status !== "완료" && dd.danger;
            const warn = status !== "완료" && dd.warn;
            return (
              <div
                key={t.id}
                className={`lrow ${danger ? "danger" : ""} ${warn ? "warn" : ""}`}
                style={stripeStyle(t.assignee_id, danger, warn)}
              >
                <div
                  className={`t-check ${status === "완료" ? "done" : ""}`}
                  onClick={() => toggleList(t)}
                >
                  <i className="ti ti-check" />
                </div>
                <div
                  className={`lrow-title ${status === "완료" ? "done" : ""}`}
                >
                  {t.description}
                </div>
                <span className={`badge ${COL_BADGE[status] || "b-gray"}`}>
                  {status}
                </span>
                <div className={`av ${avOf(t.assignee_id)} av-sm`}>
                  {nameOf(t.assignee_id)[0]}
                </div>
                <div
                  className={`lrow-due ${danger ? "due-red" : warn ? "due-amber" : "due-soft"}`}
                >
                  {status === "완료" ? "완료" : dd.label || "기한 없음"}
                </div>
              </div>
            );
          })}
          {tasks.length === 0 && (
            <div
              style={{ padding: 18, fontSize: 13, color: "var(--text-soft)" }}
            >
              등록된 태스크가 없습니다. 태스크를 추가해 보세요.
            </div>
          )}
        </div>
      )}

      {modalOpen && (
        <Modal
          title="태스크 추가"
          onClose={() => setModalOpen(false)}
          actions={
            <>
              <button className="btn" onClick={() => setModalOpen(false)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void addTask()}
                disabled={saving}
              >
                {saving ? "추가 중…" : "추가"}
              </button>
            </>
          }
        >
          <div className="modal-sub">
            담당자와 마감일을 지정하면 기여도에 자동 반영됩니다.
          </div>
          <div className="field">
            <label className="field-label">태스크 이름</label>
            <input
              className="input"
              placeholder="예) 발표 자료 수정"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">담당자</label>
              <select
                className="input"
                value={newAssignee}
                onChange={(e) => setNewAssignee(e.target.value)}
              >
                <option value="">미지정</option>
                {members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field-label">마감일</label>
              <input
                className="input"
                type="date"
                value={newDue}
                onChange={(e) => setNewDue(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="field-label">상태</label>
            <select
              className="input"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as Status)}
            >
              <option>할 일</option>
              <option>진행 중</option>
              <option>완료</option>
            </select>
          </div>
        </Modal>
      )}
    </div>
  );
}
