// Size/risk reviewer-attention flag.
//
// BR-2.

export interface SizeRiskFinding {
  linesChanged: number;
  filesChanged: number;
  linesThreshold: number;
  filesThreshold: number;
}

export interface DiffStats {
  linesChanged: number;
  filesChanged: number;
}

// BR-2: OR logic — either threshold alone is enough to flag, catching
// both "one huge file" and "many small files" as risk patterns. Purely
// informational about reviewgate's inability to force GitHub's
// reviewer-requirement settings — this finding still contributes to
// GatePolicyOrchestrator's blocking determination like the other two
// rules (see business-rules.md BR-2's note on this distinction).
export function evaluateSizeRisk(diffStats: DiffStats, linesThreshold: number, filesThreshold: number): SizeRiskFinding | undefined {
  if (diffStats.linesChanged <= linesThreshold && diffStats.filesChanged <= filesThreshold) {
    return undefined;
  }
  return {
    linesChanged: diffStats.linesChanged,
    filesChanged: diffStats.filesChanged,
    linesThreshold,
    filesThreshold,
  };
}
