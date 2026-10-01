import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { extractFunctionComplexities, type FunctionComplexity } from "../../src/gatepolicy/complexity";

// Every test in this file exercises the TS/JS path — "test.ts" is a
// recognized extension, so this never hits the unrecognized-
// extension branch (which returns []); the helper just keeps every
// call site below unchanged from before the filename parameter existed.
function extractTs(source: string): FunctionComplexity[] {
  return extractFunctionComplexities("test.ts", source);
}

describe("extractFunctionComplexities", () => {
  it("a function with no decision points has complexity 1", () => {
    const results = extractTs("function foo() { return 1; }");
    expect(results).toContainEqual({ name: "foo", complexity: 1, location: "line 1" });
  });

  it("counts an if statement as one decision point", () => {
    const results = extractTs("function foo(a) { if (a) { return 1; } return 0; }");
    expect(results).toContainEqual({ name: "foo", complexity: 2, location: "line 1" });
  });

  it("counts each else-if branch as its own decision point", () => {
    const results = extractTs(
      "function foo(a) { if (a === 1) { return 1; } else if (a === 2) { return 2; } else if (a === 3) { return 3; } return 0; }"
    );
    // base 1 + 3 if_statement nodes (the initial if plus two else-if, each its own if_statement)
    expect(results).toContainEqual({ name: "foo", complexity: 4, location: "line 1" });
  });

  it("counts for/while/do-while loops, one point each", () => {
    const results = extractTs(
      "function foo(a) { for (let i = 0; i < a; i++) {} while (a) { a--; } do { a++; } while (a); }"
    );
    expect(results).toContainEqual({ name: "foo", complexity: 4, location: "line 1" });
  });

  it("counts for-in and for-of loops, one point each", () => {
    const results = extractTs("function foo(a) { for (const x of a) {} for (const y in a) {} }");
    expect(results).toContainEqual({ name: "foo", complexity: 3, location: "line 1" });
  });

  it("counts each switch case, but not switch default, as a decision point", () => {
    const results = extractTs(
      "function foo(a) { switch (a) { case 1: break; case 2: break; default: break; } }"
    );
    // base 1 + 2 case labels (default does not count, per BR-1)
    expect(results).toContainEqual({ name: "foo", complexity: 3, location: "line 1" });
  });

  it("counts a catch clause as one decision point", () => {
    const results = extractTs("function foo() { try { risky(); } catch (e) { handle(e); } }");
    expect(results).toContainEqual({ name: "foo", complexity: 2, location: "line 1" });
  });

  it("counts each && and || as its own decision point", () => {
    const results = extractTs("function foo(a, b) { if (a && b || !a) { return 1; } }");
    // base 1 + 1 if_statement + 1 && + 1 || = 4
    expect(results).toContainEqual({ name: "foo", complexity: 4, location: "line 1" });
  });

  it("does not count a ternary expression as a decision point (BR-1's exact enumerated list)", () => {
    const results = extractTs("function foo(a) { return a ? 1 : 2; }");
    expect(results).toContainEqual({ name: "foo", complexity: 1, location: "line 1" });
  });

  it("extracts arrow functions and function expressions assigned to a name", () => {
    const results = extractTs("const doThing = (a) => { if (a) return 1; }; const other = function(a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "doThing", complexity: 2, location: "line 1" });
    expect(results).toContainEqual({ name: "other", complexity: 2, location: "line 1" });
  });

  // Regression test (found by /code-review): a class-field arrow function
  // (`bar = () => {}`) has a public_field_definition parent, not a
  // variable_declarator — previously unreported (reported <anonymous>)
  // since only variable_declarator was checked as a named-parent type.
  it("names a class-field arrow function from its property name", () => {
    const results = extractTs("class Foo { bar = (a) => { if (a) return 1; }; }");
    expect(results).toContainEqual({ name: "bar", complexity: 2, location: "line 1" });
  });

  it("names an unassigned function expression <anonymous>", () => {
    const results = extractTs("[1, 2].forEach(function (a) { if (a) return 1; });");
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 2, location: "line 1" });
  });

  // Regression tests (found by a fifth /code-review pass): CommonJS-style
  // assignment (`exports.foo = function() {}`, `Foo.prototype.bar =
  // function() {}`, plain `x = function() {}`) and object-literal
  // method-value shorthand (`{ foo: function() {} }`) were all reported
  // as <anonymous> — plausible in AI-generated/bundled code, the same
  // class of gap as the class-field fix above, just for two more common
  // parent shapes (assignment_expression, pair).
  it("names a function assigned via a member-expression assignment (CommonJS-style export)", () => {
    const results = extractTs("Foo.prototype.bar = function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "bar", complexity: 2, location: "line 1" });
  });

  it("names a function assigned to a plain identifier", () => {
    const results = extractTs("let x; x = function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "x", complexity: 2, location: "line 1" });
  });

  // Regression test (found by a fifteenth /code-review pass, verified via
  // grammar dump): compound/logical assignment (`exports.foo ||=
  // function() {}`, a common CommonJS lazy-init/memoization idiom) parses
  // as its own distinct augmented_assignment_expression node type, not
  // assignment_expression — same left/right field shape, just a
  // different node type that was never checked.
  it("names a function assigned via a compound/logical assignment operator", () => {
    const results = extractTs("exports.foo ||= function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "foo", complexity: 2, location: "line 1" });
  });

  it("names a function used as an object-literal property value", () => {
    const results = extractTs("const obj = { foo: function (a) { if (a) return 1; } };");
    expect(results).toContainEqual({ name: "foo", complexity: 2, location: "line 1" });
  });

  // Regression tests (found by a fourteenth /code-review pass, verified
  // directly): bracket/computed-string assignment (`obj['bar'] =
  // function() {}`) — the bracket-notation sibling of the dot-notation
  // member_expression case above, and the exact same CommonJS-export/
  // bundled-code family this file already targets — parses as a
  // subscript_expression, not member_expression, and was previously
  // unhandled entirely.
  it("names a function assigned via bracket/computed-string notation", () => {
    const results = extractTs("obj['bar'] = function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "bar", complexity: 2, location: "line 1" });
  });

  it("names a function assigned via a numeric bracket index", () => {
    const results = extractTs("obj[42] = function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "42", complexity: 2, location: "line 1" });
  });

  it("does not report a dynamic bracket index's variable name as the function name", () => {
    // obj[dynamicKey] assigns to whatever property dynamicKey's runtime
    // value names — "dynamicKey" itself is a variable reference, not the
    // actual (unknowable at parse time) property name.
    const results = extractTs("obj[dynamicKey] = function (a) { if (a) return 1; };");
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 2, location: "line 1" });
  });

  // Regression tests (found by the same pass, verified via grammar dump):
  // a parenthesized function/arrow-function expression, optionally with a
  // TS type assertion/non-null/satisfies wrapper around it, sits one or
  // more transparent-wrapper nodes below its real naming parent — an
  // ordinary, common stylistic pattern, not an edge case.
  it("names a parenthesized arrow function assigned to a variable", () => {
    const results = extractTs("const x = ((a) => { if (a) return 1; });");
    expect(results).toContainEqual({ name: "x", complexity: 2, location: "line 1" });
  });

  it("names a parenthesized arrow function through a TS 'as' type assertion", () => {
    const results = extractTs("const x = ((a) => { if (a) return 1; }) as any;");
    expect(results).toContainEqual({ name: "x", complexity: 2, location: "line 1" });
  });

  it("names a parenthesized arrow function through a non-null assertion", () => {
    const results = extractTs("const x = ((a) => { if (a) return 1; })!;");
    expect(results).toContainEqual({ name: "x", complexity: 2, location: "line 1" });
  });

  // Regression test (found by an eighth /code-review pass, verified
  // directly): a computed object-literal key (`{ [expr]: function() {} }`)
  // has no static name at all — its grammar node is
  // computed_property_name, whose `.text` is the raw, arbitrary source of
  // `expr`, not a meaningful bounded name (and, found alongside this,
  // exactly the shape that let PR-diff content inject unescaped markdown
  // into gatePolicySummary's output — see checker.ts's
  // sanitizeForCodeSpan for the render-boundary half of that fix).
  // Reporting <anonymous> here closes the gap at its source too.
  it("does not report a computed object-literal key's raw expression as a name", () => {
    const results = extractTs('const obj = { [key + "y"]: function (a) { if (a) return 1; } };');
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 2, location: "line 1" });
  });

  // Regression test (found by a ninth /code-review pass, verified
  // directly): a string-literal object key's own `.text` includes its
  // surrounding quote characters (`"foo bar"`, quotes and all) —
  // inconsistent with every other named-parent case here, which all
  // yield bare identifier text. Fixed by reading the key's
  // string_fragment child instead. An empty string-literal key has no
  // such child, so it falls back to <anonymous> rather than an empty name.
  it("names a function from a string-literal object key without the surrounding quotes", () => {
    const results = extractTs('const obj = { "foo bar": function (a) { if (a) return 1; } };');
    expect(results).toContainEqual({ name: "foo bar", complexity: 2, location: "line 1" });
  });

  it("reports <anonymous> for a function keyed by an empty string literal", () => {
    const results = extractTs('const obj = { "": function (a) { if (a) return 1; } };');
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 2, location: "line 1" });
  });

  // Regression test (found by a tenth /code-review pass, verified
  // directly): a string-literal key containing any escape sequence (a
  // Windows-style path, plausible in AI-generated/bundled code) is split
  // into multiple named children (string_fragment, escape_sequence,
  // string_fragment, ...) by the grammar — reading only the first
  // silently truncated the name at the first escape instead of just
  // stripping quotes.
  it("does not truncate a string-literal key's name at its first escape sequence", () => {
    const results = extractTs('const obj = { "C:\\\\Users\\\\x": function (a) { if (a) return 1; } };');
    expect(results).toContainEqual({ name: "C:\\\\Users\\\\x", complexity: 2, location: "line 1" });
  });

  it("extracts a generator function declaration and generator function expression", () => {
    const results = extractTs("function* gen() { if (true) yield 1; } const gen2 = function*() { if (true) yield 1; };");
    expect(results).toContainEqual({ name: "gen", complexity: 2, location: "line 1" });
    expect(results).toContainEqual({ name: "gen2", complexity: 2, location: "line 1" });
  });

  it("extracts a class method", () => {
    const results = extractTs("class Foo { method(a) { if (a) return 1; } }");
    expect(results).toContainEqual({ name: "method", complexity: 2, location: "line 1" });
  });

  // Regression tests (found by a twelfth /code-review pass, verified
  // directly): a method_definition resolves its own name via its own
  // `name` field, which the code previously returned unconditionally
  // before ever reaching the pair-parent sanitization logic — bypassing
  // it entirely for a computed or backtick-containing method name, even
  // though method_definition's name field resolves to the exact same
  // node shapes (computed_property_name, string) a `pair`'s key field
  // does.
  it("does not report a computed class-method name's raw expression as a name", () => {
    const results = extractTs('class Foo { ["a" + "b"]() { return 1; } }');
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 1, location: "line 1" });
  });

  it("names a class method from a string-literal name without the surrounding quotes, backtick neutralized only downstream", () => {
    const results = extractTs('class Foo { "a`b"() { return 1; } }');
    expect(results).toContainEqual({ name: "a`b", complexity: 1, location: "line 1" });
  });

  // Regression tests (found by a thirteenth /code-review pass, verified
  // directly): public_field_definition's own `name` field resolves to
  // the exact same node shapes (computed_property_name, string) a
  // `pair`'s key field and method_definition's own name field do, but
  // this branch returned the raw `.text` unconditionally instead of
  // routing through the shared `nameFromKeyLikeNode` sanitizer — missed
  // when this branch was written since variable_declarator's own name
  // field is always a plain identifier and never needed this handling.
  it("does not report a computed class-field key's raw expression as a name", () => {
    const results = extractTs('class Foo { [k + "x"] = (a) => { if (a) return 1; }; }');
    expect(results).toContainEqual({ name: "<anonymous>", complexity: 2, location: "line 1" });
  });

  it("names a class field from a string-literal key without the surrounding quotes", () => {
    const results = extractTs('class Foo { "a b" = () => { return 1; }; }');
    expect(results).toContainEqual({ name: "a b", complexity: 1, location: "line 1" });
  });

  // Regression test (found by the same pass, verified via grammar dump):
  // a private class member's name (`#bar`) is its own distinct
  // private_property_identifier node type, not property_identifier —
  // every private method/accessor/field-arrow-function previously
  // reported <anonymous> instead of its real name.
  it("names a private class method from its #-prefixed identifier", () => {
    const results = extractTs("class Foo { #bar(a) { if (a) return 1; } }");
    expect(results).toContainEqual({ name: "#bar", complexity: 2, location: "line 1" });
  });

  it("names a private class-field arrow function from its #-prefixed identifier", () => {
    const results = extractTs("class Foo { #bar = (a) => { if (a) return 1; }; }");
    expect(results).toContainEqual({ name: "#bar", complexity: 2, location: "line 1" });
  });

  it("scopes decision points to the innermost enclosing function, not the outer one", () => {
    const results = extractTs(
      "function outer(a) { function inner(b) { if (b) return 1; } if (a) return 2; return 0; }"
    );
    expect(results).toContainEqual({ name: "outer", complexity: 2, location: "line 1" });
    expect(results).toContainEqual({ name: "inner", complexity: 2, location: "line 1" });
  });

  it("finds multiple top-level functions independently", () => {
    const results = extractTs("function a() {} function b(x) { if (x) return 1; }");
    expect(results).toHaveLength(2);
    expect(results).toContainEqual({ name: "a", complexity: 1, location: "line 1" });
    expect(results).toContainEqual({ name: "b", complexity: 2, location: "line 1" });
  });

  it("returns an empty array for a file with no functions", () => {
    expect(extractTs("const x = 1;")).toEqual([]);
  });

  it("does not throw on malformed or non-TypeScript input", () => {
    expect(() => extractTs("function foo( { [[[")).not.toThrow();
    expect(() => extractTs("")).not.toThrow();
  });

  // Regression test (found by /code-review, verified directly first):
  // tree-sitter's own parser.parse() throws (not just returns a tree with
  // hasError) on sufficiently deeply-nested source — a distinct failure
  // mode from the malformed-input case above, which parses fine and just
  // yields odd/empty results. Uncaught, this previously propagated out of
  // extractFunctionComplexities entirely, which in checker.ts wiped the
  // whole checkGatePolicy result for the PR, including BR-6's blocking
  // mechanism. Fixed by catching parser.parse() itself and returning no
  // functions found, matching BR-1's documented "never throws" contract.
  it("fails open (returns no functions found) instead of throwing on pathologically deep nesting", () => {
    const depth = 6000;
    const source = "function foo() {\n" + "if (a) {\n".repeat(depth) + "return 1;\n" + "}\n".repeat(depth) + "}\n";
    expect(() => extractTs(source)).not.toThrow();
    expect(extractTs(source)).toEqual([]);
  });

  // Found by a further /code-review pass on the fix above: that fix only
  // wrapped parser.parse() in try/catch, but walk()/countDecisionPoints()
  // are plain recursive functions with no depth guard of their own — a
  // deeply nested *expression* (not block) can parse successfully well
  // before tree-sitter's own native depth limit throws, yet still
  // overflow the JS call stack during the walk.
  //
  // Not covered by a committed unit test here: the exact depth at which
  // parser.parse() succeeds but the JS walk overflows is a race between
  // tree-sitter's native recursion limit and V8's JS call-stack limit,
  // and both were verified directly to shift substantially by execution
  // context — under a plain `node` process, parse succeeds and walk
  // overflows anywhere from ~8,000 to ~15,000 nested parens; under this
  // project's actual vitest runner, parse itself already throws by
  // ~17,000, closing that window entirely for this construct (verified
  // directly, including that a deliberate stack-pre-consumption technique
  // to force the same race independent of nesting depth produces
  // non-deterministic results here — an unacceptable source of CI
  // flakiness, the same category of risk this project's coverage-DoS
  // timing assertion was already loosened once to avoid). The fix itself
  // (wrapping the whole parse+walk computation in one try/catch,
  // documented on extractFunctionComplexities above) was verified
  // directly against a plain `node` process instead, per this project's
  // established scratch-script verification discipline for
  // environment-sensitive findings that can't be reliably automated
  // (see also: Docker build verification, real GitHub App install).

  // PBT: complexity is always a positive integer, extraction never throws
  // (business-rules.md's Testable Properties table).
  it("always returns a positive integer complexity for any function found, never throws", () => {
    fc.assert(
      fc.property(fc.string(), (source) => {
        const results = extractTs(source);
        for (const result of results) {
          expect(Number.isInteger(result.complexity)).toBe(true);
          expect(result.complexity).toBeGreaterThanOrEqual(1);
        }
      })
    );
  });
});
