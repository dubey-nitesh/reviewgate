// Integration tests for src/metrics/store.ts against a real Postgres
// instance — closes the PBT-01 properties the design docs explicitly
// deferred to build-and-test ("requires a test DB / testcontainer"):
//   - saveMetrics idempotence: applying it twice with the same value
//     results in exactly one row (Testable Properties table)
//   - PrMetrics schema round-trip: write via saveMetrics, read back via a
//     direct SELECT, values match
//
// Requires DATABASE_URL to point at a real (throwaway) Postgres database
// with migrations/001_init.sql already applied. Skips entirely if
// DATABASE_URL isn't set, so this doesn't fail environments without a
// database configured (e.g. this project's own CI, which has no Postgres
// service yet — see build-instructions.md for how to run this locally).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import fc from "fast-check";
import type { PrMetrics } from "../../src/metrics/capture";

const hasDatabase = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDatabase)("saveMetrics (integration, real Postgres)", () => {
  let pool: Pool;
  let saveMetrics: (metrics: PrMetrics) => Promise<void>;
  let closePool: () => Promise<void>;

  beforeAll(async () => {
    // Import after DATABASE_URL is confirmed set, since src/metrics/db.ts
    // reads it at first getPool() call, not at module-level import time.
    ({ saveMetrics } = await import("../../src/metrics/store"));
    ({ closePool } = await import("../../src/metrics/db"));
    // This test's own verification pool reads DATABASE_SSL the same way
    // src/metrics/db.ts does, rather than hardcoding ssl: false — otherwise
    // the two connections' TLS settings can silently diverge (e.g. this
    // pool connecting insecurely while saveMetrics's internal pool, via
    // getPool(), still defaults to requiring TLS and fails), which is the
    // exact SSL mismatch documented in integration-test-instructions.md.
    const sslDisabled = process.env.DATABASE_SSL === "false";
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslDisabled ? false : { rejectUnauthorized: true },
    });
    await pool.query("DELETE FROM pr_metrics WHERE repo = 'integration-test/repo'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM pr_metrics WHERE repo = 'integration-test/repo'");
    await pool.end();
    // Also close the pool saveMetrics lazily created internally via
    // getPool() — without this, that pool's open connections/timers keep
    // the process alive after this suite finishes.
    await closePool();
  });

  it("is idempotent: applying the same metrics twice results in exactly one row", async () => {
    const metrics: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1001,
      confidence: "definite",
      timeToFirstReviewMinutes: 30,
      timeToMergeMinutes: 90,
      reviewCommentCount: 4,
    };

    await saveMetrics(metrics);
    await saveMetrics(metrics);

    const { rows } = await pool.query(
      "SELECT * FROM pr_metrics WHERE repo = $1 AND pr_id = $2",
      [metrics.repo, metrics.prId]
    );
    expect(rows).toHaveLength(1);
  });

  it("round-trips a PrMetrics value through saveMetrics and a direct SELECT", async () => {
    const metrics: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1002,
      confidence: "likely",
      timeToFirstReviewMinutes: 45,
      timeToMergeMinutes: 120,
      reviewCommentCount: 7,
    };

    await saveMetrics(metrics);

    const { rows } = await pool.query(
      "SELECT repo, pr_id, confidence, time_to_first_review_minutes, time_to_merge_minutes, review_comment_count FROM pr_metrics WHERE repo = $1 AND pr_id = $2",
      [metrics.repo, metrics.prId]
    );
    expect(rows[0]).toMatchObject({
      repo: metrics.repo,
      pr_id: metrics.prId,
      confidence: metrics.confidence,
      time_to_first_review_minutes: metrics.timeToFirstReviewMinutes,
      time_to_merge_minutes: metrics.timeToMergeMinutes,
      review_comment_count: metrics.reviewCommentCount,
    });
  });

  it("a later upsert with different values updates the row, not duplicates it", async () => {
    const first: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1003,
      confidence: "none",
      reviewCommentCount: 0,
    };
    const updated: PrMetrics = {
      ...first,
      confidence: "definite",
      timeToMergeMinutes: 15,
      reviewCommentCount: 2,
    };

    await saveMetrics(first);
    await saveMetrics(updated);

    const { rows } = await pool.query("SELECT * FROM pr_metrics WHERE repo = $1 AND pr_id = $2", [
      first.repo,
      first.prId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe("definite");
    expect(rows[0].time_to_merge_minutes).toBe(15);
  });

  // Regression test (code-review pass): gate_policy_blocked/
  // consistency_finding_count use COALESCE(EXCLUDED, existing), not an
  // unconditional overwrite — a mocked pool.query() can't execute real
  // SQL, so this is the only way to verify the COALESCE actually
  // preserves an earlier value rather than just asserting the query text
  // contains the word (already covered separately in store.test.ts).
  it("preserves gate_policy_blocked/consistency_finding_count when a later upsert omits them", async () => {
    const withFindings: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1004,
      confidence: "definite",
      reviewCommentCount: 1,
      gatePolicyBlocked: true,
      consistencyFindingCount: 3,
    };
    const metricsOnlyFollowUp: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1004,
      confidence: "definite",
      reviewCommentCount: 2,
      // gatePolicyBlocked/consistencyFindingCount omitted — simulates the
      // closed/review_submitted metrics-only path.
    };

    await saveMetrics(withFindings);
    await saveMetrics(metricsOnlyFollowUp);

    const { rows } = await pool.query("SELECT * FROM pr_metrics WHERE repo = $1 AND pr_id = $2", [
      withFindings.repo,
      withFindings.prId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].gate_policy_blocked).toBe(true);
    expect(rows[0].consistency_finding_count).toBe(3);
    // The fields the follow-up DID provide still update normally.
    expect(rows[0].review_comment_count).toBe(2);
  });

  it("does overwrite gate_policy_blocked/consistency_finding_count when a later upsert provides new values", async () => {
    const first: PrMetrics = {
      repo: "integration-test/repo",
      prId: 1005,
      confidence: "definite",
      reviewCommentCount: 0,
      gatePolicyBlocked: true,
      consistencyFindingCount: 5,
    };
    const updated: PrMetrics = {
      ...first,
      gatePolicyBlocked: false,
      consistencyFindingCount: 0,
    };

    await saveMetrics(first);
    await saveMetrics(updated);

    const { rows } = await pool.query("SELECT * FROM pr_metrics WHERE repo = $1 AND pr_id = $2", [
      first.repo,
      first.prId,
    ]);
    expect(rows[0].gate_policy_blocked).toBe(false);
    expect(rows[0].consistency_finding_count).toBe(0);
  });

  // PBT-01: schema round-trip property, run against the real database
  // rather than a mock — for any valid PrMetrics, write-then-read
  // reproduces the same field values.
  it("round-trips arbitrary valid PrMetrics values (property)", async () => {
    const metricsArb: fc.Arbitrary<PrMetrics> = fc.record({
      repo: fc.constant("integration-test/repo"),
      prId: fc.integer({ min: 2000, max: 2999 }),
      confidence: fc.constantFrom("definite", "likely", "none"),
      timeToFirstReviewMinutes: fc.option(fc.nat(10000), { nil: undefined }),
      timeToMergeMinutes: fc.option(fc.nat(10000), { nil: undefined }),
      reviewCommentCount: fc.nat(1000),
    });

    await fc.assert(
      fc.asyncProperty(metricsArb, async (metrics) => {
        await saveMetrics(metrics);
        const { rows } = await pool.query(
          "SELECT confidence, time_to_first_review_minutes, time_to_merge_minutes, review_comment_count FROM pr_metrics WHERE repo = $1 AND pr_id = $2",
          [metrics.repo, metrics.prId]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].confidence).toBe(metrics.confidence);
        expect(rows[0].time_to_first_review_minutes).toBe(metrics.timeToFirstReviewMinutes ?? null);
        expect(rows[0].time_to_merge_minutes).toBe(metrics.timeToMergeMinutes ?? null);
        expect(rows[0].review_comment_count).toBe(metrics.reviewCommentCount);
      }),
      { numRuns: 20 }
    );
  });
});
