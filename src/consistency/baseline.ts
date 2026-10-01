// Sibling-file baseline resolution.
//
// BR-1 (sample-size gate) and BR-6 (resource budgets). Uses
// repos.getContent rather than the Git Trees API originally considered.

import { extractFileAstSummary, type FileAstSummary } from "./ast";
import { isSameLanguageFamily } from "../util/languageExtensions";
import { decodeFileContent, withTimeout, type OctokitLike } from "../util/githubContent";

export type { OctokitLike };

export interface SiblingBaseline {
  files: FileAstSummary[];
  sufficientSample: boolean;
}

// BR-1 / BR-6. MAX_FILE_SIZE_BYTES is exported for reuse by checker.ts,
// which needs the same size cap for the diff file itself — found
// duplicated (independently declared in both files) during a code-review
// pass.
//
// The extension filter this comment used to describe
// (TS_JS_EXTENSIONS/isTsJsFile) is now isSupportedFile/isSameLanguageFamily
// from the shared languageExtensions.ts registry — unifying what were two
// independently-duplicated TS_JS_EXTENSIONS constants (this file and
// gatepolicy/checker.ts) rather than adding a third copy for Python.
const MIN_SIBLING_FILES = 3;
const MAX_SIBLING_FILES = 10;
export const MAX_FILE_SIZE_BYTES = 200 * 1024;

// RESILIENCY-10 (enabled Resiliency Baseline extension): "All external
// calls (HTTP, database, cache) MUST have explicit timeouts configured —
// no unbounded waits." Every octokit.repos.getContent call in this module
// is wrapped in withTimeout (../util/githubContent, shared with
// config.ts's loadConfig — see that module's comment) — found missing
// during a code-review pass; previously a hung/slow GitHub API call had no
// bound at all, and checker.ts's own per-file wall-clock budget check
// (between loop iterations) doesn't help mid-call, only between files.
const EXTERNAL_CALL_TIMEOUT_MS = 3000;

function directoryOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx === -1 ? "" : filePath.slice(0, idx);
}

interface DirectoryEntry {
  name: string;
  path: string;
  type: string;
  size?: number;
}

function isDirectoryListing(data: unknown): data is DirectoryEntry[] {
  return Array.isArray(data);
}

// Exported for reuse by checker.ts (component 5), which fetches the diff
// file's own content at the PR's head ref using the same
// getContent-then-decode logic this module already needs for siblings.
export async function fetchFileContent(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | undefined> {
  let response: { data: unknown };
  try {
    response = await withTimeout(octokit.repos.getContent({ owner, repo, path, ref }), EXTERNAL_CALL_TIMEOUT_MS);
  } catch {
    // Any fetch failure — 404 (e.g. a listed file deleted between the
    // directory listing and this fetch), network error, rate limit, or a
    // timeout — is "content unavailable." Found during a code-review
    // pass: this previously had no try/catch, so a single flaky/slow
    // sibling fetch would reject resolveSiblingBaseline entirely, which
    // propagates out and aborts the whole PR's consistency check rather
    // than just skipping the one problematic file — too coarse for BR-6's
    // fail-open posture.
    return undefined;
  }
  return decodeFileContent(response.data);
}

// BR-1: for a given diff file, lists same-directory TS/JS siblings
// (excluding the diff file itself AND any other diff-touched files — a
// file this same PR also modified is not an independent baseline sample of
// "the codebase's existing pattern"), applies BR-6's fetch ceiling and
// per-file size cap, and parses whatever's left via the AST extraction
// layer (component 1). sufficientSample reflects files actually included
// in the baseline (after size-cap/fetch-failure filtering), not just the
// raw candidate count — a directory with enough listed files but too many
// oversized/unfetchable ones is still an insufficient sample in practice.
//
// otherTouchedFilePaths: the full set of paths this PR's diff touches
// (including touchedFilePath itself — the exclusion filter checks both).
// Found during a code-review pass: the exclusion previously only checked
// `entry.path !== touchedFilePath`, so a second file the same PR modified
// in the same directory was still counted as a legitimate sibling,
// silently inflating sufficientSample against BR-1's stated rule.
//
// deadline (absolute Date.now()-comparable ms, optional): when given, the
// sibling-fetch loop bails out (returning whatever's already collected)
// once passed, rather than only being bounded between top-level diff
// files by checker.ts's own budget check — found during a code-review
// pass: a single diff file's sibling loop can issue up to
// MAX_SIBLING_FILES + 1 sequential calls, and checker.ts's per-file check
// alone can't interrupt mid-loop.
export async function resolveSiblingBaseline(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  touchedFilePath: string,
  ref: string,
  deadline?: number,
  otherTouchedFilePaths: ReadonlySet<string> = new Set()
): Promise<SiblingBaseline> {
  const dir = directoryOf(touchedFilePath);
  let entries: DirectoryEntry[];
  try {
    // GitHub's contents API treats an empty path as the repository root;
    // "." is not a recognized path segment there (it isn't POSIX-style
    // path normalization) and would 404 — found during a code-review
    // pass. Not verified against the live API in this sandbox (no
    // outbound network access to github.com here); this follows GitHub's
    // documented contract, but flagging for the user to confirm against
    // a real repo with a root-level TS/JS file.
    const response = await withTimeout(
      octokit.repos.getContent({ owner, repo, path: dir, ref }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
    entries = isDirectoryListing(response.data) ? response.data : [];
  } catch {
    // Directory fetch failure (e.g. deleted directory, rate limit, or a
    // timeout) fails open to "no baseline" rather than propagating —
    // consistent with this whole checker's non-blocking posture (BR-7).
    entries = [];
  }

  // Size filtering happens BEFORE the fetch-ceiling slice, not after —
  // found during a code-review pass: filtering after slicing meant early
  // oversized entries (e.g. a large generated file listed first) could
  // crowd out smaller, valid siblings later in the listing, starving the
  // baseline even when enough small candidates existed.
  // BR-5 / G6: same-language-family, not just "any recognized extension"
  // — a Python touchedFilePath only ever gets Python candidates, and vice
  // versa, applied before any other filter (size cap, ceiling), so a
  // language-mismatched candidate never even reaches those checks.
  const candidates = entries
    .filter(
      (entry) =>
        entry.type === "file" &&
        isSameLanguageFamily(entry.name, touchedFilePath) &&
        entry.path !== touchedFilePath &&
        !otherTouchedFilePaths.has(entry.path) &&
        (entry.size === undefined || entry.size <= MAX_FILE_SIZE_BYTES)
    )
    .slice(0, MAX_SIBLING_FILES);

  if (candidates.length < MIN_SIBLING_FILES) {
    return { files: [], sufficientSample: false };
  }

  if (deadline !== undefined && Date.now() > deadline) {
    return { files: [], sufficientSample: false };
  }

  // Fetched concurrently, not sequentially — found during a code-review
  // pass: up to MAX_SIBLING_FILES (10) independent fetches, each with its
  // own EXTERNAL_CALL_TIMEOUT_MS (3s) bound, were previously awaited one
  // at a time, making wall-clock time additive (up to ~30s worst case)
  // against the caller's shared 5s per-PR budget — the single biggest
  // cause of the deadline bail-out firing and silently shrinking the
  // baseline sample. Each fetch is independent (no candidate's result
  // depends on another's), so there's nothing sequential to preserve.
  const contents = await Promise.all(
    candidates.map((candidate) => fetchFileContent(octokit, owner, repo, candidate.path, ref))
  );
  // Paired by index (not filter-then-map) so each summary is parsed with
  // its own candidate's filename — extractFileAstSummary needs the
  // filename to resolve which language to parse as, which a
  // filter-then-map over contents alone would lose track of.
  const files: FileAstSummary[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const content = contents[i];
    if (content === undefined) {
      continue;
    }
    const summary = extractFileAstSummary(candidates[i].path, content);
    if (summary !== undefined) {
      files.push(summary);
    }
  }

  return { files, sufficientSample: files.length >= MIN_SIBLING_FILES };
}
