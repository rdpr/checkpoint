import { artifactLocation } from './api';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';
import { Select } from './Select';
import { useEffect, useState } from 'react';
import type { ReviewRequest, Reviewer, Revision, User } from '../shared/types';
import {
  api,
  post,
  dateLabel,
  errorText,
  initials,
  artifactLabel,
  relativeDate,
} from './api';
import { ErrorMessage, Loading, Modal } from './ui';
import { useReviewDraft } from './useReviewDraft';

function requestLabel(r: ReviewRequest) {
  if (r.status === 'waiting')
    return r.outdated ? 'Outdated · awaiting renewal' : 'Waiting for review';
  return {
    artifact_archived: 'Artifact archived',
    approved: 'Approved',
    changes_requested: 'Changes requested',
    cancelled: 'Cancelled',
    superseded: 'Replaced by a new round',
    reviewer_unavailable: 'Reviewer no longer eligible',
  }[r.status];
}

function useRequests(
  workspaceId: string,
  artifactId?: string,
  refreshKey?: number,
) {
  const [requests, setRequests] = useState<ReviewRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, refresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await api<ReviewRequest[]>(
          artifactId
            ? `/artifacts/${artifactId}/review-requests`
            : workspaceId
              ? `/workspaces/${workspaceId}/review-requests`
              : '/my-reviews',
        );
        if (active) {
          setRequests(next);
          setError(null);
          setLoading(false);
        }
      } catch (e) {
        if (active) {
          setRequests([]);
          setError(errorText(e));
          setLoading(false);
        }
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [workspaceId, artifactId, refreshKey, generation]);
  return { requests, error, loading, refresh: () => refresh((n) => n + 1) };
}

export function RequestCard({
  request: r,
  onOpen,
  onChanged,
}: {
  request: ReviewRequest;
  onOpen: (r: ReviewRequest) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function act(kind: 'renew' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      await post<ReviewRequest>(`/review-requests/${r.id}/${kind}`, {
        expectedVersion: r.version,
        ...(kind === 'renew'
          ? { expectedRevisionId: r.currentRevisionId }
          : {}),
      });
      onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article
      className="request-card"
      aria-label={`Review request for ${r.path}`}
    >
      <div className="request-heading">
        <strong>
          {r.workspaceName ? `${r.workspaceName} › ` : ''}
          {artifactLocation(r.path)}
        </strong>
        <span className="pill">{requestLabel(r)}</span>
      </div>
      <p>
        Revision {r.revisionNumber} · {r.reviewerName}
      </p>
      <small>
        Requested by{' '}
        {r.agentName
          ? `${r.agentName} (for ${r.requesterName})`
          : r.requesterName}{' '}
        · {dateLabel(r.createdAt)}
      </small>
      {r.status === 'waiting' && (
        <p className="round-status">
          This round needs a new response from {r.reviewerName}. Earlier
          decisions do not complete it.
        </p>
      )}
      {r.message && <p className="request-message">{r.message}</p>}
      {r.outdated && (
        <p className="anchor-note">
          The artifact has newer changes. This request still refers to revision{' '}
          {r.revisionNumber}.
        </p>
      )}
      {r.decision && r.decision.decision !== 'withdrawn' && (
        <p className="request-message">
          {r.decision.reviewerName}:{' '}
          {r.decision.note ||
            (r.decision.decision === 'approved'
              ? 'Approved this revision.'
              : 'Requested changes.')}
        </p>
      )}
      {r.status === 'reviewer_unavailable' && (
        <p>Cancel this request and choose a current editor or owner.</p>
      )}
      {r.cancelledAt && (
        <small>
          Cancelled by {r.cancelledBy} · {dateLabel(r.cancelledAt)}
        </small>
      )}
      <ErrorMessage message={error} />
      <div className="button-row">
        <button className="button small-button" onClick={() => onOpen(r)}>
          Open requested revision
        </button>
        {r.canManage && !r.cancelledAt && !r.supersededBy && (
          <>
            {r.status !== 'reviewer_unavailable' &&
              (r.outdated ||
                r.status === 'approved' ||
                r.status === 'changes_requested') && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void act('renew')}
                >
                  {r.outdated
                    ? 'Request latest revision'
                    : 'Request review again'}
                </button>
              )}
            {(r.status === 'waiting' ||
              r.status === 'reviewer_unavailable') && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void act('cancel')}
              >
                Cancel request
              </button>
            )}
          </>
        )}
      </div>
    </article>
  );
}

export function MyReviews({
  workspaceId,
  user,
  onOpen,
}: {
  workspaceId: string;
  user: User;
  onOpen: (r: ReviewRequest) => void;
}) {
  const { requests, error, loading, refresh } = useRequests(workspaceId);
  const [tab, setTab] = useState<'waiting' | 'requested' | 'completed'>(
    'waiting',
  );
  const [filter, setFilter] = useState('');
  const waiting = requests.filter(
    (r) => r.reviewerId === user.id && r.status === 'waiting',
  );
  const visible = requests
    .filter((r) => !filter || r.workspaceId === filter)
    .filter((r) =>
      tab === 'waiting'
        ? r.reviewerId === user.id && r.status === 'waiting'
        : tab === 'requested'
          ? r.requesterId === user.id &&
            ['waiting', 'reviewer_unavailable'].includes(r.status)
          : (r.reviewerId === user.id || r.requesterId === user.id) &&
            !['waiting', 'reviewer_unavailable'].includes(r.status),
    );
  return (
    <section className="workspace-home review-queue">
      <div className="home-title">
        <div>
          <h1>My reviews</h1>
          <p>
            {waiting.length
              ? `${waiting.length} ${waiting.length === 1 ? 'review is' : 'reviews are'} waiting on you.`
              : 'You’re up to date.'}{' '}
            Across all your workspaces.
          </p>
        </div>
      </div>
      <div className="queue-controls">
        <label>
          <span className="sr-only">Filter workspace</span>
          <Select
            searchable
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="">All workspaces</option>
            {[
              ...new Map(
                requests.map((r) => [r.workspaceId, r.workspaceName]),
              ).entries(),
            ].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <div className="queue-tabs" aria-label="Review queue">
          <button
            aria-pressed={tab === 'waiting'}
            className={tab === 'waiting' ? 'active' : ''}
            onClick={() => setTab('waiting')}
          >
            Waiting on me <span>{waiting.length}</span>
          </button>
          <button
            aria-pressed={tab === 'requested'}
            className={tab === 'requested' ? 'active' : ''}
            onClick={() => setTab('requested')}
          >
            Requested by me
          </button>
          <button
            aria-pressed={tab === 'completed'}
            className={tab === 'completed' ? 'active' : ''}
            onClick={() => setTab('completed')}
          >
            Completed
          </button>
        </div>
      </div>
      <ErrorMessage message={error} />
      {loading ? (
        <Loading label="Loading review requests…" />
      ) : visible.length ? (
        <div className="request-list">
          <div className="request-table-heading" aria-hidden="true">
            <span>Artifact</span>
            <span>Review state</span>
            <span>{tab === 'waiting' ? 'Requested by' : 'Reviewer'}</span>
            <span>Requested</span>
            <span />
          </div>
          {visible.map((r) => (
            <div className="request-row" key={r.id}>
              <button
                onClick={() => onOpen(r)}
                aria-label={`Open requested revision of ${r.path}`}
              >
                <strong>{artifactLabel(r.path)}</strong>
                <small>
                  {r.workspaceName} › {artifactLocation(r.path)}
                </small>
              </button>
              <span
                className={`pill request-state state-${r.outdated && r.status === 'waiting' ? 'outdated' : r.status}`}
              >
                {requestLabel(r)}
              </span>
              <span className="request-person">
                <span className="avatar">
                  {initials(
                    tab === 'waiting'
                      ? (r.agentName ?? r.requesterName)
                      : r.reviewerName,
                  )}
                </span>
                <small>
                  {tab === 'waiting'
                    ? (r.agentName ?? r.requesterName)
                    : r.reviewerName}{' '}
                  · r{r.revisionNumber}
                </small>
              </span>
              <time dateTime={r.createdAt} title={dateLabel(r.createdAt)}>
                {relativeDate(r.createdAt)}
              </time>
              <details>
                <summary
                  aria-label="Request details and actions"
                  title="Request details and actions"
                >
                  <MoreHorizontal size={18} />
                </summary>
                <RequestCard request={r} onOpen={onOpen} onChanged={refresh} />
              </details>
            </div>
          ))}
          <div className="request-table-footer">
            <span>
              {visible.length} {visible.length === 1 ? 'request' : 'requests'}
            </span>
          </div>
        </div>
      ) : (
        !error && (
          <p className="list-empty">
            {filter
              ? 'No review requests match this workspace filter.'
              : tab === 'waiting'
                ? 'You’re caught up. No reviews waiting on you.'
                : tab === 'completed'
                  ? 'No completed review rounds yet.'
                  : 'No review requests from you yet.'}
          </p>
        )
      )}
    </section>
  );
}

export function ArtifactRequests({
  contextTarget,
  artifactId,
  user,
  onReadLatest,
  workspaceId,
  revision,
  currentRevisionId,
  canRequest,
  refreshKey,
  onOpen,
}: {
  contextTarget?: HTMLElement | null;
  artifactId: string;
  user: User;
  onReadLatest: () => void;
  workspaceId: string;
  revision: Revision;
  currentRevisionId: string;
  canRequest: boolean;
  refreshKey: number;
  onOpen: (r: ReviewRequest) => void;
}) {
  const { requests, error, refresh } = useRequests(
    workspaceId,
    artifactId,
    refreshKey,
  );
  const [draft, setDraft, storageError] = useReviewDraft<{
    revision: Pick<Revision, 'id' | 'number'>;
    reviewerId: string;
    message: string;
  } | null>(`pw-request-draft:${user.id}:${artifactId}`, null);
  const [formOpen, setFormOpen] = useState(false);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  async function start() {
    if (!draft)
      setDraft({
        revision: { id: revision.id, number: revision.number },
        reviewerId: '',
        message: '',
      });
    setFormOpen(true);
    setFormError(null);
    setReviewers([]);
    try {
      setReviewers(
        await api<Reviewer[]>(`/workspaces/${workspaceId}/reviewers`),
      );
    } catch (e) {
      setFormError(errorText(e));
    }
  }
  const context = requests.find(
    (r) =>
      r.reviewerId === user.id &&
      r.revisionId === revision.id &&
      r.status === 'waiting',
  );
  return (
    <section className="artifact-requests" aria-label="Review requests">
      {contextTarget &&
        context &&
        createPortal(
          <div className="review-invitation">
            <span className="avatar">
              {initials(context.agentName ?? context.requesterName)}
            </span>
            <div>
              <strong>
                {context.agentName ?? context.requesterName} requested your
                review.
              </strong>
              {context.message && <p>“{context.message}”</p>}
            </div>
          </div>,
          contextTarget,
        )}
      <div className="request-heading">
        <button
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          Review requests ({requests.length})
        </button>
        {(canRequest || draft) && (
          <button className="button small-button" onClick={() => void start()}>
            {draft ? 'Resume request draft' : 'Request review'}
          </button>
        )}
      </div>
      <ErrorMessage message={error} />
      {expanded && (
        <div className="request-list">
          {requests.length ? (
            requests.map((r) => (
              <RequestCard
                key={r.id}
                request={r}
                onOpen={onOpen}
                onChanged={refresh}
              />
            ))
          ) : (
            <p className="muted">No review requests for this artifact.</p>
          )}
        </div>
      )}
      <ErrorMessage message={storageError} />
      {draft && formOpen && (
        <Modal title="Request review" onClose={() => setFormOpen(false)}>
          <form
            className="request-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                busy ||
                !canRequest ||
                draft.revision.id !== currentRevisionId
              )
                return;
              setBusy(true);
              setFormError(null);
              try {
                await post(`/artifacts/${artifactId}/review-requests`, {
                  expectedRevisionId: draft.revision.id,
                  reviewerId: draft.reviewerId,
                  message: draft.message,
                });
                setDraft((current) =>
                  current?.revision.id === draft.revision.id &&
                  current.reviewerId === draft.reviewerId &&
                  current.message === draft.message
                    ? null
                    : current,
                );
                setFormOpen(false);
                setExpanded(true);
                refresh();
              } catch (e) {
                setFormError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <p>Request a review of revision {draft.revision.number}.</p>
            <label>
              Reviewer
              <Select
                searchable
                aria-label="Reviewer"
                required
                disabled={busy}
                value={draft.reviewerId}
                onChange={(e) =>
                  setDraft({ ...draft, reviewerId: e.target.value })
                }
              >
                <option value="" disabled>
                  Choose a reviewer
                </option>
                {reviewers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.role === 'owner' ? ' (owner)' : ''}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              Review message (optional)
              <textarea
                rows={3}
                disabled={busy}
                maxLength={5000}
                value={draft.message}
                onChange={(e) =>
                  setDraft({ ...draft, message: e.target.value })
                }
              />
            </label>
            {draft.revision.id !== currentRevisionId && (
              <p role="alert">
                A newer revision is available. Your message and reviewer are
                kept for revision {draft.revision.number}.
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setFormOpen(false);
                    onReadLatest();
                  }}
                >
                  Read latest revision
                </button>
                {revision.id === currentRevisionId && canRequest && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        revision: {
                          id: revision.id,
                          number: revision.number,
                        },
                      })
                    }
                  >
                    Use request for revision {revision.number}
                  </button>
                )}
              </p>
            )}
            <small>
              Draft kept in this browser when you close this dialog.
            </small>
            <ErrorMessage message={storageError} />
            <ErrorMessage message={formError} />
            <button
              className="button primary"
              disabled={
                busy ||
                !draft.reviewerId ||
                !canRequest ||
                draft.revision.id !== currentRevisionId
              }
            >
              Send review request
            </button>
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setFormOpen(false);
              }}
            >
              Discard request draft
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
