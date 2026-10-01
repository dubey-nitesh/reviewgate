// Python-grammar-specific McCabe complexity decision-point counting
// (multi-language expansion). Mirrors complexity.ts's existing TS/JS
// walk's output shape (FunctionComplexity) exactly.
//
// BR-4.
//
// Grammar node types below were verified empirically against the pinned
// tree-sitter-python version via a disposable scratch script (this
// project's established discipline), not assumed. Notably:
// - `elif` is its own `elif_clause` node, a direct sibling of
//   `if_statement` (not nested inside an `else_clause` the way JS's
//   `else if` is) — counting every elif_clause node directly gives each
//   elif its own decision point with no special-casing needed, the exact
//   analog of complexity.ts's own "counting every if_statement naturally
//   counts each else-if too" comment for the TS/JS grammar.
// - `match`/`case` produces `match_statement`/`case_clause` node types —
//   distinct from everything below, so BR-4's "match/case out of scope"
//   decision is enforced by omission (these types are simply never
//   checked), not a special exclusion.
// - `except* X:` (Python 3.11+ exception groups) produces a distinct
//   `except_group_clause` node, found during grammar verification and
//   included alongside `except_clause` — the same "each clause is its
//   own branch" reasoning applies regardless of which except keyword
//   form is used; this is a grammar-completeness detail, not a new
//   business-rule decision, so no separate approval round was needed.
// - `lambda` expressions are a distinct node type, not `function_definition`
//   — deliberately not walked as a separate FunctionComplexity entry
//   (a lambda body is a single expression, structurally incapable of
//   containing most of the decision-point types below); any decision
//   points inside a lambda's expression (e.g. a boolean_operator) are
//   still counted, folded into whichever enclosing function_definition
//   contains the lambda, since lambda doesn't stop the walk the way a
//   nested function_definition does.

import type Parser from "tree-sitter";
import type { FunctionComplexity } from "./complexity";

const FUNCTION_DEFINITION_TYPE = "function_definition";

// BR-4: if (each elif separately, trailing bare else never counted), for,
// while, each except/except* clause, each boolean and/or occurrence, each
// comprehension if clause (list/set/dict/generator comprehensions all
// share this same if_clause node type — verified, not assumed).
const DECISION_POINT_TYPES = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "except_group_clause",
  "boolean_operator",
  "if_clause",
]);

function countDecisionPoints(node: Parser.SyntaxNode): number {
  // Stops at a nested function's boundary — its decision points belong
  // to its own FunctionComplexity entry, computed separately when the
  // outer walk reaches it. Mirrors complexity.ts's identical rule for
  // TS/JS.
  if (node.type === FUNCTION_DEFINITION_TYPE) {
    return 0;
  }

  let count = DECISION_POINT_TYPES.has(node.type) ? 1 : 0;
  for (const child of node.namedChildren) {
    count += countDecisionPoints(child);
  }
  return count;
}

function walk(node: Parser.SyntaxNode, results: FunctionComplexity[]): void {
  if (node.type === FUNCTION_DEFINITION_TYPE) {
    const body = node.childForFieldName("body");
    const complexity = 1 + (body ? countDecisionPoints(body) : 0);
    results.push({
      // function_definition always has a name field (verified) — unlike
      // TS/JS's arrow-function/callback anonymity problem, Python's only
      // genuinely anonymous function form is `lambda`, which this walker
      // doesn't visit as its own entry at all (see header comment).
      name: node.childForFieldName("name")?.text ?? "<anonymous>",
      complexity,
      location: `line ${node.startPosition.row + 1}`,
    });
  }
  for (const child of node.namedChildren) {
    walk(child, results);
  }
}

// Pure: AST node in, plain data out — mirrors complexity.ts's own
// internal walk() signature exactly (mutates the caller-owned `results`
// array rather than building and returning a fresh one), not just its
// exported function's contract. This matters for fail-open correctness,
// not just style: complexity.ts's own catch block returns `results`
// (whatever was collected before a mid-walk overflow) to preserve
// already-computed functions per BR-2/the 7th code-review pass's fix —
// a build-then-return version here would lose that partial-results
// guarantee for Python specifically, since a stack overflow partway
// through this function would throw before ever returning anything to
// push. Fail-open parsing itself (the try/catch) is complexity.ts's own
// responsibility, same separation of concerns as astWalkPython.ts/ast.ts.
export function extractPythonFunctionComplexities(rootNode: Parser.SyntaxNode, results: FunctionComplexity[]): void {
  walk(rootNode, results);
}
