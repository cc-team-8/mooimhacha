import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import { apiGet, apiPost, apiPatch, apiDelete } from "@/lib/api";
import { openCompanion } from "@/lib/companion";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type {
  Agenda,
  Decision,
  Meeting,
  MeetingContribution,
  MeetingAttendance,
  AttendanceSummary,
  AttendanceStatus,
  Transcript,
  TeamSettings,
} from "@/lib/types";
import type { TeamContext } from "../DashboardPage";

type Tab = "agenda" | "speak" | "attendance" | "decision" | "summary";

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

const AV_GRADS = ["var(--av1)", "var(--av2)", "var(--av3)", "var(--av4)"];

function meetingMeta(m: Meeting, memberCount: number): string {
  const d = new Date(m.scheduled_at);
  const today = new Date();
  const day =
    d.toDateString() === today.toDateString()
      ? "오늘"
      : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  const time = d.toLocaleTimeString("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
  });
  if (m.status === "ended" && m.t0_timestamp && m.ended_at) {
    const mins = Math.max(
      1,
      Math.round(
        (new Date(m.ended_at).getTime() - new Date(m.t0_timestamp).getTime()) /
          60000,
      ),
    );
    return `${day} · ${mins}분`;
  }
  return `${day} ${time} · ${memberCount}명`;
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
    "meeting" | "decision" | "agenda" | "absence" | null
  >(null);
  // 결정 수정/삭제 대상 — 수정은 결정 모달을 재사용, 삭제는 확인 모달을 띄운다.
  const [editingDecision, setEditingDecision] = useState<Decision | null>(null);
  const [deletingDecision, setDeletingDecision] = useState<Decision | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  // 발언 탭 최초 진입 시 바 애니메이션을 한 번만 실행하기 위한 플래그.
  // state 대신 ref를 쓰는 이유: 값 변경이 리렌더를 유발할 필요 없음.
  const barsAnimated = useRef(false);

  // 새 회의 모달 입력값
  const [newTopic, setNewTopic] = useState("");
  const [newMeetingType, setNewMeetingType] = useState<"regular" | "partial">(
    "regular",
  );
  const [newDate, setNewDate] = useState("");
  const [newTime, setNewTime] = useState("15:00");
  // 입력 중 빈 값을 허용하기 위해 ""도 담는다 — 제출 시 기본값으로 보정
  const [newMinutes, setNewMinutes] = useState<number | "">(30);
  // 아젠다를 한 항목씩 추가 — 예상 시간(minutes)은 선택
  const [newAgendaList, setNewAgendaList] = useState<
    { title: string; minutes: number | "" }[]
  >([]);
  const [newAgendaInput, setNewAgendaInput] = useState("");
  const [newAgendaMinutes, setNewAgendaMinutes] = useState<number | "">("");

  // 아젠다 모달 입력값
  const [agTitle, setAgTitle] = useState("");
  const [agMinutes, setAgMinutes] = useState<number | "">(10);

  const selected = meetings.find((m) => m.id === selectedId) ?? null;

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
    barsAnimated.current = false;
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
        void apiGet<TeamSettings>(`/teams/${team.id}/settings`).then(setTeamSettings).catch(() => null);
      }
    }
  }, [tab, selectedId, selected?.status, loadAttendance]);

  useEffect(() => {
    if (tab === "speak" && selected?.status === "ended" && selectedId && !transcript) {
      void apiGet<Transcript>(`/meetings/${selectedId}/transcript`).then(setTranscript).catch(() => null);
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
    if (tab === "speak" && !barsAnimated.current) {
      barsAnimated.current = true;
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
      await Promise.all([loadAttendance(selectedId), loadSummaries()]);
      showToast("결석 사유가 등록되었습니다. 팀원 동의를 기다려 주세요");
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

  async function createMeeting() {
    if (!team || busy) return;
    if (!newDate) {
      showToast("날짜를 선택해 주세요", "error");
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
      setNewDate("");
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
          .sort(
            (a, b) =>
              new Date(b.scheduled_at).getTime() -
              new Date(a.scheduled_at).getTime(),
          ),
      },
    ],
    [meetings],
  );

  // 발언 경고: 비중 10% 미만 멤버
  const lowSpeaker = speak.find(
    (s) => s.speech_ratio != null && s.speech_ratio < 0.1,
  );
  const headMeta = selected
    ? meetingMeta(selected, team?.member_count ?? 0)
    : "";

  return (
    <>
      <div className="meeting-layout">
        {/* 사이드바 */}
        <div className="msidebar">
          <div className="msb-head">
            <span>회의 목록</span>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setModalOpen("meeting")}
            >
              <i className="ti ti-plus" />
            </button>
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
                            {meetingMeta(m, team?.member_count ?? 0)}
                          </div>
                          {sum && sum.pending_count > 0 && (
                            <div className="mcard-att-row">
                              <span className="mcard-pending">
                                <i className="ti ti-alert-circle" /> 미처리{" "}
                                {sum.pending_count}건
                              </span>
                            </div>
                          )}
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
                  <div className="mdh-title">
                    {selected.topic ?? "제목 없는 회의"}
                  </div>
                  {selected.status === "scheduled" && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => void startMeeting()}
                      disabled={busy}
                    >
                      <i className="ti ti-player-play" /> 회의 시작
                    </button>
                  )}
                  {selected.status === "active" && (
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => void endMeeting()}
                      disabled={busy}
                    >
                      <i className="ti ti-player-stop" /> 회의 종료
                    </button>
                  )}
                </div>
                <div className="mdh-meta">
                  <span>
                    <i className="ti ti-calendar" /> {headMeta}
                  </span>
                  <span>
                    <i className="ti ti-users" /> {team?.member_count ?? "-"}명
                  </span>
                  {selected.status === "active" && (
                    <span style={{ color: "var(--coral)", fontWeight: 700 }}>
                      <i className="ti ti-clock" /> {fmt(elapsed)}
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
                        {
                          agenda: "아젠다",
                          speak: "발언 기록",
                          attendance: "출결",
                          decision: "결정 사항",
                          summary: "회의 요약",
                        }[t]
                      }
                    </div>
                  ))}
                </div>
              </div>

              <div className="tab-body scroll">
                {/* 아젠다 */}
                {tab === "agenda" && (
                  <div className="tab-panel active">
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
                          <div className={`av a${(i % 4) + 1} av-sm`}>
                            {s.name[0]}
                          </div>
                          <span className="speak-name">{s.name}</span>
                          <span className="speak-bar">
                            <i
                              data-w={pct}
                              style={{
                                background: warn
                                  ? "var(--coral)"
                                  : AV_GRADS[i % AV_GRADS.length],
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
                    {lowSpeaker && (
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
                        {lowSpeaker.name}님의 발언 비중이 10% 미만입니다. 의견을
                        물어봐 주세요.
                      </div>
                    )}
                    {/* 발화 기록 — 종료된 회의만 */}
                    {selected.status === "ended" && (
                      <>
                        <div className="panel-label" style={{ marginTop: 18 }}>발화 기록</div>
                        {!transcript ? (
                          <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>불러오는 중…</div>
                        ) : transcript.sections.every((s) => s.groups.length === 0) ? (
                          <div className="summary-box"><i className="ti ti-info-circle" />저장된 발화 기록이 없습니다.</div>
                        ) : (
                          transcript.sections.filter((s) => s.groups.length > 0).map((section) => (
                            <div key={section.agenda_id} className="utt-section">
                              <div className="utt-section-title">{section.title}</div>
                              {section.groups.map((g, gi) => {
                                const speaker = speak.find((s) => s.user_id === g.user_id);
                                const idx = speak.findIndex((s) => s.user_id === g.user_id);
                                return (
                                  <div key={gi} className="utt-row">
                                    <div className={`av a${(idx % 4) + 1} av-sm`}>{(speaker?.name ?? "?")[0]}</div>
                                    <div className="utt-body">
                                      <span className="utt-name">{speaker?.name ?? `사용자 ${g.user_id}`}<span className="utt-time">{fmt(Math.floor(g.started_at_offset_ms / 1000))}</span></span>
                                      <span className="utt-text">{g.text}</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          ))
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* 출결 */}
                {tab === "attendance" && (
                  <div className="tab-panel active">
                    <div className="panel-label">출결 현황
                      {(() => {
                        const grace = teamSettings?.punctuality_grace_ratio ?? 0.1;
                        const totalMin = selected.total_minutes;
                        const graceMin = Math.round(totalMin * grace);
                        return (
                          <span className="info-tip" data-tip={`회의 시작 후 ${graceMin}분(총 ${totalMin}분의 ${Math.round(grace * 100)}%) 이내 입장 → 출석\n초과 입장 → 지각\n입장 기록 없음 → 결석`}>
                            <i className="ti ti-info-circle" />
                          </span>
                        );
                      })()}
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
                          return (
                            <div key={mem.user_id} className="att-row">
                              <div
                                className={`av a${(mem.user_id % 4) + 1} av-sm`}
                              >
                                {mem.name[0]}
                              </div>
                              <span className="att-name">{mem.name}</span>
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
                                  ` ${mem.late_minutes}분`}
                              </span>
                              {/* 본인 결석 + 미입력 → 사유 입력 */}
                              {isMe &&
                                mem.status === "absent" &&
                                !mem.absence && (
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
                              {/* 타인 결석 + 사유 있음 + 미승인 → 동의 */}
                              {!isMe &&
                                mem.absence &&
                                mem.absence.status === "pending" && (
                                  <button
                                    className="btn btn-sm"
                                    disabled={busy || mem.absence.my_consent}
                                    onClick={() =>
                                      void consentAbsence(mem.absence!.id)
                                    }
                                  >
                                    {mem.absence.my_consent
                                      ? `동의함 ${mem.absence.consent_count}/${attendance.consent_required}`
                                      : `동의 ${mem.absence.consent_count}/${attendance.consent_required}`}
                                  </button>
                                )}
                            </div>
                          );
                        })}
                        {/* 사유 상세 (입력된 결석 건) */}
                        {attendance.members.some((m) => m.absence) && (
                          <div className="att-reasons">
                            {attendance.members
                              .filter((m) => m.absence)
                              .map((m) => (
                                <div key={m.user_id} className="att-reason">
                                  <strong>{m.name}</strong>
                                  <span>{m.absence!.reason}</span>
                                  {m.absence!.status === "approved" && (
                                    <span className="att-reason-ok">
                                      <i className="ti ti-check" /> 인정됨
                                    </span>
                                  )}
                                </div>
                              ))}
                          </div>
                        )}
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
                    {selected.summary ? (
                      <div
                        className="summary-box"
                        style={{ whiteSpace: "pre-wrap" }}
                      >
                        <i className="ti ti-sparkles" />
                        {selected.summary}
                      </div>
                    ) : (
                      <div className="summary-box">
                        <i className="ti ti-sparkles" />
                        회의가 종료되면 AI가 자동으로
                        결정사항·액션아이템·회의록을 요약합니다.
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>

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
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label">시간</label>
              <input
                className="input"
                type="time"
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
                  if (e.key === "Enter") {
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
            />
          </div>
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
