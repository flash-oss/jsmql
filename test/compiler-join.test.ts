// Phase 5 of src/compiler/ — the join road: `$$$.<coll>.<chain>` as `$lookup`.
//
// Two shapes, one road. One correlated equality and nothing else is the
// `localField`/`foreignField` pair — the join a MongoDB developer writes, which
// the planner reads from the foreign index. Everything else keeps `let` +
// `pipeline` + `$expr` (see docs/specs/emit-pass.md § The join road). `$.` is the
// OUTER document at every depth (HR4) and reaches the body through the stage's
// `let`; the body's own document is its parameter.
//
// The second half runs every pipeline this file asserts on a live mongod AND
// compares the documents that come back with what JavaScript would give over
// the same fixture, because a green `toEqual` proves what the compiler emits
// and never what the server does with it. Self-skips (green) when no mongod is
// reachable, with an all-or-nothing guard.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection, type Db } from "mongodb";
import { expr, pipeline } from "../src/compiler/index.ts";

const URI = "mongodb://127.0.0.1:27017";

const USERS = [
  { _id: 1, tag: "x", ids: [101, 103], minTotal: 6 },
  { _id: 2, tag: "y", minTotal: 6 },
  { _id: 3 },
  { _id: 4, nul: null },
];
const ORDERS = [
  { _id: 101, userId: 1, total: 10, status: "paid", tag: "x" },
  { _id: 102, userId: 1, total: 20, status: "open", tag: "y" },
  { _id: 103, userId: 2, total: 5, status: "paid", tag: "y" },
  { _id: 104, total: 7, nul: null },
];
const ITEMS = [
  { _id: "i1", orderId: 101, tag: "x", q: 2 },
  { _id: "i2", orderId: 101, tag: "y", q: 9 },
  { _id: "i3", orderId: 103, tag: "y", q: 1 },
];

/** Every source asserted below runs on the server too; `expected` compares the documents that come back. */
const RUNS: { src: string; expected?: unknown[] }[] = [];
const compiled = (src: string, expected?: unknown[]): unknown[] => {
  RUNS.push({ src, expected });
  return pipeline(src);
};

const E = (id: unknown) => ({ $expr: { $eq: ["$userId", id] } });
const LET = { jsmql_f0__id: "$_id" };
const byUser = { $match: E("$$jsmql_f0__id") };
/** One correlated equality and nothing else is the pair the planner reads from the index. */
const COMPACT = { localField: "_id", foreignField: "userId" };

describe("compiler/emit/join — one route, the pipeline form", () => {
  it("joins on one correlated equality with the pair MongoDB reads from the index", () => {
    // `localField`/`foreignField` is the join a MongoDB developer writes, and the
    // server's own rules apply to it: a missing field counts as null, and an array
    // matches element-wise. The same boundary a query document has.
    expect(
      compiled("$.orders = $$$.orders.filter(o => o.userId === $._id);", [
        { _id: 1, orders: [101, 102] },
        { _id: 2, orders: [103] },
        { _id: 3, orders: [] },
        { _id: 4, orders: [] },
      ]),
    ).toEqual([{ $lookup: { from: "orders", ...COMPACT, as: "orders" } }]);
    // the lodash shorthand is the same predicate
    expect(compiled("$.orders = $$$.orders.filter({ userId: $._id });")).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "orders" } },
    ]);
    // MEASURED on mongod: the pair reads a MISSING field as null, so a document with
    // no `nul` and a document whose `nul` IS null join the same foreign documents.
    expect(
      compiled("$.same = $$$.orders.filter(o => o.nul === $.nul);", [
        { _id: 1, same: [101, 102, 103, 104] },
        { _id: 2, same: [101, 102, 103, 104] },
        { _id: 3, same: [101, 102, 103, 104] },
        { _id: 4, same: [101, 102, 103, 104] },
      ]),
    ).toEqual([{ $lookup: { from: "orders", localField: "nul", foreignField: "nul", as: "same" } }]);
  });

  it("keeps a constant clause native beside the correlation", () => {
    expect(
      compiled('$.paid = $$$.orders.filter(o => o.userId === $._id && o.status === "paid");', [
        { _id: 1, paid: [101] },
        { _id: 2, paid: [103] },
        { _id: 3, paid: [] },
        { _id: 4, paid: [] },
      ]),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: LET,
          pipeline: [{ $match: { status: "paid", $expr: { $eq: ["$userId", "$$jsmql_f0__id"] } } }],
          as: "paid",
        },
      },
    ]);
  });

  it("`.find` is the first match, as ONE document — absent when nothing matched", () => {
    expect(
      compiled("$.first = $$$.orders.find(o => o.userId === $._id);", [
        { _id: 1, first: 101 },
        { _id: 2, first: 103 },
        { _id: 3 },
        { _id: 4 },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", let: LET, pipeline: [byUser, { $limit: 1 }], as: "first" } },
      { $set: { first: { $first: "$first" } } },
    ]);
  });

  it("carries an outer `let` binding and a nested field into the body", () => {
    expect(
      compiled("let cutoff = $.minTotal; $.big = $$$.orders.filter(o => o.userId === $._id && o.total > cutoff);", [
        { _id: 1, big: [101, 102] },
        { _id: 2, big: [] },
        { _id: 3, big: [] },
        { _id: 4, big: [] },
      ]),
    ).toEqual([
      { $set: { "__jsmql.var.cutoff": "$minTotal" } },
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id", jsmql_v0_cutoff: "$__jsmql.var.cutoff" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $gt: ["$total", "$$jsmql_v0_cutoff"] }] },
              },
            },
          ],
          as: "big",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("compiler/emit/join — the chain peels into the body, the rest reads the value", () => {
  it("puts stream links inside the `$lookup.pipeline`, in source order", () => {
    expect(
      // the two cheapest orders are 103 and 104, and only then is the owner tested
      compiled('$.top = $$$.orders.toSorted("total").take(2).filter(o => o.userId === $._id);', [
        { _id: 1, top: [] },
        { _id: 2, top: [103] },
        { _id: 3, top: [] },
        { _id: 4, top: [] },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", let: LET, pipeline: [{ $sort: { total: 1 } }, { $limit: 2 }, byUser], as: "top" } },
    ]);
    // a `.map` to a DOCUMENT is a `$replaceWith` inside the body
    expect(
      compiled("$.t = $$$.orders.filter(o => o.userId === $._id).map(o => ({ t: o.total })).take(1);", [
        { _id: 1, t: [{ t: 10 }] },
        { _id: 2, t: [{ t: 5 }] },
        { _id: 3, t: [] },
        { _id: 4, t: [] },
      ]),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: LET,
          pipeline: [byUser, { $replaceWith: { t: "$total" } }, { $limit: 1 }],
          as: "t",
        },
      },
    ]);
  });

  it("reads what follows the body as a value over the joined array", () => {
    // `.length` is `$size` — the slot is KNOWN to be an array, so no runtime guard
    expect(
      compiled("$.n = $$$.orders.filter(o => o.userId === $._id).length;", [
        { _id: 1, n: 2 },
        { _id: 2, n: 1 },
        { _id: 3, n: 0 },
        { _id: 4, n: 0 },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.tmp.0" } },
      { $set: { n: { $size: "$__jsmql.tmp.0" } } },
      { $unset: "__jsmql" },
    ]);
    expect(
      compiled("$.o = $$$.orders.filter(o => o.userId === $._id)[0];", [
        { _id: 1, o: 101 },
        { _id: 2, o: 103 },
        { _id: 3 },
        { _id: 4 },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.tmp.0" } },
      { $set: { o: { $arrayElemAt: ["$__jsmql.tmp.0", 0] } } },
      { $unset: "__jsmql" },
    ]);
    // a field of the ONE document `.find` leaves is a path
    expect(
      compiled("$.t = $$$.orders.find(o => o.userId === $._id).total;", [
        { _id: 1, t: 10 },
        { _id: 2, t: 5 },
        { _id: 3 },
        { _id: 4 },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", let: LET, pipeline: [byUser, { $limit: 1 }], as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.tmp.0": { $first: "$__jsmql.tmp.0" } } },
      { $set: { t: "$__jsmql.tmp.0.total" } },
      { $unset: "__jsmql" },
    ]);
    // inside a stage body the `$lookup` is hoisted ahead of the stage
    expect(compiled("$match($$$.orders.filter(o => o.userId === $._id).length > 1);", [{ _id: 1 }])).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.tmp.0" } },
      { $match: { $expr: { $gt: [{ $size: "$__jsmql.tmp.0" }, 1] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a collapse leaves ONE document, `{}` when nothing matched, as lodash does", () => {
    expect(
      compiled('$.by = $$$.orders.filter(o => o.userId === $._id).countBy("status");', [
        { _id: 1, by: { paid: 1, open: 1 } },
        { _id: 2, by: { paid: 1 } },
        { _id: 3, by: {} },
        { _id: 4, by: {} },
      ]),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: LET,
          pipeline: [
            byUser,
            { $group: { _id: "$status", __jsmqlTmp: { $sum: 1 } } },
            {
              $group: {
                _id: null,
                __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
              },
            },
            { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
          ],
          as: "by",
        },
      },
      { $set: { by: { $ifNull: [{ $first: "$by" }, {}] } } },
    ]);
  });

  it("binds the join to a `let`, in the binding's own slot", () => {
    expect(
      compiled("let os = $$$.orders.filter(o => o.userId === $._id); $.n = os.length;", [
        { _id: 1, n: 2 },
        { _id: 2, n: 1 },
        { _id: 3, n: 0 },
        { _id: 4, n: 0 },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.var.os" } },
      { $set: { n: { $size: "$__jsmql.var.os" } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("compiler/emit/join — inside the body", () => {
  it("the parameter is the body's document: read it, write it; `$.` is the outer document", () => {
    expect(
      compiled("$.o = $$$.orders.aggregate(o => { $match(o.userId === $._id); o.dbl = o.total * 2; delete o.tag; });", [
        {
          _id: 1,
          o: [
            { _id: 101, dbl: 20 },
            { _id: 102, dbl: 40 },
          ],
        },
        { _id: 2, o: [{ _id: 103, dbl: 10 }] },
        { _id: 3, o: [] },
        { _id: 4, o: [] },
      ]),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: LET,
          pipeline: [byUser, { $set: { dbl: { $multiply: ["$total", 2] } } }, { $unset: "tag" }],
          as: "o",
        },
      },
    ]);
    // the outer document cannot be written from inside
    expect(() => pipeline("$.o = $$$.orders.aggregate(o => { $.x = 1; });")).toThrow(/outer document can't be written/);
    // the callback's THIRD parameter is the body's own stream; `$$` is the ROOT stream at every depth (HR4)
    expect(
      compiled("$.o = $$$.orders.aggregate((o, _i, coll) => { coll.filter(d => d.userId === $._id).take(1); });", [
        { _id: 1, o: [101] },
        { _id: 2, o: [103] },
        { _id: 3, o: [] },
        { _id: 4, o: [] },
      ]),
    ).toEqual([{ $lookup: { from: "orders", let: LET, pipeline: [byUser, { $limit: 1 }], as: "o" } }]);
    expect(() => pipeline("$.o = $$$.orders.aggregate(o => { $$.filter(d => d.a > 1); });")).toThrow(
      /'\$\$' is the root stream/,
    );
    // `coll.length` counts the body's stream where it stands; `$$.length` counts the ROOT stream,
    // materialised on the root pipeline and carried in through `let`
    expect(() =>
      pipeline("$.o = $$$.orders.aggregate((o, _i, coll) => { $match(o.userId === $._id); o.n = coll.length; });"),
    ).toThrow(/'coll' is the body's own stream, and this body runs '\$match', which changes what its count means/);
    expect(
      compiled("$.o = $$$.orders.aggregate(o => { $match(o.userId === $._id); o.n = $$.length; });", [
        {
          _id: 1,
          o: [
            { _id: 101, n: 4 },
            { _id: 102, n: 4 },
          ],
        },
        { _id: 2, o: [{ _id: 103, n: 4 }] },
        { _id: 3, o: [] },
        { _id: 4, o: [] },
      ]),
    ).toEqual([
      { $setWindowFields: { output: { "__jsmql.length": { $count: {} } } } },
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id", jsmql_s0_length: "$__jsmql.length" },
          pipeline: [byUser, { $set: { n: "$$jsmql_s0_length" } }],
          as: "o",
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("nests: a root read is captured once, at the outermost join, and read by name below", () => {
    expect(
      compiled(
        "$.o = $$$.orders.aggregate(o => { $match(o.userId === $._id); o.items = $$$.items.filter(i => i.orderId === o._id && i.tag === $.tag); });",
        [
          {
            _id: 1,
            o: [
              { _id: 101, items: ["i1"] },
              { _id: 102, items: [] },
            ],
          },
          { _id: 2, o: [{ _id: 103, items: ["i3"] }] },
          { _id: 3, o: [] },
          { _id: 4, o: [] },
        ],
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0__id: "$_id", jsmql_f0_tag: "$tag" },
          pipeline: [
            byUser,
            {
              $lookup: {
                from: "items",
                let: { jsmql_f1__id: "$_id" },
                pipeline: [
                  {
                    $match: {
                      $expr: { $and: [{ $eq: ["$orderId", "$$jsmql_f1__id"] }, { $eq: ["$tag", "$$jsmql_f0_tag"] }] },
                    },
                  },
                ],
                as: "items",
              },
            },
          ],
          as: "o",
        },
      },
    ]);
    // a nested join inside a PREDICATE is hoisted inside the body, and the body's
    // own cleanup runs, so no scratch leaks into the joined array
    expect(
      compiled(
        "$.o = $$$.orders.filter(o => o.userId === $._id && $$$.items.filter(i => i.orderId === o._id).length > 0);",
        [
          { _id: 1, o: [101] },
          { _id: 2, o: [103] },
          { _id: 3, o: [] },
          { _id: 4, o: [] },
        ],
      ),
    ).toEqual([
      {
        $lookup: {
          from: "orders",
          let: LET,
          pipeline: [
            { $lookup: { from: "items", localField: "_id", foreignField: "orderId", as: "__jsmql.tmp.0" } },
            {
              $match: {
                $expr: { $and: [{ $eq: ["$userId", "$$jsmql_f0__id"] }, { $gt: [{ $size: "$__jsmql.tmp.0" }, 0] }] },
              },
            },
            { $unset: "__jsmql" },
          ],
          as: "o",
        },
      },
    ]);
  });
});

describe("compiler/emit/join — the stream and the root", () => {
  it("switches the stream to the other collection", () => {
    // correlated: one `$lookup` per document, unwound into the stream
    expect(
      compiled("$$ = $$$.orders.filter(o => o.userId === $._id);", [{ _id: 101 }, { _id: 102 }, { _id: 103 }]),
    ).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    // uncorrelated: the current stream is dropped and the other collection's pipeline unioned in
    expect(compiled('$$ = $$$.orders.filter(o => o.status === "paid");', [{ _id: 101 }, { _id: 103 }])).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $match: { status: "paid" } }] } },
    ]);
    expect(compiled("$$ = $$$.orders;", [{ _id: 101 }, { _id: 102 }, { _id: 103 }, { _id: 104 }])).toEqual([
      { $match: { $expr: false } },
      { $unionWith: "orders" },
    ]);
  });

  it("`$ = $$$.c.find(p)` — each document becomes the one it found; one that found nothing leaves", () => {
    // `$replaceWith: { $first: … }` fails on the server for every unmatched document (measured)
    expect(compiled("$ = $$$.orders.find(o => o.userId === $._id);", [{ _id: 101 }, { _id: 103 }])).toEqual([
      { $lookup: { from: "orders", let: LET, pipeline: [byUser, { $limit: 1 }], as: "__jsmql.tmp.0" } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    expect(() => pipeline("$ = $$$.orders.filter(o => o.userId === $._id);")).toThrow(/ONE document/);
  });
});

describe("compiler/emit/join — the refusals name the way out", () => {
  it("a read with no destination, a value in the stream, a value outside a pipeline", () => {
    expect(() => pipeline("$$$.orders.filter(o => o.a > 1);")).toThrow(/gives it no destination/);
    expect(() => pipeline("$$ = $$$.orders.filter(o => o.a > 1).length;")).toThrow(/makes a value/);
    expect(() => expr("$$$.orders.filter(o => o.a > 1).length")).toThrow(
      /'\$\$\$\.<coll>' \(a read of another collection\) needs Pipeline mode — it materialises a '\$lookup' stage/,
    );
  });
  it("a wrong count and a wrong receiver are spelled as the source would write them", () => {
    expect(() => pipeline("$.x = $$$.orders.find()")).toThrow(
      /'\.find\(predicate\)' requires exactly 1 argument, got 0/,
    );
    expect(() => pipeline("$.x = $$$.orders.find(o => o.a === 1).length")).toThrow(
      /'\.length' is not available on a 'object' — it is defined on 'array', 'string', 'stream'/,
    );
  });
  it("the collection is named when the pipeline is written, in the current database", () => {
    expect(() => pipeline("$.o = $$$[$.name].find(o => o.a > 1);")).toThrow(/named when the pipeline is written/);
    expect(() => pipeline('$.o = $$$[""].find(o => o.a > 1);')).toThrow(/names no collection/);
    expect(() => pipeline("$.o = $$$$.db.orders.find(o => o.a > 1);")).toThrow(/another DATABASE/);
    // a name that is not an identifier is spelled with brackets
    expect(compiled('$.o = $$$["order-log"].filter(o => o.userId === $._id);')).toEqual([
      { $lookup: { from: "order-log", ...COMPACT, as: "o" } },
    ]);
  });
  it("a body over a stage with no `let` cannot read the outer document", () => {
    expect(() => pipeline('$unionWith({ coll: "orders", pipeline: [$match($.a > 1)] });')).toThrow(/has no 'let'/);
  });
  it("reads a value `.map` over the joined array with the value road's cell", () => {
    expect(
      compiled("$.t = $$$.orders.filter(o => o.userId === $._id).map(o => o.total);", [
        { _id: 1, t: [10, 20] },
        { _id: 2, t: [5] },
        { _id: 3, t: [] },
        { _id: 4, t: [] },
      ]),
    ).toEqual([
      { $lookup: { from: "orders", ...COMPACT, as: "__jsmql.tmp.0" } },
      { $set: { t: { $map: { input: "$__jsmql.tmp.0", as: "o", in: "$$o.total" } } } },
      { $unset: "__jsmql" },
    ]);
  });
});

// ── the server ───────────────────────────────────────────────────────────────

let client: MongoClient | null = null;
let db: Db | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  try {
    const c = new MongoClient(URI, { serverSelectionTimeoutMS: 800 });
    await c.connect();
    await c.db("admin").command({ ping: 1 });
    client = c;
    db = c.db("jsmql_compiler_join");
    await db.dropDatabase();
    await db.collection("users").insertMany(USERS.map((d) => ({ ...d })));
    await db.collection("orders").insertMany(ORDERS.map((d) => ({ ...d })));
    await db.collection("items").insertMany(ITEMS.map((d) => ({ ...d })));
    await db.collection("order-log").insertMany([{ _id: 9, userId: 1 }]);
    coll = db.collection("users");
  } catch {
    client = null;
    db = null;
    coll = null;
  }
});

afterAll(async () => {
  await client?.close();
});

/**
 * A result document with its joined values reduced to ids, so expectations stay
 * readable: a top-level document keeps its `_id` and the fields the pipeline
 * added; a joined document is its id alone unless the body added fields to it.
 */
const FIXTURE_KEYS = new Set(["userId", "total", "status", "tag", "nul", "orderId", "q", "ids", "minTotal"]);
const idsOf = (v: unknown, top: boolean): unknown => {
  if (Array.isArray(v)) return v.map((x) => idsOf(x, false));
  if (v !== null && typeof v === "object" && "_id" in v) {
    const d = v as Record<string, unknown>;
    const added = Object.entries(d).filter(([k]) => k !== "_id" && !FIXTURE_KEYS.has(k));
    if (!top && added.length === 0) return d._id;
    return { _id: d._id, ...Object.fromEntries(added.map(([k, x]) => [k, idsOf(x, false)])) };
  }
  return v;
};

/** JSON with every object's keys sorted, so two documents that differ only in key order compare equal. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

describe("compiler/emit/join — the server runs every pipeline this file asserts, and answers as JavaScript would", () => {
  it("ran each one, or none", async () => {
    if (coll === null) {
      expect(RUNS.length).toBeGreaterThan(0);
      return;
    }
    const problems: string[] = [];
    for (const { src, expected } of RUNS) {
      let docs: Record<string, unknown>[];
      try {
        docs = await coll.aggregate(pipeline(src) as Record<string, unknown>[]).toArray();
      } catch (e) {
        problems.push(`${src}\n  ${JSON.stringify(pipeline(src))}\n  ${(e as Error).message}`);
        continue;
      }
      if (expected === undefined) continue;
      // a `$group` answers its keys in no promised order, so documents compare with keys sorted
      const got = canonical(docs.map((d) => idsOf(d, true)));
      const want = canonical(expected);
      if (got !== want) problems.push(`${src}\n  got  ${got}\n  want ${want}`);
    }
    expect(problems, `${problems.length} of ${RUNS.length}:\n${problems.join("\n")}`).toEqual([]);
  });
});

describe("compiler/emit/join — hoists of a lowering that is taken back", () => {
  it("stamps the root count once when the chain goes on after the join", () => {
    const out = pipeline(
      "$.o = $$$.orders.filter(o => o.i < $$.length).map((o, i, coll) => o.i + coll.length)",
    ) as Record<string, unknown>[];
    expect(out.filter((s) => "$setWindowFields" in s)).toHaveLength(1);
    expect(out[1]).toMatchObject({ $lookup: { let: { jsmql_s0_length: "$__jsmql.length" } } });
  });
});
