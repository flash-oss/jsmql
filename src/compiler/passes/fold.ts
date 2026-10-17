// Phase 3 — FOLD. A `const` whose value can be computed is computed, and every
// reference to it becomes the value.
//
//   const msInDay = 24 * 60 * 60 * 1000;  $.elapsedMs > msInDay
//     →  $.elapsedMs > 86400000     →   { "elapsedMs": { "$gt": 86400000 } }
//
// Without fold, the same program becomes a pipeline. The pipeline recomputes the
// number on every document, in a `$set` nobody asked for. The result cannot use
// an index. This is not a size optimisation: it decides which DOCUMENT the
// program becomes.
//
// Fold runs INSIDE the desugar fixpoint, and the two feed each other:
//   const k = "name"; $.items.map(k)
//     fold    → $.items.map("name")          the shorthand rule can now see it
//     desugar → $.items.map(x => x.name)
//
// THE TWO WAYS A FOLD CAN GO WRONG, and what stops each:
//
//   1. It replaces a name that means something else here. A binder of the same
//      name — a lambda parameter, or a declaration in a nested scope — makes a
//      DIFFERENT variable. Substitution through that binder answers with the
//      constant, where the source meant the other variable. `substitute`
//      (substitute.ts) refuses to cross one.
//   2. It replaces a name whose value changes. A write, a mutation, or a second
//      declaration means the first value is not the only one. `unfoldable`
//      collects those names, and they keep their runtime binding.

import type { Expr, PipelineStmt, Program } from "../../registry/ast.ts";
import type { NodeName } from "../../registry/vocabulary.ts";
import { ParseError } from "../parse/cursor.ts";
import type { Constants } from "./evaluate.ts";
import { asDeclaredFunction, evaluate, writeBack } from "./evaluate.ts";
import { bindsFor, declaredIn } from "./naming.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { substitute } from "./substitute.ts";
import { mapTree, mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

const isNode = (v: unknown): v is Any =>
  typeof v === "object" && v !== null && !Array.isArray(v) && typeof (v as { type?: unknown }).type === "string";

// ── which names may not be folded ────────────────────────────────────────────

/** The name a write or a read path is rooted in — `a` for all of `a`, `a.p`, `a[0]`. */
function rootName(node: unknown): string | null {
  let cursor = node;
  while (isNode(cursor) && (cursor.type === "MemberAccess" || cursor.type === "IndexAccess")) {
    cursor = cursor.object;
  }
  return isNode(cursor) && cursor.type === "Ident" && typeof cursor.name === "string" ? cursor.name : null;
}

/**
 * Names that keep their runtime binding whatever their value.
 *
 * Four ways a name's value stops being the one it was bound to. The first two are
 * plain; the last two are the ones that are easy to miss:
 *   a = 2               written to
 *   const a = …         a second time
 *   a.p = 9             written to THROUGH a path — the name still changes
 *   a.sort()            mutated by a call, which is a write with no `=` in it
 */
function unfoldable(stmts: readonly PipelineStmt[]): ReadonlySet<string> {
  const excluded = new Set<string>();
  const declared = new Set<string>();
  const readSoFar = new Set<string>();

  for (const stmt of stmts) {
    // A name READ before it is declared is a `ReferenceError` in JavaScript.
    // The later value would give it a meaning the language does not have. So the
    // declaration keeps its binding, and a later phase reports it.
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (readSoFar.has(stmt.name)) excluded.add(stmt.name);
    }
    // A name BOUND inside the statement — a lambda's parameter — is not a read of
    // the outer name: `$.items.some(k => k > 1); const k = 5` folds `k`.
    for (const name of freeNamesIn(stmt as Any)) readSoFar.add(name);
  }

  // A function whose body reads its OWN name, or a name declared only later, is
  // not settled here: substituting it would never end (recursion) or would carry
  // a name that has no value yet. It stays a binding, inlined where it is called,
  // and the recursion is refused there. A call of an EARLIER function folds.
  const order = declaredIn(stmts);
  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (declared.has(stmt.name)) excluded.add(stmt.name);
      declared.add(stmt.name);
      const body = (stmt.type === "LetDecl" ? (stmt as Any).value : (stmt as Any).lambda) as Any | undefined;
      const later = new Set(order.slice(order.indexOf(stmt.name)));
      if (body?.type === "Lambda" && [...freeNamesIn(body)].some((n) => later.has(n))) excluded.add(stmt.name);
    }
    // Walked WITH positions, because one test below depends on position. A call
    // that IS a statement mutates its receiver: `a.sort();` is the whole
    // statement, and nothing reads its result. The same call in value position
    // returns a new array and leaves the binding alone. The node's shape alone
    // cannot tell this apart: it would read `[xs.slice(1)]` in a value slot as a
    // bracketed pipeline of mutations, and would keep a constant that fold should
    // replace.
    for (const [node, where] of everyNodeWithPosition(stmt as Any)) {
      // A write, however deep the path it writes through.
      if (node.type === "AssignExpr" || node.type === "DeleteStmt") {
        const name = rootName(node.target);
        if (name !== null) excluded.add(name);
      }
      if (node.type !== "MethodCall") continue;
      if (where.at === "statement") {
        const receiver = rootName(node.object);
        if (receiver !== null) excluded.add(receiver);
      }
    }
  }
  return excluded;
}

/** Every bare name a statement reads that no binder inside it introduces. */
function freeNamesIn(stmt: Any): ReadonlySet<string> {
  const out = new Set<string>();
  const step = (node: object, key: string, here: ReadonlySet<string>): ReadonlySet<string> => {
    const names = bindsFor(node, key);
    if (names.length === 0) return here;
    const next = new Set(here);
    for (const n of names) next.add(n);
    return next;
  };
  mapTreeIn(stmt as object, new Set<string>() as ReadonlySet<string>, step, (node, bound) => {
    const n = node as Any;
    if (n.type === "Ident" && typeof n.name === "string" && !bound.has(n.name)) out.add(n.name);
    return node;
  });
  return out;
}

/** Every node of a statement with the position it stands in, the statement itself at STATEMENT. */
function everyNodeWithPosition(stmt: Any): readonly (readonly [Any, Where])[] {
  const out: (readonly [Any, Where])[] = [];
  mapTreeIn(stmt as object, STATEMENT, edge, (node, where) => {
    out.push([node as Any, where]);
    return node;
  });
  return out;
}

// ── constant subexpressions ──────────────────────────────────────────────────

/**
 * Replace any subexpression that is already a constant with the value it holds.
 *
 * Reading a constant at RUN TIME is pure waste — the answer cannot change:
 *   const o = { a: 1 };  $.x === o.a
 *     without this  → {"$expr":{"$eq":["$x",{"$getField":{"field":"a","input":{"a":1}}}]}}
 *     with it       → {"x": 1}
 * The second can use an index; the first cannot.
 *
 * A constant that the engine cannot settle stays as it is, and computes at run time.
 */
function foldConstantParts<T extends object>(node: T, known: Constants = EMPTY): T {
  // The environment travels down and SHRINKS at every binder. A lambda
  // parameter named the same as a declared function is a different thing
  // entirely. Folding `f(1)` against the outer `f` inside `map(f => f(1))`
  // would answer about the wrong one.
  const step = (n: object, key: string, here: Constants): Constants => {
    const names = bindsFor(n, key);
    if (names.length === 0) return here;
    const next = new Map(here);
    for (const name of names) next.delete(name);
    return next;
  };

  return mapTreeIn(node, known, step, (inner, env) => {
    const n = inner as Any;
    // `{ [k]: 1 }` with a constant `k` is `{ "<k>": 1 }` — the key JavaScript would
    // compute. Settled here so the stage rules that take only a written key
    // (`$sort({ [field]: 1 })`) see one, and a document literal stays a document.
    if (n.type === "KeyValueEntry") {
      const key = n.key as { kind: string; expr?: Expr };
      if (key.kind !== "computed" || key.expr === undefined) return inner;
      const computed = evaluate(key.expr, env);
      return computed.ok && typeof computed.value === "string"
        ? ({ ...n, key: { kind: "static", name: computed.value } } as object)
        : inner;
    }
    // a regex node is a constant already, and re-spelling it would lose whether the call supplied it
    if (!EVALUABLE.has(n.type) || n.type === "RegexLiteral") return inner;
    const result = evaluate(n as unknown as Expr, env);
    if (!result.ok) {
      if (result.unspellable !== undefined) throw noLiteralFor(result.unspellable, n.pos as number);
      return inner;
    }
    // Every EVALUABLE node is JSMQL, so each string it computes is text (HR6).
    return writeBack(result.value, n.pos as number) as object;
  });
}

/**
 * Every statement of a list, with its constant parts folded against `known`.
 *
 * ONE STATEMENT at a time, never the list around it. A scope's own declarations
 * are exactly what its statements should see. Descending through the
 * `Pipeline` node would make `bindsFor` hide them along with the nested ones.
 */
function foldPartsIn(stmts: readonly PipelineStmt[], known: Constants): readonly PipelineStmt[] {
  const out = stmts.map((stmt) => foldConstantParts(stmt as unknown as object, known) as unknown as PipelineStmt);
  return out.some((stmt, i) => stmt !== stmts[i]) ? out : stmts;
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
const EVALUABLE_TYPES = [
  "UnaryExpr",
  "BinaryExpr",
  "TernaryExpr",
  "TemplateLiteral",
  "MemberAccess",
  "IndexAccess",
  "MethodCall",
  "CallExpression",
  "NewExpression",
] as const;
/**
 * The expression types deliberately NOT asked about, each for a stated reason. A
 * literal is already the answer, and re-spelling it would rebuild the node every
 * round, so the fixpoint would never settle. A reference, a lambda and a block
 * are not values. `OperatorCall` is the escape hatch above. Together with
 * `EVALUABLE_TYPES` this must cover every `Expr` type. The two lines below turn a
 * new node type into a compile error here, instead of a subexpression that fold
 * silently never folds.
 */
const NOT_ASKED_TYPES = [
  "NumberLiteral",
  "BigIntLiteral",
  "StringLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "UndefinedLiteral",
  "RegexLiteral",
  "ObjectIdLiteral",
  "Injected",
  "ArrayLiteral",
  "ObjectLiteral",
  "FieldRef",
  "StreamRef",
  "DatabaseRef",
  "ClusterRef",
  "Ident",
  "OperatorCall",
  "Lambda",
  "ExprBlock",
] as const;
type ExprType = Extract<Expr, { type: string }>["type"];
type Covered = (typeof EVALUABLE_TYPES)[number] | (typeof NOT_ASKED_TYPES)[number];
const _everyExprIsDecided: [Exclude<ExprType, Covered>] extends [never] ? true : Exclude<ExprType, Covered> = true;
const _onlyExprTypes: [Exclude<Covered, NodeName>] extends [never] ? true : Exclude<Covered, NodeName> = true;
void _everyExprIsDecided;
void _onlyExprTypes;
const EVALUABLE: ReadonlySet<string> = new Set(EVALUABLE_TYPES);

// ── the pass ─────────────────────────────────────────────────────────────────

/**
 * Fold every declaration that can be folded, and drop it.
 *
 * Statements are walked IN ORDER. Fold substitutes each one with what is known
 * at the point it stands. That is not tidiness: a name read before it is
 * declared is a `ReferenceError` in JavaScript, and the later value would give
 * it a meaning the language does not have.
 */
export function fold(program: Program): Program {
  // Every NESTED statement list is a scope of its own and folds in its own right:
  // `$$.aggregate(() => { const a = 2; $match({ b: a }) })` should read 2. An
  // outer constant reaches into one through the substitution below, which stops
  // at any binder of the same name; this is the other direction.
  const foldNested = (node: object): object => {
    const n = node as Any;
    if (n.type !== "Pipeline") return node;
    const inner = foldStatements(n.stmts as readonly PipelineStmt[]);
    const parts = foldPartsIn(inner.stmts, inner.env);
    return inner.changed || parts !== inner.stmts ? ({ ...n, stmts: parts } as object) : node;
  };

  const root = program as Any;
  if (root.type !== "Pipeline") return foldConstantParts(mapTree(program, foldNested) as object) as Program;

  // The root is folded BELOW, by the pass that also decides whether the program
  // collapses to one expression. Walking it here as well would do that work
  // first, and would leave the pass below with nothing to report. The collapse
  // — the whole reason `const a = 1; $.x === a` is a Filter — would never happen.
  const stmts = (root.stmts as readonly PipelineStmt[]).map(
    (stmt) => mapTree(stmt as unknown as object, foldNested) as unknown as PipelineStmt,
  );

  const top = foldStatements(stmts);
  const original = root.stmts as readonly PipelineStmt[];
  const nestedChanged = stmts.some((stmt, i) => stmt !== original[i]);
  if (!top.changed && !nestedChanged) {
    const parts = foldPartsIn(stmts, top.env);
    if (parts === stmts) return program;
    return { type: "Pipeline", stmts: parts, pos: root.pos as number } as unknown as Program;
  }

  const rewritten = { type: "Pipeline", stmts: foldPartsIn(top.stmts, top.env), pos: root.pos as number } as Any;
  const left = rewritten.stmts as readonly PipelineStmt[];
  // One EXPRESSION left is a Filter, not a pipeline of one predicate. This is
  // the whole reason `const a = 1; $.x === a` reads as `{ "x": 1 }`. Only an
  // expression collapses this way: a write or a declaration stays a pipeline
  // either way. Unwrapping one would throw away the `;` the source wrote, and
  // gain nothing.
  if (left.length === 1) {
    const only = left[0] as Any;
    const isStatement = only.type === "UpdateFilter" || only.type === "LetDecl" || only.type === "FuncDecl";
    if (!isStatement) return only as unknown as Program;
  }
  return rewritten as unknown as Program;
}

/** One scope's worth of folding: the statements that survive, and whether any went. */
function foldStatements(stmts: readonly PipelineStmt[]): {
  stmts: readonly PipelineStmt[];
  changed: boolean;
  env: Constants;
} {
  const excluded = unfoldable(stmts);
  const folded = new Map<string, unknown>();
  // Declared functions live HERE and not in `folded`: a call to one may be
  // evaluated, but the function itself is never substituted into the tree, where
  // a lambda would sit in an expression's place.
  const env = new Map<string, unknown>();
  const survivors: PipelineStmt[] = [];
  let changed = false;

  for (const stmt of stmts) {
    // What is known SO FAR, and not one declaration more.
    const resolved =
      folded.size === 0
        ? stmt
        : (
            substitute({ type: "Pipeline", stmts: [stmt], pos: 0 }, folded) as unknown as {
              stmts: readonly PipelineStmt[];
            }
          ).stmts[0];
    if (resolved !== stmt) changed = true;

    if (resolved.type === "FuncDecl" && !excluded.has(resolved.name)) {
      env.set(resolved.name, asDeclaredFunction(resolved.lambda as unknown as object));
      survivors.push(resolved);
      continue;
    }
    if (resolved.type === "LetDecl" && !excluded.has(resolved.name)) {
      const result = evaluate(resolved.value, env);
      // A constant MongoDB cannot write down is worth saying out loud. The
      // engine names it and propagates it, so an `Infinity` buried three
      // operators deep reports the same way one at the top does.
      if (!result.ok && result.unspellable !== undefined) throw noLiteralFor(result.unspellable, resolved.pos);
      if (result.ok) {
        // Every computed value has a node that carries it, so the declaration emits nothing.
        const at = (resolved.value as { pos: number }).pos;
        writeBack(result.value, at);
        folded.set(resolved.name, result.value);
        env.set(resolved.name, result.value);
        changed = true;
        continue;
      }
    }
    // A name that did not fold must not be read as one further down either.
    if (resolved.type === "LetDecl" || resolved.type === "FuncDecl") {
      folded.delete(resolved.name);
      env.delete(resolved.name);
    }
    survivors.push(resolved);
  }

  return { stmts: survivors, changed, env };
}

/** The constant MongoDB cannot write down, named — `10 / 0` inside a folded callback reports as the top-level one does. */
function noLiteralFor(what: string, pos: number): ParseError {
  return new ParseError(
    `This constant expression evaluates to ${what}, which has no MongoDB literal. Check the arithmetic — a division by zero, or an exponent out of range — or guard it with a condition.`,
    pos,
  );
}
