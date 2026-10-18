// Phase 3 — DESUGAR. Source to source: the pass takes an AST and returns an AST.
//
// A sugar is a construct that MEANS another construct the language already has.
// The pass rewrites the sugar here, so phases 4 and 5 see fewer shapes. A phase
// cannot mishandle a shape it never sees. That is the whole argument for the
// pass: a lowering phase that recognises sugar itself must recognise it in
// every loop that lowers, and a loop that does not know a form mis-lowers it
// silently.
//
// TWO PROPERTIES OF THE PASS.
//
// 1. The rules run in a FIXED ORDER. The write normalisations come first,
//    because every rule after them assumes `op` is `=`. The field-path fold
//    comes before the mutators, because a mutator's target is a path. Where two
//    rules cannot match one input, the order is declaration order and nothing
//    more.
//
// 2. The pass REPEATS until nothing changes, because a rewrite can produce more
//    sugar, and folding runs between the rounds:
//      const k = "name"; $.items.map(k)
//        → $.items.map("name")        the constant is inlined
//          → $.items.map(x => x.name)   the shorthand becomes an arrow
//
// See docs/specs/desugar-pass.md for the form-by-form rules and the full order.

import type { FuncDecl, Program, UpdateFilter, UpdateOp } from "../../registry/ast.ts";
import { writeInValueOf, functionInValueOf } from "../parse/parser.ts";
import { applyRules } from "./desugar-rules.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { fold } from "./fold.ts";
import { mapTreeIn } from "./walk.ts";

/**
 * A backstop on rounds, far above anything a program reaches. It is NOT how the
 * pass tells a fixpoint from a cycle — the tree hash below does that: a round
 * that produces a tree already seen is a cycle, whatever its number. A fixed
 * round limit is the wrong test, because a chain of declarations, where each one
 * needs the previous one folded and a rule run, advances one link per round, and
 * a developer may write as many links as they like.
 */
const MAX_ROUNDS = 100_000;

/** The tree as text with positions erased. This way, two rounds that differ only in `pos` compare equal. */
const fingerprint = (program: Program): string => JSON.stringify(program, (k, v) => (k === "pos" ? 0 : v));

// ── the driver ───────────────────────────────────────────────────────────────

/**
 * A write stands only where a statement may stand. The parser reads `[$.x++]`
 * as a pipeline element, because only the position pass knows that the array
 * in `$.y = [$.x++]` is a value. This check runs once, before any rule rewrites
 * a write, so the refusal quotes the write as the developer spelled it: the
 * refusal that `$.y = $.x++` gets.
 */
function refuseWritesInValues(program: Program, root: RootWhere): void {
  mapTreeIn(program, root, edge, (node, where) => {
    if (where.at === "statement" || where.at === "updateDoc") return node;
    const t = (node as { type: string }).type;
    if (t === "UpdateFilter" || t === "AssignExpr" || t === "DeleteStmt") {
      throw writeInValueOf(node as UpdateOp | UpdateFilter);
    }
    if (t === "FuncDecl") throw functionInValueOf(node as FuncDecl);
    return node;
  });
}

/** What one round did, so the caller can tell a fixpoint from a cycle. */
export type DesugarResult = { program: Program; rounds: number };

/**
 * Where the ROOT of a program stands. There are four entry points and four
 * answers, and no program can tell them apart on its own:
 *
 *   jsmql(<pipeline>)  a `;`-separated program        → STATEMENT
 *   jsmql(<filter>)    one predicate, no `;`          → FILTER
 *   jsmql.expr(...)    one aggregation expression     → VALUE
 *   jsmql.update(...)  the object form of an update   → UPDATE_DOC
 *
 * `shapeOf` decides between the first two; the other two are the caller's own
 * fact. `edge` answers every step below the root.
 */
export type RootWhere = Where;

/**
 * The function applies every rule, repeatedly, until a whole round changes
 * nothing.
 *
 * Identity is the test: `mapTree` returns the same object when no rule fires,
 * so a round that produces the same reference is the fixpoint.
 */
export function desugarVerbose(program: Program, root: RootWhere = STATEMENT): DesugarResult {
  refuseWritesInValues(program, root);
  let current: Program = program;
  const seen = new Set<string>([fingerprint(program)]);
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let next = applyRules(current, root);
    // Folding runs AFTER the rules in each round, and the two feed each other.
    // A mutator statement has by now become a plain assignment, so "was this
    // name written to" is one question rather than a list of method names. A
    // constant the fold inlines becomes a literal the rules can match next round:
    //   const k = "name"; $.items.map(k)   →   map("name")   →   map(x => x.name)
    next = fold(next);
    if (next === current) return { program: current, rounds: round };
    // A tree seen in an earlier round means two rules undo each other's work —
    // a bug in the table, never a fact about the source.
    const print = fingerprint(next);
    if (seen.has(print)) {
      throw new Error(
        `jsmql internal error (please report): the desugar pass cycled after ${round} rounds — two rules are rewriting each other's output.`,
      );
    }
    seen.add(print);
    current = next;
  }
  throw new Error(`jsmql internal error (please report): the desugar pass did not settle after ${MAX_ROUNDS} rounds.`);
}

export function desugar(program: Program, root: RootWhere = STATEMENT): Program {
  return desugarVerbose(program, root).program;
}
