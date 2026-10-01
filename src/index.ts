// Probot app entry point. Listens for pull_request events and runs
// AI-authorship detection (src/detectors) plus cycle-time metrics capture
// (src/metrics).

import type { ApplicationFunctionOptions, Context, Probot } from "probot";
import { detectCoAuthorTrailer } from "./detectors/coAuthor";
import { loadConfig, matchesBranchPattern, matchesPrTemplateMarker } from "./detectors/config";
import {
  type AuthorshipResult,
  checkRunConclusion,
  checkRunSummary,
  combineSignals,
  shouldPostComment,
} from "./detectors/confidence";
import { computeMetrics, type FindingsSummary, type PrEventContext } from "./metrics/capture";
import { saveMetrics } from "./metrics/store";
import { getPool } from "./metrics/db";
import { checkConsistency, checkConsistencySummary } from "./consistency/checker";
import { checkGatePolicy, gatePolicySummary } from "./gatepolicy/checker";
import { composeCheckRunBody } from "./output/render";
import { checkEscapeLinkageOnMerge, checkEscapeLinkageOnNewIssue } from "./escapeLinkage/checker";
import { fetchDashboardMetrics } from "./dashboard/dataProvider";
import { renderDashboardPage } from "./dashboard/pageRenderer";

const CHECK_RUN_NAME = "reviewgate/ai-authorship";
const COMMENT_MARKER = "<!-- reviewgate:ai-authorship -->";

type Octokit = Context<"pull_request">["octokit"];
type Logger = Context<"pull_request">["log"];

// Hand-restated subset of Octokit's PullRequest/SimplePullRequest shapes
// (@octokit/webhooks-types, schema.d.ts — PullRequest ~L2915,
// SimplePullRequest ~L6506), not derived via the type system, since the two
// source types aren't identical and a generic intersection would be more
// fragile than this explicit list. If @octokit/webhooks-types is upgraded,
// re-verify these fields are still present on both shapes before trusting
// DetectionContext's structural match again.
//
// `base` added for the consistency checker: the sibling-file baseline
// must be read from the PR's base ref, not head — it represents the
// codebase's existing pattern, not this PR's own changes. Both PR shapes
// carry `base` the same way they carry `head`.
interface MinimalPr {
  number: number;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  body: string | null;
}

// Structural interface satisfied by both Context<"pull_request"> and
// Context<"pull_request_review"> — both carry a compatible embedded PR
// object (verified against @octokit/webhooks-types: PullRequestReview
// events' `pull_request` is a SimplePullRequest, which has `number`,
// `head.{ref,sha}`, and `body` but NOT `review_comments`, hence metrics
// assembly below always re-fetches the canonical full PR object instead of
// trusting the payload's embedded one). This lets evaluateAuthorship and
// the metrics-assembly functions run uniformly across event types without
// duplicating logic. upsertCheckRun/upsertComment deliberately keep the
// narrower Context<"pull_request"> type instead (below) — they are only
// ever called from the opened/synchronize handler, and widening them too
// would silently drop the compile-time guarantee that they can't be
// invoked from a pull_request_review context (found during a code-review
// pass).
export interface DetectionContext {
  repo(): { owner: string; repo: string };
  payload: { pull_request: MinimalPr };
  octokit: Octokit;
  log: Logger;
}

function prIdentity(context: DetectionContext) {
  const { owner, repo } = context.repo();
  return { owner, repo, pr: context.payload.pull_request };
}

function logIfRejected(log: Logger, outcome: PromiseSettledResult<void>, message: string): void {
  if (outcome.status === "rejected") {
    log.error({ err: outcome.reason }, message);
  }
}

// Found by a sixth /code-review pass: the fulfilled/rejected unwrap for
// checkConsistency's and checkGatePolicy's Promise.allSettled outcomes
// (below) was duplicated verbatim, differing only in the variable and log
// message — the same class of drift risk BR-4's default-literal
// duplication was once consolidated to avoid. logIfRejected (above) isn't
// reusable here since it's typed for PromiseSettledResult<void> and
// discards the fulfilled value; this generalizes the same pattern to
// return the value (or undefined on rejection, after logging).
function unwrapOrLog<T>(log: Logger, outcome: PromiseSettledResult<T>, message: string): T | undefined {
  if (outcome.status === "fulfilled") {
    return outcome.value;
  }
  log.error({ err: outcome.reason }, message);
  return undefined;
}

const locks = new Map<string, Promise<void>>();

// In-process mutex keyed by an arbitrary string. Closes the check-then-act
// race in upsertCheckRun/upsertComment: two webhook deliveries for the same
// key (e.g. two redeliveries of the same PR, processed concurrently within
// this one Node process) could otherwise both see "no existing resource" via
// their list call and both go on to create a duplicate check-run/comment.
// Chaining each call onto the previous one for the same key forces them to
// run strictly sequentially, so the second call's list-then-act sees the
// first call's write. Each key's chain entry is removed once it settles, so
// the map doesn't grow unboundedly over the process's lifetime.
//
// This only serializes within a single process — it is not a substitute for
// a database-level unique constraint or advisory lock, and does not protect
// against duplicate creation across multiple horizontally-scaled instances
// of this app. No deployment target/scaling model has been chosen yet for
// this MVP (RESILIENCY-04 is deferred to Operations), so a single-instance
// mitigation is what's being applied here; revisit if this app is ever run
// with more than one instance.
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const result = previous.then(fn, fn);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  locks.set(key, settled);
  void settled.finally(() => {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  });
  return result;
}

export async function evaluateAuthorship(context: DetectionContext): Promise<AuthorshipResult> {
  const { owner, repo, pr } = prIdentity(context);

  // Commit-listing and config-loading are independent of each other — run
  // them concurrently rather than paying two sequential round-trip
  // latencies. Only the config promise gets a .catch(): a commit-listing
  // failure must still propagate out of Promise.all and abort the whole
  // evaluation (handled by the caller's outer catch), while a config-load
  // failure degrades gracefully instead.
  //
  // Accepted tradeoff: running both concurrently means the config fetch
  // always fires even on the rare path where commit-listing is about to
  // fail, wasting one API call on that path. Avoiding it would require
  // re-serializing (config only fetched after commits succeed), which
  // would lose the latency win on the common success path — judged not
  // worth it since commit-listing failures are the exception, not the rule.
  let configLoadError: unknown;
  const [commits, config] = await Promise.all([
    context.octokit.paginate(context.octokit.pulls.listCommits, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
    loadConfig(context.octokit, owner, repo).catch((err) => {
      configLoadError = err;
      return undefined;
    }),
  ]);

  const coAuthorSignal = detectCoAuthorTrailer(commits.map((c) => c.commit.message));

  let matchedBranchPattern: string | undefined;
  let matchedTemplateMarker: string | undefined;
  if (config) {
    matchedBranchPattern = matchesBranchPattern(pr.head.ref, config.aiBranchPatterns ?? []);
    matchedTemplateMarker = matchesPrTemplateMarker(pr.body, config.aiPrTemplateMarkers ?? []);
  } else {
    // loadConfig only throws for operational errors (rate limit, network,
    // 5xx, permission issues) — "missing file" already fails closed to
    // defaults inside it (BR-4), which is why we key off `config` being
    // present rather than a separate flag. Degrade gracefully here rather
    // than aborting the whole evaluation: still post based on the
    // commit-trailer signal alone, instead of silently producing no
    // check-run/comment at all. The status code is logged (not just the
    // generic message) so a persistent 403 (misconfigured app permissions)
    // is distinguishable from a transient rate-limit 5xx during triage.
    const status =
      typeof configLoadError === "object" && configLoadError !== null
        ? (configLoadError as { status?: number }).status
        : undefined;
    context.log.warn(
      { err: configLoadError, status },
      "reviewgate: .reviewgate.yml load failed, evaluating trailer signal only"
    );
  }

  const result = combineSignals(coAuthorSignal, matchedBranchPattern, matchedTemplateMarker);
  if (!config) {
    result.reasons.push("(.reviewgate.yml unavailable — only commit-trailer signal evaluated)");
  }
  return result;
}

// consistencySummary (consistency checker): the "Consistency" section
// text from checkConsistencySummary, or "" when the check is
// disabled/out-of-scope or found nothing (BR-7) — appended verbatim, so
// "" produces no visible section change to the original authorship-only
// output.
//
// gatePolicySummary/shouldBlock (gate policy): the "Gate Policy" section
// text from gatePolicySummary, or "" per the same contract as
// consistencySummary; shouldBlock (default false) overrides the
// conclusion to "failure" — the one and only path to that conclusion in
// this project (BR-6). Output is now assembled via composeCheckRunBody
// (BR-5's restructuring) instead of ad-hoc string concatenation — each
// block is self-labeled (checkConsistencySummary/gatePolicySummary
// already embed their own bold label; the authorship block gets one
// added here, at the call site, so checkRunSummary itself stays
// untouched).
export async function upsertCheckRun(
  context: Context<"pull_request">,
  result: AuthorshipResult,
  consistencySummary = "",
  gatePolicySummaryText = "",
  shouldBlock = false
): Promise<void> {
  const { owner, repo, pr } = prIdentity(context);

  // Idempotency: a webhook redelivery for the same head SHA must update the
  // existing check-run rather than creating a duplicate. Wrapped in
  // withLock (keyed by head SHA) so two concurrent deliveries for the same
  // SHA can't both pass the listForRef check before either has created a
  // run — see withLock's comment for why this is needed and its limits.
  await withLock(`checkrun:${owner}/${repo}#${pr.head.sha}`, async () => {
    const existing = await context.octokit.checks.listForRef({
      owner,
      repo,
      ref: pr.head.sha,
      check_name: CHECK_RUN_NAME,
    });

    const output = {
      title: `Authorship confidence: ${result.confidence}`,
      summary: composeCheckRunBody([
        { body: `**Authorship**:\n${checkRunSummary(result)}` },
        { body: consistencySummary },
        { body: gatePolicySummaryText },
      ]),
    };
    // BR-6: shouldBlock overrides the conclusion to "failure" —
    // authorship/consistency-checker signals never contribute to this,
    // only gatePolicy's findings (see checkGatePolicy's shouldBlock
    // computation).
    const conclusion = shouldBlock ? "failure" : checkRunConclusion(result.confidence);

    const existingRun = existing.data.check_runs[0];
    if (existingRun) {
      await context.octokit.checks.update({
        owner,
        repo,
        check_run_id: existingRun.id,
        status: "completed",
        conclusion,
        output,
      });
    } else {
      await context.octokit.checks.create({
        owner,
        repo,
        name: CHECK_RUN_NAME,
        head_sha: pr.head.sha,
        status: "completed",
        conclusion,
        output,
      });
    }
  });
}

export async function upsertComment(
  context: Context<"pull_request">,
  result: AuthorshipResult,
  consistencySummary = "",
  gatePolicySummaryText = ""
): Promise<void> {
  // BR-6's original gate (post only for definite/likely confidence) would
  // silently drop consistency findings on a scope: "all" PR with
  // confidence "none" — found while wiring this up: shouldPostComment
  // only ever considered authorship confidence, but the consistency
  // checker can now have something worth posting (a non-empty
  // consistencySummary) independent of that confidence. Extended for the
  // gate-policy summary the same way (its own default scope is "all", so
  // this matters even more here).
  if (!shouldPostComment(result.confidence) && !consistencySummary && !gatePolicySummaryText) {
    return;
  }
  const { owner, repo, pr } = prIdentity(context);
  // Uses the same composeCheckRunBody/"**Authorship**:" convention as
  // upsertCheckRun (BR-5) — replaces the old standalone "**reviewgate**:"
  // bot-branding label, which is redundant with the invisible
  // COMMENT_MARKER already identifying this as reviewgate's comment.
  const body = `${COMMENT_MARKER}\n${composeCheckRunBody([
    { body: `**Authorship**:\n${checkRunSummary(result)}` },
    { body: consistencySummary },
    { body: gatePolicySummaryText },
  ])}`;

  // Idempotency: keep one sticky comment per PR instead of appending a new
  // one on every push/redelivery. per_page: 100 bounds the round-trip count
  // on PRs with long comment histories (full elimination of this scan
  // requires persisting the comment id, deferred to the metrics module's Postgres store).
  // Wrapped in withLock (keyed by PR number) so two concurrent deliveries
  // for the same PR can't both pass the list-and-find check before either
  // has created a comment — see withLock's comment for why this is needed
  // and its limits.
  await withLock(`comment:${owner}/${repo}#${pr.number}`, async () => {
    const comments = await context.octokit.paginate(context.octokit.issues.listComments, {
      owner,
      repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const existingComment = comments.find((c) => c.body?.includes(COMMENT_MARKER));

    if (existingComment) {
      await context.octokit.issues.updateComment({ owner, repo, comment_id: existingComment.id, body });
    } else {
      await context.octokit.issues.createComment({ owner, repo, issue_number: pr.number, body });
    }
  });
}

// Assembles PrEventContext for metrics capture. Always re-fetches the
// canonical full PR object (rather than trusting the webhook payload's
// embedded PR, whose shape/freshness varies by event type — see
// DetectionContext's comment) plus the reviews list for firstReviewAt,
// which works uniformly across opened/synchronize/closed/review-submitted
// without event-specific branching.
export async function buildPrEventContext(context: DetectionContext): Promise<PrEventContext> {
  const { owner, repo, pr } = prIdentity(context);

  const [fullPr, reviews] = await Promise.all([
    context.octokit.pulls.get({ owner, repo, pull_number: pr.number }),
    context.octokit.paginate(context.octokit.pulls.listReviews, {
      owner,
      repo,
      pull_number: pr.number,
      per_page: 100,
    }),
  ]);

  const mergedAt = fullPr.data.merged_at ?? undefined;
  const mergedAtMs = mergedAt !== undefined ? new Date(mergedAt).getTime() : undefined;

  // Only reviews submitted before the merge count as candidates for
  // "first review" — a review left on an already-merged PR (GitHub permits
  // this) is real data, but it isn't a "time to first review" in any
  // meaningful sense, and letting it through as firstReviewAt would make it
  // later than mergedAt, tripping computeMetrics's BR-2 ordering invariant
  // and dropping BOTH fields — including the already-correct
  // timeToMergeMinutes from an earlier event. Found during a code-review
  // pass: without this filter, a post-merge review event would silently
  // clobber previously-good data via the upsert in saveMetrics.
  //
  // Comparison is done via Date.getTime() (numeric), not raw string
  // comparison, matching the convention used everywhere else in this
  // codebase (e.g. minutesBetween below) — a raw string comparison would
  // give the wrong ordering for timestamps that differ in sub-second
  // precision or formatting (verified: "...:00.500Z" string-compares as
  // "less than" "...:00Z" despite being 500ms later), which would silently
  // reintroduce this exact class of data loss for any timestamp source
  // that isn't always whole-second UTC.
  const reviewTimestamps = reviews
    .map((r) => r.submitted_at)
    .filter((t): t is string => {
      if (!t) {
        return false;
      }
      return mergedAtMs === undefined || new Date(t).getTime() < mergedAtMs;
    })
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
  const firstReviewAt = reviewTimestamps.length > 0 ? reviewTimestamps[0] : undefined;

  return {
    prId: pr.number,
    repo: `${owner}/${repo}`,
    openedAt: fullPr.data.created_at,
    firstReviewAt,
    mergedAt,
    reviewCommentCount: fullPr.data.review_comments,
  };
}

// Wrapped in withLock (keyed by PR number), same mechanism as
// upsertCheckRun/upsertComment: two overlapping deliveries for the same PR
// (e.g. a synchronize event whose own evaluateAuthorship call is slow,
// racing a later, faster closed event) could otherwise complete out of
// order — the slower call's buildPrEventContext snapshot, taken earlier but
// written later, would silently overwrite the faster call's fresher write
// (e.g. resetting an already-correct time_to_merge_minutes back to NULL).
// Serializing the whole snapshot-then-write unit per PR guarantees that
// whichever call starts second always snapshots (and therefore writes)
// state at least as current as the one before it — found during a
// code-review pass.
// findingsSummary: optional — the opened/synchronize handler
// passes its already-computed gate-policy/consistency results through
// (no new fetch); the metrics-only path (closed/review_submitted) omits
// it entirely, since it never computes either. store.ts's COALESCE-based
// upsert is what actually prevents that omission from clobbering an
// earlier good value — this parameter only decides what THIS call
// contributes, not what survives in the row.
export async function captureAndSaveMetrics(
  context: DetectionContext,
  confidence: AuthorshipResult["confidence"],
  findingsSummary?: FindingsSummary
): Promise<void> {
  const { owner, repo, pr } = prIdentity(context);
  await withLock(`metrics:${owner}/${repo}#${pr.number}`, async () => {
    const event = await buildPrEventContext(context);
    const { metrics, warnings } = computeMetrics(event, confidence, findingsSummary);
    for (const warning of warnings) {
      context.log.warn({ prId: event.prId, repo: event.repo }, `reviewgate: ${warning}`);
    }
    await saveMetrics(metrics);
  });
}

// SECURITY-04: required on every response from the dashboard route,
// including the 500 error path below — set explicitly on both branches
// rather than via router middleware, since getRouter's minimal contract
// (ApplicationFunctionOptions) doesn't guarantee a full Express Router
// with .use() (see this file's own test harness, which fakes only .get()).
export const DASHBOARD_SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'self'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

export default (app: Probot, { getRouter }: ApplicationFunctionOptions = {}) => {
  // Metrics-dashboard (F1): served as a new route on the
  // existing app process (no new listening port/process). getRouter is
  // undefined in Probot's own type when a caller doesn't provide one
  // (e.g. this file's own test harness constructs a bare fake Probot
  // object without it) — skipped gracefully rather than throwing, since
  // the dashboard route is additive and its absence shouldn't prevent
  // the webhook handlers below from registering.
  if (getRouter) {
    const router = getRouter("/dashboard");
    router.get("/", async (_req, res) => {
      res.set(DASHBOARD_SECURITY_HEADERS);
      try {
        const metrics = await fetchDashboardMetrics(getPool());
        res.set("Content-Type", "text/html; charset=utf-8").send(renderDashboardPage(metrics));
      } catch (err) {
        app.log.error({ err }, "reviewgate: failed to render dashboard");
        res.status(500).send("Failed to load dashboard");
      }
    });
  }

  app.on(["pull_request.opened", "pull_request.reopened", "pull_request.ready_for_review", "pull_request.synchronize"], async (context) => {
    // Skip draft PRs — they are analyzed when the author marks them ready
    // for review (pull_request.ready_for_review, which always has draft:false).
    // Without this guard, a draft PR is analyzed on `opened` and again on
    // `ready_for_review`, producing duplicate check-runs and comments.
    if (context.payload.pull_request.draft === true) {
      return;
    }

    let result: AuthorshipResult;
    try {
      result = await evaluateAuthorship(context);
    } catch (err) {
      // Commit listing itself failed (distinct from a config-load failure,
      // which evaluateAuthorship already degrades gracefully) — nothing
      // meaningful can be posted or captured.
      context.log.error({ err }, "reviewgate: authorship evaluation failed");
      return;
    }

    // Consistency-checking and metrics capture are independent of
    // each other and both start immediately. But they are NOT joined into
    // one Promise.allSettled batch (as an earlier version of this handler
    // did) — found during a code-review pass: doing so meant check-run/
    // comment posting (which only needs the consistency result) also
    // waited on metrics capture, so a slow/hung Postgres write could delay
    // the visible PR status update even though metrics has nothing to do
    // with its content. The original authorship-only handler explicitly
    // guaranteed check-run/comment posting was independent of metrics;
    // this restructuring restores that for metrics specifically, while
    // still making check-run/comment wait on consistency (which they now
    // genuinely depend on for their content). metricsPromise's own error
    // handling is inlined (not logIfRejected, which expects a
    // PromiseSettledResult) since it's tracked outside any allSettled
    // batch here.
    //
    // metricsPromise is now started AFTER checkConsistency/
    // checkGatePolicy resolve (moved down from here), not before — needed
    // so their results can be persisted alongside the cycle-time metrics
    // (closing a persistence gap identified while adding the metrics
    // dashboard). This does NOT reintroduce the bug the original
    // decoupling fixed: check-run/comment posting below still never waits
    // on metricsPromise, only on consistency/gatePolicy — which it
    // already depended on regardless. The new dependency (metrics now
    // also waits on consistency/gatePolicy) doesn't touch that
    // guarantee's direction.

    // checkConsistency and checkGatePolicy are independent of each other
    // (gatePolicy deliberately fetches its own file list rather than
    // sharing one with checkConsistency), so run them concurrently rather than
    // sequentially — found by /code-review: awaiting them one after the
    // other simply adds their latencies together (each with its own
    // multi-second external-call/wall-clock budget) for no reason, when
    // running them concurrently costs only the slower of the two.
    const [consistencyOutcome, gatePolicyOutcome] = await Promise.allSettled([
      checkConsistency(context, result),
      checkGatePolicy(context, result),
    ]);
    const consistencyResult = unwrapOrLog(context.log, consistencyOutcome, "reviewgate: consistency check failed");
    const consistencySummary = checkConsistencySummary(consistencyResult);

    const gatePolicyResult = unwrapOrLog(context.log, gatePolicyOutcome, "reviewgate: gate policy check failed");
    const gatePolicySummaryText = gatePolicySummary(gatePolicyResult);
    const shouldBlock = gatePolicyResult?.shouldBlock ?? false;

    const metricsPromise = captureAndSaveMetrics(context, result.confidence, {
      gatePolicyBlocked: gatePolicyResult?.shouldBlock,
      consistencyFindingCount: consistencyResult
        ? consistencyResult.namingFindings.length + consistencyResult.errorHandlingFindings.length
        : undefined,
    }).catch((err: unknown) => {
      context.log.error({ err }, "reviewgate: failed to capture/save metrics");
    });

    const [checkRunOutcome, commentOutcome] = await Promise.allSettled([
      upsertCheckRun(context, result, consistencySummary, gatePolicySummaryText, shouldBlock),
      upsertComment(context, result, consistencySummary, gatePolicySummaryText),
    ]);
    logIfRejected(context.log, checkRunOutcome, "reviewgate: failed to post check-run");
    logIfRejected(context.log, commentOutcome, "reviewgate: failed to post PR comment");

    // Ensure the handler doesn't return (and the webhook delivery isn't
    // considered "done") before metrics capture has actually finished —
    // its own failure is already caught and logged above, so this await
    // can't throw; it just waits for completion without gating check-run/
    // comment posting on it.
    await metricsPromise;
  });

  // Metrics-only path: no check-run/comment posting (nothing new to gate
  // or explain to the PR author on close or on an incoming review), but
  // still need a fresh confidence tag and updated cycle-time numbers.
  //
  // Accepted tradeoff: this re-runs the full evaluateAuthorship pipeline
  // (paginated commit list + config reload) plus buildPrEventContext's full
  // PR+reviews refetch (which also re-sorts/re-filters the whole reviews
  // list to recompute firstReviewAt) on every single review submission,
  // even though the authorship signal itself can't change from a review
  // event — an active PR with many reviews pays all of that cost on each
  // one, compounding as the review count grows. Caching the
  // already-known confidence (e.g. reading it back from the pr_metrics row
  // written by the opened/synchronize handler) would avoid this, but adds a
  // read-before-write dependency and an edge case for PRs reviewed before
  // any opened/synchronize event was ever captured; deferred as
  // disproportionate for this MVP's scale, consistent with the
  // .reviewgate.yml caching gap already accepted in evaluateAuthorship.
  app.on(["pull_request.closed", "pull_request_review.submitted"], async (context) => {
    let result: AuthorshipResult;
    try {
      result = await evaluateAuthorship(context);
    } catch (err) {
      context.log.error({ err }, "reviewgate: authorship evaluation failed (metrics-only path)");
      return;
    }

    try {
      await captureAndSaveMetrics(context, result.confidence);
    } catch (err) {
      context.log.error({ err }, "reviewgate: failed to capture/save metrics");
    }
  });

  // Defect-escape-linkage (E1): a separate handler, not folded
  // into the metrics-only path above — that handler is also registered
  // for pull_request_review.submitted, whose payload's embedded PR is a
  // SimplePullRequest without a `merged`/`body` guarantee shaped the same
  // way (see DetectionContext's own comment on why upsertCheckRun/
  // upsertComment stay on the narrower Context<"pull_request"> type for
  // the same reason). checkEscapeLinkageOnMerge never throws (fails open
  // internally on both config-load and detection failures), but this is
  // still wrapped defensively, matching every other top-level call in
  // this file.
  app.on("pull_request.closed", async (context) => {
    const pr = context.payload.pull_request;
    if (!pr.merged) {
      return;
    }
    try {
      await checkEscapeLinkageOnMerge(context, { number: pr.number, body: pr.body, base: { sha: pr.base.sha } });
    } catch (err) {
      context.log.error({ err }, "reviewgate: escape-linkage on-merge check failed");
    }
  });

  // Defect-escape-linkage (E2/E3): this project's first
  // subscription to the `issues` event family — requires the `Issues:
  // Read` GitHub App permission. checkEscapeLinkageOnNewIssue never throws for
  // the same reason as checkEscapeLinkageOnMerge above; wrapped
  // defensively for the same consistency reason.
  app.on("issues.opened", async (context) => {
    const issue = context.payload.issue;
    try {
      await checkEscapeLinkageOnNewIssue(context, {
        number: issue.number,
        body: issue.body ?? null,
        createdAt: issue.created_at,
      });
    } catch (err) {
      context.log.error({ err }, "reviewgate: escape-linkage on-new-issue check failed");
    }
  });
};
