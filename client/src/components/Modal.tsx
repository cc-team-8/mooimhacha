import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}

export default function Modal({
  title,
  onClose,
  children,
  actions,
}: ModalProps) {
  return (
    <div
      className="modal-bg open"
      // e.target === e.currentTarget: 배경(.modal-bg)을 직접 클릭했을 때만 닫힘.
      // 모달 내부 클릭이 배경까지 버블링되어도 닫히지 않도록 함.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="modal">
        <div className="modal-ttl">
          {title}
          <button className="modal-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}
