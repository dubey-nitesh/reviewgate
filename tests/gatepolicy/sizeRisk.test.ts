import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluateSizeRisk } from "../../src/gatepolicy/sizeRisk";

describe("evaluateSizeRisk", () => {
  it("returns undefined when both metrics are at or below their thresholds", () => {
    expect(evaluateSizeRisk({ linesChanged: 500, filesChanged: 20 }, 500, 20)).toBeUndefined();
    expect(evaluateSizeRisk({ linesChanged: 10, filesChanged: 1 }, 500, 20)).toBeUndefined();
  });

  it("flags when only lines-changed exceeds its threshold (OR logic)", () => {
    const finding = evaluateSizeRisk({ linesChanged: 501, filesChanged: 1 }, 500, 20);
    expect(finding).toEqual({ linesChanged: 501, filesChanged: 1, linesThreshold: 500, filesThreshold: 20 });
  });

  it("flags when only files-changed exceeds its threshold (OR logic)", () => {
    const finding = evaluateSizeRisk({ linesChanged: 10, filesChanged: 21 }, 500, 20);
    expect(finding).toEqual({ linesChanged: 10, filesChanged: 21, linesThreshold: 500, filesThreshold: 20 });
  });

  it("flags when both metrics exceed their thresholds", () => {
    const finding = evaluateSizeRisk({ linesChanged: 501, filesChanged: 21 }, 500, 20);
    expect(finding).toEqual({ linesChanged: 501, filesChanged: 21, linesThreshold: 500, filesThreshold: 20 });
  });

  // Exhaustive truth table over the 4 threshold-pass/fail combinations
  // (business-rules.md's Testable Properties table).
  it("produces a finding if and only if lines-changed OR files-changed exceeds its threshold", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 50 }),
        (linesChanged, filesChanged, linesThreshold, filesThreshold) => {
          const finding = evaluateSizeRisk({ linesChanged, filesChanged }, linesThreshold, filesThreshold);
          const expectFinding = linesChanged > linesThreshold || filesChanged > filesThreshold;
          expect(finding !== undefined).toBe(expectFinding);
        }
      )
    );
  });
});
