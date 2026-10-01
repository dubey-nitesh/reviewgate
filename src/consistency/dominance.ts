// Shared "minimum sample size + dominance threshold" gate, per BR-3/BR-4.
// Extracted during a code-review pass: naming.ts's dominantConvention and
// errorHandling.ts's dominantPattern independently re-implemented the same
// algorithm — one generalized over a Map<NamingCase, number>, one
// hand-unrolled over a boolean's two buckets. naming.ts's own comment had
// already flagged the risk ("the two gates otherwise look like the same
// constant copy-pasted with a typo") without extracting it; this closes
// that gap. Each caller still owns its own MIN_SAMPLE_SIZE constant (5 vs.
// 3 — intentionally different, documented at each call site), passed in
// explicitly rather than hardcoded here.
export function resolveDominant<T>(
  counts: Map<T, number>,
  total: number,
  minSampleSize: number,
  dominanceThreshold: number
): T | undefined {
  if (total < minSampleSize) {
    return undefined;
  }
  let best: T | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  if (best === undefined || bestCount / total < dominanceThreshold) {
    return undefined;
  }
  return best;
}
