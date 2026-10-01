// Combines the independent authorship signals (commit trailer, branch
// pattern, PR template marker) into a single confidence result, per
// FR-1.4 (Q4=C: track signals separately, expose a confidence level, no
// single collapsed boolean).
//
// BR-5 (combination table), BR-6 (comment threshold), BR-7 (check-run mapping).

import type { AuthorshipSignal } from "./coAuthor";

export type Confidence = "definite" | "likely" | "none";

export interface AuthorshipResult {
  confidence: Confidence;
  reasons: string[];
  matchedTrailer?: string;
}

export function combineSignals(
  coAuthorSignal: AuthorshipSignal,
  matchedBranchPattern: string | undefined,
  matchedTemplateMarker: string | undefined
): AuthorshipResult {
  if (coAuthorSignal.isAiAuthored) {
    return {
      confidence: "definite",
      reasons: [`Commit trailer matched: ${coAuthorSignal.matchedTrailer}`],
      matchedTrailer: coAuthorSignal.matchedTrailer,
    };
  }

  const reasons: string[] = [];
  if (matchedBranchPattern !== undefined) {
    reasons.push(`Branch name matches pattern: ${matchedBranchPattern}`);
  }
  if (matchedTemplateMarker !== undefined) {
    reasons.push(`PR description matches configured marker: ${matchedTemplateMarker}`);
  }

  if (reasons.length > 0) {
    return { confidence: "likely", reasons };
  }

  return { confidence: "none", reasons };
}

// BR-6: only post a PR comment when confidence is definite or likely.
export function shouldPostComment(confidence: Confidence): boolean {
  return confidence !== "none";
}

// BR-7: check-run conclusion mapping — never "failure" from authorship
// detection alone (no gate-blocking behavior; stricter gate rules are a
// separate, opt-in feature).
export function checkRunConclusion(confidence: Confidence): "success" | "neutral" {
  return confidence === "none" ? "success" : "neutral";
}

export function checkRunSummary(result: AuthorshipResult): string {
  switch (result.confidence) {
    case "definite":
      return `AI-authored (definite): ${result.reasons.join("; ")}`;
    case "likely":
      return `Possibly AI-authored (likely): ${result.reasons.join("; ")}`;
    case "none":
      return "No AI-authorship signals detected";
  }
}
