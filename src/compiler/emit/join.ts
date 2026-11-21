import type { Expr, Stage, Type } from "../../registry/vocabulary.ts";
import { chainBase } from "../passes/naming.ts";
import { collapsesOf, picksOneOf, streamBodyOf } from "../rows.ts";
import { Chain, type Env } from "./env.ts";
import * as E from "./errors.ts";
import { lowerValue } from "./lower.ts";
import { Capture, type FieldSlot } from "./names.ts";
import { documentsOf, kindOf, typeOf } from "./prove.ts";
import { DOCUMENT, arrayOf, maybeAbsent, present } from "./type.ts";
import { childEnv } from "./inputs.ts";

type Link = Extract<Expr, { type: "MethodCall" }>;

export type JoinServices = {
  link: (link: Link, env: Env, first: boolean, row?: string) => Stage[] | null;
  peels: (link: Link, env: Env) => boolean;
};

export function readsAnotherCollection(node: Expr): boolean {
  const t = (chainBase(node) as { type: string }).type;
  return t === "DatabaseRef" || t === "ClusterRef";
}

function foreignChain(node: Expr): { from: string; links: Link[]; pos: number } {
  const links: Link[] = [];
  let cur: Expr = node;
  while (cur.type === "MethodCall") {
    if (cur.optional) throw E.optionalOnStream(cur.pos);
    links.unshift(cur);
    cur = cur.object;
  }
  if ((chainBase(cur) as { type: string }).type === "ClusterRef") throw E.crossDatabaseRead(node.pos);
  if (cur.type === "MemberAccess" && cur.object.type === "DatabaseRef") return { from: cur.name, links, pos: node.pos };
  if (cur.type === "IndexAccess" && cur.object.type === "DatabaseRef") {
    if (cur.index.type !== "StringLiteral") throw E.collectionNameFrom(cur.index);
    if (cur.index.value === "") throw E.emptyCollectionName(cur.index.pos);
    return { from: cur.index.value, links, pos: node.pos };
  }
  if (cur.type === "DatabaseRef") throw E.collectionMissing(cur.pos);
  throw E.notAJoinChain(node.pos);
}

export type Pair = { readonly localField: string; readonly foreignField: string };

export type Lookup = {
  readonly from: string;
  readonly pair: Pair | null;
  readonly let: Record<string, unknown> | null;
  readonly pipeline: Stage[];
  readonly correlated: boolean;
  readonly one: false | "find" | "collapse";
  readonly yields: "array" | "object";
  readonly rest: readonly Link[];
  readonly complete: boolean;
  readonly peeledTo: Expr;
  readonly element: string;
  readonly document: Type;
  readonly pos: number;
};

export function joinedType(l: Lookup): Type {
  if (l.one === "find") return maybeAbsent(l.document);
  if (l.one === "collapse") return present(l.document);
  return present(arrayOf(l.document));
}

function documentBody(link: Link, env: Env): boolean {
  const cb = link.args[0];
  if (cb === undefined || cb.type !== "Lambda" || cb.body === undefined) return false;
  return kindOf(cb.body, env) === "object";
}

export function lookupOf(node: Expr, env: Env, S: JoinServices, over: "$lookup" | "$unionWith" = "$lookup"): Lookup {
  let head: Expr = node;
  for (;;) {
    while ((head.type === "MemberAccess" || head.type === "IndexAccess") && head.object.type !== "DatabaseRef") {
      head = head.object;
    }
    let run: Expr = head;
    while (run.type === "MethodCall") run = run.object;
    const read = (run.type === "MemberAccess" || run.type === "IndexAccess") && run.object.type !== "DatabaseRef";
    if (run === head || !read || (chainBase(run) as { type: string }).type !== "DatabaseRef") break;
    head = run;
  }
  const { from, links, pos } = foreignChain(head);
  const capture = over === "$lookup" ? new Capture(env.level) : null;
  let body = env.enter({ stage: over, path: ["pipeline"], capture }, new Chain());
  let one: Lookup["one"] = false;
  let yields: "array" | "object" = "array";
  let peeledTo: Expr = links.length > 0 ? links[0].object : node;
  let i = 0;
  for (; i < links.length; i++) {
    const link = links[i];
    const first = body.chain.emitted.length === 0 && body.chain.hoisted.length === 0;
    const asRow = picksOneOf(link.name);
    if (asRow !== null) {
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
    const start = body.chain.emitted.length;
    body.chain.flush();
    body.chain.emitted.push(...stages);
    body = body.document(documentsOf(body.chain.emitted.slice(start), body.documents[body.level]));
    peeledTo = link;
    const collapsed = collapsesOf(link.name);
    one = collapsed ? "collapse" : false;
    yields = collapsed ? "object" : "array";
  }
  const rest = links.slice(i);
  const complete = rest.length === 0 && head === node;
  const vars = capture !== null && capture.any ? capture.vars : null;
  const element = body.chain.element;
  const stages = body.chain.close();
  const document = documentsOf(stages, DOCUMENT);
  const shape = takePair(vars, stages);
  return { complete, from, ...shape, correlated: vars !== null, one, yields, rest, peeledTo, element, document, pos };
}

function pathOn(base: Expr, path: string, pos: number): Expr {
  return path
    .split(".")
    .reduce<Expr>((object, name) => ({ type: "MemberAccess", object, name, optional: false, pos }), base);
}

function elementsOf(slot: Expr, l: Lookup, env: Env, node: Expr): Expr {
  if (l.element === "") return slot;
  if (l.one === "find") return pathOn(slot, l.element, l.pos);
  if (countsElements(node, l.peeledTo)) return slot;
  const x = env.fresh("el").as;
  const body = pathOn({ type: "Ident", name: x, pos: l.pos }, l.element, l.pos);
  const map: Expr = { type: "Lambda", params: [x], body, pos: l.pos };
  return { type: "MethodCall", object: slot, name: "map", args: [map], optional: false, pos: l.pos };
}

function countsElements(node: Expr, peeledTo: Expr): boolean {
  if (node.type === "MemberAccess") return node.name === "length" && node.object === peeledTo;
  if (node.type === "MethodCall") return node.name === "size" && node.args.length === 0 && node.object === peeledTo;
  return false;
}

function fieldPath(v: unknown): string | null {
  return typeof v === "string" && v.startsWith("$") && !v.startsWith("$$") ? v.slice(1) : null;
}

function reads(v: unknown, name: string): boolean {
  if (typeof v === "string") return v === `$$${name}` || v.startsWith(`$$${name}.`);
  if (Array.isArray(v)) return v.some((x) => reads(x, name));
  if (v !== null && typeof v === "object") return Object.values(v).some((x) => reads(x, name));
  return false;
}

function takePair(
  vars: Record<string, unknown> | null,
  pipeline: Stage[],
): { pair: Pair | null; let: Record<string, unknown> | null; pipeline: Stage[] } {
  const whole = { pair: null, let: vars, pipeline };
  if (vars === null || pipeline.length === 0) return whole;
  const { $expr, ...query } = (pipeline[0] as { $match?: Record<string, unknown> }).$match ?? {};
  if ($expr === undefined) return whole;
  const and = ($expr as { $and?: unknown }).$and;
  const conjuncts: unknown[] = Array.isArray(and) ? and : [$expr];
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

export function lookupStage(l: Lookup, as: string): Stage {
  const body: Record<string, unknown> = { from: l.from };
  if (l.pair !== null) {
    body.localField = l.pair.localField;
    body.foreignField = l.pair.foreignField;
  }
  if (l.let !== null) body.let = l.let;
  if (l.pair === null || l.pipeline.length > 0) body.pipeline = l.pipeline;
  body.as = as;
  return { $lookup: body };
}

const unwrap = (path: string, one: "find" | "collapse"): Stage => ({
  $set: { [path]: one === "find" ? { $first: "$" + path } : { $ifNull: [{ $first: "$" + path }, {}] } },
});

function rebase(node: Expr, peeledTo: Expr, replacement: Expr): Expr {
  if (node === peeledTo) return replacement;
  if (node.type === "MethodCall" || node.type === "MemberAccess" || node.type === "IndexAccess") {
    return { ...node, object: rebase(node.object, peeledTo, replacement) } as Expr;
  }
  return node;
}

export function joinValue(node: Expr, env: Env, S: JoinServices): unknown {
  const l = lookupOf(node, env, S);
  if (!env.chain.isPipeline) throw E.joinNeedsPipeline(l.pos);
  const slot: FieldSlot = env.chain.slot();
  const stages: Stage[] = [lookupStage(l, slot.path)];
  if (l.one !== false) stages.push(unwrap(slot.path, l.one));
  env.chain.hoist(stages, slot.path);
  const name = `#join${slot.path}`;
  const bound = env.bind(name, { ref: { kind: "field", slot }, type: joinedType(l), mutable: false, pos: l.pos });
  const rebased = rebase(node, l.peeledTo, elementsOf({ type: "Ident", name, pos: l.pos }, l, env, node));
  const valueEnv = bound.at({ at: "value" });
  const value = lowerValue(rebased, valueEnv);
  env.chain.proved(node, typeOf(rebased, valueEnv));
  return value;
}

export function joinWrite(node: Expr, path: string, env: Env, S: JoinServices): { stages: Stage[]; type: Type } | null {
  const marks = [env.chain, env.rootChain].map((c) => [c, c.mark()] as const);
  const l = lookupOf(node, env, S);
  if (!l.complete || l.element !== "") {
    for (const [c, m] of marks) c.rewind(m);
    return null;
  }
  const stages: Stage[] = [lookupStage(l, path)];
  if (l.one !== false) stages.push(unwrap(path, l.one));
  return { stages, type: joinedType(l) };
}

export function joinRoot(node: Expr, root: string, env: Env, S: JoinServices): Stage[] {
  const l = lookupOf(node, env, S);
  if (!l.complete || l.one !== "find") throw E.rootNeedsOneDocument(root, l.pos);
  const slot = env.chain.slot();
  const found = l.element === "" ? "$" + slot.path : `$${slot.path}.${l.element}`;
  return [lookupStage(l, slot.path), { $unwind: "$" + slot.path }, { $replaceWith: found }];
}

export function joinStream(node: Expr, env: Env, first: boolean, S: JoinServices): Stage[] {
  void first;
  const l = lookupOf(node, env, S);
  if (!l.complete) {
    const after = l.rest[0] ?? (node as { name?: string; pos: number });
    throw E.valueInStream(after.name ?? "length", after.pos);
  }
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
