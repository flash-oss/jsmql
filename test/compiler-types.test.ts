// The type tracker: what the compiler proves about a written field, a `let`, a
// possible-kinds value — and what the server does with the document it emits.
//
// Each case states the MQL, and the live half runs that MQL on the project's own
// mongod, so the claim "this shape is valid and answers X" is measured, never
// assumed (HR3). The suite skips its live half when no mongod is listening.
// See docs/specs/types.md.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, type Collection } from "mongodb";
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

  it("a `$project` inclusion keeps the named fields' types and forgets the rest; an exclusion removes its fields", () => {
    expect(jsmql('$.a = "x"; $.b = 1; $ = $.pick(["a"]); $.n = $.a.length(); $.m = $.b ? 1 : 2;')).toEqual([
      { $set: { a: "x" } },
      { $set: { b: 1 } },
      { $project: { a: 1, _id: 0 } },
      { $set: { n: { $strLenCP: "$a" } } },
      { $set: { m: 2 } },
    ]);
    expect(jsmql('$.a = "x"; $project({ a: 0 }); $.n = $.a ? 1 : 2;')[2]).toEqual({ $set: { n: 2 } });
  });

  it("a stage whose output no layout states yet leaves the document unknown", () => {
    // `a` was a present string; after the stage it may be missing, so the null guard is back.
    expect(jsmql('$.a = "x"; $sortByCount($.a); $.n = $.a.length();')[2]).toEqual({
      $set: { n: { $cond: { if: { $eq: [{ $ifNull: ["$a", null] }, null] }, then: null, else: { $strLenCP: "$a" } } } },
    });
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

  it("the projected program answers as JavaScript would", async () => {
    const out = await coll
      .aggregate([
        ...(jsmql('$.a = "x"; $.b = 1; $ = $.pick(["a"]); $.n = $.a.length(); $.m = $.b ? 1 : 2;') as object[]),
        { $limit: 1 },
      ])
      .toArray();
    expect(out).toEqual([{ a: "x", n: 1, m: 2 }]);
  });
});

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
    expect(
      jsmql('$.o = { a: "x", b: 1 }; $.p = $.o.pick(["a"]); $.n = $.p.a.length(); $.m = $.p.b ? 1 : 2;').slice(2),
    ).toEqual([{ $set: { n: { $strLenCP: "$p.a" } } }, { $set: { m: 2 } }]);
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

describe("types — a join carries the shape its body made", () => {
  it("a `const` bound to a join is a present array: `.has` needs no guard", () => {
    expect(jsmql('const ids = $$$.orders.filter({ status: "a" }).map("pid").uniq(); $.hit = ids.has("x");')).toEqual([
      { $lookup: { from: "orders", pipeline: [{ $match: { status: "a" } }], as: "__jsmql.tmp.0" } },
      { $set: { "__jsmql.var.ids": { $setUnion: { $map: { input: "$__jsmql.tmp.0", as: "x", in: "$$x.pid" } } } } },
      { $set: { hit: { $in: ["x", "$__jsmql.var.ids"] } } },
      { $unset: "__jsmql" },
    ]);
  });

  it("a `.pick` in the body closes the element: a field it did not keep is certainly missing", () => {
    expect(
      jsmql('$.p = $$$.products.filter({ active: true }).pick(["_id", "name"]); $.t = $.p[0].price ? 1 : 2;'),
    ).toEqual([
      {
        $lookup: {
          from: "products",
          pipeline: [{ $match: { active: true } }, { $project: { _id: 1, name: 1 } }],
          as: "p",
        },
      },
      { $set: { t: 2 } },
    ]);
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
                { $ne: [{ $ifNull: [{ $arrayElemAt: ["$s", "$i"] }, null] }, null] },
                { $ne: [{ $arrayElemAt: ["$s", "$i"] }, ""] },
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
      $.t = $.p[0].price ? 1 : 2;
      $.name = $.p.find({ _id: "x" }).name;
    `;
    const out = await users.aggregate([...(jsmql(src) as object[]), { $sort: { _id: 1 } }]).toArray();
    expect(out.map((d) => [d.hit, d.c, d.t, d.name])).toEqual([
      [true, 2, 2, "X"],
      [false, 0, 2, "X"],
    ]);
  });
});
