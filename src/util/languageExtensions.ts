// Shared per-language extension registry (multi-language expansion).
// Replaces two independently-duplicated TS_JS_EXTENSIONS constants
// (formerly in src/consistency/baseline.ts and src/gatepolicy/checker.ts)
// with one source of truth.
//
// Lives in src/util/, not src/consistency/ (where it was first drafted)
// — moved
// after discovering src/gatepolicy/checker.ts's own header comment
// documents a deliberate, pre-existing "no dependency on
// src/consistency/*" boundary (the gate-policy module's own Application
// Design decision, unrelated to this registry's own Question 1/2).
// Putting the shared registry in src/consistency/ would have silently
// violated that boundary the moment gatepolicy/checker.ts needed to
// import it. src/util/ already holds githubContent.ts, a precedent for
// exactly this shape: a dependency-free module both the consistency
// checker and gate policy import from independently without either
// depending on the other.
//
// BR-1 (deterministic, total language resolution) and BR-5
// (same-language-family sibling filtering, G6's authoritative rule).

export type LanguageFamily = "ts-js" | "python";

const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const PYTHON_EXTENSIONS = [".py"];

export const SUPPORTED_EXTENSIONS: readonly string[] = [...TS_JS_EXTENSIONS, ...PYTHON_EXTENSIONS];

// BR-1: total (every recognized extension maps to exactly one family) and
// deterministic (same input always resolves the same way). An
// unrecognized extension resolves to undefined — not an error, not a
// fallback to any particular family.
export function languageFamilyOf(filename: string): LanguageFamily | undefined {
  if (TS_JS_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    return "ts-js";
  }
  if (PYTHON_EXTENSIONS.some((ext) => filename.endsWith(ext))) {
    return "python";
  }
  return undefined;
}

export function isSupportedFile(filename: string): boolean {
  return languageFamilyOf(filename) !== undefined;
}

// BR-5 / G6: the single predicate every sibling-filtering call site uses.
// Both files must resolve to a defined, equal family — an unrecognized
// extension on either side is never "the same family" as anything,
// including another unrecognized extension.
export function isSameLanguageFamily(fileA: string, fileB: string): boolean {
  const familyA = languageFamilyOf(fileA);
  if (familyA === undefined) {
    return false;
  }
  return familyA === languageFamilyOf(fileB);
}
