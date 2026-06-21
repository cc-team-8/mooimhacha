import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useOutletContext } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import HeadsetGateModal from "@/components/HeadsetGateModal";
import MemberSelect from "@/components/MemberSelect";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";
import { openCompanion, createCompanionChannel } from "@/lib/companion";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type {
  ActionItem,
  Agenda,
  Decision,
  Meeting,
  MeetingContribution,
  TeamContribution,
  MeetingAttendance,
  AttendanceSummary,
  AttendanceStatus,
  Transcript,
  TeamSettings,
} from "@/lib/types";
import type { TeamContext } from "../DashboardPage";
import { todayStr, nowTimeStr, timeMinForDate } from "@/lib/dateUtils";

type Tab =
  | "agenda"
  | "speak"
  | "attendance"
  | "decision"
  | "summary"
  | "settings";
type Status = "할 일" | "진행 중" | "완료";

const STATUS_TO_API: Record<Status, string> = {
  "할 일": "todo",
  "진행 중": "in_progress",
  완료: "done",
};
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

// 출결 상태별 배지 표기 (기존 색상 토큰 재사용)
const ATT_BADGE: Record<
  AttendanceStatus,
  { label: string; color: string; bg: string }
> = {
  present: { label: "출석", color: "var(--green)", bg: "var(--green-soft)" },
  excused: {
    label: "출석 인정",
    color: "var(--green)",
    bg: "var(--green-soft)",
  },
  late: { label: "지각", color: "#b8860b", bg: "rgba(240,193,79,.18)" },
  absent: { label: "결석", color: "var(--coral)", bg: "var(--coral-soft)" },
};

import { avatarBg, memberColor } from "@/lib/avatarColor";

function meetingMeta(
  m: Meeting,
  memberCount: number,
  attendedCount?: number,
): string {
  const d = new Date(m.scheduled_at);
  const today = new Date();
  const day =
    d.toDateString() === today.toDateString()
      ? "오늘"
      : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  if (m.status === "ended" && m.t0_timestamp && m.ended_at) {
    const start = new Date(m.t0_timestamp);
    const end = new Date(m.ended_at);
    const timeFmt = (t: Date) =>
      t.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
    const startDay =
      start.toDateString() === today.toDateString()
        ? "오늘"
        : `${start.getMonth() + 1}월 ${start.getDate()}일`;
    const sameDay = start.toDateString() === end.toDateString();
    const endStr = sameDay
      ? timeFmt(end)
      : `${end.getMonth() + 1}/${end.getDate()} ${timeFmt(end)}`;
    const countStr = attendedCount !== undefined ? ` · ${attendedCount}명` : "";
    return `${startDay} · ${timeFmt(start)} ~ ${endStr}${countStr}`;
  }
  return `${day} · ${memberCount}명`;
}

export default function MeetingPage() {
  const { showToast } = useToast();
  const team = useOutletContext<TeamContext | null>();
  const me = useCurrentUser();
  const [tab, setTab] = useState<Tab>("agenda");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [speak, setSpeak] = useState<MeetingContribution[]>([]);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [attendance, setAttendance] = useState<MeetingAttendance | null>(null);
  const [teamSettings, setTeamSettings] = useState<TeamSettings | null>(null);
  const [hasJoined, setHasJoined] = useState<boolean | null>(null);
  const [joinedCount, setJoinedCount] = useState(0);
  const [joiningMeeting, setJoiningMeeting] = useState(false);
  const [absenceInput, setAbsenceInput] = useState("");
  // 회의별 출결 요약 (목록 배지·미처리 표시용)
  const [summaries, setSummaries] = useState<Map<number, AttendanceSummary>>(
    new Map(),
  );
  // elapsed: 초 단위 정수. fmt()로 MM:SS 포맷 변환.
  const [elapsed, setElapsed] = useState(0);
  const [decInput, setDecInput] = useState("");
  // 세 모달을 하나의 state로 관리. null이면 모두 닫힘.
  const [modalOpen, setModalOpen] = useState<
    | "meeting"
    | "decision"
    | "agenda"
    | "absence"
    | "headset"
    | "quickstart"
    | null
  >(null);
  const [headsetAction, setHeadsetAction] = useState<
    "start" | "attend" | "quickstart"
  >("start");
  // 결정 수정/삭제 대상 — 수정은 결정 모달을 재사용, 삭제는 확인 모달을 띄운다.
  const [editingDecision, setEditingDecision] = useState<Decision | null>(null);
  const [deletingDecision, setDeletingDecision] = useState<Decision | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingTasks, setPendingTasks] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<TeamContribution[]>([]);
  const [prevDecisions, setPrevDecisions] = useState<Decision[]>([]);

  // AI 태스크 확정 모달
  const [confirmTask, setConfirmTask] = useState<ActionItem | null>(null);
  const [confirmDesc, setConfirmDesc] = useState("");
  const [confirmAssignee, setConfirmAssignee] = useState("");
  const [confirmDue, setConfirmDue] = useState(todayStr());
  const [confirmTime, setConfirmTime] = useState(nowTimeStr());
  const [confirmStatus, setConfirmStatus] = useState<Status>("할 일");
  const [confirmDifficulty, setConfirmDifficulty] = useState(2);
  const [confirmSaving, setConfirmSaving] = useState(false);
  // 발언 탭 최초 진입 시 바 애니메이션을 한 번만 실행하기 위한 플래그.
  // state 대신 ref를 쓰는 이유: 값 변경이 리렌더를 유발할 필요 없음.

  // 새 회의 모달 입력값
  const [newTopic, setNewTopic] = useState("");
  // 회의 설정 탭
  const [editTopic, setEditTopic] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editTime, setEditTime] = useState("");
  const [editMinutes, setEditMinutes] = useState<number | "">(30);
  const [editMeetingType, setEditMeetingType] = useState<"regular" | "partial">(
    "regular",
  );
  const [editSaving, setEditSaving] = useState(false);
  const [deletingMeeting, setDeletingMeeting] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [newMeetingType, setNewMeetingType] = useState<"regular" | "partial">(
    "regular",
  );
  const [newDate, setNewDate] = useState(todayStr());
  const [newTime, setNewTime] = useState(nowTimeStr());
  // 입력 중 빈 값을 허용하기 위해 ""도 담는다 — 제출 시 기본값으로 보정
  const [newMinutes, setNewMinutes] = useState<number | "">(30);
  // 아젠다를 한 항목씩 추가 — 예상 시간(minutes)은 선택
  const [newAgendaList, setNewAgendaList] = useState<
    { title: string; minutes: number | "" }[]
  >([]);
  const [newAgendaInput, setNewAgendaInput] = useState("");
  const [newAgendaMinutes, setNewAgendaMinutes] = useState<number | "">("");
  const [quickTopic, setQuickTopic] = useState("");
  const [quickMeetingType, setQuickMeetingType] = useState<
    "regular" | "partial"
  >("regular");
  const [quickMinutes, setQuickMinutes] = useState<number | "">(30);
  const [quickAgendaList, setQuickAgendaList] = useState<
    { title: string; minutes: number | "" }[]
  >([]);
  const [quickAgendaInput, setQuickAgendaInput] = useState("");
  const [quickAgendaMinutes, setQuickAgendaMinutes] = useState<number | "">("");
  const [quickStarting, setQuickStarting] = useState(false);

  // 아젠다 모달 입력값
  const [agTitle, setAgTitle] = useState("");
  const [agMinutes, setAgMinutes] = useState<number | "">(10);

  const selected = meetings.find((m) => m.id === selectedId) ?? null;

  const nicknameMap = useMemo(
    () =>
      new Map(
        (team?.members ?? []).map((m) => [m.user_id, m.nickname ?? m.name]),
      ),
    [team],
  );
  const memberIdx = (userId: number) => {
    const i = (team?.members ?? []).findIndex((m) => m.user_id === userId);
    return i < 0 ? userId % 32 : i;
  };

  // 가장 최근에 종료된 회의 (선택 회의 제외)
  const prevMeeting = useMemo(() => {
    if (!selected) return null;
    return (
      [...meetings]
        .filter((m) => m.status === "ended" && m.id !== selected.id)
        .sort((a, b) => {
          const ta = a.ended_at ?? a.scheduled_at;
          const tb = b.ended_at ?? b.scheduled_at;
          return new Date(tb).getTime() - new Date(ta).getTime();
        })[0] ?? null
    );
  }, [meetings, selected]);

  useEffect(() => {
    setPrevDecisions([]);
    if (!prevMeeting || selected?.status === "ended") return;
    apiGet<Decision[]>(`/decisions?meeting_id=${prevMeeting.id}`)
      .then(setPrevDecisions)
      .catch(() => {});
  }, [prevMeeting?.id, selected?.status]);

  const loadMeetings = useCallback(async () => {
    if (!team) return;
    try {
      const ms = await apiGet<Meeting[]>(`/meetings?team_id=${team.id}`);
      setMeetings(ms);
      // 선택 유지, 없으면 진행 중 → 예정 → 최근 종료 순으로 기본 선택
      setSelectedId((cur) => {
        if (cur && ms.some((m) => m.id === cur)) return cur;
        const active = ms.find((m) => m.status === "active");
        const scheduled = [...ms]
          .filter((m) => m.status === "scheduled")
          .sort(
            (a, b) =>
              new Date(a.scheduled_at).getTime() -
              new Date(b.scheduled_at).getTime(),
          )[0];
        const ended = [...ms]
          .filter((m) => m.status === "ended")
          .sort(
            (a, b) =>
              new Date(b.scheduled_at).getTime() -
              new Date(a.scheduled_at).getTime(),
          )[0];
        return (active ?? scheduled ?? ended)?.id ?? null;
      });
    } catch (e) {
      showToast((e as Error).message, "error");
    }
  }, [team, showToast]);

  useEffect(() => {
    void loadMeetings();
  }, [loadMeetings]);

  const loadPendingTasks = useCallback(async () => {
    if (!team || !selectedId) return;
    try {
      const all = await apiGet<ActionItem[]>(
        `/action-items?team_id=${team.id}&meeting_id=${selectedId}&confirmed=false`,
      );
      setPendingTasks(all.filter((t) => t.source === "ai_extracted"));
    } catch {
      // 실패는 무시 — 요약 탭 부가 기능
    }
  }, [team, selectedId]);

  // 요약 탭 + 종료된 회의일 때 미확정 AI 태스크 로드
  useEffect(() => {
    if (tab === "summary" && selected?.status === "ended") {
      void loadPendingTasks();
    }
  }, [tab, selected?.status, loadPendingTasks]);

  // 설정 탭 진입 시 현재 값으로 초기화
  useEffect(() => {
    if (tab === "settings" && selected) {
      setEditTopic(selected.topic ?? "");
      const d = new Date(selected.scheduled_at);
      setEditDate(d.toLocaleDateString("sv-SE"));
      setEditTime(
        d.toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }),
      );
      setEditMinutes(selected.total_minutes ?? 30);
      setEditMeetingType(selected.meeting_type ?? "regular");
    }
  }, [tab, selected?.id]);

  async function saveMeetingSettings() {
    if (!selectedId || editSaving) return;
    if (selected?.status === "scheduled") {
      if (!editDate || !editTime) {
        showToast("날짜와 시간을 입력해 주세요", "error");
        return;
      }
      if (new Date(`${editDate}T${editTime}:00`) <= new Date()) {
        showToast("현재 시각 이후로 설정해 주세요", "error");
        return;
      }
    }
    setEditSaving(true);
    try {
      const patch: Record<string, unknown> = {
        topic: editTopic.trim() || undefined,
      };
      if (selected?.status !== "ended") {
        patch.meeting_type = editMeetingType;
      }
      if (selected?.status === "scheduled") {
        patch.scheduled_at = new Date(
          `${editDate}T${editTime}:00`,
        ).toISOString();
        patch.total_minutes = editMinutes || undefined;
      }
      await apiPatch(`/meetings/${selectedId}`, patch);
      await loadMeetings();
      showToast("회의 정보가 수정되었습니다.");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDeleteMeeting() {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await apiDelete(`/meetings/${selectedId}`);
      setSelectedId(null);
      setDeletingMeeting(false);
      setDeleteConfirmInput("");
      showToast("회의가 삭제되었습니다.");
      await loadMeetings();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // 팀 멤버 목록 (확정 모달 담당자 선택용)
  useEffect(() => {
    if (!team) return;
    apiGet<{ members: TeamContribution[] }>(`/teams/${team.id}/contributions`)
      .then((r) => setMembers(r.members))
      .catch(() => {});
  }, [team]);

  // companion 창 이벤트 → 대시보드 즉시 갱신
  useEffect(() => {
    const ch = createCompanionChannel();
    ch.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type?: string };
      if (msg.type === "meeting:ended") {
        void loadMeetings();
      } else if (msg.type === "agenda:added" && selectedId) {
        void apiGet<Agenda[]>(`/meetings/${selectedId}/agendas`)
          .then(setAgendas)
          .catch(() => {});
      } else if (msg.type === "decision:added" && selectedId) {
        void apiGet<Decision[]>(`/decisions?meeting_id=${selectedId}`)
          .then(setDecisions)
          .catch(() => {});
      } else if (msg.type === "action:added") {
        // 회의 탭에 실시간 액션 목록 없음 — Tasks 페이지에서 확인
      }
    };
    return () => ch.close();
  }, [loadMeetings, selectedId]);

  // 회의 목록 출결 요약 — 카드 배지·미처리 표시용 (부가 정보라 실패는 조용히 무시)
  const loadSummaries = useCallback(async () => {
    if (!team) return;
    try {
      const list = await apiGet<AttendanceSummary[]>(
        `/teams/${team.id}/attendance-summary`,
      );
      setSummaries(new Map(list.map((s) => [s.meeting_id, s])));
    } catch {
      /* 무시 */
    }
  }, [team]);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries]);

  // 선택 회의의 상세(아젠다·발언·결정) 로드
  useEffect(() => {
    if (!selectedId) {
      setAgendas([]);
      setSpeak([]);
      setTranscript(null);
      setDecisions([]);
      return;
    }
    let alive = true;
    setTranscript(null);
    void Promise.allSettled([
      apiGet<Agenda[]>(`/meetings/${selectedId}/agendas`),
      apiGet<{ scores: MeetingContribution[] }>(
        `/meetings/${selectedId}/contributions`,
      ),
      apiGet<Decision[]>(`/decisions?meeting_id=${selectedId}`),
    ]).then(([ag, sp, dc]) => {
      if (!alive) return;
      if (ag.status === "fulfilled") setAgendas(ag.value);
      if (sp.status === "fulfilled") setSpeak(sp.value.scores);
      if (dc.status === "fulfilled") setDecisions(dc.value);
    });
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // 출결: 종료된 회의의 출결 탭 진입 시 로드 (재사용 위해 useCallback)
  const loadAttendance = useCallback(
    async (meetingId: number) => {
      try {
        setAttendance(
          await apiGet<MeetingAttendance>(`/meetings/${meetingId}/attendance`),
        );
      } catch (e) {
        showToast((e as Error).message, "error");
      }
    },
    [showToast],
  );

  useEffect(() => {
    setAttendance(null);
    if (tab === "attendance" && selected?.status === "ended" && selectedId) {
      void loadAttendance(selectedId);
      if (!teamSettings && team) {
        void apiGet<TeamSettings>(`/teams/${team.id}/settings`)
          .then(setTeamSettings)
          .catch(() => null);
      }
    }
  }, [tab, selectedId, selected?.status, loadAttendance]);

  useEffect(() => {
    setHasJoined(null);
    setJoinedCount(0);
    if (!selectedId || selected?.status === "ended") return;
    void apiGet<{ count: number; hasJoined: boolean }>(
      `/meetings/${selectedId}/joined-count`,
    )
      .then(({ count, hasJoined: hj }) => {
        setJoinedCount(count);
        setHasJoined(hj);
      })
      .catch(() => null);
  }, [selectedId, selected?.status]);

  useEffect(() => {
    if (
      tab === "speak" &&
      selected?.status === "ended" &&
      selectedId &&
      !transcript
    ) {
      void apiGet<Transcript>(`/meetings/${selectedId}/transcript`)
        .then(setTranscript)
        .catch(() => null);
    }
  }, [tab, selectedId, selected?.status, transcript]);

  // 진행 중 회의 경과 시간 — t0 기준 실측, 1초 틱
  useEffect(() => {
    if (!selected || selected.status !== "active" || !selected.t0_timestamp) {
      setElapsed(0);
      return;
    }
    const t0 = new Date(selected.t0_timestamp).getTime();
    const tick = () =>
      setElapsed(Math.max(0, Math.floor((Date.now() - t0) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [selected]);

  useEffect(() => {
    if (tab === "speak") {
      requestAnimationFrame(() => {
        document
          .querySelectorAll<HTMLElement>(".speak-bar i[data-w]")
          .forEach((b) => {
            b.style.width = b.dataset.w + "%";
          });
      });
    }
  }, [tab, speak]);

  const fmt = (s: number) =>
    String(Math.floor(s / 60)).padStart(2, "0") +
    ":" +
    String(s % 60).padStart(2, "0");

  const fmtAgTime = (ag: Agenda) => {
    if (ag.started_at_offset_ms != null && ag.ended_at_offset_ms != null) {
      const totalSec = Math.round(
        (ag.ended_at_offset_ms - ag.started_at_offset_ms) / 1000,
      );
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      return s > 0 ? `${m}분 ${s}초` : `${m}분`;
    }
    return `${ag.actual_minutes ?? ag.estimated_minutes}분`;
  };

  async function saveConfirmTask() {
    if (!confirmTask || confirmSaving) return;
    if (!confirmDesc.trim()) {
      showToast("태스크 이름을 입력해 주세요", "error");
      return;
    }
    setConfirmSaving(true);
    try {
      await apiPatch(`/action-items/${confirmTask.id}`, {
        description: confirmDesc.trim(),
        confirmed: true,
        assignee_id: confirmAssignee ? Number(confirmAssignee) : null,
        due_date: confirmDue
          ? new Date(`${confirmDue}T${confirmTime || "23:59"}`).toISOString()
          : undefined,
        status: STATUS_TO_API[confirmStatus],
        difficulty: confirmDifficulty,
      });
      setPendingTasks((prev) => prev.filter((t) => t.id !== confirmTask.id));
      setConfirmTask(null);
      showToast("태스크가 확정됐습니다.");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setConfirmSaving(false);
    }
  }

  // 추가/수정 겸용 — editingDecision이 있으면 PATCH, 없으면 POST
  async function saveDecision() {
    if (!decInput.trim()) {
      showToast("결정 내용을 입력해주세요");
      return;
    }
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      if (editingDecision) {
        await apiPatch(`/decisions/${editingDecision.id}`, {
          content: decInput.trim(),
        });
      } else {
        await apiPost("/decisions", {
          meeting_id: selectedId,
          content: decInput.trim(),
        });
      }
      setDecisions(
        await apiGet<Decision[]>(`/decisions?meeting_id=${selectedId}`),
      );
      if (!editingDecision) {
        const ch = createCompanionChannel();
        ch.postMessage({ type: "decision:added", meeting_id: selectedId });
        ch.close();
      }
      setDecInput("");
      setModalOpen(null);
      showToast(
        editingDecision
          ? "결정 사항이 수정되었습니다"
          : "결정 사항이 추가되었습니다",
      );
      setEditingDecision(null);
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function deleteDecision() {
    if (!deletingDecision || busy) return;
    setBusy(true);
    try {
      await apiDelete(`/decisions/${deletingDecision.id}`);
      setDecisions((prev) => prev.filter((d) => d.id !== deletingDecision.id));
      setDeletingDecision(null);
      showToast("결정 사항이 삭제되었습니다");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // 본인 결석 사유 입력
  async function saveAbsence() {
    if (!absenceInput.trim()) {
      showToast("결석 사유를 입력해주세요");
      return;
    }
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await apiPost(`/meetings/${selectedId}/absences`, {
        reason: absenceInput.trim(),
      });
      setModalOpen(null);
      setAbsenceInput("");
      showToast("사유가 등록됐습니다");
      await Promise.all([loadAttendance(selectedId), loadSummaries()]);
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // 다른 멤버의 결석 사유에 동의 — 정족수 도달 시 출석 인정으로 자동 전환
  async function consentAbsence(absenceId: number) {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      const r = await apiPost<{ status: string }>(
        `/absences/${absenceId}/consent`,
      );
      await Promise.all([loadAttendance(selectedId), loadSummaries()]);
      showToast(
        r.status === "approved"
          ? "출석 인정으로 처리되었습니다"
          : "동의했습니다",
      );
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancelConsent(absenceId: number) {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await apiDelete(`/absences/${absenceId}/consent`);
      await Promise.all([loadAttendance(selectedId), loadSummaries()]);
      showToast("동의를 취소했습니다");
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // 새 회의 모달: 아젠다를 한 항목씩 리스트에 추가
  function addAgendaToList() {
    const t = newAgendaInput.trim();
    if (!t) return;
    setNewAgendaList((prev) => [
      ...prev,
      { title: t, minutes: newAgendaMinutes },
    ]);
    setNewAgendaInput("");
    setNewAgendaMinutes("");
  }

  function removeAgendaFromList(idx: number) {
    setNewAgendaList((prev) => prev.filter((_, i) => i !== idx));
  }

  // 새 회의 모달 닫기 — 아젠다 입력 잔존 방지
  function closeMeetingModal() {
    setModalOpen(null);
    setNewMeetingType("regular");
    setNewAgendaList([]);
    setNewAgendaInput("");
    setNewAgendaMinutes("");
  }

  function addQuickAgendaToList() {
    const t = quickAgendaInput.trim();
    if (!t) return;
    setQuickAgendaList((prev) => [
      ...prev,
      { title: t, minutes: quickAgendaMinutes },
    ]);
    setQuickAgendaInput("");
    setQuickAgendaMinutes("");
  }

  function removeQuickAgendaFromList(idx: number) {
    setQuickAgendaList((prev) => prev.filter((_, i) => i !== idx));
  }

  // "지금 바로 시작" 모달 닫기 — 입력 잔존 방지
  function closeQuickstartModal() {
    setModalOpen(null);
    setQuickTopic("");
    setQuickMeetingType("regular");
    setQuickMinutes(30);
    setQuickAgendaList([]);
    setQuickAgendaInput("");
    setQuickAgendaMinutes("");
  }

  async function createMeeting() {
    if (!team || busy) return;
    if (!newDate) {
      showToast("날짜를 선택해 주세요", "error");
      return;
    }
    if (!newTime) {
      showToast("시간을 입력해 주세요", "error");
      return;
    }
    if (new Date(`${newDate}T${newTime}:00`) <= new Date()) {
      showToast("현재 시각 이후로 설정해 주세요", "error");
      return;
    }
    if (!newMinutes) {
      showToast("예상 소요 시간을 입력해 주세요", "error");
      return;
    }
    setBusy(true);
    try {
      const created = await apiPost<Meeting>("/meetings", {
        team_id: team.id,
        scheduled_at: new Date(`${newDate}T${newTime}:00`).toISOString(),
        total_minutes: newMinutes,
        topic: newTopic.trim() || undefined,
        meeting_type: newMeetingType,
      });
      // 추가한 아젠다를 순서대로 등록 — 예상 시간은 입력한 경우에만 전송(선택)
      for (const ag of newAgendaList) {
        await apiPost(`/meetings/${created.id}/agendas`, {
          title: ag.title,
          ...(ag.minutes !== "" ? { estimated_minutes: ag.minutes } : {}),
        });
      }
      setModalOpen(null);
      setNewTopic("");
      setNewMeetingType("regular");
      setNewDate(todayStr());
      setNewTime(nowTimeStr());
      setNewAgendaList([]);
      setNewAgendaInput("");
      setNewAgendaMinutes("");
      showToast("새 회의가 생성되었습니다");
      await loadMeetings();
      setSelectedId(created.id);
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // "지금 바로 시작" — 날짜/시간 입력 없이 현재 시각으로 생성 후 곧바로 시작하고
  // 회의 창(보조 창)을 연다. 헤드셋 안내 모달 확인 후 호출된다.
  async function startMeetingNow() {
    if (!team || quickStarting) return;
    if (!quickMinutes) {
      showToast("예상 소요 시간을 입력해 주세요", "error");
      return;
    }
    setQuickStarting(true);
    try {
      const created = await apiPost<Meeting>("/meetings", {
        team_id: team.id,
        scheduled_at: new Date().toISOString(),
        total_minutes: quickMinutes,
        topic: quickTopic.trim() || undefined,
        meeting_type: quickMeetingType,
      });
      for (const ag of quickAgendaList) {
        await apiPost(`/meetings/${created.id}/agendas`, {
          title: ag.title,
          ...(ag.minutes !== "" ? { estimated_minutes: ag.minutes } : {}),
        });
      }
      await apiPost(`/meetings/${created.id}/start`);
      closeQuickstartModal();
      await loadMeetings();
      setSelectedId(created.id);
      const win = openCompanion(created.id, team.id);
      if (!window.mooimhacha?.isElectron && win === null) {
        showToast(
          "회의는 시작됐지만 팝업이 차단됐어요. 회의실 탭에서 회의 창을 다시 열어주세요.",
          "error",
        );
      } else {
        showToast("회의가 시작되었습니다");
      }
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setQuickStarting(false);
    }
  }

  async function addAgenda() {
    if (!selectedId || busy) return;
    if (!agTitle.trim()) {
      showToast("아젠다 내용을 입력해 주세요", "error");
      return;
    }
    setBusy(true);
    try {
      await apiPost(`/meetings/${selectedId}/agendas`, {
        title: agTitle.trim(),
        estimated_minutes: agMinutes || 10,
      });
      setAgendas(await apiGet<Agenda[]>(`/meetings/${selectedId}/agendas`));
      setModalOpen(null);
      setAgTitle("");
      showToast("아젠다가 추가되었습니다");
      const ch = createCompanionChannel();
      ch.postMessage({ type: "agenda:added", meeting_id: selectedId });
      ch.close();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // 회의 시작 — 서버가 호출 시점을 t0_timestamp(시각 동기화 기준점)로 저장한다
  async function startMeeting() {
    if (!selected || !team || busy) return;
    setBusy(true);
    try {
      await apiPost(`/meetings/${selected.id}/start`);
      // 시작자도 바로 참여(출석)되도록 회의 창을 즉시 연다 — 런처와 동일 동작.
      // 출석은 회의 창이 WS meeting:join 을 보내는 시점에 기록된다.
      const win = openCompanion(selected.id, team.id);
      if (!window.mooimhacha?.isElectron && win === null) {
        showToast(
          "회의는 시작됐지만 팝업이 차단됐어요. 회의실 탭에서 회의 창을 다시 열어주세요.",
          "error",
        );
      } else {
        showToast("회의가 시작되었습니다");
      }
      await loadMeetings();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function endMeeting() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      await apiPost(`/meetings/${selected.id}/end`);
      showToast("회의가 종료되었습니다. 기여도가 산정돼요");
      await loadMeetings();
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function attendMeeting() {
    if (!selected || !team || joiningMeeting) return;
    setJoiningMeeting(true);
    try {
      const res = await apiPost<{ ok: true; alreadyJoined: boolean }>(
        `/meetings/${selected.id}/attend`,
        {},
      );
      setHasJoined(true);
      const win = openCompanion(selected.id, team.id);
      if (!window.mooimhacha?.isElectron && win === null) {
        showToast(
          "참가는 완료됐지만 팝업이 차단됐어요. 회의실 탭에서 회의 창을 다시 열어주세요.",
          "error",
        );
      } else if (!res.alreadyJoined) {
        showToast("참가 완료!");
      }
      if (!res.alreadyJoined) {
        setJoinedCount((c) => c + 1);
      }
    } catch (e) {
      showToast((e as Error).message, "error");
    } finally {
      setJoiningMeeting(false);
    }
  }

  async function refreshDetail() {
    if (!selectedId || refreshing) return;
    setRefreshing(true);
    try {
      await loadMeetings();
      const [ag, sp, dc] = await Promise.allSettled([
        apiGet<Agenda[]>(`/meetings/${selectedId}/agendas`),
        apiGet<{ scores: MeetingContribution[] }>(
          `/meetings/${selectedId}/contributions`,
        ),
        apiGet<Decision[]>(`/decisions?meeting_id=${selectedId}`),
      ]);
      if (ag.status === "fulfilled") setAgendas(ag.value);
      if (sp.status === "fulfilled") setSpeak(sp.value.scores);
      if (dc.status === "fulfilled") setDecisions(dc.value);
      setTranscript(null);
      if (selected?.status === "ended") {
        await loadAttendance(selectedId);
        await loadPendingTasks();
      }
    } finally {
      setRefreshing(false);
    }
  }

  // status → CSS 클래스/레이블 매핑. as const로 유니온 키 타입 접근 보장.
  const spillCls = {
    active: "spill-live",
    scheduled: "spill-soon",
    ended: "spill-done",
  } as const;
  const spillLabel = {
    active: "진행",
    scheduled: "예정",
    ended: "완료",
  } as const;
  const groups = useMemo(
    () => [
      {
        label: "진행 중",
        items: meetings.filter((m) => m.status === "active"),
      },
      {
        label: "예정",
        items: meetings.filter((m) => m.status === "scheduled"),
      },
      {
        label: "완료",
        items: [...meetings]
          .filter((m) => m.status === "ended")
          .sort((a, b) => {
            const ta = a.ended_at ?? a.scheduled_at;
            const tb = b.ended_at ?? b.scheduled_at;
            return new Date(tb).getTime() - new Date(ta).getTime();
          }),
      },
    ],
    [meetings],
  );

  // 발언 경고: 비중 10% 미만 멤버 (전체)
  const lowSpeakers = speak.filter(
    (s) => s.speech_ratio != null && s.speech_ratio < 0.1,
  );
  return (
    <>
      <div className="meeting-layout" data-tour="mt-layout">
        {/* 사이드바 */}
        <div className="msidebar" data-tour="mt-sidebar">
          <div className="msb-head">
            <span>회의 목록</span>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                className="btn btn-primary btn-sm"
                style={{ background: "var(--green)", color: "#fff" }}
                onClick={() => setModalOpen("quickstart")}
                title="지금 바로 회의 시작"
              >
                <i className="ti ti-bolt" /> 바로 시작
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setModalOpen("meeting")}
                data-tour="mt-new"
              >
                <i className="ti ti-plus" />
              </button>
            </div>
          </div>
          <div className="msb-list scroll">
            {meetings.length === 0 && (
              <div
                style={{
                  padding: 14,
                  fontSize: 12.5,
                  color: "var(--text-soft)",
                }}
              >
                아직 회의가 없습니다. + 버튼으로 만들어 보세요.
              </div>
            )}
            {groups.map(
              ({ label, items }) =>
                items.length > 0 && (
                  <div key={label}>
                    <div className="msb-group">{label}</div>
                    {items.map((m) => {
                      const sum =
                        m.status === "ended" ? summaries.get(m.id) : undefined;
                      const attBadge = sum ? ATT_BADGE[sum.my_status] : null;
                      return (
                        <div
                          key={m.id}
                          className={`mcard ${m.id === selectedId ? "sel" : ""}`}
                          onClick={() => setSelectedId(m.id)}
                          style={{ cursor: "pointer" }}
                        >
                          <div className="mcard-top">
                            <div className="mcard-name">
                              {m.topic ?? "제목 없는 회의"}
                            </div>
                            {/* 완료 옆에 내 출결 표시 */}
                            {attBadge && (
                              <span
                                className="mcard-att"
                                style={{
                                  color: attBadge.color,
                                  background: attBadge.bg,
                                }}
                              >
                                {attBadge.label}
                              </span>
                            )}
                            <span className={`spill ${spillCls[m.status]}`}>
                              {spillLabel[m.status]}
                            </span>
                          </div>
                          <div className="mcard-meta">
                            {meetingMeta(
                              m,
                              team?.member_count ?? 0,
                              summaries.get(m.id)?.attended_count,
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ),
            )}
          </div>
        </div>

        {/* 상세 */}
        <div className="mdetail">
          {!selected ? (
            <div
              style={{ padding: 24, fontSize: 13.5, color: "var(--text-soft)" }}
            >
              왼쪽에서 회의를 선택하거나 새 회의를 만들어 보세요.
            </div>
          ) : (
            <>
              <div className="mdetail-head">
                <div className="mdh-top">
                  <div className="mdh-top-left">
                    <div className="mdh-title">
                      {selected.topic ?? "제목 없는 회의"}
                    </div>
                    <div className="mdh-badges">
                      <span className={`spill ${spillCls[selected.status]}`}>
                        {spillLabel[selected.status]}
                      </span>
                      <span
                        className={`mdh-type-badge mdh-type-${selected.meeting_type}`}
                      >
                        {selected.meeting_type === "regular"
                          ? "전체 회의"
                          : "부분 회의"}
                      </span>
                      {selected.status === "ended" &&
                        summaries.get(selected.id)?.attended_count != null && (
                          <span className="mdh-attended-count">
                            <i className="ti ti-user" />
                            {summaries.get(selected.id)!.attended_count}명
                          </span>
                        )}
                    </div>
                  </div>
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <button
                      className="btn btn-sm"
                      onClick={() => void refreshDetail()}
                      disabled={refreshing}
                      title="새로고침"
                    >
                      <i
                        className={`ti ${refreshing ? "ti-loader-2" : "ti-refresh"}`}
                      />
                    </button>
                    {selected.status === "scheduled" && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          setHeadsetAction("start");
                          setModalOpen("headset");
                        }}
                        disabled={busy}
                      >
                        <i className="ti ti-player-play" /> 회의 시작
                      </button>
                    )}
                    {selected.status === "active" && hasJoined === true && (
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => void endMeeting()}
                        disabled={busy}
                      >
                        <i className="ti ti-player-stop" /> 회의 종료
                      </button>
                    )}
                    {selected.status === "active" && hasJoined !== true && (
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={() => {
                          setHeadsetAction("attend");
                          setModalOpen("headset");
                        }}
                        disabled={joiningMeeting || hasJoined === null}
                      >
                        <i className="ti ti-login" />{" "}
                        {joiningMeeting ? "참가 중…" : "회의 참여"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="mdh-meta">
                  <div className="mdh-meta-dates">
                    <i className="ti ti-calendar" />
                    <span>
                      {(() => {
                        const d = new Date(selected.scheduled_at);
                        const today = new Date();
                        const day =
                          d.toDateString() === today.toDateString()
                            ? "오늘"
                            : `${d.getMonth() + 1}월 ${d.getDate()}일`;
                        const t = d.toLocaleTimeString("ko-KR", {
                          hour: "numeric",
                          minute: "2-digit",
                        });
                        return `${day} ${t} 예정`;
                      })()}
                    </span>
                    {selected.status === "ended" &&
                      selected.t0_timestamp &&
                      selected.ended_at && (
                        <>
                          <span />
                          <span>
                            {(() => {
                              const tf = (d: Date) =>
                                d.toLocaleTimeString("ko-KR", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                });
                              const s = new Date(selected.t0_timestamp!);
                              const e = new Date(selected.ended_at!);
                              const today = new Date();
                              const day =
                                s.toDateString() === today.toDateString()
                                  ? "오늘"
                                  : `${s.getMonth() + 1}월 ${s.getDate()}일`;
                              const min = Math.round(
                                (e.getTime() - s.getTime()) / 60000,
                              );
                              const dur =
                                min >= 60
                                  ? `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`
                                  : `${min}분`;
                              return `${day} ${tf(s)} ~ ${tf(e)} (${dur})`;
                            })()}
                          </span>
                        </>
                      )}
                  </div>
                  {selected.status !== "ended" && (
                    <span>
                      <i className="ti ti-users" /> {joinedCount}명
                    </span>
                  )}
                  {selected.status === "active" && (
                    <span style={{ color: "var(--coral)", fontWeight: 700 }}>
                      <i className="ti ti-clock" /> {fmt(elapsed)}
                    </span>
                  )}
                  {selected.status === "active" && (
                    <span
                      className="mdh-companion-link"
                      onClick={() => openCompanion(selected.id, team!.id)}
                    >
                      <i className="ti ti-external-link" /> 회의 창 열기
                    </span>
                  )}
                </div>
                <div className="tabs">
                  {(
                    [
                      "agenda",
                      "speak",
                      "attendance",
                      "decision",
                      "summary",
                    ] as Tab[]
                  ).map((t) => (
                    <div
                      key={t}
                      className={`tab ${tab === t ? "active" : ""}`}
                      onClick={() => setTab(t)}
                    >
                      {
                        (
                          {
                            agenda: "아젠다",
                            speak: "발언 기록",
                            attendance: "출결",
                            decision: "결정 사항",
                            summary: "회의 요약",
                          } as Record<string, string>
                        )[t]
                      }
                    </div>
                  ))}
                  <div
                    style={{
                      width: 1,
                      background: "var(--border-2)",
                      margin: "8px 6px",
                    }}
                  />
                  <div
                    className={`tab ${tab === "settings" ? "active" : ""}`}
                    onClick={() => setTab("settings")}
                  >
                    회의 설정
                  </div>
                </div>
              </div>

              <div className="tab-body scroll">
                {/* 아젠다 */}
                {tab === "agenda" && (
                  <div className="tab-panel active">
                    {prevDecisions.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <div
                          className="panel-label"
                          style={{ marginBottom: 6 }}
                        >
                          저번 회의 결정 사항
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 400,
                              color: "var(--text-soft)",
                              marginLeft: 6,
                              textTransform: "none",
                              letterSpacing: 0,
                            }}
                          >
                            {prevMeeting?.topic ?? "이전 회의"}
                          </span>
                        </div>
                        {prevDecisions.map((d) => (
                          <div key={d.id} className="dec-item">
                            <div className="dec-ic">
                              <i className="ti ti-check" />
                            </div>
                            <div className="dec-text">{d.content}</div>
                          </div>
                        ))}
                        <div
                          style={{
                            borderTop: "1px solid var(--border)",
                            margin: "12px 0 10px",
                          }}
                        />
                      </div>
                    )}
                    <div className="panel-label">아젠다 진행</div>
                    {agendas.length === 0 && (
                      <div
                        style={{
                          fontSize: 12.5,
                          color: "var(--text-soft)",
                          padding: "4px 0 8px",
                        }}
                      >
                        등록된 아젠다가 없습니다.
                      </div>
                    )}
                    {agendas.map((a, i) => {
                      const cur = a.status === "active";
                      const done = a.status === "done";
                      return (
                        <div
                          key={a.id}
                          className={`ag-item ${cur ? "cur" : ""}`}
                        >
                          <div className="ag-num">
                            {cur ? (
                              <i
                                className="ti ti-player-play-filled"
                                style={{ fontSize: 9 }}
                              />
                            ) : done ? (
                              <i
                                className="ti ti-check"
                                style={{ fontSize: 10 }}
                              />
                            ) : (
                              i + 1
                            )}
                          </div>
                          <div className="ag-text">{a.title}</div>
                          <div className="ag-prog">
                            <i
                              style={{
                                width: done ? "100%" : cur ? "60%" : "0%",
                              }}
                            />
                          </div>
                          <div className="ag-time">{fmtAgTime(a)}</div>
                        </div>
                      );
                    })}
                    {selected.status !== "ended" && (
                      <button
                        className="add-col"
                        style={{ marginTop: 4 }}
                        onClick={() => setModalOpen("agenda")}
                      >
                        <i className="ti ti-plus" /> 아젠다 추가
                      </button>
                    )}
                  </div>
                )}

                {/* 발언 기록 */}
                {tab === "speak" && (
                  <div className="tab-panel active">
                    <div
                      className="panel-label"
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      발언 분포{" "}
                      {selected.status === "active" && (
                        <span
                          className="live-dot"
                          style={{ background: "var(--green)" }}
                        />
                      )}
                      <span
                        style={{
                          marginLeft: "auto",
                          textTransform: "none",
                          letterSpacing: 0,
                          color: "var(--text-soft)",
                          fontWeight: 500,
                        }}
                      >
                        글자 수 기준
                      </span>
                    </div>
                    {speak.length === 0 && (
                      <div className="summary-box">
                        <i className="ti ti-info-circle" />
                        {selected.status === "ended"
                          ? "산정된 발언 기록이 없습니다."
                          : "발언 분포는 회의가 종료되면 집계됩니다. 진행 중에는 회의 보조 창에서 실시간으로 확인할 수 있어요."}
                      </div>
                    )}
                    {speak.map((s, i) => {
                      const pct =
                        s.speech_ratio == null
                          ? 0
                          : Math.round(s.speech_ratio * 100);
                      const warn =
                        s.speech_ratio != null && s.speech_ratio < 0.1;
                      return (
                        <div key={s.user_id} className="speak-row">
                          <div
                            className="av av-sm"
                            style={{
                              background: avatarBg(memberIdx(s.user_id)),
                            }}
                          >
                            {(nicknameMap.get(s.user_id) ?? s.name)[0]}
                          </div>
                          <span className="speak-name">
                            {nicknameMap.get(s.user_id) ?? s.name}
                          </span>
                          <span className="speak-bar">
                            <i
                              data-w={pct}
                              style={{
                                background: warn
                                  ? "var(--coral)"
                                  : memberColor(memberIdx(s.user_id)),
                              }}
                            />
                          </span>
                          <span
                            className="speak-pct"
                            style={warn ? { color: "var(--coral)" } : undefined}
                          >
                            {s.speech_ratio == null ? "—" : `${pct}%`}
                          </span>
                        </div>
                      );
                    })}
                    {lowSpeakers.length > 0 && (
                      <div
                        className="summary-box"
                        style={{
                          marginTop: 14,
                          background: "var(--coral-soft)",
                          borderColor: "rgba(240,102,79,.4)",
                        }}
                      >
                        <i
                          className="ti ti-alert-triangle"
                          style={{ color: "var(--coral)" }}
                        />
                        {lowSpeakers
                          .map((s) => nicknameMap.get(s.user_id) ?? s.name)
                          .join(", ")}
                        님의 발언 비중이 10% 미만입니다. 의견을 물어봐 주세요.
                      </div>
                    )}
                    {/* 발화 기록 — 종료된 회의만 */}
                    {selected.status === "ended" && (
                      <>
                        <div className="panel-label" style={{ marginTop: 18 }}>
                          발화 기록
                        </div>
                        {!transcript ? (
                          <div
                            style={{
                              fontSize: 12.5,
                              color: "var(--text-soft)",
                            }}
                          >
                            불러오는 중…
                          </div>
                        ) : transcript.sections.every(
                            (s) => s.groups.length === 0,
                          ) ? (
                          <div className="summary-box">
                            <i className="ti ti-info-circle" />
                            저장된 발화 기록이 없습니다.
                          </div>
                        ) : (
                          (() => {
                            const flat = transcript.sections
                              .filter((s) => s.groups.length > 0)
                              .flatMap((s) =>
                                s.groups.map((g) => ({
                                  ...g,
                                  sectionId: s.agenda_id,
                                  sectionTitle: s.title,
                                })),
                              )
                              .sort(
                                (a, b) =>
                                  a.started_at_offset_ms -
                                  b.started_at_offset_ms,
                              );
                            return flat.map((g, i) => {
                              const showHeader =
                                i === 0 ||
                                g.sectionId !== flat[i - 1].sectionId;
                              const speaker = speak.find(
                                (s) => s.user_id === g.user_id,
                              );
                              return (
                                <div key={i}>
                                  {showHeader && (
                                    <div className="utt-section-title">
                                      {g.sectionTitle}
                                    </div>
                                  )}
                                  <div className="utt-row">
                                    <div
                                      className="av av-sm"
                                      style={{
                                        background: avatarBg(
                                          memberIdx(g.user_id),
                                        ),
                                      }}
                                    >
                                      {
                                        (speaker
                                          ? (nicknameMap.get(speaker.user_id) ??
                                            speaker.name)
                                          : (nicknameMap.get(g.user_id) ??
                                            "?"))[0]
                                      }
                                    </div>
                                    <div className="utt-body">
                                      <span className="utt-name">
                                        {speaker
                                          ? (nicknameMap.get(speaker.user_id) ??
                                            speaker.name)
                                          : (nicknameMap.get(g.user_id) ??
                                            `사용자 ${g.user_id}`)}
                                        <span className="utt-time">
                                          {selected.t0_timestamp
                                            ? (() => {
                                                const t0 = new Date(
                                                  selected.t0_timestamp,
                                                ).getTime();
                                                const tf = (offset: number) =>
                                                  new Date(
                                                    t0 + offset,
                                                  ).toLocaleTimeString(
                                                    "ko-KR",
                                                    {
                                                      hour: "2-digit",
                                                      minute: "2-digit",
                                                      second: "2-digit",
                                                    },
                                                  );
                                                return `${tf(g.started_at_offset_ms)} ~ ${tf(g.ended_at_offset_ms)}`;
                                              })()
                                            : `${fmt(Math.floor(g.started_at_offset_ms / 1000))} ~ ${fmt(Math.floor(g.ended_at_offset_ms / 1000))}`}
                                        </span>
                                      </span>
                                      <span className="utt-text">{g.text}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            });
                          })()
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 출결 */}
                {tab === "attendance" && (
                  <div className="tab-panel active">
                    <div className="panel-label">
                      출결 현황
                      <span
                        className="info-tip"
                        data-tip={`회의 시작 후 ${teamSettings?.late_threshold_minutes ?? 5}분 이내 입장 → 출석\n${teamSettings?.late_threshold_minutes ?? 5}분 초과 입장 → 지각\n입장 기록 없음 → 결석`}
                      >
                        <i className="ti ti-info-circle" />
                      </span>
                    </div>
                    {selected.status !== "ended" ? (
                      <div className="summary-box">
                        <i className="ti ti-info-circle" />
                        출결은 회의가 종료된 후 확인할 수 있어요.
                      </div>
                    ) : !attendance ? (
                      <div
                        style={{ fontSize: 12.5, color: "var(--text-soft)" }}
                      >
                        불러오는 중…
                      </div>
                    ) : (
                      <>
                        {attendance.members.map((mem) => {
                          const badge = ATT_BADGE[mem.status];
                          const isMe = me?.id === mem.user_id;
                          const showSub =
                            mem.status === "absent" ||
                            mem.status === "excused" ||
                            mem.status === "late";
                          return (
                            <div key={mem.user_id} className="att-item">
                              {/* 메인 행: 아바타 · 이름 · 배지 */}
                              <div className="att-row">
                                <div
                                  className="av av-sm"
                                  style={{
                                    background: avatarBg(
                                      memberIdx(mem.user_id),
                                    ),
                                  }}
                                >
                                  {
                                    (nicknameMap.get(mem.user_id) ??
                                      mem.name)[0]
                                  }
                                </div>
                                <span className="att-name">
                                  {nicknameMap.get(mem.user_id) ?? mem.name}
                                </span>
                                <span
                                  className="att-badge"
                                  style={{
                                    color: badge.color,
                                    background: badge.bg,
                                  }}
                                >
                                  {badge.label}
                                  {mem.status === "late" &&
                                    mem.late_minutes != null &&
                                    ` +${mem.late_minutes}분 후 입장`}
                                </span>
                              </div>
                              {/* 서브 행: 사유 + 액션 (결석·지각·출석인정) */}
                              {showSub && (
                                <div className="att-sub">
                                  <span
                                    className={`att-sub-reason${!mem.absence ? " att-sub-empty" : ""}`}
                                  >
                                    {mem.absence
                                      ? mem.absence.reason
                                      : isMe
                                        ? "사유를 입력해주세요"
                                        : "사유 미입력"}
                                  </span>
                                  <div className="att-sub-actions">
                                    {/* 본인 + 사유 없음 */}
                                    {isMe && !mem.absence && (
                                      <button
                                        className="btn btn-primary btn-sm"
                                        onClick={() => {
                                          setAbsenceInput("");
                                          setModalOpen("absence");
                                        }}
                                      >
                                        사유 입력
                                      </button>
                                    )}
                                    {/* 본인 + pending: 동의 수 */}
                                    {isMe &&
                                      mem.absence?.status === "pending" && (
                                        <span className="att-consent-count">
                                          동의 {mem.absence.consent_count}/
                                          {attendance.consent_required}
                                        </span>
                                      )}
                                    {/* 타인 + pending: 동의/동의함 */}
                                    {!isMe &&
                                      mem.absence?.status === "pending" && (
                                        <button
                                          className={`btn btn-sm${mem.absence.my_consent ? " btn-consented" : ""}`}
                                          disabled={busy}
                                          onClick={() =>
                                            mem.absence!.my_consent
                                              ? void cancelConsent(
                                                  mem.absence!.id,
                                                )
                                              : void consentAbsence(
                                                  mem.absence!.id,
                                                )
                                          }
                                        >
                                          {mem.absence.my_consent
                                            ? `동의함 ${mem.absence.consent_count}/${attendance.consent_required}`
                                            : `동의 ${mem.absence.consent_count}/${attendance.consent_required}`}
                                        </button>
                                      )}
                                    {/* 인정됨 */}
                                    {mem.absence?.status === "approved" && (
                                      <span className="att-reason-ok">
                                        <i className="ti ti-check" /> 인정됨
                                      </span>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}

                {/* 결정 사항 */}
                {tab === "decision" && (
                  <div
                    className="tab-panel active"
                    style={{ overflow: "hidden" }}
                  >
                    <div
                      className="panel-label"
                      style={{ display: "flex", alignItems: "center" }}
                    >
                      결정 사항
                      <button
                        className="btn btn-primary btn-sm"
                        style={{ marginLeft: "auto" }}
                        onClick={() => {
                          setEditingDecision(null);
                          setDecInput("");
                          setModalOpen("decision");
                        }}
                      >
                        <i className="ti ti-plus" /> 추가
                      </button>
                    </div>
                    <div className="dec-list scroll">
                      {decisions.length === 0 && (
                        <div
                          style={{ fontSize: 12.5, color: "var(--text-soft)" }}
                        >
                          아직 기록된 결정이 없습니다.
                        </div>
                      )}
                      {decisions.map((d) => (
                        <div key={d.id} className="dec-item">
                          <div className="dec-ic">
                            <i className="ti ti-check" />
                          </div>
                          <div className="dec-text">{d.content}</div>
                          <div className="dec-actions">
                            <button
                              className="dec-act"
                              aria-label="결정 수정"
                              onClick={() => {
                                setEditingDecision(d);
                                setDecInput(d.content);
                                setModalOpen("decision");
                              }}
                            >
                              <i className="ti ti-pencil" />
                            </button>
                            <button
                              className="dec-act dec-act--danger"
                              aria-label="결정 삭제"
                              onClick={() => setDeletingDecision(d)}
                            >
                              <i className="ti ti-trash" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 회의 요약 */}
                {tab === "summary" && (
                  <div className="tab-panel active">
                    {selected.status !== "ended" ? (
                      <div className="summary-box">
                        <i className="ti ti-sparkles" />
                        회의가 종료되면 AI가 자동으로 결정 사항·태스크·회의록을
                        요약합니다.
                      </div>
                    ) : (
                      <>
                        {pendingTasks.length > 0 && (
                          <div className="summary-section summary-section--tasks">
                            <div className="summary-header">
                              <div className="summary-title summary-title--amber">
                                <i className="ti ti-list-check" />
                                AI 제안 태스크
                                <span className="badge badge-amber">
                                  {pendingTasks.length}개 검토 대기
                                </span>
                              </div>
                            </div>
                            <div className="summary-tasks">
                              {pendingTasks.map((task) => (
                                <div
                                  key={task.id}
                                  className="summary-task-item"
                                >
                                  <i className="ti ti-sparkles" />
                                  <span className="summary-task-desc">
                                    {task.description}
                                  </span>
                                  <button
                                    className="btn btn-sm btn-primary"
                                    onClick={() => {
                                      setConfirmTask(task);
                                      setConfirmDesc(task.description);
                                      setConfirmAssignee("");
                                      setConfirmDue(todayStr());
                                      setConfirmTime(nowTimeStr());
                                      setConfirmStatus("할 일");
                                      setConfirmDifficulty(2);
                                    }}
                                  >
                                    확정
                                  </button>
                                  <button
                                    className="btn btn-sm"
                                    onClick={async () => {
                                      setPendingTasks((prev) =>
                                        prev.filter((t) => t.id !== task.id),
                                      );
                                      try {
                                        await apiDelete(
                                          `/action-items/${task.id}`,
                                        );
                                      } catch (e) {
                                        setPendingTasks((prev) => [
                                          ...prev,
                                          task,
                                        ]);
                                        showToast(
                                          (e as Error).message,
                                          "error",
                                        );
                                      }
                                    }}
                                  >
                                    제거
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="summary-section">
                          <div className="summary-header">
                            <div className="summary-title">
                              <i className="ti ti-sparkles" />
                              AI 회의록
                            </div>
                            <button
                              className="btn btn-sm"
                              disabled={busy}
                              onClick={async () => {
                                setBusy(true);
                                try {
                                  const res = await apiPost<{
                                    summarized: boolean;
                                    reason?: string;
                                  }>(`/meetings/${selectedId}/summarize`);
                                  if (!res.summarized) {
                                    showToast(
                                      res.reason === "llm_not_configured"
                                        ? "API 키가 설정되지 않았습니다."
                                        : "요약에 실패했어요. 다시 시도해 주세요.",
                                      "error",
                                    );
                                  } else {
                                    await loadMeetings();
                                    await loadPendingTasks();
                                    showToast("회의가 요약됐습니다.");
                                  }
                                } catch (e) {
                                  showToast((e as Error).message, "error");
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              <i
                                className={`ti ${busy ? "ti-loader-2" : "ti-refresh"}`}
                              />
                              {busy
                                ? "요약 중…"
                                : selected.summary
                                  ? "다시 요약"
                                  : "요약 생성"}
                            </button>
                          </div>
                          {selected.one_liner && (
                            <div className="summary-one-liner">
                              {selected.one_liner}
                            </div>
                          )}
                          {selected.summary ? (
                            <div className="summary-md">
                              <ReactMarkdown>{selected.summary}</ReactMarkdown>
                            </div>
                          ) : (
                            <div className="summary-empty">
                              <i className="ti ti-file-description" />
                              <span>
                                발화 기록과 결정 사항을 바탕으로 AI가 회의록을
                                작성합니다.
                              </span>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* 회의 설정 */}
                {tab === "settings" && (
                  <div className="tab-panel active">
                    <div className="panel-label">회의 정보 수정</div>
                    <div className="field">
                      <label className="field-label">회의 이름</label>
                      <input
                        className="input"
                        placeholder="예) 중간 점검 회의"
                        value={editTopic}
                        onChange={(e) => setEditTopic(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <label className="field-label">회의 유형</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className={`btn btn-sm${editMeetingType === "regular" ? " btn-primary" : ""}`}
                          disabled={selected.status === "ended"}
                          onClick={() => setEditMeetingType("regular")}
                        >
                          전체 회의
                        </button>
                        <button
                          type="button"
                          className={`btn btn-sm${editMeetingType === "partial" ? " btn-primary" : ""}`}
                          disabled={selected.status === "ended"}
                          onClick={() => setEditMeetingType("partial")}
                        >
                          부분 회의
                        </button>
                      </div>
                    </div>
                    <div className="field-row">
                      <div className="field">
                        <label className="field-label">날짜</label>
                        <input
                          className="input"
                          type="date"
                          min={todayStr()}
                          value={editDate}
                          disabled={selected.status !== "scheduled"}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="field-label">시간</label>
                        <input
                          className="input"
                          type="time"
                          min={timeMinForDate(editDate)}
                          value={editTime}
                          disabled={selected.status !== "scheduled"}
                          onChange={(e) => setEditTime(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="field">
                      <label className="field-label">예상 소요 시간 (분)</label>
                      <input
                        className="input"
                        type="number"
                        min={5}
                        step={5}
                        value={editMinutes}
                        disabled={selected.status !== "scheduled"}
                        onChange={(e) =>
                          setEditMinutes(
                            e.target.value === "" ? "" : Number(e.target.value),
                          )
                        }
                      />
                    </div>
                    {selected.status === "active" && (
                      <div className="summary-box" style={{ marginBottom: 8 }}>
                        <i className="ti ti-info-circle" />
                        진행 중인 회의는 이름과 회의 유형만 수정할 수 있습니다.
                      </div>
                    )}
                    {selected.status === "ended" && (
                      <div className="summary-box" style={{ marginBottom: 8 }}>
                        <i className="ti ti-info-circle" />
                        완료된 회의는 이름만 수정할 수 있습니다.
                      </div>
                    )}
                    <button
                      className="btn btn-primary"
                      style={{ marginTop: 8 }}
                      onClick={() => void saveMeetingSettings()}
                      disabled={editSaving}
                    >
                      {editSaving ? "저장 중…" : "저장"}
                    </button>
                    <div
                      style={{
                        marginTop: 32,
                        borderTop: "1px solid var(--border-2)",
                        paddingTop: 16,
                      }}
                    >
                      <div
                        className="panel-label"
                        style={{ color: "var(--coral)" }}
                      >
                        위험 구역
                      </div>
                      <button
                        className="btn btn-danger btn-sm"
                        onClick={() => setDeletingMeeting(true)}
                      >
                        <i className="ti ti-trash" /> 회의 삭제
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 회의 입장 전 헤드셋 권장 안내 — 보조 창을 열기 전에 띄우고, 확인 시 시작 진행 */}
      {modalOpen === "headset" && (
        <HeadsetGateModal
          onClose={() => setModalOpen(null)}
          onConfirm={() => {
            setModalOpen(null);
            if (headsetAction === "start") {
              void startMeeting();
            } else if (headsetAction === "quickstart") {
              void startMeetingNow();
            } else {
              void attendMeeting();
            }
          }}
        />
      )}

      {/* 새 회의 모달 */}
      {modalOpen === "meeting" && (
        <Modal
          title="새 회의 만들기"
          onClose={closeMeetingModal}
          actions={
            <>
              <button className="btn" onClick={closeMeetingModal}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void createMeeting()}
                disabled={busy}
              >
                {busy ? "생성 중…" : "회의 생성"}
              </button>
            </>
          }
        >
          <div className="modal-sub">
            아젠다를 미리 작성하면 회의 효율이 올라갑니다.
          </div>
          <div className="field">
            <label className="field-label">회의 이름</label>
            <input
              className="input"
              placeholder="예) 중간 점검 회의"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">회의 유형</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`btn btn-sm${newMeetingType === "regular" ? " btn-primary" : ""}`}
                onClick={() => setNewMeetingType("regular")}
              >
                전체 회의
              </button>
              <button
                type="button"
                className={`btn btn-sm${newMeetingType === "partial" ? " btn-primary" : ""}`}
                onClick={() => setNewMeetingType("partial")}
              >
                부분 회의
              </button>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">날짜</label>
              <input
                className="input"
                type="date"
                min={todayStr()}
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label">시간</label>
              <input
                className="input"
                type="time"
                min={timeMinForDate(newDate)}
                value={newTime}
                onChange={(e) => setNewTime(e.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <label className="field-label">예상 소요 시간 (분)</label>
            <input
              className="input"
              type="number"
              min={5}
              step={5}
              value={newMinutes}
              onChange={(e) =>
                setNewMinutes(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            />
          </div>
          <div className="field">
            <label className="field-label">
              아젠다 <span className="opt">(선택)</span>
            </label>
            {newAgendaList.length > 0 && (
              <div className="agenda-chips">
                {newAgendaList.map((ag, i) => (
                  <div className="agenda-chip" key={i}>
                    <span className="agenda-chip-title">{ag.title}</span>
                    {ag.minutes !== "" && (
                      <span className="agenda-chip-min">{ag.minutes}분</span>
                    )}
                    <button
                      type="button"
                      className="agenda-chip-x"
                      onClick={() => removeAgendaFromList(i)}
                      aria-label="아젠다 삭제"
                    >
                      <i className="ti ti-x" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="agenda-add">
              <input
                className="input"
                placeholder="아젠다 제목"
                value={newAgendaInput}
                onChange={(e) => setNewAgendaInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addAgendaToList();
                  }
                }}
              />
              <input
                className="input agenda-add-min"
                type="number"
                min={0}
                placeholder="분"
                value={newAgendaMinutes}
                onChange={(e) =>
                  setNewAgendaMinutes(
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn btn-sm agenda-add-btn"
              onClick={addAgendaToList}
            >
              <i className="ti ti-plus" /> 추가
            </button>
          </div>
        </Modal>
      )}

      {/* 지금 바로 시작 모달 — 날짜/시간 없이 즉시 생성 후 시작 */}
      {modalOpen === "quickstart" && (
        <Modal
          title="지금 바로 시작"
          onClose={closeQuickstartModal}
          actions={
            <>
              <button className="btn" onClick={closeQuickstartModal}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (!quickMinutes) {
                    showToast("예상 소요 시간을 입력해 주세요", "error");
                    return;
                  }
                  setHeadsetAction("quickstart");
                  setModalOpen("headset");
                }}
                disabled={quickStarting}
              >
                {quickStarting ? "시작 중…" : "시작하기"}
              </button>
            </>
          }
        >
          <div className="modal-sub">
            지금 시각으로 회의를 만들고 곧바로 시작합니다.
          </div>
          <div className="field">
            <label className="field-label">회의 이름</label>
            <input
              className="input"
              placeholder="예) 중간 점검 회의"
              maxLength={200}
              value={quickTopic}
              onChange={(e) => setQuickTopic(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">회의 유형</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={`btn btn-sm${quickMeetingType === "regular" ? " btn-primary" : ""}`}
                onClick={() => setQuickMeetingType("regular")}
              >
                전체 회의
              </button>
              <button
                type="button"
                className={`btn btn-sm${quickMeetingType === "partial" ? " btn-primary" : ""}`}
                onClick={() => setQuickMeetingType("partial")}
              >
                부분 회의
              </button>
            </div>
          </div>
          <div className="field">
            <label className="field-label">예상 소요 시간 (분)</label>
            <input
              className="input"
              type="number"
              min={5}
              step={5}
              value={quickMinutes}
              onChange={(e) =>
                setQuickMinutes(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            />
          </div>
          <div className="field">
            <label className="field-label">
              아젠다 <span className="opt">(선택)</span>
            </label>
            {quickAgendaList.length > 0 && (
              <div className="agenda-chips">
                {quickAgendaList.map((ag, i) => (
                  <div className="agenda-chip" key={i}>
                    <span className="agenda-chip-title">{ag.title}</span>
                    {ag.minutes !== "" && (
                      <span className="agenda-chip-min">{ag.minutes}분</span>
                    )}
                    <button
                      type="button"
                      className="agenda-chip-x"
                      onClick={() => removeQuickAgendaFromList(i)}
                      aria-label="아젠다 삭제"
                    >
                      <i className="ti ti-x" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="agenda-add">
              <input
                className="input"
                placeholder="아젠다 제목"
                maxLength={200}
                value={quickAgendaInput}
                onChange={(e) => setQuickAgendaInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    addQuickAgendaToList();
                  }
                }}
              />
              <input
                className="input agenda-add-min"
                type="number"
                min={0}
                placeholder="분"
                value={quickAgendaMinutes}
                onChange={(e) =>
                  setQuickAgendaMinutes(
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
                }
              />
            </div>
            <button
              type="button"
              className="btn btn-sm agenda-add-btn"
              onClick={addQuickAgendaToList}
            >
              <i className="ti ti-plus" /> 추가
            </button>
          </div>
        </Modal>
      )}

      {/* 결정 사항 모달 (추가/수정 겸용) */}
      {modalOpen === "decision" && (
        <Modal
          title={editingDecision ? "결정 사항 수정" : "결정 사항 추가"}
          onClose={() => {
            setModalOpen(null);
            setEditingDecision(null);
          }}
          actions={
            <>
              <button
                className="btn"
                onClick={() => {
                  setModalOpen(null);
                  setEditingDecision(null);
                }}
              >
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void saveDecision()}
                disabled={busy}
              >
                {editingDecision ? "저장" : "추가"}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">결정 내용</label>
            <textarea
              className="input"
              rows={3}
              placeholder="회의에서 결정된 내용을 입력하세요"
              value={decInput}
              onChange={(e) => setDecInput(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void saveDecision();
                }
              }}
              autoFocus
            />
          </div>
        </Modal>
      )}

      {/* 결석 사유 입력 모달 */}
      {modalOpen === "absence" && (
        <Modal
          title="결석 사유 입력"
          onClose={() => {
            setModalOpen(null);
            setAbsenceInput("");
          }}
          actions={
            <>
              <button
                className="btn"
                onClick={() => {
                  setModalOpen(null);
                  setAbsenceInput("");
                }}
              >
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void saveAbsence()}
                disabled={busy}
              >
                제출
              </button>
            </>
          }
        >
          <>
            <div className="modal-sub">
              팀원 과반이 동의하면 출석으로 인정됩니다.
            </div>
            <div className="field">
              <label className="field-label">사유</label>
              <textarea
                className="input"
                rows={3}
                placeholder="예) 가족 행사로 참석하지 못했습니다."
                value={absenceInput}
                onChange={(e) => setAbsenceInput(e.target.value)}
                autoFocus
              />
            </div>
          </>
        </Modal>
      )}

      {/* 결정 삭제 확인 모달 */}
      {deletingDecision && (
        <ConfirmModal
          title="결정 사항 삭제"
          message={
            <>
              “{deletingDecision.content}”
              <br />이 결정을 삭제할까요? 되돌릴 수 없습니다.
            </>
          }
          confirmLabel="삭제"
          danger
          busy={busy}
          onConfirm={() => void deleteDecision()}
          onClose={() => setDeletingDecision(null)}
        />
      )}

      {/* 회의 삭제 확인 모달 */}
      {deletingMeeting && (
        <Modal
          title="회의 삭제"
          onClose={() => {
            setDeletingMeeting(false);
            setDeleteConfirmInput("");
          }}
          actions={
            <>
              <button
                className="btn"
                onClick={() => {
                  setDeletingMeeting(false);
                  setDeleteConfirmInput("");
                }}
              >
                취소
              </button>
              <button
                className="btn btn-danger"
                disabled={deleteConfirmInput !== "삭제하겠습니다" || busy}
                onClick={() => void handleDeleteMeeting()}
              >
                삭제
              </button>
            </>
          }
        >
          <div className="modal-sub">
            회의와 관련된 모든 데이터(발화·결정·아젠다)가 영구 삭제됩니다.
          </div>
          <div className="field">
            <label className="field-label">
              확인을 위해 <strong>삭제하겠습니다</strong>를 입력하세요
            </label>
            <input
              className="input"
              placeholder="삭제하겠습니다"
              value={deleteConfirmInput}
              onChange={(e) => setDeleteConfirmInput(e.target.value)}
            />
          </div>
        </Modal>
      )}

      {/* AI 태스크 확정 모달 */}
      {confirmTask && (
        <Modal
          title="태스크 확정"
          onClose={() => setConfirmTask(null)}
          actions={
            <>
              <button className="btn" onClick={() => setConfirmTask(null)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void saveConfirmTask()}
                disabled={confirmSaving}
              >
                {confirmSaving ? "확정 중…" : "확정"}
              </button>
            </>
          }
        >
          <div className="modal-sub">
            AI가 제안한 태스크를 검토하고 확정하세요.
          </div>
          <div className="field">
            <label className="field-label">태스크 이름</label>
            <input
              className="input"
              value={confirmDesc}
              onChange={(e) => setConfirmDesc(e.target.value)}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label className="field-label">담당자</label>
              <MemberSelect
                members={members}
                nicknameMap={nicknameMap}
                value={confirmAssignee}
                onChange={setConfirmAssignee}
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
                  value={confirmDue}
                  onChange={(e) => setConfirmDue(e.target.value)}
                />
                <input
                  className="input"
                  type="time"
                  style={{ flex: 1 }}
                  placeholder="23:59"
                  min={timeMinForDate(confirmDue)}
                  value={confirmTime}
                  onChange={(e) => setConfirmTime(e.target.value)}
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
                  className={`chip-opt ${STATUS_CHIP_CLS[s]} ${confirmStatus === s ? "active" : ""}`}
                  onClick={() => setConfirmStatus(s)}
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
                  className={`chip-opt chip-diff ${confirmDifficulty === c.value ? "active" : ""}`}
                  onClick={() => setConfirmDifficulty(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* 아젠다 모달 */}
      {modalOpen === "agenda" && (
        <Modal
          title="아젠다 추가"
          onClose={() => setModalOpen(null)}
          actions={
            <>
              <button className="btn" onClick={() => setModalOpen(null)}>
                취소
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void addAgenda()}
                disabled={busy}
              >
                추가
              </button>
            </>
          }
        >
          <div className="field">
            <label className="field-label">아젠다 내용</label>
            <input
              className="input"
              placeholder="예) 최종 발표 순서 확정"
              value={agTitle}
              onChange={(e) => setAgTitle(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label className="field-label">소요 시간 (분)</label>
            <input
              className="input"
              type="number"
              min={1}
              value={agMinutes}
              onChange={(e) =>
                setAgMinutes(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            />
          </div>
        </Modal>
      )}
    </>
  );
}
