import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeMetrics, PrEventContext } from "../src/metrics/capture";
import type { Confidence } from "../src/detectors/confidence";

const BASE_EVENT: PrEventContext = {
  prId: 42,
  repo: "acme/widgets",
  openedAt: "2026-01-01T00:00:00Z",
  reviewCommentCount: 0,
};

describe("computeMetrics", () => {
  // Story B1 acceptance criterion: PR receives its first review 3 hours
  // after opening -> timeToFirstReviewMinutes recorded as 180.
  it("computes time-to-first-review in minutes", () => {
    const { metrics, warnings } = computeMetrics(
      { ...BASE_EVENT, firstReviewAt: "2026-01-01T03:00:00Z" },
      "definite"
    );
    expect(metrics.timeToFirstReviewMinutes).toBe(180);
    expect(metrics.timeToMergeMinutes).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  // Story B1 acceptance criterion: PR merged before any review is
  // submitted -> timeToFirstReviewMinutes left unset (not zero), while
  // timeToMergeMinutes is recorded.
  it("leaves timeToFirstReviewMinutes unset when merged before any review", () => {
    const { metrics } = computeMetrics({ ...BASE_EVENT, mergedAt: "2026-01-01T01:00:00Z" }, "none");
    expect(metrics.timeToFirstReviewMinutes).toBeUndefined();
    expect(metrics.timeToMergeMinutes).toBe(60);
  });

  it("leaves both fields unset when neither reviewed nor merged", () => {
    const { metrics } = computeMetrics(BASE_EVENT, "likely");
    expect(metrics.timeToFirstReviewMinutes).toBeUndefined();
    expect(metrics.timeToMergeMinutes).toBeUndefined();
  });

  // BR-4: confidence is passed through verbatim, no re-derivation.
  it("passes confidence through unchanged", () => {
    for (const confidence of ["definite", "likely", "none"] as Confidence[]) {
      expect(computeMetrics(BASE_EVENT, confidence).metrics.confidence).toBe(confidence);
    }
  });

  // BR-2: when both are present and reviewed-after-merged, the invariant is
  // violated -> both fields dropped, a warning recorded.
  it("drops both time-delta fields and warns when review comes after merge", () => {
    const { metrics, warnings } = computeMetrics(
      {
        ...BASE_EVENT,
        mergedAt: "2026-01-01T01:00:00Z",
        firstReviewAt: "2026-01-01T02:00:00Z", // after merge — invalid ordering
      },
      "definite"
    );
    expect(metrics.timeToFirstReviewMinutes).toBeUndefined();
    expect(metrics.timeToMergeMinutes).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  // BR-3: a negative delta (upstream timestamp bug) is dropped, not stored.
  it("drops a negative time-delta field and warns", () => {
    const { metrics, warnings } = computeMetrics(
      { ...BASE_EVENT, firstReviewAt: "2025-12-31T23:00:00Z" }, // before openedAt
      "none"
    );
    expect(metrics.timeToFirstReviewMinutes).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  // Regression test found during a code-review pass: an unparseable
  // timestamp makes Date.parse produce NaN, which passes both `x < 0` and
  // `x > y` comparisons undetected (NaN fails every comparison) — a naive
  // negative-only check would let it through to saveMetrics, which would
  // then fail the Postgres integer column insert instead of being caught
  // here as the "invalid upstream timestamp" this validation exists for.
  it("drops a time-delta field computed from an unparseable timestamp (NaN) and warns", () => {
    const { metrics, warnings } = computeMetrics(
      { ...BASE_EVENT, firstReviewAt: "not-a-valid-timestamp" },
      "none"
    );
    expect(metrics.timeToFirstReviewMinutes).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("passes reviewCommentCount through unchanged", () => {
    expect(computeMetrics({ ...BASE_EVENT, reviewCommentCount: 7 }, "none").metrics.reviewCommentCount).toBe(
      7
    );
  });

  // PBT (Testable Properties table): for any generated event where both
  // deltas are present, timeToFirstReviewMinutes <= timeToMergeMinutes
  // always holds in the output (BR-2) — either both are valid and ordered,
  // or both are dropped.
  it("never outputs an out-of-order time-delta pair", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.constantFrom<Confidence>("definite", "likely", "none"),
        (reviewOffsetMin, mergeOffsetMin, confidence) => {
          const event: PrEventContext = {
            ...BASE_EVENT,
            firstReviewAt: new Date(Date.parse(BASE_EVENT.openedAt) + reviewOffsetMin * 60000).toISOString(),
            mergedAt: new Date(Date.parse(BASE_EVENT.openedAt) + mergeOffsetMin * 60000).toISOString(),
          };
          const { metrics } = computeMetrics(event, confidence);
          if (metrics.timeToFirstReviewMinutes !== undefined && metrics.timeToMergeMinutes !== undefined) {
            expect(metrics.timeToFirstReviewMinutes).toBeLessThanOrEqual(metrics.timeToMergeMinutes);
          }
        }
      )
    );
  });

  // PBT: both time-delta fields, when present in the output, are always
  // non-negative (BR-3).
  it("never outputs a negative time-delta field", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -1000, max: 1000 }),
        fc.constantFrom<Confidence>("definite", "likely", "none"),
        (reviewOffsetMin, mergeOffsetMin, confidence) => {
          const event: PrEventContext = {
            ...BASE_EVENT,
            firstReviewAt: new Date(Date.parse(BASE_EVENT.openedAt) + reviewOffsetMin * 60000).toISOString(),
            mergedAt: new Date(Date.parse(BASE_EVENT.openedAt) + mergeOffsetMin * 60000).toISOString(),
          };
          const { metrics } = computeMetrics(event, confidence);
          if (metrics.timeToFirstReviewMinutes !== undefined) {
            expect(metrics.timeToFirstReviewMinutes).toBeGreaterThanOrEqual(0);
          }
          if (metrics.timeToMergeMinutes !== undefined) {
            expect(metrics.timeToMergeMinutes).toBeGreaterThanOrEqual(0);
          }
        }
      )
    );
  });

  // PBT: reviewCommentCount is a pure passthrough for any generated value.
  it("always passes reviewCommentCount through verbatim (property)", () => {
    fc.assert(
      fc.property(fc.nat(1000), (count) => {
        const { metrics } = computeMetrics({ ...BASE_EVENT, reviewCommentCount: count }, "none");
        expect(metrics.reviewCommentCount).toBe(count);
      })
    );
  });

  // gatePolicyBlocked/consistencyFindingCount are passed through
  // verbatim, same as confidence (BR-4) — no independent validation or
  // re-derivation.
  it("passes gatePolicyBlocked/consistencyFindingCount through verbatim when given", () => {
    const { metrics } = computeMetrics(BASE_EVENT, "definite", {
      gatePolicyBlocked: true,
      consistencyFindingCount: 3,
    });
    expect(metrics.gatePolicyBlocked).toBe(true);
    expect(metrics.consistencyFindingCount).toBe(3);
  });

  it("leaves gatePolicyBlocked/consistencyFindingCount undefined when findingsSummary is omitted", () => {
    const { metrics } = computeMetrics(BASE_EVENT, "definite");
    expect(metrics.gatePolicyBlocked).toBeUndefined();
    expect(metrics.consistencyFindingCount).toBeUndefined();
  });
});
