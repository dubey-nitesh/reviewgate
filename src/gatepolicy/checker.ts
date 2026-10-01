// Gate-policy orchestrator.
//
// BR-1 through BR-7. The only module in the gate-policy checker that integrates with
// the authorship-detection module's existing code (loadConfig,
// AuthorshipResult, DetectionContext) — deliberately does NOT import
// from src/consistency/* (no dependency on the consistency checker, by
// design).

import type { DetectionContext } from "../index";
import { DEFAULT_GATE_POLICY, loadConfig } from "../detectors/config";
import type { AuthorshipResult } from "../detectors/confidence";
import { withTimeout, decodeFileContent, type OctokitLike } from "../util/githubContent";
import { isSupportedFile } from "../util/languageExtensions";
import { extractFunctionComplexities } from "./complexity";
import { evaluateSizeRisk, type SizeRiskFinding } from "./sizeRisk";
import { fetchCoverageFinding, type CoverageFinding } from "./coverage";

export interface ComplexityFinding {
  file: string;
  functionName: string;
  complexity: number;
  threshold: number;
}

export interface GatePolicyResult {
  complexityFindings: ComplexityFinding[];
  sizeRiskFinding?: SizeRiskFinding;
  coverageFinding?: CoverageFinding;
  shouldBlock: boolean;
}

// Found by a sixteenth /code-review pass: "does this result have any
// finding at all" was computed twice, independently — once for
// `shouldBlock`, once as `gatePolicySummary`'s `hasFindings` — the same
// drift risk this file already consolidated elsewhere (`unwrapOrLog` in
// index.ts, `isPlainObject` in config.ts). A future fourth gate rule
// added to only one of the two call sites would silently desync
// blocking from what the summary reports. Single source of truth now.
function hasAnyFinding(result: Pick<GatePolicyResult, "complexityFindings" | "sizeRiskFinding" | "coverageFinding">): boolean {
  return result.complexityFindings.length > 0 || result.sizeRiskFinding !== undefined || result.coverageFinding !== undefined;
}

// A minimal shape of the PR-files-list entries this module needs — the
// same fields src/consistency/checker.ts already reads off the real
// Octokit response, restated here (not imported from there) — this
// module has no dependency on the consistency checker, by design.
export interface ChangedFile {
  filename: string;
  status: string;
  changes: number;
  additions: number;
  deletions: number;
}

// BR-7: own constants, not imported from src/consistency/baseline.ts —
// same figures as the consistency checker's for a reason judged
// reasonable there, not because the two modules share a dependency.
//
// The extension filter this comment used to describe locally
// (TS_JS_EXTENSIONS/isTsJsFile) is now isSupportedFile from
// src/util/languageExtensions.ts — a neutral shared module, not
// src/consistency/*, so this file's own "no dependency on the
// consistency checker" boundary (this header's own comment) stays
// intact even though the extension registry is now unified rather than
// duplicated a third time.
const MAX_DIFF_FILES = 20;
const MAX_FILE_SIZE_BYTES = 200 * 1024;
const WALL_CLOCK_BUDGET_MS = 5000;
const EXTERNAL_CALL_TIMEOUT_MS = 3000;

// Own timeout-bounded content fetch, built on the shared
// src/util/githubContent.ts primitives — not src/consistency/baseline.ts's
// fetchFileContent (no dependency on the consistency checker, by design).
//
// `timeoutMs` is a parameter, not always EXTERNAL_CALL_TIMEOUT_MS — found
// by an eighth /code-review pass, verified directly with fake timers: a
// fixed per-call budget here meant that even after the seventh pass's
// shared `passDeadline` fix, a changedFiles fetch that consumed most of
// the pass's budget (e.g. ~4900ms of 5000ms, legitimately, not a hang)
// still let each per-file content fetch claim a brand-new full
// EXTERNAL_CALL_TIMEOUT_MS (3s) window of its own — reproducing
// essentially the same "residual budget not actually enforced" class of
// bug the shared-deadline fix addressed one level up, just one call
// deeper. Callers now pass whichever is smaller: the standard per-call
// budget, or the time actually remaining until the shared pass deadline.
// Found by a ninth /code-review pass: this catch was silent, unlike
// every other failure path in this file (loadConfig's and
// pulls.listFiles's catches both log a warning) — the exact same
// operational blind spot a sixth /code-review pass already fixed for
// pulls.listFiles ("a persistent permission/5xx/rate-limit failure would
// silently and permanently zero out complexity/sizeRisk findings ...
// with nothing in the logs"), just never applied to this equally
// error-prone (called up to MAX_DIFF_FILES times per PR) per-file fetch.
// Unlike baseline.ts's sibling-file fetch (a different module with its
// own accepted silent-catch precedent, where a 404 is routine —
// a listed directory sibling can legitimately not exist by fetch time),
// a 404/permission/rate-limit failure fetching a file this PR's own diff
// already lists as changed, at its own head SHA, is not a routine miss.
function logFetchFailure(context: DetectionContext, path: string, err: unknown): void {
  context.log.warn({ err, file: path }, "reviewgate: gate-policy per-file content fetch failed or timed out, skipping this file");
}

async function fetchFileContent(
  context: DetectionContext,
  octokit: OctokitLike,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  timeoutMs: number
): Promise<string | undefined> {
  try {
    const response = await withTimeout(octokit.repos.getContent({ owner, repo, path, ref }), timeoutMs);
    return decodeFileContent(response.data);
  } catch (err) {
    logFetchFailure(context, path, err);
    return undefined;
  }
}

// BR-1/BR-7: fetches each in-scope changed TS/JS file's content
// concurrently, then parses each for cyclomatic-complexity findings.
// Extracted out of checkGatePolicy so the complexity work and the
// coverage rule's own external call (BR-3) can run concurrently via
// Promise.all — found by /code-review: the two rules are fully
// independent, so awaiting them one after the other stacked their two
// separate multi-second budgets in series for no reason.
// `deadline` defaults to a fresh WALL_CLOCK_BUDGET_MS window when omitted
// (real usage from checkGatePolicy below) but is directly injectable —
// same testability pattern as src/consistency/baseline.ts's
// resolveSiblingBaseline — so the "stop processing once the budget is
// exhausted" behavior can be exercised directly with an already-past
// deadline, rather than only indirectly via real elapsed wall-clock time.
export async function computeComplexityFindings(
  context: DetectionContext,
  owner: string,
  repo: string,
  pr: { number: number; head: { sha: string } },
  changedFiles: ChangedFile[],
  complexityConfig: { enabled: boolean; threshold: number },
  deadline: number = Date.now() + WALL_CLOCK_BUDGET_MS
): Promise<ComplexityFinding[]> {
  const complexityFindings: ComplexityFinding[] = [];
  if (!complexityConfig.enabled) {
    return complexityFindings;
  }

  const filesToCheck = changedFiles
    .filter((file) => file.status !== "removed" && file.changes > 0 && isSupportedFile(file.filename))
    .slice(0, MAX_DIFF_FILES);

  // Fetched concurrently, not sequentially — found by /code-review:
  // up to MAX_DIFF_FILES (20) independent fetches, each with its own
  // EXTERNAL_CALL_TIMEOUT_MS (3s) bound, were previously awaited one
  // at a time, burning through WALL_CLOCK_BUDGET_MS (5s) faster than
  // necessary and causing avoidable partial results. Mirrors the
  // consistency checker's baseline.ts fix for the identical class of issue.
  //
  // The deadline check below happens inside the parse loop, after the
  // fetch's real elapsed time (and any prior iterations' parse time) has
  // actually accrued against `deadline` — not immediately after computing
  // a fresh deadline, which an earlier draft of this fix did and a
  // further /code-review pass caught: checking `Date.now() > deadline` on
  // the very next line after `deadline = Date.now() + WALL_CLOCK_BUDGET_MS`
  // can, for all practical purposes, never be true, silently making the
  // whole budget check dead code. Same point-in-the-loop as where
  // consistency/checker.ts checks its own equivalent deadline.
  const perFileTimeoutMs = Math.min(EXTERNAL_CALL_TIMEOUT_MS, Math.max(0, deadline - Date.now()));
  const contents = await Promise.all(
    filesToCheck.map((file) =>
      fetchFileContent(context, context.octokit, owner, repo, file.filename, pr.head.sha, perFileTimeoutMs)
    )
  );

  for (const [index, content] of contents.entries()) {
    if (Date.now() > deadline) {
      // BR-7: fail-open — stop processing further files, keep whatever
      // findings were already collected, never surface this as an error.
      context.log.warn(
        { prId: pr.number, repo: `${owner}/${repo}` },
        "reviewgate: gate-policy complexity check exceeded its per-PR time budget, using partial results"
      );
      break;
    }

    if (content === undefined || Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
      continue;
    }

    // extractFunctionComplexities (BR-1) guarantees it never throws —
    // including on the pathological deeply-nested-source cases found by
    // /code-review, where tree-sitter's own parser.parse() throws, or
    // the plain recursive walk overflows the JS call stack — so no
    // try/catch is needed at this call site; see that function's own
    // header comment for the fix and why it lives there rather than
    // here.
    const functions = extractFunctionComplexities(filesToCheck[index].filename, content);
    for (const fn of functions) {
      if (fn.complexity > complexityConfig.threshold) {
        complexityFindings.push({
          file: filesToCheck[index].filename,
          functionName: fn.name,
          complexity: fn.complexity,
          threshold: complexityConfig.threshold,
        });
      }
    }
  }

  return complexityFindings;
}

// BR-1/BR-2/BR-3/BR-4/BR-6: reads the (extended) .reviewgate.yml config,
// gates on enabled + scope, and — when in scope — runs the three gate
// rules, each independently gated by its own per-rule enabled flag.
//
// Correction made during implementation: the original design specified
// changedFiles as a parameter, hoisted once by the webhook handler and
// shared with checkConsistency, to avoid a redundant
// pulls.listFiles call when both features are enabled. That would have
// broken an existing, tested consistency-checker contract instead — index.test.ts
// asserts pulls.listFiles is never called when consistencyCheck is
// disabled (no extra API calls for a disabled feature), and hoisting the
// call in the handler unconditionally would call it even when both
// gatePolicy and consistencyCheck are disabled, since whether gatePolicy
// is enabled isn't known until config is loaded — which is exactly what
// this function does internally. Reverted to fetching its own list here,
// gated after the enabled/scope check, mirroring checkConsistency's
// exact pattern — a second listFiles call only when both features are
// actually enabled on the same repo (an accepted, documented tradeoff,
// same class as the already-accepted duplicate-AST-parse and
// duplicate-.reviewgate.yml-fetch gaps elsewhere in this project).
// Returns undefined only for the disabled/out-of-scope case; an
// empty-but-defined result (zero findings, shouldBlock: false) is
// distinct — see gatePolicySummary.
export async function checkGatePolicy(
  context: DetectionContext,
  authorshipResult: AuthorshipResult
): Promise<GatePolicyResult | undefined> {
  const { owner, repo } = context.repo();
  const pr = context.payload.pull_request;

  // BR-7: a single deadline for the whole gate-policy pass — the config
  // load itself, the changedFiles fetch, AND the complexity rule's own
  // subsequent per-file fetch-and-parse work — established once here, at
  // the true start of the function, rather than each stage computing its
  // own fresh WALL_CLOCK_BUDGET_MS window. Found by a seventh /code-review
  // pass (changedFiles vs. computeComplexityFindings) and again by a
  // later pass (this deadline was itself being computed AFTER loadConfig
  // resolved, so its own up-to-~3000ms latency was silently excluded from
  // the budget it's supposed to cover): verified directly with fake
  // timers both times — without covering every stage, individually-fine
  // latencies at each stage (e.g. ~2900ms config load, ~4900ms changedFiles
  // fetch) stack into a measured 7000-8000ms+ total elapsed time for one
  // gate-policy pass, well over the documented "5000ms for the whole
  // gate-policy pass," with the fail-open partial-results path never
  // engaging since each stage's own deadline check only ever saw its own
  // freshly-started clock. Every downstream consumer (changedFilesPromise's
  // withTimeout, computeComplexityFindings' deadline) already derives its
  // own budget as "time remaining until passDeadline," so establishing it
  // this early is sufficient on its own — no other call site needs to
  // change for the whole pass to now self-bound at WALL_CLOCK_BUDGET_MS.
  const passDeadline = Date.now() + WALL_CLOCK_BUDGET_MS;

  const config = await loadConfig(context.octokit, owner, repo).catch((err: unknown) => {
    context.log.warn({ err }, "reviewgate: gatePolicy config load failed, treating as disabled");
    return undefined;
  });
  const gatePolicyConfig = config?.gatePolicy ?? DEFAULT_GATE_POLICY;
  if (!gatePolicyConfig.enabled) {
    return undefined;
  }
  if (gatePolicyConfig.scope === "ai-only" && authorshipResult.confidence === "none") {
    return undefined;
  }

  // Found during a /code-review pass: only the complexity and sizeRisk
  // rules consume changedFiles (coverage only calls checks.listForRef) —
  // fetching it unconditionally paid a full paginated pulls.listFiles
  // round-trip on every event even for a repo using gatePolicy solely for
  // its coverage rule, whose result would then go entirely unused. Gated
  // the fetch behind whether either actual consumer is enabled, matching
  // this file's own "no extra API calls for a disabled feature" standard
  // (already applied at the whole-gatePolicy level above) one level
  // deeper, at the per-sub-rule level.
  //
  // RESILIENCY-10 / found by a fifth /code-review pass: this paginated
  // call had no timeout at all, unlike every other external call in this
  // file (repos.getContent, checks.listForRef are both withTimeout-
  // wrapped) — an unresponsive GitHub API here would hang checkGatePolicy
  // (and, since index.ts awaits it, the whole webhook handler)
  // indefinitely, silently defeating BR-7's 5000ms per-PR budget.
  // Wrapped in withTimeout and, per this file's own fail-open posture,
  // caught so a timeout/failure yields no changed-files data (complexity
  // and sizeRisk then simply produce no findings for this PR) rather than
  // propagating out and wiping the whole GatePolicyResult.
  //
  // A sixth /code-review pass found two more issues with that fix: (a)
  // bounding this specific call by EXTERNAL_CALL_TIMEOUT_MS
  // (single-external-call budget, 3s) was too tight — unlike every other
  // call in this file, octokit.paginate issues one HTTP round trip per
  // 100-file page with no cap of its own, so a legitimately large PR
  // (100+ changed files) can need multiple round trips and exceed 3s
  // under completely normal (non-degraded) latency, not just during a
  // real hang — silently losing complexity/sizeRisk coverage for exactly
  // the large PRs most likely to need it. Rebound to WALL_CLOCK_BUDGET_MS
  // (5s), the per-PR-level budget this multi-round-trip operation more
  // naturally belongs to. (b) the failure catch was silent, unlike every
  // other error path in this file (loadConfig's catch above logs a warn)
  // — a persistent permission/5xx/rate-limit failure would silently and
  // permanently zero out complexity/sizeRisk findings for a repo with
  // nothing in the logs to reveal it looks identical to "no risk
  // findings" rather than "this feature is broken." Now logs a warning
  // matching this file's own established pattern.
  //
  // Also started concurrently with the coverage rule's own independent
  // checks.listForRef call, not awaited before it — found by a fifth
  // pass: coverage doesn't consume changedFiles at all, so awaiting this
  // fetch first before starting coverage's fetch reintroduced the exact
  // "independent external calls stacking in series" issue this file was
  // already restructured to eliminate for complexity-vs-coverage
  // specifically, just one call earlier in the function.
  const changedFilesPromise: Promise<ChangedFile[]> =
    gatePolicyConfig.complexity.enabled || gatePolicyConfig.sizeRisk.enabled
      ? withTimeout(
          context.octokit.paginate(context.octokit.pulls.listFiles, {
            owner,
            repo,
            pull_number: pr.number,
            per_page: 100,
          }),
          Math.max(0, passDeadline - Date.now())
        ).catch((err: unknown) => {
          context.log.warn(
            { err, prId: pr.number, repo: `${owner}/${repo}` },
            "reviewgate: gate-policy pulls.listFiles failed or timed out, using no changed-files data"
          );
          return [];
        })
      : Promise.resolve([]);

  // Complexity (file fetches + tree-sitter parsing) and coverage (a
  // single checks.listForRef call) are fully independent rules — found by
  // /code-review: awaiting them one after the other simply stacks their
  // two separate multi-second budgets in series for no reason, when
  // running them concurrently costs only the slower of the two. sizeRisk
  // has no I/O of its own (pure computation over the already-fetched
  // changedFiles), so it's computed inline, not part of this Promise.all.
  const [changedFiles, complexityFindings, coverageFinding] = await Promise.all([
    changedFilesPromise,
    changedFilesPromise.then((changedFiles) =>
      computeComplexityFindings(context, owner, repo, pr, changedFiles, gatePolicyConfig.complexity, passDeadline)
    ),
    gatePolicyConfig.coverage.enabled && gatePolicyConfig.coverage.checkRunName
      ? fetchCoverageFinding(
          context.octokit,
          owner,
          repo,
          pr.head.sha,
          gatePolicyConfig.coverage.checkRunName,
          gatePolicyConfig.coverage.minimumPercent,
          context.log,
          Math.min(EXTERNAL_CALL_TIMEOUT_MS, Math.max(0, passDeadline - Date.now()))
        )
      : Promise.resolve(undefined),
  ]);

  let sizeRiskFinding: SizeRiskFinding | undefined;
  if (gatePolicyConfig.sizeRisk.enabled) {
    const linesChanged = changedFiles.reduce((sum, file) => sum + file.additions + file.deletions, 0);
    const filesChanged = changedFiles.length;
    sizeRiskFinding = evaluateSizeRisk(
      { linesChanged, filesChanged },
      gatePolicyConfig.sizeRisk.linesThreshold,
      gatePolicyConfig.sizeRisk.filesThreshold
    );
  }

  // BR-6: the one and only place shouldBlock is computed. Size/risk
  // findings contribute exactly like the other two — see BR-2's note on
  // why "informational" (about GitHub's reviewer-requirement mechanism)
  // doesn't mean "exempt from blocking."
  const shouldBlock = gatePolicyConfig.blocking && hasAnyFinding({ complexityFindings, sizeRiskFinding, coverageFinding });

  return { complexityFindings, sizeRiskFinding, coverageFinding, shouldBlock };
}

// Found by an eighth /code-review pass, verified directly: a complexity
// finding's `functionName` can come from a computed object-literal
// property key (`{ [expr]: function() {} }`, complexity.ts's `pair`
// handling) or a string-literal key containing a literal backtick
// (`{ "a\`b": function() {} }`) — either way, tree-sitter's `.text` for
// that node is raw, attacker-influenced source text with no character
// restrictions, unlike a real identifier. Embedded verbatim inside this
// function's backtick code spans below, a `` ` `` in that text closes the
// code span early, letting arbitrary markdown from the PR's own diff
// render live inside reviewgate's own trusted check-run/comment output —
// e.g. injecting bold "looks safe" text next to a blocking finding.
// Sanitized at this one rendering boundary (not by trying to enumerate
// every tree-sitter node shape that could yield an unsafe character,
// which found two distinct sources already) rather than only restricting
// which key types complexity.ts treats as named — the more root-cause fix
// per this project's own precedent (compare the coverage regex DoS fix:
// bounded at the actual scan, not by trying to reject every adversarial
// input shape upstream). Also strips newlines, since a JS string literal
// can contain one via a line-continuation backslash, which would
// otherwise inject extra lines into this markdown list.
function sanitizeForCodeSpan(value: string): string {
  return value.replace(/[`\r\n]/g, "'");
}

// BR-5: renders the "Gate Policy" block, self-labeled (matching the
// consistency checker's checkConsistencySummary convention) since the generic Output Composer
// has no knowledge of titles (see src/output/render.ts). "" for both the
// disabled/out-of-scope case (undefined) and the zero-findings case.
export function gatePolicySummary(result: GatePolicyResult | undefined): string {
  if (!result) {
    return "";
  }
  if (!hasAnyFinding(result)) {
    return "";
  }

  const lines: string[] = ["**Gate Policy**:"];
  for (const finding of result.complexityFindings) {
    lines.push(
      `- \`${sanitizeForCodeSpan(finding.file)}\`: \`${sanitizeForCodeSpan(finding.functionName)}\` has complexity ${finding.complexity} ` +
        `(threshold: ${finding.threshold})`
    );
  }
  if (result.sizeRiskFinding) {
    lines.push(
      `- This PR changes ${result.sizeRiskFinding.linesChanged} lines across ` +
        `${result.sizeRiskFinding.filesChanged} files — consider extra review attention ` +
        `(thresholds: ${result.sizeRiskFinding.linesThreshold} lines / ${result.sizeRiskFinding.filesThreshold} files)`
    );
  }
  if (result.coverageFinding) {
    lines.push(
      `- Coverage (\`${result.coverageFinding.checkRunName}\`) is ${result.coverageFinding.actualPercent}%, ` +
        `below the minimum of ${result.coverageFinding.minimumPercent}%`
    );
  }
  if (result.shouldBlock) {
    lines.push("- This PR is blocked from merging until the above gate rule(s) pass (`gatePolicy.blocking: true`).");
  }
  return lines.join("\n");
}
