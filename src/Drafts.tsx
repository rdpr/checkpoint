import { useState } from 'react';
import { savedDrafts } from './drafts';
import { api, dateLabel, download, errorText } from './api';
import type { Document, User } from '../shared/types';
import { Modal, ErrorMessage } from './ui';
export function Drafts({
  user,
  onClose,
  onOpen,
}: {
  user: User;
  onClose: () => void;
  onOpen: (workspaceId: string, documentId: string, commentId?: string) => void;
}) {
  const [items, setItems] = useState(() => {
    try {
      return savedDrafts(user.id);
    } catch {
      return [];
    }
  });
  const [error, setError] = useState<string | null>(null);
  const names: Record<string, string> = {
    'pw-draft': 'Document',
    'pw-comment-drafts': 'Unsent comments',
    'pw-review-draft': 'Review',
    'pw-request-draft': 'Review request',
    'pw-reply-draft': 'Reply',
    'pw-annotation-draft': 'Annotation edit',
    'pw-popover-draft': 'Selection comment',
    'pw-discussion-draft': 'Document discussion',
  };
  return (
    <Modal title="Saved drafts" onClose={onClose}>
      <p className="muted">
        Saved in this browser for {user.name}. Drafts survive closing tabs, but
        do not sync to other devices. Concurrent drafts are kept separately.
      </p>
      <ErrorMessage message={error} />
      <div className="search-results">
        {items.map((d) => {
          const [kind, , documentId, commentId] = d.key.split(':');
          const value = d.value as {
            body?: string;
            note?: string;
            text?: string;
          };
          const preview =
            typeof d.value === 'string'
              ? d.value
              : (value?.body ??
                value?.note ??
                value?.text ??
                'Unsent feedback');
          return (
            <article className="search-result" key={d.slot}>
              <strong>
                {names[kind] ?? 'Draft'} · {dateLabel(d.updatedAt)}
              </strong>
              <p>{preview.slice(0, 180)}</p>
              {kind === 'pw-popover-draft' && (
                <p className="muted">
                  Reopen the same passage on its original revision to continue.
                  You can also download your text and attachment references.
                </p>
              )}
              <div className="button-row">
                <button
                  className="button small-button"
                  onClick={async () => {
                    try {
                      const doc = await api<Document>(
                        `/documents/${documentId}`,
                      );
                      sessionStorage.setItem('pw-selected-draft', d.slot);
                      onOpen(
                        doc.workspaceId,
                        doc.id,
                        kind === 'pw-reply-draft' ||
                          kind === 'pw-annotation-draft'
                          ? commentId
                          : undefined,
                      );
                    } catch (e) {
                      setError(errorText(e));
                    }
                  }}
                >
                  Resume draft
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    download(
                      'saved-draft.txt',
                      typeof d.value === 'string'
                        ? d.value
                        : JSON.stringify(d.value, null, 2),
                    )
                  }
                >
                  Download draft
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    if (confirm('Discard this saved draft?')) {
                      try {
                        localStorage.removeItem(d.slot);
                        setItems(savedDrafts(user.id));
                      } catch (e) {
                        setError(errorText(e));
                      }
                    }
                  }}
                >
                  Discard draft
                </button>
              </div>
            </article>
          );
        })}
        {!items.length && <p>No saved drafts.</p>}
      </div>
    </Modal>
  );
}
