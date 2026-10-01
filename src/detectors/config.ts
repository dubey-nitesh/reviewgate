// Loads the target repo's .reviewgate.yml — org-specific branch-naming /
// PR-template conventions used as an additional authorship signal.
//
// BR-2, BR-3, BR-4 for matching semantics and fallback behavior.

import * as yaml from "js-yaml";
import { minimatch } from "minimatch";
import { decodeFileContent, withTimeout, type OctokitLike } from "../util/githubContent";

export type { OctokitLike };

// Consistency-checker BR-5: enabled defaults to false (opt-in — this is a
// stricter, noisier signal than authorship detection). scope "ai-only"
// (default) gates on the authorship-detection module's
// AuthorshipResult.confidence being definite/likely; "all" runs the
// checker regardless of confidence.
export interface ConsistencyCheckConfig {
  enabled: boolean;
  scope: "ai-only" | "all";
}

// Gate-policy BR-4: enabled defaults to false (opt-in). scope "all"
// (default — inverted from consistencyCheck's "ai-only" default) runs
// regardless of authorship confidence; "ai-only" restricts to the
// authorship-detection module's AuthorshipResult.confidence being
// definite/likely. blocking defaults to false — only an explicit `true`
// lets the check-run's conclusion become "failure" (BR-6). Each sub-rule
// has its own `enabled` flag, defaulting to `true` once gatePolicy.enabled
// itself is opted into (BR-4's note on why: a minimal `{enabled: true}`
// should still get full behavior, with per-rule flags existing so a repo
// can selectively narrow rather than needing to enumerate all three just
// to turn any one on).
export interface GatePolicyConfig {
  enabled: boolean;
  scope: "all" | "ai-only";
  blocking: boolean;
  complexity: { enabled: boolean; threshold: number };
  sizeRisk: { enabled: boolean; linesThreshold: number; filesThreshold: number };
  coverage: { enabled: boolean; minimumPercent: number; checkRunName?: string };
}

// Defect-escape-linkage BR: enabled defaults to false (opt-in, same
// posture as consistencyCheck/gatePolicy — this subscribes to a new
// webhook event family (issues.*) and requires the Issues: Read
// permission, so it must never activate silently on upgrade).
// timeWindowDays defaults to 14 (E2's heuristic-fallback window).
export interface EscapeLinkageConfig {
  enabled: boolean;
  timeWindowDays: number;
}

export interface ReviewgateConfig {
  aiBranchPatterns?: string[];
  aiPrTemplateMarkers?: string[];
  consistencyCheck?: ConsistencyCheckConfig;
  gatePolicy?: GatePolicyConfig;
  escapeLinkage?: EscapeLinkageConfig;
}

// Exported for reuse by checker.ts, which needs this exact default as its
// own fallback when config-loading fails — found hand-restated there as an
// identical literal during a code-review pass.
export const DEFAULT_CONSISTENCY_CHECK: ConsistencyCheckConfig = { enabled: false, scope: "ai-only" };

// Exported for reuse by src/gatepolicy/checker.ts, same pattern as
// DEFAULT_CONSISTENCY_CHECK above. coverage.checkRunName deliberately has
// no default (BR-3) — CI check-run naming is entirely repo/tool-specific.
export const DEFAULT_GATE_POLICY: GatePolicyConfig = {
  enabled: false,
  scope: "all",
  blocking: false,
  complexity: { enabled: true, threshold: 10 },
  sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
  coverage: { enabled: true, minimumPercent: 80 },
};

// Exported for reuse by src/escapeLinkage/checker.ts, same pattern as
// DEFAULT_CONSISTENCY_CHECK/DEFAULT_GATE_POLICY above.
export const DEFAULT_ESCAPE_LINKAGE: EscapeLinkageConfig = { enabled: false, timeWindowDays: 14 };

const DEFAULT_CONFIG: ReviewgateConfig = {
  aiBranchPatterns: [],
  aiPrTemplateMarkers: [],
  consistencyCheck: DEFAULT_CONSISTENCY_CHECK,
  gatePolicy: DEFAULT_GATE_POLICY,
  escapeLinkage: DEFAULT_ESCAPE_LINKAGE,
};

// Bounds on aiBranchPatterns/aiPrTemplateMarkers: both are matched against
// on every PR event using attacker-controlled input (branch name, PR body)
// against repo-controlled patterns (.reviewgate.yml). Even with per-option
// DoS mitigations on the matching side (see matchesBranchPattern), an
// unbounded array or string length still lets a malicious config multiply
// the per-event matching cost arbitrarily. These caps are generous for any
// legitimate config (BR-2's own examples are a handful of short patterns)
// and, like BR-4's other shape checks, fail closed to defaults rather than
// rejecting only the offending entries.
const MAX_PATTERNS = 50;
const MAX_PATTERN_LENGTH = 200;

// Matches src/consistency/baseline.ts's EXTERNAL_CALL_TIMEOUT_MS (kept as
// separate constants, not a shared export, since each module owns its own
// RESILIENCY-10 budget independently — no shared semantic meaning beyond
// "the same 3s figure was judged reasonable in both places").
const EXTERNAL_CALL_TIMEOUT_MS = 3000;

function isNotFoundError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}

function isStringArrayOrUndefined(value: unknown): value is string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= MAX_PATTERNS &&
      value.every((v) => typeof v === "string" && v.length <= MAX_PATTERN_LENGTH))
  );
}

// Consistency-check BR-5: same fail-closed posture as isStringArrayOrUndefined —
// an invalid consistencyCheck value invalidates the whole config (falls
// back to DEFAULT_CONFIG, which has consistencyCheck.enabled: false),
// not just that one key.
function isValidConsistencyCheckShape(value: unknown): value is Partial<ConsistencyCheckConfig> | undefined {
  if (value === undefined) {
    return true;
  }
  // typeof [] === "object", so an explicit Array.isArray check is needed —
  // found during a code-review pass: `consistencyCheck: [1, 2, 3]` in
  // .reviewgate.yml would otherwise pass this shape check (candidate.enabled
  // and candidate.scope both read as undefined off an array, same as {}),
  // silently accepting a malformed value the fail-closed contract intends
  // to reject.
  //
  // Found by a ninth /code-review pass: this was the same predicate as
  // isPlainObject below (added later, for gatePolicy's shape checks),
  // just hand-rolled and negated — a drift risk if one were ever updated
  // without the other, the same class of duplication this project has
  // already consolidated elsewhere (unwrapOrLog generalizing
  // logIfRejected). Consolidated to the shared helper; isPlainObject is a
  // function declaration, hoisted, so the reference below works despite
  // being defined later in this file. Pure refactor, no behavior change —
  // verified by the existing test suite passing unchanged.
  if (!isPlainObject(value)) {
    return false;
  }
  const candidate = value;
  if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
    return false;
  }
  if (candidate.scope !== undefined && candidate.scope !== "ai-only" && candidate.scope !== "all") {
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Found by a fifth /code-review pass: `typeof value === "number"` alone
// accepts NaN and +/-Infinity — both valid YAML (`.nan`, `.inf` parse to
// exactly these via js-yaml, verified directly), and both silently defeat
// whichever gate-policy threshold field they're assigned to. A complexity/
// sizeRisk threshold of NaN makes every `> threshold` comparison false
// (the rule never fires, with `blocking: true` this looks like "nothing
// ever violates policy" rather than a config mistake); a coverage
// minimumPercent of NaN makes `actualPercent >= minimumPercent` always
// false too, but since that's the early-exit condition in
// fetchCoverageFinding, the effect there is the opposite polarity — the
// rule fires on every PR regardless of actual coverage. Either way, a
// non-finite threshold is a config value with no sane operational
// meaning, so it's rejected the same way any other wrong-shape value is
// (BR-4's "reject the whole config" contract) rather than accepted and
// producing behavior the repo owner never intended.
// Found by a tenth /code-review pass, verified directly: a negative
// threshold is the same class of "config value with no sane operational
// meaning" as NaN/Infinity above, just not caught by the original
// (renamed) isFiniteNumber check — `evaluateSizeRisk({ linesChanged: 0,
// filesChanged: 0 }, -1, 100)` (a completely empty diff) returns a
// finding, because any real value is `> -1`; the same logic makes a
// negative complexity.threshold flag every function, and a negative
// coverage minimumPercent pass every PR regardless of actual coverage
// (the opposite-polarity failure this file's own NaN/Infinity fix
// already distinguishes). Zero remains valid — an aggressive but
// coherent policy choice a repo owner might deliberately set ("flag
// every function" / "any coverage passes") — only negative values are
// rejected. Renamed from isFiniteNumber to isValidThresholdNumber since
// "finite" alone no longer describes what it actually checks.
function isValidThresholdNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// BR-4: same fail-closed posture as isValidConsistencyCheckShape — an
// invalid gatePolicy value (at any nesting level) invalidates the whole
// config, not just that one key. Each sub-rule object is validated the
// same way: undefined is fine (defaults fill in), a non-object/array is
// rejected outright, and any present field must be the right type.
function isValidGatePolicyShape(value: unknown): value is Partial<GatePolicyConfig> | undefined {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return false;
  }
  if (value.scope !== undefined && value.scope !== "all" && value.scope !== "ai-only") {
    return false;
  }
  if (value.blocking !== undefined && typeof value.blocking !== "boolean") {
    return false;
  }

  const complexity = value.complexity;
  if (complexity !== undefined) {
    if (!isPlainObject(complexity)) {
      return false;
    }
    if (complexity.enabled !== undefined && typeof complexity.enabled !== "boolean") {
      return false;
    }
    if (complexity.threshold !== undefined && !isValidThresholdNumber(complexity.threshold)) {
      return false;
    }
  }

  const sizeRisk = value.sizeRisk;
  if (sizeRisk !== undefined) {
    if (!isPlainObject(sizeRisk)) {
      return false;
    }
    if (sizeRisk.enabled !== undefined && typeof sizeRisk.enabled !== "boolean") {
      return false;
    }
    if (sizeRisk.linesThreshold !== undefined && !isValidThresholdNumber(sizeRisk.linesThreshold)) {
      return false;
    }
    if (sizeRisk.filesThreshold !== undefined && !isValidThresholdNumber(sizeRisk.filesThreshold)) {
      return false;
    }
  }

  const coverage = value.coverage;
  if (coverage !== undefined) {
    if (!isPlainObject(coverage)) {
      return false;
    }
    if (coverage.enabled !== undefined && typeof coverage.enabled !== "boolean") {
      return false;
    }
    if (coverage.minimumPercent !== undefined && !isValidThresholdNumber(coverage.minimumPercent)) {
      return false;
    }
    if (
      coverage.checkRunName !== undefined &&
      (typeof coverage.checkRunName !== "string" || coverage.checkRunName.length > MAX_PATTERN_LENGTH)
    ) {
      return false;
    }
  }

  return true;
}

// Same fail-closed posture as isValidGatePolicyShape — an invalid
// escapeLinkage value invalidates the whole config, not just this key.
function isValidEscapeLinkageShape(value: unknown): value is Partial<EscapeLinkageConfig> | undefined {
  if (value === undefined) {
    return true;
  }
  if (!isPlainObject(value)) {
    return false;
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    return false;
  }
  if (value.timeWindowDays !== undefined && !isValidThresholdNumber(value.timeWindowDays)) {
    return false;
  }
  return true;
}

function isValidConfigShape(value: unknown): value is ReviewgateConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isStringArrayOrUndefined(candidate.aiBranchPatterns) &&
    isStringArrayOrUndefined(candidate.aiPrTemplateMarkers) &&
    isValidConsistencyCheckShape(candidate.consistencyCheck) &&
    isValidGatePolicyShape(candidate.gatePolicy) &&
    isValidEscapeLinkageShape(candidate.escapeLinkage)
  );
}

// BR-4: missing file (404), unparseable content (non-base64 encoding, e.g.
// files over 1MB where GitHub omits inline content), malformed YAML, and
// wrong-shape YAML all fail closed to defaults. Any OTHER API error (rate
// limit, network, 5xx) propagates, since those are operational failures
// distinct from "no usable config" (SECURITY-15 fail-closed, but don't
// silently swallow real errors).
export async function loadConfig(
  octokit: OctokitLike,
  owner: string,
  repo: string
): Promise<ReviewgateConfig> {
  let raw: string;
  try {
    // RESILIENCY-10 (enabled Resiliency Baseline extension): explicit
    // timeout, shared with src/consistency/baseline.ts's identical
    // requirement — found missing here during a code-review pass. This
    // call sat on the consistency-check hot path (checker.ts
    // calls loadConfig too) with no bound at all, even though the sibling
    // module had already been fixed for the same class of external call.
    const response = await withTimeout(
      octokit.repos.getContent({ owner, repo, path: ".reviewgate.yml" }),
      EXTERNAL_CALL_TIMEOUT_MS
    );
    // encoding: "none" (files GitHub won't inline, e.g. >1MB) and any
    // other non-base64 shape both decode to undefined here — not a valid
    // config, fails closed to defaults rather than throwing.
    const decoded = decodeFileContent(response.data);
    if (decoded === undefined) {
      return DEFAULT_CONFIG;
    }
    raw = decoded;
  } catch (err) {
    if (isNotFoundError(err)) {
      return DEFAULT_CONFIG;
    }
    throw err;
  }

  try {
    const parsed = yaml.load(raw);
    if (!isValidConfigShape(parsed)) {
      return DEFAULT_CONFIG;
    }
    return {
      aiBranchPatterns: parsed.aiBranchPatterns ?? [],
      aiPrTemplateMarkers: parsed.aiPrTemplateMarkers ?? [],
      consistencyCheck: {
        enabled: parsed.consistencyCheck?.enabled ?? false,
        scope: parsed.consistencyCheck?.scope ?? "ai-only",
      },
      gatePolicy: {
        enabled: parsed.gatePolicy?.enabled ?? DEFAULT_GATE_POLICY.enabled,
        scope: parsed.gatePolicy?.scope ?? DEFAULT_GATE_POLICY.scope,
        blocking: parsed.gatePolicy?.blocking ?? DEFAULT_GATE_POLICY.blocking,
        complexity: {
          enabled: parsed.gatePolicy?.complexity?.enabled ?? DEFAULT_GATE_POLICY.complexity.enabled,
          threshold: parsed.gatePolicy?.complexity?.threshold ?? DEFAULT_GATE_POLICY.complexity.threshold,
        },
        sizeRisk: {
          enabled: parsed.gatePolicy?.sizeRisk?.enabled ?? DEFAULT_GATE_POLICY.sizeRisk.enabled,
          linesThreshold: parsed.gatePolicy?.sizeRisk?.linesThreshold ?? DEFAULT_GATE_POLICY.sizeRisk.linesThreshold,
          filesThreshold: parsed.gatePolicy?.sizeRisk?.filesThreshold ?? DEFAULT_GATE_POLICY.sizeRisk.filesThreshold,
        },
        coverage: {
          enabled: parsed.gatePolicy?.coverage?.enabled ?? DEFAULT_GATE_POLICY.coverage.enabled,
          minimumPercent: parsed.gatePolicy?.coverage?.minimumPercent ?? DEFAULT_GATE_POLICY.coverage.minimumPercent,
          checkRunName: parsed.gatePolicy?.coverage?.checkRunName,
        },
      },
      escapeLinkage: {
        enabled: parsed.escapeLinkage?.enabled ?? DEFAULT_ESCAPE_LINKAGE.enabled,
        timeWindowDays: parsed.escapeLinkage?.timeWindowDays ?? DEFAULT_ESCAPE_LINKAGE.timeWindowDays,
      },
    };
  } catch {
    // Malformed YAML — fail closed to defaults rather than throwing.
    return DEFAULT_CONFIG;
  }
}

// BR-2: glob patterns ("ai/*", "copilot/*", "ai/pr-?"), using minimatch for
// full glob semantics (*, ?, character classes) rather than a hand-rolled
// subset. Returns the first matching pattern (for reason-text specificity)
// or undefined if none match.
//
// nobrace: true disables brace expansion ({a,b}) — not part of BR-2's
// supported syntax, and combinatorial brace nesting is a DoS vector against
// this attacker-controlled (via .reviewgate.yml) input; see
// tests/config.test.ts's DoS regression test for the measured impact.
//
// noext: true disables extglob syntax (!(...), +(...), etc.) — also not
// part of BR-2's supported syntax (*, ?, character classes only), and
// extglob negation patterns like "!(a)".repeat(n) cause exponential-time
// blowup in minimatch that the pattern-count/length caps alone don't bound;
// see tests/config.test.ts's extglob DoS regression test.
//
// nonegate: true disables minimatch's separate leading-"!" whole-pattern
// negation feature (also not part of BR-2's supported syntax) — found
// while verifying the noext fix above: noext alone stops the CPU blowup,
// but a pattern that still starts with a literal "!" (like the same
// "!(a)".repeat(n) attack pattern, now treated as a literal string rather
// than extglob) triggers minimatch's negate handling regardless, which
// strips the leading "!" and inverts the match result — so this exact
// attack pattern still spuriously matched almost any branch name (verified
// directly: true with noext alone, false with nonegate added), just via a
// different mechanism than the CPU-cost one noext already closed.
//
// MAX_WILDCARDS_PER_PATTERN caps `*`/`?` occurrences in a single pattern —
// found during a code-review pass: plain, fully-documented BR-2 syntax
// (multiple `*` wildcards in one pattern, e.g. "release-*-*-hotfix-*") also
// causes exponential-time catastrophic backtracking in the regex minimatch
// compiles it into — no minimatch option closes this (their own docs treat
// it as inherent to using untrusted patterns as regex sources, "working as
// intended," not a bug). Unlike the brace/extglob/negate cases above, this
// vector needs no repo-owner-authored maliciousness in `.reviewgate.yml`
// at all: an ordinary multi-`*` naming convention plus ANY external PR
// author choosing an almost-but-not-quite-matching branch name (their
// choice, no privileges needed) is enough — verified directly: 4+ wildcards
// against a several-hundred-character branch name (well within GitHub's
// real ref-length limits) takes seconds, growing exponentially with
// wildcard count. Verified 3 wildcards stays fast (<20ms) even at 600
// characters, comfortably covering realistic branch-name lengths against
// BR-2's own multi-wildcard examples, which never need more than 1-2. A
// pattern over the cap is treated as never-matching (skipped), not a
// config-wide failure — consistent with this codebase's fail-open-per-item
// posture elsewhere (e.g. baseline.ts's per-sibling fetch-failure skip)
// rather than the fail-closed-whole-config posture BR-4 uses for shape
// violations, since a single overly-complex pattern isn't evidence the
// whole config is malformed.
const MAX_WILDCARDS_PER_PATTERN = 3;

function withinWildcardBudget(pattern: string): boolean {
  return (pattern.match(/[*?]/g) ?? []).length <= MAX_WILDCARDS_PER_PATTERN;
}

export function matchesBranchPattern(branchName: string, patterns: string[]): string | undefined {
  return patterns.find(
    (pattern) =>
      withinWildcardBudget(pattern) &&
      minimatch(branchName, pattern, { nobrace: true, noext: true, nonegate: true })
  );
}

// BR-3: case-insensitive substring match against PR body text. Returns the
// first matching marker (for reason-text specificity) or undefined.
// Blank/whitespace-only markers are skipped: String.includes("") is always
// true, so an empty marker in .reviewgate.yml would otherwise match every
// non-empty PR body.
export function matchesPrTemplateMarker(
  prBody: string | null | undefined,
  markers: string[]
): string | undefined {
  if (!prBody) {
    return undefined;
  }
  const normalizedBody = prBody.toLowerCase();
  return markers.find((marker) => {
    // Found during a code-review pass: the blank check trimmed marker but
    // the .includes() call below used to check the untrimmed value —
    // a marker with incidental leading/trailing whitespace (easy to
    // introduce via YAML formatting) would never match, since the PR body
    // essentially never contains that exact padding.
    const trimmed = marker.trim();
    return trimmed.length > 0 && normalizedBody.includes(trimmed.toLowerCase());
  });
}
