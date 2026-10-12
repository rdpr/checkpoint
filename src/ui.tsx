import { version } from '../shared/version';
import { useEffect, useRef, type ReactNode } from 'react';
import { X, AlertCircle, Loader2 } from 'lucide-react';

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={onClose}
      className="modal"
      aria-label={title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <div className="error-message" role="alert">
      <AlertCircle size={17} />
      <span>{message}</span>
    </div>
  ) : null;
}
export function Loading({ label = 'Loading workspace…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Loader2 size={20} className="spin" />
      {label}
    </div>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        c<span>·</span>
      </span>
      <span>
        Checkpoint<span className="brand-sub">v{version}</span>
      </span>
    </div>
  );
}
