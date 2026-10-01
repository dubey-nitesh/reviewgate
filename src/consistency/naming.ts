// Naming-convention deviation detection.
//
// BR-3, and the classification rule it depends on.

import type { ExtractedIdentifier, FileAstSummary, NamingCase } from "./ast";
import { resolveDominant } from "./dominance";

export interface NamingFinding {
  file: string;
  identifierName: string;
  identifierKind: ExtractedIdentifier["kind"];
  expectedConvention: NamingCase;
}

// BR-3: minimum classifiable-identifier count per kind before a dominant
// convention can be established, and the agreement fraction required to
// call one dominant. Both gates fail closed to "no finding" — an
// insufficient or unclear baseline never produces a false claim.
//
// MIN_SAMPLE_SIZE is intentionally different from errorHandling.ts's
// equivalent (5 here vs. 3 there) — not an unsynced duplicate. A typical
// file has many more identifiers than catch clauses, so a higher bar is
// still reachable in practice; flagged as worth calling out explicitly
// during a code-review pass, since the two gates otherwise look like the
// same constant copy-pasted with a typo.
const MIN_SAMPLE_SIZE = 5;
const DOMINANCE_THRESHOLD = 0.8;

function dominantConvention(counts: Map<NamingCase, number>, total: number): NamingCase | undefined {
  return resolveDominant(counts, total, MIN_SAMPLE_SIZE, DOMINANCE_THRESHOLD);
}

// BR-3: per identifier kind, classify the baseline's identifiers
// (excluding "other" — it carries no signal either way), determine
// whether one convention is dominant, and flag diff identifiers of that
// kind whose classification differs. Diff identifiers classified "other"
// are never flagged (nothing to compare them against).
export function findNamingDeviations(
  baseline: FileAstSummary[],
  diffFile: FileAstSummary,
  diffFilePath: string
): NamingFinding[] {
  const countsByKind = new Map<ExtractedIdentifier["kind"], Map<NamingCase, number>>();
  const totalByKind = new Map<ExtractedIdentifier["kind"], number>();

  for (const file of baseline) {
    for (const identifier of file.identifiers) {
      if (identifier.namingCase === "other") {
        continue;
      }
      const counts = countsByKind.get(identifier.kind) ?? new Map<NamingCase, number>();
      counts.set(identifier.namingCase, (counts.get(identifier.namingCase) ?? 0) + 1);
      countsByKind.set(identifier.kind, counts);
      totalByKind.set(identifier.kind, (totalByKind.get(identifier.kind) ?? 0) + 1);
    }
  }

  const findings: NamingFinding[] = [];
  for (const identifier of diffFile.identifiers) {
    if (identifier.namingCase === "other") {
      continue;
    }
    const counts = countsByKind.get(identifier.kind);
    const total = totalByKind.get(identifier.kind) ?? 0;
    if (!counts) {
      continue;
    }
    const dominant = dominantConvention(counts, total);
    if (dominant !== undefined && identifier.namingCase !== dominant) {
      findings.push({
        file: diffFilePath,
        identifierName: identifier.name,
        identifierKind: identifier.kind,
        expectedConvention: dominant,
      });
    }
  }
  return findings;
}
