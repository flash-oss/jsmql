import { describe, it, expect } from "vitest";
import { jsmql } from "../src/index.ts";

// A stage that you spell — `$limit(…)`, a raw `{ $unwind: … }` document, a `$$.$sort(…)`
// link — is your own MQL. HR3 does not apply to it (docs/LANG_RULES.md): the compiler
// checks no stage body, and the server judges the document. The compiler still checks
// where each stage stands, and the query operators that an aggregation `$match` refuses.
//
// Most expected documents in the first block are DELIBERATELY invalid. Each one is the
// developer's MQL, passed through as written, and the server refuses it (the note
// beside it gives the reason). They pin the pass-through; the suite does not endorse them
// as valid shapes (test/CLAUDE.md § Never assert MQL that the MongoDB server rejects).

describe("a stage body is your own MQL, and it passes through as written", () => {
  const sortKeys = (n: number): string => Array.from({ length: n }, (_, i) => `k${i}: 1`).join(", ");
  const PASSES: readonly [string, unknown][] = [
    // mongod: the server refuses a limit that is not positive.
    ["[ $limit(0) ]", [{ $limit: 0 }]],
    ["[ $limit(-5) ]", [{ $limit: -5 }]],
    ["[ $limit(2.5) ]", [{ $limit: 2.5 }]],
    ["[ $limit('x') ]", [{ $limit: "x" }]],
    ["[ $skip(-1) ]", [{ $skip: -1 }]],
    // mongod: the server refuses a field path, because `$limit` takes a number.
    ["[ $limit($.pageSize) ]", [{ $limit: "$pageSize" }]],
    ["[ $skip($.n) ]", [{ $skip: "$n" }]],
    // mongod: the server refuses a `$`-prefixed count field. It refuses the other two names too.
    ["[ $count('') ]", [{ $count: "" }]],
    ["[ $count('$x') ]", [{ $count: "$x" }]],
    ["[ $count('a.b') ]", [{ $count: "a.b" }]],
    // mongod: the server refuses a `$group` body that is not an object.
    ['[ $group("externalId") ]', [{ $group: "externalId" }]],
    ["[ $group(5) ]", [{ $group: 5 }]],
    ["[ $group([1, 2]) ]", [{ $group: [1, 2] }]],
    ["[ $addFields(5) ]", [{ $addFields: 5 }]],
    ['[ $set("x") ]', [{ $set: "x" }]],
    ['[ $project("name") ]', [{ $project: "name" }]],
    ["[ $sort(1) ]", [{ $sort: 1 }]],
    ["[ $sample(5) ]", [{ $sample: 5 }]],
    ["[ $unset(5) ]", [{ $unset: 5 }]],
    // mongod: the server refuses a sort direction other than 1 or -1.
    ["[ $sort({ a: 2 }) ]", [{ $sort: { a: 2 } }]],
    ['[ $sort({ createdAt: "desc" }) ]', [{ $sort: { createdAt: "desc" } }]],
    ["[ $sort({ a: true }) ]", [{ $sort: { a: true } }]],
    // mongod: the server refuses an exclusion inside an inclusion projection.
    ["[ $project({ a: 1, b: 0 }) ]", [{ $project: { a: 1, b: 0 } }]],
    ["[ $project({}) ]", [{ $project: {} }]],
    ["[ $unset('') ]", [{ $unset: "" }]],
    // mongod: the server refuses an `$unwind` path with no `$` prefix.
    ["[ $unwind('items') ]", [{ $unwind: "items" }]],
    ["[ $sample({}) ]", [{ $sample: {} }]],
    ["[ $sample({ size: -1 }) ]", [{ $sample: { size: -1 } }]],
    ["[ $bucket({ groupBy: $.x }) ]", [{ $bucket: { groupBy: "$x" } }]],
    ["[ $bucket({ groupBy: $.x, boundaries: [1] }) ]", [{ $bucket: { groupBy: "$x", boundaries: [1] } }]],
    ["[ $bucket({ groupBy: $.x, boundaries: [3, 1, 2] }) ]", [{ $bucket: { groupBy: "$x", boundaries: [3, 1, 2] } }]],
    ["[ $bucket({ groupBy: $.x, boundaries: $.bounds }) ]", [{ $bucket: { groupBy: "$x", boundaries: "$bounds" } }]],
    ["[ $bucketAuto({ groupBy: $.x, buckets: 0 }) ]", [{ $bucketAuto: { groupBy: "$x", buckets: 0 } }]],
    [
      "[ $bucketAuto({ groupBy: $.x, buckets: 5, granularity: 'R7' }) ]",
      [{ $bucketAuto: { groupBy: "$x", buckets: 5, granularity: "R7" } }],
    ],
    [
      "[ $setWindowFields({ output: { n: { $sum: 1, window: { documents: [0, 1], range: [-1, 1] } } } }) ]",
      [{ $setWindowFields: { output: { n: { $sum: 1, window: { documents: [0, 1], range: [-1, 1] } } } } }],
    ],
    [
      "[ $fill({ output: { x: { value: 0, method: 'linear' } } }) ]",
      [{ $fill: { output: { x: { value: 0, method: "linear" } } } }],
    ],
    [
      "[ $fill({ sortBy: { t: 1 }, output: { x: { method: 'linaer' } } }) ]",
      [{ $fill: { sortBy: { t: 1 }, output: { x: { method: "linaer" } } } }],
    ],
    // mongod: the server refuses a `$group` with no `_id`.
    ["[ $group({ total: $sum($.x) }) ]", [{ $group: { total: { $sum: "$x" } } }]],
    [
      "[ $lookup({ from: 'c', localField: 'a', foreignField: 'b' }) ]",
      [{ $lookup: { from: "c", localField: "a", foreignField: "b" } }],
    ],
    ["[ $geoNear({ distanceField: 'd' }) ]", [{ $geoNear: { distanceField: "d" } }]],
    ["[ $merge({ into: 'c', whenMatched: 'replce' }) ]", [{ $merge: { into: "c", whenMatched: "replce" } }]],
    ["[ $unionWith({}) ]", [{ $unionWith: {} }]],
    ["[ $replaceWith(5) ]", [{ $replaceWith: 5 }]],
    ["[ { $documents: 5 } ]", [{ $documents: 5 }]],
    // mongod: the server refuses a sort with this many keys.
    [
      `[ $sort({ ${sortKeys(33)} }) ]`,
      [{ $sort: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 1])) }],
    ],
  ];
  for (const [src, mql] of PASSES) {
    it(`passes ${src.length > 60 ? src.slice(0, 57) + "…" : src} through`, () => {
      expect(jsmql(src)).toEqual(mql);
    });
  }

  it("keeps the valid bodies the same", () => {
    expect(jsmql("[ $limit(5) ]")).toEqual([{ $limit: 5 }]);
    expect(jsmql("[ $skip(0) ]")).toEqual([{ $skip: 0 }]);
    expect(jsmql("[ $count('total') ]")).toEqual([{ $count: "total" }]);
    expect(jsmql("[ $sort({ a: 1, b: -1 }) ]")).toEqual([{ $sort: { a: 1, b: -1 } }]);
    expect(jsmql("[ $project({ _id: 0, name: 1 }) ]")).toEqual([{ $project: { _id: 0, name: 1 } }]);
    expect(jsmql("[ $unwind($.items) ]")).toEqual([{ $unwind: "$items" }]);
    expect(jsmql("[ $bucket({ groupBy: $.x, boundaries: [0, 10, 20] }) ]")).toEqual([
      { $bucket: { groupBy: "$x", boundaries: [0, 10, 20] } },
    ]);
    expect(jsmql("[ $fill({ output: { x: { method: 'locf' } } }) ]")).toEqual([
      { $fill: { output: { x: { method: "locf" } } } },
    ]);
    expect(jsmql("[ $replaceWith($.user) ]")).toEqual([{ $replaceWith: "$user" }]);
  });

  it("refuses a JavaScript spread or computed key in a body of named keys, which has no lowering there", () => {
    // The spread is JavaScript code. It lowers to `$mergeObjects`, which no stage takes as
    // its body, and that MQL is the compiler's own (HR3).
    expect(() => jsmql("$set({ ...$.o });")).toThrow(
      "MQL has no spread in an object. Write Object.assign(a, b) instead.",
    );
    expect(() => jsmql("[{ $set: { ...$.o } }]")).toThrow("MQL has no spread in an object.");
  });
});

describe("$match query-operator placement", () => {
  it("accepts $text in a first-stage $match", () => {
    expect(jsmql("[ $match({ $text: { $search: 'a' } }), $sort({ x: 1 }) ]")).toEqual([
      { $match: { $text: { $search: "a" } } },
      { $sort: { x: 1 } },
    ]);
  });
  it("rejects $near / $nearSphere / $where in an aggregation $match", () => {
    expect(() => jsmql("[ $match({ loc: { $near: [0, 0] } }) ]")).toThrow(
      /'\$near' is not allowed inside an aggregation '\$match'.*\$geoNear/,
    );
    expect(() => jsmql("[ $sort({ x: 1 }), $match({ loc: { $nearSphere: [0, 0] } }) ]")).toThrow(
      /'\$nearSphere' is not allowed.*\$geoNear/,
    );
    // MEASURED: `find({ $where: … })` runs where server-side JavaScript is enabled,
    // and an aggregation `$match` refuses it at any depth of the body. So the RAW
    // filter passes through (HR1) and the same document inside a `$match` does not.
    expect(jsmql("{ $where: 'this.x > 1' }")).toEqual({ $where: "this.x > 1" });
    expect(() => jsmql("[ $match({ $where: 'this.x > 1' }) ]")).toThrow(/'\$where' cannot stand inside '\$match'/);
    expect(() => jsmql("[ $match({ $and: [{ $where: 'this.x > 1' }] }) ]")).toThrow(
      /'\$where' cannot stand inside '\$match'/,
    );
  });
  it("leaves an ordinary $match (object or expression body) alone", () => {
    expect(jsmql("[ $sort({ x: 1 }), $match({ x: { $gt: 1 } }) ]")).toEqual([
      { $sort: { x: 1 } },
      { $match: { x: { $gt: 1 } } },
    ]);
    expect(jsmql("[ $sort({ x: 1 }), $match($.x > 1) ]")).toEqual([{ $sort: { x: 1 } }, { $match: { x: { $gt: 1 } } }]);
  });
});

// A stage name in a value slot is your MQL too: it passes through, and the server
// refuses it as an unknown expression operator. Each output below is DELIBERATELY invalid.
describe("a pipeline stage name used where a value is expected", () => {
  const PASSES: [string, string, unknown][] = [
    ["an assignment RHS", "$.x = $limit(5);", [{ $set: { x: { $limit: 5 } } }]],
    ["a `$ = { … }` value", "$ = { a: $sort({ b: 1 }) };", [{ $replaceWith: { a: { $sort: { b: 1 } } } }]],
    ["an arithmetic operand", '$.y = $out("c") + 1;', [{ $set: { y: { $add: [{ $out: "c" }, 1] } } }]],
    ["a `$match` body", "$match($limit(3));", [{ $match: { $limit: 3 } }]],
    [
      "a callback body",
      "$.x = $.items.map(v => $unwind(v));",
      [{ $set: { x: { $map: { input: { $ifNull: ["$items", []] }, as: "v", in: { $unwind: "$$v" } } } } }],
    ],
  ];
  for (const [label, src, mql] of PASSES) {
    it(`passes through in ${label}`, () => {
      expect(jsmql(src)).toEqual(mql);
    });
  }

  it("is rejected in `jsmql.expr`, which yields an expression and never a stage", () => {
    // The bare `jsmql(...)` entry auto-wraps a lone stage call into a pipeline, so the
    // same source is a legitimate statement there — only the expression entry rejects.
    expect(() => jsmql.expr("$match($.a === 0)")).toThrow(
      "jsmql.expr() expects an aggregation expression (the value of a stage field, `jsmql.expr`). It received a top-level '$match' stage call instead. Use jsmql.pipeline() — for a Filter, drop the `$match(...)` wrapper and pass its predicate.",
    );
    expect(jsmql("$match($.a === 0)")).toEqual([{ $match: { a: 0 } }]);
  });

  it("leaves `$count`, an unknown operator, and raw MQL alone", () => {
    // `$count` is a stage AND an accumulator, so it is valid in a value slot.
    expect(jsmql("$group({ _id: null, n: $count() });")).toEqual([{ $group: { _id: null, n: { $count: {} } } }]);
    // HR2 forward-compat: an unknown name is in neither registry.
    expect(jsmql("$.x = $someFutureOp($.a, 2);")).toEqual([{ $set: { x: { $someFutureOp: ["$a", 2] } } }]);
    // Raw MQL the developer wrote verbatim stays unguarded — it is their document.
    expect(jsmql("$.x = { $limit: 5 };")).toEqual([{ $set: { x: { $limit: 5 } } }]);
  });

  it("leaves every legitimate stage position alone", () => {
    expect(jsmql("$limit(5);")).toEqual([{ $limit: 5 }]);
    expect(jsmql("$$ = $$.$limit(5);")).toEqual([{ $limit: 5 }]);
    expect(jsmql("$.r = $$$.o.aggregate(o => { $limit(5); });")).toEqual([
      { $lookup: { from: "o", pipeline: [{ $limit: 5 }], as: "r" } },
    ]);
  });
});
