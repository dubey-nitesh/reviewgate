// Defect-escape-linkage orchestrator (stories E1-E4).
//
// BR-8 (config gating) and BR-9 (event-to-detector routing).

import { DEFAULT_ESCAPE_LINKAGE, loadConfig } from "../detectors/config";
import { detectCommitLinkedEscapes, type OctokitLike as CommitLinkOctokit } from "./commitLinkDetector";
import { detectHeuristicEscape, type OctokitLike as HeuristicOctokit } from "./heuristicDetector";
import { parseManualOverride } from "./manualOverrideResolver";
import { upsertEscapeRecord } from "./store";
import type { OctokitLike as ConfigOctokit } from "../detectors/config";

// Deliberately NOT src/index.ts's DetectionContext — that type requires
// `payload.pull_request`, which the `issues.opened` webhook context this
// module also needs to accept (for checkEscapeLinkageOnNewIssue) doesn't
// have. Neither function here reads `context.payload` at all (the
// triggering event's relevant fields are passed as explicit parameters
// instead), so this narrower structural type is both sufficient and
// correctly accepts both `Context<"pull_request">` and `Context<"issues">`
// call sites in index.ts without a payload-shape mismatch.
export interface EscapeLinkageContext {
  repo(): { owner: string; repo: string };
  octokit: CommitLinkOctokit & HeuristicOctokit & ConfigOctokit;
  log: { warn(obj: unknown, message: string): void };
}

// BR-8: same fail-closed posture as every prior wave's config gate — a
// config-load failure or explicit `enabled: false` (the default) means
// no detection runs, logged so an operational failure is distinguishable
// from "not configured," matching evaluateAuthorship/checkConsistency/
// checkGatePolicy's established logging discipline.
async function loadEscapeLinkageConfigOrDisabled(
  context: EscapeLinkageContext,
  owner: string,
  repo: string
): Promise<{ enabled: boolean; timeWindowDays: number }> {
  const config = await loadConfig(context.octokit, owner, repo).catch((err: unknown) => {
    context.log.warn({ err }, "reviewgate: escapeLinkage config load failed, treating as disabled");
    return undefined;
  });
  return config?.escapeLinkage ?? DEFAULT_ESCAPE_LINKAGE;
}

// FR-5.1/FR-5.2/BR-9 (merge path): on a merged PR, run commit-linked
// detection and persist any resulting escape records. A detection or
// storage failure is logged and does not throw — this runs alongside
// (not gating) the existing metrics-capture flow for the same event.
export async function checkEscapeLinkageOnMerge(
  context: EscapeLinkageContext,
  mergedPr: { number: number; body: string | null; base: { sha: string } }
): Promise<void> {
  const { owner, repo } = context.repo();
  const escapeLinkageConfig = await loadEscapeLinkageConfigOrDisabled(context, owner, repo);
  if (!escapeLinkageConfig.enabled) {
    return;
  }

  try {
    const escapes = await detectCommitLinkedEscapes(context.octokit, owner, repo, mergedPr);
    for (const escape of escapes) {
      await upsertEscapeRecord({
        repo: `${owner}/${repo}`,
        issueNumber: escape.issueNumber,
        sourcePrId: escape.sourcePrId,
        detectionMethod: "commit-linked",
      });
    }
  } catch (err) {
    context.log.warn({ err, prId: mergedPr.number }, "reviewgate: commit-linked escape detection failed");
  }
}

// FR-5.3/FR-5.4/BR-9 (new-issue path): manual override (E3) takes
// precedence over the heuristic fallback (E2) at the call-order level
// too — not just at the storage layer (store.ts's precedence-aware
// upsert is the actual correctness guarantee; skipping the heuristic
// call entirely when a manual link is already present is purely an
// optimization, avoiding wasted API calls for a result that would be
// discarded by the store anyway).
export async function checkEscapeLinkageOnNewIssue(
  context: EscapeLinkageContext,
  issue: { number: number; body: string | null; createdAt: string }
): Promise<void> {
  const { owner, repo } = context.repo();
  const escapeLinkageConfig = await loadEscapeLinkageConfigOrDisabled(context, owner, repo);
  if (!escapeLinkageConfig.enabled) {
    return;
  }

  try {
    const manual = parseManualOverride(issue.body);
    if (manual) {
      await upsertEscapeRecord({
        repo: `${owner}/${repo}`,
        issueNumber: issue.number,
        sourcePrId: manual.sourcePrId,
        detectionMethod: "manual",
      });
      return;
    }

    const heuristic = await detectHeuristicEscape(
      context.octokit,
      owner,
      repo,
      issue,
      escapeLinkageConfig.timeWindowDays
    );
    if (heuristic) {
      await upsertEscapeRecord({
        repo: `${owner}/${repo}`,
        issueNumber: issue.number,
        sourcePrId: heuristic.sourcePrId,
        detectionMethod: "time-window-heuristic",
      });
    }
  } catch (err) {
    context.log.warn({ err, issueNumber: issue.number }, "reviewgate: new-issue escape detection failed");
  }
}
