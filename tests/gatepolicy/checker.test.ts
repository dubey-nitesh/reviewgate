import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetectionContext } from "../../src/index";
import { checkGatePolicy, computeComplexityFindings, gatePolicySummary } from "../../src/gatepolicy/checker";
import type { AuthorshipResult } from "../../src/detectors/confidence";

const definiteResult: AuthorshipResult = { confidence: "definite", reasons: ["test"], matchedTrailer: "Claude Code" };
const noneResult: AuthorshipResult = { confidence: "none", reasons: [] };

interface MockOptions {
  configYaml?: string;
  configThrows?: unknown;
  changedFiles?: Array<{ filename: string; status: string; changes?: number; additions?: number; deletions?: number }>;
  fileContents?: Record<string, string>;
  checkRuns?: Array<{ name: string; output?: { summary?: string | null } }>;
  listFilesHangs?: boolean;
  listFilesThrows?: unknown;
  listFilesDelayMs?: number;
  configDelayMs?: number;
  checkRunsDelayMs?: number;
  fileContentHangs?: boolean;
  fileContentThrows?: unknown;
}

function makeContext(options: MockOptions): DetectionContext {
  const fileContents = options.fileContents ?? {};

  const octokit = {
    repos: {
      getContent: vi.fn(async (params: { path: string }) => {
        if (params.path === ".reviewgate.yml") {
          if (options.configDelayMs !== undefined) {
            await new Promise((resolve) => setTimeout(resolve, options.configDelayMs));
          }
          if (options.configThrows !== undefined) {
            throw options.configThrows;
          }
          if (options.configYaml === undefined) {
            throw { status: 404 };
          }
          return { data: { content: Buffer.from(options.configYaml).toString("base64"), encoding: "base64" } };
        }
        if (options.fileContentHangs) {
          return new Promise(() => {});
        }
        if (options.fileContentThrows !== undefined) {
          throw options.fileContentThrows;
        }
        if (fileContents[params.path] !== undefined) {
          return { data: { content: Buffer.from(fileContents[params.path]).toString("base64"), encoding: "base64" } };
        }
        return { data: [] };
      }),
    },
    checks: {
      listForRef: vi.fn(async () => {
        if (options.checkRunsDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.checkRunsDelayMs));
        }
        return { data: { check_runs: options.checkRuns ?? [] } };
      }),
    },
    pulls: {
      listFiles: vi.fn(async () => ({
        data: (options.changedFiles ?? []).map((file) => ({ changes: 1, additions: 1, deletions: 0, ...file })),
      })),
    },
    paginate: vi.fn(async (fn: (...args: unknown[]) => Promise<{ data: unknown }>, params: unknown) => {
      if (options.listFilesHangs) {
        return new Promise(() => {});
      }
      if (options.listFilesThrows !== undefined) {
        throw options.listFilesThrows;
      }
      if (options.listFilesDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.listFilesDelayMs));
      }
      const response = await fn(params);
      return response.data as unknown[];
    }),
  };

  return {
    repo: () => ({ owner: "acme", repo: "widgets" }),
    payload: {
      pull_request: {
        number: 42,
        head: { ref: "feature/x", sha: "headsha" },
        base: { ref: "main", sha: "basesha" },
        body: null,
      },
    },
    octokit,
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as DetectionContext;
}

const enabledConfig = "gatePolicy:\n  enabled: true\n";

describe("checkGatePolicy", () => {
  it("returns undefined when gatePolicy is not enabled (default)", async () => {
    const context = makeContext({ changedFiles: [{ filename: "src/foo.ts", status: "modified" }] });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result).toBeUndefined();
  });

  it("returns undefined when scope is ai-only and confidence is none", async () => {
    const context = makeContext({ configYaml: "gatePolicy:\n  enabled: true\n  scope: ai-only\n" });
    const result = await checkGatePolicy(context, noneResult);
    expect(result).toBeUndefined();
  });

  it("runs when scope is all (default) regardless of confidence", async () => {
    const context = makeContext({ configYaml: enabledConfig });
    const result = await checkGatePolicy(context, noneResult);
    expect(result).toBeDefined();
  });

  it("flags a function whose complexity exceeds the configured threshold", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      fileContents: { "src/foo.ts": "function foo(a) { if (a) { return 1; } return 0; }" },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toContainEqual({ file: "src/foo.ts", functionName: "foo", complexity: 2, threshold: 1 });
  });

  it("does not flag a function at or below the threshold", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 10\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      fileContents: { "src/foo.ts": "function foo(a) { if (a) { return 1; } return 0; }" },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toEqual([]);
  });

  it("skips the complexity rule entirely when disabled, even with a highly complex function", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    enabled: false\n    threshold: 1\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      fileContents: { "src/foo.ts": "function foo(a) { if (a) { return 1; } return 0; }" },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toEqual([]);
  });

  it("skips a pure rename with no content changes for the complexity rule", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [{ filename: "src/foo.ts", status: "renamed", changes: 0 }],
      fileContents: { "src/foo.ts": "function foo(a) { if (a) { return 1; } return 0; }" },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toEqual([]);
  });

  // G3: end-to-end through checkGatePolicy (not just the pure
  // extractFunctionComplexities function directly) — exercises the real
  // file-fetch + language-dispatch path for a Python file.
  it("flags a function whose complexity exceeds the configured threshold in a Python file", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [{ filename: "src/foo.py", status: "modified" }],
      fileContents: { "src/foo.py": "def foo(a):\n    if a:\n        return 1\n    return 0\n" },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toContainEqual({
      file: "src/foo.py",
      functionName: "foo",
      complexity: 2,
      threshold: 1,
    });
  });

  // G6 (practical gate-policy concern): a PR touching both a
  // Python and a TS/JS file gets each file dispatched to its own correct
  // language parser — a regression here would show up as either file's
  // functions silently disappearing (wrong parser producing no matches)
  // or a cross-language miscount.
  it("dispatches each file in a mixed TS/JS + Python PR to its own correct language parser", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [
        { filename: "src/foo.ts", status: "modified" },
        { filename: "src/bar.py", status: "modified" },
      ],
      fileContents: {
        "src/foo.ts": "function foo(a) { if (a) { return 1; } return 0; }",
        "src/bar.py": "def bar(a):\n    if a:\n        return 1\n    return 0\n",
      },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toContainEqual({ file: "src/foo.ts", functionName: "foo", complexity: 2, threshold: 1 });
    expect(result?.complexityFindings).toContainEqual({ file: "src/bar.py", functionName: "bar", complexity: 2, threshold: 1 });
  });

  it("flags size/risk when lines-changed OR files-changed exceeds its threshold", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  sizeRisk:\n    linesThreshold: 5\n    filesThreshold: 100\n",
      changedFiles: [
        { filename: "a.ts", status: "modified", additions: 3, deletions: 3 },
        { filename: "b.ts", status: "modified", additions: 1, deletions: 0 },
      ],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.sizeRiskFinding).toEqual({ linesChanged: 7, filesChanged: 2, linesThreshold: 5, filesThreshold: 100 });
  });

  it("does not flag size/risk when both metrics are within threshold", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n",
      changedFiles: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.sizeRiskFinding).toBeUndefined();
  });

  // G4: confirmation, not new behavior — size/risk is pure
  // diff-stat counting with no language coupling, so this test uses
  // Python file paths specifically rather than relying on the existing
  // TS/JS-path tests above to stand in for "it also works for Python."
  it("flags size/risk for a PR that only touches Python files, identically to a TS/JS PR", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  sizeRisk:\n    linesThreshold: 5\n    filesThreshold: 100\n",
      changedFiles: [
        { filename: "a.py", status: "modified", additions: 3, deletions: 3 },
        { filename: "b.py", status: "modified", additions: 1, deletions: 0 },
      ],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.sizeRiskFinding).toEqual({ linesChanged: 7, filesChanged: 2, linesThreshold: 5, filesThreshold: 100 });
  });

  it("flags a coverage finding below the configured minimum, using the configured check-run name", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  coverage:\n    checkRunName: coverage-report\n    minimumPercent: 90\n",
      checkRuns: [{ name: "coverage-report", output: { summary: "coverage: 70%" } }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.coverageFinding).toEqual({ actualPercent: 70, minimumPercent: 90, checkRunName: "coverage-report" });
  });

  // Regression test (found by /code-review): when only the coverage rule
  // is enabled, pulls.listFiles must not be called at all — its result
  // (changedFiles) is only consumed by the complexity and sizeRisk rules.
  it("does not call pulls.listFiles when only the coverage rule is enabled", async () => {
    const context = makeContext({
      configYaml:
        "gatePolicy:\n  enabled: true\n  complexity:\n    enabled: false\n  sizeRisk:\n    enabled: false\n  coverage:\n    checkRunName: coverage-report\n",
      checkRuns: [{ name: "coverage-report", output: { summary: "coverage: 70%" } }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.coverageFinding).toBeDefined();
    expect(context.octokit.pulls.listFiles).not.toHaveBeenCalled();
  });

  // Regression test (found by a fifth /code-review pass, RESILIENCY-10):
  // unlike every other external call in this file, the paginated
  // pulls.listFiles call had no timeout at all — a hanging GitHub API
  // response here would hang checkGatePolicy (and, via index.ts's await,
  // the whole webhook handler) indefinitely. Fails open instead: a
  // timeout yields no changed-files data, so complexity/sizeRisk simply
  // produce no findings for this PR, rather than propagating and wiping
  // the whole GatePolicyResult.
  describe("pulls.listFiles timeout (RESILIENCY-10)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails open instead of hanging forever when pulls.listFiles never resolves", async () => {
      vi.useFakeTimers();
      const context = makeContext({
        configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
        listFilesHangs: true,
      });

      const resultPromise = checkGatePolicy(context, definiteResult);
      await vi.advanceTimersByTimeAsync(5001);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({ complexityFindings: [], shouldBlock: false })
      );
    });
  });

  // Regression test (found by a seventh /code-review pass, BR-7): the
  // documented "5000ms for the whole gate-policy pass" budget was not
  // actually shared across stages — computeComplexityFindings defaulted
  // to a brand-new WALL_CLOCK_BUDGET_MS window computed only after
  // changedFiles already resolved, so a listFiles fetch that legitimately
  // took most of the budget (not a hang — within its own timeout) was
  // followed by a second full budget for the per-file fetch-and-parse
  // work, roughly doubling worst-case latency. Fixed by establishing one
  // `passDeadline` at the start of checkGatePolicy and threading it
  // through both the changedFiles timeout and computeComplexityFindings'
  // deadline parameter.
  describe("shared wall-clock budget across stages (BR-7)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not grant a second full budget window after a slow (not hung) listFiles fetch", async () => {
      vi.useFakeTimers();
      const context = makeContext({
        configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
        changedFiles: [{ filename: "a.ts", status: "modified" }],
        listFilesDelayMs: 4900,
        fileContentHangs: true,
      });

      const resultPromise = checkGatePolicy(context, definiteResult);
      // An eighth /code-review pass found the per-file content fetch
      // still claimed its own fresh EXTERNAL_CALL_TIMEOUT_MS window
      // regardless of how little of the shared budget remained (fixed by
      // capping it to the smaller of the two) — before that fix this
      // resolved only after ~7900ms (4900 + a full fresh 3000ms), not
      // ~5000ms. Advancing by just past the shared budget, rather than a
      // further +6000ms, is itself part of what this regression test now
      // proves: the promise must already be settled by then, not still
      // waiting on a second full per-file timeout window.
      await vi.advanceTimersByTimeAsync(5100);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({ complexityFindings: [], shouldBlock: false })
      );
    });
  });

  // Regression test (code-review pass, BR-7): passDeadline was computed
  // AFTER loadConfig resolved, so the config load's own latency (up to its
  // own ~3000ms timeout) wasn't counted against the shared 5000ms pass
  // budget at all — the exact same "second full budget window" bug the
  // seventh-pass fix above closed for listFiles-vs-complexity, recurring
  // one stage earlier, before passDeadline is even computed once. A
  // ~2900ms config load followed by a ~4900ms (individually-fine)
  // listFiles fetch previously totaled ~7800ms; with passDeadline now
  // established before loadConfig, listFiles's own withTimeout is bounded
  // by whatever's left of the 5000ms budget after the config load, so the
  // whole pass must resolve well before the old ~7800ms figure.
  describe("shared wall-clock budget includes config load itself (BR-7)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not let the config load's own latency escape the shared 5000ms pass budget", async () => {
      vi.useFakeTimers();
      const context = makeContext({
        configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
        configDelayMs: 2900,
        changedFiles: [{ filename: "a.ts", status: "modified" }],
        listFilesDelayMs: 4900,
        fileContentHangs: true,
      });

      const resultPromise = checkGatePolicy(context, definiteResult);
      // Old behavior needed ~2900 (config) + 4900 (listFiles, unbounded by
      // any shared deadline) ≈ 7800ms+ to settle. Advancing by 5200ms —
      // just past the documented budget — must be enough for the fix.
      await vi.advanceTimersByTimeAsync(5200);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({ complexityFindings: [], shouldBlock: false })
      );
      expect(context.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ prId: 42 }),
        expect.stringContaining("pulls.listFiles failed or timed out")
      );
    });
  });

  // Regression test (code-review pass, BR-7): the coverage rule's own
  // checks.listForRef call was the one external call in this file left on
  // a fixed EXTERNAL_CALL_TIMEOUT_MS, unrelated to how much of the shared
  // passDeadline had already been spent on the config load — the same
  // "second full budget window" bug class already closed for
  // changedFiles-vs-complexity and the per-file fetch, just never applied
  // to coverage. A ~2900ms config load followed by a ~2900ms
  // (individually-fine) checks.listForRef call previously totaled
  // ~5800ms; with the remaining-budget timeout threaded through, the
  // whole pass must resolve well before that.
  describe("coverage's own external call respects the shared pass budget (BR-7)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("does not let coverage's checks.listForRef escape the shared 5000ms pass budget", async () => {
      vi.useFakeTimers();
      const context = makeContext({
        configYaml:
          "gatePolicy:\n  enabled: true\n  complexity:\n    enabled: false\n  sizeRisk:\n    enabled: false\n  coverage:\n    checkRunName: coverage-report\n",
        configDelayMs: 2900,
        checkRunsDelayMs: 2900,
        checkRuns: [{ name: "coverage-report", output: { summary: "coverage: 50%" } }],
      });

      const resultPromise = checkGatePolicy(context, definiteResult);
      await vi.advanceTimersByTimeAsync(5200);

      await expect(resultPromise).resolves.toEqual(
        expect.objectContaining({ coverageFinding: undefined, shouldBlock: false })
      );
      expect(context.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ checkRunName: "coverage-report" }),
        expect.stringContaining("checks.listForRef failed or timed out")
      );
    });
  });

  // Regression test (found by a sixth /code-review pass): a rejecting (as
  // opposed to hanging) pulls.listFiles call previously failed open
  // silently — no log line distinguished "this feature is broken" (e.g. a
  // permission error, a persistent 5xx, a rate limit) from "this PR
  // genuinely has no risk findings." Every other failure path in this
  // file (loadConfig's catch) already logs a warning; this call now does
  // too.
  it("logs a warning (not silently) when pulls.listFiles rejects", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      listFilesThrows: { status: 403, message: "forbidden" },
    });

    const result = await checkGatePolicy(context, definiteResult);

    expect(result?.complexityFindings).toEqual([]);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }) }),
      expect.stringContaining("pulls.listFiles failed or timed out")
    );
  });

  // Regression test (found by a ninth /code-review pass): a rejecting
  // repos.getContent call for a changed file's own content (as opposed to
  // pulls.listFiles or .reviewgate.yml, both already fixed in earlier
  // rounds) also failed open silently — the same operational blind spot,
  // just one call deeper and up to MAX_DIFF_FILES times more likely to
  // matter per PR.
  it("logs a warning (not silently) when a per-file content fetch rejects", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [{ filename: "a.ts", status: "modified" }],
      fileContentThrows: { status: 403, message: "forbidden" },
    });

    const result = await checkGatePolicy(context, definiteResult);

    expect(result?.complexityFindings).toEqual([]);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }), file: "a.ts" }),
      expect.stringContaining("per-file content fetch failed or timed out")
    );
  });

  // Regression test (found by the same pass): coverage's own independent
  // checks.listForRef call must not wait for the changedFiles fetch to
  // complete first, since coverage doesn't consume changedFiles at all —
  // both should be in flight concurrently. Exercised by making
  // pulls.listFiles hang indefinitely (via fake timers) while asserting
  // checks.listForRef is still called and still contributes its finding —
  // if the two were still serialized, checks.listForRef would never even
  // be invoked before the surrounding checkGatePolicy call's own
  // WALL_CLOCK_BUDGET_MS-driven resolution, since pulls.listFiles never
  // resolves on its own in this test.
  it("still runs the coverage check-run lookup concurrently while pulls.listFiles is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const context = makeContext({
        configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n  coverage:\n    checkRunName: coverage-report\n",
        listFilesHangs: true,
        checkRuns: [{ name: "coverage-report", output: { summary: "coverage: 50%" } }],
      });

      const resultPromise = checkGatePolicy(context, definiteResult);
      await vi.advanceTimersByTimeAsync(5001);

      const result = await resultPromise;
      expect(context.octokit.checks.listForRef).toHaveBeenCalled();
      expect(result?.coverageFinding).toEqual({ actualPercent: 50, minimumPercent: 80, checkRunName: "coverage-report" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("produces no coverage finding when checkRunName is unconfigured (documented no-op, not an error)", async () => {
    const context = makeContext({ configYaml: "gatePolicy:\n  enabled: true\n" });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.coverageFinding).toBeUndefined();
    expect(context.octokit.checks.listForRef).not.toHaveBeenCalled();
  });

  it("shouldBlock is true when blocking is enabled and a rule fails", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  blocking: true\n  sizeRisk:\n    linesThreshold: 0\n",
      changedFiles: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.shouldBlock).toBe(true);
  });

  it("shouldBlock is false when blocking is disabled (default), even when a rule fails", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  sizeRisk:\n    linesThreshold: 0\n",
      changedFiles: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.sizeRiskFinding).toBeDefined();
    expect(result?.shouldBlock).toBe(false);
  });

  it("shouldBlock is false when blocking is enabled but no rule fails", async () => {
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  blocking: true\n",
      changedFiles: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 0 }],
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.shouldBlock).toBe(false);
  });

  it("treats a config-load failure as disabled and logs a warning", async () => {
    const context = makeContext({ configThrows: { status: 403, message: "rate limited" } });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result).toBeUndefined();
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }) }),
      expect.stringContaining("gatePolicy config load failed")
    );
  });

  // Regression test (found by /code-review, the exact production risk
  // that motivated extractFunctionComplexities' own fail-open fix): one
  // file whose content can't be meaningfully parsed (here, pathologically
  // deep block nesting that makes tree-sitter's own parser.parse() throw
  // — same construct as complexity.test.ts's "pathologically deep
  // nesting" test) must not wipe out complexity findings already computed
  // for other files in the same PR — the whole point of BR-1's
  // per-function fail-open contract is that it's scoped to the one
  // problematic file, not the whole PR. This is an orchestrator-level
  // property (checkGatePolicy must isolate one file's failure from
  // others) that holds regardless of which specific internal failure mode
  // (parser.parse() throwing, or the JS walk overflowing — see
  // complexity.test.ts for why the latter isn't independently covered by
  // a committed test) actually fires for a given pathological input.
  it("still reports findings from other files when one file's content can't be meaningfully parsed", async () => {
    const depth = 6000;
    const pathologicalContent = "function bad() {\n" + "if (a) {\n".repeat(depth) + "return 1;\n" + "}\n".repeat(depth) + "}\n";
    const context = makeContext({
      configYaml: "gatePolicy:\n  enabled: true\n  complexity:\n    threshold: 1\n",
      changedFiles: [
        { filename: "src/bad.ts", status: "modified" },
        { filename: "src/good.ts", status: "modified" },
      ],
      fileContents: {
        "src/bad.ts": pathologicalContent,
        "src/good.ts": "function foo(a) { if (a) { return 1; } return 0; }",
      },
    });
    const result = await checkGatePolicy(context, definiteResult);
    expect(result?.complexityFindings).toContainEqual({
      file: "src/good.ts",
      functionName: "foo",
      complexity: 2,
      threshold: 1,
    });
  });
});

// Regression test (found by /code-review, verified directly first): the
// per-PR wall-clock deadline was previously computed and checked back to
// back with no intervening work, so `Date.now() > deadline` could never
// actually be true — the whole budget check was dead code. Exercised
// directly here (mirroring src/consistency/baseline.ts's
// resolveSiblingBaseline test for the identical class of fix) via the
// injectable `deadline` parameter, rather than only indirectly through
// real elapsed wall-clock time.
describe("computeComplexityFindings", () => {
  it("stops processing further files once an already-past deadline is reached, keeping findings collected so far", async () => {
    const context = makeContext({
      fileContents: {
        "src/a.ts": "function a(x) { if (x) { return 1; } return 0; }",
        "src/b.ts": "function b(x) { if (x) { return 1; } return 0; }",
      },
    });
    const changedFiles = [
      { filename: "src/a.ts", status: "modified", changes: 1, additions: 1, deletions: 0 },
      { filename: "src/b.ts", status: "modified", changes: 1, additions: 1, deletions: 0 },
    ];

    const alreadyPastDeadline = Date.now() - 1;
    const findings = await computeComplexityFindings(
      context,
      "acme",
      "widgets",
      { number: 42, head: { sha: "headsha" } },
      changedFiles,
      { enabled: true, threshold: 1 },
      alreadyPastDeadline
    );

    expect(findings).toEqual([]);
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prId: 42, repo: "acme/widgets" }),
      expect.stringContaining("exceeded its per-PR time budget")
    );
  });
});

describe("gatePolicySummary", () => {
  it("returns an empty string for undefined", () => {
    expect(gatePolicySummary(undefined)).toBe("");
  });

  it("returns an empty string when there are no findings", () => {
    expect(gatePolicySummary({ complexityFindings: [], shouldBlock: false })).toBe("");
  });

  it("renders each finding type and a blocking notice when shouldBlock is true", () => {
    const summary = gatePolicySummary({
      complexityFindings: [{ file: "a.ts", functionName: "foo", complexity: 12, threshold: 10 }],
      sizeRiskFinding: { linesChanged: 600, filesChanged: 25, linesThreshold: 500, filesThreshold: 20 },
      coverageFinding: { actualPercent: 70, minimumPercent: 80, checkRunName: "coverage-report" },
      shouldBlock: true,
    });
    expect(summary).toContain("**Gate Policy**:");
    expect(summary).toContain("foo");
    expect(summary).toContain("600 lines");
    expect(summary).toContain("70%");
    expect(summary).toContain("blocked from merging");
  });

  it("does not render a blocking notice when shouldBlock is false", () => {
    const summary = gatePolicySummary({
      complexityFindings: [{ file: "a.ts", functionName: "foo", complexity: 12, threshold: 10 }],
      shouldBlock: false,
    });
    expect(summary).not.toContain("blocked from merging");
  });

  // Regression test (found by an eighth /code-review pass, verified
  // directly): a complexity finding's functionName can come from a
  // computed object-literal key or a string-literal key containing a
  // literal backtick (complexity.ts's `pair` handling) — raw,
  // attacker-influenced source text with no character restrictions. A
  // backtick embedded unescaped in this function's own backtick code
  // spans would close the span early, letting arbitrary markdown from the
  // PR's diff render live inside reviewgate's own trusted check-run/PR
  // comment output. Sanitized at this render boundary; also strips
  // newlines, which a JS string literal can contain via line-continuation.
  it("neutralizes backticks and newlines in file/function names so they cannot break out of their code span", () => {
    const summary = gatePolicySummary({
      complexityFindings: [
        { file: "a.ts", functionName: "a`)) **INJECTED**\nrogue line", complexity: 12, threshold: 10 },
      ],
      shouldBlock: false,
    });
    // The whole finding — including "rogue line", which the embedded
    // newline would otherwise have pushed onto its own markdown line —
    // must stay on the single "- `a.ts`: ..." bullet line, not spill onto
    // a separate line the injected content controls.
    const lines = summary.split("\n");
    expect(lines).toHaveLength(2); // "**Gate Policy**:" + one finding bullet
    const findingLine = lines[1];
    expect(findingLine).toMatch(/^- `a\.ts`: `[^`]*` has complexity/);
    expect(findingLine).not.toContain("`))");
    expect(findingLine).toContain("a')) **INJECTED**'rogue line");
  });
});
