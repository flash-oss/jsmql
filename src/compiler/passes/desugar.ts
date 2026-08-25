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
import { arrayLiteralOrderOf, immutableTwinOf, isFieldProperty } from "../rows.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { mapTreeIn } from "./walk.ts";

/**
 * One rewrite. Returns the node unchanged to decline, or a replacement.
 *
 * A rule never recurses: `mapTree` has already rewritten the children, so the
 * node a rule sees is as reduced as it is going to get.
 */
export type Rule = {
  /** Named after the production it removes, so a failure is traceable to a row. */
  name: string;
  /** `where` is the position the node stands in. Most rules do not read it. */
  apply: (node: object, where: Where) => object;
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
 * `MemberAccess` over a `FieldRef` → one dotted `FieldRef`.
 *
 * MQL spells a nested field one way — `"$a.b"` — so the tree should hold it one
 * way too. Every reader downstream then asks ONE question ("is this a FieldRef?")
 * where it would otherwise have to walk a chain to find out.
 *
 * `.length` is the exception, and it is the registry that says so: its row is the
 * only one that is READ rather than called on something a field can hold. So the
 * name decides, and the rule stays blind to the spelling:
 *   $.a.b         → FieldRef("a.b")
 *   $.a.length    → the size of `a`, left alone
 *   $.a.length.b  → FieldRef("a.length.b")   ← a field really called `length`
 *
 * The third case is why the rule collects the WHOLE chain from where it stands
 * instead of folding one link: `.length` declines while it is the last segment,
 * and the `.b` above it then folds straight past it.
 */
const fieldPath: Rule = {
  name: "memberAccess",
  apply: (node) => {
    const n = node as { type: string; object?: object; name?: string };
    if (n.type !== "MemberAccess" || n.name === undefined) return node;
    // A `$`-led segment is not a path segment: MQL paths cannot hold one, and the
    // spelling belongs to the chained stage call (`.$match(…)`).
    if (n.name.startsWith("$") || isFieldProperty(n.name)) return node;
    const segments: string[] = [n.name];
    let base = n.object as { type: string; object?: object; name?: string; path?: string; pos?: number };
    while (base.type === "MemberAccess") {
      const name = base.name as string;
      if (name.startsWith("$")) return node;
      segments.unshift(name);
      base = base.object as typeof base;
    }
    if (base.type !== "FieldRef") return node;
    // The bare `$` has an empty path, so it contributes no leading segment.
    const head = base.path === "" ? [] : [base.path as string];
    return { type: "FieldRef", path: [...head, ...segments].join("."), pos: base.pos } as object;
  },
};

// ── the statement mutators ───────────────────────────────────────────────────
//
// A mutator is the one JavaScript shape whose whole meaning is "write this back":
//   $.items.sort();   is   $.items = $.items.toSorted();
// So the rewrite is a WRITE, and the position matters. In any other position the
// same tree is refused by the row's own message, which is why both rules below
// check `where` before anything else — see position.ts.

type Node = { type: string; pos: number } & Record<string, unknown>;

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

/**
 * The field this mutator writes back to, or null.
 *
 * A field PATH and nothing else: MQL writes a path, so `$.items[0].push(1)` and
 * `$.items.filter(p).sort()` have no destination and are not statements at all.
 * `$$` lands here too, and declining it is what keeps `$$.push(…)` ($unionWith)
 * and `$$.sort(…)` ($sort) out of a rule meant for fields.
 */
function writtenField(node: Node): Node | null {
  const recv = node.object;
  if (!isNode(recv) || recv.type !== "FieldRef" || recv.path === "") return null;
  return recv;
}

/** The write, spelled the way the parser spells `$.a = …;`. */
function writeBack(target: Node, value: object, pos: number): object {
  return {
    type: "UpdateFilter",
    // A FRESH copy of the target for the destination: it appears twice now, and a
    // later phase compares nodes by identity.
    ops: [{ type: "AssignExpr", target: { ...target }, op: "=", value, pos }],
    pos: target.pos,
  };
}

/**
 * `$.a.sort(k);` → `$.a = $.a.toSorted(k);`
 *
 * The twin name comes from the row, never from here — and only a same-argument
 * twin has one, so the arguments are forwarded untouched.
 */
const mutatorTwin: Rule = {
  name: "methodCall",
  apply: (node, where) => {
    if (where.at !== "statement") return node;
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;
    const twin = immutableTwinOf(n.name);
    if (twin === undefined) return node;
    const target = writtenField(n);
    if (target === null) return node;
    return writeBack(
      target,
      { type: "MethodCall", object: target, name: twin, args: n.args, optional: false, pos: n.pos },
      n.pos,
    );
  },
};

/**
 * `$.a.push(9);` → `$.a = [...$.a, 9];`   and the mirror for `.unshift()`.
 *
 * Spread rather than `.concat()`, because they are not the same function:
 * `[1].push([2])` is `[1, [2]]` and `[1].concat([2])` is `[1, 2]`. Spread keeps
 * push's meaning for an array argument; concat would flatten it.
 */
const mutatorSpread: Rule = {
  name: "spreadElement",
  apply: (node, where) => {
    if (where.at !== "statement") return node;
    const n = node as Node;
    if (n.type !== "MethodCall" || typeof n.name !== "string") return node;
    const order = arrayLiteralOrderOf(n.name);
    if (order === undefined) return node;
    const target = writtenField(n);
    if (target === null) return node;
    const spread = { type: "SpreadElement", argument: target, pos: target.pos };
    const args = n.args as readonly object[];
    const elements = order === "receiver, then arguments" ? [spread, ...args] : [...args, spread];
    return writeBack(target, { type: "ArrayLiteral", elements, pos: n.pos }, n.pos);
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
  // Folding a path is independent of every rule above and below it: no rule
  // matches on a MemberAccess, and none builds one.
  fieldPath,
  // AFTER fieldPath, which is what makes `$.a.b.sort()` reach a FieldRef target.
  // Between them the two cover a name at most once: a row carries `immutableTwin`
  // or `asArrayLiteral`, never both.
  mutatorTwin,
  mutatorSpread,
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
    for (const rule of RULES) next = mapTreeIn(next, STATEMENT, edge, rule.apply);
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
