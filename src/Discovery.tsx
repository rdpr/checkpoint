import { useEffect, useState } from 'react';
import type {
  Document,
  SearchHit,
  Workspace,
  WorkspaceNotification,
  ReviewRequest,
} from '../shared/types';
import { api, post, errorText, dateLabel } from './api';
import { ErrorMessage, Modal, Loading } from './ui';

export function SearchDocuments({
  workspaces,
  onOpen,
  onClose,
}: {
  workspaces: Workspace[];
  onOpen: (workspaceId: string, documentId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [workspaceId, setWorkspace] = useState(''),
    [archived, setArchived] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    setHits([]);
    setError(null);
    setLoading(!!query.trim());
    const timer = setTimeout(() => {
      if (!query.trim()) return;
      const params = new URLSearchParams({
        query,
        includeArchived: String(archived),
      });
      if (workspaceId) params.set('workspaceId', workspaceId);
      api<SearchHit[]>(`/search?${params}`)
        .then((r) => {
          if (active) setHits(r);
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, workspaceId, archived]);
  return (
    <Modal title="Search documents" onClose={onClose}>
      <label>
        Search saved content and paths
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Words from a plan, decision, or filename"
          maxLength={200}
        />
      </label>
      <div className="discovery-controls">
        <label>
          Workspace
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="">All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Include archived
        </label>
      </div>
      <p className="small muted">
        Searches the latest saved Markdown. All words must match; partial words
        are supported. Up to 100 results.
      </p>
      <ErrorMessage message={error} />
      {loading ? (
        <Loading label="Searching…" />
      ) : (
        <div className="search-results">
          {hits.map((h) => (
            <button
              className="search-result"
              key={h.id}
              onClick={() => onOpen(h.workspaceId, h.id)}
            >
              <strong>
                {h.path}
                {h.archivedAt ? ' · Archived' : ''}
              </strong>
              <small>{h.workspaceName}</small>
              <p>{h.snippet}</p>
            </button>
          ))}
          {query.trim() && !hits.length && !error && (
            <p className="muted">No matching documents.</p>
          )}
        </div>
      )}
    </Modal>
  );
}
export function Notifications({
  onOpen,
  onRequest,
  onClose,
  onCount,
}: {
  onOpen: (workspaceId: string, documentId: string, commentId?: string) => void;
  onRequest: (request: ReviewRequest) => void;
  onClose: () => void;
  onCount: (count: number) => void;
}) {
  const [items, setItems] = useState<WorkspaceNotification[]>([]),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () =>
      api<{ items: WorkspaceNotification[]; unreadCount: number }>(
        '/notifications',
      )
        .then((r) => {
          if (active) {
            setItems(r.items);
            onCount(r.unreadCount);
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        });
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function open(n: WorkspaceNotification) {
    setBusy(true);
    setError(null);
    try {
      const request = n.requestId
        ? await api<ReviewRequest>(`/review-requests/${n.requestId}`)
        : null;
      const next = await post<{
        items: WorkspaceNotification[];
        unreadCount: number;
      }>('/notifications/read', { id: n.id });
      onCount(next.unreadCount);
      if (request) onRequest(request);
      else onOpen(n.workspaceId, n.documentId, n.commentId ?? undefined);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Notifications" onClose={onClose}>
      <p className="muted">
        Review requests, outcomes, and replies in discussions you’ve joined.
      </p>
      <ErrorMessage message={error} />
      {!!items.length && (
        <button
          className="text-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{
                items: WorkspaceNotification[];
                unreadCount: number;
              }>('/notifications/read', { throughId: items[0].id });
              setItems(r.items);
              onCount(r.unreadCount);
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Mark all as read
        </button>
      )}
      <div className="search-results">
        {items.map((n) => (
          <button
            disabled={busy}
            className={`search-result ${n.readAt ? '' : 'unread'}`}
            key={n.id}
            onClick={() => void open(n)}
          >
            <strong>
              {!n.readAt ? '● ' : ''}
              {n.actorName}{' '}
              {
                {
                  reply: 'replied',
                  review_requested: 'requested your review',
                  approved: 'approved your review request',
                  changes_requested: 'requested changes',
                  withdrawn: 'withdrew their review',
                }[n.kind]
              }
            </strong>
            <small>
              {n.workspaceName} · {n.path} · {dateLabel(n.createdAt)}
            </small>
            {n.preview && <p>{n.preview}</p>}
          </button>
        ))}
        {!items.length && !error && (
          <p className="muted">You’re all caught up.</p>
        )}
      </div>
    </Modal>
  );
}
export function DocumentActions({
  doc,
  onChanged,
}: {
  doc: Document;
  onChanged: (doc: Document) => void;
}) {
  const [open, setOpen] = useState(false),
    [path, setPath] = useState(doc.path),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  // Keep the displayed snapshot while this dialog is open so concurrent changes conflict.
  const [snapshot, setSnapshot] = useState(doc);
  async function save(archive?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<Document>(`/documents/${doc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          expectedRevisionId: snapshot.currentRevisionId,
          expectedMetadataVersion: snapshot.metadataVersion,
          ...(archive === undefined ? { path } : { archived: archive }),
        }),
      });
      onChanged(next);
      setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="text-button"
        onClick={() => {
          setSnapshot(doc);
          setPath(doc.path);
          setError(null);
          setOpen(true);
        }}
      >
        Manage document
      </button>
      {open && (
        <Modal title="Manage document" onClose={() => setOpen(false)}>
          <ErrorMessage message={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Document path
              <input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required
                maxLength={240}
              />
            </label>
            <p className="small muted">
              Rename or move within this workspace using a relative .md path,
              such as plans/launch.md. Links to this document and its history
              stay intact.
            </p>
            <button
              className="button"
              disabled={busy || path === snapshot.path}
            >
              Save path
            </button>
          </form>
          <hr />
          <h3>
            {doc.archivedAt ? 'Restore from archive' : 'Archive document'}
          </h3>
          <p className="muted">
            Archived documents remain readable, with their history and
            discussions. Editing and pending review requests pause until you
            unarchive.
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={() => void save(!doc.archivedAt)}
          >
            {doc.archivedAt ? 'Unarchive document' : 'Archive document'}
          </button>
        </Modal>
      )}
    </>
  );
}
