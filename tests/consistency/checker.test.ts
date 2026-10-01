import { describe, expect, it, vi } from "vitest";
import type { DetectionContext } from "../../src/index";
import { checkConsistency, checkConsistencySummary } from "../../src/consistency/checker";
import type { AuthorshipResult } from "../../src/detectors/confidence";

const definiteResult: AuthorshipResult = { confidence: "definite", reasons: ["test"], matchedTrailer: "Claude Code" };
const noneResult: AuthorshipResult = { confidence: "none", reasons: [] };

interface MockOptions {
  configYaml?: string;
  configThrows?: unknown;
  changedFiles?: Array<{ filename: string; status: string; changes?: number; previous_filename?: string }>;
  directoryListing?: unknown;
  fileContents?: Record<string, string>;
  // Per-path artificial delay (ms), for exercising wall-clock-budget
  // behavior with vi.useFakeTimers()/advanceTimersByTimeAsync — each delay
  // stays under the per-call EXTERNAL_CALL_TIMEOUT_MS (3000ms) so it never
  // trips that timeout on its own, only accumulates against the shared
  // per-PR WALL_CLOCK_BUDGET_MS across multiple calls.
  delays?: Record<string, number>;
}

function delayThen<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function makeContext(options: MockOptions): DetectionContext {
  const fileContents = options.fileContents ?? {};

  const octokit = {
    repos: {
      getContent: vi.fn(async (params: { path: string }) => {
        const delayMs = options.delays?.[params.path];
        if (delayMs !== undefined) {
          await delayThen(delayMs, undefined);
        }
        if (params.path === ".reviewgate.yml") {
          if (options.configThrows !== undefined) {
            throw options.configThrows;
          }
          if (options.configYaml === undefined) {
            throw { status: 404 };
          }
          return { data: { content: Buffer.from(options.configYaml).toString("base64"), encoding: "base64" } };
        }
        if (fileContents[params.path] !== undefined) {
          return { data: { content: Buffer.from(fileContents[params.path]).toString("base64"), encoding: "base64" } };
        }
        return { data: options.directoryListing ?? [] };
      }),
    },
    pulls: {
      listFiles: vi.fn(async () => ({
        data: (options.changedFiles ?? []).map((file) => ({ changes: 1, ...file })),
      })),
    },
    paginate: vi.fn(async (fn: (...args: unknown[]) => Promise<{ data: unknown }>, params: unknown) => {
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

function siblingEntry(path: string, size = 100) {
  return { name: path.split("/").pop()!, path, type: "file", size };
}

describe("checkConsistency", () => {
  it("returns undefined when consistencyCheck is not enabled (default)", async () => {
    const context = makeContext({ changedFiles: [{ filename: "src/foo.ts", status: "modified" }] });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toBeUndefined();
    // Must short-circuit before even listing changed files.
    expect((context.octokit.pulls.listFiles as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("returns undefined when scope is ai-only (default) and confidence is none", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
    });

    const result = await checkConsistency(context, noneResult);

    expect(result).toBeUndefined();
  });

  it("runs when scope is ai-only and confidence is definite/likely", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [siblingEntry("src/a.ts"), siblingEntry("src/b.ts"), siblingEntry("src/c.ts")],
      fileContents: {
        "src/a.ts": "const fooBar = 1;",
        "src/b.ts": "const bazQux = 2;",
        "src/c.ts": "const oneVal = 3;",
        "src/foo.ts": "const snake_named = 4;",
      },
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toBeDefined();
  });

  it("runs regardless of confidence when scope is all", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n  scope: all\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [siblingEntry("src/a.ts"), siblingEntry("src/b.ts"), siblingEntry("src/c.ts")],
      fileContents: {
        "src/a.ts": "const fooBar = 1;",
        "src/b.ts": "const bazQux = 2;",
        "src/c.ts": "const oneVal = 3;",
        "src/foo.ts": "const snake_named = 4;",
      },
    });

    const result = await checkConsistency(context, noneResult);

    expect(result).toBeDefined();
  });

  it("skips removed files and non-TS/JS files", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [
        { filename: "src/removed.ts", status: "removed" },
        { filename: "README.md", status: "modified" },
      ],
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toEqual({ namingFindings: [], errorHandlingFindings: [] });
  });

  // Regression test (code-review pass): a pure rename (git mv, no content
  // edit) reports status "renamed" with changes: 0 — must not be compared
  // against a sibling baseline at all, since nothing about the file's own
  // content actually changed in this PR.
  it("skips a pure rename with no content changes", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/lib/foo.ts", status: "renamed", changes: 0 }],
      directoryListing: [
        siblingEntry("src/lib/a.ts"),
        siblingEntry("src/lib/b.ts"),
        siblingEntry("src/lib/c.ts"),
        siblingEntry("src/lib/d.ts"),
        siblingEntry("src/lib/e.ts"),
      ],
      fileContents: {
        "src/lib/a.ts": "const camelOne = 1;",
        "src/lib/b.ts": "const camelTwo = 1;",
        "src/lib/c.ts": "const camelThree = 1;",
        "src/lib/d.ts": "const camelFour = 1;",
        "src/lib/e.ts": "const camelFive = 1;",
        // Deviates from the baseline's camelCase convention — if this
        // renamed-but-unmodified file were compared anyway, it would
        // produce a naming finding, which is exactly what must NOT happen.
        "src/lib/foo.ts": "const snake_named = 4;",
      },
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toEqual({ namingFindings: [], errorHandlingFindings: [] });
  });

  it("produces naming findings for a deviating diff file with a sufficient baseline", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [
        siblingEntry("src/a.ts"),
        siblingEntry("src/b.ts"),
        siblingEntry("src/c.ts"),
        siblingEntry("src/d.ts"),
        siblingEntry("src/e.ts"),
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

    const result = await checkConsistency(context, definiteResult);

    expect(result?.namingFindings).toHaveLength(1);
    expect(result?.namingFindings[0].identifierName).toBe("snake_named");
  });

  it("skips a diff file with an insufficient sibling sample (no findings, no crash)", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
      directoryListing: [siblingEntry("src/a.ts")],
      fileContents: { "src/a.ts": "const x = 1;", "src/foo.ts": "const snake_named = 4;" },
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toEqual({ namingFindings: [], errorHandlingFindings: [] });
  });

  it("falls back to disabled when .reviewgate.yml is malformed (fail-closed, BR-5)", async () => {
    const context = makeContext({
      configYaml: ":::not valid yaml:::[",
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toBeUndefined();
  });

  // Regression test (code-review pass): an operational config-load
  // failure (not "missing file") must be logged, not silently swallowed
  // — mirrors evaluateAuthorship's degrade-gracefully-but-log behavior in
  // src/index.ts for the same underlying loadConfig failure mode.
  it("logs a warning when .reviewgate.yml fails to load for an operational reason", async () => {
    const context = makeContext({
      configThrows: { status: 403, message: "rate limited" },
      changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
    });

    const result = await checkConsistency(context, definiteResult);

    expect(result).toBeUndefined();
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }) }),
      expect.stringContaining("consistencyCheck config load failed")
    );
  });

  // Regression test (code-review pass, BR-6): the diff file's own content
  // fetch had no deadline check before it — only the sibling-fetch batch
  // (inside resolveSiblingBaseline) and the top-of-loop check did. Here the
  // directory listing (2900ms) and the sibling-content batch (another
  // 2900ms, concurrent) each individually stay under the 3000ms per-call
  // timeout, but together exceed the 5000ms per-PR budget by the time
  // resolveSiblingBaseline returns — a realistic "two individually-fine
  // stages, not a hang" scenario, not a contrived one. The diff file's own
  // content must never be fetched once that combined time is already spent,
  // and the budget-exceeded warning must fire.
  it("does not fetch the diff file's own content once the budget was already spent resolving its baseline", async () => {
    vi.useFakeTimers();
    try {
      const context = makeContext({
        configYaml: "consistencyCheck:\n  enabled: true\n",
        changedFiles: [{ filename: "src/foo.ts", status: "modified" }],
        directoryListing: [siblingEntry("src/a.ts"), siblingEntry("src/b.ts"), siblingEntry("src/c.ts")],
        fileContents: {
          "src/a.ts": "const camelOne = 1;",
          "src/b.ts": "const camelTwo = 1;",
          "src/c.ts": "const camelThree = 1;",
          "src/foo.ts": "const snake_named = 4;",
        },
        delays: {
          src: 2900,
          "src/a.ts": 2900,
          "src/b.ts": 2900,
          "src/c.ts": 2900,
        },
      });

      const resultPromise = checkConsistency(context, definiteResult);
      await vi.advanceTimersByTimeAsync(6000);
      const result = await resultPromise;

      expect(result).toEqual({ namingFindings: [], errorHandlingFindings: [] });
      const calledPaths = (context.octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.map(
        (call) => (call[0] as { path: string }).path
      );
      expect(calledPaths).not.toContain("src/foo.ts");
      expect(context.log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ prId: 42 }),
        expect.stringContaining("exceeded its per-PR time budget")
      );
    } finally {
      vi.useRealTimers();
    }
  });

  // Regression test (code-review pass, BR-1): a renamed file's OLD path
  // must also be excluded from another checked file's sibling baseline,
  // not just its new path — resolveSiblingBaseline lists the directory at
  // the PR's base ref, where the old path is still present. Asserted
  // directly on whether the old path's content was ever fetched as a
  // sibling, rather than on a downstream naming finding — naming.ts has
  // its own separate MIN_SAMPLE_SIZE (5) dominance gate distinct from
  // baseline.ts's MIN_SIBLING_FILES (3), so a 3-candidate baseline never
  // produces a naming finding either way and wouldn't discriminate here.
  it("excludes a renamed file's old path from another file's sibling baseline", async () => {
    const context = makeContext({
      configYaml: "consistencyCheck:\n  enabled: true\n",
      changedFiles: [
        { filename: "src/foo/target.ts", status: "modified" },
        { filename: "src/bar/other-touched.ts", status: "renamed", changes: 0, previous_filename: "src/foo/other-touched.ts" },
      ],
      directoryListing: [
        siblingEntry("src/foo/a.ts"),
        siblingEntry("src/foo/b.ts"),
        siblingEntry("src/foo/other-touched.ts"),
        siblingEntry("src/foo/target.ts"),
      ],
      fileContents: {
        "src/foo/a.ts": "const camelOne = 1;",
        "src/foo/b.ts": "const camelTwo = 1;",
        "src/foo/other-touched.ts": "const camelThree = 1;",
        "src/foo/target.ts": "const snake_named = 4;",
      },
    });

    await checkConsistency(context, definiteResult);

    const calledPaths = (context.octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(calledPaths).not.toContain("src/foo/other-touched.ts");
  });
});

describe("checkConsistencySummary", () => {
  it("returns an empty string for an undefined result (disabled/out-of-scope)", () => {
    expect(checkConsistencySummary(undefined)).toBe("");
  });

  it("returns an empty string for a defined result with zero findings", () => {
    expect(checkConsistencySummary({ namingFindings: [], errorHandlingFindings: [] })).toBe("");
  });

  it("renders a Consistency section with both finding types", () => {
    const summary = checkConsistencySummary({
      namingFindings: [
        { file: "src/foo.ts", identifierName: "snake_named", identifierKind: "variable", expectedConvention: "camelCase" },
      ],
      errorHandlingFindings: [{ file: "src/bar.ts", location: "line 10" }],
    });

    expect(summary).toContain("**Consistency**:");
    expect(summary).toContain("snake_named");
    expect(summary).toContain("camelCase");
    expect(summary).toContain("src/bar.ts");
    expect(summary).toContain("line 10");
  });
});
