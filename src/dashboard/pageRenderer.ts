// Renders the lightweight custom dashboard page (FR-5.7).
//
// BR-12 (render-boundary sanitization).

import type { DashboardMetrics } from "./dataProvider";

// NFR-5-2 / BR-12: every interpolated value goes through this escape,
// even the currently-all-numeric DashboardMetrics fields — the current
// aggregate-only scope (no per-repo breakdown, no issue titles/PR bodies
// rendered) means there is no live attacker-controlled string reaching
// this renderer today, but the escaping is applied uniformly rather than
// selectively so a future addition of repo names or issue references
// (both anticipated as future enhancements) inherits a safe-by-default
// render boundary instead of needing every future field to remember to
// opt in — same "sanitize at the actual render point, not by trying to
// track every upstream source" principle as gatepolicy/checker.ts's
// sanitizeForCodeSpan.
// Exported for direct unit testing — DashboardMetrics has no
// attacker-controlled string field today (see the comment above), so
// there's no live call path to exercise this through renderDashboardPage
// itself; exporting it lets the escaping behavior be verified directly
// rather than only indirectly (and untestably) asserted.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value: number | undefined, options?: { percent?: boolean; decimals?: number }): string {
  if (value === undefined) {
    return "—";
  }
  const decimals = options?.decimals ?? 0;
  if (options?.percent) {
    return escapeHtml(`${(value * 100).toFixed(decimals)}%`);
  }
  return escapeHtml(value.toFixed(decimals));
}

function statRow(label: string, ai: string, human: string): string {
  return `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td>${ai}</td>
      <td>${human}</td>
    </tr>`;
}

// FR-5.7: aggregate AI-vs-human trend view. No per-repo/per-team
// breakdown currently. Server-rendered HTML, no client-side framework —
// matches this project's minimal-infra posture.
export function renderDashboardPage(metrics: DashboardMetrics): string {
  const { escapeRate } = metrics;
  const totalPrs = metrics.aiPrCount + metrics.humanPrCount;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>reviewgate — Metrics Dashboard</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { padding: 0.5rem 1rem; border: 1px solid #ddd; text-align: left; }
    th { background: #f5f5f5; }
    .escape-rate { margin-top: 2rem; }
    .caveat { color: #666; font-size: 0.9rem; }
  </style>
</head>
<body>
  <h1>reviewgate Metrics Dashboard</h1>
  <p>${escapeHtml(String(totalPrs))} PRs tracked (${formatNumber(metrics.aiPrCount)} AI-authored, ${formatNumber(metrics.humanPrCount)} human-authored).</p>

  <table>
    <thead>
      <tr><th>Metric</th><th>AI-authored</th><th>Human-authored</th></tr>
    </thead>
    <tbody>
      ${statRow(
        "Avg. time to merge (minutes)",
        formatNumber(metrics.avgCycleTimeMinutesByConfidence.ai),
        formatNumber(metrics.avgCycleTimeMinutesByConfidence.human)
      )}
      ${statRow(
        "Avg. review comment count",
        formatNumber(metrics.avgReviewCommentCountByConfidence.ai, { decimals: 1 }),
        formatNumber(metrics.avgReviewCommentCountByConfidence.human, { decimals: 1 })
      )}
    </tbody>
  </table>

  <h2>Gate Policy &amp; Consistency</h2>
  <table>
    <tbody>
      <tr><td>Gate-policy block rate</td><td>${formatNumber(metrics.gatePolicyBlockRate, { percent: true, decimals: 1 })}</td></tr>
      <tr><td>Consistency finding rate</td><td>${formatNumber(metrics.consistencyFindingRate, { percent: true, decimals: 1 })}</td></tr>
    </tbody>
  </table>

  <div class="escape-rate">
    <h2>Defect Escape Rate</h2>
    <table>
      <tbody>
        <tr><td>Confirmed (commit-linked / manual)</td><td>${escapeHtml(String(escapeRate.confirmedCount))}</td></tr>
        <tr><td>Heuristic (time-window, best-effort)</td><td>${escapeHtml(String(escapeRate.heuristicCount))}</td></tr>
      </tbody>
    </table>
    <p class="caveat">Heuristic counts are best-effort correlation, not a confirmed causal link — see FR-5.6.</p>
  </div>
</body>
</html>`;
}
