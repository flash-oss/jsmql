// Phase 3 — FOLD. A `const` whose value can be computed is computed, and every
// reference to it becomes the value.
//
//   const msInDay = 24 * 60 * 60 * 1000;  $.elapsedMs > msInDay
//     →  $.elapsedMs > 86400000     →   { "elapsedMs": { "$gt": 86400000 } }
//
// Without it the same program is a pipeline that computes the number on every
// document, in a `$set` the user never asked for, and the result cannot use an
// index. So this is not a size optimisation: it decides which DOCUMENT the
// program becomes.
//
// It runs INSIDE the desugar fixpoint, and the two feed each other:
//   const k = "name"; $.items.map(k)
//     fold    → $.items.map("name")          the shorthand rule can now see it
//     desugar → $.items.map(x => x.name)
// and in the other direction, a mutator statement becomes a plain assignment
// before this pass looks for one, so "was this name written to" is a single
// question rather than a list of mutating method names.

import type { Expr, FuncDecl, LetDecl, PipelineStmt, Program } from "../../registry/ast.ts";
import { ParseError } from "../parse/cursor.ts";
import { asLiteral } from "./literal.ts";
import type { Constants } from "./evaluate.ts";
import { evaluate } from "./evaluate.ts";
import { mapTree, mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

/** A name bound to a value, and the expression that produced it. */
type Folded = { value: unknown; source: Expr };

// ── which names may not be folded ────────────────────────────────────────────

/**
 * Names that keep their runtime binding whatever their value.
 *
 * A name written to after it is bound cannot be replaced by its first value, and
 * a name bound twice has no single value to speak of. `Object.assign(x, …)` is
 * the one mutation that survives desugaring — every array mutator has become a
 * plain assignment by the time this runs, and is caught by the first rule.
 */
function unfoldable(stmts: readonly PipelineStmt[]): ReadonlySet<string> {
  const excluded = new Set<string>();
  const declared = new Set<string>();

  const writtenTo = (node: Any): void => {
    for (const child of nodesIn(Object.values(node))) writtenTo(child);
    if (node.type === "AssignExpr" || node.type === "DeleteStmt") {
      const target = node.target as Any | undefined;
      if (target?.type === "Ident" && typeof target.name === "string") excluded.add(target.name);
    }
    // `Object.assign(x, …)` mutates its first argument in place.
    if (node.type === "MethodCall" && node.name === "assign") {
      const receiver = node.object as Any | undefined;
      const first = (node.args as readonly Any[] | undefined)?.[0];
      if (receiver?.type === "Ident" && receiver.name === "Object" && first?.type === "Ident") {
        excluded.add(first.name as string);
      }
    }
  };

  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (declared.has(stmt.name)) excluded.add(stmt.name);
      declared.add(stmt.name);
    }
    writtenTo(stmt as Any);
  }
  return excluded;
}

const isNode = (v: unknown): v is Any =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

function* nodesIn(value: unknown): Generator<Any> {
  if (Array.isArray(value)) {
    for (const v of value) yield* nodesIn(v);
  } else if (isNode(value)) {
    yield value;
  } else if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) yield* nodesIn(v);
  }
}

// ── substitution ─────────────────────────────────────────────────────────────

/** The names a node binds for the subtree below it, if any. */
function binds(node: Any, key: string): readonly string[] {
  if (node.type === "Lambda" && Array.isArray(node.params)) return node.params as readonly string[];
  if (node.type === "ExprBlock" && key === "ret") {
    return (node.decls as readonly Any[] | undefined)?.map((d) => d.name as string) ?? [];
  }
  return [];
}

/**
 * Replace every free reference to a folded name with the value it holds.
 *
 * "Free" is the whole difficulty. A lambda parameter of the same name is a
 * DIFFERENT variable, and substituting into its body would answer with the
 * constant where the source meant the element:
 *   const x = 100;  $.items.map(x => x + 1)     `x` is the element, not 100
 * The shadowed names travel down with the walk, which is what `mapTreeIn` is for.
 */
function substitute(program: Program, folded: ReadonlyMap<string, Folded>): Program {
  const shadowedBy = (node: object, key: string, here: ReadonlySet<string>): ReadonlySet<string> => {
    const names = binds(node as Any, key);
    if (names.length === 0) return here;
    const next = new Set(here);
    for (const name of names) next.add(name);
    return next;
  };

  return mapTreeIn(program, new Set<string>() as ReadonlySet<string>, shadowedBy, (node, shadowed) => {
    const n = node as Any;
    if (n.type !== "Ident" || typeof n.name !== "string") return node;
    if (shadowed.has(n.name)) return node;
    const hit = folded.get(n.name);
    if (hit === undefined) return node;
    const pos = n.pos as number;
    // A value with a literal spelling goes in as that literal. One without — a
    // Date — goes in as the constant EXPRESSION that produced it, which is just
    // as faithful and just as much a tree the surface could have produced.
    return (asLiteral(hit.value, pos) ?? withPos(hit.source, pos)) as object;
  });
}

/** The same expression, reporting the position of the reference it replaces. */
function withPos(node: Expr, pos: number): Expr {
  return { ...(node as object), pos } as Expr;
}

// ── constant subexpressions ──────────────────────────────────────────────────

/**
 * Replace any subexpression that is already a constant with the value it holds.
 *
 * Substituting a folded name leaves constants sitting in the middle of the tree,
 * and reading them at RUN TIME is pure waste — the answer cannot change:
 *   const o = { a: 1 };  $.x === o.a
 *     without this  → {"$expr":{"$eq":["$x",{"$getField":{"field":"a","input":{"a":1}}}]}}
 *     with it       → {"x": 1}
 * The second can use an index; the first cannot.
 *
 * A value with no MongoDB literal is simply left alone here. Unlike a
 * declaration — which must produce a value or stay a binding — a subexpression
 * is perfectly able to go on being computed at run time.
 */
function foldConstantParts(program: Program): Program {
  return mapTree(program, (node) => {
    const n = node as Any;
    // Already a value, or not an expression at all.
    if (!EVALUABLE.has(n.type)) return node;
    const result = evaluate(n as unknown as Expr, EMPTY);
    if (!result.ok) return node;
    return (asLiteral(result.value, n.pos as number) ?? node) as object;
  });
}

const EMPTY: Constants = new Map();

/**
 * The node types worth asking about. Every other type either cannot be constant
 * or is one already, and asking anyway would rebuild the tree for nothing.
 *
 * `OperatorCall` is deliberately absent: `$add(1, 2)` is the escape hatch, and
 * raw MQL the developer wrote is emitted as written. Folding it would break the
 * property that a pasted pipeline round-trips.
 */
const EVALUABLE: ReadonlySet<string> = new Set([
  "UnaryExpr",
  "BinaryExpr",
  "TernaryExpr",
  "TemplateLiteral",
  "MemberAccess",
  "IndexAccess",
  "MethodCall",
  "NewExpression",
]);

// ── the pass ─────────────────────────────────────────────────────────────────

/** What a value is called when it has no MongoDB literal, for the message. */
function unspellable(value: unknown): string | null {
  if (typeof value === "number" && !Number.isFinite(value)) return Number.isNaN(value) ? "NaN" : String(value);
  return null;
}

/** The statement list a program holds, or null when it holds none. */
function statementsOf(program: Program): readonly PipelineStmt[] | null {
  const root = program as Any;
  if (root.type === "Pipeline") return root.stmts as readonly PipelineStmt[];
  return null;
}

/**
 * Fold every declaration that can be folded, and drop it.
 *
 * The survivors keep their order. When exactly one survives and it is an
 * expression, the `Pipeline` wrapper goes too — which is what turns
 * `const a = 1; $.x === a` into a Filter rather than a pipeline of one predicate.
 */
export function fold(program: Program): Program {
  const stmts = statementsOf(program);
  // No declarations to fold, but a constant subexpression may still be sitting
  // in the tree — `$.x === 1 + 2` reads the same and is smaller as `$.x === 3`.
  if (stmts === null) return foldConstantParts(program);

  const excluded = unfoldable(stmts);
  const folded = new Map<string, Folded>();
  const env = new Map<string, unknown>();
  const survivors: PipelineStmt[] = [];
  let changed = false;

  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" && !excluded.has(stmt.name)) {
      // Substitute what is known so far, so a chain of declarations folds:
      // `const base = 10; const doubled = base * 2;`
      const result = evaluate(stmt.value, env as Constants);
      if (result.ok) {
        const name = unspellable(result.value);
        if (name !== null) {
          throw new ParseError(
            `This constant expression evaluates to ${name}, which has no MongoDB literal. Check the arithmetic — a division by zero, or an exponent out of range.`,
            stmt.pos,
          );
        }
        folded.set(stmt.name, { value: result.value, source: stmt.value });
        env.set(stmt.name, result.value);
        changed = true;
        continue; // the declaration itself emits nothing
      }
    }
    // A name that did not fold must not be read as one further down either.
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      folded.delete(stmt.name);
      env.delete(stmt.name);
    }
    survivors.push(stmt);
  }

  if (!changed) return foldConstantParts(program);

  const rewritten = foldConstantParts(
    substitute({ type: "Pipeline", stmts: survivors, pos: (program as Any).pos as number }, folded),
  );
  const left = (rewritten as { stmts: readonly PipelineStmt[] }).stmts;
  // One EXPRESSION left is a Filter, not a pipeline of one predicate — which is
  // the whole reason `const a = 1; $.x === a` reads as `{ "x": 1 }`.
  //
  // Only an expression. A write or a declaration is a pipeline either way, so
  // unwrapping one would throw away the `;` the source wrote and gain nothing.
  if (left.length === 1) {
    const only = left[0] as Any;
    const isStatement = only.type === "UpdateFilter" || only.type === "LetDecl" || only.type === "FuncDecl";
    if (!isStatement) return only as Program;
  }
  return rewritten;
}

export type { FuncDecl, LetDecl };
