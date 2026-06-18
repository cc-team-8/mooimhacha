import { useState, useEffect, useCallback } from "react";
import { useOutletContext } from "react-router-dom";
import {
  todayStr,
  nowTimeStr,
  nowDateTimeStr,
  timeMinForDate,
} from "@/lib/dateUtils";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { apiGet, apiPatch, apiPost, apiDelete } from "@/lib/api";
import { getUser } from "@/lib/auth";
import type { ActionItem, TeamContribution, TaskExtension } from "@/lib/types";
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
  const [view, setView] = useState<"board" | "list">("board");
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [tasks, setTasks] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamContribution[]>([]);

  // 추가 모달
  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newDesc, setNewDesc] = useState("");
  const [newAssignee, setNewAssignee] = useState<string>("");
  const [newDue, setNewDue] = useState(todayStr());
  const [newTime, setNewTime] = useState(nowTimeStr());
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

  // 기한 연장: 태스크별 최신 요청 (action_item_id → 요청)
  const [extensions, setExtensions] = useState<Map<number, TaskExtension>>(
    new Map(),
  );
  // 연장 요청 모달
  const [extTarget, setExtTarget] = useState<ActionItem | null>(null);
  const [extDue, setExtDue] = useState("");
  const [extReason, setExtReason] = useState("");
  const [extSaving, setExtSaving] = useState(false);

  // 팀의 연장 요청 로드 — 태스크별 최신 1건만 (list는 created_at DESC)
  const loadExtensions = useCallback(async () => {
    if (!team) return;
    try {
      const list = await apiGet<TaskExtension[]>(
        `/teams/${team.id}/extensions`,
      );
      const byTask = new Map<number, TaskExtension>();
      for (const e of list) {
        if (!byTask.has(e.action_item_id)) byTask.set(e.action_item_id, e);
      }
      setExtensions(byTask);
    } catch {
      /* 부가 정보 — 실패는 조용히 무시 */
    }
  }, [team]);

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
    void loadExtensions();
  }, [load, loadExtensions]);

  // 연장 요청 모달 열기 — 기본 희망 기한은 기존 기한 +3일
  function openExtModal(t: ActionItem) {
    setExtTarget(t);
    setExtReason("");
    const base = t.due_date ? new Date(t.due_date) : new Date();
    base.setDate(base.getDate() + 3);
    setExtDue(toLocalInput(base));
  }

  async function submitExtension() {
    if (!extTarget) return;
    if (!extDue) {
      showToast("희망 기한을 선택해 주세요", "error");
      return;
    }
    if (!extReason.trim()) {
      showToast("연장 사유를 입력해 주세요", "error");
      return;
    }
    setExtSaving(true);
    try {
      await apiPost(`/action-items/${extTarget.id}/extension`, {
        requested_due_date: new Date(extDue).toISOString(),
        reason: extReason.trim(),
      });
      setExtTarget(null);
      await loadExtensions();
      showToast("연장 요청을 보냈어요. 팀장 승인을 기다려 주세요");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setExtSaving(false);
    }
  }

  async function approveExt(extId: number) {
    try {
      await apiPost(`/extensions/${extId}/approve`);
      await Promise.all([load(), loadExtensions()]);
      showToast("연장을 수락했습니다");
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }

  async function rejectExt(extId: number) {
    try {
      await apiPost(`/extensions/${extId}/reject`);
      await loadExtensions();
      showToast("연장을 거절했습니다");
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }

  // 태스크 카드 인라인 연장 영역 — board/list 공용
  function renderExtension(t: ActionItem) {
    const status = API_TO_STATUS[t.status];
    const dd = dueState(t.due_date);
    const overdue = status !== "완료" && dd.danger;
    const ext = extensions.get(t.id);
    const isLeader = team?.my_role === "leader";
    const isMine = t.assignee_id === currentUser?.id;
    const fmtD = (iso: string) => {
      const d = new Date(iso);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    if (ext?.status === "pending") {
      return (
        <div className="tc-ext" onClick={(e) => e.stopPropagation()}>
          <span className="tc-ext-label">
            <i className="ti ti-clock-hour-4" /> 연장 요청 ~
            {fmtD(ext.requested_due_date)}
          </span>
          {isLeader ? (
            <span className="tc-ext-acts">
              <button
                className="tc-ext-ok"
                onClick={() => void approveExt(ext.id)}
              >
                수락
              </button>
              <button
                className="tc-ext-no"
                onClick={() => void rejectExt(ext.id)}
              >
                거절
              </button>
            </span>
          ) : (
            <span className="tc-ext-wait">대기 중</span>
          )}
        </div>
      );
    }
    if (overdue && isMine) {
      return (
        <button
          className="tc-ext-btn"
          onClick={(e) => {
            e.stopPropagation();
            openExtModal(t);
          }}
        >
          <i className="ti ti-calendar-plus" />
          {ext?.status === "rejected"
            ? "연장 거절됨 · 재요청"
            : "기한 연장 요청"}
        </button>
      );
    }
    return null;
  }

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

  const canEdit = (t: ActionItem) =>
    !t.assignee_id || t.assignee_id === currentUser?.id;

  function openEdit(task: ActionItem) {
    setEditTarget(task);
    setEditDesc(task.description);
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
        assignee_id: editAssignee ? Number(editAssignee) : null,
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
      setNewDue(todayStr());
      setNewTime(nowTimeStr());
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {team?.my_role === "leader" && (
            <button className="btn btn-sm" onClick={shareTaskStatus}>
              <i className="ti ti-share" /> 공유하기
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => setModalOpen(true)}
          >
            <i className="ti ti-plus" /> 태스크 추가
          </button>
        </div>
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
                      {renderExtension(t)}
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
                {renderExtension(t)}
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

      {/* 기한 연장 요청 모달 */}
      {extTarget && (
        <Modal
          title="기한 연장 요청"
          onClose={() => setExtTarget(null)}
          actions={
            <>
              <button className="btn" onClick={() => setExtTarget(null)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void submitExtension()}
                disabled={extSaving}
              >
                {extSaving ? "요청 중…" : "요청 보내기"}
              </button>
            </>
          }
        >
          <div className="modal-sub">팀장이 수락하면 기한이 변경됩니다.</div>
          <div className="field">
            <label className="field-label">희망 기한</label>
            <input
              className="input"
              type="datetime-local"
              min={nowDateTimeStr()}
              value={extDue}
              onChange={(e) => setExtDue(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">사유</label>
            <textarea
              className="input"
              rows={3}
              placeholder="예) 추가 자료 조사가 더 필요합니다."
              value={extReason}
              onChange={(e) => setExtReason(e.target.value)}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
