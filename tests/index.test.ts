import { describe, expect, it, vi } from "vitest";
import type { Context, Probot } from "probot";

const saveMetricsMock = vi.fn(async () => undefined);
vi.mock("../src/metrics/store", () => ({
  saveMetrics: saveMetricsMock,
}));

const checkEscapeLinkageOnMergeMock = vi.fn(async () => undefined);
const checkEscapeLinkageOnNewIssueMock = vi.fn(async () => undefined);
vi.mock("../src/escapeLinkage/checker", () => ({
  checkEscapeLinkageOnMerge: checkEscapeLinkageOnMergeMock,
  checkEscapeLinkageOnNewIssue: checkEscapeLinkageOnNewIssueMock,
}));

const getPoolMock = vi.fn(() => ({}));
vi.mock("../src/metrics/db", () => ({
  getPool: getPoolMock,
}));

const fetchDashboardMetricsMock = vi.fn(async () => ({
  aiPrCount: 1,
  humanPrCount: 1,
  avgCycleTimeMinutesByConfidence: { ai: 1, human: 1 },
  avgReviewCommentCountByConfidence: { ai: 1, human: 1 },
  escapeRate: { confirmedCount: 0, heuristicCount: 0 },
  gatePolicyBlockRate: undefined,
  consistencyFindingRate: undefined,
}));
vi.mock("../src/dashboard/dataProvider", () => ({
  fetchDashboardMetrics: fetchDashboardMetricsMock,
}));

const renderDashboardPageMock = vi.fn(() => "<html>fake dashboard</html>");
vi.mock("../src/dashboard/pageRenderer", () => ({
  renderDashboardPage: renderDashboardPageMock,
}));

const {
  default: registerApp,
  evaluateAuthorship,
  upsertCheckRun,
  upsertComment,
  buildPrEventContext,
  captureAndSaveMetrics,
  DASHBOARD_SECURITY_HEADERS,
} = await import("../src/index");

interface MockCheckRun {
  id: number;
  name: string;
  conclusion: string;
  output: { title: string; summary: string };
}

interface MockComment {
  id: number;
  body: string;
}

// A minimal, stateful fake of the parts of context.octokit this module
// actually calls. State (checkRuns/comments arrays) persists across calls
// within a single test, which is what lets the idempotency tests below
// simulate "the same event is handled twice." listForRef filters by
// check_name (like the real API) rather than blindly returning whatever
// exists, so a regression that passes the wrong name/ref would be caught
// rather than silently passing.
function makeContext(options: {
  commitMessages?: string[];
  configYaml?: string | { throw: unknown };
  headRef?: string;
  prBody?: string | null;
  openedAt?: string;
  mergedAt?: string | null;
  reviewSubmittedTimestamps?: (string | null)[];
  reviewCommentCount?: number;
  // Consistency-checker additions — routed by path, since
  // repos.getContent now serves .reviewgate.yml, sibling-directory
  // listings, and diff-file content all through the same endpoint.
  changedFiles?: Array<{ filename: string; status: string; changes?: number; additions?: number; deletions?: number }>;
  directoryListing?: unknown;
  fileContents?: Record<string, string>;
  // Gate-policy addition: simulates a check-run the repo's own
  // CI already produced (e.g. a coverage reporter) — distinct from
  // state.checkRuns, which tracks reviewgate's own check-run for
  // idempotency. listForRef below searches both, filtered by check_name,
  // matching the real API's behavior of returning any check-run with
  // that name regardless of which app created it.
  externalCheckRuns?: Array<{ name: string; output?: { summary?: string | null; text?: string | null } }>;
  // Defect-escape-linkage addition.
  merged?: boolean;
  draft?: boolean;
}): {
  context: Context<"pull_request">;
  state: { checkRuns: MockCheckRun[]; comments: MockComment[] };
} {
  const state = { checkRuns: [] as MockCheckRun[], comments: [] as MockComment[] };
  let nextCheckRunId = 1;
  let nextCommentId = 1;

  const octokit = {
    paginate: vi.fn(async (fn: (...args: unknown[]) => Promise<{ data: unknown }>, params: unknown) => {
      const response = await fn(params);
      return response.data as unknown[];
    }),
    pulls: {
      listCommits: vi.fn(async () => ({
        data: (options.commitMessages ?? []).map((message) => ({ commit: { message } })),
      })),
      get: vi.fn(async () => ({
        data: {
          created_at: options.openedAt ?? "2026-01-01T00:00:00Z",
          merged_at: options.mergedAt ?? null,
          review_comments: options.reviewCommentCount ?? 0,
        },
      })),
      listReviews: vi.fn(async () => ({
        data: (options.reviewSubmittedTimestamps ?? []).map((submitted_at) => ({ submitted_at })),
      })),
      listFiles: vi.fn(async () => ({
        data: (options.changedFiles ?? []).map((file) => ({ changes: 1, additions: 1, deletions: 0, ...file })),
      })),
    },
    repos: {
      getContent: vi.fn(async (params: { path: string }) => {
        if (params.path === ".reviewgate.yml") {
          if (options.configYaml === undefined) {
            throw { status: 404 };
          }
          if (typeof options.configYaml === "object" && "throw" in options.configYaml) {
            throw options.configYaml.throw;
          }
          return { data: { content: Buffer.from(options.configYaml).toString("base64"), encoding: "base64" } };
        }
        const fileContent = options.fileContents?.[params.path];
        if (fileContent !== undefined) {
          return { data: { content: Buffer.from(fileContent).toString("base64"), encoding: "base64" } };
        }
        return { data: options.directoryListing ?? [] };
      }),
    },
    checks: {
      listForRef: vi.fn(async (params: { check_name?: string }) => ({
        data: {
          check_runs: [...state.checkRuns, ...(options.externalCheckRuns ?? [])].filter(
            (r) => r.name === params.check_name
          ),
        },
      })),
      create: vi.fn(
        async (params: { name: string; conclusion: string; output: { title: string; summary: string } }) => {
          state.checkRuns.push({
            id: nextCheckRunId++,
            name: params.name,
            conclusion: params.conclusion,
            output: params.output,
          });
        }
      ),
      update: vi.fn(async (params: { check_run_id: number; conclusion: string; output: unknown }) => {
        const run = state.checkRuns.find((r) => r.id === params.check_run_id);
        if (run) {
          run.conclusion = params.conclusion;
          run.output = params.output as { title: string; summary: string };
        }
      }),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: state.comments })),
      createComment: vi.fn(async (params: { body: string }) => {
        state.comments.push({ id: nextCommentId++, body: params.body });
      }),
      updateComment: vi.fn(async (params: { comment_id: number; body: string }) => {
        const comment = state.comments.find((c) => c.id === params.comment_id);
        if (comment) {
          comment.body = params.body;
        }
      }),
    },
  };

  const context = {
    repo: () => ({ owner: "acme", repo: "widgets" }),
    payload: {
      pull_request: {
        number: 42,
        head: { sha: "abc123", ref: options.headRef ?? "feature/login" },
        base: { sha: "basesha", ref: "main" },
        body: options.prBody ?? null,
        merged: options.merged ?? false,
        draft: options.draft ?? false,
      },
      issue: {
        number: 99,
        body: options.prBody ?? null,
        created_at: options.openedAt ?? "2026-01-01T00:00:00Z",
      },
    },
    octokit,
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as Context<"pull_request">;

  return { context, state };
}

describe("evaluateAuthorship", () => {
  it("returns definite confidence for a matching commit trailer", async () => {
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
    });
    const result = await evaluateAuthorship(context);
    expect(result.confidence).toBe("definite");
  });

  // Regression test for the first code-review finding: a config-load
  // failure (non-404) must degrade gracefully, not abort the whole
  // evaluation and produce nothing.
  it("degrades gracefully when config loading fails for an operational reason", async () => {
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: { throw: { status: 403, message: "rate limited" } },
    });
    const result = await evaluateAuthorship(context);
    expect(result.confidence).toBe("definite");
    expect(result.reasons.some((r) => r.includes("unavailable"))).toBe(true);
  });

  // Exercises the successful config-load path and confirms both results
  // are still combined correctly when both concurrent calls succeed.
  it("returns likely confidence when only a configured branch pattern matches", async () => {
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Jane Doe <jane@example.com>"],
      configYaml: "aiBranchPatterns:\n  - ai/*\n",
      headRef: "ai/refactor-auth",
    });
    const result = await evaluateAuthorship(context);
    expect(result.confidence).toBe("likely");
    expect(result.reasons).toContain("Branch name matches pattern: ai/*");
  });
});

describe("upsertCheckRun idempotency", () => {
  it("creates a check-run when none exists, then updates in place on a repeated call", async () => {
    const { context, state } = makeContext({});
    const result = { confidence: "definite" as const, reasons: ["test"], matchedTrailer: "Claude Code" };

    await upsertCheckRun(context, result);
    expect(state.checkRuns).toHaveLength(1);

    // Simulate the same event being handled again (webhook redelivery, or a
    // repeated synchronize for the same head SHA) — state must not grow.
    await upsertCheckRun(context, result);
    expect(state.checkRuns).toHaveLength(1);
  });

  // Regression test for a gap found in the third code-review pass: the mock
  // previously ignored check_name entirely, so a bug that queried for the
  // wrong check-run name would have passed unnoticed. This asserts the code
  // only ever matches/updates its own named check-run, not an unrelated one
  // (e.g. a CI/lint check-run) that happens to exist on the same SHA.
  it("does not touch an unrelated check-run with a different name", async () => {
    const { context, state } = makeContext({});
    state.checkRuns.push({ id: 999, name: "ci/lint", conclusion: "success", output: { title: "", summary: "" } });

    const result = { confidence: "definite" as const, reasons: ["test"], matchedTrailer: "Claude Code" };
    await upsertCheckRun(context, result);

    expect(state.checkRuns).toHaveLength(2);
    const lintRun = state.checkRuns.find((r) => r.id === 999);
    expect(lintRun?.conclusion).toBe("success");
    const reviewgateRun = state.checkRuns.find((r) => r.name === "reviewgate/ai-authorship");
    expect(reviewgateRun).toBeDefined();
  });

  // Regression test for the withLock fix: two concurrent calls for the
  // same head SHA (e.g. overlapping webhook redeliveries processed in the
  // same process) must not both pass the "no existing check-run" check
  // before either has created one. This mock's async functions have no
  // internal awaits, so both calls' listForRef reads are captured before
  // either call's create() write — deterministic, not timing-dependent —
  // so removing withLock would make this test reliably fail with 2
  // check-runs instead of 1.
  it("does not create a duplicate check-run when two calls run concurrently", async () => {
    const { context, state } = makeContext({});
    const result = { confidence: "definite" as const, reasons: ["test"], matchedTrailer: "Claude Code" };

    await Promise.all([upsertCheckRun(context, result), upsertCheckRun(context, result)]);

    expect(state.checkRuns).toHaveLength(1);
  });
});

describe("upsertComment idempotency", () => {
  it("creates a comment when none exists, then updates the same comment on a repeated call", async () => {
    const { context, state } = makeContext({});
    const result = { confidence: "likely" as const, reasons: ["test"] };

    await upsertComment(context, result);
    expect(state.comments).toHaveLength(1);

    await upsertComment(context, result);
    expect(state.comments).toHaveLength(1);
  });

  it("does not call the GitHub API at all when confidence is none", async () => {
    const { context, state } = makeContext({});
    const result = { confidence: "none" as const, reasons: [] };

    await upsertComment(context, result);
    expect(state.comments).toHaveLength(0);
  });

  // Same race-condition regression as upsertCheckRun above, keyed by PR
  // number instead of head SHA.
  it("does not create a duplicate comment when two calls run concurrently", async () => {
    const { context, state } = makeContext({});
    const result = { confidence: "likely" as const, reasons: ["test"] };

    await Promise.all([upsertComment(context, result), upsertComment(context, result)]);

    expect(state.comments).toHaveLength(1);
  });
});

describe("buildPrEventContext", () => {
  it("derives firstReviewAt as the earliest review submission timestamp", async () => {
    const { context } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      reviewSubmittedTimestamps: ["2026-01-01T05:00:00Z", "2026-01-01T02:00:00Z", null],
      reviewCommentCount: 4,
    });
    const event = await buildPrEventContext(context);
    expect(event.firstReviewAt).toBe("2026-01-01T02:00:00Z");
    expect(event.reviewCommentCount).toBe(4);
    expect(event.prId).toBe(42);
    expect(event.repo).toBe("acme/widgets");
  });

  it("leaves firstReviewAt undefined when no reviews have been submitted", async () => {
    const { context } = makeContext({});
    const event = await buildPrEventContext(context);
    expect(event.firstReviewAt).toBeUndefined();
  });

  // Regression test for the data-loss bug found during a code-review pass:
  // a review submitted on an already-merged PR (GitHub permits this) must
  // NOT be treated as the "first review" — if it were, firstReviewAt would
  // end up later than mergedAt, tripping computeMetrics's BR-2 ordering
  // invariant and dropping the already-correct timeToMergeMinutes too.
  it("excludes reviews submitted after the merge from firstReviewAt consideration", async () => {
    const { context } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-01T01:00:00Z",
      reviewSubmittedTimestamps: ["2026-01-01T02:00:00Z"], // after merge
    });
    const event = await buildPrEventContext(context);
    expect(event.firstReviewAt).toBeUndefined();
    expect(event.mergedAt).toBe("2026-01-01T01:00:00Z");
  });

  it("still finds firstReviewAt when some reviews are pre-merge and some are post-merge", async () => {
    const { context } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-01T02:00:00Z",
      reviewSubmittedTimestamps: ["2026-01-01T03:00:00Z", "2026-01-01T01:00:00Z"], // one after, one before
    });
    const event = await buildPrEventContext(context);
    expect(event.firstReviewAt).toBe("2026-01-01T01:00:00Z");
  });
});

describe("captureAndSaveMetrics (post-merge review regression)", () => {
  // End-to-end version of the buildPrEventContext regression above: proves
  // the full capture pipeline no longer clobbers a valid timeToMergeMinutes
  // when a review arrives after merge.
  it("preserves timeToMergeMinutes when a review is submitted after merge", async () => {
    saveMetricsMock.mockClear();
    const { context } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-01T01:00:00Z",
      reviewSubmittedTimestamps: ["2026-01-01T02:00:00Z"], // after merge
    });

    await captureAndSaveMetrics(context, "none");

    const savedMetrics = saveMetricsMock.mock.calls[0][0];
    expect(savedMetrics.timeToMergeMinutes).toBe(60);
    expect(savedMetrics.timeToFirstReviewMinutes).toBeUndefined();
  });
});

describe("captureAndSaveMetrics", () => {
  it("computes and saves metrics tagged with the given confidence", async () => {
    saveMetricsMock.mockClear();
    const { context } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-01T01:00:00Z",
      reviewCommentCount: 2,
    });

    await captureAndSaveMetrics(context, "definite");

    expect(saveMetricsMock).toHaveBeenCalledTimes(1);
    const savedMetrics = saveMetricsMock.mock.calls[0][0];
    expect(savedMetrics).toMatchObject({
      prId: 42,
      repo: "acme/widgets",
      confidence: "definite",
      timeToMergeMinutes: 60,
      reviewCommentCount: 2,
    });
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Regression test (code-review pass): two overlapping deliveries for the
// same PR — a slow one snapshotting pre-merge state, a fast one
// snapshotting post-merge state — must not let the slow (stale) snapshot's
// write land after and clobber the fast (fresh) one's write.
describe("captureAndSaveMetrics (concurrent-delivery race regression)", () => {
  it("does not let a slower, stale snapshot overwrite a faster, fresher write for the same PR", async () => {
    saveMetricsMock.mockClear();

    // Event A: pre-merge snapshot, but its own PR fetch is slow (stands in
    // for a slow upstream evaluateAuthorship call in the real handler).
    const { context: contextA } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: null,
    });
    const originalGet = contextA.octokit.pulls.get;
    contextA.octokit.pulls.get = vi.fn(async (...args: unknown[]) => {
      await delay(20);
      return (originalGet as (...a: unknown[]) => Promise<unknown>)(...args);
    });

    // Event B: post-merge snapshot, fast.
    const { context: contextB } = makeContext({
      openedAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-01-01T01:00:00Z",
    });

    const callA = captureAndSaveMetrics(contextA, "definite");
    await Promise.resolve();
    const callB = captureAndSaveMetrics(contextB, "definite");
    await Promise.all([callA, callB]);

    expect(saveMetricsMock).toHaveBeenCalledTimes(2);
    const lastCall = saveMetricsMock.mock.calls[saveMetricsMock.mock.calls.length - 1][0];
    expect(lastCall.timeToMergeMinutes).toBe(60);
  });
});

describe("app.on handlers", () => {
  function registerFakeApp(): {
    openedHandler: (context: Context<"pull_request">) => Promise<void>;
    closedHandler: (context: Context<"pull_request">) => Promise<void>;
    escapeLinkageMergeHandler: (context: Context<"pull_request">) => Promise<void>;
    escapeLinkageNewIssueHandler: (context: Context<"issues">) => Promise<void>;
  } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the fake registers handlers for multiple distinct event payload shapes (pull_request, issues), which a single non-generic map value type can't express without this.
    const handlers = new Map<string, (context: any) => Promise<void>>();
    const fakeApp = {
      on: (events: string[] | string, fn: (context: unknown) => Promise<void>) => {
        const key = Array.isArray(events) ? events.join(",") : events;
        handlers.set(key, fn);
      },
    } as unknown as Probot;
    registerApp(fakeApp);

    const openedHandler = handlers.get("pull_request.opened,pull_request.reopened,pull_request.ready_for_review,pull_request.synchronize");
    const closedHandler = handlers.get("pull_request.closed,pull_request_review.submitted");
    const escapeLinkageMergeHandler = handlers.get("pull_request.closed");
    const escapeLinkageNewIssueHandler = handlers.get("issues.opened");
    expect(openedHandler).toBeDefined();
    expect(closedHandler).toBeDefined();
    expect(escapeLinkageMergeHandler).toBeDefined();
    expect(escapeLinkageNewIssueHandler).toBeDefined();
    return {
      openedHandler: openedHandler!,
      closedHandler: closedHandler!,
      escapeLinkageMergeHandler: escapeLinkageMergeHandler!,
      escapeLinkageNewIssueHandler: escapeLinkageNewIssueHandler!,
    };
  }

  // Regression test found during the fourth code-review pass: the app.on
  // handler's outer catch (for a commit-listing failure) had zero coverage
  // across every prior round.
  it("opened/synchronize handler logs and posts nothing when commit-listing fails", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context } = makeContext({});
    (context.octokit.pulls.listCommits as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("network error")
    );

    await openedHandler(context);

    expect(context.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "reviewgate: authorship evaluation failed"
    );
    expect(context.octokit.checks.create).not.toHaveBeenCalled();
    expect(context.octokit.checks.update).not.toHaveBeenCalled();
    expect(context.octokit.issues.createComment).not.toHaveBeenCalled();
    expect(saveMetricsMock).not.toHaveBeenCalled();
  });

  it("opened/synchronize handler posts a check-run, comment, and saves metrics on success", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      mergedAt: "2026-01-01T01:00:00Z",
    });

    await openedHandler(context);

    expect(state.checkRuns).toHaveLength(1);
    expect(state.comments).toHaveLength(1);
    expect(saveMetricsMock).toHaveBeenCalledTimes(1);
  });

  it("skips all processing when pull_request.draft is true", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({ draft: true });

    await openedHandler(context);

    expect(state.checkRuns).toHaveLength(0);
    expect(state.comments).toHaveLength(0);
    expect(saveMetricsMock).not.toHaveBeenCalled();
    expect(context.octokit.pulls.listCommits).not.toHaveBeenCalled();
  });

  it("runs full pipeline for ready_for_review (draft: false)", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      draft: false,
      headRef: "ai/some-feature",
      configYaml: "aiBranchPatterns:\n  - 'ai/*'\n",
    });

    await openedHandler(context);

    expect(state.checkRuns).toHaveLength(1);
    expect(state.comments).toHaveLength(1);
    expect(saveMetricsMock).toHaveBeenCalledTimes(1);
  });

  // Regression test (code-review pass): an earlier version of this
  // handler joined checkConsistency and captureAndSaveMetrics into one
  // Promise.allSettled batch, which meant check-run/comment posting
  // (which only needs the consistency result) also waited for metrics
  // capture to finish — reintroducing exactly the coupling the original
  // fully-parallel structure was designed to avoid. Asserts
  // check-run/comment are posted while metrics capture is still pending.
  it("posts a check-run and comment without waiting for a slow metrics capture to finish", async () => {
    saveMetricsMock.mockClear();
    let resolveMetrics: (() => void) | undefined;
    saveMetricsMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveMetrics = resolve;
        })
    );
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
    });

    const handlerPromise = openedHandler(context);

    await vi.waitFor(() => {
      expect(state.checkRuns).toHaveLength(1);
      expect(state.comments).toHaveLength(1);
    });
    // Metrics capture is still pending at this point.
    expect(saveMetricsMock).toHaveBeenCalledTimes(1);

    resolveMetrics!();
    await handlerPromise;
  });

  // Closes the persistence gap — gate-policy/consistency results
  // computed earlier in this same handler invocation must reach
  // saveMetrics, not just the check-run/comment output.
  it("passes gatePolicyBlocked and consistencyFindingCount through to saveMetrics", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "consistencyCheck:\n  enabled: true\n  scope: all\ngatePolicy:\n  enabled: true\n  blocking: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 100 },
        { name: "b.ts", path: "src/b.ts", type: "file", size: 100 },
        { name: "c.ts", path: "src/c.ts", type: "file", size: 100 },
      ],
      fileContents: {
        "src/a.ts": "const camelOne = 1;",
        "src/b.ts": "const camelTwo = 1;",
        "src/c.ts": "const camelThree = 1;",
        "src/foo.ts": "const snake_named = 4; function complexFn() { if(a){if(b){if(c){if(d){return 1;}}}} }",
      },
    });

    await openedHandler(context);

    expect(saveMetricsMock).toHaveBeenCalledTimes(1);
    const savedMetrics = saveMetricsMock.mock.calls[0][0];
    // Asserts the plumbing carries a defined number through (not that a
    // specific naming.ts/errorHandling.ts rule fires — that's naming.ts's
    // own MIN_SAMPLE_SIZE=5 concern, already covered by
    // tests/consistency/*.test.ts, not this wiring test's).
    expect(typeof savedMetrics.consistencyFindingCount).toBe("number");
    expect(typeof savedMetrics.gatePolicyBlocked).toBe("boolean");
  });

  it("leaves gatePolicyBlocked/consistencyFindingCount undefined when neither feature is enabled (default)", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
    });

    await openedHandler(context);

    const savedMetrics = saveMetricsMock.mock.calls[0][0];
    expect(savedMetrics.gatePolicyBlocked).toBeUndefined();
    expect(savedMetrics.consistencyFindingCount).toBeUndefined();
  });

  // Default config leaves consistencyCheck disabled — the original
  // authorship-only output must be byte-for-byte unaffected (no
  // "Consistency" section, no extra API calls).
  it("opened/synchronize handler does not run the consistency check when disabled (default)", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      mergedAt: "2026-01-01T01:00:00Z",
    });

    await openedHandler(context);

    expect(context.octokit.pulls.listFiles).not.toHaveBeenCalled();
    expect(state.checkRuns[0].output.summary).not.toContain("Consistency");
    expect(state.comments[0].body).not.toContain("Consistency");
  });

  it("opened/synchronize handler appends a Consistency section when the check finds deviations", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 50 },
        { name: "b.ts", path: "src/b.ts", type: "file", size: 50 },
        { name: "c.ts", path: "src/c.ts", type: "file", size: 50 },
        { name: "d.ts", path: "src/d.ts", type: "file", size: 50 },
        { name: "e.ts", path: "src/e.ts", type: "file", size: 50 },
      ],
      fileContents: {
        "src/a.ts": "const camelOne = 1;",
        "src/b.ts": "const camelTwo = 1;",
        "src/c.ts": "const camelThree = 1;",
        "src/d.ts": "const camelFour = 1;",
        "src/e.ts": "const camelFive = 1;",
        "src/foo.ts": "const snake_named = 4;",
      },
    });

    await openedHandler(context);

    expect(state.checkRuns[0].output.summary).toContain("Consistency");
    expect(state.checkRuns[0].output.summary).toContain("snake_named");
    expect(state.comments[0].body).toContain("Consistency");
    // Non-blocking (BR-7): consistency findings never fail the check-run.
    expect(state.checkRuns[0].conclusion).not.toBe("failure");
  });

  // Regression test for the upsertComment fix found while wiring this up:
  // scope "all" can produce findings on a confidence: "none" PR, which
  // the original shouldPostComment(confidence) gate would have
  // silently suppressed entirely.
  it("posts a comment for consistency findings even when confidence is none, under scope: all", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      // No commit trailer, no branch/marker match -> confidence "none".
      configYaml: "consistencyCheck:\n  enabled: true\n  scope: all\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 50 },
        { name: "b.ts", path: "src/b.ts", type: "file", size: 50 },
        { name: "c.ts", path: "src/c.ts", type: "file", size: 50 },
        { name: "d.ts", path: "src/d.ts", type: "file", size: 50 },
        { name: "e.ts", path: "src/e.ts", type: "file", size: 50 },
      ],
      fileContents: {
        "src/a.ts": "const camelOne = 1;",
        "src/b.ts": "const camelTwo = 1;",
        "src/c.ts": "const camelThree = 1;",
        "src/d.ts": "const camelFour = 1;",
        "src/e.ts": "const camelFive = 1;",
        "src/foo.ts": "const CONSTANT_LIKE_VAR_X = 4;",
      },
    });

    await openedHandler(context);

    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain("Consistency");
  });

  // Default config leaves gatePolicy disabled — no extra API
  // calls, no "Gate Policy" section, mirroring the consistency checker's
  // equivalent backward-compatibility test above.
  it("opened/synchronize handler does not run the gate policy check when disabled (default)", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      mergedAt: "2026-01-01T01:00:00Z",
    });

    await openedHandler(context);

    expect(state.checkRuns[0].output.summary).not.toContain("Gate Policy");
    expect(state.comments[0].body).not.toContain("Gate Policy");
  });

  it("opened/synchronize handler appends a Gate Policy section when a rule finds a deviation", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "gatePolicy:\n  enabled: true\n  sizeRisk:\n    linesThreshold: 0\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified", additions: 5, deletions: 0 }],
    });

    await openedHandler(context);

    expect(state.checkRuns[0].output.summary).toContain("Gate Policy");
    expect(state.comments[0].body).toContain("Gate Policy");
    // Non-blocking by default (BR-6): a gate-policy finding never fails
    // the check-run unless gatePolicy.blocking: true is set.
    expect(state.checkRuns[0].conclusion).not.toBe("failure");
  });

  // BR-6: the one and only path to a "failure" conclusion in this project.
  it("opened/synchronize handler fails the check-run when gatePolicy.blocking is true and a rule fails", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "gatePolicy:\n  enabled: true\n  blocking: true\n  sizeRisk:\n    linesThreshold: 0\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified", additions: 5, deletions: 0 }],
    });

    await openedHandler(context);

    expect(state.checkRuns[0].conclusion).toBe("failure");
    // D6: advance signal — the failing rule's own content is always
    // present, not a generic "gate failed" message with no explanation.
    expect(state.checkRuns[0].output.summary).toContain("Gate Policy");
    expect(state.checkRuns[0].output.summary).toContain("blocked from merging");
  });

  // Regression test (BR-6's central invariant): authorship/consistency-
  // checker signals must remain permanently unable to cause a "failure"
  // conclusion, even when gatePolicy is enabled and blocking, as long as
  // gatePolicy's own rules don't fail. A high-confidence authorship
  // result plus real consistency findings must not, by themselves, ever
  // produce "failure."
  it("never fails the check-run from authorship/consistency-checker findings alone, even with gatePolicy.blocking enabled", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "consistencyCheck:\n  enabled: true\ngatePolicy:\n  enabled: true\n  blocking: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified", additions: 1, deletions: 0 }],
      directoryListing: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 50 },
        { name: "b.ts", path: "src/b.ts", type: "file", size: 50 },
        { name: "c.ts", path: "src/c.ts", type: "file", size: 50 },
        { name: "d.ts", path: "src/d.ts", type: "file", size: 50 },
        { name: "e.ts", path: "src/e.ts", type: "file", size: 50 },
      ],
      fileContents: {
        "src/a.ts": "const camelOne = 1;",
        "src/b.ts": "const camelTwo = 1;",
        "src/c.ts": "const camelThree = 1;",
        "src/d.ts": "const camelFour = 1;",
        "src/e.ts": "const camelFive = 1;",
        "src/foo.ts": "const snake_named = 4;",
      },
    });

    await openedHandler(context);

    // Definite authorship confidence and a real consistency finding are
    // both present, but no gate-policy rule failed (sizeRisk/complexity/
    // coverage all pass with default thresholds) — conclusion must stay
    // non-failure.
    expect(state.checkRuns[0].output.summary).toContain("Consistency");
    expect(state.checkRuns[0].conclusion).not.toBe("failure");
  });

  it("posts a comment for gate policy findings even when confidence is none, under scope: all (default)", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      // No commit trailer, no branch/marker match -> confidence "none".
      configYaml: "gatePolicy:\n  enabled: true\n  sizeRisk:\n    linesThreshold: 0\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified", additions: 5, deletions: 0 }],
    });

    await openedHandler(context);

    expect(state.comments).toHaveLength(1);
    expect(state.comments[0].body).toContain("Gate Policy");
  });

  it("reads coverage data from an existing CI check-run by configured name", async () => {
    saveMetricsMock.mockClear();
    const { openedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "gatePolicy:\n  enabled: true\n  coverage:\n    checkRunName: coverage-report\n    minimumPercent: 90\n",
      externalCheckRuns: [{ name: "coverage-report", output: { summary: "coverage: 60%" } }],
    });

    await openedHandler(context);

    expect(state.checkRuns[0].output.summary).toContain("60%");
  });

  it("closed/review-submitted handler never invokes the gate policy check", async () => {
    saveMetricsMock.mockClear();
    const { closedHandler } = registerFakeApp();
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "gatePolicy:\n  enabled: true\n",
      mergedAt: "2026-01-01T02:00:00Z",
    });

    await closedHandler(context);

    expect(context.octokit.pulls.listFiles).not.toHaveBeenCalled();
  });

  it("closed/review-submitted handler never invokes the consistency check", async () => {
    saveMetricsMock.mockClear();
    const { closedHandler } = registerFakeApp();
    const { context } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      configYaml: "consistencyCheck:\n  enabled: true\n  scope: all\n",
      mergedAt: "2026-01-01T02:00:00Z",
    });

    await closedHandler(context);

    expect(context.octokit.pulls.listFiles).not.toHaveBeenCalled();
  });

  it("closed/review-submitted handler saves metrics without posting a check-run or comment", async () => {
    saveMetricsMock.mockClear();
    const { closedHandler } = registerFakeApp();
    const { context, state } = makeContext({
      commitMessages: ["Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>"],
      mergedAt: "2026-01-01T02:00:00Z",
    });

    await closedHandler(context);

    expect(state.checkRuns).toHaveLength(0);
    expect(state.comments).toHaveLength(0);
    expect(saveMetricsMock).toHaveBeenCalledTimes(1);
  });

  describe("Defect-escape-linkage handlers", () => {
    it("pull_request.closed handler calls checkEscapeLinkageOnMerge with the extracted PR fields when merged", async () => {
      checkEscapeLinkageOnMergeMock.mockClear();
      const { escapeLinkageMergeHandler } = registerFakeApp();
      const { context } = makeContext({ merged: true, prBody: "Fixes #1" });

      await escapeLinkageMergeHandler(context);

      expect(checkEscapeLinkageOnMergeMock).toHaveBeenCalledWith(context, {
        number: 42,
        body: "Fixes #1",
        base: { sha: "basesha" },
      });
    });

    it("pull_request.closed handler does not call checkEscapeLinkageOnMerge when the PR was closed without merging", async () => {
      checkEscapeLinkageOnMergeMock.mockClear();
      const { escapeLinkageMergeHandler } = registerFakeApp();
      const { context } = makeContext({ merged: false });

      await escapeLinkageMergeHandler(context);

      expect(checkEscapeLinkageOnMergeMock).not.toHaveBeenCalled();
    });

    it("pull_request.closed handler catches and logs (not throws) when checkEscapeLinkageOnMerge rejects", async () => {
      checkEscapeLinkageOnMergeMock.mockClear();
      checkEscapeLinkageOnMergeMock.mockRejectedValueOnce(new Error("boom"));
      const { escapeLinkageMergeHandler } = registerFakeApp();
      const { context } = makeContext({ merged: true });

      await expect(escapeLinkageMergeHandler(context)).resolves.toBeUndefined();
      expect(context.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reviewgate: escape-linkage on-merge check failed"
      );
    });

    it("issues.opened handler calls checkEscapeLinkageOnNewIssue with the extracted issue fields", async () => {
      checkEscapeLinkageOnNewIssueMock.mockClear();
      const { escapeLinkageNewIssueHandler } = registerFakeApp();
      const { context } = makeContext({ prBody: "Escape-Source: #5", openedAt: "2026-02-01T00:00:00Z" });

      await escapeLinkageNewIssueHandler(context as unknown as Context<"issues">);

      expect(checkEscapeLinkageOnNewIssueMock).toHaveBeenCalledWith(context, {
        number: 99,
        body: "Escape-Source: #5",
        createdAt: "2026-02-01T00:00:00Z",
      });
    });

    it("issues.opened handler catches and logs (not throws) when checkEscapeLinkageOnNewIssue rejects", async () => {
      checkEscapeLinkageOnNewIssueMock.mockClear();
      checkEscapeLinkageOnNewIssueMock.mockRejectedValueOnce(new Error("boom"));
      const { escapeLinkageNewIssueHandler } = registerFakeApp();
      const { context } = makeContext({});

      await expect(escapeLinkageNewIssueHandler(context as unknown as Context<"issues">)).resolves.toBeUndefined();
      expect(context.log.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "reviewgate: escape-linkage on-new-issue check failed"
      );
    });
  });
});

describe("dashboard HTTP route", () => {
  function registerFakeAppWithRouter(): {
    getHandler: (req: unknown, res: { set: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> }) => Promise<void>;
    getRouterMock: ReturnType<typeof vi.fn>;
  } {
    let getHandler: ((req: unknown, res: unknown) => Promise<void>) | undefined;
    const fakeRouter = {
      get: (path: string, handler: (req: unknown, res: unknown) => Promise<void>) => {
        if (path === "/") {
          getHandler = handler;
        }
      },
    };
    const getRouterMock = vi.fn(() => fakeRouter);
    const fakeApp = {
      on: vi.fn(),
      log: { error: vi.fn(), warn: vi.fn() },
    } as unknown as Probot;
    registerApp(fakeApp, { getRouter: getRouterMock as unknown as (path?: string) => never });
    expect(getHandler).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- res is a minimal fake, not a real Express Response.
    return { getHandler: getHandler! as any, getRouterMock };
  }

  it("mounts the router at /dashboard", () => {
    const { getRouterMock } = registerFakeAppWithRouter();
    expect(getRouterMock).toHaveBeenCalledWith("/dashboard");
  });

  it("renders the dashboard page with a 200 and HTML content type on success", async () => {
    fetchDashboardMetricsMock.mockClear();
    renderDashboardPageMock.mockClear();
    const { getHandler } = registerFakeAppWithRouter();
    const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };

    await getHandler({}, res);

    expect(fetchDashboardMetricsMock).toHaveBeenCalledTimes(1);
    expect(renderDashboardPageMock).toHaveBeenCalledTimes(1);
    expect(res.set).toHaveBeenCalledWith(DASHBOARD_SECURITY_HEADERS);
    expect(res.set).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
    expect(res.send).toHaveBeenCalledWith("<html>fake dashboard</html>");
    expect(res.status).not.toHaveBeenCalled();
  });

  it("responds 500 without throwing when fetchDashboardMetrics rejects", async () => {
    fetchDashboardMetricsMock.mockRejectedValueOnce(new Error("db down"));
    const { getHandler } = registerFakeAppWithRouter();
    const res = { set: vi.fn().mockReturnThis(), status: vi.fn().mockReturnThis(), send: vi.fn() };

    await expect(getHandler({}, res)).resolves.toBeUndefined();

    expect(res.set).toHaveBeenCalledWith(DASHBOARD_SECURITY_HEADERS);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith("Failed to load dashboard");
  });

  it("does not throw when getRouter is not provided (e.g. a bare test harness)", () => {
    const fakeApp = { on: vi.fn(), log: { error: vi.fn(), warn: vi.fn() } } as unknown as Probot;
    expect(() => registerApp(fakeApp)).not.toThrow();
  });
});
