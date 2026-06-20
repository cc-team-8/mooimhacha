import { useState, useEffect, useCallback } from "react";
import {
  useOutletContext,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import { apiDelete, apiGet, apiPatch } from "@/lib/api";
import { getUser } from "@/lib/auth";
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
  const [teamName, setTeamName] = useState("");
  const [courseName, setCourseName] = useState("");
  const [inviteCopied, setInviteCopied] = useState(false);
  const [saving, setSaving] = useState(false);
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
        showToast(`${memberAction.target.name}님을 내보냈습니다`);
        setMemberAction(null);
        loadMembers();
      } else if (memberAction.kind === "transfer") {
        await apiPatch(`/teams/${team.id}/leader`, {
          user_id: memberAction.target.user_id,
        });
        showToast(`${memberAction.target.name}님이 새 팀장이 되었습니다`);
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
      .then(setSettings)
      .catch(() => {});
  }, [team]);

  function copyInviteCode() {
    if (!detail) return;
    navigator.clipboard?.writeText(detail.invite_code).catch(() => {});
    setInviteCopied(true);
    setTimeout(() => setInviteCopied(false), 2000);
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
          style={{
            padding: "8px 16px 16px",
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
        <div style={{ padding: "8px 16px 16px" }}>
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
            {isLeader && (
              <button className="btn" onClick={regenerateCode}>
                <i className="ti ti-refresh" /> 재발급
              </button>
            )}
          </div>
          <div
            style={{ marginTop: 8, fontSize: 12, color: "var(--text-soft)" }}
          >
            이 코드를 팀원에게 공유하면 팀에 합류할 수 있습니다.
          </div>
        </div>
      </Card>

      {/* 멤버 관리 */}
      <Card icon="ti ti-users" title="멤버 관리">
        <div style={{ padding: "8px 16px 16px" }}>
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
                <div className={`av a${(i % 4) + 1} av-sm`}>{m.name[0]}</div>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>
                  {m.name}
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
                <span style={{ flex: 1 }} />
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
            style={{
              padding: "8px 16px 16px",
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
              <label className="field-label">무단결석 처리</label>
              <select
                className="input"
                value={settings.absent_meeting_handling}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        absent_meeting_handling: e.target
                          .value as Settings["absent_meeting_handling"],
                      },
                  )
                }
                disabled={!isLeader}
              >
                <option value="exclude">해당 회의 기여도 집계 제외</option>
                <option value="zero">기여도 0점 처리</option>
                <option value="attendance_only">출석 점수만 차감</option>
              </select>
            </div>

            <div className="field">
              <label className="field-label">마감 패널티</label>
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
                min={1}
                max={240}
                value={settings.min_meeting_minutes}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        min_meeting_minutes: Number(e.target.value),
                      },
                  )
                }
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
                value={settings.leader_bonus_multiplier}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        leader_bonus_multiplier: Number(e.target.value),
                      },
                  )
                }
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                기여도 가중치 — 태스크 비중{" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  종합: 발언{" "}
                  {Math.round(
                    (1 - settings.final_task_weight) *
                      settings.weight_speech_in_meeting *
                      100,
                  )}
                  % · 출석{" "}
                  {Math.round(
                    (1 - settings.final_task_weight) *
                      settings.weight_attend_in_meeting *
                      100,
                  )}
                  % · 태스크 {Math.round(settings.final_task_weight * 100)}%
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.final_task_weight}
                onChange={(e) =>
                  setSettings(
                    (s) =>
                      s && { ...s, final_task_weight: Number(e.target.value) },
                  )
                }
                disabled={!isLeader}
              />
            </div>

            <div className="field">
              <label className="field-label">
                회의 내 발언 비중 (출석 = 나머지){" "}
                <span style={{ color: "var(--text-soft)", fontWeight: 400 }}>
                  현재: 발언 {Math.round(settings.weight_speech_in_meeting * 100)}
                  % · 출석 {Math.round(settings.weight_attend_in_meeting * 100)}%
                </span>
              </label>
              <input
                className="input"
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={settings.weight_speech_in_meeting}
                onChange={(e) => {
                  const ws = Number(e.target.value);
                  setSettings(
                    (s) =>
                      s && {
                        ...s,
                        weight_speech_in_meeting: ws,
                        weight_attend_in_meeting:
                          Math.round((1 - ws) * 100) / 100,
                      },
                  );
                }}
                disabled={!isLeader}
              />
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
            padding: "8px 16px 16px",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          {isLeader && settings && (
            <>
              <div className="field">
                <label className="field-label">워크스페이스 연결</label>
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
                <p
                  style={{
                    margin: "6px 0 0",
                    fontSize: 12,
                    color: "var(--text-soft)",
                    lineHeight: 1.5,
                  }}
                >
                  채널 우클릭 → 채널 세부정보 → 채널 세부정보 보기 → 맨 아래
                  채널 ID 복사
                </p>
              </div>
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
          style={{
            padding: "8px 16px 16px",
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
                <b>{memberAction.target.name}</b>님을 팀에서 내보낼까요?
                <br />
                과거 회의·기여도 기록은 보존됩니다.
              </>
            ) : memberAction.kind === "transfer" ? (
              <>
                <b>{memberAction.target.name}</b>님에게 팀장을 위임할까요?
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
