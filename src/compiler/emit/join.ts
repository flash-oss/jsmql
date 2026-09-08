// Phase 5 — EMIT. The join road: a chain on another collection, `$$$.<coll>.<links>`,
// as the `$lookup` it means, in every position it may stand.
//
// One route. The stage is always `let` + `pipeline` + `$expr` — never
// `localField`/`foreignField` — because the pipeline form compares the two
// fields' OWN values as JavaScript does (`1 === [1, 2]` is false, `undefined ===
// undefined` is true, `undefined === null` is false), and the basic form does
// not (missing ≡ null, an array matches element-wise). Measured on mongod 8.3.7:
// the pipeline form uses the foreign index too (`indexesUsed`, keys examined =
// rows matched), so nothing is paid for the meaning.
//
// The chain peels: a link goes INTO `$lookup.pipeline` while its row has a
// `stream` cell that accepts it (`filter`, the sorts, `take`, `aggregate`, a
// stage link, a `.map` to a provable document). The first link that is not such
// a link ends the sub-pipeline; it and everything after it read the materialised
// array as a VALUE (`.length` → `$size`, `.map(o => o.total)` → `$map`, `[0]`).
// `.find(p)` is the one special head: `[$match, { $limit: 1 }]` and the slot
// unwrapped with `$first` to ONE document.
//
// Correlation is the Env's business: a read of a shallower level inside the body
// lands in the boundary's Capture (env.ts `render`), and the `let` is written
// from it once the body is lowered. See docs/specs/emit-pass.md § The join road.

import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { chainBase } from "../passes/naming.ts";
import { collapsesOf, picksOneOf, streamBodyOf } from "../rows.ts";
import { Chain, type Env } from "./env.ts";
import * as E from "./errors.ts";
import { lowerValue } from "./lower.ts";
import { Capture, type FieldSlot } from "./names.ts";
import { kindOf } from "./types.ts";
import { childEnv } from "./inputs.ts";

type Link = Extract<Expr, { type: "MethodCall" }>;

/** What statement.ts lends the road: one chain link as its stages, or null when the row has no stream cell. */
export type JoinServices = {
  /** `row` runs another row's cell under the link's own name — `.find` is `filter` plus a limit. */
  link: (link: Link, env: Env, first: boolean, row?: string) => Stage[] | null;
  /** Has the link's row a stream rule? A refused or absent cell ends the body: the link reads the value. */
  peels: (link: Link) => boolean;
};

/** Does this chain read another collection — is it rooted in `$$$` (or `$$$$`)? */
export function readsAnotherCollection(node: Expr): boolean {
  const t = (chainBase(node) as { type: string }).type;
  return t === "DatabaseRef" || t === "ClusterRef";
}

/** The chain taken apart: the collection it names and its links, base first. */
function foreignChain(node: Expr): { from: string; links: Link[]; pos: number } {
  const links: Link[] = [];
  let cur: Expr = node;
  while (cur.type === "MethodCall") {
    if (cur.optional) throw E.optionalOnStream(cur.pos);
    links.unshift(cur);
    cur = cur.object;
  }
  // `$$$$.<db>.<coll>` — a cross-database read is Atlas Data Federation only.
  if ((chainBase(cur) as { type: string }).type === "ClusterRef") throw E.crossDatabaseRead(node.pos);
  if (cur.type === "MemberAccess" && cur.object.type === "DatabaseRef") return { from: cur.name, links, pos: node.pos };
  if (cur.type === "IndexAccess" && cur.object.type === "DatabaseRef") {
    if (cur.index.type !== "StringLiteral") throw E.collectionNameMustBeConstant(cur.index.pos);
    if (cur.index.value === "") throw E.emptyCollectionName(cur.index.pos);
    return { from: cur.index.value, links, pos: node.pos };
  }
  if (cur.type === "DatabaseRef") throw E.collectionMissing(cur.pos);
  throw E.notAJoinChain(node.pos);
}

/** The `$lookup` a chain's peeled prefix means, and what is left over. */
export type Lookup = {
  readonly from: string;
  readonly let: Record<string, string> | null;
  readonly pipeline: Stage[];
  /**
   * The array holds ONE document that is the value: `.find` (unwrapped with
   * `$first`, absent when nothing matched) or a collapse (`countBy`; `{}` when
   * nothing matched, as lodash answers for an empty array).
   */
  readonly one: false | "find" | "collapse";
  /** What the materialised slot holds once unwrapped. */
  readonly yields: "array" | "object";
  /** The links that did not peel — read value-mode over the slot. */
  readonly rest: readonly Link[];
  /** Is the WHOLE chain the `$lookup` — nothing after the peeled links, no `.length`, no `[0]`? */
  readonly complete: boolean;
  /** The last peeled node, so the rest of the chain can be rebased onto the slot. */
  readonly peeledTo: Expr;
  readonly pos: number;
};

/** Does a `.map` body provably produce a document? Only then does it peel into the sub-pipeline. */
function documentBody(link: Link, env: Env): boolean {
  const cb = link.args[0];
  if (cb === undefined || cb.type !== "Lambda" || cb.body === undefined) return false;
  return kindOf(cb.body, env) === "object";
}

/**
 * Lower the chain's prefix into a `$lookup` body. The body runs one level
 * deeper: its Env crosses a `$lookup` boundary with a fresh Capture, so every
 * read of the outer document inside it is interned into `let`.
 */
export function lookupOf(node: Expr, env: Env, S: JoinServices, over: "$lookup" | "$unionWith" = "$lookup"): Lookup {
  // `.length`, `.total`, `[0]` after the links read the joined value; the chain
  // proper is the outermost method call under them.
  let head: Expr = node;
  while ((head.type === "MemberAccess" || head.type === "IndexAccess") && head.object.type !== "DatabaseRef") {
    head = head.object;
  }
  const { from, links, pos } = foreignChain(head);
  // A `$unionWith` body has no `let`: its capture is null, and a read of the outer document inside it is refused.
  const capture = over === "$lookup" ? new Capture(env.level) : null;
  const body = env.enter({ stage: over, path: ["pipeline"], capture }, new Chain());
  let one: Lookup["one"] = false;
  let yields: "array" | "object" = "array";
  let peeledTo: Expr = links.length > 0 ? links[0].object : node;
  let i = 0;
  for (; i < links.length; i++) {
    const link = links[i];
    const first = body.chain.emitted.length === 0 && body.chain.hoisted.length === 0;
    const asRow = picksOneOf(link.name);
    if (asRow !== null) {
      // `.find(p)` — the first match, as ONE document.
      const stages = S.link(link, body, first, asRow);
      if (stages === null) throw E.notAJoinChain(link.pos);
      body.chain.flush();
      body.chain.emitted.push(...stages, { $limit: 1 });
      one = "find";
      yields = "object";
      peeledTo = link;
      i++;
      break;
    }
    if (!S.peels(link)) break;
    if (streamBodyOf(link.name) === "document" && !documentBody(link, body)) break;
    const stages = S.link(link, body, first);
    if (stages === null) break;
    body.chain.flush();
    body.chain.emitted.push(...stages);
    peeledTo = link;
    // A link that folds the stream into one document leaves one document in the array.
    const c = collapsesOf(link.name);
    const collapsed = c === true || (c === "unlessRawBody" && link.args[0]?.type !== "ObjectLiteral");
    one = collapsed ? "collapse" : false;
    yields = collapsed ? "object" : "array";
  }
  const rest = links.slice(i);
  const complete = rest.length === 0 && head === node;
  return {
    complete,
    let: capture !== null && capture.any ? capture.vars : null,
    from,
    pipeline: body.chain.close(),
    one,
    yields,
    rest,
    peeledTo,
    pos,
  };
}

/**
 * One correlated equality and nothing else IS the `localField`/`foreignField` pair.
 *
 * `{ let: { v: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$uid", "$$v"] } } }] }`
 * and `{ localField: "_id", foreignField: "uid" }` select the same documents, and the
 * second is the join MongoDB's own documentation is written in: it is the form the
 * planner answers straight from the foreign index, and the form a reader recognises.
 * Anything more than the one equality — a second clause, another link, a body that
 * reads more than one outer field — keeps the pipeline, because only the pipeline
 * can express it.
 */
function compactPair(l: Lookup): { localField: string; foreignField: string } | null {
  if (l.let === null || l.pipeline.length !== 1) return null;
  const vars = Object.entries(l.let);
  if (vars.length !== 1) return null;
  const [name, read] = vars[0];
  if (typeof read !== "string" || !read.startsWith("$") || read.startsWith("$$")) return null;
  const match = (l.pipeline[0] as { $match?: Record<string, unknown> }).$match;
  if (match === undefined || Object.keys(match).length !== 1) return null;
  const eq = (match.$expr as { $eq?: unknown } | undefined)?.$eq;
  if (!Array.isArray(eq) || eq.length !== 2) return null;
  const variable = `$$${name}`;
  const foreign = eq[0] === variable ? eq[1] : eq[1] === variable ? eq[0] : null;
  if (typeof foreign !== "string" || !foreign.startsWith("$") || foreign.startsWith("$$")) return null;
  return { localField: read.slice(1), foreignField: foreign.slice(1) };
}

/** The stage, keys in reading order: from, localField/foreignField or let/pipeline, as. */
export function lookupStage(l: Lookup, as: string): Stage {
  const body: Record<string, unknown> = { from: l.from };
  // A `.find` keeps the pipeline for its `{ $limit: 1 }`: the compact form has nowhere
  // to put it, and without it the server materialises EVERY match before the first is
  // taken — MEASURED, 110 matching documents of 1 MB each answer Location4568,
  // "Total size of documents in <coll> matching pipeline's $lookup exceeds 104857600 bytes".
  const pair = l.one === "find" ? null : compactPair(l);
  if (pair !== null) {
    body.localField = pair.localField;
    body.foreignField = pair.foreignField;
    body.as = as;
    return { $lookup: body };
  }
  if (l.let !== null) body.let = l.let;
  body.pipeline = l.pipeline;
  body.as = as;
  return { $lookup: body };
}

/** The one document the array holds, written back over it: absent for a `.find` that found nothing, `{}` for a collapse of nothing. */
const unwrap = (path: string, one: "find" | "collapse"): Stage => ({
  $set: { [path]: one === "find" ? { $first: "$" + path } : { $ifNull: [{ $first: "$" + path }, {}] } },
});

/** The chain with its peeled prefix replaced by `replacement`. */
function rebase(node: Expr, peeledTo: Expr, replacement: Expr): Expr {
  if (node === peeledTo) return replacement;
  if (node.type === "MethodCall" || node.type === "MemberAccess" || node.type === "IndexAccess") {
    return { ...node, object: rebase(node.object, peeledTo, replacement) } as Expr;
  }
  return node;
}

/**
 * A chain in a VALUE position: the `$lookup` is hoisted ahead of the statement
 * into a scratch slot, and the value is what the rest of the chain makes of that
 * slot. The slot is bound as a typed name, so `.length` on an array slot is
 * `$size` and `.total` on a document slot is a path.
 */
export function joinValue(node: Expr, env: Env, S: JoinServices): unknown {
  const l = lookupOf(node, env, S);
  if (!env.chain.isPipeline) throw E.joinNeedsPipeline(l.pos);
  const slot: FieldSlot = env.chain.slot();
  const stages: Stage[] = [lookupStage(l, slot.path)];
  if (l.one !== false) stages.push(unwrap(slot.path, l.one));
  env.chain.hoist(stages, slot.path);
  const name = `#join${slot.path}`;
  // A `$lookup.as` array always holds the foreign collection's documents, so a
  // terminal that answers one ELEMENT of it — `.head()`, `.maxBy(k)` — is a document.
  const bound = env.bind(name, {
    ref: { kind: "field", slot },
    type: l.yields,
    elements: l.yields === "array" ? "object" : "unknown",
    mutable: false,
    pos: l.pos,
  });
  const rebased = rebase(node, l.peeledTo, { type: "Ident", name, pos: l.pos } as Expr);
  // the rest of the chain is a VALUE over the slot, wherever the chain stood
  return lowerValue(rebased, bound.at({ at: "value" }));
}

/**
 * `$.o = $$$.c.<chain>;` with nothing after the peel: the target IS `as`, so no
 * scratch and no cleanup. Null when the chain goes on after the `$lookup` — the
 * value road then materialises it.
 */
export function joinWrite(
  node: Expr,
  path: string,
  env: Env,
  S: JoinServices,
): { stages: Stage[]; yields: "array" | "object" } | null {
  // The body's lowering may hoist onto the outer chains (`$$.length` stamps the
  // root stream). When the chain goes on, the value road lowers the body again,
  // so what this attempt hoisted is taken back — else the stamp lands twice.
  const marks = [env.chain, env.rootChain].map((c) => [c, c.hoisted.length] as const);
  const l = lookupOf(node, env, S);
  if (!l.complete) {
    for (const [c, n] of marks) c.hoisted.length = n;
    return null;
  }
  const stages: Stage[] = [lookupStage(l, path)];
  if (l.one !== false) stages.push(unwrap(path, l.one));
  return { stages, yields: l.yields };
}

/**
 * `$ = $$$.c.find(p);` — each document becomes the one it found. A document
 * that found nothing has nothing to become, and leaves the stream: `$unwind` of
 * an empty slot drops it. (`$replaceWith: { $first: … }` fails on the server
 * for every such document — measured.)
 */
export function joinRoot(node: Expr, env: Env, S: JoinServices): Stage[] {
  const l = lookupOf(node, env, S);
  if (!l.complete || l.one !== "find") throw E.rootNeedsOneDocument(l.pos);
  const slot = env.chain.slot();
  return [lookupStage(l, slot.path), { $unwind: "$" + slot.path }, { $replaceWith: "$" + slot.path }];
}

/**
 * `$$ = $$$.c.<chain>;` — the stream becomes the other collection's documents.
 * Correlated (the body read the outer document): a `$lookup` per outer document,
 * unwound into the stream. Uncorrelated: the current stream is dropped and the
 * other collection's pipeline unioned in.
 */
export function joinStream(node: Expr, env: Env, first: boolean, S: JoinServices): Stage[] {
  void first;
  const l = lookupOf(node, env, S);
  if (!l.complete) {
    const after = l.rest[0] ?? (node as { name?: string; pos: number });
    throw E.valueInStream(after.name ?? "length", after.pos);
  }
  // `.find` gives ONE document, and a stream is many: JavaScript would not assign it to an array either.
  if (l.one === "find") throw E.oneDocumentInStream(l.pos);
  if (l.let !== null) {
    const slot = env.chain.slot();
    const stages: Stage[] = [lookupStage(l, slot.path)];
    if (l.one !== false) stages.push(unwrap(slot.path, l.one));
    return [...stages, { $unwind: "$" + slot.path }, { $replaceWith: "$" + slot.path }];
  }
  const source: Stage =
    l.pipeline.length === 0 ? { $unionWith: l.from } : { $unionWith: { coll: l.from, pipeline: l.pipeline } };
  return [{ $match: { $expr: false } }, source];
}
