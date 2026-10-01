import { describe, expect, it } from "vitest";
import type { FileAstSummary } from "../../src/consistency/ast";
import { findErrorHandlingDeviations } from "../../src/consistency/errorHandling";

function fileWith(catchClauses: FileAstSummary["catchClauses"]): FileAstSummary {
  return { identifiers: [], catchClauses };
}

function clause(narrowed: boolean, location = "line 1") {
  return { narrowed, location };
}

describe("findErrorHandlingDeviations", () => {
  it("flags a new unnarrowed catch when the baseline is dominantly narrowed", () => {
    const baseline = [fileWith([clause(true), clause(true), clause(true)])];
    const diffFile = fileWith([clause(false, "line 42")]);

    const findings = findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts");

    expect(findings).toEqual([{ file: "src/foo.ts", location: "line 42" }]);
  });

  // BR-4: symmetric — not hardcoded toward preferring narrow catches.
  it("flags a new narrowed catch when the baseline is dominantly unnarrowed", () => {
    const baseline = [fileWith([clause(false), clause(false), clause(false)])];
    const diffFile = fileWith([clause(true, "line 7")]);

    const findings = findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts");

    expect(findings).toEqual([{ file: "src/foo.ts", location: "line 7" }]);
  });

  it("does not flag a diff catch matching the dominant pattern", () => {
    const baseline = [fileWith([clause(true), clause(true), clause(true)])];
    const diffFile = fileWith([clause(true)]);

    expect(findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("does not flag anything below the minimum-sample-size gate (fewer than 3)", () => {
    const baseline = [fileWith([clause(true), clause(true)])];
    const diffFile = fileWith([clause(false, "line 5")]);

    expect(findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("does not flag anything below the 80% agreement gate (a near-even split)", () => {
    // 3 narrowed, 2 unnarrowed out of 5 = 60% — below the 80% threshold.
    const baseline = [fileWith([clause(true), clause(true), clause(true), clause(false), clause(false)])];
    const diffFile = fileWith([clause(false, "line 5")]);

    expect(findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([]);
  });

  it("flags multiple deviating diff catches independently", () => {
    const baseline = [fileWith([clause(true), clause(true), clause(true)])];
    const diffFile = fileWith([clause(false, "line 1"), clause(true, "line 2"), clause(false, "line 3")]);

    const findings = findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts");

    expect(findings).toEqual([
      { file: "src/foo.ts", location: "line 1" },
      { file: "src/foo.ts", location: "line 3" },
    ]);
  });

  it("aggregates the baseline across multiple sibling files", () => {
    const baseline = [fileWith([clause(true), clause(true)]), fileWith([clause(true)])];
    const diffFile = fileWith([clause(false, "line 9")]);

    expect(findErrorHandlingDeviations(baseline, diffFile, "src/foo.ts")).toEqual([
      { file: "src/foo.ts", location: "line 9" },
    ]);
  });
});
