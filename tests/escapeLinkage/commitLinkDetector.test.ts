import { describe, expect, it, vi } from "vitest";
import {
  detectCommitLinkedEscapes,
  extractClosingKeywordIssueRefs,
  removedLineRanges,
  type OctokitLike,
} from "../../src/escapeLinkage/commitLinkDetector";

describe("extractClosingKeywordIssueRefs", () => {
  it.each([
    ["Fixes #123", [123]],
    ["fixes #123", [123]],
    ["Closes #7", [7]],
    ["Resolved #99", [99]],
    ["fix: #5", [5]],
  ])("matches %s", (body, expected) => {
    expect(extractClosingKeywordIssueRefs(body)).toEqual(expected);
  });

  it("matches multiple distinct issue references", () => {
    expect(extractClosingKeywordIssueRefs("Fixes #1 and closes #2")).toEqual([1, 2]);
  });

  it("deduplicates the same issue referenced twice", () => {
    expect(extractClosingKeywordIssueRefs("Fixes #1. Also fixes #1 again.")).toEqual([1]);
  });

  it("returns empty for a body with no closing keyword", () => {
    expect(extractClosingKeywordIssueRefs("See #123 for context.")).toEqual([]);
  });

  it("returns empty for null/empty body", () => {
    expect(extractClosingKeywordIssueRefs(null)).toEqual([]);
    expect(extractClosingKeywordIssueRefs("")).toEqual([]);
  });

  // Regression-shaped: a word that merely contains a keyword as a
  // substring (e.g. "prefix es #1") must not match — \b word boundaries
  // guard this.
  it("does not match a keyword embedded inside another word", () => {
    expect(extractClosingKeywordIssueRefs("prefixes #1")).toEqual([]);
  });
});

describe("removedLineRanges", () => {
  it("parses a single hunk header with an explicit old-line count", () => {
    const patch = "@@ -10,5 +10,3 @@ some context\n-removed\n-removed\n context";
    expect(removedLineRanges(patch)).toEqual([{ start: 10, end: 14 }]);
  });

  it("defaults the old-line count to 1 when omitted", () => {
    const patch = "@@ -10 +10,2 @@\n-removed\n+added\n+added";
    expect(removedLineRanges(patch)).toEqual([{ start: 10, end: 10 }]);
  });

  it("parses multiple hunks in one patch", () => {
    const patch = "@@ -1,2 +1,2 @@\n-a\n+b\n@@ -50,3 +49,1 @@\n-c\n-d\n-e\n+f";
    expect(removedLineRanges(patch)).toEqual([
      { start: 1, end: 2 },
      { start: 50, end: 52 },
    ]);
  });

  // A pure-addition hunk (0 old lines) contributes nothing — there's no
  // pre-existing line to blame.
  it("skips a pure-addition hunk (old-line count of 0)", () => {
    const patch = "@@ -10,0 +11,3 @@\n+added\n+added\n+added";
    expect(removedLineRanges(patch)).toEqual([]);
  });

  it("returns an empty array for a patch with no hunk headers", () => {
    expect(removedLineRanges("")).toEqual([]);
  });
});

describe("detectCommitLinkedEscapes", () => {
  function makeOctokit(options: {
    files?: Array<{ filename: string; status: string; patch?: string }>;
    blameRanges?: Array<{ startingLine: number; endingLine: number; oid: string }>;
    prsForOid?: Record<string, Array<{ number: number; merged_at: string | null }>>;
    listFilesThrows?: unknown;
    listCommitsThrows?: unknown;
    graphqlThrows?: unknown;
    commitMessages?: string[];
  }): OctokitLike {
    return {
      pulls: {
        listFiles: vi.fn(async () => {
          if (options.listFilesThrows !== undefined) {
            throw options.listFilesThrows;
          }
          return { data: options.files ?? [] };
        }),
        listCommits: vi.fn(async () => {
          if (options.listCommitsThrows !== undefined) {
            throw options.listCommitsThrows;
          }
          return { data: (options.commitMessages ?? []).map((message) => ({ commit: { message } })) };
        }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn(async ({ commit_sha }: { commit_sha: string }) => ({
          data: options.prsForOid?.[commit_sha] ?? [],
        })),
      },
      graphql: vi.fn(async () => {
        if (options.graphqlThrows !== undefined) {
          throw options.graphqlThrows;
        }
        return {
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
        };
      }),
    };
  }

  const mergedPr = { number: 100, body: "Fixes #42", base: { sha: "basesha" } };

  it("returns empty when neither PR body nor commit messages have a closing-keyword reference", async () => {
    const octokit = makeOctokit({ commitMessages: ["chore: housekeeping"] });
    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", {
      ...mergedPr,
      body: "no reference here",
    });
    expect(result).toEqual([]);
    expect(octokit.pulls.listCommits).toHaveBeenCalledOnce();
    expect(octokit.pulls.listFiles).not.toHaveBeenCalled();
  });

  it("resolves issue refs from commit messages when PR body is empty", async () => {
    const octokit = makeOctokit({
      commitMessages: ["fix: correct off-by-one\n\nFixes #42"],
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: { abc123: [{ number: 55, merged_at: "2026-01-01T00:00:00Z" }] },
    });
    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", { ...mergedPr, body: null });
    expect(result).toEqual([{ issueNumber: 42, sourcePrId: 55 }]);
  });

  it("resolves the introducing PR via blame and returns an escape for the referenced issue", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: { abc123: [{ number: 55, merged_at: "2026-01-01T00:00:00Z" }] },
    });

    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr);
    expect(result).toEqual([{ issueNumber: 42, sourcePrId: 55 }]);
    expect(octokit.pulls.listCommits).toHaveBeenCalledOnce();
  });

  it("returns an escape for each of multiple referenced issues, sharing the same source PR", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: { abc123: [{ number: 55, merged_at: "2026-01-01T00:00:00Z" }] },
    });

    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", {
      ...mergedPr,
      body: "Fixes #1 and closes #2",
    });
    expect(result).toEqual([
      { issueNumber: 1, sourcePrId: 55 },
      { issueNumber: 2, sourcePrId: 55 },
    ]);
  });

  it("ignores a blame range that does not overlap any removed line range", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 100, endingLine: 105, oid: "unrelated" }],
    });

    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr);
    expect(result).toEqual([]);
  });

  it("skips a pure-addition file (no patch removed-lines) without calling blame for it", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/new.ts", status: "added", patch: "@@ -0,0 +1,3 @@\n+a\n+b\n+c" }],
    });

    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr);
    expect(result).toEqual([]);
    expect(octokit.graphql).not.toHaveBeenCalled();
  });

  it("fails open (empty array, no throw) when pulls.listCommits rejects", async () => {
    const octokit = makeOctokit({ listCommitsThrows: new Error("network timeout") });
    await expect(detectCommitLinkedEscapes(octokit, "acme", "widgets", { ...mergedPr, body: null })).resolves.toEqual([]);
  });

  it("fails open (empty array, no throw) when pulls.listFiles rejects", async () => {
    const octokit = makeOctokit({ listFilesThrows: { status: 500 } });
    await expect(detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr)).resolves.toEqual([]);
  });

  it("fails open (empty array, no throw) when the GraphQL blame call rejects", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      graphqlThrows: new Error("boom"),
    });
    await expect(detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr)).resolves.toEqual([]);
  });

  it("fails open (empty array) when no commit resolves to a merged PR", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: { abc123: [] },
    });
    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr);
    expect(result).toEqual([]);
  });

  it("picks the most-recently-merged PR when a commit is associated with more than one", async () => {
    const octokit = makeOctokit({
      files: [{ filename: "src/foo.ts", status: "modified", patch: "@@ -10,2 +10,1 @@\n-bug\n context" }],
      blameRanges: [{ startingLine: 9, endingLine: 12, oid: "abc123" }],
      prsForOid: {
        abc123: [
          { number: 10, merged_at: "2026-01-01T00:00:00Z" },
          { number: 20, merged_at: "2026-02-01T00:00:00Z" },
        ],
      },
    });
    const result = await detectCommitLinkedEscapes(octokit, "acme", "widgets", mergedPr);
    expect(result).toEqual([{ issueNumber: 42, sourcePrId: 20 }]);
  });
});
