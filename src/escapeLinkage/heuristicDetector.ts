// Time-window heuristic defect-escape detection (story E2, FR-5.3) — the
// lowest-precedence, explicitly best-effort fallback tier.
//
// BR-6 (path-mention parsing) and BR-7 (time-window matching).

import { withTimeout } from "../util/githubContent";

export interface HeuristicEscape {
  sourcePrId: number;
}

interface NewIssue {
  number: number;
  body: string | null;
  createdAt: string;
}

interface MergedPrSummary {
  number: number;
  merged_at: string | null;
}

export interface OctokitLike {
  pulls: {
    list(params: {
      owner: string;
      repo: string;
      state: "closed";
      sort: "updated";
      direction: "desc";
      per_page: number;
      page: number;
    }): Promise<{ data: MergedPrSummary[] }>;
    listFiles(params: {
      owner: string;
      repo: string;
      pull_number: number;
      per_page: number;
    }): Promise<{ data: Array<{ filename: string }> }>;
  };
}

const EXTERNAL_CALL_TIMEOUT_MS = 3000;

// BR-6: best-effort extraction of file-path-like tokens from free-text
// issue body — matches a `/`-separated path ending in a common source
// extension. Deliberately conservative (a real path, not just any string
// containing a slash) to keep the false-positive rate down, at the cost
// of missing paths in unconventional formats — acceptable for a
// heuristic fallback tier that's already the lowest-precedence signal.
//
// Path segments are matched with `[\w.-]+` (never `/`) so each segment's
// extent is unambiguous relative to the mandatory `/` separator — unlike
// a single `[\w./-]+` class spanning both, which admits multiple ways to
// split the same input and forces catastrophic (exponential) backtracking
// on long extension-less input. Segment length and count are additionally
// bounded ({1,64}, {1,12} — generous for any real path) rather than left
// unbounded (`+`): with `g`, a failed match is retried at every offset in
// the input, so even an unambiguous-but-unbounded pattern degrades to
// O(n^2) on a long adversarial string (issue bodies are
// attacker-controlled up to GitHub's ~64KB limit) — bounding each
// attempt's cost keeps the whole scan O(n).
const FILE_PATH_PATTERN = /\b(?:[\w.-]{1,64}\/){1,12}[\w.-]{1,64}\.(?:ts|tsx|js|jsx|py|java|go|rb|php|c|cpp|h|hpp|cs)\b/g;

export function extractMentionedFilePaths(issueBody: string | null): string[] {
  if (!issueBody) {
    return [];
  }
  return [...new Set(issueBody.match(FILE_PATH_PATTERN) ?? [])];
}

const MAX_CANDIDATE_PRS = 20;
// The REST API can't sort by merged_at, only by updated_at — so a single
// 100-item page (the old behavior) can miss an in-window merged PR that
// simply hasn't been touched recently, on any repo with >100 PRs closed/
// updated since it merged. Paging further reduces (does not eliminate)
// that gap; still bounded, since this is the lowest-precedence,
// best-effort detection tier and an unbounded scan isn't worth the extra
// API calls on every new issue.
const MAX_LIST_PAGES = 3;

// BR-7: candidate PRs are those merged in
// [issue.createdAt - timeWindowDays, issue.createdAt] — a fix merged
// AFTER the issue was filed can't be what caused it, and one merged
// before the window is treated as too distant to implicate with any
// confidence (the whole point of a time-window heuristic is bounding
// how far back it's willing to guess).
function isWithinWindow(mergedAt: string, issueCreatedAt: string, timeWindowDays: number): boolean {
  const mergedMs = new Date(mergedAt).getTime();
  const issueMs = new Date(issueCreatedAt).getTime();
  const windowMs = timeWindowDays * 24 * 60 * 60 * 1000;
  return mergedMs <= issueMs && mergedMs >= issueMs - windowMs;
}

// FR-5.3: fails open (undefined, not a thrown error) when no path is
// mentioned, no PR is found in the window, or any external call fails —
// this is explicitly the lowest-confidence, most-likely-to-find-nothing
// detection tier, and that's expected behavior, not a bug.
export async function detectHeuristicEscape(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  issue: NewIssue,
  timeWindowDays: number
): Promise<HeuristicEscape | undefined> {
  const mentionedPaths = extractMentionedFilePaths(issue.body);
  if (mentionedPaths.length === 0) {
    return undefined;
  }

  // Each page is fetched independently so a later page's timeout/error
  // discards only that page, not candidates already found on earlier
  // pages — a single try/catch around the whole loop would otherwise
  // throw away good partial results on a mid-scan failure.
  const candidatePrs: MergedPrSummary[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES && candidatePrs.length < MAX_CANDIDATE_PRS; page++) {
    let data: MergedPrSummary[];
    try {
      const response = await withTimeout(
        octokit.pulls.list({ owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100, page }),
        EXTERNAL_CALL_TIMEOUT_MS
      );
      data = response.data;
    } catch {
      break;
    }
    if (data.length === 0) {
      break;
    }
    for (const pr of data) {
      if (pr.merged_at !== null && isWithinWindow(pr.merged_at, issue.createdAt, timeWindowDays)) {
        candidatePrs.push(pr);
      }
    }
    if (data.length < 100) {
      break;
    }
  }
  candidatePrs.length = Math.min(candidatePrs.length, MAX_CANDIDATE_PRS);

  for (const pr of candidatePrs) {
    let files: Array<{ filename: string }>;
    try {
      const response = await withTimeout(
        octokit.pulls.listFiles({ owner, repo, pull_number: pr.number, per_page: 100 }),
        EXTERNAL_CALL_TIMEOUT_MS
      );
      files = response.data;
    } catch {
      continue;
    }
    if (files.some((file) => mentionedPaths.some((path) => file.filename.endsWith(path)))) {
      return { sourcePrId: pr.number };
    }
  }

  return undefined;
}
