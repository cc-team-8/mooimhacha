import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import {
  connectMeetingSocket,
  joinMeeting,
  leaveMeeting,
  sendUtterance,
  changeAgendaStatus,
  addDecision,
  addAction,
  speakingStart,
  speakingEnd,
  reportAnomaly,
  type ContributionScoreLive,
} from "@/lib/ws";
import { apiGet, apiPost, tryRefresh } from "@/lib/api";
import { isSpeechSupported } from "@/lib/speech";
import { createSttEngine, type SttEngine } from "@/lib/stt-engine";
import { createCompanionChannel } from "@/lib/companion";
import type {
  Agenda,
  CurrentUser,
  Decision,
  ActionItem,
  Meeting,
  TeamMember,
} from "@/lib/types";
import AgendaTracker from "./AgendaTracker";
import ContributionBar from "./ContributionBar";
import QuickInput from "./QuickInput";

interface Props {
  meetingId: number;
  teamId: number;
}

// 재동기화용 스냅샷 ∪ 현재 상태 병합 — 스냅샷에 없는 항목(스냅샷 SELECT 이후 broadcast 로
// 먼저 도착한 것)은 유지하고, 같은 id 는 스냅샷 값 우선(끊긴 동안의 변경은 스냅샷에만 있음).
// bigint id 는 런타임에 string 가능 → Number 정규화
function mergeById<T extends { id: number | string }>(
  snapshot: T[],
  current: T[],
): T[] {
  const ids = new Set(snapshot.map((s) => Number(s.id)));
  return [...snapshot, ...current.filter((c) => !ids.has(Number(c.id)))];
}

export default function MeetingRoom({ meetingId, teamId }: Props) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [scores, setScores] = useState<ContributionScoreLive[]>([]);
  const [speaking, setSpeaking] = useState<Set<number>>(new Set());
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [actions, setActions] = useState<ActionItem[]>([]);
  const [summaries, setSummaries] = useState<Record<number, string>>({});
  const [t0ms, setT0ms] = useState<number | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const [micOn, setMicOn] = useState(false);
  const [ended, setEnded] = useState(false);
  // error 는 입장 실패(초기 로드 불가)만 — 회의 중 쓰기 실패는 wsIssue 인라인 배너로
  const [error, setError] = useState<string | null>(null);
  const [wsIssue, setWsIssue] = useState<string | null>(null);
  const [silentHint, setSilentHint] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [sttIssue, setSttIssue] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  // 재연결이 더는 자동으로 이뤄지지 않는 상태 (reconnect_failed / 서버 강제 종료)
  const [connLost, setConnLost] = useState(false);
  const [ending, setEnding] = useState(false);
  const [speakingSelf, setSpeakingSelf] = useState(false);
  const [partialText, setPartialText] = useState("");
  const [myUserId, setMyUserId] = useState<number | null>(null);
  const [recentCollapsed, setRecentCollapsed] = useState(true);

  const socketRef = useRef<Socket | null>(null);
  const engineRef = useRef<SttEngine | null>(null);
  const t0Ref = useRef<number | null>(null);
  // ack 타임아웃 직후 브로드캐스트로 같은 항목이 도착하면 성공 간주하고 실패 배너를 닫기 위한 추적
  const lateArrivalRef = useRef<{
    kind: "decision" | "action";
    text: string;
  } | null>(null);
  const speechStartRef = useRef<number>(Date.now());
  const lastSpokeRef = useRef<number>(Date.now());
  // t0 미수신 상태에서 확정된 발화는 절대시각으로 버퍼링했다가 t0 도착 시 flush
  const pendingRef = useRef<
    {
      text: string;
      confidence: number | null;
      startAbs: number;
      endAbs: number;
    }[]
  >([]);

  // 매초 갱신 (시간 초과 시각화용)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // t0 도착 시 버퍼링된 발화를 상대 오프셋으로 변환해 일괄 전송
  const flushPending = useCallback(
    (t0: number) => {
      const s = socketRef.current;
      if (!s) return;
      const items = pendingRef.current;
      pendingRef.current = [];
      for (const it of items) {
        sendUtterance(s, {
          meeting_id: meetingId,
          text: it.text,
          char_count: it.text.length,
          started_at_offset_ms: Math.max(0, it.startAbs - t0),
          ended_at_offset_ms: Math.max(0, it.endAbs - t0),
          confidence: it.confidence,
        });
      }
    },
    [meetingId],
  );

  // 확정 발화 전송 — t0 있으면 즉시, 없으면 버퍼링(시각 동기화 손상 방지)
  const sendUtteranceNow = useCallback(
    (text: string, confidence: number | null) => {
      const s = socketRef.current;
      if (!s) return;
      const startAbs = speechStartRef.current;
      const endAbs = Date.now();
      lastSpokeRef.current = endAbs;
      setSilentHint(false);
      const t0 = t0Ref.current;
      if (t0 != null) {
        sendUtterance(s, {
          meeting_id: meetingId,
          text,
          char_count: text.length,
          started_at_offset_ms: Math.max(0, startAbs - t0),
          ended_at_offset_ms: Math.max(0, endAbs - t0),
          confidence,
        });
      } else {
        pendingRef.current.push({ text, confidence, startAbs, endAbs });
      }
    },
    [meetingId],
  );

  // 침묵 알림(본인에게만) — 마이크 켜진 채 90초 이상 무발언이면 표시
  useEffect(() => {
    if (!micOn) {
      setSilentHint(false);
      return;
    }
    const t = setInterval(() => {
      setSilentHint(Date.now() - lastSpokeRef.current > 90_000);
    }, 5000);
    return () => clearInterval(t);
  }, [micOn]);

  // 회의 종료 전이 — 멱등(종료자 본인도 meeting:ended 를 다시 받음).
  // ended 는 렌더 분기(언마운트 아님)라 STT 엔진을 명시적으로 정지해야 한다 (toggleMic off 분기 참고).
  const endLocally = useCallback(() => {
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
      const s = socketRef.current;
      if (s) speakingEnd(s, meetingId);
    }
    setSpeakingSelf(false);
    setMicOn(false);
    setEnded(true);
  }, [meetingId]);

  // 재연결 후 끊긴 동안의 결정·액션·아젠다(요약 포함)을 REST 스냅샷으로 재동기화.
  // (서버 join 응답은 t0·presence·기여도 스냅샷만 — 기여도는 join 시 서버가 다시 broadcast)
  const resyncSnapshots = useCallback(async () => {
    try {
      const [ag, dec, act] = await Promise.all([
        apiGet<Agenda[]>(`/meetings/${meetingId}/agendas`),
        apiGet<Decision[]>(`/decisions?meeting_id=${meetingId}`),
        apiGet<ActionItem[]>(`/action-items?team_id=${teamId}`),
      ]);
      // 전체 교체가 아닌 id 기준 병합 — fetch 중 broadcast 로 먼저 도착한 항목(스냅샷
      // SELECT 이후 저장분)을 더 오래된 스냅샷이 덮어써 유실시키지 않도록 한다
      setAgendas((prev) => mergeById(ag, prev));
      setDecisions((prev) => mergeById(dec, prev));
      setActions((prev) => mergeById(act, prev));
    } catch {
      // 재동기화 실패는 치명적이지 않음 — 이후 브로드캐스트·새로고침으로 복구 가능
    }
  }, [meetingId, teamId]);

  // 초기 데이터 로드 + 소켓 연결
  useEffect(() => {
    if (!meetingId) {
      setError("회의 정보가 없습니다.");
      return;
    }
    let mounted = true;

    void (async () => {
      try {
        const [m, ag, team, dec, act, me] = await Promise.all([
          apiGet<Meeting>(`/meetings/${meetingId}`),
          apiGet<Agenda[]>(`/meetings/${meetingId}/agendas`),
          apiGet<{ members: TeamMember[] }>(`/teams/${teamId}`),
          apiGet<Decision[]>(`/decisions?meeting_id=${meetingId}`),
          apiGet<ActionItem[]>(`/action-items?team_id=${teamId}`),
          apiGet<CurrentUser>("/auth/me"),
        ]);
        if (!mounted) return;
        setMeeting(m);
        setAgendas(ag);
        setMembers(team.members);
        setDecisions(dec);
        setActions(act);
        setMyUserId(me.id);
        if (m.t0_timestamp) {
          const t = new Date(m.t0_timestamp).getTime();
          setT0ms(t);
          t0Ref.current = t;
        }
        // 이미 종료된 회의에 재접속한 경우 — 곧바로 ended 전이
        if (m.status === "ended") endLocally();
      } catch (e) {
        if (mounted) setError((e as Error).message);
      }
    })();

    const socket = connectMeetingSocket();
    socketRef.current = socket;

    // 첫 연결인지 추적 — 재연결일 때만 REST 스냅샷 재동기화(마운트 로드와 이중 호출 방지)
    let hadConnected = false;
    socket.on("connect", () => {
      setConnected(true);
      setConnLost(false);
      joinMeeting(socket, meetingId);
      if (hadConnected) void resyncSnapshots();
      hadConnected = true;
    });
    // 서버 강제 종료 후 토큰 갱신 재시도는 1회만 — 만료가 아닌 이유로 계속 거부되면
    // 갱신·재연결을 반복하지 않고 새로고침 안내로 전환 (강제 종료 루프 방지)
    let kickRetried = false;
    socket.on("disconnect", (reason) => {
      setConnected(false);
      // 서버 강제 종료('io server disconnect')는 자동 재연결이 없다. 게이트웨이가
      // 만료 토큰을 거부한 경로일 수 있으므로 tryRefresh 1회 후 수동 재연결하고,
      // 그래도 실패하면 connLost 로 — '접속 중' 거짓 안내 금지
      if (reason === "io server disconnect") {
        if (kickRetried) {
          setConnLost(true);
          return;
        }
        kickRetried = true;
        void tryRefresh()
          .then((ok) => {
            if (!mounted) return;
            if (ok) socket.connect();
            else setConnLost(true);
          })
          .catch(() => {
            if (mounted) setConnLost(true);
          });
      }
    });
    socket.on("connect_error", () => setConnected(false));
    // 재연결 시도 상한 초과 — 새로고침 안내로 전환
    const onReconnectFailed = () => setConnLost(true);
    socket.io.on("reconnect_failed", onReconnectFailed);
    socket.on(
      "meeting:t0",
      (p: { t0_timestamp: string | null; status?: Meeting["status"] }) => {
        if (p.t0_timestamp) {
          const t = new Date(p.t0_timestamp).getTime();
          setT0ms(t);
          t0Ref.current = t;
          flushPending(t);
        }
        // join 응답에 status 포함 — 재접속 시 이미 종료된 회의면 ended 전이
        if (p.status === "ended") endLocally();
      },
    );
    // 회의 종료 broadcast — 모든 참가자 보조 창에서 STT 정지 + ended 전이 (멱등)
    socket.on("meeting:ended", () => endLocally());
    // 서버 WsException(검증 실패 등)은 ack 없이 'exception' 이벤트로만 도착 — 배너로 표면화
    socket.on("exception", (e: { message?: string }) => {
      setWsIssue(
        typeof e?.message === "string" && e.message
          ? e.message
          : "요청을 처리하지 못했어요.",
      );
    });
    socket.on("contribution:update", (p: { scores: ContributionScoreLive[] }) =>
      setScores(p.scores),
    );
    socket.on("agenda:status-change", (p: { agenda: Agenda }) =>
      setAgendas((prev) =>
        prev.map((a) => (a.id === p.agenda.id ? p.agenda : a)),
      ),
    );
    socket.on("agenda:summary", (p: { agenda_id: number; summary: string }) =>
      setSummaries((prev) => ({ ...prev, [p.agenda_id]: p.summary })),
    );
    socket.on("decision:new", (p: { decision: Decision }) => {
      // 재동기화 스냅샷 병합과 경합할 수 있으므로 id 기준 dedupe (bigint id 는 런타임에 string 가능 → Number 정규화)
      setDecisions((prev) =>
        prev.some((d) => Number(d.id) === Number(p.decision.id))
          ? prev
          : [...prev, p.decision],
      );
      // ack 타임아웃 직후 같은 내용이 브로드캐스트로 도착 → 성공 간주, 실패 배너 닫기
      if (
        lateArrivalRef.current?.kind === "decision" &&
        lateArrivalRef.current.text === p.decision.content
      ) {
        lateArrivalRef.current = null;
        setWsIssue(null);
      }
    });
    socket.on("action:new", (p: { action: ActionItem }) => {
      setActions((prev) =>
        prev.some((a) => Number(a.id) === Number(p.action.id))
          ? prev
          : [...prev, p.action],
      );
      if (
        lateArrivalRef.current?.kind === "action" &&
        lateArrivalRef.current.text === p.action.description
      ) {
        lateArrivalRef.current = null;
        setWsIssue(null);
      }
    });
    socket.on("user:speaking-start", (p: { user_id: number }) =>
      setSpeaking((prev) => new Set(prev).add(p.user_id)),
    );
    socket.on("user:speaking-end", (p: { user_id: number }) =>
      setSpeaking((prev) => {
        const next = new Set(prev);
        next.delete(p.user_id);
        return next;
      }),
    );

    return () => {
      mounted = false;
      // Manager 는 동일 URL 소켓 간 공유될 수 있어 리스너를 명시적으로 해제
      socket.io.off("reconnect_failed", onReconnectFailed);
      leaveMeeting(socket, meetingId);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [meetingId, teamId, flushPending, endLocally, resyncSnapshots]);

  // STT (마이크 on/off)
  const toggleMic = useCallback(async () => {
    if (micOn) {
      engineRef.current?.stop();
      engineRef.current = null;
      const s = socketRef.current;
      if (s) speakingEnd(s, meetingId);
      setSpeakingSelf(false);
      setPartialText("");
      setMicOn(false);
      return;
    }
    setMicError(null);
    setSttIssue(null);
    const isElectron = !!window.mooimhacha?.isElectron;
    if (!isElectron && !isSpeechSupported()) {
      setMicError(
        "이 브라우저는 음성 인식을 지원하지 않아요. Chrome/Edge에서 열어 주세요.",
      );
      return;
    }
    // 브라우저: 마이크 권한·동의 + 에코/노이즈 억제 제약 적용 (docs/05). Electron은 사이드카가 캡처.
    if (!isElectron) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // 권한·디바이스 확인용 — Web Speech 가 자체 스트림을 열므로 즉시 정리
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        setMicError(
          "마이크 권한이 필요해요. 주소창 왼쪽 자물쇠 → 마이크 → 허용 후 ‘다시 시도’를 눌러 주세요.",
        );
        return;
      }
    }

    const engine = createSttEngine();
    engine.start({
      onSpeechStart: () => {
        speechStartRef.current = Date.now();
        setSpeakingSelf(true);
        const s = socketRef.current;
        if (s) speakingStart(s, meetingId);
      },
      onSpeechEnd: () => {
        setSpeakingSelf(false);
        const s = socketRef.current;
        if (s) speakingEnd(s, meetingId);
      },
      onPartial: (text) => setPartialText(text),
      onFinal: (text, confidence) => {
        setPartialText("");
        setSttIssue(null);
        sendUtteranceNow(text, confidence);
      },
      onFailure: (err) => {
        const s = socketRef.current;
        // 권한 거부·재시작 실패 → 마이크가 꺼지므로 복구 배너로 표면화
        if (err === "not-allowed" || err === "restart_failed") {
          setMicError(
            err === "not-allowed"
              ? "마이크 권한이 거부됐어요. 주소창 왼쪽 자물쇠 → 마이크 → 허용 후 ‘다시 시도’를 눌러 주세요."
              : "음성 인식이 잠시 끊겼어요. ‘다시 시도’를 눌러 주세요.",
          );
          engineRef.current?.stop();
          engineRef.current = null;
          setSpeakingSelf(false);
          if (s) speakingEnd(s, meetingId);
          setMicOn(false);
        } else if (err === "network") {
          // 자동 재시도 중 — 마이크는 켜둔 채 일시 배너로 알림
          setSttIssue("🌐 음성 인식 네트워크가 불안정해요. 다시 시도하는 중…");
        }
        // 실질 장애(network·restart_failed·not-allowed 등)만 서버에 손실 기록.
        // no-speech(침묵)·aborted(인식 재시작)는 정상 동작 잡음 — 보고하면 조용히 경청한
        // 사람의 신뢰도 보정이 오염되므로 보고하지 않고 자동 재시작(speech.ts onend)에 맡긴다.
        if (s && err !== "no-speech" && err !== "aborted")
          reportAnomaly(s, {
            meeting_id: meetingId,
            event_type: "stt_failure",
            metadata: { reason: err },
          });
      },
    });
    engineRef.current = engine;
    lastSpokeRef.current = Date.now();
    setMicOn(true);
  }, [micOn, meetingId, sendUtteranceNow]);

  useEffect(() => {
    return () => engineRef.current?.stop();
  }, []);

  // 쓰기 실패는 토스트가 아닌 인라인 배너로 — companion.html 에는 #toast 엘리먼트가 없다.
  // ack 타임아웃 시 자동 재전송 금지(서버 성공 + ack 지연과 구분 불가 → 중복 저장 위험).
  const handleActivate = (id: number) => {
    const s = socketRef.current;
    if (!s) return;
    const active = agendas.find((a) => a.status === "active");
    const doActivate = () =>
      changeAgendaStatus(s, {
        meeting_id: meetingId,
        agenda_id: id,
        activate: true,
      }).catch(() => {
        setWsIssue(
          "아젠다 상태 변경이 확인되지 않았어요. 잠시 후 다시 시도해 주세요.",
        );
      });
    if (active && Number(active.id) !== Number(id)) {
      changeAgendaStatus(s, {
        meeting_id: meetingId,
        agenda_id: Number(active.id),
        status: "done",
      })
        .then(doActivate)
        .catch(() => {
          setWsIssue(
            "아젠다 상태 변경이 확인되지 않았어요. 잠시 후 다시 시도해 주세요.",
          );
        });
    } else {
      doActivate();
    }
  };
  // 완료 = 자동 스위칭: 완료 ack 후 목록 순서상 첫 대기 아젠다을 이어서 시작한다.
  // activate 한 번으로 합치지 않는 이유 — 서버 activate 의 기존 아젠다 자동 완료는
  // broadcast 되지 않아 다른 참가자 화면에 이전 아젠다이 active 로 남고, 완료 시
  // LLM 요약 트리거도 done 경로에만 있다.
  const handleDone = (id: number) => {
    const s = socketRef.current;
    if (!s) return;
    changeAgendaStatus(s, {
      meeting_id: meetingId,
      agenda_id: id,
      status: "done",
    })
      .then(() => {
        const next = agendas.find(
          (a) => a.status === "pending" && Number(a.id) !== Number(id),
        );
        if (!next) return;
        return changeAgendaStatus(s, {
          meeting_id: meetingId,
          agenda_id: Number(next.id),
          activate: true,
        });
      })
      .catch(() => {
        setWsIssue(
          "아젠다 상태 변경이 확인되지 않았어요. 잠시 후 다시 시도해 주세요.",
        );
      });
  };
  const broadcast = (
    type: "agenda:added" | "decision:added" | "action:added",
  ) => {
    const ch = createCompanionChannel();
    ch.postMessage({ type, meeting_id: meetingId });
    ch.close();
  };

  const handleAddAgenda = async (title: string) => {
    try {
      const created = await apiPost<Agenda>(`/meetings/${meetingId}/agendas`, {
        title,
        source: "ad_hoc",
      });
      setAgendas((prev) => [...prev, created]);
      broadcast("agenda:added");
    } catch {
      // 회의 중 사소한 쓰기 실패 — 풀스크린 에러 대신 인라인 배너로 회의 화면 보존
      setWsIssue("아젠다을 추가하지 못했어요. 잠시 후 다시 시도해 주세요.");
    }
  };

  // 실패 시 false 반환 → QuickInput 이 비운 입력을 복원한다
  const handleDecision = async (content: string): Promise<boolean> => {
    const s = socketRef.current;
    if (!s) return false;
    try {
      await addDecision(s, { meeting_id: meetingId, content });
      broadcast("decision:added");
      return true;
    } catch {
      lateArrivalRef.current = { kind: "decision", text: content };
      setWsIssue(
        "결정 사항 저장이 확인되지 않았어요. 입력을 복원했어요 — 다시 시도해 주세요.",
      );
      return false;
    }
  };
  const handleAction = async (payload: {
    description: string;
    assignee_id?: number;
    due_date?: string;
    difficulty?: number;
  }): Promise<boolean> => {
    const s = socketRef.current;
    if (!s) return false;
    try {
      await addAction(s, {
        meeting_id: meetingId,
        team_id: teamId,
        ...payload,
      });
      broadcast("action:added");
      return true;
    } catch {
      lateArrivalRef.current = { kind: "action", text: payload.description };
      setWsIssue(
        "액션 저장이 확인되지 않았어요. 입력을 복원했어요 — 다시 시도해 주세요.",
      );
      return false;
    }
  };

  const handleEnd = async () => {
    if (ending) return;
    if (
      !confirm(
        "회의를 종료하면 다시 시작할 수 없어요. 지금 기여도를 확정할까요?",
      )
    )
      return;
    setEnding(true);
    try {
      await apiPost(`/meetings/${meetingId}/end`);
      // 종료자 메인 탭의 리포트 자동 이동 경로 — meeting:ended broadcast 와 별개로 유지
      const ch = createCompanionChannel();
      ch.postMessage({ type: "meeting:ended", meeting_id: meetingId });
      ch.close();
      endLocally();
    } catch {
      // 종료 실패는 풀스크린 에러가 아닌 인라인 배너로 — 종료 버튼 재활성화 유지
      setWsIssue("회의 종료에 실패했어요. 잠시 후 다시 시도해 주세요.");
      setEnding(false);
    }
  };

  if (error) {
    return (
      <div className="cmp-error">
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>다시 불러오기</button>
      </div>
    );
  }
  if (ended) {
    return (
      <div className="cmp-ended">
        <p>회의가 종료됐어요. 리포트는 메인 화면에서 확인할 수 있어요.</p>
        <button onClick={() => window.close()}>창 닫기</button>
      </div>
    );
  }

  const elapsedSec =
    t0ms !== null ? Math.max(0, Math.floor((now - t0ms) / 1000)) : 0;
  const fmtHms = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };
  const totalSec = (meeting?.total_minutes ?? 0) * 60;
  const recentDecisions = decisions.slice(-3).reverse();
  const recentActions = actions.slice(-3).reverse();

  return (
    <div className="companion">
      <header className="cmp-header">
        <div className="cmp-header__title">
          <strong>{meeting?.topic ?? "회의 진행 중"}</strong>
          <span className="cmp-header__time">
            {fmtHms(elapsedSec)} / {fmtHms(totalSec)}
          </span>
        </div>
        <div className="cmp-header__actions">
          <button
            className={`cmp-mic-btn ${micOn ? "on" : ""}`}
            onClick={() => void toggleMic()}
            aria-pressed={micOn}
            title={micOn ? "마이크 끄기" : "마이크 켜기"}
          >
            {micOn ? "🔴 듣는 중" : "🎙 마이크 켜기"}
          </button>
          <button className="cmp-end-btn" onClick={handleEnd} disabled={ending}>
            {ending ? "종료 중…" : "회의 종료"}
          </button>
        </div>
      </header>

      {!connected && (
        <div className="cmp-conn-banner">
          {connLost
            ? "🔌 연결에 문제가 있어요 — 새로고침 해 주세요."
            : "🔌 연결이 끊겨 다시 접속하는 중이에요…"}
        </div>
      )}
      {elapsedSec >= 300 && agendas.every((a) => a.status === "pending") && (
        <div className="cmp-agenda-hint">
          💡 회의 시작 5분이 지났어요.{" "}
          {agendas.length === 0
            ? "아젠다을 추가해 보세요!"
            : "아젠다을 시작해 보세요!"}
        </div>
      )}
      {wsIssue && (
        <div className="cmp-mic-banner" role="alert">
          <span>{wsIssue}</span>
          <button
            onClick={() => {
              setWsIssue(null);
              lateArrivalRef.current = null;
            }}
          >
            닫기
          </button>
        </div>
      )}
      {micError && (
        <div className="cmp-mic-banner" role="alert">
          <span>{micError}</span>
          <button
            onClick={() => {
              setMicError(null);
              void toggleMic();
            }}
          >
            다시 시도
          </button>
        </div>
      )}
      {!micOn && !micError && (
        <div className="cmp-mic-prompt">
          🎙 마이크를 켜야 발언이 기록돼요.{" "}
          <button onClick={() => void toggleMic()}>마이크 켜기</button>
        </div>
      )}
      {sttIssue && <div className="cmp-silent-hint">{sttIssue}</div>}
      {micOn && !silentHint && !sttIssue && (
        <div className="cmp-listen-hint">
          {speakingSelf
            ? "● 말하는 중… 잘 인식하고 있어요"
            : "🎙 마이크 켜짐 · 발언을 기다리는 중"}
        </div>
      )}
      {partialText && <div className="cmp-partial-text">{partialText}</div>}
      {silentHint && (
        <div className="cmp-silent-hint">
          🔇 한동안 발언이 없어요. 의견을 나눠보세요.
        </div>
      )}

      <AgendaTracker
        agendas={agendas}
        t0ms={t0ms}
        now={now}
        summaries={summaries}
        onActivate={handleActivate}
        onDone={handleDone}
        onAdd={handleAddAgenda}
        hintActive={
          elapsedSec >= 300 && agendas.every((a) => a.status === "pending")
        }
      />

      <ContributionBar
        scores={scores}
        members={members}
        speaking={speaking}
        myUserId={myUserId}
      />

      <QuickInput
        members={members}
        onDecision={handleDecision}
        onAction={handleAction}
      />

      <section className="cmp-section cmp-recent">
        <header
          className="cmp-section__head cmp-section__head--toggle"
          onClick={() => setRecentCollapsed((c) => !c)}
          title={recentCollapsed ? "펼치기" : "접기"}
        >
          <h2>최근 항목</h2>
          <span className="cmp-toggle-btn">
            <i className={`ti ti-chevron-${recentCollapsed ? "down" : "up"}`} />
          </span>
        </header>
        {!recentCollapsed && (
          <ul className="cmp-recent-list">
            {recentDecisions.map((d) => (
              <li key={`d${d.id}`}>
                <span className="cmp-tag cmp-tag--decision">결정</span>
                {d.content}
              </li>
            ))}
            {recentActions.map((a) => (
              <li key={`a${a.id}`}>
                <span className="cmp-tag cmp-tag--action">액션</span>
                {a.description}
              </li>
            ))}
            {recentDecisions.length === 0 && recentActions.length === 0 && (
              <li className="cmp-empty">기록된 항목이 없습니다.</li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}
