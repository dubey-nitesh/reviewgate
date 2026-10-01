import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { AI_COAUTHOR_PATTERNS, detectCoAuthorTrailer } from "../src/detectors/coAuthor";

describe("detectCoAuthorTrailer", () => {
  it("flags a Claude Code co-authored commit (with email)", () => {
    const result = detectCoAuthorTrailer([
      "Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>",
    ]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("Claude Code");
  });

  it("flags a GitHub Copilot co-authored commit (with email)", () => {
    const result = detectCoAuthorTrailer([
      "Add feature\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
    ]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("GitHub Copilot");
  });

  it("does not flag a commit with no matching trailer", () => {
    const result = detectCoAuthorTrailer([
      "Fix bug\n\nCo-authored-by: Jane Doe <jane@example.com>",
    ]);
    expect(result.isAiAuthored).toBe(false);
    expect(result.matchedTrailer).toBeUndefined();
  });

  it("does not flag a commit with no trailer at all", () => {
    const result = detectCoAuthorTrailer(["Fix bug in parser"]);
    expect(result.isAiAuthored).toBe(false);
  });

  // Regression test: a bare trailer with no <email> (a valid git trailer
  // format) must still be detected via exact name-alias matching.
  it("flags a bare-name trailer with no email", () => {
    const result = detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: Claude Code"]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("Claude Code");
  });

  it("flags a bare 'Cursor' trailer with no email", () => {
    const result = detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: Cursor"]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("Cursor");
  });

  it("flags a bare 'GitHub Copilot' trailer with no email", () => {
    expect(detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: GitHub Copilot"]).matchedTrailer).toBe(
      "GitHub Copilot"
    );
  });

  // Regression test for the "copilot" name-alias false-positive risk found
  // during the fourth code-review pass: "copilot" alone is an ordinary
  // English job-title word (as in a flight/driving copilot) a human might
  // plausibly use as a nickname or git identity — the same class of risk
  // "claude" was removed for. Only the specific two-word "github copilot"
  // form remains as a bare-name alias.
  it("does not flag a bare 'Copilot' trailer with no email (ordinary job-title word)", () => {
    const result = detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: Copilot"]);
    expect(result.isAiAuthored).toBe(false);
  });

  it("flags a bare 'Windsurf' trailer with no email", () => {
    const result = detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: Windsurf"]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("Windsurf");
  });

  // Regression test for the "claude" name-alias false-positive risk found
  // during the third code-review pass: unlike the other tools, "Claude" is
  // a common real human first name, so it was deliberately removed from
  // Claude Code's bare-name aliases (only the two-word "claude code" form
  // remains). A bare single-word "Claude" trailer with no email must NOT be
  // flagged.
  it("does not flag a bare 'Claude' trailer with no email (common human first name)", () => {
    const result = detectCoAuthorTrailer(["Fix bug\n\nCo-authored-by: Claude"]);
    expect(result.isAiAuthored).toBe(false);
  });

  // Regression test: an email present but not matching any known tool
  // domain (e.g. an internal/self-hosted deployment) still resolves via
  // exact name-alias matching on the display name.
  it("flags a known tool name with an unrecognized/internal email domain", () => {
    const result = detectCoAuthorTrailer([
      "Fix bug\n\nCo-authored-by: Claude Code <bot@internal-ai.acme.com>",
    ]);
    expect(result.isAiAuthored).toBe(true);
    expect(result.matchedTrailer).toBe("Claude Code");
  });

  // Regression test for the original false-positive risk: matching is
  // EXACT-name, not substring, so a human co-author whose display name
  // merely contains a tool name must NOT be flagged, with or without email.
  it("does not flag a human co-author whose name contains a tool name (no email)", () => {
    const result = detectCoAuthorTrailer(["Refactor auth\n\nCo-authored-by: Cursor Johnson"]);
    expect(result.isAiAuthored).toBe(false);
  });

  it("does not flag a human co-author whose name contains a tool name (with email)", () => {
    const result = detectCoAuthorTrailer([
      "Refactor auth\n\nCo-authored-by: Cursor Johnson <cursor.johnson@example.com>",
    ]);
    expect(result.isAiAuthored).toBe(false);
  });

  it("does not flag a human co-author whose email local-part contains a tool name", () => {
    const result = detectCoAuthorTrailer([
      "Fix bug\n\nCo-authored-by: Jane Copilotson <jane.copilotson@example.com>",
    ]);
    expect(result.isAiAuthored).toBe(false);
  });

  // Regression test (code-review pass): the Claude Code/Cursor/Codeium/
  // Windsurf email patterns were only end-anchored ($), unlike GitHub
  // Copilot's deliberately `(^|\+)`-anchored pattern — an email whose
  // local-part merely ends with the real address (e.g. a prefix injected
  // before it) must not match at "definite" confidence via the email
  // path.
  it("does not match an email whose local-part has an unrelated prefix before the real address", () => {
    const result = detectCoAuthorTrailer([
      "Fix bug\n\nCo-authored-by: Someone <attacker-noreply@anthropic.com>",
    ]);
    expect(result.isAiAuthored).toBe(false);
  });

  // PBT: result is order-independent w.r.t. commit message array ordering —
  // matching a trailer anywhere in the array yields the same result
  // regardless of position (business-rules.md Testable Properties).
  it("is order-independent for a matching trailer's position in the array", () => {
    const matchingMessage = "Fix bug\n\nCo-authored-by: Claude <noreply@anthropic.com>";
    fc.assert(
      fc.property(
        fc.array(fc.string().filter((s) => !/co-authored-by:/i.test(s)), { maxLength: 5 }),
        fc.array(fc.string().filter((s) => !/co-authored-by:/i.test(s)), { maxLength: 5 }),
        (before, after) => {
          const messages = [...before, matchingMessage, ...after];
          const result = detectCoAuthorTrailer(messages);
          expect(result.isAiAuthored).toBe(true);
          expect(result.matchedTrailer).toBe("Claude Code");
        }
      )
    );
  });

  // Matching is keyed on mutually-exclusive email domains / exact name
  // aliases rather than ordered substrings, so the result must be
  // independent of declaration order — asserted via the externally
  // observable consequence: every known tool's canonical trailer (email
  // AND bare-name forms) resolves to its own distinct canonical name.
  it("resolves each known tool's trailer to its own distinct canonical name", () => {
    const cases: Array<[string, string]> = [
      ["Co-authored-by: Claude <noreply@anthropic.com>", "Claude Code"],
      ["Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>", "GitHub Copilot"],
      ["Co-authored-by: Cursor <noreply@cursor.sh>", "Cursor"],
      ["Co-authored-by: Codeium <noreply@codeium.com>", "Codeium"],
      ["Co-authored-by: Windsurf <noreply@windsurf.com>", "Windsurf"],
      ["Co-authored-by: Claude Code", "Claude Code"],
      ["Co-authored-by: Codeium", "Codeium"],
      ["Co-authored-by: GitHub Copilot", "GitHub Copilot"],
      ["Co-authored-by: Windsurf", "Windsurf"],
    ];
    for (const [trailer, expectedName] of cases) {
      const result = detectCoAuthorTrailer([`Fix bug\n\n${trailer}`]);
      expect(result.matchedTrailer).toBe(expectedName);
    }
  });
});

// Structural invariant tests (third code-review pass): guard against future
// AI_COAUTHOR_PATTERNS edits that add a working email pattern but forget (or
// mistype) the corresponding bare-name aliases, or vice versa.
describe("AI_COAUTHOR_PATTERNS structural invariants", () => {
  it("every pattern has a non-empty, lowercase-normalized, globally-unique alias list and a defined email pattern", () => {
    const allAliases: string[] = [];
    for (const pattern of AI_COAUTHOR_PATTERNS) {
      expect(pattern.canonicalName.length).toBeGreaterThan(0);
      expect(pattern.emailPattern).toBeInstanceOf(RegExp);
      expect(pattern.nameAliases.length).toBeGreaterThan(0);
      for (const alias of pattern.nameAliases) {
        expect(alias).toBe(alias.toLowerCase());
        expect(alias.length).toBeGreaterThan(0);
        allAliases.push(alias);
      }
    }
    // No two patterns share a name alias — checked in the same pass since
    // it's a static property of the same array with no interdependency on
    // the check above (merged from two separate tests during the fourth
    // code-review pass).
    expect(new Set(allAliases).size).toBe(allAliases.length);
  });

  // Every declared alias must actually resolve back to its own tool via
  // detectCoAuthorTrailer — catches an alias that's present in the array
  // but unreachable due to a matching bug (e.g. shadowed by an earlier
  // pattern, or containing characters normalizedName never produces).
  it("every declared alias is reachable via detectCoAuthorTrailer", () => {
    for (const pattern of AI_COAUTHOR_PATTERNS) {
      for (const alias of pattern.nameAliases) {
        const result = detectCoAuthorTrailer([`Fix bug\n\nCo-authored-by: ${alias}`]);
        expect(result.matchedTrailer).toBe(pattern.canonicalName);
      }
    }
  });
});
