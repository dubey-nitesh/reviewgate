// AST extraction layer. The only module in the consistency checker that touches
// tree-sitter — every downstream module (naming.ts, errorHandling.ts,
// and their tests) works on the plain FileAstSummary shape this
// produces, for testability.
//
// Grammar node types below were verified empirically against the pinned
// tree-sitter-typescript version (childForFieldName("name")/("value"),
// and binary_expression's "operator" field) rather than assumed from
// general tree-sitter familiarity — see the business-rules.md BR-2/BR-3
// classification rules this implements.

import Parser from "tree-sitter";
// tree-sitter-typescript's type declarations use `export = {typescript, tsx}`
// (a plain object, not a default-exportable class/function), which
// esModuleInterop's synthetic-default handling doesn't cover — verified
// `import Parser from "tree-sitter"` (line above) and `import * as X`
// both fail to typecheck against this specific export shape (TS2497).
// `import ... = require(...)` is the TS-blessed way to consume an
// `export =` module regardless of interop settings; eslint's
// no-require-imports doesn't distinguish this from a runtime require()
// call, so it's disabled for this one necessary line only.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import TreeSitterTypeScript = require("tree-sitter-typescript");
// tree-sitter-python's type declarations export a plain grammar object
// directly (no `export = {...}` wrapper the way tree-sitter-typescript
// does) — a normal `import` works here, verified directly rather than
// assumed from the TS/JS grammar's own (different) export shape.
import TreeSitterPython from "tree-sitter-python";
import { walkPython } from "./astWalkPython";
import { languageFamilyOf, type LanguageFamily } from "../util/languageExtensions";

const { typescript } = TreeSitterTypeScript;

export type NamingCase = "camelCase" | "PascalCase" | "snake_case" | "CONSTANT_CASE" | "other";

export interface ExtractedIdentifier {
  name: string;
  kind: "function" | "variable" | "exportedSymbol";
  namingCase: NamingCase;
}

export interface ExtractedCatchClause {
  narrowed: boolean;
  location: string;
}

export interface FileAstSummary {
  identifiers: ExtractedIdentifier[];
  catchClauses: ExtractedCatchClause[];
}

// BR-3 / business-logic-model.md: CONSTANT_CASE and snake_case both
// require at least one underscore separating 2+ segments — a lone
// leading underscore (e.g. "_privateVar") deliberately falls through to
// "other" rather than being misclassified as snake_case.
const CONSTANT_CASE_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;
const SNAKE_CASE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PASCAL_CASE_RE = /^[A-Z][a-zA-Z0-9]*$/;
const CAMEL_CASE_RE = /^[a-z][a-zA-Z0-9]*$/;

export function classifyNamingCase(name: string): NamingCase {
  if (CONSTANT_CASE_RE.test(name)) {
    return "CONSTANT_CASE";
  }
  if (SNAKE_CASE_RE.test(name)) {
    return "snake_case";
  }
  if (PASCAL_CASE_RE.test(name)) {
    return "PascalCase";
  }
  if (CAMEL_CASE_RE.test(name)) {
    return "camelCase";
  }
  return "other";
}

// generator_function is the `const x = function*() {}` expression form,
// distinct from function_expression/arrow_function — verified against the
// installed grammar (a code-review pass found it and
// generator_function_declaration/abstract_class_declaration missing below,
// silently dropping generator functions and abstract classes from both the
// baseline counts and diff-file checks).
const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "generator_function"]);
const EXPORTED_SYMBOL_DECLARATIONS = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
]);

function pushIdentifier(
  identifiers: ExtractedIdentifier[],
  nameNode: Parser.SyntaxNode | null,
  kind: ExtractedIdentifier["kind"]
): void {
  if (!nameNode) {
    return;
  }
  identifiers.push({ name: nameNode.text, kind, namingCase: classifyNamingCase(nameNode.text) });
}

// Scoped to the caught exception's own identifier — found during a
// code-review pass: an unscoped "instanceof anywhere in the body" check
// marks a catch as narrowed even when the instanceof has nothing to do
// with the caught error (e.g. `catch (e) { log(e); if (x instanceof Y)
// {} }`), skewing the baseline toward "narrowed" and letting a genuinely
// unnarrowed diff catch with an incidental unrelated instanceof escape
// detection. Matches on the left operand's exact identifier text —
// doesn't resolve real lexical scoping (a same-named identifier shadowed
// by a nested catch/function would still match), a residual limitation
// consistent with this heuristic's already-documented narrow scope
// (business-rules.md BR-2).
function hasInstanceofCheckOn(node: Parser.SyntaxNode, paramName: string): boolean {
  if (
    node.type === "binary_expression" &&
    node.childForFieldName("operator")?.text === "instanceof" &&
    node.childForFieldName("left")?.text === paramName
  ) {
    return true;
  }
  for (const child of node.namedChildren) {
    if (hasInstanceofCheckOn(child, paramName)) {
      return true;
    }
  }
  return false;
}

function walk(node: Parser.SyntaxNode, identifiers: ExtractedIdentifier[], catchClauses: ExtractedCatchClause[]): void {
  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
      pushIdentifier(identifiers, node.childForFieldName("name"), "function");
      break;
    case "variable_declarator": {
      const valueType = node.childForFieldName("value")?.type;
      const kind = valueType !== undefined && FUNCTION_VALUE_TYPES.has(valueType) ? "function" : "variable";
      pushIdentifier(identifiers, node.childForFieldName("name"), kind);
      break;
    }
    case "catch_clause": {
      const body = node.childForFieldName("body");
      const paramName = node.childForFieldName("parameter")?.text;
      catchClauses.push({
        // No bound parameter (an optional catch binding, `catch { ... }`)
        // means there's nothing to narrow against at this catch's own
        // level — treated as unnarrowed rather than scanning the body for
        // an unrelated instanceof check.
        // A destructured catch parameter (`catch ({ message })`) has no
        // bound identifier for the caught value itself, so paramName is the
        // whole pattern's text (e.g. "{ message }") and can never equal an
        // instanceof left operand — deterministically unnarrowed. Checked
        // during a code-review pass and confirmed correct-by-construction,
        // not a bug: you cannot instanceof-check a value you destructured
        // away (there's no binding left to check).
        narrowed: body && paramName ? hasInstanceofCheckOn(body, paramName) : false,
        location: `line ${node.startPosition.row + 1}`,
      });
      break;
    }
    default:
      if (EXPORTED_SYMBOL_DECLARATIONS.has(node.type)) {
        pushIdentifier(identifiers, node.childForFieldName("name"), "exportedSymbol");
      }
      break;
  }
  for (const child of node.namedChildren) {
    walk(child, identifiers, catchClauses);
  }
}

// Module-level, reused across calls rather than constructed per parse —
// found during a code-review pass: a single PR's consistency check can
// call this dozens of times (each diff file plus up to 10 siblings each),
// and constructing+configuring a fresh Parser every time was pure overhead.
// Safe to share: tree-sitter's parser.parse() is synchronous, and Node's
// single-threaded event loop never overlaps two parse() calls even when
// the surrounding I/O (fetching file content) runs concurrently.
//
// One Parser per LanguageFamily, built once into a small Map — replacing
// the single hardcoded TS/JS-only parser this module used to construct
// directly. Adding a third language means adding one more entry here
// plus one new walker module, not a structural change to this registry
// itself.
const tsJsParser = new Parser();
tsJsParser.setLanguage(typescript);
const pythonParser = new Parser();
pythonParser.setLanguage(TreeSitterPython);

const PARSERS_BY_FAMILY: ReadonlyMap<LanguageFamily, Parser> = new Map([
  ["ts-js", tsJsParser],
  ["python", pythonParser],
]);

// Pure: source text in, plain data out. No file I/O, no size/budget
// enforcement here — those are the sibling-file resolver's (baseline.ts)
// responsibility per BR-6, keeping this function trivially fixture-testable.
//
// Takes filename alongside sourceText (a signature change from the
// TS/JS-only original) so it can resolve which language family to parse
// as, rather than assuming TS/JS unconditionally. Returns undefined for a
// filename whose extension isn't recognized by languageExtensions.ts at
// all (BR-1) — a distinct case from "recognized but failed to parse,"
// which still returns an (empty) FileAstSummary below, matching the
// original TS/JS behavior exactly for that case.
//
// Found while fixing the identical defect in the gate-policy module's own
// AST walk (src/gatepolicy/complexity.ts's extractFunctionComplexities): tree-sitter's
// parser.parse() throws (not just returns a tree with hasError) on
// sufficiently deeply-nested source — plausible in AI-generated/bundled
// code, this app's own stated primary target. Uncaught, this propagated
// out of extractFileAstSummary, out of checkConsistency's per-file loop
// (src/consistency/checker.ts has no try/catch around this call either),
// and wiped the entire ConsistencyResult for the PR — including naming/
// error-handling findings already computed for earlier files. Caught
// here, matching this function's own "pure, fixture-testable" contract
// and the fail-open posture baseline.ts's fetchFileContent already has
// for its own external-call failures: unparseable source yields no
// findings for that file, not a thrown error. Applied identically to the
// new Python path from day one (BR-2), not discovered incidentally in a
// later review round as happened twice before for TS/JS.
export function extractFileAstSummary(filename: string, sourceText: string): FileAstSummary | undefined {
  const family = languageFamilyOf(filename);
  if (family === undefined) {
    return undefined;
  }
  const parser = PARSERS_BY_FAMILY.get(family);
  if (!parser) {
    return undefined;
  }

  const identifiers: ExtractedIdentifier[] = [];
  const catchClauses: ExtractedCatchClause[] = [];
  try {
    const tree = parser.parse(sourceText);
    if (family === "python") {
      const result = walkPython(tree.rootNode);
      identifiers.push(...result.identifiers);
      catchClauses.push(...result.catchClauses);
    } else {
      walk(tree.rootNode, identifiers, catchClauses);
    }
  } catch {
    // Fall through — whatever was collected before the failure (nothing,
    // for a single-file parse throw) is returned below either way.
  }
  return { identifiers, catchClauses };
}
