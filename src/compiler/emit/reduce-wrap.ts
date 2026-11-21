import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { chainBase } from "../passes/naming.ts";
import * as E from "./errors.ts";
import { propertyKeyExpr } from "../../registry/mql.ts";

type Lambda = Extract<Expr, { type: "Lambda" }>;
type Call = Extract<Expr, { type: "MethodCall" }>;
type Accumulator = { op: "$sum" | "$max" | "$min" | "$first" | "$last" | "$push"; value: unknown };

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

export const isStreamReduce = (e: Expr): e is Call =>
  e.type === "MethodCall" && e.name === "reduce" && e.object.type === "StreamRef";

export function isReduceWrap(list: Extract<Expr, { type: "ArrayLiteral" }>): boolean {
  if (list.elements.length !== 1) return false;
  const el = list.elements[0];
  if (el.type === "ObjectLiteral") return el.entries.some((e) => e.type === "KeyValueEntry" && isStreamReduce(e.value));
  return el.type !== "SpreadElement" && isStreamReduce(el as Expr);
}

function fieldOf(e: Expr, param: string): string | null {
  if (e.type === "MemberAccess") {
    if (e.object.type === "Ident" && e.object.name === param) return e.name;
    const base = fieldOf(e.object, param);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

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
    body.object.type === "ArrayLiteral" &&
    (body.name === "max" || body.name === "min") &&
    body.args.length === 0 &&
    body.object.elements.length === 2 &&
    body.object.elements.every((e) => e.type !== "SpreadElement")
  ) {
    const [a, b] = body.object.elements as readonly Expr[];
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

export function reducerOf(call: Call): { lambda: Lambda; acc: string; param: string; body: Expr } {
  if (call.args.length !== 2) throw E.reduceWrapArity(call.args.length, call.pos);
  const fn = call.args[0];
  if (fn.type !== "Lambda" || fn.body === undefined || fn.params.length !== 2) throw E.reduceWrapCallback(call.pos);
  return { lambda: fn, acc: fn.params[0], param: fn.params[1], body: fn.body };
}

export function reduceWrapStages(list: Extract<Expr, { type: "ArrayLiteral" }>, wholeDocument: () => unknown): Stage[] {
  const el = list.elements[0] as Expr;
  const group: Record<string, unknown> = { _id: null };
  const replace: Record<string, unknown> = {};
  const add = (key: string, acc: Accumulator, init: Expr): void => {
    group[key] = { [acc.op]: acc.value };
    replace[key] = seeded(acc, init, "$" + key);
  };
  if (el.type === "ObjectLiteral") {
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
  const r = reducerOf(el as Call);
  if (r.body.type !== "ObjectLiteral") throw E.reduceWrapObjectBody(r.acc, r.body.pos);
  const init = (el as Call).args[1];
  const keyed = keyedEntry(r.body, r.acc, r.param);
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
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: propertyKeyExpr(keyed.k), v: keyed.v === ROOT ? wholeDocument() : keyed.v } },
        },
      },
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

const ROOT = "$$ROOT";

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
  const v = entry.value.type === "Ident" && entry.value.name === param ? ROOT : fieldOf(entry.value, param);
  if (v === null) return null;
  return { k: "$" + k, v: v === ROOT ? v : "$" + v };
}

export function holdsStreamReduce(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(holdsStreamReduce);
  const n = node as { type?: string } & Record<string, unknown>;
  if (n.type === "MethodCall" && isStreamReduce(n as unknown as Expr)) return true;
  if (n.type === "MethodCall" && (chainBase(n) as { type: string }).type === "StreamRef" && n.name === "reduce")
    return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && k !== "pos" && holdsStreamReduce(v));
}

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
