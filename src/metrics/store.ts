// Postgres persistence for PrMetrics.
//
// BR-5. No dashboard in this milestone — data just needs to be queryable.

import type { PrMetrics } from "./capture";
import { getPool } from "./db";

// gate_policy_blocked/consistency_finding_count use COALESCE(EXCLUDED, ...)
// rather than an unconditional overwrite like every other column here —
// found during implementation: captureAndSaveMetrics is called
// from two paths (the opened/synchronize handler, which computes fresh
// gate-policy/consistency results every time, and the closed/
// review_submitted metrics-only path, which never computes them at all).
// An unconditional SET would let the metrics-only path's NULL values
// silently clobber a real result an earlier opened/synchronize event
// already wrote for the same PR — the exact class of data-loss bug Wave
// 1's post-merge-review filtering (BR-2) was built to prevent, just for
// these two new columns. COALESCE means: when this call actually
// computed a value, use it (including overwriting an earlier value, e.g.
// a re-run after a synchronize that fixed a gate-policy violation); when
// it didn't (undefined -> NULL parameter), keep whatever's already
// stored.
const UPSERT_SQL = `
  INSERT INTO pr_metrics (repo, pr_id, confidence, time_to_first_review_minutes, time_to_merge_minutes, review_comment_count, gate_policy_blocked, consistency_finding_count)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (repo, pr_id) DO UPDATE SET
    confidence = EXCLUDED.confidence,
    time_to_first_review_minutes = EXCLUDED.time_to_first_review_minutes,
    time_to_merge_minutes = EXCLUDED.time_to_merge_minutes,
    review_comment_count = EXCLUDED.review_comment_count,
    gate_policy_blocked = COALESCE(EXCLUDED.gate_policy_blocked, pr_metrics.gate_policy_blocked),
    consistency_finding_count = COALESCE(EXCLUDED.consistency_finding_count, pr_metrics.consistency_finding_count)
`;

// BR-5: upsert on (repo, pr_id) — every subsequent event for the same PR
// updates the existing row rather than creating a duplicate.
export async function saveMetrics(metrics: PrMetrics): Promise<void> {
  const pool = getPool();
  await pool.query(UPSERT_SQL, [
    metrics.repo,
    metrics.prId,
    metrics.confidence,
    metrics.timeToFirstReviewMinutes ?? null,
    metrics.timeToMergeMinutes ?? null,
    metrics.reviewCommentCount,
    metrics.gatePolicyBlocked ?? null,
    metrics.consistencyFindingCount ?? null,
  ]);
}
