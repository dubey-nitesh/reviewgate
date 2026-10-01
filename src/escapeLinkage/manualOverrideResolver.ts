// Manual escape-link override (story E3).
//
// BR-3 for the trailer format and precedence semantics.
//
// A reporter/triager can explicitly state which PR introduced a bug by
// adding a trailer line to the issue body — mirrors
// src/detectors/coAuthor.ts's Co-authored-by trailer-parsing pattern
// (same line-anchored, case-insensitive prefix shape), not shared code:
// the data and validation are different (a PR number, not a name/email).

export interface ManualEscape {
  sourcePrId: number;
}

// Case-insensitive, tolerant of surrounding whitespace around the "#",
// matching this project's existing trailer-parsing conventions
// (coAuthor.ts's TRAILER_PREFIX is similarly lenient on whitespace).
const ESCAPE_SOURCE_TRAILER = /^escape-source:\s*#\s*(\d+)\s*$/im;

// Returns the FIRST matching trailer line, scanning the whole body (not
// just the last line) — an issue body can have arbitrary surrounding
// text before/after the trailer, same tolerance coAuthor.ts's per-line
// scan already extends to commit messages.
export function parseManualOverride(issueBody: string | null | undefined): ManualEscape | undefined {
  if (!issueBody) {
    return undefined;
  }
  const match = ESCAPE_SOURCE_TRAILER.exec(issueBody);
  if (!match) {
    return undefined;
  }
  const sourcePrId = Number(match[1]);
  // The \d+ capture group guarantees a non-negative integer string, but
  // guard against unsafe-integer overflow (e.g. a 300-digit number) —
  // Number() doesn't throw on that, it silently returns Infinity, which
  // would be a nonsensical PR id.
  if (!Number.isSafeInteger(sourcePrId)) {
    return undefined;
  }
  return { sourcePrId };
}
