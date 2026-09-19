// Phase 5 — EMIT. The reducer wrap. This module reads `$$ = [{ k: $$.reduce((acc, d) => …, init), … }]`
// and `$$ = [$$.reduce((acc, d) => ({ ...acc, k: … }), { k: init })]` as the ONE
// `$group` they mean, followed by the `$replaceWith` that drops `_id`.
//
// `.reduce` folds the stream to one value, and a stream must stay documents, so
// the fold is written INSIDE a document — one key per accumulator. Each key's
// body is read as the MongoDB accumulator it spells. A body that spells none is
// refused, and the message names the shapes that do. The init is JavaScript's own value. It is
// required and unread, because MongoDB's accumulators have their own neutral elements.
//
//   acc + d.total          → { $sum: "$total" }      acc + 1            → { $sum: 1 }
//   Math.max(acc, d.x)     → { $max: "$x" }          Math.min(acc, d.x) → { $min: "$x" }
//   acc ?? d.x             → { $first: "$x" }        d.x                → { $last: "$x" }
//   [...acc, d.x]          → { $push: "$x" }         acc.concat(d.x)    → { $push: "$x" }
//
// See docs/specs/emit-pass.md § The reducer wrap.

import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { chainBase } from "../passes/naming.ts";
import * as E from "./errors.ts";

type Lambda = Extract<Expr, { type: "Lambda" }>;
type Call = Extract<Expr, { type: "MethodCall" }>;
type Accumulator = { op: "$sum" | "$max" | "$min" | "$first" | "$last" | "$push"; value: unknown };

/**
 * The seed folded in, as JavaScript would fold it: `acc + d.x` from 10 is the sum plus 10,
 * `Math.max` from 5 is the max with 5, `[...acc, d.x]` from `[0]` is `[0, …]`,
 * and `acc ?? d.x` from a non-null seed IS the seed. `$last` reads no seed. The
 * compiler refuses a seed that is not a constant, because it cannot start a MongoDB accumulator.
 */
function seeded(acc: Accumulator, init: Expr, read: string): unknown {
  const c = constantOf(init);
  if (c === NOT_CONSTANT) throw E.reduceWrapSeed(init.pos);
  switch (acc.op) {
    case "$sum":
      return c === 0 ? read : { $add: [c, read] };
    case "$max":
    case "$min":
      return c === null ? read : { [acc.op]: [c, read] };
    case "$push":
      return Array.isArray(c) && c.length > 0 ? { $concatArrays: [c, read] } : read;
    case "$first":
      return c === null ? read : c;
    case "$last":
      return read;
  }
}

const NOT_CONSTANT: unique symbol = Symbol("not constant");
/** The value a literal spells: a number, a string, a boolean, null, or a list or document of those. Or NOT_CONSTANT. */
function constantOf(e: Expr): unknown {
  switch (e.type) {
    case "NumberLiteral":
    case "StringLiteral":
    case "BooleanLiteral":
      return e.value;
    case "NullLiteral":
    case "UndefinedLiteral":
      return null;
    case "ArrayLiteral": {
      const out: unknown[] = [];
      for (const el of e.elements) {
        if (el.type === "SpreadElement") return NOT_CONSTANT;
        const v = constantOf(el as Expr);
        if (v === NOT_CONSTANT) return NOT_CONSTANT;
        out.push(v);
      }
      return out;
    }
    case "ObjectLiteral": {
      const out: Record<string, unknown> = {};
      for (const en of e.entries) {
        if (en.type !== "KeyValueEntry" || en.key.kind !== "static") return NOT_CONSTANT;
        const v = constantOf(en.value);
        if (v === NOT_CONSTANT) return NOT_CONSTANT;
        out[en.key.name] = v;
      }
      return out;
    }
    default:
      return NOT_CONSTANT;
  }
}

/** Is this `$$.reduce(…)` a fold of the ROOT stream? */
export const isStreamReduce = (e: Expr): e is Call =>
  e.type === "MethodCall" && e.name === "reduce" && e.object.type === "CollectionRef";

/** Does a `$$ = [ … ]` list hold a reducer wrap, and is it the whole list? */
export function isReduceWrap(list: Extract<Expr, { type: "ArrayLiteral" }>): boolean {
  if (list.elements.length !== 1) return false;
  const el = list.elements[0];
  if (el.type === "ObjectLiteral") return el.entries.some((e) => e.type === "KeyValueEntry" && isStreamReduce(e.value));
  return el.type !== "SpreadElement" && isStreamReduce(el as Expr);
}

/** The dotted path `d.a.b` spells on the document parameter, or null. */
function fieldOf(e: Expr, param: string): string | null {
  if (e.type === "MemberAccess") {
    if (e.object.type === "Ident" && e.object.name === param) return e.name;
    const base = fieldOf(e.object, param);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

/** The accumulator a reducer body spells. `isAcc` says which node is the accumulator. */
function accumulatorOf(body: Expr, isAcc: (e: Expr) => boolean, param: string): Accumulator | null {
  if (body.type === "BinaryExpr" && body.op === "+") {
    const other = isAcc(body.left) ? body.right : isAcc(body.right) ? body.left : null;
    if (other !== null) {
      if (other.type === "NumberLiteral" && other.value === 1) return { op: "$sum", value: 1 };
      const f = fieldOf(other, param);
      if (f !== null) return { op: "$sum", value: "$" + f };
    }
  }
  if (
    body.type === "MethodCall" &&
    body.object.type === "Ident" &&
    body.object.name === "Math" &&
    (body.name === "max" || body.name === "min") &&
    body.args.length === 2
  ) {
    const [a, b] = body.args as readonly Expr[];
    const other = isAcc(a) ? b : isAcc(b) ? a : null;
    const f = other === null ? null : fieldOf(other, param);
    if (f !== null) return { op: body.name === "max" ? "$max" : "$min", value: "$" + f };
  }
  if (body.type === "BinaryExpr" && body.op === "??" && isAcc(body.left)) {
    const f = fieldOf(body.right, param);
    if (f !== null) return { op: "$first", value: "$" + f };
  }
  {
    const f = fieldOf(body, param);
    if (f !== null) return { op: "$last", value: "$" + f };
  }
  if (body.type === "ArrayLiteral" && body.elements.length === 2) {
    const [first, second] = body.elements;
    if (first.type === "SpreadElement" && isAcc(first.argument) && second.type !== "SpreadElement") {
      const f = fieldOf(second as Expr, param);
      if (f !== null) return { op: "$push", value: "$" + f };
    }
  }
  if (body.type === "MethodCall" && body.name === "concat" && body.args.length === 1 && isAcc(body.object)) {
    const a = body.args[0];
    const f = a.type === "SpreadElement" ? null : fieldOf(a, param);
    if (f !== null) return { op: "$push", value: "$" + f };
  }
  return null;
}

/** The `(acc, d) => body` of a `$$.reduce(fn, init)`, its two parameters checked. */
export function reducerOf(call: Call): { lambda: Lambda; acc: string; param: string; body: Expr } {
  if (call.args.length !== 2) throw E.reduceWrapArity(call.args.length, call.pos);
  const fn = call.args[0];
  if (fn.type !== "Lambda" || fn.body === undefined || fn.params.length !== 2) throw E.reduceWrapCallback(call.pos);
  return { lambda: fn, acc: fn.params[0], param: fn.params[1], body: fn.body };
}

/**
 * `$$ = [ … ]` that holds a reducer wrap → `[{ $group: { _id: null, … } }, { $replaceWith: { … } }]`.
 */
export function reduceWrapStages(list: Extract<Expr, { type: "ArrayLiteral" }>): Stage[] {
  const el = list.elements[0] as Expr;
  const group: Record<string, unknown> = { _id: null };
  const replace: Record<string, unknown> = {};
  const add = (key: string, acc: Accumulator, init: Expr): void => {
    group[key] = { [acc.op]: acc.value };
    replace[key] = seeded(acc, init, "$" + key);
  };
  if (el.type === "ObjectLiteral") {
    // `[{ k: $$.reduce(…), … }]` — one fold per key, with `acc` as the bare parameter.
    for (const e of el.entries) {
      if (e.type !== "KeyValueEntry" || e.key.kind !== "static") throw E.reduceWrapEntry(e.pos);
      if (!isStreamReduce(e.value)) throw E.reduceWrapEntry(e.value.pos);
      const r = reducerOf(e.value);
      const acc = accumulatorOf(r.body, (x) => x.type === "Ident" && x.name === r.acc, r.param);
      if (acc === null) throw E.reduceWrapShape(r.acc, r.param, r.body.pos);
      add(e.key.name, acc, e.value.args[1] as Expr);
    }
    return [{ $group: group }, { $replaceWith: replace }];
  }
  // `[$$.reduce((acc, d) => ({ ...acc, k: … }), { k: init })]` — the body names every fold.
  const r = reducerOf(el as Call);
  if (r.body.type !== "ObjectLiteral") throw E.reduceWrapObjectBody(r.acc, r.body.pos);
  const init = (el as Call).args[1];
  // `({ ...acc, [d.k]: d.v })` from `{}` — one document keyed by a field. The compiler
  // pushes every pair, then applies `$arrayToObject`. The key is a field of the document.
  const keyed = keyedEntry(r.body, r.acc, r.param);
  // `({ [d.k]: d.v })` without `...acc` replaces the accumulator at every step. JavaScript keeps only the LAST document.
  if (
    keyed === null &&
    r.body.entries.length === 1 &&
    r.body.entries[0].type === "KeyValueEntry" &&
    r.body.entries[0].key.kind === "computed"
  ) {
    throw E.reduceWrapKeyedNeedsSpread(r.acc, r.body.pos);
  }
  if (keyed !== null) {
    if (init.type !== "ObjectLiteral" || init.entries.length !== 0) throw E.reduceWrapKeyedInit(init.pos);
    return [
      { $group: { _id: null, __jsmqlTmp: { $push: { k: keyed.k, v: keyed.v } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ];
  }
  const initKeys = new Set(
    init.type === "ObjectLiteral"
      ? init.entries.flatMap((e) => (e.type === "KeyValueEntry" && e.key.kind === "static" ? [e.key.name] : []))
      : [],
  );
  const seen = new Set<string>();
  r.body.entries.forEach((e, i) => {
    if (e.type === "SpreadElement") {
      if (i === 0 && e.argument.type === "Ident" && e.argument.name === r.acc) return;
      throw E.reduceWrapEntry(e.pos);
    }
    if (e.key.kind !== "static") throw E.reduceWrapEntry(e.pos);
    const key = e.key.name;
    const isAcc = (x: Expr): boolean =>
      x.type === "MemberAccess" && x.name === key && x.object.type === "Ident" && x.object.name === r.acc;
    const acc = accumulatorOf(e.value, isAcc, r.param);
    if (acc === null) throw E.reduceWrapShape(`${r.acc}.${key}`, r.param, e.value.pos);
    if (!initKeys.has(key)) throw E.reduceWrapInit(key, "the body folds it, the init does not start it", init.pos);
    seen.add(key);
    const seed = (init as Extract<Expr, { type: "ObjectLiteral" }>).entries.find(
      (x) => x.type === "KeyValueEntry" && x.key.kind === "static" && x.key.name === key,
    ) as Extract<Expr, { type: "ObjectLiteral" }>["entries"][number] & { value: Expr };
    add(key, acc, seed.value);
  });
  for (const k of initKeys)
    if (!seen.has(k)) throw E.reduceWrapInit(k, "the init starts it, the body does not fold it", init.pos);
  return [{ $group: group }, { $replaceWith: replace }];
}

/**
 * `({ ...acc, [d.k]: d.v })` — a body of exactly the accumulator spread and one
 * computed entry keyed by a field of the document, with a field or the
 * whole document as its value. Null for any other body.
 */
function keyedEntry(
  body: Extract<Expr, { type: "ObjectLiteral" }>,
  acc: string,
  param: string,
): { k: string; v: string } | null {
  if (body.entries.length !== 2) return null;
  const [spread, entry] = body.entries;
  if (spread.type !== "SpreadElement" || spread.argument.type !== "Ident" || spread.argument.name !== acc) return null;
  if (entry.type !== "KeyValueEntry" || entry.key.kind !== "computed") return null;
  const k = fieldOf(entry.key.expr, param);
  if (k === null) return null;
  const v = entry.value.type === "Ident" && entry.value.name === param ? "$$ROOT" : fieldOf(entry.value, param);
  if (v === null) return null;
  return { k: "$" + k, v: v === "$$ROOT" ? v : "$" + v };
}

/** Is there a `$$.reduce(…)` anywhere in this tree — a wrap placed in the wrong spot? */
export function holdsStreamReduce(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(holdsStreamReduce);
  const n = node as { type?: string } & Record<string, unknown>;
  if (n.type === "MethodCall" && isStreamReduce(n as unknown as Expr)) return true;
  if (n.type === "MethodCall" && (chainBase(n) as { type: string }).type === "CollectionRef" && n.name === "reduce")
    return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && k !== "pos" && holdsStreamReduce(v));
}

/**
 * The ARRAY reducer as a stream. `$$.reduce((acc, d) => acc.concat(<doc>), [])`
 * keeps every document reshaped, and `(acc, d) => cond ? acc.concat(<doc>) : acc`
 * filters first: a `$match` and a `$replaceWith`, with `d` as the document. Any
 * other body is a total, which the wrap form computes instead; the refusal names it.
 */
export function arrayReduceParts(call: Call): { test: Lambda | null; doc: Lambda } {
  const { lambda, acc, param, body } = reducerOf(call);
  const seed = call.args[1];
  if (seed === undefined || seed.type !== "ArrayLiteral" || seed.elements.length !== 0)
    throw E.arrayReduceShape(call.pos);
  const appended = (e: Expr): Expr | null => {
    if (e.type === "MethodCall" && e.name === "concat" && e.object.type === "Ident" && e.object.name === acc) {
      const [only] = e.args;
      return e.args.length === 1 && only.type !== "SpreadElement" ? only : null;
    }
    if (e.type === "ArrayLiteral" && e.elements.length === 2) {
      const [first, second] = e.elements;
      if (
        first.type === "SpreadElement" &&
        first.argument.type === "Ident" &&
        first.argument.name === acc &&
        second.type !== "SpreadElement"
      ) {
        return second as Expr;
      }
    }
    return null;
  };
  const one = (b: Expr): Lambda => ({ type: "Lambda", params: [param], body: b, pos: lambda.pos });
  const plain = appended(body);
  if (plain !== null) return { test: null, doc: one(plain) };
  if (body.type === "TernaryExpr" && body.alternate.type === "Ident" && body.alternate.name === acc) {
    const kept = appended(body.consequent);
    if (kept !== null) return { test: one(body.test), doc: one(kept) };
  }
  throw E.arrayReduceShape(body.pos);
}
