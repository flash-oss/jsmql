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
import { constantIn, pathOfIn } from "./filter.ts";
import { internalError } from "../../errors.ts";
import {
  blockWhereValueExpected,
  mapMustReturnDocument,
  needsPipeline,
  notAFieldOfTheDocument,
  notAnArrow,
  unfilledParam,
  valueWhereBlockExpected,
} from "./errors.ts";
import { kindOf } from "./types.ts";
import type { Env } from "./env.ts";
import { edge } from "../passes/position.ts";

/** The two readings of an expression, supplied by lower.ts. */
export type Reader = { value: (node: Expr, env: Env) => unknown; truth: (node: Expr, env: Env) => Truth };

/** The Env a child at property `key` of `node` is lowered under — phase 4's answer, applied. */
export const childEnv = (env: Env, node: object, key: string): Env => env.at(edge(node, key, env.site.where));

/**
 * A callback bound for a body: the one element parameter is a variable, and the
 * body is lowered under it. Rows with a real renderer bind one parameter here;
 * an index or collection parameter is a different lowering, and no row that
 * reaches this constructor states one.
 */
function callback(cb: Expr, env: Env, read: (body: Expr, e: Env) => unknown): { as: string; in: unknown } {
  if (cb.type !== "Lambda" || cb.body === undefined) {
    internalError("a renderer asked for a callback body from an argument that is not an expression arrow");
  }
  if (cb.params.length !== 1) {
    internalError(`a renderer asked for a one-parameter callback and the arrow has ${cb.params.length}`);
  }
  const bound = env.param(cb.params[0], "unknown", cb.pos);
  return { as: bound.as, in: read(cb.body, childEnv(bound.env, cb, "body")) };
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
    predicate: (cb) => callback(cb, argEnv, read.truth) as { as: string; in: Truth },
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
    hoist: (stages: readonly Stage[], reads: string) => {
      if (!env.chain.isPipeline) throw needsPipeline(name, (node as { pos: number }).pos);
      return env.chain.hoist(stages, reads);
    },
    slot: () => env.chain.slot().path,
  };
}

/** The two query readings, supplied by filter.ts. */
export type QueryReader = {
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
        .bind(cb.params[0], { ref: { kind: "document" }, type: "unknown", mutable: false, pos: cb.pos });
      return read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
    },
  };
}

/** The three readings a STAGE cell asks of an argument, supplied by statement.ts. */
export type StageReader = {
  value: (node: Expr, env: Env) => unknown;
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
): StageIn & { keys: readonly string[] } {
  const argEnv = childEnv(env, node, "args");
  /**
   * A callback's FIRST parameter IS the stream's document, so its fields are
   * top-level paths. lodash lets a callback name an index and the collection too;
   * a stream has no per-document index and the collection is the stream itself,
   * so each is bound as a name whose READ says what to write instead.
   */
  const bound = (cb: Expr): Env | null => {
    if (cb.type !== "Lambda" || cb.params.length < 1 || cb.params.length > 3) return null;
    // The parameters open the callback's block: a `let` of the same name inside it collides.
    let e = argEnv
      .block()
      .bind(cb.params[0], { ref: { kind: "document" }, type: "unknown", mutable: false, pos: cb.pos });
    if (cb.params.length >= 2) {
      e = e.bind(cb.params[1], {
        ref: {
          kind: "dropped",
          message: unfilledParam(cb.params[1], name, "a stream has no per-document index; leave the parameter unused."),
          replaced: false,
        },
        type: "unknown",
        mutable: false,
        pos: cb.pos,
      });
    }
    if (cb.params.length === 3) {
      e = e.bind(cb.params[2], {
        ref: {
          kind: "dropped",
          message: unfilledParam(
            cb.params[2],
            name,
            "the collection is the stream itself; write '$$.length' for its size.",
          ),
          replaced: false,
        },
        type: "unknown",
        mutable: false,
        pos: cb.pos,
      });
    }
    return e;
  };
  /**
   * A callback's body and the env it is lowered under — the parameter IS the
   * document. Not an arrow at all — `.countBy(String)` — is the developer's
   * mistake, worded; the shorthands a row accepts have been rewritten to arrows
   * by then, so what arrives here is the arrow or the error.
   */
  const body = (cb: Expr, what: string): { body: Expr; env: Env } => {
    const e = bound(cb);
    if (e === null) throw notAnArrow(name, what, cb);
    const b = (cb as { body?: Expr }).body;
    if (b === undefined) throw blockWhereValueExpected(name, cb.pos);
    return { body: b, env: childEnv(e, cb, "body") };
  };
  return {
    name,
    args,
    keys,
    value: (e) => read.value(e, argEnv),
    predicate: (cb) => {
      const b = body(cb, "a predicate");
      return read.predicate(b.body, b.env);
    },
    reshape: (cb) => {
      const b = body(cb, "a reshape");
      return read.reshape(b.body, b.env);
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
      if (e === null) throw notAnArrow(name, "a block of stages", cb);
      const stages = (cb as { stages?: Pipeline }).stages;
      if (stages === undefined) throw valueWhereBlockExpected(name, cb.pos);
      return read.block(stages, e);
    },
    sortSpec: (e, objects = true) => sortSpecOf(e, name, objects),
    orderBy: (keys, orders) => orderBySpec(keys, orders, name),
    slot: () => env.chain.slot().path,
    prevStages: env.chain.emitted,
    bind: (hint) => {
      const b = env.fresh(hint);
      return { as: b.as, ref: b.ref };
    },
  };
}
