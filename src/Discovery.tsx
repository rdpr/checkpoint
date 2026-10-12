import { artifactLocation } from './api';
import { FolderPicker, pathInFolder } from './Folders';
import { Select } from './Select';
import { useEffect, useState } from 'react';
import type {
  Catalog,
  Artifact,
  SearchHit,
  Workspace,
  WorkspaceNotification,
  ReviewRequest,
} from '../shared/types';
import { api, post, errorText, dateLabel } from './api';
import { SettingsPage, ErrorMessage, Modal, Loading } from './ui';

export function SearchArtifacts({
  workspaces,
  initialWorkspaceId = '',
  onOpen,
  onClose,
}: {
  workspaces: Workspace[];
  initialWorkspaceId?: string;
  onOpen: (workspaceId: string, artifactId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(''),
    [workspaceId, setWorkspace] = useState(initialWorkspaceId),
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
    <Modal title="Search artifacts" onClose={onClose}>
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
          <Select
            searchable
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
          </Select>
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
        <ul className="search-results" aria-label="Search results">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                className="search-result"
                onClick={() => onOpen(h.workspaceId, h.id)}
              >
                <strong>
                  {artifactLocation(h.path)}
                  {h.archivedAt ? ' · Archived' : ''}
                </strong>
                <small>{h.workspaceName}</small>
                <p className="result-preview">{h.snippet}</p>
              </button>
            </li>
          ))}
          {query.trim() && !hits.length && !error && (
            <li className="list-empty">
              No matching artifacts. Try another name or phrase.
            </li>
          )}
        </ul>
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
  onOpen: (workspaceId: string, artifactId: string, commentId?: string) => void;
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
      else onOpen(n.workspaceId, n.artifactId, n.commentId ?? undefined);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <SettingsPage title="Notifications" onClose={onClose}>
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
      <ul className="search-results" aria-label="Notifications">
        {items.map((n) => (
          <li key={n.id}>
            <button
              disabled={busy}
              className={`search-result ${n.readAt ? '' : 'unread'}`}
              onClick={() => void open(n)}
            >
              <strong>
                {!n.readAt && (
                  <span className="notification-unread" aria-label="Unread">
                    ●{' '}
                  </span>
                )}
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
                {n.workspaceName} · {artifactLocation(n.path)} ·{' '}
                {dateLabel(n.createdAt)}
              </small>
              {n.preview && <p className="result-preview">{n.preview}</p>}
            </button>
          </li>
        ))}
        {!items.length && !error && (
          <li className="list-empty">
            You’re all caught up. New requests, replies, and review outcomes
            will appear here.
          </li>
        )}
      </ul>
    </SettingsPage>
  );
}
export function ArtifactActions({
  doc,
  onChanged,
}: {
  doc: Artifact;
  onChanged: (doc: Artifact) => void;
}) {
  const [open, setOpen] = useState(false),
    [name, setName] = useState(
      doc.path.split('/').pop()!.replace(/\.md$/i, ''),
    ),
    [folderId, setFolderId] = useState(doc.folderId),
    [catalog, setCatalog] = useState<Catalog | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  // Keep the displayed snapshot while this dialog is open so concurrent changes conflict.
  const [snapshot, setSnapshot] = useState(doc);
  const path = catalog
    ? pathInFolder(catalog.folders, folderId, name)
    : doc.path;
  async function save(archive?: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await api<Artifact>(`/artifacts/${doc.id}`, {
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
        onClick={async () => {
          setSnapshot(doc);
          setName(doc.path.split('/').pop()!.replace(/\.md$/i, ''));
          setFolderId(doc.folderId);
          setCatalog(null);
          setError(null);
          setOpen(true);
          try {
            setCatalog(
              await api<Catalog>(`/workspaces/${doc.workspaceId}/catalog`),
            );
          } catch (e) {
            setError(errorText(e));
          }
        }}
      >
        Manage artifact
      </button>
      {open && (
        <Modal title="Manage artifact" onClose={() => setOpen(false)}>
          <ErrorMessage message={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Artifact name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={120}
                pattern="[^/\\\\]+"
              />
            </label>
            {catalog && (
              <FolderPicker
                folders={catalog.folders}
                value={folderId}
                onChange={setFolderId}
              />
            )}
            <p className="small muted">
              Choose a name and folder. Links, discussions, and history stay
              intact.
            </p>
            <button
              className="button"
              disabled={busy || !catalog || path === snapshot.path}
            >
              Save changes
            </button>
          </form>
          <hr />
          <h3>
            {doc.archivedAt ? 'Restore from archive' : 'Archive artifact'}
          </h3>
          <p className="muted">
            Archived artifacts remain readable, with their history and
            discussions. Editing and pending review requests pause until you
            unarchive.
          </p>
          <button
            className="button"
            disabled={busy}
            onClick={() => void save(!doc.archivedAt)}
          >
            {doc.archivedAt ? 'Unarchive artifact' : 'Archive artifact'}
          </button>
        </Modal>
      )}
    </>
  );
}
