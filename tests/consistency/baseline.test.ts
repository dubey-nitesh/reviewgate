import { afterEach, describe, expect, it, vi } from "vitest";
import type { OctokitLike } from "../../src/consistency/baseline";
import { fetchFileContent, resolveSiblingBaseline } from "../../src/consistency/baseline";

function makeOctokit(options: {
  directoryListing?: unknown;
  fileContents?: Record<string, { content: string; encoding?: string }>;
  directoryThrows?: unknown;
  fileThrows?: Set<string>;
  hangOnPaths?: Set<string>;
}): OctokitLike {
  return {
    repos: {
      getContent: vi.fn(async (params: { path: string }) => {
        if (options.hangOnPaths?.has(params.path)) {
          // Never resolves — used to exercise the per-call timeout.
          return new Promise(() => {});
        }
        const fileEntry = options.fileContents?.[params.path];
        if (fileEntry) {
          if (options.fileThrows?.has(params.path)) {
            throw new Error(`simulated failure for ${params.path}`);
          }
          return { data: { content: Buffer.from(fileEntry.content).toString("base64"), encoding: "base64" } };
        }
        if (options.directoryThrows) {
          throw options.directoryThrows;
        }
        return { data: options.directoryListing ?? [] };
      }),
    },
  };
}

function fileEntry(path: string, size = 100) {
  return { name: path.split("/").pop()!, path, type: "file", size };
}

describe("resolveSiblingBaseline", () => {
  it("resolves siblings from the touched file's directory, excluding itself", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/c.ts"),
        fileEntry("src/foo/target.ts"),
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.sufficientSample).toBe(true);
    expect(result.files).toHaveLength(3);
  });

  it("excludes non-TS/JS files and directories from the sibling set", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/c.ts"),
        { name: "README.md", path: "src/foo/README.md", type: "file", size: 50 },
        { name: "sub", path: "src/foo/sub", type: "dir" },
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.files).toHaveLength(3);
  });

  // BR-1: below the minimum sibling count -> insufficient sample, empty
  // baseline (not an error, not a partial guess).
  it("reports an insufficient sample when fewer than 3 candidates exist", async () => {
    const octokit = makeOctokit({
      directoryListing: [fileEntry("src/foo/a.ts"), fileEntry("src/foo/target.ts")],
      fileContents: { "src/foo/a.ts": { content: "const x = 1;" } },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result).toEqual({ files: [], sufficientSample: false });
  });

  // BR-6: fetch ceiling — never fetches more than 10 candidates even when
  // the directory listing has many more.
  it("caps sibling fetches at 10 regardless of directory size", async () => {
    const manyFiles = Array.from({ length: 30 }, (_, i) => fileEntry(`src/foo/file${i}.ts`));
    const fileContents: Record<string, { content: string }> = {};
    for (const f of manyFiles) {
      fileContents[f.path] = { content: `const v${f.path} = 1;` };
    }
    const octokit = makeOctokit({
      directoryListing: [...manyFiles, fileEntry("src/foo/target.ts")],
      fileContents,
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.files).toHaveLength(10);
    // getContent called once for the directory listing + at most 10 for files
    expect((octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(11);
  });

  // BR-6: per-file size cap — oversized candidates are skipped (not
  // fetched), and don't count toward the sufficient-sample total.
  it("skips candidates over the per-file size cap without fetching them", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts", 100),
        fileEntry("src/foo/b.ts", 100),
        fileEntry("src/foo/c.ts", 100),
        fileEntry("src/foo/huge.ts", 300 * 1024),
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
        "src/foo/huge.ts": { content: "const huge = 1;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.files).toHaveLength(3);
    const calledPaths = (octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(calledPaths).not.toContain("src/foo/huge.ts");
  });

  it("fails open (empty baseline, no throw) when the directory listing itself fails", async () => {
    const octokit = makeOctokit({ directoryThrows: { status: 404 } });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result).toEqual({ files: [], sufficientSample: false });
  });

  it("handles a root-level touched file (no directory segment)", async () => {
    const octokit = makeOctokit({
      directoryListing: [fileEntry("a.ts"), fileEntry("b.ts"), fileEntry("c.ts"), fileEntry("target.ts")],
      fileContents: {
        "a.ts": { content: "const x = 1;" },
        "b.ts": { content: "const y = 2;" },
        "c.ts": { content: "const z = 3;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "target.ts", "main");

    expect(result.sufficientSample).toBe(true);
  });

  // Regression test (code-review pass): GitHub's contents API treats an
  // empty path as repo root; "." is a literal path segment there (no
  // POSIX normalization) and would 404 against the real API. The mock
  // above previously ignored `path` entirely, which is exactly what let
  // this slip through — this test asserts the actual path value sent.
  it("requests the directory listing with an empty path, not '.', for a root-level file", async () => {
    const octokit = makeOctokit({
      directoryListing: [fileEntry("a.ts"), fileEntry("b.ts"), fileEntry("c.ts")],
    });

    await resolveSiblingBaseline(octokit, "acme", "widgets", "target.ts", "main");

    const calls = (octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls;
    const directoryListingCall = calls.find((call) => (call[0] as { path: string }).path !== "target.ts");
    expect(directoryListingCall?.[0]).toMatchObject({ path: "" });
  });

  // Regression test (code-review pass): the fetch-ceiling slice must
  // happen AFTER size filtering, not before — otherwise early oversized
  // entries can crowd out smaller, valid siblings later in the listing.
  it("does not let an early oversized entry crowd out smaller valid siblings later in the listing", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/huge.ts", 300 * 1024),
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/c.ts"),
      ],
      fileContents: {
        "src/foo/huge.ts": { content: "const huge = 1;" },
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.sufficientSample).toBe(true);
    expect(result.files).toHaveLength(3);
  });

  // Regression test (code-review pass): a single sibling fetch failure
  // must not abort the whole baseline resolution — only that one sibling
  // is skipped, consistent with BR-6's fail-open posture.
  it("skips a sibling whose fetch fails without aborting the whole baseline", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/c.ts"),
        fileEntry("src/foo/flaky.ts"),
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
        "src/foo/flaky.ts": { content: "const w = 4;" },
      },
      fileThrows: new Set(["src/foo/flaky.ts"]),
    });

    await expect(
      resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main")
    ).resolves.toEqual({ files: expect.any(Array), sufficientSample: true });
  });

  // Regression test (code-review pass): an already-past deadline stops
  // the sibling-fetch loop mid-file rather than only being bounded
  // between top-level diff files by the caller (checker.ts).
  it("bails out of the sibling-fetch loop once the deadline has passed", async () => {
    const octokit = makeOctokit({
      directoryListing: [fileEntry("src/foo/a.ts"), fileEntry("src/foo/b.ts"), fileEntry("src/foo/c.ts")],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
      },
    });

    const alreadyPastDeadline = Date.now() - 1;
    const result = await resolveSiblingBaseline(
      octokit,
      "acme",
      "widgets",
      "src/foo/target.ts",
      "main",
      alreadyPastDeadline
    );

    expect(result.files).toHaveLength(0);
    expect(result.sufficientSample).toBe(false);
  });

  // Regression test (code-review pass, BR-1): a file also touched by this
  // same PR must not count as a sibling baseline sample, even when it's
  // in the same directory as the file being checked. Without the
  // otherTouchedFilePaths exclusion, this directory has 3 "siblings"
  // (a.ts, b.ts, and the other-touched file) — enough to pass the
  // MIN_SIBLING_FILES gate — but per BR-1 only a.ts and b.ts are
  // legitimate, independent samples.
  it("excludes other diff-touched files from the sibling baseline, not just the file itself", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/other-touched.ts"),
        fileEntry("src/foo/target.ts"),
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/other-touched.ts": { content: "const w = 3;" },
      },
    });

    const result = await resolveSiblingBaseline(
      octokit,
      "acme",
      "widgets",
      "src/foo/target.ts",
      "main",
      undefined,
      new Set(["src/foo/target.ts", "src/foo/other-touched.ts"])
    );

    expect(result.sufficientSample).toBe(false);
    expect(result.files).toHaveLength(0);
  });

  // G6: the authoritative polyglot-repo correctness test — a
  // Python touched file in a directory that also contains TS/JS files
  // must only ever get Python siblings, never TS/JS ones, even though
  // the TS/JS files would otherwise satisfy MIN_SIBLING_FILES on their
  // own. This is the test that would catch a regression in
  // isSameLanguageFamily or its call site here.
  it("only includes same-language-family siblings in a polyglot directory (Python touched file)", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.py"),
        fileEntry("src/foo/b.py"),
        fileEntry("src/foo/c.py"),
        fileEntry("src/foo/unrelated1.ts"),
        fileEntry("src/foo/unrelated2.ts"),
        fileEntry("src/foo/target.py"),
      ],
      fileContents: {
        "src/foo/a.py": { content: "def a(): pass" },
        "src/foo/b.py": { content: "def b(): pass" },
        "src/foo/c.py": { content: "def c(): pass" },
        "src/foo/unrelated1.ts": { content: "const x = 1;" },
        "src/foo/unrelated2.ts": { content: "const y = 2;" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.py", "main");

    expect(result.sufficientSample).toBe(true);
    expect(result.files).toHaveLength(3);
    const fetchedPaths = (octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(fetchedPaths).not.toContain("src/foo/unrelated1.ts");
    expect(fetchedPaths).not.toContain("src/foo/unrelated2.ts");
  });

  // Reverse direction — regression protection: a TS/JS touched file in a
  // polyglot directory must not be widened to also accept Python
  // siblings.
  it("only includes same-language-family siblings in a polyglot directory (TS/JS touched file)", async () => {
    const octokit = makeOctokit({
      directoryListing: [
        fileEntry("src/foo/a.ts"),
        fileEntry("src/foo/b.ts"),
        fileEntry("src/foo/c.ts"),
        fileEntry("src/foo/unrelated.py"),
        fileEntry("src/foo/target.ts"),
      ],
      fileContents: {
        "src/foo/a.ts": { content: "const x = 1;" },
        "src/foo/b.ts": { content: "const y = 2;" },
        "src/foo/c.ts": { content: "const z = 3;" },
        "src/foo/unrelated.py": { content: "def unrelated(): pass" },
      },
    });

    const result = await resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");

    expect(result.files).toHaveLength(3);
    const fetchedPaths = (octokit.repos.getContent as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => (call[0] as { path: string }).path
    );
    expect(fetchedPaths).not.toContain("src/foo/unrelated.py");
  });
});

// RESILIENCY-10 (enabled Resiliency Baseline extension): "All external
// calls ... MUST have explicit timeouts configured — no unbounded waits."
describe("resolveSiblingBaseline / fetchFileContent — timeout (RESILIENCY-10)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails open instead of hanging forever when the directory listing call never resolves", async () => {
    vi.useFakeTimers();
    const octokit = makeOctokit({ hangOnPaths: new Set(["src/foo"]) });

    const resultPromise = resolveSiblingBaseline(octokit, "acme", "widgets", "src/foo/target.ts", "main");
    await vi.advanceTimersByTimeAsync(3001);

    await expect(resultPromise).resolves.toEqual({ files: [], sufficientSample: false });
  });

  it("fetchFileContent resolves to undefined instead of hanging forever on a stuck call", async () => {
    vi.useFakeTimers();
    const octokit = makeOctokit({ hangOnPaths: new Set(["src/foo/stuck.ts"]) });

    const contentPromise = fetchFileContent(octokit, "acme", "widgets", "src/foo/stuck.ts", "main");
    await vi.advanceTimersByTimeAsync(3001);

    await expect(contentPromise).resolves.toBeUndefined();
  });
});
