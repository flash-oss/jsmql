// Phase 3 — DESUGAR. Source to source: AST in, AST out.
//
// A sugar is a construct that MEANS another construct the language already has.
// Rewriting it here means phases 4 and 5 see fewer shapes, and a shape they never
// see is a shape they cannot mishandle. That is the whole argument for the pass:
// sugar recognised DURING lowering has to be recognised by every loop that
// lowers, and a loop that does not know a form mis-lowers it silently.
//
// TWO PROPERTIES THE AUDITS PROVED NECESSARY.
//
// 1. The rules run in a FIXED ORDER, because twelve pairs of them match the same
//    input and reversing either turns a working query into an error:
//      $ = { hi: $$.filter(t => t.x > 1) };
//        facet first        → [{"$facet":{"hi":[{"$match":{"x":{"$gt":1}}}]}}]
//        replace-root first → "'$$' (current collection) is statement-only"
//
// 2. The pass REPEATS until nothing changes, because a rewrite can produce more
//    sugar:
//      $$ = $$.reduce((a, d) => d.ok ? a.concat(d.items) : a, [])
//        → $$ = $$.filter(d => d.ok); $ = $.items;     still two sugars
//          → $match($.ok); $replaceWith($.items);      now none
//
// See docs/specs/desugar-pass.md for the form-by-form rules and the full order.

import type { AssignOp, BinaryOp, Expr, Program } from "../../registry/ast.ts";
import { ParseError } from "../parse/cursor.ts";
import { mapTree } from "./walk.ts";

/**
 * One rewrite. Returns the node unchanged to decline, or a replacement.
 *
 * A rule never recurses: `mapTree` has already rewritten the children, so the
 * node a rule sees is as reduced as it is going to get.
 */
export type Rule = {
  /** Named after the production it removes, so a failure is traceable to a row. */
  name: string;
  apply: (node: object) => object;
};

/** How many rounds before we conclude a rule pair is cycling. */
const MAX_ROUNDS = 24;

// ── the rules, in the order they are tried ───────────────────────────────────

/** `+=` `-=` `*=` `/=` → `=` over the matching binary operator. */
const COMPOUND: Readonly<Record<string, BinaryOp>> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/" };

/**
 * A write whose target cannot take one. Checked BEFORE the rewrite, or a tailored
 * error becomes valid-looking MQL:
 *   $ += 1     today → "Cannot use compound assignment … on bare '$'"
 *   $ = $ + 1  today → [{"$replaceWith":{"$add":["$$ROOT",1]}}]
 * Rewriting first would turn the first into the second and lose the message.
 */
function refuseNonScalarTarget(target: object, op: AssignOp): void {
  const t = target as { type: string; path?: string };
  const what = t.type === "CollectionRef" ? "'$$'" : t.type === "FieldRef" && t.path === "" ? "bare '$'" : null;
  if (what === null) return;
  throw new ParseError(
    `Cannot use '${op}' on ${what} — it is the whole document, not a scalar. Write the field: '$.<field> ${op} …'`,
    (target as { pos: number }).pos,
  );
}

const compoundAssign: Rule = {
  name: "fieldAssignment",
  apply: (node) => {
    const n = node as { type: string; op?: AssignOp; target?: object; value?: Expr; pos?: number };
    if (n.type !== "AssignExpr" || n.op === undefined) return node;
    const binop = COMPOUND[n.op];
    if (binop === undefined) return node;
    refuseNonScalarTarget(n.target as object, n.op);
    return {
      type: "AssignExpr",
      target: n.target,
      op: "=",
      // The target appears twice: once as the destination, once as the left
      // operand. A FRESH copy, because a later phase compares nodes by identity.
      value: { type: "BinaryExpr", op: binop, left: n.target, right: n.value, pos: n.pos },
      pos: n.pos,
    } as object;
  },
};

/**
 * `++` and `--`, prefix or postfix, on a field or a binding.
 *
 * All four spellings produce the same MQL today, because a write at statement
 * position has no value in MQL and so prefix-versus-postfix cannot be observed.
 * The parser records `value` as a placeholder copy of the target; this overwrites
 * it rather than reading it.
 */
const incDec: Rule = {
  name: "increment",
  apply: (node) => {
    const n = node as { type: string; op?: AssignOp; target?: object; pos?: number };
    if (n.type !== "AssignExpr") return node;
    if (n.op !== "++" && n.op !== "--") return node;
    refuseNonScalarTarget(n.target as object, n.op);
    return {
      type: "AssignExpr",
      target: n.target,
      op: "=",
      value: {
        type: "BinaryExpr",
        op: n.op === "++" ? "+" : "-",
        left: n.target,
        right: { type: "NumberLiteral", value: 1, pos: n.pos },
        pos: n.pos,
      },
      pos: n.pos,
    } as object;
  },
};

/**
 * `x => { return E }` → `x => E`.
 *
 * REQUIRED, not tidiness: the parser builds a zero-declaration `ExprBlock` for
 * this and an empty `$let: { vars: {} }` would otherwise reach the emitter.
 */
const bareReturnBlock: Rule = {
  name: "blockReturn",
  apply: (node) => {
    const n = node as { type: string; decls?: readonly unknown[]; ret?: object };
    if (n.type !== "ExprBlock") return node;
    if (n.decls === undefined || n.decls.length > 0) return node;
    return n.ret as object;
  },
};

/**
 * Every rule, in the order the audits established. Order is load-bearing where
 * two rules match one input; where they cannot collide it is declaration order
 * and nothing more.
 */
export const RULES: readonly Rule[] = [
  // The write normalisations come first: everything downstream assumes `op` is
  // `"="`, including the sugar dispatch that routes a write by its target.
  compoundAssign,
  incDec,
  bareReturnBlock,
];

// ── the driver ───────────────────────────────────────────────────────────────

/** What one round did, so the caller can tell a fixpoint from a cycle. */
export type DesugarResult = { program: Program; rounds: number };

/**
 * Apply every rule, repeatedly, until a whole round changes nothing.
 *
 * Identity is the test: `mapTree` returns the same object when no rule fired, so
 * a round that produces the same reference is the fixpoint.
 */
export function desugarVerbose(program: Program): DesugarResult {
  let current: Program = program;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let next = current;
    for (const rule of RULES) next = mapTree(next, rule.apply);
    if (next === current) return { program: current, rounds: round };
    current = next;
  }
  // Reaching here means two rules undo each other. That is a bug in the rule
  // table, not in the input, so it says so.
  throw new Error(
    `jsmql internal error (please report): the desugar pass did not settle after ${MAX_ROUNDS} rounds — two rules are rewriting each other's output`,
  );
}

export function desugar(program: Program): Program {
  return desugarVerbose(program).program;
}
