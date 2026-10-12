import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { api } from './api';
import { artifactUrl } from './navigation';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { TableOfContents } from '@plannotator/ui/components/TableOfContents';
import { useActiveSection } from '@plannotator/ui/hooks/useActiveSection';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { Viewer, type ViewerHandle } from '@plannotator/ui/components/Viewer';
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from '@plannotator/ui/components/MarkdownEditor';
import { MarkdownDiff } from '@plannotator/ui/components/MarkdownDiff';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import {
  AnnotationType,
  type Annotation,
  type EditorMode,
  type InputMethod,
} from '@plannotator/ui/types';
import type { AnnotationRestoreReport } from '@plannotator/ui/hooks/useAnnotationHighlighter';
import type { SelectionAction } from '@plannotator/ui/utils/selectionActions';
import type { Comment } from '../shared/types';

export default function PlannotatorSurface({
  body,
  artifactId,
  mode,
  comments,
  selected,
  readOnly,
  onChange,
  onComment,
  onSelect,
  compareBody,
  onLink,
  onRestoreReport,
  selectionActions,
  reviewMode,
  onReviewModeChange,
  inputMethod,
  onInputMethodChange,
  layout,
  tocTarget,
  scrollViewport,
  onTocNavigate,
}: {
  body: string;
  artifactId: string;
  mode: 'read' | 'edit' | 'compare';
  comments: Comment[];
  selected: string | null;
  readOnly: boolean;
  onChange: (body: string) => void;
  onComment: (annotation: Annotation) => void;
  onSelect: (id: string | null) => void;
  compareBody?: string;
  onLink: (path: string) => void;
  onRestoreReport: (report: AnnotationRestoreReport) => void;
  selectionActions?: SelectionAction[];
  reviewMode: EditorMode;
  onReviewModeChange: (mode: EditorMode) => void;
  inputMethod: InputMethod;
  onInputMethodChange: (method: InputMethod) => void;
  layout: 'normal' | 'wide' | 'focus';
  tocTarget: HTMLElement | null;
  scrollViewport: HTMLElement | null;
  onTocNavigate: () => void;
}) {
  const { resolvedMode } = useTheme();
  const editorRef = useRef<MarkdownEditorHandle | null>(null);
  const viewerRef = useRef<ViewerHandle | null>(null);
  const restoredIds = useRef(new Map<string, string>());
  const blocks = useMemo(() => parseMarkdownToBlocks(body), [body]);
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== 'read') return;
    let active = true;
    const [id, revisionId] = artifactId.split(':');
    const anchors = Array.from(
      contentRef.current?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? [],
    );
    // Give native open-in-new-tab/copy-link actions stable application URLs.
    // Preserve the authored href for ordinary clicks and revision-bound resolution.
    async function resolveAnchors() {
      const resolved = new Map<string, string>();
      for (const anchor of anchors) {
        if (!active) return;
        const attribute = anchor.getAttribute('href')!;
        const href = attribute.startsWith(location.origin + '/?')
          ? (anchor.dataset.workspaceHref ?? attribute)
          : attribute;
        if (
          /^[a-z][a-z\d+.-]*:/i.test(href) ||
          href.startsWith('//') ||
          href.startsWith('/api/')
        )
          continue;
        anchor.dataset.workspaceHref = href;
        try {
          let url = resolved.get(href);
          if (!url) {
            const target = await api<{
              workspaceId: string;
              artifactId: string;
              fragment: string;
            }>(
              `/artifacts/${id}/resolve-link?${new URLSearchParams({ revisionId, href })}`,
            );
            url = artifactUrl(target.workspaceId, target.artifactId, {
              ...(target.fragment
                ? { heading: decodeURIComponent(target.fragment) }
                : {}),
              ...(href.startsWith('#') ? { revision: revisionId } : {}),
            }).href;
            resolved.set(href, url);
          }
          if (active && anchor.isConnected) anchor.href = url;
        } catch {
          /* Clicking still reports inaccessible or missing destinations. */
        }
      }
    }
    void resolveAnchors();
    return () => {
      active = false;
    };
  }, [body, artifactId, mode]);
  const headingCount = blocks.filter(
    (block) => block.type === 'heading' && (block.level ?? 1) <= 3,
  ).length;
  const activeSection = useActiveSection(
    contentRef,
    headingCount,
    scrollViewport,
  );
  const annotations = useMemo(
    () =>
      comments
        .filter((c) => !c.resolved && !c.diff)
        .map(
          (c) =>
            ({
              ...(c.anchor ?? {}),
              id: c.id,
              blockId:
                typeof c.anchor?.blockId === 'string' ? c.anchor.blockId : '',
              startOffset:
                typeof c.anchor?.startOffset === 'number'
                  ? c.anchor.startOffset
                  : 0,
              endOffset:
                typeof c.anchor?.endOffset === 'number'
                  ? c.anchor.endOffset
                  : 0,
              originalText: c.quote,
              text: c.body,
              type:
                c.kind === 'deletion'
                  ? AnnotationType.DELETION
                  : c.quote
                    ? AnnotationType.COMMENT
                    : AnnotationType.GLOBAL_COMMENT,
              isQuickLabel: c.kind === 'label',
              quickLabelTip: c.labelTip ?? undefined,
              images: c.images,
              author: c.authorName,
              createdA: Date.parse(c.createdAt),
            }) as Annotation,
        ),
    [comments],
  );
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const currentIds = new Map(
      annotations.map((a) => [
        a.id,
        JSON.stringify([a.originalText, a.blockId, a.startOffset, a.endOffset]),
      ]),
    );
    for (const [id, anchor] of restoredIds.current) {
      if (currentIds.get(id) !== anchor) viewer.removeHighlight(id);
    }
    // The annotations prop supplies metadata; persisted highlights use the
    // viewer's explicit restore API. Leave pending selections alone on polls.
    viewer.applySharedAnnotations(annotations);
    restoredIds.current = currentIds;
  }, [annotations, body, mode, readOnly]);
  if (mode === 'edit')
    return (
      <MarkdownEditor
        markdown={body}
        documentId={artifactId}
        maxWidth={layout === 'wide' ? null : 832}
        editorHandleRef={editorRef}
        onMarkdownChange={onChange}
        onLinkClick={onLink}
        mode={resolvedMode}
      />
    );
  if (mode === 'compare')
    return (
      <MarkdownDiff
        originalMarkdown={compareBody ?? ''}
        modifiedMarkdown={body}
        documentId={artifactId}
        mode={resolvedMode}
      />
    );
  return (
    <div
      ref={contentRef}
      onClickCapture={(event) => {
        const anchor = (event.target as Element).closest?.('a');
        const href =
          anchor?.dataset.workspaceHref ?? anchor?.getAttribute('href');
        if (
          (event.ctrlKey || event.metaKey || event.shiftKey) &&
          anchor?.href.startsWith(location.origin + '/?')
        ) {
          event.stopPropagation();
          return;
        }
        if (
          href &&
          !/^[a-z][a-z\d+.-]*:/i.test(href) &&
          !href.startsWith('//') &&
          !href.startsWith('/api/')
        ) {
          event.preventDefault();
          event.stopPropagation();
          onLink(href);
        }
      }}
    >
      {tocTarget &&
        createPortal(
          headingCount ? (
            <ScrollViewportProvider viewport={scrollViewport}>
              <TableOfContents
                blocks={blocks}
                annotations={annotations}
                activeId={activeSection}
                onNavigate={onTocNavigate}
              />
            </ScrollViewportProvider>
          ) : (
            <p className="muted small">No headings in this artifact.</p>
          ),
          tocTarget,
        )}
      <Viewer
        ref={viewerRef}
        markdown={body}
        maxWidth={layout === 'wide' ? null : 832}
        blocks={blocks}
        annotations={annotations}
        mode={reviewMode}
        inputMethod={inputMethod}
        annotationHeader={{
          onInputMethodChange,
          onModeChange: onReviewModeChange,
        }}
        taterMode={false}
        readOnly={readOnly}
        quickLabels
        allowImages
        selectedAnnotationId={selected}
        onSelectAnnotation={onSelect}
        onAddAnnotation={(annotation) => {
          viewerRef.current?.removeHighlight(annotation.id);
          onComment(annotation);
        }}
        onOpenLinkedDoc={onLink}
        onRestoreReport={onRestoreReport}
        selectionActions={selectionActions}
        copyLabel="Copy artifact"
        disableCodePathValidation
      />
    </div>
  );
}
