import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn(async () => ({ rows: [] }));

vi.mock("../src/metrics/db", () => ({
  getPool: () => ({ query: queryMock }),
}));

// Dynamic import after the mock is registered, per vitest's hoisting model.
const { saveMetrics } = await import("../src/metrics/store");

describe("saveMetrics", () => {
  it("issues an upsert with the correct parameters, in field order", async () => {
    queryMock.mockClear();
    await saveMetrics({
      repo: "acme/widgets",
      prId: 42,
      confidence: "definite",
      timeToFirstReviewMinutes: 180,
      timeToMergeMinutes: 240,
      reviewCommentCount: 3,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (repo, pr_id) DO UPDATE");
    expect(params).toEqual(["acme/widgets", 42, "definite", 180, 240, 3, null, null]);
  });

  // BR-1: unset fields must be persisted as NULL, not undefined/0 — pg's
  // driver would otherwise reject `undefined` parameters outright.
  it("passes null (not undefined) for unset time-delta fields", async () => {
    queryMock.mockClear();
    await saveMetrics({
      repo: "acme/widgets",
      prId: 42,
      confidence: "none",
      reviewCommentCount: 0,
    });

    const [, params] = queryMock.mock.calls[0];
    expect(params[3]).toBeNull();
    expect(params[4]).toBeNull();
  });

  // gate_policy_blocked/consistency_finding_count also pass null
  // (not undefined) when unset, same BR-1 rationale as the time-delta
  // fields above.
  it("passes null for unset gate_policy_blocked/consistency_finding_count", async () => {
    queryMock.mockClear();
    await saveMetrics({
      repo: "acme/widgets",
      prId: 42,
      confidence: "none",
      reviewCommentCount: 0,
    });

    const [, params] = queryMock.mock.calls[0];
    expect(params[6]).toBeNull();
    expect(params[7]).toBeNull();
  });

  it("passes gate_policy_blocked/consistency_finding_count through when set", async () => {
    queryMock.mockClear();
    await saveMetrics({
      repo: "acme/widgets",
      prId: 42,
      confidence: "none",
      reviewCommentCount: 0,
      gatePolicyBlocked: true,
      consistencyFindingCount: 5,
    });

    const [, params] = queryMock.mock.calls[0];
    expect(params[6]).toBe(true);
    expect(params[7]).toBe(5);
  });

  // Regression test (code-review pass): the metrics-only path
  // (closed/review_submitted) never computes gate-policy/consistency
  // results, so an unconditional overwrite of these two columns would
  // silently clobber a real result an earlier opened/synchronize event
  // already wrote for the same PR — the same class of data-loss bug
  // computeMetrics' own post-merge-review filtering (BR-2) exists to prevent, one
  // level deeper. Asserted here at the SQL-text level (not a mock that
  // can't execute real SQL) — confirms the upsert uses COALESCE, not an
  // unconditional SET, for both new columns.
  it("uses COALESCE (not an unconditional overwrite) for gate_policy_blocked/consistency_finding_count", async () => {
    queryMock.mockClear();
    await saveMetrics({
      repo: "acme/widgets",
      prId: 42,
      confidence: "none",
      reviewCommentCount: 0,
    });

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toMatch(/gate_policy_blocked\s*=\s*COALESCE\(EXCLUDED\.gate_policy_blocked/);
    expect(sql).toMatch(/consistency_finding_count\s*=\s*COALESCE\(EXCLUDED\.consistency_finding_count/);
  });
});
