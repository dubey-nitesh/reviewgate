import { describe, expect, it } from "vitest";
import { extractFileAstSummary, type FileAstSummary } from "../../src/consistency/ast";

// Every test in this file exercises the Python dispatch path through the
// same public extractFileAstSummary boundary ast.test.ts uses for TS/JS —
// astWalkPython.ts's walk() isn't exported, matching that file's own
// testing style (test the dispatch function's observable behavior, not
// an internal helper).
function extractPy(source: string): FileAstSummary {
  return extractFileAstSummary("test.py", source)!;
}

describe("extractFileAstSummary — Python identifiers", () => {
  it("extracts a function definition as kind function", () => {
    const summary = extractPy("def foo_bar():\n    pass\n");
    expect(summary.identifiers).toContainEqual({ name: "foo_bar", kind: "function", namingCase: "snake_case" });
  });

  it("extracts an async function definition as kind function (no separate node type)", () => {
    const summary = extractPy("async def foo_bar():\n    pass\n");
    expect(summary.identifiers).toContainEqual({ name: "foo_bar", kind: "function", namingCase: "snake_case" });
  });

  it("extracts a class definition as kind exportedSymbol", () => {
    const summary = extractPy("class MyClass:\n    pass\n");
    expect(summary.identifiers).toContainEqual({ name: "MyClass", kind: "exportedSymbol", namingCase: "PascalCase" });
  });

  it("extracts a module-level assignment as kind variable", () => {
    const summary = extractPy("MAX_COUNT = 5\n");
    expect(summary.identifiers).toContainEqual({ name: "MAX_COUNT", kind: "variable", namingCase: "CONSTANT_CASE" });
  });

  it("extracts a function-local assignment too (walk recurses into function bodies)", () => {
    const summary = extractPy("def f():\n    local_var = 1\n");
    expect(summary.identifiers).toContainEqual({ name: "local_var", kind: "variable", namingCase: "snake_case" });
  });

  it("finds nested function/class definitions, not just top-level ones", () => {
    const summary = extractPy("class Outer:\n    def method_one(self):\n        def inner():\n            pass\n");
    const names = summary.identifiers.map((i) => i.name);
    expect(names).toContain("Outer");
    expect(names).toContain("method_one");
    expect(names).toContain("inner");
  });

  it("does not extract a non-identifier assignment target (tuple/attribute/subscript)", () => {
    const summary = extractPy("a, b = 1, 2\nobj.attr = 1\nd['key'] = 1\n");
    expect(summary.identifiers).toEqual([]);
  });
});

describe("extractFileAstSummary — Python except-clause classification (BR-3)", () => {
  it("marks a bare `except:` as broad (unnarrowed)", () => {
    const summary = extractPy("try:\n    pass\nexcept:\n    pass\n");
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("marks `except Exception:` as broad", () => {
    const summary = extractPy("try:\n    pass\nexcept Exception:\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("marks `except BaseException:` as broad", () => {
    const summary = extractPy("try:\n    pass\nexcept BaseException:\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("marks a single specific named exception type as narrow", () => {
    const summary = extractPy("try:\n    pass\nexcept ValueError:\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(true);
  });

  it("marks a tuple of specific named types as narrow, regardless of count (no cap)", () => {
    const summary = extractPy("try:\n    pass\nexcept (TypeError, KeyError, IndexError, AttributeError):\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(true);
  });

  it("marks a tuple containing Exception alongside specific types as broad (the broad member dominates)", () => {
    const summary = extractPy("try:\n    pass\nexcept (TypeError, Exception):\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("marks `except X as e:` (as-binding) the same as without the binding", () => {
    const narrow = extractPy("try:\n    pass\nexcept ValueError as e:\n    pass\n");
    expect(narrow.catchClauses[0].narrowed).toBe(true);

    const broad = extractPy("try:\n    pass\nexcept Exception as e:\n    pass\n");
    expect(broad.catchClauses[0].narrowed).toBe(false);
  });

  it("marks `except (A, B) as e:` (tuple with as-binding) the same as without the binding", () => {
    const summary = extractPy("try:\n    pass\nexcept (TypeError, KeyError) as e:\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(true);
  });

  // Regression test (code-review pass): a redundant-parens single type
  // (no trailing comma) parses as `parenthesized_expression`, NOT
  // `tuple` — a tuple requires a trailing comma. The original
  // implementation only unwrapped `as_pattern`, so `except (Exception):`
  // left `typeNode.text` as the literal "(Exception)", which never
  // matched BROAD_EXCEPTION_NAMES's bare "Exception" entry — a false
  // negative (broad except silently classified as narrow). Verified by
  // reversion: reverting the parenthesized_expression-unwrapping loop to
  // only unwrap as_pattern makes this test fail.
  it("marks a redundant-parens single broad type as broad, not narrow (parenthesized_expression, not tuple)", () => {
    const bare = extractPy("try:\n    pass\nexcept (Exception):\n    pass\n");
    expect(bare.catchClauses[0].narrowed).toBe(false);

    const withAs = extractPy("try:\n    pass\nexcept (Exception) as e:\n    pass\n");
    expect(withAs.catchClauses[0].narrowed).toBe(false);
  });

  it("marks a redundant-parens single narrow type as narrow", () => {
    const summary = extractPy("try:\n    pass\nexcept (ValueError):\n    pass\n");
    expect(summary.catchClauses[0].narrowed).toBe(true);
  });

  it("finds multiple except clauses on one try independently, each its own entry", () => {
    const summary = extractPy(
      "try:\n    pass\nexcept ValueError:\n    pass\nexcept Exception:\n    pass\nexcept:\n    pass\n"
    );
    expect(summary.catchClauses).toHaveLength(3);
    expect(summary.catchClauses[0].narrowed).toBe(true);
    expect(summary.catchClauses[1].narrowed).toBe(false);
    expect(summary.catchClauses[2].narrowed).toBe(false);
  });
});

describe("extractFileAstSummary — Python fail-open behavior (BR-2)", () => {
  it("returns empty arrays for a file with no matching declarations or except clauses", () => {
    const summary = extractPy("x = 1 + 1\n");
    expect(summary.identifiers.filter((i) => i.kind !== "variable")).toEqual([]);
    expect(summary.catchClauses).toEqual([]);
  });

  it("does not throw on malformed Python input", () => {
    expect(() => extractPy("def foo(:::: not valid")).not.toThrow();
    expect(() => extractPy("")).not.toThrow();
  });

  it("fails open (does not throw, returns a defined empty-ish summary) on pathologically deep nesting", () => {
    const depth = 6000;
    const source = "def foo():\n" + "if True:\n".repeat(depth) + "    pass\n";
    expect(() => extractFileAstSummary("test.py", source)).not.toThrow();
  });
});

describe("extractFileAstSummary — unrecognized extension (BR-1)", () => {
  it("returns undefined for an unrecognized extension, distinct from an empty summary", () => {
    expect(extractFileAstSummary("README.md", "def foo(): pass")).toBeUndefined();
  });
});
