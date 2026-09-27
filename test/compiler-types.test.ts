// The type tracker: what the compiler proves about a written field, a `let`, a
// possible-kinds value — and what the server does with the document it emits.
//
// Each case states the MQL, and the live half runs that MQL on the project's own
// mongod, so the claim "this shape is valid and answers X" is measured, never
// assumed (HR3). The suite skips its live half when no mongod is listening.
// See docs/specs/types.md.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Double, MongoClient, type Collection } from "mongodb";
import { jsmql } from "../src/index.ts";
import { DOCUMENT, at, kindsOf, of, written } from "../src/compiler/emit/type.ts";
import { liveClient } from "./fixtures/live.ts";

const up = await liveClient();
await up?.close();

describe("types — a written field carries what its value proved", () => {
  it("an array write, then a boolean write: no `$switch`, and the boolean is its own truth", () => {
    expect(
      jsmql(`
        $.arr = $.tags.uniq();
        $.bool = $.arr.has("red");
        $.result = $.bool ? "R" : "OTHER";
      `),
    ).toEqual([
      { $set: { arr: { $setUnion: { $ifNull: ["$tags", []] } } } },
      { $set: { bool: { $in: ["red", "$arr"] } } },
      { $set: { result: { $cond: { if: "$bool", then: "R", else: "OTHER" } } } },
    ]);
  });

  it("a string write, then a string method: the method's own form, guarded only while the value may be missing", () => {
    expect(jsmql("$.s = $.a.trim(); $.t = $.s.toUpperCase();")).toEqual([
      { $set: { s: { $trim: { input: "$a" } } } },
      {
        $set: {
          t: { $cond: { if: { $eq: [{ $ifNull: ["$s", null] }, null] }, then: null, else: { $toUpper: "$s" } } },
        },
      },
    ]);
    // A literal is there: no guard at all.
    expect(jsmql('$.s = "abc"; $.t = $.s.toUpperCase();')).toEqual([
      { $set: { s: "abc" } },
      { $set: { t: { $toUpper: "$s" } } },
    ]);
  });

  it("a `let` takes the type of each value it is assigned", () => {
    expect(jsmql("let x = $.n + 1; x = $.s.trim(); $.len = x.length();")).toEqual([
      { $set: { "__jsmql.var.x": { $add: ["$n", 1] } } },
      { $set: { "__jsmql.var.x": { $trim: { input: "$s" } } } },
      {
        $set: {
          len: {
            $cond: {
              if: { $eq: [{ $ifNull: ["$__jsmql.var.x", null] }, null] },
              then: null,
              else: { $strLenCP: "$__jsmql.var.x" },
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("a method on a field proven to hold a kind the method has no form for is refused at compile time", () => {
    expect(() => jsmql('$.b = $.arr.has("x"); $.t = $.b.trim();')).toThrow(
      "'.trim()' is not available on a 'bool' — it is defined on 'string'.",
    );
  });

  it("a stage that replaces the document forgets every written type", () => {
    // `.indexOf` has two families. Over the two written kinds the `$switch` needs no default;
    // after the replacement `v` is unknown, so the null default is back.
    expect(jsmql('$.v = $.flag ? "abc" : [1, 2]; $ = { v: $.other }; $.i = $.v.indexOf("b");')).toEqual([
      {
        $set: {
          v: {
            $cond: {
              if: {
                $and: [
                  { $ne: [{ $ifNull: ["$flag", null] }, null] },
                  { $ne: ["$flag", false] },
                  { $ne: ["$flag", ""] },
                  { $ne: ["$flag", 0] },
                ],
              },
              then: "abc",
              else: [1, 2],
            },
          },
        },
      },
      { $replaceWith: { v: "$other" } },
      {
        $set: {
          i: {
            $switch: {
              branches: [
                { case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $indexOfArray: ["$v", "b"] } },
                { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $indexOfCP: ["$v", "b"] } },
              ],
              default: -1,
            },
          },
        },
      },
    ]);
  });
});

describe("types — a value of several possible kinds dispatches over those kinds alone", () => {
  // `.indexOf` is the method with two families, so it is the one that dispatches.
  it("two kinds the row covers, present: a `$switch` over the two, with no default", () => {
    expect(jsmql('$.v = $.flag ? "abc" : [1, 2]; $.i = $.v.indexOf("b");')[1]).toEqual({
      $set: {
        i: {
          $switch: {
            branches: [
              { case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $indexOfArray: ["$v", "b"] } },
              { case: { $in: [{ $type: "$v" }, ["string"]] }, then: { $indexOfCP: ["$v", "b"] } },
            ],
          },
        },
      },
    });
  });

  it("a kind the row has no form for keeps the null default", () => {
    expect(jsmql('$.v = $.flag ? 5 : [1, 2]; $.i = $.v.indexOf("b");')[1]).toEqual({
      $set: {
        i: {
          $switch: {
            branches: [{ case: { $in: [{ $type: "$v" }, ["array"]] }, then: { $indexOfArray: ["$v", "b"] } }],
            default: -1,
          },
        },
      },
    });
  });

  it("a method of one family takes that family's operator while the value may be of that kind", () => {
    // `.length()` is a string length. The value may be a string, so the string form runs, and the
    // server judges an array at run time. A value that can NEVER be a string is refused.
    expect(jsmql('$.v = $.flag ? "abc" : [1, 2]; $.len = $.v.length();')[1]).toEqual({
      $set: { len: { $strLenCP: "$v" } },
    });
    expect(() => jsmql("$.v = $.flag ? 5 : [1, 2]; $.len = $.v.length();")).toThrow(
      "'.length()' is not available on a 'number' or an 'array' — it is defined on 'string'.",
    );
    expect(() => jsmql("$.v = [1, 2]; $.len = $.v.length();")).toThrow("For the number of elements, write '.size()'.");
  });
});

describe("types — the write rules", () => {
  it("a whole-field write replaces the field's proof", () => {
    const doc = written(written(DOCUMENT, "a", of("string")), "a", of("number"));
    expect(kindsOf(at(doc, "a"))).toEqual(["number"]);
  });

  it("a dotted write keeps the parent's other properties and makes the parent present", () => {
    // `address` was never written whole, so it may be an array: each property is then
    // the string written, or the list of strings the array form carries (measured below).
    const doc = written(written(DOCUMENT, "address.country", of("string")), "address.full", of("string"));
    expect(kindsOf(at(doc, "address.country"))?.sort()).toEqual(["array", "string"]);
    expect(kindsOf(at(doc, "address.full"))?.sort()).toEqual(["array", "string"]);
    expect(at(doc, "address").absent).toBe(false);
    // A parent written whole as an object first is an object, and its properties are exact.
    const known = written(written(DOCUMENT, "address", of("object")), "address.full", of("string"));
    expect(kindsOf(at(known, "address.full"))).toEqual(["string"]);
  });

  it("a dotted write into an unknown parent may land on an object or into every element of an array", () => {
    // MEASURED below: `{ $set: { "a.b": 1 } }` makes a scalar `a` into `{ b: 1 }` and
    // writes `b` into each element of an array `a`. So `a.b` is a number or a list of them.
    const doc = written(DOCUMENT, "a.b", of("number"));
    expect(kindsOf(at(doc, "a"))?.sort()).toEqual(["array", "object"]);
    expect(kindsOf(at(doc, "a.b"))?.sort()).toEqual(["array", "number"]);
  });
});

describe.skipIf(up === null)("types — the server agrees", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("t");
  });
  afterAll(async () => {
    await client?.close();
  });

  it("the array-then-boolean program answers as JavaScript would", async () => {
    await coll.deleteMany({});
    await coll.insertMany([{ _id: 1, tags: ["red", "blue", "red"] }, { _id: 2, tags: ["blue"] }, { _id: 3 }]);
    const out = await coll
      .aggregate([
        ...(jsmql('$.arr = $.tags.uniq(); $.bool = $.arr.has("red"); $.result = $.bool ? "R" : "OTHER";') as object[]),
        { $sort: { _id: 1 } },
      ])
      .toArray();
    expect(out.map((d) => d.result)).toEqual(["R", "OTHER", "OTHER"]);
    expect(out.map((d) => d.bool)).toEqual([true, false, false]);
  });

  it("a default-less `$switch` over two present kinds runs on both", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, flag: true },
      { _id: 2, flag: false },
    ]);
    const out = await coll
      .aggregate([
        ...(jsmql('$.v = $.flag ? "abc" : [1, 2]; $.i = $.v.indexOf("b");') as object[]),
        { $sort: { _id: 1 } },
      ])
      .toArray();
    expect(out.map((d) => d.i)).toEqual([1, -1]);
  });

  it("a dotted `$set` lands on a scalar as an object and into every element of an array", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, a: 5 },
      { _id: 2, a: { c: 1 } },
      { _id: 3 },
      { _id: 4, a: [1, 2] },
      { _id: 5, a: [{ x: 1 }, { x: 2 }] },
    ]);
    const out = await coll.aggregate([...(jsmql("$.a.b = 1;") as object[]), { $sort: { _id: 1 } }]).toArray();
    expect(out.map((d) => d.a)).toEqual([
      { b: 1 },
      { c: 1, b: 1 },
      { b: 1 },
      [{ b: 1 }, { b: 1 }],
      [
        { x: 1, b: 1 },
        { x: 2, b: 1 },
      ],
    ]);
  });

  it("a `let` assigned again reads as its new value", async () => {
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, n: 1, s: "  ab  " },
      { _id: 2, n: 1 },
    ]);
    const out = await coll
      .aggregate([
        ...(jsmql("let x = $.n + 1; x = $.s.trim(); $.len = x.length();") as object[]),
        { $sort: { _id: 1 } },
      ])
      .toArray();
    expect(out.map((d) => d.len)).toEqual([2, null]);
  });
});

describe("types — the truthiness check keeps only the tests the value can fail", () => {
  it("a string keeps the empty-string test, and the null test while it may be missing", () => {
    expect(jsmql("$.s = $.a.trim(); $.t = $.s ? 1 : 2;")[1]).toEqual({
      $set: {
        t: {
          $cond: { if: { $and: [{ $ne: [{ $ifNull: ["$s", null] }, null] }, { $ne: ["$s", ""] }] }, then: 1, else: 2 },
        },
      },
    });
    expect(jsmql('$.u = "x"; $.v = $.u ? 1 : 2;')[1]).toEqual({
      $set: { v: { $cond: { if: { $ne: ["$u", ""] }, then: 1, else: 2 } } },
    });
  });

  it("a boolean or a number is its own truth; an array that is there needs no test at all", () => {
    expect(jsmql("$.n = $.a.length(); $.x = $.n ? 1 : 2;")[1]).toEqual({
      $set: { x: { $cond: { if: "$n", then: 1, else: 2 } } },
    });
    expect(jsmql("$.arr = [1]; $.w = $.arr ? 1 : 2;")[1]).toEqual({ $set: { w: 1 } });
  });

  it("in a filter, a bare field with a known type takes the query form", () => {
    expect(jsmql("$.b = $.n > 1; $match($.b);")[1]).toEqual({ $match: { b: true } });
    expect(jsmql("$.s = $.a.trim(); $match($.s);")[1]).toEqual({ $match: { s: { $nin: [null, ""] } } });
    expect(jsmql("$.n = $.a.length(); $match($.n);")[1]).toEqual({ $match: { n: { $nin: [null, 0] } } });
    expect(jsmql("$.o = { a: 1 }; $match($.o);")[1]).toEqual({ $match: {} });
    // a value that may be an array stays on the `$expr` road: the query language reads an array element by element
    expect(jsmql("$.v = $.flag ? 0 : [0]; $match($.v);")[1]).toEqual({ $match: { $expr: { $ne: ["$v", 0] } } });
  });
});

describe.skipIf(up === null)("types — the server agrees with the truthiness check", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("truth");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, a: "  x  ", n: 2, flag: true },
      { _id: 2, a: "    ", n: 0, flag: false },
      { _id: 3 },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  const run = async (src: string, field: string): Promise<unknown[]> => {
    const out = await coll.aggregate([...(jsmql(src) as object[]), { $sort: { _id: 1 } }]).toArray();
    return out.map((d) => d[field]);
  };

  it("answers as JavaScript would on a string, a number, a boolean and a present array", async () => {
    // JS: "x" → 1, "" → 2, missing → 2
    expect(await run("$.s = $.a.trim(); $.t = $.s ? 1 : 2;", "t")).toEqual([1, 2, 2]);
    // JS: 2 → 1, 0 → 2, missing (null) → 2
    expect(await run("$.x = $.n ? 1 : 2;", "x")).toEqual([1, 2, 2]);
    expect(await run("$.arr = [1]; $.w = $.arr ? 1 : 2;", "w")).toEqual([1, 1, 1]);
  });

  it("the query forms select the documents JavaScript keeps", async () => {
    const ids = async (src: string): Promise<unknown[]> =>
      (await coll.aggregate([...(jsmql(src) as object[]), { $sort: { _id: 1 } }]).toArray()).map((d) => d._id);
    expect(await ids("$.b = $.n > 1; $match($.b);")).toEqual([1]);
    expect(await ids("$.s = $.a.trim(); $match($.s);")).toEqual([1]);
    expect(await ids("$.m = $.n; $match($.flag);")).toEqual([1]);
  });
});

describe("types — the document after a stage, read off the stage itself", () => {
  it("`$group` types each output by its accumulator, and `_id` by its expression", () => {
    expect(
      jsmql(
        "$group({ _id: $.k, total: $sum($.amount), items: $push($.item) }); $.t = $.total ? 1 : 2; $.n = $.items.size();",
      ),
    ).toEqual([
      { $group: { _id: "$k", total: { $sum: "$amount" }, items: { $push: "$item" } } },
      { $set: { t: { $cond: { if: "$total", then: 1, else: 2 } } } },
      { $set: { n: { $size: "$items" } } },
    ]);
  });

  it("`$ = <expr>` makes the value's shape the document", () => {
    expect(jsmql('$.p = { a: 1, b: "x" }; $ = $.p; $.c = $.b.length();')).toEqual([
      { $set: { p: { $mergeObjects: [{ a: 1, b: "x" }] } } },
      { $replaceWith: "$p" },
      { $set: { c: { $strLenCP: "$b" } } },
    ]);
  });

  it("`.flatMap(<field>)` makes the field its element", () => {
    expect(jsmql('$.items = [{ q: 1 }]; $$.flatMap("items"); $.d = $.items.q + 1;')).toEqual([
      { $set: { items: [{ q: 1 }] } },
      { $unwind: "$items" },
      { $set: { d: { $add: ["$items.q", 1] } } },
    ]);
  });

  it("a `$project` inclusion keeps the named fields' types and closes the document; an exclusion removes its fields", () => {
    expect(jsmql('$.a = "x"; $.b = 1; $ = $.pick(["a"]); $.n = $.a.length();')).toEqual([
      { $set: { a: "x" } },
      { $set: { b: 1 } },
      { $project: { a: 1, _id: 0 } },
      { $set: { n: { $strLenCP: "$a" } } },
    ]);
    // The document holds `a` alone, so a read of `b` gives no value.
    expect(() => jsmql('$.a = "x"; $.b = 1; $ = $.pick(["a"]); $.m = $.b ? 1 : 2;')).toThrow(
      "'$.b' reads a field that the document does not have. It holds 'a'.",
    );
    // An exclusion leaves the document open, and `a` certainly missing.
    expect(jsmql('$.a = "x"; $project({ a: 0 }); $.n = $.a ? 1 : 2;')[2]).toEqual({ $set: { n: 2 } });
  });

  it("a stage whose output no layout states yet leaves the document unknown", () => {
    // `a` was a present string; after the stage it may be missing, so the null guard is back.
    expect(jsmql('$.a = "x"; $sortByCount($.a); $.n = $.a.length();')[2]).toEqual({
      $set: { n: { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $strLenCP: "$a" } } } },
    });
  });

  it("each link of a stream chain reads the document that the link before it made", () => {
    // The `$set` link wrote `a` from a field the proof cannot show, so the `.map` link guards the read.
    expect(jsmql('$.a = "x"; $$.$set({ a: $.label }).map(d => ({ n: $.a.length() }));')).toEqual([
      { $set: { a: "x" } },
      { $set: { a: "$label" } },
      {
        $replaceWith: {
          n: { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $strLenCP: "$a" } } },
        },
      },
    ]);
    // A link that replaced the document took the `let` field with it, as a stage statement does.
    expect(() => jsmql("let t = $.a; $$.map(d => ({ x: 1 })).filter(d => d.x === t);")).toThrow(
      "`t` is a `let` binding. It cannot be read after `$replaceWith`, because that stage replaced the document that carried it.",
    );
    // `.uniq()` gives the documents back as they were, so the `let` field is still there.
    expect(() => jsmql("let t = $.a; $$.uniq().filter(d => d.x === t);")).not.toThrow();
  });

  it("the statement after a chain reads the Env that the chain's last link left", () => {
    // `.uniq()` gives the documents back as they were. The `let` field is still on them, so a
    // later link and a later statement read it, and the cleanup drops it at the end.
    const kept = [
      { $set: { "__jsmql.var.t": "$a" } },
      { $group: { _id: "$$ROOT" } },
      { $replaceWith: "$_id" },
      { $match: { $expr: { $eq: ["$x", "$__jsmql.var.t"] } } },
      { $unset: "__jsmql" },
    ];
    expect(jsmql("let t = $.a; $$.uniq().filter(d => d.x === t);")).toEqual(kept);
    expect(jsmql("let t = $.a; $$.uniq(); $match($.x === t);")).toEqual(kept);
    expect(jsmql("let t = $.a; $$ = $$.uniq(); $match($.x === t);")).toEqual(kept);
    expect(jsmql("let t = $.a; $$ = $$.uniq().filter(d => d.x === t);")).toEqual(kept);
    // Each row that states `restoresDocuments` keeps the binding.
    for (const link of ['uniqBy("x")', "sortedUniq()", 'sortedUniqBy("x")']) {
      expect((jsmql(`let t = $.a; $$.${link}; $match($.x === t);`) as object[]).slice(-2)).toEqual(kept.slice(-2));
    }
    // The element after `.flatMap` stays for the next statement: `x` is the unwound id.
    expect(jsmql('$$.flatMap("ids").uniq(); $$.map(x => ({ v: x * 2 }));')).toEqual([
      { $unwind: "$ids" },
      { $group: { _id: "$ids", __jsmqlTmp: { $first: "$$ROOT" } } },
      { $replaceWith: "$__jsmqlTmp" },
      { $replaceWith: { v: { $multiply: ["$ids", 2] } } },
    ]);
    // The cleanup stands ahead of the stage that writes the stream to a collection.
    expect(jsmql("let t = $.a; $$$.out = $$.uniq();")).toEqual([...kept.slice(0, 3), kept[4], { $out: "out" }]);
    expect(jsmql("let t = $.a; $$$.c.concat($$.uniq());")).toEqual([...kept.slice(0, 3), kept[4], { $merge: "c" }]);
  });

  it("a scratch field that a stage writes after a replace is still cleaned up", () => {
    // `.shuffle()` writes its sort key after `.map` replaced the document.
    expect(jsmql("$$.map(d => ({ a: d.a })).shuffle();")).toEqual([
      { $replaceWith: { a: "$a" } },
      { $addFields: { "__jsmql.tmp.0": { $rand: {} } } },
      { $sort: { "__jsmql.tmp.0": 1 } },
      { $unset: "__jsmql" },
    ]);
    // The stream count lands after `$ = …` in the same run.
    expect(jsmql("$ = { a: $.a }, $.n = $$.size();")).toEqual([
      { $replaceWith: { a: "$a" } },
      { $setWindowFields: { output: { "__jsmql.size": { $count: {} } } } },
      { $set: { n: "$__jsmql.size" } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a write run takes each stage in the order that the stages stand", () => {
    // A write after `$ = …` cannot read the `let` that the stage took, as the next statement cannot.
    expect(() => jsmql("let t = $.a; $ = { a: $.a }, $.x = t;")).toThrow(
      "`t` is a `let` binding. It cannot be read after `$replaceWith`, because that stage replaced the document that carried it.",
    );
    // A write after the stage carries the `let` again, and the next statement reads it.
    expect(jsmql("let t = $.a; $ = { a: $.a }, t = 1; $.y = t;")).toEqual([
      { $set: { "__jsmql.var.t": "$a" } },
      { $replaceWith: { a: "$a" } },
      { $set: { "__jsmql.var.t": 1 } },
      { $set: { y: "$__jsmql.var.t" } },
      { $unset: "__jsmql" },
    ]);
  });
});

describe.skipIf(up === null)("types — the server agrees with the stage effects", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("stages");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, k: "a", amount: 5, item: "x" },
      { _id: 2, k: "a", amount: 7, item: "y" },
      { _id: 3, k: "b", amount: 0, item: "z" },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("the grouped program answers as JavaScript would", async () => {
    const out = await coll
      .aggregate([
        ...(jsmql(
          "$group({ _id: $.k, total: $sum($.amount), items: $push($.item) }); $.t = $.total ? 1 : 2; $.n = $.items.size();",
        ) as object[]),
        { $sort: { _id: 1 } },
      ])
      .toArray();
    expect(out).toEqual([
      { _id: "a", total: 12, items: ["x", "y"], t: 1, n: 2 },
      { _id: "b", total: 0, items: ["z"], t: 2, n: 1 },
    ]);
  });

  it("the projected program answers as JavaScript would, and the read it refuses gives no value", async () => {
    const out = await coll
      .aggregate([
        ...(jsmql('$.a = "x"; $.b = 1; $ = $.pick(["a"]); $.n = $.a.length();') as object[]),
        // The read `$.b` that the compiler refuses after the projection, written as raw MQL.
        { $set: { m: "$b" } },
        { $limit: 1 },
      ])
      .toArray();
    expect(out).toEqual([{ a: "x", n: 1 }]);
  });

  it("the chain link after a `$set` answers as JavaScript would", async () => {
    // No fixture document has `label`, so `a` is missing after the `$set`, and `.length()` answers null.
    const out = await coll
      .aggregate(jsmql('$.a = "x"; $$.$set({ a: $.label }).map(d => ({ n: $.a.length() }));') as object[])
      .toArray();
    expect(out).toEqual([{ n: null }, { n: null }, { n: null }]);
  });

  it("a `let` read after `.uniq()` answers as JavaScript would, and no scratch field reaches the answer", async () => {
    const answer = async (source: string, by: string): Promise<unknown[]> =>
      await coll.aggregate([...(jsmql(source) as object[]), { $sort: { [by]: 1 } }]).toArray();
    // The two `{ k: "a" }` documents are one after `.uniq()`.
    expect(await answer("$$.map(d => ({ k: d.k })); let t = $.k; $$.uniq().filter(d => d.k === t);", "k")).toEqual([
      { k: "a" },
      { k: "b" },
    ]);
    expect(await answer("let t = $.amount; $$.uniq(); $match($.amount === t);", "_id")).toEqual([
      { _id: 1, k: "a", amount: 5, item: "x" },
      { _id: 2, k: "a", amount: 7, item: "y" },
      { _id: 3, k: "b", amount: 0, item: "z" },
    ]);
  });

  it("a scratch field that a stage writes after a replace does not reach the answer", async () => {
    const answer = async (source: string): Promise<unknown[]> =>
      await coll.aggregate([...(jsmql(source) as object[]), { $sort: { k: 1 } }]).toArray();
    expect(await answer("$$.map(d => ({ k: d.k })).shuffle();")).toEqual([{ k: "a" }, { k: "a" }, { k: "b" }]);
    expect(await answer("$ = { k: $.k }, $.n = $$.size();")).toEqual([
      { k: "a", n: 3 },
      { k: "a", n: 3 },
      { k: "b", n: 3 },
    ]);
  });
});

describe.skipIf(up === null)(
  "types — the server agrees: a link that gives the documents back gives them as they were",
  () => {
    let client: MongoClient;
    let coll: Collection;
    beforeAll(async () => {
      client = (await liveClient())!;
      coll = client.db("jsmql_compiler_types").collection("restores");
      await coll.deleteMany({});
      await coll.insertMany([
        {
          _id: 1,
          a: 2,
          ids: [3, 1, 2, 2],
          items: [
            { sku: "a", qty: 5 },
            { sku: "b", qty: 1 },
          ],
        },
        { _id: 2, a: 1, ids: [1], items: [{ sku: "c", qty: 2 }] },
      ]);
    });
    afterAll(async () => {
      await client?.close();
    });

    it("the link after `.intersection()` reads the unwound value, as lodash does", async () => {
      const answer = async (source: string, by: string): Promise<unknown[]> =>
        await coll.aggregate([...(jsmql(source) as object[]), { $sort: { [by]: 1 } }]).toArray();
      // lodash: `_.intersection([3, 1, 2, 2, 1], [1, 2])` is `[1, 2]`.
      expect(await answer('$$.flatMap("ids").intersection([1, 2]).map(x => ({ v: x * 10 }));', "v")).toEqual([
        { v: 10 },
        { v: 20 },
      ]);
      expect(
        await answer('$$.flatMap("items").intersectionBy([{ sku: "a" }], "sku").map(i => ({ q: i.qty }));', "q"),
      ).toEqual([{ q: 5 }]);
    });

    it("a `let` read after `.intersection()` answers as JavaScript would, and no scratch field reaches the answer", async () => {
      const out = await coll
        .aggregate(jsmql('let t = $.a; $$.flatMap("ids").intersection([2]).filter(x => x === t);') as object[])
        .toArray();
      expect(out).toEqual([
        {
          _id: 1,
          a: 2,
          ids: 2,
          items: [
            { sku: "a", qty: 5 },
            { sku: "b", qty: 1 },
          ],
        },
      ]);
    });

    it("`.uniq()` on whole documents gives back the first of two equal documents", async () => {
      // An int and a double of one value compare equal, so `.uniq()` keeps one document,
      // and lodash keeps the first one. `$type` shows which document came back.
      const pair = client.db("jsmql_compiler_types").collection("first_kept");
      await pair.deleteMany({});
      await pair.insertMany([
        { _id: 1, v: 1 },
        { _id: 2, v: new Double(1) },
      ]);
      const kept = async (order: string): Promise<unknown[]> =>
        await pair
          .aggregate(jsmql(`$$.${order}.map(d => ({ v: d.v })).uniq(); $.t = $type($.v);`) as object[])
          .toArray();
      expect(await kept('sortBy("_id")')).toEqual([{ v: 1, t: "int" }]);
      expect(await kept('orderBy("_id", "desc")')).toEqual([{ v: 1, t: "double" }]);
    });
  },
);

describe("types — a call's result follows its row's `returns` term", () => {
  it("`.map(f)` proves an array of what the callback returns", () => {
    expect(jsmql("$.names = $.tags.map(t => t.trim()); $.n = $.names[0].length();")[1]).toEqual({
      $set: {
        n: {
          $let: {
            vars: { jsmqlRecv: { $arrayElemAt: ["$names", 0] } },
            in: {
              $cond: {
                if: { $eq: [{ $ifNull: ["$$jsmqlRecv", null] }, null] },
                then: null,
                else: { $strLenCP: "$$jsmqlRecv" },
              },
            },
          },
        },
      },
    });
  });

  it("a spread and `.assign()` merge object shapes, so a merged property has its type", () => {
    expect(jsmql("const addr1 = { ...$.address, done: true }; $.r = addr1.done ? 1 : 2;")[1]).toEqual({
      $set: { r: { $cond: { if: "$__jsmql.var.addr1.done", then: 1, else: 2 } } },
    });
    expect(jsmql("$.a2 = $.address.assign({ done: true }); $.r = $.a2.done ? 1 : 2;")[1]).toEqual({
      $set: { r: { $cond: { if: "$a2.done", then: 1, else: 2 } } },
    });
  });

  it("`.pick()` keeps the named properties and nothing else", () => {
    expect(jsmql('$.o = { a: "x", b: 1 }; $.p = $.o.pick(["a"]); $.n = $.p.a.length();').slice(2)).toEqual([
      { $set: { n: { $strLenCP: "$p.a" } } },
    ]);
    expect(() => jsmql('$.o = { a: "x", b: 1 }; $.p = $.o.pick(["a"]); $.m = $.p.b ? 1 : 2;')).toThrow(
      "'$.p.b' reads a field that '$.p' does not have. It holds 'a'.",
    );
  });

  it("`.filter(p)` keeps the elements; `.head()` may find nothing, so a property of it may be missing", () => {
    expect(
      jsmql('$.items = [{ q: "s" }]; $.first = $.items.filter(i => i.q).head(); $.n = $.first.q.length();')[2],
    ).toEqual({
      $set: {
        n: {
          $cond: { if: { $eq: [{ $ifNull: ["$first.q", null] }, null] }, then: null, else: { $strLenCP: "$first.q" } },
        },
      },
    });
  });
});

describe("types — a `$match` narrows the document for the statements after it", () => {
  it("a presence test drops the null guard downstream", () => {
    expect(
      jsmql(
        '$match($.tags != null); $.arr = $.tags.uniq(); $.bool = $.arr.has("red"); $.result = $.bool ? "R" : "OTHER";',
      ),
    ).toEqual([
      { $match: { tags: { $ne: null } } },
      { $set: { arr: { $setUnion: "$tags" } } },
      { $set: { bool: { $in: ["red", "$arr"] } } },
      { $set: { result: { $cond: { if: "$bool", then: "R", else: "OTHER" } } } },
    ]);
  });

  it("a `typeof` test and an equality prove the kind; a comparison proves its literal's kind, in its type bracket", () => {
    expect(jsmql('$match(typeof $.b === "string"); $.u = $.b.trim();')[1]).toEqual({
      $set: { u: { $trim: { input: "$b" } } },
    });
    expect(jsmql('$$.filter({ status: "a" }); $.s = $.status.toUpperCase();')[1]).toEqual({
      $set: { s: { $toUpper: "$status" } },
    });
    // `n` is a number, or an array holding one (the query language reads an array element by element):
    // a number owes only the zero test, an array none, and neither can be missing.
    expect(jsmql("$match($.n > 5); $.x = $.n ? 1 : 2;")[1]).toEqual({
      $set: { x: { $cond: { if: { $ne: ["$n", 0] }, then: 1, else: 2 } } },
    });
  });

  it("an `||` proves nothing; `$expr` proves nothing", () => {
    expect(jsmql("$match($.x === 5 || $.y > 1); $.z = $.x ? 1 : 2;")[1]).toEqual({
      $set: {
        z: {
          $cond: {
            if: {
              $and: [
                { $ne: [{ $ifNull: ["$x", null] }, null] },
                { $ne: ["$x", false] },
                { $ne: ["$x", ""] },
                { $ne: ["$x", 0] },
              ],
            },
            then: 1,
            else: 2,
          },
        },
      },
    });
  });
});

describe.skipIf(up === null)("types — the server agrees with the narrowing", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("narrow");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, tags: ["red", "blue"], n: 7, s: " a " },
      { _id: 2, tags: ["blue"], n: 9, s: "b" },
      { _id: 3, n: "x", s: 5 },
      { _id: 4, tags: null, n: [1, 8] },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  const run = async (src: string): Promise<unknown[]> =>
    coll.aggregate([...(jsmql(src) as object[]), { $sort: { _id: 1 } }]).toArray();

  it("only the selected documents reach the narrowed stages, and they answer as JavaScript would", async () => {
    const a = await run(
      '$match($.tags != null); $.arr = $.tags.uniq(); $.bool = $.arr.has("red"); $.result = $.bool ? "R" : "OTHER";',
    );
    expect(a.map((d) => [d._id, d.result])).toEqual([
      [1, "R"],
      [2, "OTHER"],
    ]);
    // `n > 5` selects 7, 9 and the array holding 8 — never the string
    const b = await run("$match($.n > 5); $.x = $.n ? 1 : 2;");
    expect(b.map((d) => [d._id, d.x])).toEqual([
      [1, 1],
      [2, 1],
      [4, 1],
    ]);
    const c = await run('$match(typeof $.s === "string"); $.u = $.s.trim();');
    expect(c.map((d) => d.u)).toEqual(["a", "b"]);
  });
});

describe("types — a refusal reads the whole kind set", () => {
  // "Possible" is not "proven": a value that MAY be a document passes, and the server judges.
  // A value that can NEVER be one is refused, and the message names every kind it can be.
  it("a root write, a stream source, a spread, a union and a merge refuse a value that cannot fit", () => {
    expect(jsmql("$.x = $.f ? { a: 1 } : 5; $ = $.x;")[1]).toEqual({ $replaceWith: "$x" });
    expect(() => jsmql('$.x = $.f ? "s" : 5; $ = $.x;')).toThrow("a string or a number is not one");
    expect(() => jsmql('$.x = $.f ? [1] : ["x"]; $$ = $.x;')).toThrow("these elements are numbers or strings");
    expect(() => jsmql('$.x = $.f ? "abc" : 5; $.y = [...$.x];')).toThrow(
      "'...' in an array spreads an ARRAY, and this value is a string or a number.",
    );
    expect(() => jsmql("$.x = 5; $.y = { ...$.x };")).toThrow(
      "'...' in an object spreads a DOCUMENT's fields, and this value is a number.",
    );
    // a string keeps its own message, which names the character-wise spelling
    expect(() => jsmql('$.x = "abc"; $.y = [...$.x];')).toThrow("spreads a string into its characters");
    expect(() => jsmql("$.n = 5; $$$.out.push($.n);")).toThrow("a number is not a document");
    expect(() => jsmql("$.b = $.f ? 1 : true; $$.push($.b);")).toThrow("this is a number or a boolean");
    expect(() => jsmql("$$ = $.tags.map(t => t.length());")).toThrow("these elements are numbers");
  });
});

describe("types — a read that the proof shows gives no value is refused", () => {
  // Each row: the entry, the source, the whole message, and the text the caret lands on.
  const REFUSED: [entry: "expr" | "pipeline", src: string, message: string, at: string][] = [
    // a field of an array, a string or another scalar
    [
      "expr",
      "$.tags.uniq().size",
      "'.size' reads a field, and an array has no fields. Write '.size()' to call the method.",
      ".size",
    ],
    [
      "expr",
      "$.tags.uniq().length",
      "'.length' reads a field, and an array has no fields. For the number of elements, write '.size()'.",
      ".length",
    ],
    [
      "expr",
      "$.items.uniq().total",
      "'.total' reads a field, and an array has no fields. To read the field of each element, write '.map(e => e.total)'.",
      ".total",
    ],
    [
      "expr",
      '$.csv.split(",")["length"]',
      `'["length"]' reads a field, and an array has no fields. For the number of elements, write '.size()'.`,
      '["length"]',
    ],
    [
      "expr",
      "$.name.trim().length",
      "'.length' reads a field, and a string has no fields. Write '.length()' to call the method.",
      ".length",
    ],
    [
      "expr",
      "[1, 2].length",
      "'.length' reads a field, and an array has no fields. For the number of elements, write '.size()'.",
      ".length",
    ],
    [
      "expr",
      '$.at.startOf("day").year',
      "'.year' reads a field, and a date has no fields. Call a method instead, for example '.getFullYear()'.",
      ".year",
    ],
    [
      "pipeline",
      "$.n = 1; $.y = $.n.value;",
      "'$.n.value' reads a field, and a number has no fields. Call a method instead, for example '.round()'.",
      "$.n.value",
    ],
    // a field that a closed object does not hold
    ["expr", '$.o.pick(["a"]).b', "'.b' reads a field that this object does not have. It holds 'a'.", ".b"],
    [
      "expr",
      '$.o.pick(["a"]).keys',
      "'.keys' reads a field that this object does not have. It holds 'a'. Write '.keys()' to call the method.",
      ".keys",
    ],
    [
      "pipeline",
      "$group({ _id: $.k, n: $sum(1) }); $.y = $.total;",
      "'$.total' reads a field that the document does not have. It holds '_id', 'n'.",
      "$.total",
    ],
    [
      "pipeline",
      "$group({ _id: $.k, n: $sum(1) }); $match($.total > 5);",
      "'$.total' reads a field that the document does not have. It holds '_id', 'n'.",
      "$.total",
    ],
    [
      "pipeline",
      "$group({ _id: $.k, n: $sum(1) }); $$.filter(d => d.total > 5);",
      "'.total' reads a field that 'd' does not have. It holds '_id', 'n'.",
      ".total",
    ],
    [
      "pipeline",
      '$group({ _id: $.k, n: $sum(1) }); $$.sortBy("total");',
      "'total' reads a field that the document does not have. It holds '_id', 'n'.",
      '"total"',
    ],
    [
      "pipeline",
      '$.p = $$$.products.pick(["_id", "name"]).filter(p => p.price > 1);',
      "'.price' reads a field that 'p' does not have. It holds '_id', 'name'.",
      ".price",
    ],
    // a query path through an array whose elements cannot hold the field
    [
      "pipeline",
      '$.tags = $.csv.split(","); $match($.tags.length > 0);',
      "'$.tags.length' reads a field, and an array has no fields. For the number of elements, write '.size()'.",
      "$.tags.length",
    ],
    [
      "pipeline",
      "$.items = [{ q: 1 }]; $match($.items.z === 1);",
      "'$.items.z' reads a field that the elements of '$.items' do not have. They hold 'q'.",
      "$.items.z",
    ],
    // a shorthand's parameter is named by what it stands for
    [
      "pipeline",
      '$$.map(o => ({ id: o.id })).filter({ type: "a" });',
      "'.type' reads a field that the document does not have. It holds 'id'.",
      ".filter",
    ],
    [
      "pipeline",
      '$.items = [{ q: 1 }]; $.s = $.items.sortBy("z");',
      "'z' reads a field that the element does not have. It holds 'q'.",
      '"z"',
    ],
    // a value that is always null or missing
    [
      "pipeline",
      "$.a = null; $.b = $.a.c;",
      "'$.a' is always null or missing here, so '$.a.c' has no value to read. Remove the read, or write a value before the read.",
      "$.a.c",
    ],
    [
      "pipeline",
      '$.a = "x"; $unset("a"); $.n = $.a.length();',
      "'$.a' is always null or missing here, so '.length()' has no value to read. Remove the read, or write a value before the read.",
      ".length",
    ],
  ];

  it.each(REFUSED)("%s: %s", (entry, src, message, at) => {
    expect(() => jsmql[entry](src)).toThrow(message);
    const result = jsmql.validate(src);
    expect(result.errors.map((e) => [e.message, e.pos])).toEqual([[message, src.indexOf(at)]]);
  });

  it("a read that the proof cannot rule out compiles", () => {
    // Nothing is known about `a`, so `.length` reads its field `length` (HR5).
    expect(jsmql.expr("$.a.length")).toBe("$a.length");
    expect(jsmql.expr("$.a.b.c")).toBe("$a.b.c");
    expect(jsmql("$group({ _id: $.k, n: $sum(1) }); $.y = $.n + 1;")[1]).toEqual({ $set: { y: { $add: ["$n", 1] } } });
    // A value of several kinds, or an open object, can hold the field.
    expect(jsmql('$.v = $.flag ? "s" : { a: 1 }; $.y = $.v.a;')[1]).toEqual({ $set: { y: "$v.a" } });
    expect(jsmql("$.o = { a: 1, ...$.rest }; $.y = $.o.b;")[1]).toEqual({ $set: { y: "$o.b" } });
    // A query keeps MongoDB's path through an array (SR2), where an element can hold the field.
    expect(jsmql('$.orders = $$$.orders.filter(o => o.uid === $._id); $match($.orders.status === "open");')[1]).toEqual(
      { $match: { "orders.status": "open" } },
    );
    expect(jsmql("$.items = [{ q: 1 }]; $match($.items.q === 1);")[1]).toEqual({ $match: { "items.q": 1 } });
    expect(jsmql("$.a = []; $.a.push({ x: 1 }); $match($.a.x === 1);")[2]).toEqual({ $match: { "a.x": 1 } });
    // Each link reads what the link before it made.
    expect(jsmql("$group({ _id: $.k, n: $sum(1) }); $$.map(d => ({ total: d.n })).filter(d => d.total > 1);")).toEqual([
      { $group: { _id: "$k", n: { $sum: 1 } } },
      { $replaceWith: { total: "$n" } },
      { $match: { total: { $gt: 1 } } },
    ]);
  });
});

describe.skipIf(up === null)("types — the server gives no value for a read that the compiler refuses", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("reads");
    await coll.deleteMany({});
    await coll.insertMany([{ _id: 1, k: "a", n: 1, s: "abc", arr: [1, 2], o: { a: 1 } }]);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("a field of a scalar, of an array, or one that a closed object does not hold is missing", async () => {
    const [doc] = await coll
      .aggregate([
        {
          $set: {
            ofArray: { $getField: { field: "size", input: "$arr" } },
            ofString: { $getField: { field: "length", input: "$s" } },
            ofObject: { $getField: { field: "b", input: "$o" } },
            numberPath: "$n.value",
            stringPath: "$s.length",
            // A field path through an array lists each element's field: numbers have none.
            arrayPath: "$arr.size",
          },
        },
      ])
      .toArray();
    expect(doc).toEqual({ _id: 1, k: "a", n: 1, s: "abc", arr: [1, 2], o: { a: 1 }, arrayPath: [] });
  });

  it("a query path through an array of numbers matches no document", async () => {
    expect(await coll.find({ "arr.size": { $exists: true } }).toArray()).toEqual([]);
    expect(await coll.find({ "arr.length": { $gt: 0 } }).toArray()).toEqual([]);
  });

  it("a field that a `$group` did not make is missing", async () => {
    const out = await coll.aggregate([{ $group: { _id: "$k", n: { $sum: 1 } } }, { $set: { y: "$total" } }]).toArray();
    expect(out).toEqual([{ _id: "a", n: 1 }]);
  });
});

describe("types — a computed key that may be missing reads as the empty name", () => {
  // `$getField` refuses a null name, so the guard stands wherever the proof cannot show the key.
  it("a string key guards what the proof cannot show, and takes no guard where it can", () => {
    expect(jsmql.expr("$.o[$.s.trim()]")).toEqual({
      $getField: { field: { $ifNull: [{ $trim: { input: "$s" } }, ""] }, input: { $ifNull: ["$o", {}] } },
    });
    expect(jsmql('$.s = "a"; $.v = $.o[$.s];')[1]).toEqual({
      $set: { v: { $getField: { field: "$s", input: { $ifNull: ["$o", {}] } } } },
    });
  });
});

describe.skipIf(up === null)("types — the server runs a computed key that may be missing", () => {
  let client: MongoClient;
  let coll: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    coll = client.db("jsmql_compiler_types").collection("keys");
    await coll.deleteMany({});
    await coll.insertMany([
      { _id: 1, o: { a: 1 }, s: " a ", k: "a", x: 5 },
      { _id: 2, o: { a: 1 }, x: 6 },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("a key that is missing reads no field, as JavaScript's `o[undefined]` does", async () => {
    const out = await coll
      .aggregate([{ $set: { v: jsmql.expr("$.o[$.s.trim()]") } }, { $project: { v: 1 } }, { $sort: { _id: 1 } }])
      .toArray();
    expect(out).toEqual([{ _id: 1, v: 1 }, { _id: 2 }]);
    const mapped = await coll
      .aggregate([...(jsmql.pipeline('const M = { a: "x" };\n$ = { v: $[M[$.k]] };') as object[])])
      .toArray();
    expect(mapped).toEqual([{ v: 5 }, {}]);
  });
});

describe("types — a join carries the shape its body made", () => {
  it("a `const` bound to a join is a present array: `.has` needs no guard", () => {
    expect(jsmql('const ids = $$$.orders.filter({ status: "a" }).map("pid").uniq(); $.hit = ids.has("x");')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "a" } }], as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.ids": { $setUnion: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.pid" } } } } },
      { $set: { hit: { $in: ["x", "$__jsmql.var.ids"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a `.pick` in the body closes the element: a read of a field that it did not keep is refused", () => {
    expect(jsmql('$.p = $$$.products.filter({ active: true }).pick(["_id", "name"]); $.t = $.p[0].name;')).toEqual([
      {
        $lookup: {
          from: "products",
          pipeline: [{ $match: { active: true } }, { $project: { _id: 1, name: 1 } }],
          as: "p",
        },
      },
      { $set: { t: { $let: { vars: { jsmqlV: { $arrayElemAt: ["$p", 0] } }, in: "$$jsmqlV.name" } } } },
    ]);
    expect(() =>
      jsmql('$.p = $$$.products.filter({ active: true }).pick(["_id", "name"]); $.t = $.p[0].price ? 1 : 2;'),
    ).toThrow("'.price' reads a field that '$.p[0]' does not have. It holds '_id', 'name'.");
  });

  it("a `.countBy()` in the body is a present record of numbers: a key read is its own truth", () => {
    const out = jsmql(
      'const counts = $$$.orders.filter({ status: "a" }).flatMap("pid").countBy(); $.n = Object.keys(counts).size(); $.c = counts[$.pid] ? 1 : 2;',
    ) as object[];
    expect(out.slice(2)).toEqual([
      {
        $set: {
          n: {
            $size: { $map: { input: { $objectToArray: "$__jsmql.var.counts" }, as: "jsmqlKv", in: "$$jsmqlKv.k" } },
          },
        },
      },
      {
        $set: {
          c: {
            $cond: {
              if: { $getField: { field: { $toString: { $ifNull: ["$pid", ""] } }, input: "$__jsmql.var.counts" } },
              then: 1,
              else: 2,
            },
          },
        },
      },
      { $unset: "__jsmql" },
    ]);
  });

  it("`.take(n)` keeps the element and not the positions; an index into an array of unknown length may miss", () => {
    // The fold settles a constant receiver to a one-item literal: position 0 is a present string.
    expect(jsmql('$.a = ["x", "yy"].take(1); $.n = $.a[0].length();')).toEqual([
      { $set: { a: ["x"] } },
      { $set: { n: { $strLenCP: { $arrayElemAt: ["$a", 0] } } } },
    ]);
    // A receiver the fold cannot settle: the element is a string, and index 0 may miss.
    expect(jsmql('$.a = [$.s.trim(), "yy"].take(1); $.n = $.a[0].length();')).toEqual([
      { $set: { a: { $slice: [[{ $trim: { input: "$s" } }, "yy"], 1] } } },
      {
        $set: {
          n: {
            $let: {
              vars: { jsmqlRecv: { $arrayElemAt: ["$a", 0] } },
              in: {
                $cond: {
                  if: { $eq: [{ $ifNull: ["$$jsmqlRecv", null] }, null] },
                  then: null,
                  else: { $strLenCP: "$$jsmqlRecv" },
                },
              },
            },
          },
        },
      },
    ]);
  });

  it("`.fromEntries()` over tuple literals is a record of the second items; a named key may be missing", () => {
    expect(jsmql('$.r = [["a", 1], ["b", 2]].fromEntries(); $.t = $.r.a ? "y" : "n";')[1]).toEqual({
      $set: { t: { $cond: { if: "$r.a", then: "y", else: "n" } } },
    });
  });

  it("an index the compiler cannot read answers the element, maybe absent", () => {
    expect(jsmql('$.s = ["a", "b"]; $.t = $.s[$.i] ? 1 : 2;')[1]).toEqual({
      $set: {
        t: {
          $cond: {
            if: {
              $and: [
                {
                  $ne: [
                    {
                      $ifNull: [
                        {
                          $switch: {
                            branches: [{ case: { $isNumber: "$i" }, then: { $arrayElemAt: ["$s", "$i"] } }],
                            default: "$$REMOVE",
                          },
                        },
                        null,
                      ],
                    },
                    null,
                  ],
                },
                {
                  $ne: [
                    {
                      $switch: {
                        branches: [{ case: { $isNumber: "$i" }, then: { $arrayElemAt: ["$s", "$i"] } }],
                        default: "$$REMOVE",
                      },
                    },
                    "",
                  ],
                },
              ],
            },
            then: 1,
            else: 2,
          },
        },
      },
    });
  });

  it("a callback parameter carries the element's own presence, not the array's", () => {
    // `$map` over a null `a` never runs the body, and each part of a `.split()` is a string that is there.
    expect(jsmql('$.a = $.s.split(","); $.n = $.a.map(p => p.length()); $.ids = $.a.map(ObjectId);')).toEqual([
      { $set: { a: { $split: ["$s", ","] } } },
      { $set: { n: { $map: { input: { $ifNull: ["$a", []] }, as: "p", in: { $strLenCP: "$$p" } } } } },
      { $set: { ids: { $map: { input: { $ifNull: ["$a", []] }, as: "x", in: { $toObjectId: "$$x" } } } } },
    ]);
  });

  it("an accumulator is present whatever its operand: `.size()` on a `$push` array needs no guard", () => {
    expect(jsmql("$group({ _id: $.k, items: $push($.item) }); $.n = $.items.size();")).toEqual([
      { $group: { _id: "$k", items: { $push: "$item" } } },
      { $set: { n: { $size: "$items" } } },
    ]);
  });
});

describe.skipIf(up === null)("types — the server agrees with the join's proof", () => {
  let client: MongoClient;
  let orders: Collection;
  let products: Collection;
  let users: Collection;
  beforeAll(async () => {
    client = (await liveClient())!;
    const db = client.db("jsmql_compiler_types");
    orders = db.collection("orders");
    products = db.collection("products");
    users = db.collection("users");
    await Promise.all([orders.deleteMany({}), products.deleteMany({}), users.deleteMany({})]);
    await orders.insertMany([
      { _id: 1, status: "a", pid: ["x", "y"] },
      { _id: 2, status: "a", pid: ["y"] },
      { _id: 3, status: "b", pid: ["z"] },
    ]);
    await products.insertMany([
      { _id: "x", name: "X", active: true, price: 1 },
      { _id: "y", name: "Y", active: false },
    ]);
    await users.insertMany([
      { _id: 1, pid: "y" },
      { _id: 2, pid: "q" },
    ]);
  });
  afterAll(async () => {
    await client?.close();
  });

  it("the unguarded `$in` over the joined array, the closed element, and the record read all answer as JavaScript would", async () => {
    const src = `
      const ids = $$$.orders.filter({ status: "a" }).map("pid").flatten().uniq();
      const counts = $$$.orders.filter({ status: "a" }).flatMap("pid").countBy();
      $.p = $$$.products.filter({ active: true }).pick(["_id", "name"]);
      $.hit = ids.has($.pid);
      $.c = counts[$.pid] ? counts[$.pid] : 0;
      $.name = $.p.find({ _id: "x" }).name;
    `;
    const out = await users.aggregate([...(jsmql(src) as object[]), { $sort: { _id: 1 } }]).toArray();
    expect(out.map((d) => [d.hit, d.c, d.name])).toEqual([
      [true, 2, "X"],
      [false, 0, "X"],
    ]);
  });
});
