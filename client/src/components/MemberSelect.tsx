import { useState, useRef, useEffect } from "react";

interface Member {
  user_id: number;
  name: string;
}

interface MemberSelectProps {
  members: Member[];
  nicknameMap: Map<number, string>;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function MemberSelect({
  members,
  nicknameMap,
  value,
  onChange,
  placeholder = "미지정",
}: MemberSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = value
    ? members.find((m) => String(m.user_id) === value)
    : null;
  const displayName = selected
    ? (nicknameMap.get(selected.user_id) ?? selected.name)
    : null;
  const truncated =
    displayName && displayName.length > 9
      ? displayName.slice(0, 9) + "…"
      : displayName;

  return (
    <div className="ms-wrap" ref={ref}>
      <button
        type="button"
        className={`input ms-trigger${open ? " ms-open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title={displayName ?? undefined}
      >
        <span className={displayName ? "" : "ms-placeholder"}>
          {truncated ?? placeholder}
        </span>
        <i className={`ti ti-chevron-${open ? "up" : "down"} ms-chevron`} />
      </button>
      {open && (
        <div className="ms-list">
          <div
            className={`ms-item${!value ? " ms-selected" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            {placeholder}
          </div>
          {members.map((m) => {
            const name = nicknameMap.get(m.user_id) ?? m.name;
            const isSelected = String(m.user_id) === value;
            return (
              <div
                key={m.user_id}
                className={`ms-item${isSelected ? " ms-selected" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(String(m.user_id));
                  setOpen(false);
                }}
              >
                {name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
