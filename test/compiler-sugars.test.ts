// Phase 5 of src/compiler/ — the destination-visible sugars and the source stages:
//
//   $ = { k: $$.filter(…), … }        a $facet, one branch per chain on the stream
//   $$.push(…) / .concat(…)           a $unionWith per source, in order
//   $$$.<coll> = $$.…  / $$$$.<db>.<coll> = $$.…   the stream written out ($out)
//   $$.indexStats() / $$$$.currentOp(…)             the source stages, scoped by sigil
//   function f(x) { return … }                      a name for a body, inlined at each call
//
// The server half runs every read-only pipeline this file asserts on a live
// mongod and compares the documents that come back; the `$out` pipelines are run
// and the target collection read. Self-skips (green) when no mongod is reachable,
// with the all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Db } from "mongodb";
import { pipeline } from "../src/compiler/index.ts";
import { liveClient } from "./fixtures/live.ts";

const MAIN = [
  { _id: 1, a: 1, tag: "t1", xs: [3, 1, 2] },
  { _id: 2, a: 2, tag: "t2", xs: [2, 5] },
  { _id: 3, a: 3, tag: "t1", xs: [] as number[] },
];
const ARCHIVE = [
  { _id: 10, a: 10, tag: "t1" },
  { _id: 20, a: 20, tag: "t9" },
];

type Run = { src: string; expected?: unknown; reads?: string };
const RUNS: Run[] = [];
const compiled = (src: string, expected?: unknown, reads?: string): unknown[] => {
  RUNS.push({ src, expected, reads });
  return pipeline(src);
};

describe("compiler/emit — `$ = { k: $$.… }` is a $facet", () => {
  it("makes one branch per chain on the stream, each the chain's stages", () => {
    expect(
      compiled('$ = { big: $$.filter(o => o.a > 1), all: $$.take(10), n: $$.$count("n") };', [
        { big: [2, 3], all: [1, 2, 3], n: [{ n: 3 }] },
      ]),
    ).toEqual([{ $facet: { big: [{ $match: { a: { $gt: 1 } } }], all: [{ $limit: 10 }], n: [{ $count: "n" }] } }]);
    // the root document is the branch's document, at every depth (HR4)
    expect(compiled("$ = { t1: $$.filter(o => $.tag === 't1') };", [{ t1: [1, 3] }])).toEqual([
      { $facet: { t1: [{ $match: { tag: "t1" } }] } },
    ]);
    // a bare `$$` is the stream unchanged; a block is its stages
    expect(
      compiled("$ = { all: $$, agg: $$.aggregate(o => { $match(o.a > 1); o.y = o.a * 2; }) };", [
        {
          all: [1, 2, 3],
          agg: [
            { _id: 2, y: 4 },
            { _id: 3, y: 6 },
          ],
        },
      ]),
    ).toEqual([
      { $facet: { all: [], agg: [{ $match: { a: { $gt: 1 } } }, { $set: { y: { $multiply: ["$a", 2] } } }] } },
    ]);
    // a `let` before it is dropped — the stage replaces the document
    expect(() => pipeline("let x = $.a; $ = { k: $$.take(1) }; $.z = x;")).toThrow(/can't be read after `\$facet`/);
  });

  it("refuses what no server accepts, naming the way out", () => {
    expect(() => pipeline("$ = { a: $$.filter(o => o.a > 1), lit: 1 };")).toThrow(/every entry must be one: 'lit'/);
    expect(() => pipeline('$ = { "a.b": $$.take(1) };')).toThrow(/cannot name a '\$facet' branch/);
    expect(() => pipeline('$ = { "$big": $$.take(1) };')).toThrow(/cannot name a '\$facet' branch/);
    // measured: `$facet is not allowed to be used within a $facet stage`, `$out is not allowed … within a $facet`
    expect(() => pipeline("$ = { outer: $$.aggregate(o => { $ = { inner: $$.take(1) }; }) };")).toThrow(
      /'\$facet' cannot stand inside '\$facet'/,
    );
    expect(() => pipeline('$ = { w: $$.$out("x") };')).toThrow(/'\$out' cannot stand inside '\$facet'/);
    // a chain on the stream assigned to a FIELD is not a value
    expect(() => pipeline("$.k = $$.filter(o => o.a > 1);")).toThrow(/not a value/);
  });
});

describe("compiler/emit — `$$.push(…)` and `.concat(…)` are $unionWith", () => {
  it("one stage per source, in order; documents batch into one $documents", () => {
    expect(compiled("$$.push(...$$$.archive);", [1, 2, 3, 10, 20])).toEqual([{ $unionWith: "archive" }]);
    expect(compiled("$$.push(...$$$.archive.filter(o => o.a > 10));", [1, 2, 3, 20])).toEqual([
      { $unionWith: { coll: "archive", pipeline: [{ $match: { a: { $gt: 10 } } }] } },
    ]);
    expect(compiled("$$.push($$$.archive.find(o => o.a > 1));", [1, 2, 3, 10])).toEqual([
      { $unionWith: { coll: "archive", pipeline: [{ $match: { a: { $gt: 1 } } }, { $limit: 1 }] } },
    ]);
    expect(
      compiled("$$.push({ a: 1 }, { b: 2 }, ...$$$.archive, { c: 3 });", [
        1,
        2,
        3,
        { a: 1 },
        { b: 2 },
        10,
        20,
        { c: 3 },
      ]),
    ).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { b: 2 }] }] } },
      { $unionWith: "archive" },
      { $unionWith: { pipeline: [{ $documents: [{ c: 3 }] }] } },
    ]);
    // `.concat` is the same, mid-chain
    expect(compiled("$$.filter(o => o.a > 2).concat(...$$$.archive).take(2);", [3, 10])).toEqual([
      { $match: { a: { $gt: 2 } } },
      { $unionWith: "archive" },
      { $limit: 2 },
    ]);
  });

  it("keeps JavaScript's spread rule, and knows $unionWith has no `let`", () => {
    expect(() => pipeline("$$.push($$$.archive.filter(o => o.a > 1));")).toThrow(
      /would push the whole array as one document/,
    );
    expect(() => pipeline("$$.push(...$$$.archive.find(o => o.a > 1));")).toThrow(
      /gives ONE document, which JavaScript would not spread/,
    );
    expect(() => pipeline("$$.push(...$.items);")).toThrow(/An array the DATA decides cannot be appended/);
    // a WRITTEN list of documents is appendable: `$documents` takes a spelled-out list
    expect(pipeline("$$.push(...[{ a: 1 }, { a: 2 }]);")).toEqual([
      { $unionWith: { pipeline: [{ $documents: [{ a: 1 }, { a: 2 }] }] } },
    ]);
    expect(() => pipeline("$$.push(5);")).toThrow(/this is a number/);
    // `$documents` runs with no input document, and a `$unionWith` body has no `let` — measured
    expect(() => pipeline("$$.push({ a: $.a });")).toThrow(/has no 'let'/);
    expect(() => pipeline("$$.push(...$$$.archive.filter(o => o.tag === $.tag));")).toThrow(/has no 'let'/);
    // `$$` is the root stream; a body over another collection names its own through the parameter
    expect(() => pipeline("$.o = $$$.archive.aggregate(o => { $$.push({ a: 1 }); });")).toThrow(
      /'\$\$' is the root stream/,
    );
    expect(compiled("$.o = $$$.archive.aggregate((o, _i, coll) => { coll.concat(...$$$.main); });")).toEqual([
      { $lookup: { from: "archive", pipeline: [{ $unionWith: "main" }], as: "o" } },
    ]);
  });
});

describe("compiler/emit — `$$$.<coll> = <stream>` is $out", () => {
  it("writes the stream, after its stages, as the last stage", () => {
    expect(compiled("$$$.out_all = $$;", [1, 2, 3], "out_all")).toEqual([{ $out: "out_all" }]);
    expect(compiled("$$$.out_big = $$.filter(o => o.a > 1).take(5);", [2, 3], "out_big")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $limit: 5 },
      { $out: "out_big" },
    ]);
    expect(compiled('$$$["out-dash"] = $$;', [1, 2, 3], "out-dash")).toEqual([{ $out: "out-dash" }]);
    expect(pipeline("$$$$.jsmql_compiler_sugars_other.c = $$;")).toEqual([
      { $out: { db: "jsmql_compiler_sugars_other", coll: "c" } },
    ]);
    // the cleanup precedes the write
    expect(
      compiled(
        "let x = $.a; $.b = x; $$$.out_b = $$;",
        [
          { _id: 1, b: 1 },
          { _id: 2, b: 2 },
          { _id: 3, b: 3 },
        ],
        "out_b",
      ),
    ).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { b: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
      { $out: "out_b" },
    ]);
  });

  it("refuses a target the server refuses, and a source that is not the stream", () => {
    expect(() => pipeline("$$$.x = $$$.other;")).toThrow(/written from the stream/);
    expect(() => pipeline("$$$.x = $.items;")).toThrow(/written from the stream/);
    expect(() => pipeline("$$$.a.b = $$;")).toThrow(/too many segments/i);
    expect(() => pipeline("$$$$.onlydb = $$;")).toThrow(/names a database/);
    expect(() => pipeline("$$$[$.name] = $$;")).toThrow(/named when the pipeline is written/);
    expect(() => pipeline('$$$[""] = $$;')).toThrow(/cannot name a collection to write/);
    expect(() => pipeline('$$$["$x"] = $$;')).toThrow(/cannot name a collection to write/);
    expect(() => pipeline("$$$.x = $$; $.y = 1;")).toThrow(/Nothing can follow '\$out'/);
  });
});

describe("compiler/emit — `$$ = [{ k: $$.reduce(…) }]` folds the stream to one document", () => {
  it("reads each reducer body as the accumulator it spells", () => {
    expect(
      compiled(
        "$$ = [{ total: $$.reduce((acc, d) => acc + d.a, 0), n: $$.reduce((acc, d) => acc + 1, 0), mx: $$.reduce((acc, d) => Math.max(acc, d.a), 0), tags: $$.reduce((acc, d) => [...acc, d.tag], []), last: $$.reduce((acc, d) => d.a, null), first: $$.reduce((acc, d) => acc ?? d.tag, null) }];",
        [{ total: 6, n: 3, mx: 3, tags: ["t1", "t2", "t1"], last: 3, first: "t1" }],
      ),
    ).toEqual([
      {
        $group: {
          _id: null,
          total: { $sum: "$a" },
          n: { $sum: 1 },
          mx: { $max: "$a" },
          tags: { $push: "$tag" },
          last: { $last: "$a" },
          first: { $first: "$tag" },
        },
      },
      // the seed is folded in as JavaScript would: `Math.max` from 0 is the max with 0
      {
        $replaceWith: {
          total: "$total",
          n: "$n",
          mx: { $max: [0, "$mx"] },
          tags: "$tags",
          last: "$last",
          first: "$first",
        },
      },
    ]);
    // the object reducer names every fold in its body and its init
    expect(
      compiled(
        "$$ = [$$.reduce((acc, d) => ({ ...acc, total: acc.total + d.a, n: acc.n + 1 }), { total: 0, n: 0 })];",
        [{ total: 6, n: 3 }],
      ),
    ).toEqual([
      { $group: { _id: null, total: { $sum: "$a" }, n: { $sum: 1 } } },
      { $replaceWith: { total: "$total", n: "$n" } },
    ]);
    // the fold's document is the stream's document after it
    expect(
      compiled(
        "$$.filter(d => d.a > 1); $$ = [{ total: $$.reduce((acc, d) => acc + d.a, 0) }]; $.double = $.total * 2;",
        [{ total: 5, double: 10 }],
      ),
    ).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $group: { _id: null, total: { $sum: "$a" } } },
      { $replaceWith: { total: "$total" } },
      { $set: { double: { $multiply: ["$total", 2] } } },
    ]);
  });

  it("refuses a body that spells no accumulator, and a fold outside its wrap", () => {
    expect(() => pipeline("$$ = [{ t: $$.reduce((acc, d) => acc * d.a, 1) }];")).toThrow(
      /spells no MongoDB accumulator/,
    );
    expect(() => pipeline("$$ = [{ t: $$.reduce((acc, d) => acc + d.a, 0) }, { x: 1 }];")).toThrow(/wrap it in one/);
    expect(() => pipeline("$$ = [$$.reduce((acc, d) => ({ ...acc, t: acc.t + d.a }), { t: 0, n: 0 })];")).toThrow(
      /uneven/,
    );
    expect(() => pipeline("$$ = [$$.reduce((acc, d) => acc + d.a, 0)];")).toThrow(/returns a document/);
    expect(() => pipeline("$.t = $$.reduce((acc, d) => acc + d.a, 0);")).toThrow(/not a value/);
  });
});

describe("compiler/emit — the source stages, scoped by sigil", () => {
  it("runs the row's stage, first, on the sigil the row states", () => {
    expect(compiled("$$.indexStats();")).toEqual([{ $indexStats: {} }]);
    expect(pipeline("$$$$.currentOp({ allUsers: true });")).toEqual([{ $currentOp: { allUsers: true } }]);
    expect(pipeline("$$$$.listSessions();")).toEqual([{ $listSessions: {} }]);
    expect(() => pipeline("$$$$.indexStats();")).toThrow(/is defined on 'stream'/);
    expect(() => pipeline("$$.currentOp();")).toThrow(/is defined on 'cluster'/);
    expect(() => pipeline("$match($.a > 1); $$.indexStats();")).toThrow(/has to be the FIRST stage/);
  });
});

describe("compiler/emit — a declared function is a name for a body", () => {
  it("inlines the body at each call, and is declared once per block", () => {
    expect(
      compiled("function tax(x) { return x * 1.1; } $.total = tax($.a);", [
        { _id: 1, total: 1 * 1.1 },
        { _id: 2, total: 2 * 1.1 },
        { _id: 3, total: 3 * 1.1 },
      ]),
    ).toEqual([{ $set: { total: { $let: { vars: { x: "$a" }, in: { $multiply: ["$$x", 1.1] } } } } }]);
    expect(() => pipeline("function f(x) { return x; } function f(y) { return y; }")).toThrow(
      /already declared earlier in this block/,
    );
    expect(() => pipeline("function f(x) { return f(x) + 1; } $.y = f($.a);")).toThrow(/recurs/i);
  });
});

// ── the server ───────────────────────────────────────────────────────────────

let client: MongoClient | null = null;
let db: Db | null = null;

beforeAll(async () => {
  client = await liveClient();
  // Null means the instance is not running, and only that: liveClient throws on any
  // other refusal rather than letting this suite skip itself green.
  if (client === null) return;
  const c = client;
  db = c.db("jsmql_compiler_sugars");
  await db.dropDatabase();
  await db.collection("main").insertMany(MAIN.map((d) => ({ ...d })));
  await db.collection("archive").insertMany(ARCHIVE.map((d) => ({ ...d })));
});

afterAll(async () => {
  await client?.close();
});

/** A result reduced to what the pipeline added: a fixture document is its id, a facet branch a list of them. */
const FIXTURE_KEYS = new Set(["a", "tag", "xs"]);
const shrink = (v: unknown, top: boolean): unknown => {
  if (Array.isArray(v)) return v.map((x) => shrink(x, false));
  if (v !== null && typeof v === "object") {
    const d = v as Record<string, unknown>;
    if ("_id" in d && MAIN.concat(ARCHIVE).some((f) => f._id === d._id)) {
      const added = Object.entries(d).filter(([k]) => k !== "_id" && !FIXTURE_KEYS.has(k));
      if (added.length === 0) return d._id;
      return { _id: d._id, ...Object.fromEntries(added) };
    }
    const out = Object.fromEntries(
      Object.entries(d)
        .filter(([k]) => k !== "_id")
        .map(([k, x]) => [k, shrink(x, false)]),
    );
    return top ? out : out;
  }
  return v;
};
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

describe("compiler/emit — a JavaScript aggregate inside $group / $setWindowFields is the accumulator", () => {
  it("reads the receiver as the accumulator's operand", () => {
    expect(
      compiled(
        "$group({ _id: $.tag, total: $.a.sum(), avg: $.a.mean(), mx: $.a.max(), mn: $.a.min(), f: $.a.first(), h: $.a.head(), l: $.a.last() }); $sort({ _id: 1 });",
        [
          { total: 4, avg: 2, mx: 3, mn: 1, f: 1, h: 1, l: 3 },
          { total: 2, avg: 2, mx: 2, mn: 2, f: 2, h: 2, l: 2 },
        ],
      ),
    ).toEqual([
      {
        $group: {
          _id: "$tag",
          total: { $sum: "$a" },
          avg: { $avg: "$a" },
          mx: { $max: "$a" },
          mn: { $min: "$a" },
          f: { $first: "$a" },
          h: { $first: "$a" },
          l: { $last: "$a" },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  });

  it("accumulates each document's own sumBy / meanBy — the accumulator alone ignores an array operand", () => {
    expect(
      compiled(
        "$group({ _id: $.tag, q: [$.a, 1].sumBy(x => x * 2), m: [$.a, 1].meanBy(x => x) }); $sort({ _id: 1 });",
        [
          { q: 12, m: 1.5 },
          { q: 6, m: 1.5 },
        ],
      ),
    ).toEqual([
      {
        $group: {
          _id: "$tag",
          q: { $sum: { $sum: { $map: { input: ["$a", 1], as: "x", in: { $multiply: ["$$x", 2] } } } } },
          m: { $avg: { $avg: { $map: { input: ["$a", 1], as: "x", in: "$$x" } } } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  });

  it("is the window operator inside $setWindowFields.output", () => {
    expect(
      compiled(
        "$setWindowFields({ partitionBy: $.tag, sortBy: { _id: 1 }, output: { run: $.a.sum(), f: $.a.first(), avg: $.a.mean(), l: $.a.last() } }); $sort({ _id: 1 });",
        [
          { _id: 1, run: 4, f: 1, avg: 2, l: 3 },
          { _id: 2, run: 2, f: 2, avg: 2, l: 2 },
          { _id: 3, run: 4, f: 1, avg: 2, l: 3 },
        ],
      ),
    ).toEqual([
      {
        $setWindowFields: {
          partitionBy: "$tag",
          sortBy: { _id: 1 },
          output: { run: { $sum: "$a" }, f: { $first: "$a" }, avg: { $avg: "$a" }, l: { $last: "$a" } },
        },
      },
      { $sort: { _id: 1 } },
    ]);
  });
});

describe("compiler/emit — a mutator statement writes its receiver", () => {
  // each expectation is JavaScript's own answer over the fixture
  const after = (mutate: (xs: number[]) => void) =>
    MAIN.map((d) => {
      const ys = [...d.xs];
      mutate(ys);
      return { _id: d._id, ys };
    });

  it("pop and shift are slices of a receiver the spelling proved an array", () => {
    expect(
      compiled(
        "$.ys = $.xs; $.ys.pop();",
        after((ys) => ys.pop()),
      ),
    ).toEqual([
      { $set: { ys: "$xs" } },
      {
        $set: {
          ys: {
            $let: {
              vars: { jsmqlArr: "$ys" },
              in: { $slice: ["$$jsmqlArr", { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] }] },
            },
          },
        },
      },
    ]);
    expect(
      compiled(
        "$.ys = $.xs; $.ys.shift();",
        after((ys) => ys.shift()),
      ),
    ).toEqual([
      { $set: { ys: "$xs" } },
      {
        $set: {
          ys: {
            $let: {
              vars: { jsmqlArr: "$ys" },
              in: { $slice: ["$$jsmqlArr", 1, { $max: [1, { $size: "$$jsmqlArr" }] }] },
            },
          },
        },
      },
    ]);
    expect(() => pipeline("$.xs.pop(1);")).toThrow(/'\.pop\(\)' takes exactly 0 arguments, got 1/);
  });

  it("fill and copyWithin follow JavaScript's index rules, negatives included", () => {
    expect(
      compiled(
        "$.ys = $.xs; $.ys.fill(0);",
        after((ys) => ys.fill(0)),
      ),
    ).toEqual([{ $set: { ys: "$xs" } }, { $set: { ys: { $map: { input: "$ys", as: "jsmqlUnused", in: 0 } } } }]);
    compiled(
      "$.ys = $.xs; $.ys.fill(9, 1);",
      after((ys) => ys.fill(9, 1)),
    );
    compiled(
      "$.ys = $.xs; $.ys.fill(9, 1, 2);",
      after((ys) => ys.fill(9, 1, 2)),
    );
    compiled(
      "$.ys = $.xs; $.ys.fill(9, 2, 1);",
      after((ys) => ys.fill(9, 2, 1)),
    );
    compiled(
      "$.ys = $.xs; $.ys.fill(9, -1);",
      after((ys) => ys.fill(9, -1)),
    );
    compiled(
      "$.ys = $.xs; $.ys.copyWithin(0, 1);",
      after((ys) => ys.copyWithin(0, 1)),
    );
    compiled(
      "$.ys = $.xs; $.ys.copyWithin(1, 0, 1);",
      after((ys) => ys.copyWithin(1, 0, 1)),
    );
    compiled(
      "$.ys = $.xs; $.ys.copyWithin(-1, 0);",
      after((ys) => ys.copyWithin(-1, 0)),
    );
    expect(() => pipeline("$.xs.fill();")).toThrow(
      /'\.fill\(value\[, start\[, end\]\]\)' takes 1 to 3 arguments, got 0/,
    );
  });

  it("a binding is a target too, and a mutator may write a const — JavaScript allows the mutation", () => {
    compiled(
      "let r = [3, 1]; r.pop(); $.r = r;",
      MAIN.map((d) => ({ _id: d._id, r: [3] })),
    );
    compiled(
      "const r = [3, 1]; r.push(2); $.r = r;",
      MAIN.map((d) => ({ _id: d._id, r: [3, 1, 2] })),
    );
    compiled(
      "const r = { p: 1 }; Object.assign(r, { q: 2 }); $.r = r;",
      MAIN.map((d) => ({ _id: d._id, r: { p: 1, q: 2 } })),
    );
    expect(() => pipeline("Object.assign(zzz, { a: 1 });")).toThrow(/zzz/);
    expect(() => pipeline("$.s.trim().sort();")).toThrow(/needs a field or a binding to write/);
    expect(() => pipeline("[1, 2].reverse();")).toThrow(/needs a field or a binding to write/);
  });

  it("Object.assign at statement position writes its target", () => {
    expect(
      compiled("$.o = { p: 1 }; Object.assign($.o, { q: 2 });", [
        { _id: 1, o: { p: 1, q: 2 } },
        { _id: 2, o: { p: 1, q: 2 } },
        { _id: 3, o: { p: 1, q: 2 } },
      ]),
    ).toEqual([{ $set: { o: { $mergeObjects: [{ p: 1 }] } } }, { $set: { o: { $mergeObjects: ["$o", { q: 2 }] } } }]);
  });

  it("assert is a guard stage whose failure names the message", () => {
    expect(compiled('assert($.a > 0, "a must be positive");', [1, 2, 3])).toEqual([
      {
        $match: {
          $expr: {
            $convert: {
              input: true,
              to: { $cond: [{ $gt: ["$a", 0] }, "bool", "jsmql assertion failed: a must be positive"] },
            },
          },
        },
      },
    ]);
    expect(compiled("assert($.a > 0);", [1, 2, 3])).toEqual([
      {
        $match: {
          $expr: { $convert: { input: true, to: { $cond: [{ $gt: ["$a", 0] }, "bool", "jsmql assertion failed"] } } },
        },
      },
    ]);
    expect(pipeline("assert($.a > 0, $.tag);")).toEqual([
      {
        $match: {
          $expr: {
            $convert: {
              input: true,
              to: {
                $cond: [{ $gt: ["$a", 0] }, "bool", { $concat: ["jsmql assertion failed: ", { $toString: "$tag" }] }],
              },
            },
          },
        },
      },
    ]);
    expect(() => pipeline("assert(...$.flags);")).toThrow(/Spread \(\.\.\.\) is not supported/);
    expect(() => pipeline("const assert = (x) => x; assert($.y);")).toThrow(/only computes a value/);
  });
});

describe("compiler/emit — the server runs every pipeline this file asserts", () => {
  it("ran each one, or none", async () => {
    if (db === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    const problems: string[] = [];
    for (const { src, expected, reads } of RUNS) {
      let docs: Record<string, unknown>[];
      try {
        docs = await db
          .collection("main")
          .aggregate(pipeline(src) as Record<string, unknown>[])
          .toArray();
        if (reads !== undefined) docs = await db.collection(reads).find().sort({ _id: 1 }).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(pipeline(src))}\n  ${(e as Error).message}`);
        continue;
      }
      if (expected === undefined) continue;
      const got = canonical(docs.map((d) => shrink(d, true)));
      const want = canonical(expected);
      if (got !== want) problems.push(`${src}\n  got  ${got}\n  want ${want}`);
    }
    expect(problems, `${problems.length} of ${RUNS.length}:\n${problems.join("\n")}`).toEqual([]);
  });
});
