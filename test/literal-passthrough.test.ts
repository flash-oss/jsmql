import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";
import { OPERATORS, type OperatorDef } from "../src/operators.ts";
import { STAGES } from "../src/stages.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The rule under test (HR1 — see docs/LANG_RULES.md):
//
//   A `$`-prefixed string literal typed in SOURCE passes through verbatim in
//   EVERY context — pipeline, stage body, and `jsmql.expr` alike, at any depth
//   including inside nested operator calls. It IS the MQL field ref `$x`, so
//   jsmql adds no `$literal` of its own. This makes pasted raw MQL round-trip.
//
//   The only `$literal` auto-wrap is HR1's runtime-injected exception: a `"$x"`
//   arriving via `jsmql.compile` params or a template-tag `${…}` gets wrapped in
//   expression position so untrusted input can't silently become a field ref —
//   covered in codegen.test.ts, not here (this file uses source-typed sentinels).
//   The explicit `$literal("$y")` escape hatch forces a literal anywhere.
//
// This file is the comprehensive guard: it loops EVERY operator and EVERY stage
// so no `$op` can silently regress into emitting (or dropping) a `$literal`.
// ─────────────────────────────────────────────────────────────────────────────

const SENTINEL = "$f"; // a `$`-prefixed string that MUST survive verbatim in a pipeline

/** The operand count a synthetic array-shape call must supply to satisfy any
 *  declared arity rule (exact, the low end of an allowed range, or a min); 2
 *  otherwise. Keeps the pass-through probe arity-valid so it reaches codegen. */
function arrayArgCount(def: OperatorDef): number {
  const a = def.args?.arity;
  if (a === undefined) return 2;
  return a.exact ?? a.allowed?.[0] ?? a.atLeast ?? 2;
}

// A valid sample value for an enum'd slot, so the pass-through probe stays
// arg-valid (the enum check would reject the `$f` sentinel). The non-enum slots
// still carry the sentinel — those are what the pass-through assertion checks.
const ENUM_SAMPLE: Record<string, string> = {
  timeUnit: "day",
  weekday: "monday",
  bsonTypeName: "string",
  regexFlags: "i",
};
function slotLiteral(def: OperatorDef, key: string): string {
  const ref = def.args?.enums?.[key];
  if (ref !== undefined) return JSON.stringify(Array.isArray(ref) ? ref[0] : ENUM_SAMPLE[ref]);
  return JSON.stringify(SENTINEL);
}

/** Build a minimal `$op(...)` call source from the operator's registry shape. */
function callSource(name: string, def: OperatorDef): string {
  const q = JSON.stringify(SENTINEL);
  switch (def.shape.kind) {
    case "none":
      return `${name}()`;
    case "array":
      return `${name}(${Array(arrayArgCount(def)).fill(q).join(", ")})`;
    case "object":
      // Fill every positional slot (each maps to a named key); enum'd slots get a
      // valid sample value, the rest the `$`-string sentinel under test.
      return `${name}(${def.shape.keys.map((k) => slotLiteral(def, k)).join(", ")})`;
    case "single":
      return `${name}(${q})`;
    case "flex":
      // flex defaults to the single-value form (1 arg); but an arity rule
      // dictates the count — the comparison ops ($eq/$gt/…) need exactly 2 in
      // the aggregation position this probe builds.
      return `${name}(${Array(def.args?.arity ? arrayArgCount(def) : 1)
        .fill(q)
        .join(", ")})`;
  }
}

// Place the call in a stage whose context the operator is legal in. NOTE: these
// are deliberately minimal synthetic calls (a single `$f` sentinel per slot,
// arity-padded via `arrayArgCount`) — they exercise `$literal` pass-through, NOT
// operator type validity, so an individual call here is not necessarily
// *runnable* MQL (the sentinel is the wrong BSON type for most slots). We do
// supply a `sortBy` for the window branch so the common ranking
// operators stay runnable; the loop's contract is strictly "no spurious
// `$literal`", asserted on the emitted shape — see test/CLAUDE.md.
function stageSourceFor(name: string, def: OperatorDef, call: string): string {
  if (def.accumulatorOnly) return `$group({ _id: 1, v: ${call} });`;
  if (def.category === "window") return `$setWindowFields({ sortBy: { s: 1 }, output: { v: ${call} } });`;
  return `$addFields({ v: ${call} });`;
}

/** Can an `$op(...)` call legally sit in bare `jsmql.expr` position with a `$`-string arg? */
function exprCanTakeStringArg(def: OperatorDef): boolean {
  // Accumulator-/window-only operators are illegal in bare expression position;
  // `none`-shape operators take no `$`-string arg.
  return !def.accumulatorOnly && def.category !== "window" && def.shape.kind !== "none";
}

describe("literal pass-through — the reported $unwind bug and siblings", () => {
  it("all three $unwind forms (+ raw object form) produce the identical document", () => {
    const expected = [{ $unwind: "$items" }];
    expect(jsmql(`$unwind("$items");`)).toEqual(expected); // string call form
    expect(jsmql(`$unwind($.items);`)).toEqual(expected); // field-ref form
    expect(jsmql(`[{ $unwind: "$items" }]`)).toEqual(expected); // raw object form
    expect(jsmql(`$unwind({ path: "$items" });`)).toEqual([{ $unwind: { path: "$items" } }]); // object call form
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

  it("a non-$ literal string is still rejected as a $replaceWith new-root", () => {
    expect(() => jsmql(`$replaceWith("hello");`)).toThrow(/must resolve to a document/);
  });
});

describe("literal pass-through — every operator in the registry", () => {
  for (const [name, def] of Object.entries(OPERATORS)) {
    if (name === "$literal") continue; // legitimately emits a $literal envelope

    const call = callSource(name, def);
    const stageSrc = stageSourceFor(name, def, call);

    it(`${name}: $-string passes through in pipeline context`, () => {
      const out = JSON.stringify(jsmql.pipeline(stageSrc));
      expect(out).not.toContain("$literal");
    });

    if (exprCanTakeStringArg(def)) {
      it(`${name}: same source $-string ALSO passes through in jsmql.expr (HR1)`, () => {
        const out = JSON.stringify(jsmql.expr(call));
        expect(out).not.toContain("$literal");
      });
    }
  }

  it("$literal itself still emits its envelope in both contexts", () => {
    expect(jsmql.expr(`$literal("$y")`)).toEqual({ $literal: "$y" });
    expect(jsmql(`$project({ x: $literal("$y") });`)).toEqual([{ $project: { x: { $literal: "$y" } } }]);
  });
});

// One representative valid pipeline source per stage that can carry a `$`-string.
// Every entry asserts the emitted document contains no spurious `$literal`.
const STAGE_CASES: Record<string, string> = {
  $addFields: `$addFields({ v: "$x" });`,
  $bucket: `$bucket({ groupBy: "$price", boundaries: [0, 100, 200], default: "other" });`,
  $bucketAuto: `$bucketAuto({ groupBy: "$price", buckets: 4 });`,
  $count: `$count("total");`,
  $densify: `$densify({ field: "ts", range: { step: 1, unit: "hour", bounds: "full" } });`,
  $documents: `$documents([{ a: "$x" }]);`,
  $facet: `$facet({ a: [$count("c")] });`,
  $fill: `$fill({ output: { v: { value: "$x" } } });`,
  $geoNear: `$geoNear({ near: { type: "Point", coordinates: [0, 0] }, distanceField: "d", key: "loc" });`,
  $graphLookup: `$graphLookup({ from: "c", startWith: "$ref", connectFromField: "ref", connectToField: "_id", as: "out" });`,
  $group: `$group({ _id: "$cat", n: $sum("$qty") });`,
  $limit: `$limit(5);`,
  $lookup: `$lookup({ from: "c", localField: "a", foreignField: "b", as: "out" });`,
  $match: `$match($.x === "$y");`,
  $merge: `$merge("archived");`,
  $out: `$out("archived");`,
  $project: `$project({ x: "$y" });`,
  $redact: `$redact("$$PRUNE");`,
  $replaceRoot: `$replaceRoot({ newRoot: "$sub" });`,
  $replaceWith: `$replaceWith("$sub");`,
  $sample: `$sample({ size: 3 });`,
  $set: `$set({ v: "$x" });`,
  $setWindowFields: `$setWindowFields({ partitionBy: "$g", sortBy: { t: 1 }, output: { n: $sum("$q") } });`,
  $skip: `$skip(2);`,
  $sort: `$sort({ t: 1 });`,
  $sortByCount: `$sortByCount("$tags");`,
  $unionWith: `$unionWith({ coll: "c", pipeline: [$match($.x === "$y")] });`,
  $unset: `$unset(["a", "b"]);`,
  $unwind: `$unwind("$items");`,
};

// Stages with no `$`-string body to pass through, or that require server/source
// infrastructure jsmql surfaces only via dedicated sugar (`$$`/`$$$$`). Each is
// excluded from the pass-through loop with its reason, but still counted by the
// coverage meta-assertion below so no stage is silently uncovered.
const STAGE_SKIP: Record<string, string> = {
  $changeStream: "source stage; no $-string body",
  $changeStreamSplitLargeEvent: "terminal stage; no $-string body",
  $collStats: "diagnostic source stage (option object, no $-string)",
  $currentOp: "diagnostic source stage; surfaced via $$$$ sugar",
  $indexStats: "diagnostic source stage; surfaced via $$ sugar",
  $listLocalSessions: "diagnostic source stage; surfaced via $$$$ sugar",
  $listSampledQueries: "diagnostic source stage; surfaced via $$$$ sugar",
  $listSearchIndexes: "diagnostic source stage; surfaced via $$ sugar",
  $listSessions: "diagnostic source stage; surfaced via $$$$ sugar",
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
    it(`${name}: stage body emits no spurious $literal`, () => {
      const out = JSON.stringify(jsmql.pipeline(src));
      expect(out).not.toContain("$literal");
    });
  }

  it("every registered stage is either pass-through-tested or explicitly skipped", () => {
    const accounted = new Set([...Object.keys(STAGE_CASES), ...Object.keys(STAGE_SKIP)]);
    const uncovered = Object.keys(STAGES).filter((s) => !accounted.has(s));
    expect(uncovered).toEqual([]);
    // No stale skip entries that no longer name a real stage.
    const staleSkips = Object.keys(STAGE_SKIP).filter((s) => !(s in STAGES));
    expect(staleSkips).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server-rejection regressions found by replaying generated MQL against a real
// mongod (see test/CLAUDE.md → "Never assert MQL the MongoDB server would
// reject"). Each shape below WAS emitted by jsmql at some point and rejected by
// MongoDB; these lock in the corrected, runnable shapes.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk an MQL value and collect every name that MongoDB treats as a user
 * variable: a `$let`/`$lookup` `let`/`vars` key, and a `$map`/`$filter`/`$reduce`
 * `as` value. MongoDB requires each to begin with a lowercase ASCII letter; a
 * leading `_`/`$`/uppercase/digit makes the server reject the pipeline.
 */
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

const VALID_VAR = /^[a-z]/; // MongoDB user-variable first-char rule (matches safeVarName)
const VALID_REGEX_OPTS = /^[imsx]*$/; // MongoDB $regex* options (no JS g/u/y/d/v)

/** Inputs that previously produced server-invalid MQL, with how to compile them. */
const REGRESSION_INPUTS: Array<{ label: string; mql: () => unknown }> = [
  {
    label: "$lookup auto-let on $._id (pipeline form)",
    mql: () => jsmql(`$.u = $$$.users.find(u => u.refId === $._id && u.active);`),
  },
  {
    label: "$lookup auto-let on $._id (basic form)",
    mql: () => jsmql(`$.o = $$$.orders.filter(o => o.userId === $._id);`),
  },
  { label: "|| short-circuit binding", mql: () => jsmql.expr(`($.a + $.b) || $.c`) },
  { label: "&& short-circuit binding", mql: () => jsmql.expr(`($.a + $.b) && $.c`) },
  { label: "Array.from with throwaway _ param", mql: () => jsmql.expr(`Array.from({ length: 3 }, (_, i) => i * 2)`) },
  { label: ".map throwaway _ param", mql: () => jsmql(`$set({ xs: $.xs.map(_ => 0) });`) },
  { label: ".reduce throwaway _ element param", mql: () => jsmql.expr(`$.xs.reduce((acc, _, i) => acc + i, 0)`) },
  { label: ".fill() statement mutator (bounds)", mql: () => jsmql(`$.xs.fill(0, 1, 3);`) },
  { label: ".fill() statement mutator (no bounds)", mql: () => jsmql(`$.xs.fill(0);`) },
  { label: "$$ = [] drop-all", mql: () => jsmql(`$$ = [];`) },
  { label: "$$ = source-switch", mql: () => jsmql(`$$ = $$$.transactions.filter(t => t.client === 156);`) },
  { label: ".match(/re/g)", mql: () => jsmql.expr(`$.s.match(/word/g)`) },
  { label: ".matchAll(/re/g)", mql: () => jsmql.expr(`$.s.matchAll(/word/g)`) },
  { label: "/re/gi.test()", mql: () => jsmql.expr(`/pattern/gi.test($.str)`) },
];

describe("server-rejection regressions — no invalid var names, $limit:0, or regex flags", () => {
  for (const { label, mql } of REGRESSION_INPUTS) {
    it(`${label}: emits only MongoDB-valid user variable names`, () => {
      const bad = collectVarNames(mql()).filter((n) => !VALID_VAR.test(n));
      expect(bad).toEqual([]);
    });
  }

  it("the $-prefixed local field name flows through as a sanitized let var", () => {
    // `$._id` → let var `v0_id` (not the server-rejected `_id`), referenced as `$$v0_id`.
    expect(jsmql(`$.u = $$$.users.find(u => u.refId === $._id && u.active);`)).toEqual([
      {
        $lookup: {
          from: "users",
          let: { v0_id: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $cond: { if: { $eq: ["$refId", "$$v0_id"] }, then: "$active", else: { $eq: ["$refId", "$$v0_id"] } },
                },
              },
            },
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
    // No pipeline should ever contain `$limit: 0`.
    for (const { mql } of REGRESSION_INPUTS) {
      expect(JSON.stringify(mql())).not.toContain('"$limit":0');
    }
  });

  it("regex options carry only MongoDB-valid flags (JS g/u/y dropped)", () => {
    expect(jsmql.expr(`$.s.match(/word/g)`)).toEqual({ $regexMatch: { input: "$s", regex: "word" } });
    expect(jsmql.expr(`$.s.matchAll(/word/g)`)).toEqual({ $regexFindAll: { input: "$s", regex: "word" } });
    expect(jsmql.expr(`/pattern/gi.test($.str)`)).toEqual({
      $regexMatch: { input: "$str", regex: "pattern", options: "i" },
    });
    // Walk every regex options string in the corpus and assert validity.
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
