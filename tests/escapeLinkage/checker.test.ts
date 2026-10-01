import { describe, expect, it, vi } from "vitest";
import type { DetectionContext } from "../../src/index";

const upsertEscapeRecordMock = vi.fn(async () => undefined);
vi.mock("../../src/escapeLinkage/store", () => ({
  upsertEscapeRecord: upsertEscapeRecordMock,
}));

const { checkEscapeLinkageOnMerge, checkEscapeLinkageOnNewIssue } = await import("../../src/escapeLinkage/checker");

interface MockOptions {
  configYaml?: string;
  configThrows?: unknown;
  files?: Array<{ filename: string; status: string; patch?: string }>;
  blameRanges?: Array<{ startingLine: number; endingLine: number; oid: string }>;
  prsForOid?: Record<string, Array<{ number: number; merged_at: string | null }>>;
  mergedPrs?: Array<{ number: number; merged_at: string | null }>;
  filesByPr?: Record<number, string[]>;
}

function makeContext(options: MockOptions): DetectionContext {
  const octokit = {
    repos: {
      getContent: vi.fn(async () => {
        if (options.configThrows !== undefined) {
          throw options.configThrows;
        }
        if (options.configYaml === undefined) {
          throw { status: 404 };
        }
        return { data: { content: Buffer.from(options.configYaml).toString("base64"), encoding: "base64" } };
      }),
      listPullRequestsAssociatedWithCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
        data: options.prsForOid?.[commit_sha] ?? [],
      })),
    },
    pulls: {
      listFiles: vi.fn(async ({ pull_number }: { pull_number?: number }) => {
        if (pull_number !== undefined && options.filesByPr) {
          return { data: (options.filesByPr[pull_number] ?? []).map((filename) => ({ filename })) };
        }
        return { data: options.files ?? [] };
      }),
      list: vi.fn(async () => ({ data: options.mergedPrs ?? [] })),
    },
    graphql: vi.fn(async () => ({
      repository: {
        object: {
          blame: {
            ranges: (options.blameRanges ?? []).map((r) => ({
              startingLine: r.startingLine,
              endingLine: r.endingLine,
              commit: { oid: r.oid },
            })),
          },
        },
      },
    })),
  };

  return {
    repo: () => ({ owner: "acme", repo: "widgets" }),
    payload: { pull_request: { number: 1, head: { ref: "x", sha: "x" }, base: { ref: "main", sha: "basesha" }, body: null } },
    octokit,
    log: { warn: vi.fn(), error: vi.fn() },
  } as unknown as DetectionContext;
}

describe("checkEscapeLinkageOnMerge", () => {
  it("does nothing when escapeLinkage is not enabled (default)", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({});
    await checkEscapeLinkageOnMerge(context, { number: 10, body: "Fixes #1", base: { sha: "basesha" } });
    expect(upsertEscapeRecordMock).not.toHaveBeenCalled();
  });

  it("upserts a commit-linked escape record when enabled and a fix is resolved", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({
      configYaml: "escapeLinkage:\n  enabled: true\n",
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: { abc123: [{ number: 55, merged_at: "2026-01-01T00:00:00Z" }] },
    });

    await checkEscapeLinkageOnMerge(context, { number: 10, body: "Fixes #1", base: { sha: "basesha" } });

    expect(upsertEscapeRecordMock).toHaveBeenCalledWith({
      repo: "acme/widgets",
      issueNumber: 1,
      sourcePrId: 55,
      detectionMethod: "commit-linked",
    });
  });

  it("does not throw and logs a warning when config load fails operationally", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({ configThrows: { status: 403, message: "rate limited" } });
    await expect(
      checkEscapeLinkageOnMerge(context, { number: 10, body: "Fixes #1", base: { sha: "basesha" } })
    ).resolves.toBeUndefined();
    expect(upsertEscapeRecordMock).not.toHaveBeenCalled();
    expect(context.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ status: 403 }) }),
      expect.stringContaining("escapeLinkage config load failed")
    );
  });

  it("does not throw when detection itself fails", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({ configYaml: "escapeLinkage:\n  enabled: true\n" });
    context.octokit.pulls.listFiles = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      checkEscapeLinkageOnMerge(context, { number: 10, body: "Fixes #1", base: { sha: "basesha" } })
    ).resolves.toBeUndefined();
  });
});

describe("checkEscapeLinkageOnNewIssue", () => {
  it("does nothing when escapeLinkage is not enabled (default)", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({});
    await checkEscapeLinkageOnNewIssue(context, { number: 1, body: "Escape-Source: #5", createdAt: "2026-01-01T00:00:00Z" });
    expect(upsertEscapeRecordMock).not.toHaveBeenCalled();
  });

  it("upserts a manual override when present, without calling the heuristic detector", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({ configYaml: "escapeLinkage:\n  enabled: true\n" });

    await checkEscapeLinkageOnNewIssue(context, {
      number: 1,
      body: "Escape-Source: #5",
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(upsertEscapeRecordMock).toHaveBeenCalledWith({
      repo: "acme/widgets",
      issueNumber: 1,
      sourcePrId: 5,
      detectionMethod: "manual",
    });
    expect(context.octokit.pulls.list).not.toHaveBeenCalled();
  });

  it("falls back to the heuristic detector when no manual override is present", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({
      configYaml: "escapeLinkage:\n  enabled: true\n  timeWindowDays: 14\n",
      mergedPrs: [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }],
      filesByPr: { 10: ["src/foo.ts"] },
    });

    await checkEscapeLinkageOnNewIssue(context, {
      number: 2,
      body: "Broken in src/foo.ts",
      createdAt: "2026-01-15T00:00:00Z",
    });

    expect(upsertEscapeRecordMock).toHaveBeenCalledWith({
      repo: "acme/widgets",
      issueNumber: 2,
      sourcePrId: 10,
      detectionMethod: "time-window-heuristic",
    });
  });

  it("does not upsert anything when neither manual nor heuristic detection finds a match", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({ configYaml: "escapeLinkage:\n  enabled: true\n" });

    await checkEscapeLinkageOnNewIssue(context, {
      number: 3,
      body: "No path mentioned here.",
      createdAt: "2026-01-15T00:00:00Z",
    });

    expect(upsertEscapeRecordMock).not.toHaveBeenCalled();
  });

  it("does not throw when detection itself fails", async () => {
    upsertEscapeRecordMock.mockClear();
    const context = makeContext({
      configYaml: "escapeLinkage:\n  enabled: true\n",
      mergedPrs: [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }],
    });
    context.octokit.pulls.list = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(
      checkEscapeLinkageOnNewIssue(context, { number: 3, body: "Broken in src/foo.ts", createdAt: "2026-01-15T00:00:00Z" })
    ).resolves.toBeUndefined();
  });
});
