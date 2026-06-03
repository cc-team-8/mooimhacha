import { useState, useEffect } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/useToast";
import { apiFetch, authHeader } from "@/lib/apiFetch";
import Card from "@/components/Card";
import Modal from "@/components/Modal";
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
}

export default function SettingsPage() {
  const team = useOutletContext<TeamContext | null>();
  const { showToast } = useToast();
  const navigate = useNavigate();
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
      await apiFetch(`/api/teams/${team.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify(settings),
      });
      showToast("설정이 저장됐습니다");
    } catch (err) {
      showToast((err as Error).message || "저장 실패");
    } finally {
      setSaving(false);
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
      {/* 팀 삭제 — 팀장만 */}
      {isLeader && (
        <Card icon="ti ti-trash" title="팀 삭제">
          <div style={{ padding: "8px 16px 16px" }}>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-soft)",
                margin: "0 0 12px",
              }}
            >
              팀을 삭제하면 모든 멤버십·설정·기록이 영구적으로 사라집니다.
            </p>
            <button
              className="btn btn-danger"
              onClick={() => setDeleteModalOpen(true)}
            >
              <i className="ti ti-trash" /> 팀 삭제
            </button>
          </div>
        </Card>
      )}

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
    </div>
  );
}
