import { useMemo } from 'react';
import { artifactFormat } from '../shared/artifacts';
import { PlanRawDiffView } from '@plannotator/ui/components/plan-diff/PlanRawDiffView';
import { PlanDiffViewer } from '@plannotator/ui/components/plan-diff/PlanDiffViewer';
import { AnnotationToolstrip } from '@plannotator/ui/components/AnnotationToolstrip';
import { computePlanDiff } from '@plannotator/ui/utils/planDiffEngine';
import {
  AnnotationType,
  type Annotation,
  type EditorMode,
} from '@plannotator/ui/types';
import type { Comment, Revision } from '../shared/types';

export type Comparison = { base: Revision; target: Revision };
export default function RevisionDiff({
  path,
  comparison,
  comments,
  selected,
  canComment,
  mode,
  onMode,
  diffMode,
  onDiffMode,
  wide,
  onComment,
  onSelect,
  onExit,
}: {
  path: string;
  comparison: Comparison;
  comments: Comment[];
  selected: string | null;
  canComment: boolean;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  diffMode: 'clean' | 'classic' | 'raw';
  onDiffMode: (mode: 'clean' | 'classic' | 'raw') => void;
  wide: boolean;
  onComment: (annotation: Annotation) => void;
  onSelect: (id: string | null) => void;
  onExit: () => void;
}) {
  const diff = useMemo(
    () => computePlanDiff(comparison.base.body, comparison.target.body),
    [comparison],
  );
  const annotations = useMemo(
    () =>
      comments
        .filter(
          (c) =>
            !c.resolved &&
            c.revisionId === comparison.target.id &&
            c.diff?.baseRevisionId === comparison.base.id,
        )
        .map(
          (c): Annotation => ({
            id: c.id,
            blockId: `diff-block-${c.diff!.blockIndex}`,
            startOffset: 0,
            endOffset: c.quote.length,
            originalText: c.quote,
            text: c.body,
            diffContext: c.diff!.side,
            type:
              c.kind === 'deletion'
                ? AnnotationType.DELETION
                : AnnotationType.COMMENT,
            isQuickLabel: c.kind === 'label',
            quickLabelTip: c.labelTip ?? undefined,
            author: c.authorName,
            createdA: Date.parse(c.createdAt),
          }),
        ),
    [comments, comparison],
  );
  if (artifactFormat(path) !== 'markdown')
    return (
      <div className="revision-diff">
        <div className="annotation-controls">
          <span>
            Source changes · revision {comparison.base.number} →{' '}
            {comparison.target.number}
          </span>
          <button className="button" onClick={onExit}>
            Back to artifact
          </button>
        </div>
        <p className="muted small">
          Return to the artifact to comment on the rendered revision.
        </p>
        <PlanRawDiffView blocks={diff.blocks} />
      </div>
    );
  return (
    <div className="revision-diff">
      {canComment && (
        <div
          className="annotation-controls"
          role="region"
          aria-label="Review tools"
        >
          <AnnotationToolstrip
            inputMethod="pinpoint"
            onInputMethodChange={() => {}}
            mode={mode}
            onModeChange={onMode}
            showHelpLink={false}
            hideInputMethodSwitch
          />
          <p>
            {diffMode === 'raw'
              ? 'Use Rendered or Classic to comment on changes.'
              : 'Click a changed passage to discuss it. Comments retain both revision IDs.'}
          </p>
        </div>
      )}
      <PlanDiffViewer
        diffBlocks={diff.blocks}
        diffStats={diff.stats}
        diffMode={diffMode}
        onDiffModeChange={onDiffMode}
        baseVersionLabel={`Revision ${comparison.base.number} → ${comparison.target.number}`}
        onPlanDiffToggle={onExit}
        maxWidth={wide ? 100000 : 832}
        annotations={annotations}
        selectedAnnotationId={selected}
        onAddAnnotation={canComment ? onComment : undefined}
        onSelectAnnotation={onSelect}
        mode={mode}
      />
    </div>
  );
}
