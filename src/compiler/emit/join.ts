// Phase 5 — EMIT. The join road: a chain on another collection, `$$$.<coll>.<links>`,
// as the `$lookup` it means, in every position it may stand.
//
// One road, two shapes. A body that OPENS with a correlated equality — a `$match`
// whose predicate states `<foreign field> === <outer field>`, alone or as one
// `&&` conjunct among others — becomes the `localField`/`foreignField` pair.
// Whatever follows it, the other conjuncts and the later links go into
// `pipeline` beside the pair, and the server runs this over the matched
// documents only (MongoDB 5.0+). The pair is the join form MongoDB's own
// documentation uses. The planner answers it from the foreign index (a
// multikey index when either side is an array), and the server's own rules
// apply to it: a missing field counts as null, and an array matches
// element-wise — two arrays join when they share one element. Everything else
// uses `let` + `pipeline` + `$expr`, which compares the two fields' OWN values
// as JavaScript does (`undefined === null` is false), and also uses the
// foreign index (measured: `indexesUsed`, keys examined = rows matched). The
// compiler takes the pair from the body's FIRST stage and never from its only
// stage, so a trailing `.take(n)` changes what the join returns and never what
// it matches.
//
// The chain peels: a link goes INTO `$lookup.pipeline` while its row has a
// `stream` cell that accepts it (`filter`, the sorts, `take`, `aggregate`, a
// stage link, a `.map` to a provable document). The first link that is not such
// a link ends the sub-pipeline. It and everything after it read the materialised
// array as a VALUE (`.length` → `$size`, `.map(o => o.total)` → `$map`, `[0]`).
// `.find(p)` is the one special head: `[$match, { $limit: 1 }]`, with the slot
// unwrapped with `$first` to ONE document.
//
// Correlation is the Env's business: a read of a shallower level inside the body
// lands in the boundary's Capture (env.ts `render`), and the compiler writes the
// `let` from it once the body is lowered. See docs/specs/emit-pass.md § The join road.

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
  /** Does the link's row have a stream rule? A refused or absent cell ends the body: the link reads the value. */
  peels: (link: Link, env: Env) => boolean;
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

/** The `localField` / `foreignField` pair a body opens with. */
export type Pair = { readonly localField: string; readonly foreignField: string };

/** The `$lookup` a chain's peeled prefix means, and what is left over. */
export type Lookup = {
  readonly from: string;
  /** The one correlated equality the body opened with, as the pair; null when it opened with anything else. */
  readonly pair: Pair | null;
  /** What the pipeline still reads of the outer document — the pair's own read is not repeated here. */
  readonly let: Record<string, string> | null;
  /** The body's stages after the pair's `$match` — the whole body when there is no pair. */
  readonly pipeline: Stage[];
  /** Did the body read the outer document at all — through the pair or through `let`? */
  readonly correlated: boolean;
  /**
   * The array holds ONE document that is the value: `.find` (unwrapped with
   * `$first`, absent when nothing matched), or a collapse (`countBy`, which
   * gives `{}` when nothing matched, as lodash answers for an empty array).
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
  /**
   * Where the body's ELEMENT lives on the documents the array holds: `""` when
   * each document is the element, or the unwound field after a
   * `.flatMap("items")` that no later stage replaced. The value of such a
   * chain is the elements, not their carriers — `$$$.orders.flatMap("items")`
   * gives the items.
   */
  readonly element: string;
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
  // `.length`, `.total`, `[0]` after the links read the joined value. The chain
  // proper is the outermost method call under them.
  let head: Expr = node;
  while ((head.type === "MemberAccess" || head.type === "IndexAccess") && head.object.type !== "DatabaseRef") {
    head = head.object;
  }
  const { from, links, pos } = foreignChain(head);
  // A `$unionWith` body has no `let`. Its capture is null, and the compiler refuses a read of the outer document inside it.
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
    if (!S.peels(link, body)) break;
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
  const vars = capture !== null && capture.any ? capture.vars : null;
  const element = body.chain.element;
  const shape = takePair(vars, body.chain.close());
  return { complete, from, ...shape, correlated: vars !== null, one, yields, rest, peeledTo, element, pos };
}

/** `<base>.a.b` for the dotted `path` — the element read off one document of the slot. */
function pathOn(base: Expr, path: string, pos: number): Expr {
  return path
    .split(".")
    .reduce<Expr>((object, name) => ({ type: "MemberAccess", object, name, optional: false, pos }), base);
}

/**
 * The slot's value as the chain means it. The array holds the body's
 * documents. When the element is an unwound field of theirs, the value is
 * those fields — one per document (`.map(x => x.items)`), or the one
 * document's (`.items`).
 */
function elementsOf(slot: Expr, l: Lookup, env: Env, node: Expr): Expr {
  if (l.element === "") return slot;
  if (l.one === "find") return pathOn(slot, l.element, l.pos);
  // One document per element, so a COUNT of the elements is the count of the
  // documents. `.length` and `.size()` read the slot itself — `$size: "$slot"`
  // — instead of picking each element out first.
  if (countsElements(node, l.peeledTo)) return slot;
  // A compiler mint, so the two spellings of one chain (`"items"` / `d => d.items`) name it alike.
  const x = env.fresh("el").as;
  const body = pathOn({ type: "Ident", name: x, pos: l.pos }, l.element, l.pos);
  const map: Expr = { type: "Lambda", params: [x], body, pos: l.pos };
  return { type: "MethodCall", object: slot, name: "map", args: [map], optional: false, pos: l.pos };
}

/** Is the whole value the COUNT of the peeled chain — `<chain>.length` or `<chain>.size()`, nothing else? */
function countsElements(node: Expr, peeledTo: Expr): boolean {
  if (node.type === "MemberAccess") return node.name === "length" && node.object === peeledTo;
  if (node.type === "MethodCall") return node.name === "size" && node.args.length === 0 && node.object === peeledTo;
  return false;
}

/** A plain field path — `"$x"`, `"$a.b"` — and not a `$$` variable; its name without the `$`. */
function fieldPath(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("$") && !v.startsWith("$$") ? v.slice(1) : null;
}

/** Does any string in `v` read the variable `$$name` — as itself or as the head of a path? */
function reads(v: unknown, name: string): boolean {
  if (typeof v === "string") return v === `$$${name}` || v.startsWith(`$$${name}.`);
  if (Array.isArray(v)) return v.some((x) => reads(x, name));
  if (v !== null && typeof v === "object") return Object.values(v).some((x) => reads(x, name));
  return false;
}

/**
 * The correlated equality the body's first stage carries, taken out as the
 * `localField`/`foreignField` pair. Whatever else that stage stated stays as a
 * `$match`.
 *
 * `{ let: { v: "$_id" }, pipeline: [{ $match: { $expr: { $eq: ["$uid", "$$v"] } } }, …rest] }`
 * and `{ localField: "_id", foreignField: "uid", pipeline: […rest] }` run `rest`
 * over the same documents (MongoDB 5.0+ runs the pipeline over the pair's
 * matches). The equality may be one `&&` conjunct among others —
 * `o.uid === $._id && o.t > d` becomes `{ $match: { $expr: { $and: [eq, gt] } } }`
 * — and the pair reads it the same way. The conjuncts beside it, and the
 * stage's query-document keys, stay as the pipeline's first `$match`, over the
 * pair's matches. The pair's variable leaves `let` unless a later stage still
 * reads it. A `let` beside the pair is the concise correlated form, and the
 * server accepts it (measured on 8.3.7). A first stage with no such equality —
 * a comparison that is not one, a side that is not a plain field path, an
 * equality under `||` — keeps the body whole, because only `$expr` can state it.
 */
function takePair(
  vars: Record<string, string> | null,
  pipeline: Stage[],
): { pair: Pair | null; let: Record<string, string> | null; pipeline: Stage[] } {
  const whole = { pair: null, let: vars, pipeline };
  if (vars === null || pipeline.length === 0) return whole;
  const { $expr, ...query } = (pipeline[0] as { $match?: Record<string, unknown> }).$match ?? {};
  if ($expr === undefined) return whole;
  const and = ($expr as { $and?: unknown }).$and;
  const conjuncts: unknown[] = Array.isArray(and) ? and : [$expr];
  // The FIRST conjunct that is a correlated equality is the pair: the one the developer wrote first.
  for (const [i, conjunct] of conjuncts.entries()) {
    const eq = (conjunct as { $eq?: unknown }).$eq;
    if (!Array.isArray(eq) || eq.length !== 2) continue;
    for (const [name, read] of Object.entries(vars)) {
      const localField = fieldPath(read);
      if (localField === null) continue;
      const variable = `$$${name}`;
      const foreignField = fieldPath(eq[0] === variable ? eq[1] : eq[1] === variable ? eq[0] : null);
      if (foreignField === null) continue;
      const others = conjuncts.filter((_, j) => j !== i);
      const match: Record<string, unknown> = { ...query };
      if (others.length === 1) match.$expr = others[0];
      else if (others.length > 1) match.$expr = { $and: others };
      const rest = [...(Object.keys(match).length > 0 ? [{ $match: match } as Stage] : []), ...pipeline.slice(1)];
      const kept = Object.fromEntries(Object.entries(vars).filter(([n]) => n !== name || reads(rest, n)));
      return { pair: { localField, foreignField }, let: Object.keys(kept).length > 0 ? kept : null, pipeline: rest };
    }
  }
  return whole;
}

/** The stage, keys in reading order: from, localField/foreignField, let, pipeline, as. */
export function lookupStage(l: Lookup, as: string): Stage {
  const body: Record<string, unknown> = { from: l.from };
  if (l.pair !== null) {
    body.localField = l.pair.localField;
    body.foreignField = l.pair.foreignField;
  }
  if (l.let !== null) body.let = l.let;
  // The pair alone needs no pipeline. A `.find` keeps its `{ $limit: 1 }`
  // there. The server takes ONE matched document per outer document and stops
  // (measured: one key, one document examined per outer document), where the
  // pair alone would materialise every match first. MEASURED: 110 matching
  // documents of 1 MB each give Location4568, "Total size of documents in
  // <coll> matching pipeline's $lookup exceeds 104857600 bytes".
  if (l.pair === null || l.pipeline.length > 0) body.pipeline = l.pipeline;
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
 * A chain in a VALUE position: the compiler hoists the `$lookup` ahead of the
 * stage that reads it, into a scratch slot. The value is what the rest of the
 * chain makes of that slot. The slot is bound as a typed name, so `.length` on
 * an array slot is `$size` and `.total` on a document slot is a path.
 */
export function joinValue(node: Expr, env: Env, S: JoinServices): unknown {
  const l = lookupOf(node, env, S);
  if (!env.chain.isPipeline) throw E.joinNeedsPipeline(l.pos);
  const slot: FieldSlot = env.chain.slot();
  const stages: Stage[] = [lookupStage(l, slot.path)];
  if (l.one !== false) stages.push(unwrap(slot.path, l.one));
  env.chain.hoist(stages, slot.path);
  const name = `#join${slot.path}`;
  // A `$lookup.as` array holds the foreign collection's documents, so a terminal
  // that answers one ELEMENT of it — `.head()`, `.maxBy(k)` — is a document. An
  // unwound field's elements are whatever the field held.
  const bound = env.bind(name, {
    ref: { kind: "field", slot },
    type: l.yields,
    elements: l.yields === "array" && l.element === "" ? "object" : "unknown",
    // The server always writes the `as` array. A `.find` may find nothing.
    present: l.one !== "find",
    mutable: false,
    pos: l.pos,
  });
  const rebased = rebase(node, l.peeledTo, elementsOf({ type: "Ident", name, pos: l.pos }, l, env, node));
  // the rest of the chain is a VALUE over the slot, wherever the chain stood
  return lowerValue(rebased, bound.at({ at: "value" }));
}

/**
 * `$.o = $$$.c.<chain>;` with nothing after the peel: the target IS `as`, so it
 * needs no scratch and no cleanup. Null when the chain goes on after the
 * `$lookup` — the value road then materialises it.
 */
export function joinWrite(
  node: Expr,
  path: string,
  env: Env,
  S: JoinServices,
): { stages: Stage[]; yields: "array" | "object" } | null {
  // The body's lowering may hoist onto the outer chains (`$$.length` stamps
  // the root stream). When the chain goes on, the value road lowers the body
  // again, so the compiler takes back what this attempt hoisted — otherwise
  // the stamp lands twice.
  const marks = [env.chain, env.rootChain].map((c) => [c, c.mark()] as const);
  const l = lookupOf(node, env, S);
  // An unwound element is read off the documents `as` holds, which is the value road's work too.
  if (!l.complete || l.element !== "") {
    for (const [c, m] of marks) c.rewind(m);
    return null;
  }
  const stages: Stage[] = [lookupStage(l, path)];
  if (l.one !== false) stages.push(unwrap(path, l.one));
  return { stages, yields: l.yields };
}

/**
 * `$ = $$$.c.find(p);` — each document becomes the one it found. A document
 * that found nothing has nothing to become, and leaves the stream. `$unwind`
 * of an empty slot drops it. (`$replaceWith: { $first: … }` fails on the
 * server for every such document — measured.)
 */
export function joinRoot(node: Expr, env: Env, S: JoinServices): Stage[] {
  const l = lookupOf(node, env, S);
  if (!l.complete || l.one !== "find") throw E.rootNeedsOneDocument(l.pos);
  const slot = env.chain.slot();
  const found = l.element === "" ? "$" + slot.path : `$${slot.path}.${l.element}`;
  return [lookupStage(l, slot.path), { $unwind: "$" + slot.path }, { $replaceWith: found }];
}

/**
 * `$$ = $$$.c.<chain>;` — the stream becomes the other collection's documents.
 * Correlated (the body read the outer document): a `$lookup` per outer document,
 * unwound into the stream. Uncorrelated: the compiler drops the current stream
 * and unions in the other collection's pipeline.
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
  if (l.correlated) {
    const slot = env.chain.slot();
    const stages: Stage[] = [lookupStage(l, slot.path)];
    if (l.one !== false) stages.push(unwrap(slot.path, l.one));
    return [...stages, { $unwind: "$" + slot.path }, { $replaceWith: "$" + slot.path }];
  }
  const source: Stage =
    l.pipeline.length === 0 ? { $unionWith: l.from } : { $unionWith: { coll: l.from, pipeline: l.pipeline } };
  return [{ $match: { $expr: false } }, source];
}
