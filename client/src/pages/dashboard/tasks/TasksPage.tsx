import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import { avatarBg, memberColor } from "@/lib/avatarColor";
import { todayStr, timeMinForDate } from "@/lib/dateUtils";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import MemberSelect from "@/components/MemberSelect";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { ActionItem, TeamContribution, ActionItemLog } from "@/lib/types";
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
  dDay: string;
} {
  if (!due)
    return { danger: false, warn: false, label: "", timeLabel: "", dDay: "" };
  const d = new Date(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dueDay = new Date(d);
  dueDay.setHours(0, 0, 0, 0);
  const diff = Math.round((dueDay.getTime() - today.getTime()) / 86400000);
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  const label = `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]})`;
  const timeLabel = fmtTime(d);
  const dDay = diff < 0 ? `D+${Math.abs(diff)}` : `D-${diff}`;
  return {
    danger: diff <= 0,
    warn: diff >= 1 && diff <= 3,
    label,
    timeLabel,
    dDay,
  };
}

function fmtTime(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 || 12;
  return `${ampm} ${h12}:${String(m).padStart(2, "0")}`;
}

function fmtCompleted(iso: string): string {
  const d = new Date(iso);
  const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
  return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${fmtTime(d)}`;
}

// Date → datetime-local input 값 ("YYYY-MM-DDTHH:mm")
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  const [view, setView] = useState<"board" | "list" | "history">("board");
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [listSort, setListSort] = useState<"newest" | "difficulty" | "oldest">(
    "newest",
  );
  const [historyLogs, setHistoryLogs] = useState<ActionItemLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tasks, setTasks] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamContribution[]>([]);

  // 추가 모달
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newDetail, setNewDetail] = useState("");
  const [newAssignee, setNewAssignee] = useState<string>("");
  const [newDue, setNewDue] = useState(todayStr());
  const [newTime, setNewTime] = useState("");
  const [newStatus, setNewStatus] = useState<Status>("할 일");
  const [newDifficulty, setNewDifficulty] = useState(2);

  // 수정 모달
  const [editTarget, setEditTarget] = useState<ActionItem | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [editDetail, setEditDetail] = useState("");
  const [editAssignee, setEditAssignee] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editDifficulty, setEditDifficulty] = useState(2);
  const [editStatus, setEditStatus] = useState<Status>("할 일");
  const [editSaving, setEditSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusChangePending, setStatusChangePending] = useState<{
    task: ActionItem;
    newStatus: Status;
  } | null>(null);

  // 드래그 앤 드롭
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);

  // 카카오 공유 배치
  const [shareBatches, setShareBatches] = useState<
    { title: string; desc: string; img: string }[][]
  >([]);
  const [shareBatchIdx, setShareBatchIdx] = useState(0);
  const [shareTitle, setShareTitle] = useState("");

  // 수정/삭제 이력
  const [logsTarget, setLogsTarget] = useState<ActionItem | null>(null);
  const [logs, setLogs] = useState<ActionItemLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!team) return;
    try {
      const [ts, cs] = await Promise.all([
        apiGet<ActionItem[]>(`/action-items?team_id=${team.id}&confirmed=true`),
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

  useEffect(() => {
    if (view === "history") void loadHistoryLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, team]);

  const nicknameMap = new Map(
    (team?.members ?? []).map((m) => [m.user_id, m.nickname ?? m.name]),
  );
  const nameToNickname = new Map(
    (team?.members ?? []).map((m) => [m.name, m.nickname ?? m.name]),
  );
  const fmtLogVal = (field: string, val: string | null) => {
    const raw = formatVal(field, val);
    return field === "assignee" ? (nameToNickname.get(raw) ?? raw) : raw;
  };
  const nameOf = (id: number | null) =>
    (id != null ? nicknameMap.get(id) : null) ??
    members.find((m) => m.user_id === id)?.name ??
    "미지정";
  const avBg = (id: number | null) => {
    if (id == null) return "linear-gradient(150deg, #c8c4bb, #a8a49b)";
    const i = (team?.members ?? []).findIndex((m) => m.user_id === id);
    return avatarBg(i < 0 ? id % 32 : i);
  };
  const colorOf = (id: number | null) => {
    if (id == null) return null;
    const i = (team?.members ?? []).findIndex((m) => m.user_id === id);
    return memberColor(i < 0 ? id % 32 : i);
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

  const listFilteredTasks = (() => {
    const base =
      filter === "mine"
        ? tasks.filter((t) => t.assignee_id === currentUser?.id)
        : [...tasks];
    if (listSort === "newest") return base.sort((a, b) => b.id - a.id);
    if (listSort === "oldest") return base.sort((a, b) => a.id - b.id);
    return base.sort((a, b) => {
      const d = (b.difficulty ?? 1) - (a.difficulty ?? 1);
      return d !== 0 ? d : b.id - a.id;
    });
  })();

  useEffect(() => {
    requestAnimationFrame(() => {
      document
        .querySelectorAll<HTMLElement>(".prog-fill[data-w]")
        .forEach((b) => {
          b.style.width = b.dataset.w + "%";
        });
    });
  }, [done, total]);

  // 누구든 수정 가능 (권한은 서버에서 팀 멤버십으로 검증)
  const canEdit = (_t: ActionItem) => true;

  function openEdit(task: ActionItem) {
    setEditTarget(task);
    setEditDesc(task.description);
    setEditDetail(task.detail ?? "");
    setEditAssignee(task.assignee_id ? String(task.assignee_id) : "");
    if (task.due_date) {
      const dt = new Date(task.due_date);
      setEditDue(
        `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`,
      );
      setEditTime(
        `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`,
      );
    } else {
      setEditDue("");
      setEditTime("");
    }
    setEditDifficulty(task.difficulty ?? 2);
    setEditStatus(API_TO_STATUS[task.status]);
  }

  async function saveEdit() {
    if (!editTarget || editSaving) return;

    const body: Record<string, unknown> = {};
    if (editDesc.trim() !== editTarget.description) {
      if (!editDesc.trim()) {
        showToast("태스크 이름을 입력해 주세요", "error");
        return;
      }
      body.description = editDesc.trim();
    }
    if (editDifficulty !== (editTarget.difficulty ?? 2))
      body.difficulty = editDifficulty;
    const newAssigneeId = editAssignee ? Number(editAssignee) : null;
    if (newAssigneeId !== (editTarget.assignee_id ?? null))
      body.assignee_id = newAssigneeId;
    const newDue = editDue
      ? new Date(`${editDue}T${editTime || "23:59"}`)
      : null;
    const origDue = editTarget.due_date ? new Date(editTarget.due_date) : null;
    if ((newDue?.getTime() ?? null) !== (origDue?.getTime() ?? null))
      body.due_date = newDue?.toISOString() ?? undefined;
    if (editStatus !== API_TO_STATUS[editTarget.status])
      body.status = STATUS_TO_API[editStatus];

    // 세부사항(메모)도 함께 반영 — 점수에 영향 없음
    if (editDetail.trim() !== (editTarget.detail ?? ""))
      body.detail = editDetail.trim() || null;

    if (Object.keys(body).length === 0) {
      showToast("변경된 항목이 없습니다", "error");
      return;
    }
    setEditSaving(true);
    try {
      await apiPatch(`/action-items/${editTarget.id}`, body);
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
      setConfirmDelete(false);
      setEditTarget(null);
      showToast("태스크가 삭제되었습니다");
      await load();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setDeleting(false);
    }
  }

  async function loadHistoryLogs() {
    if (!team) return;
    setHistoryLoading(true);
    try {
      const data = await apiGet<ActionItemLog[]>(
        `/action-items/logs?team_id=${team.id}`,
      );
      setHistoryLogs(data);
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadLogs(task: ActionItem) {
    setLogsTarget(task);
    setLogs([]);
    setLogsLoading(true);
    try {
      const data = await apiGet<ActionItemLog[]>(
        `/action-items/${task.id}/logs`,
      );
      setLogs(data);
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setLogsLoading(false);
    }
  }

  async function changeStatus(task: ActionItem, status: Status) {
    const prev = tasks;
    setTasks((ts) =>
      ts.map((t) =>
        t.id === task.id
          ? {
              ...t,
              status: STATUS_TO_API[status],
              completed_at: status === "완료" ? new Date().toISOString() : null,
            }
          : t,
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

  function requestStatusChange(task: ActionItem, newStatus: Status) {
    if (task.status === "done") {
      setStatusChangePending({ task, newStatus });
    } else {
      void changeStatus(task, newStatus);
    }
  }

  function toggleList(task: ActionItem) {
    requestStatusChange(task, task.status === "done" ? "할 일" : "완료");
  }

  function shareTaskStatus() {
    if (!team) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayExpiring = tasks.filter((t) => {
      if (t.status === "done" || !t.due_date) return false;
      const dueDay = new Date(t.due_date);
      dueDay.setHours(0, 0, 0, 0);
      return dueDay >= today && dueDay < tomorrow;
    });

    const overdue = tasks.filter((t) => {
      if (t.status === "done" || !t.due_date) return false;
      const dueDay = new Date(t.due_date);
      dueDay.setHours(0, 0, 0, 0);
      return dueDay < today;
    });

    if (todayExpiring.length === 0 && overdue.length === 0) {
      showToast("공유할 내용이 없습니다.");
      return;
    }

    if (!window.Kakao?.isInitialized()) {
      showToast("카카오 SDK가 초기화되지 않았습니다.", "error");
      return;
    }

    const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}/${now.getDate()}(${DAYS[now.getDay()]})`;

    const origin = window.location.origin;
    const IMG_DONE = `${origin}/icon-done.png`;
    const IMG_WARN = `${origin}/icon-warning.png`;

    const items: { title: string; desc: string; img: string }[] = [
      ...todayExpiring.map((t) => ({
        title: `🔔 ${t.description}`,
        desc: `오늘 마감 · ${nameOf(t.assignee_id)}`,
        img: IMG_DONE,
      })),
      ...overdue.map((t) => {
        const dueDay = new Date(t.due_date!);
        dueDay.setHours(0, 0, 0, 0);
        const days = Math.round(
          (today.getTime() - dueDay.getTime()) / 86400000,
        );
        return {
          title: `⚠️ ${t.description}`,
          desc: `D+${days} · ${nameOf(t.assignee_id)}`,
          img: IMG_WARN,
        };
      }),
    ];

    const batches: { title: string; desc: string; img: string }[][] = [];
    for (let i = 0; i < items.length; i += 5) {
      batches.push(items.slice(i, i + 5));
    }

    setShareTitle(`태스크 현황 (${dateStr})`);
    setShareBatches(batches);
    setShareBatchIdx(0);
  }

  function sendCurrentBatch() {
    const batch = shareBatches[shareBatchIdx];
    if (!batch) return;

    const templateArgs: Record<string, string> = { title: shareTitle };
    for (let i = 0; i < 5; i++) {
      templateArgs[`t${i + 1}`] = batch[i]?.title ?? "";
      templateArgs[`d${i + 1}`] = batch[i]?.desc ?? "";
      templateArgs[`img${i + 1}`] = batch[i]?.img ?? "";
    }

    window.Kakao.Share.sendCustom({ templateId: 134415, templateArgs });

    if (shareBatchIdx + 1 >= shareBatches.length) {
      setShareBatches([]);
    } else {
      setShareBatchIdx(shareBatchIdx + 1);
    }
  }

  async function addTask() {
    if (!team || saving) return;
    if (!newDesc.trim()) {
      showToast("태스크 이름을 입력해 주세요", "error");
      return;
    }
    if (newDue && newTime) {
      if (new Date(`${newDue}T${newTime}`) <= new Date()) {
        showToast("현재 시각 이후로 설정해 주세요", "error");
        return;
      }
    }
    setSaving(true);
    try {
      await apiPost("/action-items", {
        team_id: team.id,
        description: newDesc.trim(),
        detail: newDetail.trim() || undefined,
        assignee_id: newAssignee ? Number(newAssignee) : undefined,
        due_date: newDue
          ? new Date(`${newDue}T${newTime || "23:59"}`).toISOString()
          : undefined,
        status: STATUS_TO_API[newStatus],
        difficulty: newDifficulty,
      });
      setModalOpen(false);
      setNewDesc("");
      setNewDetail("");
      setNewAssignee("");
      setNewDue(todayStr());
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
      <div className="task-top" data-tour="tk-controls">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {view !== "history" && (
            <>
              <div className="view-toggle" data-tour="tk-views">
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
              {view === "list" && (
                <div className="view-toggle">
                  <button
                    className={`vt ${listSort === "newest" ? "active" : ""}`}
                    onClick={() => setListSort("newest")}
                  >
                    최신순
                  </button>
                  <button
                    className={`vt ${listSort === "difficulty" ? "active" : ""}`}
                    onClick={() => setListSort("difficulty")}
                  >
                    난이도순
                  </button>
                  <button
                    className={`vt ${listSort === "oldest" ? "active" : ""}`}
                    onClick={() => setListSort("oldest")}
                  >
                    오래된순
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            className={`btn btn-sm${view === "history" ? " btn-consented" : ""}`}
            onClick={() => setView(view === "history" ? "board" : "history")}
          >
            <i className="ti ti-history" /> 이력
          </button>
          {team?.my_role === "leader" && (
            <button className="btn btn-sm" onClick={shareTaskStatus}>
              <i className="ti ti-share" /> 공유하기
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            data-tour="tk-add"
            onClick={() => setModalOpen(true)}
          >
            <i className="ti ti-plus" /> 태스크 추가
          </button>
        </div>
      </div>

      <div className="prog-strip" data-tour="tk-progress">
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
        <div className="board" data-tour="tk-board">
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
                  if (
                    task &&
                    canEdit(task) &&
                    API_TO_STATUS[task.status] !== col
                  ) {
                    requestStatusChange(task, col);
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
                <div className="col-cards">
                  {colTasks.map((t) => {
                    const status = API_TO_STATUS[t.status];
                    const dd = dueState(t.due_date);
                    const danger = status !== "완료" && dd.danger;
                    const warn = status !== "완료" && dd.warn;
                    const who = nameOf(t.assignee_id);
                    return (
                      <div
                        key={t.id}
                        draggable={canEdit(t)}
                        className={`tcard ${danger ? "danger" : ""} ${warn ? "warn" : ""} ${status === "완료" ? "done-card" : ""} ${draggingId === t.id ? "dragging" : ""}`}
                        style={{
                          cursor: canEdit(t)
                            ? draggingId === t.id
                              ? "grabbing"
                              : "grab"
                            : "default",
                          ...stripeStyle(t.assignee_id, danger, warn),
                        }}
                        onDragStart={(e) => {
                          if (!canEdit(t)) return;
                          setDraggingId(t.id);
                          e.dataTransfer.setData("taskId", String(t.id));
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        onDragEnd={() => setDraggingId(null)}
                        onClick={() => canEdit(t) && openEdit(t)}
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
                        {t.detail && (
                          <div className="tc-detail">{t.detail}</div>
                        )}
                        <div className="tc-foot">
                          <span className="tc-who">
                            <span
                              className="av av-sm"
                              style={{
                                background: avBg(t.assignee_id),
                                width: 20,
                                height: 20,
                                fontSize: 9,
                              }}
                            >
                              {who[0]}
                            </span>
                            {who}
                          </span>
                          <div
                            style={{
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "flex-end",
                              gap: 2,
                            }}
                          >
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
                                  <span
                                    style={{ fontWeight: 500, marginLeft: 2 }}
                                  >
                                    {dd.timeLabel}
                                  </span>
                                )}
                                {dd.dDay && (
                                  <span
                                    style={{ fontWeight: 700, marginLeft: 4 }}
                                  >
                                    {dd.dDay}
                                  </span>
                                )}
                              </div>
                            )}
                            {status === "완료" && t.completed_at && (
                              <div
                                className="tc-due"
                                style={{ color: "var(--green)" }}
                              >
                                <i className="ti ti-check" />
                                {fmtCompleted(t.completed_at)} 완료
                                {t.due_date &&
                                  new Date(t.completed_at) >
                                    new Date(t.due_date) && (
                                    <span
                                      style={{
                                        marginLeft: 4,
                                        fontSize: 10,
                                        fontWeight: 700,
                                        color: "var(--coral)",
                                        background: "var(--coral-soft)",
                                        borderRadius: 4,
                                        padding: "1px 5px",
                                      }}
                                    >
                                      기한 초과
                                    </span>
                                  )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
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
          {listFilteredTasks.map((t) => {
            const status = API_TO_STATUS[t.status];
            const dd = dueState(t.due_date);
            const danger = status !== "완료" && dd.danger;
            const warn = status !== "완료" && dd.warn;
            return (
              <div key={t.id} className="lrow-wrap">
                <div
                  className={`lrow ${danger ? "danger" : ""} ${warn ? "warn" : ""}`}
                  style={{
                    cursor: canEdit(t) ? "pointer" : "default",
                    ...stripeStyle(t.assignee_id, danger, warn),
                  }}
                  onClick={() => canEdit(t) && openEdit(t)}
                >
                  <div
                    className={`t-check ${status === "완료" ? "done" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (canEdit(t)) toggleList(t);
                    }}
                  >
                    <i className="ti ti-check" />
                  </div>
                  <div className="lrow-titlebox">
                    <div
                      className={`lrow-title ${status === "완료" ? "done" : ""}`}
                    >
                      {t.description}
                    </div>
                    {t.detail && <div className="lrow-detail">{t.detail}</div>}
                  </div>
                  <span className={`badge ${COL_BADGE[status] || "b-gray"}`}>
                    {status}
                  </span>
                  <div
                    className="av av-sm"
                    style={{ background: avBg(t.assignee_id) }}
                  >
                    {nameOf(t.assignee_id)[0]}
                  </div>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                      minWidth: 140,
                    }}
                  >
                    <div
                      className={`lrow-due ${danger ? "due-red" : warn ? "due-amber" : "due-soft"}`}
                    >
                      {dd.label ? (
                        <>
                          {dd.label}
                          {dd.timeLabel && ` ${dd.timeLabel}`}
                          {dd.dDay && (
                            <span style={{ fontWeight: 700, marginLeft: 5 }}>
                              {dd.dDay}
                            </span>
                          )}
                        </>
                      ) : (
                        "기한 없음"
                      )}
                    </div>
                    {status === "완료" && t.completed_at && (
                      <div
                        className="lrow-due"
                        style={{ color: "var(--green)" }}
                      >
                        <i className="ti ti-check" style={{ marginRight: 3 }} />
                        {fmtCompleted(t.completed_at)} 완료
                        {t.due_date &&
                          new Date(t.completed_at) > new Date(t.due_date) && (
                            <span
                              style={{
                                marginLeft: 4,
                                fontSize: 10,
                                fontWeight: 700,
                                color: "var(--coral)",
                                background: "var(--coral-soft)",
                                borderRadius: 4,
                                padding: "1px 5px",
                              }}
                            >
                              기한 초과
                            </span>
                          )}
                      </div>
                    )}
                  </div>
                  <span className="tc-diff">
                    {"★".repeat(t.difficulty ?? 1)}
                    <span className="tc-diff-off">
                      {"★".repeat(3 - (t.difficulty ?? 1))}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
          {listFilteredTasks.length === 0 && (
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

      {/* 이력 뷰 */}
      {view === "history" && (
        <div className="board">
          {(["edit", "delete"] as const).map((action) => {
            const colLogs = historyLogs.filter((l) => l.action === action);
            const label = action === "edit" ? "수정" : "삭제";
            const color = action === "edit" ? "var(--blue)" : "var(--coral)";
            return (
              <div key={action} className="board-col">
                <div className="col-head">
                  <span className="col-dot" style={{ background: color }} />
                  <span className="col-title">{label}</span>
                  <span className="col-cnt">{colLogs.length}</span>
                </div>
                <div className="col-cards">
                  {historyLoading ? (
                    <div
                      style={{
                        padding: 16,
                        fontSize: 13,
                        color: "var(--text-soft)",
                      }}
                    >
                      불러오는 중…
                    </div>
                  ) : colLogs.length === 0 ? (
                    <div
                      style={{
                        padding: 16,
                        fontSize: 13,
                        color: "var(--text-soft)",
                      }}
                    >
                      {label} 이력이 없습니다.
                    </div>
                  ) : (
                    colLogs.map((log) => (
                      <div
                        key={log.id}
                        className="tcard"
                        style={{ cursor: "default" }}
                      >
                        <div
                          style={{
                            fontSize: 11,
                            color: "var(--text-mut)",
                            marginBottom: 6,
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span style={{ fontWeight: 600, color }}>
                            {nameToNickname.get(log.actor_name) ??
                              log.actor_name}
                          </span>
                          <span>{fmtLogTime(log.created_at)}</span>
                        </div>
                        <div
                          style={{
                            fontSize: 12.5,
                            fontWeight: 600,
                            marginBottom: action === "edit" ? 8 : 0,
                          }}
                        >
                          {log.task_description}
                        </div>
                        {action === "edit" &&
                          (log.changes ?? []).map((c, i) => (
                            <div
                              key={i}
                              style={{
                                fontSize: 11.5,
                                color: "var(--text-soft)",
                                display: "flex",
                                alignItems: "center",
                                gap: 4,
                                marginTop: 3,
                              }}
                            >
                              <span
                                style={{
                                  fontWeight: 600,
                                  color: "var(--text-main)",
                                  minWidth: 36,
                                }}
                              >
                                {fieldLabel(c.field)}
                              </span>
                              <span style={{ color: "var(--coral)" }}>
                                {fmtLogVal(c.field, c.from)}
                              </span>
                              <i
                                className="ti ti-arrow-right"
                                style={{ fontSize: 10 }}
                              />
                              <span style={{ color: "var(--green)" }}>
                                {fmtLogVal(c.field, c.to)}
                              </span>
                            </div>
                          ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          })}
          {/* 세 번째 빈 컬럼 자리 — 보드 3열 레이아웃 유지 */}
          <div />
        </div>
      )}

      {/* 태스크 추가 모달 */}
      {modalOpen && (
        <Modal
          title="태스크 추가"
          className="modal-wide"
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
          <div className="field">
            <label className="field-label">세부사항 (선택)</label>
            <textarea
              className="input"
              rows={2}
              maxLength={2000}
              placeholder="예) 참고 링크, 작업 범위 등 메모"
              value={newDetail}
              onChange={(e) => setNewDetail(e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">담당자</label>
              <MemberSelect
                members={members}
                nicknameMap={nicknameMap}
                value={newAssignee}
                onChange={setNewAssignee}
              />
            </div>
            <div className="field">
              <label className="field-label">마감일</label>
              <div className="field-row" style={{ gap: 6 }}>
                <input
                  className="input"
                  type="date"
                  style={{ flex: 2 }}
                  min={todayStr()}
                  value={newDue}
                  onChange={(e) => setNewDue(e.target.value)}
                />
                <input
                  className="input"
                  type="time"
                  style={{ flex: 1 }}
                  placeholder="23:59"
                  min={timeMinForDate(newDue)}
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
          className="modal-wide"
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
              <button className="btn" onClick={() => void loadLogs(editTarget)}>
                <i className="ti ti-history" /> 이력
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
          <div className="field">
            <label className="field-label">세부사항 (선택)</label>
            <textarea
              className="input"
              rows={2}
              maxLength={2000}
              placeholder="예) 참고 링크, 작업 범위 등 메모"
              value={editDetail}
              onChange={(e) => setEditDetail(e.target.value)}
            />
            <div className="field-hint">세부사항은 승인 없이 바로 반영돼요</div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">담당자</label>
              <MemberSelect
                members={members}
                nicknameMap={nicknameMap}
                value={editAssignee}
                onChange={setEditAssignee}
              />
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
        </Modal>
      )}

      {/* 삭제 확인 모달 */}
      {confirmDelete && editTarget && (
        <ConfirmModal
          title="태스크 삭제"
          message={
            <>
              <strong>{editTarget.description}</strong> 태스크를 삭제할까요?
              <br />이 작업은 되돌릴 수 없습니다.
            </>
          }
          confirmLabel="삭제"
          busy={deleting}
          onConfirm={() => void deleteTask()}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      {/* 완료 → 다른 상태 변경 경고 모달 */}
      {statusChangePending && (
        <ConfirmModal
          title="완료 상태 변경"
          message={
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
                textAlign: "center",
                padding: "4px 0 8px",
              }}
            >
              <div
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: "rgba(240,193,79,.15)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <i
                  className="ti ti-alert-triangle"
                  style={{ fontSize: 26, color: "var(--amber, #b8860b)" }}
                />
              </div>
              <div
                style={{
                  fontSize: 14,
                  lineHeight: 1.7,
                  color: "var(--text-main)",
                }}
              >
                완료 처리된 태스크를{" "}
                <strong>{statusChangePending.newStatus}</strong>으로 변경하면
                <br />
                <strong style={{ color: "var(--amber, #b8860b)" }}>
                  완료 날짜가 초기화
                </strong>
                됩니다.
              </div>
            </div>
          }
          confirmLabel="변경"
          onConfirm={() => {
            void changeStatus(
              statusChangePending.task,
              statusChangePending.newStatus,
            );
            setStatusChangePending(null);
          }}
          onClose={() => setStatusChangePending(null)}
        />
      )}

      {/* 카카오 공유 미리보기 모달 */}
      {shareBatches.length > 0 && (
        <Modal
          title={`카카오 공유 ${shareBatchIdx + 1}/${shareBatches.length}`}
          onClose={() => setShareBatches([])}
          actions={
            <>
              <button className="btn" onClick={() => setShareBatches([])}>
                취소
              </button>
              <button className="btn btn-primary" onClick={sendCurrentBatch}>
                <i className="ti ti-brand-kakao" /> {shareBatchIdx + 1}/
                {shareBatches.length} 보내기
              </button>
            </>
          }
        >
          <div className="modal-sub">아래 내용이 카카오톡으로 공유됩니다.</div>
          {shareBatches[shareBatchIdx].map((item, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderBottom: "1px solid var(--border-2)",
              }}
            >
              <img
                src={item.img}
                alt=""
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  flexShrink: 0,
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text-main)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.title}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-soft)",
                    marginTop: 2,
                  }}
                >
                  {item.desc}
                </div>
              </div>
            </div>
          ))}
        </Modal>
      )}

      {/* 수정/삭제 이력 모달 */}
      {logsTarget && (
        <Modal
          title={`이력 — ${logsTarget.description}`}
          className="modal-wide"
          onClose={() => setLogsTarget(null)}
          actions={
            <button className="btn" onClick={() => setLogsTarget(null)}>
              닫기
            </button>
          }
        >
          {logsLoading ? (
            <div
              style={{
                padding: "24px 0",
                textAlign: "center",
                color: "var(--text-soft)",
                fontSize: 13,
              }}
            >
              불러오는 중…
            </div>
          ) : logs.length === 0 ? (
            <div
              style={{
                padding: "24px 0",
                textAlign: "center",
                color: "var(--text-soft)",
                fontSize: 13,
              }}
            >
              수정/삭제 이력이 없습니다.
            </div>
          ) : (
            <div className="log-list">
              {logs.map((log) => (
                <div key={log.id} className="log-item">
                  <div className="log-meta">
                    <span
                      className={`log-badge ${log.action === "delete" ? "log-badge-delete" : "log-badge-edit"}`}
                    >
                      {log.action === "delete" ? "삭제" : "수정"}
                    </span>
                    <span className="log-actor">
                      {nameToNickname.get(log.actor_name) ?? log.actor_name}
                    </span>
                    <span className="log-date">
                      {fmtLogTime(log.created_at)}
                    </span>
                  </div>
                  {log.action === "delete" ? (
                    <div className="log-desc">
                      <strong>{log.task_description}</strong> 태스크를
                      삭제했습니다.
                    </div>
                  ) : (
                    <div className="log-changes">
                      {(log.changes ?? []).map((c, i) => (
                        <div key={i} className="log-change-row">
                          <span className="log-field">
                            {fieldLabel(c.field)}
                          </span>
                          <span className="log-from">
                            {fmtLogVal(c.field, c.from)}
                          </span>
                          <i
                            className="ti ti-arrow-right"
                            style={{ fontSize: 11, color: "var(--text-mut)" }}
                          />
                          <span className="log-to">
                            {fmtLogVal(c.field, c.to)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function fmtLogTime(iso: string): string {
  const kst = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  const m = kst.getUTCMonth() + 1;
  const d = kst.getUTCDate();
  const h = kst.getUTCHours();
  const min = String(kst.getUTCMinutes()).padStart(2, "0");
  const ampm = h < 12 ? "오전" : "오후";
  const h12 = h % 12 || 12;
  return `${m}. ${d}. ${ampm} ${h12}:${min}`;
}

function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    description: "이름",
    difficulty: "난이도",
    assignee: "담당자",
    due_date: "마감일",
    status: "상태",
  };
  return map[field] ?? field;
}

function formatVal(field: string, val: string | null): string {
  if (val == null) return "없음";
  if (field === "difficulty") return "★".repeat(Number(val));
  if (field === "due_date") {
    const d = new Date(val);
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  }
  return val;
}
