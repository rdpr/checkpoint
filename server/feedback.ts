import type { Comment, Revision, ReviewDecision } from '../shared/types.ts';
import { currentDecisions, reviewStatus } from '../shared/review.ts';
import {
  diagramAnchorLocationLine,
  parseDiagramAnchor,
} from '@plannotator/core/diagram-anchor';

// Deliberately plain Markdown: useful to people and MCP clients, with source
// revisions and resolution retained so old feedback cannot look like new approval.
export function formatFeedback(
  path: string,
  revision: Revision,
  reviews: ReviewDecision[],
  comments: Comment[],
  revisions: Omit<Revision, 'body'>[],
) {
  const numbers = new Map(revisions.map((r) => [r.id, r.number]));
  const decisions = reviews.filter((r) => r.revisionNumber <= revision.number);
  const lines = [
    `# Review feedback: ${path}`,
    '',
    `Revision ${revision.number} (${revision.id})`,
    `Status: ${reviewStatus(decisions, revision.id)}`,
    '',
    '## Review decisions',
    '',
  ];
  const active = currentDecisions(decisions, revision.id);
  if (!active.length) lines.push('No active decisions on this revision.');
  for (const r of active) {
    lines.push(
      `- ${r.reviewerName}: ${r.decision === 'approved' ? 'Approved' : 'Changes requested'} — ${r.createdAt}`,
    );
    if (r.note) lines.push(...r.note.split('\n').map((l) => `  > ${l}`));
  }
  lines.push(
    '',
    '## Discussions',
    '',
    'Earlier-revision quotes and diagram locations refer to their original revision. Resolved threads are included for context.',
    '',
  );
  for (const c of comments.filter(
    (c) => (numbers.get(c.revisionId) ?? Infinity) <= revision.number,
  )) {
    lines.push(
      `### ${c.kind === 'deletion' ? 'Suggested deletion' : c.kind === 'label' ? 'Label' : 'Comment'} · ${c.resolved ? 'Resolved' : 'Open'}`,
      `${c.agentName ? `${c.agentName} (for ${c.authorName})` : c.authorName} · revision ${numbers.get(c.revisionId)} · ${c.createdAt}`,
      `Discussion ID: ${c.id}`,
      '',
    );
    if (c.diff)
      lines.push(
        `Comparison: revision ${numbers.get(c.diff.baseRevisionId)} → ${numbers.get(c.revisionId)} · ${c.diff.side} passage (block ${c.diff.blockIndex + 1})`,
        `Baseline ID: ${c.diff.baseRevisionId}; target ID: ${c.revisionId}`,
        '',
      );
    for (const a of c.reattachments.filter(
      (a) => a.revisionNumber <= revision.number,
    )) {
      lines.push(
        `Reattached to revision ${a.revisionNumber} (${a.revisionId}) by ${a.agentName ?? a.authorName} · ${a.createdAt}`,
        ...a.quote.split('\n').map((l) => `> ${l}`),
        '',
        'Original passage:',
        '',
      );
    }
    if (c.quote) lines.push(...c.quote.split('\n').map((l) => `> ${l}`), '');
    const diagram = parseDiagramAnchor(c.anchor?.diagramAnchor);
    if (diagram) lines.push(diagramAnchorLocationLine(diagram), '');
    if (c.body) lines.push(c.body, '');
    if (c.labelTip) lines.push(`Label instruction: ${c.labelTip}`, '');
    for (const image of c.images)
      lines.push(
        `Attachment: ${image.name} — ${image.path} (workspace sign-in required)`,
      );
    for (const reply of c.replies)
      lines.push(
        '',
        `Reply — ${reply.agentName ?? reply.authorName} · ${reply.createdAt}`,
        ...reply.body.split('\n').map((l) => `> ${l}`),
      );
    lines.push('');
  }
  return lines.join('\n');
}
