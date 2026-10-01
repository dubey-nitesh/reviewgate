// Integration tests for src/escapeLinkage/store.ts against a real
// Postgres instance — the precedence-aware upsert (BR-1) lives entirely
// in the SQL's WHERE clause, which a mocked pool.query() can't actually
// execute; this is the only way to verify the precedence comparison
// itself is correct, not just that it's present in the query text.
//
// Requires DATABASE_URL to point at a real (throwaway) Postgres database
// with migrations/001_init.sql already applied. Skips entirely if
// DATABASE_URL isn't set, same convention as
// tests/integration/metrics-store.integration.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { DetectionMethod } from "../../src/escapeLinkage/store";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("EscapeLinkageStore (integration, real Postgres)", () => {
  let pool: Pool;
  let upsertEscapeRecord: (record: {
    repo: string;
    issueNumber: number;
    sourcePrId: number;
    detectionMethod: DetectionMethod;
  }) => Promise<void>;
  let readEscapeRateSummary: (repo?: string) => Promise<{ confirmedCount: number; heuristicCount: number }>;
  let closePool: () => Promise<void>;

  beforeAll(async () => {
    ({ upsertEscapeRecord, readEscapeRateSummary } = await import("../../src/escapeLinkage/store"));
    ({ closePool } = await import("../../src/metrics/db"));
    const sslDisabled = process.env.DATABASE_SSL === "false";
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslDisabled ? false : { rejectUnauthorized: true },
    });
    await pool.query("DELETE FROM escape_records WHERE repo = 'integration-test/repo'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM escape_records WHERE repo = 'integration-test/repo'");
    await pool.end();
    await closePool();
  });

  it("is idempotent: applying the same record twice results in exactly one row", async () => {
    const record = {
      repo: "integration-test/repo",
      issueNumber: 1001,
      sourcePrId: 501,
      detectionMethod: "commit-linked" as const,
    };
    await upsertEscapeRecord(record);
    await upsertEscapeRecord(record);

    const { rows } = await pool.query("SELECT * FROM escape_records WHERE repo = $1 AND issue_number = $2", [
      record.repo,
      record.issueNumber,
    ]);
    expect(rows).toHaveLength(1);
  });

  // BR-1: a higher-precedence write overwrites a lower-precedence one.
  it("lets a manual override replace an existing commit-linked record", async () => {
    const repo = "integration-test/repo";
    const issueNumber = 1002;
    await upsertEscapeRecord({ repo, issueNumber, sourcePrId: 501, detectionMethod: "commit-linked" });
    await upsertEscapeRecord({ repo, issueNumber, sourcePrId: 999, detectionMethod: "manual" });

    const { rows } = await pool.query("SELECT * FROM escape_records WHERE repo = $1 AND issue_number = $2", [
      repo,
      issueNumber,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].detection_method).toBe("manual");
    expect(rows[0].source_pr_id).toBe(999);
  });

  // BR-1: a lower-precedence write must NOT overwrite a higher-precedence
  // existing record — the core correctness guarantee this whole precedence
  // scheme exists for.
  it("does not let a heuristic detection overwrite an existing manual override", async () => {
    const repo = "integration-test/repo";
    const issueNumber = 1003;
    await upsertEscapeRecord({ repo, issueNumber, sourcePrId: 999, detectionMethod: "manual" });
    await upsertEscapeRecord({ repo, issueNumber, sourcePrId: 111, detectionMethod: "time-window-heuristic" });

    const { rows } = await pool.query("SELECT * FROM escape_records WHERE repo = $1 AND issue_number = $2", [
      repo,
      issueNumber,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].detection_method).toBe("manual");
    expect(rows[0].source_pr_id).toBe(999);
  });

  it("does not let commit-linked overwrite manual, but does let it overwrite heuristic", async () => {
    const repo = "integration-test/repo";
    const issueA = 1004;
    const issueB = 1005;
    await upsertEscapeRecord({ repo, issueNumber: issueA, sourcePrId: 999, detectionMethod: "manual" });
    await upsertEscapeRecord({ repo, issueNumber: issueA, sourcePrId: 222, detectionMethod: "commit-linked" });

    await upsertEscapeRecord({ repo, issueNumber: issueB, sourcePrId: 333, detectionMethod: "time-window-heuristic" });
    await upsertEscapeRecord({ repo, issueNumber: issueB, sourcePrId: 444, detectionMethod: "commit-linked" });

    const { rows: rowsA } = await pool.query("SELECT * FROM escape_records WHERE repo = $1 AND issue_number = $2", [
      repo,
      issueA,
    ]);
    expect(rowsA[0].detection_method).toBe("manual");

    const { rows: rowsB } = await pool.query("SELECT * FROM escape_records WHERE repo = $1 AND issue_number = $2", [
      repo,
      issueB,
    ]);
    expect(rowsB[0].detection_method).toBe("commit-linked");
    expect(rowsB[0].source_pr_id).toBe(444);
  });

  it("readEscapeRateSummary correctly separates confirmed from heuristic counts", async () => {
    // Use a distinct repo so this test's count is not contaminated by the
    // records accumulated in the preceding it() blocks (1001-1005, all
    // targeting "integration-test/repo").
    const repo = "integration-test/summary-repo";
    await pool.query("DELETE FROM escape_records WHERE repo = $1", [repo]);
    await upsertEscapeRecord({ repo, issueNumber: 2001, sourcePrId: 1, detectionMethod: "manual" });
    await upsertEscapeRecord({ repo, issueNumber: 2002, sourcePrId: 2, detectionMethod: "commit-linked" });
    await upsertEscapeRecord({ repo, issueNumber: 2003, sourcePrId: 3, detectionMethod: "time-window-heuristic" });

    const summary = await readEscapeRateSummary(repo);
    expect(summary).toEqual({ confirmedCount: 2, heuristicCount: 1 });

    await pool.query("DELETE FROM escape_records WHERE repo = $1", [repo]);
  });
});
