// Read-only Postgres queries for the metrics dashboard (FR-5.7).
//
// BR-10 (AI-vs-human split) and BR-11 (rate definitions).

import type { Pool } from "pg";
import { readEscapeRateSummary, type EscapeRateSummary } from "../escapeLinkage/store";

export interface DashboardMetrics {
  aiPrCount: number;
  humanPrCount: number;
  avgCycleTimeMinutesByConfidence: { ai: number | undefined; human: number | undefined };
  avgReviewCommentCountByConfidence: { ai: number | undefined; human: number | undefined };
  // Raw counts, not a pre-computed fraction — deliberately kept
  // unmerged (BR-2/FR-5.6's confirmed-vs-heuristic split), same
  // EscapeRateSummary shape EscapeLinkageStore already returns.
  escapeRate: EscapeRateSummary;
  // Both undefined when no PR has this feature evaluated yet (0 rows
  // with a non-NULL value), distinct from a real 0% rate — mirrors
  // pr_metrics's own "unset vs. zero" distinction for these columns.
  gatePolicyBlockRate: number | undefined;
  consistencyFindingRate: number | undefined;
}

interface AggregateRow {
  ai_pr_count: string;
  human_pr_count: string;
  ai_avg_cycle_time: string | null;
  human_avg_cycle_time: string | null;
  ai_avg_comment_count: string | null;
  human_avg_comment_count: string | null;
  gate_policy_evaluated_count: string;
  gate_policy_blocked_count: string;
  consistency_evaluated_count: string;
  consistency_with_findings_count: string;
}

// BR-10: "AI-authored" is confidence IN ('definite', 'likely') — the same
// two-of-three grouping FR-1.4's confidence levels have used for gating
// decisions elsewhere (e.g. gatePolicy.scope: "ai-only"); "human" is
// confidence = 'none'. Not re-deriving this split independently — reusing
// the existing, already-established meaning of "AI-authored" throughout
// this project.
const AGGREGATE_SQL = `
  SELECT
    count(*) FILTER (WHERE confidence IN ('definite', 'likely')) AS ai_pr_count,
    count(*) FILTER (WHERE confidence = 'none') AS human_pr_count,
    avg(time_to_merge_minutes) FILTER (WHERE confidence IN ('definite', 'likely')) AS ai_avg_cycle_time,
    avg(time_to_merge_minutes) FILTER (WHERE confidence = 'none') AS human_avg_cycle_time,
    avg(review_comment_count) FILTER (WHERE confidence IN ('definite', 'likely')) AS ai_avg_comment_count,
    avg(review_comment_count) FILTER (WHERE confidence = 'none') AS human_avg_comment_count,
    count(*) FILTER (WHERE gate_policy_blocked IS NOT NULL) AS gate_policy_evaluated_count,
    count(*) FILTER (WHERE gate_policy_blocked = true) AS gate_policy_blocked_count,
    count(*) FILTER (WHERE consistency_finding_count IS NOT NULL) AS consistency_evaluated_count,
    count(*) FILTER (WHERE consistency_finding_count > 0) AS consistency_with_findings_count
  FROM pr_metrics
`;

function toNumberOrUndefined(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}

// BR-11: a rate is undefined (not 0) when its denominator (the evaluated
// count) is zero — "no PR has this feature evaluated yet" is distinct
// from "evaluated, and the rate is 0%."
function rateOrUndefined(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

// F1: no per-repo/per-team breakdown in this wave (aggregate only, per
// the requirements decision) — mirrors EscapeLinkageStore's own
// no-repo-filter default.
export async function fetchDashboardMetrics(pool: Pool): Promise<DashboardMetrics> {
  const [aggregateResult, escapeRate] = await Promise.all([
    pool.query<AggregateRow>(AGGREGATE_SQL),
    readEscapeRateSummary(),
  ]);
  const row = aggregateResult.rows[0];

  const gatePolicyEvaluatedCount = Number(row?.gate_policy_evaluated_count ?? 0);
  const consistencyEvaluatedCount = Number(row?.consistency_evaluated_count ?? 0);

  return {
    aiPrCount: Number(row?.ai_pr_count ?? 0),
    humanPrCount: Number(row?.human_pr_count ?? 0),
    avgCycleTimeMinutesByConfidence: {
      ai: toNumberOrUndefined(row?.ai_avg_cycle_time ?? null),
      human: toNumberOrUndefined(row?.human_avg_cycle_time ?? null),
    },
    avgReviewCommentCountByConfidence: {
      ai: toNumberOrUndefined(row?.ai_avg_comment_count ?? null),
      human: toNumberOrUndefined(row?.human_avg_comment_count ?? null),
    },
    escapeRate,
    gatePolicyBlockRate: rateOrUndefined(Number(row?.gate_policy_blocked_count ?? 0), gatePolicyEvaluatedCount),
    consistencyFindingRate: rateOrUndefined(
      Number(row?.consistency_with_findings_count ?? 0),
      consistencyEvaluatedCount
    ),
  };
}
