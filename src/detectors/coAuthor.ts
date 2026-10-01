// Detects Co-authored-by trailers used by GitHub Copilot / Claude Code in
// commit messages.
//
// BR-1 for the trailer pattern list and two-phase matching semantics.
//
// Matching is two-phase:
//   1. Email-domain match (most reliable) — checked whenever the trailer
//      includes an <email>.
//   2. Exact-name fallback (case-insensitive, whole-name equality — never
//      substring) — used when there's no email, or the email doesn't match
//      any known domain (e.g. an internal/self-hosted tool). Exact equality
//      means a human named "Cursor Johnson" never matches "cursor", unlike
//      substring matching, which is what caused a false-positive regression
//      in an earlier version of this detector.

export interface AuthorshipSignal {
  isAiAuthored: boolean;
  matchedTrailer?: string; // canonical, properly-cased tool name
}

interface TrailerPattern {
  canonicalName: string;
  emailPattern: RegExp;
  nameAliases: string[]; // lowercase, exact-match candidates only
}

// Exported (read-only) so tests can assert structural invariants across
// every entry (e.g. every pattern has a non-empty alias list) without
// duplicating the list.
export const AI_COAUTHOR_PATTERNS: ReadonlyArray<Readonly<TrailerPattern>> = [
  {
    canonicalName: "Claude Code",
    // ^-anchored (full-string equality against the trimmed email, not just
    // a domain-suffix match) — found during a code-review pass: without
    // the start anchor, "attacker-noreply@anthropic.com" also matched,
    // since only the end of the string was pinned. Unlike GitHub Copilot's
    // pattern below, there's no legitimate ID-prefix scheme for this
    // domain (the real sender address is exactly "noreply@anthropic.com"),
    // so a full match — not `(^|\+)`-style prefix tolerance — is correct
    // here and for the three patterns below it.
    emailPattern: /^noreply@anthropic\.com$/i,
    // Deliberately does NOT include a bare "claude" alias: unlike the other
    // tools' names, "Claude" is a common real human first name, so a
    // single-word exact-match fallback risks false-flagging a human commit
    // author named Claude with no email present to override it. "claude
    // code" (the two-word form) is kept since a human is very unlikely to
    // set their git display name to that exact two-word string.
    nameAliases: ["claude code"],
  },
  {
    canonicalName: "GitHub Copilot",
    emailPattern: /(^|\+)copilot@users\.noreply\.github\.com$/i,
    // Deliberately excludes a bare "copilot" alias: unlike "github copilot"
    // (a specific, unlikely-to-collide two-word brand name), "copilot" is
    // an ordinary English job-title word (as in a flight/driving copilot)
    // that a human could plausibly adopt as a nickname or git identity —
    // the same class of risk "claude" was removed for (see Claude Code's
    // entry above), just reasoned about correctly this time: the test
    // isn't "is this a human first name," it's "is this a word a human
    // might use as a handle." Found during a fourth code-review pass.
    nameAliases: ["github copilot"],
  },
  {
    canonicalName: "Cursor",
    emailPattern: /^noreply@cursor\.(sh|com)$/i,
    nameAliases: ["cursor"],
  },
  {
    canonicalName: "Codeium",
    emailPattern: /^noreply@codeium\.com$/i,
    nameAliases: ["codeium"],
  },
  {
    canonicalName: "Windsurf",
    emailPattern: /^noreply@windsurf\.com$/i,
    nameAliases: ["windsurf"],
  },
];

const TRAILER_PREFIX = /^co-authored-by:\s*(.+)$/i;
const NAME_WITH_EMAIL = /^(.*?)\s*<([^>]+)>$/;

function parseTrailerLine(line: string): { name: string; email?: string } | undefined {
  const prefixMatch = TRAILER_PREFIX.exec(line);
  if (!prefixMatch) {
    return undefined;
  }
  const rest = prefixMatch[1].trim();
  const withEmail = NAME_WITH_EMAIL.exec(rest);
  if (withEmail) {
    return { name: withEmail[1].trim(), email: withEmail[2].trim() };
  }
  return { name: rest };
}

function matchTrailer(parsed: { name: string; email?: string }): string | undefined {
  if (parsed.email) {
    const byEmail = AI_COAUTHOR_PATTERNS.find((p) => p.emailPattern.test(parsed.email!));
    if (byEmail) {
      return byEmail.canonicalName;
    }
  }
  // Fallback: exact (not substring) name match — applies both when no
  // email is present, and when an email is present but unrecognized.
  const normalizedName = parsed.name.toLowerCase();
  const byName = AI_COAUTHOR_PATTERNS.find((p) => p.nameAliases.includes(normalizedName));
  return byName?.canonicalName;
}

export function detectCoAuthorTrailer(commitMessages: string[]): AuthorshipSignal {
  for (const message of commitMessages) {
    for (const rawLine of message.split("\n")) {
      const parsed = parseTrailerLine(rawLine.trim());
      if (!parsed) {
        continue;
      }
      const matchedTrailer = matchTrailer(parsed);
      if (matchedTrailer) {
        return { isAiAuthored: true, matchedTrailer };
      }
    }
  }
  return { isAiAuthored: false };
}
