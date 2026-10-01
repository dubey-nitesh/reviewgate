// Error-handling-idiom deviation detection.
//
// BR-4.

import type { FileAstSummary } from "./ast";
import { resolveDominant } from "./dominance";

export interface ErrorHandlingFinding {
  file: string;
  location: string;
}

// BR-4: same two-gate shape as naming (naming.ts), applied to a boolean
// (narrowed vs. unnarrowed) rather than a multi-value classification —
// shares resolveDominant's gate logic (extracted during a code-review
// pass; this file previously hand-unrolled the same "min sample + 80%
// dominance" math over the two boolean buckets instead of calling it).
const MIN_SAMPLE_SIZE = 3;
const DOMINANCE_THRESHOLD = 0.8;

function dominantPattern(narrowedCount: number, total: number): boolean | undefined {
  const counts = new Map<boolean, number>([
    [true, narrowedCount],
    [false, total - narrowedCount],
  ]);
  return resolveDominant(counts, total, MIN_SAMPLE_SIZE, DOMINANCE_THRESHOLD);
}

// BR-4: applies symmetrically — a dominantly-narrowed baseline flags new
// unnarrowed catches (the failure mode this is meant to catch); a
// dominantly-unnarrowed baseline flags new narrowed catches. The point is
// deviation from the established local pattern, not a hardcoded
// preference for narrow catches.
export function findErrorHandlingDeviations(
  baseline: FileAstSummary[],
  diffFile: FileAstSummary,
  diffFilePath: string
): ErrorHandlingFinding[] {
  let narrowedCount = 0;
  let total = 0;
  for (const file of baseline) {
    for (const clause of file.catchClauses) {
      total += 1;
      if (clause.narrowed) {
        narrowedCount += 1;
      }
    }
  }

  const dominant = dominantPattern(narrowedCount, total);
  if (dominant === undefined) {
    return [];
  }

  const findings: ErrorHandlingFinding[] = [];
  for (const clause of diffFile.catchClauses) {
    if (clause.narrowed !== dominant) {
      findings.push({ file: diffFilePath, location: clause.location });
    }
  }
  return findings;
}
