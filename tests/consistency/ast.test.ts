import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { classifyNamingCase, extractFileAstSummary, type FileAstSummary } from "../../src/consistency/ast";

// Every test in this file exercises the TS/JS path — "test.ts" is a
// recognized extension, so extractFileAstSummary never returns
// undefined here; the non-null assertion documents that, rather than
// forcing every call site below to handle a case that can't happen for
// this file's own inputs.
function extractTs(source: string): FileAstSummary {
  return extractFileAstSummary("test.ts", source)!;
}

describe("classifyNamingCase", () => {
  it("classifies CONSTANT_CASE (2+ underscore-separated uppercase segments)", () => {
    expect(classifyNamingCase("MAX_RETRY_COUNT")).toBe("CONSTANT_CASE");
    expect(classifyNamingCase("A_B")).toBe("CONSTANT_CASE");
  });

  it("classifies snake_case (2+ underscore-separated lowercase segments)", () => {
    expect(classifyNamingCase("retry_count")).toBe("snake_case");
    expect(classifyNamingCase("some_value")).toBe("snake_case");
  });

  it("classifies PascalCase, including a single all-caps word (e.g. a type name)", () => {
    expect(classifyNamingCase("MyClass")).toBe("PascalCase");
    expect(classifyNamingCase("URL")).toBe("PascalCase");
  });

  it("classifies camelCase, including a single all-lowercase word", () => {
    expect(classifyNamingCase("fooBar")).toBe("camelCase");
    expect(classifyNamingCase("foo")).toBe("camelCase");
  });

  // Regression test: an earlier draft of this rule made "other"'s own
  // stated example ("starts with _") unreachable, since "contains _"
  // alone (regardless of segment count) would have matched snake_case
  // first. Fixed by requiring 2+ segments for snake_case/CONSTANT_CASE.
  it("classifies a lone leading underscore as other, not snake_case", () => {
    expect(classifyNamingCase("_privateVar")).toBe("other");
  });

  it("classifies mixed case-and-underscore names as other", () => {
    expect(classifyNamingCase("Foo_Bar")).toBe("other");
  });

  it("classifies names starting with a digit or $ as other", () => {
    expect(classifyNamingCase("$scope")).toBe("other");
    expect(classifyNamingCase("2fast")).toBe("other");
  });

  // PBT: every generated string classifies into exactly one of the 5
  // categories and never throws (business-rules.md's Testable Properties
  // table).
  it("always returns one of the 5 categories for any string, never throws", () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const result = classifyNamingCase(name);
        expect(["camelCase", "PascalCase", "snake_case", "CONSTANT_CASE", "other"]).toContain(result);
      })
    );
  });
});

describe("extractFileAstSummary", () => {
  it("extracts a function declaration as kind function", () => {
    const summary = extractTs("function fooBar() {}");
    expect(summary.identifiers).toContainEqual({ name: "fooBar", kind: "function", namingCase: "camelCase" });
  });

  it("extracts a const assigned an arrow function as kind function, not variable", () => {
    const summary = extractTs("const doThing = () => {};");
    expect(summary.identifiers).toContainEqual({ name: "doThing", kind: "function", namingCase: "camelCase" });
  });

  it("extracts a const assigned a function expression as kind function", () => {
    const summary = extractTs("const doThing = function() {};");
    expect(summary.identifiers).toContainEqual({ name: "doThing", kind: "function", namingCase: "camelCase" });
  });

  // Regression test (code-review pass): generator_function_declaration is
  // a distinct grammar node from function_declaration, not a modifier flag
  // on it — verified against the installed tree-sitter-typescript grammar.
  it("extracts a generator function declaration as kind function", () => {
    const summary = extractTs("function* fetchAllItems() {}");
    expect(summary.identifiers).toContainEqual({
      name: "fetchAllItems",
      kind: "function",
      namingCase: "camelCase",
    });
  });

  // Regression test (code-review pass): the `function*() {}` expression
  // form parses to a distinct generator_function node, separate from
  // function_expression/arrow_function.
  it("extracts a const assigned a generator function expression as kind function", () => {
    const summary = extractTs("const genFn = function*() {};");
    expect(summary.identifiers).toContainEqual({ name: "genFn", kind: "function", namingCase: "camelCase" });
  });

  it("extracts a plain const/let/var as kind variable", () => {
    const summary = extractTs("const max_count = 5; let other_val = 1;");
    expect(summary.identifiers).toContainEqual({ name: "max_count", kind: "variable", namingCase: "snake_case" });
    expect(summary.identifiers).toContainEqual({ name: "other_val", kind: "variable", namingCase: "snake_case" });
  });

  it("extracts class/interface/type-alias/enum names as kind exportedSymbol", () => {
    const summary = extractTs(`
      class MyClass {}
      interface IThing {}
      type TAlias = string;
      enum Color { Red, Green }
    `);
    const names = summary.identifiers.filter((i) => i.kind === "exportedSymbol").map((i) => i.name);
    expect(names.sort()).toEqual(["Color", "IThing", "MyClass", "TAlias"]);
  });

  // Regression test (code-review pass): abstract_class_declaration is a
  // distinct grammar node from class_declaration, not a modifier flag on
  // it — verified against the installed grammar; was previously dropped
  // entirely (matched no switch case and wasn't in EXPORTED_SYMBOL_DECLARATIONS).
  it("extracts an abstract class name as kind exportedSymbol", () => {
    const summary = extractTs("abstract class FooService {}");
    expect(summary.identifiers).toContainEqual({
      name: "FooService",
      kind: "exportedSymbol",
      namingCase: "PascalCase",
    });
  });

  it("extracts identifiers regardless of export status (BR: kind doesn't depend on export)", () => {
    const summary = extractTs("export const exportedThing = 1; const localThing = 2;");
    expect(summary.identifiers).toContainEqual({
      name: "exportedThing",
      kind: "variable",
      namingCase: "camelCase",
    });
    expect(summary.identifiers).toContainEqual({ name: "localThing", kind: "variable", namingCase: "camelCase" });
  });

  it("finds nested function/class declarations, not just top-level ones", () => {
    const summary = extractTs(`
      function outer() {
        function inner() {}
        class Nested {}
      }
    `);
    const names = summary.identifiers.map((i) => i.name);
    expect(names).toContain("outer");
    expect(names).toContain("inner");
    expect(names).toContain("Nested");
  });

  it("marks a catch clause narrowed when its body contains an instanceof check", () => {
    const summary = extractTs(`
      try {
        doThing();
      } catch (e) {
        if (e instanceof TypeError) {
          console.log("narrow");
        }
      }
    `);
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(true);
  });

  it("marks a catch clause unnarrowed when its body has no instanceof check", () => {
    const summary = extractTs(`
      try {
        doThing();
      } catch (e) {
        console.log("broad", e);
      }
    `);
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  // Regression test (code-review pass): an instanceof check unrelated to
  // the caught exception must not count as narrowing it.
  it("does not mark a catch narrowed when the instanceof check is unrelated to the caught exception", () => {
    const summary = extractTs(`
      try {
        doThing();
      } catch (e) {
        log(e);
        if (someUnrelatedVar instanceof Array) {
          doOther();
        }
      }
    `);
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  // Verified during a code-review pass (not a bug, documented behavior):
  // a destructured catch parameter has no bound identifier for the caught
  // value itself, so it can never be instanceof-checked within this catch.
  it("does not mark a catch with a destructured parameter as narrowed, even with an instanceof present", () => {
    const summary = extractTs(`
      try {
        doThing();
      } catch ({ message }) {
        if (message instanceof String) {
          log(message);
        }
      }
    `);
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("does not mark a catch with no bound parameter as narrowed", () => {
    const summary = extractTs(`
      try {
        doThing();
      } catch {
        log("failed");
      }
    `);
    expect(summary.catchClauses).toHaveLength(1);
    expect(summary.catchClauses[0].narrowed).toBe(false);
  });

  it("finds multiple catch clauses independently, each with its own location", () => {
    const summary = extractTs(`
      try { a(); } catch (e) { if (e instanceof TypeError) {} }
      try { b(); } catch (e) { log(e); }
    `);
    expect(summary.catchClauses).toHaveLength(2);
    expect(summary.catchClauses[0].narrowed).toBe(true);
    expect(summary.catchClauses[1].narrowed).toBe(false);
    expect(summary.catchClauses[0].location).not.toBe(summary.catchClauses[1].location);
  });

  it("returns empty arrays for a file with no matching declarations or catch clauses", () => {
    const summary = extractTs("1 + 1;");
    expect(summary.identifiers).toEqual([]);
    expect(summary.catchClauses).toEqual([]);
  });

  // Regression: malformed/non-TS input must not throw — tree-sitter is
  // designed for untrusted/partial input (it produces ERROR nodes rather
  // than throwing), and this function must stay fail-open per BR-6.
  it("does not throw on malformed or non-TypeScript input", () => {
    expect(() => extractTs("this is not { valid ts +++ ")).not.toThrow();
    expect(() => extractTs("")).not.toThrow();
  });

  // Regression test (found while fixing the identical defect in the
  // gate-policy module's own AST walk, src/gatepolicy/complexity.ts's
  // extractFunctionComplexities): tree-sitter's own parser.parse() throws
  // (not just returns a tree with hasError) on sufficiently deeply-nested
  // source — a distinct failure mode from the malformed-input case above,
  // which parses fine and just yields odd/empty results. Uncaught, this
  // previously propagated out of extractFileAstSummary and, since
  // checkConsistency has no try/catch around this call either, would have
  // wiped the entire ConsistencyResult for the PR. Verified directly
  // before fixing (a disposable script confirmed the throw).
  it("fails open (returns empty results) instead of throwing on pathologically deep nesting", () => {
    const depth = 6000;
    const source = "function foo() {\n" + "if (a) {\n".repeat(depth) + "return 1;\n" + "}\n".repeat(depth) + "}\n";
    expect(() => extractTs(source)).not.toThrow();
    expect(extractTs(source)).toEqual({ identifiers: [], catchClauses: [] });
  });
});
