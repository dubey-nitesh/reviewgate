// Captures per-PR cycle-time metrics (time-to-first-review, time-to-merge,
// review comment count) tagged AI vs human.
//
// BR-1 through BR-4.

import type { Confidence } from "../detectors/confidence";

// gatePolicyBlocked/consistencyFindingCount: closes the persistence gap
// identified while adding the metrics dashboard — checkConsistency/
// checkGatePolicy results were never persisted anywhere before this,
// only rendered into the check-run/comment and discarded. Both undefined
// (not false/0) when that feature wasn't enabled/evaluated for this PR —
// distinct from a real "ran and found nothing" result, same "unset vs.
// zero" distinction BR-1 already established for the time-to-*-minutes
// fields.
export interface PrMetrics {
  prId: number;
  repo: string;
  confidence: Confidence;
  timeToFirstReviewMinutes?: number;
  timeToMergeMinutes?: number;
  reviewCommentCount: number;
  gatePolicyBlocked?: boolean;
  consistencyFindingCount?: number;
}

// What computeMetrics needs, extracted from the webhook payload by the
// orchestration layer (index.ts) — keeps this function free of GitHub
// API/Octokit types (component-dependency.md's decoupling decision).
export interface PrEventContext {
  prId: number;
  repo: string;
  openedAt: string;
  firstReviewAt?: string;
  mergedAt?: string;
  reviewCommentCount: number;
}

export interface ComputeMetricsResult {
  metrics: PrMetrics;
  warnings: string[];
}

function minutesBetween(earlier: string, later: string): number {
  return Math.round((new Date(later).getTime() - new Date(earlier).getTime()) / 60000);
}

// findingsSummary: passed through verbatim, same as `confidence`
// (BR-4) — computeMetrics doesn't re-derive or validate the consistency
// checker's/gate policy's already-computed results, it only carries them
// to the persisted row.
export interface FindingsSummary {
  gatePolicyBlocked?: boolean;
  consistencyFindingCount?: number;
}

// Pure function — no I/O, no logging. Validation issues (BR-2, BR-3) are
// returned as `warnings` for the orchestration layer to log, keeping this
// function fully unit-testable and PBT-able in isolation.
export function computeMetrics(
  event: PrEventContext,
  confidence: Confidence,
  findingsSummary: FindingsSummary = {}
): ComputeMetricsResult {
  const warnings: string[] = [];

  // BR-1: unset (not 0) when the corresponding event hasn't happened.
  let timeToFirstReviewMinutes = event.firstReviewAt
    ? minutesBetween(event.openedAt, event.firstReviewAt)
    : undefined;
  let timeToMergeMinutes = event.mergedAt ? minutesBetween(event.openedAt, event.mergedAt) : undefined;

  // BR-3: non-negative constraint — a negative value indicates an upstream
  // timestamp-ordering bug; drop the offending field rather than persist it.
  // Also guards against NaN (an unparseable timestamp): Date.parse of a
  // malformed string produces NaN, which fails every comparison including
  // `< 0`, so a naive negative-only check would let it through undetected
  // — found during a code-review pass. Written explicitly as two
  // conditions (rather than relying on `!(x >= 0)`'s implicit NaN-fails-
  // comparison behavior) so the intent is legible without the reader
  // needing to reason about NaN comparison semantics.
  if (
    timeToFirstReviewMinutes !== undefined &&
    (!Number.isFinite(timeToFirstReviewMinutes) || timeToFirstReviewMinutes < 0)
  ) {
    warnings.push(`timeToFirstReviewMinutes was invalid (${timeToFirstReviewMinutes}); dropped`);
    timeToFirstReviewMinutes = undefined;
  }
  if (
    timeToMergeMinutes !== undefined &&
    (!Number.isFinite(timeToMergeMinutes) || timeToMergeMinutes < 0)
  ) {
    warnings.push(`timeToMergeMinutes was invalid (${timeToMergeMinutes}); dropped`);
    timeToMergeMinutes = undefined;
  }

  // BR-2: review-before-merge invariant — when both are present and the
  // ordering is violated, neither value can be trusted; drop both.
  if (
    timeToFirstReviewMinutes !== undefined &&
    timeToMergeMinutes !== undefined &&
    timeToFirstReviewMinutes > timeToMergeMinutes
  ) {
    warnings.push(
      `timeToFirstReviewMinutes (${timeToFirstReviewMinutes}) exceeded timeToMergeMinutes (${timeToMergeMinutes}); both dropped`
    );
    timeToFirstReviewMinutes = undefined;
    timeToMergeMinutes = undefined;
  }

  return {
    metrics: {
      prId: event.prId,
      repo: event.repo,
      // BR-4: confidence is passed through verbatim from the
      // authorship-detection module's AuthorshipResult — no independent
      // re-derivation.
      confidence,
      timeToFirstReviewMinutes,
      timeToMergeMinutes,
      reviewCommentCount: event.reviewCommentCount,
      gatePolicyBlocked: findingsSummary.gatePolicyBlocked,
      consistencyFindingCount: findingsSummary.consistencyFindingCount,
    },
    warnings,
  };
}
