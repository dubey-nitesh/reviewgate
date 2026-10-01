import { describe, expect, it, vi } from "vitest";

const queryMock = vi.fn(async () => ({ rows: [] }));

vi.mock("../../src/metrics/db", () => ({
  getPool: () => ({ query: queryMock }),
}));

const { upsertEscapeRecord, readEscapeRateSummary } = await import("../../src/escapeLinkage/store");

describe("upsertEscapeRecord", () => {
  it("issues an upsert with the correct parameters, in field order", async () => {
    queryMock.mockClear();
    await upsertEscapeRecord({
      repo: "acme/widgets",
      issueNumber: 42,
      sourcePrId: 7,
      detectionMethod: "commit-linked",
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (repo, issue_number) DO UPDATE");
    expect(params).toEqual(["acme/widgets", 42, 7, "commit-linked"]);
  });

  // BR-1: the precedence comparison lives in the SQL's WHERE clause, not
  // application code. This asserts the exact operator and side order —
  // EXCLUDED (incoming) >= escape_records (existing) — not just that a
  // WHERE clause exists, so a mutation that flips >= to <=/< or swaps
  // which side is EXCLUDED vs. escape_records (either of which would
  // silently invert precedence, letting lower-tier detections overwrite
  // higher-tier ones) fails this test even though the mock can't execute
  // real SQL against Postgres to catch it at the semantic level.
  it("includes a precedence comparison in the upsert's WHERE clause", async () => {
    queryMock.mockClear();
    await upsertEscapeRecord({
      repo: "acme/widgets",
      issueNumber: 42,
      sourcePrId: 7,
      detectionMethod: "manual",
    });

    const [sql] = queryMock.mock.calls[0];
    expect(sql).toContain("WHERE");
    expect(sql).toMatch(
      /CASE\s+EXCLUDED\.detection_method[\s\S]*?END\s*\)\s*>=\s*\(\s*CASE\s+escape_records\.detection_method[\s\S]*?END\s*\)/
    );
    // Guard against the two CASE expressions ranking methods differently
    // (e.g. one block edited without the other), which would make the
    // >= comparison meaningless even with the right operator/side order.
    const [excludedBlock, existingBlock] = sql.split("escape_records.detection_method");
    for (const method of ["'manual' THEN 3", "'commit-linked' THEN 2", "'time-window-heuristic' THEN 1"]) {
      expect(excludedBlock).toContain(method);
      expect(existingBlock).toContain(method);
    }
  });
});

describe("readEscapeRateSummary", () => {
  it("passes repo through as a query parameter when given", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce({ rows: [{ confirmed_count: "3", heuristic_count: "1" }] });

    const summary = await readEscapeRateSummary("acme/widgets");

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual(["acme/widgets"]);
    expect(summary).toEqual({ confirmedCount: 3, heuristicCount: 1 });
  });

  it("passes null (aggregate across all repos) when repo is omitted", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce({ rows: [{ confirmed_count: "5", heuristic_count: "2" }] });

    await readEscapeRateSummary();

    const [, params] = queryMock.mock.calls[0];
    expect(params).toEqual([null]);
  });

  // BR-2: confirmed and heuristic must never be summed into one figure by
  // this function itself.
  it("keeps confirmedCount and heuristicCount as separate fields, never summed", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce({ rows: [{ confirmed_count: "10", heuristic_count: "20" }] });

    const summary = await readEscapeRateSummary();

    expect(summary.confirmedCount).toBe(10);
    expect(summary.heuristicCount).toBe(20);
    expect(Object.keys(summary).sort()).toEqual(["confirmedCount", "heuristicCount"]);
  });

  it("returns zero counts when no rows match", async () => {
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce({ rows: [] });

    const summary = await readEscapeRateSummary("acme/empty-repo");

    expect(summary).toEqual({ confirmedCount: 0, heuristicCount: 0 });
  });
});
