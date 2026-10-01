// Per-function cyclomatic complexity.
//
// BR-1. Deliberately does NOT share src/consistency/ast.ts's Parser/walk
// — its own module-level Parser and AST walk, to
// avoid touching the consistency checker's already-shipped,
// already-tested surface.
//
// Grammar node types below were verified empirically against the pinned
// tree-sitter-typescript version via a disposable scratch script (this
// project's established discipline — see ast.ts's own header comment for
// precedent), not assumed from general tree-sitter familiarity.

import Parser from "tree-sitter";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import TreeSitterTypeScript = require("tree-sitter-typescript");
import TreeSitterPython from "tree-sitter-python";
import { extractPythonFunctionComplexities } from "./complexityWalkPython";
import { languageFamilyOf, type LanguageFamily } from "../util/languageExtensions";

const { typescript } = TreeSitterTypeScript;

export interface FunctionComplexity {
  name: string;
  complexity: number;
  location: string;
}

const FUNCTION_LIKE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

// Function expressions/arrow functions/generator expressions have no name
// field of their own — verified their parent is a variable_declarator
// when assigned to a name (`const x = () => {}`), whose own `name` field
// gives the identifier, or a public_field_definition for a class-field
// arrow function (`class Foo { bar = () => {} }`, found by /code-review —
// this common modern TS/class-property pattern was previously reported
// as "<anonymous>" since only variable_declarator was checked); otherwise
// (e.g. passed inline as a callback) there's no meaningful name to report.
const NAMED_PARENT_TYPES = new Set(["variable_declarator", "public_field_definition"]);

// Found by a fifth /code-review pass: CommonJS-style assignment (`exports.foo
// = function() {}`, `Foo.prototype.bar = function() {}`, `x = function()
// {}`) and object-literal method-value shorthand (`{ foo: function() {} }`)
// were both reported as `<anonymous>` — plausible in AI-generated/bundled
// code (this app's own stated primary target), the same class of gap as
// the class-field fix above, just for two more common parent shapes.
// Verified via grammar dump: an assignment_expression's `left` field is
// either a plain identifier (`x = ...`) or a member_expression (whose own
// `property` field gives the last segment — `bar` for `Foo.prototype.bar`,
// `foo` for `exports.foo`); a pair's `key` field gives the property name
// directly.
// Shared by both `ownName` (a method_definition's own `name` field) and
// the `pair` parent branch below — found by a twelfth /code-review pass,
// verified directly: a class/object method's name can be a computed key
// (`class Foo { [expr]() {} }`) or a string-literal key containing a
// backtick (`class Foo { "a\`b"() {} }`), exactly the same node shapes
// the `pair` branch already handles for object-literal property VALUES
// — but `method_definition` resolves its own name via its own `name`
// field, which the code previously returned unconditionally
// (`ownName.text`) before ever reaching this logic, bypassing it
// entirely. Verified: `class Foo { ["a" + "\`injected\`"]() {} }`
// reported the raw computed-key source (backticks and all) as the name.
// Returns `undefined` (not `<anonymous>` directly) for a key with no
// meaningful bounded name, so callers can decide their own fallback.
function nameFromKeyLikeNode(key: Parser.SyntaxNode | null): string | undefined {
  if (!key) {
    return undefined;
  }
  // Found by a thirteenth /code-review pass, verified via grammar dump: a
  // private class member's name (`#bar`) is its own distinct
  // `private_property_identifier` node type, not `property_identifier` —
  // omitted here, every private method/accessor/field-arrow-function
  // reported `<anonymous>` instead of its real (and already safe,
  // syntactically restricted) name.
  if (
    key.type === "identifier" ||
    key.type === "property_identifier" ||
    key.type === "private_property_identifier" ||
    key.type === "number"
  ) {
    return key.text;
  }
  if (key.type === "string") {
    const content = key.namedChildren.map((child) => child.text).join("");
    return content || undefined;
  }
  // A computed key (`[expr]`) has no static name at all — its `.text` is
  // the raw, arbitrary source of `expr`, not a name.
  return undefined;
}

// Found by a fourteenth /code-review pass, verified via grammar dump: a
// parenthesized function/arrow-function expression — `const x = (() =>
// {});`, or with a TS type assertion/non-null/satisfies wrapped around
// it, e.g. `(() => {}) as Foo`, `(() => {})!`, `(() => {}) satisfies
// Foo` — sits one or more of these transparent-wrapper nodes below its
// real naming parent (`variable_declarator`, `pair`, etc.), not directly
// inside it. Since functionName() only ever inspected `node.parent`
// directly, any of these (an ordinary, common stylistic/formatter
// pattern, not an edge case) defeated name resolution entirely. Skipped
// past here, before any of the naming-parent checks below run.
const TRANSPARENT_WRAPPER_TYPES = new Set([
  "parenthesized_expression",
  "as_expression",
  "satisfies_expression",
  "non_null_expression",
]);

function functionName(node: Parser.SyntaxNode): string {
  const ownName = node.childForFieldName("name");
  if (ownName) {
    return nameFromKeyLikeNode(ownName) ?? "<anonymous>";
  }
  let parent = node.parent;
  while (parent && TRANSPARENT_WRAPPER_TYPES.has(parent.type)) {
    parent = parent.parent;
  }
  if (!parent) {
    return "<anonymous>";
  }
  if (NAMED_PARENT_TYPES.has(parent.type)) {
    // Found by a thirteenth /code-review pass, verified directly: a
    // public_field_definition's `name` field resolves to the exact same
    // node shapes (computed_property_name, string) a `pair`'s `key` field
    // and method_definition's own `name` field do — `class Foo { [k +
    // "x"] = () => {}; }` returned the raw computed-key source text as
    // the name, missed when this branch was written since
    // variable_declarator's own `name` field is always a plain
    // `identifier` and never needed this handling. Routed through the
    // same shared helper as the other two branches.
    const name = nameFromKeyLikeNode(parent.childForFieldName("name"));
    if (name) {
      return name;
    }
  }
  // Found by a fifteenth /code-review pass, verified via grammar dump:
  // compound/logical assignment (`exports.foo ||= function() {}`,
  // `cache.getData ??= function() {}` — a common CommonJS lazy-init/
  // memoization idiom) parses as its own distinct
  // `augmented_assignment_expression` node type, not `assignment_expression`
  // — same `left`/`right` field shape, just missed since only the plain
  // `=` node type was checked.
  if (parent.type === "assignment_expression" || parent.type === "augmented_assignment_expression") {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") {
      return left.text;
    }
    if (left?.type === "member_expression") {
      const property = left.childForFieldName("property");
      if (property) {
        return property.text;
      }
    }
    // Found by a fourteenth /code-review pass, verified directly:
    // bracket/computed-string assignment (`obj['bar'] = function() {}`,
    // `Foo.prototype['bar'] = function() {}`, `exports['foo'] = function()
    // {}`) — the bracket-notation sibling of the dot-notation
    // member_expression case above, and the exact same
    // CommonJS-export/bundled-code family this file already targets —
    // parses as a `subscript_expression`, not `member_expression`, with
    // its own `index` field instead of `property`. Deliberately only
    // `string`/`number` index nodes are accepted here, NOT the full
    // `nameFromKeyLikeNode` type set: unlike a `pair`'s key or a
    // method_definition's name, a subscript's `index` can be a bare
    // `identifier` too (`obj[dynamicKey] = ...`) — but that identifier is
    // a *variable reference* whose runtime value determines the actual
    // property name, not the property name itself. Verified directly
    // that reusing the shared helper unchanged would have misreported
    // "dynamicKey" as the function's name for exactly that dynamic case.
    if (left?.type === "subscript_expression") {
      const index = left.childForFieldName("index");
      const name = index?.type === "string" || index?.type === "number" ? nameFromKeyLikeNode(index) : undefined;
      if (name) {
        return name;
      }
    }
  }
  if (parent.type === "pair") {
    // A computed key (`{ [expr]: function() {} }`) has no static name at
    // all — found by an eighth /code-review pass; a string-literal key's
    // own `.text` includes its surrounding quotes and can be split across
    // multiple named children by an escape sequence — found by ninth and
    // tenth passes respectively. All three handled by the same
    // `nameFromKeyLikeNode` helper `ownName` above also uses (found by a
    // twelfth pass to be needed there too, for `method_definition`'s own
    // name field, which resolves to the exact same node shapes).
    const name = nameFromKeyLikeNode(parent.childForFieldName("key"));
    if (name) {
      return name;
    }
  }
  return "<anonymous>";
}

// BR-1: decision points counted for McCabe complexity. Each is verified
// against the grammar: if_statement (an `else if` is its own nested
// if_statement inside an else_clause, so counting every if_statement node
// naturally counts each `else if` too, with no special-casing needed),
// for_statement, for_in_statement (covers both `for...in` and `for...of`
// — the grammar doesn't distinguish them at the node-type level),
// while_statement, do_statement, switch_case (not switch_default — the
// fallback branch isn't a decision point), catch_clause, and a
// binary_expression whose operator field is "&&" or "||".
function countDecisionPoints(node: Parser.SyntaxNode): number {
  // Stops at a nested function's boundary rather than descending into
  // it — its decision points belong to its own FunctionComplexity entry,
  // computed separately when the outer walk() reaches it, not folded
  // into the enclosing function's count.
  if (FUNCTION_LIKE_TYPES.has(node.type)) {
    return 0;
  }

  let count = 0;
  switch (node.type) {
    case "if_statement":
    case "for_statement":
    case "for_in_statement":
    case "while_statement":
    case "do_statement":
    case "switch_case":
    case "catch_clause":
      count += 1;
      break;
    case "binary_expression": {
      const operator = node.childForFieldName("operator")?.text;
      if (operator === "&&" || operator === "||") {
        count += 1;
      }
      break;
    }
    default:
      break;
  }

  for (const child of node.namedChildren) {
    count += countDecisionPoints(child);
  }
  return count;
}

function walk(node: Parser.SyntaxNode, results: FunctionComplexity[]): void {
  if (FUNCTION_LIKE_TYPES.has(node.type)) {
    const body = node.childForFieldName("body");
    const complexity = 1 + (body ? countDecisionPoints(body) : 0);
    results.push({
      name: functionName(node),
      complexity,
      location: `line ${node.startPosition.row + 1}`,
    });
  }
  for (const child of node.namedChildren) {
    walk(child, results);
  }
}

// This module keeps its OWN per-language parser map, deliberately not
// sharing src/consistency/ast.ts's registry — same reasoning as this
// file's own header comment for why it already has its own Parser/walk
// separate from ast.ts's ("to avoid touching the consistency checker's
// already-shipped, already-tested surface"). That reasoning extends unchanged to the
// multi-language registry itself: two small, independent registries,
// not one shared one, preserves the existing module boundary rather than
// coupling this file to ast.ts's internals for the first time.
const tsJsParser = new Parser();
tsJsParser.setLanguage(typescript);
const pythonParser = new Parser();
pythonParser.setLanguage(TreeSitterPython);

const PARSERS_BY_FAMILY: ReadonlyMap<LanguageFamily, Parser> = new Map([
  ["ts-js", tsJsParser],
  ["python", pythonParser],
]);

// Pure: source text in, plain data out. No I/O, no threshold comparison
// here (that's GatePolicyOrchestrator's job, per BR-1's separation from
// the consistency checker's ast.ts/naming.ts split precedent).
//
// BR-1: "complexity computation never throws." Found by /code-review,
// verified directly: tree-sitter's parser.parse() itself throws (not just
// returns a tree with hasError) on sufficiently deeply-nested source
// (~6000+ nested blocks — plausible for generated/bundled/minified code,
// exactly what this app targets as AI-authored), a distinct failure mode
// from the "malformed input parses but yields odd/empty results" case the
// existing tests already cover.
//
// A further /code-review pass found the first fix (a try/catch around
// only parser.parse()) was itself incomplete: walk()/countDecisionPoints()
// are plain recursive functions with no depth guard, so source with deeply
// nested *expressions* (not blocks) — e.g. ~5000+ nested parentheses,
// well within MAX_FILE_SIZE_BYTES — parses successfully (tree-sitter
// itself doesn't throw in this shallower range) but then overflows the
// JS call stack during the walk, a RangeError distinct from parser.parse's
// own "Invalid argument" throw. Verified directly: depth 3000 walks fine,
// depth 5000 already overflows. The try/catch is widened to cover the
// walk too, since both are the same "attempt to compute complexity for
// this source" operation from this function's fail-open contract's point
// of view — not two separately-guarded steps.
//
// Caught here, at the one place this function's own documented and tested
// "never throws" contract is either true or isn't — not pushed onto every
// caller to remember, matching fetchCoverageFinding's (BR-3) equivalent
// guarantee at its own exported boundary. Any source that can't be
// meaningfully walked, regardless of which step fails, is treated the
// same: no functions found, not an error.
//
// Found by a seventh /code-review pass, verified directly: `results` was
// declared inside the try block, so when walk() overflowed partway
// through a file (e.g. a normal `good()` function followed by a
// pathologically deep `bad()` function), the catch returned a fresh `[]`
// — discarding `good`'s already-computed finding along with `bad`'s,
// even though `good` parsed and walked just fine. This contradicted
// BR-1's own per-*function* fail-open contract ("no finding for that
// function", not "no findings for the whole file"). Fixed by declaring
// `results` outside the try and returning it (whatever was accumulated
// before the failure) from the catch, instead of a fresh array — the
// exact same "keep what's already collected, don't discard it" posture
// this project uses everywhere else a partial-results fail-open applies
// (e.g. checkGatePolicy's own per-PR wall-clock bail-out).
// Takes filename alongside sourceText, to resolve which
// language to parse as (mirrors ast.ts's identical signature change).
// An unrecognized extension yields [] — same "never throws, worst case
// no functions found" contract this function already had, not a new
// `| undefined` variant; callers (checker.ts) already pre-filter with
// isSupportedFile before reaching this call.
export function extractFunctionComplexities(filename: string, sourceText: string): FunctionComplexity[] {
  const results: FunctionComplexity[] = [];
  const family = languageFamilyOf(filename);
  const parser = family !== undefined ? PARSERS_BY_FAMILY.get(family) : undefined;
  if (!parser) {
    return results;
  }
  try {
    const tree = parser.parse(sourceText);
    if (family === "python") {
      extractPythonFunctionComplexities(tree.rootNode, results);
    } else {
      walk(tree.rootNode, results);
    }
  } catch {
    return results;
  }
  return results;
}
