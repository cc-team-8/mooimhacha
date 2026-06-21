// 프론트엔드 공용 도메인 타입 (서버 엔티티와 대응)

export type AgendaStatus = "pending" | "active" | "done";
export type MeetingStatus = "scheduled" | "active" | "ended";

export interface Team {
  id: number;
  name: string;
  course_name: string | null;
  role?: "leader" | "member";
}

export interface TeamMember {
  user_id: number;
  name: string;
  nickname: string | null;
  profile_image_url: string | null;
  role: "leader" | "member";
}

export interface Meeting {
  id: number;
  team_id: number;
  scheduled_at: string;
  total_minutes: number;
  topic: string | null;
  status: MeetingStatus;
  t0_timestamp: string | null;
  ended_at: string | null;
  meeting_type: "regular" | "partial";
  one_liner?: string | null;
  summary?: string | null;
}

export interface Agenda {
  id: number;
  meeting_id: number;
  title: string;
  estimated_minutes: number;
  order_index: number;
  status: AgendaStatus;
  started_at_offset_ms: number | null;
  ended_at_offset_ms: number | null;
  actual_minutes: number | null;
  source: string;
  summary: string | null;
}

export interface Decision {
  id: number;
  meeting_id: number;
  content: string;
  agenda_id: number | null;
  created_by: number;
}

export interface ActionItem {
  id: number;
  team_id: number;
  meeting_id: number | null;
  assignee_id: number | null;
  description: string;
  detail: string | null;
  due_date: string | null;
  completed_at: string | null;
  difficulty: number;
  status: string;
  source: "manual" | "ai_extracted";
  confirmed: boolean;
}

export interface ActionItemLog {
  id: number;
  actor_name: string;
  action: "edit" | "delete";
  task_description: string;
  changes: { field: string; from: string | null; to: string | null }[] | null;
  created_at: string;
}

export interface MeetingContribution {
  user_id: number;
  name: string;
  speech_ratio: number | null;
  attendance_ratio: number | null;
  meeting_score: number | null;
  confidence_level: string | null;
}

export interface TeamContribution {
  user_id: number;
  name: string;
  role?: "leader" | "member";
  meeting_aggregate: number | null;
  task_score: number | null;
  composite_score: number | null;
  // 레이더(출석·참여도 축)용 — 산정 포함 회의의 ① 비율 단순 평균 (0~1)
  attendance_avg?: number | null;
  speech_avg?: number | null;
}

export interface CurrentUser {
  id: number;
  name: string;
  kakao_email: string | null;
  university: string | null;
  department: string | null;
  profile_image_url: string | null;
  email_opt_out?: boolean;
}

export type AttendanceStatus = "present" | "late" | "absent" | "excused";

export interface AttendanceMember {
  user_id: number;
  name: string;
  profile_image_url: string | null;
  status: AttendanceStatus;
  joined_at: string | null;
  late_minutes: number | null;
  absence: {
    id: number;
    reason: string;
    status: "pending" | "approved" | "rejected";
    consent_count: number;
    my_consent: boolean;
  } | null;
}

export interface MeetingAttendance {
  meeting_id: number;
  consent_required: number;
  members: AttendanceMember[];
}

// 회의 목록 사이드바용 요약 — 내 출결 + 미처리 동의 수
export interface AttendanceSummary {
  meeting_id: number;
  my_status: AttendanceStatus;
  pending_count: number;
  attended_count: number;
}

export interface PendingConsent {
  absence_id: number;
  meeting_id: number;
  meeting_topic: string;
  user_name: string;
  reason: string;
  created_at: string;
}

// 기여도 집계 규칙 (서버 team_settings 엔티티 대응)
export interface TeamSettings {
  team_id: number;
  punctuality_grace_ratio: number;
  presence_grace_seconds: number;
  max_utterance_chars: number;
  deadline_penalty_curve: "standard" | "lenient" | "strict";
  absent_meeting_handling: "exclude" | "zero" | "attendance_only";
  min_meeting_minutes: number;
  final_task_weight: number;
  leader_bonus_multiplier: number;
  contribution_visibility: "team" | "leader" | "self";
  late_threshold_minutes: number;
}

export interface TeamDetail extends Team {
  members: TeamMember[];
  settings?: TeamSettings | null;
}

export interface TranscriptGroup {
  user_id: number;
  agenda_id: number | null;
  text: string;
  started_at_offset_ms: number;
  ended_at_offset_ms: number;
  is_short: boolean;
  utterance_ids: number[];
}

export interface TranscriptSection {
  agenda_id: number;
  title: string;
  status: string;
  summary: string | null;
  groups: TranscriptGroup[];
}

export interface Transcript {
  meeting_id: number;
  sections: TranscriptSection[];
}

export interface Notification {
  id: number;
  type: "meeting_soon" | "action_assigned" | "meeting_confirmed";
  title: string;
  body: string | null;
  meeting_id: number | null;
  action_item_id: number | null;
  read: boolean;
  created_at: string;
}
