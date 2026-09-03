// Phase 3 — FOLD. A `const` whose value can be computed is computed, and every
// reference to it becomes the value.
//
//   const msInDay = 24 * 60 * 60 * 1000;  $.elapsedMs > msInDay
//     →  $.elapsedMs > 86400000     →   { "elapsedMs": { "$gt": 86400000 } }
//
// Without it the same program is a pipeline that recomputes the number on every
// document, in a `$set` nobody asked for, and the result cannot use an index. So
// this is not a size optimisation: it decides which DOCUMENT the program becomes.
//
// It runs INSIDE the desugar fixpoint, and the two feed each other:
//   const k = "name"; $.items.map(k)
//     fold    → $.items.map("name")          the shorthand rule can now see it
//     desugar → $.items.map(x => x.name)
//
// THE TWO WAYS A FOLD GOES WRONG, and what stops each:
//
//   1. It replaces a name that means something else here. A binder of the same
//      name — a lambda parameter, a declaration in a nested scope — makes a
//      DIFFERENT variable, and substituting through one answers with the
//      constant where the source meant the other. `shadowedIn` collects every
//      binder the tree has; `substitute` refuses to cross one.
//   2. It replaces a name whose value changes. A write, a mutation, or a second
//      declaration means the first value is not the only one. `unfoldable`
//      collects those names, and they keep their runtime binding.

import type { Expr, PipelineStmt, Program } from "../../registry/ast.ts";
import type { NodeName } from "../../registry/vocabulary.ts";
import { ParseError } from "../parse/cursor.ts";
import { mutatedArgumentOf } from "../rows.ts";
import { asLiteral } from "./literal.ts";
import type { Constants } from "./evaluate.ts";
import { asDeclaredFunction, evaluate } from "./evaluate.ts";
import { bindsFor, namesSomething } from "./naming.ts";
import type { Where } from "./position.ts";
import { edge, STATEMENT } from "./position.ts";
import { mapTree, mapTreeIn } from "./walk.ts";

type Any = { type: string } & Record<string, unknown>;

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

/** Every node in the subtree, the node itself included. */
function* everyNode(root: Any): Generator<Any> {
  yield root;
  for (const child of nodesIn(Object.values(root))) yield* everyNode(child);
}

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
    // Answering it with the later value would invent a meaning the language does
    // not have, so the declaration keeps its binding and a later phase reports it.
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (readSoFar.has(stmt.name)) excluded.add(stmt.name);
    }
    for (const node of everyNode(stmt as Any)) {
      if (node.type === "Ident" && typeof node.name === "string") readSoFar.add(node.name);
    }
  }

  for (const stmt of stmts) {
    if (stmt.type === "LetDecl" || stmt.type === "FuncDecl") {
      if (declared.has(stmt.name)) excluded.add(stmt.name);
      declared.add(stmt.name);
    }
    // Walked WITH positions, because one of the tests below is about position:
    // a call that IS a statement mutates its receiver — `a.sort();` is the whole
    // statement and nothing reads its result — while the same call in value
    // position answers with a new array and leaves the binding alone. Reading the
    // node's shape instead of its position read `[xs.slice(1)]` in a value slot as
    // a bracketed pipeline of mutations, and kept a constant it should have folded.
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
      // A call that writes one of its ARGUMENTS in place, wherever it stands —
      // `Object.assign(a, …)`. Which argument is the row's fact, not a name matched
      // here, so a second such name is a row and not a branch.
      if (typeof node.name === "string") {
        const index = mutatedArgumentOf(node.name);
        if (index !== undefined) {
          const name = rootName((node.args as readonly unknown[] | undefined)?.[index]);
          if (name !== null) excluded.add(name);
        }
      }
    }
  }
  return excluded;
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

// ── substitution ─────────────────────────────────────────────────────────────

/** What travels down the tree while substituting. */
type Scope = { shadowed: ReadonlySet<string>; naming: boolean };

/** Every name a node binds for the subtree under `key` — stated once, in naming.ts. */
const shadowedIn = (node: Any, key: string): readonly string[] => bindsFor(node, key);

/**
 * Replace every free reference to a folded name with the value it holds.
 *
 * Two things it must never do. It must not cross a binder of the same name — see
 * `shadowedIn`. And it must not touch an identifier that NAMES something rather
 * than valuing it: `a.p = 9` names a place and `g(1)` names a function, so
 * replacing either with its value produces `1 = 9` or `3(1)`, neither of which is
 * a program.
 */
function substitute(program: Program, folded: ReadonlyMap<string, unknown>): Program {
  const start: Scope = { shadowed: new Set(), naming: false };

  // An identifier that NAMES something is never substituted — the same test
  // position.ts uses to keep those slots out of value position. See naming.ts.
  const step = (node: object, key: string, here: Scope): Scope => {
    const n = node as Any;
    const naming = namesSomething(n, key);
    const names = shadowedIn(n, key);
    if (names.length === 0) {
      return naming === here.naming ? here : { shadowed: here.shadowed, naming };
    }
    const shadowed = new Set(here.shadowed);
    for (const name of names) shadowed.add(name);
    return { shadowed, naming: naming || here.naming };
  };

  return mapTreeIn(program, start, step, (node, scope) => {
    const n = node as Any;
    if (n.type !== "Ident" || typeof n.name !== "string") return node;
    if (scope.naming || scope.shadowed.has(n.name)) return node;
    if (!folded.has(n.name)) return node;
    // Every folded value has a literal — `fold` only records the ones that do —
    // so there is no fallback here, and no un-substituted source to capture with.
    return asLiteral(folded.get(n.name), n.pos as number) as object;
  });
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
 * A value with no MongoDB literal is left alone. Unlike a declaration — which
 * must produce a value or stay a binding — a subexpression is perfectly able to
 * go on being computed at run time.
 */
function foldConstantParts<T extends object>(node: T, known: Constants = EMPTY): T {
  // The environment travels down and SHRINKS at every binder: a lambda parameter
  // named the same as a declared function is a different thing entirely, and
  // folding `f(1)` against the outer `f` inside `map(f => f(1))` would answer
  // about the wrong one.
  const step = (n: object, key: string, here: Constants): Constants => {
    const names = shadowedIn(n as Any, key);
    if (names.length === 0) return here;
    const next = new Map(here);
    for (const name of names) next.delete(name);
    return next;
  };

  return mapTreeIn(node, known, step, (inner, env) => {
    const n = inner as Any;
    if (!EVALUABLE.has(n.type)) return inner;
    const result = evaluate(n as unknown as Expr, env);
    if (!result.ok) return inner;
    return (asLiteral(result.value, n.pos as number) ?? inner) as object;
  });
}

/**
 * Every statement of a list, with its constant parts folded against `known`.
 *
 * ONE STATEMENT at a time, never the list around it: a scope's own declarations
 * are exactly what its statements should see, and descending through the
 * `Pipeline` node would make `shadowedIn` hide them along with the nested ones.
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
 * The expression types deliberately NOT asked about, each for a stated reason: a
 * literal is already the answer (and re-spelling it would rebuild the node every
 * round, so the fixpoint would never settle); a reference, a lambda and a block
 * are not values; `OperatorCall` is the escape hatch above. Together with
 * `EVALUABLE_TYPES` this must cover every `Expr` type — the two lines below make a
 * new node type a compile error here rather than a subexpression silently never
 * folded.
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
  "ArrayLiteral",
  "ObjectLiteral",
  "FieldRef",
  "CollectionRef",
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
 * Statements are walked IN ORDER, and each one is substituted with what is known
 * at the point it stands. That is not tidiness: a name read before it is declared
 * is a `ReferenceError` in JavaScript, and answering it with the later value
 * would invent a meaning the language does not have.
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
  // first and leave the pass below with nothing to report, and the collapse — the
  // whole reason `const a = 1; $.x === a` is a Filter — would never happen.
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
  // One EXPRESSION left is a Filter, not a pipeline of one predicate — which is
  // the whole reason `const a = 1; $.x === a` reads as `{ "x": 1 }`. Only an
  // expression: a write or a declaration is a pipeline either way, so unwrapping
  // one would throw away the `;` the source wrote and gain nothing.
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
      // evaluator names it and propagates it, so an `Infinity` buried three
      // operators deep reports the same way one at the top does.
      if (!result.ok && result.unspellable !== undefined) {
        throw new ParseError(
          `This constant expression evaluates to ${result.unspellable}, which has no MongoDB literal. Check the arithmetic — a division by zero, or an exponent out of range.`,
          resolved.pos,
        );
      }
      if (result.ok) {
        // Only a value with a literal spelling. Anything else keeps its binding:
        // inlining the source expression instead would carry that expression's
        // own free names to every use site, where they can be captured by a
        // lambda parameter or left with no binder at all.
        if (asLiteral(result.value, 0) !== null) {
          folded.set(resolved.name, result.value);
          env.set(resolved.name, result.value);
          changed = true;
          continue; // the declaration itself emits nothing
        }
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
