import { describe, expect, it } from "vitest";
import { escapeHtml, renderDashboardPage } from "../../src/dashboard/pageRenderer";
import type { DashboardMetrics } from "../../src/dashboard/dataProvider";

describe("escapeHtml", () => {
  it("escapes all five HTML-significant characters", () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;"
    );
  });

  it("leaves an already-safe string unchanged", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
});

const BASE_METRICS: DashboardMetrics = {
  aiPrCount: 10,
  humanPrCount: 5,
  avgCycleTimeMinutesByConfidence: { ai: 120, human: 90 },
  avgReviewCommentCountByConfidence: { ai: 3.2, human: 1.5 },
  escapeRate: { confirmedCount: 2, heuristicCount: 1 },
  gatePolicyBlockRate: 0.25,
  consistencyFindingRate: 0.5,
};

describe("renderDashboardPage", () => {
  it("renders a well-formed HTML document", () => {
    const html = renderDashboardPage(BASE_METRICS);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("</html>");
    expect(html).toContain("<title>");
  });

  it("renders AI and human PR counts", () => {
    const html = renderDashboardPage(BASE_METRICS);
    expect(html).toContain("10");
    expect(html).toContain("5");
    expect(html).toContain("15"); // total
  });

  it("renders percentages for gate-policy block rate and consistency finding rate", () => {
    const html = renderDashboardPage(BASE_METRICS);
    expect(html).toContain("25.0%");
    expect(html).toContain("50.0%");
  });

  // BR-11: undefined rates render as a placeholder, never "0%" or "NaN%".
  it("renders a placeholder (not 0% or NaN%) when a rate is undefined", () => {
    const html = renderDashboardPage({ ...BASE_METRICS, gatePolicyBlockRate: undefined, consistencyFindingRate: undefined });
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("0.0%");
    expect(html).toContain("—");
  });

  it("renders a placeholder when avg cycle time/comment count is undefined", () => {
    const html = renderDashboardPage({
      ...BASE_METRICS,
      avgCycleTimeMinutesByConfidence: { ai: undefined, human: undefined },
    });
    expect(html).not.toContain("NaN");
  });

  // FR-5.6/E4: confirmed and heuristic escape counts must render as
  // separate figures, never combined into one number.
  it("renders confirmed and heuristic escape counts separately, with a caveat for heuristic data", () => {
    const html = renderDashboardPage(BASE_METRICS);
    expect(html).toContain("Confirmed");
    expect(html).toContain("Heuristic");
    expect(html).toContain("best-effort");
    expect(html).not.toContain(">3<"); // 2+1 must never appear pre-summed as a single cell
  });

});
