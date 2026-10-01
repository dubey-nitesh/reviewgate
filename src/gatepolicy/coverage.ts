// Test-coverage-delta gate rule.
//
// BR-3. reviewgate never runs the target repo's own
// tests to compute coverage — this only reads an existing CI check-run
// the repo's own tooling already produced.

import { withTimeout } from "../util/githubContent";

export interface CoverageFinding {
  actualPercent: number;
  minimumPercent: number;
  checkRunName: string;
}

interface CheckRunOutput {
  summary?: string | null;
  text?: string | null;
}

interface CheckRun {
  name: string;
  output?: CheckRunOutput | null;
}

export interface OctokitLike {
  checks: {
    listForRef(params: {
      owner: string;
      repo: string;
      ref: string;
      check_name: string;
    }): Promise<{ data: { check_runs: CheckRun[] } }>;
  };
}

// Minimal structural type, not imported from ../index (this module has
// no other dependency on DetectionContext, and stays a standalone unit
// like complexity.ts/sizeRisk.ts) — just enough to log a warning, added
// by a fifteenth /code-review pass (see fetchCoverageFinding's own
// comment for why).
export interface LoggerLike {
  warn(obj: unknown, message: string): void;
}

// RESILIENCY-10: matches src/consistency/baseline.ts's/src/detectors/
// config.ts's identical requirement — its own constant per BR-7's
// accepted-duplication note (each module owns its own budget
// independently, no shared semantic meaning beyond "3s was judged
// reasonable everywhere").
const EXTERNAL_CALL_TIMEOUT_MS = 3000;

// BR-3: require the word "coverage" within this
// many characters of a matched NN%/NN.N% pattern, to reduce false
// positives from an unrelated percentage appearing in the check-run's
// output (e.g. "80% of tests passed" without this guard would otherwise
// be mistaken for a coverage figure).
const COVERAGE_KEYWORD_WINDOW = 30;
//
// RESILIENCY-10-adjacent, found during testing then corrected on
// review: the original `(\d+(?:\.\d+)?)\s*%` backtracks quadratically on
// a long digit run with no following "%" — measured ~6.7s for a
// 131070-character all-digit string (GitHub's own cap on a check-run's
// output.summary + output.text combined). A first fix capped the text
// scanned to 5000 characters, but two independent `/code-review` passes
// correctly flagged that as patching the symptom: it would silently
// truncate legitimate large reports (e.g. a per-file coverage listing
// with the aggregate "TOTAL: NN%" line past character 5000), making the
// gate fail open on a real coverage regression with no signal that
// truncation — not "coverage passed" — was the actual reason.
//
// Root-cause fix instead: bound both digit groups. A bounded quantifier
// can only ever attempt a constant number of match lengths at each
// starting position, making the whole scan linear regardless of input
// length, regardless of how large that bound is — verified directly: the
// same 131070-character adversarial string (and two other adversarial
// patterns targeting the decimal-digit run specifically) scan in ~1-2ms
// even with the wider \d{1,6} bound below. No truncation needed —
// fetchCoverageFinding scans the full combined output text again.
//
// The decimal bound was originally \d{1,2} ("coverage percentages are
// 0-100 with realistically at most 1-2 decimal places") — a /code-review
// pass found and verified this was a real correctness bug, not a
// harmless approximation: a 3+-decimal-digit percentage like "63.478%"
// doesn't just lose precision, it *fails to match at that position
// entirely* (\d{1,2} can't consume ".478" and still be followed by "%"),
// so the regex backtracks to the next starting position and matches
// "478%" as a bare 478 instead — always >= any real minimumPercent, so a
// genuine coverage regression from a tool that emits unrounded
// percentages silently never triggers the gate, even with
// gatePolicy.blocking: true. Widened to \d{1,6} (six decimal digits is
// generous well past any realistic coverage-tool precision) — verified
// directly against the exact failing cases ("63.478%", "5.999%",
// "45.6789%") now parsing correctly, while remaining just as DoS-safe as
// the narrower bound.
const PERCENT_PATTERN = /(\d{1,3}(?:\.\d{1,6})?)\s*%/gi;

// G5: `pytest-cov`/`coverage.py`'s default terminal report is a
// fixed-width ASCII table (`Name  Stmts  Miss  Cover` header, one row per
// file, a `TOTAL` row for the aggregate), NOT the short-prose style
// (`Coverage: 85.5%`) the keyword-window check above was tuned against.
// Verified directly (scratch script, not assumed): in a realistic report,
// the TOTAL row's own percentage sits well outside COVERAGE_KEYWORD_WINDOW
// (30 chars) from any occurrence of "coverage" — column padding alone
// routinely exceeds that distance — so the existing keyword-window check
// structurally cannot match this format regardless of which extra keywords
// it's given; a real, structurally different report shape needs a
// dedicated pattern, not a wider keyword list. Anchored to a line that
// starts with "TOTAL" and ends with a percentage — deliberately NOT
// proximity-based, so it doesn't inherit the keyword-window check's own
// false-positive risk (a broader keyword like "cover" would also match
// "recover"/"discovered" near an unrelated percentage in JS-ecosystem
// output; anchoring to the line shape avoids that trade-off entirely).
// Bounded digit groups (matching PERCENT_PATTERN's own DoS-safety
// rationale above) — verified at GitHub's actual 131070-character
// combined summary+text cap, both as many short adversarial lines and one
// single huge non-matching line: sub-millisecond in both cases, no
// backtracking blowup.
const TOTAL_LINE_PATTERN = /^TOTAL\s+.*?(\d{1,3}(?:\.\d{1,6})?)\s*%\s*$/gim;

// Best-effort, not a hard contract with every CI tool's exact output
// format (BR-3) — returns undefined rather than throwing on anything
// unrecognized.
//
// Found by a tenth /code-review pass, verified directly: lowercasing the
// whole text upfront (`text.toLowerCase()`) and then slicing it using
// indices computed from the original, un-lowercased `text` broke for any
// input where `.toLowerCase()` changes the string's length — verified
// with `"İ".repeat(25) + "Coverage: 45%"` (U+0130, whose lowercase form
// `"i̇"` is two UTF-16 code units instead of one): `lowerText` ends up 25
// characters longer than `text`, so slicing it at `text`-relative offsets
// lands on the wrong region entirely, missing "coverage" even though it
// sits right next to the match in the real text — silently producing "no
// coverage data" for a genuine regression. Fixed by slicing the window
// out of the original, always-correctly-indexed `text` first, then
// lowercasing only that already-correctly-positioned slice — a window is
// at most `2 * COVERAGE_KEYWORD_WINDOW` characters, so this adds no
// meaningful cost even called once per candidate match.
// Found by an eleventh /code-review pass, verified directly: this
// function's own module-level BR-3 comment above already documented
// "multiple ambiguous matches ... → no finding (fail open)" as the
// intended contract, but the implementation never actually detected
// ambiguity — it returned the FIRST coverage-adjacent match found, full
// stop. Verified with `"Diff Coverage: 95%\nTotal Coverage: 40%"` and
// `minimumPercent: 80`: the real 40% total coverage regression went
// completely unflagged because the unrelated, earlier "Diff Coverage:
// 95%" figure was picked instead — not a fail-open ("no finding" because
// genuinely undecidable), but a wrong, silently-passing answer, actively
// defeating `gatePolicy.blocking` on a genuine regression. Fixed to
// actually implement the documented contract: collect every
// coverage-adjacent match, and only return a percentage when exactly one
// such match exists — two or more is the ambiguous case BR-3 already
// says should produce no finding, not a guess at which one is "the real"
// total.
//
// Known residual limitation, deliberately not addressed here: a
// realistic CI tool that reports BOTH an aggregate total and a diff/patch
// percentage in the same summary (a common Codecov-style convention) now
// fails open (no finding) rather than picking either — this fix corrects
// the "silently wrong" bug, it doesn't add a "prefer the total-labeled
// figure" heuristic, since which keyword/convention to prefer (e.g.
// "total", "overall") is a new parsing-strategy design decision beyond
// this bug fix's scope (the original distance/regex choices already went
// through an explicit approval round) —
// flagged here for a future design pass rather than invented unilaterally.
function parseCoveragePercent(text: string): number | undefined {
  PERCENT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  const coverageAdjacentPercents: number[] = [];
  while ((match = PERCENT_PATTERN.exec(text)) !== null) {
    const windowStart = Math.max(0, match.index - COVERAGE_KEYWORD_WINDOW);
    const windowEnd = Math.min(text.length, match.index + match[0].length + COVERAGE_KEYWORD_WINDOW);
    if (text.slice(windowStart, windowEnd).toLowerCase().includes("coverage")) {
      coverageAdjacentPercents.push(Number.parseFloat(match[1]));
    }
  }
  // G5: pytest-cov/coverage.py's TOTAL-row percentage, matched
  // independently of the keyword-window scan above (see TOTAL_LINE_PATTERN's
  // own comment for why) and merged into the same candidate list — a value
  // this pattern finds that disagrees with the keyword-window scan's own
  // finding correctly falls into the existing ambiguous-values case below,
  // rather than needing separate handling.
  TOTAL_LINE_PATTERN.lastIndex = 0;
  let totalMatch: RegExpExecArray | null;
  while ((totalMatch = TOTAL_LINE_PATTERN.exec(text)) !== null) {
    coverageAdjacentPercents.push(Number.parseFloat(totalMatch[1]));
  }
  // Found by a twelfth /code-review pass, verified directly: this used
  // to treat any 2+ coverage-adjacent matches as ambiguous, even when
  // they all agree on the same value — `fetchCoverageFinding` always
  // concatenates `output.summary` and `output.text`, and a common CI-tool
  // pattern states the same aggregate figure in both (a short summary
  // plus a detailed text body), which duplicated the exact same
  // percentage and made a genuine, unambiguous regression fail open
  // instead of being caught. There is no real ambiguity when every
  // coverage-adjacent match agrees — only distinct values (the
  // "Diff Coverage: 95% / Total Coverage: 40%" case this function's own
  // eleventh-pass fix already handles) are genuinely ambiguous.
  const distinctPercents = new Set(coverageAdjacentPercents);
  return distinctPercents.size === 1 ? coverageAdjacentPercents[0] : undefined;
}

// BR-3: looks up the check-run by exact name on the PR's head SHA, reads
// its output text, and compares a best-effort-parsed percentage against
// the configured minimum. Fails open (returns undefined, never throws)
// for: a timed-out/failed listForRef call, no matching check-run, or
// unparseable output — none of these are "coverage regressed," they're
// "no coverage data available," which produces no finding.
// Found by a fifteenth /code-review pass: this catch was silent, and the
// function didn't even receive a logger to fix it with — unlike every
// other external call in the gate-policy checker (pulls.listFiles,
// repos.getContent in checker.ts), which received explicit warn-logging fixes across the
// sixth and ninth rounds for this exact failure mode. A persistent
// permission/5xx/rate-limit failure here silently and permanently
// disables the coverage gate for the repo, indistinguishable in the
// check-run output from "coverage passed" or "no coverage tool
// configured," with nothing in the logs to reveal it. `log` is optional
// so existing callers/tests that don't need logging assertions aren't
// forced to pass one.
// `timeoutMs` defaults to EXTERNAL_CALL_TIMEOUT_MS but is directly
// injectable — found during a code-review pass: this was the one BR-7
// external call in checkGatePolicy left on a fixed timeout, unrelated to
// how much of the shared per-PR passDeadline had already been consumed by
// the config load or anything else. The same "second full budget window"
// class the changedFiles-vs-complexity and per-file-fetch fixes already
// closed, just never applied here. Callers now pass whichever is smaller:
// the standard per-call budget, or the time actually remaining until the
// shared pass deadline — same pattern as gatepolicy/checker.ts's
// fetchFileContent.
export async function fetchCoverageFinding(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  headSha: string,
  checkRunName: string,
  minimumPercent: number,
  log?: LoggerLike,
  timeoutMs: number = EXTERNAL_CALL_TIMEOUT_MS
): Promise<CoverageFinding | undefined> {
  let checkRuns: CheckRun[];
  try {
    const response = await withTimeout(
      octokit.checks.listForRef({ owner, repo, ref: headSha, check_name: checkRunName }),
      timeoutMs
    );
    checkRuns = response.data.check_runs;
  } catch (err) {
    log?.warn({ err, checkRunName }, "reviewgate: gate-policy checks.listForRef failed or timed out, no coverage finding");
    return undefined;
  }

  // Found by a sixteenth /code-review pass, verified directly: GitHub can
  // return more than one check-run sharing the same name on one head SHA
  // (multiple check suites for the same ref — e.g. re-triggered runs or
  // more than one integration posting under that name), but this used to
  // pick whichever entry `.find()` happened to see first, silently
  // ignoring the rest. Verified: two "coverage-report" runs reporting 50%
  // and 95% returned 50% regardless of array order — a lower-privileged
  // actor able to post a same-named check-run (this project's own
  // established trust model already treats that as adversarial, same
  // reasoning as the coverage-regex DoS fix above) could spoof a passing
  // percentage over a real regression. Fixed the same way the in-text
  // "multiple percentages in one run" ambiguity is already handled
  // (BR-3, eleventh/twelfth rounds): parse every matching run
  // independently, and only produce a percentage when every run that
  // *did* parse agrees — genuinely differing runs fail open rather than
  // picking one arbitrarily.
  const matches = checkRuns.filter((checkRun) => checkRun.name === checkRunName);
  if (matches.length === 0) {
    return undefined;
  }

  const parsedPercents = matches
    .map((checkRun) => parseCoveragePercent(`${checkRun.output?.summary ?? ""}\n${checkRun.output?.text ?? ""}`))
    .filter((percent): percent is number => percent !== undefined);
  const distinctPercents = new Set(parsedPercents);
  if (distinctPercents.size !== 1) {
    return undefined;
  }

  const actualPercent = parsedPercents[0];
  if (actualPercent >= minimumPercent) {
    return undefined;
  }

  return { actualPercent, minimumPercent, checkRunName };
}
