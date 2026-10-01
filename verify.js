// reviewgate verification script — runs checker functions directly against a
// real PR using a personal access token. No GitHub App needed, nothing is
// posted back to GitHub. Results are printed to stdout.
//
// Usage:
//   set GITHUB_PAT=ghp_xxxx
//   set DATABASE_URL=postgresql://reviewgate:reviewgate-localdev@localhost:5432/reviewgate
//   set DATABASE_SSL=false
//   node verify.js <owner> <repo> <pr-number>
//
// Example:
//   node verify.js <owner> <repo> 42

"use strict";

const { Octokit: Core } = require("@octokit/core");
const { restEndpointMethods } = require("@octokit/plugin-rest-endpoint-methods");
const { paginateRest } = require("@octokit/plugin-paginate-rest");

const { checkConsistency } = require("./dist/consistency/checker");
const { checkGatePolicy } = require("./dist/gatepolicy/checker");
const { checkEscapeLinkageOnMerge } = require("./dist/escapeLinkage/checker");
const { evaluateAuthorship } = require("./dist/index");
const { computeMetrics } = require("./dist/metrics/capture");
const { saveMetrics } = require("./dist/metrics/store");
const { closePool } = require("./dist/metrics/db");

// ─── config ──────────────────────────────────────────────────────────────────
const pat = process.env.GITHUB_PAT;
const [, , owner, repo, prStr] = process.argv;
const pull_number = parseInt(prStr, 10);

if (!pat)  { console.error("ERROR: set GITHUB_PAT env var first"); process.exit(1); }
if (!owner || !repo || !pull_number) {
  console.error("Usage: node verify.js <owner> <repo> <pr-number>");
  process.exit(1);
}

// ─── octokit setup ───────────────────────────────────────────────────────────
const OctokitWithPlugins = Core.plugin(restEndpointMethods, paginateRest);
const _octokit = new OctokitWithPlugins({ auth: pat });
// The restEndpointMethods plugin adds endpoints under octokit.rest.*
// but the checker code (src/detectors/config.ts) calls octokit.repos.getContent()
// following Probot's context.octokit shape. Proxy .repos/.pulls/.issues to .rest.*.
const octokit = new Proxy(_octokit, {
  get(target, prop) {
    if (["repos", "pulls", "issues", "apps", "checks"].includes(prop)) {
      return target.rest[prop];
    }
    return target[prop];
  },
});

// minimal console logger matching Probot's log.warn / log.info shape
const log = {
  info:  (...a) => console.log("[INFO]",  ...a),
  warn:  (...a) => console.warn("[WARN]",  ...a),
  error: (...a) => console.error("[ERROR]", ...a),
  debug: (...a) => {},
};

// ─── main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n=== reviewgate verification: ${owner}/${repo} PR #${pull_number} ===\n`);

  // 1. Fetch real PR data + first review time (for pr_metrics)
  console.log("Fetching PR...");
  const { data: pull_request } = await octokit.rest.pulls.get({ owner, repo, pull_number });
  console.log(`  Title:  ${pull_request.title}`);
  console.log(`  State:  ${pull_request.state}  merged: ${pull_request.merged}`);
  console.log(`  Author: ${pull_request.user?.login}`);
  console.log(`  Files changed: ${pull_request.changed_files}  +${pull_request.additions} -${pull_request.deletions}`);

  let firstReviewAt;
  try {
    const reviews = await octokit.rest.pulls.listReviews({ owner, repo, pull_number });
    const first = reviews.data.find(r => r.submitted_at);
    firstReviewAt = first?.submitted_at;
  } catch { /* no reviews or API error — leave undefined */ }

  // 2. Build context (same shape as DetectionContext in src/index.ts)
  const context = {
    repo: () => ({ owner, repo }),
    payload: { pull_request },
    octokit,
    log,
  };

  // 3. Authorship detection
  console.log("\n--- Authorship detection ---");
  let authResult = { confidence: "none", reasons: [] };
  try {
    authResult = await evaluateAuthorship(context);
    console.log("  confidence:", authResult.confidence);
    console.log("  reasons:   ", JSON.stringify(authResult.reasons));
  } catch (e) {
    console.error("  FAILED:", e.message);
  }

  // 4. Consistency checker
  console.log("\n--- Consistency checker ---");
  let consistencyFindingCount;
  try {
    const consistency = await checkConsistency(context, authResult);
    if (consistency === undefined) {
      console.log("  Skipped (disabled — add .reviewgate.yml with consistencyCheck.enabled: true)");
    } else {
      consistencyFindingCount = consistency.namingFindings.length + consistency.errorHandlingFindings.length;
      console.log("  namingFindings:       ", consistency.namingFindings.length);
      console.log("  errorHandlingFindings:", consistency.errorHandlingFindings.length);
      if (consistency.namingFindings.length)       console.log("  naming:", JSON.stringify(consistency.namingFindings, null, 2));
      if (consistency.errorHandlingFindings.length) console.log("  error handling:", JSON.stringify(consistency.errorHandlingFindings, null, 2));
    }
  } catch (e) {
    console.error("  FAILED:", e.message);
  }

  // 5. Gate policy
  console.log("\n--- Gate policy ---");
  let gatePolicyBlocked;
  try {
    const gate = await checkGatePolicy(context, authResult);
    if (gate === undefined) {
      console.log("  Skipped (disabled — add .reviewgate.yml with gatePolicy.enabled: true)");
    } else {
      gatePolicyBlocked = gate.shouldBlock;
      console.log("  complexityFindings:", gate.complexityFindings.length);
      console.log("  sizeRiskFinding:   ", gate.sizeRiskFinding ? JSON.stringify(gate.sizeRiskFinding) : "none");
      console.log("  coverageFinding:   ", gate.coverageFinding  ? JSON.stringify(gate.coverageFinding)  : "none");
      console.log("  shouldBlock:       ", gate.shouldBlock);
      if (gate.complexityFindings.length) console.log("  complexity:", JSON.stringify(gate.complexityFindings, null, 2));
    }
  } catch (e) {
    console.error("  FAILED:", e.message);
  }

  // 6. Escape linkage (merge path, only meaningful if PR is merged)
  console.log("\n--- Escape linkage (merge path) ---");
  if (!pull_request.merged) {
    console.log("  PR is not merged — skipping merge-path escape detection");
  } else {
    const escapeContext = { repo: () => ({ owner, repo }), octokit, log };
    try {
      await checkEscapeLinkageOnMerge(
        escapeContext,
        { number: pull_number, body: pull_request.body, base: { sha: pull_request.base.sha } }
      );
      console.log("  Detection ran OK — escape records written for any issue refs found in commits");
    } catch (e) {
      if (e.message && e.message.includes("DATABASE_URL")) {
        console.log("  Detection ran OK; DB skipped (DATABASE_URL not set)");
      } else {
        console.error("  FAILED:", e.message);
      }
    }
  }

  // 7. Write pr_metrics (same INSERT the real Probot handler does)
  console.log("\n--- pr_metrics ---");
  if (process.env.DATABASE_URL) {
    try {
      const { metrics, warnings } = computeMetrics(
        {
          prId: pull_number,
          repo: `${owner}/${repo}`,
          openedAt: pull_request.created_at,
          firstReviewAt,
          mergedAt: pull_request.merged_at ?? undefined,
          reviewCommentCount: pull_request.review_comments,
        },
        authResult.confidence,
        { gatePolicyBlocked, consistencyFindingCount }
      );
      if (warnings.length) console.log("  warnings:", warnings);
      await saveMetrics(metrics);
      console.log("  Wrote pr_metrics row:", JSON.stringify(metrics));
    } catch (e) {
      console.error("  FAILED:", e.message);
    } finally {
      await closePool();
    }
  } else {
    console.log("  Skipped (DATABASE_URL not set)");
  }

  console.log("\n=== Done ===");
})();
