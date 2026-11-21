import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import {
  argCountOf,
  everyOperatorName,
  everyStageName,
  operandShapeOf,
  positionalKeysOf,
  positionsOf,
} from "../src/compiler/rows.ts";

const SENTINEL = "$f";

function arrayArgCount(name: string): number {
  const a = argCountOf(name);
  if (a === undefined) return 2;
  if (a.none === true) return 0;
  if (a.atLeast !== undefined) return Math.max(a.atLeast, 2);
  return a.exact ?? a.allowed?.[0] ?? 2;
}

function callSource(name: string): string {
  const q = JSON.stringify(SENTINEL);
  switch (operandShapeOf(name)) {
    case "none":
      return `${name}()`;
    case "array":
      return `${name}(${Array(arrayArgCount(name)).fill(q).join(", ")})`;
    case "object":
      return `${name}(${positionalKeysOf(name)
        .map(() => q)
        .join(", ")})`;
    case "flex":
      return `${name}(${Array(argCountOf(name) ? arrayArgCount(name) : 1)
        .fill(q)
        .join(", ")})`;
    default:
      return `${name}(${q})`;
  }
}

function stageSourceFor(name: string, call: string): string {
  const positions = positionsOf(name) ?? [];
  if (!positions.includes("value")) {
    if (positions.includes("group")) return `$group({ _id: 1, v: ${call} });`;
    if (positions.includes("window")) return `$setWindowFields({ sortBy: { s: 1 }, output: { v: ${call} } });`;
  }
  return `$addFields({ v: ${call} });`;
}

function exprCanTakeStringArg(name: string): boolean {
  return (positionsOf(name) ?? []).includes("value") && operandShapeOf(name) !== "none";
}

describe("literal pass-through — every $unwind spelling and its siblings", () => {
  it("the three short $unwind forms produce one document, and the object call form keeps its object", () => {
    expect(jsmql(`$unwind("$items");`)).toEqual([{ $unwind: "$items" }]);
    expect(jsmql(`$unwind($.items);`)).toEqual([{ $unwind: "$items" }]);
    expect(jsmql(`[{ $unwind: "$items" }]`)).toEqual([{ $unwind: "$items" }]);
    expect(jsmql(`$unwind({ path: "$items" });`)).toEqual([{ $unwind: { path: "$items" } }]);
  });

  it("$sortByCount / $replaceWith / $project / $group pass a $-string through", () => {
    expect(jsmql(`$sortByCount("$tags");`)).toEqual([{ $sortByCount: "$tags" }]);
    expect(jsmql(`$replaceWith("$sub");`)).toEqual([{ $replaceWith: "$sub" }]);
    expect(jsmql(`$project({ x: "$y" });`)).toEqual([{ $project: { x: "$y" } }]);
    expect(jsmql(`$group({ _id: "$cat" });`)).toEqual([{ $group: { _id: "$cat" } }]);
    expect(jsmql(`$documents([{ a: "$x" }]);`)).toEqual([{ $documents: [{ a: "$x" }] }]);
  });

  it("a nested operator inside a stage also passes its $-strings through (Model B)", () => {
    expect(jsmql(`$project({ t: $concat("$a", "$b") });`)).toEqual([{ $project: { t: { $concat: ["$a", "$b"] } } }]);
  });

  it("the $literal(...) escape hatch still forces a literal inside a pipeline", () => {
    expect(jsmql(`$project({ x: $literal("$y") });`)).toEqual([{ $project: { x: { $literal: "$y" } } }]);
  });

  it("a non-$ literal string passes through as a $replaceWith new-root, and `$ =` refuses it", () => {
    expect(jsmql(`$replaceWith("hello");`)).toEqual([{ $replaceWith: "hello" }]);
    expect(() => jsmql(`$ = "hello";`)).toThrow(
      "'$ = …' takes a document, but got a string. Put the value under a field ('$ = { value: … };'), or write to a field instead ('$.value = …;').",
    );
  });
});

describe("literal pass-through — every operator in the registry", () => {
  for (const name of everyOperatorName()) {
    if (name === "$literal") continue;
    const positions = positionsOf(name) ?? [];
    if (!positions.some((p) => p === "value" || p === "group" || p === "window")) continue;
    if (name === "$count" || name === "$expMovingAvg") continue;
    if (operandShapeOf(name) === "none") continue;

    const call = callSource(name);
    const stageSrc = stageSourceFor(name, call);
    const sentinel = JSON.stringify(SENTINEL);

    it(`${name}: $-string passes through in pipeline context`, () => {
      const out = JSON.stringify(jsmql.pipeline(stageSrc));
      expect(out).toContain(sentinel);
      expect(out).not.toContain("$literal");
    });

    if (exprCanTakeStringArg(name)) {
      it(`${name}: same source $-string ALSO passes through in jsmql.expr (HR1)`, () => {
        const out = JSON.stringify(jsmql.expr(call));
        expect(out).toContain(sentinel);
        expect(out).not.toContain("$literal");
      });
    }
  }

  it("$literal itself still emits its envelope in both contexts", () => {
    expect(jsmql.expr(`$literal("$y")`)).toEqual({ $literal: "$y" });
    expect(jsmql(`$project({ x: $literal("$y") });`)).toEqual([{ $project: { x: { $literal: "$y" } } }]);
  });
});

const STAGE_CASES: Record<string, string> = {
  $addFields: `$addFields({ v: "$x" });`,
  $bucket: `$bucket({ groupBy: "$price", boundaries: [0, 100, 200], default: "other" });`,
  $bucketAuto: `$bucketAuto({ groupBy: "$price", buckets: 4 });`,
  $documents: `$documents([{ a: "$x" }]);`,
  $facet: `$facet({ a: [$set({ v: "$x" })] });`,
  $fill: `$fill({ output: { v: { value: "$x" } } });`,
  $geoNear: `$geoNear({ near: { type: "Point", coordinates: [0, 0] }, distanceField: "d", key: "loc", query: { t: "$x" } });`,
  $graphLookup: `$graphLookup({ from: "c", startWith: "$ref", connectFromField: "ref", connectToField: "_id", as: "out" });`,
  $group: `$group({ _id: "$cat", n: $sum("$qty") });`,
  $lookup: `$lookup({ from: "c", let: { v: "$a" }, pipeline: [$match({ $expr: $eq("$b", "$$v") })], as: "out" });`,
  $match: `$match($.x === "$y");`,
  $merge: `$merge({ into: "archived", whenMatched: [$set({ v: "$x" })] });`,
  $project: `$project({ x: "$y" });`,
  $redact: `$redact("$$PRUNE");`,
  $replaceRoot: `$replaceRoot({ newRoot: "$sub" });`,
  $replaceWith: `$replaceWith("$sub");`,
  $set: `$set({ v: "$x" });`,
  $setWindowFields: `$setWindowFields({ partitionBy: "$g", sortBy: { t: 1 }, output: { n: $sum("$q") } });`,
  $sortByCount: `$sortByCount("$tags");`,
  $unionWith: `$unionWith({ coll: "c", pipeline: [$match({ x: "$y" })] });`,
  $unwind: `$unwind("$items");`,
};

const dollarStrings = (src: string): string[] => [...src.matchAll(/"(\$[^"]*)"/g)].map((m) => m[1]);

const STAGE_SKIP: Record<string, string> = {
  $count: "the body is a field name, which cannot start with '$'",
  $densify: "every slot is a field name or a constant",
  $limit: "the body is a constant number",
  $out: "the body names a collection",
  $sample: "the body is a constant size",
  $skip: "the body is a constant number",
  $sort: "the body holds field names and directions",
  $unset: "the body holds field names",
  $changeStream: "source stage; no $-string body",
  $changeStreamSplitLargeEvent: "terminal stage; no $-string body",
  $collStats: "diagnostic source stage (option object, no $-string)",
  $currentOp: "diagnostic source stage; surfaced through $$$$ sugar",
  $indexStats: "diagnostic source stage; surfaced through $$ sugar",
  $listLocalSessions: "diagnostic source stage; surfaced through $$$$ sugar",
  $listSampledQueries: "diagnostic source stage; surfaced through $$$$ sugar",
  $listSearchIndexes: "diagnostic source stage; surfaced through $$ sugar",
  $listSessions: "diagnostic source stage; surfaced through $$$$ sugar",
  $planCacheStats: "diagnostic source stage; no $-string body",
  $rankFusion: "hybrid-search stage; sub-pipeline body, no bare $-string",
  $scoreFusion: "hybrid-search stage; sub-pipeline body, no bare $-string",
  $search: "Atlas Search source stage; opaque option object",
  $searchMeta: "Atlas Search source stage; opaque option object",
  $shardedDataDistribution: "diagnostic source stage; no body",
  $vectorSearch: "Atlas Vector Search source stage; opaque option object",
};

describe("literal pass-through — every stage in the registry", () => {
  for (const [name, src] of Object.entries(STAGE_CASES)) {
    it(`${name}: stage body keeps its $-strings and emits no spurious $literal`, () => {
      const out = JSON.stringify(jsmql.pipeline(src));
      const kept = dollarStrings(src);
      expect(kept.length).toBeGreaterThan(0);
      for (const s of kept) expect(out).toContain(JSON.stringify(s));
      expect(out).not.toContain("$literal");
    });
  }

  it("every registered stage is either pass-through-tested or explicitly skipped", () => {
    const accounted = new Set([...Object.keys(STAGE_CASES), ...Object.keys(STAGE_SKIP)]);
    const stages = new Set(everyStageName());
    const uncovered = [...stages].filter((s) => !accounted.has(s));
    expect(uncovered).toEqual([]);
    const staleSkips = Object.keys(STAGE_SKIP).filter((s) => !stages.has(s));
    expect(staleSkips).toEqual([]);
  });
});

function collectVarNames(node: unknown, into: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const x of node) collectVarNames(x, into);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "let" || k === "vars") && v !== null && typeof v === "object" && !Array.isArray(v)) {
        into.push(...Object.keys(v as Record<string, unknown>));
      }
      if (k === "as" && typeof v === "string") into.push(v);
      collectVarNames(v, into);
    }
  }
  return into;
}

const VALID_VAR = /^[a-z][A-Za-z0-9_]*$/;
const VALID_REGEX_OPTS = /^[imsx]*$/;

type Input = { label: string; mql: () => unknown };

const VAR_INPUTS: Input[] = [
  {
    label: "$lookup auto-let on $._id (a `.find` with no join pair)",
    mql: () => jsmql(`$.u = $$$.users.find(u => (u.refId === $._id || u.altId === $._id) && u.active);`),
  },
  {
    label: "$lookup auto-let on $._id (a `.filter` with no join pair)",
    mql: () => jsmql(`$.o = $$$.orders.filter(o => o.userId === $._id || o.ownerId === $._id);`),
  },
  {
    label: "$lookup auto-let on `$.meta`, read through a hyphenated key",
    mql: () => jsmql(`$.o = $$$.orders.filter(o => o.total > $.meta["min-total"]);`),
  },
  { label: "|| short-circuit binding", mql: () => jsmql.expr(`($.a + $.b) || $.c`) },
  { label: "&& short-circuit binding", mql: () => jsmql.expr(`($.a + $.b) && $.c`) },
  { label: ".map throwaway _ param", mql: () => jsmql(`$set({ xs: $.xs.map(_ => 0) });`) },
  { label: ".reduce throwaway _ element param", mql: () => jsmql.expr(`$.xs.reduce((acc, _, i) => acc + i, 0)`) },
  { label: ".fill() statement mutator (bounds)", mql: () => jsmql(`$.xs.fill(0, 1, 3);`) },
  { label: ".fill() statement mutator (no bounds)", mql: () => jsmql(`$.xs.fill(0);`) },
];

const OTHER_INPUTS: Input[] = [
  { label: "$$ = [] drop-all", mql: () => jsmql(`$$ = [];`) },
  { label: "$$ = source-switch", mql: () => jsmql(`$$ = $$$.transactions.filter(t => t.client === 156);`) },
  { label: ".match(/re/g)", mql: () => jsmql.expr(`$.s.match(/word/g)`) },
  { label: ".matchAll(/re/g)", mql: () => jsmql.expr(`$.s.matchAll(/word/g)`) },
  { label: "/re/gi.test()", mql: () => jsmql.expr(`/pattern/gi.test($.str)`) },
];

const REGRESSION_INPUTS: Input[] = [...VAR_INPUTS, ...OTHER_INPUTS];

describe("server-rejection regressions — no invalid var names, $limit:0, or regex flags", () => {
  for (const { label, mql } of VAR_INPUTS) {
    it(`${label}: emits only MongoDB-valid user variable names`, () => {
      const names = collectVarNames(mql());
      expect(names.length).toBeGreaterThan(0);
      expect(names.filter((n) => !VALID_VAR.test(n))).toEqual([]);
    });
  }

  it("the $-prefixed local field name flows through as a sanitized let var", () => {
    expect(jsmql(`$.u = $$$.users.find(u => (u.refId === $._id || u.altId === $._id) && u.active);`)).toEqual([
      {
        $lookup: {
          from: "users",
          let: { jsmql_f0__id: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $or: [{ $eq: ["$refId", "$$jsmql_f0__id"] }, { $eq: ["$altId", "$$jsmql_f0__id"] }] },
                    { $gt: ["$active", null] },
                    { $ne: ["$active", false] },
                    { $ne: ["$active", ""] },
                    { $ne: ["$active", 0] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "u",
        },
      },
      { $set: { u: { $first: "$u" } } },
    ]);
  });

  it("$$ = [] and source-switch use a never-matching $match, never $limit:0", () => {
    expect(jsmql(`$$ = [];`)).toEqual([{ $match: { $expr: false } }]);
    expect(jsmql(`$$ = $$$.transactions.filter(t => t.client === 156);`)).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "transactions", pipeline: [{ $match: { client: 156 } }] } },
    ]);
    for (const { mql } of REGRESSION_INPUTS) {
      expect(JSON.stringify(mql())).not.toContain('"$limit":0');
    }
  });

  it("regex options carry only MongoDB-valid flags (JS g/u/y dropped)", () => {
    expect(jsmql.expr(`$.s.match(/word/g)`)).toEqual({
      $regexMatch: { input: { $ifNull: ["$s", ""] }, regex: "word" },
    });
    expect(jsmql.expr(`$.s.matchAll(/word/g)`)).toEqual({
      $regexFindAll: { input: { $ifNull: ["$s", ""] }, regex: "word" },
    });
    expect(jsmql.expr(`/pattern/gi.test($.str)`)).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "i" },
    });
    const collectOpts = (node: unknown, into: string[] = []): string[] => {
      if (Array.isArray(node)) node.forEach((x) => collectOpts(x, into));
      else if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === "options" && typeof v === "string") into.push(v);
          collectOpts(v, into);
        }
      }
      return into;
    };
    for (const { mql } of REGRESSION_INPUTS) {
      for (const o of collectOpts(mql())) expect(o).toMatch(VALID_REGEX_OPTS);
    }
  });
});
