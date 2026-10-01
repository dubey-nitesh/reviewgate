// Python-grammar-specific AST walk (multi-language expansion). Produces
// the exact same ExtractedIdentifier/ExtractedCatchClause output shape
// ast.ts's existing TS/JS walk() already produces — naming.ts and
// errorHandling.ts consume this output unchanged.
//
// Grammar node types below were verified empirically against the pinned
// tree-sitter-python version via a disposable scratch script (this
// project's established discipline — see ast.ts's own header comment for
// precedent), not assumed from general tree-sitter familiarity. Notably:
// `elif`/`else` are direct siblings of `if_statement` (not nested, unlike
// JS's `else if`); `except X as e:` wraps the type expression in an
// `as_pattern` node (its first named child is the real type, the second
// is the binding target); `match`/`case` produces `match_statement`/
// `case_clause` — distinct node types this walker never matches, which is
// exactly how BR-4's "match/case out of scope" decision is enforced (by
// omission, not a special exclusion check).

import type Parser from "tree-sitter";
import { classifyNamingCase, type ExtractedCatchClause, type ExtractedIdentifier } from "./ast";

// BR-3: `Exception`/`BaseException` are Python's own "catch everything"
// idioms — broad regardless of whether they appear alone or inside a
// tuple alongside other, more specific types (the broad member dominates).
const BROAD_EXCEPTION_NAMES = new Set(["Exception", "BaseException"]);

// `except X:` and `except (A, B):` expose their type expression as the
// except_clause's own first named child (before `block`). `except X as
// e:` wraps that same expression one level deeper, inside an `as_pattern`
// node — verified via grammar dump, not assumed: as_pattern has no
// "value" field name, so its own first named child (before
// as_pattern_target) is the type expression either way.
//
// A redundant-parens single type — `except (Exception):`, with no
// trailing comma — parses as `parenthesized_expression` wrapping the
// identifier, NOT `tuple` (verified via grammar dump: `tuple` only
// appears with a trailing comma, e.g. `(Exception,)`). Found during a
// code-review pass: unwrapping only `as_pattern` and returning
// `parenthesized_expression` unchanged left `typeNode.text` as the
// literal string `"(Exception)"`, which never matched
// `BROAD_EXCEPTION_NAMES`'s bare `"Exception"`/`"BaseException"`
// entries — silently misclassifying a genuinely broad except as narrow
// (a false negative, exactly the failure direction BR-3 exists to
// avoid). `parenthesized_expression` can also appear INSIDE an
// `as_pattern` (`except (Exception) as e:` → as_pattern's own first
// child is itself a parenthesized_expression, verified directly) — so
// both wrapper types are unwrapped in one loop, handling either order
// or (defensively) repeated nesting, not just the one level each
// individual test case happens to exercise.
const TRANSPARENT_WRAPPER_TYPES = new Set(["as_pattern", "parenthesized_expression"]);

function exceptionTypeNode(exceptClause: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  let current: Parser.SyntaxNode | undefined = exceptClause.namedChildren[0];
  if (!current || current.type === "block") {
    return undefined; // bare `except:` — nothing to inspect
  }
  while (current && TRANSPARENT_WRAPPER_TYPES.has(current.type)) {
    current = current.namedChildren[0];
  }
  return current;
}

// BR-3: bare `except:` and `except Exception:`/`except BaseException:`
// (alone or inside a tuple with other types) are broad; a single named
// non-broad type, or a tuple of only non-broad named types, is narrow —
// regardless of tuple length (no count cap). Matches on exact
// type-expression text, same documented-limitation
// class as ast.ts's own instanceof-narrowing check (a same-named type
// imported under a different alias, or accessed via a dotted/attribute
// path other than the bare name, isn't resolved) — not a new limitation
// class this wave introduces.
export function isNarrowExceptClause(exceptClause: Parser.SyntaxNode): boolean {
  const typeNode = exceptionTypeNode(exceptClause);
  if (!typeNode) {
    return false;
  }
  if (typeNode.type === "tuple") {
    const names = typeNode.namedChildren.map((child) => child.text);
    return names.length > 0 && names.every((name) => !BROAD_EXCEPTION_NAMES.has(name));
  }
  return !BROAD_EXCEPTION_NAMES.has(typeNode.text);
}

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

function walkNode(node: Parser.SyntaxNode, identifiers: ExtractedIdentifier[], catchClauses: ExtractedCatchClause[]): void {
  switch (node.type) {
    case "function_definition":
      // Covers both `def` and `async def` — both parse to the same node
      // type, verified via grammar dump; no separate async variant exists
      // at the node-type level, so no special-casing is needed.
      pushIdentifier(identifiers, node.childForFieldName("name"), "function");
      break;
    case "class_definition":
      // Mirrors ast.ts's own EXPORTED_SYMBOL_DECLARATIONS treatment of
      // TS/JS class declarations — Python has no separate
      // interface/type-alias/enum declaration forms to also list here.
      pushIdentifier(identifiers, node.childForFieldName("name"), "exportedSymbol");
      break;
    case "assignment": {
      // Only a plain identifier target counts — mirrors ast.ts's own
      // scope (a tuple/list/attribute/subscript assignment target isn't a
      // single named identifier to classify), not a new limitation this
      // wave introduces.
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") {
        pushIdentifier(identifiers, left, "variable");
      }
      break;
    }
    case "except_clause":
      catchClauses.push({
        narrowed: isNarrowExceptClause(node),
        location: `line ${node.startPosition.row + 1}`,
      });
      break;
    default:
      break;
  }
  for (const child of node.namedChildren) {
    walkNode(child, identifiers, catchClauses);
  }
}

// Pure: AST node in, plain data out — mirrors ast.ts's own walk()
// contract exactly, including recursing into nested scopes (a
// function-local assignment is still counted, same as TS/JS's
// variable_declarator matching anywhere in the tree).
export function walkPython(rootNode: Parser.SyntaxNode): {
  identifiers: ExtractedIdentifier[];
  catchClauses: ExtractedCatchClause[];
} {
  const identifiers: ExtractedIdentifier[] = [];
  const catchClauses: ExtractedCatchClause[] = [];
  walkNode(rootNode, identifiers, catchClauses);
  return { identifiers, catchClauses };
}
