import { PopoverDraftScope } from './popoverDrafts';
import { readDraft, writeDraft } from './drafts';
import { DocumentActions } from './Discovery';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  BookOpen,
  Pencil,
  GitCompareArrows,
  MessageSquare,
  History,
  Check,
  ArrowUpRight,
  ArrowLeft,
  RotateCcw,
  Download,
  Save,
  Send,
  Link as LinkIcon,
  Bot,
} from 'lucide-react';
import type { AnnotationRestoreReport } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import { currentDecisions } from '../shared/review';
import type { Comparison } from './RevisionDiff';
import { AnnotationType, type Annotation } from '@plannotator/ui/types';
import type {
  Document,
  Comment,
  Revision,
  User,
  Workspace,
  ReviewRequest,
} from '../shared/types';
import {
  api,
  post,
  ApiError,
  errorText,
  dateLabel,
  initials,
  download,
} from './api';
import { ErrorMessage, Loading } from './ui';
import { DocumentRequests } from './ReviewRequests';
import { ReviewStatus } from './ReviewStatus';
import { useReviewDraft } from './useReviewDraft';
import type { z } from 'zod';
import type { addComment as commentSchema } from '../server/schemas';
import type { ReviewPreferences } from './reviewPreferences';

const ReviewSettings = lazy(() => import('./ReviewSettings'));
const RevisionDiff = lazy(() => import('./RevisionDiff'));
const Surface = lazy(() => import('./PlannotatorSurface'));
type PendingComment = {
  revisionNumber: number;
  payload: z.infer<typeof commentSchema>;
};
type Draft = { body: string; baseRevisionId: string; baseBody: string };

export function DocumentView({
  id,
  user,
  workspace,
  preferences,
  updatePreferences,
  preferenceError,
  onSaved,
  onLink,
  requestId,
  onOpenRequest,
}: {
  id: string;
  requestId: string | null;
  onOpenRequest: (request: ReviewRequest) => void;
  user: User;
  workspace: Workspace;
  preferences: ReviewPreferences;
  updatePreferences: (patch: Partial<ReviewPreferences>) => void;
  preferenceError: string | null;
  onSaved: () => void;
  onLink: (path: string, revisionId: string) => void;
}) {
  const [pendingComments, setPendingComments, commentStorageError] =
    useReviewDraft<PendingComment[]>(`pw-comment-drafts:${user.id}:${id}`, []);
  const [discussionDraft, setDiscussionDraft, discussionStorageError] =
    useReviewDraft<{
      body: string;
      revisionId: string;
      revisionNumber: number;
    } | null>(`pw-discussion-draft:${user.id}:${id}`, null);
  const [popoverStorageError, setPopoverStorageError] = useState<string | null>(
    null,
  );
  useEffect(() => {
    const failed = () =>
      setPopoverStorageError(
        'Browser draft storage is unavailable. Keep this tab open and copy unsaved feedback before leaving.',
      );
    window.addEventListener('pw:draft-error', failed);
    return () => window.removeEventListener('pw:draft-error', failed);
  }, []);
  const savingComments = useRef(new Set<string>());
  const requestedViewLoaded = useRef(false);
  const [requestLoading, setRequestLoading] = useState(!!requestId);
  const [focusedRequest, setFocusedRequest] = useState<ReviewRequest | null>(
    null,
  );
  const [requestRevision, setRequestRevision] = useState<Revision | null>(null);
  const [doc, setDoc] = useState<Document | null>(null),
    [comments, setComments] = useState<Comment[]>([]),
    [revisions, setRevisions] = useState<Omit<Revision, 'body'>[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null),
    draftRef = useRef<Draft | null>(null);
  const [mode, setMode] = useState<'read' | 'edit' | 'compare'>('read'),
    [tab, setTab] = useState<'comments' | 'history'>('comments');
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [reattaching, setReattaching] = useState<{
    comment: Comment;
    revisionId: string;
  } | null>(null);
  const [historical, setHistorical] = useState<Revision | null>(null),
    [selected, setSelected] = useState<string | null>(() =>
      new URLSearchParams(location.search).get('comment'),
    );
  const [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [copied, setCopied] = useState(false);
  const [feedbackCopied, setFeedbackCopied] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const { reviewMode, inputMethod, showResolved, layout } = preferences;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contentsOpen, setContentsOpen] = useState(false);
  const contentsButtonRef = useRef<HTMLButtonElement>(null);
  function closeContents() {
    setContentsOpen(false);
    contentsButtonRef.current?.focus({ preventScroll: true });
  }
  useEffect(() => {
    if (!contentsOpen) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('.contents-control')
      )
        setContentsOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) closeContents();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [contentsOpen]);
  const [tocTarget, setTocTarget] = useState<HTMLDivElement | null>(null);
  const [scrollViewport, setScrollViewport] = useState<HTMLDivElement | null>(
    null,
  );
  const [layoutViewport, setLayoutViewport] = useState<HTMLDivElement | null>(
    null,
  );
  const [narrow, setNarrow] = useState(
    () => window.matchMedia('(max-width: 900px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const resize = () => setNarrow(query.matches);
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);
  const locationRevisionId =
    historical?.id ?? requestRevision?.id ?? doc?.currentRevisionId;
  const [locationReport, setLocationReport] = useState<{
    revisionId?: string;
    locations: Record<string, 'found' | 'moved' | 'missing'>;
  }>({ locations: {} });
  const onRestoreReport = useCallback(
    (report: AnnotationRestoreReport) => {
      setLocationReport((previous) => {
        const before =
          previous.revisionId === locationRevisionId ? previous.locations : {};
        const locations = { ...before };
        for (const id of report.attempted) {
          // Paint passes can arrive before parent effects. Scope their results to
          // the rendered revision instead of clearing a fresh report in an effect.
          locations[id] = report.unanchored.includes(id)
            ? 'missing'
            : report.moved?.some((m) => m.id === id && m.blockId)
              ? 'moved'
              : before[id] === 'moved'
                ? 'moved'
                : 'found';
        }
        return previous.revisionId === locationRevisionId &&
          JSON.stringify(locations) === JSON.stringify(before)
          ? previous
          : { revisionId: locationRevisionId, locations };
      });
    },
    [locationRevisionId],
  );
  useEffect(() => {
    const fragment = new URLSearchParams(location.search).get('heading');
    if (!fragment) return;
    let remaining = 30;
    const timer = setInterval(() => {
      const headings = Array.from(
        document.querySelectorAll<HTMLElement>(
          '.document-surface h1,.document-surface h2,.document-surface h3,.document-surface h4,.document-surface h5,.document-surface h6',
        ),
      );
      const target = headings.find(
        (h) =>
          h.id === fragment ||
          h.textContent
            ?.trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N} -]/gu, '')
            .replace(/\s+/g, '-') === fragment,
      );
      if (target) {
        target.scrollIntoView({ block: 'start' });
        clearInterval(timer);
      } else if (--remaining === 0) clearInterval(timer);
    }, 100);
    return () => clearInterval(timer);
  }, [id]);
  const draftKey = `pw-draft:${user.id}:${id}`;
  const canEdit = workspace.role !== 'viewer' && !doc?.archivedAt;
  const changed = !!draft && draft.body !== draft.baseBody;
  const alive = useRef(true);
  const updateDraft = useCallback(
    (value: Draft | null) => {
      draftRef.current = value;
      setDraft(value);
      try {
        writeDraft(draftKey, value);
      } catch {
        setError(
          'Browser draft storage is unavailable. Download your draft before leaving this page.',
        );
      }
    },
    [draftKey],
  );
  async function reloadDiscussions() {
    const [nextComments, nextRevisions] = await Promise.all([
      api<Comment[]>(`/documents/${id}/comments`),
      api<Omit<Revision, 'body'>[]>(`/documents/${id}/revisions`),
    ]);
    if (alive.current) {
      setComments(nextComments);
      setRevisions(nextRevisions);
    }
  }
  useEffect(() => {
    alive.current = true;
    async function refresh(initial = false) {
      try {
        const next = await api<Document>(`/documents/${id}`);
        if (!alive.current) return;
        setDoc(next);
        if (requestId) {
          const request = await api<ReviewRequest>(
            `/review-requests/${requestId}`,
          );
          if (request.documentId !== id)
            throw new Error('This request belongs to another document.');
          if (!alive.current) return;
          setFocusedRequest(request);
        }
        if (initial) {
          try {
            const stored = readDraft<Draft | null>(draftKey, null);
            if (
              stored &&
              typeof stored.body === 'string' &&
              typeof stored.baseRevisionId === 'string' &&
              typeof stored.baseBody === 'string'
            ) {
              updateDraft(stored);
              setMode('edit');
              setConflict(stored.baseRevisionId !== next.currentRevisionId);
            }
          } catch {
            /* Invalid local draft is ignored. */
          }
          const revisionId = new URLSearchParams(location.search).get(
            'revision',
          );
          if (revisionId) {
            const revision = await api<Revision>(
              `/documents/${id}/revisions/${revisionId}`,
            );
            if (alive.current) {
              setHistorical(revision);
              setMode('read');
            }
          }
          const params = new URLSearchParams(location.search);
          if (!requestId && params.get('base') && params.get('target')) {
            const [base, target] = await Promise.all(
              [params.get('base'), params.get('target')].map((rid) =>
                api<Revision>(`/documents/${id}/revisions/${rid}`),
              ),
            );
            if (alive.current) {
              setHistorical(null);
              setComparison({ base, target });
              setMode('compare');
            }
          }
        } else if (
          draftRef.current &&
          draftRef.current.baseRevisionId !== next.currentRevisionId
        )
          setConflict(true);
        await reloadDiscussions();
        if (requestId && !requestedViewLoaded.current) {
          const request = await api<ReviewRequest>(
            `/review-requests/${requestId}`,
          );
          const historicalId = new URLSearchParams(location.search).get(
            'revision',
          );
          const target = await api<Revision>(
            `/documents/${id}/revisions/${historicalId ?? request.revisionId}`,
          );
          const base =
            !historicalId && request.baseRevisionId
              ? await api<Revision>(
                  `/documents/${id}/revisions/${request.baseRevisionId}`,
                )
              : null;
          if (alive.current) {
            setHistorical(historicalId ? target : null);
            setRequestRevision(historicalId ? null : target);
            setComparison(base ? { base, target } : null);
            setMode(base ? 'compare' : 'read');
            requestedViewLoaded.current = true;
          }
        }
        if (alive.current) {
          setUnavailable(false);
          setRequestLoading(false);
        }
      } catch (e) {
        if (alive.current) {
          setError(errorText(e));
          if (e instanceof ApiError && [401, 403, 404].includes(e.status))
            setUnavailable(true);
        }
      }
    }
    void refresh(true);
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [id]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (changed) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [changed]);
  function setVersion(version: Revision | null, recordHistory = true) {
    setRequestRevision(null);
    setHistorical(version);
    setComparison(null);
    setReattaching(null);
    setMode('read');
    const url = new URL(location.href);
    if (version) url.searchParams.set('revision', version.id);
    else url.searchParams.delete('revision');
    url.searchParams.delete('base');
    url.searchParams.delete('target');
    if (recordHistory && url.href !== location.href)
      history.pushState(null, '', url);
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError && e.code === 'revision_conflict')
        setConflict(true);
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    if (!draft) return;
    await action(async () => {
      const saved = await api<Document>(`/documents/${id}`, {
        method: 'PUT',
        body: JSON.stringify({
          body: draft.body,
          expectedRevisionId: draft.baseRevisionId,
        }),
      });
      if (!alive.current) return;
      setDoc(saved);
      const newerDraft =
        draftRef.current && draftRef.current.body !== draft.body;
      if (!newerDraft) updateDraft(null);
      setConflict(!!newerDraft);
      setMode(newerDraft ? 'edit' : 'read');
      await reloadDiscussions();
      onSaved();
    });
  }
  async function openComparison(baseId?: string, targetId?: string) {
    if (!doc) return;
    await action(async () => {
      const target = targetId
        ? await api<Revision>(`/documents/${id}/revisions/${targetId}`)
        : doc.revision;
      const previous = revisions.filter((r) => r.number < target.number);
      const reviewed = previous.filter((r) =>
        currentDecisions(doc.reviews, r.id).some(
          (d) => d.reviewerId === user.id,
        ),
      );
      const baseline =
        baseId ??
        [...reviewed].sort((a, b) => b.number - a.number)[0]?.id ??
        [...previous].sort((a, b) => b.number - a.number)[0]?.id;
      if (!baseline) return;
      const base = await api<Revision>(
        `/documents/${id}/revisions/${baseline}`,
      );
      setVersion(null, false);
      const url = new URL(location.href);
      url.searchParams.delete('revision');
      url.searchParams.set('base', base.id);
      url.searchParams.set('target', target.id);
      if (url.href !== location.href) history.pushState(null, '', url);
      setComparison({ base, target });
      setMode('compare');
      setTab('comments');
    });
  }
  async function savePendingComment(pending: PendingComment) {
    const submissionId = pending.payload.submissionId!;
    if (savingComments.current.has(submissionId)) return;
    savingComments.current.add(submissionId);
    await action(async () => {
      const comment = await post<Comment>(
        `/documents/${id}/comments`,
        pending.payload,
      );
      // Clear on confirmed POST success, independently of a subsequent refresh.
      setPendingComments((previous) =>
        previous.filter((p) => p.payload.submissionId !== submissionId),
      );
      await reloadDiscussions();
      if (alive.current) {
        updatePreferences({ layout: 'normal' });
        setSelected(comment.id);
        setTab('comments');
      }
    });
    savingComments.current.delete(submissionId);
  }
  async function addAnnotation(annotation: Annotation) {
    if (!doc || historical) return;
    const pending: PendingComment = {
      revisionNumber:
        mode === 'compare' && comparison
          ? comparison.target.number
          : (requestRevision ?? doc.revision).number,
      payload: {
        submissionId: crypto.randomUUID(),
        documentId: id,
        revisionId:
          mode === 'compare' && comparison
            ? comparison.target.id
            : (requestRevision?.id ?? doc.currentRevisionId),
        diff:
          mode === 'compare' && comparison && annotation.diffContext
            ? {
                baseRevisionId: comparison.base.id,
                blockIndex: Number(
                  annotation.blockId.replace('diff-block-', ''),
                ),
                side: annotation.diffContext,
              }
            : null,
        body: annotation.text ?? '',
        kind:
          annotation.type === AnnotationType.DELETION
            ? 'deletion'
            : annotation.isQuickLabel
              ? 'label'
              : 'comment',
        labelTip: annotation.quickLabelTip ?? null,
        images: annotation.images ?? [],
        quote: annotation.originalText ?? '',
        anchor: {
          blockId: annotation.blockId,
          startOffset: annotation.startOffset,
          endOffset: annotation.endOffset,
          // Upstream can end a selection on a synthetic trailing span (-1).
          // Keep the quote for verified restoration, not an invalid DOM position.
          startMeta:
            annotation.startMeta && annotation.startMeta.parentIndex >= 0
              ? annotation.startMeta
              : undefined,
          endMeta:
            annotation.endMeta && annotation.endMeta.parentIndex >= 0
              ? annotation.endMeta
              : undefined,
          mathTargets: annotation.mathTargets,
          diagramAnchor: annotation.diagramAnchor,
        },
      },
    };
    setPendingComments((previous) => [...previous, pending]);
    await savePendingComment(pending);
  }
  if (unavailable)
    return (
      <div className="document-empty">
        <ErrorMessage message={error} />
        <p>Saved server content is hidden until access is restored.</p>
        {draft && (
          <button
            className="button"
            onClick={() => download('recovered-draft.md', draft.body)}
          >
            Download your unsaved draft
          </button>
        )}
      </div>
    );
  if (!doc || requestLoading)
    return error ? (
      <div className="document-empty">
        <ErrorMessage message={error} />
      </div>
    ) : (
      <Loading label="Opening document…" />
    );
  const comparing = mode === 'compare' && comparison;
  const displayed = comparing
    ? comparing.target
    : (historical ?? requestRevision ?? doc.revision);
  const throughRevision = comments.filter(
    (c) =>
      (revisions.find((r) => r.id === c.revisionId)?.number ?? Infinity) <=
      displayed.number,
  );
  const locatedComments = throughRevision.map((c) => {
    const attachment = c.reattachments
      .filter((a) => a.revisionNumber <= displayed.number)
      .at(-1);
    return attachment
      ? {
          ...c,
          quote: attachment.quote,
          anchor: attachment.anchor,
          diff: null,
        }
      : c;
  });
  const visibleComments = throughRevision.filter(
    (c) =>
      (showResolved || !c.resolved || c.id === selected) &&
      (!historical || c.revisionId === historical.id),
  );
  const openCount = throughRevision.filter((c) => !c.resolved).length;
  const editorBody =
    mode === 'edit' || (mode === 'compare' && draft && !historical)
      ? (draft?.body ?? displayed.body)
      : displayed.body;
  return (
    <div ref={setLayoutViewport} className={`document-layout layout-${layout}`}>
      <section className="document-main">
        {doc.archivedAt && (
          <div className="archive-banner" role="status">
            Archived · This document is read-only. Its history and discussions
            are preserved.
          </div>
        )}
        <div className="document-toolbar">
          <div className="segmented" aria-label="Document mode">
            <button
              className={mode === 'read' ? 'active' : ''}
              onClick={() => {
                setMode('read');
                setComparison(null);
              }}
            >
              <BookOpen size={15} />
              Read
            </button>
            {canEdit && !historical && (
              <button
                className={mode === 'edit' ? 'active' : ''}
                onClick={() => {
                  if (!draft)
                    updateDraft({
                      body: doc.revision.body,
                      baseBody: doc.revision.body,
                      baseRevisionId: doc.currentRevisionId,
                    });
                  setComparison(null);
                  setRequestRevision(null);
                  setReattaching(null);
                  setMode('edit');
                }}
              >
                <Pencil size={15} />
                Edit
              </button>
            )}
            {(historical || draft) && (
              <button
                className={mode === 'compare' ? 'active' : ''}
                onClick={() => {
                  if (historical)
                    void openComparison(
                      historical.id === doc.currentRevisionId
                        ? undefined
                        : historical.id,
                    );
                  else {
                    setComparison(null);
                    setMode('compare');
                  }
                }}
              >
                <GitCompareArrows size={15} />
                Changes
              </button>
            )}
            {revisions.length > 1 && !historical && !changed && (
              <button
                className={comparing ? 'active' : ''}
                disabled={busy}
                onClick={() => void openComparison()}
              >
                <GitCompareArrows size={15} /> Review changes
              </button>
            )}
          </div>
          <div className="toolbar-actions">
            {workspace.role !== 'viewer' && (
              <DocumentActions
                doc={doc}
                onChanged={(next) => {
                  setDoc(next);
                  onSaved();
                }}
              />
            )}
            {changed && !historical ? (
              <>
                <span className="draft-indicator">Unsaved draft</span>
                <button
                  className="button primary small-button"
                  disabled={busy || conflict || !canEdit}
                  onClick={() => void save()}
                >
                  <Save size={14} />
                  Save revision
                </button>
              </>
            ) : (
              <span className="saved-status">
                <Check size={14} />
                {historical ? 'Saved version' : 'All changes saved'}
              </span>
            )}
            <button
              className="icon-button"
              title="Download Markdown"
              aria-label="Download Markdown"
              onClick={() =>
                download(
                  doc.path.split('/').pop()!,
                  draft?.body ?? displayed.body,
                )
              }
            >
              <Download size={16} />
            </button>
            <button
              className="icon-button"
              title="Copy document link"
              aria-label="Copy document link"
              onClick={() => {
                navigator.clipboard
                  .writeText(location.href)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                  .catch(() =>
                    setError(
                      'Copy the URL from your browser to share this document.',
                    ),
                  );
              }}
            >
              {copied ? <Check size={16} /> : <LinkIcon size={16} />}
            </button>
          </div>
        </div>
        <div
          className="reading-controls"
          role="region"
          aria-label="Reading controls"
        >
          <div className="segmented" aria-label="Reading layout">
            {(['normal', 'wide', 'focus'] as const).map((value) => (
              <button
                key={value}
                aria-pressed={layout === value}
                className={layout === value ? 'active' : ''}
                title={
                  value === 'wide'
                    ? 'Hide side panels and expand the document'
                    : value === 'focus'
                      ? 'Hide side panels and keep a comfortable reading width'
                      : 'Restore side panels'
                }
                onClick={() => updatePreferences({ layout: value })}
              >
                {value === 'normal'
                  ? 'Normal'
                  : value === 'wide'
                    ? 'Wide'
                    : 'Focus'}
              </button>
            ))}
          </div>
          <div className="contents-control">
            <button
              className="text-button"
              aria-expanded={contentsOpen && mode === 'read'}
              ref={contentsButtonRef}
              aria-controls="document-contents"
              disabled={mode !== 'read'}
              onClick={() => setContentsOpen(!contentsOpen)}
            >
              Contents
            </button>
            <div
              id="document-contents"
              className="contents-popover"
              hidden={!contentsOpen || mode !== 'read'}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setContentsOpen(false);
                  e.stopPropagation();
                  e.currentTarget.parentElement
                    ?.querySelector('button')
                    ?.focus();
                }
              }}
            >
              <div ref={setTocTarget} />
              <button className="text-button" onClick={closeContents}>
                Close contents
              </button>
            </div>
          </div>
          <button className="text-button" onClick={() => setSettingsOpen(true)}>
            Custom labels
          </button>
        </div>
        {settingsOpen && (
          <Suspense fallback={<Loading label="Loading labels…" />}>
            <ReviewSettings onClose={() => setSettingsOpen(false)} />
          </Suspense>
        )}
        <ErrorMessage message={preferenceError} />
        <ErrorMessage message={error} />
        <ErrorMessage message={commentStorageError} />
        {!!pendingComments.length && (
          <section className="pending-comments" aria-label="Unsaved comments">
            <strong>Comments awaiting confirmation</strong>
            <p>
              Your feedback is kept in this browser until the server confirms
              it. Retry keeps the original revision and passage.
            </p>
            {pendingComments.map((p) => (
              <article className="request-card" key={p.payload.submissionId}>
                <small>
                  Revision {p.revisionNumber} · {p.payload.kind}
                  {p.payload.diff ? ' · comparison comment' : ''}
                </small>
                {p.payload.quote && <blockquote>{p.payload.quote}</blockquote>}
                {p.payload.body && (
                  <p className="request-message">{p.payload.body}</p>
                )}
                {p.payload.images.map((img) => (
                  <a
                    key={img.path}
                    href={img.path}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <img
                      className="recovered-image"
                      src={img.path}
                      alt={img.name}
                    />
                  </a>
                ))}
                <div className="button-row">
                  <button
                    className="button small-button"
                    disabled={busy || !canEdit}
                    onClick={() => void savePendingComment(p)}
                  >
                    Retry comment save
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      setPendingComments((previous) =>
                        previous.filter(
                          (other) =>
                            other.payload.submissionId !==
                            p.payload.submissionId,
                        ),
                      )
                    }
                  >
                    Discard recovered comment
                  </button>
                </div>
              </article>
            ))}
          </section>
        )}
        {focusedRequest && (
          <div className="version-banner request-context" role="status">
            <span>
              Review requested from {focusedRequest.reviewerName} by{' '}
              {focusedRequest.agentName ?? focusedRequest.requesterName} ·
              revision {focusedRequest.revisionNumber}
              {focusedRequest.outdated
                ? ' · Outdated: newer changes are available'
                : ''}
              {focusedRequest.supersededBy
                ? ' · Replaced by a new review round'
                : focusedRequest.cancelledAt
                  ? ' · Cancelled'
                  : ''}
              {focusedRequest.message && (
                <small>{focusedRequest.message}</small>
              )}
            </span>
            {focusedRequest.supersededBy && (
              <button
                className="text-button"
                onClick={() =>
                  void action(async () =>
                    onOpenRequest(
                      await api<ReviewRequest>(
                        `/review-requests/${focusedRequest.supersededBy}`,
                      ),
                    ),
                  )
                }
              >
                Open new round
              </button>
            )}
          </div>
        )}
        <ReviewStatus
          doc={doc}
          revision={displayed}
          user={user}
          request={focusedRequest}
          onReadLatest={() => setVersion(null)}
          canReview={
            canEdit &&
            !historical &&
            !changed &&
            (mode === 'read' || !!comparing) &&
            displayed.id === doc.currentRevisionId
          }
          busy={busy}
          onReview={(revisionId, decision, note) =>
            action(async () => {
              const saved = await post<Document>(`/documents/${id}/reviews`, {
                expectedRevisionId: revisionId,
                decision,
                note,
              });
              if (alive.current) setDoc(saved);
              if (requestId) {
                void api<ReviewRequest>(`/review-requests/${requestId}`)
                  .then((r) => {
                    if (alive.current) setFocusedRequest(r);
                  })
                  .catch(() => {}); // Normal polling retries a failed status refresh.
              }
            })
          }
        />
        <DocumentRequests
          documentId={id}
          user={user}
          workspaceId={workspace.id}
          revision={displayed}
          onReadLatest={() => setVersion(null)}
          currentRevisionId={doc.currentRevisionId}
          canRequest={
            canEdit &&
            !changed &&
            mode !== 'edit' &&
            displayed.id === doc.currentRevisionId
          }
          refreshKey={doc.reviews.length}
          onOpen={onOpenRequest}
        />
        {comparing && (
          <div className="comparison-banner">
            <label>
              Compare from
              <select
                aria-label="Comparison baseline"
                value={comparing.base.id}
                disabled={busy}
                onChange={(e) =>
                  void openComparison(e.target.value, comparing.target.id)
                }
              >
                {revisions
                  .filter((r) => r.number < comparing.target.number)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      Revision {r.number}
                    </option>
                  ))}
              </select>
            </label>
            <span>
              to revision {comparing.target.number} ·{' '}
              {currentDecisions(doc.reviews, comparing.base.id).some(
                (r) => r.reviewerId === user.id,
              )
                ? 'From your reviewed revision'
                : 'Earlier saved revision'}
            </span>
            {comparing.target.id !== doc.currentRevisionId && (
              <p role="status">
                Revision {doc.revision.number} is now available. This comparison
                stays on revision {comparing.target.number}.
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void openComparison(comparing.base.id)}
                >
                  Review latest changes
                </button>
              </p>
            )}
          </div>
        )}
        {reattaching && (
          <div className="version-banner" role="status">
            <span>
              Select or pinpoint a new passage, open Actions, then choose
              “Attach discussion here”. The original quote and replies stay
              preserved.
            </span>
            <button
              className="text-button"
              onClick={() => setReattaching(null)}
            >
              Cancel reattachment
            </button>
          </div>
        )}
        {historical && (
          <div className="version-banner">
            <History size={16} />
            <span>
              Viewing revision {historical.number} ·{' '}
              {dateLabel(historical.createdAt)}
            </span>
            <button className="text-button" onClick={() => setVersion(null)}>
              Back to latest <ArrowLeft size={14} />
            </button>
            {canEdit && (
              <button
                className="button small-button"
                disabled={busy}
                onClick={() => {
                  if (
                    confirm(
                      `Restore revision ${historical.number} as a new revision? Existing history and any local draft will be kept.`,
                    )
                  )
                    void action(async () => {
                      const restored = await post<Document>(
                        `/documents/${id}/restore`,
                        {
                          revisionId: historical.id,
                          expectedRevisionId: doc.currentRevisionId,
                        },
                      );
                      setDoc(restored);
                      setVersion(null);
                      if (draft) setConflict(true);
                      await reloadDiscussions();
                      onSaved();
                    });
                }}
              >
                <RotateCcw size={14} />
                Restore
              </button>
            )}
          </div>
        )}
        {conflict && draft && (
          <div className="conflict-banner" role="alert">
            <strong>A newer revision is available. Your draft is safe.</strong>
            <p>
              Compare your draft with the latest revision. Reconcile the text
              before choosing “Use latest as base”; saving will still check for
              further changes.
            </p>
            <div className="button-row">
              <button
                className="button small-button"
                onClick={() => {
                  setHistorical(null);
                  setMode('compare');
                }}
              >
                Compare with latest
              </button>
              <button
                className="button small-button"
                onClick={() => {
                  updateDraft({
                    ...draft,
                    baseBody: doc.revision.body,
                    baseRevisionId: doc.currentRevisionId,
                  });
                  setConflict(false);
                  setComparison(null);
                  setRequestRevision(null);
                  setReattaching(null);
                  setMode('edit');
                }}
              >
                Use latest as base
              </button>
              <button
                className="text-button"
                onClick={() => download('unsaved-draft.md', draft.body)}
              >
                Download draft
              </button>
            </div>
          </div>
        )}
        {draft && !historical && !conflict && (
          <div className="draft-note">
            <span>
              Your draft is kept in this browser until you save or discard it.
            </span>
            <button
              className="text-button"
              onClick={() => {
                if (!changed || confirm('Discard your unsaved changes?')) {
                  updateDraft(null);
                  setMode('read');
                  setConflict(false);
                }
              }}
            >
              Discard draft
            </button>
          </div>
        )}
        <div className="document-scroll" ref={setScrollViewport}>
          <div className="document-meta">
            <span className="eyebrow">{doc.path}</span>
            <span>
              REV {displayed.number.toString().padStart(2, '0')}{' '}
              <span className="meta-dot">·</span> {displayed.authorName}
              {displayed.agentName ? ` / ${displayed.agentName}` : ''}
            </span>
          </div>
          <div className="document-surface" data-testid="document-surface">
            <PopoverDraftScope.Provider
              value={`${id}:${displayed.id}${comparison ? `:${comparison.base.id}` : ''}`}
            >
              <Suspense
                fallback={<Loading label="Loading Plannotator editor…" />}
              >
                {comparing ? (
                  <RevisionDiff
                    key={`${comparing.base.id}:${comparing.target.id}`}
                    comparison={comparing}
                    comments={throughRevision}
                    selected={selected}
                    canComment={canEdit}
                    mode={reviewMode}
                    onMode={(reviewMode) => updatePreferences({ reviewMode })}
                    diffMode={preferences.diffMode}
                    onDiffMode={(diffMode) => updatePreferences({ diffMode })}
                    wide={layout === 'wide'}
                    onComment={(ann) => void addAnnotation(ann)}
                    onSelect={(id) => {
                      setSelected(id);
                      if (id) updatePreferences({ layout: 'normal' });
                    }}
                    onExit={() => {
                      setComparison(null);
                      setMode('read');
                    }}
                  />
                ) : (
                  <Surface
                    key={`${id}:${historical?.id ?? requestRevision?.id ?? (mode === 'edit' ? draft?.baseRevisionId : doc.currentRevisionId)}:${mode}`}
                    body={
                      mode === 'compare' && historical
                        ? doc.revision.body
                        : editorBody
                    }
                    documentId={`${id}:${historical?.id ?? draft?.baseRevisionId ?? doc.currentRevisionId}`}
                    mode={mode}
                    layout={layout}
                    tocTarget={tocTarget}
                    scrollViewport={narrow ? layoutViewport : scrollViewport}
                    onTocNavigate={closeContents}
                    readOnly={
                      !canEdit ||
                      !!historical ||
                      (!!requestRevision &&
                        requestRevision.id !== doc.currentRevisionId)
                    }
                    comments={
                      historical
                        ? locatedComments.filter(
                            (c) => c.revisionId === historical.id,
                          )
                        : locatedComments
                    }
                    selected={selected}
                    onSelect={(id) => {
                      if (id) updatePreferences({ layout: 'normal' });
                      setSelected(id);
                      setTab('comments');
                    }}
                    onComment={(ann) => void addAnnotation(ann)}
                    onRestoreReport={onRestoreReport}
                    selectionActions={
                      reattaching
                        ? [
                            {
                              id: 'reattach',
                              label: 'Attach discussion here',
                              onSelect: (ctx) => {
                                if (busy) return;
                                void action(async () => {
                                  await post(
                                    `/comments/${reattaching.comment.id}/reattach`,
                                    {
                                      expectedVersion:
                                        reattaching.comment.version,
                                      expectedRevisionId:
                                        reattaching.revisionId,
                                      quote: ctx.text,
                                      anchor: {
                                        blockId: ctx.blockId,
                                        startOffset: ctx.startOffset,
                                        endOffset: ctx.endOffset,
                                      },
                                    },
                                  );
                                  setLocationReport({ locations: {} });
                                  await reloadDiscussions();
                                  setReattaching(null);
                                });
                              },
                            },
                          ]
                        : undefined
                    }
                    reviewMode={reviewMode}
                    onReviewModeChange={(reviewMode) =>
                      updatePreferences({ reviewMode })
                    }
                    inputMethod={inputMethod}
                    onInputMethodChange={(inputMethod) =>
                      updatePreferences({ inputMethod })
                    }
                    onChange={(body) => {
                      if (draftRef.current)
                        updateDraft({ ...draftRef.current, body });
                    }}
                    compareBody={
                      historical?.body ??
                      (conflict ? doc.revision.body : draft?.baseBody) ??
                      doc.revision.body
                    }
                    onLink={(path) => onLink(path, displayed.id)}
                  />
                )}
              </Suspense>
            </PopoverDraftScope.Provider>
          </div>
          <div className="document-footer">
            <span>Saved {dateLabel(displayed.createdAt)}</span>
            <span>
              {displayed.body.trim().split(/\s+/).filter(Boolean).length} words
            </span>
          </div>
        </div>
      </section>
      <aside className="review-panel">
        <div className="review-tabs">
          <button
            className={tab === 'comments' ? 'active' : ''}
            onClick={() => setTab('comments')}
          >
            <MessageSquare size={16} />
            Discussion <span>{openCount}</span>
          </button>
          <button
            className={tab === 'history' ? 'active' : ''}
            onClick={() => setTab('history')}
          >
            <History size={16} />
            History
          </button>
        </div>
        {tab === 'comments' ? (
          <>
            <div className="panel-heading">
              <div>
                <h2>Make the plan better.</h2>
                <p>Select or pinpoint a passage to review it.</p>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={showResolved}
                  onChange={(e) =>
                    updatePreferences({ showResolved: e.target.checked })
                  }
                />
                Show resolved
              </label>
            </div>
            <div className="feedback-actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const { markdown } = await api<{ markdown: string }>(
                      `/documents/${id}/revisions/${displayed.id}/feedback`,
                    );
                    await navigator.clipboard.writeText(markdown);
                    setFeedbackCopied(true);
                    setTimeout(() => setFeedbackCopied(false), 2000);
                  })
                }
              >
                {feedbackCopied ? 'Feedback copied' : 'Copy review feedback'}
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const { markdown } = await api<{ markdown: string }>(
                      `/documents/${id}/revisions/${displayed.id}/feedback`,
                    );
                    download(
                      `review-revision-${displayed.number}.md`,
                      markdown,
                    );
                  })
                }
              >
                Download feedback
              </button>
            </div>
            <div className="comment-list">
              {visibleComments.length ? (
                visibleComments.map((c) => (
                  <CommentCard
                    key={c.id}
                    comment={c}
                    userId={user.id}
                    selected={selected === c.id}
                    canEdit={canEdit && !historical}
                    onSelect={() => setSelected(c.id)}
                    onEdit={(body, expectedVersion) =>
                      action(async () => {
                        await api(`/comments/${c.id}`, {
                          method: 'PUT',
                          body: JSON.stringify({ body, expectedVersion }),
                        });
                        await reloadDiscussions();
                      })
                    }
                    onDelete={() =>
                      void action(async () => {
                        await api(`/comments/${c.id}`, {
                          method: 'DELETE',
                          body: JSON.stringify({
                            expectedVersion: c.version,
                          }),
                        });
                        await reloadDiscussions();
                        if (selected === c.id) setSelected(null);
                      })
                    }
                    onReply={(body) =>
                      action(async () => {
                        await post(`/comments/${c.id}/replies`, { body });
                        await reloadDiscussions();
                      })
                    }
                    onResolve={() =>
                      void action(async () => {
                        await api(`/comments/${c.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ resolved: !c.resolved }),
                        });
                        await reloadDiscussions();
                      })
                    }
                    busy={busy}
                    older={
                      !historical && c.revisionId !== doc.currentRevisionId
                    }
                    location={
                      mode === 'read' &&
                      locationReport.revisionId === displayed.id
                        ? locationReport.locations[c.id]
                        : undefined
                    }
                    attachment={c.reattachments
                      .filter((a) => a.revisionNumber <= displayed.number)
                      .at(-1)}
                    diffLabel={
                      c.diff
                        ? `Revision ${revisions.find((r) => r.id === c.diff!.baseRevisionId)?.number} → ${revisions.find((r) => r.id === c.revisionId)?.number} · ${c.diff.side} passage`
                        : undefined
                    }
                    onOpenComparison={() => {
                      if (c.diff)
                        void openComparison(
                          c.diff.baseRevisionId,
                          c.revisionId,
                        );
                    }}
                    onReattach={() => {
                      setVersion(null);
                      setReattaching({
                        comment: c,
                        revisionId: doc.currentRevisionId,
                      });
                      setSelected(c.id);
                      updatePreferences({
                        layout: 'normal',
                        reviewMode: 'selection',
                      });
                    }}
                  />
                ))
              ) : (
                <div className="discussion-empty">
                  <MessageSquare size={27} strokeWidth={1.3} />
                  <h3>
                    {historical
                      ? 'No discussions on this revision'
                      : 'A fresh perspective starts here'}
                  </h3>
                  <p>
                    {historical
                      ? 'Return to the latest document to continue the conversation.'
                      : 'Ask a question, suggest a change, or leave a note for your team.'}
                  </p>
                </div>
              )}
            </div>
            {canEdit && !historical && (
              <form
                className="new-comment"
                onSubmit={(e) => {
                  e.preventDefault();
                  const body = discussionDraft?.body ?? '';
                  if (!body.trim()) return;
                  const pending: PendingComment = {
                    revisionNumber:
                      discussionDraft?.revisionNumber ?? displayed.number,
                    payload: {
                      submissionId: crypto.randomUUID(),
                      documentId: id,
                      body,
                      revisionId: discussionDraft?.revisionId ?? displayed.id,
                      kind: 'comment',
                      quote: '',
                      labelTip: null,
                      images: [],
                      diff: null,
                    },
                  };
                  setPendingComments((previous) => [...previous, pending]);
                  setDiscussionDraft(null);
                  void savePendingComment(pending);
                }}
              >
                <ErrorMessage
                  message={discussionStorageError || popoverStorageError}
                />
                {discussionDraft &&
                  discussionDraft.revisionId !== displayed.id && (
                    <p className="panel-note">
                      This draft belongs to revision{' '}
                      {discussionDraft.revisionNumber}. Posting keeps it
                      attached to that revision.
                    </p>
                  )}
                <label htmlFor="new-comment">Document discussion</label>
                <textarea
                  id="new-comment"
                  value={discussionDraft?.body ?? ''}
                  onChange={(e) =>
                    setDiscussionDraft(
                      e.target.value
                        ? {
                            body: e.target.value,
                            revisionId:
                              discussionDraft?.revisionId ?? displayed.id,
                            revisionNumber:
                              discussionDraft?.revisionNumber ??
                              displayed.number,
                          }
                        : null,
                    )
                  }
                  name="body"
                  placeholder="What’s on your mind?"
                  required
                  maxLength={10000}
                  rows={3}
                />
                <div>
                  <span>Visible to your workspace</span>
                  <button
                    className="button primary small-button"
                    disabled={busy}
                  >
                    <Send size={13} />
                    Post
                  </button>
                </div>
              </form>
            )}
            {!canEdit && (
              <div className="panel-note">You have view-only access.</div>
            )}
          </>
        ) : (
          <>
            <div className="panel-heading">
              <h2>Every step, preserved.</h2>
              <p>Restore an earlier version without losing history.</p>
            </div>
            <div className="revision-list">
              {revisions.map((r) => (
                <button
                  className={`revision-item ${historical?.id === r.id ? 'selected' : ''}`}
                  key={r.id}
                  onClick={() =>
                    void action(async () =>
                      setVersion(
                        await api<Revision>(
                          `/documents/${id}/revisions/${r.id}`,
                        ),
                      ),
                    )
                  }
                >
                  <span className="revision-marker">
                    <History size={15} />
                  </span>
                  <span>
                    <strong>
                      Revision {r.number}
                      {r.id === doc.currentRevisionId && (
                        <span className="pill green">Latest</span>
                      )}
                    </strong>
                    <small>
                      {r.agentName ?? r.authorName} · {dateLabel(r.createdAt)}
                    </small>
                    {r.restoredFrom && (
                      <small>Restored from an earlier revision</small>
                    )}
                  </span>
                  <ArrowUpRight size={14} />
                </button>
              ))}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function CommentCard({
  userId,
  comment,
  selected,
  canEdit,
  onSelect,
  onReply,
  onResolve,
  onEdit,
  onDelete,
  busy,
  older,
  location,
  attachment,
  diffLabel,
  onOpenComparison,
  onReattach,
}: {
  userId: string;
  comment: Comment;
  selected: boolean;
  canEdit: boolean;
  onSelect: () => void;
  onReply: (body: string) => Promise<boolean>;
  onResolve: () => void;
  onEdit: (body: string, expectedVersion: number) => Promise<boolean>;
  onDelete: () => void;
  busy: boolean;
  older: boolean;
  location?: 'found' | 'moved' | 'missing';
  attachment?: Comment['reattachments'][number];
  diffLabel?: string;
  onOpenComparison: () => void;
  onReattach: () => void;
}) {
  const [editing, setEditing, editStorageError] = useReviewDraft<{
    body: string;
    version: number;
  } | null>(
    `pw-annotation-draft:${userId}:${comment.documentId}:${comment.id}`,
    null,
  );
  const [reply, setReply, replyStorageError] = useReviewDraft<string>(
    `pw-reply-draft:${userId}:${comment.documentId}:${comment.id}`,
    '',
  );
  const [replying, setReplying] = useState(!!reply);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected)
      ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selected]);
  return (
    <article
      ref={ref}
      className={`comment-card ${selected ? 'selected' : ''} ${comment.resolved ? 'resolved' : ''}`}
      onClick={onSelect}
    >
      <ErrorMessage message={editStorageError || replyStorageError} />
      <div className="comment-author">
        <span className="avatar small-avatar">
          {comment.agentName ? <Bot size={14} /> : initials(comment.authorName)}
        </span>
        <div>
          <strong>{comment.agentName ?? comment.authorName}</strong>
          <small>
            {comment.agentName ? `For ${comment.authorName} · ` : ''}
            {dateLabel(comment.createdAt)}
            {comment.updatedAt ? ' · Edited' : ''}
          </small>
        </div>
      </div>
      {comment.kind !== 'comment' && (
        <span className={`annotation-kind ${comment.kind}`}>
          {comment.kind === 'deletion' ? 'Suggested deletion' : 'Label'}
        </span>
      )}
      {comment.quote && <blockquote>{comment.quote}</blockquote>}
      {diffLabel && (
        <div className="anchor-note">
          {diffLabel}
          <br />
          <button className="text-button" onClick={onOpenComparison}>
            Open original comparison
          </button>
        </div>
      )}
      {attachment && (
        <div className="anchor-note">
          Reattached by {attachment.agentName ?? attachment.authorName} on
          revision {attachment.revisionNumber}
          <blockquote>{attachment.quote}</blockquote>
        </div>
      )}
      {comment.quote && (!comment.diff || attachment) && location && (
        <span className="anchor-note">
          {location === 'missing'
            ? 'Unanchored — passage missing from this revision'
            : location === 'moved'
              ? 'Passage moved — found in a new location'
              : older
                ? 'Passage found in this revision'
                : 'Passage found'}
        </span>
      )}
      {canEdit &&
        comment.canEdit &&
        !comment.resolved &&
        (location === 'missing' || comment.diff) && (
          <button
            className="text-button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onReattach();
            }}
          >
            Reattach discussion
          </button>
        )}
      {editing ? (
        <form
          className="reply-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await onEdit(editing.body, editing.version))
              setEditing((current) =>
                current?.body === editing.body &&
                current.version === editing.version
                  ? null
                  : current,
              );
          }}
        >
          <label htmlFor={`edit-${comment.id}`}>Edit annotation</label>
          <textarea
            id={`edit-${comment.id}`}
            rows={3}
            maxLength={10000}
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            autoFocus
          />
          {editing.version !== comment.version && (
            <p role="alert">
              This discussion changed while you were editing. Your text is
              preserved. Cancel and reopen to use the latest version.
            </p>
          )}
          <div className="button-row">
            <button
              className="button small-button"
              disabled={
                !canEdit ||
                !comment.canEdit ||
                busy ||
                editing.version !== comment.version
              }
            >
              Save annotation
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => setEditing(null)}
            >
              Cancel edit
            </button>
          </div>
        </form>
      ) : (
        comment.body && <p className="comment-body">{comment.body}</p>
      )}
      {comment.labelTip && <p className="label-tip">{comment.labelTip}</p>}
      {comment.images?.length > 0 && (
        <div className="comment-images">
          {comment.images.map((image) => (
            <a
              key={image.path}
              href={image.path}
              target="_blank"
              rel="noreferrer"
              title={`Open ${image.name}`}
            >
              <img src={image.path} alt={image.name} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {comment.replies.map((r) => (
        <div className="reply" key={r.id}>
          <strong>{r.agentName ?? r.authorName}</strong>
          <small>
            {r.agentName ? `For ${r.authorName} · ` : ''}
            {dateLabel(r.createdAt)}
          </small>
          <p>{r.body}</p>
        </div>
      ))}
      {canEdit && (
        <div className="comment-actions">
          {comment.canEdit && !editing && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                setEditing({ body: comment.body, version: comment.version })
              }
            >
              Edit annotation
            </button>
          )}
          {comment.canDelete && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (
                  confirm(
                    `Delete this discussion${comment.replies.length ? ` and its ${comment.replies.length} replies` : ''}? This cannot be undone.`,
                  )
                )
                  onDelete();
              }}
            >
              Delete discussion
            </button>
          )}
          <button
            className="button small-button"
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onResolve();
            }}
          >
            {comment.resolved ? <RotateCcw size={14} /> : <Check size={14} />}
            {comment.resolved ? 'Reopen discussion' : 'Resolve discussion'}
          </button>
        </div>
      )}
      {comment.resolved ? (
        <span className="resolved-label">
          <Check size={13} />
          Resolved
        </span>
      ) : (
        canEdit &&
        (replying ? (
          <form
            className="reply-form"
            onSubmit={async (e: FormEvent<HTMLFormElement>) => {
              e.preventDefault();
              const form = e.currentTarget;
              if (await onReply(reply)) {
                setReply((current) => (current === reply ? '' : current));
                form.reset();
                setReplying(false);
              }
            }}
          >
            <label className="sr-only" htmlFor={`reply-${comment.id}`}>
              Reply to discussion
            </label>
            <textarea
              id={`reply-${comment.id}`}
              name="body"
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              required
              maxLength={10000}
              placeholder="Write a reply…"
              rows={2}
              autoFocus
            />
            <div className="button-row">
              <button className="button small-button" disabled={busy}>
                Send reply
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setReply('');
                  setReplying(false);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button className="text-button" onClick={() => setReplying(true)}>
            Reply
          </button>
        ))
      )}
    </article>
  );
}
