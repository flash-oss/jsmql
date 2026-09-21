// Phase 5 — EMIT. The union road: `$$.push(…)` as a statement and `.concat(…)` as a
// chain link, both the `$unionWith` stages they mean, one per argument in order.
//
//   $$.push(...$$$.archive)                → { $unionWith: "archive" }
//   $$.push(...$$$.archive.filter(p))      → { $unionWith: { coll: "archive", pipeline: [$match] } }
//   $$.push($$$.archive.find(p))           → the same with `{ $limit: 1 }` — one document, no spread
//   $$.push({ a: 1 }, { b: 2 })            → { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { b: 2 }] }] } }
//   $$.push(...[{ a: 1 }, { b: 2 }])       → the same: a written list spreads into the same batch
//   $$.concat([{ a: 1 }])                  → the same, and `.concat` takes the array itself, as JavaScript does
//
// JavaScript's spread rule holds: the compiler spreads in an array (a `.filter`,
// a whole collection), does not spread one document (`.find`, a literal), and
// refuses the wrong one with the other spelling. `$unionWith` has no `let`, so
// the compiler refuses a body that reads the outer document where it reads it
// (Env.render). `$documents` runs with no input document at all, so it refuses
// `{ a: $.a }` there the same way.
// See docs/specs/emit-pass.md § The union road.

import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { Chain, type Env } from "./env.ts";
import * as E from "./errors.ts";
import { lookupOf, readsAnotherCollection, type JoinServices } from "./join.ts";
import { lowerValue } from "./lower.ts";
import { typeOf } from "./prove.ts";
import { cannotBe } from "./type.ts";
import { childEnv } from "./inputs.ts";
import { bansNestedOf } from "../rows.ts";

/** The stage a written list of documents makes — the one a container may ban at any depth. */
const DOCUMENTS = "$documents";

/**
 * A value in a written document list that needed a STAGE of its own. `$documents`
 * is the first stage of the `$unionWith` body, so nothing can stand ahead of it
 * to produce the value. The read would then be a path nothing writes — measured,
 * the server answers `{}` for such a document rather than refusing it. Both
 * spellings of the list (`$$.push({ … })` and `$$ = [{ … }]`) call this.
 */
export function noStageInDocuments(chain: Chain, written: string, pos: number): void {
  const made = chain.hoisted[0] ?? chain.emitted[0];
  if (made !== undefined) throw E.documentsNeedNoStage(written, Object.keys(made)[0], pos);
}

type Arg = Extract<Expr, { type: "MethodCall" }>["args"][number];

/**
 * The documents a WRITTEN list holds, or null. `$documents` takes a list the
 * program spells out — MEASURED, the server refuses a field path there ("an
 * array is expected") — so an array is appendable exactly when its elements
 * are written.
 */
function writtenDocuments(e: Expr): readonly Expr[] | null {
  if (e.type !== "ArrayLiteral" || e.elements.length === 0) return null;
  const out: Expr[] = [];
  for (const el of e.elements) {
    if (el.type === "SpreadElement") return null;
    out.push(el as Expr);
  }
  return out;
}

/** `$$.push(a, b, …)` / `.concat(a, b, …)` — one `$unionWith` per source, in order. */
export function unionStages(args: readonly Arg[], env: Env, node: Expr, S: JoinServices): Stage[] {
  if (args.length === 0) throw E.unionNeedsArgument(node.pos);
  const out: Stage[] = [];
  let docs: Expr[] = [];
  const flushDocs = (): void => {
    if (docs.length === 0) return;
    // A container whose row bans this stage at ANY depth bans it here too. The
    // `$unionWith` wrapper is what makes `$documents` legal inside a `$lookup`
    // and inside another `$unionWith`, but it does not save it inside a
    // `$facet`.
    for (const boundary of env.site.boundaries) {
      if (!bansNestedOf(boundary.stage).includes(DOCUMENTS)) continue;
      throw E.bannedNested(
        `.${node.type === "MethodCall" ? node.name : "push"}(<document>)`,
        DOCUMENTS,
        boundary.stage,
        "Append another collection instead ('$$.push(...$$$.<coll>)'), or append the documents outside the branch.",
        node.pos,
      );
    }
    // The documents are evaluated with NO input document — a `$unionWith` body runs over nothing.
    const body = env.enter({ stage: "$unionWith", path: ["pipeline"], capture: null }, new Chain());
    const list = docs.map((d) => lowerValue(d, childEnv(body, node, "args")));
    const verb = node.type === "MethodCall" ? node.name : "push";
    noStageInDocuments(body.chain, `.${verb}(${verb === "concat" ? "[{ … }]" : "{ … }"})`, node.pos);
    out.push({ $unionWith: { pipeline: [{ $documents: list }] } });
    docs = [];
  };
  for (const a of args) {
    if (a.type === "SpreadElement") {
      // `$$.push(...[{ … }, { … }])` — JavaScript spreads the list into the arguments,
      // and each element is a document, so they join the same `$documents` batch.
      const spread = writtenDocuments(a.argument);
      if (spread !== null) {
        docs.push(...spread);
        continue;
      }
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
    // `.concat(list)` takes the ARRAY, as JavaScript's own `.concat` does, and appends
    // its elements. `.push(list)` would append the array as one element, which is not a
    // document, so it keeps the refusal that names the spread.
    const asList = writtenDocuments(a);
    if (asList !== null && (node as { name?: string }).name === "concat") {
      docs.push(...asList);
      continue;
    }
    const t = typeOf(a, env);
    if (cannotBe(t, "object")) throw E.unionArg(E.nounOfKinds(t), a.pos);
    docs.push(a);
  }
  flushDocs();
  return out;
}
