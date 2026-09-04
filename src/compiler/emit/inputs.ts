// Phase 5 — EMIT. The `In` record a renderer receives, built from an Env in one
// place.
//
// A renderer never sees the Env. It receives its arguments, its receiver, and
// SERVICES — `value`, `truth`, `iteratee`, `predicate`, `bind`, `hoist`, `slot`
// — each closed over the Env the call stands in. Every field is required by
// type, and there is exactly one constructor, so a renderer cannot be handed a
// record with a service missing.

import type { Expr, ExprIn, FilterIn, QueryDoc, Stage, Truth } from "../../registry/vocabulary.ts";
import { constantIn, pathOfIn } from "./filter.ts";
import { internalError } from "../../errors.ts";
import { needsPipeline } from "./errors.ts";
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
      const bodyEnv = argEnv.bind(cb.params[0], {
        ref: { kind: "document" },
        type: "unknown",
        mutable: false,
        pos: cb.pos,
      });
      return read.lowerNativeFilter(cb.body, childEnv(bodyEnv, cb, "body"));
    },
  };
}
