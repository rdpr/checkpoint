import { useState } from 'react';
import type {
  Artifact,
  Revision,
  User,
  ReviewDecision,
  ReviewRequest,
} from '../shared/types';
import { currentDecisions, reviewStatus } from '../shared/review';
import { dateLabel, artifactLabel, relativeDate } from './api';
import { useReviewDraft } from './useReviewDraft';
import { ErrorMessage, Modal } from './ui';

export function ReviewStatus({
  doc,
  revision,
  user,
  canReview,
  request,
  onReadLatest,
  busy,
  onReview,
}: {
  doc: Artifact;
  revision: Revision;
  user: User;
  canReview: boolean;
  request: ReviewRequest | null;
  onReadLatest: () => void;
  busy: boolean;
  onReview: (
    revisionId: string,
    decision: ReviewDecision['decision'],
    note: string,
  ) => Promise<boolean>;
}) {
  const [draft, setDraft, storageError] = useReviewDraft<{
    revisionId: string;
    revisionNumber: number;
    note: string;
  } | null>(`pw-review-draft:${user.id}:${doc.id}`, null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [deferred, setDeferred] = useState(true);
  const awaitingOwnResponse =
    request?.status === 'waiting' &&
    request.reviewerId === user.id &&
    request.revisionId === revision.id;
  const reviews = doc.reviews.filter(
    (r) => r.revisionNumber <= revision.number,
  );
  const active = currentDecisions(reviews, revision.id);
  const own = active.find((r) => r.reviewerId === user.id);
  const status = reviewStatus(reviews, revision.id);
  const stale =
    draft &&
    (draft.revisionId !== doc.currentRevisionId ||
      draft.revisionId !== revision.id);
  async function submit(decision: ReviewDecision['decision']) {
    setSubmissionError(null);
    if (!draft) return;
    if (await onReview(draft.revisionId, decision, draft.note)) {
      setDraft((current) =>
        current?.revisionId === draft.revisionId && current.note === draft.note
          ? null
          : current,
      );
      setDeferred(true);
    } else
      setSubmissionError(
        'Your review was not submitted. Your note is kept. Check your connection and the current revision before trying again.',
      );
  }
  return (
    <section className="review-status" aria-label="Artifact review">
      <div className="review-status-heading">
        <h1>{artifactLabel(doc.path)}</h1>
        {((canReview && !draft) || (draft && deferred)) && (
          <button
            className="button primary small-button"
            onClick={() => {
              if (!draft)
                setDraft({
                  revisionId: revision.id,
                  revisionNumber: revision.number,
                  note: '',
                });
              setDeferred(false);
            }}
          >
            {draft
              ? 'Resume review draft'
              : awaitingOwnResponse && own
                ? 'Respond to this round'
                : own
                  ? 'Update your review'
                  : 'Finish review'}
          </button>
        )}
      </div>
      <div className="review-metadata">
        <strong
          className={`review-state ${status === 'Approved' ? 'review-approved' : status === 'Changes requested' ? 'review-changes' : ''}`}
        >
          {status}
        </strong>
        <span>Revision {revision.number}</span>
        <span>
          {request
            ? `Requested by ${request.agentName ?? request.requesterName}`
            : (revision.agentName ?? revision.authorName)}
        </span>
        <time
          dateTime={revision.createdAt}
          title={dateLabel(revision.createdAt)}
        >
          {relativeDate(revision.createdAt)}
        </time>
      </div>
      <ErrorMessage message={storageError} />
      {request && request.revisionId === revision.id && (
        <p className="round-status" role="status">
          {request.status === 'waiting'
            ? `This review round is waiting for ${request.reviewerId === user.id ? 'your response' : request.reviewerName + '’s response'}. Earlier decisions do not complete this round.`
            : request.status === 'approved' ||
                request.status === 'changes_requested'
              ? `This round is complete: ${request.reviewerName} ${request.status === 'approved' ? 'approved' : 'requested changes'}.`
              : request.status === 'superseded'
                ? 'This review round was replaced by a new round.'
                : request.status === 'cancelled'
                  ? 'This review round was cancelled.'
                  : 'This review round needs an eligible reviewer.'}
        </p>
      )}
      {draft && !deferred && (
        <Modal
          title={`Finish review · revision ${draft.revisionNumber}`}
          onClose={() => setDeferred(true)}
        >
          <p className="muted">
            Posted comments are already shared. This decision applies only to
            revision {draft.revisionNumber}.
          </p>
          <form
            className="review-decision-form"
            onSubmit={(e) => e.preventDefault()}
          >
            <small>
              Draft for revision {draft.revisionNumber} · kept in this browser
            </small>
            <ErrorMessage message={submissionError ?? storageError} />
            <label htmlFor="review-note">Review note (optional)</label>
            <textarea
              id="review-note"
              disabled={busy}
              rows={2}
              maxLength={10000}
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            {stale && (
              <p role="alert">
                Your note belongs to revision {draft.revisionNumber}. It is kept
                here and will not be submitted for another revision
                automatically.
                {revision.id !== doc.currentRevisionId ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={onReadLatest}
                  >
                    Read latest revision
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-button"
                    disabled={!canReview || busy}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        revisionId: revision.id,
                        revisionNumber: revision.number,
                      })
                    }
                  >
                    Use note for revision {revision.number}
                  </button>
                )}
              </p>
            )}
            {!canReview && (
              <p>
                {doc.archivedAt
                  ? 'Unarchive this artifact before submitting a review. Your note is kept.'
                  : 'Review the latest saved revision and save or discard any artifact draft before submitting.'}
              </p>
            )}
            <div className="button-row">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setDeferred(true)}
              >
                Keep draft for later
              </button>
              <button
                className="button primary small-button"
                disabled={busy || !!stale || !canReview}
                onClick={() => void submit('approved')}
              >
                Approve
              </button>
              <button
                className="button small-button"
                disabled={busy || !!stale || !canReview}
                onClick={() => void submit('changes_requested')}
              >
                Request changes
              </button>
              {own && (
                <button
                  className="text-button"
                  disabled={busy || !!stale || !canReview}
                  onClick={() => void submit('withdrawn')}
                >
                  Withdraw review
                </button>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                Discard review draft
              </button>
            </div>
            <small>
              Decisions apply only to the saved revision. Open discussions do
              not block approval.
            </small>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function ReviewActivity({
  doc,
  revision,
}: {
  doc: Artifact;
  revision: Revision;
}) {
  const reviews = doc.reviews.filter(
    (r) => r.revisionNumber <= revision.number,
  );
  return (
    <div className="review-activity">
      {' '}
      {!!reviews.length && (
        <details className="review-history">
          <summary>Review activity ({reviews.length})</summary>
          <p>
            Each reviewer’s latest decision on this revision counts. Any request
            for changes takes precedence; approval requires at least one
            approval. This is a recorded review, not an editing lock.
          </p>
          {[...reviews].reverse().map((r) => (
            <div className="review-entry" key={r.id}>
              <strong>
                {r.reviewerName} ·{' '}
                {r.decision === 'approved'
                  ? 'Approved'
                  : r.decision === 'changes_requested'
                    ? 'Requested changes'
                    : 'Withdrew review'}
              </strong>
              <small>
                Revision {r.revisionNumber} · {dateLabel(r.createdAt)}
              </small>
              {r.note && <p>{r.note}</p>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
