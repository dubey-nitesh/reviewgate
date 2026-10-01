import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCoverageFinding, type OctokitLike } from "../../src/gatepolicy/coverage";

function makeOctokit(options: {
  checkRuns?: Array<{ name: string; output?: { summary?: string | null; text?: string | null } }>;
  hang?: boolean;
  throws?: unknown;
}): OctokitLike {
  return {
    checks: {
      listForRef: async () => {
        if (options.hang) {
          return new Promise(() => {});
        }
        if (options.throws !== undefined) {
          throw options.throws;
        }
        return { data: { check_runs: options.checkRuns ?? [] } };
      },
    },
  };
}

describe("fetchCoverageFinding", () => {
  it("returns undefined when no check-run matches the configured name", async () => {
    const octokit = makeOctokit({ checkRuns: [{ name: "other-check", output: { summary: "coverage: 50%" } }] });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  // Regression tests (found by a sixteenth /code-review pass, verified
  // directly): GitHub can return more than one check-run sharing the
  // same name on one head SHA (multiple check suites for the same ref).
  // This used to silently pick whichever entry `.find()` saw first,
  // regardless of array order — a lower-privileged actor able to post a
  // same-named check-run could spoof a passing percentage over a real
  // regression. Fixed the same way the in-text "multiple percentages in
  // one run" ambiguity is already handled: only produce a percentage
  // when every matching run that parsed agrees.
  it("fails open when multiple check-runs sharing the configured name report different percentages", async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { name: "coverage-report", output: { summary: "coverage: 50%" } },
        { name: "coverage-report", output: { summary: "coverage: 95%" } },
      ],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  it("fails open regardless of which order the differing check-runs appear in", async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { name: "coverage-report", output: { summary: "coverage: 95%" } },
        { name: "coverage-report", output: { summary: "coverage: 50%" } },
      ],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  it("still finds the percentage when multiple check-runs sharing the configured name agree", async () => {
    const octokit = makeOctokit({
      checkRuns: [
        { name: "coverage-report", output: { summary: "coverage: 50%" } },
        { name: "coverage-report", output: { summary: "coverage: 50%" } },
      ],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 50, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  it("returns a finding when coverage is below the minimum", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "Total coverage: 65%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 65, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  it("returns undefined when coverage is at or above the minimum", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "Total coverage: 85%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  it("parses a decimal percentage", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "coverage 72.5%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 72.5, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  it("requires the word 'coverage' near the matched percentage, ignoring unrelated percentages", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "98% of tests passed. Line coverage: 65%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 65, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  // Regression test (found by an eleventh /code-review pass, verified
  // directly): parseCoveragePercent used to return the FIRST
  // coverage-adjacent match, not treating multiple matches as ambiguous
  // despite its own header comment already documenting "multiple
  // ambiguous matches -> no finding (fail open)" as the intended
  // contract. A summary reporting both a diff/patch percentage and a
  // total percentage (a common real-world CI convention) previously let
  // the earlier, unrelated figure silently mask a genuine total-coverage
  // regression. Fixed to fail open (no finding) once genuinely ambiguous
  // — not to guess which match is "the real" total (a separate, later
  // design decision, deliberately not made here).
  it("produces no finding (fails open) when multiple ambiguous coverage-labeled percentages are present", async () => {
    // minimumPercent (96) is chosen so the old, unfixed behavior (silently
    // picking the first coverage-adjacent match, 95%) would be
    // DISTINGUISHABLE from the fixed fail-open behavior: 95 < 96 would
    // have produced a (wrong) finding under the old code, whereas the fix
    // produces no finding at all regardless of threshold, since ambiguity
    // itself — not which figure happens to clear the bar — is what
    // triggers the fail-open path.
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "Diff Coverage: 95%\nTotal Coverage: 40%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 96);
    expect(result).toBeUndefined();
  });

  // Regression test (found by a twelfth /code-review pass, verified
  // directly): fetchCoverageFinding always concatenates output.summary
  // and output.text, and a common CI-tool pattern states the same
  // aggregate percentage in both (a short summary plus a detailed text
  // body) — the eleventh round's ambiguity fix treated this as 2+
  // distinct matches and failed open, even though there's no real
  // ambiguity when every coverage-adjacent match agrees on the same
  // value. Only genuinely different values (the prior test's 95%/40%
  // case) should be treated as ambiguous.
  it("finds the coverage percentage when it appears identically in both output.summary and output.text", async () => {
    const octokit = makeOctokit({
      checkRuns: [
        {
          name: "coverage-report",
          output: { summary: "Coverage: 45%", text: "## Coverage Report\nTotal Coverage: 45%\n" },
        },
      ],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 45, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  // Regression test (found by a tenth /code-review pass, verified
  // directly): lowercasing the whole text upfront and then slicing it
  // using indices computed from the original, un-lowercased text broke
  // for input where .toLowerCase() changes string length — U+0130 ("İ")
  // lowercases to a 2-code-unit sequence, so 25 of them shift every
  // downstream index by 25, misaligning the keyword-window slice enough
  // to miss "Coverage" even though it sits right next to the real match.
  it("finds the coverage percentage even when preceded by characters whose lowercase form has a different length", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "İ".repeat(25) + "Coverage: 45%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 45, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  it("returns undefined when no percentage is within the keyword window of 'coverage'", async () => {
    // Verified the distance (104 chars) genuinely exceeds the keyword
    // window before writing this test, and chose minimumPercent (80) such
    // that IF the implementation incorrectly matched the far-away 45%
    // anyway, it WOULD produce a finding (45 < 80) — so this test fails
    // loudly if the keyword-window filtering regresses, rather than
    // passing accidentally the way an earlier draft of this test did
    // (its percentage happened to be above the threshold either way,
    // so it couldn't actually distinguish correct filtering from none).
    const octokit = makeOctokit({
      checkRuns: [
        {
          name: "coverage-report",
          output: {
            summary:
              "45% of unrelated build steps succeeded across all configured platforms and environments today. Separately, coverage information was not included in this particular report at all.",
          },
        },
      ],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  // Regression test (found during testing, root-cause fix applied
  // on review): the original `(\d+(?:\.\d+)?)\s*%` backtracks
  // quadratically on a long digit run with no "%" — measured ~6.7s for a
  // 131070-char all-digit string (GitHub's own combined summary+text
  // cap). A first fix capped the scanned length, but that silently
  // truncated legitimate large reports instead — see the next test.
  // Fixed at the root by bounding both digit groups
  // (`\d{1,3}(?:\.\d{1,2})?`), so no truncation is needed: the full
  // 131070-char string is scanned here, not a capped prefix. The 2s
  // bound is generous (~2ms measured) specifically to avoid flaking on a
  // loaded/slow CI runner while still catching a real quadratic
  // regression, which would blow well past it (~6.7s).
  it("stays fast on an adversarial all-digit check-run output (quadratic-regex DoS)", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "9".repeat(65535), text: "9".repeat(65535) } }],
    });
    const start = Date.now();
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result).toBeUndefined();
  });

  // Regression test (found by /code-review on the first DoS fix draft,
  // which capped scanned length to 5000 chars): a legitimate large
  // report — e.g. a per-file coverage listing before the aggregate line,
  // easily exceeding 5000 characters for a repo with many files — must
  // still be parsed correctly now that the fix is root-cause (bounded
  // quantifier) rather than truncation-based.
  it("finds the coverage percentage even when it appears after 5000 characters of legitimate report content", async () => {
    const perFileRows = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts     92.1%     10/11`).join("\n");
    // A separator keeps the last per-file row's own "92.1%" match outside
    // the TOTAL line's keyword window — otherwise it would match first
    // (appearing earlier in the text) and, being >= minimumPercent, mask
    // the real 65% regression this test means to exercise. Verified this
    // separation is sufficient directly before trusting it.
    const separator = "=".repeat(50) + "\n";
    const summary = `${perFileRows}\n${separator}TOTAL coverage: 65%\n`;
    expect(summary.length).toBeGreaterThan(5000);

    const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary } }] });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 65, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  // Regression test (found by a further /code-review pass on the DoS fix
  // above): the DoS fix's decimal bound was originally `\d{1,2}`, which
  // doesn't just lose precision on 3+ decimal digits — it fails to match
  // at that position at all (`\d{1,2}` can't consume ".478" and still be
  // followed by "%"), so the regex instead matches "478%" as a bare 478,
  // always >= any real minimumPercent, silently defeating the gate.
  // Verified directly before fixing, and again here: with the widened
  // `\d{1,6}` bound, the actual percentage is parsed correctly.
  it("parses a percentage with more than two decimal digits correctly, not as a truncated bare number", async () => {
    const octokit = makeOctokit({
      checkRuns: [{ name: "coverage-report", output: { summary: "coverage: 63.478%" } }],
    });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toEqual({ actualPercent: 63.478, minimumPercent: 80, checkRunName: "coverage-report" });
  });

  it("returns undefined when the check-run has no output text", async () => {
    const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report" }] });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  it("fails open (returns undefined) when the listForRef call throws", async () => {
    const octokit = makeOctokit({ throws: new Error("network error") });
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
    expect(result).toBeUndefined();
  });

  // Regression test (found by a fifteenth /code-review pass): this catch
  // was silent, and the function didn't even receive a logger to fix it
  // with — unlike every other external call in the gate-policy checker
  // (pulls.listFiles, repos.getContent in checker.ts), which received
  // explicit warn-logging fixes in the sixth and ninth rounds for this
  // exact failure mode. A persistent permission/5xx/rate-limit failure
  // silently and permanently disabled the coverage gate with nothing in
  // the logs to reveal it.
  it("logs a warning (not silently) when the listForRef call rejects", async () => {
    const octokit = makeOctokit({ throws: { status: 403, message: "forbidden" } });
    const log = { warn: vi.fn() };
    const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80, log);
    expect(result).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }), checkRunName: "coverage-report" }),
      expect.stringContaining("checks.listForRef failed or timed out")
    );
  });

  describe("timeout (RESILIENCY-10)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails open instead of hanging forever when listForRef never resolves", async () => {
      vi.useFakeTimers();
      const octokit = makeOctokit({ hang: true });

      const resultPromise = fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      await vi.advanceTimersByTimeAsync(3001);

      await expect(resultPromise).resolves.toBeUndefined();
    });
  });

  // G5: pytest-cov/coverage.py's default terminal report is a
  // fixed-width ASCII table whose TOTAL-row percentage sits well outside
  // the existing keyword-window check's reach (verified directly with a
  // scratch script before implementing — column padding alone routinely
  // exceeds COVERAGE_KEYWORD_WINDOW). These tests exercise the dedicated
  // TOTAL-line pattern added for it, through the same public
  // fetchCoverageFinding boundary every other test in this file uses.
  describe("Python coverage-tool report parsing (BR-6)", () => {
    const pytestCovReport =
      "---------- coverage: platform linux, python 3.11.4-final-0 -----------\n" +
      "Name                      Stmts   Miss  Cover\n" +
      "---------------------------------------------\n" +
      "src/app.py                   45      3    93%\n" +
      "src/utils.py                 20      0   100%\n" +
      "---------------------------------------------\n" +
      "TOTAL                        65      3    70%\n";

    const bareCoveragePyReport =
      "Name                      Stmts   Miss  Cover\n" +
      "---------------------------------------------\n" +
      "src/app.py                   45      3    93%\n" +
      "---------------------------------------------\n" +
      "TOTAL                        45      3    70%\n";

    it("finds the TOTAL row's percentage in a pytest-cov terminal report", async () => {
      const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary: pytestCovReport } }] });
      const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      expect(result).toEqual({ actualPercent: 70, minimumPercent: 80, checkRunName: "coverage-report" });
    });

    it("finds the TOTAL row's percentage in a bare coverage.py report (no pytest wrapper)", async () => {
      const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary: bareCoveragePyReport } }] });
      const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      expect(result).toEqual({ actualPercent: 70, minimumPercent: 80, checkRunName: "coverage-report" });
    });

    it("does not flag when the TOTAL row's coverage meets the minimum", async () => {
      const report = pytestCovReport.replace("70%\n", "95%\n");
      const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary: report } }] });
      const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      expect(result).toBeUndefined();
    });

    it("still fails open on genuinely ambiguous input (a TOTAL line disagreeing with a keyword-window match)", async () => {
      const conflicting = "Diff Coverage: 95%\n" + pytestCovReport; // 95% (keyword-window) vs 70% (TOTAL line)
      const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary: conflicting } }] });
      const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      expect(result).toBeUndefined();
    });

    it("stays fast (no catastrophic/quadratic backtracking) on an adversarial TOTAL-prefixed report at GitHub's output-size cap", async () => {
      const line = "TOTAL " + "x".repeat(500) + " nostophere ";
      const adversarial = (line + "\n").repeat(Math.ceil(131070 / (line.length + 1)));
      const octokit = makeOctokit({ checkRuns: [{ name: "coverage-report", output: { summary: adversarial } }] });
      const start = Date.now();
      const result = await fetchCoverageFinding(octokit, "acme", "widgets", "sha", "coverage-report", 80);
      expect(Date.now() - start).toBeLessThan(500);
      expect(result).toBeUndefined();
    });
  });
});
