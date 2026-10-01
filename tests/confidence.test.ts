import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkRunConclusion, checkRunSummary, combineSignals, shouldPostComment } from "../src/detectors/confidence";
import type { AuthorshipSignal } from "../src/detectors/coAuthor";

const noTrailer: AuthorshipSignal = { isAiAuthored: false };
const trailerMatched: AuthorshipSignal = { isAiAuthored: true, matchedTrailer: "Claude Code" };

describe("combineSignals", () => {
  it("returns definite when the commit trailer matches", () => {
    const result = combineSignals(trailerMatched, undefined, undefined);
    expect(result.confidence).toBe("definite");
    expect(result.reasons).toContain("Commit trailer matched: Claude Code");
  });

  it("returns likely when only the branch pattern matches", () => {
    const result = combineSignals(noTrailer, "ai/*", undefined);
    expect(result.confidence).toBe("likely");
    expect(result.reasons).toContain("Branch name matches pattern: ai/*");
  });

  it("returns likely when only the PR template marker matches", () => {
    const result = combineSignals(noTrailer, undefined, "ai-assisted");
    expect(result.confidence).toBe("likely");
    expect(result.reasons).toContain("PR description matches configured marker: ai-assisted");
  });

  it("returns none when no signal matches", () => {
    const result = combineSignals(noTrailer, undefined, undefined);
    expect(result.confidence).toBe("none");
    expect(result.reasons).toEqual([]);
  });

  // PBT: exhaustive oracle test — the signal-presence input space is small
  // enough to fully enumerate (business-rules.md Testable Properties). Every
  // combination must resolve per the BR-5 truth table, no exceptions.
  it("matches the BR-5 truth table for every signal-presence combination", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (trailer, branch, template) => {
        const signal: AuthorshipSignal = trailer
          ? { isAiAuthored: true, matchedTrailer: "some-tool" }
          : { isAiAuthored: false };
        const result = combineSignals(signal, branch ? "ai/*" : undefined, template ? "ai-assisted" : undefined);
        const expected = trailer ? "definite" : branch || template ? "likely" : "none";
        expect(result.confidence).toBe(expected);
      }),
      { numRuns: 8 } // full 2^3 enumeration, not random sampling needed
    );
  });
});

describe("shouldPostComment", () => {
  it("is false only for none", () => {
    expect(shouldPostComment("none")).toBe(false);
    expect(shouldPostComment("likely")).toBe(true);
    expect(shouldPostComment("definite")).toBe(true);
  });
});

describe("checkRunConclusion", () => {
  it("never returns failure", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("definite", "likely", "none") as fc.Arbitrary<"definite" | "likely" | "none">,
        (confidence) => {
          expect(checkRunConclusion(confidence)).not.toBe("failure");
        }
      )
    );
  });

  it("maps none to success and everything else to neutral", () => {
    expect(checkRunConclusion("none")).toBe("success");
    expect(checkRunConclusion("likely")).toBe("neutral");
    expect(checkRunConclusion("definite")).toBe("neutral");
  });
});

// BR-7: check-run/comment summary text per confidence level. Previously
// exported with zero direct test coverage (found in the sixth code-review
// pass's test-coverage audit) — only checkRunConclusion's enum mapping was
// tested, not the actual message text upsertCheckRun/upsertComment post.
describe("checkRunSummary", () => {
  it("formats the definite case with joined reasons", () => {
    const result = combineSignals(trailerMatched, undefined, undefined);
    expect(checkRunSummary(result)).toBe("AI-authored (definite): Commit trailer matched: Claude Code");
  });

  it("formats the likely case with joined reasons", () => {
    const result = combineSignals(noTrailer, "ai/*", "ai-assisted");
    expect(checkRunSummary(result)).toBe(
      "Possibly AI-authored (likely): Branch name matches pattern: ai/*; PR description matches configured marker: ai-assisted"
    );
  });

  it("formats the none case with a fixed message, ignoring the empty reasons array", () => {
    const result = combineSignals(noTrailer, undefined, undefined);
    expect(checkRunSummary(result)).toBe("No AI-authorship signals detected");
  });
});
