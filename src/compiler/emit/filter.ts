// Phase 5 — EMIT. A predicate to a QUERY document — the filter target.
//
// The MongoDB query language is a predicate language: `{ a: 1 }`, `{ a: { $gt: 1 } }`,
// `{ $or: [...] }`. It can use an index. The expression language behind `$expr`
// cannot. The compiler lowers a predicate to the query language wherever a row
// states a native form, and to `{ $expr: <truth> }` where no row does. It never
// mixes the two inside one leaf, and it never makes a leaf's meaning depend on
// its neighbour:
//
//   $.a > 1 && $.b <= 2                    → { a: { $gt: 1 }, b: { $lte: 2 } }
//   $.a >= 1 && $.a <= 9                   → { $and: [{ a: { $gte: 1 } }, { a: { $lte: 9 } }] }
//   $.a === 1 && $.q * $.p > 100           → { a: 1, $expr: { $gt: [{ $multiply: ["$q", "$p"] }, 100] } }
//   $.tags === "red" || $.q * $.p > 100    → { $or: [{ tags: "red" }, { $expr: { $gt: [...] } }] }
//
// The last line states the rule: `||` lowers PER BRANCH. If the compiler wraps
// the whole disjunction in `$expr` as soon as one side needs it, this changes
// the OTHER side's answer: `{ $expr: { $eq: ["$tags", "red"] } }` does not match
// `tags: ["red", "blue"]`, where `{ tags: "red" }` does match.

import type { Expr, QueryDoc, Truth } from "../../registry/vocabulary.ts";
import { queryOwnValue } from "../../registry/vocabulary.ts";
import { internalError } from "../../errors.ts";
import { namedRow, staticKey } from "../passes/naming.ts";
import { evaluate } from "../passes/evaluate.ts";
import { bsonTagOf, isDate, isPlainObject, isRegExp, longsWithin, ObjectId } from "../../bson.ts";
import { consult, listedIn } from "./consult.ts";
import { checkSlots } from "./check.ts";
import type { Env } from "./env.ts";
import * as E from "./errors.ts";
import { childEnv, filterInputs } from "./inputs.ts";
import { lowerTruth, lowerValue } from "./lower.ts";
import { matchExpr } from "./mql.ts";
import { FALSE, or } from "./mode.ts";
import { typeOf } from "./prove.ts";
import { isNothing } from "./type.ts";
import { select, shapeOf, type Receiver } from "./select.ts";
import {
  isCallable,
  operandPositionOf,
  operandShapeOf,
  positionalKeysOf,
  productionForOperator,
  onlyInsideOf,
  liftsToOf,
} from "../rows.ts";

/**
 * A predicate's query document. It includes `$expr` where a leaf has no
 * native form. The caller of `nativeOnly` gets null instead of an `$expr` —
 * this is how a `.some` body or an `||` branch learns it cannot use an index
 * as a whole.
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
    const all = extractHasChain(node, env);
    if (all !== null) return hasChain(all.path, all.values);
    const left = translate(node.left, childEnv(env, node, "left"), nativeOnly);
    const right = translate(node.right, childEnv(env, node, "right"), nativeOnly);
    if (left === null || right === null) return null;
    return mergeAnd(left, right);
  }
  if (node.type === "UnaryExpr" && node.op === "!") {
    // `!p` is the COMPLEMENT of p's own clause. The query language states it
    // exactly where an expression does not: `$expr` orders values across BSON
    // types, so `{ $not: { $gt: ["$v", 1] } }` is false for `v: [0, 20]` and
    // for `v: "x"`, where JavaScript answers true for both. The compiler
    // complements only a clause with no `$expr` inside it. Anything else keeps
    // the truth road below, whose `$not` over one expression already gives
    // JavaScript's answer.
    const inner = translate(node.argument, childEnv(env, node, "argument"), true);
    if (inner !== null && Object.keys(inner).length > 0 && !isAlwaysTrue(inner) && !isAlwaysFalse(inner)) {
      return { $nor: [inner] };
    }
  }
  if (node.type === "BinaryExpr" && node.op === "||") {
    // Each branch stands on its own: a leaf's query form never depends on its sibling.
    const branches = chainOf(node, "||").map((b) => translate(b, childEnv(env, node, "left"), nativeOnly));
    if (branches.some((b) => b === null)) return null;
    // A folded constant branch: `false` adds nothing, `true` decides everything.
    if ((branches as QueryDoc[]).some(isAlwaysTrue)) return {};
    const docs = (branches as QueryDoc[]).filter((d) => !isAlwaysFalse(d));
    if (docs.length === 0) return matchExpr(FALSE);
    if (docs.length === 1) return docs[0];
    // Every branch an `$expr`: one `$expr: { $or }` says the same thing in less
    // text. A native branch keeps the per-branch form, which keeps its own meaning.
    if (docs.every((d) => Object.keys(d).length === 1 && "$expr" in d))
      return matchExpr(or(...docs.map((d) => d.$expr as Truth)));
    return { $or: docs };
  }
  // A raw query document is the developer's own MQL. The compiler lowers its values and keeps its keys.
  if (node.type === "ObjectLiteral" && !env.scope.has("$")) return rawQuery(node, env);
  const native = leaf(node, env) ?? bareTruth(node, env);
  if (native !== null) return native;
  if (nativeOnly) return null;
  return matchExpr(lowerTruth(node, env.at({ at: "value" })));
}

/**
 * A bare field read as a predicate — `$.active`, `u.deleted` — in the QUERY
 * language, where the proof rules an array out. The query language reads an
 * array field element by element, so `{ f: { $nin: [0] } }` drops `f: [0, 1]`,
 * which JavaScript keeps; a value that may be an array stays on the `$expr`
 * road. Otherwise the check is the same subtractive rule `truthOf` applies:
 * one excluded value per part of the proof that can be falsy.
 *
 *   $.active     active: bool             → { active: true }
 *   $.n          n: number, present       → { n: { $ne: 0 } }
 *   $.n          n: number, absent        → { n: { $nin: [null, 0] } }
 *   $.o          o: object, absent        → { o: { $ne: null } }
 *   $.o          o: object, present       → {}   (always true)
 */
function bareTruth(node: Expr, env: Env): QueryDoc | null {
  const path = pathOfIn(node, env);
  if (path === null || path === "") return null;
  const t = typeOf(node, env.at({ at: "value" }));
  if (t.kinds === "any" || t.kinds.has("array")) return null;
  if (isNothing(t)) return matchExpr(FALSE);
  // A boolean is truthy exactly when it is `true`; null and missing are not.
  if (t.kinds.size === 1 && t.kinds.has("bool")) return { [path]: true };
  const excluded: unknown[] = [];
  if (t.absent) excluded.push(null);
  if (t.kinds.has("bool")) excluded.push(false);
  if (t.kinds.has("string")) excluded.push("");
  if (t.kinds.has("number")) excluded.push(0);
  if (excluded.length === 0) return {};
  return { [path]: excluded.length === 1 ? { $ne: excluded[0] } : { $nin: excluded } };
}

/**
 * A raw `{ status: "a", $expr: … }` document. It keeps the keys as written and
 * lowers the values in value position. A value that is a RUNTIME read —
 * `{ userId: $.other }`, an outer binding, `{ createdAt: { $gte: $.since } }` —
 * has no query form. The query language compares a field with a constant, and
 * `"$other"` there is just the string. The compiler lifts such an entry into
 * `$expr` (`{ $eq: ["$userId", "$other"] }`), where the read means the field.
 * The constant entries stay native beside it.
 */
function rawQuery(node: Extract<Expr, { type: "ObjectLiteral" }>, env: Env): QueryDoc {
  const valueEnv = env.at({ at: "value" });
  const lifted: unknown[] = [];
  const kept: Array<(typeof node.entries)[number]> = [];
  for (const e of node.entries) {
    if (e.type === "SpreadElement" || staticKey(e) === null || staticKey(e)!.startsWith("$")) {
      kept.push(e);
      continue;
    }
    const key = staticKey(e)!;
    // The value either APPLIES operators to the field — `{ $gte: … }`, `$gte(…)` —
    // or IS what the field is compared with. The two take different lifts, so
    // the shape decides which lift applies first.
    const ops = operatorEntries(e.value);
    if (ops !== null) {
      const runtime = ops.filter((o) => readsAtRunTime(o.value));
      if (runtime.length === 0) {
        kept.push(e);
        continue;
      }
      // `{ createdAt: { $gte: $.since } }` — an operator with a runtime operand
      // takes its expression twin. The operators with a constant operand stay
      // native beside it.
      for (const o of runtime) {
        const twin = liftsToOf(o.op);
        if (twin === undefined) throw E.runtimeInQueryOperator(o.op, o.pos);
        const clause = { [twin.op]: ["$" + key, lowerValue(o.value, valueEnv)] };
        lifted.push(twin.negated === true ? { $not: [clause] } : clause);
      }
      if (e.value.type === "ObjectLiteral") {
        const stay = e.value.entries.filter((o) => o.type === "KeyValueEntry" && !readsAtRunTime(o.value));
        if (stay.length > 0) kept.push({ ...e, value: { ...e.value, entries: stay } });
      }
      continue;
    }
    // A COMPARED VALUE. The query language takes it as written only when nothing
    // inside it is read at run time. `{ a: [1, $.b] }` would compare the field
    // with the four-character string "$b", so the compiler moves the whole
    // comparison into `$expr`.
    if (readsAtRunTime(e.value)) {
      lifted.push({ $eq: ["$" + key, lowerValue(e.value, valueEnv)] });
      continue;
    }
    kept.push(e);
  }
  const out = rawDocument({ ...node, entries: kept }, valueEnv);
  if (lifted.length === 0) return out;
  const own = out.$expr === undefined ? [] : [out.$expr];
  const all = [...own, ...lifted];
  out.$expr = all.length === 1 ? all[0] : { $and: all };
  return out;
}

/** The proximity operators, valid in a `find()` filter and refused inside an aggregation `$match`. */
const NEAR: ReadonlySet<string> = new Set(["$near", "$nearSphere"]);

/** The top-level query operators whose operand is a list of query documents. */
const LOGICAL: ReadonlySet<string> = new Set(["$and", "$or", "$nor"]);

/**
 * The operators a raw query value applies to its field, or null when the value
 * is one the field is COMPARED with. `{ $gte: $.since }` is the document
 * spelling and `$gte($.since)` is the call. HR2 states the two are one thing,
 * so both answer here. A document whose keys are not all `$`-named is a value,
 * not a set of operators.
 */
function operatorEntries(e: Expr): ReadonlyArray<{ op: string; value: Expr; pos: number }> | null {
  if (e.type === "OperatorCall" && e.args.length === 1 && e.args[0].type !== "SpreadElement") {
    return [{ op: e.name, value: e.args[0] as Expr, pos: e.pos }];
  }
  if (e.type !== "ObjectLiteral" || e.entries.length === 0) return null;
  const out: Array<{ op: string; value: Expr; pos: number }> = [];
  for (const entry of e.entries) {
    const key = staticKey(entry);
    if (entry.type !== "KeyValueEntry" || key === null || !key.startsWith("$")) return null;
    out.push({ op: key, value: entry.value, pos: entry.pos });
  }
  return out;
}

/**
 * Is anything inside this value read at RUN time — a field, a bound name, an
 * access, or a call on one — rather than a constant, a regex, or the
 * developer's own operator?
 *
 * The question DESCENDS. A read gives the field's name as a plain string in a
 * query slot, so it has no query form wherever it sits. `{ a: $.b }`,
 * `{ a: [1, $.b] }`, `{ a: [{ x: $.b }] }` and `{ a: { x: { y: $.b } } }` are
 * one case, not four.
 */
function readsAtRunTime(e: Expr): boolean {
  switch (e.type) {
    case "FieldRef":
    case "Ident":
    case "MemberAccess":
    case "IndexAccess":
    case "MethodCall":
    case "CallExpression":
      return constantIn(e) === null;
    case "ArrayLiteral":
      return e.elements.some((el) => el.type !== "SpreadElement" && readsAtRunTime(el as Expr));
    case "ObjectLiteral":
      return e.entries.some((o) => o.type === "KeyValueEntry" && readsAtRunTime(o.value));
    default:
      return false;
  }
}

/** A raw document's entries, keys as written and checked, values through `rawValue`. */
function rawDocument(node: Extract<Expr, { type: "ObjectLiteral" }>, env: Env): QueryDoc {
  const out: QueryDoc = {};
  for (const e of node.entries) {
    if (e.type === "SpreadElement") throw E.spreadInOperatorBody(e.pos);
    const key = staticKey(e);
    if (key === null) throw E.computedKeyInOperatorBody(e.pos);
    // `{ $setUnion: "$x" }` — a list operator with one scalar is a document the
    // server refuses. It refuses this on the call spelling too, and at the top
    // of the document as well as below it.
    if (key.startsWith("$") && operandShapeOf(key) === "array" && e.value.type !== "ArrayLiteral") {
      throw E.listOperand(key, e.value.pos);
    }
    // A key whose row states a different position for its operand takes that
    // language instead of the query one — `$expr`'s operand is an expression.
    // `$near` and `$nearSphere` query only a `find()`. Inside an aggregation
    // `$match` the server refuses them.
    if (NEAR.has(key) && env.site.root !== "filter") throw E.nearInMatch(key, e.pos);
    // `$and`, `$or` and `$nor` hold a LIST of query documents. Each element is a filter of its own.
    if (LOGICAL.has(key) && e.value.type === "ArrayLiteral") {
      out[key] = e.value.elements.map((el) => {
        if (el.type === "SpreadElement") throw E.spreadInOperatorBody(el.pos);
        return lowerFilter(el as Expr, env);
      });
      continue;
    }
    out[key] = operandPositionOf(key) === "value" ? lowerValue(e.value, env) : rawValue(e.value, env);
  }
  return out;
}

/**
 * A value inside a raw query document. `{ x: $gt($.y) }` — an operator with ONE
 * operand — is the QUERY operator's spelling (`{ x: { $gt: "$y" } }`). HR2
 * passes it through as written, so the expression form's count rule does not
 * apply to it. Anything else is an ordinary value.
 */
function rawValue(e: Expr, env: Env): unknown {
  if (e.type === "OperatorCall" && e.args.length === 1 && e.args[0].type !== "SpreadElement") {
    // The operand is raw too: `{ a: $not($gt(1)) }` nests one query operator in another.
    return { [e.name]: rawValue(e.args[0], env) };
  }
  if (e.type === "ObjectLiteral") return rawDocument(e, env);
  // A computed expression is neither a value nor a query operator. `{ a: $.b > 1 }`
  // becomes `{ a: { $gt: ["$b", 1] } }`, which the server ACCEPTS and matches
  // nothing. This is the silent kind of wrong answer. A constant that happens
  // to be written as an expression (`-1`) has already settled to a value, so
  // it passes.
  if ((e.type === "BinaryExpr" || e.type === "UnaryExpr" || e.type === "TernaryExpr") && !evaluate(e, new Map()).ok) {
    throw E.expressionInQueryValue(e.pos);
  }
  const value = lowerValue(e, env);
  // The server refuses an aggregation operator in a query document outright.
  // Measured: `{ a: { $trim: … } }` answers "unknown operator: $trim". The
  // compiler checks this HERE, and not on a raw document's keys, because a
  // document the developer TYPED is their own MQL and passes through — a query
  // operator newer than this build must still round-trip. This value is one
  // the developer wrote as JavaScript.
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
 * on its own — is null here and becomes `$expr`.
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
    const hosts = onlyInsideOf(name, "filter");
    if (hosts !== undefined && !hosts.includes(env.site.inside ?? "")) throw E.onlyInside(name, hosts, node.pos);
    if (NEAR.has(name) && env.site.root !== "filter") throw E.nearInMatch(name, node.pos);
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
  // A query-only operator applies to the top-level document. Inside an
  // `$elemMatch` body the server refuses it ("can only be applied to the
  // top-level document"), and it has no value form to fall back to.
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
    filterInputs(name, recv, args, positionalKeysOf(name), env, node, { lowerValue, lowerFilter, lowerNativeFilter }),
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
 * `$.tags.has("a") && $.tags.has("b")` — every leaf a `.has` of a constant on the
 * SAME path — becomes `{ tags: { $all: ["a", "b"] } }`. This matches the same
 * documents as the `$and` of two clauses, in the shorter indexable shape the
 * developer meant. It also folds what one `.has` already answers (see the `has` row).
 */
function hasChain(path: string, values: readonly unknown[]): QueryDoc {
  return { [path]: { $all: values } };
}

/** The path and the needles of an `&&` chain whose every leaf is `.has(<constant>)` on ONE path, or null. */
function extractHasChain(node: Expr, env: Env): { path: string; values: unknown[] } | null {
  const leaves = chainOf(node, "&&");
  let path: string | null = null;
  const values: unknown[] = [];
  for (const l of leaves) {
    if (l.type !== "MethodCall" || l.name !== "has" || l.args.length !== 1) return null;
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
 * not a path segment. Inside a `.some` callback the element parameter is the
 * root, so `i.q` names "q".
 */
export function pathOfIn(e: Expr, env: Env): string | null {
  // Inside an `$elemMatch` body the outer document is out of reach. `$.min` has
  // no query path there, so a body that reads it takes the `$expr` road.
  const elements = env.site.boundaries.filter((b) => b.stage === "$elemMatch");
  const innermost = elements.length === 0 ? null : elements[elements.length - 1];
  // Inside a sub-pipeline over ANOTHER collection, `$.x` still names the OUTER
  // document (HR4). The server reaches it only through the stage's `let`, so it
  // has no query path. The `$expr` road reads it and captures it instead.
  if (e.type === "FieldRef") return e.path === "" || innermost !== null || env.level > 0 ? null : e.path;
  // The element itself, when it is an unwound FIELD: `.flatMap("tags").filter(t => t === "x")` becomes `{ tags: "x" }`.
  // The whole document has no query path. The `$expr` road captures a shallower level's element.
  if (e.type === "Ident" && env.scope.has(e.name)) {
    const b = env.lookup(e.name, e.pos);
    if (b.ref.kind !== "document" || b.ref.path === "" || b.level !== env.level) return null;
    return innermost === null || innermost.element === e.name ? b.ref.path : null;
  }
  if (e.type === "MemberAccess") {
    if (!isCallable(e.name)) return null;
    if (e.object.type === "Ident" && env.scope.has(e.object.name)) {
      const b = env.lookup(e.object.name, e.object.pos);
      // a parameter of a SHALLOWER level also has no path here — the `$expr` road captures it
      if (b.ref.kind === "document" && b.level === env.level) {
        // A name bound as the ELEMENT — a stream callback's parameter, or a `.some`
        // element — has its fields as paths, under the element's own path when
        // the field is unwound. Inside an `$elemMatch` only the INNERMOST
        // element's fields do. An outer parameter read there has no query form,
        // because `$elemMatch` sees only its own element, so the body takes the
        // `$expr` road.
        if (innermost !== null && innermost.element !== e.object.name) return null;
        return b.ref.path === "" ? e.name : `${b.ref.path}.${e.name}`;
      }
    }
    const base = pathOfIn(e.object, env);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

/** A constant the query language compares as written, boxed. Null for a value it would reinterpret. */
/**
 * A LITERAL the raw query language takes as written — a constant, or a list or
 * document of literals (`[1, 2]`, `{ $search: "x" }`) — boxed; null otherwise.
 * This differs from `constantIn` on purpose. A JavaScript spelling reads an
 * array or document literal by reference (`$.tags === [1, 2]` is never true in
 * JavaScript), so it takes the expression road, where `$eq` compares the whole
 * value.
 */
export function literalIn(e: Expr): { value: unknown } | null {
  if (e.type === "ArrayLiteral") {
    const out: unknown[] = [];
    for (const el of e.elements) {
      if (el.type === "SpreadElement") return null;
      const c = literalIn(el as Expr);
      if (c === null) return null;
      out.push(c.value);
    }
    return { value: out };
  }
  if (e.type === "ObjectLiteral") {
    const out: Record<string, unknown> = {};
    for (const entry of e.entries) {
      const key = staticKey(entry);
      if (entry.type !== "KeyValueEntry" || key === null) return null;
      const c = literalIn(entry.value);
      if (c === null) return null;
      out[key] = c.value;
    }
    return { value: out };
  }
  return constantIn(e);
}

export function constantIn(e: Expr): { value: unknown } | null {
  if (e.type === "Injected") return { value: e.value };
  // a RegExp the CALL supplied is the developer's own MongoDB regex, taken as
  // written. One typed in source is a pattern for the regex methods, and no
  // constant to compare a field with.
  if (e.type === "RegexLiteral") return e.injected !== undefined ? { value: e.injected } : null;
  if (e.type === "ObjectIdLiteral") return { value: new ObjectId(e.hex) };
  const v = evaluate(e, new Map());
  if (!v.ok) return null;
  // A BigInt IS an int64 in MQL. The compiler converts it here, so `$.n === 5n`
  // stays a query the index serves. Left unconverted, it would fall through to
  // `$expr`.
  const converted = longsWithin(v.value);
  if (!converted.ok) return null;
  const x = converted.value;
  return isQueryConstant(x) ? { value: x } : null;
}

/**
 * A value the query language compares as written: a scalar, a Date, any BSON
 * value, a regex, or a list of such values.
 *
 * Every BSON value belongs here for a reason of correctness, not output size.
 * MEASURED on mongod, for `{ tags: [Long(5), Long(7)] }`:
 *   { tags: Long(5) }                      → matches      (any ELEMENT equals)
 *   { $expr: { $eq: ["$tags", Long(5)] } } → matches NOT   (the whole array, to a scalar)
 * A BSON value left off this list takes the `$expr` road, and quietly answers
 * the second question on every array field.
 */
function isQueryConstant(x: unknown): boolean {
  if (x === null || typeof x === "number" || typeof x === "string" || typeof x === "boolean") return true;
  if (isDate(x) || bsonTagOf(x) !== undefined) return true;
  if (Array.isArray(x)) return x.every(isQueryConstant);
  return false;
}

// ── the `&&` merge ───────────────────────────────────────────────────────────

/**
 * Two query documents as one conjunction. A key that appears once stays at the
 * top level, where the planner reads it. A key that collides goes into ONE
 * `$and`, placed where the first collision stood, with an existing `$and`
 * flattened into it. Two `$expr` residuals become one `$expr: { $and: [...] }`.
 *
 * A collision on a field whose two clauses are OPERATOR documents that name
 * different operators is not a collision at all. The server reads every
 * operator in one field document as a conjunction, so `$.a >= 1 && $.a <= 9` is
 * one clause. Two clauses that name the SAME operator differently stay in the
 * `$and`.
 */
export function mergeAnd(a: QueryDoc, b: QueryDoc): QueryDoc {
  // A folded constant clause: `true` adds nothing, `false` decides everything.
  if (isAlwaysFalse(a) || isAlwaysFalse(b)) return matchExpr(FALSE);
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
 * A value spelled so that two spellings are equal only when the values are
 * equal. `JSON.stringify` does not do this: it writes every RegExp as `{}`, so
 * `/^a/` and `/z$/` would read as one value, and a merge would drop a
 * condition.
 */
function spell(v: unknown): string {
  if (isRegExp(v)) return `re:${v.source}/${v.flags}`;
  if (isDate(v)) return `date:${v.getTime()}`;
  if (Array.isArray(v)) return `[${v.map(spell).join(",")}]`;
  if (isObj(v)) {
    // A BSON value (an ObjectId, a Decimal128) answers for itself. Only a plain
    // object is read key by key.
    if (!isPlainObject(v)) return `bson:${String(v)}`;
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
    if (!isPlainObject(v)) return null;
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
