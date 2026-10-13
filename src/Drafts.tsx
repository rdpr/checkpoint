import { useConfirm } from './Confirm';
import { useState } from 'react';
import { savedDrafts } from './drafts';
import { api, dateLabel, download, errorText } from './api';
import type { Artifact, User } from '../shared/types';
import { SettingsPage, ErrorMessage } from './ui';
export function Drafts({
  user,
  onClose,
  onOpen,
}: {
  user: User;
  onClose: () => void;
  onOpen: (workspaceId: string, artifactId: string, commentId?: string) => void;
}) {
  const confirm = useConfirm();
  const [items, setItems] = useState(() => {
    try {
      return savedDrafts(user.id);
    } catch {
      return [];
    }
  });
  const [error, setError] = useState<string | null>(null);
  const names: Record<string, string> = {
    'pw-draft': 'Artifact',
    'pw-comment-drafts': 'Unsent comments',
    'pw-review-draft': 'Review',
    'pw-request-draft': 'Review request',
    'pw-reply-draft': 'Reply',
    'pw-annotation-draft': 'Annotation edit',
    'pw-popover-draft': 'Selection comment',
    'pw-discussion-draft': 'Artifact discussion',
  };
  return (
    <SettingsPage title="Saved drafts" onClose={onClose}>
      <p className="muted">
        Drafts are saved in this browser, not synced to other devices.
      </p>
      <ErrorMessage message={error} />
      <ul className="search-results" aria-label="Saved drafts">
        {items.map((d) => {
          const [kind, , artifactId, commentId] = d.key.split(':');
          const value = d.value as {
            body?: string;
            note?: string;
            text?: string;
            message?: string;
          };
          const preview =
            typeof d.value === 'string'
              ? d.value
              : (value?.body ??
                value?.note ??
                value?.text ??
                value?.message ??
                'Unsent feedback');
          return (
            <li key={d.slot}>
              <article className="search-result">
                <strong>{names[kind] ?? 'Draft'} draft</strong>
                <small>Saved {dateLabel(d.updatedAt)}</small>
                <p className="result-preview">{preview.slice(0, 280)}</p>
                {kind === 'pw-popover-draft' && (
                  <p className="muted">
                    Reopen the same passage on its original revision to
                    continue. You can also download your text and attachment
                    references.
                  </p>
                )}
                <div className="button-row">
                  <button
                    className="button small-button"
                    onClick={async () => {
                      try {
                        const doc = await api<Artifact>(
                          `/artifacts/${artifactId}`,
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
                    className="text-button danger"
                    onClick={async () => {
                      if (await confirm('Discard this saved draft?')) {
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
            </li>
          );
        })}
        {!items.length && (
          <li className="list-empty">
            No saved drafts. Your unfinished edits and feedback will appear
            here.
          </li>
        )}
      </ul>
    </SettingsPage>
  );
}
