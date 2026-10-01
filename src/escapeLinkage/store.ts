// Postgres persistence for defect-escape records (stories E1-E4).
//
// BR-1 (precedence) and BR-2 (confirmed/heuristic split).

import { getPool } from "../metrics/db";

export type DetectionMethod = "manual" | "commit-linked" | "time-window-heuristic";

export interface EscapeRecord {
  repo: string;
  issueNumber: number;
  sourcePrId: number;
  detectionMethod: DetectionMethod;
}

// BR-1: precedence order, highest first. A write only takes effect when
// its method's rank is >= whatever's already stored for the same (repo,
// issueNumber) — enforced in SQL (not read-then-write in application
// code) so it's correct regardless of which caller's write reaches
// Postgres first, including two overlapping webhook deliveries.
const PRECEDENCE_CASE = `
  CASE detection_method
    WHEN 'manual' THEN 3
    WHEN 'commit-linked' THEN 2
    WHEN 'time-window-heuristic' THEN 1
  END
`;

const UPSERT_SQL = `
  INSERT INTO escape_records (repo, issue_number, source_pr_id, detection_method)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (repo, issue_number) DO UPDATE SET
    source_pr_id = EXCLUDED.source_pr_id,
    detection_method = EXCLUDED.detection_method,
    detected_at = now()
  WHERE
    (${PRECEDENCE_CASE.replace(/detection_method/g, "EXCLUDED.detection_method")})
    >=
    (${PRECEDENCE_CASE.replace(/detection_method/g, "escape_records.detection_method")})
`;

// BR-1: a lower-precedence detection for a (repo, issueNumber) pair
// that already has a higher-precedence record is a silent no-op — not
// an error, not a partial write. Never throws on a duplicate/no-op
// write (the WHERE clause above makes Postgres itself skip the row,
// there's nothing exceptional about that outcome).
//
// The >= (not >) means a same-tier write always replaces the existing
// row. That's required for idempotent redelivery of the *same*
// detection (e.g. a redelivered issues.opened webhook), but it also
// means two *different* same-tier detections for the same issue (e.g.
// two separate merged PRs both saying "Fixes #42") last-write-wins with
// no record kept of the one that lost — accepted as out of scope for
// this wave rather than a bug; only one source PR is tracked per issue.
export async function upsertEscapeRecord(record: EscapeRecord): Promise<void> {
  const pool = getPool();
  await pool.query(UPSERT_SQL, [record.repo, record.issueNumber, record.sourcePrId, record.detectionMethod]);
}

// BR-2: confirmed (manual + commit-linked) and heuristic
// (time-window-heuristic) counts are always returned separately, never
// pre-summed — enforces FR-5.6/E4 at this read boundary, not just by
// caller convention.
export interface EscapeRateSummary {
  confirmedCount: number;
  heuristicCount: number;
}

const SUMMARY_SQL = `
  SELECT
    count(*) FILTER (WHERE detection_method IN ('manual', 'commit-linked')) AS confirmed_count,
    count(*) FILTER (WHERE detection_method = 'time-window-heuristic') AS heuristic_count
  FROM escape_records
  WHERE ($1::text IS NULL OR repo = $1)
`;

// repo omitted (undefined) means aggregate across all repos — F1's
// no-per-repo-breakdown decision.
export async function readEscapeRateSummary(repo?: string): Promise<EscapeRateSummary> {
  const pool = getPool();
  const result = await pool.query<{ confirmed_count: string; heuristic_count: string }>(SUMMARY_SQL, [repo ?? null]);
  const row = result.rows[0];
  return {
    confirmedCount: Number(row?.confirmed_count ?? 0),
    heuristicCount: Number(row?.heuristic_count ?? 0),
  };
}
