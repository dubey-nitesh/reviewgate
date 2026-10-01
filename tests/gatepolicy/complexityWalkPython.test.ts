import { describe, expect, it } from "vitest";
import { extractFunctionComplexities } from "../../src/gatepolicy/complexity";

// Every test exercises the Python dispatch path through the same public
// extractFunctionComplexities boundary complexity.test.ts uses for
// TS/JS — complexityWalkPython.ts's walk() isn't exported.
function extractPy(source: string) {
  return extractFunctionComplexities("test.py", source);
}

describe("extractFunctionComplexities — Python (BR-4)", () => {
  it("a function with no decision points has complexity 1", () => {
    const results = extractPy("def foo():\n    return 1\n");
    expect(results).toContainEqual({ name: "foo", complexity: 1, location: "line 1" });
  });

  it("counts if/elif separately, but not the trailing else", () => {
    const results = extractPy(
      "def foo(x):\n    if x > 0:\n        pass\n    elif x < 0:\n        pass\n    elif x == 0:\n        pass\n    else:\n        pass\n    return x\n"
    );
    // base 1 + if + elif + elif = 4 (else contributes nothing)
    expect(results).toContainEqual({ name: "foo", complexity: 4, location: "line 1" });
  });

  it("counts for and while loops", () => {
    const results = extractPy("def foo():\n    for i in range(10):\n        pass\n    while True:\n        break\n");
    expect(results).toContainEqual({ name: "foo", complexity: 3, location: "line 1" });
  });

  it("counts each except clause on one try independently", () => {
    const results = extractPy(
      "def foo():\n    try:\n        risky()\n    except ValueError:\n        pass\n    except TypeError:\n        pass\n"
    );
    // base 1 + 2 except clauses = 3
    expect(results).toContainEqual({ name: "foo", complexity: 3, location: "line 1" });
  });

  it("counts each boolean and/or occurrence", () => {
    const results = extractPy("def foo(a, b, c):\n    return a and b or c\n");
    // "a and b or c" -> one "and" boolean_operator, one "or" boolean_operator = 2
    expect(results).toContainEqual({ name: "foo", complexity: 3, location: "line 1" });
  });

  it("counts a comprehension's if clause as a decision point", () => {
    const results = extractPy("def foo():\n    return [x for x in range(10) if x % 2 == 0]\n");
    expect(results).toContainEqual({ name: "foo", complexity: 2, location: "line 1" });
  });

  it("does not count match/case (explicitly out of scope, BR-4)", () => {
    const results = extractPy(
      'def foo(cmd):\n    match cmd:\n        case "go":\n            pass\n        case "stop":\n            pass\n        case _:\n            pass\n'
    );
    // Deliberately undercounts — match/case is a documented gap, not a
    // silent miscount: this assertion pins the CURRENT (limited) behavior
    // so a future wave that adds match/case support changes this test on
    // purpose, not by accident.
    expect(results).toContainEqual({ name: "foo", complexity: 1, location: "line 1" });
  });

  it("scopes decision points to the innermost enclosing function, not the outer one", () => {
    const results = extractPy("def outer(a):\n    def inner(b):\n        if b:\n            return 1\n    if a:\n        return 2\n");
    expect(results).toContainEqual({ name: "outer", complexity: 2, location: "line 1" });
    expect(results).toContainEqual({ name: "inner", complexity: 2, location: "line 2" });
  });

  it("finds multiple top-level functions independently", () => {
    const results = extractPy("def a():\n    pass\ndef b(x):\n    if x:\n        pass\n");
    expect(results).toHaveLength(2);
    expect(results).toContainEqual({ name: "a", complexity: 1, location: "line 1" });
    expect(results).toContainEqual({ name: "b", complexity: 2, location: "line 3" });
  });

  it("does not throw on malformed Python input", () => {
    expect(() => extractPy("def foo(:::: not valid")).not.toThrow();
    expect(() => extractPy("")).not.toThrow();
  });

  it("returns [] for an unrecognized extension rather than attempting TS/JS parsing", () => {
    expect(extractFunctionComplexities("README.md", "def foo(): pass")).toEqual([]);
  });

  // A first attempt at strengthening this test (per a code-review
  // finding that the original ".not.toThrow()"-only version wouldn't
  // catch a regression to build-and-return semantics) asserted that
  // `good`'s entry survives — but that's actually the WRONG expectation
  // for this specific depth/construct: verified directly (a disposable
  // script) that tree-sitter's own `parser.parse()` throws ("Invalid
  // argument") for the ENTIRE file at this depth of nested blocks, before
  // any walking starts at all — so `good()` is never visited and CANNOT
  // survive, regardless of whether extractPythonFunctionComplexities
  // mutates a shared array or builds-and-returns. This matches
  // complexity.ts's own equivalent TS/JS test exactly (same depth, same
  // nested-`if`-block construct, same `toEqual([])` expectation — see
  // "fails open (returns no functions found) instead of throwing on
  // pathologically deep nesting" in complexity.test.ts) and that file's
  // own honest documented admission that the OTHER scenario (parse
  // succeeds, only the JS-call-stack walk overflows partway through,
  // which is where partial-results preservation actually matters) needs
  // deeply nested *expressions*, not blocks, and lands at a depth that's
  // "a race between tree-sitter's native recursion limit and V8's JS
  // call-stack limit" — environment-dependent, deliberately not pinned
  // to a specific committed test there either. Same honesty applied here
  // rather than asserting something this construct doesn't actually
  // exercise.
  it("fails open (returns no functions found) instead of throwing when parser.parse() itself throws on deeply nested blocks", () => {
    const depth = 6000;
    const source = "def good():\n    return 1\n\ndef bad():\n" + "if True:\n".repeat(depth) + "    pass\n";
    expect(() => extractPy(source)).not.toThrow();
    expect(extractPy(source)).toEqual([]);
  });

  // The property complexity.ts's own header comment documents (a
  // caller-supplied `results` array is mutated, not built-and-returned,
  // so a JS-call-stack overflow *during the walk itself* — distinct from
  // parser.parse() throwing — preserves whatever was already collected)
  // is verified by reading extractPythonFunctionComplexities's actual
  // signature and complexity.ts's dispatch code (both take/mutate the
  // same `results` reference the TS/JS branch does), not by a
  // depth-specific test — matching complexity.test.ts's own precedent of
  // leaving that exact boundary uncommitted as a test, for the reason
  // explained in the test above.
});
