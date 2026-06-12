import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { ActionItem, TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";

type Status = "할 일" | "진행 중" | "완료";

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
const COL_COLOR = {
  "할 일": "var(--text-soft)",
  "진행 중": "var(--blue)",
  완료: "var(--green)",
};
const COL_BADGE = { "할 일": "", "진행 중": "b-blue", 완료: "b-green" };

function dueState(due: string | null): {
  danger: boolean;
  warn: boolean;
  label: string;
  timeLabel: string;
} {
  if (!due) return { danger: false, warn: false, label: "", timeLabel: "" };
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(d);
  dueDay.setHours(0, 0, 0, 0);
  const diff = (dueDay.getTime() - today.getTime()) / 86400000;
  const label =
    diff < 0
      ? "지남"
      : diff === 0
        ? "오늘"
        : diff === 1
          ? "내일"
          : `${d.getMonth() + 1}/${d.getDate()}`;
  const timeLabel = fmtTime(d);
  return { danger: diff <= 0, warn: diff >= 1 && diff <= 3, label, timeLabel };
}

function fmtTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 || 12;
  return `${ampm} ${h12}:${String(m).padStart(2, "0")}`;
}

const DIFF_CHIPS = [
  { value: 1, label: "★ 낮음" },
  { value: 2, label: "★★ 보통" },
  { value: 3, label: "★★★ 높음" },
] as const;

const STATUS_CHIP_CLS: Record<Status, string> = {
  "할 일": "chip-todo",
  "진행 중": "chip-inprog",
  완료: "chip-done",
};

export default function TasksPage() {
  const { showToast } = useToast();
  const team = useOutletContext<TeamContext | null>();
  const currentUser = getUser();
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [tasks, setTasks] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamContribution[]>([]);

  // 추가 모달
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newAssignee, setNewAssignee] = useState<string>("");
  const [newDue, setNewDue] = useState("");
  const [newTime, setNewTime] = useState("");
  const [newStatus, setNewStatus] = useState<Status>("할 일");
  const [newDifficulty, setNewDifficulty] = useState(2);

  // 수정 모달
  const [editTarget, setEditTarget] = useState<ActionItem | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editAssignee, setEditAssignee] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editStatus, setEditStatus] = useState<Status>("할 일");
  const [editDifficulty, setEditDifficulty] = useState(2);
  const [editSaving, setEditSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // 드래그 앤 드롭
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);

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

  // 마감일 오름차순, 동일 날짜면 난이도 내림차순(높은 것 먼저)
  const sortedTasks = [...tasks].sort((a, b) => {
    if (a.due_date && b.due_date) {
      const diff =
        new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
      if (diff !== 0) return diff;
    } else if (a.due_date) return -1;
    else if (b.due_date) return 1;
    return (b.difficulty ?? 1) - (a.difficulty ?? 1);
  });
  const filteredTasks =
    filter === "mine"
      ? sortedTasks.filter((t) => t.assignee_id === currentUser?.id)
      : sortedTasks;

  useEffect(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".prog-fill[data-w]")
        .forEach((b) => {
          b.style.width = b.dataset.w + "%";
        });
    });
  }, [done, total]);

  function openEdit(task: ActionItem) {
    setEditTarget(task);
    setEditDesc(task.description);
    setEditAssignee(task.assignee_id ? String(task.assignee_id) : "");
    setEditDue(task.due_date?.slice(0, 10) ?? "");
    if (!task.due_date || task.due_date.endsWith("T00:00:00.000Z")) {
      setEditTime("");
    } else {
      const dt = new Date(task.due_date);
      setEditTime(
        `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`,
      );
    }
    setEditStatus(API_TO_STATUS[task.status] ?? "할 일");
    setEditDifficulty(task.difficulty ?? 2);
  }

  async function saveEdit() {
    if (!editTarget || editSaving) return;
    if (!editDesc.trim()) {
      showToast("태스크 이름을 입력해 주세요", "error");
      return;
    }
    setEditSaving(true);
    try {
      await apiPatch(`/action-items/${editTarget.id}`, {
        description: editDesc.trim(),
        assignee_id: editAssignee ? Number(editAssignee) : undefined,
        due_date: editDue
          ? new Date(`${editDue}T${editTime || "23:59"}`).toISOString()
          : undefined,
        status: STATUS_TO_API[editStatus],
        difficulty: editDifficulty,
      });
      setEditTarget(null);
      showToast("태스크가 수정되었습니다");
      await load();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteTask() {
    if (!editTarget || deleting) return;
    setDeleting(true);
    try {
      await apiDelete(`/action-items/${editTarget.id}`);
      setTasks((ts) => ts.filter((t) => t.id !== editTarget.id));
      setConfirmDelete(false);
      setEditTarget(null);
      showToast("태스크가 삭제되었습니다");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function changeStatus(task: ActionItem, status: Status) {
    const prev = tasks;
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
        due_date: newDue
          ? new Date(`${newDue}T${newTime || "23:59"}`).toISOString()
          : undefined,
        status: STATUS_TO_API[newStatus],
        difficulty: newDifficulty,
      });
      setModalOpen(false);
      setNewDesc("");
      setNewAssignee("");
      setNewDue("");
      setNewTime("");
      setNewStatus("할 일");
      setNewDifficulty(2);
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
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          <div className="view-toggle">
            <button
              className={`vt ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              전체
            </button>
            <button
              className={`vt ${filter === "mine" ? "active" : ""}`}
              onClick={() => setFilter("mine")}
            >
              내 태스크
            </button>
          </div>
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
            const colTasks = filteredTasks.filter(
              (t) => API_TO_STATUS[t.status] === col,
            );
            return (
              <div
                key={col}
                className={`board-col ${dragOverCol === col ? "drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOverCol(col);
                }}
                onDragLeave={() => setDragOverCol(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOverCol(null);
                  setDraggingId(null);
                  const id = Number(e.dataTransfer.getData("taskId"));
                  const task = tasks.find((t) => t.id === id);
                  if (task && API_TO_STATUS[task.status] !== col) {
                    void changeStatus(task, col);
                  }
                }}
              >
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
                      draggable
                      className={`tcard ${danger ? "danger" : ""} ${warn ? "warn" : ""} ${status === "완료" ? "done-card" : ""} ${draggingId === t.id ? "dragging" : ""}`}
                      style={{
                        cursor: draggingId === t.id ? "grabbing" : "grab",
                        ...stripeStyle(t.assignee_id, danger, warn),
                      }}
                      onDragStart={(e) => {
                        setDraggingId(t.id);
                        e.dataTransfer.setData("taskId", String(t.id));
                        e.dataTransfer.effectAllowed = "move";
                      }}
                      onDragEnd={() => setDraggingId(null)}
                      onClick={() => openEdit(t)}
                    >
                      <div className="tc-head">
                        <div
                          className={`tc-title ${status === "완료" ? "done" : ""}`}
                        >
                          {t.description}
                        </div>
                        <span className="tc-diff">
                          {"★".repeat(t.difficulty ?? 1)}
                          <span className="tc-diff-off">
                            {"★".repeat(3 - (t.difficulty ?? 1))}
                          </span>
                        </span>
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
                            {dd.timeLabel && (
                              <span style={{ fontWeight: 500, marginLeft: 2 }}>
                                {dd.timeLabel}
                              </span>
                            )}
                          </div>
                        )}
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
          {filteredTasks.map((t) => {
            const status = API_TO_STATUS[t.status];
            const dd = dueState(t.due_date);
            const danger = status !== "완료" && dd.danger;
            const warn = status !== "완료" && dd.warn;
            return (
              <div
                key={t.id}
                className={`lrow ${danger ? "danger" : ""} ${warn ? "warn" : ""}`}
                style={{
                  cursor: "pointer",
                  ...stripeStyle(t.assignee_id, danger, warn),
                }}
                onClick={() => openEdit(t)}
              >
                <div
                  className={`t-check ${status === "완료" ? "done" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleList(t);
                  }}
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
                  {dd.label
                    ? `${dd.label}${dd.timeLabel ? ` ${dd.timeLabel}` : ""}`
                    : "기한 없음"}
                </div>
                <span className="tc-diff">
                  {"★".repeat(t.difficulty ?? 1)}
                  <span className="tc-diff-off">
                    {"★".repeat(3 - (t.difficulty ?? 1))}
                  </span>
                </span>
              </div>
            );
          })}
          {filteredTasks.length === 0 && (
            <div
              style={{ padding: 18, fontSize: 13, color: "var(--text-soft)" }}
            >
              {filter === "mine"
                ? "나에게 배정된 태스크가 없습니다."
                : "등록된 태스크가 없습니다. 태스크를 추가해 보세요."}
            </div>
          )}
        </div>
      )}

      {/* 태스크 추가 모달 */}
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
              <div className="field-row" style={{ gap: 6 }}>
                <input
                  className="input"
                  type="date"
                  style={{ flex: 2 }}
                  value={newDue}
                  onChange={(e) => setNewDue(e.target.value)}
                />
                <input
                  className="input"
                  type="time"
                  style={{ flex: 1 }}
                  placeholder="23:59"
                  value={newTime}
                  onChange={(e) => setNewTime(e.target.value)}
                />
              </div>
              <div className="field-hint">시간 미입력 시 23:59</div>
            </div>
          </div>
          <div className="field">
            <label className="field-label">상태</label>
            <div className="chip-row">
              {(["할 일", "진행 중", "완료"] as Status[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip-opt ${STATUS_CHIP_CLS[s]} ${newStatus === s ? "active" : ""}`}
                  onClick={() => setNewStatus(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label">난이도</label>
            <div className="chip-row">
              {DIFF_CHIPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`chip-opt chip-diff ${newDifficulty === c.value ? "active" : ""}`}
                  onClick={() => setNewDifficulty(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* 태스크 수정 모달 */}
      {editTarget && !confirmDelete && (
        <Modal
          title="태스크 수정"
          onClose={() => setEditTarget(null)}
          actions={
            <>
              <button
                className="btn btn-danger"
                style={{ marginRight: "auto" }}
                onClick={() => setConfirmDelete(true)}
              >
                삭제
              </button>
              <button className="btn" onClick={() => setEditTarget(null)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void saveEdit()}
                disabled={editSaving}
              >
                {editSaving ? "저장 중…" : "저장"}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">태스크 이름</label>
            <input
              className="input"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">담당자</label>
              <select
                className="input"
                value={editAssignee}
                onChange={(e) => setEditAssignee(e.target.value)}
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
              <div className="field-row" style={{ gap: 6 }}>
                <input
                  className="input"
                  type="date"
                  style={{ flex: 2 }}
                  value={editDue}
                  onChange={(e) => setEditDue(e.target.value)}
                />
                <input
                  className="input"
                  type="time"
                  style={{ flex: 1 }}
                  placeholder="23:59"
                  value={editTime}
                  onChange={(e) => setEditTime(e.target.value)}
                />
              </div>
              <div className="field-hint">시간 미입력 시 23:59</div>
            </div>
          </div>
          <div className="field">
            <label className="field-label">상태</label>
            <div className="chip-row">
              {(["할 일", "진행 중", "완료"] as Status[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`chip-opt ${STATUS_CHIP_CLS[s]} ${editStatus === s ? "active" : ""}`}
                  onClick={() => setEditStatus(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="field-label">난이도</label>
            <div className="chip-row">
              {DIFF_CHIPS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={`chip-opt chip-diff ${editDifficulty === c.value ? "active" : ""}`}
                  onClick={() => setEditDifficulty(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* 삭제 확인 모달 */}
      {confirmDelete && editTarget && (
        <ConfirmModal
          title="태스크 삭제"
          message={
            <>
              <strong>{editTarget.description}</strong>을(를) 삭제할까요?
              <br />이 작업은 되돌릴 수 없습니다.
            </>
          }
          confirmLabel="삭제"
          danger
          busy={deleting}
          onConfirm={() => void deleteTask()}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}
