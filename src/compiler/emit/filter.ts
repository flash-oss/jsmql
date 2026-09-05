// Phase 5 — EMIT. A predicate to a QUERY document — the filter target.
//
// MongoDB's query language is a predicate language: `{ a: 1 }`, `{ a: { $gt: 1 } }`,
// `{ $or: [...] }`. It reaches an index; the expression language behind `$expr`
// does not. So a predicate is lowered to the query language wherever a row states
// a native form, and to `{ $expr: <truth> }` where none does — never a mix inside
// one leaf, and never a leaf whose meaning depends on its neighbour:
//
//   $.a > 1 && $.b <= 2                    → { a: { $gt: 1 }, b: { $lte: 2 } }
//   $.a >= 1 && $.a <= 9                   → { $and: [{ a: { $gte: 1 } }, { a: { $lte: 9 } }] }
//   $.a === 1 && $.q * $.p > 100           → { a: 1, $expr: { $gt: [{ $multiply: ["$q", "$p"] }, 100] } }
//   $.tags === "red" || $.q * $.p > 100    → { $or: [{ tags: "red" }, { $expr: { $gt: [...] } }] }
//
// The last line is the developer's ruling: `||` lowers PER BRANCH. The shipped
// compiler wrapped the whole disjunction in `$expr` as soon as one side needed it,
// and `{ $expr: { $eq: ["$tags", "red"] } }` does not match `tags: ["red", "blue"]`
// where `{ tags: "red" }` does — the left leaf's answer changed with its sibling.

import type { Expr, QueryDoc, Truth } from "../../registry/vocabulary.ts";
import { escapeForRegex, OWN_VALUE, queryOwnValue } from "../../registry/vocabulary.ts";
import { internalError } from "../../errors.ts";
import { namedRow, staticKey } from "../passes/naming.ts";
import { evaluate } from "../passes/evaluate.ts";
import { ObjectId } from "../../objectid.ts";
import { consult, listedIn } from "./consult.ts";
import { checkSlots } from "./check.ts";
import type { Env } from "./env.ts";
import * as E from "./errors.ts";
import { childEnv, filterInputs } from "./inputs.ts";
import { lowerTruth, lowerValue } from "./lower.ts";
import { matchExpr } from "./mql.ts";
import { or, truthOf } from "./mode.ts";
import { select, shapeOf, type Receiver } from "./select.ts";
import {
  isCallable,
  operandPositionOf,
  operandShapeOf,
  pipelineOverOf,
  positionalKeysOf,
  productionForOperator,
} from "../rows.ts";

/**
 * A predicate's query document, `$expr` included where a leaf has no native form.
 * The caller of `nativeOnly` gets null instead of an `$expr` — that is how a
 * `.some` body or an `||` branch learns it cannot be indexed as a whole.
 */
export function lowerFilter(node: Expr, env: Env): QueryDoc {
  const q = translate(node, env, false);
  if (q === null) internalError("a full filter translation answered null");
  return q;
}

/** The same, null when any leaf would need `$expr`. */
export const lowerNativeFilter = (node: Expr, env: Env): QueryDoc | null => translate(node, env, true);

const isExpr = (a: { type: string }): a is Expr =>
  a.type !== "SpreadElement" &&
  a.type !== "LetDecl" &&
  a.type !== "FuncDecl" &&
  a.type !== "AssignExpr" &&
  a.type !== "DeleteStmt" &&
  a.type !== "UpdateFilter";

function translate(node: Expr, env: Env, nativeOnly: boolean): QueryDoc | null {
  if (node.type === "BinaryExpr" && node.op === "&&") {
    const all = extractIncludesChain(node, env);
    if (all !== null) return includesChain(all.path, all.values);
    const left = translate(node.left, childEnv(env, node, "left"), nativeOnly);
    const right = translate(node.right, childEnv(env, node, "right"), nativeOnly);
    if (left === null || right === null) return null;
    return mergeAnd(left, right);
  }
  if (node.type === "UnaryExpr" && node.op === "!") {
    // `!p` is the COMPLEMENT of p's own clause, and the query language says it
    // exactly where an expression does not: `$expr` orders across BSON types, so
    // `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]` and for `v: "x"`,
    // where JavaScript answers true for both. Only a clause with no `$expr`
    // inside is complemented; anything else keeps the truth road below, whose
    // `$not` over one expression is already JavaScript's answer.
    const inner = translate(node.argument, childEnv(env, node, "argument"), true);
    if (inner !== null && Object.keys(inner).length > 0 && !isAlwaysTrue(inner) && !isAlwaysFalse(inner)) {
      return { $nor: [inner] };
    }
  }
  if (node.type === "BinaryExpr" && node.op === "||") {
    // Each branch on its own: a leaf's query form never depends on its sibling.
    const branches = chainOf(node, "||").map((b) => translate(b, childEnv(env, node, "left"), nativeOnly));
    if (branches.some((b) => b === null)) return null;
    // A folded constant branch: `false` adds nothing, `true` decides everything.
    if ((branches as QueryDoc[]).some(isAlwaysTrue)) return {};
    const docs = (branches as QueryDoc[]).filter((d) => !isAlwaysFalse(d));
    if (docs.length === 0) return matchExpr(truthOf(false, true));
    if (docs.length === 1) return docs[0];
    // Every branch an `$expr`: one `$expr: { $or }` says the same in less. A native
    // branch keeps the per-branch form, where its own meaning is kept.
    if (docs.every((d) => Object.keys(d).length === 1 && "$expr" in d))
      return matchExpr(or(...docs.map((d) => d.$expr as Truth)));
    return { $or: docs };
  }
  // A raw query document is the developer's own MQL: its values are lowered, its keys kept.
  if (node.type === "ObjectLiteral" && !env.scope.has("$")) return rawQuery(node, env);
  const native = leaf(node, env);
  if (native !== null) return native;
  if (nativeOnly) return null;
  return matchExpr(lowerTruth(node, env.at({ at: "value" })));
}

/** A raw `{ status: "a", $expr: … }` document: keys as written, values in value position. */
function rawQuery(node: Extract<Expr, { type: "ObjectLiteral" }>, env: Env): QueryDoc {
  return rawDocument(node, env.at({ at: "value" }));
}

/** A raw document's entries, keys as written and checked, values through `rawValue`. */
function rawDocument(node: Extract<Expr, { type: "ObjectLiteral" }>, env: Env): QueryDoc {
  const out: QueryDoc = {};
  for (const e of node.entries) {
    if (e.type === "SpreadElement") throw E.spreadInOperatorBody(e.pos);
    const key = staticKey(e);
    if (key === null) throw E.computedKeyInOperatorBody(e.pos);
    // `{ $setUnion: "$x" }` — a list operator with one scalar is a document the server
    // refuses, on this spelling as on the call, at the top of the document as below it.
    if (key.startsWith("$") && operandShapeOf(key) === "array" && e.value.type !== "ArrayLiteral") {
      throw E.listOperand(key, e.value.pos);
    }
    // A key whose row states a different position for its operand takes that
    // language instead of the query one — `$expr`'s operand is an expression.
    out[key] = operandPositionOf(key) === "value" ? lowerValue(e.value, env) : rawValue(e.value, env);
  }
  return out;
}

/**
 * A value inside a raw query document. `{ x: $gt($.y) }` — an operator with ONE
 * operand — is the QUERY operator's spelling (`{ x: { $gt: "$y" } }`), which HR2
 * passes through as written; the expression form's count rule does not apply
 * to it. Anything else is an ordinary value.
 */
function rawValue(e: Expr, env: Env): unknown {
  if (e.type === "OperatorCall" && e.args.length === 1 && e.args[0].type !== "SpreadElement") {
    // The operand is raw too: `{ a: $not($gt(1)) }` nests one query operator in another.
    return { [e.name]: rawValue(e.args[0], env) };
  }
  if (e.type === "ObjectLiteral") return rawDocument(e, env);
  // A computed expression is neither a value nor a query operator. `{ a: $.b > 1 }`
  // becomes `{ a: { $gt: ["$b", 1] } }`, which the server ACCEPTS and matches nothing —
  // the silent kind of wrong. A constant that happens to be written as an expression
  // (`-1`) has already settled, so it is a value and passes.
  if ((e.type === "BinaryExpr" || e.type === "UnaryExpr" || e.type === "TernaryExpr") && !evaluate(e, new Map()).ok) {
    throw E.expressionInQueryValue(e.pos);
  }
  const value = lowerValue(e, env);
  // An aggregation operator in a query document is refused by the server outright:
  // measured, `{ a: { $trim: … } }` answers "unknown operator: $trim". Checked HERE
  // and not on a raw document's keys: a document the developer TYPED is their own
  // MQL and passes through (a query operator newer than this build must still
  // round-trip), while this value is one they wrote as JavaScript.
  if (isObj(value) && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") && !listedIn(key, "filter")) throw E.aggregationOperatorInQuery(key, e.pos);
    }
  }
  return value;
}

/**
 * One predicate leaf: the row's query cell, or null. The row is the production
 * for an operator (`===`), or the name for a method (`.includes`) or an operator
 * call (`$sampleRate`). A cell that is not a rule — `viaFallback`, `composedInto`
 * on its own, a pending — is null here and becomes `$expr`.
 */
function leaf(node: Expr, env: Env): QueryDoc | null {
  let name: string | undefined;
  let recv: Expr | null = null;
  let args: readonly Expr[];
  if (node.type === "BinaryExpr") {
    name = productionForOperator("BinaryExpr", node.op);
    args = [node.left, node.right];
  } else if (node.type === "MethodCall") {
    name = node.name;
    recv = node.object;
    args = node.args.filter(isExpr);
  } else if (node.type === "OperatorCall") {
    name = node.name;
    args = node.args.filter(isExpr);
  } else return null;
  if (name === undefined) return null;
  const verdict = consult(name, "filter");
  if (verdict.kind === "refused")
    throw E.refusalFor(
      { kind: "refused", name, message: verdict.message, needsSubject: verdict.needsSubject },
      spelled(node, name),
      "",
      "filter",
      node.pos,
      [],
    );
  // A query-only operator applies to the top-level document: inside an `$elemMatch`
  // body the server refuses it ("can only be applied to the top-level document"), and
  // it has no value form to fall back to.
  if (!listedIn(name, "value") && env.site.boundaries.some((b) => b.stage === "$elemMatch")) {
    throw E.queryOnlyInsideElement(name, node.pos);
  }
  if (verdict.kind !== "lower" && verdict.kind !== "perFamily") return null;
  const receiver: Receiver = recv === null ? { kind: "none" } : { kind: "opaque", lowered: null };
  const sel = select(verdict, receiver, shapeOf(args), args.length);
  if (sel.kind === "wrongCount" || sel.kind === "rejectedCount" || sel.kind === "spreadRefused") {
    throw E.refusalFor(sel, spelled(node, name), "", "filter", node.pos, []);
  }
  if (sel.kind !== "rule") return null;
  checkSlots(name, sel.rule.args, args);
  const out = sel.rule.emit(
    filterInputs(name, recv, args, positionalKeysOf(name), env, node, { lowerFilter, lowerNativeFilter }),
  );
  return (out as QueryDoc | null) ?? null;
}

const spelled = (node: Expr, name: string): string =>
  node.type === "MethodCall" ? `.${name}` : node.type === "BinaryExpr" ? `'${node.op}'` : name;

/** Every operand of a left-nested chain of `op`. */
function chainOf(node: Expr, op: string): Expr[] {
  const out: Expr[] = [];
  const walk = (e: Expr) => {
    if (e.type === "BinaryExpr" && e.op === op) {
      walk(e.left);
      out.push(e.right);
    } else out.push(e);
  };
  walk(node);
  return out;
}

/**
 * `$.tags.includes("a") && $.tags.includes("b")` — every leaf an `.includes` of a
 * constant on the SAME path — is `{ tags: { $all: ["a", "b"] } }`: the same documents
 * as the `$and` of two clauses, in the shorter shape the developer meant. Both
 * readings of `.includes` survive the fold, each on one side of the `$or` (see
 * the `includes` row): `$all` is the ARRAY reading, and a string that holds every
 * needle is the STRING one.
 */
function includesChain(path: string, values: readonly unknown[]): QueryDoc {
  const contains = { [path]: { $all: values, $type: "array" } };
  const needles = values.filter((v) => typeof v === "string" || typeof v === "number");
  if (needles.length !== values.length) return contains;
  const [first, ...rest] = needles.map((v) => escapeForRegex(String(v)));
  const substrings =
    rest.length === 0
      ? queryOwnValue(path, { $regex: first }, OWN_VALUE)
      : { $and: [queryOwnValue(path, { $regex: first }, OWN_VALUE), ...rest.map((r) => ({ [path]: { $regex: r } }))] };
  return { $or: [contains, substrings] };
}

/** The path and the needles of an `&&` chain whose every leaf is `.includes(<constant>)` on ONE path, or null. */
function extractIncludesChain(node: Expr, env: Env): { path: string; values: unknown[] } | null {
  const leaves = chainOf(node, "&&");
  let path: string | null = null;
  const values: unknown[] = [];
  for (const l of leaves) {
    if (l.type !== "MethodCall" || l.name !== "includes" || l.args.length !== 1) return null;
    const p = pathOfIn(l.object, env);
    const a = l.args[0];
    const c = isExpr(a) ? constantIn(a) : null;
    if (p === null || c === null || (path !== null && p !== path)) return null;
    path = p;
    values.push(c.value);
  }
  return path === null ? null : { path, values };
}

// ── the two readings a query cell needs ──────────────────────────────────────

/**
 * The field path an expression names, or null. A `.length` is a property row,
 * not a path segment; inside a `.some` callback the element parameter is the root,
 * so `i.q` is "q".
 */
export function pathOfIn(e: Expr, env: Env): string | null {
  // Inside an `$elemMatch` body the outer document is out of reach: `$.min` has no
  // query path there, so a body that reads it takes the `$expr` road.
  const elements = env.site.boundaries.filter((b) => b.stage === "$elemMatch");
  const innermost = elements.length === 0 ? null : elements[elements.length - 1];
  // Inside a sub-pipeline over ANOTHER collection, `$.x` is still the OUTER
  // document (HR4), which the server reaches only through the stage's `let` —
  // the join road, not built yet. It must not become the foreign document's path.
  if (e.type === "FieldRef" && env.site.boundaries.some((b) => pipelineOverOf(b.stage) === "foreign")) {
    throw E.pendingStatement("a read of the outer document inside a sub-pipeline over another collection", e.pos);
  }
  if (e.type === "FieldRef") return e.path === "" || innermost !== null ? null : e.path;
  if (e.type === "MemberAccess") {
    if (!isCallable(e.name)) return null;
    if (
      e.object.type === "Ident" &&
      env.scope.has(e.object.name) &&
      env.lookup(e.object.name, e.object.pos).ref.kind === "document"
    ) {
      // A name bound as the DOCUMENT — a stream callback's parameter, or a `.some`
      // element — has its fields as paths. Inside an `$elemMatch` only the
      // INNERMOST element's do: an outer parameter read there has no query form
      // (`$elemMatch` sees its own element only), so the body takes the `$expr` road.
      return innermost === null || innermost.element === e.object.name ? e.name : null;
    }
    const base = pathOfIn(e.object, env);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

/** A constant the query language compares as written, boxed; null for a value it would reinterpret. */
export function constantIn(e: Expr): { value: unknown } | null {
  if (e.type === "ObjectIdLiteral") return { value: new ObjectId(e.hex) };
  const v = evaluate(e, new Map());
  if (!v.ok) return null;
  const x = v.value;
  if (x === null || typeof x === "number" || typeof x === "string" || typeof x === "boolean") return { value: x };
  if (x instanceof Date || x instanceof ObjectId) return { value: x };
  return null;
}

// ── the `&&` merge ───────────────────────────────────────────────────────────

/**
 * Two query documents as one conjunction. A key that appears once stays at the
 * top level, where the planner reads it; a key that collides goes into ONE `$and`
 * placed where the first collision stood, an existing `$and` flattened into it.
 * Two `$expr` residuals become one `$expr: { $and: [...] }`.
 *
 * A collision on a field whose two clauses are OPERATOR documents that name
 * different operators is not a collision at all: the server reads every operator
 * in one field document as a conjunction, so `$.a >= 1 && $.a <= 9` is one
 * clause. Two clauses that name the SAME operator differently stay in the `$and`.
 */
export function mergeAnd(a: QueryDoc, b: QueryDoc): QueryDoc {
  // A folded constant clause: `true` adds nothing, `false` decides everything.
  if (isAlwaysFalse(a) || isAlwaysFalse(b)) return matchExpr(truthOf(false, true));
  if (isAlwaysTrue(a) || Object.keys(a).length === 0) return b;
  if (isAlwaysTrue(b) || Object.keys(b).length === 0) return a;
  type Clause = { key: string; value: unknown };
  const clauses: Clause[] = [];
  const exprs: unknown[] = [];
  const collect = (doc: QueryDoc) => {
    for (const k of Object.keys(doc)) {
      if (k === "$and" && Array.isArray(doc[k])) {
        for (const inner of doc[k] as QueryDoc[])
          for (const ik of Object.keys(inner)) clauses.push({ key: ik, value: inner[ik] });
      } else if (k === "$expr") exprs.push(doc[k]);
      else clauses.push({ key: k, value: doc[k] });
    }
  };
  collect(a);
  collect(b);
  // Operator documents on one field that agree wherever they overlap are one document.
  for (let i = 0; i < clauses.length; i++) {
    for (let j = i + 1; j < clauses.length; j++) {
      if (clauses[i].key !== clauses[j].key) continue;
      const merged = mergedOperators(clauses[i].value, clauses[j].value);
      if (merged === null) continue;
      clauses[i] = { key: clauses[i].key, value: merged };
      clauses.splice(j, 1);
      j--;
    }
  }
  const counts = new Map<string, number>();
  for (const c of clauses) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  const out: QueryDoc = {};
  let and: QueryDoc[] | null = null;
  for (const c of clauses) {
    if ((counts.get(c.key) ?? 0) > 1) {
      if (and === null) {
        and = [];
        out.$and = and;
      }
      and.push({ [c.key]: c.value });
    } else out[c.key] = c.value;
  }
  if (exprs.length === 1) out.$expr = exprs[0];
  else if (exprs.length > 1)
    out.$expr = { $and: exprs.flatMap((e) => (isObj(e) && Array.isArray(e.$and) ? (e.$and as unknown[]) : [e])) };
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * A value spelled so that two spellings are equal only when the values are.
 * `JSON.stringify` is not that: it writes every RegExp as `{}`, so `/^a/` and
 * `/z$/` would read as one value and a merge would drop a condition.
 */
function spell(v: unknown): string {
  if (v instanceof RegExp) return `re:${v.source}/${v.flags}`;
  if (v instanceof Date) return `date:${v.getTime()}`;
  if (Array.isArray(v)) return `[${v.map(spell).join(",")}]`;
  if (isObj(v)) {
    const proto = Object.getPrototypeOf(v) as unknown;
    // A BSON value (an ObjectId, a Decimal128) answers for itself; only a plain
    // object is read key by key.
    if (proto !== Object.prototype && proto !== null) return `bson:${String(v)}`;
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${k}:${spell(v[k])}`)
      .join(",")}}`;
  }
  return `${typeof v}:${String(v)}`;
}

/** Two operator documents as one, or null when either is a plain value or they name one operator two ways. */
function mergedOperators(a: unknown, b: unknown): Record<string, unknown> | null {
  const operatorDoc = (v: unknown): Record<string, unknown> | null => {
    if (!isObj(v) || Array.isArray(v) || v instanceof Date || v instanceof RegExp) return null;
    const keys = Object.keys(v);
    return keys.length > 0 && keys.every((k) => k.startsWith("$")) ? v : null;
  };
  const l = operatorDoc(a);
  const r = operatorDoc(b);
  if (l === null || r === null) return null;
  for (const k of Object.keys(r)) {
    if (k in l && spell(l[k]) !== spell(r[k])) return null;
  }
  return { ...l, ...r };
}

/** `{ $expr: true }` — a predicate the fold settled to true; it selects every document. */
const isAlwaysTrue = (d: QueryDoc): boolean => Object.keys(d).length === 1 && d.$expr === true;
/** `{ $expr: false }` — a predicate the fold settled to false; it selects none. */
const isAlwaysFalse = (d: QueryDoc): boolean => Object.keys(d).length === 1 && d.$expr === false;

/** Is this the document the whole program means — a raw query — rather than a predicate? */
export const isRawQuery = (node: Expr): boolean => node.type === "ObjectLiteral" && namedRow(node) === null;
