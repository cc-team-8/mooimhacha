import { useState } from "react";
import { motion } from "framer-motion";
import type { TeamMember } from "@/lib/types";
import type { ContributionScoreLive } from "@/lib/ws";
import { memberColor } from "@/lib/avatarColor";

interface Props {
  scores: ContributionScoreLive[];
  members: TeamMember[];
  speaking: Set<number>;
  myUserId?: number | null;
}

export default function ContributionBar({
  scores,
  members,
  speaking,
  myUserId,
}: Props) {
  const [collapsed, setCollapsed] = useState(true);

  const nameOf = (id: number) => {
    const m = members.find((m) => m.user_id === id);
    return m ? (m.nickname ?? m.name) : `사용자 ${id}`;
  };
  const memberIdx = (id: number) => {
    const i = members.findIndex((m) => m.user_id === id);
    return i < 0 ? id % 32 : i;
  };

  const byUser = new Map(scores.map((s) => [s.user_id, s]));
  const allRows = members
    .map(
      (m) =>
        byUser.get(m.user_id) ?? {
          user_id: m.user_id,
          char_count: 0,
          ratio: 0,
        },
    )
    .sort((a, b) => b.ratio - a.ratio);

  const rows =
    collapsed && myUserId != null
      ? allRows.filter((r) => r.user_id === myUserId)
      : allRows;

  return (
    <section className="cmp-section cmp-contrib">
      <header
        className="cmp-section__head cmp-section__head--toggle"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? "전체 보기" : "접기"}
      >
        <h2>
          발언 비중
          <span
            className="cmp-info info-tip"
            data-tip="발언 글자수 기반 추정치입니다."
          >
            ⓘ
          </span>
        </h2>
        <span className="cmp-toggle-btn">
          <i className={`ti ti-chevron-${collapsed ? "down" : "up"}`} />
        </span>
      </header>
      <div className="cmp-bars">
        {rows.map((row) => (
          <div className="cmp-bar-row" key={row.user_id}>
            <span className="cmp-bar-name" data-tooltip={nameOf(row.user_id)}>
              {speaking.has(row.user_id) && <span className="cmp-mic">🎤</span>}
              <span className="cmp-bar-name-text">{nameOf(row.user_id)}</span>
            </span>
            <div className="cmp-bar-track">
              <motion.div
                className="cmp-bar-fill"
                style={{
                  background: memberColor(memberIdx(row.user_id)),
                }}
                initial={false}
                animate={{ width: `${Math.round(row.ratio * 100)}%` }}
                transition={{ type: "spring", stiffness: 120, damping: 20 }}
              />
            </div>
            <span className="cmp-bar-count">{row.char_count}자</span>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="cmp-empty">아직 발언이 없습니다.</p>
        )}
      </div>
    </section>
  );
}
