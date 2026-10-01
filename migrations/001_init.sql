-- Schema for reviewgate's pr_metrics table.
--
-- `confidence` replaces the original draft's `is_ai_authored BOOLEAN`: per
-- FR-1.4, authorship is tracked as a three-level confidence (definite /
-- likely / none), not a single boolean.
CREATE TABLE IF NOT EXISTS pr_metrics (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    pr_id INTEGER NOT NULL,
    confidence TEXT NOT NULL CHECK (confidence IN ('definite', 'likely', 'none')),
    time_to_first_review_minutes INTEGER,
    time_to_merge_minutes INTEGER,
    review_comment_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repo, pr_id)
);

-- Forward-migrates a database still on the old is_ai_authored BOOLEAN
-- column (CREATE TABLE IF NOT EXISTS above is a no-op against it, since
-- this file has been edited in place rather than versioned as separate
-- migrations). If a future schema draft changes this table again before
-- release, add a matching guard.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pr_metrics' AND column_name = 'is_ai_authored'
    ) THEN
        ALTER TABLE pr_metrics ADD COLUMN confidence TEXT;
        UPDATE pr_metrics SET confidence = CASE WHEN is_ai_authored THEN 'definite' ELSE 'none' END;
        ALTER TABLE pr_metrics ALTER COLUMN confidence SET NOT NULL;
        ALTER TABLE pr_metrics ADD CONSTRAINT pr_metrics_confidence_check
            CHECK (confidence IN ('definite', 'likely', 'none'));
        ALTER TABLE pr_metrics DROP COLUMN is_ai_authored;
    END IF;
END $$;

-- Closes the persistence gap identified while adding the metrics
-- dashboard — the gate-policy/consistency results were never persisted
-- anywhere before this, only ever rendered into the
-- check-run/PR comment and discarded. Both nullable: NULL means "this
-- feature wasn't enabled/evaluated for this PR," distinct from a real
-- false/zero result — the dashboard must be able to tell "no gate-policy
-- data" apart from "gate-policy ran and found nothing," same reasoning
-- as this table's own optional time-to-*-minutes columns.
ALTER TABLE pr_metrics ADD COLUMN IF NOT EXISTS gate_policy_blocked BOOLEAN;
ALTER TABLE pr_metrics ADD COLUMN IF NOT EXISTS consistency_finding_count INTEGER;

-- One row per (repo, issue) that has a detected or manually-supplied
-- escape link back to the PR that introduced it. UNIQUE (repo,
-- issue_number) is the same key
-- EscapeLinkageStore's precedence-aware upsert (BR-1) operates against —
-- only one source PR is tracked per issue at a time, the highest-
-- precedence one found so far.
CREATE TABLE IF NOT EXISTS escape_records (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    source_pr_id INTEGER NOT NULL,
    detection_method TEXT NOT NULL CHECK (detection_method IN ('manual', 'commit-linked', 'time-window-heuristic')),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repo, issue_number)
);
