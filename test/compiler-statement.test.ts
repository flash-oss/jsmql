import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
import { pipeline } from "../src/compiler/index.ts";
import { liveClient, liveUp } from "./fixtures/live.ts";
import { everyStageName, statementBodyOf } from "../src/compiler/rows.ts";
import { jsmql } from "../src/index.ts";

const NEEDS_MORE_THAN_A_SERVER: Readonly<Record<string, string>> = {
  '$sort({ s: $meta("textScore") });': "a text score exists only under a $text query against a text index",
};

const REFUSED_BY_ENVIRONMENT: Readonly<Record<string, RegExp>> = {
  "$documents([{ a: 1 }]); $.b = 2;": /database or cluster-level aggregation/,
  '$geoNear({ near: [0, 0], distanceField: "d", query: $.k === "a" });': /2d or 2dsphere index/,
};

const up = await liveUp();

const RUNS: string[] = [];
const compiled = (src: string): unknown[] => {
  RUNS.push(src);
  return pipeline(src);
};

describe("compiler/emit/statement — the writes", () => {
  it("makes one $set per `,`-joined run, and one stage per `;`", () => {
    expect(compiled("$.a = 1;")).toEqual([{ $set: { a: 1 } }]);
    expect(compiled("$.a = 1, $.b = 2;")).toEqual([{ $set: { a: 1, b: 2 } }]);
    expect(compiled("$.a = 1; $.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { b: 2 } }]);
    expect(compiled("$.total = $.qty * $.price;")).toEqual([{ $set: { total: { $multiply: ["$qty", "$price"] } } }]);
    expect(compiled("$.a += 1;")).toEqual([{ $set: { a: { $add: ["$a", 1] } } }]);
    expect(compiled("$.a.b = 1, $.a.c = 2;")).toEqual([{ $set: { "a.b": 1, "a.c": 2 } }]);
  });

  it("assigns a document WHOLE, as JavaScript does", () => {
    expect(compiled("$.n = { x: 1 };")).toEqual([{ $set: { n: { $mergeObjects: [{ x: 1 }] } } }]);
    expect(compiled("$.n = { x: $.a };")).toEqual([{ $set: { n: { $mergeObjects: [{ x: "$a" }] } } }]);
    expect(compiled("$.n = {};")).toEqual([{ $set: { n: { $mergeObjects: [{}] } } }]);
    expect(compiled("$.n = { ...$, x: 1 };")).toEqual([{ $set: { n: { $mergeObjects: ["$$ROOT", { x: 1 }] } } }]);
    expect(compiled("$.n = [1, 2];")).toEqual([{ $set: { n: [1, 2] } }]);
    expect(compiled("$.n = $.other;")).toEqual([{ $set: { n: "$other" } }]);
    expect(compiled("$set({ n: { x: 1 } });")).toEqual([{ $set: { n: { x: 1 } } }]);
  });

  it("ends a group where one $set would say something else", () => {
    expect(compiled("$.x = 1, $.z = $.x;")).toEqual([{ $set: { x: 1 } }, { $set: { z: "$x" } }]);
    expect(compiled("$.a = $.q, $.b = $.a.c;")).toEqual([{ $set: { a: "$q" } }, { $set: { b: "$a.c" } }]);
    expect(compiled("$.a = $.b, $.b = 1;")).toEqual([{ $set: { a: "$b", b: 1 } }]);
    expect(compiled('$.a = 1, $.b = $toString("$a");')).toEqual([
      { $set: { a: 1 } },
      { $set: { b: { $toString: "$a" } } },
    ]);
    expect(compiled('$.a = 1, $.b = "$a";')).toEqual([{ $set: { a: 1, b: { $literal: "$a" } } }]);
    expect(compiled("$.a = 1, $.a = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { a: 2 } }]);
    expect(compiled("$.a = 1, $.a.b = 2;")).toEqual([{ $set: { a: 1 } }, { $set: { "a.b": 2 } }]);
    expect(compiled("$.a.b = 1, $.a = 2;")).toEqual([{ $set: { "a.b": 1 } }, { $set: { a: 2 } }]);
  });

  it("unsets a deletion, and the root replacement stands alone", () => {
    expect(compiled("delete $.a;")).toEqual([{ $unset: "a" }]);
    expect(compiled("delete $.a, delete $.b;")).toEqual([{ $unset: ["a", "b"] }]);
    expect(compiled("$.a = 1, delete $.b;")).toEqual([{ $set: { a: 1 } }, { $unset: "b" }]);
    expect(compiled("delete $.a, $.b = 1;")).toEqual([{ $unset: "a" }, { $set: { b: 1 } }]);
    expect(compiled("$ = { x: $.a };")).toEqual([{ $replaceWith: { x: "$a" } }]);
    expect(compiled("$ = $.sub;")).toEqual([{ $replaceWith: "$sub" }]);
    expect(() => pipeline("$ = 5;")).toThrow(/takes a document, but got a number\./);
    expect(() => pipeline('$ = "x";')).toThrow(/but got a string\./);
    for (const src of ["$ = [{ a: 1 }, { a: 2 }];", "$ = [1, 2];", "$ = [];", "$ = $.items.map(x => ({ v: x }));"]) {
      expect(() => pipeline(src)).toThrow(/takes a document, but got an array\./);
    }
    expect(() => pipeline("$ = null;")).toThrow(/takes a document, but got null\./);
    expect(() => pipeline("$ = $abs($.a);")).toThrow(/takes a document, but got a number\./);
  });

  it("`$ = $.method(…)` is the stage that root-replacing object methods emit", () => {
    expect(compiled('$ = $.pick(["a", "b"]);')).toEqual([{ $project: { a: 1, b: 1, _id: 0 } }]);
    expect(compiled('$ = $.omit(["a"]);')).toEqual([{ $project: { a: 0 } }]);
    expect(compiled("$ = $.pick([]);")).toEqual([{ $replaceWith: {} }]);
    expect(compiled('$ = $.pick(["a", "b"]).omit(["b"]);')).toEqual([
      { $project: { a: 1, b: 1, _id: 0 } },
      { $project: { b: 0 } },
    ]);
    expect(compiled('$.n = 1; $ = $.pick(["n"]); $.m = 2;')).toEqual([
      { $set: { n: 1 } },
      { $project: { n: 1, _id: 0 } },
      { $set: { m: 2 } },
    ]);
    expect(compiled('$$.flatMap("items"); $ = $.omit(["a"]); $$.pick(["qty"]);')).toEqual([
      { $unwind: "$items" },
      { $project: { a: 0 } },
      { $project: { "items.qty": 1, _id: 0 } },
    ]);
    expect(compiled('$$.flatMap("items"); $ = $.pick(["a"]); $$.pick(["qty"]);')).toEqual([
      { $unwind: "$items" },
      { $project: { a: 1, _id: 0 } },
      { $project: { qty: 1, _id: 0 } },
    ]);
    expect(compiled('$ = $.pick(["a"]).mapValues(v => v);')).toMatchObject([
      {
        $replaceWith: {
          $arrayToObject: { $map: { input: { $objectToArray: { $let: { vars: { jsmqlObj: "$$ROOT" } } } } } },
        },
      },
    ]);
    expect(compiled('$ = $?.pick(["a"]);')).toEqual([
      {
        $replaceWith: {
          $let: { vars: { jsmqlObj: "$$ROOT" }, in: { a: { $getField: { field: "a", input: "$$jsmqlObj" } } } },
        },
      },
    ]);
    expect(compiled("$ = $.pick($.keys);")).toEqual([
      {
        $replaceWith: {
          $arrayToObject: {
            $filter: {
              input: { $objectToArray: "$$ROOT" },
              as: "jsmqlKv",
              cond: { $in: ["$$jsmqlKv.k", { $ifNull: ["$keys", []] }] },
            },
          },
        },
      },
    ]);
    expect(compiled('$ = $.omit($.hidden).pick(["a"]);')).toMatchObject([{ $replaceWith: {} }]);
    expect(() => pipeline('let x = $.a * 2; $ = $.pick(["a"]); $.y = x;')).toThrow(/after `\$project`/);
    expect(compiled('let x = $.a * 2; $ = $.omit(["b"]); $.y = x;')).toEqual([
      { $set: { "__jsmql.var.x": { $multiply: ["$a", 2] } } },
      { $project: { b: 0 } },
      { $set: { y: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("keeps `$` the ROOT document inside a body over another collection", () => {
    expect(compiled('$.x = $$$.orders.aggregate(o => { o = $.pick(["a"]); });')).toEqual([
      {
        $lookup: {
          from: "orders",
          let: { jsmql_f0_root: "$$ROOT" },
          pipeline: [
            {
              $replaceWith: {
                $let: {
                  vars: { jsmqlObj: "$$jsmql_f0_root" },
                  in: { a: { $getField: { field: "a", input: "$$jsmqlObj" } } },
                },
              },
            },
          ],
          as: "x",
        },
      },
    ]);
    expect(compiled('$.x = $$$.orders.aggregate(o => { o = $.omit(["a"]); });')).toEqual(
      pipeline('$.x = $$$.orders.aggregate(o => { o = $?.omit(["a"]); });'),
    );
    expect(compiled('$$.aggregate(o => { o = $.pick(["a"]); });')).toEqual([{ $project: { a: 1, _id: 0 } }]);
  });

  it("`o = o.pick(…)` on a body's own parameter is the stage that `$ = $.pick(…)` emits", () => {
    expect(compiled('$$.aggregate(o => { o = o.pick(["a"]); });')).toEqual(pipeline('$ = $.pick(["a"]);'));
    expect(compiled('$$.aggregate(o => { $ = o.omit(["a"]); });')).toEqual(pipeline('$ = $.omit(["a"]);'));
    expect(compiled('$ = { k: $$.aggregate(o => { o = o.pick(["a"]); }) };')).toEqual([
      { $facet: { k: [{ $project: { a: 1, _id: 0 } }] } },
    ]);
    expect(compiled('$.x = $$$.orders.aggregate(o => { o = o.pick(["a"]); });')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $project: { a: 1, _id: 0 } }], as: "x" } },
    ]);
    expect(compiled('$.x = $$$.orders.aggregate((o, _i, orders) => { o = o.pick(["a", "b"]).omit(["b"]); });')).toEqual(
      [
        {
          $lookup: {
            from: "orders",
            pipeline: [{ $project: { a: 1, b: 1, _id: 0 } }, { $project: { b: 0 } }],
            as: "x",
          },
        },
      ],
    );
    expect(
      compiled(`$.team = $$$.users.aggregate(u => {
        $match(u.teamId === $._id);
        u = u.pick(["_id", "name"]);
        u.orders = $$$.orders.aggregate(o => { $match(o.userId === u._id); o = o.omit(["audit"]); });
      });`),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "teamId",
          pipeline: [
            { $project: { _id: 1, name: 1 } },
            {
              $lookup: {
                from: "orders",
                localField: "_id",
                foreignField: "userId",
                pipeline: [{ $project: { audit: 0 } }],
                as: "orders",
              },
            },
          ],
          as: "team",
        },
      },
    ]);
    expect(
      compiled(
        '$.team = $$$.users.aggregate(u => { u.orders = $$$.orders.aggregate(o => { o = u.pick(["name"]); }); });',
      ),
    ).toEqual([
      {
        $lookup: {
          from: "users",
          pipeline: [
            {
              $lookup: {
                from: "orders",
                let: { jsmql_f1_u: "$$ROOT" },
                pipeline: [
                  {
                    $replaceWith: {
                      $let: {
                        vars: { jsmqlObj: "$$jsmql_f1_u" },
                        in: { name: { $getField: { field: "name", input: "$$jsmqlObj" } } },
                      },
                    },
                  },
                ],
                as: "orders",
              },
            },
          ],
          as: "team",
        },
      },
    ]);
    for (const reshape of [
      'o?.pick(["a"])',
      "o.pick(o.keys)",
      'o.pick(["a"]).mapValues(v => v)',
      'o.sub.pick(["a"])',
    ]) {
      expect(compiled(`$.x = $$$.orders.aggregate(o => { o = ${reshape}; });`), reshape).toMatchObject([
        { $lookup: { pipeline: [{ $replaceWith: {} }] } },
      ]);
    }
    expect(compiled('$$.flatMap("items").aggregate(o => { o = o.pick(["a"]); });')).toEqual([
      { $unwind: "$items" },
      {
        $set: {
          items: {
            $let: { vars: { jsmqlObj: "$items" }, in: { a: { $getField: { field: "a", input: "$$jsmqlObj" } } } },
          },
        },
      },
    ]);
  });

  it("places a stage that computes a needed value ahead of the stage that uses it", () => {
    expect(compiled("$.n = $$.size();")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("$.k = $.tag, $.n = $$.size() + $.k;")).toEqual([
      { $set: { k: "$tag" } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: { $add: ["$__jsmql.size", "$k"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("$$.$match({ ok: true }).map(d => ({ _id: d._id, n: $$.size() }));")).toEqual([
      { $match: { ok: true } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $replaceWith: { _id: "$_id", n: "$__jsmql.size" } },
    ]);
  });
});

describe("compiler/emit/statement — the stage calls", () => {
  it("renders a stage from its own row, in the position the row states for its body", () => {
    expect(compiled("$match($.a > 1);")).toEqual([{ $match: { a: { $gt: 1 } } }]);
    expect(compiled("$sort({ a: -1 });")).toEqual([{ $sort: { a: -1 } }]);
    expect(compiled("$limit(2);")).toEqual([{ $limit: 2 }]);
    expect(compiled('$count("n");')).toEqual([{ $count: "n" }]);
    expect(compiled("$project({ a: 1, _id: 0 });")).toEqual([{ $project: { a: 1, _id: 0 } }]);
    expect(compiled("$group({ _id: null, total: $sum($.qty) });")).toEqual([
      { $group: { _id: null, total: { $sum: "$qty" } } },
    ]);
    expect(compiled("$match($.a > 1); $sort({ a: -1 }); $limit(1);")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $sort: { a: -1 } },
      { $limit: 1 },
    ]);
  });

  it("reads each body key in the position its row states", () => {
    expect(compiled('$geoNear({ near: [0, 0], distanceField: "d", query: $.k === "a" });')).toEqual([
      { $geoNear: { near: [0, 0], distanceField: "d", query: { k: "a" } } },
    ]);
  });

  it("places a stage where its row says it may stand", () => {
    expect(compiled('$.b = 2; $out("o");')).toEqual([{ $set: { b: 2 } }, { $out: "o" }]);
    expect(compiled('$.n = $$.size(); $out("o");')).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
      { $out: "o" },
    ]);
    expect(compiled("$documents([{ a: 1 }]); $.b = 2;")).toEqual([{ $documents: [{ a: 1 }] }, { $set: { b: 2 } }]);
    expect(() => pipeline('$out("o"); $.b = 2;')).toThrow(/Nothing can follow '\$out'/);
    expect(() => pipeline("$.b = 2; $documents([{ a: 1 }]);")).toThrow(/has to be the FIRST stage/);
    expect(() => pipeline('$out("a"); $merge("b");')).toThrow(/Nothing can follow '\$out'/);
    expect(() => pipeline('$lookup({ from: "o", pipeline: [$out("x")], as: "r" });')).toThrow(
      /cannot stand inside '\$lookup'/,
    );
  });

  it("passes a raw stage document through, and reads a bracketed program as the pipeline", () => {
    expect(compiled("{ $match: { a: 2 } };")).toEqual([{ $match: { a: 2 } }]);
    expect(compiled("[$match($.a > 1), $set({ b: 1 })]")).toEqual([{ $match: { a: { $gt: 1 } } }, { $set: { b: 1 } }]);
  });
});

describe("compiler/emit/statement — a stage body that you write passes through", () => {
  it("takes every key combination as written", () => {
    expect(compiled('$lookup({ from: "o", localField: "a", foreignField: "b", as: "j" });')).toEqual([
      { $lookup: { from: "o", localField: "a", foreignField: "b", as: "j" } },
    ]);
    expect(compiled('$lookup({ from: "o", pipeline: [$limit(1)], as: "j" });')).toEqual([
      { $lookup: { from: "o", pipeline: [{ $limit: 1 }], as: "j" } },
    ]);
    expect(pipeline('$lookup({ from: "o", localField: "a", as: "j" });')).toEqual([
      { $lookup: { from: "o", localField: "a", as: "j" } },
    ]);
    expect(pipeline('$lookup({ from: "o", as: "j" });')).toEqual([{ $lookup: { from: "o", as: "j" } }]);
    expect(pipeline('$lookup({ from: "o", localField: "a", foreignField: "b" });')).toEqual([
      { $lookup: { from: "o", localField: "a", foreignField: "b" } },
    ]);
  });

  it("takes each body form as written", () => {
    expect(compiled('$unionWith("o");')).toEqual([{ $unionWith: "o" }]);
    expect(compiled('$unionWith({ coll: "o", pipeline: [$limit(1)] });')).toEqual([
      { $unionWith: { coll: "o", pipeline: [{ $limit: 1 }] } },
    ]);
    expect(pipeline("$unionWith(5);")).toEqual([{ $unionWith: 5 }]);
    expect(compiled("$unionWith($.c);")).toEqual([{ $unionWith: "$c" }]);
  });

  it("takes a field path as a body, and the server judges it", () => {
    expect(compiled("$unwind($.p);")).toEqual([{ $unwind: "$p" }]);
    const PASSES: readonly [string, unknown][] = [
      ["$sort($.spec);", [{ $sort: "$spec" }]],
      ["$group($.g);", [{ $group: "$g" }]],
      ["$project($.p);", [{ $project: "$p" }]],
      ["$set($.s);", [{ $set: "$s" }]],
      ["$out($.c);", [{ $out: "$c" }]],
      ["$lookup($.l);", [{ $lookup: "$l" }]],
      ["$sample($.n);", [{ $sample: "$n" }]],
      ["$facet($.f);", [{ $facet: "$f" }]],
    ];
    for (const [src, out] of PASSES) expect(pipeline(src), src).toEqual(out);
  });

  it("takes every sort direction and unwind path as written", () => {
    expect(compiled("$sort({ a: 1, b: -1 });")).toEqual([{ $sort: { a: 1, b: -1 } }]);
    expect(compiled('$sort({ s: $meta("textScore") });')).toEqual([{ $sort: { s: { $meta: "textScore" } } }]);
    expect(pipeline('$sort({ a: "desc" });')).toEqual([{ $sort: { a: "desc" } }]);
    expect(pipeline("$sort({ a: 0 });")).toEqual([{ $sort: { a: 0 } }]);
    expect(compiled('$unwind("$items");')).toEqual([{ $unwind: "$items" }]);
    expect(pipeline('$unwind("items");')).toEqual([{ $unwind: "items" }]);
    expect(pipeline('$unwind({ path: "items" });')).toEqual([{ $unwind: { path: "items" } }]);
  });

  it("takes a sort of 33 keys that you write, and refuses 33 in a JavaScript sort", () => {
    const spec = (n: number): string => `{ ${Array.from({ length: n }, (_, i) => `k${i}: 1`).join(", ")} }`;
    const names = (n: number): string => `[${Array.from({ length: n }, (_, i) => `"k${i}"`).join(", ")}]`;
    const written: readonly [string, (s: string) => string][] = [
      ["$sort", (s) => `$sort(${s});`],
      ["$sort", (s) => `$$.$sort(${s});`],
      ["$setWindowFields.sortBy", (s) => `$setWindowFields({ sortBy: ${s}, output: { r: { $sum: 1 } } });`],
      ["$fill.sortBy", (s) => `$fill({ sortBy: ${s}, output: { qty: { method: "locf" } } });`],
      ["$top.sortBy", (s) => `$group({ _id: null, t: $top({ output: $.a, sortBy: ${s} }) });`],
      ["$bottomN.sortBy", (s) => `$group({ _id: null, t: $bottomN($.a, ${s}, 2) });`],
    ];
    for (const [who, src] of written) {
      expect(compiled(src(spec(32))), who).toHaveLength(1);
      expect(pipeline(src(spec(33))), who).toHaveLength(1);
    }
    expect(compiled(`$$.toSorted(${spec(32)});`)).toHaveLength(1);
    expect(() => pipeline(`$$.toSorted(${spec(33)});`)).toThrow(
      "'.toSorted()' sorts by at most 32 keys, and this sort names 33. The server refuses a longer compound sort.",
    );
    expect(compiled(`$$.sortBy(${names(32)});`)).toEqual([
      { $sort: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, 1])) },
    ]);
    expect(() => pipeline(`$$.sortBy(${names(33)});`)).toThrow(/^'\.sortBy\(\)' sorts by at most 32 keys/);
    expect(compiled(`$.x = $.items.toSorted(${spec(33)});`)).toHaveLength(1);
  });

  it("takes every literal value in a closed-set slot as written", () => {
    expect(compiled("$bucket({ groupBy: $.a, boundaries: [0, 10, 30] });")).toEqual([
      { $bucket: { groupBy: "$a", boundaries: [0, 10, 30] } },
    ]);
    expect(pipeline("$bucket({ groupBy: $.a });")).toEqual([{ $bucket: { groupBy: "$a" } }]);
    expect(pipeline("$bucket({ groupBy: $.a, boundaries: $.b });")).toEqual([
      { $bucket: { groupBy: "$a", boundaries: "$b" } },
    ]);
    expect(pipeline('$bucketAuto({ groupBy: $.a, buckets: 2, granularity: "nope" });')).toEqual([
      { $bucketAuto: { groupBy: "$a", buckets: 2, granularity: "nope" } },
    ]);
  });

  it("takes a body that no reading can prove, at every stage", () => {
    expect(pipeline("$unwind(null); $.b = $.a;")).toEqual([{ $unwind: null }, { $set: { b: "$a" } }]);
    expect(pipeline("$unset([null]); $.b = $.a;")).toEqual([{ $unset: [null] }, { $set: { b: "$a" } }]);
    for (const stage of everyStageName()) {
      expect(() => pipeline(`${stage}(null);`), stage).not.toThrow();
      const src = `$.a = 1; ${stage}(null); $.b = $.a;`;
      for (const e of jsmql.validate(src).errors) {
        expect(e.code, `${stage}: ${e.message}`).toBe("CODEGEN_ERROR");
        expect(e.pos, `${stage}: ${e.message}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("compiler/emit/statement — bindings between stages", () => {
  it("carries a `let` in a field of the document, and the cleanup drops it", () => {
    expect(compiled("let x = $.a * 2; $.b = x;")).toEqual([
      { $set: { "__jsmql.var.x": { $multiply: ["$a", 2] } } },
      { $set: { b: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let x = 1; $.b = x;")).toEqual([{ $set: { b: 1 } }]);
    expect(compiled("let x = $.a; let y = x + 1; $.c = y;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.y": { $add: ["$__jsmql.var.x", 1] } } },
      { $set: { c: "$__jsmql.var.y" } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let t = $.a; $$.filter(d => d.x > t);")).toEqual([
      { $set: { "__jsmql.var.t": "$a" } },
      { $match: { $expr: { $gt: ["$x", "$__jsmql.var.t"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let x = $.a; x = $.b; $.c = x;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.x": "$b" } },
      { $set: { c: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    expect(() => pipeline("const x = $.a; x = $.b;")).toThrow(/is a 'const' and cannot be assigned again/);
  });

  it("shares one $set across the declarators a `,` joined, and breaks it at a dependency", () => {
    expect(compiled("let a = $.x, b = $.y; $.o = a + b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x", "__jsmql.var.b": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.a", "$__jsmql.var.b"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let a = $.x; let b = $.y; $.o = a + b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $set: { "__jsmql.var.b": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.a", "$__jsmql.var.b"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let a = $.x, b = a + 1, c = $.y; $.o = b + c;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $set: { "__jsmql.var.b": { $add: ["$__jsmql.var.a", 1] }, "__jsmql.var.c": "$y" } },
      { $set: { o: { $add: ["$__jsmql.var.b", "$__jsmql.var.c"] } } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("const k = 2, n = k * 3; $.c = $.a * n;")).toEqual([{ $set: { c: { $multiply: ["$a", 6] } } }]);
    expect(compiled("const dbl = (v) => v * 2, y = dbl($.a); $.c = dbl(y);")).toEqual([
      { $set: { "__jsmql.var.y": { $let: { vars: { v: "$a" }, in: { $multiply: ["$$v", 2] } } } } },
      { $set: { c: { $let: { vars: { v: "$__jsmql.var.y" }, in: { $multiply: ["$$v", 2] } } } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("keeps a declarator whose value hoists a stage out of the shared $set", () => {
    expect(compiled("let a = $.x, b = $$$.other.filter(o => o.k === a).size(); $.o = b;")).toEqual([
      { $set: { "__jsmql.var.a": "$x" } },
      { $lookup: { from: "other", localField: "__jsmql.var.a", foreignField: "k", as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.b": { $size: "$__jsmql.tmp.0" } } },
      { $set: { o: "$__jsmql.var.b" } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled("let a = $.x, b = $$$.other.filter(o => o.k === a).size(); $.o = b;")).toEqual(
      compiled("let a = $.x; let b = $$$.other.filter(o => o.k === a).size(); $.o = b;"),
    );
  });

  it("loses a binding at a stage that replaces the document, and says so on the next read", () => {
    expect(compiled("let x = $.a; $group({ _id: x });")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $group: { _id: "$__jsmql.var.x" } },
    ]);
    expect(compiled("let x = $.a; $ = { y: x };")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $replaceWith: { y: "$__jsmql.var.x" } },
    ]);
    expect(() => pipeline('let t = $.a; $count("n"); $.b = t;')).toThrow(
      /It cannot be read after `\$count`, because that stage replaced the document that carried it\./,
    );
    expect(() => pipeline("let t = $.a; $project({ a: 1 }); $.b = t;")).toThrow(
      /It cannot be read after `\$project`, because that stage replaced the document that carried it\./,
    );
    expect(compiled("let t = $.a; $project({ z: 0 }); $.b = t;")).toEqual([
      { $set: { "__jsmql.var.t": "$a" } },
      { $project: { z: 0 } },
      { $set: { b: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
    expect(compiled('let x = $.a; $.b = x; $out("o");')).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { b: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
      { $out: "o" },
    ]);
  });

  it("carries a dropped `let` again on assignment, and refuses the spellings JavaScript refuses", () => {
    expect(compiled("let v = $.x; $group({ _id: $.c }); v = $._id; $.w = v;")).toEqual([
      { $set: { "__jsmql.var.v": "$x" } },
      { $group: { _id: "$c" } },
      { $set: { "__jsmql.var.v": "$_id" } },
      { $set: { w: "$__jsmql.var.v" } },
      { $unset: "__jsmql" },
    ]);
    expect(() => pipeline("const v = $.x; $group({ _id: $.c }); $.w = v;")).toThrow(
      /`v` is a `const` binding\. It cannot be read after `\$group`, because that stage replaced the document that carried it\./,
    );
    expect(() => pipeline("const v = $.x; $group({ _id: $.c }); v = 1;")).toThrow(
      /is a 'const' and cannot be assigned again/,
    );
    expect(() => pipeline("let v = $.x; let v = $.y;")).toThrow(/already declared earlier in this block/);
    expect(() => pipeline("let v = $.x; $group({ _id: $.c }); let v = $._id;")).toThrow(
      /already declared earlier in this block/,
    );
  });

  it("scopes a `let` to the block that declares it", () => {
    expect(compiled("let x = $.a; $$.aggregate(o => { x = o.b; $.y = x; }); $.z = x;")).toEqual([
      { $set: { "__jsmql.var.x": "$a" } },
      { $set: { "__jsmql.var.x": "$b" } },
      { $set: { y: "$__jsmql.var.x" } },
      { $set: { z: "$__jsmql.var.x" } },
      { $unset: "__jsmql" },
    ]);
    expect(() => pipeline("let x = $.a; $$.aggregate(o => { let x = o.b; $.y = x; });")).toThrow(
      /`let x` shadows the `x` declared outside this block/,
    );
    expect(() => pipeline("$$.aggregate(o => { let o = 1; $.y = o; });")).toThrow(/re-declares the parameter `o`/);
    expect(() => pipeline("$$.aggregate(o => { let k = o.b; $.y = k; }); $.z = k;")).toThrow(/Unknown identifier 'k'/);
    expect(() => pipeline("$$.map((d, i) => ({ n: i }));")).toThrow(/`i` has no value inside `.map\(\)`/);
    expect(compiled("$$.map((d, i, c) => ({ n: c.size() }));")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $replaceWith: { n: "$__jsmql.size" } },
    ]);
  });

  it("starts the stream from a literal list of documents", () => {
    const fanOut = (docs: unknown[]) => [
      { $match: { $expr: false } },
      { $unionWith: { pipeline: [{ $documents: docs }] } },
    ];
    expect(compiled("$$ = [{ a: 1 }, { a: 2 }];")).toEqual(fanOut([{ a: 1 }, { a: 2 }]));
    expect(compiled("$$ = [{ a: 1 }]; $.b = 2;")).toEqual([...fanOut([{ a: 1 }]), { $set: { b: 2 } }]);
    expect(compiled("$$ = [];")).toEqual([{ $match: { $expr: false } }]);
    expect(compiled("$.b = 1; $$ = [{ a: 1 }];")).toEqual([{ $set: { b: 1 } }, ...fanOut([{ a: 1 }])]);
    expect(() => pipeline("$$ = [{ a: 1 }, 5];")).toThrow(
      /'\$\$ = \[ … \]' element 2 takes a document, but got a number/,
    );
    expect(compiled("$$ = [{ n: $$.reduce((acc, d) => acc + 1, 0) }];")).toEqual([
      { $group: { _id: null, n: { $sum: 1 } } },
      { $replaceWith: { n: "$n" } },
    ]);
  });
});

describe("compiler/emit/statement — the stream road", () => {
  it("lowers a chain on the stream one link at a time, and the bare spelling the same way", () => {
    expect(compiled("$$ = $$.filter(d => d.x > 1);")).toEqual([{ $match: { x: { $gt: 1 } } }]);
    expect(compiled("$$.filter(d => d.x > 1);")).toEqual([{ $match: { x: { $gt: 1 } } }]);
    expect(compiled('$$ = $$.filter(d => d.x > 1).sortBy("k").take(2);')).toEqual([
      { $match: { x: { $gt: 1 } } },
      { $sort: { k: 1 } },
      { $limit: 2 },
    ]);
    expect(compiled("$$ = $$.$match({ a: 1 }).$limit(1);")).toEqual([{ $match: { a: 1 } }, { $limit: 1 }]);
    expect(compiled("$$ = $$.map(d => ({ a: d.x, w: d }));")).toEqual([{ $replaceWith: { a: "$x", w: "$$ROOT" } }]);
    expect(compiled("$$ = $$.map(d => d.sub.deep);")).toEqual([{ $replaceWith: "$sub.deep" }]);
    expect(compiled("$$ = $$.filter(d => d.x > $.y);")).toEqual([{ $match: { $expr: { $gt: ["$x", "$y"] } } }]);
    expect(compiled("$$ = $$.filter({ k: 1 });")).toEqual([{ $match: { k: 1 } }]);
    expect(compiled('$$ = $$.map("sub");')).toEqual([{ $replaceWith: "$sub" }]);
  });

  it("reads every sort spelling through one reader", () => {
    expect(compiled('$$ = $$.sortBy("x");')).toEqual([{ $sort: { x: 1 } }]);
    expect(compiled('$$ = $$.sortBy(["x", "y"]);')).toEqual([{ $sort: { x: 1, y: 1 } }]);
    expect(compiled('$$ = $$.sort({ x: -1, y: "asc" });')).toEqual([{ $sort: { x: -1, y: 1 } }]);
    expect(compiled("$$ = $$.toSorted((a, b) => b.x - a.x || a.y - b.y);")).toEqual([{ $sort: { x: -1, y: 1 } }]);
    expect(compiled('$$ = $$.orderBy(["x", "y"], ["asc", "desc"]);')).toEqual([{ $sort: { x: 1, y: -1 } }]);
    expect(compiled("$$ = $$.sortBy(d => -d.age);")).toEqual([{ $sort: { age: -1 } }]);
    expect(compiled("$$ = $$.sortBy(d => d.a + d.b);")).toEqual([
      { $addFields: { "__jsmql.tmp.0": { $add: ["$a", "$b"] } } },
      { $sort: { "__jsmql.tmp.0": 1 } },
      { $unset: "__jsmql" },
    ]);
    expect(() => pipeline("$$ = $$.sortBy({ k: -1 });")).toThrow(/reads an object as a lodash matcher/);
    expect(() => pipeline("$$ = $$.sort({ a: 2 });")).toThrow(/takes a direction: 1, -1/);
  });

  it("emits each method's own stage, and nothing for an identity", () => {
    expect(compiled("$$ = $$.take(2);")).toEqual([{ $limit: 2 }]);
    expect(compiled("$$ = $$.take(0);")).toEqual([{ $match: { $expr: false } }]);
    expect(compiled("$$ = $$.slice(1, 3);")).toEqual([{ $skip: 1 }, { $limit: 2 }]);
    expect(compiled("$$ = $$.tail();")).toEqual([{ $skip: 1 }]);
    expect(compiled("$$ = $$.sampleSize(3);")).toEqual([{ $sample: { size: 3 } }]);
    expect(compiled("$$ = $$.flatMap(d => d.items);")).toEqual([{ $unwind: "$items" }]);
    expect(compiled('$$ = $$.pick(["a", "b"]);')).toEqual([{ $project: { a: 1, b: 1, _id: 0 } }]);
    expect(compiled('$$ = $$.omit(["a"]);')).toEqual([{ $project: { a: 0 } }]);
    expect(compiled("$$ = $$.pick([]);")).toEqual([{ $replaceWith: {} }]);
    expect(compiled('$$.flatMap("items").pick([]);')).toEqual([{ $unwind: "$items" }, { $replaceWith: { items: {} } }]);
    expect(compiled("$$.omit([]); $.x = 1;")).toEqual([{ $set: { x: 1 } }]);
    expect(compiled('$$ = $$.uniqBy("k");')).toEqual([
      { $group: { _id: "$k", __jsmqlTmp: { $first: "$$ROOT" } } },
      { $replaceWith: "$__jsmqlTmp" },
    ]);
    expect(compiled("$$.uniq();")).toEqual([{ $group: { _id: "$$ROOT" } }, { $replaceWith: "$_id" }]);
    expect(compiled('$$ = $$.countBy("k");')).toEqual([
      { $group: { _id: "$k", __jsmqlTmp: { $sum: 1 } } },
      {
        $group: {
          _id: null,
          __jsmqlTmp: { $push: { k: { $ifNull: [{ $toString: "$_id" }, "null"] }, v: "$__jsmqlTmp" } },
        },
      },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    expect(compiled("$$ = $$.reject(d => d.x > 1);")).toEqual([{ $match: { $nor: [{ x: { $gt: 1 } }] } }]);
    expect(compiled("$$.aggregate((o) => { $match(o.a > 1); $limit(2); });")).toEqual([
      { $match: { a: { $gt: 1 } } },
      { $limit: 2 },
    ]);
  });

  it("refuses what the server would, and says what to write", () => {
    expect(() => pipeline('$$.filter(d => d.a).$out("x").$limit(1);')).toThrow(/Nothing can follow '\$out'/);
    expect(() => pipeline("$$?.$match({ a: 1 });")).toThrow(/never null/);
    expect(() => pipeline("$$ = $$.map(d => 5);")).toThrow(/takes an arrow that returns a document/);
    expect(() => pipeline("$$ = $$.flatMap(d => 5);")).toThrow(/names the ARRAY FIELD/);
    expect(() => pipeline("$$.omit([1, 2]);")).toThrow(/takes a field NAME to write/);
    expect(() => pipeline("$$ = $$.countBy(String);")).toThrow(/takes a key here/);
    expect(() => pipeline("$$.filterr(d => d.a);")).toThrow(/Did you mean '\.filter\(\)'/);
    expect(pipeline("$$.$prject({ a: 1 });")).toEqual([{ $prject: { a: 1 } }]);
    expect(() => pipeline("$$ = $$.map((d, i) => ({ n: i }));")).toThrow(/no per-document index/);
    expect(compiled("$$ = $$.map((d, _i, _coll) => ({ id: d._id }));")).toEqual([{ $replaceWith: { id: "$_id" } }]);
  });
});

describe("compiler/emit/statement — the refusals name the way out", () => {
  it("tells a value what to do when it stands as a statement", () => {
    expect(() => pipeline("$.a > 1;")).toThrow(/A pipeline statement writes something/);
    expect(() => pipeline("$.s.trim();")).toThrow(/Assign it to a field/);
    expect(pipeline("$abs(42);")).toEqual([{ $abs: 42 }]);
    expect(pipeline("$not(true);")).toEqual([{ $not: true }]);
  });

  it("refuses a stage, an operator or a global function on a value, and keeps no part of the call", () => {
    const sortOnValue =
      "'.$sort()' is a pipeline stage, and a stage runs on a stream, not on a value. Write it as a chain link ('$$.$sort(…)') or as a pipeline statement ('$sort(…);'). For the value form, use '$sortArray(…)'.";
    expect(() => pipeline("$.items.$sort({ a: 1 });")).toThrow(sortOnValue);
    expect(() => pipeline("$match({ a: 1 }); $.items.$sort({ a: 1 });")).toThrow(sortOnValue);
    expect(() => pipeline('"abc".$sort({ a: 1 });')).toThrow(sortOnValue);
    expect(() => pipeline("$.items.$match({ a: 1 }).$sort({ b: 1 });")).toThrow(sortOnValue);
    expect(() => pipeline("$.items.$foo();")).toThrow(
      "'.$foo()' takes no receiver. A '$' name is a MongoDB operator or stage, and each one is a call: write '$foo(…)' with every operand inside the parentheses.",
    );
    expect(() => pipeline("$.items.assert($.x > 1);")).toThrow(
      "'.assert()' takes no receiver. 'assert' is a global function: write 'assert(…)' with the value inside the parentheses.",
    );
    expect(pipeline("$$.$match({ a: 1 }).$sort({ b: 1 });")).toEqual([{ $match: { a: 1 } }, { $sort: { b: 1 } }]);
  });

  it("names the context reference that a source stage runs on, with its dot", () => {
    expect(() => pipeline("$.items.indexStats();")).toThrow(
      "'indexStats()' is not available on a receiver whose type JSMQL cannot prove — it is defined on 'stream'. Write '$$.indexStats()' — the root stream, run on 'db.coll.aggregate()'.",
    );
    expect(() => pipeline("$.items.currentOp();")).toThrow(
      /Write '\$\$\$\$\.currentOp\(\)' — the cluster reference, run on the admin database\.$/,
    );
  });

  it("names the nearest working name for a misspelled call, from the names of its kind", () => {
    const refusal = (src: string): string => {
      try {
        pipeline(src);
      } catch (e) {
        return (e as Error).message;
      }
      return "compiled";
    };
    expect(refusal("$$.sizee();")).toBe(
      "'.sizee()' is not a method of the stream '$$'. Did you mean '.size()'? A stage is a link too: '$$.$match(…)'.",
    );
    expect(refusal("$$.concatt([{ a: 1 }]);")).toBe(
      "'.concatt()' is not a method of the stream '$$'. Did you mean '.concat()'? A stage is a link too: '$$.$match(…)'.",
    );
    expect(refusal("$$ = $$$.orders.filterr((o) => o.a);")).toBe(
      "Unknown method '.filterr()' at position 15. Did you mean '.filter()'?",
    );
    expect(refusal("$.tags.popp();")).toBe("Unknown method '.popp()' at position 6. Did you mean '.pop()'?");
    expect(refusal("$.tags.pushh(1);")).toBe("Unknown method '.pushh()' at position 6. Did you mean '.push()'?");
    expect(refusal("$.tags.Numbr();")).toBe("Unknown method '.Numbr()' at position 6.");
    expect(refusal("Date.noww();")).toBe("Unknown method 'Date.noww()' at position 4. Did you mean 'Date.now'?");
    expect(refusal("Object.assignn($.a, { b: 1 });")).toBe("Unknown method 'Object.assignn()' at position 6.");
    expect(refusal("assertt($.a > 1);")).toBe(
      "Unknown function 'assertt(...)'. Did you mean 'assert(...)'? Declare it first with `const assertt = (…) => …;` at the top level of a pipeline; for a MongoDB operator write `$assertt(...)`; for a method, `receiver.assertt(...)`.",
    );
    expect(refusal("$.n = Longg(5);")).toBe(
      "Unknown function 'Longg(...)'. Did you mean 'Long(...)'? Declare it first with `const Longg = (…) => …;` at the top level of a pipeline; for a MongoDB operator write `$Longg(...)`; for a method, `receiver.Longg(...)`.",
    );
    expect(refusal("$.n = Numberr($.s);")).toBe(
      "Unknown function 'Numberr(...)'. Declare it first with `const Numberr = (…) => …;` at the top level of a pipeline; for a MongoDB operator write `$Numberr(...)`; for a method, `receiver.Numberr(...)`.",
    );
    expect(pipeline("$matc({ a: 1 });")).toEqual([{ $matc: { a: 1 } }]);
    expect(compiled("$.tags.pop();")).toEqual([
      {
        $set: {
          tags: {
            $let: {
              vars: { jsmqlArr: { $ifNull: ["$tags", []] } },
              in: { $slice: ["$$jsmqlArr", { $max: [{ $subtract: [{ $size: "$$jsmqlArr" }, 1] }, 0] }] },
            },
          },
        },
      },
    ]);
    expect(compiled("$$ = $$$.orders.filter((o) => o.a);")).toEqual([
      { $match: { $expr: false } },
      {
        $unionWith: {
          coll: "orders",
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [{ $gt: ["$a", null] }, { $ne: ["$a", false] }, { $ne: ["$a", ""] }, { $ne: ["$a", 0] }],
                },
              },
            },
          ],
        },
      },
    ]);
  });

  it("refuses a destination that is not a field, and the deletion of the document", () => {
    expect(() => pipeline("$.s.trim() = 1;")).toThrow(/You can write only to a field/);
    expect(() => pipeline("delete $;")).toThrow(/delete the document itself/);
  });

  it("quotes the root as written when it refuses a root write in a body, and each fix it names compiles", () => {
    const notADocument = (root: string, noun: string): string =>
      `'${root} = …' takes a document, but got ${noun}. Put the value under a field ('${root} = { value: … };'), or write to a field instead ('${root}.value = …;').`;
    expect(() => pipeline("$$.aggregate(o => { o = 5; });")).toThrow(notADocument("o", "a number"));
    expect(() => pipeline("$$.aggregate(o => { o = o.a * 2; });")).toThrow(notADocument("o", "a number"));
    expect(() => pipeline("$$.aggregate(o => { o = null; });")).toThrow(notADocument("o", "null"));
    expect(() => pipeline("$$.aggregate(function (doc) { doc = 5; });")).toThrow(notADocument("doc", "a number"));
    expect(() => pipeline("$$ = $$$.orders.aggregate(o => { o = 5; });")).toThrow(notADocument("o", "a number"));
    expect(() => pipeline("$.x = $$$.orders.filter(o => o.uid === $._id).aggregate(o => { o = 5; });")).toThrow(
      notADocument("o", "a number"),
    );
    expect(() => pipeline("$$.aggregate(o => { $ = 5; });")).toThrow(notADocument("$", "a number"));
    expect(() => pipeline("$$.aggregate(o => { o = [1, 2]; });")).toThrow(
      "'o = …' takes a document, but got an array. Name the destination that takes an array: '$$ = <array>;' makes the stream from its elements, one document per element. To keep the array as a field of this document, write 'o.<field> = <array>;'.",
    );
    expect(() => pipeline("$$.aggregate(o => { delete o; });")).toThrow(
      "'delete o' would delete the document itself. To replace it, write 'o = { … };'; to drop every field but one, write 'o = { keep: o.keep };'.",
    );
    expect(() => pipeline("$$.aggregate(o => { o = $$$.orders.filter(p => p.a === o.b); });")).toThrow(
      "The document can only become ONE document, and this chain gives an array. Write 'o = $$$.<coll>.find(pred)' for the first match, or keep the array in a field: 'o.<field> = $$$.<coll>.…'.",
    );
    expect(compiled("$$.aggregate(o => { o = { value: 5 }; });")).toEqual([{ $replaceWith: { value: 5 } }]);
    expect(compiled("$$.aggregate(o => { o.value = o.a * 2; });")).toEqual([
      { $set: { value: { $multiply: ["$a", 2] } } },
    ]);
    expect(compiled("$$.aggregate(o => { o.list = [1, 2]; });")).toEqual([{ $set: { list: [1, 2] } }]);
    expect(compiled("$$.aggregate(o => { o = { keep: o.a }; });")).toEqual([{ $replaceWith: { keep: "$a" } }]);
    expect(compiled("$$.aggregate(o => { o = $$$.orders.find(p => p.a === o.b); });")).toEqual([
      {
        $lookup: { from: "orders", localField: "b", foreignField: "a", pipeline: [{ $limit: 1 }], as: "__jsmql.tmp.0" },
      },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    expect(compiled("$$ = $$$.orders.aggregate(o => { o = { value: 5 }; });")).toEqual([
      { $match: { $expr: false } },
      { $unionWith: { coll: "orders", pipeline: [{ $replaceWith: { value: 5 } }] } },
    ]);
  });

  it("passes a body that the server refuses through as written, because you wrote it", () => {
    expect(pipeline('$count("$n");')).toEqual([{ $count: "$n" }]);
    expect(pipeline("$count($.name);")).toEqual([{ $count: "$name" }]);
    expect(pipeline('$count("a.b");')).toEqual([{ $count: "a.b" }]);
    expect(pipeline("$count(5);")).toEqual([{ $count: 5 }]);
    expect(pipeline("$limit(0);")).toEqual([{ $limit: 0 }]);
    expect(pipeline("$limit(1.5);")).toEqual([{ $limit: 1.5 }]);
    expect(pipeline("$limit($.n);")).toEqual([{ $limit: "$n" }]);
    expect(pipeline("$skip(-1);")).toEqual([{ $skip: -1 }]);
    expect(compiled("$skip(0);")).toEqual([{ $skip: 0 }]);
    expect(compiled('$unionWith("c");')).toEqual([{ $unionWith: "c" }]);
  });

  it("refuses a value, and a program that would do nothing", () => {
    expect(() => pipeline("[1, 2, 3].slice(3, 2)")).toThrow(/A pipeline is one or more statements/);
    expect(() => pipeline("const x = 5;")).toThrow(/produces no stages/);
    expect(compiled("[]")).toEqual([]);
  });

  it("keeps a stage inside the body it was written in", () => {
    expect(compiled('$lookup({ from: "o", pipeline: [$match({ a: { $gt: 1 } }), $limit(2)], as: "r" });')).toEqual([
      { $lookup: { from: "o", pipeline: [{ $match: { a: { $gt: 1 } } }, { $limit: 2 }], as: "r" } },
    ]);
    expect(compiled('$lookup({ from: "o", pipeline: [$match($.a > 1)], as: "r" });')).toEqual([
      {
        $lookup: {
          from: "o",
          let: { jsmql_f0_a: "$a" },
          pipeline: [{ $match: { $expr: { $gt: ["$$jsmql_f0_a", 1] } } }],
          as: "r",
        },
      },
    ]);
    expect(compiled("$facet({ a: [$limit(1)] });")).toEqual([{ $facet: { a: [{ $limit: 1 }] } }]);
  });

  it("passes a body that no deployment accepts through, in both spellings of a stage", () => {
    expect(pipeline("$addFields(5);")).toEqual([{ $addFields: 5 }]);
    expect(pipeline("$replaceWith(5);")).toEqual([{ $replaceWith: 5 }]);
    expect(pipeline("$replaceRoot({ newRoot: 5 });")).toEqual([{ $replaceRoot: { newRoot: 5 } }]);
    expect(pipeline("$replaceRoot({ bogus: 1 });")).toEqual([{ $replaceRoot: { bogus: 1 } }]);
    expect(pipeline('{ $unwind: "items" };')).toEqual([{ $unwind: "items" }]);
    expect(pipeline('{ $sort: { a: "desc" } };')).toEqual([{ $sort: { a: "desc" } }]);
    expect(pipeline('$bucketAuto({ groupBy: $.x, buckets: 2, granularity: "$g" });')).toEqual([
      { $bucketAuto: { groupBy: "$x", buckets: 2, granularity: "$g" } },
    ]);
  });

  it("passes the body of every stage through, whatever the server says of it", () => {
    expect(pipeline('$densify({ field: "t", range: { step: 1, bounds: "full" }, zzz: 1 });')).toEqual([
      { $densify: { field: "t", range: { step: 1, bounds: "full" }, zzz: 1 } },
    ]);
    expect(pipeline('$densify({ range: { step: 1, bounds: "full" } });')).toEqual([
      { $densify: { range: { step: 1, bounds: "full" } } },
    ]);
    expect(
      pipeline(
        '$fill({ sortBy: { t: 1 }, partitionBy: "$k", partitionByFields: ["k"], output: { a: { method: "locf" } } });',
      ),
    ).toEqual([
      { $fill: { sortBy: { t: 1 }, partitionBy: "$k", partitionByFields: ["k"], output: { a: { method: "locf" } } } },
    ]);
    expect(pipeline('$setWindowFields({ partitionBy: "$k" });')).toEqual([{ $setWindowFields: { partitionBy: "$k" } }]);
    expect(pipeline('$merge({ into: "c", whenMatched: "zzz" });')).toEqual([
      { $merge: { into: "c", whenMatched: "zzz" } },
    ]);
    expect(pipeline("$changeStreamSplitLargeEvent({ zzz: 1 });")).toEqual([
      { $changeStreamSplitLargeEvent: { zzz: 1 } },
    ]);
    expect(pipeline('{ $out: { db: "d", coll: "c", zzz: 1 } };')).toEqual([{ $out: { db: "d", coll: "c", zzz: 1 } }]);
    expect(pipeline('$geoNear({ near: [0, 0], distanceField: "d", zzz: 1 });')).toEqual([
      { $geoNear: { near: [0, 0], distanceField: "d", zzz: 1 } },
    ]);
    expect(pipeline('$fill({ sortBy: { t: 1 }, output: { a: { method: "locf" } } });')).toEqual([
      { $fill: { sortBy: { t: 1 }, output: { a: { method: "locf" } } } },
    ]);
    expect(pipeline('$densify({ field: "t", range: { step: 1, bounds: "full" } });')).toEqual([
      { $densify: { field: "t", range: { step: 1, bounds: "full" } } },
    ]);
    expect(pipeline('$merge({ into: "c", whenMatched: [{ $set: { a: 1 } }] });')).toEqual([
      { $merge: { into: "c", whenMatched: [{ $set: { a: 1 } }] } },
    ]);
  });

  it("says which forms this compiler has not built yet, so nothing looks supported", () => {
    expect(() => pipeline("$$$.orders.$match({ a: 1 });")).toThrow(/gives it no destination/);
    expect(compiled("$$$.dest = $$.aggregate((o) => { $match(o.a === 1); });")).toEqual([
      { $match: { a: 1 } },
      { $out: "dest" },
    ]);
  });
});

const CLEAR_ROOT = { $unsetField: { field: "__jsmql", input: "$$ROOT" } };

const NAMESPACE_FREE: string[] = [];
const clear = (src: string): unknown[] => {
  NAMESPACE_FREE.push(src);
  return compiled(src);
};

describe("compiler/emit/statement — a read of the whole document never carries `__jsmql`", () => {
  it("leaves the namespace out of the document after a binding wrote under it", () => {
    const t = { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } };
    expect(clear("let t = $.a + 1; $ = { ...$, y: t };")).toEqual([
      t,
      { $replaceWith: { $mergeObjects: [CLEAR_ROOT, { y: "$__jsmql.var.t" }] } },
    ]);
    expect(clear("let t = $.a + 1; $.copy = $; $.y = t;")).toEqual([
      t,
      { $set: { copy: CLEAR_ROOT } },
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
    expect(clear("let t = $.a + 1; $.y = t; $group({ _id: null, all: $push($) });")).toEqual([
      t,
      { $set: { y: "$__jsmql.var.t" } },
      { $group: { _id: null, all: { $push: CLEAR_ROOT } } },
    ]);
    expect(clear("let t = $.a + 1; $.y = t; $$ = $$.map(d => ({ d }));")).toEqual([
      t,
      { $set: { y: "$__jsmql.var.t" } },
      { $replaceWith: { d: CLEAR_ROOT } },
    ]);
  });

  it("leaves it out of the documents that `.groupBy()` and `.keyBy()` collect", () => {
    const [groupBy] = clear("let t = $.a + 1; $.y = t; $$ = $$.groupBy(d => d.a);").slice(2);
    expect(groupBy).toEqual({ $group: { _id: "$a", __jsmqlTmp: { $push: CLEAR_ROOT } } });
    const [keyBy] = clear("let t = $.a + 1; $.y = t; $$ = $$.keyBy(d => d._id);").slice(2);
    expect(keyBy).toEqual({ $group: { _id: "$_id", __jsmqlTmp: { $last: CLEAR_ROOT } } });
  });

  it("leaves it out when a stage of the same statement writes it after the compiler lowers the read", () => {
    expect(clear("$.copy = { d: $, n: $$.size() };")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { copy: { $mergeObjects: [{ d: CLEAR_ROOT, n: "$__jsmql.size" }] } } },
      { $unset: "__jsmql" },
    ]);
    expect(clear("$ = { a: $$.map(d => ({ d, n: $$.size() })) };")).toEqual([
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $facet: { a: [{ $replaceWith: { d: CLEAR_ROOT, n: "$__jsmql.size" } }] } },
    ]);
  });

  it("reads the bare `$$ROOT` when nothing is under the namespace", () => {
    expect(clear("$.copy = $;")).toEqual([{ $set: { copy: "$$ROOT" } }]);
    expect(clear("$ = { ...$, y: 1 };")).toEqual([{ $replaceWith: { $mergeObjects: ["$$ROOT", { y: 1 }] } }]);
  });

  it("removes the namespace ahead of a stage you write that reads `$$ROOT`, and keeps your MQL as written (HR1)", () => {
    const t = { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } };
    expect(clear('let t = $.a + 1; $replaceWith("$$ROOT");')).toEqual([
      t,
      { $unset: "__jsmql" },
      { $replaceWith: "$$ROOT" },
    ]);
    expect(clear('let t = $.a + 1; $.y = t; $group({ _id: null, all: { $push: "$$ROOT" } });')).toEqual([
      t,
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
      { $group: { _id: null, all: { $push: "$$ROOT" } } },
    ]);
    expect(clear('let t = $.a + 1; $.copy = $mergeObjects("$$ROOT", {});')).toEqual([
      t,
      { $unset: "__jsmql" },
      { $set: { copy: { $mergeObjects: ["$$ROOT", {}] } } },
    ]);
    expect(clear('let t = $.a + 1; $set({ copy: "$$ROOT" }); t = 5; $.y = t;')).toEqual([
      t,
      { $unset: "__jsmql" },
      { $set: { copy: "$$ROOT" } },
      { $set: { "__jsmql.var.t": 5 } },
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("keeps a `$$ROOT` in a sub-pipeline and in a stage that returns the documents unchanged", () => {
    expect(
      clear('let t = $.a + 1; $.y = t; $lookup({ from: "orders", pipeline: [{ $replaceWith: "$$ROOT" }], as: "o" });'),
    ).toEqual([
      { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } },
      { $set: { y: "$__jsmql.var.t" } },
      { $lookup: { from: "orders", pipeline: [{ $replaceWith: "$$ROOT" }], as: "o" } },
      { $unset: "__jsmql" },
    ]);
    expect(clear("let t = $.a + 1; $$.uniq(); $.y = t;")).toEqual([
      { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } },
      { $group: { _id: "$$ROOT" } },
      { $replaceWith: "$_id" },
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("reads the whole document without the namespace in a keyed reducer wrap", () => {
    expect(
      clear("let t = $.a + 1; $.y = t; $$ = [$$.reduce((acc, d) => ({ ...acc, [d.k]: d }), {})];").slice(2),
    ).toEqual([
      { $group: { _id: null, __jsmqlTmp: { $push: { k: { $toString: { $ifNull: ["$k", ""] } }, v: CLEAR_ROOT } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
  });

  it("refuses a later read of a binding that the removal deleted, and names the fix", () => {
    expect(() => pipeline('let t = $.a + 1; $set({ copy: "$$ROOT" }); $.y = t;')).toThrow(
      /`t` cannot be read here\. .*write `\$` in place of `"\$\$ROOT"`/,
    );
    expect(pipeline("let t = $.a + 1; $set({ copy: $ }); $.y = t;")).toEqual([
      { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } },
      { $set: { copy: CLEAR_ROOT } },
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("refuses a raw `$$ROOT` in a statement that also reads the namespace, and names `$`", () => {
    expect(() => pipeline('let t = $.a + 1; $group({ _id: t, all: { $push: "$$ROOT" } });')).toThrow(
      /reads the whole document as `\$\$ROOT` in raw MQL, and it also reads a value that the compiler keeps/,
    );
    expect(clear("let t = $.a + 1; $group({ _id: t, all: { $push: $ } });")).toEqual([
      { $set: { "__jsmql.var.t": { $add: ["$a", 1] } } },
      { $group: { _id: "$__jsmql.var.t", all: { $push: CLEAR_ROOT } } },
    ]);
  });
});

let client: MongoClient | null = null;
let coll: Collection | null = null;

beforeAll(async () => {
  client = await liveClient();
  if (client === null) return;
  const c = client;
  coll = c.db("jsmql_compiler_statement").collection("t");
  await coll.deleteMany({});
  await coll.insertMany([
    { _id: 1, a: 2, b: 4, qty: 3, price: 5, sub: { k: 1, deep: { v: 1 } }, items: [1, 2] },
    { _id: 2, a: 9, b: 1, qty: 1, price: 2, sub: { k: 2, deep: { v: 2 } }, items: [] },
  ]);
  const orders = c.db("jsmql_compiler_statement").collection("orders");
  await orders.deleteMany({});
  await orders.insertMany([
    { _id: 10, a: 100, b: 1, audit: "x" },
    { _id: 11, a: null, b: 2 },
    { _id: 12, b: 3 },
  ]);
});

afterAll(async () => {
  await client?.close();
});

const run = (src: string): Promise<Record<string, unknown>[]> =>
  coll!.aggregate<Record<string, unknown>>(pipeline(src) as Record<string, unknown>[]).toArray();

describe("compiler/emit/statement — a computed key is a string, against the server's own answer", () => {
  it.skipIf(!up)("writes a number key as its text, as JavaScript does", async () => {
    expect(compiled("$.o = { [$.a]: 1 };")).toEqual([
      { $set: { o: { $arrayToObject: [[{ k: { $toString: { $ifNull: ["$a", ""] } }, v: 1 }]] } } },
    ]);
    expect((await run("$.o = { [$.a]: 1 };")).map((d) => d.o)).toEqual([{ "2": 1 }, { "9": 1 }]);
    expect(compiled("$.o = { [7]: 1, [true]: 2 };")).toEqual([
      {
        $set: {
          o: {
            $arrayToObject: [
              [
                { k: "7", v: 1 },
                { k: "true", v: 2 },
              ],
            ],
          },
        },
      },
    ]);
  });

  it.skipIf(!up)("writes and reads one key, so a count over numbers is correct", async () => {
    const got = await run("$.counts = $.items.reduce((acc, x) => ({ ...acc, [x]: (acc[x] ?? 0) + 1 }), {});");
    expect(got.map((d) => d.counts)).toEqual([{ "1": 1, "2": 1 }, {}]);
  });

  it.skipIf(!up)("keys the stream reducer wrap by the text of the field", async () => {
    const src = "$$ = [$$.reduce((acc, d) => ({ ...acc, [d._id]: d.a }), {})];";
    expect(compiled(src)).toEqual([
      { $group: { _id: null, __jsmqlTmp: { $push: { k: { $toString: { $ifNull: ["$_id", ""] } }, v: "$a" } } } },
      { $replaceWith: { $arrayToObject: "$__jsmqlTmp" } },
    ]);
    expect(await run(src)).toEqual([{ "1": 2, "2": 9 }]);
  });
});

const holdsNamespace = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(holdsNamespace)
    : typeof v === "object" && v !== null && v.constructor === Object
      ? Object.entries(v).some(([k, x]) => k.startsWith("__jsmql") || holdsNamespace(x))
      : false;

describe("compiler/emit/statement — the namespace, against the server's own answer", () => {
  it.skipIf(!up)("gives back no document that holds `__jsmql` at any depth", async () => {
    expect(NAMESPACE_FREE.length).toBeGreaterThan(0);
    for (const src of NAMESPACE_FREE) {
      const got = await run(src);
      expect(got.length, src).toBeGreaterThan(0);
      expect(holdsNamespace(got), `${src}\n${JSON.stringify(got)}`).toBe(false);
    }
  });
});

describe("compiler/emit/statement — a regex literal in MQL that you write is a BSON regex", () => {
  it("keeps the regex in a query document, in an operator's operand, and in a stage body", () => {
    expect(compiled("$match({ s: /^a/i });")).toEqual([{ $match: { s: /^a/i } }]);
    expect(compiled("$match({ s: { $in: [/^a/, /^b/] } });")).toEqual([{ $match: { s: { $in: [/^a/, /^b/] } } }]);
    expect(compiled("$match({ s: { $not: /^a/ } });")).toEqual([{ $match: { s: { $not: /^a/ } } }]);
    expect(compiled("$.m = $regexMatch({ input: $.s, regex: /^a/i });")).toEqual([
      { $set: { m: { $regexMatch: { input: "$s", regex: /^a/i } } } },
    ]);
    expect(compiled('$.m = { $regexMatch: { input: "$s", regex: /^a/ } };')).toEqual([
      { $set: { m: { $regexMatch: { input: "$s", regex: /^a/ } } } },
    ]);
    expect(compiled("$.m = $regexMatch({ input: $.s, regex: /^a/g });")).toEqual([
      { $set: { m: { $regexMatch: { input: "$s", regex: /^a/ } } } },
    ]);
  });

  it("stays refused in JavaScript code, and the message names both spellings", () => {
    const msg =
      "In JavaScript code, a regex literal is valid only as an argument of .match(), .test(), .exec(), .matchAll() or .search(). In MQL that you write, a regex literal is a BSON regex: '{ name: /^a/ }', '$regexMatch({ input: $.name, regex: /^a/ })'. To pass a pattern as a string, use a string literal.";
    expect(() => pipeline("$.m = /^a/;")).toThrow(msg);
    expect(() => pipeline("$.m = [/^a/];")).toThrow(msg);
    expect(() => pipeline("$match($.s === /^a/);")).toThrow(msg);
  });
});

describe("compiler/emit/statement — the server accepts every pipeline this file asserts", () => {
  it("asserts each allowance in a case above", () => {
    for (const src of [...Object.keys(NEEDS_MORE_THAN_A_SERVER), ...Object.keys(REFUSED_BY_ENVIRONMENT)]) {
      expect(RUNS, src).toContain(src);
    }
  });

  it.skipIf(!up)("runs each pipeline", async () => {
    const refused: string[] = [];
    const byEnvironment: string[] = [];
    let ran = 0;
    for (const src of RUNS) {
      if (src in NEEDS_MORE_THAN_A_SERVER) continue;
      try {
        await coll!.aggregate(pipeline(src) as Record<string, unknown>[]).toArray();
        ran++;
      } catch (e) {
        const message = (e as Error).message;
        const expected = REFUSED_BY_ENVIRONMENT[src];
        if (expected !== undefined && expected.test(message)) byEnvironment.push(src);
        else refused.push(`${src}\n  ${JSON.stringify(pipeline(src))}\n  ${message}`);
      }
    }
    expect(refused, `the server refused ${refused.length} of ${RUNS.length}:\n${refused.join("\n")}`).toEqual([]);
    expect(byEnvironment.sort()).toEqual(Object.keys(REFUSED_BY_ENVIRONMENT).sort());
    expect(ran + byEnvironment.length + Object.keys(NEEDS_MORE_THAN_A_SERVER).length).toBe(RUNS.length);
  });
});

describe("compiler/emit/statement — an empty key list, against the server's own answer", () => {
  it.skipIf(!up)("`.pick([])` makes each element `{}`", async () => {
    expect(await run("$$.pick([]);")).toEqual([{}, {}]);
    expect(await run("$ = $.pick([]);")).toEqual([{}, {}]);
    expect(await run('$$.flatMap("items").pick([]);')).toEqual([{ items: {} }, { items: {} }]);
  });

  it.skipIf(!up)("`.omit([])` keeps each document as it is", async () => {
    const docs = await coll!.find({}).toArray();
    expect(await run("$$.omit([]); $.x = 1;")).toEqual(docs.map((d) => ({ ...d, x: 1 })));
  });
});

describe("compiler/emit/statement — a reshape in a body over another collection, against the server's own answer", () => {
  it.skipIf(!up)("`o = $.pick([…])` there picks from the ROOT document, once for each order (HR4)", async () => {
    const got = await run('$.x = $$$.orders.aggregate(o => { o = $.pick(["a"]); });');
    expect(got.map((d) => d.x)).toEqual([
      [{ a: 2 }, { a: 2 }, { a: 2 }],
      [{ a: 9 }, { a: 9 }, { a: 9 }],
    ]);
  });

  it.skipIf(!up)("`o = o.pick([…])` there answers what the value road answers, for each order", async () => {
    const got = await run('$.x = $$$.orders.aggregate(o => { o = o.pick(["a"]); });');
    expect(got.map((d) => d.x)).toEqual([
      [{ a: 100 }, { a: null }, {}],
      [{ a: 100 }, { a: null }, {}],
    ]);
    for (const reshape of ['pick(["a"])', 'omit(["a"])', 'pick(["a", "b"]).omit(["b"])', "pick([])", "omit([])"]) {
      const stage = `$.x = $$$.orders.aggregate(o => { o = o.${reshape}; });`;
      const value = `$.x = $$$.orders.aggregate(o => { o = o?.${reshape}; });`;
      expect(pipeline(stage), reshape).not.toEqual(pipeline(value));
      expect(await run(stage), reshape).toEqual(await run(value));
    }
  });
});

describe("compiler/emit/statement — a root write of a provable array fans out", () => {
  it("an array-returning method on an unproven field is an array, so `$$ = $.items.map(…)` fans out", () => {
    expect(pipeline("$$ = $.items.map(x => ({ v: x }))")).toEqual([
      { $set: { "__jsmql.tmp.0": { $map: { input: { $ifNull: ["$items", []] }, as: "x", in: { v: "$$x" } } } } },
      { $unwind: "$__jsmql.tmp.0" },
      { $replaceWith: "$__jsmql.tmp.0" },
    ]);
    expect(pipeline("$ = $.items")).toEqual([{ $replaceWith: "$items" }]);
  });

  const slotted = (path: string) => [
    { $set: { "__jsmql.tmp.0": path } },
    { $unwind: "$__jsmql.tmp.0" },
    { $replaceWith: "$__jsmql.tmp.0" },
  ];
  it("a one-segment field path unwinds in place, and a dotted path uses the scratch slot", () => {
    expect(pipeline("$$ = $.items;")).toEqual([{ $unwind: "$items" }, { $replaceWith: "$items" }]);
    expect(pipeline("$$ = $.a.b;")).toEqual(slotted("$a.b"));
  });
  it.skipIf(!up)("the in-place fan-out gives the documents that the scratch slot gives", async () => {
    const fanout = client!.db("jsmql_compiler_statement").collection("fanout");
    await fanout.deleteMany({});
    await fanout.insertMany([
      { _id: 1, items: [{ n: 1 }, { n: 2 }], a: [{ b: { n: 3 } }, { b: { n: 4 } }] },
      { _id: 2, items: { n: 5 }, a: { b: [{ n: 6 }] } },
      { _id: 3, items: [] },
      { _id: 4, items: null },
      { _id: 5 },
    ]);
    const ns = async (stages: unknown[]) =>
      (await fanout.aggregate(stages as Record<string, unknown>[]).toArray()).map((d) => d.n).sort();
    expect(await ns(pipeline("$$ = $.items;"))).toEqual([1, 2, 5]);
    expect(await ns(slotted("$items"))).toEqual([1, 2, 5]);
    expect(await ns(pipeline("$$ = $.a.b;"))).toEqual([3, 4, 6]);
    expect(await ns([{ $unwind: "$a.b" }, { $replaceWith: "$a.b" }])).toEqual([6]);
  });
  it("a binding that holds an array-returning method's value is typed, so a read dispatches at compile time", () => {
    expect(pipeline('const ids = $.tags.uniq(); $.y = ids.has("a")')).toEqual([
      { $set: { "__jsmql.var.ids": { $setUnion: { $ifNull: ["$tags", []] } } } },
      { $set: { y: { $in: ["a", "$__jsmql.var.ids"] } } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe("compiler/emit/statement — the update spec's closed set, against the server's own answer", () => {
  const ALLOWED = statementBodyOf("$merge");
  const SERVER_ALLOWS: readonly string[] = [
    "$addFields",
    "$set",
    "$project",
    "$unset",
    "$replaceRoot",
    "$replaceWith",
    "$fill",
  ];

  const BODIES: Readonly<Record<string, unknown>> = {
    $addFields: { z: 1 },
    $set: { z: 1 },
    $project: { z: 1 },
    $unset: "qty",
    $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", { z: 1 }] } },
    $replaceWith: { $mergeObjects: ["$$ROOT", { z: 1 }] },
    $fill: { output: { a: { value: 0 } } },
    $match: { a: 2 },
    $limit: 1,
    $skip: 0,
    $sort: { a: 1 },
    $count: "n",
    $group: { _id: "$a" },
    $unwind: "$items",
    $sortByCount: "$a",
    $redact: "$$KEEP",
    $setWindowFields: { output: { w: { $count: {} } } },
    $bucketAuto: { groupBy: "$a", buckets: 1 },
    $sample: { size: 1 },
  };

  it("states in the row exactly the stages the server allows", () => {
    expect([...(ALLOWED as readonly string[])].sort()).toEqual([...SERVER_ALLOWS].sort());
  });

  it.skipIf(!up)("allows exactly what the server allows", async () => {
    const c = coll!;
    const serverAllows: string[] = [];
    for (const [name, body] of Object.entries(BODIES)) {
      try {
        await c.aggregate([{ $merge: { into: "update_spec_probe", whenMatched: [{ [name]: body }] } }]).toArray();
        serverAllows.push(name);
      } catch (e) {
        const m = (e as Error).message;
        expect(m, `'${name}' was refused for a reason other than the update spec`).toMatch(
          /is not allowed to be used within an update/,
        );
      }
    }
    expect([...serverAllows].sort()).toEqual([...SERVER_ALLOWS].sort());
    expect(SERVER_ALLOWS.filter((n) => !(n in BODIES))).toEqual([]);
  });

  it("refuses at compile time exactly the ones the server refuses", () => {
    for (const name of Object.keys(BODIES)) {
      const src = `$merge({ into: "c", whenMatched: [{ ${name}: ${JSON.stringify(BODIES[name])} }] });`;
      if (SERVER_ALLOWS.includes(name)) {
        expect(pipeline(src), name).toEqual([{ $merge: { into: "c", whenMatched: [{ [name]: BODIES[name] }] } }]);
      } else {
        expect(() => pipeline(src), name).toThrow(/cannot stand inside '\$merge'\. That body is an UPDATE/);
      }
    }
  });
});
