// Phase 5 — EMIT. The union road: `$$.push(…)` as a statement and `.concat(…)` as a
// chain link, both the `$unionWith` stages they mean, one per argument in order.
//
//   $$.push(...$$$.archive)                → { $unionWith: "archive" }
//   $$.push(...$$$.archive.filter(p))      → { $unionWith: { coll: "archive", pipeline: [$match] } }
//   $$.push($$$.archive.find(p))           → the same with `{ $limit: 1 }` — one document, no spread
//   $$.push({ a: 1 }, { b: 2 })            → { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { b: 2 }] }] } }
//
// JavaScript's spread rule holds: an array (a `.filter`, a whole collection) is
// spread in, one document (`.find`, a literal) is not, and the wrong one is
// refused with the other spelling. `$unionWith` has no `let`, so a body that reads
// the outer document is refused where it reads it (Env.render); `$documents` runs
// with no input document at all, so `{ a: $.a }` there is refused the same way.
// See docs/specs/emit-pass.md § The union road.

import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { Chain, type Env } from "./env.ts";
import * as E from "./errors.ts";
import { lookupOf, readsAnotherCollection, type JoinServices } from "./join.ts";
import { lowerValue } from "./lower.ts";
import { kindOf } from "./types.ts";
import { childEnv } from "./inputs.ts";

type Arg = Extract<Expr, { type: "MethodCall" }>["args"][number];

/** `$$.push(a, b, …)` / `.concat(a, b, …)` — one `$unionWith` per source, in order. */
export function unionStages(args: readonly Arg[], env: Env, node: Expr, S: JoinServices): Stage[] {
  if (args.length === 0) throw E.unionNeedsArgument(node.pos);
  const out: Stage[] = [];
  let docs: Expr[] = [];
  const flushDocs = (): void => {
    if (docs.length === 0) return;
    // The documents are evaluated with NO input document: a `$unionWith` body, over nothing.
    const body = env.enter({ stage: "$unionWith", path: ["pipeline"], capture: null }, new Chain());
    const list = docs.map((d) => lowerValue(d, childEnv(body, node, "args")));
    out.push({ $unionWith: { pipeline: [{ $documents: list }] } });
    docs = [];
  };
  for (const a of args) {
    if (a.type === "SpreadElement") {
      flushDocs();
      if (!readsAnotherCollection(a.argument)) throw E.unionSpreadSource(a.pos);
      const l = lookupOf(a.argument, env, S, "$unionWith");
      if (!l.complete) throw E.valueInStream(l.rest[0]?.name ?? "length", l.pos);
      if (l.one === "find") throw E.unionSpreadOfOne(a.pos);
      out.push(
        l.pipeline.length === 0 ? { $unionWith: l.from } : { $unionWith: { coll: l.from, pipeline: l.pipeline } },
      );
      continue;
    }
    if (a.type === "ObjectLiteral") {
      docs.push(a);
      continue;
    }
    if (readsAnotherCollection(a)) {
      flushDocs();
      const l = lookupOf(a, env, S, "$unionWith");
      if (!l.complete) throw E.valueInStream(l.rest[0]?.name ?? "length", l.pos);
      if (l.one !== "find") throw E.unionNeedsSpread(a.pos);
      out.push({ $unionWith: { coll: l.from, pipeline: l.pipeline } });
      continue;
    }
    // A value that is not a document literal: a number, a field, an array …
    if (a.type === "NullLiteral" || a.type === "UndefinedLiteral")
      throw E.unionArg(a.type === "NullLiteral" ? "null" : "undefined", a.pos);
    const kind = kindOf(a, env);
    if (kind === "object" || kind === "unknown") {
      docs.push(a);
      continue;
    }
    throw E.unionArg(kind, a.pos);
  }
  flushDocs();
  return out;
}
