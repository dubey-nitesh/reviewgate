import { describe, expect, it, vi } from "vitest";

const readEscapeRateSummaryMock = vi.fn(async () => ({ confirmedCount: 0, heuristicCount: 0 }));
vi.mock("../../src/escapeLinkage/store", () => ({
  readEscapeRateSummary: readEscapeRateSummaryMock,
}));

const { fetchDashboardMetrics } = await import("../../src/dashboard/dataProvider");

function makePool(row: Record<string, string | null>) {
  return { query: vi.fn(async () => ({ rows: [row] })) } as unknown as import("pg").Pool;
}

const FULL_ROW = {
  ai_pr_count: "10",
  human_pr_count: "5",
  ai_avg_cycle_time: "120.5",
  human_avg_cycle_time: "90",
  ai_avg_comment_count: "3.2",
  human_avg_comment_count: "1.5",
  gate_policy_evaluated_count: "8",
  gate_policy_blocked_count: "2",
  consistency_evaluated_count: "6",
  consistency_with_findings_count: "3",
};

describe("fetchDashboardMetrics", () => {
  it("returns AI vs human PR counts", async () => {
    const pool = makePool(FULL_ROW);
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.aiPrCount).toBe(10);
    expect(metrics.humanPrCount).toBe(5);
  });

  it("returns avg cycle time and comment count split by AI vs human", async () => {
    const pool = makePool(FULL_ROW);
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.avgCycleTimeMinutesByConfidence).toEqual({ ai: 120.5, human: 90 });
    expect(metrics.avgReviewCommentCountByConfidence).toEqual({ ai: 3.2, human: 1.5 });
  });

  it("computes gatePolicyBlockRate and consistencyFindingRate as fractions", async () => {
    const pool = makePool(FULL_ROW);
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.gatePolicyBlockRate).toBe(2 / 8);
    expect(metrics.consistencyFindingRate).toBe(3 / 6);
  });

  // BR-11: a zero-denominator rate is undefined, not 0 — "not evaluated
  // yet" must be distinguishable from "evaluated, 0%".
  it("returns undefined rates (not 0) when the evaluated count is zero", async () => {
    const pool = makePool({
      ...FULL_ROW,
      gate_policy_evaluated_count: "0",
      gate_policy_blocked_count: "0",
      consistency_evaluated_count: "0",
      consistency_with_findings_count: "0",
    });
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.gatePolicyBlockRate).toBeUndefined();
    expect(metrics.consistencyFindingRate).toBeUndefined();
  });

  it("returns undefined avg cycle time/comment count when the SQL avg() is NULL (no rows in that group)", async () => {
    const pool = makePool({
      ...FULL_ROW,
      ai_avg_cycle_time: null,
      human_avg_cycle_time: null,
    });
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.avgCycleTimeMinutesByConfidence).toEqual({ ai: undefined, human: undefined });
  });

  // FR-5.6/E4: escapeRate must come from EscapeLinkageStore's own
  // confirmed/heuristic split, never re-derived or merged here.
  it("passes escapeRate through from EscapeLinkageStore unmerged", async () => {
    readEscapeRateSummaryMock.mockResolvedValueOnce({ confirmedCount: 7, heuristicCount: 2 });
    const pool = makePool(FULL_ROW);
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.escapeRate).toEqual({ confirmedCount: 7, heuristicCount: 2 });
  });

  it("calls readEscapeRateSummary with no repo argument (aggregate across all repos)", async () => {
    readEscapeRateSummaryMock.mockClear();
    const pool = makePool(FULL_ROW);
    await fetchDashboardMetrics(pool);
    expect(readEscapeRateSummaryMock).toHaveBeenCalledWith();
  });

  it("returns zero counts when the pr_metrics table is empty (no rows returned)", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as import("pg").Pool;
    const metrics = await fetchDashboardMetrics(pool);
    expect(metrics.aiPrCount).toBe(0);
    expect(metrics.humanPrCount).toBe(0);
    expect(metrics.gatePolicyBlockRate).toBeUndefined();
  });
});
