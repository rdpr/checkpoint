import { version } from '../shared/version';
import { useEffect, useRef, useState, useId, type ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { MoreHorizontal } from 'lucide-react';
import { Dialog } from '@base-ui/react/dialog';
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
  const opener = useRef<HTMLElement | null>(
    document.activeElement as HTMLElement,
  );
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop forceRender className="modal-backdrop dialog-backdrop" />
        <Dialog.Popup
          className="modal"
          aria-label={title}
          finalFocus={() => {
            const target = opener.current;
            if (target?.getClientRects().length) return target;
            const triggerId = target
              ?.closest('[data-action-trigger]')
              ?.getAttribute('data-action-trigger');
            return triggerId ? document.getElementById(triggerId) : false;
          }}
        >
          <div className="modal-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <button
              type="button"
              className="icon-button"
              aria-label="Close dialog"
              onClick={onClose}
            >
              <X size={20} />
            </button>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function SettingsPage({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <section className="settings-page" aria-label={title}>
      <div className="settings-content">
        <button className="text-button" onClick={onClose}>
          ← Back to workspace
        </button>
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        {children}
      </div>
    </section>
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
    <div className="brand" title={`Checkpoint v${version}`}>
      <img className="brand-light" src="/brand/lockup-light.svg" alt="Checkpoint" width="190" height="40" />
      <img className="brand-dark" src="/brand/lockup-dark.svg" alt="Checkpoint" width="190" height="40" />
    </div>
  );
}

export function Sidebar({
  children,
  mobile,
  onClose,
}: {
  children: ReactNode;
  mobile: boolean;
  onClose: () => void;
}) {
  if (!mobile) return <aside className="sidebar">{children}</aside>;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="sidebar mobile-navigation">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <button
            className="icon-button drawer-close"
            aria-label="Close navigation"
            onClick={onClose}
          >
            <X size={20} />
          </button>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ReviewPanel({
  children,
  title = 'Artifact discussion',
  mobile,
  open,
  onClose,
}: {
  children: ReactNode;
  title?: string;
  mobile: boolean;
  open: boolean;
  onClose: () => void;
}) {
  if (!mobile) return <aside className="review-panel">{children}</aside>;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal keepMounted>
        <Dialog.Backdrop className="modal-backdrop" />
        <Dialog.Popup className="review-panel mobile-discussions">
          <div className="sheet-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <button className="text-button" onClick={onClose}>
              Return to artifact
            </button>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ActionPopover({
  label,
  children,
  icon,
}: {
  label: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const triggerId = useId();
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        id={triggerId}
        className="icon-button"
        aria-label={label}
        title={label}
      >
        {icon ?? <MoreHorizontal size={18} />}
      </Popover.Trigger>
      <Popover.Portal keepMounted>
        <Popover.Positioner
          className="choice-positioner"
          sideOffset={8}
          align="end"
        >
          <Popover.Popup
            className="action-popover"
            data-action-trigger={triggerId}
            onClick={(event) => {
              if ((event.target as Element).closest('button')) setOpen(false);
            }}
          >
            <Popover.Title className="sr-only">{label}</Popover.Title>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
