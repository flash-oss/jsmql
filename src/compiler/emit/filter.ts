import type { Expr, QueryDoc, Truth } from "../../registry/vocabulary.ts";
import { queryOwnValue } from "../../registry/vocabulary.ts";
import { mongoRegexOptions, setKey } from "../../registry/mql.ts";
import { internalError } from "../../errors.ts";
import { namedRow, staticKey } from "../passes/naming.ts";
import { constantOf } from "../passes/evaluate.ts";
import { isMqlShaped } from "../passes/inject.ts";
import { bsonTagOf, isDate, isPlainObject, isRegExp, longsWithin, ObjectId, regexValue } from "../../bson.ts";
import { consult, listedIn } from "./consult.ts";
import { checkSlots } from "./check.ts";
import type { Env } from "./env.ts";
import * as E from "./errors.ts";
import { childEnv, filterInputs, onOwnStream } from "./inputs.ts";
import { holderOf, lowerTruth, lowerValue, operandsFirst, readablePath, slotProof } from "./lower.ts";
import { matchExpr } from "./mql.ts";
import { FALSE, mongoTruthy, or } from "./mode.ts";
import { proofsFor, sourceFamily, typeOf } from "./prove.ts";
import { isNothing, unreadable } from "./type.ts";
import { select, shapeOf, UNPROVEN, type Receiver } from "./select.ts";
import {
  isCallable,
  isKnownName,
  operandPositionOf,
  positionalKeysOf,
  productionForOperator,
  liftsToOf,
  namespaceNames,
  takesNoReceiver,
} from "../rows.ts";

const NAMESPACES = namespaceNames();

export function lowerFilter(node: Expr, env: Env, jsRead = false): QueryDoc {
  const q = translate(node, env, false, jsRead);
  if (q === null) internalError("a full filter translation answered null");
  return q;
}

export const lowerNativeFilter = (node: Expr, env: Env): QueryDoc | null => translate(node, env, true, true);

const isExpr = (a: { type: string }): a is Expr =>
  a.type !== "SpreadElement" &&
  a.type !== "LetDecl" &&
  a.type !== "FuncDecl" &&
  a.type !== "AssignExpr" &&
  a.type !== "DeleteStmt" &&
  a.type !== "UpdateFilter";

function translate(node: Expr, env: Env, nativeOnly: boolean, jsRead: boolean): QueryDoc | null {
  if (node.type === "Injected" && isMqlShaped(node.value)) throw E.runTimeValueAsQuery(node.value, node.pos);
  if (node.type === "BinaryExpr" && node.op === "&&") {
    const all = extractHasChain(node, env);
    if (all !== null) return hasChain(all.path, all.values);
    const left = translate(node.left, childEnv(env, node, "left"), nativeOnly, true);
    const right = translate(node.right, childEnv(env, node, "right"), nativeOnly, true);
    if (left === null || right === null) return null;
    return mergeAnd(left, right);
  }
  if (node.type === "UnaryExpr" && node.op === "!") {
    const inner = translate(node.argument, childEnv(env, node, "argument"), true, true);
    if (inner !== null && Object.keys(inner).length > 0 && !isAlwaysTrue(inner) && !isAlwaysFalse(inner)) {
      return { $nor: [inner] };
    }
  }
  if (node.type === "BinaryExpr" && node.op === "||") {
    const branches = chainOf(node, "||").map((b) => translate(b, childEnv(env, node, "left"), nativeOnly, true));
    if (branches.some((b) => b === null)) return null;
    if ((branches as QueryDoc[]).some(isAlwaysTrue)) return {};
    const docs = (branches as QueryDoc[]).filter((d) => !isAlwaysFalse(d));
    if (docs.length === 0) return matchExpr(FALSE);
    if (docs.length === 1) return docs[0];
    if (docs.every((d) => Object.keys(d).length === 1 && "$expr" in d))
      return matchExpr(or(...docs.map((d) => d.$expr as Truth)));
    return { $or: docs };
  }
  if (node.type === "ObjectLiteral" && !env.scope.has("$")) return rawQuery(node, env);
  const native = leaf(node, env) ?? bareTruth(node, env);
  if (native !== null) return native;
  if (nativeOnly) return null;
  const valueEnv = env.at({ at: "value" });
  if (node.type === "OperatorCall" && !jsRead) return matchExpr(mongoTruthy(lowerValue(node, valueEnv)));
  return matchExpr(lowerTruth(node, valueEnv));
}

function bareTruth(node: Expr, env: Env): QueryDoc | null {
  const path = pathOfIn(node, env);
  if (path === null || path === "") return null;
  const t = typeOf(node, env.at({ at: "value" }));
  if (t.kinds === "any" || t.kinds.has("array")) return null;
  if (isNothing(t)) return matchExpr(FALSE);
  if (t.kinds.size === 1 && t.kinds.has("bool")) return { [path]: true };
  const excluded: unknown[] = [];
  if (t.absent) excluded.push(null);
  if (t.kinds.has("bool")) excluded.push(false);
  if (t.kinds.has("string")) excluded.push("");
  if (t.kinds.has("number")) excluded.push(0);
  if (excluded.length === 0) return {};
  return { [path]: excluded.length === 1 ? { $ne: excluded[0] } : { $nin: excluded } };
}

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
    const ops = operatorEntries(e.value);
    if (ops !== null) {
      const runtime = ops.filter((o) => readsAtRunTime(o.value));
      if (runtime.length === 0) {
        kept.push(e);
        continue;
      }
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

const NEAR: ReadonlySet<string> = new Set(["$near", "$nearSphere"]);

const LOGICAL: ReadonlySet<string> = new Set(["$and", "$or", "$nor"]);

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

const NOT_INJECTED = Symbol("not injected");

function injectedInQuery(key: string, value: Expr): unknown {
  if (value.type !== "Injected" || !isMqlShaped(value.value)) return NOT_INJECTED;
  if (!key.startsWith("$")) return queryOwnValue(key, { $eq: value.value })[key];
  if (liftsToOf(key) !== undefined) return value.value;
  if (operandPositionOf(key) === "value") return NOT_INJECTED;
  throw E.runTimeValueAsQuery(value.value, value.pos);
}

function rawDocument(node: Extract<Expr, { type: "ObjectLiteral" }>, env: Env): QueryDoc {
  const out: QueryDoc = {};
  for (const e of node.entries) {
    if (e.type === "SpreadElement") throw E.spreadInOperatorBody(e.pos);
    const key = staticKey(e);
    if (key === null) throw E.computedKeyInOperatorBody(e.pos);
    const placed = injectedInQuery(key, e.value);
    if (placed !== NOT_INJECTED) {
      setKey(out, key, placed);
      continue;
    }
    if (NEAR.has(key) && env.site.root !== "filter") throw E.nearInMatch(key, e.pos);
    if (LOGICAL.has(key) && e.value.type === "ArrayLiteral") {
      out[key] = e.value.elements.map((el) => {
        if (el.type === "SpreadElement") throw E.spreadInOperatorBody(el.pos);
        return lowerFilter(el as Expr, env);
      });
      continue;
    }
    out[key] =
      operandPositionOf(key) === "value"
        ? lowerValue(e.value, env)
        : rawValue(e.value, key.startsWith("$") ? env.inside(key) : env);
  }
  return out;
}

function rawValue(e: Expr, env: Env): unknown {
  if (e.type === "OperatorCall" && e.args.length === 1 && e.args[0].type !== "SpreadElement") {
    const placed = injectedInQuery(e.name, e.args[0] as Expr);
    if (placed !== NOT_INJECTED) return { [e.name]: placed };
    return { [e.name]: rawValue(e.args[0], env) };
  }
  if (e.type === "ObjectLiteral") return rawDocument(e, env);
  if (e.type === "RegexLiteral") return e.injected ?? regexValue(e.pattern, mongoRegexOptions(e.flags));
  if ((e.type === "BinaryExpr" || e.type === "UnaryExpr" || e.type === "TernaryExpr") && !constantOf(e).ok) {
    throw E.expressionInQueryValue(e.pos);
  }
  const value = lowerValue(e, env);
  if (e.type !== "OperatorCall" && isObj(value) && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (key.startsWith("$") && !listedIn(key, "filter")) throw E.aggregationOperatorInQuery(key, e.pos);
    }
  }
  return value;
}

function leaf(node: Expr, env: Env): QueryDoc | null {
  let name: string | undefined;
  let recv: Expr | null = null;
  let args: readonly Expr[];
  const escape = node.type === "OperatorCall";
  if (node.type === "BinaryExpr") {
    name = productionForOperator("BinaryExpr", node.op);
    args = [node.left, node.right];
  } else if (node.type === "MethodCall") {
    if (takesNoReceiver(node.name) && node.object.type !== "StreamRef" && !onOwnStream(node.object, env)) {
      throw E.noReceiver(node.name, node.pos);
    }
    name = node.name;
    recv = node.object;
    args = node.args.filter(isExpr);
  } else if (node.type === "OperatorCall") {
    name = node.name;
    args = node.args.filter(isExpr);
    if (NEAR.has(name) && env.site.root !== "filter") throw E.nearInMatch(name, node.pos);
  } else return null;
  if (name === undefined) return null;
  const verdict = consult(name, "filter");
  if (verdict.kind === "refused") {
    if (node.type === "OperatorCall") return plainQuery(node, env);
    throw E.refusalFor(
      { kind: "refused", name, message: verdict.message, needsSubject: verdict.needsSubject },
      spelled(node, name),
      "",
      "filter",
      node.pos,
      [],
    );
  }
  if (!escape && !listedIn(name, "value") && env.site.boundaries.some((b) => b.stage === "$elemMatch")) {
    throw E.queryOnlyInsideElement(name, node.pos);
  }
  if (verdict.kind !== "lower" && verdict.kind !== "perFamily") {
    return node.type === "OperatorCall" ? plainQuery(node, env) : null;
  }
  const space = recv === null ? null : sourceFamily(recv);
  const receiver: Receiver =
    recv === null
      ? { kind: "none" }
      : space !== null && NAMESPACES.has(space)
        ? { kind: "namespace", name: space as Extract<Receiver, { kind: "namespace" }>["name"] }
        : { kind: "opaque", lowered: null };
  const source = recv ?? args[args.length - 1];
  const proofs = escape
    ? UNPROVEN
    : proofsFor(args, env, true, source === undefined ? null : { node: source, env }, (a) => pathOfIn(a, env) !== null);
  const sel = select(verdict, receiver, shapeOf(args), args.length, proofs);
  if (sel.kind === "wrongKind") {
    operandsFirst(args, childEnv(env, node, "args"));
    throw E.refusalFor(sel, spelled(node, name), "", "filter", node.pos, [], undefined, {
      ...(recv === null ? {} : { receiver: recv }),
      args,
    });
  }
  if (sel.kind === "spreadRefused") throw E.refusalFor(sel, spelled(node, name), "", "filter", node.pos, []);
  if (sel.kind === "wrongCount" || sel.kind === "rejectedCount") {
    if (node.type === "OperatorCall") return plainQuery(node, env);
    throw E.refusalFor(sel, spelled(node, name), "", "filter", node.pos, []);
  }
  if (sel.kind !== "rule") return node.type === "OperatorCall" ? plainQuery(node, env) : null;
  if (!escape) {
    checkSlots(name, sel.rule.args, args, true, undefined, env.site.settling, slotProof(childEnv(env, node, "args")));
  }
  const inputs = filterInputs(name, recv, args, positionalKeysOf(name), env, node, {
    lowerValue,
    lowerFilter,
    lowerNativeFilter,
  });
  let out: unknown;
  try {
    out = sel.rule.emit(inputs);
  } catch (e) {
    if (node.type === "OperatorCall" && e instanceof E.QueryFormError) return plainQuery(node, env);
    throw e;
  }
  return (out as QueryDoc | null) ?? null;
}

function plainQuery(node: Extract<Expr, { type: "OperatorCall" }>, env: Env): QueryDoc | null {
  if (!isKnownName(node.name) || listedIn(node.name, "value")) return null;
  const spread = node.args.find((a) => a.type === "SpreadElement");
  if (spread !== undefined) {
    throw E.refusalFor({ kind: "spreadRefused", name: node.name, sig: "…" }, node.name, "", "filter", spread.pos, []);
  }
  const args = node.args.filter(isExpr);
  const inside = env.inside(node.name);
  if (args.length === 0) return { [node.name]: {} };
  if (args.length === 1) return { [node.name]: rawValue(args[0], inside) };
  return { [node.name]: args.map((a) => rawValue(a, inside)) };
}

const spelled = (node: Expr, name: string): string =>
  node.type === "MethodCall" ? `.${name}` : node.type === "BinaryExpr" ? `'${node.op}'` : name;

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

function hasChain(path: string, values: readonly unknown[]): QueryDoc {
  return queryOwnValue(path, { $all: values });
}

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
  if (values.every((v) => v === null)) return null;
  return path === null ? null : { path, values };
}

export function pathOfIn(e: Expr, env: Env): string | null {
  const elements = env.site.boundaries.filter((b) => b.stage === "$elemMatch");
  const innermost = elements.length === 0 ? null : elements[elements.length - 1];
  if (e.type === "FieldRef") {
    if (e.path === "" || innermost !== null || env.level > 0) return null;
    readablePath(e, env, true);
    return e.path;
  }
  if (e.type === "Ident" && env.scope.has(e.name)) {
    const b = env.lookup(e.name, e.pos);
    if (b.ref.kind !== "document" || b.level !== env.level) return null;
    if (b.ref.path === "") return innermost !== null && innermost.element === e.name ? "" : null;
    return innermost === null || innermost.element === e.name ? b.ref.path : null;
  }
  if (e.type === "MemberAccess") {
    if (!isCallable(e.name)) return null;
    if (e.object.type === "Ident" && env.scope.has(e.object.name)) {
      const b = env.lookup(e.object.name, e.object.pos);
      if (b.ref.kind === "document" && b.level === env.level) {
        if (innermost !== null && innermost.element !== e.object.name) return null;
        const why = unreadable(typeOf(e.object, env), e.name, true);
        if (why !== null) {
          throw E.unreadableField(e.name, why, `${e.optional ? "?." : "."}${e.name}`, holderOf(e.object, env), e.pos);
        }
        return b.ref.path === "" ? e.name : `${b.ref.path}.${e.name}`;
      }
    }
    const base = pathOfIn(e.object, env);
    return base === null ? null : base === "" ? e.name : `${base}.${e.name}`;
  }
  return null;
}

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
  if (e.type === "RegexLiteral") return e.injected !== undefined ? { value: e.injected } : null;
  if (e.type === "ObjectIdLiteral") return { value: new ObjectId(e.hex) };
  const v = constantOf(e);
  if (!v.ok) return null;
  const converted = longsWithin(v.value);
  if (!converted.ok) return null;
  const x = converted.value;
  return isQueryConstant(x) ? { value: x } : null;
}

function isQueryConstant(x: unknown): boolean {
  if (x === null || typeof x === "number" || typeof x === "string" || typeof x === "boolean") return true;
  if (isDate(x) || bsonTagOf(x) !== undefined) return true;
  if (Array.isArray(x)) return x.every(isQueryConstant);
  return false;
}

export function mergeAnd(a: QueryDoc, b: QueryDoc): QueryDoc {
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

function spell(v: unknown): string {
  if (isRegExp(v)) return `re:${v.source}/${v.flags}`;
  if (isDate(v)) return `date:${v.getTime()}`;
  if (Array.isArray(v)) return `[${v.map(spell).join(",")}]`;
  if (isObj(v)) {
    if (!isPlainObject(v)) return `bson:${String(v)}`;
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${k}:${spell(v[k])}`)
      .join(",")}}`;
  }
  return `${typeof v}:${String(v)}`;
}

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

const isAlwaysTrue = (d: QueryDoc): boolean => Object.keys(d).length === 1 && d.$expr === true;
const isAlwaysFalse = (d: QueryDoc): boolean => Object.keys(d).length === 1 && d.$expr === false;
