// Commit-linked defect-escape detection (story E1, FR-5.1/FR-5.2) — the
// primary, highest-precedence detection tier.
//
// BR-4 (closing-keyword detection) and BR-5 (blame resolution).

import { withTimeout } from "../util/githubContent";

export interface CommitLinkedEscape {
  issueNumber: number;
  sourcePrId: number;
}

interface MergedPr {
  number: number;
  body: string | null;
  base: { sha: string };
}

export interface OctokitLike {
  pulls: {
    listFiles(params: { owner: string; repo: string; pull_number: number; per_page: number }): Promise<{
      data: Array<{ filename: string; status: string; patch?: string }>;
    }>;
    listCommits(params: { owner: string; repo: string; pull_number: number; per_page: number }): Promise<{
      data: Array<{ commit: { message: string } }>;
    }>;
  };
  repos: {
    listPullRequestsAssociatedWithCommit(params: {
      owner: string;
      repo: string;
      commit_sha: string;
    }): Promise<{ data: Array<{ number: number; merged_at: string | null }> }>;
  };
  graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>;
}

const EXTERNAL_CALL_TIMEOUT_MS = 3000;

// GitHub's own supported closing-keyword set (see GitHub docs: "Linking a
// pull request to an issue"). Case-insensitive; a keyword can appear
// anywhere in the PR body, not just as its own line — matching GitHub's
// own parsing behavior (unlike the Co-authored-by/Escape-Source trailers
// elsewhere in this project, which ARE line-anchored).
const CLOSING_KEYWORD_REF = /\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s*:?\s*#(\d+)\b/gi;

// BR-4: extracts every distinct issue number referenced via a GitHub
// closing keyword. Pure — no I/O.
export function extractClosingKeywordIssueRefs(prBody: string | null): number[] {
  if (!prBody) {
    return [];
  }
  const numbers = new Set<number>();
  for (const match of prBody.matchAll(CLOSING_KEYWORD_REF)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n)) {
      numbers.add(n);
    }
  }
  return [...numbers];
}

// BR-5: parses a unified-diff patch's hunk headers for the OLD-file line
// ranges this patch removed or modified — the lines that existed before
// the fix, which is what needs blaming to find the introducing commit. A
// pure-addition hunk (0 old lines) contributes nothing to blame, since
// there's no pre-existing line to attribute.
export function removedLineRanges(patch: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm;
  for (const match of patch.matchAll(hunkHeader)) {
    const start = Number(match[1]);
    const count = match[2] !== undefined ? Number(match[2]) : 1;
    if (count > 0) {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

interface BlameRange {
  startingLine: number;
  endingLine: number;
  commit: { oid: string };
}

interface BlameQueryResult {
  repository: {
    object: { blame: { ranges: BlameRange[] } } | null;
  } | null;
}

const BLAME_QUERY = `
  query($owner: String!, $repo: String!, $ref: String!, $path: String!) {
    repository(owner: $owner, name: $repo) {
      object(expression: $ref) {
        ... on Commit {
          blame(path: $path) {
            ranges {
              startingLine
              endingLine
              commit { oid }
            }
          }
        }
      }
    }
  }
`;

function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

// Blames one file at `ref` (the fix PR's base SHA — the pre-fix state)
// and returns the set of distinct commit OIDs that last touched any of
// the given removed-line ranges. Fails open (empty array) on any
// GraphQL error or an unrecognized response shape (e.g. the path didn't
// exist at that ref, a binary file, or a repo/ref that's since been
// deleted) — a single file's blame failing must not abort detection for
// the PR's other files.
async function blameCommitOidsForRanges(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  ref: string,
  path: string,
  removedRanges: Array<{ start: number; end: number }>
): Promise<string[]> {
  if (removedRanges.length === 0) {
    return [];
  }
  let result: BlameQueryResult;
  try {
    result = await withTimeout(
      octokit.graphql<BlameQueryResult>(BLAME_QUERY, { owner, repo, ref, path }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
  } catch {
    return [];
  }
  const blameRanges = result.repository?.object?.blame?.ranges ?? [];
  const oids = new Set<string>();
  for (const blameRange of blameRanges) {
    const asRange = { start: blameRange.startingLine, end: blameRange.endingLine };
    if (removedRanges.some((removed) => rangesOverlap(removed, asRange))) {
      oids.add(blameRange.commit.oid);
    }
  }
  return [...oids];
}

// Resolves a commit OID back to the PR that merged it. Best-effort: a
// commit can be associated with more than one PR (e.g. a cherry-pick or
// a squash-merged PR whose commit also appears via a later merge) — this
// takes the most-recently-merged match, on the reasoning that the most
// recent merge is the one most likely to represent this exact line's
// actual introduction into the target branch's history. Fails open
// (undefined) on no match or any API error.
async function resolveIntroducingPr(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  commitOid: string
): Promise<number | undefined> {
  let prs: Array<{ number: number; merged_at: string | null }>;
  try {
    const response = await withTimeout(
      octokit.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: commitOid }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
    prs = response.data;
  } catch {
    return undefined;
  }
  const merged = prs.filter((pr) => pr.merged_at !== null).sort((a, b) => (a.merged_at! < b.merged_at! ? 1 : -1));
  return merged[0]?.number;
}

const MAX_FILES_PER_DETECTION = 20;

// Scans commit messages for closing-keyword issue refs. Fails open (empty
// array) on any API error — commit refs are a best-effort supplement to
// the PR body refs extracted by extractClosingKeywordIssueRefs.
//
// Pagination note: per_page: 100 is GitHub's maximum for this endpoint.
// PRs with more than 100 commits will have refs in commits beyond the
// 100th silently missed. This is an accepted limitation — such PRs are
// extremely rare in practice and the body-ref path (extractClosingKeywordIssueRefs)
// remains the primary detection mechanism.
async function issueRefsFromCommits(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number[]> {
  let commits: Array<{ commit: { message: string } }>;
  try {
    const response = await withTimeout(
      octokit.pulls.listCommits({ owner, repo, pull_number: prNumber, per_page: 100 }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
    commits = response.data;
  } catch {
    return [];
  }
  const numbers = new Set<number>();
  for (const c of commits) {
    for (const n of extractClosingKeywordIssueRefs(c.commit.message)) {
      numbers.add(n);
    }
  }
  return [...numbers];
}

// FR-5.1/FR-5.2: for a merged bug-fix PR, finds every closing-keyword-
// referenced issue and, for each, attempts to trace the fix back to
// whichever earlier PR introduced the fixed lines. Fails open at every
// stage (no closing keyword, no blame match, no resolvable PR all
// produce no result for that issue, never a thrown error) — a partial
// result (some issues resolved, others not) is expected, not a bug.
export async function detectCommitLinkedEscapes(
  octokit: OctokitLike,
  owner: string,
  repo: string,
  mergedPr: MergedPr
): Promise<CommitLinkedEscape[]> {
  const bodyRefs = extractClosingKeywordIssueRefs(mergedPr.body);
  // Always fetch commit refs unconditionally — body refs alone miss commit-only
  // closing keywords. The extra API call is the price of correctness.
  const commitRefs = await issueRefsFromCommits(octokit, owner, repo, mergedPr.number);
  const issueNumbers = [...new Set([...bodyRefs, ...commitRefs])];
  if (issueNumbers.length === 0) {
    return [];
  }

  let files: Array<{ filename: string; status: string; patch?: string }>;
  try {
    const response = await withTimeout(
      octokit.pulls.listFiles({ owner, repo, pull_number: mergedPr.number, per_page: 100 }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
    files = response.data;
  } catch {
    return [];
  }

  const candidateFiles = files.filter((file) => file.status !== "added" && file.patch).slice(0, MAX_FILES_PER_DETECTION);

  const allOids = new Set<string>();
  for (const file of candidateFiles) {
    const ranges = removedLineRanges(file.patch!);
    const oids = await blameCommitOidsForRanges(octokit, owner, repo, mergedPr.base.sha, file.filename, ranges);
    for (const oid of oids) {
      allOids.add(oid);
    }
  }

  let sourcePrId: number | undefined;
  for (const oid of allOids) {
    sourcePrId = await resolveIntroducingPr(octokit, owner, repo, oid);
    if (sourcePrId !== undefined) {
      break;
    }
  }

  if (sourcePrId === undefined) {
    return [];
  }
  return issueNumbers.map((issueNumber) => ({ issueNumber, sourcePrId: sourcePrId! }));
}
