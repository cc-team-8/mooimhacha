import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  useOutletContext,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import { apiDelete, apiGet, apiPatch } from "@/lib/api";
import { getUser } from "@/lib/auth";
import { avatarBg } from "@/lib/avatarColor";
import { useTeamStore } from "@/stores/teamStore";
import Card from "@/components/Card";
import Modal from "@/components/Modal";
import ConfirmModal from "@/components/ConfirmModal";
import type { TeamContribution } from "@/lib/types";
import type { TeamContext } from "../DashboardPage";

interface TeamDetail {
  id: number;
  name: string;
  course_name: string;
  invite_code: string;
}

interface Settings {
  contribution_visibility: "team" | "self" | "leader";
  absent_meeting_handling: "exclude" | "zero" | "attendance_only";
  deadline_penalty_curve: "standard" | "lenient" | "strict";
  min_meeting_minutes: number;
  late_threshold_minutes: number;
  late_max_minutes: number;
  punctuality_grace_ratio: number;
  leader_bonus_multiplier: number;
  final_task_weight: number;
  weight_speech_in_meeting: number;
  weight_attend_in_meeting: number;
  slack_bot_token?: string | null;
  slack_channel_id?: string | null;
}

export default function SettingsPage() {
  const team = useOutletContext<TeamContext | null>();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isLeader = team?.my_role === "leader";

  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  // 기여도 종합 가중치(%) — 발언/출석/태스크 (합 100). 저장 시 기존 필드로 환산.
  const [weightPct, setWeightPct] = useState({
    speech: 30,
    attend: 20,
    task: 50,
  });
  const weightRef = useRef(weightPct);
  weightRef.current = weightPct;
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<null | "h1" | "h2">(null);
  const [dragging, setDragging] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  // 숫자 입력 편집 중 임시 문자열 — 빈 값·소수점 중간 입력을 허용하기 위함
  const [numDraft, setNumDraft] = useState<Record<string, string>>({});
  const [showPenaltyInfo, setShowPenaltyInfo] = useState(false);
  const [showSlackInfo, setShowSlackInfo] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);
  // 멤버 관리 — 강퇴/위임/탈퇴
  const me = getUser();
  const [members, setMembers] = useState<TeamContribution[]>([]);
  const [memberAction, setMemberAction] = useState<
    | { kind: "kick"; target: TeamContribution }
    | { kind: "transfer"; target: TeamContribution }
    | { kind: "leave" }
    | null
  >(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [slackUserId, setSlackUserId] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);
  const [testingSlack, setTestingSlack] = useState<
    "channel" | "dm" | "button" | null
  >(null);

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

  const loadMembers = useCallback(() => {
    if (!team) return;
    apiGet<{ members: TeamContribution[] }>(`/teams/${team.id}/contributions`)
      .then((d) =>
        setMembers([...d.members].sort((a) => (a.role === "leader" ? -1 : 1))),
      )
      .catch(() => {});
  }, [team]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  async function runMemberAction() {
    if (!team || !memberAction || actionBusy) return;
    setActionBusy(true);
    try {
      if (memberAction.kind === "kick") {
        await apiDelete(
          `/teams/${team.id}/members/${memberAction.target.user_id}`,
        );
        showToast(
          `${nicknameMap.get(memberAction.target.user_id) ?? memberAction.target.name}님을 내보냈습니다`,
        );
        setMemberAction(null);
        loadMembers();
      } else if (memberAction.kind === "transfer") {
        await apiPatch(`/teams/${team.id}/leader`, {
          user_id: memberAction.target.user_id,
        });
        showToast(
          `${nicknameMap.get(memberAction.target.user_id) ?? memberAction.target.name}님이 새 팀장이 되었습니다`,
        );
        // 사이드바·설정 화면의 역할 표시를 한 번에 갱신하기 위해 전체 리로드
        window.location.reload();
      } else {
        await apiDelete(`/teams/${team.id}/members/me`);
        useTeamStore.getState().clearTeamId();
        showToast("팀에서 나왔습니다");
        navigate("/home");
      }
    } catch (err) {
      showToast((err as Error).message, "error");
      setMemberAction(null);
    } finally {
      setActionBusy(false);
    }
  }

  useEffect(() => {
    apiFetch<{ slack_user_id?: string | null }>("/api/auth/me", {
      headers: authHeader(),
    })
      .then((d) => setSlackUserId(d.slack_user_id ?? ""))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const slack = searchParams.get("slack");
    if (slack === "connected") {
      showToast("Slack 워크스페이스 연결됐습니다");
      setSearchParams({}, { replace: true });
    } else if (slack === "error") {
      showToast("Slack 연결에 실패했습니다", "error");
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams, showToast]);

  useEffect(() => {
    if (!team) return;
    apiFetch<TeamDetail>(`/api/teams/${team.id}`, { headers: authHeader() })
      .then((d) => {
        setDetail(d);
        setTeamName(d.name);
        setCourseName(d.course_name);
      })
      .catch(() => {});
    apiFetch<Settings>(`/api/teams/${team.id}/settings`, {
      headers: authHeader(),
    })
      .then((s) => {
        setSettings(s);
        const t = Number(s.final_task_weight);
        const ws = Number(s.weight_speech_in_meeting);
        const wa = Number(s.weight_attend_in_meeting);
        const speech = Math.round((1 - t) * ws * 100);
        const attend = Math.round((1 - t) * wa * 100);
        setWeightPct({
          speech,
          attend,
          task: Math.max(0, 100 - speech - attend),
        });
      })
      .catch(() => {});
  }, [team]);

  function copyInviteCode() {
    if (!detail) return;
    navigator.clipboard?.writeText(detail.invite_code).catch(() => {});
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
  }

  function shareKakao() {
    if (!detail || !team) return;
    if (!window.Kakao?.isInitialized()) {
      showToast("카카오 SDK가 초기화되지 않았습니다");
      return;
    }
    window.Kakao.Share.sendDefault({
      objectType: "text",
      text: `${me?.name ?? "팀원"}님이 초대하셨어요 🎉\n🏷 ${team.name}\n🔑 초대코드: ${detail.invite_code}`,
      link: {
        mobileWebUrl: window.location.origin,
        webUrl: window.location.origin,
      },
      buttonTitle: "지금 합류하기",
    });
  }

  async function regenerateCode() {
    if (!team) return;
    try {
      const data = await apiFetch<{ invite_code: string }>(
        `/api/teams/${team.id}/invite-code`,
        { method: "POST", headers: authHeader() },
      );
      setDetail((prev) => prev && { ...prev, invite_code: data.invite_code });
      showToast("초대코드가 재발급됐습니다");
    } catch (err) {
      showToast((err as Error).message || "재발급 실패");
    }
  }

  async function saveTeamInfo() {
    if (!team || !teamName.trim()) return;
    setSaving(true);
    try {
      await apiFetch(`/api/teams/${team.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({
          name: teamName.trim(),
          course_name: courseName,
        }),
      });
      showToast("팀 정보가 저장됐습니다");
    } catch (err) {
      showToast((err as Error).message || "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  // 발언/출석/태스크 %(합 100)를 기존 저장 모델(final_task_weight·weight_speech/attend)로 환산.
  function applyWeights(speech: number, attend: number, task: number) {
    const next = {
      speech: Math.round(speech),
      attend: Math.round(attend),
      task: Math.round(task),
    };
    setWeightPct(next);
    weightRef.current = next;
    const sum = next.speech + next.attend + next.task;
    const t = sum > 0 ? next.task / sum : 0;
    const sa = next.speech + next.attend;
    const ws = Math.round((sa > 0 ? next.speech / sa : 0.5) * 100) / 100;
    setSettings(
      (s) =>
        s && {
          ...s,
          final_task_weight: Math.round(t * 100) / 100,
          weight_speech_in_meeting: ws,
          weight_attend_in_meeting: Math.round((1 - ws) * 100) / 100,
        },
    );
  }

  // 막대 경계 핸들(h1: 발언|출석, h2: 출석|태스크)을 위치(%)로 이동. 합 100 유지.
  function moveHandleTo(which: "h1" | "h2", pct: number) {
    const MIN = 10; // 각 구간 최소 비율(%)
    const w = weightRef.current;
    let p1 = w.speech;
    let p2 = w.speech + w.attend;
    const rounded = Math.round(pct);
    if (which === "h1") {
      // 발언·출석 ≥ MIN → p1 ∈ [MIN, p2 - MIN]
      p1 = Math.max(MIN, Math.min(rounded, p2 - MIN));
    } else {
      // 출석·태스크 ≥ MIN → p2 ∈ [p1 + MIN, 100 - MIN]
      p2 = Math.min(100 - MIN, Math.max(rounded, p1 + MIN));
    }
    applyWeights(p1, p2 - p1, 100 - p2);
  }

  function moveHandleFromX(which: "h1" | "h2", clientX: number) {
    const el = barRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    moveHandleTo(which, ((clientX - rect.left) / rect.width) * 100);
  }

  function nudgeHandle(which: "h1" | "h2", delta: number) {
    const w = weightRef.current;
    const cur = which === "h1" ? w.speech : w.speech + w.attend;
    moveHandleTo(which, cur + delta);
  }

  async function saveSettings() {
    if (!team || !settings) return;
    setSaving(true);
    try {
      // slack_bot_token은 OAuth로 관리되므로 제외
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { slack_bot_token: _token, ...rest } = settings;
      await apiFetch(`/api/teams/${team.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify(rest),
      });
      showToast("설정이 저장됐습니다");
    } catch (err) {
      showToast((err as Error).message || "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  // 숫자 설정 입력 핸들러 — value를 숫자에 직접 묶으면 비울 때 0이 끼어들어
  // 지우거나(특히 소수) 다시 입력하기 어렵다. 편집 중엔 draft 문자열을 보여주고,
  // 포커스가 빠질 때 빈 값이면 0으로 확정한다.
  type NumKey =
    | "min_meeting_minutes"
    | "late_threshold_minutes"
    | "late_max_minutes"
    | "leader_bonus_multiplier";
  const editNum = (key: NumKey, v: string) =>
    setNumDraft((d) => ({ ...d, [key]: v }));
  const commitNum = (key: NumKey, v: string) => {
    setSettings((s) => s && { ...s, [key]: v === "" ? 0 : Number(v) });
    setNumDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  };

  async function addToSlack() {
    if (!team) return;
    try {
      const data = await apiFetch<{ url: string }>(
        `/api/slack/oauth/url?team_id=${team.id}`,
        { headers: authHeader() },
      );
      window.location.href = data.url;
    } catch (err) {
      showToast((err as Error).message || "Slack 연결 실패", "error");
    }
  }

  async function disconnectSlack() {
    if (!team) return;
    try {
      await apiFetch(`/api/teams/${team.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ slack_bot_token: null }),
      });
      setSettings((s) => s && { ...s, slack_bot_token: null });
      showToast("Slack 연결이 해제됐습니다");
    } catch (err) {
      showToast((err as Error).message || "해제 실패", "error");
    }
  }

  async function saveSlackUserId() {
    setProfileSaving(true);
    try {
      await apiFetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ slack_user_id: slackUserId.trim() || null }),
      });
      showToast("Slack User ID가 저장됐습니다");
    } catch (err) {
      showToast((err as Error).message || "저장 실패", "error");
    } finally {
      setProfileSaving(false);
    }
  }

  async function testSlack(type: "channel" | "dm" | "button") {
    if (!team) return;
    setTestingSlack(type);
    try {
      await apiFetch(`/api/slack/test?team_id=${team.id}&type=${type}`, {
        method: "POST",
        headers: authHeader(),
      });
      showToast(
        type === "channel"
          ? "채널 메시지가 전송됐습니다"
          : type === "button"
            ? "버튼 포함 DM이 전송됐습니다. Slack에서 버튼을 클릭해 확인하세요"
            : "개인 DM이 전송됐습니다",
      );
    } catch (err) {
      showToast((err as Error).message || "전송 실패", "error");
    } finally {
      setTestingSlack(null);
    }
  }

  async function handleDelete() {
    if (!team || deleteConfirmName !== team.name) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/teams/${team.id}`, {
        method: "DELETE",
        headers: authHeader(),
      });
      showToast(`${team.name} 팀이 삭제됐습니다`);
      navigate("/home");
    } catch (err) {
      showToast((err as Error).message || "삭제 실패");
    } finally {
      setDeleting(false);
    }
  }

  if (!team) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 팀 정보 */}
      <Card icon="ti ti-users-group" title="팀 정보">
        <div
          data-tour="st-info"
          style={{
            padding: "8px 18px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div className="field">
            <label className="field-label">팀 이름</label>
            <input
              className="input"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              disabled={!isLeader}
              maxLength={100}
            />
          </div>
          <div className="field">
            <label className="field-label">과목 유형</label>
            <input
              className="input"
              value={courseName}
              onChange={(e) => setCourseName(e.target.value)}
              disabled={!isLeader}
              maxLength={100}
            />
          </div>
          {isLeader && (
            <button
              className="btn btn-primary"
              style={{ alignSelf: "flex-end" }}
              onClick={saveTeamInfo}
              disabled={saving}
            >
              저장
            </button>
          )}
        </div>
      </Card>

      {/* 초대 코드 */}
      <Card icon="ti ti-key" title="초대 코드">
        <div data-tour="st-invite" style={{ padding: "8px 18px 16px" }}>
          <div
            style={{ marginBottom: 8, fontSize: 12, color: "var(--text-soft)" }}
          >
            이 코드를 팀원에게 공유하면 팀에 합류할 수 있습니다.
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                flex: 1,
                background: "var(--surface-2)",
                border: "1px solid var(--border-2)",
                borderRadius: 10,
                padding: "10px 14px",
                fontFamily: "monospace",
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: 2,
              }}
            >
              {detail?.invite_code ?? "--------"}
            </div>
            <button
              className="btn"
              onClick={copyInviteCode}
              style={inviteCopied ? { color: "var(--green)" } : undefined}
            >
              <i className={inviteCopied ? "ti ti-check" : "ti ti-copy"} />
              {inviteCopied ? "복사됨" : "복사"}
            </button>
            <button
              className="btn"
              onClick={shareKakao}
              style={{
                background: "#FEE500",
                color: "#191919",
                border: "none",
              }}
            >
              <i className="ti ti-brand-kakao" />
              카카오 공유
            </button>
            {isLeader && (
              <button className="btn" onClick={regenerateCode}>
                <i className="ti ti-refresh" /> 재발급
              </button>
            )}
          </div>
        </div>
      </Card>

      {/* 멤버 관리 */}
      <Card icon="ti ti-users" title="멤버 관리">
        <div data-tour="st-members" style={{ padding: "8px 18px 16px" }}>
          {members.map((m, i) => {
            const isMe = me?.id === m.user_id;
            return (
              <div
                key={m.user_id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom:
                    i < members.length - 1
                      ? "1px solid var(--border)"
                      : undefined,
                }}
              >
                <div
                  className="av av-sm"
                  style={{ background: avatarBg(memberIdx(m.user_id)) }}
                >
                  {(nicknameMap.get(m.user_id) ?? m.name)[0]}
                </div>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 13.5,
                    fontWeight: 600,
                  }}
                >
                  {nicknameMap.get(m.user_id) ?? m.name}
                  {isMe && (
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--text-soft)",
                        fontWeight: 400,
                        marginLeft: 4,
                      }}
                    >
                      나
                    </span>
                  )}
                </span>
                <span
                  className={`badge ${m.role === "leader" ? "b-green" : "b-gray"}`}
                >
                  {m.role === "leader" ? "팀장" : "팀원"}
                </span>
                {isLeader && !isMe && (
                  <>
                    <button
                      className="btn btn-sm"
                      onClick={() =>
                        setMemberAction({ kind: "transfer", target: m })
                      }
                    >
                      <i className="ti ti-crown" /> 팀장 위임
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        setMemberAction({ kind: "kick", target: m })
                      }
                    >
                      <i className="ti ti-user-minus" /> 내보내기
                    </button>
                  </>
                )}
              </div>
            );
          })}
          {members.length === 0 && (
            <div style={{ fontSize: 12.5, color: "var(--text-soft)" }}>
              멤버 정보를 불러오는 중입니다…
            </div>
          )}
        </div>
      </Card>

      {/* 기여도·회의 설정 */}
      {settings && (
        <Card icon="ti ti-adjustments" title="팀 설정">
          <div
            data-tour="st-settings"
            style={{
              padding: "8px 18px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div className="field">
              <label className="field-label">기여도 공개 범위</label>
              <select
                className="input"
                value={settings.contribution_visibility}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        contribution_visibility: e.target
                          .value as Settings["contribution_visibility"],
                      },
                  )
                }
                disabled={!isLeader}
              >
                <option value="team">전체 팀원 공개</option>
                <option value="self">본인만 열람</option>
                <option value="leader">팀장만 열람</option>
              </select>
            </div>

            <div className="field">
              <label
                className="field-label"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                마감 패널티
                <button
                  type="button"
                  onClick={() => setShowPenaltyInfo((v) => !v)}
                  aria-label="마감 패널티 설명 보기"
                  aria-expanded={showPenaltyInfo}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    background: "none",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    color: showPenaltyInfo ? "var(--blue)" : "var(--text-soft)",
                    fontSize: 15,
                    lineHeight: 1,
                  }}
                >
                  <i className="ti ti-info-circle" />
                </button>
              </label>
              {showPenaltyInfo && (
                <div
                  style={{
                    margin: "0 0 8px",
                    padding: "10px 12px",
                    background: "var(--surface-2)",
                    border: "1px solid var(--border-2)",
                    borderRadius: 10,
                    fontSize: 12,
                    color: "var(--text-soft)",
                    lineHeight: 1.6,
                  }}
                >
                  마감을 넘겨 제출한 태스크의 감점 폭을 정합니다.
                  <br />
                  <strong style={{ color: "var(--text-main)" }}>표준</strong> ·
                  경과 시간에 비례해 일반적인 수준으로 감점합니다.
                  <br />
                  <strong style={{ color: "var(--text-main)" }}>완화</strong> ·
                  늦게 제출해도 감점 폭이 작아 마감을 유연하게 적용합니다.
                  <br />
                  <strong style={{ color: "var(--text-main)" }}>엄격</strong> ·
                  감점 폭이 커 기한 준수를 강하게 반영합니다.
                </div>
              )}
              <select
                className="input"
                value={settings.deadline_penalty_curve}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        deadline_penalty_curve: e.target
                          .value as Settings["deadline_penalty_curve"],
                      },
                  )
                }
                disabled={!isLeader}
              >
                <option value="standard">표준</option>
                <option value="lenient">완화</option>
                <option value="strict">엄격</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label">
                최소 회의 시간 (분){" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  현재: {settings.min_meeting_minutes}분
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={240}
                value={
                  numDraft.min_meeting_minutes ??
                  String(settings.min_meeting_minutes)
                }
                onChange={(e) => editNum("min_meeting_minutes", e.target.value)}
                onBlur={(e) => commitNum("min_meeting_minutes", e.target.value)}
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                지각 기준 (분){" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  회의 시작 후 {settings.late_threshold_minutes}분 초과 입장 시
                  지각
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={240}
                value={
                  numDraft.late_threshold_minutes ??
                  String(settings.late_threshold_minutes)
                }
                onChange={(e) =>
                  editNum("late_threshold_minutes", e.target.value)
                }
                onBlur={(e) =>
                  commitNum("late_threshold_minutes", e.target.value)
                }
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                지각 최대 인정 시간 (분){" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  {settings.late_max_minutes === 0
                    ? "0이면 상한 없음"
                    : `회의 시작 후 ${settings.late_max_minutes}분 초과 입장 시 결석`}
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={240}
                value={
                  numDraft.late_max_minutes ?? String(settings.late_max_minutes)
                }
                onChange={(e) => editNum("late_max_minutes", e.target.value)}
                onBlur={(e) => commitNum("late_max_minutes", e.target.value)}
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                팀장 보너스 배율{" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  현재: ×{settings.leader_bonus_multiplier}
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={
                  numDraft.leader_bonus_multiplier ??
                  String(settings.leader_bonus_multiplier)
                }
                onChange={(e) =>
                  editNum("leader_bonus_multiplier", e.target.value)
                }
                onBlur={(e) =>
                  commitNum("leader_bonus_multiplier", e.target.value)
                }
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                기여도 종합 가중치{" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  {isLeader
                    ? "막대 경계를 드래그해 비율을 조정하세요"
                    : "팀장이 설정한 비율"}
                </span>
              </label>

              {/* 라벨 (게이지 위) */}
              <div style={{ display: "flex", marginBottom: 5 }}>
                {(
                  [
                    ["발언", weightPct.speech],
                    ["출석", weightPct.attend],
                    ["태스크", weightPct.task],
                  ] as const
                ).map(([label, val]) => (
                  <div
                    key={label}
                    style={{
                      width: `${val}%`,
                      textAlign: "center",
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                      fontSize: 11.5,
                      fontWeight: 600,
                      color: "var(--text-main)",
                      transition: dragging ? "none" : "width .12s ease",
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>

              <div
                ref={barRef}
                style={{
                  position: "relative",
                  height: 24,
                  userSelect: "none",
                  touchAction: "none",
                  margin: "0 0 14px",
                }}
              >
                {/* 세그먼트 (둥근 모서리로 클립) */}
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    borderRadius: 12,
                    overflow: "hidden",
                    border: "1px solid var(--border-2)",
                  }}
                >
                  {(
                    [
                      ["발언", "var(--blue)", weightPct.speech],
                      ["출석", "var(--amber)", weightPct.attend],
                      ["태스크", "var(--green)", weightPct.task],
                    ] as const
                  ).map(([label, color, val]) => (
                    <div
                      key={label}
                      style={{
                        width: `${val}%`,
                        background: color,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 700,
                        textShadow: "0 1px 2px rgba(0,0,0,.28)",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        transition: dragging ? "none" : "width .12s ease",
                      }}
                    >
                      {val >= 10 ? `${val}%` : ""}
                    </div>
                  ))}
                </div>

                {/* 드래그 핸들 (팀장만) */}
                {isLeader &&
                  (
                    [
                      ["h1", weightPct.speech, "발언/출석 경계"],
                      [
                        "h2",
                        weightPct.speech + weightPct.attend,
                        "출석/태스크 경계",
                      ],
                    ] as const
                  ).map(([which, pos, aria]) => (
                    <div
                      key={which}
                      role="slider"
                      aria-label={aria}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(pos)}
                      tabIndex={0}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragRef.current = which;
                        setDragging(true);
                      }}
                      onPointerMove={(e) => {
                        if (dragRef.current !== which) return;
                        moveHandleFromX(which, e.clientX);
                      }}
                      onPointerUp={(e) => {
                        dragRef.current = null;
                        setDragging(false);
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }}
                      onKeyDown={(e) => {
                        const step = e.shiftKey ? 5 : 1;
                        if (e.key === "ArrowLeft") {
                          e.preventDefault();
                          nudgeHandle(which, -step);
                        } else if (e.key === "ArrowRight") {
                          e.preventDefault();
                          nudgeHandle(which, step);
                        }
                      }}
                      style={{
                        position: "absolute",
                        left: `${pos}%`,
                        top: 0,
                        width: 18,
                        transform: "translateX(-50%)",
                        cursor: "col-resize",
                        display: "flex",
                        flexDirection: "column",
                        alignItems: "center",
                        zIndex: 2,
                      }}
                    >
                      {/* 구분 직선 */}
                      <span
                        style={{
                          width: 2,
                          height: 24,
                          flexShrink: 0,
                          background: "var(--text-main)",
                          boxShadow: "0 0 0 1px rgba(255,255,255,.55)",
                        }}
                      />
                      {/* 경계선 아래 삼각형 (▼) */}
                      <span
                        style={{
                          width: 0,
                          height: 0,
                          flexShrink: 0,
                          marginTop: 2,
                          borderLeft: "5px solid transparent",
                          borderRight: "5px solid transparent",
                          borderTop: "7px solid var(--text-main)",
                          filter: "drop-shadow(0 1px 1px rgba(0,0,0,.25))",
                        }}
                      />
                    </div>
                  ))}
              </div>

              <div
                style={{
                  marginTop: 2,
                  fontSize: 12,
                  color: "var(--text-soft)",
                  lineHeight: 1.5,
                }}
              >
                종합 기여 = 발언×가중치 + 출석×가중치 + 태스크×가중치. 리포트의
                막대·점수에 그대로 반영됩니다.
              </div>
            </div>

            {isLeader && (
              <button
                className="btn btn-primary"
                style={{ alignSelf: "flex-end" }}
                onClick={saveSettings}
                disabled={saving}
              >
                설정 저장
              </button>
            )}
            {!isLeader && (
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-soft)",
                  textAlign: "center",
                }}
              >
                팀장만 설정을 변경할 수 있습니다.
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Slack 알림 연동 */}
      <Card icon="ti ti-brand-slack" title="Slack 알림 연동">
        <div
          style={{
            padding: "8px 18px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {isLeader && settings && (
            <>
              <div className="field">
                <label
                  className="field-label"
                  style={{ display: "flex", alignItems: "center", gap: 5 }}
                >
                  워크스페이스 연결
                  <span
                    style={{
                      position: "relative",
                      display: "inline-flex",
                      alignItems: "center",
                    }}
                    onMouseEnter={() => setShowSlackInfo(true)}
                    onMouseLeave={() => setShowSlackInfo(false)}
                  >
                    <i
                      className="ti ti-info-circle"
                      style={{
                        fontSize: 15,
                        color: "var(--text-soft)",
                        cursor: "default",
                      }}
                    />
                    {showSlackInfo && (
                      <div
                        style={{
                          position: "absolute",
                          top: "calc(100% + 6px)",
                          left: 0,
                          background: "var(--surface-2)",
                          border: "1px solid var(--border-2)",
                          borderRadius: 10,
                          padding: "10px 12px",
                          fontSize: 12,
                          color: "var(--text-soft)",
                          lineHeight: 1.7,
                          whiteSpace: "nowrap",
                          zIndex: 100,
                          boxShadow: "0 4px 12px rgba(0,0,0,.12)",
                        }}
                      >
                        슬랙 채널 ID를 입력하고 저장 버튼을 누른 뒤,
                        <br />
                        Add to Slack을 눌러서 원하는 워크스페이스에 연결하세요.
                        <br />
                        이후 원하는 채널에서{" "}
                        <code
                          style={{
                            background: "var(--surface-3)",
                            borderRadius: 4,
                            padding: "1px 5px",
                            fontFamily: "monospace",
                          }}
                        >
                          /invite @무임하차
                        </code>
                        를 입력하면 봇을 초대할 수 있습니다.
                      </div>
                    )}
                  </span>
                </label>
                {settings.slack_bot_token ? (
                  <div style={{ display: "flex", gap: 8 }}>
                    <div
                      className="input"
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        color: "var(--green)",
                        fontSize: 13,
                      }}
                    >
                      <i className="ti ti-circle-check-filled" />
                      연결됨
                    </div>
                    <button className="btn" onClick={disconnectSlack}>
                      연결 해제
                    </button>
                  </div>
                ) : (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void addToSlack();
                    }}
                  >
                    <img
                      alt="Add to Slack"
                      height="40"
                      width="139"
                      src="https://platform.slack-edge.com/img/add_to_slack.png"
                      srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
                    />
                  </a>
                )}
              </div>
              <div className="field">
                <label className="field-label">Slack Channel ID</label>
                <p
                  style={{
                    margin: "0 0 6px",
                    fontSize: 12,
                    color: "var(--text-soft)",
                    lineHeight: 1.5,
                  }}
                >
                  채널 우클릭 → 채널 세부정보 → 채널 세부정보 보기 → 맨 아래
                  채널 ID 복사
                </p>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="C0123456789"
                    value={settings.slack_channel_id ?? ""}
                    onChange={(e) =>
                      setSettings(
                        (s) => s && { ...s, slack_channel_id: e.target.value },
                      )
                    }
                    maxLength={32}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={saveSettings}
                    disabled={saving}
                  >
                    저장
                  </button>
                </div>
              </div>
              {settings.slack_bot_token && (
                <div className="field">
                  <label className="field-label">연동 테스트</label>
                  <p
                    style={{
                      margin: "0 0 8px",
                      fontSize: 12,
                      color: "var(--text-soft)",
                      lineHeight: 1.5,
                    }}
                  >
                    채널 ID와 내 Slack User ID를 저장한 뒤 테스트하세요. 버튼
                    테스트는 DM으로 버튼이 전송되며, 클릭 시 서버 연동을
                    확인합니다.
                  </p>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      disabled={
                        !settings.slack_channel_id || testingSlack === "channel"
                      }
                      onClick={() => void testSlack("channel")}
                    >
                      <i className="ti ti-send" />
                      {testingSlack === "channel"
                        ? "전송 중…"
                        : "채널 메시지 테스트"}
                    </button>
                    <button
                      className="btn"
                      style={{ flex: 1 }}
                      disabled={testingSlack === "dm"}
                      onClick={() => void testSlack("dm")}
                    >
                      <i className="ti ti-message" />
                      {testingSlack === "dm" ? "전송 중…" : "개인 DM 테스트"}
                    </button>
                  </div>
                  <button
                    className="btn"
                    style={{ width: "100%" }}
                    disabled={testingSlack === "button"}
                    onClick={() => void testSlack("button")}
                  >
                    <i className="ti ti-hand-click" />
                    {testingSlack === "button"
                      ? "전송 중…"
                      : "버튼 클릭 테스트 (DM으로 버튼 전송)"}
                  </button>
                </div>
              )}
              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  margin: "4px 0",
                }}
              />
            </>
          )}
          <div className="field">
            <label className="field-label">내 Slack User ID</label>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: 12,
                color: "var(--text-soft)",
                lineHeight: 1.5,
              }}
            >
              DM 알림(마감 하루 전·사유 승인)을 받으려면 입력하세요.
              <br />
              Slack 앱 → 프로필 → 더보기 → Member ID 복사
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="U0123456789"
                value={slackUserId}
                onChange={(e) => setSlackUserId(e.target.value)}
                maxLength={32}
              />
              <button
                className="btn btn-primary"
                onClick={saveSlackUserId}
                disabled={profileSaving}
              >
                저장
              </button>
            </div>
          </div>
        </div>
      </Card>

      {/* 위험 구역 */}
      <Card icon="ti ti-alert-triangle" title="위험 구역">
        <div
          data-tour="st-danger"
          style={{
            padding: "8px 18px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}>
                팀 나가기
              </div>
              <p
                style={{ fontSize: 12.5, color: "var(--text-soft)", margin: 0 }}
              >
                {isLeader
                  ? "팀장은 다른 멤버에게 팀장을 위임한 뒤 나갈 수 있습니다."
                  : "팀에서 나가면 다시 합류할 때 초대코드가 필요합니다."}
              </p>
            </div>
            <button
              className="btn btn-danger"
              style={{ flexShrink: 0 }}
              onClick={() => setMemberAction({ kind: "leave" })}
            >
              <i className="ti ti-door-exit" /> 나가기
            </button>
          </div>
          {isLeader && (
            <>
              <hr
                style={{
                  border: "none",
                  borderTop: "1px solid var(--border)",
                  margin: 0,
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <div
                    style={{ fontSize: 13.5, fontWeight: 600, marginBottom: 4 }}
                  >
                    팀 삭제
                  </div>
                  <p
                    style={{
                      fontSize: 12.5,
                      color: "var(--text-soft)",
                      margin: 0,
                    }}
                  >
                    팀을 삭제하면 모든 멤버십·설정·기록이 영구적으로 사라집니다.
                  </p>
                </div>
                <button
                  className="btn btn-danger"
                  style={{ flexShrink: 0 }}
                  onClick={() => setDeleteModalOpen(true)}
                >
                  <i className="ti ti-trash" /> 삭제
                </button>
              </div>
            </>
          )}
        </div>
      </Card>

      {/* 삭제 확인 모달 */}
      {deleteModalOpen && (
        <Modal
          title="팀 삭제 확인"
          onClose={() => {
            setDeleteModalOpen(false);
            setDeleteConfirmName("");
          }}
          actions={
            <button
              className="btn btn-danger"
              disabled={deleteConfirmName !== team.name || deleting}
              onClick={handleDelete}
            >
              {deleting ? "삭제 중..." : "삭제"}
            </button>
          }
        >
          <div className="modal-sub">
            <p style={{ margin: "0 0 12px", fontSize: 13 }}>
              정말 삭제하려면 팀 이름 <strong>{team.name}</strong>을 입력하세요.
            </p>
            <label className="field">
              <input
                className="input"
                placeholder={team.name}
                value={deleteConfirmName}
                onChange={(e) => setDeleteConfirmName(e.target.value)}
                autoFocus
              />
            </label>
          </div>
        </Modal>
      )}

      {/* 멤버 액션(강퇴·위임·탈퇴) 확인 모달 */}
      {memberAction && (
        <ConfirmModal
          title={
            memberAction.kind === "kick"
              ? "멤버 내보내기"
              : memberAction.kind === "transfer"
                ? "팀장 위임"
                : "팀 나가기"
          }
          message={
            memberAction.kind === "kick" ? (
              <>
                <b>
                  {nicknameMap.get(memberAction.target.user_id) ??
                    memberAction.target.name}
                </b>
                님을 팀에서 내보낼까요?
                <br />
                과거 회의·기여도 기록은 보존됩니다.
              </>
            ) : memberAction.kind === "transfer" ? (
              <>
                <b>
                  {nicknameMap.get(memberAction.target.user_id) ??
                    memberAction.target.name}
                </b>
                님에게 팀장을 위임할까요?
                <br />
                나는 팀원으로 변경됩니다.
              </>
            ) : (
              <>
                정말 이 팀에서 나갈까요?
                {isLeader && (
                  <>
                    <br />
                    팀장은 먼저 다른 멤버에게 위임해야 나갈 수 있어요.
                  </>
                )}
              </>
            )
          }
          confirmLabel={
            memberAction.kind === "kick"
              ? "내보내기"
              : memberAction.kind === "transfer"
                ? "위임하기"
                : "나가기"
          }
          danger={memberAction.kind !== "transfer"}
          busy={actionBusy}
          onConfirm={() => void runMemberAction()}
          onClose={() => setMemberAction(null)}
        />
      )}
    </div>
  );
}
