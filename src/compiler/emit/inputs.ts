// Phase 5 — EMIT. The `In` record a renderer receives, built from an Env in one
// place.
//
// A renderer never sees the Env. It receives its arguments, its receiver, and
// SERVICES — `value`, `truth`, `iteratee`, `predicate`, `bind`, `hoist`, `slot`
// — each closed over the Env the call stands in. Every field is required by
// type, and there is exactly one constructor, so a renderer cannot be handed a
// record with a service missing.

import type { Expr, ExprIn, FilterIn, QueryDoc, Stage, StageIn, Truth } from "../../registry/vocabulary.ts";
import type { Pipeline } from "../../registry/ast.ts";
import { orderBySpec, sortSpecOf } from "./sort-spec.ts";
import { constantIn, literalIn, pathOfIn } from "./filter.ts";
import { internalError } from "../../errors.ts";
import {
  badMatchesPropertyPair,
  blockWhereValueExpected,
  CodegenError,
  emptyMatcherObject,
  mapMustReturnDocument,
  needsPipeline,
  notAnArrowCallback,
  objIterateeShape,
  tooManyCallbackParams,
  notAFieldOfTheDocument,
  notAnArrow,
  unfilledParam,
  valueWhereBlockExpected,
  reducerShape,
  elementsShape,
  needsFieldPath,
  needsLiteral,
  elementNeedsQuery,
  needsPrecedingSort,
  streamHandleAfterReplace,
} from "./errors.ts";
import { preservesCountOf, slotFormsOf } from "../rows.ts";
import { kindOf } from "./types.ts";
import type { Env } from "./env.ts";
import { reduceVar } from "./names.ts";
import { indexedPairs, mongoRegexOptions } from "../../registry/mql.ts";
import { edge } from "../passes/position.ts";

/** The two readings of an expression, supplied by lower.ts. */
export type Reader = { value: (node: Expr, env: Env) => unknown; truth: (node: Expr, env: Env) => Truth };

/** The Env a child at property `key` of `node` is lowered under — phase 4's answer, applied. */
export const childEnv = (env: Env, node: object, key: string): Env => {
  const at = env.at(edge(node, key, env.site.where));
  const n = node as { type?: string; name?: string };
  // An operator's arguments are INSIDE it — what a fragment like `$case` or `$box` is valid only within;
  // any other call boundary is inside nothing.
  if (n.type === "OperatorCall" && key === "args") return at.inside(n.name ?? null);
  if (n.type === "MethodCall" || n.type === "CallExpression" || n.type === "NewExpression" || n.type === "Lambda") {
    return at.inside(null);
  }
  return at;
};

/**
 * A callback bound for a body: the one element parameter is a variable, and the
 * body is lowered under it. Rows with a real renderer bind one parameter here;
 * an index or collection parameter is a different lowering, and no row that
 * reaches this constructor states one.
 */
function callback(cb: Expr, env: Env, read: (body: Expr, e: Env) => unknown): { as: string; ref: string; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined) {
    internalError("a renderer asked for a callback body from an argument that is not an expression arrow");
  }
  if (cb.params.length !== 1) {
    internalError(`a renderer asked for a one-parameter callback and the arrow has ${cb.params.length}`);
  }
  const bound = env.param(cb.params[0], "unknown", cb.pos);
  return { as: bound.as, ref: bound.ref, in: read(cb.body, childEnv(bound.env, cb, "body")) };
}

/** Does the arrow's body read its parameter `name`? */
function readsParam(node: unknown, name: string): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((n) => readsParam(n, name));
  const n = node as { type?: string; name?: string } & Record<string, unknown>;
  if (n.type === "Ident" && n.name === name) return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && readsParam(v, name));
}

/**
 * An ARRAY callback — `(x[, i[, arr]]) => …` — as what a `$map`/`$filter` takes.
 * The element is the parameter; an index READ makes the input the `[i, x]` pairs
 * of a `$zip`, and the array parameter is the receiver bound by name.
 */
function arrayCallback(
  cb: Expr,
  recv: unknown,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
): { input: unknown; as: string; ref: string; paired: boolean; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined) throw notAnArrowCallback(name, (cb as { pos: number }).pos);
  if (cb.params.length > 3) throw tooManyCallbackParams(name, cb.params.length, cb.pos);
  const [elem, index, arr] = cb.params;
  const usesIndex = index !== undefined && readsParam(cb.body, index);
  if (!usesIndex) {
    const bound = env.param(elem ?? "_", "unknown", cb.pos);
    let bodyEnv = bound.env;
    const vars: Record<string, unknown> = {};
    if (arr !== undefined) {
      const a = bodyEnv.param(arr, "array", cb.pos);
      vars[a.as] = recv;
      bodyEnv = a.env;
    }
    const body = read(cb.body, childEnv(bodyEnv, cb, "body"));
    return {
      input: recv,
      as: bound.as,
      ref: bound.ref,
      paired: false,
      in: arr === undefined ? body : { $let: { vars, in: body } },
    };
  }
  const pair = env.fresh("pair");
  let bodyEnv = pair.env;
  const vars: Record<string, unknown> = {};
  const x = bodyEnv.param(elem, "unknown", cb.pos);
  vars[x.as] = { $arrayElemAt: [pair.ref, 1] };
  bodyEnv = x.env;
  const i = bodyEnv.param(index, "number", cb.pos);
  vars[i.as] = { $arrayElemAt: [pair.ref, 0] };
  bodyEnv = i.env;
  if (arr !== undefined) {
    const a = bodyEnv.param(arr, "array", cb.pos);
    vars[a.as] = recv;
    bodyEnv = a.env;
  }
  const size = { $size: Array.isArray(recv) ? [recv] : recv };
  return {
    input: { $zip: { inputs: [{ $range: [0, size] }, recv] } },
    as: pair.as,
    ref: pair.ref,
    paired: true,
    in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } },
  };
}

/** Does the body call anything? A call may lower to a `$reduce` of its own, whose `$$value`/`$$this` shadow the reducer's. */
function callsSomething(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(callsSomething);
  const n = node as { type?: string } & Record<string, unknown>;
  if (n.type === "MethodCall" || n.type === "CallExpression" || n.type === "NewExpression" || n.type === "OperatorCall")
    return true;
  return Object.entries(n).some(([k, v]) => k !== "type" && callsSomething(v));
}

/**
 * A REDUCER — `(acc, x[, i]) => …` — as what a `$reduce` takes. The accumulator IS
 * `$$value` and the element IS `$$this` when the body is plain arithmetic; a body
 * that calls anything reads them through a `$let`, because the call may lower to
 * a `$reduce` of its own and shadow both. An index read makes the input the
 * `[i, x]` pairs, bound the same way.
 */
function reducerCallback(
  cb: Expr,
  seed: Expr,
  recv: unknown,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
): { input: unknown; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length < 2 || cb.params.length > 3) {
    throw reducerShape(name, (cb as { pos: number }).pos);
  }
  const [acc, elem, index] = cb.params;
  const accType = kindOf(seed, env);
  const direct = !callsSomething(cb.body);
  const vars: Record<string, unknown> = {};
  let bodyEnv = env;
  if (direct) {
    bodyEnv = bodyEnv.bind(acc, {
      ref: { kind: "var", ref: reduceVar("value") },
      type: accType,
      elements: "unknown",
      mutable: false,
      pos: cb.pos,
    });
  } else {
    const a = bodyEnv.param(acc, accType, cb.pos);
    vars[a.as] = reduceVar("value");
    bodyEnv = a.env;
  }
  if (index === undefined) {
    if (direct) {
      bodyEnv = bodyEnv.bind(elem, {
        ref: { kind: "var", ref: reduceVar("this") },
        type: "unknown",
        elements: "unknown",
        mutable: false,
        pos: cb.pos,
      });
      return { input: recv, in: read(cb.body, childEnv(bodyEnv, cb, "body")) };
    }
    const x = bodyEnv.param(elem, "unknown", cb.pos);
    vars[x.as] = reduceVar("this");
    bodyEnv = x.env;
    return { input: recv, in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
  }
  const x = bodyEnv.param(elem, "unknown", cb.pos);
  vars[x.as] = { $arrayElemAt: [reduceVar("this"), 1] };
  bodyEnv = x.env;
  const i = bodyEnv.param(index, "number", cb.pos);
  vars[i.as] = { $arrayElemAt: [reduceVar("this"), 0] };
  bodyEnv = i.env;
  return { input: indexedPairs(recv), in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
}

/** An arrow of `count` parameters over one array's elements — each parameter bound to its position. */
function elementsCallback(
  cb: Expr,
  count: number,
  env: Env,
  read: (body: Expr, e: Env) => unknown,
  name: string,
  pick: (element: string, k: number) => unknown = (element, k) => ({ $arrayElemAt: [element, k] }),
): { as: string; ref: string; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== count) {
    throw elementsShape(name, count, (cb as { pos: number }).pos);
  }
  const pair = env.fresh("pair");
  let bodyEnv = pair.env;
  const vars: Record<string, unknown> = {};
  cb.params.forEach((p, k) => {
    const b = bodyEnv.param(p, "unknown", cb.pos);
    vars[b.as] = pick(pair.ref, k);
    bodyEnv = b.env;
  });
  return { as: pair.as, ref: pair.ref, in: { $let: { vars, in: read(cb.body, childEnv(bodyEnv, cb, "body")) } } };
}

/**
 * The record for a call of `name` on `recv` with `args`, under `env`. `keys` is
 * the row's positional key order. `overrides` lets the dispatcher substitute a
 * lowering for one argument — the `$let` arrow whose body is lowered under its
 * variables — without the renderer knowing.
 */
export function exprInputs(
  name: string,
  recv: unknown,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: Reader,
  overrides: ReadonlyMap<Expr, unknown> = new Map(),
): ExprIn {
  const argEnv = childEnv(env, node, "args");
  const value = (e: Expr): unknown => (overrides.has(e) ? overrides.get(e) : read.value(e, argEnv));
  return {
    name,
    recv,
    args,
    keys,
    value,
    truth: (e) => read.truth(e, argEnv),
    iteratee: (cb) => callback(cb, argEnv, read.value),
    predicate: (cb) => callback(cb, argEnv, read.truth) as { as: string; ref: string; in: Truth },
    callback: (cb, mode) => arrayCallback(cb, recv, argEnv, mode === "value" ? read.value : read.truth, name),
    reducer: (cb, seed) => reducerCallback(cb, seed, recv, argEnv, read.value, name),
    elements: (cb, count, pick) => elementsCallback(cb, count, argEnv, read.value, name, pick),
    sortSpec: (e, objects) => sortSpecOf(e, name, objects),
    orderBy: (keys, orders) => orderBySpec(keys, orders, name),
    objIteratee: (cb) => {
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length < 1 || cb.params.length > 2) {
        throw objIterateeShape(name, (cb as { pos: number }).pos);
      }
      const kv = env.fresh("kv");
      // `value` and `key` are variables over the pair: bound as the developer's own names
      let bodyEnv = kv.env;
      const vars: Record<string, unknown> = {};
      const v = bodyEnv.param(cb.params[0], "unknown", cb.pos);
      vars[v.as] = `${kv.ref}.v`;
      bodyEnv = v.env;
      if (cb.params.length === 2) {
        const k = bodyEnv.param(cb.params[1], "string", cb.pos);
        vars[k.as] = `${kv.ref}.k`;
        bodyEnv = k.env;
      }
      return {
        as: kv.as,
        ref: kv.ref,
        body: { $let: { vars, in: read.value(cb.body, childEnv(bodyEnv, cb, "body")) } },
      };
    },
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
    hoist: (stages: readonly Stage[], reads: string) => {
      // `$$` is the TOP-MOST stream at every depth: the count is materialised on the
      // root pipeline, ahead of the statement that holds this read, and reaches a
      // body over another collection through its `let` like any outer field. The
      // body's OWN stream is its callback's third parameter, whose chain is this one.
      const source = (node as { object?: Expr }).object ?? null;
      const own = onOwnStream(source, env);
      const chain = own ? env.chain : env.rootChain;
      if (!chain.isPipeline) throw needsPipeline(name, (node as { pos: number }).pos);
      chain.hoist(stages, reads);
      const level = own ? env.level : 0;
      return env.render(
        { kind: "s", level, path: reads, hint: reads.slice(reads.lastIndexOf(".") + 1) },
        (node as { pos: number }).pos,
      );
    },
    slot: () => env.chain.slot().path,
  };
}

/**
 * The first stage in this callback's block that changes what a stamped count MEANS, or
 * null. The count is a field, hoisted to the front of the body, so a stage that drops
 * the fields loses it (`$group`) and a stage that changes how many documents there are
 * makes it stale (`$unwind`, `$match`, `$limit`). Only the stages whose rows state
 * `preservesCount` leave it meaning what it said.
 *
 * A syntactic question, asked of the source: the answer must not depend on where the
 * read sits, because the stamp is hoisted whatever the source order.
 */
function staleCountStage(cb: Expr): string | null {
  const stmts = (cb as { stages?: { stmts?: readonly { type: string; name?: string }[] } }).stages?.stmts;
  if (stmts === undefined) return null;
  for (const st of stmts) {
    if (st.type !== "OperatorCall" || typeof st.name !== "string") continue;
    if (!preservesCountOf(st.name)) return st.name;
  }
  return null;
}

/** Is `recv` the body's OWN stream — a callback's collection parameter — rather than `$$`, the root stream? */
export function onOwnStream(recv: Expr | null, env: Env): boolean {
  return (
    recv !== null &&
    recv.type === "Ident" &&
    env.scope.has(recv.name) &&
    env.lookup(recv.name, recv.pos).ref.kind === "streamHandle"
  );
}

/** The two query readings, supplied by filter.ts. */
export type QueryReader = {
  lowerValue: (node: Expr, env: Env) => unknown;
  lowerFilter: (node: Expr, env: Env) => QueryDoc;
  lowerNativeFilter: (node: Expr, env: Env) => QueryDoc | null;
};

/**
 * The record for a query cell: the receiver and arguments as SOURCE, the path
 * and constant readers, and the two query readings — one that always answers
 * (with `$expr`), one that answers only natively.
 */
export function filterInputs(
  name: string,
  recv: Expr | null,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: QueryReader,
): FilterIn {
  const argEnv = childEnv(env, node, "args");
  return {
    name,
    recv,
    args,
    keys,
    pathOf: (e) => pathOfIn(e, env),
    constant: constantIn,
    query: (e) => read.lowerFilter(e, argEnv),
    nativeQuery: (e) => read.lowerNativeFilter(e, argEnv),
    elementQuery: (cb) => {
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== 1) return null;
      // The element is the root inside `$elemMatch`: the parameter stands for the document.
      const bodyEnv = argEnv
        .element(cb.params[0])
        .bind(cb.params[0], {
          ref: { kind: "document" },
          type: "unknown",
          elements: "unknown",
          mutable: false,
          pos: cb.pos,
        });
      return read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
    },
    value: (e) => read.lowerValue(e, argEnv),
    fieldPath: (e) => {
      const path = pathOfIn(e, env);
      if (path === null) throw needsFieldPath(name, (e as { pos: number }).pos);
      return path;
    },
    literal: (e) => {
      if (e.type === "RegexLiteral") return new RegExp(e.pattern, mongoRegexOptions(e.flags));
      const c = literalIn(e);
      if (c === null) throw needsLiteral(name, (e as { pos: number }).pos);
      return c.value;
    },
    literalOf: literalIn,
    element: (cb) => {
      if (cb.type !== "Lambda" || cb.body === undefined || cb.params.length !== 1) {
        throw elementNeedsQuery(name, (cb as { pos: number }).pos);
      }
      const bodyEnv = argEnv
        .element(cb.params[0])
        .bind(cb.params[0], {
          ref: { kind: "document" },
          type: "unknown",
          elements: "unknown",
          mutable: false,
          pos: cb.pos,
        });
      const q = read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
      if (q === null) throw elementNeedsQuery(name, cb.pos);
      return q;
    },
  };
}

/** The three readings a STAGE cell asks of an argument, supplied by statement.ts. */
export type StageReader = {
  value: (node: Expr, env: Env) => unknown;
  truth: (node: Expr, env: Env) => Truth;
  predicate: (body: Expr, env: Env) => QueryDoc;
  reshape: (body: Expr, env: Env) => unknown;
  /** The statements of a stage-block callback, under the env the parameter is bound in. */
  block: (stages: Pipeline, env: Env) => Stage[];
};

/**
 * The record a STAGE cell receives — a stage's body, never an operand list. Its
 * `value` is the reading the BODY's own position asks for, which is how
 * `$match`'s row makes its body a query document and a sub-pipeline's elements
 * stages, without the cell knowing it asked for anything but a value.
 */
export function stageInputs(
  name: string,
  args: readonly Expr[],
  keys: readonly string[],
  env: Env,
  node: object,
  read: StageReader,
  /** The stages the current chain has produced before this link — not yet emitted, but before it in the pipeline. */
  soFar: readonly Stage[] = [],
  /**
   * The method the SOURCE wrote, which is `name` unless the link runs as another
   * row: `$$$.users.find(p)` runs `filter` and must still be refused as `.find()`.
   * Messages use this one; everything else uses the row.
   */
  written: string = name,
): StageIn & { keys: readonly string[] } {
  const argEnv = childEnv(env, node, "args");
  const before: readonly Stage[] = [...env.chain.emitted, ...soFar];
  /**
   * A callback's FIRST parameter IS the stream's document, so its fields are
   * top-level paths. lodash lets a callback name an index and the collection too;
   * a stream has no per-document index and the collection is the stream itself,
   * so each is bound as a name whose READ says what to write instead.
   */
  const bound = (cb: Expr): Env | null => {
    if (cb.type !== "Lambda" || cb.params.length > 3) return null;
    // The parameters open the callback's block: a `let` of the same name inside it collides.
    let e = argEnv.block();
    if (cb.params.length >= 1) {
      e = e.bind(cb.params[0], {
        ref: { kind: "document" },
        type: "unknown",
        elements: "unknown",
        mutable: false,
        pos: cb.pos,
      });
    }
    if (cb.params.length >= 2) {
      e = e.bind(cb.params[1], {
        ref: {
          kind: "dropped",
          message: unfilledParam(cb.params[1], name, "a stream has no per-document index; leave the parameter unused."),
          replaced: false,
        },
        type: "unknown",
        elements: "unknown",
        mutable: false,
        pos: cb.pos,
      });
    }
    if (cb.params.length === 3) {
      // The collection parameter IS the stream the callback runs over — at the top
      // the same as `$$`, inside a body over another collection that body's stream.
      // A body whose stages change the count or the fields cannot carry one: the stamp
      // is a FIELD, hoisted ahead of the body's stages. So the handle is refused for the
      // whole body, wherever the read sits.
      const replaces = staleCountStage(cb);
      e = e.bind(cb.params[2], {
        ref:
          replaces === null
            ? { kind: "streamHandle", source: cb }
            : {
                kind: "dropped",
                message: streamHandleAfterReplace(cb.params[2], replaces, cb.pos).message,
                replaced: false,
              },
        type: "stream",
        elements: "unknown",
        mutable: false,
        pos: cb.pos,
      });
    }
    return e;
  };
  /**
   * Why this argument is not the callback the slot wanted, worded as the mistake
   * it is: too many parameters, a matcher naming no field, a pair that is not one,
   * or a shape the slot never takes. Four fixes, so four sentences.
   */
  const callbackRefusal = (cb: Expr, what: string): CodegenError => {
    if (cb.type === "Lambda") return tooManyCallbackParams(written, cb.params.length, cb.pos);
    const forms = slotFormsOf(written, "stream", args.indexOf(cb));
    if (cb.type === "ObjectLiteral" && forms.includes("matchesObject")) {
      const entries = (cb as { entries?: readonly unknown[] }).entries;
      if (entries !== undefined && entries.length === 0) return emptyMatcherObject(written, cb.pos);
    }
    // A well-formed pair was rewritten to an arrow long before here, so one that
    // arrives is malformed: not two elements, or a first that is not a name.
    if (cb.type === "ArrayLiteral" && forms.includes("matchesPropertyPair")) {
      return badMatchesPropertyPair(written, cb.pos);
    }
    return notAnArrow(written, what, forms, cb);
  };
  /**
   * A callback's body and the env it is lowered under — the parameter IS the
   * document. Not an arrow at all — `.countBy(String)` — is the developer's
   * mistake, worded; the shorthands a row accepts have been rewritten to arrows
   * by then, so what arrives here is the arrow or the error.
   */
  const body = (cb: Expr, what: string): { body: Expr; env: Env } => {
    const e = bound(cb);
    if (e === null) throw callbackRefusal(cb, what);
    const b = (cb as { body?: Expr }).body;
    if (b === undefined) throw blockWhereValueExpected(written, cb.pos);
    return { body: b, env: childEnv(e, cb, "body") };
  };
  return {
    name,
    args,
    keys,
    value: (e) => read.value(e, argEnv),
    truth: (e) => read.truth(e, argEnv),
    predicate: (cb) => {
      const b = body(cb, "a predicate");
      return read.predicate(b.body, b.env);
    },
    reshape: (cb) => {
      const b = body(cb, "a key");
      return read.reshape(b.body, b.env);
    },
    condition: (cb) => {
      const b = body(cb, "a predicate");
      return read.truth(b.body, b.env);
    },
    sortedBy: () => {
      for (let k = before.length - 1; k >= 0; k--) {
        const spec = (before[k] as Record<string, unknown>).$sort;
        if (spec !== undefined) return spec as Record<string, unknown>;
      }
      throw needsPrecedingSort(name, (node as { pos: number }).pos);
    },
    document: (cb) => {
      const b = body(cb, "a document");
      const kind = b.body.type === "NullLiteral" ? "null" : kindOf(b.body, b.env);
      if (kind !== "unknown" && kind !== "object") throw mapMustReturnDocument(name, kind, b.body.pos);
      return read.reshape(b.body, b.env);
    },
    fieldPath: (cb) => {
      const b = body(cb, "a field");
      const v = read.reshape(b.body, b.env);
      if (typeof v !== "string" || !v.startsWith("$") || v.startsWith("$$")) throw notAFieldOfTheDocument(name, cb.pos);
      return v;
    },
    block: (cb) => {
      const e = bound(cb);
      // Not an arrow at all: the block form is the only spelling, so the sentence
      // that shows it is the same one an arrow with a value body already gets.
      if (e === null) {
        throw cb.type === "Lambda"
          ? tooManyCallbackParams(written, cb.params.length, cb.pos)
          : valueWhereBlockExpected(written, cb.pos);
      }
      const stages = (cb as { stages?: Pipeline }).stages;
      if (stages === undefined) throw valueWhereBlockExpected(written, cb.pos);
      return read.block(stages, e);
    },
    sortSpec: (e, objects = true) => sortSpecOf(e, name, objects),
    orderBy: (keys, orders) => orderBySpec(keys, orders, name),
    slot: () => env.chain.slot().path,
    prevStages: before,
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
  };
}
