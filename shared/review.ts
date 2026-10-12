import type { ReviewDecision } from './types.ts';

// One person's latest decision on this exact revision; history stays append-only.
export function currentDecisions(
  reviews: ReviewDecision[],
  revisionId: string,
) {
  const latest = new Map<string, ReviewDecision>();
  for (const review of reviews) {
    if (review.revisionId === revisionId) latest.set(review.reviewerId, review);
  }
  return [...latest.values()].filter((r) => r.decision !== 'withdrawn');
}
export function reviewStatus(reviews: ReviewDecision[], revisionId: string) {
  const current = currentDecisions(reviews, revisionId);
  if (current.some((r) => r.decision === 'changes_requested'))
    return 'Changes requested';
  if (current.some((r) => r.decision === 'approved')) return 'Approved';
  const earlierIds = new Set(
    reviews.filter((r) => r.revisionId !== revisionId).map((r) => r.revisionId),
  );
  if (
    [...earlierIds].some((id) =>
      currentDecisions(reviews, id).some((r) => r.decision === 'approved'),
    )
  )
    return 'Changes since approval';
  return 'Needs review';
}
