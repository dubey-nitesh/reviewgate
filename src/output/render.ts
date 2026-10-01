// Generic check-run/comment block composer.
//
// BR-5. Deliberately has no knowledge of which feature produced which
// block — a future feature adding a fourth block needs no change here.

// Refinement made during implementation: the original design had
// OutputBlock carry a separate `title` field, but checkRunSummary
// returns plain text with no embedded label while checkConsistencySummary
// already embeds its own "**Consistency**:" label directly in the
// returned string (asserted by existing tests —
// tests/consistency/checker.test.ts's "renders a Consistency section"
// test checks for that exact substring). Changing checkConsistencySummary
// to stop embedding its label, so this module could add one uniformly,
// would violate NFR-4-3 (the consistency checker's already-shipped,
// already-tested output contract must not change) for no real benefit.
// Simpler and equally correct: each caller's content is already fully
// self-labeled by the time it becomes a block's body (index.ts adds
// "**Authorship**:" for the authorship-detection module's content at the
// call site, since checkRunSummary itself stays untouched); this module
// only knows about assembling bodies, not titles.
export interface OutputBlock {
  body: string; // "" omits the block entirely
}

// BR-5: keeps the existing bold-label convention (`**Label**:` followed
// by content, each label already embedded in its block's body — see the
// note above) rather than introducing Markdown headings — separates each
// present block with a `---` horizontal rule for clearer visual scanning.
// An empty body omits the block entirely: no separator for it either. A
// repo with only one wave's content enabled sees just that one block,
// with no leading/trailing separator — same as today's single-block
// output, just now composed generically rather than concatenated ad hoc.
export function composeCheckRunBody(blocks: OutputBlock[]): string {
  return blocks
    .map((block) => block.body)
    .filter((body) => body.length > 0)
    .join("\n\n---\n\n");
}
