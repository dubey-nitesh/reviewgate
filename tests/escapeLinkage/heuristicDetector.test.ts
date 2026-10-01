import { describe, expect, it, vi } from "vitest";
import { detectHeuristicEscape, extractMentionedFilePaths, type OctokitLike } from "../../src/escapeLinkage/heuristicDetector";

describe("extractMentionedFilePaths", () => {
  it("extracts a mentioned TypeScript file path", () => {
    expect(extractMentionedFilePaths("The bug is in src/foo/bar.ts around line 40.")).toEqual(["src/foo/bar.ts"]);
  });

  it("extracts multiple distinct paths", () => {
    expect(extractMentionedFilePaths("Happens in src/a.ts and also src/b.py")).toEqual(["src/a.ts", "src/b.py"]);
  });

  it("deduplicates a repeated path mention", () => {
    expect(extractMentionedFilePaths("src/a.ts is broken. See src/a.ts.")).toEqual(["src/a.ts"]);
  });

  it("returns empty for a body with no recognizable path", () => {
    expect(extractMentionedFilePaths("The login button is broken.")).toEqual([]);
  });

  it("returns empty for null/empty body", () => {
    expect(extractMentionedFilePaths(null)).toEqual([]);
    expect(extractMentionedFilePaths("")).toEqual([]);
  });

  it("does not match a bare filename with no directory separator", () => {
    expect(extractMentionedFilePaths("Check foo.ts for the bug.")).toEqual([]);
  });

  it("matches a path with dots/hyphens in an intermediate segment", () => {
    expect(extractMentionedFilePaths("Broken in my.dir/sub-dir/file.ts somewhere")).toEqual(["my.dir/sub-dir/file.ts"]);
  });

  it("stays fast (no catastrophic backtracking) on an adversarial extension-less path-like string", () => {
    const adversarial = "a/".repeat(20000) + "a";
    const start = Date.now();
    expect(extractMentionedFilePaths(adversarial)).toEqual([]);
    expect(Date.now() - start).toBeLessThan(500);
  });
});

describe("detectHeuristicEscape", () => {
  function makeOctokit(options: {
    mergedPrs?: MergedPrSummary[];
    filesByPr?: Record<number, string[]>;
    listThrows?: unknown;
    listFilesThrows?: unknown;
  }): OctokitLike {
    return {
      pulls: {
        list: vi.fn(async () => {
          if (options.listThrows !== undefined) {
            throw options.listThrows;
          }
          return { data: options.mergedPrs ?? [] };
        }),
        listFiles: vi.fn(async ({ pull_number }: { pull_number: number }) => {
          if (options.listFilesThrows !== undefined) {
            throw options.listFilesThrows;
          }
          return { data: (options.filesByPr?.[pull_number] ?? []).map((filename) => ({ filename })) };
        }),
      },
    };
  }

  interface MergedPrSummary {
    number: number;
    merged_at: string | null;
  }

  const issue = { number: 1, body: "Broken in src/foo.ts", createdAt: "2026-01-15T00:00:00Z" };

  it("returns undefined when the issue body has no recognizable file path", async () => {
    const octokit = makeOctokit({});
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", { ...issue, body: "no path here" }, 14);
    expect(result).toBeUndefined();
    expect(octokit.pulls.list).not.toHaveBeenCalled();
  });

  it("matches a PR merged within the window that touched the mentioned file", async () => {
    const octokit = makeOctokit({
      mergedPrs: [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }],
      filesByPr: { 10: ["src/foo.ts"] },
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toEqual({ sourcePrId: 10 });
  });

  it("does not match a PR merged before the window", async () => {
    const octokit = makeOctokit({
      mergedPrs: [{ number: 10, merged_at: "2025-12-01T00:00:00Z" }], // >14 days before issue
      filesByPr: { 10: ["src/foo.ts"] },
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toBeUndefined();
  });

  it("does not match a PR merged after the issue was filed", async () => {
    const octokit = makeOctokit({
      mergedPrs: [{ number: 10, merged_at: "2026-01-20T00:00:00Z" }], // after issue.createdAt
      filesByPr: { 10: ["src/foo.ts"] },
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toBeUndefined();
  });

  it("does not match a PR within the window that touched a different file", async () => {
    const octokit = makeOctokit({
      mergedPrs: [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }],
      filesByPr: { 10: ["src/unrelated.ts"] },
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toBeUndefined();
  });

  it("skips a not-yet-merged (open or closed-without-merge) PR", async () => {
    const octokit = makeOctokit({
      mergedPrs: [{ number: 10, merged_at: null }],
      filesByPr: { 10: ["src/foo.ts"] },
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toBeUndefined();
  });

  it("fails open (undefined, no throw) when pulls.list rejects", async () => {
    const octokit = makeOctokit({ listThrows: { status: 500 } });
    await expect(detectHeuristicEscape(octokit, "acme", "widgets", issue, 14)).resolves.toBeUndefined();
  });

  it("fails open (undefined, no throw) when a per-PR listFiles call rejects, but still checks the next candidate", async () => {
    const octokit = makeOctokit({
      mergedPrs: [
        { number: 10, merged_at: "2026-01-11T00:00:00Z" },
        { number: 11, merged_at: "2026-01-10T00:00:00Z" },
      ],
      filesByPr: { 11: ["src/foo.ts"] },
      listFilesThrows: undefined,
    });
    // Override listFiles to throw only for PR 10, not 11.
    octokit.pulls.listFiles = vi.fn(async ({ pull_number }: { pull_number: number }) => {
      if (pull_number === 10) {
        throw new Error("boom");
      }
      return { data: [{ filename: "src/foo.ts" }] };
    });
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toEqual({ sourcePrId: 11 });
  });

  it("pages past a full first page to find an in-window PR on a later page", async () => {
    // Page 1: 100 items, all merged after the issue was filed (so none
    // are in-window) — a single-page fetch would find nothing. Page 2
    // carries the one PR that's actually in-window and touches the file.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1000,
      merged_at: "2026-01-20T00:00:00Z", // after issue.createdAt — filtered out
    }));
    const page2 = [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }];
    const listMock = vi.fn(async ({ page }: { page: number }) => ({ data: page === 1 ? page1 : page === 2 ? page2 : [] }));
    const octokit: OctokitLike = {
      pulls: {
        list: listMock,
        listFiles: vi.fn(async () => ({ data: [{ filename: "src/foo.ts" }] })),
      },
    };
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toEqual({ sourcePrId: 10 });
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it("stops paging at the bounded page limit rather than scanning indefinitely", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ number: i, merged_at: "2026-01-20T00:00:00Z" }));
    const listMock = vi.fn(async () => ({ data: fullPage }));
    const octokit: OctokitLike = {
      pulls: { list: listMock, listFiles: vi.fn(async () => ({ data: [] })) },
    };
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toBeUndefined();
    expect(listMock).toHaveBeenCalledTimes(3); // MAX_LIST_PAGES, not unbounded
  });

  it("keeps candidates already found on an earlier page when a later page's fetch fails", async () => {
    const page1 = [{ number: 10, merged_at: "2026-01-10T00:00:00Z" }];
    const fullFillerPage = Array.from({ length: 100 }, (_, i) => ({ number: i + 500, merged_at: null }));
    let calls = 0;
    const listMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { data: [...page1, ...fullFillerPage.slice(0, 99)] };
      throw new Error("page 2 timed out");
    });
    const octokit: OctokitLike = {
      pulls: { list: listMock, listFiles: vi.fn(async () => ({ data: [{ filename: "src/foo.ts" }] })) },
    };
    const result = await detectHeuristicEscape(octokit, "acme", "widgets", issue, 14);
    expect(result).toEqual({ sourcePrId: 10 });
  });
});
