import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { minimatch } from "minimatch";
import * as yaml from "js-yaml";
import {
  loadConfig,
  matchesBranchPattern,
  matchesPrTemplateMarker,
  OctokitLike,
  ReviewgateConfig,
} from "../src/detectors/config";

function makeOctokit(response: { content?: string; encoding?: string } | { throw: unknown }): OctokitLike {
  return {
    repos: {
      getContent: async () => {
        if ("throw" in response) {
          throw response.throw;
        }
        return { data: response };
      },
    },
  };
}

describe("loadConfig", () => {
  it("parses a valid .reviewgate.yml", async () => {
    const yamlContent = "aiBranchPatterns:\n  - ai/*\naiPrTemplateMarkers:\n  - AI-assisted\n";
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64"), encoding: "base64" });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.aiBranchPatterns).toEqual(["ai/*"]);
    expect(config.aiPrTemplateMarkers).toEqual(["AI-assisted"]);
  });

  it("falls back to defaults when the file is missing (404)", async () => {
    const octokit = makeOctokit({ throw: { status: 404 } });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  it("falls back to defaults on malformed YAML", async () => {
    const octokit = makeOctokit({ content: Buffer.from(":::not valid yaml:::[").toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  it("falls back to defaults when parsed YAML has the wrong shape", async () => {
    const octokit = makeOctokit({ content: Buffer.from("just: a string\n").toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // Regression test: an unbounded aiBranchPatterns array or pattern length
  // lets a malicious .reviewgate.yml multiply matchesBranchPattern's
  // per-event matching cost arbitrarily, even with nobrace closing the
  // brace-specific vector. Falls back to defaults (same fail-closed
  // treatment as any other wrong-shape config) rather than truncating.
  it("falls back to defaults when aiBranchPatterns exceeds the length cap", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => `ai/${i}`);
    const yamlContent = yaml.dump({ aiBranchPatterns: tooMany });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  it("falls back to defaults when a single pattern exceeds the length cap", async () => {
    const yamlContent = yaml.dump({ aiBranchPatterns: ["a".repeat(201)] });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // Regression test: GitHub returns encoding: "none" (no inline content) for
  // files it won't serve directly (e.g. >1MB) — this must fail closed to
  // defaults, not crash Buffer.from with "Unknown encoding: none".
  it("falls back to defaults when the file is too large to inline (encoding: none)", async () => {
    // Some content is present but not base64-encoded — must not be passed
    // straight to Buffer.from(..., "none"), which throws on the unknown
    // encoding rather than failing closed.
    const octokit = makeOctokit({ content: "unusable-placeholder", encoding: "none" });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // BR-5: consistencyCheck defaults to disabled when the key is
  // absent, and applies per-field defaults (scope: "ai-only") when only
  // partially specified.
  it("defaults consistencyCheck.enabled to false when the key is absent", async () => {
    const yamlContent = "aiBranchPatterns:\n  - ai/*\n";
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.consistencyCheck).toEqual({ enabled: false, scope: "ai-only" });
  });

  it("respects an explicit consistencyCheck.enabled: true, defaulting scope to ai-only", async () => {
    const yamlContent = yaml.dump({ consistencyCheck: { enabled: true } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.consistencyCheck).toEqual({ enabled: true, scope: "ai-only" });
  });

  it("respects an explicit scope: all", async () => {
    const yamlContent = yaml.dump({ consistencyCheck: { enabled: true, scope: "all" } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.consistencyCheck).toEqual({ enabled: true, scope: "all" });
  });

  // Fail-closed (BR-5): a malformed consistencyCheck value invalidates the
  // whole config, same as a malformed aiBranchPatterns (BR-4's existing
  // posture) — not silently coerced or partially applied.
  it("falls back to defaults when consistencyCheck.enabled is not a boolean", async () => {
    const yamlContent = yaml.dump({ consistencyCheck: { enabled: "yes" } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  it("falls back to defaults when consistencyCheck.scope is an unrecognized value", async () => {
    const yamlContent = yaml.dump({ consistencyCheck: { enabled: true, scope: "everything" } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  it("falls back to defaults when consistencyCheck is not an object", async () => {
    const yamlContent = yaml.dump({ consistencyCheck: "enabled" });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // Regression test (code-review pass): typeof [] === "object", so an
  // array value for consistencyCheck previously passed the shape check
  // (candidate.enabled/scope both read undefined off an array, same as
  // {}). Paired here with a valid aiBranchPatterns so the bug is actually
  // observable: BR-5 says an invalid consistencyCheck invalidates the
  // WHOLE config (falls back to DEFAULT_CONFIG, aiBranchPatterns included)
  // — testing consistencyCheck in isolation wouldn't distinguish the bug
  // from the fix, since an array's .enabled/.scope both read undefined,
  // converging to the same safe default either way.
  it("falls back to the whole default config (not just consistencyCheck) when consistencyCheck is an array", async () => {
    const yamlContent = yaml.dump({ aiBranchPatterns: ["ai/*"], consistencyCheck: [1, 2, 3] });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // BR-4: gatePolicy defaults to disabled, applies per-field and
  // per-sub-rule defaults when only partially specified, and respects
  // explicit per-rule enabled flags.
  it("respects explicit gatePolicy sub-rule config, defaulting unspecified fields", async () => {
    const yamlContent = yaml.dump({
      gatePolicy: {
        enabled: true,
        blocking: true,
        complexity: { threshold: 15 },
        coverage: { enabled: false, checkRunName: "coverage-report" },
      },
    });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.gatePolicy).toEqual({
      enabled: true,
      scope: "all",
      blocking: true,
      complexity: { enabled: true, threshold: 15 },
      sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
      coverage: { enabled: false, minimumPercent: 80, checkRunName: "coverage-report" },
    });
  });

  it("respects an explicit gatePolicy.scope: ai-only, overriding the ai-only-inverted default", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, scope: "ai-only" } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.gatePolicy?.scope).toBe("ai-only");
  });

  it.each([
    ["gatePolicy.enabled is not a boolean", { enabled: "yes" }],
    ["gatePolicy.scope is unrecognized", { scope: "some" }],
    ["gatePolicy.blocking is not a boolean", { blocking: "yes" }],
    ["gatePolicy.complexity is not an object", { complexity: "high" }],
    ["gatePolicy.complexity.threshold is not a number", { complexity: { threshold: "ten" } }],
    ["gatePolicy.sizeRisk is not an object", { sizeRisk: "big" }],
    ["gatePolicy.sizeRisk.linesThreshold is not a number", { sizeRisk: { linesThreshold: "500" } }],
    ["gatePolicy.coverage is not an object", { coverage: "yes" }],
    ["gatePolicy.coverage.minimumPercent is not a number", { coverage: { minimumPercent: "80" } }],
    ["gatePolicy.coverage.checkRunName is not a string", { coverage: { checkRunName: 123 } }],
    ["gatePolicy.coverage.checkRunName exceeds the length cap", { coverage: { checkRunName: "a".repeat(201) } }],
  ])("falls back to the whole default config when %s", async (_description, gatePolicyOverride) => {
    const yamlContent = yaml.dump({ gatePolicy: gatePolicyOverride });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // Regression test (BR-5 array-shape precedent): typeof [] ===
  // "object", so gatePolicy's shape check needs the same explicit
  // Array.isArray rejection consistencyCheck's fix already established.
  // Paired with a valid aiBranchPatterns so the bug is actually observable
  // (an array-only gatePolicy converges to the same safe default either
  // way, same reasoning as the consistencyCheck array test above).
  it("falls back to the whole default config (not just gatePolicy) when gatePolicy is an array", async () => {
    const yamlContent = yaml.dump({ aiBranchPatterns: ["ai/*"], gatePolicy: [1, 2, 3] });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // Same array-shape rigor applied one level deeper: an array for a
  // sub-rule object (not gatePolicy itself) must also be rejected.
  it("falls back to the whole default config when gatePolicy.complexity is an array", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, complexity: [1, 2, 3] } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
  });

  // escapeLinkage defaults to disabled with a 14-day time
  // window, applies per-field defaults when only partially specified,
  // and fails the whole config closed on a malformed value — same
  // pattern as consistencyCheck/gatePolicy.
  it("respects explicit escapeLinkage config, defaulting unspecified fields", async () => {
    const yamlContent = yaml.dump({ escapeLinkage: { enabled: true } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.escapeLinkage).toEqual({ enabled: true, timeWindowDays: 14 });
  });

  it("respects an explicit escapeLinkage.timeWindowDays", async () => {
    const yamlContent = yaml.dump({ escapeLinkage: { enabled: true, timeWindowDays: 30 } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.escapeLinkage).toEqual({ enabled: true, timeWindowDays: 30 });
  });

  it.each([
    ["escapeLinkage.enabled is not a boolean", { enabled: "yes" }],
    ["escapeLinkage.timeWindowDays is not a number", { timeWindowDays: "14" }],
    ["escapeLinkage.timeWindowDays is negative", { timeWindowDays: -1 }],
    ["escapeLinkage.timeWindowDays is NaN", { timeWindowDays: NaN }],
    ["escapeLinkage is an array", [1, 2, 3]],
  ])("falls back to the whole default config when %s", async (_description, escapeLinkageOverride) => {
    const yamlContent = yaml.dump({ aiBranchPatterns: ["ai/*"], escapeLinkage: escapeLinkageOverride });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config.aiBranchPatterns).toEqual([]);
    expect(config.escapeLinkage).toEqual({ enabled: false, timeWindowDays: 14 });
  });

  // Regression tests (found by a fifth /code-review pass, verified
  // directly that js-yaml parses `.nan`/`.inf` to exactly these values):
  // `typeof value === "number"` alone accepts NaN and +/-Infinity, both
  // of which silently defeat whichever threshold field they're assigned
  // to (a NaN complexity/sizeRisk threshold makes its `>` comparison
  // always false — the rule never fires; a NaN coverage minimumPercent
  // makes fetchCoverageFinding's early-exit `>=` comparison always false
  // too, so the rule fires on every PR instead) with no error anywhere.
  it("falls back to the whole default config when gatePolicy.complexity.threshold is NaN", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, complexity: { threshold: NaN } } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config?.gatePolicy.enabled).toBe(false);
  });

  it("falls back to the whole default config when gatePolicy.coverage.minimumPercent is Infinity", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, coverage: { minimumPercent: Infinity } } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config?.gatePolicy.enabled).toBe(false);
  });

  it("falls back to the whole default config when gatePolicy.sizeRisk.linesThreshold is -Infinity", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, sizeRisk: { linesThreshold: -Infinity } } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config?.gatePolicy.enabled).toBe(false);
  });

  // Regression test (found by a tenth /code-review pass, verified
  // directly): a negative threshold is the same class of "no sane
  // operational meaning" value as NaN/Infinity above, just not caught by
  // the original fix — a negative sizeRisk.linesThreshold makes every PR
  // (including a completely empty one) exceed it, since any real value is
  // greater than a negative number.
  it("falls back to the whole default config when gatePolicy.sizeRisk.linesThreshold is negative", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, sizeRisk: { linesThreshold: -1 } } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config?.gatePolicy.enabled).toBe(false);
  });

  it("accepts a zero threshold (an aggressive but coherent policy choice, not rejected like a negative one)", async () => {
    const yamlContent = yaml.dump({ gatePolicy: { enabled: true, complexity: { threshold: 0 } } });
    const octokit = makeOctokit({ content: Buffer.from(yamlContent).toString("base64") });
    const config = await loadConfig(octokit, "acme", "widgets");
    expect(config?.gatePolicy.enabled).toBe(true);
    expect(config?.gatePolicy.complexity.threshold).toBe(0);
  });

  it("propagates non-404 errors (e.g. rate limit)", async () => {
    const octokit = makeOctokit({ throw: { status: 403, message: "rate limited" } });
    await expect(loadConfig(octokit, "acme", "widgets")).rejects.toBeDefined();
  });

  // RESILIENCY-10 (enabled Resiliency Baseline extension): "All external
  // calls ... MUST have explicit timeouts configured — no unbounded
  // waits." Regression test (code-review pass): this getContent call had
  // no timeout at all, even though the sibling consistency-check module
  // (src/consistency/baseline.ts) had already been fixed for the same
  // class of external call, and loadConfig now runs on that same
  // consistency-check hot path via checker.ts.
  describe("timeout (RESILIENCY-10)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("rejects (bounded, not hanging forever) on a stuck .reviewgate.yml fetch, same as any other operational error", async () => {
      vi.useFakeTimers();
      const octokit: OctokitLike = {
        repos: {
          getContent: () => new Promise(() => {}),
        },
      };

      const configPromise = loadConfig(octokit, "acme", "widgets");
      // Attached before advancing timers so the rejection (which fires as
      // soon as the timeout elapses, below) is never transiently
      // unhandled — the actual assertion is the awaited expect() call.
      configPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(3001);

      // Not a 404, so this propagates rather than degrading to defaults —
      // consistent with "propagates non-404 errors" above (BR-4: an
      // operational failure is distinct from "no usable config"). The
      // point under test is that it rejects within ~3s instead of hanging
      // indefinitely.
      await expect(configPromise).rejects.toBeDefined();
    });
  });

  // PBT: for any simulated 404, result is always exactly the empty-defaults
  // shape — never partial/undefined fields (business-rules.md BR-4).
  it("always returns the exact defaults shape on 404, regardless of status details", async () => {
    await fc.assert(
      fc.asyncProperty(fc.record({ status: fc.constant(404), message: fc.string() }), async (errShape) => {
        const octokit = makeOctokit({ throw: errShape });
        const config = await loadConfig(octokit, "acme", "widgets");
        expect(config).toEqual({
      aiBranchPatterns: [],
      aiPrTemplateMarkers: [],
      consistencyCheck: { enabled: false, scope: "ai-only" },
      gatePolicy: {
        enabled: false,
        scope: "all",
        blocking: false,
        complexity: { enabled: true, threshold: 10 },
        sizeRisk: { enabled: true, linesThreshold: 500, filesThreshold: 20 },
        coverage: { enabled: true, minimumPercent: 80 },
      },
      escapeLinkage: { enabled: false, timeWindowDays: 14 },
    });
      })
    );
  });

  // PBT-01 round-trip property (business-rules.md Testable Properties): for
  // any valid ReviewgateConfig, dumping to YAML and loading it back through
  // the full loadConfig pipeline must reproduce the same value. This closes
  // a gap found during the second code-review pass — the table previously
  // claimed this was "Implemented" but only the malformed-input half
  // actually had a test.
  it("round-trips any valid config through yaml.dump -> loadConfig", async () => {
    const patternArb = fc.stringMatching(/^[a-zA-Z0-9/*_-]{1,20}$/);
    // consistencyCheck is included explicitly (not left to loadConfig's
    // own defaulting) so the round-trip is a true identity check — since
    // loadConfig always fills in a consistencyCheck value on the returned
    // object (BR-5), a generated input that omitted the key would never
    // produce an equal round-trip regardless of correctness.
    const configArb: fc.Arbitrary<ReviewgateConfig> = fc.record({
      aiBranchPatterns: fc.array(patternArb, { maxLength: 5 }),
      aiPrTemplateMarkers: fc.array(patternArb, { maxLength: 5 }),
      consistencyCheck: fc.record({
        enabled: fc.boolean(),
        scope: fc.constantFrom("ai-only", "all"),
      }),
      // coverage.checkRunName has no default (BR-3) — generated as
      // optional (fc.option with nil: undefined) so the round-trip
      // property covers both "configured" and "left unset" cases. js-yaml's
      // dump omits an undefined-valued key entirely, matching loadConfig's
      // own undefined-when-absent read.
      gatePolicy: fc.record({
        enabled: fc.boolean(),
        scope: fc.constantFrom("all", "ai-only"),
        blocking: fc.boolean(),
        complexity: fc.record({ enabled: fc.boolean(), threshold: fc.integer({ min: 1, max: 100 }) }),
        sizeRisk: fc.record({
          enabled: fc.boolean(),
          linesThreshold: fc.integer({ min: 1, max: 10000 }),
          filesThreshold: fc.integer({ min: 1, max: 1000 }),
        }),
        coverage: fc.record({
          enabled: fc.boolean(),
          minimumPercent: fc.integer({ min: 0, max: 100 }),
          checkRunName: fc.option(patternArb, { nil: undefined }),
        }),
      }),
      escapeLinkage: fc.record({
        enabled: fc.boolean(),
        timeWindowDays: fc.integer({ min: 1, max: 365 }),
      }),
    });

    await fc.assert(
      fc.asyncProperty(configArb, async (config) => {
        const dumped = yaml.dump(config);
        const octokit = makeOctokit({ content: Buffer.from(dumped).toString("base64"), encoding: "base64" });
        const roundTripped = await loadConfig(octokit, "acme", "widgets");
        expect(roundTripped).toEqual(config);
      })
    );
  });
});

describe("matchesBranchPattern", () => {
  it("matches a glob pattern and returns the matched pattern", () => {
    expect(matchesBranchPattern("ai/refactor-auth", ["ai/*", "copilot/*"])).toBe("ai/*");
  });

  it("does not match when no pattern fits", () => {
    expect(matchesBranchPattern("feature/login", ["ai/*", "copilot/*"])).toBeUndefined();
  });

  it("matches an exact non-glob pattern", () => {
    expect(matchesBranchPattern("main", ["main"])).toBe("main");
  });

  // Regression test: "?" must behave as a single-character glob wildcard
  // (via minimatch), not as an unescaped regex quantifier.
  it("treats ? as a single-character wildcard, not a regex quantifier", () => {
    expect(matchesBranchPattern("ai/pr-1", ["ai/pr-?"])).toBe("ai/pr-?");
    expect(matchesBranchPattern("ai/pr-", ["ai/pr-?"])).toBeUndefined();
    expect(matchesBranchPattern("ai/pr-12", ["ai/pr-?"])).toBeUndefined();
  });

  // PBT-01 oracle test (business-rules.md Testable Properties): result must
  // agree with minimatch itself (the runtime implementation) across
  // generated branch-name/pattern strings — guards against any future
  // change to matchesBranchPattern silently diverging from real glob
  // semantics. Oracle call passes the same { nobrace: true } option as
  // matchesBranchPattern itself (see below).
  it("agrees with the minimatch oracle across generated inputs", () => {
    const segment = fc.stringMatching(/^[a-z0-9-]{1,10}$/);
    fc.assert(
      fc.property(
        fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join("/")),
        fc.constantFrom("ai/*", "copilot/*", "ai/pr-?", "feature/*", "*"),
        (branchName, pattern) => {
          const result = matchesBranchPattern(branchName, [pattern]);
          const expected = minimatch(branchName, pattern, { nobrace: true, noext: true, nonegate: true })
            ? pattern
            : undefined;
          expect(result).toBe(expected);
        }
      )
    );
  });

  // DoS regression test: a combinatorial brace pattern must complete
  // quickly (nobrace disables expansion) rather than hanging, and must not
  // match a branch that doesn't literally contain the brace text.
  it("does not brace-expand patterns (DoS fix) — treats { } as literal characters", () => {
    const attackPattern = "{a,b}".repeat(20) + "x";
    const start = Date.now();
    const result = matchesBranchPattern("feature/some-branch", [attackPattern]);
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBeUndefined();
  });

  // Confirms nobrace only disables expansion, not matching of a literal
  // brace character that's actually present in the branch name.
  it("still matches a pattern and branch name that both contain a literal brace", () => {
    expect(matchesBranchPattern("feature/{a,b}", ["feature/{a,b}"])).toBe("feature/{a,b}");
  });

  // Caps on aiBranchPatterns' array length/pattern length (isStringArrayOrUndefined)
  // bound the total matching cost per event, closing the general
  // "many small patterns" cumulative-cost DoS vector that a single-option
  // fix like nobrace doesn't address on its own.
  it("does not hang on a large adversarial pattern set within the configured caps", () => {
    const patterns = Array.from({ length: 50 }, () => ("+(a|b)".repeat(30) + "*".repeat(10)).slice(0, 200));
    const start = Date.now();
    const result = matchesBranchPattern("feature/some-branch-name", patterns);
    expect(Date.now() - start).toBeLessThan(500);
    expect(result).toBeUndefined();
  });

  // DoS regression test (code-review pass): a single extglob-negation
  // pattern well within the 50-pattern/200-char caps causes exponential-time
  // blowup in minimatch (verified separately to hang indefinitely / OOM
  // without noext) — a distinct vector from the brace-expansion and
  // +(a|b)-style patterns covered above, neither of which exercised
  // negation. noext disables extglob syntax entirely, closing this.
  it("does not hang on extglob negation patterns (DoS fix)", () => {
    const attackPattern = "!(a)".repeat(30);
    const start = Date.now();
    const result = matchesBranchPattern("feature/some-branch", [attackPattern]);
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBeUndefined();
  });

  // DoS regression test (code-review pass): plain, fully-documented BR-2
  // syntax (multiple `*` wildcards in one pattern) causes catastrophic
  // regex backtracking in minimatch that no minimatch option closes —
  // unlike the brace/extglob/negate cases above, this needs no malicious
  // pattern authorship at all, just an ordinary multi-wildcard convention
  // plus a non-matching branch name of realistic length. A pattern over
  // MAX_WILDCARDS_PER_PATTERN is treated as skipped (never matching),
  // not a hang.
  it("does not hang on a pattern with many wildcards against a long non-matching branch name (DoS fix)", () => {
    const manyWildcardsPattern = "a*a*a*a*a*a*b"; // 6 wildcards
    // Must share characters with the pattern (all "a"s) to actually force
    // catastrophic backtracking — a branch name with no matching prefix
    // fails fast on its own regardless of wildcard count, which would make
    // this test pass even without the fix.
    const adversarialBranchName = "a".repeat(600);
    const start = Date.now();
    const result = matchesBranchPattern(adversarialBranchName, [manyWildcardsPattern]);
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toBeUndefined();
  });

  it("still matches a legitimate few-wildcard pattern within the budget", () => {
    expect(matchesBranchPattern("release-1-2-hotfix-3", ["release-*-*-hotfix-*"])).toBe("release-*-*-hotfix-*");
  });
});

describe("matchesPrTemplateMarker", () => {
  it("matches a marker case-insensitively and returns the matched marker", () => {
    expect(matchesPrTemplateMarker("- [x] AI-ASSISTED\nSome description", ["ai-assisted"])).toBe(
      "ai-assisted"
    );
  });

  it("does not match when the marker is absent", () => {
    expect(matchesPrTemplateMarker("Just a normal PR description", ["ai-assisted"])).toBeUndefined();
  });

  it("does not match against a null/undefined body", () => {
    expect(matchesPrTemplateMarker(null, ["ai-assisted"])).toBeUndefined();
    expect(matchesPrTemplateMarker(undefined, ["ai-assisted"])).toBeUndefined();
  });

  // Regression test (code-review pass): a marker with incidental leading/
  // trailing whitespace (easy to introduce via YAML formatting) must still
  // match — the non-blank guard checked the trimmed value, but the actual
  // comparison previously used the untrimmed one, so a padded marker could
  // pass the guard yet never match any real PR body.
  it("matches a marker with incidental leading/trailing whitespace", () => {
    expect(matchesPrTemplateMarker("This change is ai-generated.", [" ai-generated "])).toBe(" ai-generated ");
  });

  // Regression test (BR-3): String.includes("") is always true, so a
  // blank/whitespace-only marker must be skipped rather than matching
  // every non-empty PR body.
  it("skips blank and whitespace-only markers instead of matching every body", () => {
    expect(matchesPrTemplateMarker("Just a normal PR description", [""])).toBeUndefined();
    expect(matchesPrTemplateMarker("Just a normal PR description", ["   "])).toBeUndefined();
    expect(
      matchesPrTemplateMarker("Just a normal PR description with [ai-generated] tag", ["", "[ai-generated]"])
    ).toBe("[ai-generated]");
  });
});
