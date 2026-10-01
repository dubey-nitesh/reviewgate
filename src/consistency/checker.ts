// Consistency-check orchestrator.
//
// BR-5 (config gating), BR-6 (resource budgets), BR-7 (output placement).
// The only module in the consistency checker that integrates with the
// authorship-detection module's existing code (loadConfig,
// AuthorshipResult, DetectionContext).

import type { DetectionContext } from "../index";
import { DEFAULT_CONSISTENCY_CHECK, loadConfig } from "../detectors/config";
import type { AuthorshipResult } from "../detectors/confidence";
import { extractFileAstSummary } from "./ast";
import { fetchFileContent, MAX_FILE_SIZE_BYTES, resolveSiblingBaseline } from "./baseline";
import { findErrorHandlingDeviations, type ErrorHandlingFinding } from "./errorHandling";
import { isSupportedFile } from "../util/languageExtensions";
import { findNamingDeviations, type NamingFinding } from "./naming";

export interface ConsistencyResult {
  namingFindings: NamingFinding[];
  errorHandlingFindings: ErrorHandlingFinding[];
}

// BR-6: diff-file cap and per-PR wall-clock budget. MAX_FILE_SIZE_BYTES is
// imported from baseline.ts rather than redeclared here — see that
// file's comment. isSupportedFile comes from the shared
// languageExtensions.ts registry, not baseline.ts.
const MAX_DIFF_FILES = 20;
const WALL_CLOCK_BUDGET_MS = 5000;

// BR-5 / stories C1, C4: reads the (extended) .reviewgate.yml config,
// gates on enabled + scope, and — when in scope — runs the naming (BR-3)
// and error-handling (BR-4) comparators against each changed TS/JS file's
// sibling baseline (BR-1). Returns undefined only for the disabled/
// out-of-scope case; an empty-but-defined result (zero findings) is
// distinct — see checkConsistencySummary for how each renders.
export async function checkConsistency(
  context: DetectionContext,
  authorshipResult: AuthorshipResult
): Promise<ConsistencyResult | undefined> {
  const { owner, repo } = context.repo();
  const pr = context.payload.pull_request;

  // Degrades to disabled on any config-load failure, logged (not silently
  // swallowed) so an operational error (rate limit, permissions) reads as
  // "consistencyCheck config load failed" rather than being
  // indistinguishable from "not configured" — found during a code-review
  // pass: this previously matched evaluateAuthorship's degrade-gracefully
  // behavior but not its logging discipline (src/index.ts's
  // evaluateAuthorship warns with the error status on the same kind of
  // failure).
  const config = await loadConfig(context.octokit, owner, repo).catch((err: unknown) => {
    context.log.warn({ err }, "reviewgate: consistencyCheck config load failed, treating as disabled");
    return undefined;
  });
  const consistencyConfig = config?.consistencyCheck ?? DEFAULT_CONSISTENCY_CHECK;
  if (!consistencyConfig.enabled) {
    return undefined;
  }
  if (consistencyConfig.scope === "ai-only" && authorshipResult.confidence === "none") {
    return undefined;
  }

  const changedFiles = await context.octokit.paginate(context.octokit.pulls.listFiles, {
    owner,
    repo,
    pull_number: pr.number,
    per_page: 100,
  });

  const filesToCheck = changedFiles
    // Skips a pure rename (no content change — GitHub reports `changes: 0`
    // for a `status: "renamed"` entry with nothing else edited) — found
    // during a code-review pass: comparing an unmodified file's identifiers
    // against a sibling baseline just because it moved directories produces
    // findings a reviewer would read as "wrong" for a diff that touched no
    // actual code.
    .filter((file) => file.status !== "removed" && file.changes > 0 && isSupportedFile(file.filename))
    .slice(0, MAX_DIFF_FILES);

  // BR-1: full set of paths this PR's diff touches, passed to
  // resolveSiblingBaseline so it excludes not just each file's own path
  // but every other diff-touched file too — drawn from the unfiltered
  // changedFiles list (not filesToCheck), since a file this PR touches but
  // isn't itself checking (e.g. a non-TS/JS file, or a zero-change rename)
  // is still not an independent sample of "the codebase's existing
  // pattern" if it happens to sit in the same directory as a checked file.
  //
  // Includes `previous_filename` for a renamed file, not just its new
  // `filename` — found during a code-review pass: resolveSiblingBaseline
  // lists sibling directories at the PR's base ref (pre-PR content), where
  // a renamed file's OLD path is still present and, without this, would be
  // wrongly counted as a legitimate, independent sibling even though it's
  // a file this same PR touched (moved away from that directory).
  const allTouchedFilePaths = new Set(
    changedFiles.flatMap((file) => (file.previous_filename ? [file.filename, file.previous_filename] : [file.filename]))
  );

  const namingFindings: NamingFinding[] = [];
  const errorHandlingFindings: ErrorHandlingFinding[] = [];
  // Passed into resolveSiblingBaseline so a single file's sibling-fetch
  // loop can also bail out before starting, not just between top-level
  // files here — found during a code-review pass: the per-file check below
  // alone can't interrupt a file whose own sibling fetch is what's running
  // long. Computed once and reused for both checks (previously a second,
  // textually-different `Date.now() - startedAt > WALL_CLOCK_BUDGET_MS`
  // expression had to be kept manually in sync with this one — a
  // code-review-pass simplification).
  const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;

  // BR-6: fail-open — stop processing further files once the budget is
  // spent, keep whatever findings were already collected, never surface
  // this as an error. Extracted to a shared helper (rather than repeating
  // the check+log inline) since it's now called at two points in the loop
  // — found during a code-review pass: the diff file's own content fetch
  // below had no deadline check before it at all, so two individually-fine
  // fetches (sibling batch + diff file) could together silently exceed the
  // documented 5s budget with no warning logged, since the only prior
  // check ran before the sibling-fetch batch, not after it.
  function deadlineExceeded(): boolean {
    if (Date.now() > deadline) {
      context.log.warn(
        { prId: pr.number, repo: `${owner}/${repo}` },
        "reviewgate: consistency check exceeded its per-PR time budget, using partial results"
      );
      return true;
    }
    return false;
  }

  for (const file of filesToCheck) {
    if (deadlineExceeded()) {
      break;
    }

    const baseline = await resolveSiblingBaseline(
      context.octokit,
      owner,
      repo,
      file.filename,
      pr.base.sha,
      deadline,
      allTouchedFilePaths
    );
    if (!baseline.sufficientSample) {
      continue;
    }

    if (deadlineExceeded()) {
      break;
    }

    const content = await fetchFileContent(context.octokit, owner, repo, file.filename, pr.head.sha);
    if (content === undefined || Buffer.byteLength(content, "utf-8") > MAX_FILE_SIZE_BYTES) {
      continue;
    }

    const diffSummary = extractFileAstSummary(file.filename, content);
    if (diffSummary === undefined) {
      continue;
    }
    namingFindings.push(...findNamingDeviations(baseline.files, diffSummary, file.filename));
    errorHandlingFindings.push(...findErrorHandlingDeviations(baseline.files, diffSummary, file.filename));
  }

  return { namingFindings, errorHandlingFindings };
}

// BR-7: renders the "Consistency" section appended to the
// authorship-detection module's existing check-run/comment output. Empty
// string (not a heading with no body) for
// both the disabled/out-of-scope case (undefined) and the zero-findings
// case — callers append this verbatim, so an empty string naturally
// produces no visible section either way.
export function checkConsistencySummary(result: ConsistencyResult | undefined): string {
  if (!result || (result.namingFindings.length === 0 && result.errorHandlingFindings.length === 0)) {
    return "";
  }

  const lines: string[] = ["**Consistency**:"];
  for (const finding of result.namingFindings) {
    lines.push(
      `- \`${finding.file}\`: \`${finding.identifierName}\` doesn't match the codebase's ` +
        `${finding.expectedConvention} convention for ${finding.identifierKind}s`
    );
  }
  for (const finding of result.errorHandlingFindings) {
    lines.push(
      `- \`${finding.file}\` (${finding.location}): catch clause deviates from the codebase's ` +
        `established error-handling pattern`
    );
  }
  return lines.join("\n");
}
