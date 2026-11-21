import type { Expr, Stage } from "../../registry/vocabulary.ts";
import { Chain, type Env } from "./env.ts";
import * as E from "./errors.ts";
import { lookupOf, readsAnotherCollection, type JoinServices } from "./join.ts";
import { lowerValue } from "./lower.ts";
import { typeOf } from "./prove.ts";
import { cannotBe } from "./type.ts";
import { childEnv } from "./inputs.ts";
import { bansNestedOf } from "../rows.ts";

const DOCUMENTS = "$documents";

export function noStageInDocuments(chain: Chain, written: string, pos: number): void {
  const made = chain.hoisted[0] ?? chain.emitted[0];
  if (made !== undefined) throw E.documentsNeedNoStage(written, Object.keys(made)[0], pos);
}

type Arg = Extract<Expr, { type: "MethodCall" }>["args"][number];

function writtenDocuments(e: Expr): readonly Expr[] | null {
  if (e.type !== "ArrayLiteral" || e.elements.length === 0) return null;
  const out: Expr[] = [];
  for (const el of e.elements) {
    if (el.type === "SpreadElement") return null;
    out.push(el as Expr);
  }
  return out;
}

export function unionStages(args: readonly Arg[], env: Env, node: Expr, S: JoinServices): Stage[] {
  if (args.length === 0) throw E.unionNeedsArgument(node.pos);
  const out: Stage[] = [];
  let docs: Expr[] = [];
  const verb = node.type === "MethodCall" ? node.name : "push";
  const flushDocs = (): void => {
    if (docs.length === 0) return;
    for (const boundary of env.site.boundaries) {
      if (!bansNestedOf(boundary.stage).includes(DOCUMENTS)) continue;
      throw E.bannedNested(
        `.${verb}(<document>)`,
        DOCUMENTS,
        boundary.stage,
        "Append another collection instead ('$$.push(...$$$.<coll>)'), or append the documents outside the branch.",
        node.pos,
      );
    }
    const body = env.enter({ stage: "$unionWith", path: ["pipeline"], capture: null }, new Chain());
    const list = docs.map((d) => lowerValue(d, childEnv(body, node, "args")));
    noStageInDocuments(body.chain, `.${verb}(${verb === "concat" ? "[{ … }]" : "{ … }"})`, node.pos);
    out.push({ $unionWith: { pipeline: [{ $documents: list }] } });
    docs = [];
  };
  for (const [slot, a] of args.entries()) {
    if (a.type === "SpreadElement") {
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
    if (a.type === "NullLiteral" || a.type === "UndefinedLiteral")
      throw E.unionArg(verb, slot, a.type === "NullLiteral" ? "null" : "undefined", a.pos);
    const asList = writtenDocuments(a);
    if (asList !== null && (node as { name?: string }).name === "concat") {
      docs.push(...asList);
      continue;
    }
    const t = typeOf(a, env);
    if (cannotBe(t, "object")) throw E.unionArg(verb, slot, E.nounOfKinds(t), a.pos);
    docs.push(a);
  }
  flushDocs();
  return out;
}
