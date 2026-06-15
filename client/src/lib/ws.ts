import { io, Socket } from "socket.io-client";
import { API_BASE, getAccessToken, tryRefresh } from "./api";
import type { ActionItem, Agenda, Decision } from "./types";

const WS_BASE = (import.meta.env.VITE_WS_URL as string | undefined) || API_BASE;

// 회의 룸 WebSocket(socket.io) 래퍼. 서버 RealtimeGateway 와 짝.
// 이벤트 명세: docs/04-API-명세.md §WebSocket 이벤트

export interface ContributionScoreLive {
  user_id: number;
  char_count: number;
  ratio: number;
}

// 쓰기 ack 대기 시간 — 서버 WsException 시 ack 가 오지 않으므로 timeout 필수
const ACK_TIMEOUT_MS = 5000;
// 재연결 시도 상한 — 초과 시 Manager 가 reconnect_failed 를 발행 (영구 '접속 중' 표시 방지)
const RECONNECT_ATTEMPTS = 10;
// 액세스 토큰 TTL이 1시간 캡이라 1시간 넘은 회의에서 끊기면 만료 토큰으로 재연결하게 된다.
// 만료(또는 임박) 토큰은 게이트웨이가 즉시 강제 종료하므로 이 여유 안이면 연결 전에 선제 갱신.
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

// JWT payload 의 exp 클레임(초)을 ms 로 디코드 — 형식이 어긋나면 null (만료 검사 생략)
function getTokenExpMs(token: string): number | null {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(b64)) as { exp?: number };
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function connectMeetingSocket(): Socket {
  const socket = io(WS_BASE, {
    transports: ["polling", "websocket"],
    // 함수형 auth — 재연결 시점의 최신 토큰 사용 (정적 객체는 생성 시점 토큰에 고착됨).
    // cb 호출 전까지 CONNECT 패킷이 보류되므로, 만료 임박이면 tryRefresh 를 먼저 끝낸다.
    auth: (cb) => {
      void (async () => {
        const token = getAccessToken();
        const exp = token ? getTokenExpMs(token) : null;
        if (exp !== null && exp - Date.now() < TOKEN_REFRESH_LEEWAY_MS) {
          // 갱신 실패(네트워크 등)는 기존 토큰으로 시도 — 서버 거부 시 MeetingRoom 이 복구
          await tryRefresh().catch(() => false);
        }
        cb({ token: getAccessToken() ?? "" });
      })();
    },
    autoConnect: true,
    reconnectionAttempts: RECONNECT_ATTEMPTS,
  });
  return socket;
}

// ack 기반 쓰기 emit. 실패·타임아웃 시 reject — 호출부가 입력 복원/배너를 처리한다.
// 주의: 타임아웃은 "서버 성공 + ack 지연"과 구분 불가하므로 자동 재전송 금지(중복 저장 위험).
function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    socket
      .timeout(ACK_TIMEOUT_MS)
      .emit(event, payload, (err: Error | null, res: T) => {
        if (err) reject(new Error("응답을 받지 못했어요."));
        else resolve(res);
      });
  });
}

// 회의 룸 입장 — 서버가 meeting:t0 로 응답
export function joinMeeting(socket: Socket, meetingId: number) {
  socket.emit("meeting:join", { meeting_id: meetingId });
}

export function leaveMeeting(socket: Socket, meetingId: number) {
  socket.emit("meeting:leave", { meeting_id: meetingId });
}

// 확정 발화 전송 (텍스트만)
export function sendUtterance(
  socket: Socket,
  payload: {
    meeting_id: number;
    text: string;
    char_count: number;
    started_at_offset_ms: number;
    ended_at_offset_ms: number;
    confidence?: number | null;
  },
) {
  socket.emit("utterance:new", payload);
}

export function changeAgendaStatus(
  socket: Socket,
  payload: {
    meeting_id: number;
    agenda_id: number;
    status?: "pending" | "active" | "done";
    activate?: boolean;
  },
): Promise<{ ok: true; agenda: Agenda }> {
  return emitWithAck(socket, "agenda:status-change", payload);
}

export function addDecision(
  socket: Socket,
  payload: { meeting_id: number; content: string; agenda_id?: number },
): Promise<{ ok: true; decision: Decision }> {
  return emitWithAck(socket, "decision:new", payload);
}

export function addAction(
  socket: Socket,
  payload: {
    meeting_id: number;
    team_id: number;
    description: string;
    assignee_id?: number;
    due_date?: string;
    difficulty?: number;
    agenda_id?: number;
    is_for_next_meeting?: boolean;
  },
): Promise<{ ok: true; action: ActionItem }> {
  return emitWithAck(socket, "action:new", payload);
}

// STT 실패·캡처 손실 보고 → 서버 anomaly_events 기록 (기여도 신뢰도 보정 입력, docs/05·06)
export function reportAnomaly(
  socket: Socket,
  payload: {
    meeting_id: number;
    event_type: "capture_loss" | "inference_fail" | "stt_failure";
    severity?: string;
    metadata?: Record<string, unknown>;
  },
) {
  socket.emit("anomaly:report", payload);
}

export function speakingStart(socket: Socket, meetingId: number) {
  socket.emit("user:speaking-start", { meeting_id: meetingId });
}
export function speakingEnd(socket: Socket, meetingId: number) {
  socket.emit("user:speaking-end", { meeting_id: meetingId });
}
